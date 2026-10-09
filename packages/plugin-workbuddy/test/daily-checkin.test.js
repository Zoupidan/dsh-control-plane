/**
 * 每日签到自动领取（Buddy 加油站）—— 解析 + 服务单测。
 *
 * 夹具按真机响应重建（2026-10-09，经 wbipc 实测）：
 *   状态 `POST /billing/meter/checkin-activity-status` → 200 + `data.{active,
 *   today_checked_in, streak_days, daily_credit, today_credit, total_credits, end_time}`；
 *   已签时领取 `POST /billing/meter/daily-checkin` → 400 + `{code:10001}`（幂等，不多发）。
 * `requestId` 已隐去（真机每次不同，无断言价值）。
 *
 * 约束：全程假 `connect` / 假 settings，绝不碰真桌面端与真 `~/.workbuddy`
 * （`test-home-guard` 另有一层护栏；本文件自己也不读任何真实路径）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BILLING_PATHS,
  CHECKIN_PATHS,
  CHECKIN_ALREADY_CODE,
  summarizeCheckin,
  classifyClaim,
} from '../src/host/gateway/credits.js';
import { createDailyCheckin, beijingDay, CHECKIN_TTL_MS } from '../src/host/launch/daily-checkin.js';
import { Config } from '../src/host/config/schema.js';

/** 真机状态形状（数值保留实测值，`requestId` 隐去）。 */
const REAL_STATUS = {
  code: 0,
  msg: 'OK',
  requestId: 'fixture',
  data: {
    active: true,
    today_checked_in: true,
    streak_days: 2,
    daily_credit: 100,
    today_credit: 100,
    is_streak_day: false,
    next_streak_day: 0,
    streak_bonus_days: 0,
    streak_bonus_credit: 0,
    checkin_dates: ['2026-10-09', '2026-10-08'],
    week_checkin_days: 2,
    total_credits: 200,
    start_time: '2026-09-30 00:00:00',
    end_time: '2026-10-15 23:59:59',
    theme_name: 'Buddy加油站',
    season: 10,
  },
};

/** 未签形态：把上面那份的今日标记翻过来（服务端字段名不变，只改值）。 */
const UNCLAIMED_STATUS = {
  code: 0,
  msg: 'OK',
  data: { ...REAL_STATUS.data, today_checked_in: false, streak_days: 1, today_credit: 0, total_credits: 100 },
};

/** 按剧本应答的假 wbipc：`script` 是 path 后缀 → 响应体的映射（函数可按调用次序变招）。 */
function fakeConnect(script, calls = []) {
  return async () => ({
    httpFetch: async ({ path, method, json }) => {
      calls.push({ path, method, json });
      const hit = Object.entries(script).find(([suffix]) => path.endsWith(suffix));
      if (hit === undefined) throw new Error(`unexpected path ${path}`);
      const body = typeof hit[1] === 'function' ? hit[1](calls.length) : hit[1];
      return { status: body.__status ?? 200, json: body.__json ?? body, text: null };
    },
    close: () => {},
  });
}

function okStatus(body) {
  return { __status: 200, __json: body };
}

/** 收集 `settings.update` 调用的假宿主（只收 volatile 键，照抄宿主判据）。 */
function fakeSettings() {
  const calls = [];
  return {
    calls,
    update(ns, patch) {
      for (const key of Object.keys(patch ?? {})) {
        const field = Config.dict[key];
        if (field === undefined || field.meta?.volatile !== true) {
          return Promise.reject(new Error(`Config field "${key}" is not volatile`));
        }
      }
      calls.push({ ns, patch });
      return Promise.resolve();
    },
  };
}

const claimedCfg = () => ({ enabled: true, enableAutoCheckin: true, creditsRuns: 0 });

// ───────────────────────── 解析层 ─────────────────────────

test('签到端点同样不带 /v2（与 BILLING_PATHS 同源惯例）', () => {
  assert.equal(CHECKIN_PATHS.status, '/billing/meter/checkin-activity-status');
  assert.equal(CHECKIN_PATHS.claim, '/billing/meter/daily-checkin');
  for (const p of Object.values(CHECKIN_PATHS)) assert.ok(!p.includes('/v2'), `★ ${p} 不该带 /v2`);
  assert.equal(CHECKIN_ALREADY_CODE, 10001);
  assert.ok(!Object.values(BILLING_PATHS).includes(CHECKIN_PATHS.status), '签到与余额是两组端点，不复用');
});

