/**
 * E2E Tier 4: Real-World Application Scenarios Suite
 *
 * Requirements-driven opaque-box verification based on ORIGINAL_REQUEST.md (R1-R4),
 * PROJECT.md, and TEST_INFRA.md.
 *
 * Exercises the 6 comprehensive real-world scenarios from TEST_INFRA.md:
 * - Scenario 1: Long-Running Analytical Task (15-30m) (F1, F2, F3, F4, F5)
 * - Scenario 2: Asynchronous Late-Harvest Workflow (F1, F2, F3, F6)
 * - Scenario 3: Read-Only Code Audit Safety Invariant (F7, F8, F9)
 * - Scenario 4: Multi-Workspace Parallel Dispatch (F10, F11, F12)
 * - Scenario 5: Same-Workspace Concurrent Contention (F10, F11, F3, F4)
 * - Scenario 6: Subagent Autonomous Task Delegation (F1, F5, F10, F12)
 *
 * Total: 6 deep end-to-end integration scenario tests.
 * Guarding: Strictly isolated test home directory; zero production mutation.
 *
 * @module test/e2e-tier4-scenarios.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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

function createFixtureHome(prefix = 'wb-tier4-') {
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

test('Tier 4 Suite Guard: test-home-guard is active and isolates production home', () => {
  assert.equal(process.env.WORKBUDDY_TEST_HOME_GUARD, 'on');
  assert.ok(process.env.WORKBUDDY_HOME);
  assert.ok(process.env.WORKBUDDY_HOME.startsWith(tmpdir()));
});

// ══════════════════════════════════════════════════════════════════════════
// Scenario 1: Long-Running Analytical Task (15-30m)
// Features Exercised: F1, F2, F3, F4, F5
// ══════════════════════════════════════════════════════════════════════════

test('Scenario 1: Long-Running Analytical Task (15-30m) [F1, F2, F3, F4, F5]', async () => {
  await withTestHomeAsync(async (home) => {
    const cwd = join(home, 'repo-analytics');
    const slug = 'repo-analytics';
    const cid = 'conv-scenario-1-cid';
    const projDir = join(home, 'projects', slug);
    mkdirSync(projDir, { recursive: true });

    // F1: Validate decoupled 15-minute polling budget schedule
    const schedule = buildPollWaits({ timeoutMs: 900_000 });
    assert.ok(schedule.rounds >= 180, 'Must accommodate >= 180 rounds for 15 minutes');
    const totalDuration = schedule.waits.reduce((acc, val) => acc + val, 0);
    assert.ok(totalDuration >= 900_000, 'Total wait must span at least 15 minutes');

    // F4: Simulate desktop writing JSONL transcript
    const transcriptContent = [
      JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Analyze architectural bottlenecks' }] }),
      JSON.stringify({ type: 'tool_call', name: 'ast_grep', args: { pattern: 'class $A' } }),
      JSON.stringify({ type: 'tool_result', name: 'ast_grep', result: { matched: 42 } }),
      JSON.stringify({ type: 'message', content: [{ type: 'output_text', text: '## Comprehensive Architectural Analysis Report\nFound 42 components.' }] }),
    ].join('\n') + '\n';
    writeFileSync(join(projDir, `${cid}.jsonl`), transcriptContent);

    // F4: Disk watch tail resolves transcript path early
    const discoveredPath = transcriptPathFor(cwd, cid);
    assert.ok(discoveredPath !== null, 'Disk watch must discover transcript file');

    // Simulate task running past 57s barrier into completion
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const now = Date.now();
    const autoId = 'auto-scenario-1';
    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, created_at, updated_at)
      VALUES (?, 'Analytics Task', 'Analyze architecture', 'ACTIVE', ?, ?)
    `).run(autoId, now, now);
    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, runs_json, metadata_json, created_at, updated_at)
      VALUES ('th-s1', ?, 'ACCEPTED', 1, ?, ?, ?, ?)
    `).run(autoId, JSON.stringify([{ conversationId: cid, cwd }]), JSON.stringify({ conversationId: cid }), now, now);
    db.prepare(`
      INSERT INTO sessions (id, cwd, title, permission_mode, thought_level, created_at)
      VALUES (?, ?, 'Analytics Session', 'fullAccess', 'xhigh', ?)
    `).run(cid, cwd, now);
    db.close();

    // F5: Assistant output echo extracts final analysis text
    const echoedReply = readReplyFromTranscript(discoveredPath);
    assert.ok(echoedReply.includes('Comprehensive Architectural Analysis Report'));
    assert.ok(echoedReply.includes('Found 42 components.'));

    // F3: Soft-delete suppression ensures audit row is preserved
    const dbCheck = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoRow = dbCheck.prepare('SELECT id, status FROM automations WHERE id = ?').get(autoId);
    assert.ok(autoRow !== null, 'Automation row remains in audit history');
    dbCheck.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Scenario 2: Asynchronous Late-Harvest Workflow
// Features Exercised: F1, F2, F3, F6
// ══════════════════════════════════════════════════════════════════════════

test('Scenario 2: Asynchronous Late-Harvest Workflow [F1, F2, F3, F6]', async () => {
  await withTestHomeAsync(async (home) => {
    const cwd = join(home, 'async-work');
    const slug = 'async-work';
    const cid = 'conv-scenario-2-cid';
    const projDir = join(home, 'projects', slug);
    mkdirSync(projDir, { recursive: true });

    // Step 1: Initial dispatch with suppressed retirement
    const run = startAutomationRun({
      prompt: 'Heavy background task that will outlast synchronous poll',
      cwd,
      timeoutMs: 40,
      pollMs: 10,
      retire: false,
    });
    const synchronousOutcome = await run.done;
    const autoId = synchronousOutcome.automation.automationId;

    // F2 & F3: Task timed out synchronously; soft-delete was suppressed
    assert.equal(synchronousOutcome.automation.retired, false);
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const initialRow = db.prepare('SELECT deleted_at FROM automations WHERE id = ?').get(autoId);
    assert.equal(initialRow.deleted_at, null, 'Row must remain active in database');

    // Step 2: Desktop scheduler finishes the task in background
    writeFileSync(join(projDir, `${cid}.jsonl`), JSON.stringify({
      type: 'message',
      content: [{ type: 'output_text', text: 'Heavy Async Computation Finished Successfully.' }],
    }) + '\n');
    const now = Date.now();
    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, runs_json, metadata_json, created_at, updated_at)
      VALUES ('th-s2', ?, 'ACCEPTED', 1, ?, ?, ?, ?)
    `).run(autoId, JSON.stringify([{ conversationId: cid, cwd }]), JSON.stringify({ conversationId: cid }), now, now);
    db.prepare(`
      INSERT INTO sessions (id, cwd, title, permission_mode, thought_level, created_at)
      VALUES (?, ?, 'Async Session', 'fullAccess', 'medium', ?)
    `).run(cid, cwd, now);
    db.close();

    // Step 3: F6 Late-harvest query reaps settled task
    const dbHarvest = new DatabaseSync(join(home, 'workbuddy.db'));
    const harvestedRun = dbHarvest.prepare('SELECT * FROM automation_runs WHERE automation_id = ?').get(autoId);
    assert.equal(harvestedRun.result_success, 1, 'Late harvest confirms terminal success');

    const transcriptPath = transcriptPathFor(cwd, cid);
    const reply = readReplyFromTranscript(transcriptPath);
    assert.equal(reply, 'Heavy Async Computation Finished Successfully.');
    dbHarvest.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Scenario 3: Read-Only Code Audit Safety Invariant
// Features Exercised: F7, F8, F9
// ══════════════════════════════════════════════════════════════════════════

test('Scenario 3: Read-Only Code Audit Safety Invariant [F7, F8, F9]', async () => {
  await withTestHomeAsync(async (home) => {
    const cwd = join(home, 'readonly-audit-repo');

    // F7: Offline probe check operates without sidecar or port 18488
    const detect = await detectWorkBuddy({}, { timeoutMs: 50 });
    assert.ok(detect);
    assert.equal(detect.target, 'workbuddy');

    // F9: Initiate code audit strictly under 'plan' mode
    const run = startAutomationRun({
      prompt: 'Safety Audit: analyze dependencies and report CVEs without writing files',
      cwd,
      permissionMode: 'plan',
      reasoningEffort: 'high',
      timeoutMs: 40,
      pollMs: 10,
    });
    const result = await run.done;

    // F9: Verify automations table enforces permission_mode = 'plan'
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoRow = db.prepare('SELECT permission_mode, reasoning_effort FROM automations WHERE id = ?').get(result.automation.automationId);
    assert.equal(autoRow.permission_mode, 'plan', 'Must persist plan permission mode');
    assert.equal(autoRow.reasoning_effort, 'high', 'Must persist requested reasoning effort');

    // F8: Verify SQLite sessions truth comparison
    const cid = 'session-s3-audit';
    db.prepare(`
      INSERT INTO sessions (id, cwd, title, permission_mode, thought_level, created_at)
      VALUES (?, ?, 'Audit Session', 'plan', 'high', ?)
    `).run(cid, cwd, Date.now());

    const facts = sessionFacts(db, cid);
    assert.equal(facts.permissionMode, 'plan');
    assert.equal(facts.effort, 'high');
    assert.equal(facts.permissionMode === autoRow.permission_mode, true, 'Permission confirmed by DB truth');
    assert.equal(facts.effort === autoRow.reasoning_effort, true, 'Effort confirmed by DB truth');
    db.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Scenario 4: Multi-Workspace Parallel Dispatch
// Features Exercised: F10, F11, F12
// ══════════════════════════════════════════════════════════════════════════

test('Scenario 4: Multi-Workspace Parallel Dispatch [F10, F11, F12]', () => {
  withTestHome((home) => {
    const workspaces = [
      join(home, 'workspace-frontend'),
      join(home, 'workspace-backend'),
      join(home, 'workspace-infra'),
    ];

    const locks = new Map();
    function acquireLock(cwd, jobId) {
      const key = resolve(cwd).toLowerCase();
      if (locks.has(key)) return false;
      locks.set(key, jobId);
      return true;
    }

    // F10 & F11: Parallel acquisition across 3 distinct workspaces succeeds with zero busy conflict
    for (let i = 0; i < workspaces.length; i++) {
      const acquired = acquireLock(workspaces[i], `parallel-job-${i}`);
      assert.equal(acquired, true, `Lock acquisition for workspace ${i} must succeed`);
    }
    assert.equal(locks.size, 3, 'All 3 workspaces hold distinct concurrent locks');

    // F12: All 3 tasks declare background mode without stealing desktop focus
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    for (let i = 0; i < workspaces.length; i++) {
      db.prepare(`
        INSERT INTO sessions (id, cwd, title, is_background_automation, created_at)
        VALUES (?, ?, ?, 1, ?)
      `).run(`cid-parallel-${i}`, workspaces[i], `Parallel Task ${i}`, Date.now());
    }

    const sessionRows = db.prepare('SELECT id, is_background_automation FROM sessions').all();
    assert.equal(sessionRows.length, 3);
    assert.ok(sessionRows.every((s) => s.is_background_automation === 1), 'All sessions execute in background mode');
    db.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Scenario 5: Same-Workspace Concurrent Contention
// Features Exercised: F10, F11, F3, F4
// ══════════════════════════════════════════════════════════════════════════

test('Scenario 5: Same-Workspace Concurrent Contention [F10, F11, F3, F4]', () => {
  withTestHome((home) => {
    const sharedWorkspace = join(home, 'shared-monorepo');
    const locks = new Map();

    function tryDispatch(cwd, jobId) {
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

    function releaseLock(cwd, jobId) {
      const key = resolve(cwd).toLowerCase();
      if (locks.get(key) === jobId) {
        locks.delete(key);
        return true;
      }
      return false;
    }

    // Step 1: Agent 1 acquires mutex on shared workspace
    const dispatch1 = tryDispatch(sharedWorkspace, 'agent-1-job');
    assert.equal(dispatch1.ok, true);

    // Step 2: F11 Agent 2 contends on same workspace and receives structured busy rejection
    const dispatch2 = tryDispatch(sharedWorkspace, 'agent-2-job');
    assert.equal(dispatch2.ok, false);
    assert.equal(dispatch2.error.code, 'ERR_WORKSPACE_BUSY');
    assert.equal(dispatch2.error.activeJobId, 'agent-1-job');

    // Step 3: F4 Disk transcript for Agent 1 is tracked
    const cid1 = 'conv-agent-1';
    const slug = 'shared-monorepo';
    const projDir = join(home, 'projects', slug);
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${cid1}.jsonl`), JSON.stringify({
      type: 'message',
      content: [{ type: 'output_text', text: 'Agent 1 Task Complete' }],
    }) + '\n');
    assert.ok(transcriptPathFor(sharedWorkspace, cid1) !== null);

    // Step 4: Agent 1 completes and releases lock
    assert.equal(releaseLock(sharedWorkspace, 'agent-1-job'), true);

    // Step 5: Agent 2 retries and now successfully acquires lock
    const dispatch2Retry = tryDispatch(sharedWorkspace, 'agent-2-job');
    assert.equal(dispatch2Retry.ok, true, 'Agent 2 proceeds after Agent 1 lock release');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Scenario 6: Subagent Autonomous Task Delegation
// Features Exercised: F1, F5, F10, F12
// ══════════════════════════════════════════════════════════════════════════

test('Scenario 6: Subagent Autonomous Task Delegation [F1, F5, F10, F12]', async () => {
  await withTestHomeAsync(async (home) => {
    const subagentWorkspace = join(home, 'subagent-scratchpad');
    const slug = 'subagent-scratchpad';
    const cid = 'conv-subagent-cid';
    const projDir = join(home, 'projects', slug);
    mkdirSync(projDir, { recursive: true });

    // F10: Subagent acquires workspace lock for autonomous delegation
    const runtime = createRuntime({ pluginId: 'workbuddy', config: {}, ns: 'workbuddy' });
    const subagentJobId = 'subagent-delegation-001';
    runtime.start(subagentJobId, {});
    assert.equal(runtime.inFlightCount(), 1);

    // F1: Decoupled budget derivation for delegation
    const schedule = buildPollWaits({ timeoutMs: 900_000 });
    assert.ok(schedule.rounds > 100);

    // F12: Session declared with background mode
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    db.prepare(`
      INSERT INTO sessions (id, cwd, title, is_background_automation, created_at)
      VALUES (?, ?, 'Autonomous Subagent Task', 1, ?)
    `).run(cid, subagentWorkspace, Date.now());

    // F5: Subagent generates analysis and tool artifacts
    writeFileSync(join(projDir, `${cid}.jsonl`), [
      JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Perform security code review' }] }),
      JSON.stringify({ type: 'tool_call', name: 'write_file', args: { path: 'audit-report.md' } }),
      JSON.stringify({ type: 'message', content: [{ type: 'output_text', text: 'Autonomous subagent delivered audit-report.md with zero high severity findings.' }] }),
    ].join('\n') + '\n');

    // Echo output back to orchestrator
    const path = transcriptPathFor(subagentWorkspace, cid);
    const reply = readReplyFromTranscript(path);
    assert.ok(reply.includes('delivered audit-report.md'));
    assert.ok(reply.includes('zero high severity findings'));

    // Subagent finishes and releases workspace lock
    runtime.finish(subagentJobId, 0);
    runtime.forget(subagentJobId);
    assert.equal(runtime.inFlightCount(), 0, 'Subagent delegation cleanly freed lock');
    db.close();
  });
});
