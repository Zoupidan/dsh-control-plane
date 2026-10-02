/**
 * 目标实例保障（★ 2026-09-30 新增，下发链路的**第 0 站**）。
 *
 * <p>主理人给的七步里，前两步是：「**目标实例是否存在，是否要启动**」。在这次之前，
 *   `dispatch.run()` 只做了一件事：扫一遍 session 目录，挑一个**已经活着**的 sidecar；
 *   挑不到就报 `no_sidecar` + 一句"请打开 WorkBuddy 桌面端"。这在真机上是一句**错话**——
 *   2026-09-30 20:05 的证据：桌面端进程 7 个在跑（18:00:13 起），而插件报"没开"。
 *
 * <p>本模块把那一问拆成可回答的五步，每一步都留下**可复核的证据**：
 * <pre>
 *   1. probe        挑一次可用 sidecar（复用 sidecar.js 的 discover + selectSidecar，零重复实现）
 *   2. desktop      桌面端在不在？（tasklist CSV 枚举，只读）
 *   2.5 cancel      调用方已取消 ⇒ 停在动手之前（不该由我们弹出一个窗口）
 *   3. launch       不在 ⇒ 找安装位 ⇒ 拉起 ⇒ 等**本轮**broker 端点落盘
 *                   （**只推进到这里，不宣称"能跑了"**；已在跑的那一支同样要验端点）
 *   4. wait         等 sidecar 出现（轮询 1；sidecar 是**桌面端按对话拉起**的，它不来我们无能为力）
 *   5. report       把上面四步的结论落成 report，交给调用方进回执
 * </pre>
 *
 * <p>★★★ 2026-09-30 对抗审查：三条"看起来像结论、其实没验过"的地方 ★★★
 * <pre>
 *   F1  上一轮遗留的 `endpoint.json`（桌面退出**不删**，见 `wbipc.js:58`）被当成本轮"已就绪"
 *       ⇒ 冷启动窗口被跳到第一轮轮询，报告里落一句**假的** "broker endpoint present"。
 *       修：拉起那一刻记 `launchT0`，就绪要求端点 mtime ≥ launchT0（只 `stat`，不写）。
 *   F2  进程在跑 ⇒ `desktop.ready = true`，**零校验**：同一个布尔两种含义
 *       （"在跑"与"broker 端点已就绪"），而 `projectInstance` 把它直接送到用户眼前。
 *       修：这一支也问一次 `isBrokerReady()`。
 *   F3  `opts.signal` 没接进 `waitForDesktop` ⇒ 用户取消后仍跑满就绪窗口，
 *       还要报成 `desktop_not_ready`（把用户自己的取消写成环境故障）。
 *       修：signal 透传 + 每轮顶部检查 + 回 `aborted`。
 *   F4  并发 `ensure()` 无互斥 ⇒ N 个并发请求 = N 次拉起（多开实例抢同一凭据运行时）。
 *       修：`createEnsurer` 持有 in-flight promise。
 *   F6  ★★ `NO_SIDECAR_APPEARED` 被当成**终局** ★★（2026-09-30 演示前最后一段路）
 *       真机读数：桌面端进程在跑，ACP 端点**不存在**——端点跟"人开了一条对话"走，
 *       不跟"进程在跑"走。而 sidecar 恰恰是在**人下一次打开会话**时才出现的，可能是几分钟以后。
 *       旧行为：等满 `DEFAULT_WAIT_MS`(30s) 即 `finish(FAILED, …)`，此后**没有任何恢复路径**——
 *       人后来真的开了对话也救不回来，演示中途关一次会话则下一次下发必然直接失败。
 *       修：第一窗口到点**不判死**，转成**可取消的续等**（见 `runOnce` 第 4 步与
 *       `DEFAULT_TOTAL_WAIT_MS`）；只有总上限到点才失败，中途 `signal` abort 立刻 `ABORTED`。
 * </pre>
 *
 * <p>★★ 第 4 步为什么不能自己拉一个 sidecar ★★
 * 真机两条独立的证据都指向"凭据引导"这一个点：
 * <pre>
 *   桌面端自己拉的：WorkBuddy__a85776a06….log:68-69
 *       [CredentialBootstrap] … "runtimeStatus":"unavailable","reason":"transport-error"
 *       [CredentialProtection] prewarm bootstrap rejected
 *   插件自己拉 CLI：~/.codebuddy 会话日志（2026-09-30 19:18/19:20）
 *       Authentication required. Please use /login command to sign in to your account
 * </pre>
 * 登录态在**桌面进程内**，靠父子 IPC 注入；self-serve 的 CLI 拿不到它。
 * ⇒ "插件自己 spawn 一个 CLI 当载体"不是一条待优化的路，是**一条已被证伪的路**：
 *   它能建会话、能握手、能拿到回执形状，然后在真正发任务的那一刻被鉴权拒绝。
 *   本模块宁可如实报 `no_sidecar`，也不把这条路包装成"自动"。
 *
 * <p>★ 报告里的 `stage` 是给调用方看的**契约**，不是日志文案：
 *   `reused`（本来就绪）/ `started`（本轮拉起了桌面端）/ `waited`（等到了 sidecar）/ `failed`。
 *
 * 约束：本文件属于 packages 下的 src（CI ② 扫描范围）—— 不得出现裸进程出口字面量。
 * @module host/gateway/ensure
 */
import {
  DEFAULT_READY_TIMEOUT_MS, DESKTOP_IMAGE, findDesktopExe, isBrokerReady, isDesktopRunning,
  launchDesktop, waitForDesktop,
} from './desktop.js';