test('★ 真实状态能解出签到结论（数值保留实测值）', () => {
  const r = summarizeCheckin(REAL_STATUS);
  assert.equal(r.ok, true);
  assert.equal(r.active, true);
  assert.equal(r.todayCheckedIn, true);
  assert.equal(r.streakDays, 2);
  assert.equal(r.dailyCredit, 100);
  assert.equal(r.todayCredit, 100);
  assert.equal(r.totalCredits, 200);
  assert.equal(r.endTime, '2026-10-15 23:59:59');
});

test('★ 失败与怪形状绝不能被读成"今日未签"', () => {
  assert.equal(summarizeCheckin(null), null, '连对象都不是 ⇒ null');
  assert.equal(summarizeCheckin('x'), null);
  const billed = summarizeCheckin({ code: 401, msg: 'unauthorized', requestId: 'r-1', data: null });
  assert.equal(billed.ok, false);
  assert.equal(billed.error.code, 'billing_error');
  assert.equal(billed.todayCheckedIn, null, '★ 失败时今日状态是未知，不是 false');
  for (const p of [{}, { code: 0 }, { code: 0, data: null }, { code: 0, data: [] }]) {
    const r = summarizeCheckin(p);
    assert.equal(r.ok, false, JSON.stringify(p));
    assert.equal(r.error.code, 'unexpected_shape', JSON.stringify(p));
  }
  // 字段缺失 ⇒ null（未知），不猜 true/false。
  const thin = summarizeCheckin({ code: 0, data: {} });
  assert.equal(thin.ok, true);
  assert.equal(thin.active, null);
  assert.equal(thin.todayCheckedIn, null);
  assert.equal(thin.streakDays, null);
});

test('★ 领取归类：400+10001 是"已签"（幂等），不是失败', () => {
  const already = classifyClaim(400, { code: 10001, msg: '今天已签到，请明天再来' });
  assert.equal(already.outcome, 'already');
  const alreadyByMsg = classifyClaim(400, { code: 99999, msg: '今天已签到' });
  assert.equal(alreadyByMsg.outcome, 'already', '★ 只看文案里的"已签"同样算已签（兼容服务端改码）');
  const ok = classifyClaim(200, { code: 0, msg: 'OK', data: { credit: 100 } });
  assert.equal(ok.outcome, 'claimed');
  assert.equal(ok.credit, 100);
  const okNoCredit = classifyClaim(200, { code: 0 });
  assert.equal(okNoCredit.outcome, 'claimed');
  assert.equal(okNoCredit.credit, null, '★ 实发数挖不到就是 null，不编一个');
  const failed = classifyClaim(200, { code: 40001, msg: 'nope' });
  assert.equal(failed.outcome, 'failed');
  const badStatus = classifyClaim(500, { code: 0 });
  assert.equal(badStatus.outcome, 'failed', '★ 业务码 0 但 HTTP 非 2xx ⇒ 失败（不把传输失败当领到）');
});

test('★ 北京时间跨天：腾讯按北京时间记账（无夏令时，+8h 全年正确）', () => {
  // 2026-10-09 00:30 +08:00 = 2026-10-08 16:30Z —— UTC 日期是 8 号，北京是 9 号。
  const ts = Date.parse('2026-10-08T16:30:00Z');
  assert.equal(beijingDay(ts), '2026-10-09');
  assert.equal(beijingDay(ts - 3_600_000), '2026-10-08', '★ 前一小时还是 8 号（边界敏感）');
  assert.match(beijingDay(Date.now()), /^\d{4}-\d{2}-\d{2}$/);
});

// ───────────────────────── 服务层 ─────────────────────────

test('★ 落盘键一律是 volatile（否则宿主拒绝并打死 dsh，见 settings-contract 事故）', () => {
  for (const key of ['checkinLastAt', 'checkinLastResult', 'checkinLastCredit', 'checkinStreakDays', 'enableAutoCheckin']) {
    const field = Config.dict[key];
    assert.notEqual(field, undefined, `${key} 必须存在于 Config`);
    assert.equal(field.meta?.volatile, true, `${key} 经 settings.update 落盘，非 volatile 会打死宿主`);
  }
});

