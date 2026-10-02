/**
 * 任务下发编排：发现 sidecar → 取口令 → ACP 握手 → 新建会话 → 选模型 → 跑一轮 → 取回执。
 *
 * <p>★★ 这条链路替代的是什么、为什么值得替代 ★★
 *
 * <p>旧路径是 `ctx.subprocess.spawn()` 拉起 `workbuddy` CLI。真机结论：自己 spawn 的 CLI
 * **永远 `auth_failed`，且不消耗任何积分** —— 账号会话只在**桌面端拉起的 sidecar** 里。
 * 所以旧路径在功能上等于不可用，只是每次都以一个看起来像"网络问题"的形式失败。
 *
 * <p>新路径把 WorkBuddy 当成 dsh 的一个 subagent：下发走它桌面端已经拉好的本机网关，
 * 凭据只在那个 sidecar 进程内，插件从头到尾没有 WorkBuddy 账号。
 *
 * <p>★ 全链路的每一步都可能失败，且失败形态不同（没有空闲 sidecar / 口令读不到 /
 *   握手 4xx / 模型不存在 / 回执缺失）。**每一种都必须落到一个确定的 reason code**，
 *   否则上层只能报一句"运行失败"，用户无法判断该重启桌面端还是改模型名。
 *
 * @module host/gateway/dispatch
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createAcpClient } from './acp.js';
import { createPortResolver } from './portmap.js';
import { createIdentityResolver } from './identity.js';
import { createEnsurer, ENSURE_CODE } from './ensure.js';
import {
  discoverSidecars, probeEntry, resolveSidecarEndpoints, selectSidecar,
} from './sidecar.js';
import { REASON_CODES } from '../launch/reason-codes.js';
import { autoReadSupport, createTokenProvider, readGatewayPassword } from './token.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库里那个只读 PEB 助手的绝对路径（`assets/read-sidecar-env.ps1`）。 */
export const HELPER_PATH = join(HERE, '..', '..', '..', 'assets', 'read-sidecar-env.ps1');

/**
 * 网关层的失败码 → 插件既有的 reason code。★ 复用既有枚举，不另造一套。
 *
 * ★ 这里**引用 `REASON_CODES` 的值**而不是手抄字符串：网关之前写的是 `'TRANSPORT_UNREACHABLE'`
 *   这类大写串，而枚举里存的是 `'transport_unreachable'` —— 两者永远不相等，
 *   于是 `isFailureCode()` 认不出、状态区与 availability 提示把它当**未知**渲染。
 *   写成引用后，拼错就变成 undefined 而不是静默失配。
 */
export const GATEWAY_REASON = Object.freeze({
  no_sidecar: REASON_CODES.TRANSPORT_UNREACHABLE,   // 桌面端没开，或没有空闲 sidecar
  token_unavailable: REASON_CODES.AUTH_FAILED,       // 读不到本机 IPC 口令（桌面端没登录/已重启）
  handshake_failed: REASON_CODES.TRANSPORT_UNREACHABLE,
  model_unavailable: REASON_CODES.MODEL_UNAVAILABLE,
  run_failed: REASON_CODES.TASK_ERROR,
  aborted: REASON_CODES.ABORTED,
});

/**
 * ★★★ 别再把 `no_sidecar` 这一个码当成所有失败（2026-09-30）。
 *
 *   `GATEWAY_REASON.no_sidecar` 是一个**兜底桶**，此前它同时装着四种**处置完全不同**的失败：
 *     用户自己点了取消      → 该是 `aborted`   （此前报"传输不可达"：把自己的取消写成环境故障）
 *     桌面端没装/拉不起/没就绪 → 该是 `start_failed`
 *     读不到本机 IPC 口令    → 该是 `auth_failed`（去登录或重启桌面端）
 *     真的没有可用 sidecar  → 维持 `transport_unreachable`
 *
 * <p>★ 刻意**不新造 reason code** ★
 * `REASON_CODES` 是既有枚举，状态区与 availability 都按它渲染；新增一个码要连带改渲染，
 * 比"从已有码里挑对的那个"贵得多。而这四个码**早就都在枚举里**，只是没被用上。
 *
 * <p>判据读的是 `instance.code`（`ENSURE_CODE`）与 `instance.sidecar.refused`：
 * 后者因为 `projectInstance` 现在认字符串形状，**真的**是 `all_busy` / `token_unavailable`
 * 这类码，而不是此前恒为的 `'unknown'`。
 *
 * @param {object|undefined} instance `projectInstance(report)` 的产物
 * @returns {string} 既有 `REASON_CODES` 里的一个值
 */
export function gatewayReasonForInstance(instance) {
  const code = instance?.code;
  const refused = instance?.sidecar?.refused ?? null;
  if (code === ENSURE_CODE.ABORTED) return REASON_CODES.ABORTED;
  if (refused === 'token_unavailable') return REASON_CODES.AUTH_FAILED;
  if (code === ENSURE_CODE.DESKTOP_NOT_READY
    || code === ENSURE_CODE.DESKTOP_LAUNCH_FAILED
    || code === ENSURE_CODE.DESKTOP_NOT_INSTALLED
    || code === ENSURE_CODE.DESKTOP_PROBE_FAILED) {
    return REASON_CODES.START_FAILED;
  }
  // ★ 其余（NO_USABLE_SIDECAR / NO_SIDECAR_APPEARED）维持旧行为，零回归。
  return GATEWAY_REASON.no_sidecar;
}

/**
 * ★★★ 真机实测（2026-09-28，host-cli 预热 sidecar）：**`session/set_mode` 接受但不生效。**
 *
 * 证据链（三条互相独立）：
 *   1. 同一会话连做 4 轮 `set_mode`（`acceptEdits` / `dontAsk` 交替），每轮都在**另一条新连接**上
 *      `session/load` 回读：`config_option_update.currentValue` **恒为 `default`**。
 *      桌面那条既有会话、以及 `session/new` 出来的新会话，**结论一致**——不是会话类型问题。
 *   2. 回读**信号本身是真的**：`currentValue` 报的 `default` 与下面的行为学证据一致。
 *      所以不能反过来猜"回读是陈的、其实生效了"。
 *   3. 行为学证法：设成 `acceptEdits` 后下发一个"写文件"任务，90s 不返回。
 *      `acceptEdits` 应当**秒接受**文件编辑；只有 `default`(Always Ask) 才会卡在
 *      没人能点的授权框上。⇒ 生效的确实还是 `default`。
 *
 *   推论（决定了这里为什么**必须**多回读一次）：`set_mode` 的返回值 `currentModeId`
 *   只是"我收到了你的要求"，**不是**"它生效了"。拿回显当成功，就是在安全相关的开关上报假账——
 *   而假账的后果不是报错，是任务悄悄跑在一个用户没要求的权限下。
 *
 *   为什么必须**另开一条连接**回读：真机上**同一条连接上的第二次 `session/load` 不再下发
 *   `config_option_update`**（options=0、currentValue=''），所以同连接回读必然读到空值，
 *   会把"没生效"误判成"读不到"。实测 5 次新连接、每次首次 load 都稳定拿到 8 个选项。
 *
 * @returns {Promise<{effective: string|null, confirmed: boolean}>}
 */
