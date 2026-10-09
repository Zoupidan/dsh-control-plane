/**
 * Milestone 3 / R3: Sidecar & Port 18488 Deprecation, DB Truth Permissions, Read-Only Safety.
 *
 * 覆盖：
 *   ① F7: 彻底废除 18488 端口与 Sidecar 探测：
 *      - detectWorkBuddy 在无 18488 监听的情况下纯只读探测完成，不发起任何 TCP 连接到 18488；
 *      - createFollowUpDispatcher 操作只走 CDP 调试口（默认 9222），绝不尝试 18488 预检；
 *   ② F7/F8: workbuddy_status 基于 SQLite sessions 表真实记录回显权限：
 *      - reportPermission 查询最新 sessions 行回显 current 权限；
 *      - 无库时回落至配置，空配置回落至 'default'；
 *      - 包含固定的 3 项合法权限选项（plan, default, fullAccess）；
 *      - makeStatusTool 工具调用无需 sidecar 或 dispatch.capabilities，直接产出包含 permission 的有效状态；
 *   ③ F8/F9: startAutomationRun 的只读护栏与 DB 事实权限验证：
 *      - 当 permission / permission_mode / permissionMode 为 'plan' 时，注入只读硬护栏；
 *      - 将 'plan' 写入 automations.permission_mode；
 *      - 不重复追加已存在的只读护栏；
 *      - 根据 sessions.permission_mode 校验 permission.confirmed；
 *   ④ F8/F9: harvestAutomationRun 的权限与思考强度真实性校验：
 *      - 匹配时 confirmed 为 true；
 *      - 分歧时（例如 plan != fullAccess，或 high != low）confirmed 为 false；
 *      - 未请求或会话行缺失时 confirmed 均为 false。
 *
 * @module test/db-truth-permissions.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { detectWorkBuddy } from '../src/host/probe/detect.js';
import { createFollowUpDispatcher } from '../src/host/followup/dispatcher.js';
import { reportPermission, makeStatusTool } from '../src/host/tools/status.js';
import {
  startAutomationRun,
  harvestAutomationRun,
  sessionFacts,
  READ_ONLY_PROMPT_GUARD,
} from '../src/host/gateway/automation.js';

function createFixtureHome() {
  const home = mkdtempSync(join(tmpdir(), 'wb-db-truth-test-'));
  const db = new DatabaseSync(join(home, 'workbuddy.db'));
  db.exec(`
    CREATE TABLE automations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      schedule_type TEXT NOT NULL DEFAULT 'once',
      next_run_at INTEGER,
      last_run_at INTEGER,
      cwds TEXT NOT NULL DEFAULT '[]',
      rrule TEXT NOT NULL DEFAULT '',
      scheduled_at TEXT,
      valid_from TEXT,
      valid_until TEXT,
      model_id TEXT,
      model_is_thinking INTEGER NOT NULL DEFAULT 0,
      skills_json TEXT NOT NULL DEFAULT '[]',
      push_to_wechat INTEGER NOT NULL DEFAULT 0,
      push_to_wecom_bot INTEGER NOT NULL DEFAULT 0,
      owner_user_id TEXT,
      owner_status TEXT NOT NULL DEFAULT 'legacy_unassigned',
      owner_source TEXT,
      expert_id TEXT,
      expert_marketplace TEXT,
      connector_ids_json TEXT NOT NULL DEFAULT '[]',
      permission_mode TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      wecom_bot_source TEXT,
      context_window TEXT,
      reasoning_effort TEXT
    );
    CREATE TABLE automation_runs (
      thread_id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      status TEXT NOT NULL,
      read_at TEXT,
      thread_title TEXT,
      source_cwd TEXT,
      runs_json TEXT,
      result_success INTEGER,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      failure_code TEXT,
      reason_code TEXT
    );
    CREATE TABLE automation_runtime_state (
      automation_id TEXT PRIMARY KEY,
      last_run_at INTEGER,
      last_error TEXT,
      running INTEGER NOT NULL DEFAULT 0,
      running_started_at INTEGER,
      running_conversation_id TEXT,
      metadata_json TEXT
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT,
      title TEXT,
      user_id TEXT,
      model TEXT,
      permission_mode TEXT,
      source_mode TEXT,
      is_background_automation INTEGER,
      session_settings TEXT,
      status TEXT,
      thought_level TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE session_usage (
      session_id TEXT PRIMARY KEY,
      used INTEGER,
      size INTEGER,
      credit_json TEXT
    );
  `);
  db.close();
  mkdirSync(join(home, 'logs'), { recursive: true });
  mkdirSync(join(home, 'projects'), { recursive: true });
  return home;
}

function withTestHome(fn) {
  const home = createFixtureHome();
  const prevHome = process.env.WORKBUDDY_HOME;
  process.env.WORKBUDDY_HOME = home;
  try {
    return fn(home);
  } finally {
    if (prevHome === undefined) delete process.env.WORKBUDDY_HOME;
    else process.env.WORKBUDDY_HOME = prevHome;
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {}
  }
}

async function withTestHomeAsync(fn) {
  const home = createFixtureHome();
  const prevHome = process.env.WORKBUDDY_HOME;
  process.env.WORKBUDDY_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prevHome === undefined) delete process.env.WORKBUDDY_HOME;
    else process.env.WORKBUDDY_HOME = prevHome;
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {}
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 1. Sidecar & Port 18488 Deprecation (Feature F7)
// ══════════════════════════════════════════════════════════════════════════

test('F7-1: detectWorkBuddy operates cleanly without opening TCP connections to port 18488', async () => {
  await withTestHomeAsync(async (home) => {
    // 监听 net.connect / net.createConnection 调用
    let tcpConnected18488 = false;
    const origConnect = net.connect;
    net.connect = function (...args) {
      for (const a of args) {
        if (a === 18488 || (typeof a === 'object' && a !== null && a.port === 18488)) {
          tcpConnected18488 = true;
        }
      }
      return origConnect.apply(this, args);
    };

    try {
      // 模拟 cache 配置文件存在
      mkdirSync(join(home, '.workbuddy', 'cache'), { recursive: true });
      writeFileSync(join(home, '.workbuddy', 'cache', 'acc-product-config-v3.json'), JSON.stringify({ version: '3.0' }));

      const res = await detectWorkBuddy({}, {});
      assert.equal(res.installed, true, 'Desktop detected via cache');
      assert.equal(res.method, 'desktop-cache');
      assert.equal(tcpConnected18488, false, 'detectWorkBuddy must NEVER open socket to 18488');

      // 验证证据清单中绝无 18488 或 desktop-port
      const portEvidence = res.evidence.find((e) => e.kind === 'desktop-port' || String(e.value).includes('18488'));
      assert.equal(portEvidence, undefined, 'Evidence must not include port 18488 checks');
    } finally {
      net.connect = origConnect;
    }
  });
});

test('F7-2: createFollowUpDispatcher does not probe port 18488', async () => {
  let probed18488 = false;
  const origConnect = net.connect;
  net.connect = function (...args) {
    for (const a of args) {
      if (a === 18488 || (typeof a === 'object' && a !== null && a.port === 18488)) {
        probed18488 = true;
      }
    }
    return origConnect.apply(this, args);
  };

  try {
    const dispatcher = createFollowUpDispatcher({ cdpPort: 9222, timeoutMs: 100 });
    assert.equal(typeof dispatcher.probeCdp, 'function');
    assert.equal(typeof dispatcher.followUp, 'function');
    assert.equal(typeof dispatcher.ignite, 'function');

    // 运行 probeCdp（CDP 口 9222 未开启）
    const result = await dispatcher.probeCdp(9222, 50);
    assert.equal(result.available, false);
    assert.equal(probed18488, false, 'Dispatcher must never probe port 18488');
  } finally {
    net.connect = origConnect;
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 2. Database Truth for Permission & Effort (Feature F8 & Status Tool)
// ══════════════════════════════════════════════════════════════════════════

test('F8-1: reportPermission extracts permission from latest SQLite sessions record', () => {
  withTestHome((home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const cid = 'session-perm-test-1';
    db.prepare(`
      INSERT INTO sessions (id, cwd, title, permission_mode, thought_level, created_at)
      VALUES (?, 'D:\\repo', 'Perm Test', 'fullAccess', 'high', ?)
    `).run(cid, 1728000000000);
    db.close();

    const perm = reportPermission();
    assert.equal(perm.known, true);
    assert.equal(perm.current, 'fullAccess', 'Current permission must match sessions table truth');
    assert.deepEqual(perm.options, [
      { id: 'plan', label: 'Plan (Read-Only)', description: 'Read-only inspection and analysis' },
      { id: 'default', label: 'Default', description: 'Standard interactive permissions' },
      { id: 'fullAccess', label: 'Full Access', description: 'Full filesystem access' },
    ]);
    assert.equal(perm.error, '');
  });
});

test('F8-2: reportPermission falls back to config or default when sessions table is empty', () => {
  withTestHome((_home) => {
    // 1. 无 sessions 行，提供 config.permissionMode
    const fromConfig = reportPermission({ permissionMode: 'plan' });
    assert.equal(fromConfig.known, true);
    assert.equal(fromConfig.current, 'plan');

    // 2. 无 sessions 行，空配置
    const fromDefault = reportPermission({});
    assert.equal(fromDefault.known, true);
    assert.equal(fromDefault.current, 'default');
  });
});

test('F8-3: makeStatusTool returns permission from DB truth without dispatch or sidecar', async () => {
  await withTestHomeAsync(async (home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    db.prepare(`
      INSERT INTO sessions (id, cwd, title, permission_mode, created_at)
      VALUES ('session-status-truth', 'D:\\repo', 'Title', 'plan', 1728000000000)
    `).run();
    db.close();

    const runtimeMock = {
      registry: () => 'REGISTERED',
      registrationError: () => null,
      detected: () => ({ installed: true, reason: 'ok', resolvedPath: 'cache', method: 'desktop-cache', at: Date.now(), evidence: [] }),
      inFlight: () => [],
      lastRun: () => null,
      probe: async () => {},
    };

    // dispatch 传入 null，证明无需 sidecar
    const statusTool = makeStatusTool(runtimeMock, () => ({}), {}, null, null);
    const res = await statusTool.execute({});

    assert.ok(res.permission, 'Status output must include permission object');
    assert.equal(res.permission.known, true);
    assert.equal(res.permission.current, 'plan', 'Must reflect DB truth permission_mode');
    assert.equal(res.permission.options.length, 3);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 3. Read-Only Safety Constraints & DB Confirmation (Feature F9)
// ══════════════════════════════════════════════════════════════════════════

test('F9-1: startAutomationRun with plan mode injects prompt guard and stores plan in automations', async () => {
  await withTestHomeAsync(async (home) => {
    const promptText = 'Inspect workspace files without modifications';
    const run = startAutomationRun({
      prompt: promptText,
      cwd: 'D:\\readonly-project',
      permissionMode: 'plan',
      timeoutMs: 60,
      pollMs: 20,
    });
    const result = await run.done;

    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoRow = db.prepare('SELECT prompt, permission_mode FROM automations WHERE id = ?').get(result.automation.automationId);
    db.close();

    assert.equal(autoRow.permission_mode, 'plan', 'Must store permission_mode = plan');
    assert.ok(autoRow.prompt.startsWith(READ_ONLY_PROMPT_GUARD), 'Must prepend READ_ONLY_PROMPT_GUARD to prompt');
    assert.ok(autoRow.prompt.includes(promptText), 'Must preserve original prompt text');
  });
});

test('F9-2: startAutomationRun does not duplicate prompt guard if already present', async () => {
  await withTestHomeAsync(async (home) => {
    const alreadyGuarded = `${READ_ONLY_PROMPT_GUARD}Inspect workspace again`;
    const run = startAutomationRun({
      prompt: alreadyGuarded,
      cwd: 'D:\\readonly-project',
      permission_mode: 'plan',
      timeoutMs: 60,
      pollMs: 20,
    });
    const result = await run.done;

    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoRow = db.prepare('SELECT prompt FROM automations WHERE id = ?').get(result.automation.automationId);
    db.close();

    const occurrences = autoRow.prompt.split(READ_ONLY_PROMPT_GUARD).length - 1;
    assert.equal(occurrences, 1, 'READ_ONLY_PROMPT_GUARD must not be duplicated');
  });
});

test('F9-3: startAutomationRun evaluates permission.confirmed against SQLite sessions', async () => {
  await withTestHomeAsync(async (home) => {
    const autoId = 'automation-test-confirm';
    const cid = 'session-test-confirm';
    const db = new DatabaseSync(join(home, 'workbuddy.db'));

    // 预填已完成会话与运行记录
    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, cwds, permission_mode, reasoning_effort, created_at, updated_at)
      VALUES (?, 'Confirm Run', 'Test', 'ACTIVE', '["D:\\\\repo"]', 'plan', 'high', 1000, 1000)
    `).run(autoId);

    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, metadata_json, created_at, updated_at)
      VALUES ('thread-1', ?, 'ACCEPTED', 1, ?, 1010, 1010)
    `).run(autoId, JSON.stringify({ conversationId: cid }));

    db.prepare(`
      INSERT INTO sessions (id, cwd, title, permission_mode, thought_level, created_at)
      VALUES (?, 'D:\\repo', 'Confirm Run', 'plan', 'high', 1005)
    `).run(cid);
    db.close();

    // 针对该 automationId 进行延迟收割，测试其基于 sessions 的 confirmed 判定
    const harvested = await harvestAutomationRun(autoId);
    assert.equal(harvested.ok, true);
    assert.equal(harvested.permission.requested, 'plan');
    assert.equal(harvested.permission.effective, 'plan');
    assert.equal(harvested.permission.confirmed, true, 'Permission confirmed must be true when matching');
    assert.equal(harvested.effort.requested, 'high');
    assert.equal(harvested.effort.effective, 'high');
    assert.equal(harvested.effort.confirmed, true, 'Effort confirmed must be true when matching');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 4. harvestAutomationRun Matching vs Diverging Verification
// ══════════════════════════════════════════════════════════════════════════

test('F9-4: harvestAutomationRun reports confirmed: false when permission or effort diverges', async () => {
  await withTestHomeAsync(async (home) => {
    const autoId = 'automation-diverge';
    const cid = 'session-diverge';
    const db = new DatabaseSync(join(home, 'workbuddy.db'));

    // 请求 plan 模式与 high 思考强度，但桌面端实际记为 fullAccess 与 low
    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, cwds, permission_mode, reasoning_effort, created_at, updated_at)
      VALUES (?, 'Diverged Run', 'Audit', 'ACTIVE', '["D:\\\\repo"]', 'plan', 'high', 2000, 2000)
    `).run(autoId);

    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, metadata_json, created_at, updated_at)
      VALUES ('thread-diverge', ?, 'ACCEPTED', 1, ?, 2010, 2010)
    `).run(autoId, JSON.stringify({ conversationId: cid }));

    db.prepare(`
      INSERT INTO sessions (id, cwd, title, permission_mode, thought_level, created_at)
      VALUES (?, 'D:\\repo', 'Diverged Run', 'fullAccess', 'low', 2005)
    `).run(cid);
    db.close();

    const harvested = await harvestAutomationRun(autoId);
    assert.equal(harvested.ok, true);
    assert.equal(harvested.permission.requested, 'plan');
    assert.equal(harvested.permission.effective, 'fullAccess');
    assert.equal(harvested.permission.confirmed, false, 'Must report confirmed: false on permission divergence');

    assert.equal(harvested.effort.requested, 'high');
    assert.equal(harvested.effort.effective, 'low');
    assert.equal(harvested.effort.confirmed, false, 'Must report confirmed: false on effort divergence');
  });
});

test('F9-5: harvestAutomationRun reports confirmed: false when sessions row is absent', async () => {
  await withTestHomeAsync(async (home) => {
    const autoId = 'automation-no-sess';
    const db = new DatabaseSync(join(home, 'workbuddy.db'));

    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, cwds, permission_mode, reasoning_effort, created_at, updated_at)
      VALUES (?, 'No Session Run', 'Audit', 'ACTIVE', '["D:\\\\repo"]', 'plan', 'high', 3000, 3000)
    `).run(autoId);
    db.close();

    const harvested = await harvestAutomationRun(autoId);
    assert.equal(harvested.ok, true);
    assert.equal(harvested.sessionId, null);
    assert.equal(harvested.permission.effective, null);
    assert.equal(harvested.permission.confirmed, false, 'Cannot confirm without sessions row');
    assert.equal(harvested.effort.effective, null);
    assert.equal(harvested.effort.confirmed, false, 'Cannot confirm without sessions row');
  });
});
