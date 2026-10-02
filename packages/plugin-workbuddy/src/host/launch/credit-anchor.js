/**
 * 积分锚点与扣减推算（★ 2026-09-27）。
 *
 * ## 为什么要这套东西
 * 平台**不提供可编程的余额读数**（取证见 `04-docs/RECON-CREDITS-QUOTA.md`：CLI 侧无余额端点；
 * 桌面端的会话材料要么加密、要么被运行中进程锁死；日志只记签到不记余额）。
 * 曾经走过的、**已被否决**的两条路都留了痕：
 *   ① 抽桌面端凭据 → 要么锁死要么解密，**且**一旦外泄不可撤回（2026-09-27 撤销，见 routes 删除记录）；
 *   ② 驱动浏览器读账号页 → 要给项目加最重的依赖（2026-09-27 主理人否决："不值得"）。
 * ⇒ 剩下的诚实做法：**主理人锚定一次，插件在其上做本地推算。**
 *
 * ## 三个硬纪律
 * 1. **锚点是唯一的事实。** 扣减是推算，不是读数；推算值必须永远带着"依据"一起出现。
 * 2. **未知不是 0。** 缺 token / 缺倍率 / 口径未验证 ⇒ 该项为 `null`，绝不折成 0。
 *    （0 会被读成"不花钱"，那是本仓反复踩的"静默缺席"家族。）
 * 3. **开启后锁定总额。** 主理人明令：enabled 为真期间不允许改锚点，只有关闭才能改。
 *    锁定用**快照 + 回退**实现，不是把输入框置灰——置灰是假开关，回退才是约束。
 *
 * 约束：本文件属于 packages/*​/src（CI ② 扫描面）—— 不得出现裸进程出口字样。
 */

/**
 * 换算口径。**★ 这里没有公式,而且是"被证伪"而不是"没查到"**（2026-09-27 标定）。
 *
 * 【实测·本机 315 条真实样本，全部同一模型 `glm-5.3-flash`，credit 合计 205.74】
 * 数据是真的：逐条记录带**厂商算好的** `credit`（0.15~2.82），来自主理人那次真实对话。
 *   - 单因子最小二乘 7 种口径：最佳是**常数项**，残留 15.9%；按 token 比例的最差 54.9%。
 *   - **决定性反证（比拟合残差更硬）**：同模型、同口径下，
 *     样本3（3,600 miss）= **52.8 分/百万 token**，样本4（29,276 miss）= **13.3 分/百万**，
 *     **差 4 倍** ⇒ credit 不可能是 (miss, out) 的稳定线性函数，一定还有别的变量。
 *   - 独立复核同结论：线性+保底模型解出 M≈0.137 / α≈0.0123 / β≈0.0466，
 *     代回样本4 得 0.51 vs 实测 0.39，**超估 31%**。
 *   - 目录里的 `x0.06` **不是 per-token 单价**：样本4 有 42,365 token，
 *     按 0.06/1k 应 ≈2.5 分，实测 0.39（**差 6 倍**）。它是**相对倍率**
 *     （存在 `x0.00` 免费模型；per-token 语义下会写 `0.00`）。
 *   - 官方文档**刻意不给换算表**（只说"与模型 Token 定价和任务复杂度有关"）；
 *     公开仓库在 cnb.cool 上**只有文档没有源码** ⇒ 拿不到 pricing 模块。
 *
 * 【结论】**本地重算 credit 不可靠。** 唯一权威值是上游响应里的那个 credit，
 * 而 `-p` 模式**既不吐它、也不落盘**（实测：result 帧 `total_cost_usd` 写死 0、usage 只有 token；
 * 桌面端起的对话才写 `~/projects/…/<id>.jsonl`）。⇒ 推算面一律回 `null`（未知）。
 *
 * 唯一可用的货币锚点：**1 积分 ≈ ¥0.05**（官方定价页 1,000 积分 = 50 元；2,000 = 100 元 印证）。
 *
 * 若将来要恢复推算，先做这两个判别实验：
 *   ① 同一 prompt 分别用 x0.06 与 x5.00 的模型跑，比 credit 比值：
 *      ≈83.3 ⇒ per-token 线性；显著偏离 ⇒ 按生成轮次/工具调用次数计。
 *   ② 令 cache_read=0 跑同样请求测 cache 单价；开/关 thinking 比 credit 测 reasoning 单价。
 */
