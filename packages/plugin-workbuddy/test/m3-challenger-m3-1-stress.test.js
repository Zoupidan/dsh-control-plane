/**
 * Milestone 3 (R3) Challenger 1 Adversarial & Empirical Stress Test Suite
 *
 * Specifically verifies challenger_m3_1 objectives:
 *   1. Assert that NO TCP connections are made to port 18488 during:
 *      - detectWorkBuddy (cache valid, cache missing, exe fallback, cache corrupted)
 *      - createFollowUpDispatcher (probeCdp, followUp, ignite)
 *      - Spying and monkey-patching net.connect, net.createConnection, and net.Socket.prototype.connect.
 *   2. Stress-test workbuddy_status tool and reportPermission with:
 *      - Missing SQLite DB (verify graceful fallback to config without crashing)
 *      - Corrupted SQLite DB (corrupted byte noise, 0-byte file, missing sessions table, missing permission_mode column)
 *      - Empty database (0 rows in sessions table)
 *      - Multiple sessions with different permission modes (verify strictly latest session by created_at wins)
 *      - Edge case values in sessions.permission_mode (NULL, whitespace, leading/trailing spaces, non-canonical)
 *   3. End-to-end workbuddy_status tool contract and schema stress:
 *      - Verify dispatch.capabilities is never called (sidecar completely deprecated)
 *      - Output schema conformance across all states
 *      - Options structure invariant: strictly 3 canonical permission options (plan, default, fullAccess)
 *      - presentCall and render method robustness.
 *
 * @module test/m3-challenger-m3-1-stress.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { detectWorkBuddy } from '../src/host/probe/detect.js';
import { createFollowUpDispatcher, packageContentBlocks } from '../src/host/followup/dispatcher.js';
import { reportPermission, makeStatusTool } from '../src/host/tools/status.js';

function createStressHome() {
  const home = mkdtempSync(join(tmpdir(), 'wb-m3-challenger-1-'));
  const dbPath = join(home, 'workbuddy.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE automations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL,
      schedule_type TEXT NOT NULL DEFAULT 'once', next_run_at INTEGER, last_run_at INTEGER,
      cwds TEXT NOT NULL DEFAULT '[]', rrule TEXT NOT NULL DEFAULT '', scheduled_at TEXT,
      valid_from TEXT, valid_until TEXT, model_id TEXT, model_is_thinking INTEGER NOT NULL DEFAULT 0,
      skills_json TEXT NOT NULL DEFAULT '[]', push_to_wechat INTEGER NOT NULL DEFAULT 0,
      push_to_wecom_bot INTEGER NOT NULL DEFAULT 0, owner_user_id TEXT,
      owner_status TEXT NOT NULL DEFAULT 'legacy_unassigned', owner_source TEXT,
      expert_id TEXT, expert_marketplace TEXT, connector_ids_json TEXT NOT NULL DEFAULT '[]',
      permission_mode TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
      wecom_bot_source TEXT, context_window TEXT, reasoning_effort TEXT
    );
    CREATE TABLE automation_runs (
      thread_id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, status TEXT NOT NULL, read_at TEXT,
      thread_title TEXT, source_cwd TEXT, runs_json TEXT, result_success INTEGER, metadata_json TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, failure_code TEXT, reason_code TEXT
    );
    CREATE TABLE automation_runtime_state (
      automation_id TEXT PRIMARY KEY, last_run_at INTEGER, last_error TEXT,
      running INTEGER NOT NULL DEFAULT 0, running_started_at INTEGER, running_conversation_id TEXT,
      metadata_json TEXT
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, cwd TEXT, title TEXT, user_id TEXT, model TEXT, permission_mode TEXT,
      source_mode TEXT, is_background_automation INTEGER, session_settings TEXT, status TEXT,
      thought_level TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE session_usage (
      session_id TEXT PRIMARY KEY, used INTEGER, size INTEGER, credit_json TEXT
    );
  `);
  db.close();
  mkdirSync(join(home, 'logs'), { recursive: true });
  mkdirSync(join(home, 'projects'), { recursive: true });
  return home;
}

function safeRm(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {}
}

function useStressHome(home) {
  const previous = process.env.WORKBUDDY_HOME;
  process.env.WORKBUDDY_HOME = home;
  return () => {
    if (previous === undefined) delete process.env.WORKBUDDY_HOME;
    else process.env.WORKBUDDY_HOME = previous;
  };
}

/**
 * Socket spy that detects any TCP connection attempt to a target port (18488).
 * Patches net.connect, net.createConnection, and Socket.prototype.connect.
 */
