/**
 * workbuddy_run —— 把任务下发给 WorkBuddy 桌面端的后台作业（★ U4 心脏的"执行侧"）。
 *
 * Implements: 02-design/DESIGN-v3.md §3.4.3（全文骨架）/ §4.4.2（最外层短路 A4）/ §4.5（argv 回传 = C3 透明度
 *             与 lastRun 记账）/ §7.4（M2：并发上限 1——本工具侧显式门禁）
 *
 * ★ 传输面现在**只有一条**：`automation` —— 往用户计划任务表写一行 `once` 任务，
 *   等桌面端调度器建会话（`startAutomationRun` 唯一写入点）。
 *   - 历史：`spawn`（自拉 CLI）2026-10-01 删除：无登录态、必然 auth_failed，也不是合法数据源。
 *   - `gateway`（本机 ACP 网关）已下线：本文件仅在注释里保留该字符串，不再走 `dispatch.run`，
 *     不再建网关会话、不再调网关任何接口。
 *   - 计划任务行：`schedule_type='once'`、`next_run_at=now`、`valid_until=+25min`，
 *     附 `model_id` / `permission_mode` / `cwd`；建会话成功立刻 `retireRow` 软删，
 *     任何终态都退役，启动期扫遗留活行全软删（止损就靠删行）。
 *
 * ★ M2 追加一条 **opt-in** 的追发面（RFC-SESSION-RESUME-INTEGRATION）：`resume:true` +
 *   `enableMultiTurnFollowUp`（默认 false）+ 记性命中时，先尝试把 prompt 追发进**既有**
 *   对话（Track A，`followup/dispatcher.js`）；失败优雅回退到上面那条 automation 主路。
 *   开关关闭（默认）时本文件行为与未接线版本逐字节一致。
 *
 * 形态要点（全部 `实测`，见 §3.4.3 表 + 真机 `dsh-jobs-local/lib/index.js:127-142`）：
 *   - `defineTool` 的 `output.render` 必需（顶层 render ⇒ 定义期 TypeError）；
 *   - `ctx.jobs.start(spec)` **同步**返回 JobId，且**同步调用 `spec.run()`**；start 前会校验
 *     `kind`/`label` 非空、`outputLimitBytes` 为正整数、owner 有 job controller 服务、并发上限；
 *   - run 入参【没有】signal / report —— 信号取 `exec.signal`；
 *   - `exec.agent` 可选 ⇒ owner 用条件展开。
 *
 * 并发（§7.4 M2）：真机 `ctx.jobs` 的默认上限是 **10 / owner**，不是 1 ⇒「一平台并发 1」必须由
 *   **本工具**维护：在途 ≥ 1 时下发放拒绝。
 *
 * 约束：本文件属于 packages/*​/src（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

import { EFFORT_LEVELS, PLUGIN_ID, TOOL_RUN } from '../../shared/constants.js';
import { OUTPUT_LIMIT_BYTES, REGISTRY_STATES } from '../config/constants.js';
import { createFollowUpDispatcher, packageContentBlocks } from '../followup/dispatcher.js';
import { REASON_CODES } from '../launch/reason-codes.js';
import { automationHeader, startAutomationRun } from '../gateway/automation.js';
import { cheapestModelId, desktopModels } from '../launch/desktop-models.js';

/**
 * 这一轮用哪个模型。
 *
 * <p>优先级（**从高到低，用户的选择永远压过一切**）：
 * <ol>
 *   <li>调用方逐次传的 `model`</li>
 *   <li>插件设置里钉的 `model`</li>
 *   <li>**都没选 ⇒ 由 dsh 按成本兜底挑一个**：目录与倍率是暴露的
 *       （`workbuddy_status` 的 `models` + `cost.models`），挑最省的那个。</li>
 * </ol>
 *
 * <p>★ 为什么第 ③ 档不是"不下发" ★
 * 旧行为是"都不选 ⇒ 不下发 ⇒ 桌面端用它自己的默认"。那个默认是**桌面端自己挑的**，
 * 用户既不知道是哪个、也不知道花了多少 —— 这正是 2026-10-02 那次事故的形态：
 * 没人选，却按某个（往往不便宜）的模型真扣了积分。
 * 主理人定的方向是「**没人选就是 dsh 自己选**」，而选型所需的倍率数据本来就有。
 *
 * <p>★ 选中的模型会记进 `lastRun.model` ★
 * 回执里能读到实际用了哪个，所以"替用户选了"这件事**不是静默的** ——
 * 这条是铁律三（不静默降级）在本处的落点：可以替他选，但必须看得见。
 *
 * @param {object} args
 * @param {object} c 当前配置
 * @returns {string|null} 目录读不到就返回 `null`（照旧不下发，不编造一个模型名）
 */
function resolveModelId(args, c) {
  const perCall = typeof args.model === 'string' && args.model !== '' ? args.model : '';
  if (perCall !== '') return perCall;
  const pinned = typeof c.model === 'string' && c.model !== '' ? c.model : '';
  if (pinned !== '') return pinned;
  return null;   // 目录是异步读的，真正的兜底在 awaitModelId()
}

/**
 * `resolveModelId` 的**异步**版 —— 兜底要读目录，而目录读回来是异步的。
 *
 * <p>★ 为什么必须 await（真机实测两次都没生效才定位到）★
 * 目录读取器是「同步投影 + 后台刷新」：缓存热时 `projection()` 立刻给数，缓存冷时如实说
 * "还没有"。而**下发通常发生在刚启动、还没人打开过设置卡的时候** —— 那时缓存正是冷的。
 * 于是纯同步读必然拿到空目录 ⇒ 兜底永远不生效，真机两次都印 `model=(sidecar default)`。
 * 共享单例只解决了"卡片与工具面读两份"，没解决"工具面自己还没读过"。
 * 这里 `await ensure()`（自带 5s 上限，桌面端没开也不会挂住）拿第一份读数。
 *
 * @returns {Promise<string|null>} 读不到就 `null`（不编造模型名）
 */
