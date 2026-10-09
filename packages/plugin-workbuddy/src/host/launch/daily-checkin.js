/**
 * 每日签到自动领取（Buddy 加油站）—— **先查后领，领完复核，幂等**。
 *
 * <p>★★ 为什么是这个形状 ★★
 *
 * <p>接口知识复用公开仓库（`88lin/workbuddy-auto-signin` 的状态→领取→复核三段式、
 * `SIMON-WORLD/workbuddy-daily-credit` 的幂等口径：HTTP 400 + `code:10001` = 今日已签），
 * 但**传输面不抄**：公开仓库是直连 HTTPS + 自读登录态文件（插件进程持有账号凭据，
 * 本仓红线 E3 明令禁止）；这里复用 `wbipc` 的 `http.fetch` —— 由已登录的桌面端代发，
 * 插件既不读凭据文件、也不组装鉴权头（见 `host/gateway/wbipc.js` 头注）。
 * 真机双通路实测（2026-10-09）：状态 200 全字段、已签领取 400+10001，见 `CHECKIN_PATHS` 注释。
 *
 * <p>★★ 只动免费的每日签到 ★★
 *
 * <p>成长中心（旅行礼物/盲盒/补登/兑换）是另一套活动接口，各有各的领取次数与风控语义，
 * 不在本模块 scope。范围见 `claim()`：只调 `CHECKIN_PATHS.claim`，不碰任何其他写接口。
 *
 * <p>★ 与 `live-credits.js` 同款纪律：
 * <ul>
 *   <li>所有对外方法**永不抛** —— 拿不到就 `ok:false` + 原因码，绝不把"没读到"说成"今日未签"；</li>
 *   <li>落盘字段必须是 schema 里的 volatile（见 `config/schema.js` 硬约束），且落盘失败只丢缓存、
 *       绝不把拒绝漏给宿主（`void p.then(...)` 两边都 settle）；</li>
 *   <li>同一时刻只跑一次状态刷新、一次领取（in-flight 去重）；</li>
 *   <li>跨天按**北京时间**算（腾讯按北京时间记账，北京时间无夏令时，直接 +8 小时即可）。</li>
 * </ul>
 *
 * @module host/launch/daily-checkin
 */

import { connectWbipc, WBIPC_MISS } from '../gateway/wbipc.js';

/** 状态新鲜期：签到一天只变一次，10 分钟足够新鲜，又不会每个卡片打开都打一次 IPC。 */
export const CHECKIN_TTL_MS = 10 * 60_000;

const REASONS = {
  NO_DESKTOP: 'workbuddy_desktop_closed',
  SHAPE: 'unexpected_response',
  BILLING: 'billing_rejected',
};

