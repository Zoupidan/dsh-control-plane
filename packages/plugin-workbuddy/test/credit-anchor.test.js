// 积分锚点判据：锁定、扣减、依据标注、三态。
// 纯函数，不落盘、不联网、不启动进程。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BASIS, estimateRunCredits, lockCheck, parseMultiplier, projectRemaining, takeSnapshot,
} from '../src/host/launch/credit-anchor.js';

test('倍率串解析：取不到 ⇒ null（★ 不是 0）', () => {
  assert.equal(parseMultiplier('x0.06 credits'), 0.06);
  assert.equal(parseMultiplier('x0.00 credits'), 0, '0 倍是"免费"，必须解析成 0 而不是 null');
  assert.equal(parseMultiplier('X5.00 credits'), 5);
  assert.equal(parseMultiplier(''), null);
  assert.equal(parseMultiplier('见说明'), null);
  assert.equal(parseMultiplier(null), null);
  assert.equal(parseMultiplier(undefined), null);
});

test('一次运行的推算：缺输入 ⇒ null（★ 未知不折成 0）', () => {
  // 0 倍 = 免费：倍率串里**直接写着**的事实，可判定
  assert.equal(estimateRunCredits({ tokens: 1000, multiplier: 0 }).free, true);
  // 其余：315 条真实样本已证伪任何单因子公式（BASIS 有完整记录）⇒ 未知
  const paid = estimateRunCredits({ tokens: 50000, multiplier: 0.06 });
  assert.equal(paid.credits, null, '★ 没有公式 ⇒ 未知，绝不返回一个算出来的数');
  assert.equal(paid.reason, 'no_client_formula');
  assert.equal(paid.tokensSeen, 50000, 'token 只作诊断留痕，不参与任何计算');
  // 倍率取不到 ⇒ 未知，且不能判成免费
  const noMul = estimateRunCredits({ tokens: 1000, multiplier: null });
  assert.equal(noMul.credits, null);
  assert.equal(noMul.free, null, '★ 倍率未知 ≠ 免费');
});

test('★ BASIS 记录的是"已证伪"，不是"未验证"', () => {
  assert.equal(BASIS.formula, null, '★ 本地没有公式');
  assert.equal(BASIS.perRequestFloor, 0.15, '实测地板（315 次的 min）');
  assert.equal(BASIS.currencyAnchor.perCreditCny, 0.05, '唯一硬锚点：1 积分 ≈ ¥0.05');
  assert.match(BASIS.note, /未知|无公式/, 'note 必须写明消耗一律报未知');
});

test('★ 开启后锁定：enabled 期间的锚点改动一律回退', () => {
  const snap = takeSnapshot(480.34, 1000);
  // 未开启 ⇒ 不锁
  assert.deepEqual(lockCheck({ snapshot: snap, currentAnchor: 12, enabled: false }),
    { locked: false, revert: false, why: 'unlocked' });
  // 开启且未改 ⇒ 锁着但不回退
  assert.deepEqual(lockCheck({ snapshot: snap, currentAnchor: 480.34, enabled: true }),
    { locked: true, revert: false, why: 'locked' });
  // 开启且被改 ⇒ 必须回退，并给出可记账的原因
  const edited = lockCheck({ snapshot: snap, currentAnchor: 999, enabled: true });
  assert.equal(edited.locked, true);
  assert.equal(edited.revert, true, '★ 开启期间改总额必须被回退');
  assert.equal(edited.why, 'anchor_edited_while_enabled');
  // 没有快照（还没开过）⇒ 不锁
  assert.equal(lockCheck({ snapshot: null, currentAnchor: 1, enabled: true }).locked, false);
});

test('投影：每一项都带依据，缺数据 ⇒ null', () => {
  const snap = takeSnapshot(480.34, 1000);
  const p = projectRemaining({ snapshot: snap, consumed: 12.5, runs: 5, now: 61000, lastRunCredits: 2.5 });
  assert.equal(p.anchor, 480.34);
  assert.equal(p.anchorAt, 1000);
  assert.equal(p.ageMs, 60000);
  assert.equal(p.consumed, 12.5);
  assert.equal(p.runs, 5);
  assert.equal(p.remaining, 467.84);
  assert.equal(p.lastRunCredits, 2.5);
  assert.equal(p.basis.formula, null, '★ 投影里必须带依据，且依据本身写明"没有公式"');
  assert.equal(p.basis.source, BASIS.source);

  // 没有锚点 ⇒ 全部未知，**绝不为 0**
  const none = projectRemaining({ snapshot: null, consumed: 0, runs: 0, now: 1 });
  assert.equal(none.anchor, null);
  assert.equal(none.remaining, null, '★ 没有锚点时 remaining 是 null，不是 0');
  assert.equal(none.consumed, null);
  assert.equal(none.ageMs, null);
});

test('快照：非数值的锚点归 0（不是 NaN 污染）', () => {
  assert.deepEqual(takeSnapshot(480.34, 5), { anchor: 480.34, at: 5 });
  assert.deepEqual(takeSnapshot('abc', 5), { anchor: 0, at: 5 });
  assert.deepEqual(takeSnapshot(undefined, 5), { anchor: 0, at: 5 });
});

test('★ 免费模型不得被记成"扣了 0"（调用方须据 free 排除）', () => {
  const free = estimateRunCredits({ tokens: 999999, multiplier: 0 });
  assert.equal(free.credits, 0);
  assert.equal(free.free, true, '★ 必须能被识别为"这次没花钱"，而不是"扣了 0"');
});
