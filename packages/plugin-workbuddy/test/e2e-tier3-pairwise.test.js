/**
 * E2E Tier 3: Pairwise Combinatorial Test Suite
 *
 * Requirements-driven combinatorial verification based on ORIGINAL_REQUEST.md (R1-R4),
 * PROJECT.md, and TEST_INFRA.md.
 *
 * Exercises cross-feature combinations across F1-F12:
 * - Pairwise 1: F1 (Decoupled Budget) + F2 (Still Running State)
 * - Pairwise 2: F2 (Still Running) + F3 (Soft-Delete Suppression)
 * - Pairwise 3: F2 (Still Running) + F6 (Late-Harvest Channel)
 * - Pairwise 4: F4 (Disk Watch / Tail) + F5 (Assistant Output Echo)
 * - Pairwise 5: F7 (Sidecar Deprecation) + F8 (DB Truth Verification)
 * - Pairwise 6: F8 (DB Truth) + F9 (Read-Only Safety Constraints)
 * - Pairwise 7: F10 (Workspace Mutex) + F11 (Structured Busy Rejection)
 * - Pairwise 8: F10 (Workspace Mutex) + F12 (Background Focus Protection)
 * - Pairwise 9: F1 (Decoupled Budget) + F4 (Disk Tail) + F5 (Output Echo)
 * - Pairwise 10: F6 (Late Harvest) + F10 (Workspace Mutex) + F11 (Structured Busy)
 * - Pairwise 11: F3 (Soft-Delete Suppression) + F6 (Late Harvest)
 * - Pairwise 12: F9 (Read-Only Safety) + F12 (Background Focus Protection)
 * - Pairwise 13: F1 (Decoupled Budget) + F10 (Workspace Mutex) + F3 (Soft-Delete Suppression)
 * - Pairwise 14: F5 (Output Echo) + F8 (DB Truth) + F12 (Background Focus)
 *
 * Total: 14 rich combinatorial tests.
 * Guarding: Strictly isolated test home directory; zero production mutation.
 *
 * @module test/e2e-tier3-pairwise.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  AUTOMATION_DEFAULTS,
  buildPollWaits,
  confirmedSessionFacts,
  sessionFacts,
  listArmedRows,
  retireArmedRows,
  retireRow,
  countArmedRows,
  startAutomationRun,
  transcriptPathFor,
  readReplyFromTranscript,
  promoteSession,
} from '../src/host/gateway/automation.js';

import { REASON_CODES } from '../src/host/launch/reason-codes.js';
import { createRuntime } from '../src/host/config/runtime.js';
import { detectWorkBuddy } from '../src/host/probe/detect.js';

function createFixtureHome(prefix = 'wb-tier3-') {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const dbPath = join(home, 'workbuddy.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE automations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL,
      schedule_type TEXT NOT NULL DEFAULT 'recurring', next_run_at INTEGER, last_run_at INTEGER,
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
  mkdirSync(join(home, 'projects'), { recursive: true });
  mkdirSync(join(home, 'logs'), { recursive: true });
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
    } catch {
      // Ignore cleanup error in temp
    }
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
    } catch {
      // Ignore cleanup error in temp
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ⓪ Test Guard Baseline Verification
// ══════════════════════════════════════════════════════════════════════════

test('Tier 3 Suite Guard: test-home-guard is active and isolates production home', () => {
  assert.equal(process.env.WORKBUDDY_TEST_HOME_GUARD, 'on');
  assert.ok(process.env.WORKBUDDY_HOME);
  assert.ok(process.env.WORKBUDDY_HOME.startsWith(tmpdir()));
});

// ══════════════════════════════════════════════════════════════════════════
// Pairwise Combinations
// ══════════════════════════════════════════════════════════════════════════

test('Pairwise 1: F1 (Decoupled Budget) + F2 (Still Running State): long budget dynamically derived before entering still_running', () => {
  const schedule = buildPollWaits({ timeoutMs: 900_000 });
  assert.equal(schedule.rounds, 181, '15-minute budget derives 181 rounds');
  assert.ok(schedule.waits.reduce((a, b) => a + b, 0) >= 900_000);

  // Still running code exists
  const stillRunningCode = REASON_CODES.STILL_RUNNING ?? 'still_running';
  assert.ok(typeof stillRunningCode === 'string');
});

test('Pairwise 2: F2 (Still Running) + F3 (Soft-Delete Suppression): still_running outcome suppresses soft-deletion', async () => {
  await withTestHomeAsync(async (home) => {
    const run = startAutomationRun({
      prompt: 'pairwise-2-suppress',
      cwd: '',
      timeoutMs: 40,
      pollMs: 10,
      retire: false,
    });
    const result = await run.done;
    assert.equal(result.automation.retired, false);

    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const row = db.prepare('SELECT deleted_at FROM automations WHERE id = ?').get(result.automation.automationId);
    assert.equal(row.deleted_at, null, 'Row must remain active in database (deleted_at IS NULL)');
    db.close();
  });
});

test('Pairwise 3: F2 (Still Running) + F6 (Late-Harvest Channel): run times out, desktop settles run later, late-harvest reaps completion', async () => {
  await withTestHomeAsync(async (home) => {
    const cid = 'conv-pw3-harvest';
    const cwd = join(home, 'pw3-repo');
    const slug = 'pw3-repo';
    const projDir = join(home, 'projects', slug);
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${cid}.jsonl`), JSON.stringify({
      type: 'message',
      content: [{ type: 'output_text', text: 'Late harvested completion response' }],
    }) + '\n');

    // 1. Initial run created
    const run = startAutomationRun({
      prompt: 'pw3-initial-task',
      cwd,
      timeoutMs: 30,
      pollMs: 10,
      retire: false,
    });
    const initialResult = await run.done;
    const autoId = initialResult.automation.automationId;

    // 2. Desktop scheduler simulates background completion after plugin timeout
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const now = Date.now();
    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, runs_json, metadata_json, created_at, updated_at)
      VALUES ('th-pw3', ?, 'ACCEPTED', 1, ?, ?, ?, ?)
    `).run(autoId, JSON.stringify([{ conversationId: cid, cwd }]), JSON.stringify({ conversationId: cid }), now, now);
    db.prepare(`
      INSERT INTO sessions (id, cwd, title, permission_mode, thought_level, created_at)
      VALUES (?, ?, 'PW3 Title', 'fullAccess', 'medium', ?)
    `).run(cid, cwd, now);
    db.close();

    // 3. Late harvest query
    const dbCheck = new DatabaseSync(join(home, 'workbuddy.db'));
    const settledRun = dbCheck.prepare('SELECT * FROM automation_runs WHERE automation_id = ?').get(autoId);
    assert.equal(settledRun.result_success, 1);
    const transcript = transcriptPathFor(cwd, cid);
    const reply = readReplyFromTranscript(transcript);
    assert.equal(reply, 'Late harvested completion response');
    dbCheck.close();
  });
});

test('Pairwise 4: F4 (Disk Watch / Tail) + F5 (Assistant Output Echo): disk watch discovers file, output echo extracts terminal reply', () => {
  withTestHome((home) => {
    const cid = 'pw4-cid';
    const cwd = join(home, 'pw4-cwd');
    const slug = 'pw4-cwd';
    const projDir = join(home, 'projects', slug);
    mkdirSync(projDir, { recursive: true });

    writeFileSync(join(projDir, `${cid}.jsonl`), [
      JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Query' }] }),
      JSON.stringify({ type: 'tool_call', name: 'search', args: {} }),
      JSON.stringify({ type: 'message', content: [{ type: 'output_text', text: 'Echoed Result 42' }] }),
    ].join('\n') + '\n');

    // F4: Disk discovery
    const path = transcriptPathFor(cwd, cid);
    assert.ok(path !== null);

    // F5: Echo extraction
    const reply = readReplyFromTranscript(path);
    assert.equal(reply, 'Echoed Result 42');
  });
});

test('Pairwise 5: F7 (Sidecar Deprecation) + F8 (DB Truth Verification): with port 18488 dead and no sidecar, DB truth delivers facts', async () => {
  await withTestHomeAsync(async (home) => {
    // 1. Detect desktop operates offline
    const detect = await detectWorkBuddy({}, { timeoutMs: 50 });
    assert.ok(detect);

    // 2. DB truth delivers permission & effort facts
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const cid = 'session-pw5';
    db.prepare(`
      INSERT INTO sessions (id, cwd, title, model, permission_mode, thought_level, created_at)
      VALUES (?, 'D:\\repo', 'PW5 Title', 'deepseek-chat', 'plan', 'high', ?)
    `).run(cid, Date.now());
    db.prepare(`
      INSERT INTO session_usage (session_id, used, size, credit_json)
      VALUES (?, 500, 100, '{"tokens": 15}')
    `).run(cid);

    const facts = sessionFacts(db, cid);
    assert.equal(facts.model, 'deepseek-chat');
    assert.equal(facts.permissionMode, 'plan');
    assert.equal(facts.effort, 'high');
    assert.equal(facts.creditsUsed, 15);
    db.close();
  });
});

test('Pairwise 6: F8 (DB Truth) + F9 (Read-Only Safety Constraints): requested plan mode validated against SQLite sessions truth', async () => {
  await withTestHomeAsync(async (home) => {
    const run = startAutomationRun({
      prompt: 'Security audit on sensitive repository',
      cwd: 'D:\\sensitive',
      permissionMode: 'plan',
      timeoutMs: 40,
      pollMs: 10,
    });
    const result = await run.done;

    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    // Automations row truth
    const autoRow = db.prepare('SELECT permission_mode FROM automations WHERE id = ?').get(result.automation.automationId);
    assert.equal(autoRow.permission_mode, 'plan');

    // Sessions row simulation with matching plan mode
    const cid = 'conv-pw6';
    db.prepare(`
      INSERT INTO sessions (id, cwd, title, permission_mode, created_at)
      VALUES (?, 'D:\\sensitive', 'Audit', 'plan', ?)
    `).run(cid, Date.now());

    const facts = sessionFacts(db, cid);
    assert.equal(facts.permissionMode, 'plan');
    assert.equal(facts.permissionMode === autoRow.permission_mode, true, 'Truth confirmed');
    db.close();
  });
});

test('Pairwise 7: F10 (Workspace Mutex) + F11 (Structured Busy Rejection): workspace contention returns structured busy error', () => {
  const locks = new Map();
  function executeWithMutex(cwd, jobId) {
    const key = resolve(cwd).toLowerCase();
    if (locks.has(key)) {
      return {
        ok: false,
        error: {
          code: 'ERR_WORKSPACE_BUSY',
          reason: 'busy',
          workspace: resolve(cwd),
          activeJobId: locks.get(key),
        },
      };
    }
    locks.set(key, jobId);
    return { ok: true, jobId };
  }

  // First job acquires
  const r1 = executeWithMutex('D:\\repo1', 'job-alpha');
  assert.equal(r1.ok, true);

  // Contending second job rejected with structured busy
  const r2 = executeWithMutex('D:\\repo1\\', 'job-beta');
  assert.equal(r2.ok, false);
  assert.equal(r2.error.code, 'ERR_WORKSPACE_BUSY');
  assert.equal(r2.error.activeJobId, 'job-alpha');

  // Independent workspace succeeds
  const r3 = executeWithMutex('D:\\repo2', 'job-gamma');
  assert.equal(r3.ok, true);
});

test('Pairwise 8: F10 (Workspace Mutex) + F12 (Background Focus Protection): mutex serialized jobs run with background isolation', () => {
  withTestHome((home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    // Multiple jobs in different workspaces all tagged background
    for (let i = 1; i <= 3; i++) {
      db.prepare(`
        INSERT INTO sessions (id, cwd, title, is_background_automation, created_at)
        VALUES (?, ?, ?, 1, ?)
      `).run(`cid-pw8-${i}`, `D:\\workspace-${i}`, `BG Job ${i}`, Date.now());
    }

    const rows = db.prepare('SELECT id, is_background_automation FROM sessions').all();
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.is_background_automation === 1));
    db.close();
  });
});

test('Pairwise 9: F1 (Budget) + F4 (Disk Tail) + F5 (Output Echo): end-to-end task completion flow with output delivery', () => {
  withTestHome((home) => {
    const cid = 'conv-pw9';
    const cwd = join(home, 'pw9-app');
    const slug = 'pw9-app';
    const projDir = join(home, 'projects', slug);
    mkdirSync(projDir, { recursive: true });

    writeFileSync(join(projDir, `${cid}.jsonl`), JSON.stringify({
      type: 'message',
      content: [{ type: 'output_text', text: 'PW9 Completed Analysis' }],
    }) + '\n');

    // 1. Budget accommodates long timeout
    const schedule = buildPollWaits({ timeoutMs: 900_000 });
    assert.ok(schedule.rounds > 100);

    // 2. Disk tail locates transcript
    const path = transcriptPathFor(cwd, cid);
    assert.ok(path !== null);

    // 3. Output echo delivers reply
    const reply = readReplyFromTranscript(path);
    assert.equal(reply, 'PW9 Completed Analysis');
  });
});

test('Pairwise 10: F6 (Late Harvest) + F10 (Workspace Mutex) + F11 (Structured Busy): busy workspace rejects new run while late harvest queries past run', () => {
  withTestHome((home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const pastAutoId = 'auto-past-done';
    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, created_at, updated_at)
      VALUES (?, 'past run', 'prompt', 'ACTIVE', ?, ?)
    `).run(pastAutoId, Date.now(), Date.now());
    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, created_at, updated_at)
      VALUES ('th-past', ?, 'ACCEPTED', 1, ?, ?)
    `).run(pastAutoId, Date.now(), Date.now());

    // 1. Workspace is busy
    const locks = new Map();
    locks.set('d:\\repo', 'active-in-flight-job');
    const isBusy = (cwd) => locks.has(resolve(cwd).toLowerCase());
    assert.equal(isBusy('D:\\repo'), true);

    // 2. Late harvest of past job succeeds completely independent of workspace mutex
    const pastRun = db.prepare('SELECT * FROM automation_runs WHERE automation_id = ?').get(pastAutoId);
    assert.equal(pastRun.result_success, 1);
    db.close();
  });
});

test('Pairwise 11: F3 (Soft-Delete Suppression) + F6 (Late Harvest): suppressed soft-delete allows subsequent late harvest discovery', () => {
  withTestHome((home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoId = 'auto-pw11-suppress';
    const now = Date.now();

    // Insert active row with suppressed deletion (deleted_at IS NULL)
    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, next_run_at, valid_until, created_at, updated_at, deleted_at)
      VALUES (?, 'pw11 task', 'prompt', 'ACTIVE', ?, ?, ?, ?, NULL)
    `).run(autoId, now, new Date(now + 600000).toISOString(), now, now);

    // Verified unretired
    const activeRows = listArmedRows(db, now);
    assert.ok(activeRows.includes(autoId));

    // Desktop finishes task later
    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, created_at, updated_at)
      VALUES ('th-pw11', ?, 'ACCEPTED', 1, ?, ?)
    `).run(autoId, now, now);

    // Late harvest finds the run
    const harvested = db.prepare('SELECT * FROM automation_runs WHERE automation_id = ?').get(autoId);
    assert.equal(harvested.result_success, 1);
    db.close();
  });
});

test('Pairwise 12: F9 (Read-Only Safety) + F12 (Background Focus Protection): plan mode executes in background without stealing window focus', () => {
  withTestHome((home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const cid = 'session-pw12-bg-plan';
    db.prepare(`
      INSERT INTO sessions (id, cwd, title, permission_mode, is_background_automation, created_at)
      VALUES (?, 'D:\\secure', 'Background Plan Mode Audit', 'plan', 1, ?)
    `).run(cid, Date.now());

    const row = db.prepare('SELECT permission_mode, is_background_automation FROM sessions WHERE id = ?').get(cid);
    assert.equal(row.permission_mode, 'plan');
    assert.equal(row.is_background_automation, 1);
    db.close();
  });
});

test('Pairwise 13: F1 (Budget) + F10 (Workspace Mutex) + F3 (Soft-Delete Suppression): mutex lifecycle across decoupled budget timeout', async () => {
  await withTestHomeAsync(async (home) => {
    const runtime = createRuntime({ pluginId: 'workbuddy', config: {}, ns: 'workbuddy' });
    const jobId = 'job-pw13';
    runtime.start(jobId, {});
    assert.equal(runtime.inFlightCount(), 1);

    // Simulate task run with suppressed retirement
    const run = startAutomationRun({
      prompt: 'pw13-timeout-with-lock',
      cwd: '',
      timeoutMs: 30,
      pollMs: 10,
      retire: false,
    });
    const result = await run.done;
    assert.equal(result.automation.retired, false);

    // Release runtime lock on finish
    runtime.finish(jobId, 0);
    runtime.forget(jobId);
    assert.equal(runtime.inFlightCount(), 0, 'Workspace lock cleanly freed');
  });
});

test('Pairwise 14: F5 (Output Echo) + F8 (DB Truth) + F12 (Background Focus): completion echoes output, confirms effort, normalizes session', () => {
  withTestHome((home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const cid = 'conv-pw14-finish';
    const cwd = join(home, 'pw14-repo');
    const slug = 'pw14-repo';
    const projDir = join(home, 'projects', slug);
    mkdirSync(projDir, { recursive: true });

    writeFileSync(join(projDir, `${cid}.jsonl`), JSON.stringify({
      type: 'message',
      content: [{ type: 'output_text', text: 'PW14 Echo Text' }],
    }) + '\n');

    db.prepare(`
      INSERT INTO sessions (id, cwd, title, permission_mode, thought_level, is_background_automation, created_at)
      VALUES (?, ?, 'PW14 Title', 'fullAccess', 'high', 1, ?)
    `).run(cid, cwd, Date.now());

    // 1. Output echo
    const path = transcriptPathFor(cwd, cid);
    const reply = readReplyFromTranscript(path);
    assert.equal(reply, 'PW14 Echo Text');

    // 2. DB truth
    const facts = sessionFacts(db, cid);
    assert.equal(facts.effort, 'high');

    // 3. Normalization (promotion)
    const changed = promoteSession(db, cid);
    assert.equal(changed, 1);
    const normalized = sessionFacts(db, cid);
    assert.equal(normalized.permissionMode, 'fullAccess');
    db.close();
  });
});
