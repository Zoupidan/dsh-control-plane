/**
 * 可见回收形态回归（HANDOFF-dispatch-invisible §4.3 目标形态）。
 *
 * <p>★ 为什么单开一个文件 ★
 * 既有 `gateway-bound-session.test.js` 钉的是"绑定对话不被污染"（安全性质），
 * `gateway-wiring.test.js` 钉的是"跨层组装不丢字段"（部分）。而 §4.3 的四步
 * （自建会话 → 插件侧记账 → 任何终态回收 → 启动清理遗留）加上两个跨层不断裂点
 * （sessionId 透传、白名单字段），从来没有被**一处**连贯地钉住 —— 每一处单独看
 * 都"好像有人测"，合起来"可见且安全"这个整体无人负责。泄漏一次就是真金白银
 * （实测约 200 元积分），所以收口成一份显式清单。
 *
 * <p>★ 全部用假宿主 / 内存 settings，不写真库，不触发真实网关 prompt ★
 *   - settings 服务是闭包里的纯内存对象（describe/update），连临时文件都不落；
 *   - sidecar 发现走一次性 mkdtemp 空目录 + fixture，不是用户真家；
 *   - ACP 走 `fetchImpl` 纯 mock，不发任何真实 HTTP；
 *   - 首条用例先验套件级护栏（WORKBUDDY_TEST_HOME_GUARD）：没带 guard 跑就直接红，
 *     而不是静默地"恰好没碰到真库"。
 *
 * <p>★ 门禁全绿 ≠ 验收 ★
 * 本文件只证明"内部信号自洽"（记账存在、回收被调、透传不断、字段不丢）。
 * 唯一验收永远是：用户在 WorkBuddy 界面里看到那条对话，并看到它的回执。
 * （HANDOFF §1.2 / §6-1：exit=0、正文非空、门禁全绿全部不构成验收。）
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

import { loadSessionMap, sanitizeRecord } from '../src/host/session/map.js';
import { createRuntime } from '../src/host/config/runtime.js';
import { OWN_SESSION_KEY, createDispatcher } from '../src/host/gateway/dispatch.js';
import { startGatewayRun } from '../src/host/tools/gateway-run.js';

const NS = 'dsh-plugin-workbuddy-test';

// ★ 与 `stream-json.js` 的 SESSION_ID_RE 同口径（`^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$`），
//   假 id 必须合法，否则测到的只是"被拒"，不是"记住了"。
const STALE_ID = 'stale-owned-session-0001';
const NEW_ID = 'fresh-owned-session-0002';
const GUI_CURRENT_ID = 'gui-active-session-0003';
const BOUND_ID = 'bound-explicit-session-0004';

const __tmpDirs = [];
after(() => {
  for (const d of __tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 退出期清理失败不盖结论 */ }
  }
});
function mkTmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  __tmpDirs.push(d);
  return d;
}

// ── 内存 settings：0.1.7 公共面子集（describe/update），数据只活在闭包里 ──
function memorySettings() {
  const store = {};
  const calls = [];
  const deepMerge = (a, b) => {
    const out = { ...(a ?? {}) };
    for (const [k, v] of Object.entries(b ?? {})) {
      out[k] = v !== null && typeof v === 'object' && !Array.isArray(v)
        && typeof out[k] === 'object' && out[k] !== null
        ? deepMerge(out[k], v) : v;
    }
    return out;
  };
  return {
    calls,
    store,
    describe: () => [{ ns: NS, revision: 1, value: { sessions: store }, base: {}, user: {} }],
    update: (ns, patch) => {
      calls.push({ ns, patch });
      if (ns !== NS) return Promise.reject(new Error(`No configurable plugin entry "${ns}"`));
      const merged = deepMerge(store, patch?.sessions ?? {});
      for (const k of Object.keys(store)) delete store[k];
      Object.assign(store, merged);
      return Promise.resolve({});
    },
  };
}

function fakeCtx(settingsSvc) {
  return {
    get: (name) => (name === 'settings' ? settingsSvc : undefined),
    logger: { warn: () => {} },
  };
}

