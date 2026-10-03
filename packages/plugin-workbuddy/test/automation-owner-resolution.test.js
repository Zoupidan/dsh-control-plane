/**
 * test/automation-owner-resolution.test.js
 * 回归钉死 2026-10-03 真机事故：点火 owner 抄了 automations 历史行的旧账号 id，
 * 桌面切换登录账号后，调度器 ownerVisibility() fail-closed 把新点火行整批过滤
 * （零日志 / 零 dispatch / 桥面 list 返回 []），用户侧表现为"永远没有新会话"。
 * 修复后：resolveOwnerUserId 以 sessions 表最近活跃 user_id（守护进程盖章的当前登录账号）优先。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { resolveOwnerUserId } from '../src/host/gateway/automation.js';

function memoryDb({ withLastActivity = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE automations (
    id TEXT PRIMARY KEY, owner_user_id TEXT, owner_status TEXT NOT NULL DEFAULT 'legacy_unassigned',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
    CREATE TABLE sessions (
    id TEXT PRIMARY KEY, user_id TEXT, status TEXT,
    created_at INTEGER, updated_at INTEGER${withLastActivity ? ', last_activity_at INTEGER' : ''});`);
  return db;
}

const OLD = 'old-owner-11111111-1111-1111-1111-111111111111';
const NEW = 'new-owner-22222222-2222-2222-2222-222222222222';

function seed(db, { withLastActivity = true } = {}) {
  db.prepare("INSERT INTO automations (id, owner_user_id, owner_status, created_at, updated_at) VALUES ('a1', ?, 'confirmed', 1000, 1000)").run(OLD);
  const cols = withLastActivity
    ? "INSERT INTO sessions (id, user_id, created_at, updated_at, last_activity_at) VALUES (?, ?, ?, ?, ?)"
    : "INSERT INTO sessions (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)";
  const mk = (id, user, base) => {
    if (withLastActivity) db.prepare(cols).run(id, user, base, base, base);
    else db.prepare(cols).run(id, user, base, base);
  };
  return { mk };
}

test('★ 账号切换后：最近活跃的 sessions.user_id 优先于 automations 历史行 owner（last_activity_at 轴）', () => {
  const db = memoryDb();
  const { mk } = seed(db);
  mk('s-old', OLD, 1000);
  mk('s-new', NEW, 2000);
  assert.equal(resolveOwnerUserId(db), NEW);
});

test('★ 旧库没有 last_activity_at 列：降级 updated_at 轴仍取到当前账号', () => {
  const db = memoryDb({ withLastActivity: false });
  const { mk } = seed(db, { withLastActivity: false });
  mk('s-old', OLD, 1000);
  mk('s-new', NEW, 2000);
  assert.equal(resolveOwnerUserId(db), NEW);
});

test('★ sessions 为空：回退 automations 历史行 owner（旧行为兜底）', () => {
  const db = memoryDb();
  seed(db);
  assert.equal(resolveOwnerUserId(db), OLD);
});

test('★ 两处皆空：如实返回 null（owner_status 落 legacy_unassigned）', () => {
  const db = memoryDb();
  assert.equal(resolveOwnerUserId(db), null);
});

test('★ sessions 有行但 user_id 全空串：跳过，回退 automations owner', () => {
  const db = memoryDb();
  const { mk } = seed(db);
  mk('s-blank', '   ', 3000);
  assert.equal(resolveOwnerUserId(db), OLD);
});