/** 本轮"目标实例"是怎么来的（进回执/状态面的一等公民）。 */
export const ENSURE_STAGE = Object.freeze({
  /** 一开始就有可用 sidecar。 */
  REUSED: 'reused',
  /** 桌面端原本没在跑，本轮把它拉起来了（**不代表任务一定能跑**，见 `no_sidecar`）。 */
  STARTED: 'started',
  /** 桌面端在跑，本轮轮询等到了 sidecar 出现。 */
  WAITED: 'waited',
  /** 没拿到可用 sidecar。 */
  FAILED: 'failed',
});

/** 失败归因码。每一码对应**一个处置动作**，不允许出现"再看看"这种无处置的码。 */
export const ENSURE_CODE = Object.freeze({
  /** 桌面上有 sidecar，但全都不可用（忙 / 端点解析不出 / 口令读不出）。 */
  NO_USABLE_SIDECAR: 'no_usable_sidecar',
  /** 进程枚举失败：分不清"没开"和"开不了"，此时**不**去拉起（避免多开实例抢凭据运行时）。 */
  DESKTOP_PROBE_FAILED: 'desktop_probe_failed',
  /** 本机找不到 WorkBuddy.exe 安装位。 */
  DESKTOP_NOT_INSTALLED: 'desktop_not_installed',
  /** 拉起动作本身失败。 */
  DESKTOP_LAUNCH_FAILED: 'desktop_launch_failed',
  /** 拉起了（或本来就在），但等不到 broker 端点 ⇒ 启动未完成。 */
  DESKTOP_NOT_READY: 'desktop_not_ready',
  /** 桌面端就绪，但窗口期内没有 sidecar 出现。 */
  NO_SIDECAR_APPEARED: 'no_sidecar_appeared',
  /** 等待被调用方取消。 */
  ABORTED: 'aborted',
});

/**
 * ★ 续等期间推进给上层的阶段名（`opts.onPhase` 词表，与 `dispatch.js` 既有的
 *   `discovering` / `authenticating` / `handshaking` / `opening_session` / `setting_permission` /
 *   `setting_model` / `prompting` 同风格：动词短语、snake_case）。
 *
 * <p>★ 它**只**说"在等 sidecar"，**不**说进入了任何模型阶段：这一轮还没发出一个 token、
 *   还没握手、还没建会话。写成一个看起来像"已进入思考"的词，就是把一段**静默的等待**
 *   包装成"在跑"——那比转圈更坏，因为用户会以为不该打断。
 */
export const ENSURE_PHASE = Object.freeze({
  /** 本模块正在进行（含 probe / 拉起 / 等 broker 端点）。值与旧字面量逐字相同，只是收进词表。 */
  ENSURING_INSTANCE: 'ensuring_instance',
  /** 桌面端已就绪，正在等**人**开一条对话（sidecar 由此出现）。 */
  AWAITING_SIDECAR: 'awaiting_sidecar',
});

/** 等 sidecar 出现的默认窗口。桌面端拉起 prewarm sidecar 实测在激活后 1–3s 内。 */
export const DEFAULT_WAIT_MS = 30_000;

/**
 * ★★ 续等的**总**上限（从等待那一刻起算，**不是**"再等这么久"）★★
 *
 * <p>**为什么"明显更长"是必需的，而不是"再给一个 30s"**：
 * <pre>
 *   sidecar 何时存在：桌面端**人打开一条对话**时才拉起。真机读数（2026-09-30）——
 *     桌面端 7 个进程在跑、ACP 端点却不存在 ⇒ 端点跟"对话"走，不跟"进程"走。
 *   ⇒ `DEFAULT_WAIT_MS = 30_000` 量的是**机器**（prewarm 实测激活后 1–3s），
 *     而第一窗口之后要等的是**人的注意力**。30s 里人连窗口都切不过去：
 *     那个窗口量错了对象，不是短了。所以 30s 到点必须换一种等法，而不是判死。
 * </pre>
 *
 * <p>**取值 10 分钟的依据**（三面收敛，不是一个拍出来的数）：
 * <pre>
 *   下界（不能再短）——它要覆盖的是"人从看见失败到开出对话"这一段：
 *     读作业输出 → 切到 WorkBuddy 窗口 → 新建/激活一条对话。同屏本机完成也要几十秒，
 *     所以 < 1 分钟的总窗口仍然会在人动手之前判死，等于没改。
 *   上界（不能再长）——它等的是一个**还愿意等结果**的人。10 分钟是"人还在盯着这一次
 *     下发"的常见上限；再往上不是耐心问题而是"人已经走了"，此时继续占着作业与 `inflight`，
 *     换来的只是一句更晚、答案完全相同的失败。
 *   形状（为什么是 10 而不是 5 或 30）——5 分钟容不下"扫一眼→去开个会→回来看"；
 *     30 分钟超出任何一次演示的注意力预算，还要把 `inflight` 占住半小时。
 * </pre>
 *
 * <p>★ 与 `DEFAULT_WAIT_MS` 是**串联不是替代**：前 30s 按 `DEFAULT_POLL_MS` 密轮询
 *   （prewarm 1–3s，密一点无代价），过点后转 `DEFAULT_CONTINUED_POLL_MS` 慢档——续等窗口的
 *   **事件是人**（秒~分钟级），500ms 密轮询只会把"进程枚举 + 读口令（每轮一次 PEB 读取）"
 *   重复上千遍（10min/500ms = 1200 轮）。那不是"等人"，那是拿机器去追人。
 *
 * <p>★ 代价写明（不改 F4 的取舍，只记录它的后果变大了）：这一轮在整个续等期间占着
 *   `inflight` 互斥（`createEnsurer` 的 in-flight promise）。窗口由"最多 30s"变成"最多 10 分钟"。
 *   并发请求会一起等这一个承诺——这与 F4 既有设计一致，只是等待更久，故显式记录在此。
 *
 * <p>可注入：`deps.totalWaitMs`（与 `deps.waitMs()` 同风格），单测里设成毫秒级。
 */
