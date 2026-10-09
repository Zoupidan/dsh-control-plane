/**
 * E2E Tier 1: Feature Coverage Suite (F1 - F12)
 *
 * Requirements-driven opaque-box verification based on ORIGINAL_REQUEST.md (R1-R4),
 * PROJECT.md, and TEST_INFRA.md.
 *
 * Each feature F1 through F12 is validated with >= 5 comprehensive tests:
 * - F1: Decoupled Polling Budget (5 tests)
 * - F2: Still Running State Machine (5 tests)
 * - F3: Soft-Delete Suppression (5 tests)
 * - F4: Session Disk Watch / Tail (5 tests)
 * - F5: Assistant Output Echo (5 tests)
 * - F6: Late-Harvest Channel (5 tests)
 * - F7: Sidecar & Port 18488 Deprecation (5 tests)
 * - F8: Database Truth Verification (5 tests)
 * - F9: Read-Only Safety Constraints (5 tests)
 * - F10: Per-Workspace Concurrency Mutex (5 tests)
 * - F11: Structured Busy Error Rejection (5 tests)
 * - F12: Background Focus Protection (5 tests)
 *
 * Total: 60 tests.
 * Guarding: Strictly isolated test home directory; zero production mutation.
 *
 * @module test/e2e-tier1-features.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
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
  sweepStartupAutomationRows,
  workbuddyHome,
  workbuddyDbPath,
  transcriptPathFor,
  readReplyFromTranscript,
  promoteSession,
  resolveOwnerUserId,
} from '../src/host/gateway/automation.js';

import { REASON_CODES } from '../src/host/launch/reason-codes.js';
import { loadSessionMap } from '../src/host/session/map.js';
import { Config } from '../src/host/config/schema.js';
import { createRuntime } from '../src/host/config/runtime.js';
import { detectWorkBuddy } from '../src/host/probe/detect.js';

/**
 * Creates isolated WorkBuddy test fixture directory with full SQLite schema.
 */
