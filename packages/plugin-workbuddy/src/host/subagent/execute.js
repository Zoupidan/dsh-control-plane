/**
 * 子智能体面的执行口 —— 计划任务主路（与 `host/tools/run.js` 同一条路的第二个调用点）。
 *
 * <p>传输面只有 `automation`：往计划任务表写一行 `once` 任务，等桌面端调度器建会话。
 * `gateway` 已下线：本文件仅在注释里保留该字符串，不再走 `dispatch.run`，
 * 不再建网关会话、不再调网关任何接口。
 *
 * <p>★★ 这不是"第二条下发链" ★★
 *
 * <p>`subagent/provider.js` 头注的红线是"执行出口只能有一个"。这里满足它：
 * 调的是 `startAutomationRun()` —— **与 `tools/run.js` 完全同一个函数**，
 * 同一张表、同一套点火与轮询、同一份回执形状。变的只是调用姿势：
 * 工具面把它包进 `ctx.jobs`（作业可观测、可取消、输出滚走），
 * 子智能体面直接 await（provider 需要的是一个返回值，不是一条作业）。
 *
 * <p>每轮都是新对话（该表无对话列）：同任务多轮靠 `transcript` 重放前情，
 * 并在回执里如实标 `continuity='fresh-conversation-per-round'`。
 *
 * <p>约束：本文件属于 packages 下的 src（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 *
 * @module host/subagent/execute
 */

import { REASON_CODES } from '../launch/reason-codes.js';
import { startAutomationRun } from '../gateway/automation.js';

/**
 * 传输面归一：只有 `automation`。保留该函数只为兼容配置里的显式传值；
 * 未知/缺省一律落 `automation`。
 *
 * @param {unknown} configured 配置里的 `transport` 原值。
 * @returns {'automation'}
 */
export function resolveTransport(configured) {
  void configured;
  return 'automation';
}

/**
 * 把 `auto` 这个**语义**折成"让桌面端自己挑"（点火 `modelId` 用）。
 *
 * ★ 为什么不能把 `'auto'` 原样写库 ★
 * `auto` 是**调用侧的语义**（含义"由 WorkBuddy 自己选"），而 `automations.model_id`
 * 要的是真实模型 id：写进去就会把这一轮记成一个叫 `auto` 的模型 ——
 * 一个并不存在的模型 id。所以这里传 `null`（= 不指定，由桌面端用它自己的默认）。
 *
 * @param {unknown} model
 * @returns {string|null} 可直接传给点火的 `modelId`，或 `null`。
 */
export function automationModelId(model) {
  const raw = typeof model === 'string' ? model.trim() : '';
  return raw === '' || raw === 'auto' ? null : raw;
}

/**
 * 把一次自动化点火的结果折成统一回执形状。
 *
 * ★ 为什么这里**不编** `receipt` ★
 * 自动化这一趟没有 ACP 消息链，写一个 `end_turn` 进去是凭空造证据。
 * 所以 `receipt` 如实为 `null`。
 *
 * ★ 阶段轨迹为什么比不过时 ★
 * `automation.js` 自己维护 `phases`（`db-open → awaiting-scheduler-tick → running → …`），
 * 正是"任务卡在哪一步"的唯一数据来源。
 *
 * @param {object} out `startAutomationRun().done` 的返回值。
 * @returns {object} 统一形状的回执。
 */