// ══════════════════════════════════════════════════════════════════════
// T0 套件级护栏：真库在结构上不可达（第一道防线本身必须先被证明有效）
// ══════════════════════════════════════════════════════════════════════
test('T0 护栏：WORKBUDDY_HOME 指着一次性 tmp，真库路径结构上不可达', async () => {
  assert.equal(
    process.env.WORKBUDDY_TEST_HOME_GUARD, 'on',
    '★ 套件级护栏没生效 —— 必须用 node --import ./tools/dev/test-home-guard.mjs 跑（见 npm run test:host）',
  );
  const home = process.env.WORKBUDDY_HOME ?? '';
  assert.notEqual(home, '', 'WORKBUDDY_HOME 必须被护栏改写');
  assert.ok(
    home.startsWith(tmpdir()),
    `★ WORKBUDDY_HOME 必须落在系统临时目录下，实际：${home}`,
  );
  const realDb = join(homedir(), '.workbuddy', 'workbuddy.db');
  assert.ok(
    !realDb.startsWith(home),
    '★ 真库路径必须不在 WORKBUDDY_HOME 之下（否则任何疏漏都会写进用户真库）',
  );
  const { workbuddyDbPath } = await import('../src/host/gateway/automation.js');
  assert.ok(
    workbuddyDbPath().startsWith(home),
    `★ 点火落点必须跟随 WORKBUDDY_HOME，实际：${workbuddyDbPath()}`,
  );
  assert.notEqual(workbuddyDbPath(), realDb, '★★ 点火落点绝不能是真库');
});

// ══════════════════════════════════════════════════════════════════════
// T1 adopt 后记账存在（§4.3 第 2 步：插件侧记账，标记"这条是我的"）
// ══════════════════════════════════════════════════════════════════════
test('T1 adopt 后记账存在：lookup 认得回、resumable 可用、落盘有痕', async () => {
  const settingsSvc = memorySettings();
  const sessions = loadSessionMap(fakeCtx(settingsSvc), NS);

  const r = sessions.adopt('task-a', { cliSessionId: NEW_ID, cwd: 'D:\\work' });
  assert.equal(r.ok, true, `adopt 必须成功：${r.persistError}`);
  assert.equal(r.cliSessionId, NEW_ID);

  const got = sessions.lookup('task-a');
  assert.equal(got?.cliSessionId, NEW_ID, '★ adopt 的 id 必须能被 lookup 认回来');
  assert.notEqual(sessions.resumable('task-a'), null, '★ 刚记下的会话必须可续接');
  assert.ok(
    sessions.list().some((row) => row.key === 'task-a' && row.cliSessionId === NEW_ID),
    '★ 合并视图里必须有这一条',
  );
  // ★ 落盘痕迹：patch 里两个状态位必须显式写真（深度合并下省略 = 保留旧值，
  //   省略 unconfirmed:false 会把上一轮的 true 永远粘住 —— map.js 头注的纪律）。
  const patch = settingsSvc.calls.find((c) => c.patch?.sessions?.['task-a'])?.patch?.sessions?.['task-a'];
  assert.ok(patch, '★ adopt 必须提交落盘 patch');
  assert.equal(patch.superseded, false, '★ 状态位必须显式写真，不能省略');
  assert.equal(patch.unconfirmed, false, '★ 状态位必须显式写真，不能省略');
  await sessions.settled();
});

test('T1 负控：adopt 收到畸形 id ⇒ 拒绝且不留空壳记录', () => {
  const sessions = loadSessionMap(fakeCtx(memorySettings()), NS);
  const r = sessions.adopt('task-bad', { cliSessionId: '  ' });
  assert.equal(r.ok, false, '★ 畸形 id 必须拒绝');
  assert.equal(sessions.lookup('task-bad'), null, '★ 拒绝后不得留下空壳（否则 settings 里堆空记录）');
  assert.equal(sessions.resumable('task-bad'), null);
});

// ══════════════════════════════════════════════════════════════════════
// T2 任何终态 forget 被调（§4.3 第 3 步：在途作业成功/失败/异常都立即回收）
// ══════════════════════════════════════════════════════════════════════
let runToolMod = null;
try {
  runToolMod = await import('../src/host/tools/run.js');
} catch { /* 缺 @deepseek-ai 依赖时跳过（与 host.test.js 同款纪律） */ }
const SKIP_NO_DEPS = runToolMod === null
  ? '缺 @deepseek-ai 依赖 —— 先跑 npm run link:dsh-deps'
  : false;

function fakeJobs() {
  const store = new Map();
  let seq = 0;
  return {
    store,
    start(spec) {
      const hooks = spec.run();
      const id = `${spec.kind}-${++seq}`;
      store.set(id, { id, hooks, status: 'running' });
      void Promise.resolve(hooks.done).then(
        (outcome) => { store.get(id).status = outcome?.status ?? 'completed'; },
        () => { store.get(id).status = 'failed'; },
      );
      return id;
    },
  };
}

