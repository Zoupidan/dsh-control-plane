// 纯解析层。夹具是**按真机响应重建的**，不是抓包原件 —— 见下方说明。
import assert from 'node:assert/strict';
import test from 'node:test';

import { BILLING_PATHS, normalizePackage, summarizeCredits } from '../src/host/gateway/credits.js';
import { parseMultiplier } from '../src/host/gateway/receipt.js';

/**
 * 夹具 = `get-user-resource-summary` 的响应形状 + **真机当时的数值**。
 *
 * ★ 为什么它不再是"抓包原件"：原来这个夹具是 `tools/recon/last-credits.json` 的副本。
 *   那是**探索期**的产物，在 `tools/recon/` 连同其他 45 个探针脚本一起被清掉了，
 *   而它**从未进过版本库**（不可恢复）。让单测去读一个探索目录，等于把
 *   "项目自洽"挂在"我还没删干净"上 —— 正是 2026-09-28 要清掉的那类耦合。
 *
 * ★ 所以夹具内联进本文件，并且**保留真机数值**（下面的断言逐条对得上）：
 *   平台奖励包 1605 总量 / 479.13000076 余额 / 15 次计数，第二个包 500 总量、余额已用尽，
 *   非付费用户，单位 credits。这些是实测值；**包名以外的结构按 credits.js 的读法补全**。
 *   要拿新的原件，替换这个对象即可，断言不用动。
 */
const REAL = {
  code: 0,
  msg: 'success',
  requestId: 'reconstructed-fixture',
  data: {
    IsPaidUser: false,
    Packages: [
      {
        // 平台奖励包（PROMO_CODE = /^TCACA_/）
        PackageCode: 'TCACA_code_007_nzdH5h4Nl0',
        CapacityUnit: 'credits',
        CycleTotalCapacity: '1605',
        CycleRemainCapacity: '479.13000076',
        CycleUsedCapacity: '1125.86999924',
        CycleFrozenCapacity: '0',
        TotalCount: 15,
      },
      {
        // 第二个包：余额已用尽（totalRemain 不受它影响，total 会计入它）
        PackageCode: 'SUBSCRIPTION_code_001',
        CapacityUnit: 'credits',
        CycleTotalCapacity: '500',
        CycleRemainCapacity: '0',
        CycleUsedCapacity: '500',
        CycleFrozenCapacity: '0',
      },
    ],
  },
};

test('★ 真实响应能解出余额（夹具保留真机数值，结构按解析器读法重建）', () => {
  const r = summarizeCredits(REAL);
  assert.equal(r.ok, true);
  assert.equal(r.packages.length, 2);
  // 真机数值：平台奖励包 1605 总量 / 479.13000076 余额
  const promo = r.packages.find((p) => p.promo);
  assert.equal(promo.code, 'TCACA_code_007_nzdH5h4Nl0');
  assert.equal(promo.total, 1605);
  assert.equal(promo.remain, 479.13000076);
  assert.equal(promo.used, 1125.86999924);
  assert.equal(promo.frozen, 0);
  assert.equal(promo.count, 15);
  assert.equal(r.totalRemain, 479.13000076, '第二个包余额为 0，不影响合计');
  assert.equal(r.total, 2105);
  assert.equal(r.unit, 'credits');
  assert.equal(r.isPaidUser, false);
});

test('★★ 余额字段是字符串，必须先 Number()（直接减会 NaN）', () => {
  // 这一条踩过：字符串相减导致对账永远对不上，页面看上去一切正常。
  const raw = { PackageCode: 'X', CycleTotalCapacity: '100', CycleRemainCapacity: '33.33000033', CycleUsedCapacity: '66.66999967' };
  const p = normalizePackage(raw);
  assert.equal(typeof p.remain, 'number');
  assert.equal(p.remain, 33.33000033);
  assert.equal(p.used, 66.66999967);
  assert.ok(Number.isFinite(p.remain + p.used), '★ 参与运算前不能是字符串');
  assert.equal(Math.round((p.remain + p.used) * 1e8) / 1e8, 100, '8 位小数下两段之和应还原总量');
});

test('★ 缺字段/脏字段按 0 记，不产生 NaN（宁可低估也不能 NaN）', () => {
  const p = normalizePackage({ PackageCode: 'X' });
  assert.deepEqual([p.total, p.remain, p.used, p.frozen], [0, 0, 0, 0]);
  const q = normalizePackage({ PackageCode: 'Y', CycleRemainCapacity: 'abc', TotalCount: 1.5 });
  assert.equal(q.remain, 0);
  assert.equal(q.count, null, '非整数计数记 null 而不是 1.5');
  assert.equal(normalizePackage({ CycleRemainCapacity: '5' }), null, '★ 没有 PackageCode 直接丢弃');
  assert.equal(normalizePackage(null), null);
  assert.equal(normalizePackage('nope'), null);
});

test('★ code !== 0 是失败，绝不能当成"余额 0"上报', () => {
  const r = summarizeCredits({ code: 401, msg: 'unauthorized', requestId: 'r-1', data: null });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'billing_error');
  assert.match(r.error.message, /unauthorized/);
  assert.match(r.error.message, /r-1/, '★ 带 requestId 才好让用户去查');
  assert.deepEqual(r.packages, []);
});

test('★ 形状不认识 ⇒ 绝不返回"余额 0"', () => {
  // 第一版就在顶层扫字段，扫到 undefined 还以为"没积分" —— 那会把故障说成余额为零。
  assert.equal(summarizeCredits(null), null, '连对象都不是 ⇒ null');
  assert.equal(summarizeCredits('x'), null);
  // 拿到了响应但里面没 data ⇒ 明确说形状不对，不是零余额
  for (const p of [{}, { code: 0 }, { code: 0, data: {} }, { code: 0, data: { Packages: 'nope' } }]) {
    const r = summarizeCredits(p);
    assert.equal(r.ok, false, JSON.stringify(p));
    assert.equal(r.error.code, 'unexpected_shape', JSON.stringify(p));
  }
  const zero = summarizeCredits({ code: 0, data: { Packages: [] } });
  assert.equal(zero.ok, true);
  assert.equal(zero.totalRemain, 0, '★ 真的空数组才是合法的零余额');
});

test('非法项被跳过，不让一个脏包毁掉整份余额', () => {
  const r = summarizeCredits({
    code: 0,
    data: { Packages: [null, 'x', { PackageCode: 'GOOD', CycleRemainCapacity: '12' }, { CycleRemainCapacity: '9' }] },
  });
  assert.equal(r.packages.length, 1);
  assert.equal(r.totalRemain, 12);
});

test('三个计费端点都不带 /v2（写了会 404）', () => {
  assert.equal(BILLING_PATHS.summary, '/billing/meter/get-user-resource-summary');
  for (const p of Object.values(BILLING_PATHS)) assert.ok(!p.includes('/v2'), `★ ${p} 不该带 /v2`);
});

test('倍率解析与 credits 共用同一份实现（避免两处正则漂移）', () => {
  assert.equal(parseMultiplier('x1.62'), 1.62);
  assert.equal(parseMultiplier('x0.05'), 0.05);
  assert.equal(parseMultiplier('x0.00'), 0);
});
