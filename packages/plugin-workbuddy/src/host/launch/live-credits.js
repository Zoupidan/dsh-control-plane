/**
 * 积分余额（★ 2026-09-28 取代 `credit-ledger.js`）—— **真值直读，不再由主理人手填**。
 *
 * <p>★★ 为什么整块换掉 ★★
 *
 * <p>老账本的全部机制（锚点快照 / 锁定 / 改值回退 / 重新锚定）都建立在一条前提上：
 * "平台不提供可编程的余额读数"。**这条前提今天被证伪了** —— wbipc 的 `http.fetch` 借桌面端的
 * 登录态就能只读地拿到 `get-user-resource-summary`（见 `host/gateway/wbipc.js`，真机 HTTP 200）。
 * 前提没了，整块机制就是纯负债：用户还得手填一个数字，插件再拿它本地推算，而推算早被
 * 315 条样本证伪（那份证伪记录留在 `credit-anchor.js` 里，不删 —— 它是"别再这么做"的依据）。
 *
 * <p>★★ 这个模块**只读**，不扣费 ★★
 *
 * <p>取余额用的是桌面端自己的登录态，插件既不持有 WorkBuddy 账号凭据，也无法借它发起
 * 任何写操作。所以"看一眼还剩多少"和"用 WorkBuddy 干活"是**两条互不影响的通路** ——
 * 这正是 `tools/run.js` 那条边界当初想守住的东西，现在用另一种方式守住了。
 *
 * <p>★ 余额的结算有延迟：实测跑完立刻读是旧值，60 s 后才是新值。**最短延迟未测**
 *   （`[推断]` 15–60 s）。所以本模块给的是**读数**，不是"刚跑完那次的账单"。
 *
 * @module host/launch/live-credits
 */

// ★ 静态导入（不是动态）：归因码必须和 wbipc 那边是**同一个常量**，
//   而它同时是下面 catch 分支能不能走到的前提 —— 早先把它做成动态导入、
//   以便测试注入的 `connect` 不拖进真模块，结果注入路径下 `wbipc` 是 null、
//   按码分流永远走不到，测试当场把那个设计缺陷照出来（红过一次）。
//   wbipc.js 只依赖 node 内置 + credits.js，代价可以接受。
import { connectWbipc, WBIPC_MISS } from '../gateway/wbipc.js';

/** 余额新鲜期：超过这个时间就后台重读（不阻塞状态路由）。 */
export const CREDITS_TTL_MS = 60_000;
/** 读数为什么拿不到 —— 直接透给用户看，不做成"余额 0"。 */
const REASONS = {
  /**
   * ★ 桌面端这一侧用不了，且**用户的下一步是同一个**：把 WorkBuddy 打开。
   *
   * <p>它涵盖两种真机实测到的形态（2026-09-29）：
   * <ul>
   *   <li>发现文件 `wbipc/endpoint.json` 读不到；</li>
   *   <li>文件在，但里面那个端点已经没了 —— 桌面退出时文件**不删**、重启时**滞后重写**，
   *       所以残留 endpoint 连出 `ENOENT`。旧实现把它归成 `transport`，用户看到的是
   *       `connect ENOENT \\.\pipe\wbipc-<id>`：黑话 + 一串没法解释的本机内部管道名。</li>
   * </ul>
   * 两者对用户是同一件可执行的事，所以并到同一个码，不去区分"文件没了"还是"端点没了"。
   */
  NO_DESKTOP: 'workbuddy_desktop_closed',
  SHAPE: 'unexpected_response',
  BILLING: 'billing_rejected',
};

let cached = null;   // { sum, at }
let inFlight = null; // 同一时刻只跑一次刷新

/**
 * @param {{ns: string, read: () => any, connect?: Function}} deps
 *   `connect` 注入点（默认 `connectWbipc`），测试里换成假实现。
 */
