/**
 * Milestone 1 (R1): 对抗性压力测试与契约验证套件 (Adversarial Stress Harness)。
 *
 * 本测试套件由 EMPIRICAL CHALLENGER (challenger_m1_2) 独立编写并执行，
 * 专门针对 Milestone 1 的状态机迁移与会话存储完整性进行对抗性压力测试与边界证伪。
 *
 * 核心验证契约：
 *   ① sessionStore 完整性：超时产生 still_running 时，绝对不 purge、forget 或 supersede sessionKey；
 *      连续多轮超时下会话记性恒定保持；对比真实失败与主动取消路径（明确执行 forget）。
 *   ② tools/run.js (settleAutomation) 行为：
 *      - 记录 reasonCode: 'still_running'
 *      - 绝对不调用 forgetOnFail() (sessions.forget 与 sessions.supersede 零调用)
 *      - 绝对不污染 credits.recordRun (零调用，与 completed 和 failed 的记账严格隔离)
 *      - 任务终态退出码为 0 (runtime.finish(jobId, 0))，retired 恒为 false
 *   ③ isFailureCode 判据：
 *      - isFailureCode('still_running') === false
 *      - isFailureCode(REASON_CODES.STILL_RUNNING) === false
 *      - FAILURE_CODES.has('still_running') === false
 *   ④ 边界与配置容错对抗：
 *      - 非法/极端配置（负数、0、NaN、非数字）优雅回落默认 900_000ms 预算
 *      - 极端轮询预算推导边界 (<= first, 跨 boundary)
 *
 * @module test/m1-adversarial-stress.test
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
  REASON_TEXT,
  FAILURE_CODES,
  isFailureCode,
  classifyFailure,
} from '../src/host/launch/reason-codes.js';
import { makeRunTool } from '../src/host/tools/run.js';
import { createLiveCredits } from '../src/host/launch/live-credits.js';

const REAL_DB = join(homedir(), '.workbuddy', 'workbuddy.db');

/** 构造隔离的测试夹具库 */
function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), 'wb-adversarial-stress-'));
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