async function awaitModelId(args, c) {
  const chosen = resolveModelId(args, c);
  if (chosen !== null) return chosen;
  try {
    return cheapestModelId(await desktopModels.ensure());
  } catch {
    return null;   // 读不到 ⇒ 不编造模型名，照旧交给桌面端默认
  }
}

/**
 * 本轮实际模型的倍率（给 `credits.recordRun` 记 `freeRuns` / `unknownRuns` 用）。
 *
 * <p>★ 为什么 automation 主路需要它，而此前一直传 `null` ★
 * `live-credits.js` 的记账口径是"只认两种可判定结论"（见 `credit-anchor.js` BASIS 的
 * 315 条样本证伪记录）：`multiplier === 0` ⇒ `freeRuns`（x0.00 平台赠送是写明的事实），
 * 其余一律 `unknownRuns`（本地无公式，消耗以平台结算为准）。而 `tools/run.js` 收口时
 * 硬编码 `multiplier: null` ⇒ **每一轮成功都记 `unknownRuns`**，免费模型（如 `hy3` x0.00）
 * 也被记成"未知" —— 这是漏归类，不是"正常初值"（counters 初值全 0，没有 1 的种子；
 * 失败走的是 `failedRuns`，也不是这里）。
 *
 * <p>★ 数据源是**实时目录**（与状态路由/工具面共用单例），不是回执 ★
 * 网关那一路（`gateway-run.js multiplierOfSelected`）从回执自带的 `models` 清单取倍率；
 * automation 回执（`automation.js`）没有这份清单，只有 `usedModelId`（`sessions.model`
 * 实记值）。倍率按 `modelId` 从 `catalog.cost.models[]` 对齐 —— 与客户端
 * `buildFactorIndex` 同一口径：命中有限数（含 0）即返回；未命中 / 非有限数 ⇒ `null`
 *（未知，绝不猜成 0 —— 0 会被读成"免费"）。
 *
 * @param {string|null} usedModelId 本轮实际模型（`au.usedModelId ?? au.model`）
 * @param {object|null|undefined} catalog `desktopModels.projection()` 形状（或测试注入的同形假目录）
 * @returns {number|null} 有限倍率，或 `null` = 未知
 */
export function multiplierOfUsedModel(usedModelId, catalog) {
  if (typeof usedModelId !== 'string' || usedModelId === '') return null;
  const rows = Array.isArray(catalog?.cost?.models) ? catalog.cost.models : null;
  if (rows === null) return null;
  const hit = rows.find((r) => r?.modelId === usedModelId) ?? null;
  if (hit === null) return null;
  const f = hit.factor;
  return typeof f === 'number' && Number.isFinite(f) ? f : null;
}

/**
 * 由工作区派生一个**稳定**的会话键（缺省 `session_key` 时用）。
 *
 * <p>★ 为什么不随机 ★
 * 随机 key ⇒ 每次下发都新建一条 WorkBuddy 对话 ⇒ 对话列表被撑爆，且彼此不认识。
 * 同一项目的活本来就在一条对话里，这是调用方给的**真事实**，比"模型自己起个名"可靠。
 *
 * <p>★ 为什么用摘要而不是直接拼路径 ★
 * key 会长度上限，且路径含盘符与分隔符；摘要后形如 `wb-<12 hex>`，稳定、可读、无特殊字符。
 *
 * @param {string} cwd
 * @returns {string}
 */
export function deriveSessionKey(cwd) {
  const src = typeof cwd === 'string' ? cwd.trim() : '';
  if (src === '') return 'wb-default';
  // FNV-1a（32 位）：无依赖、确定性、够作 key 用途（不是安全哈希，这里只求"同一路径同一结果"）。
  let h = 0x811c9dc5;
  for (let i = 0; i < src.length; i += 1) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 'wb-' + h.toString(16).padStart(8, '0');
}
// ★ 计划任务为主路：`startAutomationRun` 是每轮唯一写入点（INSERT automations once +
//   INSERT automation_runtime_state），参数 once / next_run_at=now / valid_until=+25min /
//   model_id / permission_mode / cwd。建会话成功立刻 retire，任何终态都退役。
//   可二次下发（禁CLI禁网关）：同 session_key 第二轮允许再次 INSERT 一行 once 建新可见对话，
//   成功后点火侧 adopt 覆盖记性为新 id（旧 id 视为 superseded 被替代），失败沿旧回收（forget，
//   下轮重建）；resume:false 同样新开。不再有“已记住就失败”分支，仅保留点火/收口失败 forget。
//   全程禁网关（网关已下线，本文件不再调网关任何接口，不调 continueSession，
//   `dispatch` 参数仅为兼容保留 void 掉）。

// ★ 可二次下发已替代“命中记性即失败”：本文件不再导出 reused-not-dispatched 口径。
//   旧 `REUSED_NOT_DISPATCHED_ORIGIN/DETAIL`（failed + already_remembered_no_dispatch +
//   逐字未送达）已删除 —— 同 session_key 第二轮走点火再 INSERT 一行 once 建新可见对话，
//   成功 adopt 覆盖新 id，失败 forget（下轮重建）。网关仍全禁（void dispatch）。

/**
 * `output.not_sent` —— 本次**有意图但没上线**的入参，逐条一句人话。
 *
 * <p>计划任务主路下 `effort` 有承载（`automations.reasoning_effort` 列），随行写库，
 * 由桌面端调度器建会话时带上 ⇒ 本路径下无未下发项，恒为空数组。
 * （网关已下线，那条"无 effort 口 ⇒ 进 not_sent"的逻辑不再适用。）
 *
 * @returns {string[]} 空数组 = 本次请求的东西全部下发成功
 */