/** 北京时间 discuter：腾讯按北京时间跨天记账（无夏令时，+8h 即全年正确）。 */
export function beijingDay(ts) {
  const t = typeof ts === 'number' && Number.isFinite(ts) ? ts : Date.now();
  return new Date(t + 8 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * @param {{ns: string, read: () => any, connect?: Function, onClaimed?: () => void}} deps
 *   `connect` 注入点（默认 `connectWbipc`），测试里换成假实现。
 *   `onClaimed` 领取成功后的回调（apply 里接成"刷新余额读数"，默认空操作）。
 */
export function createDailyCheckin({ ns, read, connect, onClaimed } = {}) {
  let svc = null;
  let cached = null; // { sum, at }
  let lastClaim = null; // { at, result, credit, streakDays }
  let statusFlight = null;
  let claimFlight = null;
  let lastError = null;
  const claimedCb = typeof onClaimed === 'function' ? onClaimed : () => {};

  function cfg() { return read() ?? {}; }

  /** 自动领取总闸：插件总开关开着 **且** 签到开关没被关掉（默认开，见 schema 注释）。 */
  function autoOn() {
    const c = cfg();
    return c.enabled === true && c.enableAutoCheckin !== false;
  }

  function submit(patch) {
    if (svc === null || typeof svc?.update !== 'function') return;
    // ★ 与 live-credits.js 同款：`settings.update` 是 async，同步抛与 reject 都只丢缓存。
    try {
      const p = svc.update(ns, patch);
      if (p !== null && typeof p?.then === 'function') void p.then(() => {}, () => {});
    } catch { /* 同步抛出同样只该丢缓存，不该阻塞读数 */ }
  }

  function persistClaim(entry) {
    lastClaim = entry;
    submit({
      checkinLastAt: entry.at,
      checkinLastResult: entry.result,
      checkinLastCredit: typeof entry.credit === 'number' ? entry.credit : 0,
      checkinStreakDays: typeof entry.streakDays === 'number' ? entry.streakDays : 0
    });
  }

  function errOf(e) {
    const msg = e instanceof Error ? e.message : String(e);
    let code = 'transport';
    if (e?.code === WBIPC_MISS.ENDPOINT_GONE || e?.code === WBIPC_MISS.DESKTOP_CLOSED) {
      code = REASONS.NO_DESKTOP;
    } else if (/endpoint not found/i.test(msg)) {
      code = REASONS.NO_DESKTOP;
    }
    return { code, message: msg };
  }

  /**
   * 只读查一次签到状态。**永不抛**。
   * @returns {Promise<{ok: boolean, sum: object|null, at: number, error: object|null}>}
   */
  async function status({ force = false } = {}) {
    if (statusFlight !== null) return statusFlight;
    if (force !== true && cached !== null && Date.now() - cached.at < CHECKIN_TTL_MS) {
      return { ok: true, sum: cached.sum, at: cached.at, error: null };
    }
    statusFlight = (async () => {
      const open = connect ?? connectWbipc;
      const { CHECKIN_PATHS, summarizeCheckin } = await import('../gateway/credits.js');
      let s = null;
      try {
        s = await open();
        const r = await s.httpFetch({ path: CHECKIN_PATHS.status, method: 'POST', json: {} });
        const sum = summarizeCheckin(r.json);
        if (sum === null || sum.ok !== true) {
          lastError = {
            code: sum === null ? REASONS.SHAPE : (sum.error?.code === 'billing_error' ? REASONS.BILLING : REASONS.SHAPE),
            message: sum === null ? 'checkin returned a response we do not recognise' : (sum.error?.message ?? 'unknown'),
          };
          return { ok: false, sum: null, at: Date.now(), error: lastError };
        }
        lastError = null;
        cached = { sum, at: Date.now() };
        return { ok: true, sum, at: cached.at, error: null };
      } catch (e) {
        lastError = errOf(e);
        return { ok: false, sum: null, at: Date.now(), error: lastError };
      } finally {
        try { s?.close?.(); } catch { /* 忽略 */ }
        statusFlight = null;
      }
    })();
    return statusFlight;
  }

  /**
   * 执行一次领取：先查 → 未签才领 → 领完复查。**永不抛，幂等**。
   * @returns {Promise<{result: string, credit: number|null, streakDays: number|null,
   *   at: number, error: object|null, verified: boolean}>}
   *   `result` ∈ `claimed | already | inactive | failed-query | failed-claim | failed-verify | unavailable`
   */
  async function claim() {
    if (claimFlight !== null) return claimFlight;
    claimFlight = (async () => {
      const open = connect ?? connectWbipc;
      const { CHECKIN_PATHS, summarizeCheckin, classifyClaim } = await import('../gateway/credits.js');
      const now = Date.now();
      const fail = (result, error) => {
        const entry = { at: now, result, credit: null, streakDays: cached?.sum?.streakDays ?? null };
        persistClaim(entry);
        return { ...entry, error: error ?? lastError, verified: false };
      };
      // ① 先查。
      const st = await status({ force: true });
      if (st.ok !== true || st.sum === null) return fail('failed-query', st.error);
      // ② 非活动季：正常状态，直接收尾（不重试、不打扰）。
      if (st.sum.active === false) {
        const entry = { at: now, result: 'inactive', credit: null, streakDays: st.sum.streakDays ?? null };
        persistClaim(entry);
        return { ...entry, error: null, verified: true };
      }
      // ③ 已签：幂等收尾（同样记一笔，供 UI 显示"今日已领"）。
      if (st.sum.todayCheckedIn === true) {
        const entry = { at: now, result: 'already', credit: st.sum.todayCredit ?? null, streakDays: st.sum.streakDays ?? null };
        persistClaim(entry);
        return { ...entry, error: null, verified: true };
      }
      // ④ 读不到明确状态（active/todayCheckedIn 任一未知）：**不领**。
      //   按"没读到"处理 —— 误领没有，但把未知当未签去领是拿不确定当依据。
      if (st.sum.todayCheckedIn !== false) return fail('failed-query', { code: 'unexpected_response', message: 'checkin status is unreadable, refusing to claim on an unknown state' });
      // ⑤ 领取（写操作**不**重试：超时可能落在服务端已处理之后，重试会变重复提交；
      //   领取接口本身幂等，但"已处理未返回"时重试仍是多余请求，能省则省）。
      let s = null;
      let cls;
      try {
        s = await open();
        const r = await s.httpFetch({ path: CHECKIN_PATHS.claim, method: 'POST', json: {} });
        cls = classifyClaim(r.status ?? null, r.json ?? null);
      } catch (e) {
        lastError = errOf(e);
        try { s?.close?.(); } catch { /* 忽略 */ }
        return fail('failed-claim', lastError);
      }
      try { s?.close?.(); } catch { /* 忽略 */ }
      if (cls.outcome === 'already') {
        const v = await status({ force: true });
        const entry = { at: Date.now(), result: 'already', credit: v.sum?.todayCredit ?? null, streakDays: v.sum?.streakDays ?? null };
        persistClaim(entry);
        return { ...entry, error: null, verified: v.ok === true };
      }
      if (cls.outcome !== 'claimed') {
        lastError = { code: 'billing_rejected', message: cls.message };
        return fail('failed-claim', lastError);
      }
      // ⑥ 复核：重查一次，`todayCheckedIn:true` 才是"真领到"。
      const v = await status({ force: true });
      if (v.ok === true && v.sum?.todayCheckedIn === true) {
        const entry = { at: Date.now(), result: 'claimed', credit: cls.credit ?? v.sum?.todayCredit ?? null, streakDays: v.sum?.streakDays ?? null };
        persistClaim(entry);
        lastError = null;
        try { claimedCb(); } catch { /* 回调不得带崩领取结论 */ }
        return { ...entry, error: null, verified: true };
      }
      lastError = { code: 'unexpected_response', message: 'claim returned ok but the re-check did not confirm it' };
      return fail('failed-verify', lastError);
    })();
    try {
      return await claimFlight;
    } finally {
      claimFlight = null;
    }
  }

  /**
   * 后台兜底：缓存过期/跨天（北京）时先重查；开着自动领取、活动进行中、今日未签 ⇒ 顺手领掉。
   * 只读失败、非活动季、已签 —— 全部静默收尾，不打扰。
   */
  function ensure() {
    void (async () => {
      try {
        const needStatus = cached === null
          || Date.now() - cached.at > CHECKIN_TTL_MS
          || beijingDay(cached.at) !== beijingDay(Date.now());
        // 今日已领过（以北京时间记）：连状态都不重查。
        if (lastClaim !== null && (lastClaim.result === 'claimed' || lastClaim.result === 'already')
          && beijingDay(lastClaim.at) === beijingDay(Date.now()) && needStatus === false) return;
        const st = await status({ force: needStatus });
        if (st.ok !== true || st.sum === null) return;
        if (autoOn() !== true) return;
        if (st.sum.active !== true) return;
        if (st.sum.todayCheckedIn !== false) {
          // 已签但本地没记：补记一笔，供 UI 显示。
          if (st.sum.todayCheckedIn === true
            && (lastClaim === null || beijingDay(lastClaim.at) !== beijingDay(Date.now()))) {
            persistClaim({ at: Date.now(), result: 'already', credit: st.sum.todayCredit ?? null, streakDays: st.sum.streakDays ?? null });
          }
          return;
        }
        // 今日已自动领过：不再重复调领取接口（幂等也不浪费这一次）。
        if (lastClaim !== null && (lastClaim.result === 'claimed' || lastClaim.result === 'already')
          && beijingDay(lastClaim.at) === beijingDay(Date.now())) return;
        await claim();
      } catch { /* 后台兜底永不抛 */ }
    })();
  }

  /**
   * 给 UI 的投影。**同步**、不阻塞：拿缓存，没有/过期就后台跑一次 `ensure()`。
   */
  function projection() {
    const age = cached === null ? null : Math.max(0, Date.now() - cached.at);
    const stale = age === null ? true : age > CHECKIN_TTL_MS;
    if (cached === null || stale
      || (lastClaim !== null && (lastClaim.result === 'claimed' || lastClaim.result === 'already')
        && beijingDay(lastClaim.at) !== beijingDay(Date.now()))) {
      ensure();
    } else if (cached !== null && autoOn() && cached.sum?.active === true && cached.sum?.todayCheckedIn === false) {
      ensure();
    }
    if (cached === null) {
      return {
        ok: false, source: 'unavailable', active: null, todayCheckedIn: null,
        streakDays: lastClaim?.streakDays ?? null, dailyCredit: null, todayCredit: null,
        totalCredits: null, endTime: null, autoEnabled: autoOn(),
        lastClaim: lastClaim === null ? null : { ...lastClaim },
        at: null, ageMs: null, stale: true, error: lastError,
      };
    }
    return {
      ok: true, source: 'live', active: cached.sum.active, todayCheckedIn: cached.sum.todayCheckedIn,
      streakDays: cached.sum.streakDays, dailyCredit: cached.sum.dailyCredit,
      todayCredit: cached.sum.todayCredit, totalCredits: cached.sum.totalCredits,
      endTime: cached.sum.endTime, autoEnabled: autoOn(),
      lastClaim: lastClaim === null ? null : { ...lastClaim },
      at: cached.at, ageMs: age, stale,
      error: null,
    };
  }

  return {
    attach: (s) => { svc = s; },
    projection, status, claim, ensure,
    /** 测试用：注入假状态。 */
    _seed: (sum, at = Date.now()) => { cached = { sum, at }; },
    /** 测试用：注入上次领取记录。 */
    _seedClaim: (entry) => { lastClaim = entry; },
    _reset: () => { cached = null; lastClaim = null; lastError = null; },
  };
}
