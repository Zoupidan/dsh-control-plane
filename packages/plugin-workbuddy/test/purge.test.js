/**
 * 施工单 2026-10-10 #3：`workbuddy_purge` 精准清理面。
 *
 * 覆盖：
 *  ① session_key 入参：软删记性里那条对话 + 清该 key 的记性（settings mutate unset 语义，
 *     经真 `loadSessionMap` + 假 settings 服务验证）；
 *  ② idLike 入参：恰好命中一条才删；0 条 / ≥2 条一律拒绝并如实回报，**绝不触碰其他对话**；
 *  ③ 两参同给但不一致 ⇒ 拒绝（防静默错位）；
 *  ④ 软删语义：`deleted_at` 置位、其余列不动、其他会话行分毫未动。
 *
 * @module test/purge.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { makePurgeTool } from '../src/host/tools/purge.js';
import { TOOL_PURGE } from '../src/shared/constants.js';
import { loadSessionMap } from '../src/host/session/map.js';

/** 极简 settings 服务：deep-merge update + mutate(unset) 语义与 dsh-settings 对齐的最小实现。 */
function fakeSettingsService(state) {
  return {
    describe: () => [{ ns: 'test-ns', value: structuredClone(state), revision: 1 }],
    update: (ns, patch) => {
      const merge = (under, over) => {
        if (under === null || typeof under !== 'object' || over === null || typeof over !== 'object') return over;
        const merged = { ...under };
        for (const [k, v] of Object.entries(over)) merged[k] = Object.hasOwn(merged, k) ? merge(merged[k], v) : v;
        return merged;
      };
      state.sessions = merge(state.sessions ?? {}, patch.sessions ?? {});
      return Promise.resolve();
    },
    mutate: (ns, ops) => {
      for (const op of ops) {
        if (op.op === 'unset' && op.path[0] === 'sessions' && op.path.length === 2) {
          delete state.sessions[op.path[1]];
        }
      }
      return Promise.resolve();
    },
  };
}

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    cwd TEXT NOT NULL,
    user_id TEXT NOT NULL DEFAULT '',
    title TEXT,
    status TEXT NOT NULL DEFAULT 'Pending',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    permission_mode TEXT
  )`);
  return db;
}

function insertSession(db, id, title, createdAt) {
  db.prepare(
    'INSERT INTO sessions (id, cwd, user_id, title, status, created_at, updated_at, deleted_at, permission_mode) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)',
  ).run(id, 'D:/repo', 'u1', title, 'Completed', createdAt, createdAt, 'fullAccess');
}

const CTX = { logger: { warn: () => {} } };

function makeSessions(svc) {
  return loadSessionMap({ get: () => svc }, 'test-ns');
}

test('workbuddy_purge：session_key 软删记性里那条对话 + 清该 key 的记性', async () => {
  const db = makeDb();
  insertSession(db, 'aaaaaaaa-1111-2222-3333-444444444444', 'Target conversation', 1000);
  insertSession(db, 'bbbbbbbb-1111-2222-3333-444444444444', 'Other conversation', 2000);

  const state = { sessions: {} };
  const svc = fakeSettingsService(state);
  const sessions = makeSessions(svc);
  sessions.adopt('k1', { cliSessionId: 'aaaaaaaa-1111-2222-3333-444444444444', cwd: 'D:/repo', own: true });

  const tool = makePurgeTool(null, null, CTX, sessions, db);
  // defineTool 的 execute 直取（不依赖宿主工具面）。
  const result = await tool.execute({ session_key: 'k1' });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.purged.length, 1);
  assert.equal(result.purged[0].id, 'aaaaaaaa-1111-2222-3333-444444444444');
  assert.equal(result.purged[0].softDeleted, true);
  assert.deepEqual(result.mapKeysCleared, ['k1']);

  // 软删语义：目标行 deleted_at 置位，其他行分毫未动。
  const target = db.prepare('SELECT deleted_at, title, permission_mode FROM sessions WHERE id = ?')
    .get('aaaaaaaa-1111-2222-3333-444444444444');
  assert.ok(target.deleted_at !== null, '软删 = deleted_at 置位');
  assert.equal(target.title, 'Target conversation', '其余列不动');
  const other = db.prepare('SELECT deleted_at FROM sessions WHERE id = ?')
    .get('bbbbbbbb-1111-2222-3333-444444444444');
  assert.equal(other.deleted_at, null, '其他对话绝不触碰');

  // 记性已清：settings 里 key 真被 unset（不是 tombstone），lookup 回 null。
  await sessions.settled();
  assert.equal(Object.hasOwn(state.sessions, 'k1'), false, 'settings 里的 key 被 mutate unset 真删');
  assert.equal(sessions.lookup('k1'), null);
  assert.equal(sessions.resumable('k1'), null, '清掉的 key 不再可续接');

  db.close();
});

test('workbuddy_purge：idLike 恰好命中一条才删；0 条 / 多条一律拒绝', async () => {
  const db = makeDb();
  insertSession(db, 'deadbeef-aaaa-2222-3333-444444444444', 'Unique match', 1000);
  insertSession(db, 'deadbeef-bbbb-2222-3333-444444444444', 'Second match', 2000);
  const sessions = makeSessions(fakeSettingsService({ sessions: {} }));
  const tool = makePurgeTool(null, null, CTX, sessions, db);

  // ≥2 条命中 ⇒ 拒绝并列出候选（必须在唯一命中删除之前验，否则活行只剩一条）。
  const ambiguous = await tool.execute({ idLike: 'deadbeef' });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.detail, /matches 2 conversations/);
  assert.match(ambiguous.detail, /deadbeef-bbbb/, '候选列表必须可见，调用方才能收窄');

  // 0 条命中 ⇒ 拒绝。
  const none = await tool.execute({ idLike: 'no-such-id' });
  assert.equal(none.ok, false);
  assert.match(none.detail, /no live conversation matches/);

  // 唯一命中 ⇒ 删。
  const unique = await tool.execute({ idLike: 'deadbeef-aaaa' });
  assert.equal(unique.ok, true, JSON.stringify(unique));
  assert.equal(unique.purged[0].id, 'deadbeef-aaaa-2222-3333-444444444444');
  assert.equal(db.prepare('SELECT deleted_at FROM sessions WHERE id = ?').get('deadbeef-aaaa-2222-3333-444444444444').deleted_at !== null, true);
  assert.equal(db.prepare('SELECT deleted_at FROM sessions WHERE id = ?').get('deadbeef-bbbb-2222-3333-444444444444').deleted_at, null);

  db.close();
});

test('workbuddy_purge：两参同给但不一致 ⇒ 拒绝，什么都不碰', async () => {
  const db = makeDb();
  insertSession(db, 'cccccccc-1111-2222-3333-444444444444', 'Recorded', 1000);
  insertSession(db, 'dddddddd-1111-2222-3333-444444444444', 'Named-by-idLike', 2000);
  const sessions = makeSessions(fakeSettingsService({ sessions: {} }));
  sessions.adopt('k2', { cliSessionId: 'cccccccc-1111-2222-3333-444444444444', cwd: 'D:/repo', own: true });
  const tool = makePurgeTool(null, null, CTX, sessions, db);

  const result = await tool.execute({ session_key: 'k2', idLike: 'dddddddd' });
  assert.equal(result.ok, false);
  assert.match(result.detail, /refusing to touch anything/);
  // 两条都原封不动。
  for (const id of ['cccccccc-1111-2222-3333-444444444444', 'dddddddd-1111-2222-3333-444444444444']) {
    assert.equal(db.prepare('SELECT deleted_at FROM sessions WHERE id = ?').get(id).deleted_at, null, id);
  }
  await sessions.settled();
  assert.ok(Object.hasOwn(sessions.lookup ? { s: 1 } : {}, 's') || true);
  assert.notEqual(sessions.lookup('k2'), null, '记性也不清（拒绝即整体不生效）');

  db.close();
});

test('workbuddy_purge：无入参 / 无记录 ⇒ 如实拒绝', async () => {
  const db = makeDb();
  const sessions = makeSessions(fakeSettingsService({ sessions: {} }));
  const tool = makePurgeTool(null, null, CTX, sessions, db);

  const noArgs = await tool.execute({});
  assert.equal(noArgs.ok, false);
  assert.match(noArgs.detail, /provide session_key or idLike/);

  const noRecord = await tool.execute({ session_key: 'ghost' });
  assert.equal(noRecord.ok, false);
  assert.match(noRecord.detail, /no recorded conversation/);

  db.close();
});

test('workbuddy_purge：工具名常量与注册面同名（workbuddy_purge）', () => {
  assert.equal(TOOL_PURGE, 'workbuddy_purge');
});
