/**
 * @file 会话可二次下发 —— 每轮点火建新行（禁CLI禁网关）。
 *
 * <p>语义（可二次下发口径）：
 * 同一个 `session_key` 首轮走点火 INSERT 一行 once（`resumed:false`），点火在
 * `sessions.id` 一确认就 `adopt` 记住；第二轮同 key 允许再次 `startAutomationRun`
 * 建新可见对话（INSERT once 新行，真下发），成功后 `adopt` 覆盖记性为新 id
 * （旧 id 视为 superseded 被替代），失败沿旧回收（`forget`，下轮重建）。
 * `resume:false` 同样新开。不再有“已记住就失败”分支，仅保留点火/收口失败 forget。
 * 网关仍全禁（`void dispatch`，不调 `continueSession`）。
 * 职责：调用方只传 `session_key` + `resume`，插件管记住/回收。
 *
 * <p>★ 本文件只碰假点火 + 内存记性，绝不写真库 ★
 * 首个用例即自证套件级护栏（`WORKBUDDY_TEST_HOME_GUARD` + 落点非真库），
 * 与 `automation-early-retire.test.js` 同款双防线（结构上写不到真库 + 行数报警）。
 * 点火函数经 `seams` 注入，永不触真机；`dispatch` 即便传入也不得被调用
 * （网关已禁用，`run.js` 内 `void dispatch`）。
 *
 * @module test/multi-turn-reuse
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { makeRunTool } from '../src/host/tools/run.js';
import { workbuddyDbPath } from '../src/host/gateway/automation.js';

const PROBE_OK = { installed: true, reason: 'ok' };
const REAL_DB = join(homedir(), '.workbuddy', 'workbuddy.db');

function makeRuntime() {
  const rt = {
    notes: [],
    detected: () => PROBE_OK,
    awaitDetection: async () => PROBE_OK,
    inFlightCount: () => 0,
    start: () => {}, finish: () => {}, forget: () => {},
    noteRun: (rec) => { rt.notes.push(rec); },
    registry: () => undefined,
    setRegistry: () => {},
  };
  return rt;
}

function makeJobs() {
  const handles = [];
  return { handles, start(spec) { handles.push(spec.run()); return `job-${handles.length}`; } };
}

const CFG = () => ({
  enabled: true, model: '', effort: '', cwdRoot: 'C:/repo',
  transport: 'automation', boundSessionId: '',
});

/**
 * 装一套被测环境。
 *
 * ★ 假点火模拟真点火的记账语义：成功即调 `sessionStore.adopt(sessionKey, {cliSessionId})`
 * （真机是 `sessions.id` 一确认就 adopt，覆盖记性为新 id），失败调 `forget`
 * （真机是终态失败即 forget，沿旧回收）。
 * 如此第二轮同 key 走可二次下发（再 INSERT 一行 once），与真链一致。
 * `failNext` 置 true 时下一轮点火返回失败（验失败 forget 回收）。
 * ★ 假网关仅作"不得被调用"的探针：即便传入，任何分支也不得触它（`void dispatch`）。
 */
