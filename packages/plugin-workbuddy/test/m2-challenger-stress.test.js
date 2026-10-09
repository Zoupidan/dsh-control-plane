/**
 * Milestone 2 (R2) Challenger Stress & Boundary Test Suite
 *
 * Empirical verification of:
 *   1. harvestAutomationRun with Soft-Deleted task rows:
 *      - Completed task that was soft-deleted (deleted_at !== null)
 *      - Failed task that was soft-deleted (deleted_at !== null)
 *      - Retired/cancelled task without any run rows (runRow === null, deleted_at !== null)
 *      - Soft-deleted task with active runtime state (running === 1)
 *   2. harvestAutomationRun with Still-Running task rows:
 *      - Actively running in runtime state (running = 1, running_conversation_id)
 *      - Actively running run row (status = 'RUNNING', result_success = null) with wait budget timeout
 *      - AbortSignal interruption during harvest wait
 *      - Dynamic completion while harvestAutomationRun is actively waiting
 *   3. harvestAutomationRun with Corrupted SQLite data:
 *      - Invalid JSON syntax in metadata_json (unparseable string)
 *      - Invalid JSON syntax in runs_json (unparseable string)
 *      - Both metadata_json and runs_json corrupted simultaneously
 *      - SQL NULL values in metadata_json and runs_json
 *      - Non-object / non-array JSON primitives in metadata_json and runs_json
 *      - Corrupted cwds column in automations table
 *      - Corrupted credit_json in session_usage table
 *      - Corrupted transcript JSONL file on disk (malformed lines interspersed)
 *      - Corrupted element in runs_json (e.g. array containing null: [null])
 *   4. harvestAutomationRun with Non-Existent and Malformed automationId:
 *      - Non-existent automationId string
 *      - Empty string and whitespace-only string
 *      - Non-string types (null, undefined, number, object, array)
 *      - Single-argument invocation without explicit db handle
 *   5. workbuddy_harvest tool execution stress:
 *      - Missing automation_id parameter
 *      - Empty or whitespace automation_id
 *      - Non-string automation_id
 *      - Negative, zero, and invalid wait_ms
 *      - Null / undefined arguments to execute()
 *      - output.render() formatting across completed, still_running, failed, and edge reports
 *      - presentCall() card representation under missing/edge args
 *   6. Strict Interface Contract Compliance:
 *      - Verify return shape against PROJECT.md M2 contract on every scenario.
 *
 * @module test/m2-challenger-stress.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  extractTranscriptArtifacts,
  harvestAutomationRun,
  readReplyFromTranscript,
  slugForCwd,
  workbuddyDbPath,
} from '../src/host/gateway/automation.js';
import { makeHarvestTool, TOOL_HARVEST, workbuddy_harvest } from '../src/host/tools/harvest.js';

function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), 'wb-m2-stress-'));
  const db = new DatabaseSync(join(home, 'workbuddy.db'));
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

function safeRm(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {}
}

/**
 * Strict validator verifying every field and sub-field matches PROJECT.md M2 contract:
 * {
 *   ok: boolean;
 *   automationId: string;
 *   sessionId: string | null;
 *   status: 'completed' | 'still_running' | 'failed';
 *   reply: string | null;
 *   artifacts: string[];
 *   transcriptPath: string | null;
 *   permission: { requested: string; effective: string | null; confirmed: boolean };
 *   effort: { requested: string; effective: string | null; confirmed: boolean };
 *   model: { requested: string; effective: string | null };
 *   usage: { tokens: number; credits: number };
 * }
 */
