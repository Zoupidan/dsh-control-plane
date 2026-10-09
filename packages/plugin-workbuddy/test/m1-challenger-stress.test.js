/**
 * Milestone 1 (R1) Challenger Stress & Boundary Test Suite
 *
 * Empirical verification of:
 *   1. Boundary timeout inputs in buildPollWaits:
 *      - timeoutMs = 0 (fallback to 900_000ms -> 181 rounds)
 *      - timeoutMs = 1 (boundary <= first -> 1 round)
 *      - timeoutMs = 2_000 (boundary == first -> 1 round)
 *      - timeoutMs = 2_001 (boundary > first -> 2 rounds)
 *      - timeoutMs = 60_000 (13 rounds, sum 62_000ms)
 *      - timeoutMs = 900_000 (181 rounds, sum 902_000ms)
 *      - timeoutMs = 1_800_000 (361 rounds, sum 1_802_000ms)
 *      - Non-positive / invalid timeout inputs fallback behavior
 *   2. Legacy path preservation:
 *      - pollMs overridden without maxPollRounds -> legacy array structure, legacy: true
 *      - legacy timeout in startAutomationRun -> fails with TASK_ERROR & soft-deletes (deleted_at !== null)
 *   3. Explicit maxPollRounds override:
 *      - maxPollRounds overrides dynamic calculation from timeoutMs
 *      - maxPollRounds overrides pollMs legacy branch
 *      - invalid maxPollRounds fallback
 *   4. Polling timeout state machine invariants in startAutomationRun:
 *      - timeout NEVER updates automations.deleted_at (must remain NULL)
 *      - returns { status: 'still_running', exitCode: 0, retired: false }
 *      - mockStore.forget is never invoked
 *      - Active ongoing run (automation_runs row status 'RUNNING') timing out also preserves deleted_at NULL
 *      - Dynamic round derivation in startAutomationRun without explicit maxPollRounds
 *      - Contrast with cancellation which legitimately soft-deletes
 *
 * @module test/m1-challenger-stress.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  AUTOMATION_DEFAULTS,
  buildPollWaits,
  startAutomationRun,
  workbuddyDbPath,
} from '../src/host/gateway/automation.js';
import {
  REASON_CODES,
  isFailureCode,
} from '../src/host/launch/reason-codes.js';

const REAL_DB = join(homedir(), '.workbuddy', 'workbuddy.db');

function realAutomationCount() {
  if (!existsSync(REAL_DB)) return null;
  const db = new DatabaseSync(REAL_DB, { readOnly: true });
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM automations WHERE deleted_at IS NULL').get().n;
  } finally {
    db.close();
  }
}

function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), 'wb-challenger-stress-'));
  const db = new DatabaseSync(join(home, 'workbuddy.db'));
  db.exec(`CREATE TABLE automations (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL,
    schedule_type TEXT NOT NULL DEFAULT 'recurring', next_run_at INTEGER, last_run_at INTEGER,
    cwds TEXT NOT NULL DEFAULT '[]', rrule TEXT NOT NULL DEFAULT '', scheduled_at TEXT,
    valid_from TEXT, valid_until TEXT, model_id TEXT, model_is_thinking INTEGER NOT NULL DEFAULT 0,
    skills_json TEXT NOT NULL DEFAULT '[]', push_to_wechat INTEGER NOT NULL DEFAULT 0,
    push_to_wecom_bot INTEGER NOT NULL DEFAULT 0, owner_user_id TEXT,
    owner_status TEXT NOT NULL DEFAULT 'legacy_unassigned', owner_source TEXT,
    expert_id TEXT, expert_marketplace TEXT, connector_ids_json TEXT NOT NULL DEFAULT '[]',
    permission_mode TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
    wecom_bot_source TEXT, context_window TEXT, reasoning_effort TEXT);
    CREATE TABLE automation_runs (
    thread_id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, status TEXT NOT NULL, read_at TEXT,
    thread_title TEXT, source_cwd TEXT, runs_json TEXT, result_success INTEGER, metadata_json TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, failure_code TEXT, reason_code TEXT);
    CREATE TABLE automation_runtime_state (
    automation_id TEXT PRIMARY KEY, last_run_at INTEGER, last_error TEXT,
    running INTEGER NOT NULL DEFAULT 0, running_started_at INTEGER, running_conversation_id TEXT,
    metadata_json TEXT);
    CREATE TABLE sessions (
    id TEXT PRIMARY KEY, cwd TEXT, title TEXT, user_id TEXT, model TEXT, permission_mode TEXT,
    source_mode TEXT, is_background_automation INTEGER, session_settings TEXT, status TEXT,
    created_at INTEGER, updated_at INTEGER);
    CREATE TABLE session_usage (
    session_id TEXT PRIMARY KEY, used INTEGER, size INTEGER, credit_json TEXT);`);
  db.close();
  return home;
}

function useHome(home) {
  const previous = process.env.WORKBUDDY_HOME;
  process.env.WORKBUDDY_HOME = home;
  return () => {
    if (previous === undefined) delete process.env.WORKBUDDY_HOME;
    else process.env.WORKBUDDY_HOME = previous;
  };
}

// ---------------------------------------------------------------------------
// 1. Boundary timeout inputs: timeoutMs = 0, 1, 60_000, 900_000, 1_800_000
// ---------------------------------------------------------------------------
test('1.1 buildPollWaits boundary: timeoutMs = 0 falls back to default 900_000ms (181 rounds)', () => {
  const res = buildPollWaits({ timeoutMs: 0 });
  assert.equal(res.rounds, 181, 'timeoutMs = 0 should fall back to AUTOMATION_DEFAULTS.timeoutMs (900_000ms -> 181 rounds)');
  assert.equal(res.waits.length, 181);
  assert.equal(res.waits[0], 2_000);
  assert.ok(res.waits.slice(1).every((w) => w === 5_000));
  assert.equal(res.waits.reduce((a, b) => a + b, 0), 902_000);
  assert.equal(res.legacy, false);
});

test('1.2 buildPollWaits boundary: timeoutMs = 1 yields exactly 1 round (2000ms)', () => {
  const res = buildPollWaits({ timeoutMs: 1 });
  assert.equal(res.rounds, 1, 'timeoutMs = 1 <= first (2000) should yield exactly 1 round');
  assert.deepEqual(res.waits, [2_000]);
  assert.equal(res.legacy, false);
});

test('1.3 buildPollWaits boundary: exact first boundary (2000ms vs 2001ms)', () => {
  const atFirst = buildPollWaits({ timeoutMs: 2_000 });
  assert.equal(atFirst.rounds, 1, 'timeoutMs = 2000 <= first (2000) should yield 1 round');
  assert.deepEqual(atFirst.waits, [2_000]);

  const pastFirst = buildPollWaits({ timeoutMs: 2_001 });
  assert.equal(pastFirst.rounds, 2, 'timeoutMs = 2001 > first (2000) should yield 1 + ceil(1/5000) = 2 rounds');
  assert.deepEqual(pastFirst.waits, [2_000, 5_000]);
});

test('1.4 buildPollWaits boundary: timeoutMs = 60_000 yields 13 rounds (sum = 62_000ms)', () => {
  const res = buildPollWaits({ timeoutMs: 60_000 });
  // 1 + Math.ceil((60000 - 2000) / 5000) = 1 + 12 = 13
  assert.equal(res.rounds, 13);
  assert.equal(res.waits.length, 13);
  assert.equal(res.waits[0], 2_000);
  assert.ok(res.waits.slice(1).every((w) => w === 5_000));
  assert.equal(res.waits.reduce((a, b) => a + b, 0), 62_000);
  assert.equal(res.legacy, false);
});

test('1.5 buildPollWaits boundary: timeoutMs = 900_000 (15 min default) yields 181 rounds', () => {
  const res = buildPollWaits({ timeoutMs: 900_000 });
  // 1 + Math.ceil((900000 - 2000) / 5000) = 1 + 180 = 181
  assert.equal(res.rounds, 181);
  assert.equal(res.waits.length, 181);
  assert.equal(res.waits[0], 2_000);
  assert.ok(res.waits.slice(1).every((w) => w === 5_000));
  assert.equal(res.waits.reduce((a, b) => a + b, 0), 902_000);
  assert.equal(res.legacy, false);
});

test('1.6 buildPollWaits boundary: timeoutMs = 1_800_000 (30 min) yields 361 rounds', () => {
  const res = buildPollWaits({ timeoutMs: 1_800_000 });
  // 1 + Math.ceil((1800000 - 2000) / 5000) = 1 + 360 = 361
  assert.equal(res.rounds, 361);
  assert.equal(res.waits.length, 361);
  assert.equal(res.waits[0], 2_000);
  assert.ok(res.waits.slice(1).every((w) => w === 5_000));
  assert.equal(res.waits.reduce((a, b) => a + b, 0), 1_802_000);
  assert.equal(res.legacy, false);
});

test('1.7 buildPollWaits boundary: negative, NaN, non-finite timeoutMs fall back safely', () => {
  for (const invalid of [-1, -99999, NaN, Infinity, -Infinity, null, undefined]) {
    const res = buildPollWaits({ timeoutMs: invalid });
    assert.equal(res.rounds, 181, `timeoutMs = ${invalid} must fallback to default 181 rounds`);
    assert.equal(res.legacy, false);
  }
});

// ---------------------------------------------------------------------------
// 2. Legacy path preservation when pollMs is overridden
// ---------------------------------------------------------------------------
test('2.1 buildPollWaits legacy path: pollMs override returns legacy array structure', () => {
  const res = buildPollWaits({ pollMs: 250, timeoutMs: 2_000 });
  assert.equal(res.legacy, true, 'overriding pollMs must set legacy: true');
  assert.equal(res.rounds, 8, 'ceil(2000 / 250) = 8');
  assert.equal(res.waits.length, 8);
  assert.ok(res.waits.every((w) => w === 250), 'all waits must equal pollMs in legacy mode');
});

test('2.2 buildPollWaits legacy path: pollMs override with default timeoutMs', () => {
  const res = buildPollWaits({ pollMs: 100 });
  assert.equal(res.legacy, true);
  assert.equal(res.rounds, 9000, 'ceil(900000 / 100) = 9000');
  assert.equal(res.waits.length, 9000);
  assert.ok(res.waits.every((w) => w === 100));
});

test('2.3 startAutomationRun legacy timeout: fails and soft-deletes row (deleted_at !== null)', async () => {
  const home = fixtureHome();
  const restore = useHome(home);

  try {
    const run = startAutomationRun({
      prompt: 'LEGACY-PATH-TIMEOUT-TEST',
      cwd: 'C:\\test\\legacy',
      pollMs: 10,
      timeoutMs: 30, // 3 rounds of 10ms
    });

    const out = await run.done;
    assert.equal(out.status, 'failed', 'legacy path timeout must fail');
    assert.equal(out.exitCode, 1, 'legacy path failure must return exitCode 1');
    assert.equal(out.automation.reason, REASON_CODES.TASK_ERROR);
    assert.equal(out.automation.retired, true, 'legacy path failure must retire row');

    // Confirm that in legacy failure, deleted_at is actually set (soft-deleted)
    const db = new DatabaseSync(join(home, 'workbuddy.db'), { readOnly: true });
    try {
      const row = db.prepare('SELECT id, deleted_at FROM automations WHERE id = ?').get(out.automation.automationId);
      assert.ok(row);
      assert.ok(row.deleted_at !== null, 'legacy timeout MUST soft-delete row (deleted_at !== null)');
    } finally {
      db.close();
    }
  } finally {
    restore();
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Explicit maxPollRounds override
// ---------------------------------------------------------------------------
test('3.1 buildPollWaits: explicit maxPollRounds overrides dynamic calculation', () => {
  const res = buildPollWaits({ timeoutMs: 900_000, maxPollRounds: 7 });
  assert.equal(res.rounds, 7, 'explicit maxPollRounds: 7 must override dynamic 181 rounds');
  assert.equal(res.waits.length, 7);
  assert.equal(res.waits[0], 2_000);
  assert.ok(res.waits.slice(1).every((w) => w === 5_000));
  assert.equal(res.legacy, false);
});

test('3.2 buildPollWaits: explicit maxPollRounds overrides pollMs legacy branch', () => {
  // If caller passes both pollMs and maxPollRounds, maxPollRounds takes precedence
  const res = buildPollWaits({ pollMs: 100, maxPollRounds: 5 });
  assert.equal(res.legacy, false, 'explicit maxPollRounds prevents entering legacy path');
  assert.equal(res.rounds, 5);
  assert.equal(res.waits.length, 5);
  assert.equal(res.waits[0], 2_000);
  assert.ok(res.waits.slice(1).every((w) => w === 5_000));
});

test('3.3 buildPollWaits: invalid maxPollRounds falls back to default maxPollRounds (12)', () => {
  for (const invalid of [0, -5, NaN, 'abc', null]) {
    const res = buildPollWaits({ maxPollRounds: invalid });
    assert.equal(res.rounds, 12, `invalid maxPollRounds ${invalid} must fallback to 12`);
    assert.equal(res.waits.length, 12);
    assert.equal(res.legacy, false);
  }
});

// ---------------------------------------------------------------------------
// 4. Polling timeout state machine invariants in startAutomationRun
// ---------------------------------------------------------------------------
test('4.1 startAutomationRun timeout: deleted_at remains NULL, returns still_running, exitCode 0, retired false', async () => {
  const before = realAutomationCount();
  const home = fixtureHome();
  const restore = useHome(home);

  let forgetCalled = false;
  const mockStore = {
    adopt: () => ({ ok: true }),
    forget: () => { forgetCalled = true; },
  };

  try {
    const run = startAutomationRun({
      prompt: 'STRESS-TIMEOUT-NO-DELETE',
      cwd: 'C:\\test\\stress',
      sessionKey: 'stress-session-key',
      sessionStore: mockStore,
      timeoutMs: 60_000,
      pollFirstMs: 15,
      pollRestMs: 15,
      maxPollRounds: 3,
    });

    const out = await run.done;

    // Output contract verification
    assert.equal(out.status, 'still_running');
    assert.equal(out.exitCode, 0);
    assert.equal(out.automation.retired, false);
    assert.equal(out.automation.reason, REASON_CODES.STILL_RUNNING);
    assert.match(out.detail, /still running/i);

    // Database verification: deleted_at MUST remain NULL
    const db = new DatabaseSync(join(home, 'workbuddy.db'), { readOnly: true });
    try {
      const row = db.prepare('SELECT id, status, deleted_at FROM automations WHERE id = ?').get(out.automation.automationId);
      assert.ok(row, 'automation row must exist');
      assert.equal(row.deleted_at, null, 'automations.deleted_at MUST REMAIN NULL on timeout');
      assert.equal(row.status, 'ACTIVE');
    } finally {
      db.close();
    }

    // Session memory verification: forget MUST NOT be called
    assert.equal(forgetCalled, false, 'sessionStore.forget MUST NOT be called on still_running timeout');

    if (before !== null) assert.equal(realAutomationCount(), before, 'real DB must not be modified');
  } finally {
    restore();
    rmSync(home, { recursive: true, force: true });
  }
});

test('4.2 startAutomationRun timeout with active ongoing run: deleted_at remains NULL', async () => {
  const home = fixtureHome();
  const restore = useHome(home);

  try {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    // We will simulate a background worker inserting an automation_runs row with status 'RUNNING'
    // after ignition, then letting polling rounds exhaust
    let run;
    try {
      run = startAutomationRun({
        prompt: 'STRESS-RUNNING-TIMEOUT',
        cwd: 'C:\\test\\running',
        timeoutMs: 60_000,
        pollFirstMs: 15,
        pollRestMs: 15,
        maxPollRounds: 4,
      });

      // Insert an active run record in automation_runs table
      // Wait a tick so nextAutomationId is known
      await new Promise((r) => setTimeout(r, 5));
      const autoRow = db.prepare('SELECT id FROM automations LIMIT 1').get();
      assert.ok(autoRow, 'autoRow must exist');

      db.prepare(`INSERT INTO automation_runs (
        thread_id, automation_id, status, created_at, updated_at
      ) VALUES (?, ?, 'RUNNING', ?, ?)`).run(
        'mock-thread-101', autoRow.id, Date.now(), Date.now()
      );

      const out = await run.done;

      assert.equal(out.status, 'still_running');
      assert.equal(out.exitCode, 0);
      assert.equal(out.automation.retired, false);
      assert.equal(out.automation.reason, REASON_CODES.STILL_RUNNING);

      // Verify DB row
      const verified = db.prepare('SELECT id, deleted_at FROM automations WHERE id = ?').get(autoRow.id);
      assert.equal(verified.deleted_at, null, 'even with active run, deleted_at MUST remain NULL');

      const runRow = db.prepare('SELECT status FROM automation_runs WHERE thread_id = ?').get('mock-thread-101');
      assert.equal(runRow.status, 'RUNNING', 'automation_runs must not be modified or failed by timeout');
    } finally {
      db.close();
    }
  } finally {
    restore();
    rmSync(home, { recursive: true, force: true });
  }
});

test('4.3 startAutomationRun dynamic rounds derivation end-to-end (no explicit maxPollRounds)', async () => {
  const home = fixtureHome();
  const restore = useHome(home);

  try {
    // Provide timeoutMs = 70, pollFirstMs = 10, pollRestMs = 15
    // rounds = 1 + ceil((70 - 10) / 15) = 1 + 4 = 5 rounds
    // Total wait = 10 + 4*15 = 70ms
    const run = startAutomationRun({
      prompt: 'DYNAMIC-ROUNDS-END-TO-END',
      cwd: 'C:\\test\\dynamic',
      timeoutMs: 70,
      pollFirstMs: 10,
      pollRestMs: 15,
    });

    const out = await run.done;
    assert.equal(out.status, 'still_running');
    assert.equal(out.exitCode, 0);
    assert.equal(out.automation.retired, false);
    assert.match(out.detail, /5 poll rounds/);

    const db = new DatabaseSync(join(home, 'workbuddy.db'), { readOnly: true });
    try {
      const row = db.prepare('SELECT id, deleted_at FROM automations WHERE id = ?').get(out.automation.automationId);
      assert.ok(row);
      assert.equal(row.deleted_at, null);
    } finally {
      db.close();
    }
  } finally {
    restore();
    rmSync(home, { recursive: true, force: true });
  }
});

test('4.4 startAutomationRun cancellation vs timeout: cancellation soft-deletes, timeout does not', async () => {
  const home = fixtureHome();
  const restore = useHome(home);

  try {
    const ac = new AbortController();
    const run = startAutomationRun({
      prompt: 'CANCEL-TEST',
      cwd: 'C:\\test\\cancel',
      signal: ac.signal,
      pollFirstMs: 50,
      pollRestMs: 50,
      maxPollRounds: 10,
    });

    // Abort after 10ms
    setTimeout(() => ac.abort(), 10);
    const out = await run.done;

    assert.equal(out.status, 'failed');
    assert.equal(out.exitCode, 1);
    assert.equal(out.automation.reason, REASON_CODES.ABORTED);
    assert.equal(out.automation.retired, true, 'cancellation must retire row');

    const db = new DatabaseSync(join(home, 'workbuddy.db'), { readOnly: true });
    try {
      const row = db.prepare('SELECT id, deleted_at FROM automations WHERE id = ?').get(out.automation.automationId);
      assert.ok(row);
      assert.ok(row.deleted_at !== null, 'cancellation MUST soft-delete row (deleted_at !== null)');
    } finally {
      db.close();
    }
  } finally {
    restore();
    rmSync(home, { recursive: true, force: true });
  }
});
