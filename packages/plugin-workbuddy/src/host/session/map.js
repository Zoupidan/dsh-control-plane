/**
 * 会话映射（key → CLI 会话 ID；§5.1/§5.3）—— T04 版（落盘 + 真实输出抽取）。
 *
 * Implements: 02-design/DESIGN-v3.md §5.1（命名空间 `sessions`：`{ "<key>": {cliSessionId, cwd, lastUsedAt} }`）/
 *             §5.3（新建会话 ⇒ 记下输出里的会话 ID；复用 ⇒ 下发 resumeFlag + 该 ID）/ §5.4（冷恢复）
 * 取证依据:   04-docs/RECON-WINDOW-RESULT.md §4.4（`system/init` 帧逐字字段：session_id/uuid/cwd/model/permissionMode）
 *
 * ★ 抽取不用"臆造正则"（T02 基线把这条登记为 T04 接手点）：解析器 = launch/stream-json.js，
 *   按帧 `type` 判别（W-10：**不按行号/序号读**），字符集校验后再落盘 —— 抽不到就记 null，**不猜**。
 *
 * ★ 落盘（GAP-3）：`settings.update(NS, { sessions: { <key>: patch } })`。
 *   实测契约（dsh-settings README）：`update(ns, patch)` 将**普通对象补丁深度合并**进用户层，
 *   校验合并结果 → 经 provider 持久化 → 提交。因此：
 *     - 补丁里**省略**某字段 ⇒ 旧值保留（所以"没抽到会话 ID"时不能写 null 覆盖旧 ID）；
 *     - 写入会被 schema 校验 → 本模块**在写入前净化记录**（类型不对的字段直接丢弃），
 *       避免一次坏写入让整份 namespace 校验失败（连带用户其它设置一起被拒）。
 *   `update` 是 **async** ⇒ 不阻塞作业收敛：异步提交 + 失败记账（`persistence().failures`）。
 *
 * 诚实边界：
 *   - 记录里的 `cwd` 只作**记录**，不参与 spawn 的 cwd 决策 —— §7.3 的优先级
 *     （args.cwd > config.cwdRoot > scratch）是设计逐字，新增"用历史 cwd"这一来源会**静默覆盖**
 *     cfg.cwdRoot 的语义，需受控窗口实证（登记为 T05 待办）。
 *   - `outputBytes` 按 **UTF-8 字节**计（与作业输出限额 64 KiB 同尺度）；`lossy` ⇒ outputTruncated，
 *     重放（§5.3 降级路径）**不得**把截断文本当全量。
 *
 * ★ 记录的**续接状态位**（T05 增量；为什么必须要这两个位，而不是只靠"有没有 ID"）：
 *   真机形态（`stream-json.js` 同款取证）：`--resume <不存在的 id>` 时 CLI **只**输出一帧
 *   `{"type":"error","error":"No conversation found with session ID: …"}`（exit 0，**没有任何新 session_id**）。
 *   若把"本轮没抽到新 ID"一律当成"沿用上一次的 ID 仍然有效"，这条**已经死掉的 id** 会被永久写回记录 ⇒
 *   之后每一次自动下发都拿它去 resume ⇒ 每次都静默空转（"一次失败导致永久失效"的最坏形态）。
 *   故把"**本轮被 CLI 确认过的**会话 id"与"沿用上一次的 id"分成两件事，并把状态**落盘 + 对上层可见**：
 *     - `superseded`  —— 调用方显式要求新开会话（`resume:false`）⇒ 旧 id 只作历史留存，**不得**再被自动续接；
 *     - `unconfirmed` —— 本轮**没有**得到任何会话确认（`sessionConfirmed:false`），且输出里有"该会话不存在"
 *       证据（真机 error 帧逐字见 `NO_SESSION_EVIDENCE`）⇒ 不得再假设它可续接。由**下一次 capture 的确认**清除。
 *   判据出处：本模块只用 `type:'error'` 帧 + 该帧的 `error` 文本（与 `reason-codes.PATTERNS.noSession`
 *   同源证据），**不**臆造新正则；无证据时保守沿用旧 id（例如 CLI 抽不到 id 但也没说会话不存在 ⇒ 不误杀）。
 *
 * 约束：本文件属于 packages/*​/src（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 */
import { randomUUID } from 'node:crypto';

import { REASON_CODES } from '../launch/reason-codes.js';
import { extractSessionId, isValidSessionId, parseFrames } from '../launch/stream-json.js';

/** 记账窗口：settings 用户层里最多保留多少条会话（防止无限膨胀；超出按 lastUsedAt 淘汰最旧）。 */
export const SESSION_RETENTION = 200;

/**
 * "会话不存在"证书帧的文本判据 —— 与 `reason-codes.js` 的 `PATTERNS.noSession` **同源证据**
 * （真机逐字：2026-09-19 `--resume <不存在的 id>`）。此处**不发明**新形态：只收已取证/官方口径的几种说法。
 */
const NO_SESSION_PATTERNS = Object.freeze([
  /No conversation found with session ID/i,
  /\bno such session\b/i,
  /\bsession\b[^\n]{0,40}\bnot found\b/i,
  /会话(?:不存在|未找到)/,
]);

/** 证据串上限（与 `reason-codes.EVIDENCE_LIMIT` 同尺度，够放下真机那一整句）。 */
const NO_SESSION_EVIDENCE_LIMIT = 400;

/**
 * 记录净化：只保留 schema 认得的字段且类型正确。
 * 依据：写入会被 schemastery 校验，坏类型会**整份拒绝**（实测：`$.sessions.u-1.cliSessionId expected
 * string | Schema<const> but got 42`）⇒ 宁可在写入前丢字段，也不让一次写入连带拒掉用户其它设置。
 *
 * ★ `superseded` / `unconfirmed` 必须**显式写出布尔值**（不能只在为真时才带）：
 *   `settings.update` 是**深度合并**（省略字段 = 保留旧值）⇒ 一次正常确认若省略 `unconfirmed:false`，
 *   上一轮的 `unconfirmed:true` 会**永远留下来**，把已经恢复健康的会话永久判死。
 *
 * @param {{ cliSessionId?: unknown, cwd?: unknown, lastUsedAt?: unknown, outputBytes?: unknown,
 *           outputTruncated?: unknown, superseded?: unknown, unconfirmed?: unknown,
 *           own?: unknown, createdAt?: unknown }} record
 * @returns {object} 净化后的记录（可能不含某些字段）
 */