/** 模拟用于测试 tools/run.js 的隔离环境 */
function createRunToolHarness({
  status = 'still_running',
  reasonCode = REASON_CODES.STILL_RUNNING,
  exitCode = 0,
  automationOverrides = {},
  configOverrides = {},
} = {}) {
  const runtimeNotes = [];
  const runtimeFinishes = [];
  const forgetCalls = [];
  const supersedeCalls = [];
  const creditRecordRuns = [];

  const runtime = {
    notes: runtimeNotes,
    detected: () => ({ installed: true, reason: 'ok' }),
    awaitDetection: async () => ({ installed: true, reason: 'ok' }),
    inFlightCount: () => 0,
    start: () => {},
    finish: (jobId, code) => {
      runtimeFinishes.push({ jobId, code });
    },
    forget: () => {},
    noteRun: (rec) => {
      runtimeNotes.push(rec);
    },
    registry: () => undefined,
    setRegistry: () => {},
  };

  const handles = [];
  const jobs = {
    start(spec) {
      const handle = spec.run();
      handles.push(handle);
      return `job-${handles.length}`;
    },
  };

  const sessions = {
    createKey: () => 'adversarial-key-1',
    resumable: () => null,
    adopt: () => ({ ok: true }),
    forget: (k, why) => {
      forgetCalls.push({ key: k, why });
    },
    supersede: (k) => {
      supersedeCalls.push({ key: k });
    },
  };

  const credits = {
    recordRun: (entry) => {
      creditRecordRuns.push(entry);
    },
    counters: { runs: 0, failedRuns: 0, freeRuns: 0, unknownRuns: 0 },
  };

  const baseConfig = {
    enabled: true,
    model: 'hy3',
    effort: '',
    cwdRoot: 'C:/repo',
    boundSessionId: '',
    automationTimeoutMs: 900_000,
    ...configOverrides,
  };

  const automationPayload = {
    reason: reasonCode,
    automationId: 'adv-auto-1',
    conversationId: 'adv-conv-1',
    sessionId: 'adv-conv-1',
    sessionKey: 'adv-key-1',
    retired: false,
    reply: 'still running in background',
    model: 'hy3',
    phases: ['awaiting-scheduler-tick', 'running', 'still_running'],
    ...automationOverrides,
  };

  const tool = makeRunTool(
    runtime,
    sessions,
    () => baseConfig,
    { jobs, subprocess: {} },
    credits,
    null,
    {
      automationRun: () => ({
        cancel: () => {},
        done: Promise.resolve({
          status,
          detail: 'simulation detail',
          exitCode,
          automation: automationPayload,
        }),
        readOutput: () => 'simulation detail',
      }),
      catalog: {
        projection: () => ({
          available: true,
          cost: { models: [{ modelId: 'hy3', factor: 0 }] },
        }),
      },
    },
  );

  return {
    tool,
    handles,
    runtimeNotes,
    runtimeFinishes,
    forgetCalls,
    supersedeCalls,
    creditRecordRuns,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试 1：isFailureCode 契约与对抗性判定测试
// ─────────────────────────────────────────────────────────────────────────────

test('ADVERSARIAL-1: isFailureCode 对 still_running 的非失败语义强制约束', () => {
  // 核心契约：still_running 绝对不能被判定为失败
  assert.equal(isFailureCode('still_running'), false, "isFailureCode('still_running') 必须为 false");
  assert.equal(isFailureCode(REASON_CODES.STILL_RUNNING), false, 'isFailureCode(REASON_CODES.STILL_RUNNING) 必须为 false');
  assert.equal(FAILURE_CODES.has('still_running'), false, "FAILURE_CODES 集合绝不能包含 'still_running'");
  assert.equal(FAILURE_CODES.has(REASON_CODES.STILL_RUNNING), false, 'FAILURE_CODES 集合绝不能包含 REASON_CODES.STILL_RUNNING');

  // 对抗测试：输入大小写变形、空值、未知类型防御
  assert.equal(isFailureCode('STILL_RUNNING'), false);
  assert.equal(isFailureCode('Still_Running'), false);
  assert.equal(isFailureCode(null), false);
  assert.equal(isFailureCode(undefined), false);
  assert.equal(isFailureCode(0), false);
  assert.equal(isFailureCode({}), false);

  // 对比验证：真正的失败码必须 100% 命中 isFailureCode
  const genuineFailures = [
    REASON_CODES.FLAG_REJECTED,
    REASON_CODES.PORT_CONFLICT,
    REASON_CODES.AUTH_FAILED,
    REASON_CODES.PERMISSION_DENIED,
    REASON_CODES.QUOTA_EXHAUSTED,
    REASON_CODES.TRANSPORT_UNREACHABLE,
    REASON_CODES.MODEL_UNAVAILABLE,
    REASON_CODES.INPUT_TOO_LONG,
    REASON_CODES.QUOTA_REQUEST_LIMIT,
    REASON_CODES.NO_SESSION_RESUME,
    REASON_CODES.NODE_RUNTIME_NOT_FOUND,
    REASON_CODES.START_FAILED,
    REASON_CODES.EXIT_NONZERO,
    REASON_CODES.TASK_ERROR,
    REASON_CODES.ALREADY_REMEMBERED_NO_DISPATCH,
  ];
  for (const code of genuineFailures) {
    assert.equal(isFailureCode(code), true, `真实失败码 ${code} 必须被 isFailureCode 识别`);
  }

  // 非失败特殊码验证：OK, ABORTED, UNKNOWN, STILL_RUNNING 均不在 FAILURE_CODES 中
  const nonFailureCodes = [
    REASON_CODES.OK,
    REASON_CODES.ABORTED,
    REASON_CODES.UNKNOWN,
    REASON_CODES.STILL_RUNNING,
  ];
  for (const code of nonFailureCodes) {
    assert.equal(isFailureCode(code), false, `非失败码 ${code} 绝对不能进 isFailureCode`);
    assert.equal(FAILURE_CODES.has(code), false, `非失败码 ${code} 绝对不能在 FAILURE_CODES 中`);
  }

  // REASON_TEXT 存在且语义中立客观
  assert.ok(typeof REASON_TEXT[REASON_CODES.STILL_RUNNING] === 'string');
  assert.match(REASON_TEXT[REASON_CODES.STILL_RUNNING], /后台运行|超时守望/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 2：tools/run.js settleAutomation 对决 still_running 终态
// ─────────────────────────────────────────────────────────────────────────────

test('ADVERSARIAL-2.1: settleAutomation 在 still_running 下记录 reasonCode: still_running 且 job exitCode 0', async () => {
  const h = createRunToolHarness({
    status: 'still_running',
    reasonCode: REASON_CODES.STILL_RUNNING,
    exitCode: 0,
    automationOverrides: {
      retired: false,
    },
  });

  const res = await h.tool.execute({ prompt: 'test-prompt', session_key: 'adv-key-1' }, { signal: new AbortController().signal });
  assert.ok(res.job_id);
  const settled = await h.handles[0].done;

  // 1. 终态返回值必须为 still_running
  assert.equal(settled.status, 'still_running');

  // 2. runtime.noteRun 记录检查
  assert.equal(h.runtimeNotes.length, 1, '必须记录一条 noteRun');
  const note = h.runtimeNotes[0];
  assert.equal(note.reasonCode, REASON_CODES.STILL_RUNNING, "noteRun.reasonCode 必须为 'still_running'");
  assert.equal(note.exitCode, 0, 'noteRun.exitCode 必须为 0');
  assert.equal(note.retired, false, 'noteRun.retired 必须为 false (不得标记已软删)');

  // 3. runtime.finish 退出码必须为 0 (非 -1)
  assert.equal(h.runtimeFinishes.length, 1);
  assert.equal(h.runtimeFinishes[0].code, 0, 'runtime.finish 退出码必须为 0 (成功守望退出)');
});

test('ADVERSARIAL-2.2: settleAutomation 在 still_running 下绝对不调用 forgetOnFail()', async () => {
  const h = createRunToolHarness({
    status: 'still_running',
    reasonCode: REASON_CODES.STILL_RUNNING,
    exitCode: 0,
  });

  await h.tool.execute({ prompt: 'test-prompt', session_key: 'adv-key-1' }, { signal: new AbortController().signal });
  await h.handles[0].done;

  // 验证 sessions.forget 和 sessions.supersede 绝对未被调用
  assert.equal(h.forgetCalls.length, 0, 'still_running 下绝对不得调用 sessions.forget');
  assert.equal(h.supersedeCalls.length, 0, 'still_running 下绝对不得调用 sessions.supersede');
});

test('ADVERSARIAL-2.3: settleAutomation 在 still_running 下绝对不污染 credits.recordRun', async () => {
  const hStillRunning = createRunToolHarness({
    status: 'still_running',
    reasonCode: REASON_CODES.STILL_RUNNING,
    exitCode: 0,
  });

  await hStillRunning.tool.execute({ prompt: 'test-prompt', session_key: 'adv-key-1' }, { signal: new AbortController().signal });
  await hStillRunning.handles[0].done;

  // still_running 状态下 credits.recordRun 必须零调用
  assert.equal(
    hStillRunning.creditRecordRuns.length,
    0,
    'still_running 下 credits.recordRun 必须为 0 次调用 (不污染成功也不污染失败计数)',
  );

  // 对比基准：completed 必须调用 1 次且 ok: true
  const hCompleted = createRunToolHarness({
    status: 'completed',
    reasonCode: REASON_CODES.OK,
    exitCode: 0,
  });
  await hCompleted.tool.execute({ prompt: 'test-prompt', session_key: 'adv-key-1' }, { signal: new AbortController().signal });
  await hCompleted.handles[0].done;
  assert.equal(hCompleted.creditRecordRuns.length, 1);
  assert.equal(hCompleted.creditRecordRuns[0].ok, true);

  // 对比基准：failed 必须调用 1 次且 ok: false
  const hFailed = createRunToolHarness({
    status: 'failed',
    reasonCode: REASON_CODES.TASK_ERROR,
    exitCode: 1,
    automationOverrides: { retired: true },
  });
  await hFailed.tool.execute({ prompt: 'test-prompt', session_key: 'adv-key-1' }, { signal: new AbortController().signal });
  await hFailed.handles[0].done;
  assert.equal(hFailed.creditRecordRuns.length, 1);
  assert.equal(hFailed.creditRecordRuns[0].ok, false);
});

test('ADVERSARIAL-2.4: 对比组验证 —— genuine failure 确实会触发 forgetOnFail() 与 exitCode -1', async () => {
  const h = createRunToolHarness({
    status: 'failed',
    reasonCode: REASON_CODES.TASK_ERROR,
    exitCode: 1,
    automationOverrides: { retired: true },
  });

  await h.tool.execute({ prompt: 'test-prompt', session_key: 'adv-key-failed' }, { signal: new AbortController().signal });
  await h.handles[0].done;

  assert.equal(h.forgetCalls.length, 1, '真实失败必须调用 forgetOnFail() 释放死会话');
  assert.equal(h.forgetCalls[0].key, 'adv-key-failed');
  assert.equal(h.runtimeFinishes[0].code, -1, '真实失败的 job exitCode 必须为 -1');
  assert.equal(h.runtimeNotes[0].retired, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 3：sessionStore 与 startAutomationRun 真实状态机对抗测试
// ─────────────────────────────────────────────────────────────────────────────

test('ADVERSARIAL-3.1: startAutomationRun 超时决不 purge/forget/supersede sessionKey，且 SQLite 保持未删', async () => {
  const home = fixtureHome();
  const restore = useHome(home);

  let adoptCount = 0;
  let forgetCount = 0;
  let supersedeCount = 0;
  const storeAudit = [];

  const spySessionStore = {
    adopt: (k, rec) => {
      adoptCount += 1;
      storeAudit.push({ op: 'adopt', key: k, rec });
      return { ok: true };
    },
    forget: (k) => {
      forgetCount += 1;
      storeAudit.push({ op: 'forget', key: k });
    },
    supersede: (k) => {
      supersedeCount += 1;
      storeAudit.push({ op: 'supersede', key: k });
    },
  };

  try {
    const key = 'stress-session-key-alpha';
    const run = startAutomationRun({
      prompt: 'ADVERSARIAL-STRESS-POLL-TIMEOUT',
      cwd: 'C:\\test\\sandbox',
      sessionKey: key,
      sessionStore: spySessionStore,
      timeoutMs: 50_000,
      pollFirstMs: 15,
      pollRestMs: 15,
      maxPollRounds: 3,
    });

    const out = await run.done;

    // 1. 结果契约验证
    assert.equal(out.status, 'still_running');
    assert.equal(out.exitCode, 0);
    assert.equal(out.automation.reason, REASON_CODES.STILL_RUNNING);
    assert.equal(out.automation.sessionKey, key);
    assert.equal(out.automation.retired, false);

    // 2. 存储操作验证：严禁任何 forget 或 supersede
    assert.equal(forgetCount, 0, 'sessionStore.forget 必须被调用 0 次');
    assert.equal(supersedeCount, 0, 'sessionStore.supersede 必须被调用 0 次');
    const destructiveOps = storeAudit.filter((item) => item.op === 'forget' || item.op === 'supersede');
    assert.deepEqual(destructiveOps, [], '绝对不能存在任何破坏性会话操作');

    // 3. SQLite 行验证：绝对不能被软删 (deleted_at IS NULL)
    const db = new DatabaseSync(join(home, 'workbuddy.db'), { readOnly: true });
    try {
      const row = db.prepare('SELECT id, status, deleted_at FROM automations WHERE id = ?').get(out.automation.automationId);
      assert.ok(row, '点火行必须保留在表中');
      assert.equal(row.deleted_at, null, '点火行 deleted_at 必须恒为 NULL (不执行 retireRow)');
    } finally {
      db.close();
    }
  } finally {
    restore();
    rmSync(home, { recursive: true, force: true });
  }
});

test('ADVERSARIAL-3.2: 连续多轮并发/顺序超时压力下 sessionKey 记性恒久保持', async () => {
  const home = fixtureHome();
  const restore = useHome(home);

  const key = 'multi-turn-resilient-key';
  const recordedKeys = new Set([key]);
  let forgetCalledTimes = 0;

  const resilientStore = {
    adopt: () => ({ ok: true }),
    forget: (k) => {
      forgetCalledTimes += 1;
      recordedKeys.delete(k);
    },
  };

  try {
    // 连续触发 3 轮超时
    for (let round = 1; round <= 3; round += 1) {
      const run = startAutomationRun({
        prompt: `ROUND-${round}-PROMPT`,
        cwd: 'C:\\test\\sandbox',
        sessionKey: key,
        sessionStore: resilientStore,
        timeoutMs: 30_000,
        pollFirstMs: 10,
        pollRestMs: 10,
        maxPollRounds: 2,
      });

      const out = await run.done;
      assert.equal(out.status, 'still_running', `第 ${round} 轮必须收敛为 still_running`);
      assert.equal(out.automation.retired, false);
      assert.equal(forgetCalledTimes, 0, `第 ${round} 轮结束后 forget 调用次数必须仍为 0`);
      assert.ok(recordedKeys.has(key), `第 ${round} 轮结束后 sessionKey "${key}" 必须依然驻留在存储中`);
    }

    // 验证库中 3 行均存活且均未被软删
    const db = new DatabaseSync(join(home, 'workbuddy.db'), { readOnly: true });
    try {
      const rows = db.prepare('SELECT id, deleted_at FROM automations').all();
      assert.equal(rows.length, 3, '3 轮点火行均应存在');
      for (const r of rows) {
        assert.equal(r.deleted_at, null, `行 ${r.id} 的 deleted_at 必须为 NULL`);
      }
    } finally {
      db.close();
    }
  } finally {
    restore();
    rmSync(home, { recursive: true, force: true });
  }
});

test('ADVERSARIAL-3.3: 对抗性边界 —— 上游取消 (abort signal) 必须正确判定为失败并清理会话', async () => {
  const home = fixtureHome();
  const restore = useHome(home);

  let forgetCalled = false;
  const store = {
    adopt: () => ({ ok: true }),
    forget: () => { forgetCalled = true; },
  };

  try {
    const ac = new AbortController();
    // 启动前即中断
    ac.abort();

    const run = startAutomationRun({
      prompt: 'ABORTED-RUN',
      cwd: 'C:\\test\\dir',
      sessionKey: 'aborted-key',
      sessionStore: store,
      signal: ac.signal,
      maxPollRounds: 5,
    });

    const out = await run.done;
    assert.equal(out.status, 'failed', '上游取消信号触发必须收敛为 failed (不能冒充 still_running)');
    assert.equal(out.exitCode, 1);
    assert.equal(forgetCalled, true, '被取消的任务必须清理 sessionStore 记性');
  } finally {
    restore();
    rmSync(home, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试 4：配置 Knobs 与动态轮数边界对抗
// ─────────────────────────────────────────────────────────────────────────────

test('ADVERSARIAL-4.1: buildPollWaits 极端与非法边界防护', () => {
  // 非正数超时 (0ms, 负数, NaN) 防御性回落为默认 900_000ms (181 轮)
  const zero = buildPollWaits({ timeoutMs: 0 });
  assert.equal(zero.rounds, 181, '0ms 预算防御性回落至默认 181 轮 (900_000ms)');

  const neg = buildPollWaits({ timeoutMs: -500 });
  assert.equal(neg.rounds, 181, '负数预算防御性回落至默认 181 轮 (900_000ms)');

  const nanVal = buildPollWaits({ timeoutMs: Number.NaN });
  assert.equal(nanVal.rounds, 181, 'NaN 预算防御性回落至默认 181 轮 (900_000ms)');

  // 极小正数超时 (1ms, 1500ms) <= first (2000ms) -> 恰好 1 轮
  const tiny1 = buildPollWaits({ timeoutMs: 1 });
  assert.equal(tiny1.rounds, 1, '1ms 预算推导为恰好 1 轮');
  assert.deepEqual(tiny1.waits, [2_000]);

  const tiny1500 = buildPollWaits({ timeoutMs: 1_500 });
  assert.equal(tiny1500.rounds, 1, '1500ms 预算推导为恰好 1 轮');
  assert.deepEqual(tiny1500.waits, [2_000]);

  // 超时恰好等于首轮等待 (2000ms)
  const exactFirst = buildPollWaits({ timeoutMs: 2_000 });
  assert.equal(exactFirst.rounds, 1);
  assert.equal(exactFirst.waits[0], 2_000);

  // 超时略大于首轮等待 (2001ms) -> 2 轮
  const slightlyOver = buildPollWaits({ timeoutMs: 2_001 });
  assert.equal(slightlyOver.rounds, 2);
  assert.equal(slightlyOver.waits.length, 2);
  assert.equal(slightlyOver.waits[0], 2_000);
  assert.equal(slightlyOver.waits[1], 5_000);

  // 15 分钟标准推导 (900_000ms) -> 181 轮 (总计 902_000ms)
  const m15 = buildPollWaits({ timeoutMs: 900_000 });
  assert.equal(m15.rounds, 181);
  assert.equal(m15.waits.reduce((a, b) => a + b, 0), 902_000);

  // 30 分钟标准推导 (1_800_000ms) -> 361 轮 (总计 1_802_000ms)
  const m30 = buildPollWaits({ timeoutMs: 1_800_000 });
  assert.equal(m30.rounds, 361);
  assert.equal(m30.waits.reduce((a, b) => a + b, 0), 1_802_000);

  // 1 小时压力推导 (3_600_000ms) -> 721 轮
  const h1 = buildPollWaits({ timeoutMs: 3_600_000 });
  assert.equal(h1.rounds, 721);
});

test('ADVERSARIAL-4.2: tools/run.js 对非法/缺失 automationTimeoutMs 配置的容错回落', async () => {
  // 测试配置变异：各种非法/非数值传入，确认不会导致崩溃且安全执行
  const invalidConfigs = [
    { automationTimeoutMs: 0 },
    { automationTimeoutMs: -1000 },
    { automationTimeoutMs: 'invalid_string' },
    { automationTimeoutMs: null },
    { automationTimeoutMs: undefined },
    { automationTimeoutMs: NaN },
  ];

  for (const cfg of invalidConfigs) {
    const h = createRunToolHarness({
      status: 'still_running',
      configOverrides: cfg,
    });

    const res = await h.tool.execute({ prompt: 'test-fuzz-config' }, { signal: new AbortController().signal });
    assert.ok(res.job_id, '异常配置下依然必须正常启动 job');
    const settled = await h.handles[0].done;
    assert.equal(settled.status, 'still_running');
    assert.equal(h.runtimeFinishes[0].code, 0);
  }
});