function autoOk(text = '回执正文') {
  return {
    cancel: () => {},
    done: Promise.resolve({
      status: 'completed', detail: text, exitCode: 0,
      automation: {
        reason: null, automationId: 'automation-1', conversationId: 'conv-1',
        sessionId: 'conv-1', sessionKey: 'k', sessionPersist: { ok: true }, retired: true,
        transcriptPath: null, reply: text,
        creditsUsed: null, model: 'wb-free', permission: 'fullAccess',
        usedModelId: 'wb-free', sessionCwd: 'D:\\work',
        tokensUsed: null, phases: ['db-open', 'running'],
      },
    }),
    readOutput: () => text,
  };
}

test('T2 任何终态都 forget：在途计数归零（成功 / 失败 / done 异常三支）', { skip: SKIP_NO_DEPS }, async () => {
  const runtime = createRuntime({ pluginId: 'plugin-workbuddy', config: {}, ns: 't2' });
  await runtime.probe(async () => ({ installed: true, reason: 'test', target: 'workbuddy' }), {});
  const forgets = [];
  const origForget = runtime.forget.bind(runtime);
  runtime.forget = (id) => { forgets.push(id); return origForget(id); };

  const jobs = fakeJobs();
  const sessions = { createKey: () => 'k', capture: () => null, resumable: () => null, adopt: () => ({ ok: true }) };
  const cfg = () => ({ enabled: true, model: 'wb-free', cwdRoot: 'D:\\work', boundSessionId: '', workspace: '' });
  const ctx = { jobs };
  const exec = { signal: new AbortController().signal };

  // ★ 计划任务主路：点火经 `automationRun` 缝注入，`dispatch` 已下线不再被读取。
  // —— 成功支 ——
  const okTool = runToolMod.makeRunTool(runtime, sessions, cfg, ctx, null, null, { automationRun: () => autoOk('ok-text') });
  const first = await okTool.execute({ prompt: 'job one' }, exec);
  await jobs.store.get(first.job_id).hooks.done;
  assert.equal(runtime.inFlightCount(), 0, '★ 成功后在途必须归零');
  assert.deepEqual(forgets, [first.job_id], '★ 成功支必须 forget 本作业');
  // ★ 成功支的 lastRun 四方闭合：automation_id / session_id / retired 必须可查。
  const afterFirst = runtime.lastRun();
  assert.equal(afterFirst?.transport, 'automation');
  assert.equal(afterFirst?.automationId, 'automation-1', '★ lastRun 必须记 automation_id（删行审计用）');
  assert.equal(afterFirst?.sessionId, 'conv-1', '★ lastRun 必须记 session_id（对话存在的硬证据）');
  assert.equal(afterFirst?.retired, true, '★ lastRun 必须记 retired（止损闸的直接读数）');

  // —— 失败支（自动化回非成功） ——
  const failed = {
    cancel: () => {},
    done: Promise.resolve({
      status: 'failed', detail: 'task_error: boom', exitCode: 1,
      automation: { reason: 'task_error', automationId: 'automation-2', conversationId: null, sessionId: null, retired: true, phases: [] },
    }),
    readOutput: () => 'task_error: boom',
  };
  const failTool = runToolMod.makeRunTool(runtime, sessions, cfg, ctx, null, null, { automationRun: () => failed });
  const second = await failTool.execute({ prompt: 'job two' }, exec);
  await jobs.store.get(second.job_id).hooks.done;
  assert.equal(runtime.inFlightCount(), 0, '★ 失败后在途必须归零');
  assert.deepEqual(forgets, [first.job_id, second.job_id], '★ 失败支同样必须 forget（否则在途表无限膨胀）');

  // —— 异常支（done 直接 reject） ——
  const rejected = {
    cancel: () => {},
    done: Promise.reject(new Error('ECONNRESET')),
    readOutput: () => '',
  };
  // ★ 必须先挂住 rejection，否则断言之前就变成 unhandled rejection。
  rejected.done.catch(() => {});
  const errTool = runToolMod.makeRunTool(runtime, sessions, cfg, ctx, null, null, { automationRun: () => rejected });
  const third = await errTool.execute({ prompt: 'job three' }, exec);
  await jobs.store.get(third.job_id).hooks.done;
  assert.equal(runtime.inFlightCount(), 0, '★ 异常后在途必须归零');
  assert.deepEqual(
    forgets, [first.job_id, second.job_id, third.job_id],
    '★ 异常支同样必须 forget —— "跑飞了的作业"正是 §4.3 要堵的泄漏口',
  );
  // ★ lastRun 四方闭合：transport + automation_id + session_id + retired 必须可查（回收 ≠ 丢记录）。
  //   取成功支的 lastRun（失败/异常支可能没有行 id，automationId 为 null 是如实的"没建过行"）。
  const last = runtime.lastRun();
  assert.equal(last?.transport, 'automation', '★ 结算记账仍在（回收 ≠ 丢记录）');
  assert.equal(typeof last?.retired, 'boolean', '★ lastRun 必须记 retired（止损闸的直接读数）');
});