export function reportFromAutomation(out) {
  const au = out?.automation ?? {};
  const ok = out?.status === 'completed';
  const requested = typeof au.requestedPermissionMode === 'string' ? au.requestedPermissionMode : '';
  const effective = typeof au.permission === 'string' ? au.permission : '';
  const requestedModel = typeof au.requestedModelId === 'string' ? au.requestedModelId : '';
  // ★ effort 真源与 permission 同口径：requested = 点火写入 reasoning_effort 的值，
  //   effective = 会话上实际记着的 thought_level（automation.js sessionFacts）。
  const requestedEffort = typeof au.requestedEffort === 'string' ? au.requestedEffort : '';
  const effectiveEffort = typeof au.effectiveEffort === 'string' ? au.effectiveEffort
    : (typeof au.effort === 'string' ? au.effort : '');
  return {
    ok,
    transport: 'automation',
    text: typeof au.reply === 'string' ? au.reply : '',
    reason: ok ? REASON_CODES.OK : (au.reason ?? REASON_CODES.TASK_ERROR),
    error: ok ? undefined : {
      code: au.reason ?? REASON_CODES.TASK_ERROR,
      message: typeof out?.detail === 'string' ? out.detail : 'the automation run did not complete',
    },
    phases: Array.isArray(au.phases) ? au.phases : [],
    // ★ 如实为 null：见上面"为什么不编 receipt"。
    receipt: null,
    // ★ 桌面端建的会话 id —— "对话真的存在"的硬证据，也是回桌面端查的句柄。
    sessionId: au.conversationId ?? null,
    // ★ 永远是 `new`：`automations` 表没有会话 id 列，调度器只按行新建。
    //   连着问第二轮 = 又一条新对话（见 `continuity`）。
    sessionOrigin: au.conversationId ? 'new' : null,
    // ★ ★ 诚实声明：本传输面**没有**会话续接。
    continuity: 'fresh-conversation-per-round',
    // ★ 权限是否兑现：`requested` 与会话上**实际记着的** `permission_mode` 逐字比。
    permission: {
      requested,
      effective: effective === '' ? '(unknown)' : effective,
      confirmed: requested !== '' && requested === effective,
    },
    // ★ 强度是否兑现：与 permission 同口径（requested/effective/confirmed），缺失 ⇒ '(unknown)'，不编造。
    effort: {
      requested: requestedEffort,
      effective: effectiveEffort === '' ? '(unknown)' : effectiveEffort,
      confirmed: requestedEffort !== '' && requestedEffort === effectiveEffort,
    },
    requestedEffort,
    effectiveEffort: effectiveEffort === '' ? null : effectiveEffort,
    usedModelId: au.usedModelId ?? au.model ?? null,
    // ★★★ "**没人选模型**"这件事必须可见，不能变成一句"桌面端默认" ★★★
    requestedModelId: requestedModel ?? null,
    usage: au.tokensUsed === null || au.tokensUsed === undefined
      ? null
      : { used: au.tokensUsed, credits: au.creditsUsed ?? null },
    automationId: au.automationId ?? null,
    // ★ 任务可视：标题与创建时间随回执带出（卡片与 status 据此显示"哪条对话、什么时候建的"）。
    title: typeof au.title === 'string' ? au.title : null,
    createdAt: typeof au.createdAt === 'number' ? au.createdAt
      : (typeof au.created_at === 'number' ? au.created_at : null),
    transcriptPath: au.transcriptPath ?? null,
    cwd: au.sessionCwd ?? null,
  };
}

/**
 * 组装子智能体面的执行口（计划任务主路）。
 *
 * @param {object} deps
 * @param {(o: object) => {cancel: () => void, done: Promise<object>, readOutput: () => string}|null} [deps.automation]
 *   点火函数（默认真 `startAutomationRun`；测试可注入假点火以不碰真库）。
 * @param {(key: string) => unknown} [deps.setting] 读插件配置。
 * @param {(phase: string) => void} [deps.onPhase] 阶段回调（可选）。
 * @param {{lookup?: (k: string) => {cliSessionId: string}|null, adopt?: (k: string, r: object) => object}|null} [deps.sessions]
 *   会话记性：拿到 `sessions.id` 后立刻 `adopt(sessionKey)`，后续走复用不再建行；
 *   当前主路每轮仍是新对话（该表无对话列），记性只做"后续复用"的账，不做本轮续接。
 * @returns {(req: object) => Promise<object>} 返回统一形状回执的函数。
 */
