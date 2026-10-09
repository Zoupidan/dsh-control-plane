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

/**
 * 每日签到（Buddy 加油站）的两个端点。同样不带 `/v2` —— 与上面三条同源。
 *
 * <p>★★ 来由 ★★：签到接口系公开仓库从桌面端逆向所得（`88lin/workbuddy-auto-signin`，
 * 直接 HTTPS 打 `https://copilot.tencent.com/v2/billing/meter/...`，Bearer 读本地登录态文件）。
 * 本插件**不走那条路**：凭据绝不进插件进程（红线 E3），而是复用 `wbipc` 的 `http.fetch`
 * —— 由已登录的桌面端代发，鉴权头由宿主填。真机实测（2026-10-09）：
 * `/billing/meter/checkin-activity-status` 经 wbipc 回 HTTP 200 + `data.today_checked_in` 等全字段；
 * `/billing/meter/daily-checkin` 在已签时回 HTTP 400 + `code:10001`（幂等，不会重复发放）。
 * 带 `/v2` 的写法经 wbipc 同样 200，但按本文件惯例统一用无前缀形。
 */
export const CHECKIN_PATHS = Object.freeze({
  status: '/billing/meter/checkin-activity-status',
  claim: '/billing/meter/daily-checkin',
});

/** 签到活动已结束 / 不在签到季 —— 正常状态，不是故障，不重试、不打扰。 */
export const CHECKIN_INACTIVE = 'checkin_inactive';
/** 今日已签（幂等）：领取接口的 `code:10001` 或文案含"已签"。 */
export const CHECKIN_ALREADY_CODE = 10001;

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

/**
 * 解析 `checkin-activity-status` 的响应（纯函数，零 I/O）。
 *
 * <p>真机形状（2026-10-09）：`{code:0, data:{active, today_checked_in, streak_days,
 * daily_credit, today_credit, total_credits, end_time, ...}}`。
 *
 * @param {object} payload 接口返回的 JSON
 * @returns {{ok: boolean, error: object|null, active: boolean|null,
 *   todayCheckedIn: boolean|null, streakDays: number|null, dailyCredit: number|null,
 *   todayCredit: number|null, totalCredits: number|null, endTime: string|null,
 *   at: number}|null}
 *   ★ 同 summarizeCredits 的三态纪律：`null` = 没拿到东西；`{ok:false}` = 拿到但报错/形状不对；
 *   只有 `{ok:true}` 才携带读数。**任何失败都不得被读成"今日未签"** —— 读不到就说读不到，
 *   绝不据此触发领取（领取的唯一依据是 `ok:true + todayCheckedIn:false`）。
 */
export function summarizeCheckin(payload) {
  if (payload === null || typeof payload !== 'object') return null;
  if (payload.code !== undefined && payload.code !== 0) {
    return {
      ok: false,
      error: { code: 'billing_error', message: `${payload.msg ?? 'unknown'}${payload.requestId === undefined ? '' : ` (requestId ${payload.requestId})`}` },
      active: null, todayCheckedIn: null, streakDays: null, dailyCredit: null,
      todayCredit: null, totalCredits: null, endTime: null, at: Date.now(),
    };
  }
  const data = payload.data;
  // ★ 数组不是对象：`data:[]` 这类形状必须走"形状不对"，不能当成"全字段缺失但成功"。
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: { code: 'unexpected_shape', message: 'the response carried no data object' }, active: null, todayCheckedIn: null, streakDays: null, dailyCredit: null, todayCredit: null, totalCredits: null, endTime: null, at: Date.now() };
  }
  const bool = (v) => (typeof v === 'boolean' ? v : null);
  const num = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };
  const str = (v) => (typeof v === 'string' && v !== '' ? v : null);
  return {
    ok: true,
    error: null,
    active: bool(data.active),
    todayCheckedIn: bool(data.today_checked_in),
    streakDays: num(data.streak_days),
    dailyCredit: num(data.daily_credit),
    todayCredit: num(data.today_credit),
    totalCredits: num(data.total_credits),
    endTime: str(data.end_time),
    at: Date.now(),
  };
}

/**
 * 归类 `daily-checkin` 的领取响应（纯函数，零 I/O）。
 *
 * <p>三种形态（真机 + 公开仓库交叉验证）：
 * <ul>
 *   <li>成功：`code:0`（`data.credit` 系实发积分，挖不到则为 null）；</li>
 *   <li>已签（幂等）：HTTP 400 + `code:10001`，或文案含"已签" —— **不是失败**；</li>
 *   <li>其他：失败，带回 `code/msg` 供上层如实显示。</li>
 * </ul>
 *
 * @param {number|null} statusCode wbipc 回的 HTTP 状态
 * @param {object|null} body 解析后的 JSON（wbipc 的 `json` 字段）
 * @returns {{outcome: 'claimed'|'already'|'failed', credit: number|null, message: string}}
 */
export function classifyClaim(statusCode, body) {
  const msg = body !== null && typeof body === 'object' ? String(body.msg ?? '') : '';
  const code = body !== null && typeof body === 'object' ? body.code : undefined;
  if (code === CHECKIN_ALREADY_CODE || msg.includes('已签')) {
    return { outcome: 'already', credit: null, message: msg === '' ? 'today already checked in' : msg };
  }
  if (code === 0 || code === undefined) {
    if (statusCode !== null && (statusCode < 200 || statusCode >= 300)) {
      return { outcome: 'failed', credit: null, message: msg === '' ? `unexpected status ${String(statusCode)}` : msg };
    }
    let credit = null;
    if (body !== null && typeof body === 'object') {
      const data = typeof body.data === 'object' && body.data !== null ? body.data : body;
      for (const k of ['credit', 'credits', 'today_credit']) {
        const v = data[k];
        if (typeof v === 'number' && Number.isFinite(v)) { credit = v; break; }
        if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) { credit = Number(v); break; }
      }
    }
    return { outcome: 'claimed', credit, message: msg === '' ? 'ok' : msg };
  }
  return { outcome: 'failed', credit: null, message: msg === '' ? `billing code ${String(code)}` : msg };
}