export const DEFAULT_TOTAL_WAIT_MS = 600_000;

/** 轮询间隔。与 `desktop.js` 同尺度，不制造第三个节拍。 */
export const DEFAULT_POLL_MS = 500;

/**
 * 续等阶段的轮询间隔（第一窗口过了之后才切到这里）。
 *
 * <p>为什么要有慢档：续等等的是**人开一条对话**，这件事的时间尺度是秒到分钟；
 * 而每一轮探测都要真做 I/O——进程表枚举 + 端点解析 + 口令读取（一次 PEB 读取）。
 * 按 500ms 轮 10 分钟 = 1200 轮这种 I/O，收益是零（人不会因为我们多问 1199 次就更快动手），
 * 代价是机器白烧，还多一次把口令读出口的机会。慢档把 10 分钟压到 ~120 轮。
 */
export const DEFAULT_CONTINUED_POLL_MS = 5_000;

/** 时间线最多留几条（会进作业输出 ⇒ 必须有界）。 */
const MAX_ATTEMPTS = 8;

const sleepDefault = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * @param {object} deps
 * @param {() => Promise<{picked: object|null, why: {code: string, detail: string}|null, scanned: number}>} deps.probe
 *   挑一个可用 sidecar；由 `dispatch.js` 注入（它已经持有 discover/selectSidecar 闭包）。
 * @param {(spec: {argv: string[]}) => Promise<string>} [deps.run] 进程枚举用（`tasklist`）
 * @param {(spec: {argv: string[]}) => object} [deps.launcher] 拉起用（`apply.js` 接官方 seam）
 * @param {() => boolean} [deps.autoStart] 拉起开关（`autoStartDesktop` 设置）
 * @param {number|(() => number)} [deps.waitMs] 等 sidecar 的**第一**窗口
 * @param {number|(() => number)} [deps.totalWaitMs]
 *   等 sidecar 的**总**上限（从等待那一刻起算；含第一窗口）。★ 续等就在这两个数之间发生：
 *   第一窗口到点不判死，继续等到这个数才算失败。注入成毫秒级即可在单测里跑完整条续等路径。
 * @param {number|(() => number)} [deps.pollMs] 第一窗口内的轮询间隔（默认 `DEFAULT_POLL_MS`）
 * @param {number|(() => number)} [deps.continuedPollMs]
 *   转入续等之后的轮询间隔（默认 `DEFAULT_CONTINUED_POLL_MS`）。两者分开是为了让"慢档"
 *   在单测里可观测——续等期间确实让出了，而且确实换了更长的节拍。
 * @param {() => {path: string, source: string}|null} [deps.findExe] 安装位查找（默认 `findDesktopExe`）
 * @param {string} [deps.endpointFile] broker 端点文件（测试夹具位）
 * @param {() => number} [deps.now]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 */