export const BASIS = Object.freeze({
  formula: null,                    // ★ 没有公式。不是未验证，是已被 315 条真实样本证伪。
  perRequestFloor: 0.15,             // 实测地板（315 次的 min 恰为 0.15）；精确值与适用范围未知
  currencyAnchor: { credits: 1000, cny: 50, perCreditCny: 0.05, source: 'codebuddy.cn 定价页' },
  cacheFree: null,                   // 未能证实（2 点定 3 个未知数）
  reasoningPriced: null,             // 官方文档零提及
  source: 'acc-product-config-v3.json 的倍率串（**相对倍率**，非单价）',
  note: '本地重算不可靠 ⇒ 消耗一律报未知。积分以**主理人锚定的余额**为唯一事实；'
    + '两次读数之差 ÷ 运行次数 = 那段的真实每次消耗（无公式、无假设）。',
});

/** 倍率串 → 数值。取不到 ⇒ `null`（**不是 0**：0 倍是"免费"，取不到是"不知道"）。 */
export function parseMultiplier(detail) {
  if (typeof detail !== 'string') return null;
  const m = /^\s*x\s*([0-9]+(?:\.[0-9]+)?)/i.exec(detail);
  if (m === null) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * 一次运行的积分。
 *
 * ★ **只承认两种可判定的结论**：
 *   ① 0 倍 ⇒ 免费（`credits:0, free:true`）—— 这是倍率串里**直接写着**的事实；
 *   ② 其余一律 **未知**（`credits:null`）—— 因为本地无公式（见 BASIS 的证伪记录）。
 *   绝不返回"算出来的数"：那是一个自信的错数，比返回未知更坏。
 *
 * @param {{ tokens?: number|null, multiplier?: number|null }} input
 *   `multiplier` = 该模型的倍率（0 = 免费）；`tokens` 仅作**诊断留痕**，不参与任何计算。
 * @returns {{ credits: number|null, free: boolean|null, reason: string }}
 */
export function estimateRunCredits({ tokens, multiplier } = {}) {
  if (typeof multiplier !== 'number' || !Number.isFinite(multiplier)) {
    return { credits: null, free: null, reason: 'multiplier_unknown' };
  }
  if (multiplier === 0) {
    // 0 倍 = 免费。这是倍率串里的原文，不是推算。
    return { credits: 0, free: true, reason: 'free_model', tokensSeen: tokens ?? null };
  }
  // ★ 非免费：**没有公式**（BASIS 已记 315 条样本的证伪）⇒ 未知。
  return { credits: null, free: false, reason: 'no_client_formula', tokensSeen: tokens ?? null };
}

/**
 * 锚点快照：`enabled` 由 false→true 时调用。**快照是锁定的基准**，此后主理人的改动一律回退。
 * @returns {{ anchor: number, at: number }}
 */
export function takeSnapshot(anchor, at) {
  return { anchor: typeof anchor === 'number' && Number.isFinite(anchor) ? anchor : 0, at };
}

/**
 * 锁定期间的改动回退判定。
 *
 * @param {{ snapshot: {anchor:number,at:number}|null, currentAnchor: number, enabled: boolean }} input
 * @returns {{ locked: boolean, revert: boolean, why: string }}
 *   `revert: true` ⇒ 调用方应把 currentAnchor 写回 snapshot.anchor，**并记账**（不静默丢弃）。
 */
export function lockCheck({ snapshot, currentAnchor, enabled }) {
  if (enabled === false || snapshot === null) {
    return { locked: false, revert: false, why: 'unlocked' };
  }
  if (currentAnchor !== snapshot.anchor) {
    return { locked: true, revert: true, why: 'anchor_edited_while_enabled' };
  }
  return { locked: true, revert: false, why: 'locked' };
}

/**
 * 投影"还剩多少"。
 *
 * @param {{ snapshot: {anchor:number,at:number}|null, consumed: number, runs: number,
 *           now?: number, lastRunCredits?: number|null }} input
 * @returns {object} 形状（**每一项都自带依据**；推算项永远带 verified 标记）
 */
export function projectRemaining({ snapshot, consumed, runs, now = Date.now(), lastRunCredits = null }) {
  const known = snapshot !== null && typeof consumed === 'number' && Number.isFinite(consumed);
  const anchor = snapshot?.anchor ?? null;
  const remaining = known && typeof anchor === 'number' ? anchor - consumed : null;
  return {
    // 三态齐全：null = 未知（没有锚点 / 没有扣减数据），不是 0
    anchor,
    anchorAt: snapshot?.at ?? null,
    ageMs: snapshot === null ? null : Math.max(0, now - snapshot.at),
    consumed: known ? consumed : null,
    runs: typeof runs === 'number' ? runs : null,
    remaining,
    lastRunCredits,
    basis: { ...BASIS },
  };
}