export function createLiveCredits({ ns, read, connect } = {}) {
  let svc = null;
  const counters = { runs: 0, freeRuns: 0, unknownRuns: 0, failedRuns: 0, lastRunAt: null };
  let lastError = null;

  function cfg() { return read() ?? {}; }

  function submit(patch) {
    if (svc === null || typeof svc?.update !== 'function') return;
    // ★ `settings.update` 是 **async**：下面这个 try/catch 只能抓同步抛出，**抓不到 reject**。
    //   `void` 掉一个会 reject 的 Promise 就是 unhandled rejection ⇒ 宿主直接退出。
    //   2026-09-28 真机踩过：`Config field "creditsRemain" is not volatile` 从这里出去，
    //   dsh 以退出码 1 结束。所以**两层都要**：
    //     ① 字段在 schema 里是 volatile（见 config/schema.js 的硬约束）；
    //     ② 这里无论成功失败都 settle，绝不把拒绝漏给宿主。
    //   失败对用户是可观测的（值没落盘 ⇒ 重启后显示 0/不可用），不需要额外出口。
    try {
      const p = svc.update(ns, patch);
      if (p !== null && typeof p?.then === 'function') void p.then(() => {}, () => {});
    } catch { /* 同步抛出同样只该丢缓存，不该阻塞读数 */ }
  }

  /**
   * 读一次真值。
   *
   * @returns {Promise<{ok: boolean, remain: number|null, at: number,
   *   packages: object[], error: {code: string, message: string}|null, unit: string|null,
   *   isPaidUser: boolean|null}>} **永不抛** —— 取不到就 `ok:false` + 原因码。
   */
  async function refresh() {
    if (inFlight !== null) return inFlight;
    inFlight = (async () => {
      const open = connect ?? connectWbipc;
      const { BILLING_PATHS, summarizeCredits } = await import('../gateway/credits.js');
      let s = null;
      try {
        s = await open();
        const r = await s.httpFetch({ path: BILLING_PATHS.summary, method: 'POST', json: {} });
        const sum = summarizeCredits(r.json);
        if (sum === null || sum.ok !== true) {
          lastError = {
            code: sum === null ? REASONS.SHAPE : (sum.error?.code === 'billing_error' ? REASONS.BILLING : REASONS.SHAPE),
            message: sum === null ? 'billing returned a response we do not recognise' : (sum.error?.message ?? 'unknown'),
          };
          return { ok: false, remain: null, at: Date.now(), packages: [], error: lastError, unit: null, isPaidUser: null };
        }
        lastError = null;
        cached = { sum, at: Date.now() };
        submit({ creditsRemain: sum.totalRemain, creditsAt: cached.at });
        return { ok: true, remain: sum.totalRemain, at: cached.at, packages: sum.packages, error: null, unit: sum.unit, isPaidUser: sum.isPaidUser };
      } catch (e) {
        // ★ 按**归因码**分流，不按文案。文案是给人看的，会被改；归因是结论。
        //   `ENDPOINT_GONE`（端点在、管道没了）与 `DESKTOP_CLOSED`（文件都读不到）
        //   对用户是**同一件可执行的事**：把 WorkBuddy 打开。所以两者并到同一个码，
        //   而不是让"连不上"掉进 `transport` 这种没人知道该怎么办的黑话里。
        const msg = e instanceof Error ? e.message : String(e);
        let code = 'transport';
        if (e?.code === WBIPC_MISS.ENDPOINT_GONE || e?.code === WBIPC_MISS.DESKTOP_CLOSED) {
          code = REASONS.NO_DESKTOP;
        } else if (/endpoint not found/i.test(msg)) {
          code = REASONS.NO_DESKTOP;   // 注入的 connect 抛普通 Error 时的兼容路径
        }
        lastError = { code, message: msg };
        return { ok: false, remain: null, at: Date.now(), packages: [], error: lastError, unit: null, isPaidUser: null };
      } finally {
        try { s?.close?.(); } catch { /* 忽略 */ }
        inFlight = null;
      }
    })();
    return inFlight;
  }

  /**
   * 给 UI 的投影。**同步**、不阻塞：拿缓存，没有就后台刷一次。
   *
   * ★ 三态要分清，绝不把"没读到"画成"0"：
   *   `source:'live'`  = 刚读到；`'snapshot'` = 读数过期（仍显示，但标 stale）；
   *   `'unavailable'` = 一次都没成功过。
   */
  function projection() {
    const age = cached === null ? null : Math.max(0, Date.now() - cached.at);
    const stale = age !== null && age > CREDITS_TTL_MS;
    if (cached === null || stale) void refresh();
    if (cached === null) {
      return {
        ok: false, source: 'unavailable', remain: null, at: null, ageMs: null, stale: true,
        unit: null, isPaidUser: null, packages: [], error: lastError, counters: { ...counters },
      };
    }
    return {
      ok: true, source: 'live', remain: cached.sum.totalRemain, at: cached.at, ageMs: age, stale,
      unit: cached.sum.unit, isPaidUser: cached.sum.isPaidUser, packages: cached.sum.packages,
      error: null, counters: { ...counters },
    };
  }

  /**
   * 记一次运行。**只数次数**——消耗额由平台结算，插件本地算不出来。
   * 旧账本曾在这里 `estimateRunCredits`，那已被证伪，现在只留事实计数。
   */
  function recordRun({ ok, multiplier = null } = {}) {
    if (ok !== true) { counters.failedRuns += 1; return { counted: false, reason: 'run_failed' }; }
    counters.runs += 1;
    counters.lastRunAt = Date.now();
    // x0.00 = 平台赠送（实测：跑完余额一位未动）
    if (multiplier === 0) counters.freeRuns += 1; else counters.unknownRuns += 1;
    submit({ creditsRuns: (cfg().creditsRuns ?? 0) + 1 });
    return { counted: false, free: multiplier === 0, reason: 'settlement_is_platform_side' };
  }

  return {
    attach: (s) => { svc = s; },
    projection, refresh, recordRun,
    /** 测试用：注入假读数。 */
    _seed: (sum, at = Date.now()) => { cached = { sum, at }; },
  };
}