export function createEnsurer(deps = {}) {
  const {
    probe, run, launcher, autoStart, now = Date.now, sleep = sleepDefault,
  } = deps;
  const findExe = typeof deps.findExe === 'function' ? deps.findExe : findDesktopExe;
  // ★ 就绪判定复用 `desktop.js` 的 broker 读法，只在这里把**端点文件位**透传出去 ——
  //   路径常量仍然只有 `wbipc.js` 一份，测试则能指到夹具。
  const readyOpts = () => (typeof deps.endpointFile === 'string'
    ? { endpointFile: deps.endpointFile } : {});
  const waitMs = () => {
    const v = typeof deps.waitMs === 'function' ? deps.waitMs() : deps.waitMs;
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_WAIT_MS;
  };
  // ★ 总上限与两个轮询节拍都走**同一种注入形状**（number 或 () => number，越界回落默认），
  //   这样单测能一次性把整条续等路径压进毫秒级，而不必去真睡 10 分钟。
  const totalWaitMs = () => {
    const v = typeof deps.totalWaitMs === 'function' ? deps.totalWaitMs() : deps.totalWaitMs;
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_TOTAL_WAIT_MS;
  };
  const pollMs = () => {
    const v = typeof deps.pollMs === 'function' ? deps.pollMs() : deps.pollMs;
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_POLL_MS;
  };
  const continuedPollMs = () => {
    const v = typeof deps.continuedPollMs === 'function' ? deps.continuedPollMs() : deps.continuedPollMs;
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_CONTINUED_POLL_MS;
  };
  const mayLaunch = () => (typeof autoStart === 'function' ? autoStart() === true : false);

  /**
   * ★ 并发互斥（F4）：同一时刻只跑一遍保障流程。
   *
   * <p>为什么必须有：`autoStartDesktop` 默认为开（`config/schema.js`），而**两个请求落在同一秒内**
   *   ——模型连发两个任务、用户点重试——会各自看到"桌面端没在跑"，各拉一个实例，
   *   两个实例抢**同一个凭据运行时**（`desktop.js` 模块头记的头号禁忌）。
   *   实测：3 个并发 `ensure()` ⇒ launcher 被调 3 次。
   *
   * <p>★ 代价（明说，不藏）：后来的调用拿到的是**同一份 report 对象**（同一引用），
   *   它的 `onPhase` 不会被单独调用，它的 `signal` 也不参与这一轮。
   *   换来的是"N 次请求至多 1 次拉起"这条硬保证 —— 少一次回调比多开一个桌面端便宜得多。
   */
  let inflight = null;

  /**
   * 确保有一个可用 sidecar。
   *
   * @param {{signal?: AbortSignal, onPhase?: (p: string) => void}} [opts]
   * @returns {Promise<{ok: boolean, sidecar: object|null, report: object}>}
   */
  function ensure(opts = {}) {
    if (inflight !== null) return inflight;
    const p = runOnce(opts).finally(() => { if (inflight === p) inflight = null; });
    inflight = p;
    return p;
  }

  /**
   * 真正跑一遍（`ensure()` 已挡住并发，这里不再考虑互斥）。
   *
   * @param {{signal?: AbortSignal, onPhase?: (p: string) => void}} opts
   * @returns {Promise<{ok: boolean, sidecar: object|null, report: object}>}
   */
  async function runOnce(opts = {}) {
    const t0 = now();
    const attempts = [];
    const note = (stage, detail) => {
      if (attempts.length < MAX_ATTEMPTS) attempts.push({ at: now() - t0, stage, detail });
    };
    const finish = (stage, code, sidecar, desktop, extra = {}) => ({
      ok: sidecar !== null,
      sidecar,
      report: {
        stage,
        code: stage === ENSURE_STAGE.FAILED ? code : 'ok',
        ok: sidecar !== null,
        at: t0,
        waitedMs: now() - t0,
        desktop,
        sidecar: {
          scanned: extra.scanned ?? 0,
          picked: sidecar !== null,
          refused: extra.why ?? null,
        },
        // ★ 这一段等待的**账**：两窗口各多少、是否走过续等、探测了几轮。
        //   它回答的是本次修复的核心问题——"30s 就死"与"人一直没来"在回执上必须长得**不一样**，
        //   而它们在 `stage` / `code` / `waitedMs` 上都同形（都是 failed + no_sidecar_appeared），
        //   所以必须单独带一个可判据的布尔。缺了它，上层只能按 30s 那种心智模型去解释一条
        //   其实已经等了 10 分钟的回执。
        wait: extra.wait ?? null,
        attempts,
        // ★ `extra.hint` 是**唯一**的按局面改写口：绝大多数 code 一码一句（`HINTS`），
        //   只有 `DESKTOP_NOT_READY` 有两种证据（见 `HINT_DESKTOP_ENDPOINT_STALE`），
        //   现在再加一种：走完了续等的 `NO_SIDECAR_APPEARED`（见 `HINT_NO_SIDECAR_AFTER_LONG_WAIT`）。
        //   刻意不给"全局换一句"的口子 —— 那种口子最后会长成七套文案。
        hint: stage === ENSURE_STAGE.FAILED ? extra.hint ?? HINTS[code] ?? HINT_DEFAULT : null,
      },
    });

    // ── 1. 先问一次：有没有已经活着的可用 sidecar ────────────────────────────
    opts.onPhase?.(ENSURE_PHASE.ENSURING_INSTANCE);
    const first = await probe();
    if (first?.picked) {
      note('probe', `reused sidecar pid=${first.picked.pid}`);
      return finish(ENSURE_STAGE.REUSED, '', first.picked, null, { scanned: first.scanned });
    }
    note('probe', `no usable sidecar (${first?.why?.code ?? 'unknown'})`);

    // ── 2. 桌面端在不在 ────────────────────────────────────────────────────
    //   没有 `run`（单测/裁剪装配）时**不猜**：直接落到 failed，`code` 如实写明缺什么。
    if (typeof run !== 'function') {
      return finish(ENSURE_STAGE.FAILED, ENSURE_CODE.NO_USABLE_SIDECAR, null, null, {
        scanned: first?.scanned ?? 0, why: first?.why?.code ?? 'no_probe',
      });
    }
    const proc = await isDesktopRunning({ run }, { image: DESKTOP_IMAGE });
    const desktop = {
      image: DESKTOP_IMAGE,
      running: proc.running,
      pids: proc.pids,
      probeError: proc.error,
      exe: null,
      launched: false,
      launchPid: null,
      launchError: null,
      ready: false,
      brokerDetail: null,
      // ★ 端点"在但陈旧"与"根本没落盘"是**两种**失败：前者盘上有一份**别的**运行留下的文件，
      //   后者盘上什么都没有。回执里 `code` 分不开它们（都叫 `desktop_not_ready`），
      //   `brokerDetail` 能分（`predates this launch (stale)`），这个布尔把"分"这件事变成可判据的。
      brokerStale: false,
    };

    // ★ 枚举失败 ≠ 没在跑。这两种情况下**都不**去拉起：多开一个桌面端实例会和已开的那一个
    //   抢同一个凭据运行时（`WorkBuddy__a85776a06….log:68` 那种 transport-error 的高发场景）。
    if (proc.error !== null) {
      desktop.probeError = proc.error;
      note('desktop', `probe failed: ${proc.error}`);
      return finish(ENSURE_STAGE.FAILED, ENSURE_CODE.DESKTOP_PROBE_FAILED, null, desktop, {
        scanned: first?.scanned ?? 0, why: first?.why?.code ?? null,
      });
    }

    // ── 2.5 取消要先于"动手" ──────────────────────────────────────────────
    //   用户已经撤了，就不该由我们去弹一个 WorkBuddy 窗口出来。abort 早于这一步时，
    //   `desktop.launched` 保持 false —— 报告要如实说"这一轮什么都没动"。
    if (opts.signal?.aborted) {
      note('desktop', 'aborted before any desktop action');
      return finish(ENSURE_STAGE.FAILED, ENSURE_CODE.ABORTED, null, desktop, {
        scanned: first?.scanned ?? 0, why: first?.why?.code ?? null,
      });
    }

    // ── 3. 不在 ⇒ 要不要起 ────────────────────────────────────────────────
    if (!proc.running) {
      note('desktop', 'not running');
      if (!mayLaunch()) {
        return finish(ENSURE_STAGE.FAILED, ENSURE_CODE.NO_USABLE_SIDECAR, null, desktop, {
          scanned: first?.scanned ?? 0, why: first?.why?.code ?? null,
        });
      }
      const exe = findExe();
      desktop.exe = exe?.path ?? null;
      if (exe === null) {
        note('launch', 'no install path found');
        return finish(ENSURE_STAGE.FAILED, ENSURE_CODE.DESKTOP_NOT_INSTALLED, null, desktop, {
          scanned: first?.scanned ?? 0, why: first?.why?.code ?? null,
        });
      }
      if (typeof launcher !== 'function') {
        note('launch', 'no launcher wired');
        return finish(ENSURE_STAGE.FAILED, ENSURE_CODE.DESKTOP_LAUNCH_FAILED, null, desktop, {
          scanned: first?.scanned ?? 0, why: first?.why?.code ?? null,
        });
      }
      // ★★ F1：就绪的**新鲜度**下限 ★★ 记在 `launchDesktop` **之前**，不是之后 ——
      //   `endpoint.json` 在桌面退出时不删（`wbipc.js:58`），"拉起之后再看一眼文件在不在"读到的是
      //   **上一轮**的残留；而记在拉起之后，万一桌面端抢先落盘（2s 的窗口 vs 一次 spawn 的往返）
      //   就会把**本轮自己的**端点判成陈旧。用真实墙钟：它要和文件系统 mtime 同一把尺子。
      const launchT0 = Date.now();
      const started = await launchDesktop({ launcher }, { exe: exe.path, image: DESKTOP_IMAGE });

      desktop.launched = started.started;
      desktop.launchPid = started.pid;
      desktop.launchError = started.error;
      if (!started.started) {
        note('launch', `failed: ${started.error}`);
        return finish(ENSURE_STAGE.FAILED, ENSURE_CODE.DESKTOP_LAUNCH_FAILED, null, desktop, {
          scanned: first?.scanned ?? 0, why: first?.why?.code ?? null,
        });
      }
      note('launch', `started pid=${started.pid ?? '?'}`);

      // ★ 拉起成功只说明"进程起来了"。桌面端完成启动的判据是 broker 端点落盘（真机 2s）。
      // ★ F5：就绪窗口**不能**被"等 sidecar 的窗口"顶掉 —— `instanceTimeoutMs`（默认 30s）
      //   说的是"等 sidecar"，冷启动余量是另一笔账；取两者较大值，两个窗口各自干自己的事。
      //   最坏情况因此是 `readyTimeoutMs + waitMs()`，这个算术写在这里而不是藏在代码里。
      const readyTimeoutMs = Math.max(waitMs(), DEFAULT_READY_TIMEOUT_MS);
      const ready = await waitForDesktop({ run, sleep, now }, {
        ...readyOpts(), timeoutMs: readyTimeoutMs, notBeforeMs: launchT0, signal: opts.signal,
      });
      desktop.ready = ready.ready;
      desktop.pids = ready.pids.length > 0 ? ready.pids : desktop.pids;
      desktop.brokerDetail = ready.lastDetail;
      desktop.brokerStale = ready.stale === true;
      // ★ F6(b)：整个就绪窗口 tasklist 全程失败 ⇒ 归因是**枚举坏了**，不是"桌面端没起来"。
      //   旧代码把 `ready.error` 丢在半路 ⇒ 回执里 `probeError:null, ready:false` 与真正的
      //   超时**长得一模一样**，两种处置不同的局面被压成同一句话。
      if (ready.error !== null && ready.error !== undefined) {
        desktop.probeError = ready.error;
        note('ready', `process enumeration kept failing: ${ready.error}`);
      }
      // ★ F3：取消落在就绪等待里 ⇒ 回 `aborted`，不许报成"桌面端没起来"。
      if (ready.aborted) {
        note('ready', 'aborted while waiting for the broker endpoint');
        return finish(ENSURE_STAGE.FAILED, ENSURE_CODE.ABORTED, null, desktop, {
          scanned: first?.scanned ?? 0, why: first?.why?.code ?? null,
        });
      }
      if (!ready.ready) {
        note('ready', `broker not ready: ${ready.lastDetail ?? ready.error ?? 'timeout'}`);
        return finish(ENSURE_STAGE.FAILED, ENSURE_CODE.DESKTOP_NOT_READY, null, desktop, {
          scanned: first?.scanned ?? 0, why: first?.why?.code ?? null,
          // ★ F1 的回声：端点**陈旧**时不能说"桌面端没启动完"——盘上那份文件是**别的**运行留下的，
          //   桌面端完全可能好得很。同一个 `code` 配两句话，理由见 `HINT_DESKTOP_ENDPOINT_STALE`。
          hint: ready.stale === true ? HINT_DESKTOP_ENDPOINT_STALE : undefined,
        });
      }
      note('ready', 'broker endpoint present');
    } else {
      // ★★ F2：进程在 ≠ 就绪 ★★ 旧代码在这里直接 `ready = true`，**零校验**，
      //   于是"桌面端在跑但 broker 端点根本不存在"与"桌面端在跑且已就绪"在
      //   `desktop.ready` 这一个布尔上**完全同形**，而 `projectInstance` 把它直接送到用户眼前。
      //   本模块头的验收标准写的就是 broker 端点 ⇒ 进程在跑时也要问那一句
      //   （一次 readFile，几 ms；真机上桌面端在跑时它答"ready"，不会变成假阴性）。
      const broker = await isBrokerReady(readyOpts());
      desktop.ready = broker.ready;
      desktop.brokerDetail = broker.detail;
      // 这一支没传 `notBeforeMs`（进程本来就在跑，没有"本轮拉起"可言）⇒ 这里恒为 false。
      // 仍要如实抄：将来谁往这条路上加了新鲜度闸门，这一行不用再改。
      desktop.brokerStale = broker.stale === true;
      note('desktop', `running pids=[${proc.pids.join(',')}] broker=${broker.ready ? 'ready' : (broker.detail ?? 'not ready')}`);
    }

    // ── 4. 桌面端就绪 ⇒ 等 sidecar 出现 ────────────────────────────────────
    //   sidecar 是**桌面端按对话**拉起来的（真机：`~/.workbuddy/sessions` 目录 mtime 19:40:10
    //   说明文件被创建后又被删除；`[Prewarm] activated …` 只在有对话激活时才发生）。
    //   ⇒ 这里能做的只有"等"，等不到就是等不到，如实报出去。
    //
    // ★ 成功时的 stage 归谁，取决于**本轮是不是我们把桌面端拉起来的**：
    //   用户问的是两件事（实例在不在 / 要不要启动），"启动"那件的答案必须留在**顶层**，
    //   不能只藏在 `desktop.launched` 里等人自己往下翻 —— 否则"这轮有一步是人替我们做的"
    //   和"这轮纯粹是复用"在回执上长得一模一样。
    const successStage = desktop.launched ? ENSURE_STAGE.STARTED : ENSURE_STAGE.WAITED;
    const firstWindowMs = waitMs();
    const totalMs = totalWaitMs();
    const waitStart = now();
    // ★ 两个截止点，语义**不同**，别混：firstDeadline = "机器那 30s 到了"（转慢档继续等），
    //   hardDeadline = "人也没来"（这才失败）。旧代码只有一个 deadline，于是第一窗口到点
    //   就直接判死——这就是 F6。
    const firstDeadline = waitStart + firstWindowMs;
    const hardDeadline = waitStart + totalMs;
    let scanned = first?.scanned ?? 0;
    let why = first?.why ?? null;
    let continued = false;
    let polls = 0;
    // ★ 这段等待**外部必须看得见**：默认窗口下它最长 10 分钟，一段没有任何回执的静默，
    //   在用户那侧与"卡死"**完全同形**（那正是本次要修的症状的一半）。
    opts.onPhase?.(ENSURE_PHASE.AWAITING_SIDECAR);
    for (;;) {
      // ★ 取消必须在每轮顶部就认。旧窗口 30s 时这条只是"别让他白等"，续等 10 分钟时
      //   它变成"用户点了取消还要再转 10 分钟"——那一轮会一直占着 `inflight`（F4 的既有取舍），
      //   而用户拿到的是一句"没有 sidecar"，等于把他自己的取消写成环境故障（F3 的同款错）。
      if (opts.signal?.aborted) {
        note('wait', 'aborted while waiting for a sidecar');
        return finish(ENSURE_STAGE.FAILED, ENSURE_CODE.ABORTED, null, desktop, {
          scanned, why: why?.code ?? null, wait: { firstWindowMs, totalWaitMs: totalMs, continued, polls },
        });
      }
      // ★ 必须让出（不许空转）：每一轮探测都是真 I/O，而且不 sleep 会让同进程的状态面、
      //      取消信号这些**别的**请求排到这一轮结束。续等转慢档（见 `DEFAULT_CONTINUED_POLL_MS`）。
      await sleep(continued ? continuedPollMs() : pollMs());
      const again = await probe();
      polls += 1;
      scanned = again?.scanned ?? scanned;
      why = again?.why ?? why;
      if (again?.picked) {
        note('wait', `sidecar appeared pid=${again.picked.pid}`
          + (continued ? ` · after the first window elapsed (${firstWindowMs}ms)` : ''));
        return finish(successStage, '', again.picked, desktop, {
          scanned, why: why?.code ?? null, wait: { firstWindowMs, totalWaitMs: totalMs, continued, polls },
        });
      }
      const t = now();
      // ★ 第一窗口到点**不是失败**，是"换一种等法"：机器那 30s 已经尽力了，
      //   接下来等的是**人**（打开一条对话）。此时再判死就是本次要修的那条终局失败。
      if (!continued && t >= firstDeadline) {
        continued = true;
        note('wait', `first window (${firstWindowMs}ms) elapsed with no sidecar · continuing up to ${totalMs}ms total`);
        // 再推一次同一个 phase：契约要求"续等期间 phase 被推进过"必须**外部可观测**。
        // 上层 `gateway-run.js` 对**连续相同**的 phase 会去重，所以这一推不产生刷屏。
        opts.onPhase?.(ENSURE_PHASE.AWAITING_SIDECAR);
      }
      if (t >= hardDeadline) {
        note('wait', continued
          ? `total window (${totalMs}ms) elapsed · still no sidecar`
          : 'window elapsed without a sidecar');
        return finish(ENSURE_STAGE.FAILED, ENSURE_CODE.NO_SIDECAR_APPEARED, null, desktop, {
          scanned, why: why?.code ?? null,
          wait: { firstWindowMs, totalWaitMs: totalMs, continued, polls },
          // ★ 续等耗尽 ⇒ 用那句点破"恢复路径不存在"的提示；没走到续等则保持既有那句。
          hint: continued ? HINT_NO_SIDECAR_AFTER_LONG_WAIT : undefined,
        });
      }
    }
  }

  return { ensure };
}

