/**
 * 积分余额的纯解析。零 I/O，可直接对真实响应体单测。
 *
 * <p>★★ 为什么值得单独抽一层 ★★
 *
 * <p>取积分要走 wbipc（一段带 HMAC 双向证明的私有协议）。**协议容易写错，解析也容易写错，
 * 而两者混在一起时，测解析就必须把协议也跑一遍** —— 于是解析的错会被协议层的噪声盖住。
 *
 * <p>真机上正是这么栽的：字段其实在 `data.Packages[]` 里，而第一版在顶层扫，
 * 扫到 `undefined` 还以为"没积分"。纯函数化之后，直接拿 `last-credits.json` 当夹具就能判对错。
 *
 * @module host/gateway/credits
 */

/** 计费相关的三个端点。★ 都不带 `/v2`（写了会被 404，这是核对出来的）。 */
export const BILLING_PATHS = Object.freeze({
  summary: '/billing/meter/get-user-resource-summary',
  freePackages: '/billing/meter/get-user-resource-free-packages',
  paidPackages: '/billing/meter/get-user-resource-paid-packages',
});

/** 平台奖励积分的包名特征：这类包没有 `SubscriptionPackageCode`，是当前账户的主要余额来源。 */
const PROMO_CODE = /^TCACA_/;

/**
 * 把一个 package 归一化成数字字段。
 *
 * <p>★★ **所有余额字段都是"字符串 + 8 位小数"**（`"479.13000076"`）。直接减会得到
 * `NaN`，先 `Number()` 再减才对。这一条踩过一次：字符串相减导致对账永远对不上，
 * 而页面看上去一切正常。
 *
 * @param {object} raw `data.Packages[]` 的一项
 * @returns {{code: string, unit: string|null, total: number, remain: number,
 *   used: number, frozen: number, count: number|null, promo: boolean} | null}
 */
export function normalizePackage(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const code = typeof raw.PackageCode === 'string' ? raw.PackageCode : null;
  if (code === null || code === '') return null;

  // ★ 字符串必转数字再参与运算。缺失/非数值统一记 0（宁可低估余额也不能 NaN）。
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const total = num(raw.CycleTotalCapacity);
  const remain = num(raw.CycleRemainCapacity);
  const used = num(raw.CycleUsedCapacity);

  return {
    code,
    unit: typeof raw.CapacityUnit === 'string' ? raw.CapacityUnit : null,
    total,
    remain,
    used,
    frozen: num(raw.CycleFrozenCapacity),
    count: Number.isInteger(raw.TotalCount) ? raw.TotalCount : null,
    promo: PROMO_CODE.test(code),
  };
}

/**
 * 解析 `get-user-resource-summary` 的响应。
 *
 * @param {object} payload 接口返回的 JSON
 * @returns {{ok: boolean, error: object|null, packages: object[],
 *   totalRemain: number, totalUsed: number, total: number, unit: string|null,
 *   isPaidUser: boolean|null, subscription: string|null,
 *   at: number}|null}
 *   ★ 三种返回要分清，**任何一种都不能变成"余额 0"**：
 *   `null` = 连对象都不是（根本没拿到东西）；`{ok:false, error}` = 拿到了但接口报错或形状不对；
 *   `{ok:true, totalRemain:0}` = **真的**零余额。只有第三种才该显示"0"。
 */
export function summarizeCredits(payload) {
  if (payload === null || typeof payload !== 'object') return null;
  // ★ `code !== 0` 是失败，绝不能当成"余额为 0"往上报 —— 那会让用户以为积分花光了。
  if (payload.code !== undefined && payload.code !== 0) {
    return {
      ok: false,
      error: { code: 'billing_error', message: `${payload.msg ?? 'unknown'}${payload.requestId === undefined ? '' : ` (requestId ${payload.requestId})`}` },
      packages: [], totalRemain: 0, totalUsed: 0, total: 0, unit: null,
      isPaidUser: null, subscription: null, at: Date.now(),
    };
  }
  const data = payload.data;
  if (data === null || typeof data !== 'object' || !Array.isArray(data.Packages)) {
    return { ok: false, error: { code: 'unexpected_shape', message: 'the response carried no data.Packages array' }, packages: [], totalRemain: 0, totalUsed: 0, total: 0, unit: null, isPaidUser: null, subscription: null, at: Date.now() };
  }

  const packages = data.Packages.map(normalizePackage).filter((p) => p !== null);
  const sum = (f) => packages.reduce((acc, p) => acc + p[f], 0);
  return {
    ok: true,
    error: null,
    packages,
    // ★ 总额按包相加。注意 `remain` 与 `total-used` 可能有分位差（接口是 8 位小数），
    //   所以以 remain 为准，total/used 只用于展示。
    totalRemain: sum('remain'),
    totalUsed: sum('used'),
    total: sum('total'),
    unit: packages.find((p) => p.unit !== null)?.unit ?? null,
    isPaidUser: typeof data.IsPaidUser === 'boolean' ? data.IsPaidUser : null,
    subscription: typeof data.SubscriptionPackageCode === 'string' ? data.SubscriptionPackageCode : null,
    at: Date.now(),
  };
}

/**
 * 按倍率估一次运行的消耗 —— **刻意不提供**。
 *
 * <p>记在这里以免后来者重写一遍：`session/new` 回的 `availableModels[]._meta.credits`
 * 形如 `x1.62`，看着像能乘出"这次要花多少"，但**乘不出来**。实测只有两个数据点：
 * kimi-k3-1（x1.62）跑一轮 6 字符的"完成"扣 0.30；hy3-x（x0.05）同样任务扣 0。
 * 一个数据点给不出消耗模型，低倍率又会被四舍五入抹平。
 *
 * <p>所以这里**不提供** `projectBalance()`。要判断"还够不够跑"，得先有真实的每任务成本
 * 采样（`consumed` 字段是有意义的实测值），那属于计费对账，是另一件事 ——
 * 别拿倍率当乘数糊一个看起来能用的数上去。
 */
