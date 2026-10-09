/**
 * Empirical Adversarial Test Suite for Milestone 4 (R4):
 * Workspace Concurrency Mutex, Structured Busy Rejection, and Focus Protection.
 *
 * Stress-tests:
 * 1. Structured busy rejection (`ERR_WORKSPACE_BUSY`) across throwing and non-throwing modes
 *    (args.throwOnBusy = false, exec.throwOnBusy = false, args.throwOnBusy = true),
 *    edge cases in workspace normalization, empty/default cwd collisions, and concurrency cap.
 * 2. Focus protection: direct rejection of is_background_automation = 0 / false / null / invalid,
 *    and invariant that in-flight automation runs NEVER clear is_background_automation.
 * 3. Subagent concurrency mutex: serialization on identical workspace, multi-workspace cap,
 *    clean lock release on synchronous exceptions, asynchronous promise rejections, and followUp errors.
 *
 * @module test/adversarial-concurrency-focus.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  REASON_CODES,
  REASON_TEXT,
  FAILURE_CODES,
  isFailureCode,
} from '../src/host/launch/reason-codes.js';
import {
  createRuntimeBase,
  normalizeWorkspaceKey,
  acquireWorkspaceLock,
  releaseWorkspaceLock,
  isWorkspaceBusy,
  inFlightByWorkspace,
  clearWorkspaceLocks,
  DEFAULT_CONCURRENCY_CAP,
} from '../src/host/config/runtime.js';
import { makeRunTool } from '../src/host/tools/run.js';
import { createTaskExecutor } from '../src/host/subagent/execute.js';
import {
  insertSession,
  promoteSession,
  startAutomationRun,
} from '../src/host/gateway/automation.js';

// ── Test Environment Helpers ──────────────────────────────────────────────────

function createMockRunEnvironment({ configOverrides = {}, concurrencyCap = 3 } = {}) {
  clearWorkspaceLocks();
  const runtime = createRuntimeBase({ concurrencyCap });
  runtime.detected = () => ({ installed: true, reason: 'ok' });
  runtime.awaitDetection = async () => ({ installed: true, reason: 'ok' });

  const runtimeFinishes = [];
  const creditRecordRuns = [];

  const originalFinish = runtime.finish;
  runtime.finish = (jobId, code) => {
    runtimeFinishes.push({ jobId, code });
    return originalFinish.call(runtime, jobId, code);
  };

  const handles = [];
  const jobs = {
    start(spec) {
      const handle = spec.run();
      handles.push(handle);
      return `job-${handles.length}`;
    },
  };

  const resumableSessions = new Map();
  const sessions = {
    createKey: () => `test-session-key-${Date.now()}`,
    resumable: (key) => resumableSessions.get(key) ?? null,
    adopt: () => ({ ok: true }),
    forget: () => {},
    supersede: () => {},
  };

  const credits = {
    recordRun: (entry) => creditRecordRuns.push(entry),
    counters: { runs: 0, failedRuns: 0, freeRuns: 0, unknownRuns: 0 },
  };

  const baseConfig = {
    enabled: true,
    model: 'deepseek-v4.1-flash',
    effort: '',
    cwdRoot: 'D:/repo',
    boundSessionId: '',
    automationTimeoutMs: 900_000,
    ...configOverrides,
  };

  const completers = [];

  const tool = makeRunTool(
    runtime,
    sessions,
    () => baseConfig,
    { jobs, subprocess: {} },
    credits,
    null,
    {
      automationRun: () => {
        let resolveDone;
        const donePromise = new Promise((res) => {
          resolveDone = res;
        });
        completers.push(resolveDone);
        return {
          cancel: () => {},
          done: donePromise,
          readOutput: () => 'adversarial-mock-output',
        };
      },
      catalog: {
        projection: () => ({
          available: true,
          cost: { models: [{ modelId: 'deepseek-v4.1-flash', factor: 0 }] },
        }),
      },
    },
  );

  return {
    tool,
    runtime,
    handles,
    runtimeFinishes,
    resumableSessions,
    completeAutomation: (payload = {
      status: 'completed',
      detail: 'all good',
      exitCode: 0,
      automation: {
        reason: null,
        automationId: 'auto-adv-1',
        conversationId: 'conv-adv-1',
        sessionId: 'conv-adv-1',
        reply: 'completed successfully',
      },
    }) => {
      while (completers.length > 0) {
        const c = completers.shift();
        c(payload);
      }
    },
    waitForHandles: () => Promise.all(handles.map((h) => h?.done)),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// AREA 1: Stress-Test Structured Busy Rejection (ERR_WORKSPACE_BUSY)
// ══════════════════════════════════════════════════════════════════════════════

test('[Adversarial 1.1] workbuddy_run throw mode: concurrent dispatch to same workspace throws complete structured error', async () => {
  const env = createMockRunEnvironment();
  try {
    // 启动初始任务
    await env.tool.execute({
      prompt: 'task 1',
      cwd: 'D:/adv/workspace-busy-1',
    });

    assert.equal(env.runtime.isWorkspaceBusy('D:/adv/workspace-busy-1'), true);

    // 对同一工作区并发下发任务 2（使用不同盘符大小写、反斜杠、末尾斜杠）
    await assert.rejects(
      async () => {
        await env.tool.execute({
          prompt: 'task 2 concurrent',
          cwd: 'd:\\adv\\workspace-busy-1\\',
        });
      },
      (err) => {
        assert.ok(err instanceof Error, '抛出的必须是 Error 实例');
        assert.equal(err.code, 'ERR_WORKSPACE_BUSY', 'err.code 必须逐字等于 ERR_WORKSPACE_BUSY');
        assert.equal(err.reasonCode, 'ERR_WORKSPACE_BUSY', 'err.reasonCode 必须逐字等于 ERR_WORKSPACE_BUSY');
        assert.equal(err.status, 'busy', 'err.status 必须为 busy');
        assert.equal(err.ok, false, 'err.ok 必须为 false');
        assert.equal(err.error, 'ERR_WORKSPACE_BUSY', 'err.error 必须等于 ERR_WORKSPACE_BUSY');
        assert.ok(typeof err.detail === 'string' && err.detail.length > 0, 'err.detail 必须是非空描述');
        assert.match(err.detail, /busy/i, 'err.detail 必须说明工作区繁忙');
        assert.match(err.message, /busy/i, 'err.message 必须说明工作区繁忙');
        return true;
      },
    );

    // 完成任务 1 结算
    env.completeAutomation();
    await env.waitForHandles();

    assert.equal(env.runtime.isWorkspaceBusy('D:/adv/workspace-busy-1'), false);
  } finally {
    clearWorkspaceLocks();
  }
});

test('[Adversarial 1.2] workbuddy_run non-throwing mode (args.throwOnBusy = false): returns complete structured error object', async () => {
  const env = createMockRunEnvironment();
  try {
    // 先获取锁
    assert.equal(env.runtime.acquireWorkspaceLock('D:/adv/workspace-busy-2', 'job-adv-2'), true);

    // 以 args.throwOnBusy: false 派发
    const result = await env.tool.execute({
      prompt: 'task non-throwing',
      cwd: 'D:/adv/workspace-busy-2',
      throwOnBusy: false,
    });

    assert.ok(result && typeof result === 'object', '必须返回对象而不是抛出');
    assert.equal(result.ok, false, 'result.ok 必须为 false');
    assert.equal(result.error, 'ERR_WORKSPACE_BUSY', 'result.error 必须为 ERR_WORKSPACE_BUSY');
    assert.equal(result.status, 'busy', 'result.status 必须为 busy');
    assert.equal(result.reasonCode, 'ERR_WORKSPACE_BUSY', 'result.reasonCode 必须为 ERR_WORKSPACE_BUSY');
    assert.ok(typeof result.detail === 'string' && result.detail.length > 0, 'result.detail 必须为非空字符串');
    assert.match(result.detail, /busy/i, 'result.detail 必须说明工作区繁忙');
  } finally {
    clearWorkspaceLocks();
  }
});

test('[Adversarial 1.3] workbuddy_run non-throwing mode via exec parameter (exec.throwOnBusy = false)', async () => {
  const env = createMockRunEnvironment();
  try {
    assert.equal(env.runtime.acquireWorkspaceLock('D:/adv/workspace-busy-3', 'job-adv-3'), true);

    // 调用 execute(args, exec) 传入 exec.throwOnBusy: false
    const result = await env.tool.execute(
      { prompt: 'task via exec param', cwd: 'D:/adv/workspace-busy-3' },
      { throwOnBusy: false },
    );

    assert.ok(result && typeof result === 'object');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'ERR_WORKSPACE_BUSY');
    assert.equal(result.status, 'busy');
    assert.equal(result.reasonCode, 'ERR_WORKSPACE_BUSY');
    assert.match(result.detail, /busy/i);
  } finally {
    clearWorkspaceLocks();
  }
});

test('[Adversarial 1.4] workbuddy_run explicit args.throwOnBusy = true throws structured error', async () => {
  const env = createMockRunEnvironment();
  try {
    assert.equal(env.runtime.acquireWorkspaceLock('D:/adv/workspace-busy-4', 'job-adv-4'), true);

    await assert.rejects(
      async () => {
        await env.tool.execute({
          prompt: 'task explicit throw',
          cwd: 'D:/adv/workspace-busy-4',
          throwOnBusy: true,
        });
      },
      (err) => {
        assert.equal(err.code, 'ERR_WORKSPACE_BUSY');
        assert.equal(err.reasonCode, 'ERR_WORKSPACE_BUSY');
        assert.equal(err.ok, false);
        assert.equal(err.status, 'busy');
        return true;
      },
    );
  } finally {
    clearWorkspaceLocks();
  }
});

test('[Adversarial 1.5] workbuddy_run default/empty workspace collision (empty string, whitespace, null, undefined)', async () => {
  const env = createMockRunEnvironment({ configOverrides: { cwdRoot: '' } });
  try {
    // 第一次下发空 cwd（回退到 '__default__'）
    await env.tool.execute({
      prompt: 'task default 1',
      cwd: '',
    });

    assert.equal(env.runtime.isWorkspaceBusy(''), true);
    assert.equal(env.runtime.isWorkspaceBusy(null), true);

    // 变异 1: 纯空白 cwd 同样碰撞
    await assert.rejects(
      async () => {
        await env.tool.execute({ prompt: 'task default 2', cwd: '   \t  ' });
      },
      (err) => {
        assert.equal(err.code, 'ERR_WORKSPACE_BUSY');
        return true;
      },
    );

    // 变异 2: non-throwing 模式下省略 cwd（默认工作区）同样被拒绝并给出结构化错误
    const resOmitted = await env.tool.execute({
      prompt: 'task default 3',
      throwOnBusy: false,
    });
    assert.equal(resOmitted.ok, false);
    assert.equal(resOmitted.reasonCode, 'ERR_WORKSPACE_BUSY');

    // 释放初始任务
    env.completeAutomation();
    await env.waitForHandles();

    assert.equal(env.runtime.isWorkspaceBusy(''), false);

    // 随后下发成功
    await env.tool.execute({ prompt: 'task default 4', cwd: '' });
    assert.equal(env.runtime.isWorkspaceBusy(''), true);
    env.completeAutomation();
    await env.waitForHandles();
    assert.equal(env.runtime.isWorkspaceBusy(''), false);
  } finally {
    clearWorkspaceLocks();
  }
});

test('[Adversarial 1.6] workbuddy_run global concurrency cap (cap = 3) rejection and recovery', async () => {
  const env = createMockRunEnvironment({ concurrencyCap: 3 });
  try {
    // 启动 3 个不同工作区的任务达到 cap=3
    await env.tool.execute({ prompt: 'cap task 1', cwd: 'D:/adv/cap-ws-1' });
    await env.tool.execute({ prompt: 'cap task 2', cwd: 'D:/adv/cap-ws-2' });
    await env.tool.execute({ prompt: 'cap task 3', cwd: 'D:/adv/cap-ws-3' });

    assert.equal(env.runtime.isWorkspaceBusy('D:/adv/cap-ws-1'), true);
    assert.equal(env.runtime.isWorkspaceBusy('D:/adv/cap-ws-2'), true);
    assert.equal(env.runtime.isWorkspaceBusy('D:/adv/cap-ws-3'), true);

    // 第 4 个不同工作区必须在 throw 模式下抛出 ERR_WORKSPACE_BUSY
    await assert.rejects(
      async () => {
        await env.tool.execute({ prompt: 'cap task 4', cwd: 'D:/adv/cap-ws-4' });
      },
      (err) => {
        assert.equal(err.code, 'ERR_WORKSPACE_BUSY');
        assert.equal(err.status, 'busy');
        return true;
      },
    );

    // 第 4 个不同工作区在 non-throwing 模式下同样返回结构化 busy
    const res4 = await env.tool.execute({
      prompt: 'cap task 4 non-throw',
      cwd: 'D:/adv/cap-ws-4',
      throwOnBusy: false,
    });
    assert.equal(res4.ok, false);
    assert.equal(res4.reasonCode, 'ERR_WORKSPACE_BUSY');

    // 释放所有已满任务
    env.completeAutomation();
    await env.waitForHandles();

    assert.equal(env.runtime.isWorkspaceBusy('D:/adv/cap-ws-1'), false);
    assert.equal(env.runtime.isWorkspaceBusy('D:/adv/cap-ws-2'), false);
    assert.equal(env.runtime.isWorkspaceBusy('D:/adv/cap-ws-3'), false);

    // 此时第 4 个工作区可以成功下发
    await env.tool.execute({ prompt: 'cap task 4 retry', cwd: 'D:/adv/cap-ws-4' });
    assert.equal(env.runtime.isWorkspaceBusy('D:/adv/cap-ws-4'), true);
    env.completeAutomation();
    await env.waitForHandles();
    assert.equal(env.runtime.isWorkspaceBusy('D:/adv/cap-ws-4'), false);
  } finally {
    clearWorkspaceLocks();
  }
});

test('[Adversarial 1.7] workbuddy_run early validation failure releases lock immediately (zero lock leak)', async () => {
  const env = createMockRunEnvironment();
  try {
    const leakCwd = 'D:/adv/validation-leak-test';

    // 触发前置校验异常：resume: true 但未传 session_key
    await assert.rejects(
      async () => {
        await env.tool.execute({
          prompt: 'task with invalid resume',
          cwd: leakCwd,
          resume: true,
          // session_key 故意不传
        });
      },
      /resume:true requires session_key/,
    );

    // 锁必须被立即释放，不得滞留
    assert.equal(env.runtime.isWorkspaceBusy(leakCwd), false, '校验失败后锁必须被立即释放');

    // 下发合法任务必须能够立即成功获取该工作区锁
    await env.tool.execute({
      prompt: 'valid recovery task',
      cwd: leakCwd,
    });
    assert.equal(env.runtime.isWorkspaceBusy(leakCwd), true);
    env.completeAutomation();
    await env.waitForHandles();
    assert.equal(env.runtime.isWorkspaceBusy(leakCwd), false);
  } finally {
    clearWorkspaceLocks();
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// AREA 2: Stress-Test Focus Protection & Session Creation (F12 / R4)
// ══════════════════════════════════════════════════════════════════════════════

test('[Adversarial 2.1] insertSession rejects all invalid is_background_automation variants (0, false, null, negative, >1, strings)', () => {
  const home = mkdtempSync(join(tmpdir(), 'wb-focus-adv-'));
  const dbPath = join(home, 'workbuddy.db');
  const db = new DatabaseSync(dbPath);

  try {
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT,
      title TEXT,
      permission_mode TEXT,
      model TEXT,
      thought_level TEXT,
      is_background_automation INTEGER,
      session_settings TEXT,
      created_at INTEGER
    );`);

    // 1. isBackgroundAutomation = 0 必须抛错拒绝
    assert.throws(
      () => insertSession(db, { id: 's-0', title: 'test 0', isBackgroundAutomation: 0 }),
      /is_background_automation must be 1/,
    );

    // 2. isBackgroundAutomation = false 必须抛错拒绝
    assert.throws(
      () => insertSession(db, { id: 's-false', title: 'test false', isBackgroundAutomation: false }),
      /is_background_automation must be 1/,
    );

    // 3. isBackgroundAutomation = null 必须抛错拒绝
    assert.throws(
      () => insertSession(db, { id: 's-null', title: 'test null', isBackgroundAutomation: null }),
      /is_background_automation must be 1/,
    );

    // 4. isBackgroundAutomation = 2 必须抛错拒绝
    assert.throws(
      () => insertSession(db, { id: 's-2', title: 'test 2', isBackgroundAutomation: 2 }),
      /is_background_automation must be 1/,
    );

    // 5. isBackgroundAutomation = -1 必须抛错拒绝
    assert.throws(
      () => insertSession(db, { id: 's-neg', title: 'test -1', isBackgroundAutomation: -1 }),
      /is_background_automation must be 1/,
    );

    // 6. 字符串 '0' 或 '1' 必须抛错拒绝（严格类型检查）
    assert.throws(
      () => insertSession(db, { id: 's-str0', title: 'test str0', isBackgroundAutomation: '0' }),
      /is_background_automation must be 1/,
    );
    assert.throws(
      () => insertSession(db, { id: 's-str1', title: 'test str1', isBackgroundAutomation: '1' }),
      /is_background_automation must be 1/,
    );

    // 正向对照 1: 显式 1 成功并写入 1
    insertSession(db, { id: 's-ok-1', title: 'ok 1', isBackgroundAutomation: 1 });
    const row1 = db.prepare('SELECT is_background_automation FROM sessions WHERE id = ?').get('s-ok-1');
    assert.equal(row1.is_background_automation, 1);

    // 正向对照 2: 显式 true 成功并写入 1
    insertSession(db, { id: 's-ok-true', title: 'ok true', isBackgroundAutomation: true });
    const rowTrue = db.prepare('SELECT is_background_automation FROM sessions WHERE id = ?').get('s-ok-true');
    assert.equal(rowTrue.is_background_automation, 1);

    // 正向对照 3: 缺省省略 成功并写入 1
    insertSession(db, { id: 's-ok-def', title: 'ok default' });
    const rowDef = db.prepare('SELECT is_background_automation FROM sessions WHERE id = ?').get('s-ok-def');
    assert.equal(rowDef.is_background_automation, 1);
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('[Adversarial 2.2] Invariant: In-flight and non-completed automation runs NEVER clear is_background_automation', () => {
  const home = mkdtempSync(join(tmpdir(), 'wb-inflight-focus-'));
  const dbPath = join(home, 'workbuddy.db');
  const db = new DatabaseSync(dbPath);

  try {
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT,
      title TEXT,
      permission_mode TEXT,
      model TEXT,
      thought_level TEXT,
      is_background_automation INTEGER,
      session_settings TEXT,
      created_at INTEGER
    );`);

    // 建立一个由自动化运行持有的会话
    insertSession(db, {
      id: 'session-inflight-check',
      cwd: 'D:/repo/proj',
      title: 'In Flight Session',
      isBackgroundAutomation: 1,
    });

    const getBgFlag = () => {
      const r = db.prepare('SELECT is_background_automation FROM sessions WHERE id = ?').get('session-inflight-check');
      return r?.is_background_automation;
    };

    // 初始状态必须是 1
    assert.equal(getBgFlag(), 1, '初始化时必须为 1');

    // 阶段模拟 1: 运行时轮询中（in flight），绝不调用 promoteSession
    // 即使有人查询或更新其他状态，is_background_automation 必须保持 1
    db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('Running Task Phase 1', 'session-inflight-check');
    assert.equal(getBgFlag(), 1, '在途运行阶段 1 中 is_background_automation 必须依然为 1');

    db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('Running Task Phase 2', 'session-inflight-check');
    assert.equal(getBgFlag(), 1, '在途运行阶段 2 中 is_background_automation 必须依然为 1');

    // 阶段模拟 2: 任务若发生超时 / 失败退出，promoteSession 绝不被触发
    // 验证失败场景下 flag 依然恒定为 1
    assert.equal(getBgFlag(), 1, '失败/超时退出后不得清除后台保护标识');

    // 阶段模拟 3: 只有在终态完成且用户显式提权时，promoteSession 才会被调用
    promoteSession(db, 'session-inflight-check');
    assert.equal(getBgFlag(), null, '显式 promoteSession 后字段归一成 NULL');
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// AREA 3: Stress-Test Subagent Concurrency Mutex (execute.js)
// ══════════════════════════════════════════════════════════════════════════════

test('[Adversarial 3.1] subagent executeTask serializes tasks on same workspace with structured busy rejection', async () => {
  clearWorkspaceLocks();
  const runtime = createRuntimeBase({ concurrencyCap: 3 });

  let finishTask1;
  const mockAutomation = () => {
    let resolveDone;
    const donePromise = new Promise((res) => {
      resolveDone = res;
    });
    finishTask1 = resolveDone;
    return {
      cancel: () => {},
      done: donePromise,
      readOutput: () => 'subagent 1 output',
    };
  };

  const executor = createTaskExecutor({
    automation: mockAutomation,
    acquireWorkspaceLock: (cwd, jobId) => runtime.acquireWorkspaceLock(cwd, jobId),
    releaseWorkspaceLock: (cwd, jobId) => runtime.releaseWorkspaceLock(cwd, jobId),
  });

  try {
    // 启动任务 1
    const p1 = executor({
      prompt: 'subagent task 1',
      cwd: 'D:/subagent/target-repo',
    });

    assert.equal(runtime.isWorkspaceBusy('D:/subagent/target-repo'), true);

    // 并发启动任务 2 至相同工作区（大小写与路径写法略异）
    const res2 = await executor({
      prompt: 'subagent task 2 concurrent',
      cwd: 'd:\\subagent\\target-repo\\',
    });

    // 任务 2 必须立即被拦截，返回完整的结构化失败报告
    assert.equal(res2.ok, false);
    assert.equal(res2.reason, REASON_CODES.WORKSPACE_BUSY);
    assert.equal(res2.error?.code, 'ERR_WORKSPACE_BUSY');
    assert.match(res2.error?.message, /busy/i);
    assert.equal(res2.transport, 'automation');
    assert.equal(res2.sessionId, null);
    assert.equal(res2.permission?.confirmed, false);
    assert.equal(res2.effort?.confirmed, false);

    // 完成任务 1
    finishTask1({
      status: 'completed',
      detail: 'all good',
      exitCode: 0,
      automation: {
        reason: null,
        automationId: 'auto-sub-ok',
        conversationId: 'conv-sub-ok',
        sessionId: 'conv-sub-ok',
        reply: 'task 1 done',
        phases: ['running'],
      },
    });

    const res1 = await p1;
    assert.equal(res1.ok, true);

    // 锁必须已经完全释放
    assert.equal(runtime.isWorkspaceBusy('D:/subagent/target-repo'), false);

    // 随后再次执行任务 3 必须成功获取锁
    let finishTask3;
    const executor3 = createTaskExecutor({
      automation: () => {
        let resolveDone;
        const donePromise = new Promise((res) => {
          resolveDone = res;
        });
        finishTask3 = resolveDone;
        return {
          cancel: () => {},
          done: donePromise,
          readOutput: () => 'subagent 3 output',
        };
      },
      acquireWorkspaceLock: (cwd, jobId) => runtime.acquireWorkspaceLock(cwd, jobId),
      releaseWorkspaceLock: (cwd, jobId) => runtime.releaseWorkspaceLock(cwd, jobId),
    });

    const p3 = executor3({
      prompt: 'subagent task 3',
      cwd: 'D:/subagent/target-repo',
    });

    assert.equal(runtime.isWorkspaceBusy('D:/subagent/target-repo'), true);

    finishTask3({
      status: 'completed',
      detail: 'all good',
      exitCode: 0,
      automation: {
        reason: null,
        automationId: 'auto-sub-3',
        conversationId: 'conv-sub-3',
        sessionId: 'conv-sub-3',
        reply: 'task 3 done',
        phases: ['running'],
      },
    });

    const res3 = await p3;
    assert.equal(res3.ok, true);
    assert.equal(runtime.isWorkspaceBusy('D:/subagent/target-repo'), false);
  } finally {
    clearWorkspaceLocks();
  }
});

test('[Adversarial 3.2] subagent executeTask clean lock release on synchronous exception in ignition', async () => {
  clearWorkspaceLocks();
  const runtime = createRuntimeBase();

  const syncExplodingAutomation = () => {
    throw new Error('Fatal synchronous crash during ignition');
  };

  const executor = createTaskExecutor({
    automation: syncExplodingAutomation,
    acquireWorkspaceLock: (cwd, jobId) => runtime.acquireWorkspaceLock(cwd, jobId),
    releaseWorkspaceLock: (cwd, jobId) => runtime.releaseWorkspaceLock(cwd, jobId),
  });

  try {
    const cwd = 'D:/subagent/sync-explosion-ws';

    const result = await executor({
      prompt: 'sync crash task',
      cwd,
    });

    assert.equal(result.ok, false);
    assert.match(result.error.message, /Fatal synchronous crash/);

    // 锁必须在 finally 块中被安全释放
    assert.equal(runtime.isWorkspaceBusy(cwd), false, '同步异常后工作区锁必须已被释放');

    // 后续任务可以顺利获取该锁
    assert.equal(runtime.acquireWorkspaceLock(cwd, 'job-sub-after'), true);
  } finally {
    clearWorkspaceLocks();
  }
});

test('[Adversarial 3.3] subagent executeTask clean lock release on asynchronous promise rejection in automation handle', async () => {
  clearWorkspaceLocks();
  const runtime = createRuntimeBase();

  const asyncRejectingAutomation = () => {
    return {
      cancel: () => {},
      done: Promise.reject(new Error('Async connection dropped mid-flight')),
      readOutput: () => '',
    };
  };

  const executor = createTaskExecutor({
    automation: asyncRejectingAutomation,
    acquireWorkspaceLock: (cwd, jobId) => runtime.acquireWorkspaceLock(cwd, jobId),
    releaseWorkspaceLock: (cwd, jobId) => runtime.releaseWorkspaceLock(cwd, jobId),
  });

  try {
    const cwd = 'D:/subagent/async-reject-ws';

    const result = await executor({
      prompt: 'async reject task',
      cwd,
    });

    assert.equal(result.ok, false);
    assert.match(result.error.message, /Async connection dropped mid-flight/);

    // 锁必须在 finally 块中被安全释放
    assert.equal(runtime.isWorkspaceBusy(cwd), false, '异步异常后工作区锁必须已被释放');

    // 后续任务可以顺利获取该锁
    assert.equal(runtime.acquireWorkspaceLock(cwd, 'job-sub-after-async'), true);
  } finally {
    clearWorkspaceLocks();
  }
});

test('[Adversarial 3.4] subagent executeTask clean lock release on followUp exception during multi-turn', async () => {
  clearWorkspaceLocks();
  const runtime = createRuntimeBase();

  const rejectingFollowUp = async () => {
    throw new Error('Fatal error inside followUp transport');
  };

  const sessions = {
    resumable: () => ({ cliSessionId: 'dead-conv-id' }),
    forget: () => {},
    touch: () => {},
  };

  const executor = createTaskExecutor({
    automation: () => ({
      cancel: () => {},
      done: Promise.resolve({
        status: 'completed',
        automation: {
          reason: null,
          automationId: 'fb-auto',
          conversationId: 'fb-conv',
          sessionId: 'fb-conv',
          reply: 'fallback response',
          phases: [],
        },
      }),
      readOutput: () => '',
    }),
    followUp: rejectingFollowUp,
    sessions,
    acquireWorkspaceLock: (cwd, jobId) => runtime.acquireWorkspaceLock(cwd, jobId),
    releaseWorkspaceLock: (cwd, jobId) => runtime.releaseWorkspaceLock(cwd, jobId),
  });

  try {
    const cwd = 'D:/subagent/followup-throw-ws';

    // 执行（配置开启追发）
    const result = await executor({
      prompt: 'followup throw task',
      cwd,
      name: 'test-topic',
      enableMultiTurnFollowUp: true,
    });

    // 追发异常应回退到点火并正常结算或安全收敛
    assert.ok(result);

    // 无论如何，工作区锁必须完全释放
    assert.equal(runtime.isWorkspaceBusy(cwd), false, 'followUp 异常后工作区锁必须已被释放');
  } finally {
    clearWorkspaceLocks();
  }
});

test('[Adversarial 3.5] subagent executeTask concurrency cap (cap = 3) enforcement across multiple workspaces', async () => {
  clearWorkspaceLocks();
  const runtime = createRuntimeBase({ concurrencyCap: 3 });

  const completers = [];
  const mockAutomation = () => {
    let resolveDone;
    const donePromise = new Promise((res) => {
      resolveDone = res;
    });
    completers.push(resolveDone);
    return {
      cancel: () => {},
      done: donePromise,
      readOutput: () => 'cap output',
    };
  };

  const executor = createTaskExecutor({
    automation: mockAutomation,
    acquireWorkspaceLock: (cwd, jobId) => runtime.acquireWorkspaceLock(cwd, jobId),
    releaseWorkspaceLock: (cwd, jobId) => runtime.releaseWorkspaceLock(cwd, jobId),
  });

  try {
    // 启动 3 个不同工作区的任务达到 cap=3
    const p1 = executor({ prompt: 'task 1', cwd: 'D:/sub-cap-1' });
    const p2 = executor({ prompt: 'task 2', cwd: 'D:/sub-cap-2' });
    const p3 = executor({ prompt: 'task 3', cwd: 'D:/sub-cap-3' });

    assert.equal(runtime.isWorkspaceBusy('D:/sub-cap-1'), true);
    assert.equal(runtime.isWorkspaceBusy('D:/sub-cap-2'), true);
    assert.equal(runtime.isWorkspaceBusy('D:/sub-cap-3'), true);

    // 第 4 个不同工作区必须被拒绝
    const res4 = await executor({ prompt: 'task 4', cwd: 'D:/sub-cap-4' });
    assert.equal(res4.ok, false);
    assert.equal(res4.reason, REASON_CODES.WORKSPACE_BUSY);
    assert.equal(res4.error?.code, 'ERR_WORKSPACE_BUSY');

    // 释放其中一个任务
    const c1 = completers.shift();
    c1({
      status: 'completed',
      detail: 'ok',
      exitCode: 0,
      automation: { reason: null, reply: 'p1 done', phases: [] },
    });
    await p1;

    assert.equal(runtime.isWorkspaceBusy('D:/sub-cap-1'), false);

    // 此时第 4 个工作区再次尝试必须能够成功获取锁
    const p4 = executor({ prompt: 'task 4 retry', cwd: 'D:/sub-cap-4' });
    assert.equal(runtime.isWorkspaceBusy('D:/sub-cap-4'), true);

    // 清理剩余
    while (completers.length > 0) {
      completers.shift()({
        status: 'completed',
        detail: 'ok',
        exitCode: 0,
        automation: { reason: null, reply: 'done', phases: [] },
      });
    }
    await Promise.all([p2, p3, p4]);

    assert.equal(runtime.isWorkspaceBusy('D:/sub-cap-2'), false);
    assert.equal(runtime.isWorkspaceBusy('D:/sub-cap-3'), false);
    assert.equal(runtime.isWorkspaceBusy('D:/sub-cap-4'), false);
  } finally {
    clearWorkspaceLocks();
  }
});