/** 每个失败码一句**可执行**的话。写"再试一次"等于没写。 */
const HINTS = Object.freeze({
  [ENSURE_CODE.NO_USABLE_SIDECAR]:
    'No usable WorkBuddy sidecar. Open the WorkBuddy desktop and start a conversation there — '
    + 'the gateway sidecar is started per conversation by the desktop, not by this plugin.',
  [ENSURE_CODE.DESKTOP_PROBE_FAILED]:
    'Could not enumerate running processes, so the plugin cannot tell whether WorkBuddy is already '
    + 'open. It did not launch a second copy on purpose. Start the desktop yourself, then retry.',
  [ENSURE_CODE.DESKTOP_NOT_INSTALLED]:
    'WorkBuddy.exe was not found in any known install location. Point the plugin at the real path, '
    + 'or start the desktop yourself.',
  [ENSURE_CODE.DESKTOP_LAUNCH_FAILED]:
    'Launching WorkBuddy.exe failed. Start the desktop manually, then retry.',
  [ENSURE_CODE.DESKTOP_NOT_READY]:
    // ★ 这一句只覆盖"端点**根本没落盘**"。端点**陈旧**（盘上是上一轮的残留）时改用
    //   `HINT_DESKTOP_ENDPOINT_STALE` —— 在这一支硬套本句，等于断言一件没有证据的事。
    'WorkBuddy.exe was started but never published its broker endpoint — the desktop did not finish '
    + 'starting. Check the desktop window, then retry.',
  [ENSURE_CODE.NO_SIDECAR_APPEARED]:
    'The WorkBuddy desktop is running but published no agent sidecar within the wait window. '
    + 'Open a conversation in the desktop; the sidecar exists only while a conversation is active.',
  [ENSURE_CODE.ABORTED]: 'Cancelled before a sidecar became available.',
});