// ══════════════════════════════════════════════════════════════════════
// T3/T4 共用：全 mock 下发器 harness（发现 → 握手 → load/new → prompt 全假）
// ══════════════════════════════════════════════════════════════════════
const RAW_SIDECAR = {
  pid: 16080, lastHeartbeat: 1790572258559, sessionId: 'f84b5022-78a6-40b0-8570-ac581c631962',
  cwd: 'D:\\Box', startedAt: 1790560045063, kind: 'interactive',
  url: 'http://127.0.0.1:63393', endpoint: 'http://127.0.0.1:63393', mode: 'local', version: '2.147.0',
};
const NOW = 1790572261000;

function fixtureSessionsDir() {
  const dir = mkTmp('wb-recovery-sessions-');
  writeFileSync(join(dir, `${RAW_SIDECAR.sessionId}.json`), JSON.stringify(RAW_SIDECAR));
  return dir;
}

const portRunStub = async ({ argv }) => {
  const joined = argv.join(' ');
  if (/netstat/.test(joined)) {
    return '  Proto  Local Address          Foreign Address        State           PID\r\n'
      + '  TCP    127.0.0.1:63393       0.0.0.0:0              LISTENING       16080\r\n';
  }
  throw new Error(`unexpected spawn: ${joined}`);
};

/**
 * ACP 纯 mock：connect / initialize / load（stale  id 直接 500 装"桌面端已无此会话"）/
 * new（第 1 次回 GUI 当前那条 —— 真机 4 次复现 —— 第 2 次起真新建）/ set_model / prompt。
 */
function acpMock({ failLoadIds = new Set(), capturePrompt = null } = {}) {
  const calls = [];
  let newCount = 0;
  const json = (obj) => {
    const p = JSON.stringify(obj);
    return { ok: true, status: 200, json: () => Promise.resolve(JSON.parse(p)), text: () => Promise.resolve(p) };
  };
  const sse = (raw) => ({
    ok: true, status: 200, text: () => Promise.resolve(typeof raw === 'string' ? raw : `data: ${JSON.stringify(raw)}\n\n`),
  });
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const body = init.body === undefined ? {} : JSON.parse(String(init.body));
    const headers = init.headers ?? {};
    if (u.endsWith('/api/v1/status')) return json({ data: { busy: false } });
    if (u.endsWith('/api/v1/acp/connect')) {
      calls.push('connect');
      return json({ connectionId: 'c-1', sessionToken: 't' });
    }
    if (u.endsWith('/api/v1/acp')) {
      if (headers['acp-connection-id'] === undefined) {
        return { ok: false, status: 400, text: () => Promise.resolve('Bad Request: Server not initialized') };
      }
      calls.push(body.method);
      const frames = [];
      const push = (obj) => frames.push(`data: ${JSON.stringify(obj)}\n\n`);
      if (body.method === 'initialize') {
        push({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
        return sse(frames.join(''));
      }
      if (body.method === 'session/load') {
        if (failLoadIds.has(body.params.sessionId)) {
          return { ok: false, status: 500, text: () => Promise.resolve('no such session') };
        }
        push({
          jsonrpc: '2.0', id: body.id,
          result: {
            sessionId: body.params.sessionId,
            models: { availableModels: [{ modelId: 'wb-free', name: 'Free', _meta: { credits: 'x0.00' } }] },
          },
        });
        return sse(frames.join(''));
      }
      if (body.method === 'session/new') {
        newCount += 1;
        const sid = newCount === 1 ? GUI_CURRENT_ID : NEW_ID;
        push({ jsonrpc: '2.0', id: body.id, result: { sessionId: sid, models: { availableModels: [] } } });
        return sse(frames.join(''));
      }
      if (body.method === 'session/set_model') {
        push({ jsonrpc: '2.0', id: body.id, result: { modelId: body.params.modelId } });
        return sse(frames.join(''));
      }
      if (body.method === 'session/prompt') {
        capturePrompt?.push(body);
        push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: body.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } } });
        push({ jsonrpc: '2.0', id: body.id, result: { stopReason: 'end_turn', outcome: 'SUCCESS' } });
        return sse(frames.join(''));
      }
      push({ jsonrpc: '2.0', id: body.id, result: {} });
      return sse(frames.join(''));
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  return { calls, fetchImpl, newCount: () => newCount };
}

