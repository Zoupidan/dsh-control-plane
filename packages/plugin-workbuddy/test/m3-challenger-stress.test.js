/**
 * Milestone 3 (R3) Challenger Stress & Boundary Test Suite
 *
 * Empirical verification of:
 *   1. startAutomationRun with plan mode:
 *      - Prompt guard prepended (starts with READ_ONLY_PROMPT_GUARD)
 *      - Guard not duplicated when prompt already contains the guard
 *      - 'plan' written to automations.permission_mode
 *      - Alias parameters: permissionMode, permission_mode, permission
 *      - Non-plan modes (default, fullAccess, omitted) do NOT inject guard
 *   2. harvestAutomationRun with divergence scenarios:
 *      - requested 'plan' vs session 'fullAccess' -> permission.confirmed === false
 *      - requested 'plan' vs session 'plan' -> permission.confirmed === true
 *      - requested effort 'high' vs session 'low' -> effort.confirmed === false
 *      - requested effort 'high' vs session 'high' -> effort.confirmed === true
 *      - mixed permutations (perm match & effort diverge, perm diverge & effort match)
 *   3. Missing row edge cases and safe failure modes:
 *      - session row missing -> returns confirmed: false safely without throwing
 *      - task / automation row missing -> returns ok: false, confirmed: false safely without throwing
 *      - malformed automationId types (empty, whitespace, null, number, object) safely handled
 *      - session row present but columns NULL / empty
 *   4. startAutomationRun end-to-end truth confirmation on settle / timeout
 *   5. workbuddy_harvest tool integration: pass-through of confirmation truth & card handling
 *
 * @module test/m3-challenger-stress.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  startAutomationRun,
  harvestAutomationRun,
  READ_ONLY_PROMPT_GUARD,
} from '../src/host/gateway/automation.js';
import { makeHarvestTool } from '../src/host/tools/harvest.js';

function createFixtureHome() {
  const home = mkdtempSync(join(tmpdir(), 'wb-m3-challenger-'));
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
// 1. startAutomationRun with Plan Mode, Guard Prepending & Persistence
// ══════════════════════════════════════════════════════════════════════════

test('CHALLENGE-1: startAutomationRun with plan mode prepends prompt guard and stores plan in automations.permission_mode', async () => {
  await withTestHomeAsync(async (home) => {
    const originalPrompt = 'Perform complete architectural scan of the codebase';
    const run = startAutomationRun({
      prompt: originalPrompt,
      cwd: 'D:\\project-plan-mode',
      permissionMode: 'plan',
      timeoutMs: 60,
      pollMs: 20,
    });
    const result = await run.done;

    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoRow = db.prepare('SELECT prompt, permission_mode FROM automations WHERE id = ?').get(result.automation.automationId);
    db.close();

    assert.ok(autoRow, 'Automations row must exist in DB');
    assert.equal(autoRow.permission_mode, 'plan', 'automations.permission_mode must strictly equal "plan"');
    assert.ok(autoRow.prompt.startsWith(READ_ONLY_PROMPT_GUARD), 'Prompt must strictly start with READ_ONLY_PROMPT_GUARD');
    assert.ok(autoRow.prompt.endsWith(originalPrompt), 'Original prompt must follow the guard');
    assert.equal(autoRow.prompt, `${READ_ONLY_PROMPT_GUARD}${originalPrompt}`);
  });
});

test('CHALLENGE-2: startAutomationRun handles alias parameter keys permission_mode and permission', async () => {
  await withTestHomeAsync(async (home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));

    // Test alias 1: permission_mode
    const run1 = startAutomationRun({
      prompt: 'Scan A',
      cwd: 'D:\\project-alias-1',
      permission_mode: 'plan',
      timeoutMs: 60,
      pollMs: 20,
    });
    const res1 = await run1.done;
    const row1 = db.prepare('SELECT prompt, permission_mode FROM automations WHERE id = ?').get(res1.automation.automationId);
    assert.equal(row1.permission_mode, 'plan');
    assert.ok(row1.prompt.startsWith(READ_ONLY_PROMPT_GUARD));

    // Test alias 2: permission
    const run2 = startAutomationRun({
      prompt: 'Scan B',
      cwd: 'D:\\project-alias-2',
      permission: 'plan',
      timeoutMs: 60,
      pollMs: 20,
    });
    const res2 = await run2.done;
    const row2 = db.prepare('SELECT prompt, permission_mode FROM automations WHERE id = ?').get(res2.automation.automationId);
    assert.equal(row2.permission_mode, 'plan');
    assert.ok(row2.prompt.startsWith(READ_ONLY_PROMPT_GUARD));

    db.close();
  });
});

test('CHALLENGE-3: startAutomationRun does not duplicate prompt guard on re-entry', async () => {
  await withTestHomeAsync(async (home) => {
    const alreadyGuarded = `${READ_ONLY_PROMPT_GUARD}Review tests without touching source`;
    const run = startAutomationRun({
      prompt: alreadyGuarded,
      cwd: 'D:\\project-idempotent-guard',
      permissionMode: 'plan',
      timeoutMs: 60,
      pollMs: 20,
    });
    const result = await run.done;

    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoRow = db.prepare('SELECT prompt FROM automations WHERE id = ?').get(result.automation.automationId);
    db.close();

    const matches = autoRow.prompt.split(READ_ONLY_PROMPT_GUARD).length - 1;
    assert.equal(matches, 1, 'READ_ONLY_PROMPT_GUARD must appear exactly once, never duplicated');
    assert.equal(autoRow.prompt, alreadyGuarded, 'Prompt must remain unchanged if already guarded');
  });
});

test('CHALLENGE-4: startAutomationRun with non-plan modes does NOT prepend prompt guard', async () => {
  await withTestHomeAsync(async (home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));

    // Case A: fullAccess
    const runFull = startAutomationRun({
      prompt: 'Full access modification allowed',
      cwd: 'D:\\project-full',
      permissionMode: 'fullAccess',
      timeoutMs: 60,
      pollMs: 20,
    });
    const resFull = await runFull.done;
    const rowFull = db.prepare('SELECT prompt, permission_mode FROM automations WHERE id = ?').get(resFull.automation.automationId);
    assert.equal(rowFull.permission_mode, 'fullAccess');
    assert.equal(rowFull.prompt.includes(READ_ONLY_PROMPT_GUARD), false, 'Must not inject guard for fullAccess');
    assert.equal(rowFull.prompt, 'Full access modification allowed');

    // Case B: default
    const runDef = startAutomationRun({
      prompt: 'Default interactive mode',
      cwd: 'D:\\project-def',
      permissionMode: 'default',
      timeoutMs: 60,
      pollMs: 20,
    });
    const resDef = await runDef.done;
    const rowDef = db.prepare('SELECT prompt, permission_mode FROM automations WHERE id = ?').get(resDef.automation.automationId);
    assert.equal(rowDef.permission_mode, 'default');
    assert.equal(rowDef.prompt.includes(READ_ONLY_PROMPT_GUARD), false, 'Must not inject guard for default');

    // Case C: unspecified / null
    const runNone = startAutomationRun({
      prompt: 'Unspecified permission mode',
      cwd: 'D:\\project-none',
      timeoutMs: 60,
      pollMs: 20,
    });
    const resNone = await runNone.done;
    const rowNone = db.prepare('SELECT prompt, permission_mode FROM automations WHERE id = ?').get(resNone.automation.automationId);
    assert.equal(rowNone.permission_mode, null);
    assert.equal(rowNone.prompt.includes(READ_ONLY_PROMPT_GUARD), false, 'Must not inject guard when unspecified');

    db.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 2. harvestAutomationRun Divergence Scenarios
// ══════════════════════════════════════════════════════════════════════════

test('CHALLENGE-5: harvestAutomationRun divergence - requested plan vs session fullAccess', async () => {
  await withTestHomeAsync(async (home) => {
    const autoId = 'auto-div-plan-vs-full';
    const cid = 'sess-div-plan-vs-full';
    const db = new DatabaseSync(join(home, 'workbuddy.db'));

    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, cwds, permission_mode, reasoning_effort, created_at, updated_at)
      VALUES (?, 'Plan Divergence', 'Test', 'ACTIVE', '["D:\\\\repo"]', 'plan', 'medium', 1000, 1000)
    `).run(autoId);

    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, metadata_json, created_at, updated_at)
      VALUES ('thread-plan-div', ?, 'ACCEPTED', 1, ?, 1010, 1010)
    `).run(autoId, JSON.stringify({ conversationId: cid }));

    db.prepare(`
      INSERT INTO sessions (id, cwd, title, permission_mode, thought_level, created_at)
      VALUES (?, 'D:\\repo', 'Plan Divergence', 'fullAccess', 'medium', 1005)
    `).run(cid);
    db.close();

    const harvested = await harvestAutomationRun(autoId);
    assert.equal(harvested.ok, true);
    assert.equal(harvested.automationId, autoId);
    assert.equal(harvested.sessionId, cid);
    assert.equal(harvested.permission.requested, 'plan');
    assert.equal(harvested.permission.effective, 'fullAccess');
    assert.equal(harvested.permission.confirmed, false, 'Must return permission.confirmed === false on divergence');
  });
});

test('CHALLENGE-6: harvestAutomationRun match - requested plan vs session plan', async () => {
  await withTestHomeAsync(async (home) => {
    const autoId = 'auto-match-plan';
    const cid = 'sess-match-plan';
    const db = new DatabaseSync(join(home, 'workbuddy.db'));

    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, cwds, permission_mode, reasoning_effort, created_at, updated_at)
      VALUES (?, 'Plan Match', 'Test', 'ACTIVE', '["D:\\\\repo"]', 'plan', 'high', 2000, 2000)
    `).run(autoId);

    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, metadata_json, created_at, updated_at)
      VALUES ('thread-plan-match', ?, 'ACCEPTED', 1, ?, 2010, 2010)
    `).run(autoId, JSON.stringify({ conversationId: cid }));

    db.prepare(`
      INSERT INTO sessions (id, cwd, title, permission_mode, thought_level, created_at)
      VALUES (?, 'D:\\repo', 'Plan Match', 'plan', 'high', 2005)
    `).run(cid);
    db.close();

    const harvested = await harvestAutomationRun(autoId);
    assert.equal(harvested.ok, true);
    assert.equal(harvested.permission.requested, 'plan');
    assert.equal(harvested.permission.effective, 'plan');
    assert.equal(harvested.permission.confirmed, true, 'Must return permission.confirmed === true when both plan');
  });
});

test('CHALLENGE-7: harvestAutomationRun divergence - requested effort high vs session low', async () => {
  await withTestHomeAsync(async (home) => {
    const autoId = 'auto-div-effort';
    const cid = 'sess-div-effort';
    const db = new DatabaseSync(join(home, 'workbuddy.db'));

    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, cwds, permission_mode, reasoning_effort, created_at, updated_at)
      VALUES (?, 'Effort Divergence', 'Test', 'ACTIVE', '["D:\\\\repo"]', 'default', 'high', 3000, 3000)
    `).run(autoId);

    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, metadata_json, created_at, updated_at)
      VALUES ('thread-effort-div', ?, 'ACCEPTED', 1, ?, 3010, 3010)
    `).run(autoId, JSON.stringify({ conversationId: cid }));

    db.prepare(`
      INSERT INTO sessions (id, cwd, title, permission_mode, thought_level, created_at)
      VALUES (?, 'D:\\repo', 'Effort Divergence', 'default', 'low', 3005)
    `).run(cid);
    db.close();

    const harvested = await harvestAutomationRun(autoId);
    assert.equal(harvested.ok, true);
    assert.equal(harvested.effort.requested, 'high');
    assert.equal(harvested.effort.effective, 'low');
    assert.equal(harvested.effort.confirmed, false, 'Must return effort.confirmed === false when requested high vs session low');
  });
});

test('CHALLENGE-8: harvestAutomationRun match - requested effort high vs session high', async () => {
  await withTestHomeAsync(async (home) => {
    const autoId = 'auto-match-effort';
    const cid = 'sess-match-effort';
    const db = new DatabaseSync(join(home, 'workbuddy.db'));

    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, cwds, permission_mode, reasoning_effort, created_at, updated_at)
      VALUES (?, 'Effort Match', 'Test', 'ACTIVE', '["D:\\\\repo"]', 'default', 'high', 4000, 4000)
    `).run(autoId);

    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, metadata_json, created_at, updated_at)
      VALUES ('thread-effort-match', ?, 'ACCEPTED', 1, ?, 4010, 4010)
    `).run(autoId, JSON.stringify({ conversationId: cid }));

    db.prepare(`
      INSERT INTO sessions (id, cwd, title, permission_mode, thought_level, created_at)
      VALUES (?, 'D:\\repo', 'Effort Match', 'default', 'high', 4005)
    `).run(cid);
    db.close();

    const harvested = await harvestAutomationRun(autoId);
    assert.equal(harvested.ok, true);
    assert.equal(harvested.effort.requested, 'high');
    assert.equal(harvested.effort.effective, 'high');
    assert.equal(harvested.effort.confirmed, true, 'Must return effort.confirmed === true when both high');
  });
});

test('CHALLENGE-9: harvestAutomationRun divergence - mixed permutations (perm match & effort diverge, perm diverge & effort match)', async () => {
  await withTestHomeAsync(async (home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));

    // Permutation A: Perm match (plan vs plan), Effort diverge (medium vs low)
    const autoA = 'auto-permA';
    const sessA = 'sess-permA';
    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, cwds, permission_mode, reasoning_effort, created_at, updated_at)
      VALUES (?, 'Permutation A', 'Test', 'ACTIVE', '["D:\\\\repo"]', 'plan', 'medium', 5000, 5000)
    `).run(autoA);
    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, metadata_json, created_at, updated_at)
      VALUES ('thread-permA', ?, 'ACCEPTED', 1, ?, 5010, 5010)
    `).run(autoA, JSON.stringify({ conversationId: sessA }));
    db.prepare(`
      INSERT INTO sessions (id, cwd, title, permission_mode, thought_level, created_at)
      VALUES (?, 'D:\\repo', 'Permutation A', 'plan', 'low', 5005)
    `).run(sessA);

    const harvestA = await harvestAutomationRun(autoA);
    assert.equal(harvestA.permission.confirmed, true, 'Permission must be confirmed (plan === plan)');
    assert.equal(harvestA.effort.confirmed, false, 'Effort must be unconfirmed (medium !== low)');

    // Permutation B: Perm diverge (default vs plan), Effort match (high vs high)
    const autoB = 'auto-permB';
    const sessB = 'sess-permB';
    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, cwds, permission_mode, reasoning_effort, created_at, updated_at)
      VALUES (?, 'Permutation B', 'Test', 'ACTIVE', '["D:\\\\repo"]', 'default', 'high', 6000, 6000)
    `).run(autoB);
    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, metadata_json, created_at, updated_at)
      VALUES ('thread-permB', ?, 'ACCEPTED', 1, ?, 6010, 6010)
    `).run(autoB, JSON.stringify({ conversationId: sessB }));
    db.prepare(`
      INSERT INTO sessions (id, cwd, title, permission_mode, thought_level, created_at)
      VALUES (?, 'D:\\repo', 'Permutation B', 'plan', 'high', 6005)
    `).run(sessB);

    const harvestB = await harvestAutomationRun(autoB);
    assert.equal(harvestB.permission.confirmed, false, 'Permission must be unconfirmed (default !== plan)');
    assert.equal(harvestB.effort.confirmed, true, 'Effort must be confirmed (high === high)');

    db.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 3. Safe Handling of Missing Rows and Malformed Inputs
// ══════════════════════════════════════════════════════════════════════════

test('CHALLENGE-10: harvestAutomationRun safe handling when sessions row is missing', async () => {
  await withTestHomeAsync(async (home) => {
    const autoId = 'auto-missing-sess';
    const db = new DatabaseSync(join(home, 'workbuddy.db'));

    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, cwds, permission_mode, reasoning_effort, created_at, updated_at)
      VALUES (?, 'Missing Session Task', 'Inspect', 'ACTIVE', '["D:\\\\repo"]', 'plan', 'high', 7000, 7000)
    `).run(autoId);
    db.close();

    // No automation_runs row, no sessions row
    const harvested = await harvestAutomationRun(autoId);

    assert.ok(harvested, 'Must return result object');
    assert.equal(harvested.ok, true);
    assert.equal(harvested.automationId, autoId);
    assert.equal(harvested.sessionId, null);
    assert.equal(harvested.permission.requested, 'plan');
    assert.equal(harvested.permission.effective, null);
    assert.equal(harvested.permission.confirmed, false, 'Must return permission.confirmed: false safely');
    assert.equal(harvested.effort.requested, 'high');
    assert.equal(harvested.effort.effective, null);
    assert.equal(harvested.effort.confirmed, false, 'Must return effort.confirmed: false safely');
  });
});

test('CHALLENGE-11: harvestAutomationRun safe handling when task/automation row is missing', async () => {
  await withTestHomeAsync(async (_home) => {
    const nonExistentId = 'auto-ghost-non-existent-999';

    // Must not throw unhandled exception
    const harvested = await harvestAutomationRun(nonExistentId);

    assert.ok(harvested, 'Must return result object');
    assert.equal(harvested.ok, false);
    assert.equal(harvested.error, 'automation_not_found');
    assert.equal(harvested.automationId, nonExistentId);
    assert.equal(harvested.sessionId, null);
    assert.equal(harvested.status, 'failed');
    assert.equal(harvested.permission.confirmed, false, 'Must safely report permission.confirmed: false');
    assert.equal(harvested.effort.confirmed, false, 'Must safely report effort.confirmed: false');
  });
});

test('CHALLENGE-12: harvestAutomationRun safe handling with invalid/malformed automationId types', async () => {
  await withTestHomeAsync(async (_home) => {
    const invalidInputs = [
      '',
      '   ',
      null,
      undefined,
      12345,
      true,
      false,
      {},
      [],
    ];

    for (const badId of invalidInputs) {
      const harvested = await harvestAutomationRun(badId);
      assert.equal(harvested.ok, false, `Must reject invalid ID: ${JSON.stringify(badId)}`);
      assert.equal(harvested.error, 'invalid_automation_id');
      assert.equal(harvested.permission.confirmed, false);
      assert.equal(harvested.effort.confirmed, false);
    }
  });
});

test('CHALLENGE-13: harvestAutomationRun safe handling when session exists but fields are NULL or empty', async () => {
  await withTestHomeAsync(async (home) => {
    const autoId = 'auto-null-fields';
    const cid = 'sess-null-fields';
    const db = new DatabaseSync(join(home, 'workbuddy.db'));

    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, cwds, permission_mode, reasoning_effort, created_at, updated_at)
      VALUES (?, 'Null Session Fields', 'Test', 'ACTIVE', '["D:\\\\repo"]', 'plan', 'high', 8000, 8000)
    `).run(autoId);

    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, metadata_json, created_at, updated_at)
      VALUES ('thread-null-fields', ?, 'ACCEPTED', 1, ?, 8010, 8010)
    `).run(autoId, JSON.stringify({ conversationId: cid }));

    // Sessions table row exists but permission_mode and thought_level are NULL
    db.prepare(`
      INSERT INTO sessions (id, cwd, title, permission_mode, thought_level, created_at)
      VALUES (?, 'D:\\repo', 'Null Session Fields', NULL, NULL, 8005)
    `).run(cid);
    db.close();

    const harvested = await harvestAutomationRun(autoId);
    assert.equal(harvested.ok, true);
    assert.equal(harvested.permission.requested, 'plan');
    assert.equal(harvested.permission.effective, null);
    assert.equal(harvested.permission.confirmed, false, 'Must be unconfirmed when session permission is NULL');
    assert.equal(harvested.effort.requested, 'high');
    assert.equal(harvested.effort.effective, null);
    assert.equal(harvested.effort.confirmed, false, 'Must be unconfirmed when session thought_level is NULL');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 4. startAutomationRun End-to-End Truth Confirmation on Timeout & Settle
// ══════════════════════════════════════════════════════════════════════════

test('CHALLENGE-14: startAutomationRun truth confirmation object on still_running timeout', async () => {
  await withTestHomeAsync(async (home) => {
    const run = startAutomationRun({
      prompt: 'Check timeout confirmation',
      cwd: 'D:\\repo-timeout',
      permissionMode: 'plan',
      reasoningEffort: 'high',
      maxPollRounds: 1,
      pollFirstMs: 20,
    });
    const res = await run.done;

    assert.equal(res.status, 'still_running');
    assert.equal(res.exitCode, 0);
    assert.equal(res.automation.retired, false);
    assert.ok(res.automation.permission);
    assert.equal(res.automation.permission.requested, 'plan');
    assert.equal(res.automation.permission.effective, null);
    assert.equal(res.automation.permission.confirmed, false, 'Unconfirmed during early timeout before session creation');
    assert.equal(String(res.automation.permission), '', 'String coercion returns empty string when effective is null');

    assert.ok(res.automation.effort);
    assert.equal(res.automation.effort.requested, 'high');
    assert.equal(res.automation.effort.effective, null);
    assert.equal(res.automation.effort.confirmed, false);
    assert.equal(String(res.automation.effort), '');
  });
});

test('CHALLENGE-15: startAutomationRun truth confirmation object on completed run with DB session match', async () => {
  await withTestHomeAsync(async (home) => {
    const prompt = 'Check completion confirmation';
    const cwd = 'D:\\repo-completed';
    const run = startAutomationRun({
      prompt,
      cwd,
      permissionMode: 'plan',
      reasoningEffort: 'high',
      pollMs: 50,
      timeoutMs: 2000,
      maxPollRounds: 10,
      pollFirstMs: 50,
      pollRestMs: 50,
    });

    // 等待点火写入 automations 行后，向 DB 补充 automation_runs 与 sessions 行
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    let autoId = null;
    for (let i = 0; i < 50; i++) {
      const row = db.prepare('SELECT id FROM automations LIMIT 1').get();
      if (row?.id) {
        autoId = row.id;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(autoId, 'Automation row must be inserted by startAutomationRun');

    const cid = 'session-completed-truth';
    db.prepare(`
      INSERT INTO sessions (id, cwd, title, permission_mode, thought_level, created_at)
      VALUES (?, ?, 'Completed Title', 'plan', 'high', ?)
    `).run(cid, cwd, Date.now());

    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, metadata_json, created_at, updated_at)
      VALUES ('thread-completed-truth', ?, 'ACCEPTED', 1, ?, ?, ?)
    `).run(autoId, JSON.stringify({ conversationId: cid }), Date.now(), Date.now());
    db.close();

    const res = await run.done;
    assert.equal(res.status, 'completed');
    assert.equal(res.exitCode, 0);
    assert.equal(res.automation.conversationId, cid);
    assert.equal(res.automation.permission.requested, 'plan');
    assert.equal(res.automation.permission.effective, 'plan');
    assert.equal(res.automation.permission.confirmed, true, 'Permission must be confirmed on match');
    assert.equal(res.automation.effort.requested, 'high');
    assert.equal(res.automation.effort.effective, 'high');
    assert.equal(res.automation.effort.confirmed, true, 'Effort must be confirmed on match');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 5. workbuddy_harvest Tool Verification
// ══════════════════════════════════════════════════════════════════════════

test('CHALLENGE-16: workbuddy_harvest tool passes through confirmation facts and handles divergence/missing safely', async () => {
  await withTestHomeAsync(async (home) => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoMatch = 'auto-tool-match';
    const sessMatch = 'sess-tool-match';
    db.prepare(`
      INSERT INTO automations (id, name, prompt, status, cwds, permission_mode, reasoning_effort, created_at, updated_at)
      VALUES (?, 'Tool Match', 'Test', 'ACTIVE', '["D:\\\\repo"]', 'plan', 'high', 9000, 9000)
    `).run(autoMatch);
    db.prepare(`
      INSERT INTO automation_runs (thread_id, automation_id, status, result_success, metadata_json, created_at, updated_at)
      VALUES ('thread-tool-match', ?, 'ACCEPTED', 1, ?, 9010, 9010)
    `).run(autoMatch, JSON.stringify({ conversationId: sessMatch }));
    db.prepare(`
      INSERT INTO sessions (id, cwd, title, permission_mode, thought_level, created_at)
      VALUES (?, 'D:\\repo', 'Tool Match', 'plan', 'high', 9005)
    `).run(sessMatch);
    db.close();

    const tool = makeHarvestTool();

    // 1. Tool execution on matching task
    const resMatch = await tool.execute({ automation_id: autoMatch });
    assert.equal(resMatch.ok, true);
    assert.equal(resMatch.permission.confirmed, true);
    assert.equal(resMatch.effort.confirmed, true);

    // 2. Tool execution on non-existent task
    const resMissing = await tool.execute({ automation_id: 'auto-ghost-missing' });
    assert.equal(resMissing.ok, false);
    assert.equal(resMissing.error, 'automation_not_found');
    assert.equal(resMissing.permission.confirmed, false);
    assert.equal(resMissing.effort.confirmed, false);

    // 3. Tool execution on invalid args (empty string)
    const resInvalid = await tool.execute({ automation_id: '' });
    assert.equal(resInvalid.ok, false);
    assert.equal(resInvalid.error, 'invalid_automation_id');
    assert.equal(resInvalid.permission.confirmed, false);
    assert.equal(resInvalid.effort.confirmed, false);

    // 4. Tool execution with missing property throws ToolArgsError
    await assert.rejects(
      async () => await tool.execute({}),
      (err) => err?.name === 'ToolArgsError' || err?.code === 'INVALID_ARGS',
      'Should reject missing required automation_id property',
    );
  });
});