const HINT_DEFAULT = HINTS[ENSURE_CODE.NO_USABLE_SIDECAR];

/**
 * ★ 续等到**总上限**仍未出现 sidecar 时的提示（走 `extra.hint` 那条既有的覆写缝，
 *   与 `HINT_DESKTOP_ENDPOINT_STALE` 同一个理由：**一码两证据 ⇒ 两句提示**，各自说清
 *   "你看到的到底是哪一段等待结束了"）。
 *
 * <p>★ 刻意**保留** `HINTS[NO_SIDECAR_APPEARED]` 的原话再**追加**一句，理由两条：
 * <pre>
 *   ① 那句"within the wait window"在新窗口（默认 10 分钟）下**依然为真**，只是不再是
 *      最有区分度的部分；把新信息**追加**而不是替换，是唯一既诚实又不顶掉既有识别串的做法。
 *   ② 它已被既有契约钉住：`gateway-instance-ensure.test.js` 把该句当作 `NO_SIDECAR_APPEARED`
 *      的标识串断言。替换掉它 = 悄悄改掉一条对外契约。
 * </pre>
 *
 * <p>追加的那句必须点破**恢复路径不存在**这一条：续等已经耗尽，"人后来开了对话"救不回
 * 这一轮（这一轮已经收敛成失败），正确动作是**开了对话之后重新下发**。
 * 不写这一句，用户会以为"我现在去开对话，它自己会跑起来"——那正是本次要修的旧症状。
 */