export function sanitizeRecord(record) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (isValidSessionId(record?.cliSessionId)) out.cliSessionId = record.cliSessionId;
  if (typeof record?.cwd === 'string' && record.cwd !== '') out.cwd = record.cwd;
  if (Number.isFinite(record?.lastUsedAt)) out.lastUsedAt = Number(record.lastUsedAt);
  if (Number.isSafeInteger(record?.outputBytes) && record.outputBytes >= 0) out.outputBytes = record.outputBytes;
  if (typeof record?.outputTruncated === 'boolean') out.outputTruncated = record.outputTruncated;
  if (typeof record?.superseded === 'boolean') out.superseded = record.superseded;
  if (typeof record?.unconfirmed === 'boolean') out.unconfirmed = record.unconfirmed;
  // ★ §4.3 自建会话标记：`own:true` = 插件经网关自建、可由启动清理回收；非 bool 一律丢弃（不猜）。
  if (record?.own === true) out.own = true;
  // ★ `createdAt` = 该 key 首次建会话的墙钟（refresh 时沿用旧值，不覆盖）。非法值丢弃。
  if (Number.isFinite(record?.createdAt)) out.createdAt = Number(record.createdAt);
  return out;
}

/** 会话摘要回传上限（状态路由 / `workbuddy_status` 工具面共用；§5.1 映射最多留 200 条）。 */
export const SESSION_SUMMARY_LIMIT = 20;

/**
 * "该会话在 CLI 侧不存在"的**证据判据**（本模块唯一实现）。
 *
 * 为什么需要它：`extractSessionId` 只回答"有没有抽到 id"，抽不到时**分不清**"CLI 没说话"与
 * "CLI 明确说这个会话没了"。而这两者对续接决策的含义完全相反 —— 前者应保守沿用旧 id，
 * 后者必须停止续接（真机 94 字节 error 帧就是这个形态）。
 *
 * 证据面刻意**只**取 `type:'error'` 帧的 `error`/`details` 文本：
 *   - 不用 `resultText`/assistant 正文：正文里模型讨论 "session not found" 是**任务内容**，
 *     把它当证据会误杀一个正常会话（与 `stream-json.js` 的"证据面/正文面分离"同一条纪律）；
 *   - 不用 exit code：真机该形态 exit 0（`verdict.js` 的 D-3 结论：退出码不可信）。
 *
 * @param {string} text 作业输出（stream-json 形态，允许残帧）
 * @returns {{ reason: string, evidence: string }|null} 命中 ⇒ 稳定原因码 + 逐字证据；未命中 ⇒ null（不猜）
 */
export function noSessionEvidence(text) {
  const source = typeof text === 'string' ? text : '';
  if (source === '') return null;
  const { frames } = parseFrames(source);
  for (const frame of frames) {
    const value = frame.value;
    if (value?.type !== 'error') continue; // 只认 CLI 自己打的错误帧
    const message = typeof value.error === 'string' && value.error !== ''
      ? value.error
      : (typeof value.details === 'string' ? value.details : '');
    if (message === '') continue;
    if (NO_SESSION_PATTERNS.some((re) => re.test(message))) {
      return { reason: REASON_CODES.NO_SESSION_RESUME, evidence: message.replace(/\s+/g, ' ').trim().slice(0, NO_SESSION_EVIDENCE_LIMIT) };
    }
  }
  return null;
}

/**
 * 续接状态位的**面向人**说明（"为什么没续接"必须可读，不能只留一个枚举值）。
 * 取值 = `unresumableReason()` 的稳定原因码（空串 = 没有阻碍）。
 */
export const RESUME_STATE_TEXT = Object.freeze({
  superseded: '已被替代：调用方显式要求新开会话（resume:false），旧会话不再自动续接。',
  unconfirmed: '未确认：上一轮 CLI 没有确认任何会话（输出显示要续接的会话已不存在），已停止自动续接。',
  no_session_id: '无会话 ID：该 key 有记录但没有可下发的会话 ID。',
  absent: '无记录：该 key 从未产生会话记录。',
  unknown: '原因未知：记录形态异常，未能判定为什么不可续接。',
});

/** 会话 ID 的**抽取来源 → 确认语义**：CLI 输出里出现合法会话 ID 即视为"本轮确认了会话"。 */
const CONFIRM_SOURCE_TEXT = Object.freeze({
  init: 'CLI 初始化帧（system/init）确认',
  frame: 'CLI 输出帧确认',
  regex: 'CLI 输出中的会话 ID 确认',
  none: '本轮 CLI 未出现任何会话 ID',
});

/**
 * "按记录能不能下发 resume"的**唯一判据**（`sessionSummary` 与 `resumable(key)` 共用）。
 * 三个条件缺一不可：① id 形态合法（`isValidSessionId`，否则 argv 会被吃掉取值）；
 * ② 未被显式替代（`resume:false`）；③ 未被判为未确认（CLI 报告过该会话不存在）。
 *
 * 为什么收成一个纯函数而不是两处各写一遍：两处判据一旦漂移，UI 与下发力就会互相矛盾
 * （UI 说可续接、run 却静默开新会话），这正是本次要修的缺陷之一。
 *
 * @param {{ cliSessionId?: unknown, superseded?: unknown, unconfirmed?: unknown }|null|undefined} record
 * @returns {boolean}
 */
export function isResumableRecord(record) {
  if (!isValidSessionId(record?.cliSessionId)) return false;
  return record?.superseded !== true && record?.unconfirmed !== true;
}

/**
 * 不可续接的**稳定原因码**（空串 = 没有阻碍）。取值与 `RESUME_STATE_TEXT` 的键一一对应。
 * @param {{ cliSessionId?: unknown, superseded?: unknown, unconfirmed?: unknown }|null|undefined} record
 * @returns {string}
 */
export function unresumableCode(record) {
  if (isResumableRecord(record)) return '';
  // 顺序即语义：用户显式替代 > CLI 侧已证不存在 > 压根没有 id。
  if (record?.superseded === true) return 'superseded';
  if (record?.unconfirmed === true) return 'unconfirmed';
  if (!isValidSessionId(record?.cliSessionId)) return 'no_session_id';
  return 'unknown';
}