function assertContractShape(report, msg = '') {
  const prefix = msg ? `[${msg}] ` : '';
  assert.equal(typeof report, 'object', `${prefix}report must be an object`);
  assert.notEqual(report, null, `${prefix}report must not be null`);

  assert.equal(typeof report.ok, 'boolean', `${prefix}ok must be boolean`);
  assert.equal(typeof report.automationId, 'string', `${prefix}automationId must be string`);
  assert.ok(
    report.sessionId === null || typeof report.sessionId === 'string',
    `${prefix}sessionId must be string or null, got: ${typeof report.sessionId}`,
  );
  assert.ok(
    ['completed', 'still_running', 'failed'].includes(report.status),
    `${prefix}status must be one of completed|still_running|failed, got: ${report.status}`,
  );
  assert.ok(
    report.reply === null || typeof report.reply === 'string',
    `${prefix}reply must be string or null, got: ${typeof report.reply}`,
  );
  assert.ok(
    Array.isArray(report.artifacts),
    `${prefix}artifacts must be an array, got: ${typeof report.artifacts}`,
  );
  for (const item of report.artifacts) {
    assert.equal(typeof item, 'string', `${prefix}artifact item must be string`);
  }
  assert.ok(
    report.transcriptPath === null || typeof report.transcriptPath === 'string',
    `${prefix}transcriptPath must be string or null, got: ${typeof report.transcriptPath}`,
  );

  // permission
  assert.equal(typeof report.permission, 'object', `${prefix}permission must be object`);
  assert.notEqual(report.permission, null, `${prefix}permission must not be null`);
  assert.equal(typeof report.permission.requested, 'string', `${prefix}permission.requested must be string`);
  assert.ok(
    report.permission.effective === null || typeof report.permission.effective === 'string',
    `${prefix}permission.effective must be string or null`,
  );
  assert.equal(typeof report.permission.confirmed, 'boolean', `${prefix}permission.confirmed must be boolean`);

  // effort
  assert.equal(typeof report.effort, 'object', `${prefix}effort must be object`);
  assert.notEqual(report.effort, null, `${prefix}effort must not be null`);
  assert.equal(typeof report.effort.requested, 'string', `${prefix}effort.requested must be string`);
  assert.ok(
    report.effort.effective === null || typeof report.effort.effective === 'string',
    `${prefix}effort.effective must be string or null`,
  );
  assert.equal(typeof report.effort.confirmed, 'boolean', `${prefix}effort.confirmed must be boolean`);

  // model
  assert.equal(typeof report.model, 'object', `${prefix}model must be object`);
  assert.notEqual(report.model, null, `${prefix}model must not be null`);
  assert.equal(typeof report.model.requested, 'string', `${prefix}model.requested must be string`);
  assert.ok(
    report.model.effective === null || typeof report.model.effective === 'string',
    `${prefix}model.effective must be string or null`,
  );

  // usage
  assert.equal(typeof report.usage, 'object', `${prefix}usage must be object`);
  assert.notEqual(report.usage, null, `${prefix}usage must not be null`);
  assert.equal(typeof report.usage.tokens, 'number', `${prefix}usage.tokens must be number`);
  assert.equal(typeof report.usage.credits, 'number', `${prefix}usage.credits must be number`);
}

// ============================================================================
// 1. STRESS TESTS: Soft-Deleted Task Rows (deleted_at !== null)
// ============================================================================

test('1.1 harvestAutomationRun: soft-deleted task that completed successfully', async () => {
  const home = fixtureHome();
  const restore = useHome(home);
  let db = null;
  try {
    db = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoId = 'auto-soft-deleted-completed';
    const cid = 'c1111111-2222-3333-4444-555555555555';
    const now = Date.now();

    // Row has deleted_at set (soft-deleted)
    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, schedule_type, created_at, updated_at, deleted_at, permission_mode, reasoning_effort, model_id)
      VALUES (?, 'Deleted completed', 'Run task', 'ACTIVE', 'once', ?, ?, ?, 'full', 'high', 'deepseek-chat')
    `).run(autoId, now, now, now + 1000);

    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, metadata_json, runs_json, created_at, updated_at)
      VALUES ('t-sd-1', ?, 'ACCEPTED', 1, ?, ?, ?, ?)
    `).run(
      autoId,
      JSON.stringify({ conversationId: cid }),
      JSON.stringify([{ conversationId: cid, output: 'Success after soft delete' }]),
      now, now + 500,
    );

    db.prepare(`
      INSERT INTO sessions (id, cwd, title, model, permission_mode, thought_level, created_at, updated_at)
      VALUES (?, 'D:\\repo', 'Deleted completed', 'deepseek-chat', 'full', 'high', ?, ?)
    `).run(cid, now, now + 500);

    const report = await harvestAutomationRun(db, autoId);

    assertContractShape(report, 'soft-deleted completed');
    assert.equal(report.ok, true);
    assert.equal(report.status, 'completed');
    assert.equal(report.automationId, autoId);
    assert.equal(report.sessionId, cid);
    assert.equal(report.reply, 'Success after soft delete');
    assert.equal(report.permission.confirmed, true);
    assert.equal(report.effort.confirmed, true);
  } finally {
    try { db?.close(); } catch {}
    restore();
    safeRm(home);
  }
});