const HINT_NO_SIDECAR_AFTER_LONG_WAIT = `${HINTS[ENSURE_CODE.NO_SIDECAR_APPEARED]}`
  + ' This plugin waited out a longer, cancellable extended wait window and still saw no sidecar:'
  + ' a sidecar exists only while a conversation is open in the WorkBuddy desktop app, so nothing'
  + ' can run until one is opened there. Opening a conversation does NOT revive this finished run —'
  + ' send the task again once a conversation is open.';

/**
 * ★ `DESKTOP_NOT_READY` 的**另一半**证据：端点**陈旧**，不是"没落盘"。
 *
 * <p>★★ 为什么同一个 code 要配两句话 ★★
 * <pre>
 *   落到这个分支时，回执里同时写着两件**互相拆台**的事：
 *     hint            "…the desktop did not finish starting. Check the desktop window."
 *     brokerDetail    "endpoint.json predates this launch (stale)"
 *   读的人被第一句送去"看看桌面端窗口是不是崩了"，而第二句说的其实是：
 *   盘上那份 `endpoint.json` 是**上一轮**运行留下的（桌面退出不删，`wbipc.js:58`），
 *   本轮没被重写。真机上桌面端窗口**完全可能是好的** —— 判不出来的原因是
 *   两份文件在内容上**逐字节同形**，唯一能分辨的 mtime 已经在 `brokerDetail` 里说了。
 *   让一句话覆盖两种证据，等于把"去查启动失败"这个**错的**排查方向钉死给用户。
 * </pre>
 *
 * <p>处置也不同：非 stale 那支是"桌面端启动没走完 ⇒ 看窗口"；
 *   这一支是"端点是旧的 ⇒ 桌面端好得很就别管它，让它重写一份"，
 *   所以给的动作是**完全退出桌面端再开一次**，而不是"去看窗口"。
 *
 * <p>刻意**不含** "did not finish starting"：这句断言在陈旧侧没有证据支撑，
 *   而它会盖掉 `brokerDetail` 已经如实写下的那一半。
 */
const HINT_DESKTOP_ENDPOINT_STALE =
  'WorkBuddy.exe was started, but the only broker endpoint on disk is a leftover from an earlier run: '
  + 'endpoint.json still predates this launch, so the desktop may well be running normally and simply '
  + 'has not republished it. If the desktop window looks healthy, quit the desktop completely and start '
  + 'it again so it writes a fresh endpoint, then retry.';