async function verifyPermissionMode(sidecar, token, sessionId, requested, fetchImpl) {
  const unknown = { effective: null, confirmed: false };
  const acp = createAcpClient({ url: sidecar.url, token, fetchImpl });
  const conn = await acp.connect();
  if (!conn.ok) return unknown;
  const init = await acp.initialize();
  if (init.error) return unknown;
  const loaded = await acp.loadSession(sessionId, '');
  if (loaded.error) return unknown;
  const effective = loaded.modes?.currentValue ?? null;
  return { effective, confirmed: effective === requested };
}

/**
 * 建一个下发器。所有副作用都可注入，所以整条链能在测试里跑完而不碰真实环境。
 *
 * @param {{run?: (spec: {argv: string[]}) => Promise<string>,
 *   fetchImpl?: typeof fetch, sessionsDir?: string,
 *   gatewayToken?: string|null|(() => string|null), boundSessionId?: string|(() => string),
 *   sessionMode?: string|(() => string), workspace?: string|(() => string),
 *   createNewConversation?: boolean|(() => boolean),
 *   isPidAlive?: (pid: number) => boolean,
 *   helperPath?: string, now?: () => number}} [deps]
 *   `run` 是**唯一**的进程出口，必须由调用方接到官方 seam `ctx.subprocess`（R3-7 ②）。
 *   `gatewayToken` 收函数是为了让**配置**成为唯一真源：静态字符串会在装配期把设置值拍死，
 *   用户改了设置也不生效（这是本仓对 `.volatile()` 字段的通用坑，见 apply.js 的说明）。
 *   `boundSessionId` 同理。**它取代了原先的 `allowInteractive` 布尔开关**：
 *   那个开关粒度太粗——"放开 interactive 整个类别"挡不住"new 到用户正在做的那条"。
 *   绑定一条具体对话，污染在结构上就不可能发生。
 *   `sessionMode` / `workspace` / `createNewConversation` 同样收函数，理由相同；
 *   三者是**每次调用可覆盖**的（`run()` 的入参优先），便于工具层做逐次下发。
 *   `launcher` 是**拉起目标实例**用的火枪式进程出口（`apply.js` 接 `ctx.subprocess` 后注入）：
 *   契约与 `run` 相反 —— `run` 等退出拿 stdout，`launcher` 拉起来就不管了
 *   （WorkBuddy.exe 是常驻 GUI，等它退出等于永远等不到）。`autoStartDesktop` /
 *   `instanceTimeoutMs` 同样现取，理由见 `.volatile()` 的通用坑。
 */

/**
 * 插件自己那条对话在会话映射里的**固定键**。
 *
 * 刻意**不用** `randomUUID()`（那是 `map.js` `createKey()` 给"多次独立任务"用的）：
 * 插件自建的对话**只有一条**，要的是"认得回自己上次那条"，不是"每次都是新的一条"。
 * 键一换，前一条就永远查不到 ⇒ 每轮都重新 new ⇒ 桌面端对话列表被刷屏。
 */
export const OWN_SESSION_KEY = 'workbuddy-gateway-own';

/**
 * ★ 自己 new 一条对话时，`session/new` 要**连着调两次**，只留第二次的结果。
 *
 * 真机实测（2026-09-28，pid 26080 / 127.0.0.1:53349，**4 次独立复现**）：
 *   每个**新 ACP 连接**上的**第 1 次** `session/new` 返回的是 GUI 当前那条（**并没有新建**），
 *   第 2 次起才真新建。
 * ⇒ 只调一次的后果不是"少建一条"，而是**把用户正在用的那条当成我们的**并下发任务 ——
 *   这正是当初"必须人先绑一条"的由来。
 *
 * 为什么固定两次而不是"看着像就再试一次"：判据是"这次返回的 id 是不是 GUI 当前那条"，
 * 而 GUI 活跃会话 id **我们拿不到**（没有任何接口读它）。拿不到真源就不猜——
 * 固定两次，行为可预测、可测，代价只是多出一条被丢弃的空对话（它没被下发过任何任务）。
 */
export const NEW_SESSION_ATTEMPTS = 2;