test('1.2 harvestAutomationRun: soft-deleted task that failed (failure_code present)', async () => {
  const home = fixtureHome();
  const restore = useHome(home);
  let db = null;
  try {
    db = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoId = 'auto-soft-deleted-failed';
    const cid = 'c2222222-3333-4444-5555-666666666666';
    const now = Date.now();

    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, schedule_type, created_at, updated_at, deleted_at)
      VALUES (?, 'Deleted failed', 'Run task', 'ACTIVE', 'once', ?, ?, ?)
    `).run(autoId, now, now, now + 2000);

    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, failure_code, metadata_json, created_at, updated_at)
      VALUES ('t-sd-fail', ?, 'FAILED', 0, 'ERR_TIMEOUT', ?, ?, ?)
    `).run(autoId, JSON.stringify({ conversationId: cid }), now, now + 1000);

    const report = await harvestAutomationRun(db, autoId);

    assertContractShape(report, 'soft-deleted failed');
    assert.equal(report.ok, true);
    assert.equal(report.status, 'failed');
    assert.equal(report.automationId, autoId);
    assert.equal(report.sessionId, cid);
  } finally {
    try { db?.close(); } catch {}
    restore();
    safeRm(home);
  }
});

test('1.3 harvestAutomationRun: soft-deleted task with no run rows (runRow === null)', async () => {
  const home = fixtureHome();
  const restore = useHome(home);
  let db = null;
  try {
    db = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoId = 'auto-soft-deleted-no-runs';
    const now = Date.now();

    // Cancelled before ignition or cleaned up
    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, schedule_type, created_at, updated_at, deleted_at)
      VALUES (?, 'Deleted before run', 'Prompt', 'ACTIVE', 'once', ?, ?, ?)
    `).run(autoId, now, now, now + 500);

    const report = await harvestAutomationRun(db, autoId);

    assertContractShape(report, 'soft-deleted no runs');
    assert.equal(report.ok, true);
    assert.equal(report.status, 'failed');
    assert.equal(report.automationId, autoId);
    assert.equal(report.sessionId, null);
    assert.equal(report.reply, null);
    assert.deepEqual(report.artifacts, []);
  } finally {
    try { db?.close(); } catch {}
    restore();
    safeRm(home);
  }
});

test('1.4 harvestAutomationRun: soft-deleted task with active runtime state (running = 1)', async () => {
  const home = fixtureHome();
  const restore = useHome(home);
  let db = null;
  try {
    db = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoId = 'auto-soft-deleted-still-running';
    const cid = 'c3333333-4444-5555-6666-777777777777';
    const now = Date.now();

    // Task marked deleted, but worker process is still executing
    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, schedule_type, created_at, updated_at, deleted_at)
      VALUES (?, 'Deleted while running', 'Prompt', 'ACTIVE', 'once', ?, ?, ?)
    `).run(autoId, now, now, now + 100);

    db.prepare(`
      INSERT INTO automation_runtime_state (automation_id, running, running_conversation_id)
      VALUES (?, 1, ?)
    `).run(autoId, cid);

    const report = await harvestAutomationRun(db, autoId, { waitMs: 20 });

    assertContractShape(report, 'soft-deleted running');
    assert.equal(report.ok, true);
    assert.equal(report.status, 'still_running');
    assert.equal(report.automationId, autoId);
    assert.equal(report.sessionId, cid);
  } finally {
    try { db?.close(); } catch {}
    restore();
    safeRm(home);
  }
});

// ============================================================================
// 2. STRESS TESTS: Still-Running Task Rows
// ============================================================================