function buildNotSent(args, cfg) {
  void args;
  void cfg;
  return [];
}

/**
 * `model` 参数的描述（★ 模型面真实化，2026-09-21；★ 2026-10-01 改指向桌面产品目录）。
 *
 * 为什么把清单**写进**参数描述而不是只说"去查 workbuddy_status"：设置里没配模型时，"谁来选"这件事
 *   原本文案上写着 DSH、实际发生在 WorkBuddy 后端。主理人的裁决是"没配置的时候把模型列表交给
 *   调用的模型自己选" ⇒ 选择发生在**填这个参数的瞬间**，选项就得在**那一处**可见。
 * ★ 清单不再硬编码 CLI 的 17 条快照（cli-models.js 已删）：候选 = 桌面产品配置目录，由
 *   `workbuddy_status` 实时回传（桌面缓存是唯一数据源）。
 * U9 未被触碰：这里给的是**候选**，插件仍然不替任何人挑一个（未传 ⇒ 不下发）。
 */
const MODEL_ARG_DESCRIPTION =
  'Model id for THIS run only; passed to WorkBuddy verbatim (unknown ids are not blocked — the desktop '
  + 'decides). When the plugin setting leaves the model unspecified, picking it is yours: choose the '
  + 'id that best fits the task and pass it here. The available ids come from the desktop product '
  + 'catalog (call workbuddy_status for the live list). Omit model to use the plugin setting; if that '
  + 'setting is also empty, dsh picks the cheapest catalog model for this run (read back lastRun.model '
  + 'to see which one) — only when the catalog cannot be read is nothing sent and the desktop falls '
  + 'back to its own default.';

/**
 * @param {object} runtime host SSOT（config/runtime.js）
 * @param {{ createKey?: () => string, capture?: (key: string, stdout: string, lossy?: boolean) => any,
 *           lookup?: (key: string) => any,
 *           resumable?: (key: string) => { cliSessionId: string, cwd: string|null }|null,
 *           adopt?: (key: string, rec: object) => any,
 *           forget?: (key: string) => any,
 *           supersede?: (key: string) => any }} sessions
 *   会话映射（`session/map.js`）。职责切分：调用方只传 `session_key` + `resume`，
 *   插件管记住/复用/回收 —— `adopt` 记住（成功保留）、`resumable`/`lookup` 查复用、
 *   `forget` 回收（终态失败/取消/超时作废，下轮重建）。`adopt` 缺席时点火按"没配写口"跳过
 *   （极简假宿主兼容）；`forget` 缺席时失败回收跳过（同兼容）。
 * @param {() => any} cfg ★ 配置【读取器】（§3.4.2 P1-2：不是快照 —— execute 内取最新值）
 * @param {object} ctx 宿主 ctx（取 ctx.jobs）
 * @param {object|null} [credits]
 * @param {object|null} [dispatch] 未使用（网关已禁用，保留参数仅为兼容旧调用方，不再走网关任何接口）
 * @param {{ automationRun?: Function, catalog?: { projection: Function }, followUp?: Function }} [seams] **只为可测而开**的覆盖：
 *   `automationRun` 默认走真 `startAutomationRun`（首轮唯一写入点）；
 *   `catalog` 默认读共享 `desktopModels` 单例
 *   （测试经 `catalog.projection()` 注入假目录，永不触真机 IPC）；
 *   `followUp` 默认 = **惰性构造**的 `createFollowUpDispatcher(...).followUp`（Track A 追发，
 *   M2；总闸 `enableMultiTurnFollowUp` 关闭时**绝不构造**——零网络、零套接字），
 *   测试注入 fake 以断言接线与回退顺序。
 */
