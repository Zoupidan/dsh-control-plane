/**
 * @file session/map.js 的 `touch(key, patch)` + `forget(key, reason)`（★ M2 增量的单元面）。
 *
 * <p>★ 只碰内存记性 + 假 settings（同步 update，非 thenable ⇒ persistState 'attempted'）★
 * 绝不触真库、真 settings —— 护栏与 `multi-turn-reuse.test.js` 同款。
 *
 * <p>覆盖面：
 *   - touch：热度推进 + 全字段保真（判死位/own/createdAt 不洗白）、patch 后置合并、
 *     坏类型字段被净化丢弃、缺 key 安全 no-op（不造记录、不落盘）、无 settings 服务时内存仍更新。
 *   - forget：默认行为与既有逐字一致（向后兼容）、reason 透传不炸、缺 key no_record。
 *
 * @module test/session-map-touch
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { loadSessionMap } from '../src/host/session/map.js';
import { workbuddyDbPath } from '../src/host/gateway/automation.js';

const REAL_DB = join(homedir(), '.workbuddy', 'workbuddy.db');

/** 假宿主 ctx：settings.update 同步返回（非 thenable ⇒ persistState 'attempted'），记录每次写入。 */
function fakeCtx() {
  /** @type {Array<{ns: string, patch: object}>} */
  const updates = [];
  const svc = {
    describe: () => [],
    update: (ns, patch) => { updates.push({ ns, patch }); return undefined; },
  };
  return { ctx: { get: (key) => (key === 'settings' ? svc : undefined) }, svc, updates };
}

/** 无 settings 服务的假宿主（极简宿主形态；persist 应走 'noop' 而不是炸）。 */
function bareCtx() {
  return { ctx: { get: () => undefined } };
}

test('⓪ 套件级护栏生效：WORKBUDDY_HOME 指着一次性 tmp，真库结构上不可达', () => {
  assert.equal(process.env.WORKBUDDY_TEST_HOME_GUARD, 'on', '★ 必须经 npm run test:host 运行');
  const home = process.env.WORKBUDDY_HOME ?? '';
  assert.ok(home.startsWith(tmpdir()));
  assert.ok(!REAL_DB.startsWith(home));
  assert.notEqual(workbuddyDbPath(), REAL_DB);
});

test('T1 ★ adopt 后 touch：lastUsedAt 推进，其余字段逐字段保真', async () => {
  const { ctx, updates } = fakeCtx();
  const sessions = loadSessionMap(ctx, 'dsh-plugin-workbuddy');
  await sessions.settled();
  const adoptAt = 1_700_000_000_000;
  sessions.adopt('K', { cliSessionId: 'conv-1', cwd: 'C:/repo', own: true, createdAt: adoptAt });
  const before = sessions.lookup('K');

  const r = sessions.touch('K');
  assert.deepEqual(
    { ok: r.ok, persistState: r.persistState, persistError: r.persistError },
    { ok: true, persistState: 'attempted', persistError: '' },
    '同步假宿主 ⇒ attempted',
  );
  const after = sessions.lookup('K');
  assert.ok(after.lastUsedAt >= before.lastUsedAt, '★ 热度戳必须推进');
  assert.equal(after.cliSessionId, 'conv-1', '会话 id 不变（touch 不换 id）');
  assert.equal(after.cwd, 'C:/repo');
  assert.equal(after.own, true, 'own 标记必须保真（回收判据）');
  assert.equal(after.createdAt, adoptAt, 'createdAt 不得被 touch 改写');
  assert.equal(after.superseded, false);
  assert.equal(after.unconfirmed, false);
  // 落盘补丁：走既有 persist 路径（settings.update），补丁里热度戳与既有记录同源。
  assert.equal(updates.length, 2, 'adopt 一次 + touch 一次，都经 persist');
  const touchPatch = updates[1].patch.sessions.K;
  assert.ok(Number.isFinite(touchPatch.lastUsedAt), 'touch 补丁必须带 lastUsedAt');
  assert.equal(touchPatch.cliSessionId, 'conv-1');
  assert.equal(touchPatch.own, true);
});

test('T2 ★ 缺 key ⇒ 安全 no-op：不造记录、不落盘', () => {
  const { ctx, updates } = fakeCtx();
  const sessions = loadSessionMap(ctx, 'dsh-plugin-workbuddy');
  const r = sessions.touch('never-used');
  assert.deepEqual({ ok: r.ok, persistState: r.persistState }, { ok: false, persistState: 'no_record' });
  assert.equal(sessions.lookup('never-used'), null, '绝不凭空造空壳记录');
  assert.equal(updates.length, 0, '不落盘（settings 里不会堆垃圾）');
});