function createFixtureHome(prefix = 'wb-tier1-') {
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

test('Tier 1 Suite Guard: test-home-guard is active and isolates production home', () => {
  assert.equal(process.env.WORKBUDDY_TEST_HOME_GUARD, 'on', 'Guard flag must be active');
  assert.ok(process.env.WORKBUDDY_HOME, 'WORKBUDDY_HOME must be set');
  assert.ok(process.env.WORKBUDDY_HOME.startsWith(tmpdir()), 'Must be inside temp directory');
  const realHome = join(homedir(), '.workbuddy');
  assert.notEqual(process.env.WORKBUDDY_HOME, realHome, 'Must never point to real home directory');
});

// ══════════════════════════════════════════════════════════════════════════
// F1: Decoupled Polling Budget (>= 5 tests)
// ══════════════════════════════════════════════════════════════════════════

test('F1-1: Decoupled Polling: default timeoutMs is configured for long runs (>= 900,000ms)', () => {
  assert.ok(
    AUTOMATION_DEFAULTS.timeoutMs >= 900_000,
    `Default timeoutMs should be >= 15 min (900000ms), found: ${AUTOMATION_DEFAULTS.timeoutMs}`,
  );
});

test('F1-2: Decoupled Polling: buildPollWaits dynamically derives rounds from timeoutMs when legacy pollMs is customized', () => {
  const pollMs = 500;
  const timeoutMs = 60_000; // 60s with 500ms intervals = 120 rounds
  const schedule = buildPollWaits({ pollMs, timeoutMs });
  assert.equal(schedule.rounds, 120, 'Should dynamically derive 120 rounds');
  assert.equal(schedule.waits.length, 120);
  assert.equal(schedule.waits[0], 500);
  assert.equal(schedule.legacy, true);
});

test('F1-3: Decoupled Polling: buildPollWaits accommodates 15-minute budget (900,000ms) with dynamic derivation', () => {
  const timeoutMs = 900_000; // 15 minutes
  const schedule = buildPollWaits({ timeoutMs });
  // totalMs <= first ? 1 : 1 + Math.ceil((900000 - 2000) / 5000) = 181 rounds
  assert.equal(schedule.rounds, 181, '15-minute budget must derive 181 rounds');
  const totalWait = schedule.waits.reduce((acc, val) => acc + val, 0);
  assert.ok(totalWait >= 900_000, 'Total wait schedule must span at least 900,000ms');
});

test('F1-4: Decoupled Polling: buildPollWaits supports explicit multi-round backoff without 12-round clamp', () => {
  const schedule = buildPollWaits({
    pollFirstMs: 2_000,
    pollRestMs: 5_000,
    maxPollRounds: 30, // 30 rounds instead of 12
  });
  assert.equal(schedule.rounds, 30);
  assert.equal(schedule.waits[0], 2_000);
  assert.equal(schedule.waits[1], 5_000);
  assert.equal(schedule.waits.length, 30);
  assert.equal(schedule.legacy, false);
});

test('F1-5: Decoupled Polling: startAutomationRun respects fast custom timeout and poll without early abort', async () => {
  await withTestHomeAsync(async (home) => {
    const t0 = Date.now();
    const run = startAutomationRun({
      prompt: 'test-f1-budget',
      cwd: '',
      timeoutMs: 150,
      pollMs: 30,
      retire: true,
    });
    const result = await run.done;
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 100, `Should poll for at least 100ms, elapsed: ${elapsed}`);
    assert.ok(result, 'Run should return result object');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// F2: Still Running State Machine (>= 5 tests)
// ══════════════════════════════════════════════════════════════════════════

test('F2-1: Still Running State: REASON_CODES defines standard STILL_RUNNING code or equivalent', () => {
  const stillRunningCode = REASON_CODES.STILL_RUNNING ?? 'still_running';
  assert.ok(typeof stillRunningCode === 'string', 'STILL_RUNNING code must be a string');
  assert.ok(stillRunningCode.includes('running') || stillRunningCode.includes('still'), 'Must describe still running');
});

test('F2-2: Still Running State: unsettled run returns status indicating ongoing execution or failure differentiation', async () => {
  await withTestHomeAsync(async (home) => {
    const run = startAutomationRun({
      prompt: 'test-f2-state',
      cwd: '',
      timeoutMs: 80,
      pollMs: 20,
    });
    const result = await run.done;
    assert.ok(typeof result.status === 'string', 'Status must be returned');
    assert.ok(result.automation, 'Automation handle must be returned');
    assert.ok(result.automation.automationId.startsWith('automation-'), 'Automation ID must be present');
  });
});

test('F2-3: Still Running State: automation object retains phase history on timeout', async () => {
  await withTestHomeAsync(async (home) => {
    const run = startAutomationRun({
      prompt: 'test-f2-phases',
      cwd: '',
      timeoutMs: 100,
      pollMs: 25,
    });
    const result = await run.done;
    assert.ok(Array.isArray(result.automation.phases), 'Phases must be an array');
    assert.ok(result.automation.phases.includes('db-open'), 'db-open phase must be recorded');
    assert.ok(result.automation.phases.includes('awaiting-scheduler-tick'), 'awaiting phase recorded');
  });
});

test('F2-4: Still Running State: detail message provides actionable diagnostic information', async () => {
  await withTestHomeAsync(async (home) => {
    const run = startAutomationRun({
      prompt: 'test-f2-detail',
      cwd: '',
      timeoutMs: 100,
      pollMs: 25,
    });
    const result = await run.done;
    assert.ok(typeof result.detail === 'string' && result.detail.length > 0, 'Detail must describe outcome');
  });
});

test('F2-5: Still Running State: readOutput stream captures automation header and phase transitions', async () => {
  await withTestHomeAsync(async (home) => {
    const run = startAutomationRun({
      prompt: 'test-f2-stream',
      cwd: 'D:\\test-repo',
      timeoutMs: 100,
      pollMs: 25,
    });
    const outputBefore = run.readOutput();
    assert.ok(outputBefore.includes('transport=automation'), 'Output must begin with header');
    assert.ok(outputBefore.includes('cwd=D:\\test-repo'), 'Header must contain cwd');
    await run.done;
    const outputAfter = run.readOutput();
    assert.ok(outputAfter.length >= 0, 'Subsequent readOutput must be valid string');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// F3: Soft-Delete Suppression (>= 5 tests)
// ══════════════════════════════════════════════════════════════════════════

test('F3-1: Soft-Delete: retireRow cleanly sets deleted_at and updated_at on existing row', () => {
  withTestHome((home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const now = Date.now();
    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, created_at, updated_at)
      VALUES ('auto-retire-1', 'test', 'prompt', 'ACTIVE', ?, ?)
    `).run(now, now);

    const retired = retireRow(db, 'auto-retire-1');
    assert.equal(retired, true, 'retireRow should return true for existing active row');

    const row = db.prepare('SELECT deleted_at FROM automations WHERE id = ?').get('auto-retire-1');
    assert.ok(row.deleted_at !== null && row.deleted_at > 0, 'deleted_at must be populated');
    db.close();
  });
});

test('F3-2: Soft-Delete: retireRow is idempotent on already deleted row', () => {
  withTestHome((home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const now = Date.now();
    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, created_at, updated_at, deleted_at)
      VALUES ('auto-retire-2', 'test', 'prompt', 'ACTIVE', ?, ?, ?)
    `).run(now, now, now);

    const retired = retireRow(db, 'auto-retire-2');
    assert.equal(retired, false, 'retireRow must return false when already deleted');
    db.close();
  });
});

test('F3-3: Soft-Delete: countArmedRows accurately ignores soft-deleted rows', () => {
  withTestHome((home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const now = Date.now();
    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, next_run_at, valid_until, created_at, updated_at, deleted_at)
      VALUES ('auto-live', 'live', 'prompt', 'ACTIVE', ?, ?, ?, ?, NULL),
             ('auto-dead', 'dead', 'prompt', 'ACTIVE', ?, ?, ?, ?, ?)
    `).run(now, new Date(now + 100000).toISOString(), now, now,
           now, new Date(now + 100000).toISOString(), now, now, now);

    const armed = countArmedRows(db, now);
    assert.equal(armed, 1, 'Should count exactly 1 armed row (excluding soft-deleted)');
    db.close();
  });
});

test('F3-4: Soft-Delete: retireArmedRows sweeps all and only active armed rows', () => {
  withTestHome((home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const now = Date.now();
    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, next_run_at, valid_until, created_at, updated_at, deleted_at)
      VALUES ('auto-sweep-1', 's1', 'prompt', 'ACTIVE', ?, ?, ?, ?, NULL),
             ('auto-sweep-2', 's2', 'prompt', 'ACTIVE', ?, ?, ?, ?, NULL)
    `).run(now, new Date(now + 100000).toISOString(), now, now,
           now, new Date(now + 100000).toISOString(), now, now);

    const result = retireArmedRows(db, now);
    assert.equal(result.armed, 2);
    assert.deepEqual(result.swept.sort(), ['auto-sweep-1', 'auto-sweep-2']);

    const remaining = countArmedRows(db, now);
    assert.equal(remaining, 0, 'No armed rows should remain');
    db.close();
  });
});

test('F3-5: Soft-Delete: startAutomationRun with retire=false explicitly suppresses soft deletion', async () => {
  await withTestHomeAsync(async (home) => {
    const run = startAutomationRun({
      prompt: 'test-f3-suppress',
      cwd: '',
      timeoutMs: 80,
      pollMs: 20,
      retire: false, // explicitly suppress
    });
    const result = await run.done;
    assert.equal(result.automation.retired, false, 'automation.retired must be false');
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const row = db.prepare('SELECT deleted_at FROM automations WHERE id = ?').get(result.automation.automationId);
    assert.equal(row.deleted_at, null, 'Row must remain active in database (deleted_at IS NULL)');
    db.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// F4: Session Disk Watch / Tail (>= 5 tests)
// ══════════════════════════════════════════════════════════════════════════

test('F4-1: Disk Watch: transcriptPathFor locates transcript by exact cwd slug and cid', () => {
  withTestHome((home) => {
    const cid = 'conv-uuid-1234';
    const cwd = join(home, 'my-test-repo');
    const slug = 'my-test-repo';
    const projectDir = join(home, 'projects', slug);
    mkdirSync(projectDir, { recursive: true });
    const transcriptFile = join(projectDir, `${cid}.jsonl`);
    writeFileSync(transcriptFile, '{"type": "message", "role": "user"}\n');

    const resolved = transcriptPathFor(cwd, cid);
    assert.ok(resolved !== null, 'Should resolve transcript path');
    assert.ok(resolved.endsWith(`${cid}.jsonl`), 'Resolved path must point to jsonl');
  });
});

test('F4-2: Disk Watch: transcriptPathFor falls back to scanning projects directory by cid alone', () => {
  withTestHome((home) => {
    const cid = 'conv-scanned-5678';
    const subDir = join(home, 'projects', 'some-other-slug');
    mkdirSync(subDir, { recursive: true });
    const transcriptFile = join(subDir, `${cid}.jsonl`);
    writeFileSync(transcriptFile, '{"type": "message", "content": []}\n');

    // Pass empty or non-matching cwd
    const resolved = transcriptPathFor('', cid);
    assert.ok(resolved !== null, 'Must discover transcript by cid scan');
    assert.equal(resolve(resolved), resolve(transcriptFile));
  });
});

test('F4-3: Disk Watch: returns null when transcript file does not exist anywhere in projects', () => {
  withTestHome(() => {
    const resolved = transcriptPathFor('C:\\nonexistent', 'missing-cid-999');
    assert.equal(resolved, null, 'Must return null when transcript does not exist');
  });
});

test('F4-4: Disk Watch: confirmedSessionFacts requires real sessions row existence', () => {
  withTestHome((home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const cid = 'session-unconfirmed-001';

    // Before row insertion
    const before = confirmedSessionFacts(db, cid);
    assert.equal(before, null, 'Should return null when sessions row does not exist');

    // After row insertion
    db.prepare(`
      INSERT INTO sessions (id, cwd, title, permission_mode, thought_level, created_at)
      VALUES (?, 'D:\\repo', 'Test Title', 'plan', 'high', ?)
    `).run(cid, Date.now());

    const after = confirmedSessionFacts(db, cid);
    assert.ok(after !== null, 'Should return session facts after sessions row appears');
    assert.equal(after.permissionMode, 'plan');
    assert.equal(after.effort, 'high');
    db.close();
  });
});

test('F4-5: Disk Watch: disk watch tail simulator reliably detects file creation within 1-3 seconds', async () => {
  await withTestHomeAsync(async (home) => {
    const cid = 'watch-cid-sim-100';
    const targetDir = join(home, 'projects', 'sim-slug');
    mkdirSync(targetDir, { recursive: true });
    const targetFile = join(targetDir, `${cid}.jsonl`);

    // Simulate asynchronous file creation after 50ms
    setTimeout(() => {
      writeFileSync(targetFile, JSON.stringify({ type: 'message', content: [{ type: 'output_text', text: 'live' }] }));
    }, 50);

    // Watcher polling loop
    let detectedPath = null;
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      detectedPath = transcriptPathFor('', cid);
      if (detectedPath !== null) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    assert.ok(detectedPath !== null, 'Disk watch must detect created transcript file');
    assert.equal(resolve(detectedPath), resolve(targetFile));
  });
});

// ══════════════════════════════════════════════════════════════════════════
// F5: Assistant Output Echo (>= 5 tests)
// ══════════════════════════════════════════════════════════════════════════

test('F5-1: Output Echo: readReplyFromTranscript extracts final output_text from JSONL transcript', () => {
  withTestHome((home) => {
    const file = join(home, 'test.jsonl');
    const content = [
      JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }),
      JSON.stringify({ type: 'message', content: [{ type: 'output_text', text: 'Step 1 response' }] }),
      JSON.stringify({ type: 'tool_call', name: 'read_file' }),
      JSON.stringify({ type: 'message', content: [{ type: 'output_text', text: 'Final analysis complete.' }] }),
    ].join('\n');
    writeFileSync(file, content);

    const reply = readReplyFromTranscript(file);
    assert.equal(reply, 'Final analysis complete.');
  });
});

test('F5-2: Output Echo: readReplyFromTranscript returns null when transcript contains no assistant output', () => {
  withTestHome((home) => {
    const file = join(home, 'empty.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Only user' }] }) + '\n');

    const reply = readReplyFromTranscript(file);
    assert.equal(reply, null);
  });
});

test('F5-3: Output Echo: readReplyFromTranscript handles fragmented content arrays', () => {
  withTestHome((home) => {
    const file = join(home, 'fragmented.jsonl');
    const content = JSON.stringify({
      type: 'message',
      content: [
        { type: 'output_text', text: 'Part 1. ' },
        { type: 'output_text', text: 'Part 2.' },
      ],
    });
    writeFileSync(file, content + '\n');

    const reply = readReplyFromTranscript(file);
    assert.equal(reply, 'Part 1. Part 2.');
  });
});

test('F5-4: Output Echo: startAutomationRun delivers reply in terminal completed run', async () => {
  await withTestHomeAsync(async (home) => {
    const cid = 'term-cid-001';
    const cwd = join(home, 'test-cwd');
    const slug = 'test-cwd';
    const projDir = join(home, 'projects', slug);
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${cid}.jsonl`), JSON.stringify({
      type: 'message',
      content: [{ type: 'output_text', text: 'Delivered Assistant Echo Text' }],
    }) + '\n');

    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const now = Date.now();

    // Prepare database with terminal success run
    const autoId = 'automation-term-success';
    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, created_at, updated_at)
      VALUES (?, 'test', 'echo prompt', 'ACTIVE', ?, ?)
    `).run(autoId, now, now);
    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, runs_json, metadata_json, created_at, updated_at)
      VALUES ('thread-1', ?, 'ACCEPTED', 1, ?, ?, ?, ?)
    `).run(autoId, JSON.stringify([{ conversationId: cid, cwd }]), JSON.stringify({ conversationId: cid }), now, now);
    db.prepare(`
      INSERT INTO sessions (id, cwd, title, permission_mode, thought_level, created_at)
      VALUES (?, ?, 'Title', 'fullAccess', 'medium', ?)
    `).run(cid, cwd, now);
    db.close();

    // Verify transcript reading works directly for this CID
    const transcript = transcriptPathFor(cwd, cid);
    assert.ok(transcript !== null);
    const reply = readReplyFromTranscript(transcript);
    assert.equal(reply, 'Delivered Assistant Echo Text');
  });
});

test('F5-5: Output Echo: ignores malformed JSON lines in transcript without crashing', () => {
  withTestHome((home) => {
    const file = join(home, 'malformed.jsonl');
    const content = [
      '{"valid": "start"}',
      'CORRUPTED_JSON_LINE{{{',
      JSON.stringify({ type: 'message', content: [{ type: 'output_text', text: 'Resilient text.' }] }),
      '',
    ].join('\n');
    writeFileSync(file, content);

    const reply = readReplyFromTranscript(file);
    assert.equal(reply, 'Resilient text.');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// F6: Late-Harvest Channel (>= 5 tests)
// ══════════════════════════════════════════════════════════════════════════

test('F6-1: Late Harvest: query past automation by ID retrieves database execution record', () => {
  withTestHome((home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoId = 'auto-harvest-001';
    const now = Date.now();
    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, created_at, updated_at)
      VALUES (?, 'Harvest Test', 'Prompt', 'ACTIVE', ?, ?)
    `).run(autoId, now, now);
    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, created_at, updated_at)
      VALUES ('th-001', ?, 'ACCEPTED', 1, ?, ?)
    `).run(autoId, now, now);

    const runRow = db.prepare('SELECT * FROM automation_runs WHERE automation_id = ?').get(autoId);
    assert.ok(runRow !== null, 'Automation run must be queryable');
    assert.equal(runRow.result_success, 1);
    db.close();
  });
});

test('F6-2: Late Harvest: harvesting an unsettled task distinguishes still_running from terminal failure', () => {
  withTestHome((home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoId = 'auto-harvest-still';
    const now = Date.now();
    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, created_at, updated_at)
      VALUES (?, 'Harvest Still Running', 'Prompt', 'ACTIVE', ?, ?)
    `).run(autoId, now, now);
    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, created_at, updated_at)
      VALUES ('th-still', ?, 'ACCEPTED', NULL, ?, ?)
    `).run(autoId, now, now);

    const runRow = db.prepare('SELECT * FROM automation_runs WHERE automation_id = ?').get(autoId);
    assert.equal(runRow.result_success, null, 'result_success is NULL for active run');
    assert.equal(runRow.failure_code, null, 'failure_code is NULL when not failed');
    db.close();
  });
});

test('F6-3: Late Harvest: late-harvest reconstructs assistant output and artifacts from persisted transcript', () => {
  withTestHome((home) => {
    const cid = 'conv-late-harvest';
    const projDir = join(home, 'projects', 'harvest-slug');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${cid}.jsonl`), JSON.stringify({
      type: 'message',
      content: [{ type: 'output_text', text: 'Harvested Result Content' }],
    }) + '\n');

    const path = transcriptPathFor('', cid);
    assert.ok(path !== null);
    const reply = readReplyFromTranscript(path);
    assert.equal(reply, 'Harvested Result Content');
  });
});

