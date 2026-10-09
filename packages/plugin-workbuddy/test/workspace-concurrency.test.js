/**
 * Milestone 4 (R4): 工作区并发互斥与焦点保护套件 (Workspace Concurrency & Focus Protection).
 *
 * Implements verification for:
 *   - F10: Per-workspace concurrency mutex in runtime.js (serialize/reject on same cwd, distinct run up to cap = 3).
 *   - F11: Structured busy rejection with code ERR_WORKSPACE_BUSY across reason-codes, run.js, and subagent/execute.js.
 *   - F12: Background focus protection in automation.js (is_background_automation = 1, promoteSession never called while active).
 *
 * @module test/workspace-concurrency.test
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
  DEFAULT_CONCURRENCY_CAP,
} from '../src/host/config/runtime.js';
import { makeRunTool } from '../src/host/tools/run.js';
import { createTaskExecutor } from '../src/host/subagent/execute.js';
import {
  insertSession,
  promoteSession,
} from '../src/host/gateway/automation.js';

// ── 1. Reason Codes: ERR_WORKSPACE_BUSY ──────────────────────────────────────────

test('REASON_CODES.WORKSPACE_BUSY: 结构化错误码与失败归类契约', () => {
  assert.equal(REASON_CODES.WORKSPACE_BUSY, 'ERR_WORKSPACE_BUSY', '错误码必须逐字等于 ERR_WORKSPACE_BUSY');
  assert.equal(FAILURE_CODES.has(REASON_CODES.WORKSPACE_BUSY), true, 'ERR_WORKSPACE_BUSY 必须登记进 FAILURE_CODES');
  assert.equal(isFailureCode(REASON_CODES.WORKSPACE_BUSY), true, 'isFailureCode(ERR_WORKSPACE_BUSY) 必须为 true');
  assert.ok(REASON_TEXT[REASON_CODES.WORKSPACE_BUSY], 'REASON_TEXT 必须包含解释文本');
  assert.match(REASON_TEXT[REASON_CODES.WORKSPACE_BUSY], /(?:workspace.*busy|busy|工作区.*繁忙)/i, '解释文本必须体现工作区繁忙');
});

// ── 2. normalizeWorkspaceKey 归一化规范 ──────────────────────────────────────────

test('normalizeWorkspaceKey: 路径斜杠、盘符大小写、尾部斜杠与空缺归一化', () => {
  // 盘符与斜杠归一化
  const winPath = 'D:\\Projects\\App\\';
  const posixPath = 'd:/projects/app';
  assert.equal(normalizeWorkspaceKey(winPath), normalizeWorkspaceKey(posixPath));
  assert.equal(normalizeWorkspaceKey('c:\\repo\\'), normalizeWorkspaceKey('C:/repo'));

  // 相对路径解析
  const rel = './subfolder';
  const expectedRel = resolve(process.cwd(), rel).replace(/\\/g, '/').toLowerCase();
  assert.equal(normalizeWorkspaceKey(rel).toLowerCase(), expectedRel);

  // 空值 / 空白字符 / null / undefined 统一回退 '__default__'
  assert.equal(normalizeWorkspaceKey(''), '__default__');
  assert.equal(normalizeWorkspaceKey('   '), '__default__');
  assert.equal(normalizeWorkspaceKey(null), '__default__');
  assert.equal(normalizeWorkspaceKey(undefined), '__default__');
  assert.equal(normalizeWorkspaceKey('\t\n'), '__default__');
});

// ── 3. Runtime Mutex & Concurrency Cap ─────────────────────────────────────────

test('createRuntimeBase: 单工作区互斥与跨工作区并发锁机制', () => {
  const runtime = createRuntimeBase({ concurrencyCap: 3 });

  // 初始状态
  assert.deepEqual(runtime.inFlightByWorkspace(), {});
  assert.equal(runtime.isWorkspaceBusy('D:/ws-a'), false);

  // 工作区 A 成功获取锁
  assert.equal(runtime.acquireWorkspaceLock('D:/ws-a', 'job-1'), true);
  assert.equal(runtime.isWorkspaceBusy('D:/ws-a'), true);
  // 同一工作区（不同形式写法）再次获取锁必须被拒绝
  assert.equal(runtime.acquireWorkspaceLock('d:\\ws-a\\', 'job-2'), false);

  // 工作区 B 成功获取锁（不同工作区允许并发）
  assert.equal(runtime.acquireWorkspaceLock('D:/ws-b', 'job-2'), true);
  assert.equal(runtime.isWorkspaceBusy('D:/ws-b'), true);

  // 释放工作区 A（使用错误的 jobId 无法释放）
  assert.equal(runtime.releaseWorkspaceLock('D:/ws-a', 'wrong-job'), false);
  assert.equal(runtime.isWorkspaceBusy('D:/ws-a'), true);

  // 正常释放工作区 A
  assert.equal(runtime.releaseWorkspaceLock('D:/ws-a', 'job-1'), true);
  assert.equal(runtime.isWorkspaceBusy('D:/ws-a'), false);

  // 释放后，工作区 A 允许再次获取锁
  assert.equal(runtime.acquireWorkspaceLock('D:/ws-a', 'job-3'), true);
  assert.equal(runtime.isWorkspaceBusy('D:/ws-a'), true);

  // 清除全部锁
  runtime.clearWorkspaceLocks();
  assert.deepEqual(runtime.inFlightByWorkspace(), {});
  assert.equal(runtime.isWorkspaceBusy('D:/ws-a'), false);
  assert.equal(runtime.isWorkspaceBusy('D:/ws-b'), false);
});

test('createRuntimeBase: 并发上限 (concurrencyCap = 3) 拦截与自愈', () => {
  const runtime = createRuntimeBase({ concurrencyCap: 3 });
  assert.equal(DEFAULT_CONCURRENCY_CAP, 3);

  // 分别锁定 3 个不同的工作区
  assert.equal(runtime.acquireWorkspaceLock('D:/ws-1', 'job-1'), true);
  assert.equal(runtime.acquireWorkspaceLock('D:/ws-2', 'job-2'), true);
  assert.equal(runtime.acquireWorkspaceLock('D:/ws-3', 'job-3'), true);

  // 第 4 个不同工作区由于达到 cap=3，必须被拒绝
  assert.equal(runtime.acquireWorkspaceLock('D:/ws-4', 'job-4'), false);
  assert.equal(runtime.isWorkspaceBusy('D:/ws-4'), false);

  // 释放其中一个工作区
  assert.equal(runtime.releaseWorkspaceLock('D:/ws-2', 'job-2'), true);

  // 此时第 4 个工作区可以成功获取锁
  assert.equal(runtime.acquireWorkspaceLock('D:/ws-4', 'job-4'), true);
  assert.equal(runtime.isWorkspaceBusy('D:/ws-4'), true);

  runtime.clearWorkspaceLocks();
});

test('createRuntimeBase: runtime.forget(jobId) 自动释放工作区锁', () => {
  const runtime = createRuntimeBase();

  assert.equal(runtime.acquireWorkspaceLock('D:/repo/my-project', 'job-forget-1'), true);
  assert.equal(runtime.isWorkspaceBusy('D:/repo/my-project'), true);

  // forget 触发自动解锁
  runtime.forget('job-forget-1');
  assert.equal(runtime.isWorkspaceBusy('D:/repo/my-project'), false);

  // 重新获取成功
  assert.equal(runtime.acquireWorkspaceLock('D:/repo/my-project', 'job-forget-2'), true);
  runtime.clearWorkspaceLocks();
});

// ── 4. workbuddy_run Tool (run.js) Concurrency & Lock Handling ────────────────

function createMockRunEnvironment({ configOverrides = {} } = {}) {
  const runtime = createRuntimeBase({ concurrencyCap: 3 });
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

  const sessions = {
    createKey: () => 'test-session-key',
    resumable: () => null,
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
          readOutput: () => 'automation-mock-output',
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
    completeAutomation: (payload = {
      status: 'completed',
      detail: 'all good',
      exitCode: 0,
      automation: {
        reason: null,
        automationId: 'auto-1',
        conversationId: 'conv-1',
        sessionId: 'conv-1',
        reply: 'all good',
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

test('workbuddy_run: 同一工作区并发下发直接拒绝并抛出 ERR_WORKSPACE_BUSY', async () => {
  const env = createMockRunEnvironment();

  // 第一次下发（开始运行中，尚未 settle）
  await env.tool.execute({
    prompt: 'task 1',
    cwd: 'D:/repo/project-a',
  });

  // 工作区已处于忙碌锁定状态
  assert.equal(env.runtime.isWorkspaceBusy('D:/repo/project-a'), true);

  // 第二次下发至相同工作区（大小写与路径写法略有差异）必须直接抛出 ERR_WORKSPACE_BUSY
  await assert.rejects(
    async () => {
      await env.tool.execute({
        prompt: 'task 2',
        cwd: 'd:\\repo\\project-a\\',
      });
    },
    (err) => {
      assert.equal(err.code, 'ERR_WORKSPACE_BUSY', '错误码必须是 ERR_WORKSPACE_BUSY');
      assert.equal(err.reasonCode, 'ERR_WORKSPACE_BUSY');
      assert.equal(err.status, 'busy');
      assert.match(err.message, /busy/i);
      return true;
    },
    '同一工作区的并发任务必须被拒绝',
  );

  // 完成 task 1
  env.completeAutomation();
  await env.waitForHandles();

  // task 1 结算后工作区锁被释放
  assert.equal(env.runtime.isWorkspaceBusy('D:/repo/project-a'), false);

  // 再次下发至 project-a 即可成功
  await env.tool.execute({
    prompt: 'task 3',
    cwd: 'D:/repo/project-a',
  });
  assert.equal(env.runtime.isWorkspaceBusy('D:/repo/project-a'), true);
  env.completeAutomation();
  await env.waitForHandles();
  assert.equal(env.runtime.isWorkspaceBusy('D:/repo/project-a'), false);
});

test('workbuddy_run: throwOnBusy: false 时返回结构化 busy 对象而不是 throw', async () => {
  const env = createMockRunEnvironment();

  // 先锁住工作区
  env.runtime.acquireWorkspaceLock('D:/repo/project-busy', 'job-lock');

  const result = await env.tool.execute({
    prompt: 'task no throw',
    cwd: 'D:/repo/project-busy',
    throwOnBusy: false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'busy');
  assert.equal(result.error, 'ERR_WORKSPACE_BUSY');
  assert.equal(result.reasonCode, 'ERR_WORKSPACE_BUSY');
  assert.match(result.detail, /busy/i);

  env.runtime.clearWorkspaceLocks();
});

test('workbuddy_run: 不同工作区允许并发下发', async () => {
  const env = createMockRunEnvironment();

  // 下发工作区 A 与工作区 B
  await env.tool.execute({ prompt: 'task A', cwd: 'D:/repo/project-a' });
  await env.tool.execute({ prompt: 'task B', cwd: 'D:/repo/project-b' });

  assert.equal(env.runtime.isWorkspaceBusy('D:/repo/project-a'), true);
  assert.equal(env.runtime.isWorkspaceBusy('D:/repo/project-b'), true);

  env.completeAutomation();
  await env.waitForHandles();

  assert.equal(env.runtime.isWorkspaceBusy('D:/repo/project-a'), false);
  assert.equal(env.runtime.isWorkspaceBusy('D:/repo/project-b'), false);
});

test('workbuddy_run: 任务失败结算时同样释放工作区锁', async () => {
  const env = createMockRunEnvironment();

  await env.tool.execute({ prompt: 'task fail', cwd: 'D:/repo/project-fail' });
  assert.equal(env.runtime.isWorkspaceBusy('D:/repo/project-fail'), true);

  env.completeAutomation({
    status: 'failed',
    detail: 'task failed miserably',
    exitCode: 1,
    automation: {
      reason: REASON_CODES.TASK_ERROR,
      automationId: 'auto-fail',
      conversationId: null,
      phases: ['running'],
    },
  });

  await env.waitForHandles();
  // 失败后锁必须被释放，绝不永久死锁工作区
  assert.equal(env.runtime.isWorkspaceBusy('D:/repo/project-fail'), false);
});

test('workbuddy_run: 同步校验失败或派发前异常时立即释放工作区锁，杜绝锁泄漏', async () => {
  const env = createMockRunEnvironment();

  // 1. 测试 resume: true 但缺少记录时同步抛错，工作区锁必须立即释放
  await assert.rejects(
    async () => {
      await env.tool.execute({
        prompt: 'task resume without session',
        cwd: 'D:/repo/project-sync-fail',
        session_key: 'non-existent-key',
        resume: true,
      });
    },
    /no resumable session is recorded/,
  );

  assert.equal(
    env.runtime.isWorkspaceBusy('D:/repo/project-sync-fail'),
    false,
    '同步校验失败后工作区锁必须立即释放，绝不泄漏',
  );

  // 2. 释放后后续正常调用可以成功获取锁并执行
  await env.tool.execute({
    prompt: 'task retry after sync fail',
    cwd: 'D:/repo/project-sync-fail',
  });
  assert.equal(env.runtime.isWorkspaceBusy('D:/repo/project-sync-fail'), true);

  env.completeAutomation();
  await env.waitForHandles();
  assert.equal(env.runtime.isWorkspaceBusy('D:/repo/project-sync-fail'), false);
});

// ── 5. Subagent Executor (execute.js) Concurrency & Lock Handling ─────────────

test('createTaskExecutor: 子智能体任务互斥拦截与锁生命周期释放', async () => {
  const runtime = createRuntimeBase();

  let completeSubagentAutomation;
  const fakeAutomation = () => {
    let resolveDone;
    const donePromise = new Promise((res) => {
      resolveDone = res;
    });
    completeSubagentAutomation = resolveDone;
    return {
      cancel: () => {},
      done: donePromise,
      readOutput: () => 'subagent-output',
    };
  };

  const executor = createTaskExecutor({
    automation: fakeAutomation,
    acquireWorkspaceLock: (cwd, jobId) => runtime.acquireWorkspaceLock(cwd, jobId),
    releaseWorkspaceLock: (cwd, jobId) => runtime.releaseWorkspaceLock(cwd, jobId),
  });

  // 启动任务 1
  const task1Promise = executor({
    prompt: 'subagent task 1',
    cwd: 'D:/workspace/subagent-1',
  });

  // 工作区已被锁定
  assert.equal(runtime.isWorkspaceBusy('D:/workspace/subagent-1'), true);

  // 相同工作区的任务 2 必须被拦截并返回结构化失败报告
  const task2Result = await executor({
    prompt: 'subagent task 2',
    cwd: 'd:\\workspace\\subagent-1\\',
  });

  assert.equal(task2Result.ok, false);
  assert.equal(task2Result.reason, REASON_CODES.WORKSPACE_BUSY);
  assert.equal(task2Result.error?.code, 'ERR_WORKSPACE_BUSY');
  assert.match(task2Result.error?.message, /busy/i);

  // 完成任务 1
  completeSubagentAutomation({
    status: 'completed',
    detail: 'ok',
    exitCode: 0,
    automation: {
      reason: null,
      automationId: 'auto-sub-1',
      conversationId: 'conv-sub-1',
      sessionId: 'conv-sub-1',
      reply: 'subagent finished',
      phases: ['running'],
    },
  });

  const task1Result = await task1Promise;
  assert.equal(task1Result.ok, true);
  // 任务 1 结束后锁已在 finally 块中释放
  assert.equal(runtime.isWorkspaceBusy('D:/workspace/subagent-1'), false);

  // 随后再次执行任务 3 成功
  const task3Promise = executor({
    prompt: 'subagent task 3',
    cwd: 'D:/workspace/subagent-1',
  });
  assert.equal(runtime.isWorkspaceBusy('D:/workspace/subagent-1'), true);

  completeSubagentAutomation({
    status: 'completed',
    detail: 'ok',
    exitCode: 0,
    automation: {
      reason: null,
      automationId: 'auto-sub-3',
      conversationId: 'conv-sub-3',
      sessionId: 'conv-sub-3',
      reply: 'subagent 3 finished',
      phases: ['running'],
    },
  });
  const task3Result = await task3Promise;
  assert.equal(task3Result.ok, true);
  assert.equal(runtime.isWorkspaceBusy('D:/workspace/subagent-1'), false);
});

test('createTaskExecutor: 异常抛出时 finally 块保证工作区锁绝不泄漏', async () => {
  const runtime = createRuntimeBase();

  const explodingAutomation = () => {
    throw new Error('Explosion during automation ignition');
  };

  const executor = createTaskExecutor({
    automation: explodingAutomation,
    acquireWorkspaceLock: (cwd, jobId) => runtime.acquireWorkspaceLock(cwd, jobId),
    releaseWorkspaceLock: (cwd, jobId) => runtime.releaseWorkspaceLock(cwd, jobId),
  });

  const result = await executor({
    prompt: 'exploding task',
    cwd: 'D:/workspace/leak-test',
  });

  assert.equal(result.ok, false);
  assert.match(result.error.message, /Explosion during automation ignition/);
  // 必须被释放
  assert.equal(runtime.isWorkspaceBusy('D:/workspace/leak-test'), false);
});

// ── 6. Focus Protection & is_background_automation = 1 (automation.js) ─────────

test('gateway/automation.js: insertSession 强校验并写入 is_background_automation = 1', () => {
  const home = mkdtempSync(join(tmpdir(), 'wb-focus-test-'));
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

    const sessionObj = {
      id: 'session-bg-test-1',
      cwd: 'D:/repo/test',
      title: 'Background Automation Session',
      permissionMode: 'fullAccess',
      model: 'deepseek-v4.1-flash',
      thoughtLevel: null,
      isBackgroundAutomation: 1,
      createdAt: Date.now(),
    };

    insertSession(db, sessionObj);

    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get('session-bg-test-1');
    assert.ok(row, 'session 必须写入成功');
    assert.equal(row.is_background_automation, 1, 'is_background_automation 必须为 1，确保桌面端不抢夺焦点');

    // 变异测试：若有人篡改其为 0，insertSession 必须抛错阻止侵入前台
    assert.throws(
      () => {
        insertSession(db, {
          id: 'session-bg-bad',
          title: 'Bad Focus Session',
          isBackgroundAutomation: 0,
        });
      },
      /is_background_automation must be 1/,
      '若 is_background_automation 不为 1 必须报错拒绝',
    );
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('gateway/automation.js: promoteSession 契约 —— 仅在显式请求且处于非在途状态下使用', () => {
  const home = mkdtempSync(join(tmpdir(), 'wb-promote-test-'));
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

    db.prepare(`
      INSERT INTO sessions (id, cwd, title, permission_mode, model, thought_level, is_background_automation, session_settings, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('session-promote-1', '', '', null, null, null, 1, '{"automation":{}}', Date.now());

    // 初始状态为后台模式
    let row = db.prepare('SELECT is_background_automation, session_settings FROM sessions WHERE id = ?').get('session-promote-1');
    assert.equal(row.is_background_automation, 1);
    assert.equal(row.session_settings, '{"automation":{}}');

    // promoteSession 执行显式提权切换
    promoteSession(db, 'session-promote-1');

    row = db.prepare('SELECT is_background_automation, session_settings FROM sessions WHERE id = ?').get('session-promote-1');
    assert.equal(row.is_background_automation, null, 'promoteSession 必须将 is_background_automation 改为 NULL');
    assert.equal(row.session_settings, null, 'promoteSession 必须将 session_settings 改为 NULL');
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});
