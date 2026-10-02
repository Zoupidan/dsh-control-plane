/**
 * §4.3 回归：自建记账标 own + 启动清理 + 回执透传 + 诚实回收位。
 *
 * <p>本文件不碰真实数据库、不碰网络、不读凭据：session 映射用假 settings 服务，
 * dispatch 用可注入的 fetch/sessionStore，gateway-run 用假 dispatch。
 *
 * @module test/dispatch-own-recycle.test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadSessionMap, sweepOwnSessions } from '../src/host/session/map.js';
import { createDispatcher } from '../src/host/gateway/dispatch.js';
import { startGatewayRun } from '../src/host/tools/gateway-run.js';

function fakeCtx() {
  const store = {};
  return {
    get: (k) => (k === 'settings' ? {
      describe: () => [{ ns: 'plugin-workbuddy', value: { sessions: store } }],
      update: (ns, patch) => {
        for (const [kk, v] of Object.entries(patch.sessions ?? {})) store[kk] = { ...(store[kk] ?? {}), ...v };
      },
    } : null),
    store,
  };
}

test('adopt 标 own:true 并落 createdAt，refresh 沿用旧值', () => {
  const ctx = fakeCtx();
  const sessions = loadSessionMap(ctx, 'plugin-workbuddy');
  const r1 = sessions.adopt('wb-k1', { cliSessionId: '11111111-1111-4111-8111-111111111111', cwd: 'D:/repo', own: true });
  assert.equal(r1.ok, true);
  const v1 = sessions.lookup('wb-k1');
  assert.equal(v1.own, true);
  assert.ok(v1.createdAt > 0);
  const c1 = v1.createdAt;
  const r2 = sessions.adopt('wb-k1', { cliSessionId: '22222222-2222-4222-8222-222222222222', cwd: 'D:/repo', own: true });
  assert.equal(r2.ok, true);
  const v2 = sessions.lookup('wb-k1');
  assert.equal(v2.createdAt, c1, '续用 refresh 不得覆盖 createdAt');
  assert.equal(v2.own, true, 'own 标记粘滞');
});

test('sweep 只动 own 且陈旧的，近期活记录保留复用', () => {
  const ctx = fakeCtx();
  const sessions = loadSessionMap(ctx, 'plugin-workbuddy');
  sessions.adopt('wb-fresh', { cliSessionId: '33333333-3333-4333-8333-333333333333', cwd: '', own: true });
  sessions.adopt('wb-stale', { cliSessionId: '44444444-4444-4444-8444-444444444444', cwd: '', own: true });
  sessions.adopt('plain', { cliSessionId: '55555555-5555-4555-8555-555555555555', cwd: '' });
  const now = Date.now();
  const out = sweepOwnSessions(sessions, { now, maxAgeMs: 1000 });
  // fresh 与 stale 都是刚写入（age≈0 < 1000），都不该被扫掉
  assert.deepEqual(out.swept, []);
  assert.ok(out.kept.includes('wb-fresh'));
  // 把 stale 的 lastUsedAt 人为调旧再扫
  const old = sweepOwnSessions({ list: () => [{ key: 'wb-stale', own: true, lastUsedAt: now - 99999, superseded: false, unconfirmed: false }], supersede: (k) => sessions.supersede(k) }, { now, maxAgeMs: 1000 });
  assert.deepEqual(old.swept, ['wb-stale']);
  assert.equal(sessions.lookup('wb-stale')?.superseded, true, '陈旧遗留只打标记，不删记录');
  assert.equal(sessions.lookup('plain')?.superseded, false, '非 own 一律不动');
});

test('dispatch.recycleOwn 忘掉映射并如实记 no_delete_api', () => {
  const store = new Map();
  const d = createDispatcher({
    sessionStore: {
      read: (k) => store.get(k) ?? '',
      adopt: (k, r) => { store.set(k, r.cliSessionId); return { ok: true }; },
      forget: (k) => { store.delete(k); return { ok: true }; },
    },
  });
  store.set('workbuddy-gateway-own', 'sess-x');
  const note = d.recycleOwn('');
  assert.equal(note.recycled, false);
  assert.equal(note.reason, 'no_delete_api');
  assert.equal(store.has('workbuddy-gateway-own'), false, '本地映射已忘，下轮重建');
  const empty = d.recycleOwn('');
  assert.equal(empty.reason, 'no_session');
});

test('gateway 白名单透传 sessionId/sessionRenewed/recycle，不再丢失', async () => {
  const out = {
    ok: true, text: 'hi', receipt: { stopReason: 'end_turn', outcome: 'SUCCESS' },
    phases: [], tools: { count: 0, names: [] }, models: [], usedModelId: null, permission: null,
    sessionId: 'sess-abc', sessionOrigin: 'new', sessionRenewed: 'first_run',
    sessionPersist: { ok: true }, instance: null, sidecar: null,
    recycle: { attempted: false, recycled: false, reason: 'retained_for_reuse', detail: '' },
  };
  const g = startGatewayRun({ prompt: 'x', cwd: 'D:/w', dispatch: { run: async () => out } });
  const done = await g.done;
  assert.equal(done.gateway.sessionId, 'sess-abc');
  assert.equal(done.gateway.sessionRenewed, 'first_run');
  assert.equal(done.gateway.recycle?.reason, 'retained_for_reuse');
});
