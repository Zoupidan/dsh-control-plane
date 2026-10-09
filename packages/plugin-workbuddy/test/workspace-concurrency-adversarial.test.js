/**
 * Adversarial Stress & Empirical Verification Test Suite for Milestone 4 (R4).
 *
 * Covers:
 *   1. Path normalization stress testing (Windows casing, slashes, relative, trailing, empty) & lock collision.
 *   2. Concurrency cap stress testing (cap = 3 saturation, reentrancy, recovery, custom cap, forget).
 *   3. Lock release stress testing on errors & validation failures in workbuddy_run and executeTask.
 *
 * @module test/workspace-concurrency-adversarial.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import {
  REASON_CODES,
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

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 1: Path Normalization & Collision Adversarial Stress Testing
// ═══════════════════════════════════════════════════════════════════════════════

test('Adversarial 1.1: normalizeWorkspaceKey Windows 盘符与目录大小写穷举', () => {
  const variations = [
    'D:\\Projects\\Workspace',
    'd:\\projects\\workspace',
    'D:/Projects/Workspace',
    'd:/projects/workspace',
    'D:\\PROJECTS\\WORKSPACE',
    'd:/PROJECTS/workspace/',
    'D:/projects/workspace///',
  ];

  const canonicalKey = normalizeWorkspaceKey(variations[0]);
  for (const v of variations) {
    assert.equal(
      normalizeWorkspaceKey(v),
      canonicalKey,
      `路径变体 ${v} 必须归一化为相同的 canonical key: ${canonicalKey}`,
    );
  }
});

test('Adversarial 1.2: normalizeWorkspaceKey 斜杠方向、多重斜杠与末尾斜杠剥离', () => {
  const base = 'd:/repo/sub/dir';
  const inputs = [
    'd:/repo/sub/dir',
    'd:\\repo\\sub\\dir',
    'd:/repo\\sub/dir',
    'd:\\repo/sub\\dir',
    'd:/repo/sub/dir/',
    'd:/repo/sub/dir///',
    'd:\\repo\\sub\\dir\\',
    'd:\\repo\\sub\\dir\\\\\\\\',
  ];

  for (const input of inputs) {
    assert.equal(
      normalizeWorkspaceKey(input),
      base,
      `多重斜杠/反斜杠 ${input} 归一化后必须完全等于 ${base}`,
    );
  }
});

test('Adversarial 1.3: normalizeWorkspaceKey 相对路径、点号与冗余段解析', () => {
  const cwd = process.cwd();
  const expectedFoo = resolve(cwd, 'foo').replace(/\\/g, '/').toLowerCase();

  assert.equal(normalizeWorkspaceKey('./foo'), expectedFoo);
  assert.equal(normalizeWorkspaceKey('foo'), expectedFoo);
  assert.equal(normalizeWorkspaceKey('./bar/../foo'), expectedFoo);
  assert.equal(normalizeWorkspaceKey('bar/../foo/./'), expectedFoo);
  assert.equal(normalizeWorkspaceKey('.'), resolve(cwd).replace(/\\/g, '/').toLowerCase());
});

test('Adversarial 1.4: normalizeWorkspaceKey 空白、空串及非法输入统一回退 __default__', () => {
  const falsyOrEmpty = [
    '',
    ' ',
    '   ',
    '\t',
    '\n',
    '\r\n',
    null,
    undefined,
    123,
    {},
    [],
    true,
    false,
  ];

  for (const val of falsyOrEmpty) {
    assert.equal(
      normalizeWorkspaceKey(val),
      '__default__',
      `输入 ${JSON.stringify(val)} 必须安全回退至 __default__`,
    );
  }
});

test('Adversarial 1.5: 相同物理路径的不同语法表达必须在锁层发生互斥碰撞', () => {
  clearWorkspaceLocks();
  const runtime = createRuntimeBase();

  // 1. Windows 大小写与斜杠变体碰撞
  assert.equal(runtime.acquireWorkspaceLock('D:\\MyProject\\App\\', 'job-win1'), true);
  // 用 POSIX 格式与全小写请求同一路径 -> 必须碰撞拒绝
  assert.equal(runtime.acquireWorkspaceLock('d:/myproject/app', 'job-win2'), false);
  assert.equal(runtime.isWorkspaceBusy('d:/myproject/app/'), true);
  // 用带有多重尾部斜杠的变体 -> 必须碰撞拒绝
  assert.equal(runtime.acquireWorkspaceLock('D:/MyProject/App///', 'job-win3'), false);

  // 2. 相对路径与绝对路径碰撞
  const relPath = './test-collision-ws';
  const absPath = resolve(process.cwd(), 'test-collision-ws');
  assert.equal(runtime.acquireWorkspaceLock(relPath, 'job-rel1'), true);
  assert.equal(runtime.acquireWorkspaceLock(absPath, 'job-abs1'), false);
  assert.equal(runtime.acquireWorkspaceLock('test-collision-ws', 'job-rel2'), false);

  // 3. 空路径变体碰撞（均映射为 __default__）
  assert.equal(runtime.acquireWorkspaceLock('', 'job-def1'), true);
  assert.equal(runtime.acquireWorkspaceLock('   ', 'job-def2'), false);
  assert.equal(runtime.acquireWorkspaceLock(null, 'job-def3'), false);
  assert.equal(runtime.acquireWorkspaceLock(undefined, 'job-def4'), false);

  // 4. 独立物理路径不碰撞
  assert.equal(runtime.acquireWorkspaceLock('D:/Distinct/Path1', 'job-dist1'), false); // 此时已超过默认 cap 3

  clearWorkspaceLocks();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 2: Concurrency Cap (cap = 3) Adversarial Stress Testing
// ═══════════════════════════════════════════════════════════════════════════════

test('Adversarial 2.1: 并发上限 (concurrencyCap = 3) 严格饱和拦截与逐个释放恢复', () => {
  clearWorkspaceLocks();
  const runtime = createRuntimeBase({ concurrencyCap: 3 });

  // 准确允许 3 个不同工作区同时持有锁
  assert.equal(runtime.acquireWorkspaceLock('D:/ws-1', 'job-1'), true, 'ws-1 必须成功');
  assert.equal(runtime.acquireWorkspaceLock('D:/ws-2', 'job-2'), true, 'ws-2 必须成功');
  assert.equal(runtime.acquireWorkspaceLock('D:/ws-3', 'job-3'), true, 'ws-3 必须成功');

  const inFlight = runtime.inFlightByWorkspace();
  assert.equal(Object.keys(inFlight).length, 3, '必须有且仅有 3 个工作区在途');

  // 第 4、第 5、第 6 个不同工作区必须被严格拒绝
  assert.equal(runtime.acquireWorkspaceLock('D:/ws-4', 'job-4'), false, 'ws-4 必须被拦截');
  assert.equal(runtime.acquireWorkspaceLock('D:/ws-5', 'job-5'), false, 'ws-5 必须被拦截');
  assert.equal(runtime.acquireWorkspaceLock('D:/ws-6', 'job-6'), false, 'ws-6 必须被拦截');

  // 释放 ws-2
  assert.equal(runtime.releaseWorkspaceLock('D:/ws-2', 'job-2'), true);
  assert.equal(runtime.isWorkspaceBusy('D:/ws-2'), false);

  // 此时容量为 2，ws-4 允许获取锁
  assert.equal(runtime.acquireWorkspaceLock('D:/ws-4', 'job-4'), true, 'ws-4 在释放后必须成功');
  // 达到 3 后，ws-5 仍被拒绝
  assert.equal(runtime.acquireWorkspaceLock('D:/ws-5', 'job-5'), false, 'ws-5 仍应被拦截');

  // 释放剩余全部工作区
  assert.equal(runtime.releaseWorkspaceLock('D:/ws-1', 'job-1'), true);
  assert.equal(runtime.releaseWorkspaceLock('D:/ws-3', 'job-3'), true);
  assert.equal(runtime.releaseWorkspaceLock('D:/ws-4', 'job-4'), true);

  assert.equal(Object.keys(runtime.inFlightByWorkspace()).length, 0);

  // 随后 ws-5 与 ws-6 成功获取锁
  assert.equal(runtime.acquireWorkspaceLock('D:/ws-5', 'job-5'), true);
  assert.equal(runtime.acquireWorkspaceLock('D:/ws-6', 'job-6'), true);

  clearWorkspaceLocks();
});

test('Adversarial 2.2: 饱和状态下 (cap = 3) 的同作业幂等重入与不同作业互斥', () => {
  clearWorkspaceLocks();
  const runtime = createRuntimeBase({ concurrencyCap: 3 });

  assert.equal(runtime.acquireWorkspaceLock('D:/ws-1', 'job-1'), true);
  assert.equal(runtime.acquireWorkspaceLock('D:/ws-2', 'job-2'), true);
  assert.equal(runtime.acquireWorkspaceLock('D:/ws-3', 'job-3'), true);

  // 在饱和态下，ws-1 的同一 job-1 再次 acquire 必须幂等返回 true，且总计数不超限
  assert.equal(runtime.acquireWorkspaceLock('d:/ws-1/', 'job-1'), true, '同一 job-1 重入必须成功');
  assert.equal(Object.keys(runtime.inFlightByWorkspace()).length, 3, '计数不应超出 3');

  // 在饱和态下，ws-1 尝试用不同的 job-x acquire 必须返回 false
  assert.equal(runtime.acquireWorkspaceLock('d:/ws-1/', 'job-x'), false, '不同 job 必须拒绝');

  clearWorkspaceLocks();
});

test('Adversarial 2.3: 自定义并发上限与非法 cap 安全回退 DEFAULT_CONCURRENCY_CAP', () => {
  clearWorkspaceLocks();

  // 自定义 cap = 1
  const runtimeCap1 = createRuntimeBase({ concurrencyCap: 1 });
  assert.equal(runtimeCap1.acquireWorkspaceLock('D:/cap1-a', 'job-1'), true);
  assert.equal(runtimeCap1.acquireWorkspaceLock('D:/cap1-b', 'job-2'), false);
  runtimeCap1.releaseWorkspaceLock('D:/cap1-a', 'job-1');
  clearWorkspaceLocks();

  // 非法 cap (<= 0, NaN, null) 必须自动安全回退 DEFAULT_CONCURRENCY_CAP (3)
  const invalidCaps = [0, -1, -99, NaN, null, undefined, 'three'];
  for (const cap of invalidCaps) {
    clearWorkspaceLocks();
    const runtime = createRuntimeBase({ concurrencyCap: cap });
    assert.equal(runtime.acquireWorkspaceLock('D:/ws-a', 'job-a'), true);
    assert.equal(runtime.acquireWorkspaceLock('D:/ws-b', 'job-b'), true);
    assert.equal(runtime.acquireWorkspaceLock('D:/ws-c', 'job-c'), true);
    // 第 4 个必须被拦截
    assert.equal(runtime.acquireWorkspaceLock('D:/ws-d', 'job-d'), false);
  }

  clearWorkspaceLocks();
});

test('Adversarial 2.4: runtime.forget(jobId) 级联释放工作区锁并恢复总并发配额', () => {
  clearWorkspaceLocks();
  const runtime = createRuntimeBase({ concurrencyCap: 3 });

  // 占满 3 个槽位
  runtime.acquireWorkspaceLock('D:/ws-1', 'job-1');
  runtime.start('job-1', {});
  runtime.acquireWorkspaceLock('D:/ws-2', 'job-2');
  runtime.start('job-2', {});
  runtime.acquireWorkspaceLock('D:/ws-3', 'job-3');
  runtime.start('job-3', {});

  assert.equal(runtime.acquireWorkspaceLock('D:/ws-4', 'job-4'), false);

  // forget job-2
  runtime.forget('job-2');
  assert.equal(runtime.isWorkspaceBusy('D:/ws-2'), false, 'forget 后 ws-2 必须不再 busy');

  // 现在 ws-4 可以成功获取
  assert.equal(runtime.acquireWorkspaceLock('D:/ws-4', 'job-4'), true, 'ws-4 必须可以获取');

  clearWorkspaceLocks();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 3: Lock Release on Errors and Validation Failures
// ═══════════════════════════════════════════════════════════════════════════════

function createMockRunEnvironment(options = {}) {
  clearWorkspaceLocks();
  const runtime = createRuntimeBase({ concurrencyCap: 3 });
  runtime.awaitDetection = async () => ({ installed: true, reason: 'ok' });

  const handles = [];
  const jobs = {
    start(spec) {
      if (options.jobsThrow) {
        throw new Error('jobs.start crashed unexpectedly');
      }
      const handle = spec.run();
      handles.push(handle);
      return `job-${handles.length}`;
    },
  };

  const sessions = {
    createKey: () => 'test-session-key',
    resumable: (k) => (k === 'valid-resumable' ? { cliSessionId: 'sess-valid', cwd: 'D:/ws' } : null),
    adopt: () => ({ ok: true }),
    forget: () => {},
    supersede: () => {},
  };

  const config = {
    enabled: true,
    model: 'deepseek-v4.1-flash',
    effort: '',
    cwdRoot: 'D:/repo',
    boundSessionId: '',
    automationTimeoutMs: 900_000,
  };

  const completers = [];
  const tool = makeRunTool(
    runtime,
    sessions,
    () => config,
    { jobs, subprocess: {} },
    null,
    null,
    {
      automationRun: (args) => {
        if (options.automationRunThrow) {
          throw new Error('automationRun threw synchronously during dispatch');
        }
        let resolveDone;
        let rejectDone;
        const donePromise = new Promise((res, rej) => {
          resolveDone = res;
          rejectDone = rej;
        });
        completers.push({ resolve: resolveDone, reject: rejectDone });
        return {
          cancel: () => {},
          done: donePromise,
          readOutput: () => 'output',
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
    completeAutomation: (payload = { status: 'completed', detail: 'done', exitCode: 0, automation: {} }) => {
      while (completers.length > 0) {
        const c = completers.shift();
        c.resolve(payload);
      }
    },
    rejectAutomation: (err = new Error('automation failed async')) => {
      while (completers.length > 0) {
        const c = completers.shift();
        c.reject(err);
      }
    },
    waitForHandles: () => Promise.all(handles.map((h) => h?.done)),
  };
}

test('Adversarial 3.1: workbuddy_run 校验失败 (resume: true 无 session_key) 必须立即释放工作区锁', async () => {
  const env = createMockRunEnvironment();
  const testCwd = 'D:/test-repo/val-1';

  await assert.rejects(
    async () => {
      await env.tool.execute({
        prompt: 'test prompt',
        cwd: testCwd,
        resume: true,
        // 缺少 session_key
      });
    },
    /requires session_key/i,
  );

  // 核心断言：校验失败退出时，工作区锁必须已被释放！
  assert.equal(
    env.runtime.isWorkspaceBusy(testCwd),
    false,
    `校验失败后工作区 ${testCwd} 绝对不得遗留处于锁定状态`,
  );

  // 后续合法请求必须能够立即获取锁并执行
  await env.tool.execute({
    prompt: 'subsequent valid prompt',
    cwd: testCwd,
  });
  assert.equal(env.runtime.isWorkspaceBusy(testCwd), true);
  env.completeAutomation();
  await env.waitForHandles();
  assert.equal(env.runtime.isWorkspaceBusy(testCwd), false);
});

test('Adversarial 3.2: workbuddy_run 校验失败 (resume: true 传入不存在的 key) 必须立即释放工作区锁', async () => {
  const env = createMockRunEnvironment();
  const testCwd = 'D:/test-repo/val-2';

  await assert.rejects(
    async () => {
      await env.tool.execute({
        prompt: 'test prompt',
        cwd: testCwd,
        resume: true,
        session_key: 'non-existent-session-key',
      });
    },
    /no resumable session is recorded/i,
  );

  // 核心断言：工作区锁必须已被释放
  assert.equal(
    env.runtime.isWorkspaceBusy(testCwd),
    false,
    `校验失败后工作区 ${testCwd} 绝对不得遗留处于锁定状态`,
  );
});

test('Adversarial 3.3: workbuddy_run 异步 done 拒绝 (Promise rejection) 必须正常释放工作区锁', async () => {
  const env = createMockRunEnvironment();
  const testCwd = 'D:/test-repo/async-rej';

  await env.tool.execute({
    prompt: 'async rej prompt',
    cwd: testCwd,
  });

  assert.equal(env.runtime.isWorkspaceBusy(testCwd), true);

  // 触发异步异常拒绝
  env.rejectAutomation(new Error('underlying connection crashed'));
  await env.waitForHandles();

  // 异常收敛结算后，工作区锁必须被释放
  assert.equal(
    env.runtime.isWorkspaceBusy(testCwd),
    false,
    '异步任务抛错后工作区锁必须正常释放',
  );
});

test('Adversarial 3.4: workbuddy_run 同步派发异常时锁释放保证 (FINDING CHECK)', async () => {
  // 场景：automationRun 同步抛出异常
  const env = createMockRunEnvironment({ automationRunThrow: true });
  const testCwd = 'D:/test-repo/sync-throw';

  let threw = false;
  try {
    await env.tool.execute({
      prompt: 'prompt during sync throw',
      cwd: testCwd,
    });
  } catch (err) {
    threw = true;
    assert.match(err.message, /automationRun threw synchronously/);
  }
  assert.equal(threw, true, '必须抛出异常');

  const busyAfterSyncThrow = env.runtime.isWorkspaceBusy(testCwd);
  // 如果此处为 true，说明同步抛出异常时未能释放已获取的锁！
  assert.equal(
    busyAfterSyncThrow,
    false,
    'CRITICAL: workbuddy_run 同步抛出异常时工作区锁被泄露（永久死锁）！',
  );
});

test('Adversarial 3.5: workbuddy_run jobs.start 同步异常时锁释放保证 (FINDING CHECK)', async () => {
  // 场景：jobs.start 同步抛出异常
  const env = createMockRunEnvironment({ jobsThrow: true });
  const testCwd = 'D:/test-repo/jobs-throw';

  let threw = false;
  try {
    await env.tool.execute({
      prompt: 'prompt during jobs throw',
      cwd: testCwd,
    });
  } catch (err) {
    threw = true;
    assert.match(err.message, /jobs\.start crashed/);
  }
  assert.equal(threw, true, '必须抛出异常');

  const busyAfterJobsThrow = env.runtime.isWorkspaceBusy(testCwd);
  // 如果此处为 true，说明 jobs.start 抛出异常时未能释放已获取的锁！
  assert.equal(
    busyAfterJobsThrow,
    false,
    'CRITICAL: jobs.start 同步抛出异常时工作区锁被泄露（永久死锁）！',
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 4: Subagent Executor (executeTask) Lock Lifecycle & Error Guarantees
// ═══════════════════════════════════════════════════════════════════════════════

test('Adversarial 4.1: executeTask 校验失败 (prompt 为空) 绝不提前锁定工作区', async () => {
  clearWorkspaceLocks();
  const runtime = createRuntimeBase();

  const executor = createTaskExecutor({
    automation: () => ({ cancel: () => {}, done: Promise.resolve({}), readOutput: () => '' }),
    acquireWorkspaceLock: (cwd, jobId) => runtime.acquireWorkspaceLock(cwd, jobId),
    releaseWorkspaceLock: (cwd, jobId) => runtime.releaseWorkspaceLock(cwd, jobId),
  });

  const res = await executor({
    prompt: '   ',
    cwd: 'D:/subagent/empty-prompt',
  });

  assert.equal(res.ok, false);
  assert.equal(res.reason, REASON_CODES.TASK_ERROR);
  assert.equal(runtime.isWorkspaceBusy('D:/subagent/empty-prompt'), false);
});

test('Adversarial 4.2: executeTask 在底层 automation 同步抛错时由 finally 保证释放锁', async () => {
  clearWorkspaceLocks();
  const runtime = createRuntimeBase();

  const executor = createTaskExecutor({
    automation: () => {
      throw new Error('subagent ignition exploded synchronously');
    },
    acquireWorkspaceLock: (cwd, jobId) => runtime.acquireWorkspaceLock(cwd, jobId),
    releaseWorkspaceLock: (cwd, jobId) => runtime.releaseWorkspaceLock(cwd, jobId),
  });

  const res = await executor({
    prompt: 'will throw synchronously',
    cwd: 'D:/subagent/sync-throw',
  });

  assert.equal(res.ok, false);
  assert.equal(res.reason, REASON_CODES.TASK_ERROR);
  assert.match(res.error?.message, /exploded synchronously/);

  // 必须被 finally 块完全释放
  assert.equal(
    runtime.isWorkspaceBusy('D:/subagent/sync-throw'),
    false,
    'executeTask 异常退出后工作区锁必须已释放',
  );
});

test('Adversarial 4.3: executeTask 在底层 handle.done 异步 reject 时由 finally 保证释放锁', async () => {
  clearWorkspaceLocks();
  const runtime = createRuntimeBase();

  const executor = createTaskExecutor({
    automation: () => ({
      cancel: () => {},
      done: Promise.reject(new Error('subagent async done rejected')),
      readOutput: () => '',
    }),
    acquireWorkspaceLock: (cwd, jobId) => runtime.acquireWorkspaceLock(cwd, jobId),
    releaseWorkspaceLock: (cwd, jobId) => runtime.releaseWorkspaceLock(cwd, jobId),
  });

  const res = await executor({
    prompt: 'will reject asynchronously',
    cwd: 'D:/subagent/async-reject',
  });

  assert.equal(res.ok, false);
  assert.equal(res.reason, REASON_CODES.TASK_ERROR);
  assert.match(res.error?.message, /rejected/);

  // 必须被 finally 块完全释放
  assert.equal(
    runtime.isWorkspaceBusy('D:/subagent/async-reject'),
    false,
    'executeTask 异步失败后工作区锁必须已释放',
  );
});