test('2.1 harvestAutomationRun: actively running task returns still_running with sessionId', async () => {
  const home = fixtureHome();
  const restore = useHome(home);
  let db = null;
  try {
    db = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoId = 'auto-active-running';
    const cid = 'c4444444-5555-6666-7777-888888888888';
    const now = Date.now();

    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, schedule_type, created_at, updated_at)
      VALUES (?, 'Active task', 'Prompt', 'ACTIVE', 'once', ?, ?)
    `).run(autoId, now, now);

    db.prepare(`
      INSERT INTO automation_runtime_state (automation_id, running, running_conversation_id)
      VALUES (?, 1, ?)
    `).run(autoId, cid);

    const report = await harvestAutomationRun(db, autoId, { waitMs: 30 });

    assertContractShape(report, 'active running');
    assert.equal(report.ok, true);
    assert.equal(report.status, 'still_running');
    assert.equal(report.sessionId, cid);
    assert.equal(report.reply, null);
  } finally {
    try { db?.close(); } catch {}
    restore();
    safeRm(home);
  }
});

test('2.2 harvestAutomationRun: AbortSignal interrupts wait loop immediately', async () => {
  const home = fixtureHome();
  const restore = useHome(home);
  let db = null;
  try {
    db = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoId = 'auto-abort-wait';
    const now = Date.now();

    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, schedule_type, created_at, updated_at)
      VALUES (?, 'Abort task', 'Prompt', 'ACTIVE', 'once', ?, ?)
    `).run(autoId, now, now);

    db.prepare(`
      INSERT INTO automation_runtime_state (automation_id, running)
      VALUES (?, 1)
    `).run(autoId);

    const ac = new AbortController();
    const tStart = Date.now();

    // Abort after 50ms despite a huge 10-second waitMs
    setTimeout(() => ac.abort(), 50);
    const report = await harvestAutomationRun(db, autoId, { waitMs: 10_000, signal: ac.signal });
    const elapsed = Date.now() - tStart;

    assert.ok(elapsed < 1000, `Harvest wait should abort promptly, took ${elapsed}ms`);
    assertContractShape(report, 'aborted wait');
    assert.equal(report.ok, true);
    assert.equal(report.status, 'still_running');
  } finally {
    try { db?.close(); } catch {}
    restore();
    safeRm(home);
  }
});