export function createTaskExecutor({ automation = null, setting = () => undefined, onPhase = null, sessions = null } = {}) {
  void setting;
  /** @type {Map<string, Array<{role: 'user'|'assistant', text: string}>>} */
  const transcript = new Map();
  const MAX_TURNS = 8;
  const MAX_TURN_CHARS = 4000;

  const key = (req) => (typeof req.sessionKey === 'string' && req.sessionKey !== '' ? req.sessionKey : '');
  const pushTurn = (k, role, text) => {
    if (k === '' || typeof text !== 'string' || text.trim() === '') return;
    const list = transcript.get(k) ?? [];
    list.push({ role, text: text.trim().slice(0, MAX_TURN_CHARS) });
    while (list.length > MAX_TURNS) list.shift();
    transcript.set(k, list);
  };
  /** 把此前几轮压成一段可读的前情，让新对话不至于从零开始。 */
  const replayPrefix = (k) => {
    const list = transcript.get(k) ?? [];
    if (list.length === 0) return '';
    const body = list
      .map((t) => `${t.role === 'user' ? '【你】' : '【WorkBuddy】'}${t.text}`)
      .join('\n\n');
    return `[本次任务此前的对话（每轮都是新对话，这里原样带过来）]\n${body}\n\n[以上是此前的对话。现在继续。]\n\n`;
  };

  /**
   * @param {object} req
   * @param {string} req.prompt
   * @param {string} [req.cwd]
   * @param {string} [req.permissionMode]
   * @param {string} [req.model] 请求的模型（`auto` 会折成"桌面端自选"）。
   * @param {string} [req.effort] 请求的推理强度（写入 `automations.reasoning_effort`，与 workbuddy_run 同源）。
   * @param {string} [req.sessionKey] 同一个 dsh 子会话的归组键（仅用于重放前情，不续接对话）。
   * @param {string} [req.name] 会话标题（写进 `automations.name`）。
   * @param {AbortSignal} [req.signal]
   * @returns {Promise<object>} 统一形状的回执。
   */
  return async function executeTask(req) {
    // ═══ 传输面：只有计划任务（与 `tools/run.js` 同一路）══════════════════════
    //   唯一写入点 `startAutomationRun`：INSERT automations once +
    //   INSERT automation_runtime_state，once / next_run_at=now / valid_until=+25min /
    //   model_id / permission_mode / reasoning_effort / cwd。建会话成功立刻退役，任何终态都退役。
    const taskKey = key(req);
    const prompt = typeof req.prompt === 'string' ? req.prompt : '';
    if (prompt.trim() === '') {
      return {
        ok: false,
        transport: 'automation',
        text: '',
        reason: REASON_CODES.TASK_ERROR,
        error: { code: REASON_CODES.TASK_ERROR, message: 'prompt must be a non-empty string' },
        phases: [],
        receipt: null,
        sessionId: null,
        sessionOrigin: null,
        continuity: 'fresh-conversation-per-round',
        permission: { requested: '', effective: '(unknown)', confirmed: false },
        effort: { requested: '', effective: '(unknown)', confirmed: false },
      };
    }
    const ignite = typeof automation === 'function' ? automation : startAutomationRun;
    const requestedModel = automationModelId(req.model);
    const requestedPerm = typeof req.permissionMode === 'string' ? req.permissionMode : '';
    // ★ 推理强度真下发（与 tools/run.js 同一参数形状）：req.effort → reasoningEffort → reasoning_effort。
    const requestedEffort = typeof req.effort === 'string' ? req.effort.trim() : '';
    // ★ 即建即撤 + adopt 记账：与 `tools/run.js` 同一写入点、同一参数形状。
    //   `sessionKey` 非空且 `sessions.adopt` 存在时透给点火，点火在 `sessions.id` 一确认
    //   就 `retireRow` + `adopt`；缺席时（极简假宿主）按"没配写口"跳过，不炸整轮。
    const automationSessionStore = (sessions !== null && typeof sessions === 'object'
      && typeof sessions.adopt === 'function')
      ? { adopt: (k, rec) => sessions.adopt(k, rec) }
      : null;
    let handle;
    try {
      handle = ignite({
        prompt: replayPrefix(taskKey) + prompt,
        cwd: typeof req.cwd === 'string' ? req.cwd : '',
        modelId: requestedModel,
        ...(requestedPerm !== '' ? { permissionMode: requestedPerm } : {}),
        ...(requestedEffort !== '' ? { reasoningEffort: requestedEffort } : {}),
        ...(typeof req.name === 'string' && req.name !== '' ? { name: req.name } : {}),
        ...(taskKey !== '' ? { sessionKey: taskKey } : {}),
        ...(automationSessionStore !== null ? { sessionStore: automationSessionStore } : {}),
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
        ...(typeof onPhase === 'function' ? { onPhase } : {}),
      });
    } catch (err) {
      return {
        ok: false,
        transport: 'automation',
        text: '',
        reason: REASON_CODES.TASK_ERROR,
        error: { code: REASON_CODES.TASK_ERROR, message: err instanceof Error ? err.message : String(err) },
        phases: [],
        receipt: null,
        sessionId: null,
        sessionOrigin: null,
        continuity: 'fresh-conversation-per-round',
        permission: { requested: requestedPerm, effective: '(unknown)', confirmed: false },
        effort: { requested: requestedEffort, effective: '(unknown)', confirmed: false },
      };
    }
    let out;
    try {
      // 兼容两种注入形状：真点火返回 {cancel,done,readOutput}；极简假点火可直接返回 out。
      if (handle !== null && typeof handle === 'object' && 'done' in handle && handle.done !== undefined) {
        out = await handle.done;
      } else {
        out = await handle;
      }
    } catch (err) {
      return {
        ok: false,
        transport: 'automation',
        text: '',
        reason: REASON_CODES.TASK_ERROR,
        error: { code: REASON_CODES.TASK_ERROR, message: err instanceof Error ? err.message : String(err) },
        phases: [],
        receipt: null,
        sessionId: null,
        sessionOrigin: null,
        continuity: 'fresh-conversation-per-round',
        permission: { requested: requestedPerm, effective: '(unknown)', confirmed: false },
        effort: { requested: requestedEffort, effective: '(unknown)', confirmed: false },
      };
    }
    const report = reportFromAutomation(out);
    // 补上"请求了哪个"（点火回执里没有这两列，由本层如实带出，不编造实际值）。
    if (report.permission !== null && typeof report.permission === 'object') {
      const eff = typeof report.permission.effective === 'string' ? report.permission.effective : '(unknown)';
      report.permission = {
        requested: requestedPerm,
        effective: eff,
        confirmed: requestedPerm !== '' && requestedPerm === eff,
      };
    }
    // ★ effort 同上：本层请求值优先（fail 支点火回执里 requestedEffort 为 null 占位时仍能回显本次入参）。
    if (report.effort !== null && typeof report.effort === 'object') {
      const eff = typeof report.effort.effective === 'string' ? report.effort.effective : '(unknown)';
      const req = requestedEffort !== '' ? requestedEffort
        : (typeof report.requestedEffort === 'string' ? report.requestedEffort : '');
      report.effort = { requested: req, effective: eff, confirmed: req !== '' && req === eff };
      report.requestedEffort = req;
      if (report.effectiveEffort === null || report.effectiveEffort === undefined) {
        report.effectiveEffort = eff === '(unknown)' ? null : eff;
      }
    }
    if (typeof requestedModel === 'string' && requestedModel !== '') {
      report.requestedModelId = requestedModel;
    } else if (report.requestedModelId === null || report.requestedModelId === undefined) {
      report.requestedModelId = '';
    }
    // 重放记性：本轮 user + assistant 落袋，供下一轮新对话带上前情。
    pushTurn(taskKey, 'user', prompt);
    if (typeof report.text === 'string' && report.text.trim() !== '') {
      pushTurn(taskKey, 'assistant', report.text);
    }
    return report;
  };
}