function createPortSentinel(forbiddenPort = 18488) {
  const attempts = [];
  const origConnect = net.connect;
  const origCreateConnection = net.createConnection;
  const origSocketConnect = net.Socket.prototype.connect;

  function recordIfForbidden(targetPort, caller) {
    if (Number(targetPort) === forbiddenPort) {
      attempts.push({ port: forbiddenPort, caller, stack: new Error().stack });
    }
  }

  function extractPort(args) {
    for (const a of args) {
      if (typeof a === 'number') return a;
      if (typeof a === 'string' && /^\d+$/.test(a)) return parseInt(a, 10);
      if (typeof a === 'object' && a !== null && 'port' in a) return Number(a.port);
    }
    return null;
  }

  net.connect = function (...args) {
    recordIfForbidden(extractPort(args), 'net.connect');
    return origConnect.apply(this, args);
  };

  net.createConnection = function (...args) {
    recordIfForbidden(extractPort(args), 'net.createConnection');
    return origCreateConnection.apply(this, args);
  };

  net.Socket.prototype.connect = function (...args) {
    recordIfForbidden(extractPort(args), 'net.Socket.prototype.connect');
    return origSocketConnect.apply(this, args);
  };

  return {
    get attempts() {
      return [...attempts];
    },
    assertZeroConnection() {
      assert.equal(
        attempts.length,
        0,
        `Violated port 18488 deprecation! Connected ${attempts.length} time(s) to port 18488:\n` +
          attempts.map((a) => `[${a.caller}] ${a.stack}`).join('\n'),
      );
    },
    restore() {
      net.connect = origConnect;
      net.createConnection = origCreateConnection;
      net.Socket.prototype.connect = origSocketConnect;
    },
  };
}

function mockRuntime(detectedResult = null) {
  return {
    registry: () => 'REGISTERED',
    registrationError: () => null,
    detected: () =>
      detectedResult ?? {
        installed: true,
        reason: 'ok',
        resolvedPath: 'C:\\fake\\path',
        method: 'desktop-cache',
        at: Date.now(),
        evidence: [],
      },
    inFlight: () => [],
    lastRun: () => null,
    probe: async (detector, ctx, cfg) => detector(ctx, cfg),
  };
}

// ══════════════════════════════════════════════════════════════════════════
// SUITE 1: EMPIRICAL PORT 18488 DEPRECATION GUARANTEES
// ══════════════════════════════════════════════════════════════════════════