function harness({ failNext = false } = {}) {
  const runtime = makeRuntime();
  const jobs = makeJobs();
  const sessions = makeSessions();
  const automationCalls = [];
  const dispatchCalls = [];
  let fireCount = 0;
  let failOnce = failNext;

  const fakeAutomation = (req) => {
    automationCalls.push(req);
    fireCount += 1;
    const n = fireCount;
    const cid = `conv-${n}`;
    if (failOnce) {
      failOnce = false;
      try { req.sessionStore?.forget?.(req.sessionKey); } catch { /* 忽略 */ }
      return {
        cancel: () => {},
        done: Promise.resolve({
          status: 'failed', detail: 'SIM-FAIL', exitCode: 1,
          automation: {
            reason: 'task_error', automationId: `automation-${n}`, conversationId: null,
            sessionId: null, sessionKey: req.sessionKey ?? null, sessionPersist: null,
            retired: true, transcriptPath: null, reply: null,
            creditsUsed: null, model: null, permission: null,
            usedModelId: null, sessionCwd: req.cwd ?? null,
            tokensUsed: null, phases: ['db-open'],
          },
        }),
        readOutput: () => 'SIM-FAIL',
      };
    }
    try { req.sessionStore?.adopt?.(req.sessionKey, { cliSessionId: cid, cwd: req.cwd ?? '', own: true }); } catch { /* 忽略 */ }
    return {
      cancel: () => {},
      done: Promise.resolve({
        status: 'completed', detail: `REPLY-${n}`, exitCode: 0,
        automation: {
          reason: null, automationId: `automation-${n}`, conversationId: cid,
          sessionId: cid, sessionKey: req.sessionKey ?? null, sessionPersist: { ok: true },
          retired: true, transcriptPath: null, reply: `REPLY-${n}`,
          creditsUsed: null, model: null, permission: null,
          usedModelId: null, sessionCwd: req.cwd ?? null,
          tokensUsed: null, phases: ['db-open', 'running'],
        },
      }),
      readOutput: () => `REPLY-${n}`,
    };
  };

  // ★ 网关已禁用：该对象只记录"被误调"，正常链路永不触它。
  const fakeDispatch = {
    continueSession: async (req) => {
      dispatchCalls.push({ ...req, via: 'continueSession' });
      throw new Error('gateway disabled: continueSession must not be called');
    },
    run: async (req) => {
      dispatchCalls.push({ ...req, viaFallbackRun: true });
      throw new Error('gateway disabled: dispatch.run must not be called');
    },
  };

  const tool = makeRunTool(
    runtime, sessions, CFG, { jobs, subprocess: {} }, null, fakeDispatch,
    { automationRun: fakeAutomation },
  );

  return { runtime, jobs, sessions, automationCalls, dispatchCalls,
    call: (args) => tool.execute(args, { signal: new AbortController().signal }) };
}

function makeSessions() {
  const store = new Map();
  const forgotten = [];
  return {
    store, forgotten,
    createKey: () => `auto-${store.size + 1}`,
    resumable: (k) => {
      const r = store.get(k);
      if (!r) return null;
      if (r.superseded === true || r.unconfirmed === true) return null;
      if (typeof r.cliSessionId !== 'string' || r.cliSessionId === '') return null;
      return { cliSessionId: r.cliSessionId, cwd: r.cwd ?? null };
    },
    lookup: (k) => store.get(k) ?? null,
    adopt: (k, rec) => {
      store.set(k, { cliSessionId: rec.cliSessionId, cwd: rec.cwd ?? null, own: rec.own === true, superseded: false, unconfirmed: false });
      return { ok: true };
    },
    forget: (k) => {
      forgotten.push(k);
      const prev = store.get(k);
      if (!prev) return { ok: false };
      store.set(k, { ...prev, superseded: true });
      return { ok: true };
    },
    supersede: (k) => {
      forgotten.push(k);
      const prev = store.get(k);
      if (!prev) return { ok: false };
      store.set(k, { ...prev, superseded: true });
      return { ok: true };
    },
  };
}

test('⓪ 套件级护栏生效：WORKBUDDY_HOME 指着一次性 tmp，真库结构上不可达', () => {
  assert.equal(
    process.env.WORKBUDDY_TEST_HOME_GUARD,
    'on',
    '★ 套件级护栏没生效 —— 必须经 npm run test:host（含 --import ./tools/dev/test-home-guard.mjs）运行',
  );
  const home = process.env.WORKBUDDY_HOME ?? '';
  assert.ok(
    home.startsWith(tmpdir()),
    `★ WORKBUDDY_HOME 必须落在系统临时目录下，实际：${home}`,
  );
  assert.ok(
    !REAL_DB.startsWith(home),
    '★ 真库路径必须不在 WORKBUDDY_HOME 之下（否则任何疏漏都会写进用户真库）',
  );
  assert.notEqual(workbuddyDbPath(), REAL_DB, '★★ 点火落点绝不能是真库');
});