export function createDispatcher(deps = {}) {
  const {
    fetchImpl = fetch, sessionsDir, gatewayToken = null, helperPath = HELPER_PATH, now = Date.now,
  } = deps;
  /** 配置里的兜底口令。每轮现取，不缓存（用户改了设置要立刻生效）。 */
  const configuredToken = () => (typeof gatewayToken === 'function' ? gatewayToken() : gatewayToken);
  /** ★ 用户绑定的那条对话。没绑就是空串，**空串 = 一步都走不出去**。 */
  const boundSession = () => (
    (typeof deps.boundSessionId === 'function' ? deps.boundSessionId() : deps.boundSessionId) ?? ''
  ).trim();
  /** 配置取值器统一形状：静态值或函数都收，每轮现取。 */
  const setting = (key) => (
    typeof deps[key] === 'function' ? deps[key]() : deps[key]
  ) ?? '';
  /** ★ 任务权限。'' = 沿用该对话当前权限，**不替用户选授权强度**。 */
  const configuredMode = () => String(setting('sessionMode')).trim();
  /** ★ 任务工作区。'' = 不带，模型用那条对话自己的目录。 */
  const configuredWorkspace = () => String(setting('workspace')).trim();
  /**
   * ★ 是否强制另开一条对话。
   *
   * 语义在 2026-09-28 **变过一次**，别再按旧名字理解：
   *   - 旧：默认 false，且 false 时"没绑对话就一步都走不出去"——**必须由人先在桌面端开一条**。
   *   - 新：默认 false，但 false **不再**意味着"走不出去"，只意味着"用**上一轮自己建的那条**"。
   *     插件在第一次调用时自己 new 一条并记下来，之后一直续用它。
   *     设成 true 是**显式覆盖**："这一轮另开一条"（新的同样会被记下来，成为之后那条）。
   */
  const configuredCreateNew = () => setting('createNewConversation') === true;

  // ★★★ 插件自建会话的记性。落点 = `settings[NS].sessions[OWN_SESSION_KEY]`（进程重启也在）。
  //   `sessionStore` 缺省时（单测、部分装配形态）退化成**进程内**记性：本轮仍能复用，
  //   但重启后要重新 new 一次。**不静默假装记住了**——下面的返回面会照实区分这两种。
  /**
   * 记性的落点 key。缺省 = `OWN_SESSION_KEY`（全局那一条，行为与引入本参数前逐字相同）。
   * ★ 子智能体那条线（`src/host/subagent/`）用**每个 dsh 子会话一个 key**，
   *   否则两个子会话共用同一把记性 ⇒ A 的上下文漏进 B。传 '' 一律当缺省，不开"匿名记性"后门。
   */
  const ownKeyOf = (key) => (typeof key === 'string' && key !== '' ? key : OWN_SESSION_KEY);
  // 进程内记性按 key 分桶（`VOLATILE_OWN_SESSIONS`），否则一个 key 会顶掉另一个。
  const volatileOwnSessions = new Map();
  const volatileRead = (key) => {
    if (!volatileOwnSessions.has(key)) return '';
    return volatileOwnSessions.get(key);
  };
  const ownSession = (key = OWN_SESSION_KEY) => {
    const k = ownKeyOf(key);
    if (typeof deps.sessionStore?.read === 'function') {
      const v = deps.sessionStore.read(k);
      return typeof v === 'string' ? v : '';
    }
    return volatileRead(k);
  };
  /** 记住这条会话（自建成功、或 load 成功后的"续用"记账）。`ok:false` 会原样带给上层。
   * ★ §4.3 记账：`own:true` = 这条是插件自建、可由启动清理回收；`createdAt` 由 map 侧首次落盘、
   *   续用 refresh 时沿用旧值（不覆盖）。 */
  const rememberOwnSession = (sessionId, cwd, key = OWN_SESSION_KEY) => {
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    volatileOwnSessions.set(ownKeyOf(key), sessionId);
    if (typeof deps.sessionStore?.adopt === 'function') {
      try {
        return deps.sessionStore.adopt(ownKeyOf(key), { cliSessionId: sessionId, cwd, own: true });
      } catch (e) {
        // 写盘抛异常**不能带崩这一轮任务**（任务已经跑完了），但必须留痕。
        return { ok: false, persistState: 'failed', persistError: e?.message ?? 'sessionStore.adopt threw' };
      }
    }
    return null;
  };
  /** 作废记性：那条会话在桌面端已经不在了。作废后下一轮会自己 new。 */
  const forgetOwnSession = (sessionId, key = OWN_SESSION_KEY) => {
    const k = ownKeyOf(key);
    if (sessionId !== '' && volatileRead(k) === sessionId) volatileOwnSessions.delete(k);
    if (typeof deps.sessionStore?.forget === 'function') {
      try { deps.sessionStore.forget(k); } catch { /* 记性作废失败 = 下一轮多 new 一次，不是本轮的错误 */ }
    }
  };
  /**
   * §4.3 诚实回收位：网关 ACP 只暴露 new/load/set_mode/set_model/prompt（见 acp.js），
   * **没有会话删除接口**。`retained_for_reuse` = 成功轮保留复用（F3）；`no_delete_api` =
   * 终态后尝试过服务端回收但无接口可调，本地映射保留、如实记未回收，绝不谎报已回收。
   */
  const recycleNote = (reason) => ({
    attempted: reason !== 'retained_for_reuse' && reason !== 'no_session',
    recycled: false,
    reason,
    detail: reason === 'no_delete_api'
      ? 'ACP exposes session/new, session/load, session/set_mode, session/set_model and session/prompt only; '
        + 'there is no session delete/unload. The local mapping is retained and the record stays unrecycled.'
      : (reason === 'retained_for_reuse'
        ? 'The conversation is kept under the same session key for reuse; no server-side recycle was attempted.'
        : 'No conversation was opened on this path, so there was nothing to recycle.'),
  });
  /**
   * ★ 不再问"放不放 interactive 这一类"，只问"绑没绑"。
   *
   * 真机实测（2026-09-28，pid 26080 / 127.0.0.1:53349）决定了为什么：
   *   - 每个新 ACP connection 的**第 1 次** `session/new` 返回 GUI 当前那条（不是新建）；
   *     第 2 次起才真新建（4 次独立复现）。⇒ 想 new 就得先 new 一次把用户那条"取"出来，扔掉它，
   *     而 `session/new` **还会切走 GUI 活跃会话**。
   *   - 当时还测到"自己 new 的对话工作区未知"，当时把原因记成 `cwd` 被忽略，
   *     用来支持"必须绑着用户那条"。**2026-09-28 更正**：`cwd` 确实被忽略（四种独立方式，
   *     含一个不存在的盘 Z: 也"成功"），但它**不再是拒绝自建的理由**——
   *     工作区有独立解法（随 prompt 送锚点，见 acp.js `buildPromptBlocks`），
   *     而 `session/load` 让"续用某条对话"变得安全且无损。
   */
  const interactiveAllowed = () => boundSession() !== '';

  // ★ 跨进程读环境块很贵（实测 760–1310ms），所以令牌提供器要活过一次 dispatch
  const tokens = createTokenProvider({
    configured: configuredToken(),
    read: (pid) => readGatewayPassword(pid, { helper: helperPath, run: deps.run }),
  });

  // ★ 5.6.2 起 session 文件不再写 `url`（见 portmap.js），端点只能按 pid 从 OS 端口表反查。
  //   这是**纯查询**（netstat / lsof），不读别的进程内存，杀软不会因此报警 ——
  //   与上面 PEB 读口令是两种风险量级，别混为一谈。
  const resolvePorts = createPortResolver({ run: deps.run });

  /**
   * ★ 身份核验：把"pid 还活着但已经不是我们的进程"的条目挑出去。
   *   与上面同样是**纯查询**（列进程名与命令行），不读内存、不改任何东西。
   *   一次查询覆盖全部候选 —— 逐个查在几十个候选上要十几秒。
   */
  const resolveIdentities = createIdentityResolver({ run: deps.run });

  /** 发现 + 反查端点。`inspect` 与 `run` 共用，免得两条路给出不同的池子。 */
  const discover = async () => {
    const entries = discoverSidecars({
      ...(sessionsDir === undefined ? {} : { dir: sessionsDir }),
      now: now(),
      // ★ 活性判据也要能注入：它默认走真实 OS（`process.kill(pid, 0)`），
      //   而 fixture 里的 pid 是本机早就退掉的那个 ⇒ 不注入的话整条链
      //   在测试里第一步就判成"桌面端没启动"，后面全测不到。
      ...(typeof deps.isPidAlive === 'function' ? { isPidAlive: deps.isPidAlive } : {}),
    });
    const withUrls = await resolveSidecarEndpoints(entries, { resolvePorts });
    // ★ 注入点：测试里直接给一张表，省掉真的去列进程。
    const identities = typeof deps.resolveIdentities === 'function'
      ? await deps.resolveIdentities(withUrls.map((e) => e.pid))
      : await resolveIdentities(withUrls.map((e) => e.pid));
    const recycled = [];
    // ★★ 进程**根本不存在**的条目（枚举成功、不在表里）。它们和"pid 被回收"必须分开：
    //   回收 ⇒ 那个进程号现在归别的程序；不存在 ⇒ 什么也没有，只剩一个残留的 session 文件。
    //   两者过去都被 fail-open 放进了候选池，于是插件去读一个不存在的进程的环境块，
    //   读不到，再把这件事报成"口令取不到/权限不够"——**归因完全错了，处置也完全错了**。
    //   实测（2026-09-30 22:0x）：被当成"1 个可用 sidecar"的 pid 20868，
    //   tasklist / Get-CimInstance Win32_Process / GetProcessById 三者都不承认它存在。
    const gone = [];
    const kept = withUrls.filter((e) => {
      const id = identities.get(e.pid);
      // ★ 顺序有讲究：`exists === false` 先判。`isSidecar === null`（查不到）依然放行 ——
      //   把"没权限"当成"不是我们的进程"，会静默丢掉用户提权运行的 sidecar（同上）。
      if (id?.exists === false) { gone.push({ pid: e.pid }); return false; }
      if (id?.isSidecar !== false) return true;
      recycled.push({ pid: e.pid, name: String(id.name ?? '') });
      return false;
    });
    return { entries: kept, recycled, gone };
  };

  /**
   * 探活一个候选（`status` 方法与 ensure 阶段共用的**同一份实现**）。
   *
   * ★ 为什么抽成闭包而不是在两个地方各写一遍：`selectSidecar` 的 `status` 回调是**这一层
   *   唯一的探活入口**，`run()`、`inspect()`、`capabilities()`、`ensure` 全走它。
   *   一旦分成两份，"取不到口令 ⇒ 标记成 token_unavailable" 这条 2026-09-28 才补上的
   *   归因必然会在某一份里退化回 `null`，而那正是本机下发链路踩过的真凶。
   *
   * @type {(e: object) => Promise<{busy: boolean, unavailable?: string, detail?: string}|null>}
   */
  const statusOf = async (entry) => {
    let token = null;
    // ★★ 这行 catch 是**本机下发链路的真凶**，2026-09-28 定位：它把"取不到口令"
    //   压成了和"端点探不通"完全一样的 `null`，于是 `selectSidecar` 只能报
    //   `probe_unreachable`（"去重启桌面端"）——而桌面端好好的，坏的是权限。
    //   真机：dsh 跑在**普通用户**上下文，读 sidecar 的 PEB 被 Windows 拒绝，
    //   两个端点裸探都是 HTTP 401（端点健康、只缺口令），全池却被判成"探不通"。
    //   现在保留成因，别再让它冒充成"桌面端没起来"。
    try {
      ({ token } = await tokens.get(entry));
    } catch (e) {
      return { busy: null, unavailable: 'token_unavailable', detail: e?.message ?? null };
    }
    // ★ 探不通**仍回 null**，不带标记：`summarizePool` 里 `s === null` 那一支
    //   （"一个都没探到" vs "探到了但都拿不到"）是按这个形状写的，改形状就得连带改归因，
    //   而那条区分**没坏**。只给口令这一层加标记，因为它是**探活的前置条件**失败——
    //   前置条件失败和"探不通"混起来，就会被读成"桌面端没就绪"。
    return probeEntry(entry, fetchImpl, token);
  };

  /**
   * 挑一个**可用**的 sidecar（discover + select 两步的合并产物）。
   *
   * ★ `allowInteractive` 恒为 true 的理由见 `run()` 里的注释：插件自己 new 的那条对话
   *   就住在 interactive sidecar 上，挡住它等于挡住自己。`inspect()` 走的是**只读**体检，
   *   那里仍然用 `interactiveAllowed()`，绝不碰任何会话。
   *
   * @param {{statusOf?: (e: object) => Promise<any>}} [opts]
   * @returns {Promise<{picked: object|null, why: {code: string, detail: string}|null, scanned: number}>}
   */
  const pickUsable = async (opts = {}) => {
    const { entries, recycled, gone } = await discover();
    let why = null;
    const picked = await selectSidecar(entries, {
      status: opts.statusOf ?? statusOf,
      allowInteractive: true,
      recycled,
      gone,
      onUnavailable: (s) => { why = s; },
    });
    return { picked: picked === null ? null : picked.entry, why, scanned: entries.length };
  };

  /**
   * 目标实例保障（★ 2026-09-30）：存在吗 → 要不要起 → 起了没 → 等到了吗。
   * 详见 `ensure.js` 头注；失败时给的是**带处置动作**的 reason code，不是一句"请打开桌面端"。
   */
  const ensurer = createEnsurer({
    probe: pickUsable,
    run: deps.run,
    launcher: deps.launcher,
    autoStart: () => setting('autoStartDesktop') === true,
    waitMs: () => setting('instanceTimeoutMs'),
    now,
  });

  return {
    tokens,

    /** §4.3 失败/取消/超时终态的本地回收口：忘掉该 key 的映射（下轮重建），服务端无删除接口故只记未回收。 */
    recycleOwn(key = OWN_SESSION_KEY) {
      const k = ownKeyOf(key);
      const current = ownSession(k);
      forgetOwnSession(current, k);
      return recycleNote(current === '' ? 'no_session' : 'no_delete_api');
    },

    /** 只做发现与探活，给状态路由用；不下发任何东西。 */
    async inspect() {
      const { entries, recycled, gone } = await discover();
      // ★ 为什么这里也挂 onUnavailable：`picked === null` 本身**不是**答案。
      //   "没有候选" / "都在等授权" / "都在真跑着" / "探不通" 要做的事完全不同
      //   （见 summarizePool 的四类），只回一个 null 会把用户引去重启桌面端，
      //   而重启修不好一个没人应答的授权对话框。
      let unavailable = null;
      const picked = await selectSidecar(entries, {
        status: statusOf,
        allowInteractive: interactiveAllowed(),
        recycled,
        gone,
        onUnavailable: (s) => { unavailable = s; },
      });

      const support = autoReadSupport();
      const resolved = entries.filter((e) => typeof e.url === 'string' && e.url !== '').length;
      return {
        candidates: entries.length,
        hostManaged: entries.filter((e) => e.hostManaged).length,
        // ★ 新增：解析出端点的有几个。5.6.2 之后 `candidates > 0` 但 `resolved === 0`
        //   是一种**独立**的失效（session 文件没写 url，端口表也查不到），得能分开看。
        resolved,
        picked: picked === null ? null : { pid: picked.entry.pid, url: picked.entry.url },
        unavailable,
        autoToken: support.supported,
        autoTokenReason: support.reason,
        configuredToken: typeof configuredToken() === 'string' && configuredToken() !== '',
      };
    },

    /**
     * 探活一个候选。实现见 `statusOf`（与 ensure 阶段共用一份，理由见那里的注释）。
     *
     * @type {(e: object) => Promise<{busy: boolean}|null>}
     */
    async status(entry) {
      return statusOf(entry);
    },

    /**
     * ★ 只读取"这条对话此刻支持什么"——**不发任务**。
     *
     * 存在的理由：`permission_mode` 是 `workbuddy_run` 的参数，而那张下拉表的**唯一真源是服务端**
     * （`config_option_update` 事件）。如果模型只能在真正下发之后才知道有哪些值，那第一次调用
     * 就只能瞎填；所以要有一个**不花积分、不改会话状态**的探针。
     *
     * @returns {Promise<{known: boolean, current: string, options: object[], at: number,
     *   models: object[], error: object|null}>}
     *   探不到时 `known:false` + 空 options —— **绝不用本地常量表顶替**（那份 6 值 CLI flag
     *   表缺 `fullAccess`/`delegate`，顶替等于让用户选不到"完全权限"）。
     */
    async capabilities() {
      const none = { known: false, current: '', options: [], at: Date.now(), models: [], error: null };
      const sessionId = boundSession();
      // 没绑对话 ⇒ 无从 load ⇒ 如实说不知道。**不要为了探权限去 session/new**——
      //   那会切走 GUI 活跃会话（真机复现 4 次），代价远大于"多知道一个下拉表"。
      if (sessionId === '') return { ...none, error: { code: 'no_bound_session', message: 'no bound conversation' } };

      const { entries, recycled, gone } = await discover();
      // ★ 必须传 `status: statusOf`：不传的话 `selectSidecar` 没法剔除"正在跑"的候选，
      //   探针会连上一条正在干活的对话。`run()`/ensure 阶段是同一套参数，这里**不能**各写一份。
      const picked = await selectSidecar(entries, {
        status: statusOf,
        allowInteractive: true,
        recycled,
        gone,
      });
      if (picked === null) {
        return { ...none, error: { code: 'no_sidecar', message: 'no usable sidecar for a read-only probe' } };
      }
      const sidecar = picked.entry;
      let token = null;
      try {
        ({ token } = await tokens.get(sidecar));
      } catch (e) {
        return { ...none, error: { code: 'token_unavailable', message: e?.message ?? null } };
      }
      const acp = createAcpClient({ url: sidecar.url, token, fetchImpl });
      // ★★ `connect()` 不能省。`acp-connection-id` 是 `connect` 建的，没有它 `initialize` 直接
      //   HTTP 400（真机 2026-09-28 实测：漏掉这行，报错是"check the acp-connection-id header"，
      //   读起来像头写错了，实际是连接压根没建）。`run()` 里也是 connect → initialize 的次序。
      const conn = await acp.connect();
      if (!conn.ok) return { ...none, error: conn.error };
      const init = await acp.initialize();
      if (init.error) return { ...none, error: init.error };
      // ★ 只 `load` 不 `new`：load 是**只读续用**（不改 sessionId、不切 active，真机验证）；
      //   new 是有副作用的，不能拿来当探针。
      const loaded = await acp.loadSession(sessionId, '');
      if (loaded.error) return { ...none, error: loaded.error };
      return {
        known: Array.isArray(loaded.modes?.options) && loaded.modes.options.length > 0,
        current: loaded.modes?.currentValue ?? '',
        options: loaded.modes?.options ?? [],
        at: Date.now(),
        models: loaded.models ?? [],
        error: null,
      };
    },

    /**
     * 目标实例体检（★ 2026-09-30）：**只问"能不能跑"，不下发任何东西**。
     *
     * ★ 为什么单独开一条路（而不是让调用方直接 `run()` 试一次）：
     *   `run()` 失败面已经带 `instance`，但它会把一条**真的任务**发出去、或至少建会话；
     *   "诊断有没有实例可用"这件事本身不该有任何副作用。
     *
     * @param {{signal?: AbortSignal}} [opts]
     * @returns {Promise<{ok: boolean, sidecar: object|null, report: object}>}
     */
    async ensure(opts = {}) {
      return ensurer.ensure(opts);
    },

    /**
     * 跑一轮。
     *
     * @param {{prompt: string, cwd: string, modelId?: string|null,
     *   permissionMode?: string|null, createNew?: boolean|null, sessionKey?: string|null,
     *   signal?: AbortSignal, onPhase?: (p: string) => void, onInstance?: (report: object) => void}} req
     * @returns {Promise<{ok: boolean, reason: string|null, text: string, receipt: object|null,
     *   phases: string[], tools: object, models: object[], modes: object|null,
     *   sessionId: string|null, sidecar: object|null, error: object|null, instance: object|null,
     *   sessionOrigin: 'new'|'loaded'|null, sessionRenewed: string, sessionPersist: object|null,
     *   recycle: {attempted: boolean, recycled: boolean, reason: string, detail: string}}>}
     */
    async run({ prompt, cwd, modelId = null, permissionMode = null, createNew: createNewArg = null, sessionKey: sessionKeyArg = null, signal, onPhase, onInstance }) {
      // 本轮"自己建的那条"记在哪个 key 下。null = 全局那一条（既有行为，逐字不变）。
      const ownKey = ownKeyOf(sessionKeyArg);
      // ★ 目标实例结论的**实时**持有者（`fail` 会读它）。声明在 `fail` 之前是必需的：
      //   闭包按声明顺序捕获，早于 `fail` 声明就取不到。
      let currentInstance = null;
      const fail = (reason, error) => ({
        ok: false, reason, text: '', receipt: null, phases: [], tools: { count: 0, names: [] },
        models: [], modes: null, sessionId: null, usedModelId: null, sidecar: null, error,
        permission: null,
        // ★ 目标实例的结论**在每个失败面都带**。"任务没发出去"和"目标实例没起来"是两种
        //   完全不同的事：前者查任务内容，后者查桌面端。不分开报，用户只能一次次重发任务，
        //   而每一次重发的结果都是一样的。闭包声明在 `fail` 之前 ⇒ 失败在这里之前发生时
        //   读到 `null`，那就是"实例这一步压根没走到"，与实情相符。
        instance: currentInstance,
        sessionOrigin: null,
        // ★ 失败面也带这两个位：失败在"选会话"之后发生时（见 `bound_session_unloadable`），
        //   调用方需要知道**当时打算用哪条、以及为什么没能用上**。
        //   这里取的是闭包外的初值——`fail` 定义在 sessionId 声明之前，拿不到后面赋的值。
        //   ⇒ 所以真要带上，改用 `runFailedWith(...)`（见下），它拿到实时的 sessionId。
        sessionRenewed: '',
        sessionPersist: null,
        recycle: recycleNote('no_session'),
      });

      if (typeof prompt !== 'string' || prompt === '') {
        return fail(GATEWAY_REASON.run_failed, { code: 'empty_prompt', message: 'prompt is empty' });
      }
      if (signal?.aborted) {
        return fail(GATEWAY_REASON.aborted, { code: 'aborted', message: 'aborted before dispatch' });
      }
      onPhase?.('discovering');

      // ★★★ 这里原来有一道"没绑对话就一步都走不出去"的闸（`no_bound_session`），**2026-09-28 删掉**。
      //   它对应的是旧设计：新建会切走 GUI 活跃会话，所以只敢让人先开一条、把 id 抄进设置。
      //   现在的分工是**插件自己 new 一条并记下来**（见下面 resolveSession 三级优先级），
      //   所以"没绑"是**正常首轮状态**，不是错误态——拿它当错误，等于把首轮必然发生的事
      //   报成故障，还要求用户去桌面端手工开一次。
      //
      //   保留的部分：`createNew` 的入参优先于配置（`null` = 没给，沿用配置），
      //   便于工具层逐次覆盖成"这一轮另开一条"。
      const createNew = createNewArg === null ? configuredCreateNew() : createNewArg === true;

      // ★★★ 第 0 站：目标实例在不在、要不要起、起了没、等到了没（★ 2026-09-30 新增）。
      //   旧代码在这里只有"扫一遍，挑一个活着的"——挑不到就报"请打开 WorkBuddy 桌面端"，
      //   而真机上桌面端明明开着 7 个进程。那句话把"**桌面端没开**"、"**桌面端开不出 sidecar**"、
      //   "**sidecar 全在忙**"三种处置完全不同的局面说成了同一句。
      //   现在这四种各有各的 reason code 与处置动作（见 ensure.js 的 HINTS）。
      const ensured = await ensurer.ensure({ signal, onPhase });
      const instance = ensured.report;
      currentInstance = instance;
      // ★ 实时递出去，而不是等整轮跑完再随返回值一起给。
      //   `ensure()` 在**下发 prompt 之前**就收敛了，而 prompt 这一步才是长的那一步：
      //   等到 `run()` 返回才播报，用户已经对着一个转圈的作业干等了几十秒。
      //   上层（`tools/gateway-run.js`）据此把结论**立刻**写进作业输出。
      onInstance?.(instance);
      if (!ensured.ok) {
        return fail(gatewayReasonForInstance(instance), {
          code: instance.code,
          instance,
          unavailable: instance.sidecar?.refused ?? null,
          message: instance.hint ?? 'no usable WorkBuddy sidecar.',
          // ★ 把"等了多久、有没有走过续等"一起递上去。
          //   `waitedMs` **不含窗口语义**：30s 与 10 分钟在它眼里是同一种数，
          //   而这两个数对使用者的含义完全相反（一个判死，一个还在等人）。
          waitedMs: instance.waitedMs ?? null,
          continuedWait: instance.wait?.continued === true,
          waitWindowMs: instance.wait?.totalWaitMs ?? null,
        });
      }
      const sidecar = ensured.sidecar;

      onPhase?.('authenticating');
      let token;
      try {
        ({ token } = await tokens.get(sidecar));
      } catch (e) {
        return fail(GATEWAY_REASON.token_unavailable, { code: 'token_unavailable', message: e.message });
      }

      onPhase?.('handshaking');
      const acp = createAcpClient({ url: sidecar.url, token, fetchImpl, onEvent: (m) => {
        const p = m?.params?.update?._meta?.['codebuddy.ai/agentPhase']?.phase;
        if (typeof p === 'string') onPhase?.(p);
      } });

      const conn = await acp.connect();
      if (!conn.ok) return fail(GATEWAY_REASON.handshake_failed, conn.error);
      const init = await acp.initialize();
      if (init.error) return fail(GATEWAY_REASON.handshake_failed, init.error);

      onPhase?.('opening_session');
      // ★★★ 载入会话，而不是 `session/new`。
      //
      //   `boundSessionId` 的语义因此**正过来**了：它不再是"绕过 new 的替代品"，
      //   而是"要续用哪条对话"——这正是它名字本来就该表达的东西。支撑是服务端在
      //   `initialize` 里宣告的 `agentCapabilities.loadSession === true`（真机读到），
      //   加上三条实测：
      //     1) 跨连接 load 已存在会话，事件里的 sessionId **不变** ⇒ 后续
      //        set_mode / set_model / prompt 都能继续用用户填的那个 id（不再有"prompt
      //        能不能寻址任意 id"这个未验证假设）；
      //     2) load 的 result 帧带 models.availableModels，事件流下发权限模式表
      //        ⇒ 顺带拿齐模型/倍率/权限三张表；
      //     3) 权限与模型**跨连接持久** ⇒ 载入不会把用户设好的设置打回默认。
      //
      //   为什么默认走 load 而不无脑 new：`session/new` 会把新建会话顶成 GUI 的活跃会话
      //   （真机复现 4 次）。这条代价**只付一次**——付在插件第一次自建自己那条对话时
      //   （下面 `sessionRenewed:'first_run'`），之后一律续用它。原先"永远不 new、
      //   必须人先开一条"是把这个一次性代价当成了每轮都要付的代价，于是把首轮也一起禁了。
      let models = [];
      let modes = null;
      // ★ workspace 既是发给 new/load 的 `cwd`，也是**随任务送进 prompt 的锚点**。
      //   它不是会话属性（见 acp.js `buildPromptBlocks` 的四条反证），所以真正起作用的
      //   是后面 `acp.prompt(..., { workspace })` 那一处；这里发 `cwd` 只是把意图带上，
      //   服务端当前会忽略它——留着无害，且哪天服务端支持了就能直接生效。
      const workspace = typeof cwd === 'string' && cwd.trim() !== '' ? cwd.trim() : configuredWorkspace();
      // ★★ 这条会话是**自己建的**还是**载入了已有的**？决定 `permission.confirmed` 怎么解释。
      //   真机实测（2026-09-28，probe-setmode-timing.mjs）：`set_mode` 在**自建**会话上是真生效的，
      //   在**已存在**的会话上只有回传、模式不变。所以权限没生效时，报错必须能指到这一条区别上，
      //   否则读者只能得到"权限坏了"这种没法行动的话。
      let sessionOrigin = 'loaded';
      // ★★★ 判定条件必须是 `sessionId === '' || createNew`，**不能**只看 `sessionId === ''`。
      //   原来只判空，于是"已绑定 + 显式要求新建"这一支被**静默降级成 load**：
      //   `new_conversation: true` 的字面承诺（"在新对话里跑，而不是绑定的那条"）被违背，
      //   而且**什么都不报错**——任务照样跑完，只是跑在了用户没要求的对话里，
      //   接着上一轮的上下文，还顺手把 GUI 的活跃对话留在原处。
      //   这与 §10.4 的 set_mode 是同一类错：**用一个无关的成功信号冒充承诺兑现**。
      //   代价（抢 GUI 活跃会话）本就是 opt-in 的、文档写明的，不构成不照做的理由。
      // ★★★ 会话从哪来 —— "插件自己 new 一条、之后一直用同一条"就落在这里。
      //
      //   三级优先级，**从上往下第一个满足的赢**：
      //     ① `boundSessionId` 非空          —— 用户在设置里显式绑的那条。**绝不**动它，也**绝不**替换它。
      //     ② 上一轮自己建的那条（记得住）  —— 直接续用（`session/load`）。**这一级就是"保持一个会话"。**
      //     ③ 都没有                        —— **自己 new 一条**，并立刻记下来，下次走②。
      //   `createNew === true` 在三者之上再加一条显式覆盖："这一轮另开一条"（新的同样被记下来）。
      //
      //   ★ ② 以前**根本不存在**：`session/new` 拿到的 id 返回给调用方就没了，没有任何落点。
      //     后果不是理论上的：`createNew=true` 时**每次调用都新建一条** ——
      //     既把桌面端的对话列表刷满，也让"多轮上下文"彻底作废（每轮从零开始，
      //     用户以为在跟同一条对话说话，其实在不停开新会话）。
      const bound = boundSession();
      const remembered = createNew ? '' : ownSession(ownKey);
      // ★ `createNew` 必须把**两条来源一起清掉**（绑定 + 记住的），不能只清记住的那条。
      //   只清 `remembered` 会算成 `sessionId = bound` ⇒ 走进 load 支 ⇒ 显式新建被**静默降级**
      //   （任务照样跑完，只是跑在用户明确不要的那条对话里，还接上了上一轮上下文）。
      //   这与 §10.4 的 set_mode 是同一类错：**用一个无关的成功信号冒充承诺兑现**。
      // ★★★ 2026-10-02 改判：优先级必须是 `remembered || bound`，不是 `bound || remembered` ★★★
      //   旧顺序（bound 优先）的实测后果：一旦 settings 里配了 `boundSessionId`，
      //   **所有** session_key 都被导向那一条绑定对话 —— 实测 `team-smoke-1` / `team-smoke-2` /
      //   `acc-verify-1` 三个不同任务全部落在同一个 `cli_session_id` 上。
      //   这直接违反本项目的产品语义「**一个任务 = 一条 WorkBuddy 对话**，只有要并行才另开」：
      //   三个任务共用一条对话 ⇒ 模型看到的是别人家的上文，任务之间互相污染。
      //
      //   改后的语义（三级，与文件头注的"绑定 → 记住的 → new"一致）：
      //     ① 这个 key 自己已经建过对话 ⇒ 用它自己的（**这才是"一个任务一条"的实现点**）
      //     ② 还没有 ⇒ 退到用户绑定的对话（他既然绑了，就是想先从这儿开始）
      //     ③ 都没有 ⇒ new 一条并记下来
      //   `createNew` 仍然把两条来源**一起**清掉（见上面那段注释：只清 remembered 会被
      //   `remembered || bound` 里的 bound 兜回来 ⇒ 显式新建被静默降级）。
      let sessionId = createNew ? '' : (remembered || bound);
      /** 本轮为什么走了"新建"这一支。**空串 = 正常续用**；非空就逐字带出去（§10.4 纪律）。 */
      let sessionRenewed = '';
      /** 记性写盘的结果。`null` = 压根没配持久化（进程内记性），非 null 就带出成败。 */
      let sessionPersist = null;
      if (sessionId !== '') {
        sessionOrigin = 'loaded';
        const loaded = await acp.loadSession(sessionId, workspace);
        if (loaded.error) {
          if (bound !== '') {
            // ★ 用户显式绑的那条续不上 ⇒ **不擅自换一条跑**。
            //   换掉就是 §10.4 的错：用一个无关的成功信号冒充承诺兑现（用户以为任务跑在他指定的那条上）。
            //   这里如实失败，并**点名是哪一种**（自建的续不上会自动重建，绑定的不会）。
            return fail(GATEWAY_REASON.handshake_failed, {
              code: 'bound_session_unloadable',
              message: 'The conversation bound in settings could not be loaded, and this '
                + 'dispatcher will not silently run the task in a different conversation. '
                + 'Re-check boundSessionId, or clear it to let the plugin own a conversation.',
              sessionId,
            });
          }
          // 记着的那条（**我们自己建的**）在桌面端已经没了 ⇒ 这属于"非必要之外"的那一次 new：
          // 作废记性、本轮重建。这是"保持一个会话"的**失效处置**，不是静默换会话
          // （下一轮仍然续用重建后的这条，不是每轮都换）。
          forgetOwnSession(sessionId, ownKey);
          sessionId = '';
          sessionRenewed = 'own_session_unloadable';
        } else {
          sessionId = loaded.sessionId ?? sessionId;
          models = loaded.models ?? [];
          modes = loaded.modes ?? null;
          // 续用成功也记账（刷新 lastUsedAt，让 §5.4 冷恢复按最近使用排序）
          sessionPersist = rememberOwnSession(sessionId, workspace, ownKey);
        }
      }
      if (sessionId === '') {
        sessionOrigin = 'new';
        if (sessionRenewed === '') {
          sessionRenewed = createNew ? 'create_new_requested' : 'first_run';
        }
        // ★ 连着 new 两次，**只留第二次**（为什么必须两次见 `NEW_SESSION_ATTEMPTS` 的实测）。
        //   第一次的结果是 GUI 当前那条，**下发前就丢掉**——绝不拿去 set_mode / prompt。
        let made = null;
        for (let attempt = 0; attempt < NEW_SESSION_ATTEMPTS; attempt += 1) {
          made = await acp.newSession(workspace);
          if (made.error) return fail(GATEWAY_REASON.handshake_failed, made.error);
        }
        if (typeof made.sessionId !== 'string' || made.sessionId === '') {
          return fail(GATEWAY_REASON.handshake_failed, {
            code: 'session_not_created',
            message: 'session/new did not return a sessionId',
          });
        }
        sessionId = made.sessionId;
        models = made.models ?? [];
        modes = made.modes ?? null;
        // ★★★ 记住它 —— 这就是"下一次别再 new"的那一步。
        //   记不住也**不中止**（会话是真的，任务能跑完），但把成败带出去：否则用户会在
        //   对话列表里看到一条条重复条目，却没有任何线索知道"插件没记住上一条"。
        sessionPersist = rememberOwnSession(sessionId, workspace, ownKey);
      }

      // ★★★ 权限必须在**下发任务之前**设好。
      //
      //   顺序是有理由的，不是排版洁癖：`dontAsk` 下 Bash 会被拒
      //   （真机 "Permission to use Bash has been denied because CodeBuddy is running in
      //   dontAsk mode"），而 `default`(Always Ask) 下没人点对话框任务就一直挂着。
      //   两者的处置完全相反，所以"这次任务用什么权限"必须是**这次**决定的事，
      //   不能沿用会话上一次残留的值——那正是设了 boundSession 直发、跑出 64 次工具调用
      //   却没人授权的那次事故。
      const wantMode = typeof permissionMode === 'string' && permissionMode !== ''
        ? permissionMode
        : configuredMode();
      // ★★★ 权限**不被下发**时也必须照实报——见 verifyPermissionMode 的真机证据。
      //   这里刻意**不因没生效就中止**：真机上 set_mode 恒不生效，一中止就等于
      //   "凡是请求权限模式的任务一律发不出去"，把工具变成摆设。真正危险的是**假装生效**：
      //   用户以为自己放开了 Bash，实际跑在 Always Ask 下（无 GUI 时直接挂死）。
      //   所以照常下发任务，但把"没生效"这条事实带出去，由上层如实转述。
      let permission = null;
      if (wantMode !== '') {
        onPhase?.('setting_permission');
        const m = await acp.setMode(sessionId, wantMode);
        if (m.error) return fail(GATEWAY_REASON.handshake_failed, m.error);
        const v = await verifyPermissionMode(sidecar, token, sessionId, wantMode, fetchImpl);
        permission = { requested: wantMode, echoed: m.modeId, effective: v.effective, confirmed: v.confirmed };
      }

      // ★ 模型**不再是必填**。原来"必须显式给模型"是因为 bound 路径拿不到清单只能瞎猜；
      //   现在 load 把清单带回来了，猜的必要性消失——会话自己记着上次用的模型。
      if (modelId === null || modelId === '') {
        onPhase?.('using_session_model');
      } else {
        onPhase?.('setting_model');
        const set = await acp.setModel(sessionId, modelId);
        if (set.error) return fail(GATEWAY_REASON.model_unavailable, set.error);
      }

      onPhase?.('prompting');
      const r = await acp.prompt(sessionId, prompt, { signal, workspace });
      // ★ 走到这里 `sessionId` / `sessionOrigin` / `sessionRenewed` / `sessionPersist` 都已是**实时值**，
      //   下面三个出口必须原样带出去（§10.4：承诺了什么、实际发生了什么，要能被读到）。
      //   `instance` 一并带出去：回执要能回答"这一轮的任务跑在哪台机器、哪个进程上" ——
      //   否则同一个 reason code 下，用户分不清是目标实例没起来还是任务本身失败。
      //   ★ B1 对账口径：`sessionId` 是回执 ↔ 会话 ↔ 落库的唯一可核对键；
      //     `receipt.requestId` 是单次 prompt 幂等键，与会话无关（见 receipt.js），不得混用。
      //     跨层白名单（gateway-run.js）与 noteRun（run.js）必须原样透传这四个字段，否则对不上。
      const resolved = { sessionId, sessionOrigin, sessionRenewed, sessionPersist, instance };
      if (r.error) {
        const reason = r.error.code === 'aborted' ? GATEWAY_REASON.aborted : GATEWAY_REASON.run_failed;
        return {
          ...fail(reason, r.error),
          sidecar: { pid: sidecar.pid, url: sidecar.url },
          models, modes, usedModelId: modelId, permission, ...resolved,
          // ★ prompt 终态（取消/失败/超时）：本地映射保留供复用，服务端无删除接口 ⇒ 如实记未回收。
          recycle: recycleNote('no_delete_api'),
        };
      }
      // ★ 拿到回执但 outcome 不是 SUCCESS ⇒ 判失败。返回一句"看起来正常"的正文
      //   却当成功记进账，是比崩溃更贵的错。
      if (r.receipt.succeeded !== true) {
        return {
          ok: false,
          reason: GATEWAY_REASON.run_failed,
          text: r.text,
          receipt: r.receipt,
          phases: r.phases,
          tools: r.tools,
          models,
          modes,
          usedModelId: modelId,
          permission,
          ...resolved,
          recycle: recycleNote('no_delete_api'),
          sidecar: { pid: sidecar.pid, url: sidecar.url },
          error: { code: 'not_successful', message: `run did not succeed (stopReason=${r.receipt.stopReason}, outcome=${r.receipt.outcome})` },
        };
      }
      return {
        ok: true, reason: null, text: r.text, receipt: r.receipt, phases: r.phases, tools: r.tools,
        models, modes, usedModelId: modelId, permission, ...resolved,
        recycle: recycleNote('retained_for_reuse'),
        sidecar: { pid: sidecar.pid, url: sidecar.url }, error: null,
      };
    },
  };
}