test('2.3 harvestAutomationRun: task completes dynamically while harvest is actively waiting', async () => {
  const home = fixtureHome();
  const restore = useHome(home);
  let db = null;
  try {
    db = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoId = 'auto-dynamic-completion';
    const cid = 'c5555555-6666-7777-8888-999999999999';
    const now = Date.now();

    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, schedule_type, created_at, updated_at)
      VALUES (?, 'Dynamic task', 'Prompt', 'ACTIVE', 'once', ?, ?)
    `).run(autoId, now, now);

    db.prepare(`
      INSERT INTO automation_runtime_state (automation_id, running, running_conversation_id)
      VALUES (?, 1, ?)
    `).run(autoId, cid);

    // After 100ms, simulate background process writing the completed runRow
    setTimeout(() => {
      try {
        db.prepare(`
          INSERT INTO automation_runs (thread_id, automation_id, status, result_success, runs_json, created_at, updated_at)
          VALUES ('t-dyn', ?, 'ACCEPTED', 1, ?, ?, ?)
        `).run(autoId, JSON.stringify([{ conversationId: cid, output: 'Finished in flight!' }]), Date.now(), Date.now());
      } catch {}
    }, 100);

    const report = await harvestAutomationRun(db, autoId, { waitMs: 1500 });

    assertContractShape(report, 'dynamic completion');
    assert.equal(report.ok, true);
    assert.equal(report.status, 'completed');
    assert.equal(report.sessionId, cid);
    assert.equal(report.reply, 'Finished in flight!');
  } finally {
    try { db?.close(); } catch {}
    restore();
    safeRm(home);
  }
});

// ============================================================================
// 3. STRESS TESTS: Corrupted SQLite JSON Data
// ============================================================================

test('3.1 harvestAutomationRun: invalid JSON syntax in metadata_json', async () => {
  const home = fixtureHome();
  const restore = useHome(home);
  let db = null;
  try {
    db = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoId = 'auto-corrupt-meta-syntax';
    const cid = 'c6666666-7777-8888-9999-000000000000';
    const now = Date.now();

    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, schedule_type, created_at, updated_at)
      VALUES (?, 'Corrupt meta', 'Prompt', 'ACTIVE', 'once', ?, ?)
    `).run(autoId, now, now);

    // metadata_json is broken JSON syntax: '{broken: json,'
    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, metadata_json, runs_json, created_at, updated_at)
      VALUES ('t-bad-meta', ?, 'ACCEPTED', 1, '{broken: json,', ?, ?, ?)
    `).run(autoId, JSON.stringify([{ conversationId: cid, output: 'Extracted from runs_json' }]), now, now);

    const report = await harvestAutomationRun(db, autoId);

    assertContractShape(report, 'corrupted metadata_json syntax');
    assert.equal(report.ok, true);
    assert.equal(report.status, 'completed');
    assert.equal(report.sessionId, cid);
    assert.equal(report.reply, 'Extracted from runs_json');
  } finally {
    try { db?.close(); } catch {}
    restore();
    safeRm(home);
  }
});

test('3.2 harvestAutomationRun: invalid JSON syntax in runs_json', async () => {
  const home = fixtureHome();
  const restore = useHome(home);
  let db = null;
  try {
    db = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoId = 'auto-corrupt-runs-syntax';
    const cid = 'c7777777-8888-9999-0000-111111111111';
    const now = Date.now();

    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, schedule_type, created_at, updated_at)
      VALUES (?, 'Corrupt runs', 'Prompt', 'ACTIVE', 'once', ?, ?)
    `).run(autoId, now, now);

    // runs_json is broken JSON syntax: '[invalid array'
    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, thread_title, metadata_json, runs_json, created_at, updated_at)
      VALUES ('t-bad-runs', ?, 'ACCEPTED', 1, 'Thread Title Fallback', ?, '[bad: syntax', ?, ?)
    `).run(autoId, JSON.stringify({ conversationId: cid }), now, now);

    const report = await harvestAutomationRun(db, autoId);

    assertContractShape(report, 'corrupted runs_json syntax');
    assert.equal(report.ok, true);
    assert.equal(report.status, 'completed');
    assert.equal(report.sessionId, cid);
    assert.equal(report.reply, 'Thread Title Fallback');
  } finally {
    try { db?.close(); } catch {}
    restore();
    safeRm(home);
  }
});

test('3.3 harvestAutomationRun: both metadata_json and runs_json corrupted simultaneously', async () => {
  const home = fixtureHome();
  const restore = useHome(home);
  let db = null;
  try {
    db = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoId = 'auto-both-corrupted';
    const now = Date.now();

    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, schedule_type, created_at, updated_at)
      VALUES (?, 'Both corrupt', 'Prompt', 'ACTIVE', 'once', ?, ?)
    `).run(autoId, now, now);

    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, metadata_json, runs_json, created_at, updated_at)
      VALUES ('t-both-bad', ?, 'ACCEPTED', 1, 'MALFORMED_META', 'MALFORMED_RUNS', ?, ?)
    `).run(autoId, now, now);

    const report = await harvestAutomationRun(db, autoId);

    assertContractShape(report, 'both corrupted');
    assert.equal(report.ok, true);
    assert.equal(report.status, 'completed');
    assert.equal(report.sessionId, null);
    assert.equal(report.reply, null);
  } finally {
    try { db?.close(); } catch {}
    restore();
    safeRm(home);
  }
});

test('3.4 harvestAutomationRun: SQL NULL values in metadata_json and runs_json', async () => {
  const home = fixtureHome();
  const restore = useHome(home);
  let db = null;
  try {
    db = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoId = 'auto-sql-nulls';
    const now = Date.now();

    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, schedule_type, created_at, updated_at)
      VALUES (?, 'Null json cols', 'Prompt', 'ACTIVE', 'once', ?, ?)
    `).run(autoId, now, now);

    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, metadata_json, runs_json, created_at, updated_at)
      VALUES ('t-nulls', ?, 'ACCEPTED', 1, NULL, NULL, ?, ?)
    `).run(autoId, now, now);

    const report = await harvestAutomationRun(db, autoId);

    assertContractShape(report, 'sql null json cols');
    assert.equal(report.ok, true);
    assert.equal(report.status, 'completed');
    assert.equal(report.sessionId, null);
    assert.equal(report.reply, null);
  } finally {
    try { db?.close(); } catch {}
    restore();
    safeRm(home);
  }
});

test('3.5 harvestAutomationRun: non-object / non-array JSON primitive values', async () => {
  const home = fixtureHome();
  const restore = useHome(home);
  let db = null;
  try {
    db = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoId = 'auto-primitive-json';
    const now = Date.now();

    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, schedule_type, cwds, created_at, updated_at)
      VALUES (?, 'Primitives', 'Prompt', 'ACTIVE', 'once', '"not an array"', ?, ?)
    `).run(autoId, now, now);

    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, metadata_json, runs_json, created_at, updated_at)
      VALUES ('t-prims', ?, 'ACCEPTED', 1, '12345', '"string instead of array"', ?, ?)
    `).run(autoId, now, now);

    const report = await harvestAutomationRun(db, autoId);

    assertContractShape(report, 'primitive json');
    assert.equal(report.ok, true);
    assert.equal(report.status, 'completed');
    assert.equal(report.sessionId, null);
  } finally {
    try { db?.close(); } catch {}
    restore();
    safeRm(home);
  }
});

test('3.6 harvestAutomationRun: corrupted cwds and session_usage.credit_json', async () => {
  const home = fixtureHome();
  const restore = useHome(home);
  let db = null;
  try {
    db = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoId = 'auto-corrupted-cwds-credits';
    const cid = 'c8888888-9999-0000-1111-222222222222';
    const now = Date.now();

    // cwds is broken syntax
    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, schedule_type, cwds, created_at, updated_at)
      VALUES (?, 'Bad cwds', 'Prompt', 'ACTIVE', 'once', '{not an array', ?, ?)
    `).run(autoId, now, now);

    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, metadata_json, created_at, updated_at)
      VALUES ('t-bad-cwds', ?, 'ACCEPTED', 1, ?, ?, ?)
    `).run(autoId, JSON.stringify({ conversationId: cid }), now, now);

    db.prepare(`
      INSERT INTO sessions (id, title, created_at, updated_at)
      VALUES (?, 'Session', ?, ?)
    `).run(cid, now, now);

    // credit_json is broken syntax
    db.prepare(`
      INSERT INTO session_usage (session_id, used, size, credit_json)
      VALUES (?, 500, 100, '{corrupted credit json')
    `).run(cid);

    const report = await harvestAutomationRun(db, autoId);

    assertContractShape(report, 'corrupted cwds and credit_json');
    assert.equal(report.ok, true);
    assert.equal(report.usage.tokens, 500);
    assert.equal(report.usage.credits, 0); // graceful fallback to 0
  } finally {
    try { db?.close(); } catch {}
    restore();
    safeRm(home);
  }
});

test('3.7 harvestAutomationRun & extractTranscript: corrupted lines in JSONL transcript on disk', async () => {
  const home = fixtureHome();
  const restore = useHome(home);
  let db = null;
  try {
    db = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoId = 'auto-corrupted-jsonl';
    const cid = 'c9999999-0000-1111-2222-333333333333';
    const cwd = 'C:\\test\\corrupt-log';
    const now = Date.now();

    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, schedule_type, cwds, created_at, updated_at)
      VALUES (?, 'Corrupt JSONL', 'Prompt', 'ACTIVE', 'once', ?, ?, ?)
    `).run(autoId, JSON.stringify([cwd]), now, now);

    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, metadata_json, created_at, updated_at)
      VALUES ('t-jsonl', ?, 'ACCEPTED', 1, ?, ?, ?)
    `).run(autoId, JSON.stringify({ conversationId: cid }), now, now);

    // Write transcript with broken lines mixed with valid lines
    const projectDir = join(home, 'projects', slugForCwd(cwd));
    mkdirSync(projectDir, { recursive: true });
    const transcriptPath = join(projectDir, `${cid}.jsonl`);
    const brokenContent = [
      '{broken line 1',
      JSON.stringify({ type: 'tool_call', input: { path: 'valid/artifact.txt' } }),
      'not even json at all',
      JSON.stringify({ type: 'message', content: [{ type: 'output_text', text: 'Valid reply among ruins' }] }),
      '{"incomplete":',
    ].join('\n') + '\n';
    writeFileSync(transcriptPath, brokenContent, 'utf8');

    const report = await harvestAutomationRun(db, autoId);

    assertContractShape(report, 'corrupted transcript JSONL');
    assert.equal(report.ok, true);
    assert.equal(report.reply, 'Valid reply among ruins');
    assert.deepEqual(report.artifacts, ['valid/artifact.txt']);
  } finally {
    try { db?.close(); } catch {}
    restore();
    safeRm(home);
  }
});

test('3.8 harvestAutomationRun: array containing null in runs_json [null]', async () => {
  const home = fixtureHome();
  const restore = useHome(home);
  let db = null;
  try {
    db = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoId = 'auto-runs-null-elem';
    const now = Date.now();

    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, schedule_type, created_at, updated_at)
      VALUES (?, 'Runs null elem', 'Prompt', 'ACTIVE', 'once', ?, ?)
    `).run(autoId, now, now);

    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, metadata_json, runs_json, created_at, updated_at)
      VALUES ('t-runs-null-elem', ?, 'ACCEPTED', 1, '{}', '[null]', ?, ?)
    `).run(autoId, now, now);

    const report = await harvestAutomationRun(db, autoId);

    assertContractShape(report, 'runs_json with [null]');
    assert.equal(report.ok, true);
    assert.equal(report.status, 'completed');
  } finally {
    try { db?.close(); } catch {}
    restore();
    safeRm(home);
  }
});

// ============================================================================
// 4. STRESS TESTS: Non-Existent and Malformed automationId
// ============================================================================

test('4.1 harvestAutomationRun: non-existent automationId string', async () => {
  const home = fixtureHome();
  const restore = useHome(home);
  let db = null;
  try {
    db = new DatabaseSync(join(home, 'workbuddy.db'));
    const report = await harvestAutomationRun(db, 'automation-ghost-404');

    assertContractShape(report, 'non-existent id');
    assert.equal(report.ok, false);
    assert.equal(report.error, 'automation_not_found');
    assert.equal(report.automationId, 'automation-ghost-404');
    assert.equal(report.status, 'failed');
    assert.equal(report.sessionId, null);
    assert.equal(report.reply, null);
    assert.deepEqual(report.artifacts, []);
  } finally {
    try { db?.close(); } catch {}
    restore();
    safeRm(home);
  }
});

test('4.2 harvestAutomationRun: empty and whitespace-only automationId', async () => {
  const home = fixtureHome();
  const restore = useHome(home);
  let db = null;
  try {
    db = new DatabaseSync(join(home, 'workbuddy.db'));

    for (const emptyId of ['', '   ', '\t\n ']) {
      const report = await harvestAutomationRun(db, emptyId);
      assertContractShape(report, `emptyId="${emptyId}"`);
      assert.equal(report.ok, false);
      assert.equal(report.error, 'invalid_automation_id');
      assert.equal(report.status, 'failed');
    }
  } finally {
    try { db?.close(); } catch {}
    restore();
    safeRm(home);
  }
});

test('4.3 harvestAutomationRun: non-string automationId types (null, undefined, number, object)', async () => {
  const home = fixtureHome();
  const restore = useHome(home);
  let db = null;
  try {
    db = new DatabaseSync(join(home, 'workbuddy.db'));

    for (const invalidId of [null, undefined, 12345, {}, []]) {
      // 2-argument overload: (db, invalidId)
      const report = await harvestAutomationRun(db, invalidId);
      assertContractShape(report, `invalidId=${String(invalidId)} (2-arg)`);
      assert.equal(report.ok, false);
      assert.equal(report.error, 'invalid_automation_id');
      assert.equal(report.status, 'failed');

      // 1-argument overload: (invalidId)
      const report1 = await harvestAutomationRun(invalidId);
      assertContractShape(report1, `invalidId=${String(invalidId)} (1-arg)`);
      assert.equal(report1.ok, false);
      assert.equal(report1.error, 'invalid_automation_id');
      assert.equal(report1.status, 'failed');
    }
  } finally {
    try { db?.close(); } catch {}
    restore();
    safeRm(home);
  }
});

test('4.4 harvestAutomationRun: single-argument overload (automationId only) using WORKBUDDY_HOME', async () => {
  const home = fixtureHome();
  const restore = useHome(home);
  let db = null;
  try {
    db = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoId = 'auto-single-arg';
    const now = Date.now();

    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, schedule_type, created_at, updated_at)
      VALUES (?, 'Single arg task', 'Prompt', 'ACTIVE', 'once', ?, ?)
    `).run(autoId, now, now);

    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, thread_title, created_at, updated_at)
      VALUES ('t-single', ?, 'ACCEPTED', 1, 'Self-managed db connection', ?, ?)
    `).run(autoId, now, now);
    db.close();
    db = null;

    // Single argument: harvestAutomationRun(autoId) opens its own connection and closes it
    const report = await harvestAutomationRun(autoId);

    assertContractShape(report, 'single-arg overload');
    assert.equal(report.ok, true);
    assert.equal(report.status, 'completed');
    assert.equal(report.reply, 'Self-managed db connection');
  } finally {
    try { db?.close(); } catch {}
    restore();
    safeRm(home);
  }
});

// ============================================================================
// 5. STRESS TESTS: workbuddy_harvest Tool Execution & Render
// ============================================================================

test('5.1 workbuddy_harvest execute: missing or invalid parameters', async () => {
  const home = fixtureHome();
  const restore = useHome(home);
  let db = null;
  try {
    db = new DatabaseSync(join(home, 'workbuddy.db'));
    const tool = makeHarvestTool(null, null, null, db);

    // Missing automation_id parameter -> schema validation error
    await assert.rejects(
      async () => tool.execute({}),
      (err) => err.code === 'INVALID_ARGS' || /automation_id/.test(err.message),
    );

    // Non-string automation_id -> schema validation error or structured error
    try {
      const res = await tool.execute({ automation_id: 12345 });
      assertContractShape(res, 'tool non-string id');
      assert.equal(res.ok, false);
      assert.equal(res.error, 'invalid_automation_id');
    } catch (err) {
      assert.ok(err.code === 'INVALID_ARGS' || /automation_id/.test(err.message));
    }
  } finally {
    try { db?.close(); } catch {}
    restore();
    safeRm(home);
  }
});

test('5.2 workbuddy_harvest execute: edge wait_ms values (negative, zero, NaN, string)', async () => {
  const home = fixtureHome();
  const restore = useHome(home);
  let db = null;
  try {
    db = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoId = 'auto-edge-wait-ms';
    const now = Date.now();

    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, schedule_type, created_at, updated_at)
      VALUES (?, 'Edge wait task', 'Prompt', 'ACTIVE', 'once', ?, ?)
    `).run(autoId, now, now);

    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, created_at, updated_at)
      VALUES ('t-edge-wait', ?, 'ACCEPTED', 1, ?, ?)
    `).run(autoId, now, now);

    const tool = makeHarvestTool(null, null, null, db);

    // Negative wait_ms
    const resNeg = await tool.execute({ automation_id: autoId, wait_ms: -1000 });
    assertContractShape(resNeg, 'negative wait_ms');
    assert.equal(resNeg.ok, true);

    // Zero wait_ms
    const resZero = await tool.execute({ automation_id: autoId, wait_ms: 0 });
    assertContractShape(resZero, 'zero wait_ms');
    assert.equal(resZero.ok, true);

    // Invalid string wait_ms (if allowed past schema)
    try {
      const resStr = await tool.execute({ automation_id: autoId, wait_ms: 'invalid' });
      assertContractShape(resStr, 'string wait_ms');
      assert.equal(resStr.ok, true);
    } catch (err) {
      assert.ok(err.code === 'INVALID_ARGS' || /wait_ms/.test(err.message));
    }
  } finally {
    try { db?.close(); } catch {}
    restore();
    safeRm(home);
  }
});

test('5.3 workbuddy_harvest output.render: handles all result states without throwing', () => {
  const tool = makeHarvestTool();

  // Completed with reply and artifacts
  const completedResult = {
    ok: true,
    automationId: 'auto-comp',
    sessionId: 'c-1',
    status: 'completed',
    reply: 'Task done successfully',
    artifacts: ['path/to/artifact1.js', 'path/to/artifact2.png'],
    transcriptPath: '/path/log.jsonl',
    permission: { requested: 'plan', effective: 'plan', confirmed: true },
    effort: { requested: 'high', effective: 'high', confirmed: true },
    model: { requested: 'v3', effective: 'v3' },
    usage: { tokens: 100, credits: 0.5 },
  };
  const r1 = tool.output.render({ automation_id: 'auto-comp' }, completedResult);
  assert.ok(Array.isArray(r1));
  assert.ok(r1[0].text.includes('Harvested automation auto-comp'));
  assert.ok(r1[0].text.includes('--- Assistant Reply ---'));
  assert.ok(r1[0].text.includes('--- Artifacts (2) ---'));

  // Still running
  const runningResult = {
    ...completedResult,
    status: 'still_running',
    reply: null,
    artifacts: [],
  };
  const r2 = tool.output.render({ automation_id: 'auto-comp' }, runningResult);
  assert.ok(Array.isArray(r2));
  assert.ok(r2[0].text.includes('status=still_running'));

  // Failed / error result
  const failedResult = {
    ok: false,
    error: 'automation_not_found',
    automationId: 'auto-miss',
    sessionId: null,
    status: 'failed',
    reply: null,
    artifacts: [],
    transcriptPath: null,
    permission: { requested: '', effective: null, confirmed: false },
    effort: { requested: '', effective: null, confirmed: false },
    model: { requested: '', effective: null },
    usage: { tokens: 0, credits: 0 },
  };
  const r3 = tool.output.render({ automation_id: 'auto-miss' }, failedResult);
  assert.ok(Array.isArray(r3));
  assert.ok(r3[0].text.includes('Failed to harvest automation auto-miss: automation_not_found'));
});

test('5.4 workbuddy_harvest presentCall: handles empty and malformed arguments safely', () => {
  const tool = makeHarvestTool();

  // Valid parameter
  const c1 = tool.presentCall({ automation_id: 'auto-123' });
  assert.equal(typeof c1, 'object');
  assert.equal(c1?.card, 'generic');
  assert.ok(c1?.title.includes('auto-123'));

  // Missing or null arguments: defineTool schema validator guards required parameter and returns undefined safely without throwing
  assert.doesNotThrow(() => {
    const c2 = tool.presentCall({});
    assert.equal(c2, undefined);
  });
  assert.doesNotThrow(() => {
    const c3 = tool.presentCall(null);
    assert.equal(c3, undefined);
  });
});
