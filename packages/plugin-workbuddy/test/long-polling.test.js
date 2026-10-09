/**
 * Milestone 1 (R1): 轮询预算解耦与长周期守望测试。
 *
 * 验证目标：
 *   ① buildPollWaits 动态推导轮数：
 *      - 15 分钟默认预算（900_000ms）推导为 181 轮（2s + 180×5s = 902s ≈ 15min）
 *      - 30 分钟预算（1_800_000ms）推导为 361 轮（2s + 360×5s = 1802s ≈ 30min）
 *      - 显式指定 maxPollRounds 时保持显式轮数（测试快路径兼容）
 *      - 显式覆盖 pollMs 时走遗留固定间隔模式
 *      - 边界条件（timeoutMs <= first 时恰好 1 轮）
 *   ② REASON_CODES.STILL_RUNNING：
 *      - STILL_RUNNING 为 'still_running'
 *      - 不在 FAILURE_CODES 失败集合中
 *      - isFailureCode(STILL_RUNNING) 为 false
 *      - REASON_TEXT[STILL_RUNNING] 为有效文本说明
 *   ③ startAutomationRun 超时状态机：
 *      - 轮数耗尽/超时收敛为 status: 'still_running'
 *      - exitCode 为 0（非 1）
 *      - automation.retired 为 false
 *      - automation.reason 为 'still_running'
 *      - SQLite automations 表中 deleted_at IS NULL（不调用 retireRow 软删）
 *      - 不调用 sessionStore.forget（不破坏会话记性）
 *   ④ subagent/execute.js 的 reportFromAutomation：
 *      - 识别 still_running 为无错误（ok: true, error: undefined）
 *   ⑤ schema.js 与 cordis.patch.yml 契约：
 *      - Config 包含 automationTimeoutMs 且默认值为 900_000，且为 volatile
 *
 * @module test/long-polling.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  AUTOMATION_DEFAULTS,
  buildPollWaits,
  startAutomationRun,
  workbuddyDbPath,
} from '../src/host/gateway/automation.js';
import {
  REASON_CODES,
  REASON_TEXT,
  FAILURE_CODES,
  isFailureCode,
} from '../src/host/launch/reason-codes.js';
import { reportFromAutomation } from '../src/host/subagent/execute.js';
import { Config } from '../src/host/config/schema.js';

const REAL_DB = join(homedir(), '.workbuddy', 'workbuddy.db');
const here = fileURLToPath(new URL('.', import.meta.url));

function realAutomationCount() {
  if (!existsSync(REAL_DB)) return null;
  const db = new DatabaseSync(REAL_DB, { readOnly: true });
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM automations WHERE deleted_at IS NULL').get().n;
  } finally {
    db.close();
  }
}

/** 构造最小测试夹具库 */
function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), 'wb-long-polling-'));
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

test('⓪ 护栏自证：临时库环境隔离有效', () => {
  assert.equal(process.env.WORKBUDDY_TEST_HOME_GUARD, 'on');
  assert.notEqual(workbuddyDbPath(), REAL_DB);
});

test('① buildPollWaits 动态推导轮数：15m 与 30m 预算正确推导且支持显式覆盖', () => {
  // 15 分钟默认预算推导
  const def = buildPollWaits({});
  assert.equal(def.rounds, 181, '默认预算 900_000ms 应推导出 181 轮');
  assert.equal(def.waits.length, 181);
  assert.equal(def.waits[0], 2_000);
  assert.ok(def.waits.slice(1).every((w) => w === 5_000));
  const totalDef = def.waits.reduce((a, b) => a + b, 0);
  assert.equal(totalDef, 902_000);
  assert.equal(def.legacy, false);

  // 30 分钟预算推导
  const m30 = buildPollWaits({ timeoutMs: 1_800_000 });
  assert.equal(m30.rounds, 361, '30 分钟预算 1_800_000ms 应推导出 361 轮');
  assert.equal(m30.waits.length, 361);
  assert.equal(m30.waits[0], 2_000);
  assert.ok(m30.waits.slice(1).every((w) => w === 5_000));
  const total30 = m30.waits.reduce((a, b) => a + b, 0);
  assert.equal(total30, 1_802_000);
  assert.equal(m30.legacy, false);

  // 边界：totalMs <= first 时恰好 1 轮
  const tiny = buildPollWaits({ timeoutMs: 1_500 });
  assert.equal(tiny.rounds, 1);
  assert.deepEqual(tiny.waits, [2_000]);

  // 自定义 first 与 rest 的推导
  const custom = buildPollWaits({ timeoutMs: 10_000, pollFirstMs: 1_000, pollRestMs: 2_000 });
  assert.equal(custom.rounds, 6, '1 + ceil((10000 - 1000) / 2000) = 6 轮');
  assert.equal(custom.waits.length, 6);
  assert.equal(custom.waits[0], 1_000);
  assert.ok(custom.waits.slice(1).every((w) => w === 2_000));

  // 显式指定 maxPollRounds 优先生效（单元测试快速收敛通道）
  const fast = buildPollWaits({ timeoutMs: 900_000, maxPollRounds: 5 });
  assert.equal(fast.rounds, 5, '显式传入 maxPollRounds 必须优先使用');
  assert.equal(fast.waits.length, 5);

  // 显式指定遗留 pollMs 时走固定间隔
  const legacy = buildPollWaits({ timeoutMs: 1_000, pollMs: 100 });
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.rounds, 10);
  assert.ok(legacy.waits.every((w) => w === 100));
});