test('status()：读一次真值并缓存，TTL 内不再打 IPC', async () => {
  const calls = [];
  const svc = fakeSettings();
  const checkin = createDailyCheckin({
    ns: 'dsh-plugin-workbuddy', read: claimedCfg,
    connect: fakeConnect({ 'checkin-activity-status': okStatus(REAL_STATUS) }, calls),
  });
  checkin.attach(svc);
  const a = await checkin.status();
  assert.equal(a.ok, true);
  assert.equal(a.sum.todayCheckedIn, true);
  assert.equal(calls.length, 1);
  const b = await checkin.status();
  assert.equal(b.ok, true);
  assert.equal(calls.length, 1, '★ TTL 内命中缓存，不再打 IPC');
  const c = await checkin.status({ force: true });
  assert.equal(calls.length, 2, '★ force 绕过缓存');
});

test('status()：桌面端没开 ⇒ ok:false + 可执行的原因码（不抛）', async () => {
  const err = new Error('wbipc endpoint not found — is the WorkBuddy desktop running?');
  err.code = 'wbipc_desktop_closed';
  const checkin = createDailyCheckin({ ns: 'dsh-plugin-workbuddy', read: claimedCfg, connect: async () => { throw err; } });
  checkin.attach(fakeSettings());
  const r = await checkin.status({ force: true });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'workbuddy_desktop_closed');
  const p = checkin.projection();
  assert.equal(p.ok, false);
  assert.equal(p.source, 'unavailable');
  assert.equal(p.todayCheckedIn, null, '★ 读不到就说读不到，不猜未签');
});

test('claim()：先查→未签才领→领完复核，全程落盘且只调一次领取接口', async () => {
  const calls = [];
  let n = 0;
  const svc = fakeSettings();
  let claimedCb = 0;
  const checkin = createDailyCheckin({
    ns: 'dsh-plugin-workbuddy', read: claimedCfg,
    connect: fakeConnect({
      'checkin-activity-status': () => { n += 1; return okStatus(n === 1 ? UNCLAIMED_STATUS : REAL_STATUS); },
      'daily-checkin': okStatus({ code: 0, msg: 'OK', data: { credit: 100 } }),
    }, calls),
    onClaimed: () => { claimedCb += 1; },
  });
  checkin.attach(svc);
  const r = await checkin.claim();
  assert.equal(r.result, 'claimed');
  assert.equal(r.verified, true);
  assert.equal(r.credit, 100);
  assert.equal(r.streakDays, 2, '★ 连签天数以复核为准，不以领取响应为准');
  assert.equal(claimedCb, 1, '★ 领到才回调（刷新余额），别的情况不刷');
  assert.equal(calls.filter((c) => c.path.endsWith('daily-checkin')).length, 1, '★ 领取接口恰好调一次');
  const written = Object.assign({}, ...svc.calls.map((c) => c.patch));
  assert.equal(written.checkinLastResult, 'claimed');
  assert.equal(written.checkinLastCredit, 100);
  assert.equal(written.checkinStreakDays, 2);
  assert.ok(typeof written.checkinLastAt === 'number' && written.checkinLastAt > 0);
});

test('claim()：已签 ⇒ 直接收尾，一次领取接口都不碰', async () => {
  const calls = [];
  const checkin = createDailyCheckin({
    ns: 'dsh-plugin-workbuddy', read: claimedCfg,
    connect: fakeConnect({ 'checkin-activity-status': okStatus(REAL_STATUS) }, calls),
  });
  checkin.attach(fakeSettings());
  const r = await checkin.claim();
  assert.equal(r.result, 'already');
  assert.equal(r.verified, true);
  assert.ok(!calls.some((c) => c.path.endsWith('daily-checkin')), '★ 已签时领取接口零调用');
});

test('claim()：非活动季 ⇒ inactive（正常状态，不重试、不算失败）', async () => {
  const calls = [];
  const checkin = createDailyCheckin({
    ns: 'dsh-plugin-workbuddy', read: claimedCfg,
    connect: fakeConnect({
      'checkin-activity-status': okStatus({ code: 0, data: { ...REAL_STATUS.data, active: false } }),
    }, calls),
  });
  checkin.attach(fakeSettings());
  const r = await checkin.claim();
  assert.equal(r.result, 'inactive');
  assert.ok(!calls.some((c) => c.path.endsWith('daily-checkin')), '★ 非活动季不调领取接口');
});

test('claim()：状态未知（字段缺失）⇒ 不领（拿不确定当依据去领是错的）', async () => {
  const calls = [];
  const checkin = createDailyCheckin({
    ns: 'dsh-plugin-workbuddy', read: claimedCfg,
    connect: fakeConnect({ 'checkin-activity-status': okStatus({ code: 0, data: {} }) }, calls),
  });
  checkin.attach(fakeSettings());
  const r = await checkin.claim();
  assert.equal(r.result, 'failed-query');
  assert.ok(!calls.some((c) => c.path.endsWith('daily-checkin')), '★ 状态未知时领取接口零调用');
});