test('R1 ★ 第一轮：无记住 ⇒ 走点火（automation），参数逐字透传，resumed:false，且禁网关', async () => {
  const h = harness();
  const r = await h.call({ prompt: 'round one', session_key: 'K' });
  assert.equal(h.automationCalls.length, 1, '必须走点火下发（每轮唯一写入点）');
  assert.equal(h.automationCalls[0].sessionKey, 'K', 'sessionKey 必须透给点火（adopt 记账的键）');
  assert.ok(h.automationCalls[0].sessionStore !== undefined, 'sessionStore 必须透给点火（否则 adopt 永不发生）');
  assert.ok(typeof h.automationCalls[0].sessionStore.adopt === 'function', '写口必须带 adopt');
  assert.equal(h.dispatchCalls.length, 0, '★ 网关已禁用：首轮绝不能调网关');
  await h.jobs.handles[0].done;
  assert.equal(r.session_key, 'K');
  assert.equal(r.resumed, false, '★ 首轮无记住 ⇒ 新对话');
  assert.equal(r.resumed_session_id, '');
  assert.deepEqual(r.not_sent, [], '首轮真下发 ⇒ not_sent 为空');
  assert.equal(h.sessions.resumable('K')?.cliSessionId, 'conv-1', '★ 首轮成功必须 adopt 记住（后续命中的前提）');
});

test('R2 ★★★ 同一个 session_key 第二轮 ⇒ 可二次下发（再 INSERT once 新行、completed、id 更新为 conv-2）', async () => {
  const h = harness();
  await h.call({ prompt: 'round one', session_key: 'K' });
  await h.jobs.handles[0].done;
  assert.equal(h.sessions.resumable('K')?.cliSessionId, 'conv-1', '前置：首轮 adopt 记住 conv-1');
  const second = await h.call({ prompt: 'round two', session_key: 'K' });
  const secondDone = await h.jobs.handles[1].done;

  assert.equal(h.automationCalls.length, 2, '★★ 第二轮必须再调点火（INSERT once 新行，可二次下发）');
  assert.equal(h.automationCalls[1].sessionKey, 'K', '★ 第二轮 sessionKey 必须透给点火（adopt 覆盖的键）');
  assert.ok(typeof h.automationCalls[1].sessionStore?.adopt === 'function', '★ 第二轮必须带 adopt 写口');
  assert.equal(h.dispatchCalls.length, 0, '★★ 网关仍全禁：第二轮也不得调网关（void dispatch）');
  assert.equal(second.session_key, 'K');
  assert.equal(second.resumed, false, '★ 每轮新对话 ⇒ resumed:false');
  assert.equal(second.resumed_session_id, '', '★ 新对话下发时 id 尚未确认 ⇒ 空');
  assert.deepEqual(second.not_sent, [], '★ 真下发 ⇒ not_sent 为空');
  // ★ 终态成功：completed + 新行 + 新 id。
  assert.equal(secondDone.status, 'completed', '★ 第二轮新对话可下发 ⇒ completed');
  assert.equal(secondDone.detail, 'REPLY-2', '★ 第二轮回执为新行产物');
  const last = h.runtime.notes[1];
  assert.equal(last?.transport, 'automation');
  assert.equal(last?.reasonCode, 'ok', '★ 成功轮 reasonCode 为 ok');
  assert.equal(last?.sessionOrigin, 'new', '★ 每轮新对话 origin 为 new');
  assert.equal(last?.resumed, false, 'lastRun 记 resumed:false');
  assert.equal(last?.sessionId, 'conv-2', '★ 成功后 adopt 覆盖记性为新 id');
  assert.match(last?.automationId ?? '', /^automation-2$/, '★ 第二轮新行 ⇒ 新 automationId');
  assert.equal(last?.retired, true, '★ 新行建会话成功即退役');
  assert.equal(last?.exitCode, 0, '★ 成功 exitCode=0，计入 completed');
  const out = h.jobs.handles[1].readOutput();
  assert.match(String(out), /REPLY-2/, '★ job_output 为新轮回执');
  // ★ 成功覆盖：旧 id 视为 superseded 被替代，记性为新 id；失败才 forget（此处成功 ⇒ 不 forget）。
  assert.ok(!h.sessions.forgotten.includes('K'), '★ 第二轮成功不得 forget（成功保留）');
  assert.equal(h.sessions.resumable('K')?.cliSessionId, 'conv-2', '★ 记性已更新为 conv-2（旧 conv-1 被替代）');
});