export const makeRunTool = (runtime, sessions, cfg, ctx, credits = null, dispatch = null, seams = {}) => defineTool({
  name: TOOL_RUN,
  description:
    'Delegate a coding task to WorkBuddy. Runs as a background job: ' +
    'read progress with job_output, cancel with job_kill. ' +
    'Pass session_key to group related runs under one key (every round inserts one once row via automation '
    + 'and opens a new visible conversation; success adopts the new id over the remembered one, failure forgets), '
    + 'or omit it to derive a stable key from the working directory. resume:true requires a recorded session '
    + 'for session_key (it errors when nothing is recorded); resume:false always starts a NEW session '
    + '(one INSERT once via automation) even when a session is remembered. Omitting resume = auto: '
    + 'always starts new via automation, even on a remembered key. ' +
    'Model, reasoning effort, tool permission and conversation scope are per-call via model / effort / ' +
    'permission_mode / new_conversation; omitting them uses the ' +
    'plugin settings, and when those are empty too the desktop runs with its own default (delegation still works). ' +
    'So when the model setting is empty, nobody upstream has picked one: choosing it for this run is yours ' +
    '(the model parameter lists the candidates). ' +
    'Tool permission and conversation scope are per-call too, via permission_mode / new_conversation; ' +
    'omitting them uses the plugin settings, and an empty setting keeps the conversation\'s current state.',
  parameters: {
    prompt: { type: 'string', required: true, description: 'The task to delegate.' },
    session_key: { type: 'string', description: 'Conversation key for this delegation; every round starts a NEW session via automation (one INSERT once), even on a remembered key — success adopts the new id, failure forgets.' },
    resume: {
      type: 'boolean',
      description:
        'Session intent: omit = auto (always starts new via automation, even on a remembered key); ' +
        'true = require a recorded session for session_key (errors when none is recorded); ' +
        'false = start a NEW session even when session_key was used before (one INSERT once via automation).',
    },
    cwd: { type: 'string', description: 'Working directory; defaults to the plugin workspace.' },
    model: { type: 'string', description: MODEL_ARG_DESCRIPTION },
    permission_mode: {
      type: 'string',
      description:
        'REQUESTED tool permission for THIS run only (a per-tool-class server-side setting, not a UI toggle). ' +
        'Valid values are exactly: default (Always Ask), acceptEdits, plan, auto, dontAsk, ' +
        'bypassPermissions, fullAccess (Full Access), delegate. ' +
        'The list is the one the SERVER reports (call workbuddy_status for the live values and which one is ' +
        'current); this plugin does not invent values. Omit it to use the plugin setting, and when that is ' +
        'also empty the run keeps whatever the conversation already had. ' +
        'Think before picking: dontAsk is NOT full access (it denies Bash), and default waits on a dialog ' +
        'nobody can click during an unattended run. ' +
        'IMPORTANT - this is a REQUEST, not a guarantee, and whether it takes effect depends on WHICH ' +
        'conversation the run happens in. Measured against the desktop on 2026-09-28: session/set_mode ' +
        'genuinely APPLIES to conversations made by session/new - fullAccess read back as fullAccess on a ' +
        'SEPARATE connection, immediately, 3s later, and after a completed turn, and that still held when ' +
        'the connection doing the setting was NOT the one that created the conversation. But on the ' +
        'conversation the WorkBuddy desktop itself owns (the bound one) it was accepted, echoed, and the ' +
        'mode never changed. So to get a permission mode that really applies, run with ' +
        'new_conversation: true. Either way the result ' +
        'carries permission.requested / .effective / .confirmed - read .confirmed before telling the user ' +
        'which permission their task ran under. ' +
        'When you pick one, nobody upstream has: choosing it for this run is yours.',
    },
    new_conversation: {
      type: 'boolean',
      description:
        'Run in a NEW WorkBuddy conversation instead of the bound one. Omit to reuse the bound conversation ' +
        '(or the plugin setting). true = create a new one. ' +
        'Cost of true: the WorkBuddy desktop GUI switches its active conversation to the new one, so if the ' +
        'user is working in that window, their view changes. Reach for it only when this run genuinely must not ' +
        'touch the existing conversation.',
    },
    effort: {
      type: 'string',
      description:
        // ★ 与卡片下拉同源：合法取值 = shared/constants.js EFFORT_LEVELS（canonical 7 档，含 off）；
        //   平台支持子集由 config.launch.effortValues 决定（WorkBuddy 6 档 minimal/low/medium/high/xhigh/max，无 off）。
        //   本参数写入 automations.reasoning_effort，随行由桌面端调度器带上（真下发，不进 not_sent）。
        'Reasoning effort for THIS run only; written to the scheduled-task row (reasoning_effort) '
        + 'and carried by the desktop scheduler. Valid values are the canonical levels '
        + '(off/minimal/low/medium/high/xhigh/max; this desktop supports minimal/low/medium/high/xhigh/max). '
        + 'Omit it to use the plugin setting.',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        job_id: { type: 'string', required: true },
        session_key: { type: 'string', required: true },
        argv_preview: { type: 'string', required: true },
        // ★ 功能③：如实回传"本次是续接还是新开"（旧行为对调用方不可见）。
        resumed: { type: 'boolean', required: true },
        resumed_session_id: { type: 'string', required: true },
        // ★ 下发健康 A 组：本次**没能上线**的入参，逐条一句人话。两条桌面端通路当前不产生
        //   未下发项 ⇒ 恒为空数组。
        not_sent: {
          type: 'array',
          required: true,
          items: { type: 'string' },
          description: 'Requested inputs that were NOT sent, one human-readable line each ' +
            '(empty = everything requested was dispatched).',
        },
        // ★ M2 追发（三键都**条件性出现** —— 开关关闭时回执键集与既有逐字一致，hardening 的
        //   "返回值键集应与声明逐字一致"断言因此不受影响）：
        follow_up: {
          type: 'object',
          additionalProperties: false,
          properties: {
            channel: { type: 'string', required: true },
            elapsedMs: { type: 'number', required: true },
          },
          description: 'Present only when the prompt was appended to the EXISTING conversation ' +
            '(resume:true + enableMultiTurnFollowUp): follow-up transport (track_a) and elapsed time.',
        },
        fallback: {
          type: 'boolean',
          description: 'Present only when the follow-up attempt failed and the run fell back to a ' +
            'fresh automation session; resumed stays false in that case.',
        },
        fallbackReason: {
          type: 'string',
          description: 'Canonical error fingerprint (RFC §4.2, e.g. ERR_WORKBUDDY_CDP_UNAVAILABLE) ' +
            'that triggered the fallback; present only alongside fallback:true.',
        },
      },
    },
    render: (_args, value) => [{
      type: 'text',
      text: `started job ${value.job_id} (session ${value.session_key}, ` +
        (value.resumed === true ? `resumed ${value.resumed_session_id})` : 'new session)') +
        // ★ M2：追发走向一行说清（成功 = 经哪条通道耗时多少；失败 = 指纹码 + 已回退新会话）。
        (value.follow_up !== undefined && value.follow_up !== null
          ? ` · follow-up delivered via ${value.follow_up.channel} in ${value.follow_up.elapsedMs}ms`
          : '') +
        (value.fallback === true
          ? ` · follow-up failed (${String(value.fallbackReason ?? 'unknown reason')}); started a fresh session instead`
          : '') +
        `\nargv: ${value.argv_preview}` +
        (Array.isArray(value.not_sent) && value.not_sent.length > 0
          ? `\n${value.not_sent.join('\n')}`
          : ''),
    }],
  },
  async execute(args, exec) {
    // 最外层短路（§4.4.2 A4）：即便工具被误注册，也再判一次。
    // ★ 下发健康 C 组：**三条分支各说各的成因**（关掉 / 没探到桌面端 / 还没探出来）。
    const c = cfg();
    if (c?.enabled !== true) {
      throw new Error(
        'workbuddy is switched OFF in the plugin settings: nothing is launched (this is the U4 gate — '
        + 'ask the user to enable the plugin, do not retry)',
      );
    }
    let probe = runtime.detected();
    if (probe === null) probe = await runtime.awaitDetection(); // 等**已在途**的那次结论，不新起探测、不抢先否决
    if (probe?.installed !== true) {
      const why = probe === null
        ? 'no availability detection has completed yet'
        : `the WorkBuddy desktop was not found (reason: ${typeof probe.reason === 'string' && probe.reason !== '' ? probe.reason : 'unknown'})`;
      throw new Error(
        `workbuddy cannot run now: ${why}. Call workbuddy_status for the evidence list (which sources were checked).`,
      );
    }
    // 空 prompt 不是合法任务（真机 jobs.start 亦以 "invalid job label" 拒收空 label）。
    if (typeof args.prompt !== 'string' || args.prompt.trim() === '') {
      throw new Error('prompt must be a non-empty string');
    }
    // prompt 以 `-` 开头会被当成 flag（模型可控文本 ⇒ 提权向量）⇒ 拒收并给可解释错误。
    if (args.prompt.trimStart().startsWith('-')) {
      throw new Error("prompt must not start with '-' (it would be parsed as a flag)");
    }
    // §7.4 M2：一平台并发上限 = 1（真机 ctx.jobs 默认 10/owner，须本工具自守）。
    if (runtime.inFlightCount() > 0) {
      throw new Error('workbuddy is busy: another job is in flight (concurrency cap = 1)');
    }

    const hasKey = typeof args.session_key === 'string' && args.session_key !== '';
    // ★ 缺省 key 必须是**确定性的**，不能是随机的（2026-10-02 改）★★
    //   旧写法 `sessions.createKey()` 每次生成随机 key ⇒ 不传 session_key 的每一次下发
    //   都会新建一条 WorkBuddy 对话 ⇒ 用户自己的对话列表被插件撑爆，而且**互相不认识**：
    //   模型看不到上一轮说过什么，"一个任务 = 一条对话"这个产品语义直接作废。
    //
    //   现在的规则（也是我们要的语义）：
    //     · 调用方给了 `session_key` ⇒ 逐字用它（并行/分话题时由人决定）
    //     · 没给 ⇒ **按工作区派生一个稳定 key**：同一项目里的活自然落在同一条对话上，
    //       不再是"每个任务一条"
    //     · 确实要另开一条 ⇒ 显式 `new_conversation: true`（唯一的逃生口，不靠默认）
    //   为什么用 cwd 派生而不是模型自己起名：模型起名不可靠（今天实测它每个任务都新起一个），
    //   而 cwd 是调用方给的**真事实**，同一个项目的活本来就该在一条对话里。
    const sessionKey = hasKey
      ? args.session_key
      : deriveSessionKey(typeof args.cwd === 'string' && args.cwd !== '' ? args.cwd : (typeof c.cwdRoot === 'string' ? c.cwdRoot : ''));
    // 会话意图：省略 ⇒ 自动（每轮新开）；resume=true ⇒ **要求**有可查记性
    //   （无记录就报错，不静默开新）；resume=false ⇒ 强制新会话。`new_conversation:true`
    //   同视为强制新会话（与 resume:false 同义）。可二次下发：有无记住都走点火
    //   INSERT 一行 once（resumed:false，真下发），成功 adopt 覆盖新 id，失败 forget。
    const intent = args.resume === true ? true : args.resume === false ? false : null;
    if (intent === true && !hasKey) {
      throw new Error('workbuddy: resume:true requires session_key (a brand-new key has nothing to continue)');
    }
    const recorded = hasKey && typeof sessions?.resumable === 'function'
      ? sessions.resumable(sessionKey)
      : null;
    if (intent === true && recorded === null) {
      throw new Error(
        `workbuddy: resume:true but no resumable session is recorded for session_key "${sessionKey}" `
        + '(use workbuddy_status to list resumable sessions, or omit resume to start a new one)',
      );
    }

    // ═══ M2 多轮追发（Track A；RFC-SESSION-RESUME-INTEGRATION §3.2/§4.2 状态机 S2）══════
    // 触发条件（三条同时成立；任一不成立 ⇒ 本块整体跳过，行为与未接线版本逐字节一致）：
    //   ① args.resume === true（调用方显式续接意图；省略/false 一律不追发）
    //   ② c.enableMultiTurnFollowUp === true（设置总闸，默认 false —— 关闭时**绝不构造** dispatcher）
    //   ③ recorded !== null（记性命中可续接会话；上一段已保证 resume:true 必有记录）
    // 成功 ⇒ `sessions.touch(sessionKey)`（同一条对话续用，只推进热度戳），回执 resumed:true
    //       并带追发元数据；失败 ⇒ `sessions.forget(sessionKey, <指纹码>)` 作废记性，然后走
    //       **完全不变**的既有点火路径，回执追加 { fallback:true, fallbackReason:<码> }。
    // 两条纪律：绝不抛（异常也收敛为回退）；绝不静默（走向写在回执与 lastRun 里）。
    let followUpMeta = null;    // 成功：{ channel, elapsedMs, conversationId, output }
    let fallbackReason = null;  // 失败：RFC §4.2 指纹码（回执 fallbackReason）
    if (intent === true && recorded !== null && c.enableMultiTurnFollowUp === true) {
      const followUpFn = typeof seams.followUp === 'function'
        ? seams.followUp
        : createFollowUpDispatcher({
          cdpPort: c.followupCdpPort,
          timeoutMs: c.followupTimeoutMs,
          log: (message) => ctx.logger?.warn?.(`[${PLUGIN_ID}] ${message}`),
        }).followUp;
      const startedAt = Date.now();
      let outcome = null;
      try {
        // ★ prompt 必须 ContentBlock 数组打包（桌面端拒收裸字符串）；裸字符串在 dispatcher
        //   侧同样被拒 —— 双保险，契约见 followup/dispatcher.js。
        outcome = await followUpFn({
          conversationId: recorded.cliSessionId,
          prompt: packageContentBlocks(args.prompt),
          timeoutMs: c.followupTimeoutMs,
        });
      } catch (err) {
        // dispatcher 的契约是**永不抛**（错误一律收敛 ok:false）；这里兜的是注入件/未来回归，
        // 归因不明 ⇒ RFC 之外的 catch-all 指纹，绝不让异常炸掉本轮。
        outcome = { ok: false, code: 'ERR_FOLLOWUP_FAILED', detail: err instanceof Error ? err.message : String(err) };
      }
      if (outcome !== null && typeof outcome === 'object' && outcome.ok === true) {
        followUpMeta = {
          channel: typeof outcome.channel === 'string' && outcome.channel !== '' ? outcome.channel : 'track_a',
          elapsedMs: Date.now() - startedAt,
          conversationId: recorded.cliSessionId,
          output: typeof outcome.receipt?.output === 'string' ? outcome.receipt.output : '',
        };
        // ★ 成功：不 forget 不 adopt（会话 id 没变），只把热度戳推进 —— `sweepOwnSessions`
        //   按 lastUsedAt 判陈旧，不 touch 的追发会话会在 7 天后被误判成无人认领的遗留。
        try {
          if (typeof sessions?.touch === 'function') sessions.touch(sessionKey);
        } catch { /* 热度戳失败不改判追发成败（下轮点火 adopt 会再记账） */ }
      } else {
        fallbackReason = typeof outcome?.code === 'string' && outcome.code !== ''
          ? outcome.code
          : 'ERR_FOLLOWUP_FAILED';
        // ★ 失败：指纹码作废记性（RFC §4.2 —— 死 id 不得留在记性里），随后照旧点火新会话。
        try {
          if (typeof sessions?.forget === 'function') sessions.forget(sessionKey, fallbackReason);
          else if (typeof sessions?.supersede === 'function') sessions.supersede(sessionKey);
        } catch { /* 回收失败 = 下轮多建一次，不拦兜底 */ }
      }
    }

    // ═══ 可二次下发：每轮都走点火 INSERT 一行 once，不再有“已记住就失败”分支 ═══
    //   `sessionStore` 按 `session_key` 记 own 映射（`adopt` 记住、`lookup`/`resumable` 查、
    //   `forget` 回收，均在 `session/map.js`）。职责：调用方只传 `session_key` + `resume`，
    //   插件管记住/回收；下发只有一路：
    //   - 每轮（有无记住、resume 省略/true/false、`new_conversation` 真假一律）
    //     ⇒ 走点火 INSERT 一行 once（`resumed:false`，真下发），建新可见对话。
    //     成功后点火侧 `adopt(sessionKey, {cliSessionId:新id})` 覆盖记性（旧 id 视为
    //     superseded 被替代）；终态失败/取消/超时 `forget(sessionKey)`（下轮重建）。
    //   - 仅保留 load/点火失败 forget（收口 `forgetOnFail` + 点火侧 `doForget` 双保险，
    //     均幂等）。记性命中不再是失败条件。
    //   - 网关全禁：本文件 `void dispatch`，不调 `continueSession`/`dispatch.run`。
    // `new_conversation` 同视为新开（与 resume:false 同义；可二次下发下每轮都新开，故仅保留读取以显式同义）。
    void (args.new_conversation === true);
    // 设置里显式绑定的对话在计划任务主路下无意义（调度器只按行新建），仅保留读取以显式忽略。
    void (typeof c.boundSessionId === 'string' ? c.boundSessionId.trim() : '');
    // ★ 网关已禁用：本文件不再调网关任何接口（`dispatch` 仅为兼容保留）。
    void dispatch;

    // ═══ 传输面（每轮新开）：走**计划任务**（每轮唯一写入点 `startAutomationRun`）══════
    //   ★ 全程禁网关：本分支绝不触 `dispatch`。
    //   点火参数：`schedule_type='once'`、`next_run_at=now`、`valid_until=+25min`
    //   （`timeoutMs(15min)+grace(10min)`，见 `automation.js`），附 `model_id` /
    //   `permission_mode` / `cwd`。建会话成功立刻 `retireRow` 软删，任何终态都退役，
    //   启动期扫遗留活行全软删 —— 止损就靠删行（软删 `deleted_at`）。
    const transport = 'automation';
    void transport;

    const autoCwd = typeof args.cwd === 'string' && args.cwd !== '' ? args.cwd : c.cwdRoot;
    const requestedPerm = (typeof args.permission_mode === 'string' && args.permission_mode !== ''
      ? args.permission_mode
      : (typeof c.sessionMode === 'string' && c.sessionMode !== ''
        ? c.sessionMode
        : (typeof c.permissionMode === 'string' && c.permissionMode !== '' ? c.permissionMode : null)));
    // ★ 推理强度真下发：工具参数 effort → automations.reasoning_effort（经 startAutomationRun 写库，由调度器带上）。
    //   合法取值以 shared/constants.js EFFORT_LEVELS 为准（与卡片下拉同一来源）；未知值不拦截，由桌面端决定，
    //   不静默升/降档，也不进 not_sent（buildNotSent 恒为空数组）。
    const normalizeEffort = (v) => {
      void EFFORT_LEVELS;
      const s = typeof v === 'string' ? v.trim() : '';
      return s === '' ? null : s;
    };
    const requestedEffort = normalizeEffort(typeof args.effort === 'string' && args.effort !== '' ? args.effort : '')
      ?? normalizeEffort(typeof c.effort === 'string' ? c.effort : '');
    // ★ 即建即撤 + adopt/forget 记账：把归组键与会话写口递给唯一写入点。
    //   `startAutomationRun` 在 `sessions.id` 一确认就 `retireRow` + `sessionStore.adopt(sessionKey)`
    //   覆盖记性为新 id（旧 id 视为 superseded 被替代）；终态失败/取消/超时
    //   `sessionStore.forget(sessionKey)`（下轮重建），成功保留。`sessions.adopt` 缺席
    //   （极简假宿主）时传 null，由点火侧按"没配写口"跳过；
    //   `forget` 缺席时同理（失败回收跳过，不炸整轮）。
    const hasAdopt = sessions !== null && typeof sessions === 'object'
      && typeof sessions.adopt === 'function';
    const hasForget = sessions !== null && typeof sessions === 'object'
      && (typeof sessions.forget === 'function' || typeof sessions.supersede === 'function');
    const automationSessionStore = (hasAdopt || hasForget)
      ? {
        ...(hasAdopt ? { adopt: (k, rec) => sessions.adopt(k, rec) } : {}),
        ...(hasForget
          ? { forget: (k) => (typeof sessions.forget === 'function' ? sessions.forget(k) : sessions.supersede(k)) }
          : {}),
      }
      : null;
    // ★ M2 三分支：追发成功 ⇒ 作业包**已完成**的追发结果（不点火、零 INSERT，见下方 automation
    //   造型的"无行可退"如实记账）；追发失败/未尝试 ⇒ 完全不变的既有点火路径。
    const a = followUpMeta !== null
      ? {
        cancel: () => { /* Track A 无行无进程可撤：prompt 已进入那条对话，不存在"撤回点火行"这回事 */ },
        done: Promise.resolve({
          status: 'completed',
          detail: followUpMeta.output,
          exitCode: 0,
          automation: {
            reason: null,
            // ★ Track A 不写 automations 表 ⇒ 四方闭合的"行"两角如实为无（automationId=null、
            //   retired=false）—— 回执照常可查，只是查到的是"没建过行"这个事实。
            automationId: null,
            conversationId: followUpMeta.conversationId,
            sessionId: followUpMeta.conversationId,
            sessionKey: sessionKey === '' ? null : sessionKey,
            sessionPersist: null,
            retired: false,
            transcriptPath: null,
            reply: followUpMeta.output !== '' ? followUpMeta.output : null,
            creditsUsed: null, model: null, permission: null,
            usedModelId: null, sessionCwd: null,
            // 追发沿用对话现配 ⇒ requested/effective 均未知（pending live calibration：回执未带模型面）。
            requestedEffort: null, effectiveEffort: null, effort: null,
            title: null, createdAt: null, tokensUsed: null,
            phases: ['followup-dispatch'],
          },
        }),
        readOutput: () => followUpMeta.output,
      }
      : (seams.automationRun ?? startAutomationRun)({
        prompt: args.prompt,
        cwd: autoCwd,
        modelId: await awaitModelId(args, c),
        permissionMode: requestedPerm,
        reasoningEffort: requestedEffort,
        sessionKey,
        ...(automationSessionStore !== null ? { sessionStore: automationSessionStore } : {}),
        signal: exec.signal,
      });
    const aJobId = ctx.jobs.start({
      kind: 'workbuddy',
      label: args.prompt.slice(0, 60),
      ...(exec.agent ? { owner: exec.agent.id } : {}),
      outputLimitBytes: OUTPUT_LIMIT_BYTES,
      run: () => {
        const forgetOnFail = () => {
          // ★ 终态失败/取消/超时 forget（下轮重建）；成功保留。点火侧失败已 forget（automation.js），
          //   这里是双保险（假点火/点火抛异常/收口异常分支点火侧够不到）。幂等，多调无害。
          try {
            if (typeof sessions?.forget === 'function') sessions.forget(sessionKey);
            else if (typeof sessions?.supersede === 'function') sessions.supersede(sessionKey);
          } catch { /* 回收失败 = 下轮多建一次，不是本轮的错误 */ }
        };
        const settleAutomation = (out) => {
          const au = out.automation ?? {};
          const status = out.status === 'completed' ? 'completed' : 'failed';
          if (status !== 'completed') forgetOnFail();
          // ★ 倍率按实记模型查实时目录（见 `multiplierOfUsedModel`）：免费 x0.00 记 freeRuns，
          //   查不到 ⇒ null ⇒ unknownRuns（未知，不猜）。此前这里硬编码 null，免费轮也被记成未知。
          const usedId = au.usedModelId ?? au.model ?? null;
          let mult = null;
          try {
            const src = (seams !== null && typeof seams === 'object' && seams.catalog !== null
              && typeof seams.catalog?.projection === 'function')
              ? seams.catalog
              : desktopModels;
            mult = multiplierOfUsedModel(usedId, src.projection());
          } catch {
            mult = null;   // 目录读不到 ⇒ 未知，不改判成败
          }
          credits?.recordRun?.({ ok: status === 'completed', multiplier: mult });
          if (status === 'completed' && runtime.registry() === REGISTRY_STATES.DEGRADED) {
            runtime.setRegistry(REGISTRY_STATES.REGISTERED);
          }
          const reqPerm = typeof requestedPerm === 'string' ? requestedPerm : '';
          const effPerm = typeof au.permission === 'string' ? au.permission : '';
          // ★ effort 回显（与 permission 同口径）：requested = 本次入参（含设置回落），effective = 会话上
          //   实际记着的 thought_level（automation.js sessionFacts 真源），缺失 ⇒ '(unknown)'，不编造。
          const reqEff = typeof requestedEffort === 'string' ? requestedEffort : '';
          const effEffRaw = typeof au.effectiveEffort === 'string' ? au.effectiveEffort
            : (typeof au.effort === 'string' ? au.effort : '');
          runtime.noteRun({
            // ★ M2：追发轮的 transport 如实记 'followup'（不是 automation —— 它没建行）。
            transport: followUpMeta !== null ? 'followup' : 'automation',
            at: Date.now(),
            exitCode: typeof out.exitCode === 'number' ? out.exitCode : null,
            reasonCode: status === 'completed' ? REASON_CODES.OK : (au.reason ?? REASON_CODES.TASK_ERROR),
            receipt: null,
            model: au.usedModelId ?? au.model ?? null,
            permission: {
              requested: reqPerm,
              effective: effPerm === '' ? '(unknown)' : effPerm,
              confirmed: reqPerm !== '' && reqPerm === effPerm,
            },
            effort: {
              requested: reqEff,
              effective: effEffRaw === '' ? '(unknown)' : effEffRaw,
              confirmed: reqEff !== '' && reqEff === effEffRaw,
            },
            // ★ lastRun 四方闭合：automation_id / session_id / retired 必须可查。
            //   `automationId` = 点火行 id（删行审计用）；`sessionId` = sessions.id（对话存在的硬证据）；
            //   `retired` = 该行是否已软删（止损闸的直接读数）。三者缺一，验收的四方闭合就少一角。
            // ★ 任务可视：title = 对话标题（点火名/会话标题），createdAt/created_at = 会话或点火创建时间，
            //   卡片与 workbuddy_status 据此显示"哪条对话、什么时候建的、回执在哪"。
            automationId: typeof au.automationId === 'string' ? au.automationId : null,
            // ★ M2：追发成功 ⇒ origin 'resumed'（同一条对话续用，不是新建）；点火轮仍按既有口径。
            sessionOrigin: followUpMeta !== null
              ? 'resumed'
              : ((au.sessionId ?? au.conversationId) ? 'new' : null),
            sessionId: (au.sessionId ?? au.conversationId) ?? null,
            title: typeof au.title === 'string' ? au.title : null,
            createdAt: typeof au.createdAt === 'number' ? au.createdAt
              : (typeof au.created_at === 'number' ? au.created_at : null),
            created_at: typeof au.created_at === 'number' ? au.created_at
              : (typeof au.createdAt === 'number' ? au.createdAt : null),
            sessionRenewed: '',
            sessionPersist: au.sessionPersist ?? null,
            retired: au.retired === true,
            sessionKey,
            // ★ M2：resumed 不再写死 false —— 追发成功为 true；点火轮（含追发失败回退）仍为 false。
            resumed: followUpMeta !== null,
            // ★ M2：追发元数据进 lastRun（channel/elapsedMs），与回执的 follow_up 同源同值。
            followUp: followUpMeta === null
              ? null
              : { channel: followUpMeta.channel, elapsedMs: followUpMeta.elapsedMs },
            recycle: null,
            instance: null,
            sidecar: null,
            toolCalls: { count: 0, names: [] },
            phases: Array.isArray(au.phases) ? au.phases : [],
            stdoutText: out.detail ?? (typeof au.reply === 'string' ? au.reply : ''),
            argv: [],
            flags: {}, notSent: [],
            usage: null,
            flagVerdict: null,
          });
          runtime.finish(aJobId, status === 'completed' ? 0 : -1);
          runtime.forget(aJobId);
          return { status, detail: out.detail ?? (typeof au.reply === 'string' ? au.reply : '') };
        };
        return {
          cancel: a.cancel,
          done: a.done.then(settleAutomation, (err) => settleAutomation({
            status: 'failed',
            detail: err instanceof Error ? err.message : String(err),
            exitCode: 1,
            automation: { reason: REASON_CODES.TASK_ERROR, automationId: null, conversationId: null, phases: [] },
          })),
          readOutput: a.readOutput,
        };
      },
    });
    runtime.start(aJobId, { terminate: a.cancel });
    // ★ M2 追发回执：走向**两分支**，字段名/取值与既有契约逐字对齐 ——
    //   · 追发成功：resumed:true + 续用的对话 id + follow_up 元数据（channel/elapsedMs）；
    //   · 点火/回退轮：既有逐字形状（resumed:false、resumed_session_id 空串），仅追发失败时
    //     追加 fallback 两键（指纹码可见，不静默）。开关关闭时不含任何新键（hardening 键集契约）。
    if (followUpMeta !== null) {
      return {
        job_id: aJobId,
        session_key: sessionKey,
        argv_preview: automationHeader({ model: typeof args.model === 'string' ? args.model : c.model, cwd: autoCwd }),
        resumed: true,
        resumed_session_id: followUpMeta.conversationId,
        not_sent: buildNotSent(args, c),
        follow_up: { channel: followUpMeta.channel, elapsedMs: followUpMeta.elapsedMs },
      };
    }
    return {
      job_id: aJobId,
      session_key: sessionKey,
      argv_preview: automationHeader({ model: typeof args.model === 'string' ? args.model : c.model, cwd: autoCwd }),
      // ★ 点火轮（含追发失败回退轮）恒为新对话（INSERT 一行 once）：`resumed:false` 逐字保留。
      resumed: false,
      resumed_session_id: '',
      not_sent: buildNotSent(args, c),
      ...(fallbackReason !== null ? { fallback: true, fallbackReason } : {}),
    };
  },
  presentCall: (a) => ({ card: 'generic', title: `Delegate to WorkBuddy: ${a.prompt.slice(0, 60)}`, kind: 'execute' }),
});