/**
 * 会话映射的**只读摘要**（按 lastUsedAt 倒序 + 条数封顶）—— 路由面与工具面共用同一份判定。
 * 刻意只回传 key / CLI 会话 ID / 时间 / 字节数 / 可续接位：`cwd` 属本机路径信息，非展示所必需则不扩散。
 *
 * 可续接位的判据 = `isValidSessionId(id)` **且** 没有 `superseded` / `unconfirmed` 状态位
 * （与 `resumable(key)` 的同一条判据，两处共用 `isResumableRecord` —— 避免"UI 说能续、run 却拒绝"或反之）。
 *
 * ★ 为什么把"展示位"与"下发力"做成同判据（修掉旧的因果断言）：
 *   旧注释写的是"UI 显示可续接 ⇒ run 真能续接"，那是**无证据的因果断言** —— UI 的 resumable 只说明
 *   "记录里有一个**形态合法**的 id"，而 CLI 侧那个会话是否还在，本进程（甚至整个插件）无从得知
 *   （真机已证明：合法的 id 在 CLI 侧也可能已不存在）。两处**必须**由同一判据计算，但该判据只能表达
 *   "按记录可下发 resume"，**不构成**"CLI 一定还能续接"的承诺。
 *
 * @param {{ list?: () => any[] }|null|undefined} sessions
 * @param {number} [limit]
 * @returns {Array<{ sessionKey: string, cliSessionId: string, lastUsedAt: number,
 *                   outputBytes: number, resumable: boolean }>}
 */
export function sessionSummary(sessions, limit = SESSION_SUMMARY_LIMIT) {
  if (sessions === null || sessions === undefined || typeof sessions.list !== 'function') return [];
  let rows;
  try {
    rows = sessions.list();
  } catch {
    return []; // 读会话映射失败不得把整个状态查询带崩
  }
  const max = Number.isSafeInteger(limit) && limit >= 0 ? limit : SESSION_SUMMARY_LIMIT;
  return (Array.isArray(rows) ? rows : [])
    .map((r) => ({
      sessionKey: typeof r?.key === 'string' ? r.key : '',
      cliSessionId: typeof r?.cliSessionId === 'string' ? r.cliSessionId : '',
      lastUsedAt: Number.isFinite(r?.lastUsedAt) ? Number(r.lastUsedAt) : 0,
      outputBytes: Number.isSafeInteger(r?.outputBytes) ? r.outputBytes : 0,
      resumable: isResumableRecord(r),
    }))
    .filter((r) => r.sessionKey !== '')
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, max);
}

/**
 * §4.3 启动清理：扫自建会话遗留（只经 settings 打标记，不碰用户 WorkBuddy 库）。
 *
 * <p>语义（保守，避免误杀正常复用）：
 * <ul>
 *   <li>只看 `own === true` 的记录 —— 插件经网关自建的会话。老记录/用户绑定一律不动（不猜）。</li>
 *   <li>已判死（`superseded`/`unconfirmed`）的不用再动，只计数。</li>
 *   <li>活记录中，仅 `lastUsedAt` 老于 `now - maxAgeMs` 的才标 `supersede`（dsh 中途被杀后
 *       长期无人认领的残留）；其余保留复用（重启后仍续用同一条，见 gateway-bound-session 测试）。</li>
 * </ul>
 *
 * <p>只做标记（`supersede` → 不再自动续接、历史留痕），不删记录、不调任何 WorkBuddy 接口。
 * 网关侧无删除接口（见 dispatch.js），如实报 `recycled:false`，不谎报已回收。
 *
 * @param {{ list: () => any[], supersede: (k: string) => any }} api `loadSessionMap` 的返回面（子集即可）
 * @param {{ now?: number, maxAgeMs?: number }} [opts]
 * @returns {{ scanned: number, own: number, swept: string[], kept: string[], dead: string[] }}
 */
export function sweepOwnSessions(api, opts = {}) {
  const now = Number.isFinite(opts.now) && opts.now > 0 ? Number(opts.now) : Date.now();
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) && opts.maxAgeMs >= 0 ? Number(opts.maxAgeMs) : 7 * 24 * 3600 * 1000;
  const out = { scanned: 0, own: 0, swept: [], kept: [], dead: [] };
  let rows;
  try {
    rows = typeof api?.list === 'function' ? api.list() : [];
  } catch {
    return out;
  }
  if (!Array.isArray(rows)) return out;
  out.scanned = rows.length;
  for (const r of rows) {
    const k = typeof r?.key === 'string' ? r.key : '';
    if (k === '' || r?.own !== true) continue;
    out.own += 1;
    if (r?.superseded === true || r?.unconfirmed === true) { out.dead.push(k); continue; }
    const age = now - (Number.isFinite(r?.lastUsedAt) ? Number(r.lastUsedAt) : 0);
    if (age > maxAgeMs) {
      try { api.supersede(k); } catch { /* 标记失败 = 下次启动再扫，不带崩启动 */ }
      out.swept.push(k);
    } else {
      out.kept.push(k);
    }
  }
  return out;
}

/**
 * @param {object} ctx 宿主 ctx（`ctx.get('settings')` 可能为 undefined —— SKILL 要求缺省检查）
 * @param {string} ns settings namespace
 */