test('claim()：领取回 400+10001（竞态：两端同时签）⇒ already（复核确认）', async () => {
  const calls = [];
  // 第一次状态查询（领前）返回未签，复核查询返回已签。
  let statusCalls = 0;
  const checkin = createDailyCheckin({
    ns: 'dsh-plugin-workbuddy', read: claimedCfg,
    connect: fakeConnect({
      'checkin-activity-status': () => { statusCalls += 1; return okStatus(statusCalls === 1 ? UNCLAIMED_STATUS : REAL_STATUS); },
      'daily-checkin': { __status: 400, __json: { code: 10001, msg: '今天已签到，请明天再来' } },
    }, calls),
  });
  checkin.attach(fakeSettings());
  const r = await checkin.claim();
  assert.equal(r.result, 'already');
  assert.equal(r.verified, true);
});

test('★ 总闸：插件关着（enabled=false）⇒ 后台一次都不跑', async () => {
  const calls = [];
  const checkin = createDailyCheckin({
    ns: 'dsh-plugin-workbuddy', read: () => ({ enabled: false, enableAutoCheckin: true }),
    connect: fakeConnect({ 'checkin-activity-status': okStatus(UNCLAIMED_STATUS) }, calls),
  });
  checkin.attach(fakeSettings());
  checkin.projection();
  checkin.ensure();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.ok(!calls.some((c) => c.path.endsWith('daily-checkin')), '★ OFF 时领取接口零调用（①硬闸优先）');
});

test('★ 签到开关关掉 ⇒ 后台不领（只读状态可以，领取不行）', async () => {
  const calls = [];
  const checkin = createDailyCheckin({
    ns: 'dsh-plugin-workbuddy', read: () => ({ enabled: true, enableAutoCheckin: false }),
    connect: fakeConnect({ 'checkin-activity-status': okStatus(UNCLAIMED_STATUS) }, calls),
  });
  checkin.attach(fakeSettings());
  checkin.projection();
  checkin.ensure();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.ok(!calls.some((c) => c.path.endsWith('daily-checkin')), '★ 开关关掉后领取接口零调用');
});

test('★ 同一天已领过 ⇒ 后台不再调领取接口（幂等也不浪费这一次）', async () => {
  const calls = [];
  const checkin = createDailyCheckin({
    ns: 'dsh-plugin-workbuddy', read: claimedCfg,
    connect: fakeConnect({ 'checkin-activity-status': okStatus(REAL_STATUS) }, calls),
  });
  checkin.attach(fakeSettings());
  checkin._seedClaim({ at: Date.now(), result: 'claimed', credit: 100, streakDays: 2 });
  checkin.projection();
  checkin.ensure();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.ok(!calls.some((c) => c.path.endsWith('daily-checkin')), '★ 北京当天已领 ⇒ 领取接口零调用');
});

test('★ 落盘失败不得变成 unhandled rejection（显示缓存没有杀宿主的权力）', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const svc = { update: () => Promise.reject(new Error('Config field "x" is not volatile')) };
    const checkin = createDailyCheckin({
      ns: 'dsh-plugin-workbuddy', read: claimedCfg,
      connect: fakeConnect({
        'checkin-activity-status': okStatus(UNCLAIMED_STATUS),
        'daily-checkin': okStatus({ code: 0, data: { credit: 100 } }),
      }),
    });
    checkin.attach(svc);
    // 复核同样走 UNCLAIMED→ 需要第三次状态：让后续状态查询返回已签。
    const r = await checkin.claim();
    assert.ok(typeof r.result === 'string', '拒绝下结论仍有结论');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(unhandled.map(String), [], '拒绝泄漏成了 unhandled rejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('★ 同步抛出的 update 也不得冒泡', async () => {
  const checkin = createDailyCheckin({
    ns: 'dsh-plugin-workbuddy', read: claimedCfg,
    connect: fakeConnect({ 'checkin-activity-status': okStatus(REAL_STATUS) }),
  });
  checkin.attach({ update: () => { throw new Error('boom'); } });
  await assert.doesNotReject(() => checkin.status({ force: true }));
  assert.doesNotThrow(() => checkin.projection());
});

test(`CHECKIN_TTL_MS 为正整数（当前 ${CHECKIN_TTL_MS}ms，状态路由靠它限流）`, () => {
  assert.ok(Number.isInteger(CHECKIN_TTL_MS) && CHECKIN_TTL_MS > 0);
});