/** 与 apply.js 逐字同形的 sessionStore 接线（read/adopt/forget ←→ 会话映射）。 */
function wiredStore(sessions, spy = {}) {
  return {
    read: (k) => sessions.lookup(k)?.cliSessionId ?? '',
    adopt: (k, r) => { spy.adopted?.push(k); return sessions.adopt(k, r); },
    forget: (k) => { spy.forgotten?.push(k); return sessions.supersede(k); },
  };
}

// ══════════════════════════════════════════════════════════════════════
// T3 启动清理遗留被清（§4.3 第 4 步：上次遗留的自建会话已不在 ⇒ 作废并重建）
// ══════════════════════════════════════════════════════════════════════
test('T3 遗留自建会话已不在 ⇒ 作废记性、本轮重建、重启后仍认得新那条', async () => {
  const settingsSvc = memorySettings();
  const sessions = loadSessionMap(fakeCtx(settingsSvc), NS);
  // ★ 上一次进程留下的记性（lastUsedAt 等字段齐全，模拟"重启后从 settings 冷恢复"）。
  sessions.adopt(OWN_SESSION_KEY, { cliSessionId: STALE_ID, cwd: 'D:\\work' });
  await sessions.settled();

  const spy = { adopted: [], forgotten: [] };
  const base = {
    run: portRunStub, now: () => NOW, gatewayToken: 'tok', boundSessionId: '',
    isPidAlive: () => true, sessionsDir: fixtureSessionsDir(),
    sessionStore: wiredStore(sessions, spy),
  };
  // ★ 桌面端现状：STALE 已不在（load 直接 500），NEW（重建出来的那条）在。
  const mock = acpMock({ failLoadIds: new Set([STALE_ID]) });
  const r1 = await createDispatcher({ ...base, fetchImpl: mock.fetchImpl })
    .run({ prompt: 'x', cwd: 'D:\\work', modelId: 'wb-free' });
  assert.equal(r1.ok, true, `★ 自建会话失效属于可自愈：${JSON.stringify(r1.error)}`);
  assert.equal(r1.sessionOrigin, 'new', '★ 失效后本轮重建');
  assert.equal(r1.sessionRenewed, 'own_session_unloadable', '★ 为什么又建了必须带出来，不能无声换一条');
  assert.equal(r1.sessionId, NEW_ID, '★ 留的必须是真新建那条，不是第 1 次 new 回来的 GUI 当前会话');
  assert.ok(spy.forgotten.includes(OWN_SESSION_KEY), '★ 遗留记性必须被作废（forget 被调）');
  assert.equal(sessions.lookup(OWN_SESSION_KEY)?.cliSessionId, NEW_ID, '★ 记账必须指向重建后的新会话');
  assert.notEqual(sessions.resumable(OWN_SESSION_KEY), null, '★ 重建后必须恢复可续接');

  // ★★★ 模拟进程重启：新 dispatcher 实例 + 同一份 settings（内存服务即"落盘"） ──
  //   若记性只活在进程内，这一轮会再 new 一条（桌面端对话列表被刷屏）。
  const mock2 = acpMock({ failLoadIds: new Set([STALE_ID]) });
  const r2 = await createDispatcher({ ...base, fetchImpl: mock2.fetchImpl })
    .run({ prompt: 'y', cwd: 'D:\\work', modelId: 'wb-free' });
  assert.equal(r2.ok, true);
  assert.equal(r2.sessionId, NEW_ID, '★ 重启后仍续用同一条（一个任务 = 一条对话）');
  assert.equal(r2.sessionOrigin, 'loaded');
  assert.equal(r2.sessionRenewed, '', '★ 正常续用不该被标成"又新建"');
  assert.ok(!mock2.calls.includes('session/new'), '★ 重启后不得再 new');
  assert.equal(process.env.WORKBUDDY_TEST_HOME_GUARD, 'on', '★ 全程护栏不得被关掉');
});