test('1.1 detectWorkBuddy: NO TCP connection to 18488 when cache is present and valid', async () => {
  const sentinel = createPortSentinel(18488);
  const home = createStressHome();
  const restore = useStressHome(home);
  try {
    const cacheDir = join(home, '.workbuddy', 'cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'acc-product-config-v3.json'), JSON.stringify({ version: '3.0' }), 'utf8');

    const result = await detectWorkBuddy({}, {});
    assert.equal(result.installed, true);
    assert.equal(result.method, 'desktop-cache');
    sentinel.assertZeroConnection();

    // Verify evidence contains no port 18488 traces
    const has18488Evidence = result.evidence.some(
      (e) => String(e.kind).includes('port') || String(e.value).includes('18488'),
    );
    assert.equal(has18488Evidence, false, 'Evidence list must not contain port 18488 checks');
  } finally {
    sentinel.restore();
    restore();
    safeRm(home);
  }
});

test('1.2 detectWorkBuddy: NO TCP connection to 18488 when cache is absent and exe is absent', async () => {
  const sentinel = createPortSentinel(18488);
  const home = createStressHome();
  const restore = useStressHome(home);
  try {
    const fakeEnv = {
      WORKBUDDY_HOME: home,
      ProgramFiles: home,
      ProgramW6432: home,
      'ProgramFiles(x86)': home,
      LOCALAPPDATA: home,
    };
    const result = await detectWorkBuddy({}, {}, fakeEnv);
    assert.equal(result.installed, false);
    assert.equal(result.method, 'desktop-probe');
    sentinel.assertZeroConnection();
  } finally {
    sentinel.restore();
    restore();
    safeRm(home);
  }
});

test('1.3 detectWorkBuddy: NO TCP connection to 18488 when cache contains corrupted / unreadable JSON', async () => {
  const sentinel = createPortSentinel(18488);
  const home = createStressHome();
  const restore = useStressHome(home);
  try {
    const cacheDir = join(home, '.workbuddy', 'cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'acc-product-config-v3.json'), 'CORRUPTED_NOT_JSON{[[{', 'utf8');

    const result = await detectWorkBuddy({}, {});
    assert.equal(result.installed, false);
    assert.equal(result.method, 'desktop-probe');
    sentinel.assertZeroConnection();
  } finally {
    sentinel.restore();
    restore();
    safeRm(home);
  }
});

test('1.4 createFollowUpDispatcher: NO TCP connection to 18488 during probeCdp', async () => {
  const sentinel = createPortSentinel(18488);
  try {
    const dispatcher = createFollowUpDispatcher({ cdpPort: 9222, timeoutMs: 80 });
    const probeRes = await dispatcher.probeCdp(9222, 50);

    assert.equal(typeof probeRes.available, 'boolean');
    assert.equal(typeof probeRes.reason, 'string');
    sentinel.assertZeroConnection();
  } finally {
    sentinel.restore();
  }
});

test('1.5 createFollowUpDispatcher: NO TCP connection to 18488 during followUp call', async () => {
  const sentinel = createPortSentinel(18488);
  try {
    const dispatcher = createFollowUpDispatcher({ cdpPort: 9222, timeoutMs: 80 });
    const prompt = packageContentBlocks('Hello adversarial challenge');
    const result = await dispatcher.followUp({ conversationId: 'c-fake-1234', prompt, timeoutMs: 50 });

    assert.equal(result.ok, false);
    sentinel.assertZeroConnection();
  } finally {
    sentinel.restore();
  }
});

test('1.6 createFollowUpDispatcher: NO TCP connection to 18488 during ignite call', async () => {
  const sentinel = createPortSentinel(18488);
  try {
    const dispatcher = createFollowUpDispatcher({ cdpPort: 9222, timeoutMs: 80 });
    const prompt = packageContentBlocks('Adversarial ignite prompt');
    const result = await dispatcher.ignite({ prompt, timeoutMs: 50, permissionMode: 'plan' });

    assert.equal(result.ok, false);
    sentinel.assertZeroConnection();
  } finally {
    sentinel.restore();
  }
});

// ══════════════════════════════════════════════════════════════════════════
// SUITE 2: MISSING SQLITE DATABASE STRESS
// ══════════════════════════════════════════════════════════════════════════

test('2.1 reportPermission: gracefully falls back to config without crashing when workbuddy.db is absent', () => {
  const emptyHome = mkdtempSync(join(tmpdir(), 'wb-empty-dir-'));
  const restore = useStressHome(emptyHome);
  try {
    // 1. Config specifies 'plan'
    const planRes = reportPermission({ permissionMode: 'plan' });
    assert.equal(planRes.known, true);
    assert.equal(planRes.current, 'plan');
    assert.equal(planRes.error, '');
    assert.equal(planRes.options.length, 3);

    // 2. Config specifies 'fullAccess'
    const fullRes = reportPermission({ permissionMode: 'fullAccess' });
    assert.equal(fullRes.known, true);
    assert.equal(fullRes.current, 'fullAccess');

    // 3. Config specifies 'default'
    const defRes = reportPermission({ permissionMode: 'default' });
    assert.equal(defRes.known, true);
    assert.equal(defRes.current, 'default');
  } finally {
    restore();
    safeRm(emptyHome);
  }
});

test('2.2 reportPermission: gracefully falls back to default when workbuddy.db is absent and config is empty', () => {
  const emptyHome = mkdtempSync(join(tmpdir(), 'wb-empty-dir-'));
  const restore = useStressHome(emptyHome);
  try {
    for (const emptyCfg of [{}, null, undefined, { permissionMode: '' }, { permissionMode: '   ' }]) {
      const res = reportPermission(emptyCfg);
      assert.equal(res.known, true);
      assert.equal(res.current, 'default', `Failed for cfg: ${JSON.stringify(emptyCfg)}`);
      assert.equal(res.error, '');
      assert.deepEqual(
        res.options.map((o) => o.id),
        ['plan', 'default', 'fullAccess'],
      );
    }
  } finally {
    restore();
    safeRm(emptyHome);
  }
});

test('2.3 makeStatusTool: executes successfully without crashing when workbuddy.db is absent', async () => {
  const emptyHome = mkdtempSync(join(tmpdir(), 'wb-empty-dir-'));
  const restore = useStressHome(emptyHome);
  try {
    const runtime = mockRuntime();
    const tool = makeStatusTool(runtime, () => ({ permissionMode: 'plan' }), {}, null, null);
    const result = await tool.execute({});

    assert.equal(result.registry, 'REGISTERED');
    assert.equal(typeof result.permission, 'object');
    assert.equal(result.permission.known, true);
    assert.equal(result.permission.current, 'plan');
    assert.equal(result.permission.error, '');
  } finally {
    restore();
    safeRm(emptyHome);
  }
});

test('2.4 makeStatusTool: dispatch.capabilities is completely deprecated and never invoked', async () => {
  const emptyHome = mkdtempSync(join(tmpdir(), 'wb-empty-dir-'));
  const restore = useStressHome(emptyHome);
  try {
    let sidecarCalled = false;
    const legacyDispatch = {
      capabilities: async () => {
        sidecarCalled = true;
        throw new Error('Sidecar must never be called!');
      },
    };

    const runtime = mockRuntime();
    const tool = makeStatusTool(runtime, () => ({}), {}, null, legacyDispatch);
    const result = await tool.execute({});

    assert.equal(sidecarCalled, false, 'makeStatusTool must never call dispatch.capabilities');
    assert.equal(result.permission.known, true);
    assert.equal(result.permission.current, 'default');
  } finally {
    restore();
    safeRm(emptyHome);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// SUITE 3: CORRUPTED SQLITE DATABASE STRESS
// ══════════════════════════════════════════════════════════════════════════

test('3.1 reportPermission & statusTool: corrupted arbitrary garbage bytes in workbuddy.db', async () => {
  const corruptHome = mkdtempSync(join(tmpdir(), 'wb-corrupt-bytes-'));
  const restore = useStressHome(corruptHome);
  try {
    const dbPath = join(corruptHome, 'workbuddy.db');
    // Overwrite with random binary and ascii garbage that is not SQLite
    writeFileSync(dbPath, 'NOT A SQLITE FILE AT ALL! GARBAGE CORRUPTION \x00\xFF\xAA\x55!@#$%^&*()_+', 'utf8');

    // 1. reportPermission must not throw, must fallback
    const perm = reportPermission({ permissionMode: 'plan' });
    assert.equal(perm.known, true);
    assert.equal(perm.current, 'plan');
    assert.equal(perm.error, '');

    // 2. statusTool.execute must not throw
    const runtime = mockRuntime();
    const tool = makeStatusTool(runtime, () => ({ permissionMode: 'plan' }), {}, null, null);
    const status = await tool.execute({});
    assert.equal(status.permission.known, true);
    assert.equal(status.permission.current, 'plan');
  } finally {
    restore();
    safeRm(corruptHome);
  }
});

test('3.2 reportPermission & statusTool: 0-byte truncated workbuddy.db file', async () => {
  const corruptHome = mkdtempSync(join(tmpdir(), 'wb-corrupt-0byte-'));
  const restore = useStressHome(corruptHome);
  try {
    const dbPath = join(corruptHome, 'workbuddy.db');
    writeFileSync(dbPath, '', 'utf8');

    const perm = reportPermission({ permissionMode: 'fullAccess' });
    assert.equal(perm.known, true);
    assert.equal(perm.current, 'fullAccess');

    const tool = makeStatusTool(mockRuntime(), () => ({ permissionMode: 'fullAccess' }), {}, null, null);
    const status = await tool.execute({});
    assert.equal(status.permission.current, 'fullAccess');
  } finally {
    restore();
    safeRm(corruptHome);
  }
});

test('3.3 reportPermission & statusTool: valid SQLite DB missing sessions table entirely', async () => {
  const corruptHome = mkdtempSync(join(tmpdir(), 'wb-no-sessions-table-'));
  const restore = useStressHome(corruptHome);
  try {
    const dbPath = join(corruptHome, 'workbuddy.db');
    const db = new DatabaseSync(dbPath);
    // Create unrelated tables, but NO sessions table
    db.exec(`CREATE TABLE unrelated_table (id TEXT PRIMARY KEY, value TEXT);`);
    db.close();

    const perm = reportPermission({ permissionMode: 'plan' });
    assert.equal(perm.known, true);
    assert.equal(perm.current, 'plan');

    const tool = makeStatusTool(mockRuntime(), () => ({ permissionMode: 'plan' }), {}, null, null);
    const status = await tool.execute({});
    assert.equal(status.permission.current, 'plan');
  } finally {
    restore();
    safeRm(corruptHome);
  }
});

test('3.4 reportPermission & statusTool: sessions table missing permission_mode column', async () => {
  const corruptHome = mkdtempSync(join(tmpdir(), 'wb-missing-perm-column-'));
  const restore = useStressHome(corruptHome);
  try {
    const dbPath = join(corruptHome, 'workbuddy.db');
    const db = new DatabaseSync(dbPath);
    // Create sessions table WITHOUT permission_mode column
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT,
        title TEXT,
        created_at INTEGER
      );
      INSERT INTO sessions (id, cwd, title, created_at) VALUES ('s1', 'D:\\repo', 'Legacy Session', 1000);
    `);
    db.close();

    const perm = reportPermission({ permissionMode: 'fullAccess' });
    assert.equal(perm.known, true);
    assert.equal(perm.current, 'fullAccess');

    const tool = makeStatusTool(mockRuntime(), () => ({ permissionMode: 'fullAccess' }), {}, null, null);
    const status = await tool.execute({});
    assert.equal(status.permission.current, 'fullAccess');
  } finally {
    restore();
    safeRm(corruptHome);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// SUITE 4: EMPTY SQLITE DATABASE STRESS
// ══════════════════════════════════════════════════════════════════════════

test('4.1 reportPermission & statusTool: empty sessions table (0 rows)', async () => {
  const home = createStressHome();
  const restore = useStressHome(home);
  try {
    // Database has schema, but sessions table is empty
    const permConfigured = reportPermission({ permissionMode: 'plan' });
    assert.equal(permConfigured.known, true);
    assert.equal(permConfigured.current, 'plan');

    const permDefault = reportPermission({});
    assert.equal(permDefault.known, true);
    assert.equal(permDefault.current, 'default');

    const tool = makeStatusTool(mockRuntime(), () => ({ permissionMode: 'plan' }), {}, null, null);
    const status = await tool.execute({});
    assert.equal(status.permission.known, true);
    assert.equal(status.permission.current, 'plan');
  } finally {
    restore();
    safeRm(home);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// SUITE 5: MULTIPLE SESSIONS PERMISSION ARBITRATION (LATEST SESSION WINS)
// ══════════════════════════════════════════════════════════════════════════

test('5.1 Chronological arbitration: strictly latest session by created_at wins', () => {
  const home = createStressHome();
  const restore = useStressHome(home);
  try {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));

    // Insert sessions with interleaved created_at order
    const stmt = db.prepare(`
      INSERT INTO sessions (id, title, permission_mode, created_at)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run('s-1', 'Session 1', 'default', 1000);
    stmt.run('s-2', 'Session 2', 'plan', 3000);
    stmt.run('s-3', 'Session 3', 'fullAccess', 2000);
    stmt.run('s-4', 'Session 4', 'default', 2500);

    // Latest created_at is s-2 (3000), which has 'plan'
    let perm = reportPermission();
    assert.equal(perm.known, true);
    assert.equal(perm.current, 'plan', 'Latest session s-2 at 3000 must win');

    // Insert newer session s-5 at 4000 with 'fullAccess'
    stmt.run('s-5', 'Session 5', 'fullAccess', 4000);
    perm = reportPermission();
    assert.equal(perm.current, 'fullAccess', 'Newer session s-5 at 4000 must win');

    // Insert newer session s-6 at 5000 with 'default'
    stmt.run('s-6', 'Session 6', 'default', 5000);
    perm = reportPermission();
    assert.equal(perm.current, 'default', 'Newer session s-6 at 5000 must win');

    db.close();
  } finally {
    restore();
    safeRm(home);
  }
});

test('5.2 Edge case values: latest session has NULL permission_mode', () => {
  const home = createStressHome();
  const restore = useStressHome(home);
  try {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const stmt = db.prepare(`
      INSERT INTO sessions (id, title, permission_mode, created_at)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run('s-old', 'Old Session', 'plan', 1000);
    // Latest session has NULL permission_mode
    stmt.run('s-null', 'Null Session', null, 2000);

    // When latest row has NULL, reportPermission falls back to config
    const permFromCfg = reportPermission({ permissionMode: 'fullAccess' });
    assert.equal(permFromCfg.current, 'fullAccess');

    const permFromDefault = reportPermission({});
    assert.equal(permFromDefault.current, 'default');

    db.close();
  } finally {
    restore();
    safeRm(home);
  }
});

test('5.3 Edge case values: latest session has empty string or whitespace permission_mode', () => {
  const home = createStressHome();
  const restore = useStressHome(home);
  try {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const stmt = db.prepare(`
      INSERT INTO sessions (id, title, permission_mode, created_at)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run('s-1', 'Session', 'fullAccess', 1000);
    stmt.run('s-whitespace', 'Space Session', '   \t\n  ', 3000);

    const perm = reportPermission({ permissionMode: 'plan' });
    assert.equal(perm.current, 'plan', 'Whitespace-only permission_mode must fall back to config');

    db.close();
  } finally {
    restore();
    safeRm(home);
  }
});

test('5.4 Edge case values: latest session has leading and trailing spaces around permission_mode', () => {
  const home = createStressHome();
  const restore = useStressHome(home);
  try {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    db.prepare(`
      INSERT INTO sessions (id, title, permission_mode, created_at)
      VALUES ('s-trimmed', 'Trimmed Session', '   plan   ', 5000)
    `).run();

    const perm = reportPermission();
    assert.equal(perm.current, 'plan', 'Must trim whitespace from permission_mode');

    db.close();
  } finally {
    restore();
    safeRm(home);
  }
});

test('5.5 High-volume session stress: 200 sessions inserted with rapid timestamps', () => {
  const home = createStressHome();
  const restore = useStressHome(home);
  try {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const modes = ['plan', 'default', 'fullAccess'];
    const insert = db.prepare(`
      INSERT INTO sessions (id, title, permission_mode, created_at)
      VALUES (?, ?, ?, ?)
    `);

    // Insert 200 sessions with ascending timestamps
    const baseTime = 1700000000000;
    for (let i = 0; i < 200; i++) {
      const mode = modes[i % 3];
      insert.run(`bulk-session-${i}`, `Title ${i}`, mode, baseTime + i * 10);
    }

    // Latest session is bulk-session-199 with index 199. 199 % 3 = 1 -> 'default'
    const perm = reportPermission();
    assert.equal(perm.known, true);
    assert.equal(perm.current, modes[199 % 3]);

    // Insert one more explicitly with 'plan'
    insert.run('bulk-session-final', 'Final', 'plan', baseTime + 10000);
    const permFinal = reportPermission();
    assert.equal(permFinal.current, 'plan');

    db.close();
  } finally {
    restore();
    safeRm(home);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// SUITE 6: END-TO-END WORKBUDDY_STATUS TOOL CONTRACT & RENDER STRESS
// ══════════════════════════════════════════════════════════════════════════

test('6.1 makeStatusTool: complete schema compliance and output fidelity', async () => {
  const home = createStressHome();
  const restore = useStressHome(home);
  try {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    db.prepare(`
      INSERT INTO sessions (id, title, permission_mode, created_at)
      VALUES ('sess-contract', 'Contract', 'plan', 1000)
    `).run();
    db.close();

    const runtime = mockRuntime();
    const config = {
      model: 'deepseek-chat',
      effort: 'high',
      sessionMode: 'per-task',
      createNewConversation: true,
      permissionMode: 'default', // DB says 'plan', DB truth must win
    };

    const tool = makeStatusTool(runtime, () => config, {}, null, null);
    const result = await tool.execute({});

    // 1. Root properties check
    assert.equal(result.registry, 'REGISTERED');
    assert.equal(result.registrationError, null);
    assert.equal(typeof result.probe, 'object');
    assert.equal(result.probe.installed, true);
    assert.equal(typeof result.config, 'object');
    assert.equal(result.config.model, 'deepseek-chat');

    // 2. Permission object contract check
    assert.equal(typeof result.permission, 'object');
    assert.equal(result.permission.known, true);
    assert.equal(result.permission.current, 'plan', 'Database truth must override config.permissionMode');
    assert.equal(result.permission.error, '');
    assert.equal(typeof result.permission.at, 'number');

    // 3. Permission options shape check
    assert.equal(result.permission.options.length, 3);
    const expectedOptions = [
      { id: 'plan', label: 'Plan (Read-Only)', description: 'Read-only inspection and analysis' },
      { id: 'default', label: 'Default', description: 'Standard interactive permissions' },
      { id: 'fullAccess', label: 'Full Access', description: 'Full filesystem access' },
    ];
    assert.deepEqual(result.permission.options, expectedOptions);

    // 4. Test render function
    const rendered = tool.output.render({}, result);
    assert.ok(Array.isArray(rendered));
    assert.equal(rendered.length, 1);
    assert.equal(rendered[0].type, 'text');
    const parsedText = JSON.parse(rendered[0].text);
    assert.equal(parsedText.permission.current, 'plan');

    // 5. Test presentCall function
    const callInfo = tool.presentCall({});
    assert.equal(typeof callInfo, 'object');
    assert.equal(callInfo.kind, 'read');
  } finally {
    restore();
    safeRm(home);
  }
});