test('R2b ★ 每轮都可下发：同 key 第三轮仍 INSERT；resume:false 同样新开', async () => {
  const h = harness();
  await h.call({ prompt: 'round one', session_key: 'K' });
  await h.jobs.handles[0].done;
  await h.call({ prompt: 'round two', session_key: 'K' });
  await h.jobs.handles[1].done;
  assert.equal(h.sessions.resumable('K')?.cliSessionId, 'conv-2', '前置：第二轮已覆盖为 conv-2');
  const third = await h.call({ prompt: 'round three', session_key: 'K' });
  const thirdDone = await h.jobs.handles[2].done;
  assert.equal(h.automationCalls.length, 3, '★ 第三轮仍 INSERT（每轮新对话）');
  assert.equal(h.dispatchCalls.length, 0, '★ 第三轮亦禁网关');
  assert.equal(thirdDone.status, 'completed', '★ 第三轮同样 completed');
  assert.equal(third.resumed, false);
  assert.equal(h.sessions.resumable('K')?.cliSessionId, 'conv-3', '★ 记性滚动到 conv-3');
  // 显式 resume:false ⇒ 同样新开（再点火），语义与自动一致。
  const forced = await h.call({ prompt: 'retry', session_key: 'K', resume: false });
  const forcedDone = await h.jobs.handles[3].done;
  assert.equal(h.automationCalls.length, 4, '★ resume:false 同样再点火（新开）');
  assert.equal(h.dispatchCalls.length, 0, '★ resume:false 亦禁网关');
  assert.equal(forced.resumed, false);
  assert.equal(forcedDone.status, 'completed');
  assert.equal(h.sessions.resumable('K')?.cliSessionId, 'conv-4', '★ resume:false 成功后同样覆盖为新 id');
});

test('R3 负控：换一个 session_key ⇒ 各自一次点火、键各自透传，且首轮都不碰网关', async () => {
  const h = harness();
  await h.call({ prompt: 'task A', session_key: 'A' });
  await h.jobs.handles[0].done;
  await h.call({ prompt: 'task B', session_key: 'B' });
  await h.jobs.handles[1].done;
  assert.equal(h.automationCalls.length, 2);
  assert.equal(h.automationCalls[0].sessionKey, 'A');
  assert.equal(h.automationCalls[1].sessionKey, 'B', '★ 不同任务键 ⇒ 各自透传（并行场景的归组键）');
  assert.equal(h.dispatchCalls.length, 0, '★ 两个都是首轮 ⇒ 都禁网关');
});

test('R4 resume:true 且无记性 ⇒ 明确报错，不静默开新对话，且不调点火/网关', async () => {
  const h = harness();
  await assert.rejects(
    () => h.call({ prompt: 'x', session_key: 'never-used', resume: true }),
    /no resumable session is recorded/,
  );
  assert.equal(h.automationCalls.length, 0, '报错时不得已经点火');
  assert.equal(h.dispatchCalls.length, 0, '报错时不得已经调网关');
});