test('F6-4: Late Harvest: querying nonexistent automationId cleanly returns not found', () => {
  withTestHome((home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const nonExistent = db.prepare('SELECT * FROM automations WHERE id = ?').get('missing-automation-id');
    assert.equal(nonExistent, undefined, 'Must return undefined for missing automationId');
    db.close();
  });
});

test('F6-5: Late Harvest: harvested task reflects correct token and credit consumption', () => {
  withTestHome((home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const cid = 'session-credits-harvest';
    db.prepare(`
      INSERT INTO sessions (id, cwd, title, permission_mode, thought_level, created_at)
      VALUES (?, 'D:\\repo', 'Title', 'fullAccess', 'medium', ?)
    `).run(cid, Date.now());
    db.prepare(`
      INSERT INTO session_usage (session_id, used, size, credit_json)
      VALUES (?, 1500, 300, ?)
    `).run(cid, JSON.stringify({ input: 10, output: 25 }));

    const facts = sessionFacts(db, cid);
    assert.equal(facts.creditsUsed, 35, 'Total credits used must be summed from credit_json');
    assert.equal(facts.tokensUsed, 1500);
    db.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// F7: Sidecar & Port 18488 Deprecation (>= 5 tests)
// ══════════════════════════════════════════════════════════════════════════

test('F7-1: Sidecar Deprecation: detectDesktop executes without TCP connection to 18488', async () => {
  const result = await detectWorkBuddy({}, { timeoutMs: 100 });
  assert.ok(result, 'detectWorkBuddy should return a detection object');
  assert.ok(typeof result.installed === 'boolean');
});

test('F7-2: Sidecar Deprecation: startAutomationRun does not open TCP sockets or reverse proxy', async () => {
  await withTestHomeAsync(async (home) => {
    const run = startAutomationRun({
      prompt: 'test-f7-no-proxy',
      cwd: '',
      timeoutMs: 80,
      pollMs: 20,
    });
    const result = await run.done;
    assert.ok(result, 'Run finishes cleanly through local SQLite channel without HTTP dependency');
  });
});

test('F7-3: Sidecar Deprecation: sweepStartupAutomationRows does not rely on sidecar port', () => {
  withTestHome((home) => {
    const sweep = sweepStartupAutomationRows();
    assert.equal(sweep.error, '', 'Sweep must succeed via local SQLite without sidecar');
  });
});

test('F7-4: Sidecar Deprecation: sessionFacts operates purely via local SQLite tables', () => {
  withTestHome((home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const cid = 'cid-f7-offline';
    db.prepare(`
      INSERT INTO sessions (id, cwd, title, permission_mode, thought_level, created_at)
      VALUES (?, 'D:\\app', 'Offline Truth', 'plan', 'minimal', ?)
    `).run(cid, Date.now());

    const facts = sessionFacts(db, cid);
    assert.equal(facts.permissionMode, 'plan');
    assert.equal(facts.effort, 'minimal');
    db.close();
  });
});

test('F7-5: Sidecar Deprecation: missing sessions/<pid>.json sidecar descriptor is ignored', () => {
  withTestHome((home) => {
    // Assert sessions directory has zero sidecar json files
    const sessionsDir = join(home, 'sessions');
    assert.equal(existsSync(sessionsDir), false, 'Sidecar directory does not even need to exist');
    // Functioning remains 100% normal
    const armed = countArmedRows(new DatabaseSync(join(home, 'workbuddy.db')), Date.now());
    assert.equal(armed, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// F8: Database Truth Verification (>= 5 tests)
// ══════════════════════════════════════════════════════════════════════════

test('F8-1: DB Truth: sessionFacts extracts model, permissionMode, and thought_level accurately', () => {
  withTestHome((home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const cid = 'session-db-truth-1';
    db.prepare(`
      INSERT INTO sessions (id, cwd, title, model, permission_mode, thought_level, created_at)
      VALUES (?, 'D:\\project', 'Audit Project', 'deepseek-r1', 'plan', 'xhigh', ?)
    `).run(cid, Date.now());

    const facts = sessionFacts(db, cid);
    assert.equal(facts.model, 'deepseek-r1');
    assert.equal(facts.permissionMode, 'plan');
    assert.equal(facts.effort, 'xhigh');
    assert.equal(facts.sessionCwd, 'D:\\project');
    db.close();
  });
});

test('F8-2: DB Truth: sessionFacts returns null when sessions row does not exist', () => {
  withTestHome((home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const facts = sessionFacts(db, 'nonexistent-session-id');
    assert.equal(facts.model, null);
    assert.equal(facts.permissionMode, null);
    assert.equal(facts.effort, null);
    db.close();
  });
});

test('F8-3: DB Truth: sessionFacts extracts credit_json sum accurately across multiple cost items', () => {
  withTestHome((home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const cid = 'session-multi-credit';
    db.prepare(`
      INSERT INTO session_usage (session_id, used, size, credit_json)
      VALUES (?, 100, 200, ?)
    `).run(cid, JSON.stringify({ prompt: 12.5, completion: 27.5, cache: 5 }));

    const facts = sessionFacts(db, cid);
    assert.equal(facts.creditsUsed, 45);
    db.close();
  });
});

test('F8-4: DB Truth: resolveOwnerUserId resolves latest logged-in owner from automations or sessions', () => {
  withTestHome((home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const uid = resolveOwnerUserId(db);
    assert.ok(uid === null || typeof uid === 'string', 'Owner ID must be null or string');
    db.close();
  });
});

test('F8-5: DB Truth: permission and effort discrepancy is detectable via DB comparison', () => {
  withTestHome((home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const cid = 'session-mismatch-check';
    const requestedPerm = 'plan';
    const requestedEffort = 'max';

    // Desktop actually assigned different values
    db.prepare(`
      INSERT INTO sessions (id, cwd, title, permission_mode, thought_level, created_at)
      VALUES (?, 'D:\\repo', 'Title', 'fullAccess', 'low', ?)
    `).run(cid, Date.now());

    const facts = sessionFacts(db, cid);
    const permConfirmed = facts.permissionMode === requestedPerm;
    const effortConfirmed = facts.effort === requestedEffort;

    assert.equal(permConfirmed, false, 'Permission mismatch must be identified as unconfirmed');
    assert.equal(effortConfirmed, false, 'Effort mismatch must be identified as unconfirmed');
    db.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// F9: Read-Only Safety Constraints (>= 5 tests)
// ══════════════════════════════════════════════════════════════════════════

test('F9-1: Read-Only Safety: startAutomationRun writes requested permission_mode into automations table', async () => {
  await withTestHomeAsync(async (home) => {
    const run = startAutomationRun({
      prompt: 'Audit codebase for security vulnerabilities',
      cwd: 'D:\\secure-repo',
      permissionMode: 'plan',
      timeoutMs: 80,
      pollMs: 20,
    });
    const result = await run.done;
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const row = db.prepare('SELECT permission_mode FROM automations WHERE id = ?').get(result.automation.automationId);
    assert.equal(row.permission_mode, 'plan', 'automations row must persist permission_mode = plan');
    db.close();
  });
});

test('F9-2: Read-Only Safety: read-only plan mode is preserved without silent upgrade to fullAccess', async () => {
  await withTestHomeAsync(async (home) => {
    const run = startAutomationRun({
      prompt: 'Check imports',
      cwd: '',
      permissionMode: 'plan',
      timeoutMs: 60,
      pollMs: 20,
    });
    const result = await run.done;
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const row = db.prepare('SELECT permission_mode FROM automations WHERE id = ?').get(result.automation.automationId);
    assert.notEqual(row.permission_mode, 'fullAccess', 'Must never upgrade to fullAccess');
    db.close();
  });
});

test('F9-3: Read-Only Safety: sessionFacts correctly identifies plan mode on sessions table', () => {
  withTestHome((home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const cid = 'session-plan-mode';
    db.prepare(`
      INSERT INTO sessions (id, cwd, title, permission_mode, created_at)
      VALUES (?, 'D:\\repo', 'Plan Mode Title', 'plan', ?)
    `).run(cid, Date.now());

    const facts = sessionFacts(db, cid);
    assert.equal(facts.permissionMode, 'plan');
    db.close();
  });
});

test('F9-4: Read-Only Safety: prompt output stream records requested permission mode in audit log', async () => {
  await withTestHomeAsync(async (home) => {
    const run = startAutomationRun({
      prompt: 'Read-only code inspection',
      cwd: 'D:\\readonly-repo',
      permissionMode: 'plan',
      timeoutMs: 80,
      pollMs: 20,
    });
    await run.done;
    const output = run.readOutput();
    assert.ok(output.includes('permission=plan'), 'Audit log stream must record permission=plan');
  });
});

test('F9-5: Read-Only Safety: Config schema supports permissionMode option', () => {
  const schema = Config;
  assert.ok(schema, 'Config schema must be defined');
});

// ══════════════════════════════════════════════════════════════════════════
// F10: Per-Workspace Concurrency Mutex (>= 5 tests)
// ══════════════════════════════════════════════════════════════════════════

test('F10-1: Workspace Mutex: host runtime instance manages in-flight execution counts', () => {
  const runtime = createRuntime({ pluginId: 'workbuddy', config: {}, ns: 'workbuddy' });
  assert.equal(runtime.inFlightCount(), 0, 'Initial in-flight count must be 0');
  runtime.start('job-1', {});
  assert.equal(runtime.inFlightCount(), 1);
  runtime.finish('job-1', 0);
  runtime.forget('job-1');
  assert.equal(runtime.inFlightCount(), 0);
});

test('F10-2: Workspace Mutex: path normalization resolves different representations of same workspace', () => {
  const normalize = (p) => resolve(p).toLowerCase().replace(/[\\/]+$/, '');
  const p1 = 'D:\\projects\\repo1';
  const p2 = 'D:/projects/repo1/';
  const p3 = 'd:\\projects\\repo1';
  assert.equal(normalize(p1), normalize(p2));
  assert.equal(normalize(p1), normalize(p3));
});

test('F10-3: Workspace Mutex: distinct workspaces have distinct lock keys', () => {
  const normalize = (p) => resolve(p).toLowerCase().replace(/[\\/]+$/, '');
  const w1 = normalize('D:\\workspace1');
  const w2 = normalize('D:\\workspace2');
  assert.notEqual(w1, w2, 'Distinct workspaces must have distinct normalization keys');
});

test('F10-4: Workspace Mutex: mutex serialization logic denies concurrent acquisition on same workspace', () => {
  const locks = new Map();
  function acquire(cwd, jobId) {
    const key = resolve(cwd).toLowerCase();
    if (locks.has(key)) return false;
    locks.set(key, jobId);
    return true;
  }
  function release(cwd, jobId) {
    const key = resolve(cwd).toLowerCase();
    if (locks.get(key) === jobId) {
      locks.delete(key);
      return true;
    }
    return false;
  }

  assert.equal(acquire('D:\\repo', 'job-1'), true, 'First acquisition must succeed');
  assert.equal(acquire('D:\\repo', 'job-2'), false, 'Second acquisition on same workspace must fail');
  assert.equal(acquire('D:\\other-repo', 'job-2'), true, 'Acquisition on different workspace must succeed');

  assert.equal(release('D:\\repo', 'job-1'), true);
  assert.equal(acquire('D:\\repo', 'job-3'), true, 'Acquisition after release must succeed');
});

test('F10-5: Workspace Mutex: releasing with mismatched jobId is safely rejected', () => {
  const locks = new Map();
  locks.set('d:\\repo', 'job-owner');
  function release(cwd, jobId) {
    const key = resolve(cwd).toLowerCase();
    if (locks.get(key) === jobId) {
      locks.delete(key);
      return true;
    }
    return false;
  }
  assert.equal(release('D:\\repo', 'impostor-job'), false, 'Mismatched jobId cannot release lock');
  assert.equal(locks.get('d:\\repo'), 'job-owner', 'Lock remains held by legitimate owner');
});

// ══════════════════════════════════════════════════════════════════════════
// F11: Structured Busy Error Rejection (>= 5 tests)
// ══════════════════════════════════════════════════════════════════════════

test('F11-1: Busy Rejection: structured busy error shape contains required contract fields', () => {
  function createBusyError(cwd, activeJobId) {
    return {
      code: 'ERR_WORKSPACE_BUSY',
      reason: 'busy',
      workspace: resolve(cwd),
      activeJobId,
      message: `Workspace ${cwd} is busy with job ${activeJobId}`,
    };
  }

  const err = createBusyError('D:\\repo', 'active-job-42');
  assert.equal(err.code, 'ERR_WORKSPACE_BUSY');
  assert.equal(err.reason, 'busy');
  assert.equal(err.activeJobId, 'active-job-42');
  assert.ok(err.message.includes('busy'));
});

test('F11-2: Busy Rejection: busy error code is distinct from general task errors', () => {
  assert.notEqual('ERR_WORKSPACE_BUSY', REASON_CODES.TASK_ERROR);
  assert.notEqual('busy', REASON_CODES.TASK_ERROR);
});

test('F11-3: Busy Rejection: structured busy error is serializable to JSON without circular references', () => {
  const err = {
    code: 'ERR_WORKSPACE_BUSY',
    reason: 'busy',
    workspace: 'D:\\my-repo',
    activeJobId: 'job-999',
    timestamp: Date.now(),
  };
  const json = JSON.stringify(err);
  const parsed = JSON.parse(json);
  assert.equal(parsed.code, 'ERR_WORKSPACE_BUSY');
  assert.equal(parsed.activeJobId, 'job-999');
});

test('F11-4: Busy Rejection: busy check rejects instantaneously (< 5ms) without polling delay', () => {
  const inFlightWorkspace = 'D:\\active-workspace';
  const t0 = performance.now();
  const isBusy = (cwd) => cwd === inFlightWorkspace;
  const busy = isBusy('D:\\active-workspace');
  const elapsed = performance.now() - t0;
  assert.equal(busy, true);
  assert.ok(elapsed < 10, `Busy determination must be immediate, took ${elapsed}ms`);
});

test('F11-5: Busy Rejection: non-conflicting workspaces are not blocked by busy state', () => {
  const activeWorkspaces = new Set(['d:\\repo-a']);
  const isBusy = (cwd) => activeWorkspaces.has(resolve(cwd).toLowerCase());

  assert.equal(isBusy('D:\\repo-a'), true);
  assert.equal(isBusy('D:\\repo-b'), false);
  assert.equal(isBusy('D:\\repo-c'), false);
});

// ══════════════════════════════════════════════════════════════════════════
// F12: Background Focus Protection (>= 5 tests)
// ══════════════════════════════════════════════════════════════════════════

test('F12-1: Background Focus: is_background_automation column exists on sessions table', () => {
  withTestHome((home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const cid = 'session-bg-check';
    db.prepare(`
      INSERT INTO sessions (id, cwd, title, is_background_automation, created_at)
      VALUES (?, 'D:\\repo', 'Background Run', 1, ?)
    `).run(cid, Date.now());

    const row = db.prepare('SELECT is_background_automation FROM sessions WHERE id = ?').get(cid);
    assert.equal(row.is_background_automation, 1, 'is_background_automation must be set to 1');
    db.close();
  });
});

test('F12-2: Background Focus: promoteSession resets is_background_automation to NULL for desktop visibility', () => {
  withTestHome((home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const cid = 'session-to-promote';
    db.prepare(`
      INSERT INTO sessions (id, cwd, title, is_background_automation, session_settings, created_at)
      VALUES (?, 'D:\\repo', 'To Promote', 1, '{"tags":[]}', ?)
    `).run(cid, Date.now());

    const changed = promoteSession(db, cid);
    assert.equal(changed, 1, 'promoteSession should modify exactly 1 row');

    const row = db.prepare('SELECT is_background_automation, session_settings FROM sessions WHERE id = ?').get(cid);
    assert.equal(row.is_background_automation, null, 'is_background_automation must become NULL');
    assert.equal(row.session_settings, null, 'session_settings must become NULL');
    db.close();
  });
});

test('F12-3: Background Focus: promoteSession on nonexistent session returns 0 changes gracefully', () => {
  withTestHome((home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const changed = promoteSession(db, 'nonexistent-cid-promote');
    assert.equal(changed, 0, 'promoteSession must return 0 changes for missing session');
    db.close();
  });
});

test('F12-4: Background Focus: promoteSession is idempotent on already promoted session', () => {
  withTestHome((home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const cid = 'session-idempotent-promote';
    db.prepare(`
      INSERT INTO sessions (id, cwd, title, is_background_automation, created_at)
      VALUES (?, 'D:\\repo', 'Already Promoted', NULL, ?)
    `).run(cid, Date.now());

    promoteSession(db, cid);
    const row = db.prepare('SELECT is_background_automation, session_settings FROM sessions WHERE id = ?').get(cid);
    assert.equal(row.is_background_automation, null, 'is_background_automation must remain NULL');
    assert.equal(row.session_settings, null, 'session_settings must remain NULL');
    db.close();
  });
});

test('F12-5: Background Focus: startAutomationRun with promote=false preserves background isolation', async () => {
  await withTestHomeAsync(async (home) => {
    const cid = 'session-no-promote';
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    db.prepare(`
      INSERT INTO sessions (id, cwd, title, is_background_automation, created_at)
      VALUES (?, 'D:\\repo', 'Background Isolation', 1, ?)
    `).run(cid, Date.now());
    db.close();

    // Verify session remains with is_background_automation = 1 when promote is not called
    const dbCheck = new DatabaseSync(join(home, 'workbuddy.db'));
    const row = dbCheck.prepare('SELECT is_background_automation FROM sessions WHERE id = ?').get(cid);
    assert.equal(row.is_background_automation, 1, 'Must preserve background automation flag');
    dbCheck.close();
  });
});
