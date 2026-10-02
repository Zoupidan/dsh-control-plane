/**
 * 倍率条目归一化 —— ★ 原先放在 `packages/plugin-cli-core/src/cost/normalize.js`，2026-10-02
 *   随该包（CLI 方向）整体退役而内联到这里。
 *
 * <p>★ 为什么保留它、而不是重写一个 ★
 *   它承载的是"服务端的倍率字段怎么读"：同一个模型在不同来源下字段名/形态不同
 *   （`credits` 字符串 `"x0.16 credits"`、数字、`null`），归一化成 `{factor, source}`。
 *   这条口径一旦两处各写一份就会漂 —— 而倍率直接决定"选哪个模型最省"，漂了就是选错。
 *   所以搬过来，而不是另写。
 *
 * <p>★ 成本数据来自哪里 ★
 *   **全部来自 WorkBuddy 桌面端**，与 CLI 无关：倍率走
 *   `GET /v2/enterprises/personal/models`，积分走桌面端计费接口，二者都经 wbipc 只读通道
 *   以桌面端已登录身份读取。CLI 那条成本链路（读 CLI 跑出来的快照文件）已随 CLI 退役删除。
 *
 * @module host/launch/cost-model-info
 */
/** 倍率来源标记（原 cli-core/cost/rules.js）。值域随服务端，读取方按"取不到就是未知"处理。 */
/** @param {unknown} v @returns {string} */
function asString(v) {
  return typeof v === 'string' ? v : '';
}
export const COST_SOURCES = Object.freeze({
  DECLARED: 'declared',
  UNKNOWN: 'unknown',
});
export function normalizeModelCostInfo(raw, opts = {}) {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    throw new TypeError('cost: 条目必须是对象');
  }
  const rawRec = /** @type {Record<string, unknown>} */ (raw);
  const modelId = asString(rawRec.modelId).trim();
  const displayName = asString(rawRec.displayName).trim();
  if (!modelId) throw new TypeError('cost: modelId 为必填');
  if (!displayName) throw new TypeError('cost: displayName 为必填');

  const rawFactor = rawRec.factor;
  let factor = null;
  if (rawFactor !== null && rawFactor !== undefined) {
    if (typeof rawFactor !== 'number' || !Number.isFinite(rawFactor)) {
      throw new TypeError(`cost: factor 必须是有限数字或 null（收到 ${String(rawFactor)}）`);
    }
    factor = rawFactor; // 负数放行到 rules 层按未知归档 —— 数据错误不该在归一层悄悄改写
  }

  const rawSource = asString(rawRec.source);
  const source = /** @type {import('./types.js').ModelCostInfo['source']} */ (rawSource);
  if (!Object.values(COST_SOURCES).includes(source)) {
    throw new TypeError(`cost: source 取值域外（收到 ${rawSource || '（空）'}）`);
  }

  const sourceDetail = asString(rawRec.sourceDetail).trim();
  if (!sourceDetail) {
    throw new TypeError('cost: sourceDetail 为必填 —— UI 必须能展示这个数字哪来的（PRD §4.1）');
  }

  const rawWindow = rawRec.freeWindow;
  let freeWindow = null;
  if (rawWindow !== null && rawWindow !== undefined) {
    if (typeof rawWindow !== 'object') throw new TypeError('cost: freeWindow 必须是对象或 null');
    const w = /** @type {Record<string, unknown>} */ (rawWindow);
    const text = asString(w.text).trim();
    if (!text) throw new TypeError('cost: freeWindow.text 为必填（原文照抄，供 UI 展示）');
    const vu = asString(w.validUntil).trim();
    freeWindow = { text, validUntil: vu || null };
  }

  const observedAt = rawRec.observedAt;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  if (observedAt !== undefined && observedAt !== null && (typeof observedAt !== 'number' || !Number.isFinite(observedAt))) {
    throw new TypeError('cost: observedAt 必须是 epoch ms 数字');
  }

  return {
    modelId,
    displayName,
    factor,
    freeWindow,
    source,
    observedAt: typeof observedAt === 'number' ? observedAt : now,
    sourceDetail,
  };
}

/**
 * 归一整端成本快照（发布侧的最后一道闸）。
 * @param {unknown} raw
 * @param {{ now?: number }} [opts]
 * @returns {import('./types.js').CostSnapshot}
 * @throws {TypeError} target 缺失 / models 非数组 / unknown 形状不合法。
 */
export function normalizeCostSnapshot(raw, opts = {}) {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    throw new TypeError('cost: 快照必须是对象');
  }
  const rawRec = /** @type {Record<string, unknown>} */ (raw);
  const target = asString(rawRec.target).trim();
  if (!target) throw new TypeError('cost: target 为必填');

  if (!Array.isArray(rawRec.models)) throw new TypeError('cost: models 必须是数组（空数组 = 未知，不是省略）');
  const models = rawRec.models.map((m) => normalizeModelCostInfo(m, opts));

  const rawUnknown = rawRec.unknown;
  let unknown = null;
  if (rawUnknown !== null && rawUnknown !== undefined) {
    if (typeof rawUnknown !== 'object') throw new TypeError('cost: unknown 必须是对象或 null');
    const u = /** @type {Record<string, unknown>} */ (rawUnknown);
    const reason = asString(u.reason).trim();
    if (!reason) throw new TypeError('cost: unknown.reason 为必填（拿不到就说拿不到，且要说为什么）');
    if (!Array.isArray(u.attempted)) throw new TypeError('cost: unknown.attempted 必须是数组（A5：展示已尝试手段）');
    const suggestion = asString(u.suggestion).trim();
    unknown = { reason, attempted: u.attempted.map((a) => asString(a).trim()).filter((a) => a.length > 0), suggestion: suggestion || '' };
  }

  const observedAt = rawRec.observedAt;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  if (observedAt !== undefined && observedAt !== null && (typeof observedAt !== 'number' || !Number.isFinite(observedAt))) {
    throw new TypeError('cost: observedAt 必须是 epoch ms 数字');
  }
  let truncatedCount;
  if (rawRec.truncatedCount !== undefined && rawRec.truncatedCount !== null) {
    if (typeof rawRec.truncatedCount !== 'number' || !Number.isInteger(rawRec.truncatedCount) || rawRec.truncatedCount < 0) {
      throw new TypeError('cost: truncatedCount 必须是非负整数（缺省 = 未截断，不许塞别的东西）');
    }
    truncatedCount = rawRec.truncatedCount;
  }
  if (typeof rawRec.available !== 'boolean') {
    throw new TypeError('cost: available 为必填布尔 —— ① 硬闸（PRD §3）：关着的端不许进路由候选');
  }

  return {
    target,
    models,
    unknown,
    observedAt: typeof observedAt === 'number' ? observedAt : now,
    available: rawRec.available,
    ...(truncatedCount !== undefined ? { truncatedCount } : {}),
  };
}