test('T3 负控：用户显式绑定的续不上 ⇒ 如实失败，绝不擅自重建顶上', async () => {
  const settingsSvc = memorySettings();
  const sessions = loadSessionMap(fakeCtx(settingsSvc), NS);
  const spy = { adopted: [], forgotten: [] };
  const mock = acpMock({ failLoadIds: new Set([BOUND_ID]) });
  const r = await createDispatcher({
    run: portRunStub, now: () => NOW, gatewayToken: 'tok', boundSessionId: BOUND_ID,
    isPidAlive: () => true, sessionsDir: fixtureSessionsDir(),
    sessionStore: wiredStore(sessions, spy), fetchImpl: mock.fetchImpl,
  }).run({ prompt: 'x', cwd: 'D:\\work', modelId: 'wb-free' });
  assert.equal(r.ok, false, '★ 绑定的对话没了不许擅自换一条跑');
  assert.equal(r.error.code, 'bound_session_unloadable');
  assert.ok(!mock.calls.includes('session/prompt'), '★ 失败时绝不能还去发任务');
  assert.ok(!mock.calls.includes('session/new'), '★ 更不许偷偷 new 一条顶上');
});

// ══════════════════════════════════════════════════════════════════════
// T4 sessionId 透传不断（sessionKey 一路递到 dispatch；prompt 寻址被记住的那条）
// ══════════════════════════════════════════════════════════════════════
test('T4 sessionKey 穿过 gateway-run 到达 dispatch（漏掉则每轮新开一条）', async () => {
  const seen = [];
  const g = startGatewayRun({
    prompt: 'x', cwd: 'D:\\work', modelId: 'wb-free', sessionKey: 'team-smoke-1',
    dispatch: {
      run: async (req) => {
        seen.push(req);
        return {
          ok: true, reason: null, text: 'done',
          receipt: { stopReason: 'end_turn', outcome: 'SUCCESS', succeeded: true },
          phases: [], tools: { count: 0, names: [] }, models: [], usedModelId: null,
          sidecar: null, error: null, sessionId: 'sid-x', sessionOrigin: 'loaded',
          sessionRenewed: '', sessionPersist: null, instance: null,
        };
      },
    },
  });
  await g.done;
  assert.equal(seen.length, 1, '★ 恰好下发一次');
  assert.equal(seen[0].sessionKey, 'team-smoke-1', '★ sessionKey 必须原样透传（它是"同一任务同一对话"的实现点）');

  // ★ 负控：不给 key 就不传这个键（dispatch 用缺席回落到全局那条，不是空串 key）。
  const seen2 = [];
  const g2 = startGatewayRun({
    prompt: 'x', cwd: 'D:\\work', modelId: 'wb-free',
    dispatch: { run: async (req) => { seen2.push(req); return { ok: true, reason: null, text: 'd', receipt: { stopReason: 'end_turn', outcome: 'SUCCESS', succeeded: true }, phases: [], tools: { count: 0, names: [] }, models: [], sidecar: null, error: null }; } },
  });
  await g2.done;
  assert.ok(!('sessionKey' in seen2[0]), '★ 没给 key 就不得编一个（空串会变成一把谁也认不得的记性）');
});

test('T4 prompt 必须寻址被记住的那条会话 id（不断裂）', async () => {
  const settingsSvc = memorySettings();
  const sessions = loadSessionMap(fakeCtx(settingsSvc), NS);
  sessions.adopt('task-keep', { cliSessionId: NEW_ID, cwd: 'D:\\work' });

  const sent = [];
  const mock = acpMock({ capturePrompt: sent });
  const r = await createDispatcher({
    run: portRunStub, now: () => NOW, gatewayToken: 'tok', boundSessionId: '',
    isPidAlive: () => true, sessionsDir: fixtureSessionsDir(),
    sessionStore: wiredStore(sessions), fetchImpl: mock.fetchImpl,
  }).run({ prompt: '继续', cwd: 'D:\\work', modelId: 'wb-free', sessionKey: 'task-keep' });
  assert.equal(r.ok, true, `★ 续用必须成功：${JSON.stringify(r.error)}`);
  assert.equal(r.sessionId, NEW_ID, '★ 回执的 sessionId 必须是被记住的那条');
  assert.equal(r.sessionOrigin, 'loaded');
  assert.equal(sent.length, 1, '★ 恰好发一次 prompt');
  assert.equal(
    sent[0]?.params?.sessionId, NEW_ID,
    '★ prompt 必须寻址被记住的会话 id —— 寻到 GUI 当前那条就是一次接管',
  );
  assert.notEqual(sent[0]?.params?.sessionId, GUI_CURRENT_ID);
});