export function loadSessionMap(ctx, ns) {
  /**
   * @type {Map<string, {cliSessionId: string | null, cwd: string | null, lastUsedAt: number,
   *                     outputBytes: number, outputTruncated: boolean,
   *                     superseded: boolean, unconfirmed: boolean}>}
   */
  const memory = new Map();
  /** 持久化失败/跳过记账（如实暴露；不静默吞掉"会话永远恢复不了"这件事）。 */
  const persistenceState = {
    attempts: 0, ok: 0, failures: 0, lastError: '', noop: 0, pending: 0,
    /** 最近一次**失败**的结构化留痕（`{key, error, at}`）；只在失败时写，成功不清除（"有过失败"本身要可见）。 */
    lastFailure: null,
  };

  const settingsService = () => {
    const svc = ctx.get?.('settings');
    return svc !== undefined && svc !== null ? svc : null;
  };

  // ★ 0.1.7 变更（B2）：`settings.get(ns)` 已移除（0.1.5 在 `dsh-settings/lib/index.js:388`）。
  //   0.1.7 的 SettingsForms 公共面只剩 configure/writable/documentPath/prepareDocument/
  //   describe/update/replace/mutate（`lib/types/index.d.ts:80-114`）——**没有 get，也没有订阅**。
  //   读法改为扫 `describe()` 的返回行：每行 `{ns, value, base, user, revision, …}`，
  //   取 `row.ns === ns` 那条的 `value.sessions`（`lib/index.js:441-451`）。
  const persistedSessions = () => {
    const svc = settingsService();
    if (svc === null || typeof svc.describe !== 'function') return {};
    let rows;
    try {
      rows = svc.describe();
    } catch {
      return {};
    }
    if (!Array.isArray(rows)) return {};
    const row = rows.find((r) => r && r.ns === ns);
    const sessions = row?.value?.sessions;
    return typeof sessions === 'object' && sessions !== null ? sessions : {};
  };

  /**
   * 提交一条会话记录（深度合并语义 ⇒ 只发增量字段）。
   *
   * ★ 返回值必须让**调用方**看得见这次写盘的结果，而不只是 `ctx.logger.warn`：
   *   真机上 `ctx.logger` 是否存在尚未验证，而"会话悄悄没了"是用户唯一可见的后果 ⇒
   *   写失败必须落到**返回字段**（`persistState` / `persistError`）里。
   *   `persistState` 的取值刻意区分两条异步边界：
   * ★★ `'noop'` 取代了原来的 `'skipped'`（WB-8 零碎账，2026-09-22）：**"跳过"这个词在撒谎** ——
   *   它暗示"本来要做、这轮略过"，而实际语义是"这一次压根没有提交任何东西"。改名时顺手把
   *   原来分给两条分支的两个标签**合并成一个**（另一条是"patch 净化后为空"，此前叫 `'noop'`），
   *   理由不是省事：两者对 `persisted` 的结论**相同**（都 ⇒ `false`，见 `capture()` 里的正向列举），
   *   而**成因**逐字住在 `persistError` / `lastError` 里（`settings.update unavailable`
   *   vs `sanitizeRecord emptied the patch`）。⇒ 两个标签是在重复表达同一个维度，
   *   合并后"没做"由状态说、"为什么没做"由成因说，各一处、不互相冒充。
   *   取值域因此仍是四条，`persistError` 是它的第二维：
   *     'noop'      —— 没有提交任何东西（没有 settings 服务 ⇒ 本进程内可续接但重启后丢失；或净化后为空）；
   *     'failed'    —— **同步**抛出 ⇒ 此刻就已经知道写不进去（返回值里直接带错误）；
   *     'pending'   —— 已交给 settings，成败要等 Promise 收敛（异步失败经 `settled()`/`persistence()` 暴露）；
   *     'attempted' —— 同上，且此刻已经收敛为成功。
   *
   * @param {string} key @param {object} patch
   * @returns {{ persistState: 'noop'|'failed'|'pending'|'attempted', persistError: string }}
   */
  function persist(key, patch) {
    const svc = settingsService();
    if (svc === null || typeof svc.update !== 'function') {
      persistenceState.noop += 1;
      persistenceState.lastError = 'settings.update unavailable';
      return { persistState: 'noop', persistError: 'settings.update unavailable' };
    }
    persistenceState.attempts += 1;
    persistenceState.pending += 1;
    let result;
    try {
      result = svc.update(ns, { sessions: { [key]: patch } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      persistenceState.pending -= 1;
      persistenceState.failures += 1;
      persistenceState.lastError = message;
      // 同步失败也要留结构化痕迹：否则"同步抛"这条边界上，上层只能看到一个字符串字段，
      // 拿不到"是哪把 key / 什么时候"（异步失败那条分支本来就写了同款痕迹）。
      persistenceState.lastFailure = { key, error: message, at: Date.now() };
      return { persistState: 'failed', persistError: message };
    }
    if (result === null || typeof result?.then !== 'function') {
      // settings.update 返回非 thenable（同步完成）⇒ 此刻就能给出确定结论。
      persistenceState.pending -= 1;
      persistenceState.ok += 1;
      return { persistState: 'attempted', persistError: '' };
    }
    void Promise.resolve(result).then(
      () => {
        persistenceState.pending -= 1;
        persistenceState.ok += 1;
      },
      (err) => {
        const message = err instanceof Error ? err.message : String(err);
        persistenceState.pending -= 1;
        persistenceState.failures += 1;
        persistenceState.lastError = message;
        persistenceState.lastFailure = { key, error: message, at: Date.now() };
        // 失败要可见（双通道）：① 这条日志（若宿主提供 logger）；② 上面的记账字段 / 返回值
        // —— 后者才是**不依赖宿主能力**的可见面（`settled()` / `persistence()` / capture 返回值）。
        ctx.logger?.warn?.(`[dsh-plugin-workbuddy] session map 落盘失败（${key}）：${message}`);
      },
    );
    return { persistState: 'pending', persistError: '' };
  }

  /**
   * 内存 → 合并视图（§5.1 形态）。
   * ★ `superseded` / `unconfirmed` 必须在这里归一（缺省 false）：settings 里已有的记录（老版本写入、
   *   冷启动读到）没有这两个字段，直接读 `undefined` 会让"记录已判死"在冷启动后**凭空复活**。
   */
  const view = (key, value) => ({
    key,
    cliSessionId: typeof value?.cliSessionId === 'string' ? value.cliSessionId : null,
    cwd: typeof value?.cwd === 'string' ? value.cwd : null,
    lastUsedAt: Number.isFinite(value?.lastUsedAt) ? Number(value.lastUsedAt) : 0,
    outputBytes: Number.isFinite(value?.outputBytes) ? Number(value.outputBytes) : 0,
    outputTruncated: value?.outputTruncated === true,
    superseded: value?.superseded === true,
    unconfirmed: value?.unconfirmed === true,
    // ★ 自建标记与创建时间向读侧透出（缺省 false/0，不猜）。list/summary 不扩散 cwd，但 own/createdAt 是回收判据，必须可见。
    own: value?.own === true,
    createdAt: Number.isFinite(value?.createdAt) ? Number(value.createdAt) : 0,
  });

  const api = {
    /** 新会话键（§5.1：uuid；与 CLI 侧会话 ID 的关联由 capture 建立）。 */
    createKey: () => randomUUID(),

    /**
     * 只读推演：查不到返回 null，**不猜**（§5.1 逐字）。
     * 优先级 = **内存优先**（本进程内的 capture 是最新知识；settings 是重新加载/冷启动后的来源）。
     * 注意：settings 层写入是异步的 ⇒ 刚 capture 完就读 settings 会拿到旧值（会误判"不可恢复"）。
     */
    lookup(key) {
      if (typeof key !== 'string' || key === '') return null;
      const local = memory.get(key);
      if (local !== undefined) return view(key, local);
      const fromSettings = persistedSessions()[key];
      if (fromSettings !== undefined && fromSettings !== null) return view(key, fromSettings);
      return null;
    },

    /**
     * 可复用会话（§5.3）：id 合法 **且** 没被判死（`superseded`/`unconfirmed`）才算可复用；否则 null（**不猜**）。
     *
     * ★ 这正是缺陷①的闸门：吃过一帧"会话不存在"之后，该 key 的旧 id 仍留在记录里（历史可查），
     *   但这里返回 null ⇒ 后续自动下发**不会**再默认拿死 id 去 resume（静默空转被掐断）。
     *
     * @param {string} key
     * @returns {{ cliSessionId: string, cwd: string|null }|null}
     */
    resumable(key) {
      const record = api.lookup(key);
      if (record === null || !isResumableRecord(record)) return null;
      return { cliSessionId: record.cliSessionId, cwd: record.cwd };
    },

    /**
     * "这个 key 为什么不可续接"（**可读文案 + 稳定原因码**）—— 让"没续接"这件事有交代，而不是悄悄换新会话。
     *
     * 为什么单独成一个方法而不是塞进 `resumable()` 的返回值：`resumable()` 的
     * `{cliSessionId, cwd} | null` 是既有契约（run.js 与既有测试都按这个形状断言），
     * 改形状会波及调用方；而原因面是**新增消费者**（下一条自动下发要说明自己为什么没续接）。
     *
     * @param {string} key
     * @returns {{ reason: string, text: string, cliSessionId: string, record: object|null }}
     *          `reason === ''` 表示**可续接**（text 也为空）。
     */
    unresumableReason(key) {
      const record = api.lookup(key);
      if (record === null) {
        return { reason: 'absent', text: RESUME_STATE_TEXT.absent, cliSessionId: '', record: null };
      }
      const reason = unresumableCode(record);
      return {
        reason,
        text: reason === '' ? '' : (RESUME_STATE_TEXT[reason] ?? RESUME_STATE_TEXT.unknown),
        cliSessionId: typeof record.cliSessionId === 'string' ? record.cliSessionId : '',
        record,
      };
    },

    /**
     * 标记"该 key 的旧会话已被替代"（`resume:false` 的落点）。
     *
     * 裁决（父 agent）：`resume:false` **保留**旧 id 记录（历史可查），但必须标 `superseded`
     * ⇒ 下一次自动下发不得 resume 它，且必须说明自己没续接（说辞经 `unresumableReason`）。
     *
     * 为什么保留 id 而不是清空：清空会丢掉"这个 key 曾经接过哪个会话"这一事实，
     * 也让用户无法从记录里看出发生过替代；而 `superseded` 恰好把"保留 + 不再自动使用"两件事同时表达。
     *
     * 已有确认（新 id）时 `capture` 会显式写回 `superseded:false` ⇒ 替代标记**自动失效**，
     * 不会把恢复健康的会话永久判死。
     *
     * @param {string} key
     * @param {string} [reason] 稳定原因码（默认 'superseded'）
     * @returns {{ ok: boolean, persistState: string, persistError: string }}
     */
    supersede(key, reason = 'superseded') {
      if (typeof key !== 'string' || key === '') return { ok: false, persistState: 'failed', persistError: 'empty session key' };
      const existing = api.lookup(key);
      // 没有记录 ⇒ 没有"旧会话"可替代：**不**为一次新开会话凭空造记录（否则 settings 里会堆出空壳）。
      if (existing === null || !isValidSessionId(existing.cliSessionId)) {
        return { ok: false, persistState: 'no_record', persistError: '' };
      }
      const patch = {
        cliSessionId: existing.cliSessionId,
        cwd: existing.cwd,
        lastUsedAt: existing.lastUsedAt,
        outputBytes: existing.outputBytes,
        outputTruncated: existing.outputTruncated,
        superseded: true,
        // 替代与"未确认"是两件事：替代是**调用方**的意图，未确认是 CLI 的观测 ⇒ 各自独立落位。
        unconfirmed: existing.unconfirmed === true,
        // ★ 自建标记与创建时间是回收判据，supersede 不得洗掉（深度合并下省略=保留，内存侧必须显式带）。
        ...(existing.own === true ? { own: true } : {}),
        ...(Number.isFinite(existing.createdAt) && existing.createdAt > 0 ? { createdAt: existing.createdAt } : {}),
      };
      const sanitized = sanitizeRecord(patch);
      memory.set(key, {
        cliSessionId: typeof sanitized.cliSessionId === 'string' ? sanitized.cliSessionId : null,
        cwd: typeof sanitized.cwd === 'string' ? sanitized.cwd : null,
        lastUsedAt: Number.isFinite(sanitized.lastUsedAt) ? Number(sanitized.lastUsedAt) : 0,
        outputBytes: Number.isSafeInteger(sanitized.outputBytes) ? sanitized.outputBytes : 0,
        outputTruncated: sanitized.outputTruncated === true,
        superseded: true,
        unconfirmed: existing.unconfirmed === true,
        own: sanitized.own === true,
        createdAt: Number.isFinite(sanitized.createdAt) ? Number(sanitized.createdAt) : 0,
      });
      const outcome = persist(key, sanitized);
      return { ok: true, persistState: outcome.persistState, persistError: outcome.persistError };
    },

    /**
     * 收下**从本进程外部**拿到的会话 ID。
     *
     * 为什么需要它（不是多余的第二个写入口）：`capture()` 唯一的 ID 来源是 **CLI stdout**
     * （`extractSessionId` 解析 stream-json 帧）。而 gateway 路径**根本不走 CLI** —— 它的
     * 会话 ID 来自 ACP `session/new` 的 result 帧。让 gateway 去调 `capture()` 等于
     * 把一个不存在的 stdout 传进去（抽出来必然是 `source:null`），会话就永远记不住。
     *
     * 职责边界：**谁观测到 ID 谁写**。`capture()` 观测输出，本方法观测 ACP 回执。
     * 调用方负责保证传进来的是**它自己要留的那条**（gateway 侧连着 new 两次、
     * 只留第二次——见 dispatch.js `NEW_SESSION_ATTEMPTS`）。
     *
     * @param {string} key
     * @param {{ cliSessionId: unknown, cwd?: unknown, own?: unknown, createdAt?: unknown }} rec
     *   `own:true` = 网关自建会话（§4.3 可回收标记）；`createdAt` 仅首次写入有效，refresh 时沿用旧值。
     * @returns {{ ok: boolean, cliSessionId: string, persistState: string, persistError: string }}
     *          `ok:false` 时 `persistError` 逐字给出原因（**不静默丢**：悄悄丢掉一条会话
     *          的后果是"下一轮又去 new 一条"，而调用方拿不到任何线索）。
     */
    adopt(key, rec) {
      if (typeof key !== 'string' || key === '') {
        return { ok: false, cliSessionId: '', persistState: 'failed', persistError: 'empty session key' };
      }
      const cliSessionId = rec?.cliSessionId;
      if (!isValidSessionId(cliSessionId)) {
        return { ok: false, cliSessionId: '', persistState: 'failed', persistError: 'malformed session id' };
      }
      const previous = api.lookup(key);
      const nowMs = Date.now();
      // ★ createdAt 语义：首次建 = now；续用 refresh = 沿用旧值（旧值缺失才填 now，不覆盖）。
      const prevCreated = Number.isFinite(previous?.createdAt) && previous.createdAt > 0 ? previous.createdAt : 0;
      const createdAt = Number.isFinite(rec?.createdAt) && rec.createdAt > 0
        ? Number(rec.createdAt)
        : (prevCreated > 0 ? prevCreated : nowMs);
      const patch = sanitizeRecord({
        cliSessionId,
        cwd: typeof rec?.cwd === 'string' && rec.cwd !== '' ? rec.cwd : previous?.cwd,
        lastUsedAt: nowMs,
        // `adopt` 只拿到一个 ID，**没有**这次会话的输出字节数 ⇒ 写 0 而不是沿用上一轮的
        // （沿用会造出"这次会话产出了上一轮那么多字节"的假记录，而它没有依据）。
        outputBytes: 0,
        outputTruncated: false,
        // ★ 两个位**必须显式清真**，与 `capture()` 同一条纪律：settings 是**深度合并**，
        //   省略字段 = 保留旧值 ⇒ 一条成功的 adopt 若省略 `unconfirmed:false`，
        //   上一轮的 `unconfirmed:true` 会永远粘在这儿，把刚救回来的会话重新判死。
        superseded: false,
        unconfirmed: false,
        // ★ 自建标记粘滞：任一轮标过 own:true 就一直是自己的（深度合并下省略=保留，显式写出才可靠）。
        own: rec?.own === true || previous?.own === true,
        createdAt,
      });
      memory.set(key, {
        cliSessionId,
        cwd: typeof patch.cwd === 'string' ? patch.cwd : null,
        lastUsedAt: Number.isFinite(patch.lastUsedAt) ? Number(patch.lastUsedAt) : nowMs,
        outputBytes: 0,
        outputTruncated: false,
        superseded: false,
        unconfirmed: false,
        own: patch.own === true,
        createdAt: Number.isFinite(patch.createdAt) ? Number(patch.createdAt) : nowMs,
      });
      const outcome = persist(key, patch);
      return {
        ok: true,
        cliSessionId,
        persistState: outcome.persistState,
        persistError: outcome.persistError,
      };
    },

    /**
     * 只更新**已有**记录的热度/元数据（★ M2 多轮追发的保鲜口；RFC-SESSION-RESUME-INTEGRATION §3.2：
     * Track A 追发成功 ⇒ `touch(sessionKey)` —— 会话 id 没变，只有 `lastUsedAt` 需要推进）。
     *
     * <p>★ 为什么不用 `adopt`：adopt 的语义是"收下一条**新的**会话 id"—— 它会把 `outputBytes`
     * 清零、把 `createdAt` 重算、把判死位清真。而追发**没有**新 id：同一条对话还在原地，
     * 需要的只是"这条 key 刚刚被用过"（`sweepOwnSessions` 按 `lastUsedAt` 判陈旧，
     * 不 touch 的追发会话会在 7 天后被误判成遗留）。touch 只做热度合并，别的字段一律保留。
     *
     * <p>★ 安全 no-op：key 不存在 ⇒ 不造记录（与 `supersede` 同一纪律——为一次写入凭空造出的
     * 空壳既不可续接，还会把 settings 表撑出垃圾）。返回 `{ ok:false, persistState:'no_record' }`。
     *
     * @param {string} key
     * @param {object} [patch] 追加字段（后置合并，同键以补丁为准；类型不合法的字段被
     *   `sanitizeRecord` 丢弃 —— 与 capture/adopt 同一条"写入前净化"纪律，不让一次坏写入
     *   拖垮整份 namespace 校验）。
     * @returns {{ ok: boolean, persistState: string, persistError: string }}
     */
    touch(key, patch = undefined) {
      if (typeof key !== 'string' || key === '') return { ok: false, persistState: 'failed', persistError: 'empty session key' };
      const existing = api.lookup(key);
      if (existing === null) {
        // 安全 no-op：没有记录就没有"热度"可推进，绝不凭空造记录。
        return { ok: false, persistState: 'no_record', persistError: '' };
      }
      const nowMs = Date.now();
      // ★ 合并顺序：现有记录打底（判死位 / own / createdAt **显式**保真 —— 深度合并下省略 = 保留
      //   旧值，但内存侧必须显式，否则 view 的缺省归一会把"粘滞的判死位"悄悄洗成 false）
      //   → `lastUsedAt = now` → 调用方补丁最后（同键以补丁为准）。
      const merged = sanitizeRecord({
        ...(typeof existing.cliSessionId === 'string' && existing.cliSessionId !== ''
          ? { cliSessionId: existing.cliSessionId } : {}),
        ...(typeof existing.cwd === 'string' && existing.cwd !== '' ? { cwd: existing.cwd } : {}),
        lastUsedAt: nowMs,
        ...(Number.isSafeInteger(existing.outputBytes) && existing.outputBytes > 0
          ? { outputBytes: existing.outputBytes } : {}),
        ...(existing.outputTruncated === true ? { outputTruncated: true } : {}),
        ...(existing.superseded === true ? { superseded: true } : {}),
        ...(existing.unconfirmed === true ? { unconfirmed: true } : {}),
        ...(existing.own === true ? { own: true } : {}),
        ...(Number.isFinite(existing.createdAt) && existing.createdAt > 0 ? { createdAt: existing.createdAt } : {}),
        ...(typeof patch === 'object' && patch !== null ? sanitizeRecord(patch) : {}),
      });
      memory.set(key, {
        cliSessionId: typeof merged.cliSessionId === 'string' ? merged.cliSessionId : null,
        cwd: typeof merged.cwd === 'string' ? merged.cwd : null,
        lastUsedAt: Number.isFinite(merged.lastUsedAt) ? Number(merged.lastUsedAt) : nowMs,
        outputBytes: Number.isSafeInteger(merged.outputBytes) ? merged.outputBytes : 0,
        outputTruncated: merged.outputTruncated === true,
        superseded: existing.superseded === true || merged.superseded === true,
        unconfirmed: existing.unconfirmed === true || merged.unconfirmed === true,
        own: existing.own === true || merged.own === true,
        createdAt: Number.isFinite(merged.createdAt) && merged.createdAt > 0 ? Number(merged.createdAt) : 0,
      });
      const outcome = persist(key, merged);
      return { ok: true, persistState: outcome.persistState, persistError: outcome.persistError };
    },

    /**
     * 作业收敛时记录（§3.4.3 settle 调用点；**签名与 T02 基线保持兼容**：`(key, stdout, lossy)`，
     * 第 4 个参数是 T05 新增的可选选项，不传 ⇒ 行为与基线逐字一致）。
     *
     * ★ 缺陷①的修复点：把"**本轮 CLI 确认过的**会话 id"与"沿用上一次的 id"分成两个字段表达。
     *   真机形态（94 字节 error 帧）：`--resume <不存在的 id>` ⇒ 只有一帧 error，**没有**任何 session_id。
     *   旧实现只有 `?? previous?.cliSessionId` 一招 ⇒ 把"CLI 明确说这个会话没了"误当成"沿用旧 id 仍然有效"
     *   ⇒ 死 id 被永久写回 ⇒ 之后每次自动下发都拿它 resume ⇒ 每次静默空转。
     *   现改为：有"会话不存在"证据且本轮无确认 ⇒ `unconfirmed: true`（旧 id 仍留作历史，但不再可续接）。
     *
     * @param {string} key
     * @param {string} stdout 作业输出（stream-json 形态；允许是被裁剪的尾部窗口）
     * @param {boolean} [lossy] 真机 readFrom 的字段：true ⇒ 输出只是保留窗口的尾部
     * @param {{ resumeIntent?: 'auto'|'fresh'|'resume' }} [options]
     *        `resumeIntent:'fresh'` = 调用方显式 `resume:false`（`run.js` 的 `intent === false`）：
     *        本轮若**没有**确认新会话，旧 id 保留但标 `superseded`（下一次自动下发不得再 resume 它）。
     * @returns {{ cliSessionId: string|null, source: string|null, cwd: string|null,
     *             outputBytes: number, outputTruncated: boolean, persisted: boolean,
     *             resumable: boolean, sessionConfirmed: boolean, confirmText: string,
     *             persistState: string, persistError: string, blockedReason: string }}
     */
    capture(key, stdout, lossy = false, options = undefined) {
      const empty = {
        cliSessionId: null, source: null, cwd: null, outputBytes: 0, outputTruncated: lossy === true,
        persisted: false, resumable: false, sessionConfirmed: false, confirmText: CONFIRM_SOURCE_TEXT.none,
        persistState: 'noop', persistError: '', blockedReason: '',
      };
      if (typeof key !== 'string' || key === '') return empty;

      const text = typeof stdout === 'string' ? stdout : '';
      const extracted = extractSessionId(text);
      // 证据面：本轮输出里有没有"该会话在 CLI 侧不存在"（只认 type:'error' 帧的文本，理由见 noSessionEvidence）
      const deadSession = noSessionEvidence(text);
      const previous = memory.get(key) ?? api.lookup(key) ?? null;
      const previousUnconfirmed = previous?.unconfirmed === true;
      const previousSuperseded = previous?.superseded === true;

      /**
       * 本轮是否**得到 CLI 的会话确认**：抽到形态合法的 id 即成立（真机每帧都带 session_id，
       * 能抽到就说明这一轮确实跑在一个会话上）。抽不到 ⇒ 不假设、不猜。
       */
      let sessionConfirmed = extracted.cliSessionId !== null;
      /**
       * ★ 对抗补丁（本轮踩到的真实陷阱）：`extractSessionId` 的 `'frame'` 分支会读**任意帧**的
       * `session_id` —— 包括 `type:'error'` 帧。而"会话不存在"那帧里的 id 恰恰是**我们刚递进去、CLI 说它不存在**的那个
       * ⇒ 不加这条，抽出来的"新确认"就是**死 id 本身**，记录会被"确认"成一个死会话（比原缺陷更糟）。
       * 真机形态下该帧不含 `session_id`（实测：`extractSessionId` 对该帧返回 `source:null`），
       * 此条是**防御性**的：只要本轮有"会话不存在"证据，就不接受任何来源的抽取结果当确认
       * （含 `regex` 兜底 —— 退路越多，把 error 文本里的死 id 当新会话的概率越大）。
       */
      if (deadSession !== null) sessionConfirmed = false;

      /**
       * 判死条件刻意**窄**：必须有"会话不存在"的证据，且本轮没有得到确认。
       * 为什么不用"抽不到 id"当判据：抽取失败的原因里有大量**与续接无关**的情形
       * （空输出、进程被拒、参数被拒、输出被裁剪、id 形态非法……），把它们一律判死会误杀健康会话，
       * 而既有行为（既有测试逐字锁定）要求"输出里只有非法 id 时保留上一个合法 id"。
       */
      const unconfirmed = !sessionConfirmed && deadSession !== null;
      const fresh = options?.resumeIntent === 'fresh';

      const record = {
        // 语义①：**本轮 CLI 确认的** id（抽不到 ⇒ null，不在这里沿用旧值）
        cliSessionId: extracted.cliSessionId ?? null,
        cwd: extracted.cwd ?? (typeof previous?.cwd === 'string' && previous.cwd !== '' ? previous.cwd : null),
        lastUsedAt: Date.now(),
        outputBytes: Buffer.byteLength(text, 'utf8'),
        outputTruncated: lossy === true,
        // 语义②：状态位只被**证据 / 本轮确认 / 意图**推动，不被"缺席"推动（2026-09-22 P1 洗白修复）。
        //   · 置真：本轮死亡证据（unconfirmed）、fresh 意图（superseded；另见下方 supersede() 兜底）。
        //   · 清真：只有**本轮确认了新会话**（位描述的是新 id，旧 id 的判死到此为止）。
        //   · 其余轮次（抽不到、什么都没读到）**沿用旧位** —— 粘滞。
        //   ★ 原缺陷：非 fresh 分支把两个位写成**当轮观测值**（superseded 恒 false、unconfirmed 恒当轮值）
        //     ⇒ 深度合并把 `true` 洗成 `false` ⇒ 判死被下一轮空轮撤销（死 id / 用户放弃的会话复活）。
        // 布尔量**显式写真**，不能只在为真时才带字段：settings 是深度合并，省略 = 保留旧值
        // ⇒ 一次确认过的会话若省略 `unconfirmed:false`，上一轮的 `true` 会永远留下来。
        superseded: sessionConfirmed ? false : (fresh || previousSuperseded),
        unconfirmed: sessionConfirmed ? false : (previousUnconfirmed || unconfirmed),
      };
      /**
       * 语义②：沿用/留存上一次的 id。本轮没确认时分两种情形（2026-09-22 P1：id 与判死位**分闸各守**）：
       *   · 本轮**确认**了新 id ⇒ 用新的（替代掉旧值；位同时清真，见上）。
       *   · 其余（本轮没确认）⇒ **留住旧 id 只作历史留痕**，无论它带不带判死位。
       *     fresh 意图那一轮位是 `superseded`、死亡证据那一轮是 `unconfirmed`；
       *     "留痕"不等于"可续接"：判死位写在记录上，`resumable()` 一律返回 null ——
       *     "记得是哪个会话没了/被放弃"与"不得再自动续接它"同时成立。
       * 为什么必须留下：内存态与落盘态必须给出**同一个** id。`sanitizeRecord` 会把 null 字段剥掉，
       * 于是"内存里 id=null、磁盘上还是旧 id"这种双口径会悄悄形成（本轮实测到的分叉）——
       * 上层只要换个读法就得到相反结论，比缺陷本身更难查。
       * ★ 原闸门在判死位为真时把 id 判成 null（双口径 + `unresumableReason` 从 'superseded' 退化成
       *   'no_session_id' = 归因失真）—— 不得续接改由位的**粘滞**承载（清真只认本轮确认），id 恒留痕。
       */
      if (!sessionConfirmed && isValidSessionId(previous?.cliSessionId)) {
        record.cliSessionId = previous.cliSessionId;
      }
      memory.set(key, record);

      // 淘汰：内存视图也要收敛（否则长会话进程里内存无限增长）
      if (memory.size > SESSION_RETENTION) {
        const oldest = [...memory.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
        for (let i = 0; i < oldest.length - SESSION_RETENTION; i += 1) memory.delete(oldest[i][0]);
      }

      const patch = sanitizeRecord(record);
      let persisted = false;
      let persistState = 'noop';
      let persistError = '';
      if (Object.keys(patch).length > 0) {
        const outcome = persist(key, patch);
        // `persisted` = "这次提交**真的出去了**"（基线的真值口径：提交过就算 true，
        // 含"已受理但还没收敛"）；**最终写没写进去**由 `persistState` 如实说，两者不混。
        // ★ 显式正向列举，不用 `!== 'failed'` 兜底 —— 兜底会把 `'noop'`（压根没提交）报成 true。
        //   这条纪律与标签怎么命名**无关**：`'noop'` 在本函数里出现在两处成因（persist 内部的
        //   "没有 settings 服务"、以及下方 else 分支的"净化后为空"），两处的 `persisted` 都是
        //   `false` ⇒ 合并命名没有把两种相反结论塞进同一个标签（那是当年 `!== 'failed'` 兜底才有的
        //   毛病）；两者的区别由 `persistError` 逐字承载。
        //   正向写法的另一好处：fail-closed —— 未来新增状态默认落到 false（不谎报已落盘）。
        persisted = outcome.persistState === 'attempted' || outcome.persistState === 'pending';
        persistState = outcome.persistState;
        persistError = outcome.persistError;
      } else {
        persistenceState.noop += 1;
        persistenceState.lastError = 'sanitizeRecord emptied the patch';
      }

      // `resume:false` 且本轮没确认新会话 ⇒ 旧 id 落成"已被替代"（保留历史 + 停止自动续接）。
      // 放在 persist 之后：supersede 自己会再提交一次 patch（含 superseded:true），两次提交都走同一条记账。
      if (fresh && !sessionConfirmed) {
        const ruled = api.supersede(key, 'superseded');
        if (ruled.persistState === 'failed') {
          persistState = 'failed';
          persistError = ruled.persistError;
        }
      }

      const recordView = api.lookup(key);
      return {
        cliSessionId: record.cliSessionId,
        source: extracted.source,
        cwd: record.cwd,
        outputBytes: record.outputBytes,
        outputTruncated: record.outputTruncated,
        persisted,
        // 面向上层的可续接位（判据与 `resumable(key)`/摘要位共用 `isResumableRecord`，不允许漂移）
        resumable: isResumableRecord(recordView),
        sessionConfirmed,
        confirmText: sessionConfirmed
          ? (CONFIRM_SOURCE_TEXT[extracted.source] ?? CONFIRM_SOURCE_TEXT.frame)
          : CONFIRM_SOURCE_TEXT.none,
        persistState,
        persistError,
        blockedReason: unresumableCode(recordView),
      };
    },

    /**
     * 作废记性：那条会话终态失败/取消/超时，下轮重建（`run` 链的回收口）。
     *
     * <p>语义 = `supersede` 的别名（保留旧 id 作历史留痕，但不再自动续接）。
     * 别名单独存在是为了让调用方（`run.js` 复用链 / `automation.js` 终态回收）
     * 按 `sessionStore` 的 `{read, adopt, forget}` 三件套接线，而不用知道底层叫
     * `supersede`。没有记录 ⇒ `no_record`，不凭空造空壳（与 `supersede` 同）。
     *
     * <p>★ M2 增量：第二参数 `reason` **透传**给 `supersede`（默认 `'superseded'`，
     * 与既有行为逐字一致 —— 向后兼容）。多轮追发的优雅回退链（RFC-SESSION-RESUME-INTEGRATION
     * §4.2）用它携带 RFC 七指纹码（如 `ERR_WORKBUDDY_CDP_UNAVAILABLE`），让"这条记性为什么
     * 被作废"沿既有调用链可达；`supersede` 目前把 reason 视作文档性入参（记录形状不变），
     * 指纹码的落点是 run.js 回执的 `fallbackReason` 与日志。
     *
     * @param {string} key
     * @param {string} [reason] 稳定原因码（默认 'superseded'；非空字符串才透传）
     * @returns {{ ok: boolean, persistState: string, persistError: string }}
     */
    forget(key, reason = 'superseded') {
      return api.supersede(key, typeof reason === 'string' && reason !== '' ? reason : 'superseded');
    },

    /** 合并视图：settings 用户层（若有）+ 内存态（**内存优先 = 更新**）。 */
    list() {
      const merged = new Map();
      for (const [key, value] of Object.entries(persistedSessions())) merged.set(key, view(key, value));
      for (const [key, value] of memory) merged.set(key, view(key, value));
      return [...merged.values()];
    },

    /**
     * 落盘健康度（状态载荷/日志/测试用；失败必须可被看见）。
     * `lastError`/`lastFailure` = **最近一次失败**的留痕（成功不清除：有过失败本身就是要暴露的事实）。
     * 注意 `lastError` 在 `'noop'` 情形也会被写（"没有 settings 服务"、"净化后为空"同样要能被看见）。
     */
    persistence() {
      return { ...persistenceState };
    },

    /** 测试用：等所有在途写入收敛（真机上 = 下一次 onChange 之前）。 */
    async settled() {
      while (persistenceState.pending > 0) await new Promise((resolve) => setImmediate(resolve));
      return { ...persistenceState };
    },
  };

  return api;
}