test('② REASON_CODES.STILL_RUNNING 归一性与非失败语义', () => {
  assert.equal(REASON_CODES.STILL_RUNNING, 'still_running');
  assert.equal(FAILURE_CODES.has(REASON_CODES.STILL_RUNNING), false, 'STILL_RUNNING 绝不能进 FAILURE_CODES');
  assert.equal(isFailureCode(REASON_CODES.STILL_RUNNING), false, 'isFailureCode(STILL_RUNNING) 必须为 false');
  assert.equal(typeof REASON_TEXT[REASON_CODES.STILL_RUNNING], 'string');
  assert.ok(REASON_TEXT[REASON_CODES.STILL_RUNNING].length > 0);
});

test('③ startAutomationRun 超时返回 still_running、exitCode 0、不软删且保留会话记性', async () => {
  const before = realAutomationCount();
  const home = fixtureHome();
  const restore = useHome(home);

  let forgetCalled = false;
  let adoptCalled = false;
  const mockStore = {
    adopt: () => { adoptCalled = true; return { ok: true }; },
    forget: () => { forgetCalled = true; },
  };

  try {
    const run = startAutomationRun({
      prompt: 'LONG-POLLING-TIMEOUT-TEST',
      cwd: 'C:\\test\\dir',
      sessionKey: 'test-session-key',
      sessionStore: mockStore,
      timeoutMs: 60_000,
      pollFirstMs: 20,
      pollRestMs: 20,
      maxPollRounds: 4,
    });

    const out = await run.done;

    // 状态机验证
    assert.equal(out.status, 'still_running', '轮数耗尽时必须返回 still_running');
    assert.equal(out.exitCode, 0, 'still_running 的 exitCode 必须为 0');
    assert.ok(out.automation, 'automation 载荷必须存在');
    assert.equal(out.automation.reason, REASON_CODES.STILL_RUNNING);
    assert.equal(out.automation.retired, false, '超时不得将 retired 标记为 true');
    assert.match(out.detail, /still running/i);

    // 严禁软删：automations 表中行依然存活（deleted_at 为 NULL）
    const db = new DatabaseSync(join(home, 'workbuddy.db'), { readOnly: true });
    try {
      const row = db.prepare('SELECT id, deleted_at FROM automations WHERE id = ?').get(out.automation.automationId);
      assert.ok(row, '点火行必须存在');
      assert.equal(row.deleted_at, null, '超时严禁执行 retireRow 软删，deleted_at 必须保持为 NULL');
    } finally {
      db.close();
    }

    // 严禁丢弃会话记性：mockStore.forget 绝不被调用
    assert.equal(forgetCalled, false, '超时严禁调用 doForget 丢弃 sessionStore 记性');

    if (before !== null) assert.equal(realAutomationCount(), before, '真库必须保持一字不动');
  } finally {
    restore();
    rmSync(home, { recursive: true, force: true });
  }
});

test('④ subagent/execute.js reportFromAutomation 兼容 still_running 状态', () => {
  const result = reportFromAutomation({
    status: 'still_running',
    detail: 'the run is still running in the desktop',
    automation: {
      reason: REASON_CODES.STILL_RUNNING,
      conversationId: 'mock-conv-123',
      reply: null,
      phases: ['awaiting-scheduler-tick', 'running', 'still_running'],
    },
  });

  assert.equal(result.ok, true, 'still_running 必须判定为 ok: true');
  assert.equal(result.reason, REASON_CODES.STILL_RUNNING);
  assert.equal(result.error, undefined, 'still_running 不得返回 error 对象');
  assert.equal(result.sessionId, 'mock-conv-123');
  assert.equal(result.transport, 'automation');
});

test('⑤ Config 与 cordis.patch.yml 契约声明 automationTimeoutMs', () => {
  // Schema 声明验证
  const validated = Config['~standard'].validate({}).value;
  const rawTimeout = validated.automationTimeoutMs;
  const timeoutVal = typeof rawTimeout?.get === 'function' ? rawTimeout.get() : rawTimeout;
  assert.equal(timeoutVal, 900_000, 'Config 必须有默认 900_000ms 的 automationTimeoutMs');

  // cordis.patch.yml 声明验证
  const patchYaml = readFileSync(join(here, '..', 'cordis.patch.yml'), 'utf8');
  assert.match(patchYaml, /automationTimeoutMs:\s*900000/, 'cordis.patch.yml 必须包含 automationTimeoutMs: 900000');
});