test('T3 ★ patch 后置合并：同键以补丁为准；坏类型字段被净化丢弃（不拖垮整份 namespace）', async () => {
  const { ctx } = fakeCtx();
  const sessions = loadSessionMap(ctx, 'dsh-plugin-workbuddy');
  sessions.adopt('K', { cliSessionId: 'conv-1', cwd: 'C:/repo' });
  const r = sessions.touch('K', { outputBytes: 123, cliSessionId: 42, junk: 'x', superseded: true });
  assert.equal(r.ok, true);
  const rec = sessions.lookup('K');
  assert.equal(rec.outputBytes, 123, '补丁字段生效');
  assert.equal(rec.cliSessionId, 'conv-1', '★ 类型不合法的补丁（id=42）被 sanitize 丢弃 ⇒ 旧 id 保留');
  assert.equal(rec.superseded, true, '布尔补丁生效（显式置真）');
  assert.equal(rec.junk, undefined, '未知字段被丢弃');
  await sessions.settled();
});

test('T4 ★★ touch 不得洗白判死位：superseded/unconfirmed 粘滞（否则死 id 复活）', async () => {
  const { ctx } = fakeCtx();
  const sessions = loadSessionMap(ctx, 'dsh-plugin-workbuddy');
  sessions.adopt('K', { cliSessionId: 'conv-1' });
  sessions.supersede('K');
  assert.equal(sessions.resumable('K'), null, '前置：supersede 后不可续接');

  sessions.touch('K');
  assert.equal(sessions.lookup('K').superseded, true, '★ touch 后判死位必须保留');
  assert.equal(sessions.resumable('K'), null, '★ touch 不得把死会话救活');

  sessions.adopt('U', { cliSessionId: 'conv-2' });
  sessions.supersede('U', 'unconfirmed');
  sessions.touch('U');
  assert.equal(sessions.resumable('U'), null);
  assert.equal(sessions.lookup('U').superseded, true);
});

test('T5 无 settings 服务 ⇒ persistState noop，内存热度仍更新（本进程内续接不丢）', () => {
  const { ctx } = bareCtx();
  const sessions = loadSessionMap(ctx, 'dsh-plugin-workbuddy');
  sessions.adopt('K', { cliSessionId: 'conv-1' });
  const before = sessions.lookup('K').lastUsedAt;
  const r = sessions.touch('K');
  assert.equal(r.ok, true);
  assert.equal(r.persistState, 'noop', '没有落盘通道要如实说（不谎报已落盘）');
  assert.ok(sessions.lookup('K').lastUsedAt >= before, '内存热度照常推进');
});

test('F1 ★ forget 默认行为向后兼容：forget(k) ≡ 旧 forget(k)（superseded 标记 + 停止续接）', async () => {
  const { ctx } = fakeCtx();
  const sessions = loadSessionMap(ctx, 'dsh-plugin-workbuddy');
  sessions.adopt('K', { cliSessionId: 'conv-1' });
  assert.equal(sessions.resumable('K')?.cliSessionId, 'conv-1');
  const r = sessions.forget('K');
  assert.equal(r.ok, true);
  assert.equal(sessions.resumable('K'), null, '★ forget 后不再可命中（下轮重建）');
  assert.equal(sessions.lookup('K').cliSessionId, 'conv-1', '旧 id 留作历史留痕（supersede 语义）');
  assert.equal(sessions.lookup('K').superseded, true);
});

test('F2 ★ forget reason 透传：指纹码入参不炸、语义不变；缺 key no_record', async () => {
  const { ctx } = fakeCtx();
  const sessions = loadSessionMap(ctx, 'dsh-plugin-workbuddy');
  sessions.adopt('K', { cliSessionId: 'conv-1' });
  const r = sessions.forget('K', 'ERR_WORKBUDDY_CDP_UNAVAILABLE');
  assert.equal(r.ok, true, '★ 指纹码 reason 纯透传 —— 不改变作废语义');
  assert.equal(sessions.resumable('K'), null);
  assert.equal(sessions.lookup('K').superseded, true);
  // 缺 key：no_record（不造空壳），带不带 reason 同。
  assert.equal(sessions.forget('never-used').persistState, 'no_record');
  assert.equal(sessions.forget('never-used', 'ERR_X').persistState, 'no_record');
  // 空 key：与既有 supersede 同一口径（failed + 逐字成因）。
  assert.equal(sessions.forget('').persistState, 'failed');
  // 非字符串 reason 安全回退到默认。
  sessions.adopt('M', { cliSessionId: 'conv-9' });
  assert.equal(sessions.forget('M', undefined).ok, true);
  sessions.adopt('N', { cliSessionId: 'conv-10' });
  assert.equal(sessions.forget('N', 42).ok, true, '非法 reason 回退默认，不炸');
});