test('R5 resume:false 有记住也强制新对话（INSERT 一行 once、resumed:false、不走网关）', async () => {
  const h = harness();
  await h.call({ prompt: 'round one', session_key: 'K' });
  await h.jobs.handles[0].done;
  assert.equal(h.sessions.resumable('K')?.cliSessionId, 'conv-1');
  const second = await h.call({ prompt: 'round two', session_key: 'K', resume: false });
  await h.jobs.handles[1].done;
  assert.equal(h.automationCalls.length, 2, '★ resume:false 必须再点火（强制新对话）');
  assert.equal(h.dispatchCalls.length, 0, '★ 强制新对话走点火，不走网关');
  assert.equal(second.resumed, false, '★ 强制新对话必须报 resumed:false');
  assert.equal(second.resumed_session_id, '');
  assert.equal(h.sessions.resumable('K')?.cliSessionId, 'conv-2', '★ 新对话成功后记住新的 id');
});

test('R6 首轮终态失败 forget（下轮重建）；成功保留', async () => {
  const h = harness({ failNext: true });
  await h.call({ prompt: 'will fail', session_key: 'K' });
  await h.jobs.handles[0].done;
  assert.equal(h.automationCalls.length, 1);
  assert.equal(h.dispatchCalls.length, 0, '★ 首轮失败也不碰网关（网关已禁用）');
  assert.ok(h.sessions.forgotten.includes('K'), '★ 首轮失败必须 forget（点火侧 + 收口双保险，至少一次）');
  assert.equal(h.sessions.resumable('K'), null, '★ forget 后不再可命中（下轮重建）');
  // 下轮重建：无记住 ⇒ 新对话（再点火），仍不走网关。
  const second = await h.call({ prompt: 'retry', session_key: 'K' });
  await h.jobs.handles[1].done;
  assert.equal(h.automationCalls.length, 2, '★ forget 后下轮必须重建（再点火）');
  assert.equal(h.dispatchCalls.length, 0, '★ 重建轮是首轮语义，不走网关');
  assert.equal(second.resumed, false);
});

test('R7 点火成功 ⇒ lastRun 记 automation_id / retired / sessionId（首轮四方闭合）', async () => {
  const h = harness();
  await h.call({ prompt: 'x', session_key: 'K' });
  await h.jobs.handles[0].done;
  const last = h.runtime.notes[0];
  assert.equal(last?.transport, 'automation');
  assert.match(last?.automationId ?? '', /^automation-\d+$/, '★ lastRun 必须记 automation_id');
  assert.equal(last?.retired, true, '★ lastRun 必须记 retired');
  assert.equal(last?.sessionId, 'conv-1');
  assert.equal(last?.sessionOrigin, 'new', '★ 首轮 origin 为 new');
  assert.equal(last?.resumed, false);
});

test('R8 ★ 网关仍全禁：首轮两次不同 key 都不碰网关，同 key 第二轮可二次下发亦不碰网关', async () => {
  const h = harness();
  await h.call({ prompt: 'a', session_key: 'A' });
  await h.jobs.handles[0].done;
  assert.equal(h.dispatchCalls.length, 0, '首轮 A 禁网关');
  await h.call({ prompt: 'b', session_key: 'B' });
  await h.jobs.handles[1].done;
  assert.equal(h.dispatchCalls.length, 0, '首轮 B 禁网关');
  await h.call({ prompt: 'a2', session_key: 'A' });
  const secondDone = await h.jobs.handles[2].done;
  assert.equal(h.dispatchCalls.length, 0, '可二次下发亦不碰网关');
  assert.equal(secondDone.status, 'completed', '★ 同 key 第二轮新对话可下发 ⇒ completed');
  assert.equal(secondDone.detail, 'REPLY-3');
  assert.equal(h.automationCalls.length, 3, '第二轮再 INSERT 新行');
  assert.equal(h.automationCalls[2].sessionKey, 'A');
  assert.equal(h.sessions.resumable('A')?.cliSessionId, 'conv-3', '★ A 的记性滚动到新 id');
});