// ══════════════════════════════════════════════════════════════════════
// T5 白名单不再丢字段（跨层组装是显式清单：少一行就无声消失且不报错）
// ══════════════════════════════════════════════════════════════════════
test('T5 gateway 白名单：dispatch 有的字段，穿过 startGatewayRun 后必须还在', async () => {
  const instance = {
    stage: 'reused', code: 'ok', ok: true, waitedMs: 0,
    desktop: { running: true, launched: false, ready: true },
    sidecar: { scanned: 2, picked: 1, refused: null },
    hint: 'the desktop was already open',
  };
  const permission = { requested: 'plan', echoed: 'plan', effective: 'plan', confirmed: true };
  const dispatch = {
    run: async () => ({
      ok: true, reason: null, text: 'done',
      receipt: { stopReason: 'end_turn', outcome: 'SUCCESS', succeeded: true },
      phases: ['prompting'], tools: { count: 1, names: ['read'] },
      models: [{ modelId: 'wb-pro', name: 'Pro', credits: 'x0.05' }],
      usedModelId: 'wb-pro', sidecar: { pid: 16080, url: 'http://127.0.0.1:63393' },
      error: null, permission, sessionId: NEW_ID, sessionOrigin: 'loaded',
      sessionRenewed: '', sessionPersist: { ok: true }, instance,
    }),
  };
  const g = startGatewayRun({ prompt: 'x', cwd: 'D:\\work', modelId: 'wb-pro', dispatch });
  const out = await g.done;
  assert.equal(out.status, 'completed');
  // ★ 逐键点名：白名单少一行，这里就红一行（sessionOrigin / instance 都这么丢过一次）。
  for (const key of ['reason', 'receipt', 'models', 'usedModelId', 'sidecar', 'tools',
    'phases', 'permission', 'sessionOrigin', 'instance', 'multiplier']) {
    assert.ok(key in (out.gateway ?? {}), `★ gateway 白名单不得丢字段：${key}`);
  }
  assert.equal(out.gateway.sessionOrigin, 'loaded');
  assert.equal(out.gateway.instance.code, 'ok', '★ instance 必须带着结论穿过（投影后仍可判）');
  assert.equal(out.gateway.usedModelId, 'wb-pro', '★ 实际用的模型必须是真实那个');
  assert.equal(out.gateway.permission.confirmed, true);
  assert.equal(out.gateway.multiplier, 0.05, '★ 倍率取归一后清单的 credits（曾恒为 null 过）');
});

test('T5 sanitizeRecord 白名单：认得的字段全留（显式 false 也留），不认得的丢', () => {
  const clean = sanitizeRecord({
    cliSessionId: NEW_ID, cwd: 'D:\\work', lastUsedAt: 123, outputBytes: 10,
    outputTruncated: false, superseded: false, unconfirmed: false,
    // ★ 下面这些是调用方手滑/版本漂移带进来的：必须丢，否则整份 namespace 校验被拒。
    evil: 'x', cliSessionId2: 'y', sessions: {},
  });
  assert.deepEqual(
    Object.keys(clean).sort(),
    ['cliSessionId', 'cwd', 'lastUsedAt', 'outputBytes', 'outputTruncated', 'superseded', 'unconfirmed'].sort(),
    '★ 白名单外字段必须丢、白名单内一个不许少',
  );
  assert.equal(clean.superseded, false, '★ 显式的 false 必须留（省略 = 保留旧 true = 把健康会话判死）');
  assert.equal(clean.unconfirmed, false);
  // ★ 负控：坏类型同样丢（实测：`$.sessions.u-1.cliSessionId expected string but got 42` 整份被拒）。
  const bad = sanitizeRecord({ cliSessionId: 42, cwd: '', lastUsedAt: NaN, outputBytes: -1 });
  assert.ok(!('cliSessionId' in bad), '★ 类型不对的字段不得进 patch');
  assert.ok(!('cwd' in bad));
});