/**
 * 把 report 投影成**允许离开插件**的形状（★ 2026-09-30）。
 *
 * <p>★ 为什么要投影，而不是直接把 report 丢出去 ★
 *
 * <p>report 是给**排查**用的，它按"证据留全"的取向长：安装路径、进程号、每一轮的探测细节、
 *   每一个错误原文。作业输出和 `workbuddy_status` 的 `lastRun` 都不是排查界面——前者会被滚走、
 *   后者每次自查都重读一遍——把这一份摊给它们，代价是三笔：
 * <pre>
 *   ① **回答不了问题**：`desktop.exe` 是"这台机器的地图"（`C:\Users\<你>\AppData\…`），
 *      对"实例在不在"这个问题零信息量，却占着一整行预算，还把本机用户名写进对话记录。
 *   ② **太长**：`attempts` 最多 8 条、每条一句自然语言；连同 `probeError` / `launchError` /
 *      `brokerDetail` 一起进 `lastRun`，等于让每个自查调用都拖着几 KB 与问题无关的散文。
 *   ③ **红线**：`tools/ci/check-no-credential-echo.mjs` 扫的是**代码里的 echo 写法**，
 *      扫不到运行时载荷。也就是说"把一个将来可能被塞进凭据的字段原样透传"不会被任何红线拦下。
 *      投影就是那道**显式**闸门：不在清单上的字段，根本不进门。
 * </pre>
 *
 * <p>★ 为什么留下 `desktop.{running,launched,ready}` 这三个布尔 ★
 *   主理人问的两句是「目标实例**是否存在**，**是否要启动**」，而 `stage` 单独答不全：
 *   `stage:failed` 时，`desktop.running=false, launched=false` 恰恰在说
 *   "桌面端本来就没开，而 `autoStartDesktop` 关着所以我没去开"——这是与
 *   "开了但拉不起来"（`launched=true, ready=false`）**处置完全不同**的两种失败。
 *   三个布尔各值一次钱，不带任何路径/进程号/错误原文。
 *
 * @param {object|null|undefined} report `ensure()` 的 `report`（可空 ⇒ 返回 `null`）
 * @returns {{
 *   stage: string, code: string, ok: boolean, waitedMs: number,
 *   desktop: {running: boolean, launched: boolean, ready: boolean}|null,
 *   sidecar: {scanned: number, picked: number, refused: string|null},
 *   wait: {firstWindowMs: number, totalWaitMs: number, continued: boolean, polls: number}|null,
 *   hint: string,
 * }|null}
 */
export function projectInstance(report) {
  // ★ 数组也要挡掉：`typeof [] === 'object'` 过得去这道门，于是垃圾输入会被投成一个
  //   `{stage:'', ok:false, …}` —— 那**长得像一个真的失败结论**，会让读者以为
  //   "确实查过了、确实没成"。返回 `null` 才是在说"这里没有结论"。
  if (report === null || report === undefined || typeof report !== 'object' || Array.isArray(report)) return null;
  const d = report.desktop ?? null;
  const refused = report.sidecar?.refused ?? null;
  const w = report.wait ?? null;
  return {
    // ★ `stage` / `code` / `ok` / `waitedMs`：主理人那两句问的直接答案。
    stage: typeof report.stage === 'string' ? report.stage : '',
    code: typeof report.code === 'string' ? report.code : '',
    ok: report.ok === true,
    waitedMs: typeof report.waitedMs === 'number' ? report.waitedMs : 0,
    desktop: d === null ? null : {
      running: d.running === true,
      launched: d.launched === true,
      ready: d.ready === true,
    },
    sidecar: {
      scanned: Number(report.sidecar?.scanned) || 0,
      picked: Number(report.sidecar?.picked) || 0,
      // ★ 只回**成因码**不回 `detail`：`detail` 是一整段散文（sidecar.js `summarizePool`），
      //   它要说的处置在 `hint` 里已经有一句短的。要细看的人去 diagnostics 端点。
      //
      // ★★ 这里原来只认 `{code}` 对象，而 `finish()` 写进去的是**码字符串**
      //   （`runOnce` 的每一处 `why: why?.code ?? null` 都已经把它压平过一次）。
      //   ⇒ 真机/真跑的每一次 `refused` 都被投影成字面量 `'unknown'`。
      //   实测（`node --input-type=module -e "…projectInstance({…, refused:'all_busy'})"`）：
      //   输入 `'all_busy'` ⇒ 输出 `refused:"unknown"`。
      //   `'unknown'` 就是"把可行动的原因压平"的字面形态：`no_desktop`（去开桌面端）、
      //   `all_busy` / `busy_running`（去关掉占用中的那条会话）、`probe_unreachable`
      //   （去查端点/网络）三种处置**完全不同**的成因，在用户与模型眼前长得一模一样。
      //   修法是**两种形状都认**，而不是新增一个键——新增键会让既有投影白名单断言（形状）
      //   失效，而这个字段的形状本来就是它的契约。
      refused: refused === null
        ? null
        : (typeof refused === 'string'
          ? refused
          : (typeof refused.code === 'string' ? refused.code : 'unknown')),
    },
    // ★ 等的账：四个标量，够回答"这一轮是 30s 就死，还是人一直没来"。
    //   `null` = 这一轮压根没走到等 sidecar 那一步（reused / 枚举失败 / 拉起失败）。
    //   有 wait 而没有这个字段 ⇒ 上层只能把 `waitedMs` 当成唯一的等待信息，
    //   而 `waitedMs` **不含**窗口语义（30s 与 10 分钟在它眼里是同一种数）。
    wait: w === null ? null : {
      firstWindowMs: Number(w.firstWindowMs) || 0,
      totalWaitMs: Number(w.totalWaitMs) || 0,
      continued: w.continued === true,
      polls: Number(w.polls) || 0,
    },
    hint: typeof report.hint === 'string' ? report.hint : '',
  };
}
