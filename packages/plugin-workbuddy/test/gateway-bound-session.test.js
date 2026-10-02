// 下发器的**绑定对话**语义。★ 这里测的是"不会污染用户会话"这一条安全性质，
//   它 2026-09-28 之前完全没有测试覆盖（`createDispatcher` 零用例），
//   而我恰恰在没有测试的情况下拿真机连发了几轮 prompt，污染了用户两次。
//
// 真机依据（pid 26080 / 127.0.0.1:53349，2026-09-28）：
//   ① `session/new` 的 `cwd` 不生效 ⇒ 自己 new 的对话工作区未知；
//   ② 每个新 ACP connection 的**第 1 次** `session/new` 返回 GUI 当前那条（不是新建），
//      第 2 次起才真新建；
//   ③ `session/new` 会切走 GUI 当前会话。
//   ⇒ 自己 new 这条路必然踩中 ②③。改成"用户建好、插件只往那条下发"。
//
// ★ 每条都带负控：既测"成立"，也测"改错了会不会红"。只测通过的那种等于没测。
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDispatcher } from '../src/host/gateway/dispatch.js';
import { startGatewayRun } from '../src/host/tools/gateway-run.js';

// 真机原文（逐字取自 ~/.workbuddy/sessions/*.json），用户活会话那一条。
const RAW_USER = {
  pid: 16080, lastHeartbeat: 1790572258559, sessionId: 'f84b5022-78a6-40b0-8570-ac581c631962',
  cwd: 'D:\\Box\\交易知识库', startedAt: 1790560045063, kind: 'interactive',
  url: 'http://127.0.0.1:63393', endpoint: 'http://127.0.0.1:63393', mode: 'local', version: '2.147.0',
};
const NOW = 1790572261000;
const BOUND = '01a0e714-2298-7fef-b41c-2c8eb5247820';
/** `session/new` 造出来的会话 id。**刻意与 `BOUND` 长得不一样**，见 acpSpy 里那条注释。 */
const NEW_SESSION = 'ffffffff-0000-4000-8000-00000000beef';
/**
 * ★ 真机上**第 1 次** `session/new` 回来的那条 —— 它是 **GUI 当前那条**，不是新建的。
 *   给它一个专属字面量，断言才有办法把"留了真新建那条"和"留了用户那条"分开。
 *   这也**刻意不等于 `RAW_USER.sessionId`**：真机上第 1 次返回的正是用户活会话的 id，
 *   而那条 `session/load` 得通（加载路径必须能续上它）。写成不同的字面量，
 *   才能让"误留第 1 次"同时被 `new` 和 `load` 两条断言抓住。
 */
const GUI_CURRENT_SESSION = '99999999-0000-4000-8000-00000000cafe';
/** 连着 new 两次、只留第二次（理由见 dispatch.js `NEW_SESSION_ATTEMPTS`）。 */
const NEW_SESSION_ATTEMPTS = 2;

/** 造一个只含该用户活会话的临时 sessions 目录。 */
function sessionsDirWith(entry) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-dispatch-'));
  writeFileSync(join(dir, `${entry.sessionId}.json`), JSON.stringify(entry));
  return dir;
}

/** 记录每一次 ACP 方法名，用来证明 `session/new` 到底有没有被调。 */
function acpSpy({ busy = false, models, modes, capturePrompt, honorSetMode = false } = {}) {
  const calls = [];
  // 新建出来的会话 id 必须与 `BOUND` 明显不同：若上层"新建"了却仍拿着绑定的 id，
  //   断言光看 `calls` 会全绿，而实际下发的还是旧对话。**不同的字面量就是这道防线。**
  const newSessionCalls = [];
  // ★★ 真机的 `session/set_mode` 是**接受但不生效**的（2026-09-28 实测：回 200、回显你给的值，
  //   但 `config_option_update.currentValue` 恒为 `default`；新会话与桌面既有会话都如此）。
  //   所以默认 `honorSetMode=false` —— **mock 必须比真机更悲观**。若让 spy 默认"设了就生效"，
  //   它就把一个不成立的假设焊进了测试里：真机上 `permission_mode` 是空转的，而单测全绿。
  //   `honorSetMode=true` 只用来测"假如服务端真的生效"那条分支的形状。
  let effectiveMode = 'default';
  // ★ 三条路的取法各不相同，少给一个都会被误报成"探不通"而不是真因：
  //   `/api/v1/status`  → `r.json()`   （sidecar.js:385 probeStatus）
  //   `/api/v1/acp/connect` → `r.json()`（acp.js:153 connect）
  //   `/api/v1/acp`     → `r.text()`  （acp.js:104，SSE 形态）
  const json = (obj) => {
    const p = JSON.stringify(obj);
    return { ok: true, status: 200, json: () => Promise.resolve(JSON.parse(p)), text: () => Promise.resolve(p) };
  };
  // ★ 接受**已拼好的多帧文本**（一次 ACP 调用会回一个流，不是一条消息），
  //   所以这里必须原样透传，不能再 JSON.stringify 一次——否则整段 SSE 会被引号包起来。
  const sse = (raw) => ({
    ok: true, status: 200, text: () => Promise.resolve(typeof raw === 'string' ? raw : `data: ${JSON.stringify(raw)}\n\n`),
  });
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const body = init.body === undefined ? {} : JSON.parse(String(init.body));
    const headers = init.headers ?? {};
    if (u.endsWith('/api/v1/status')) return json({ data: { busy } });
    if (u.endsWith('/api/v1/acp/connect')) {
      calls.push('connect');
      // ★ `connectionId` 在**顶层**，不在 `result` 也不在 `data` 下（acp.js:154 记着这个坑）。
      return json({ connectionId: 'c-1', sessionToken: 't' });
    }
    if (u.endsWith('/api/v1/acp')) {
      // ★★★ 这个拒绝是 2026-09-28 真机探针逼出来的：漏调 `connect()` 时 `initialize` 带的
      //   `acp-connection-id` 是空，真机回 HTTP 400 "Server not initialized"。原来的 spy
      //   来者不拒，于是那个 bug 全绿通过 —— **探针比 mock 严格**才能当证据。
      //   复现那个错：任何 ACP 方法缺连接头 ⇒ 400。
      if (headers['acp-connection-id'] === undefined) {
        return {
          ok: false, status: 400,
          text: () => Promise.resolve('Bad Request: Server not initialized'),
        };
      }
      calls.push(body.method);
      const frames = [];
      const push = (obj) => frames.push(`data: ${JSON.stringify(obj)}\n\n`);
      if (body.method === 'initialize') {
        push({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
        return sse(frames.join(''));
      }
      if (body.method === 'session/load') {
        // ★ `modes: []` 是**负控入口**：不下发那张 config_option_update 时，上层必须说
        //   "探不到"（known:false），绝不能拿本地 6 值 flag 表顶替。
        if (modes !== []) {
          push({
            jsonrpc: '2.0', method: 'session/update',
            params: {
              sessionId: body.params.sessionId,
              update: {
                sessionUpdate: 'config_option_update',
                configOptions: [{
                  type: 'select', id: 'mode', name: 'Permission Mode', category: 'mode',
                  currentValue: effectiveMode,
                  options: modes ?? [
                    { value: 'default', name: 'Always Ask' },
                    { value: 'plan', name: 'Plan' },
                    { value: 'dontAsk', name: "Don't Ask" },
                    { value: 'fullAccess', name: 'Full Access' },
                  ],
                }],
              },
            },
          });
        }
        push({
          jsonrpc: '2.0', id: body.id,
          result: {
            sessionId: body.params.sessionId,
            // ★ `models: []` 是**负控入口**：清单为空时上层必须如实显示"未知"，
            //   不得回落到本地硬编码倍率表（那份已经和接口对不上过）。
            models: { availableModels: models ?? [
              { modelId: 'hy3', name: '混元3', _meta: { credits: 'x0.00', supportsImages: true } },
              { modelId: 'kimi-k3-1', name: 'k3', _meta: { credits: 'x1.62', supportsImages: true } },
            ] },
          },
        });
        return sse(frames.join(''));
      }
      if (body.method === 'session/new') {
        // ★★★ 这条分支以前**根本不存在**：`session/new` 一律落到下面的兜底 `result: {}`，
        //   于是"新建"路径在测试里永远拿不到 sessionId，上层只能返回 session_not_created——
        //   套件看上去覆盖了 createNew，实际上**这条分支一次都没被跑到过**。
        //   结构性的洞比断言写错更危险：它让"没测"和"测了"长得一模一样。
        newSessionCalls.push(body);
        // ★★★ mock 必须**照抄真机**（2026-09-28，4 次独立复现）：每个**新 ACP 连接**上的
        //   **第 1 次** `session/new` 返回 GUI 当前那条，**并没有新建**；第 2 次起才真新建。
        //   两次都回同一个 id 的话，"我们留的是第 2 次"和"我们留的是第 1 次（=用户那条）"
        //   在断言下**长得一模一样** —— 那正是本条改动最该防的错，mock 却让它测不出来。
        //   mock 比真机乐观，等于没测。
        const sid = newSessionCalls.length === 1 ? GUI_CURRENT_SESSION : NEW_SESSION;
        push({
          jsonrpc: '2.0', id: body.id,
          result: {
            sessionId: sid,
            models: { availableModels: models ?? [{ modelId: 'hy3', name: '混元3', _meta: { credits: 'x0.00' } }] },
          },
        });
        return sse(frames.join(''));
      }
      if (body.method === 'session/set_mode') {
        // ★ 回显照发（真机也回显），但**除非** honorSetMode，否则不改 effectiveMode。
        if (honorSetMode) effectiveMode = body.params.modeId;
        push({ jsonrpc: '2.0', id: body.id, result: { sessionUpdate: 'current_mode_update', currentModeId: body.params.modeId } });
        return sse(frames.join(''));
      }
      if (body.method === 'session/set_model') {
        push({ jsonrpc: '2.0', id: body.id, result: { modelId: body.params.modelId } });
        return sse(frames.join(''));
      }
      if (body.method === 'session/prompt') {
        if (capturePrompt) capturePrompt.push(body);
        push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: body.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } } });
        push({ jsonrpc: '2.0', id: body.id, result: { stopReason: 'end_turn', outcome: 'SUCCESS' } });
        return sse(frames.join(''));
      }
      push({ jsonrpc: '2.0', id: body.id, result: {} });
      return sse(frames.join(''));
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  return { calls, fetchImpl, newSessionCalls };
}

/** 端点靠 netstat 反查（5.6.2 之后 session 文件不再写 url），所以 `run` 要答端口表。 */
const runStub = async ({ argv }) => {
  const joined = argv.join(' ');
  if (/netstat/.test(joined)) {
    return '  Proto  Local Address          Foreign Address        State           PID\r\n'
      + '  TCP    127.0.0.1:63393       0.0.0.0:0              LISTENING       16080\r\n';
  }
  throw new Error(`unexpected spawn: ${joined}`);
};

const make = (extra = {}) => createDispatcher({
  run: runStub, now: () => NOW, gatewayToken: 'tok', boundSessionId: BOUND, isPidAlive: () => true, ...extra,
});

test('★★★★ 没绑也没记住 ⇒ 插件**自己 new 一条**并记下来；下一轮续用它，不再 new', async () => {
  // ★★★ 这条测试对应 2026-09-28 的核心诉求：「新建会话 / 切换权限 / 会话id 复用 / 回传」。
  //   旧行为是"没绑就报 `no_bound_session`，要用户先去桌面端手开一条"。那道闸 2026-09-28 删除：
  //   插件自己建一条、自己记住、之后一直续用它。
  //   旧闸的顾虑（"新建会切走 GUI 活跃会话"）**依然成立**，但它是**一次性**代价，
  //   付在第一轮；旧设计错在把它当成了每轮都要付的代价，于是把首轮也一起禁了。
  const store = new Map();
  const adopted = [];
  const sessionStore = {
    read: (k) => store.get(k)?.cliSessionId ?? '',
    adopt: (k, r) => { adopted.push({ k, ...r }); store.set(k, { cliSessionId: r.cliSessionId, cwd: r.cwd }); return { ok: true, persistState: 'ok', persistError: '' }; },
    forget: (k) => store.delete(k),
  };
  const base = {
    run: runStub, now: () => NOW, gatewayToken: 'tok', fetchImpl: undefined,
    isPidAlive: () => true, sessionsDir: sessionsDirWith(RAW_USER),
    boundSessionId: '', sessionStore,
  };

  // ── 第 1 轮：什么都没有 ⇒ 自己建一条 ──
  const first = acpSpy();
  const r1 = await createDispatcher({ ...base, fetchImpl: first.fetchImpl }).run({ prompt: 'x', cwd: 'D:\\work', modelId: 'hy3' });
  assert.equal(r1.ok, true, `★ 没绑不该是错误态，插件该自己建一条：${JSON.stringify(r1.error)}`);
  assert.equal(r1.sessionOrigin, 'new');
  assert.equal(r1.sessionRenewed, 'first_run', '★ 首轮自建要能被读出来');
  assert.equal(r1.sessionId, NEW_SESSION, '★ 留的必须是**第 2 次**那条（真新建的），不是第 1 次的 GUI 当前会话');
  assert.notEqual(r1.sessionId, GUI_CURRENT_SESSION, '★ 绝不能把 GUI 当前那条当成自己新建的');
  assert.equal(first.newSessionCalls.length, NEW_SESSION_ATTEMPTS, '★ 必须连着 new 两次（第 1 次是 GUI 当前那条）');
  assert.equal(adopted.length, 1, '★ 建出来的那条必须被记下来，否则下一轮又会 new');
  assert.equal(adopted[0].k, 'workbuddy-gateway-own', '★ 固定键，不是 randomUUID（要的是"认得回上次那条"）');

  // ── 第 2 轮：**不再 new**，续用同一条 ──
  const second = acpSpy();
  const r2 = await createDispatcher({ ...base, fetchImpl: second.fetchImpl }).run({ prompt: 'y', cwd: 'D:\\work', modelId: 'hy3' });
  assert.equal(r2.ok, true, `★ 复用不该比新建更容易失败：${JSON.stringify(r2.error)}`);
  assert.equal(r2.sessionId, NEW_SESSION, '★ 必须是**同一条**对话（多轮上下文就靠这个）');
  assert.equal(r2.sessionOrigin, 'loaded');
  assert.equal(r2.sessionRenewed, '', '★ 正常续用不该被标成"又新建"');
  assert.ok(!second.calls.includes('session/new'), `★ 第二轮绝不能再 new：实际 ${JSON.stringify(second.calls)}`);
  assert.ok(second.calls.includes('session/load'), '★ 第二轮走 load 续接');
  assert.ok(second.calls.includes('session/prompt'), '★ 还是要真发 prompt');
  assert.equal(adopted.length, 2, '★ 续用也要记账（刷新 lastUsedAt）');
  // ★★★ 负控：进程重启后（新 dispatcher 实例）**仍要记得**。只用进程内记性的话，
  //   上面第 2 轮照样全绿——而真机上每轮都是新连接，进程内记性等于没有记性。
  const third = acpSpy();
  const r3 = await createDispatcher({ ...base, fetchImpl: third.fetchImpl }).run({ prompt: 'z', cwd: 'D:\\work', modelId: 'hy3' });
  assert.equal(r3.sessionId, NEW_SESSION, '★ 换一个新实例（模拟重启）后仍要记得上次那条');
  assert.ok(!third.calls.includes('session/new'), '★ 重启后也不该再 new');
});

test('★★★ 记住的那条在桌面端没了 ⇒ 报 bound 的坏、**自动重建自己那条**', async () => {
  // 这条是"保持一个会话"的**失效处置**，两条来源必须分开处置，否则就是静默换对话：
  //   ① 自建的那条没了 —— 属于"非必要之外"的那一次 new：作废记性、本轮重建，下一轮续新的那条；
  //   ② 用户显式绑的那条没了 —— **不许**擅自换一条跑（§10.4：用无关的成功信号冒充承诺兑现）。
  const store = new Map([['workbuddy-gateway-own', { cliSessionId: NEW_SESSION }]]);
  const base = {
    run: runStub, now: () => NOW, gatewayToken: 'tok', isPidAlive: () => true,
    sessionsDir: sessionsDirWith(RAW_USER), sessionStore: { read: (k) => store.get(k)?.cliSessionId ?? '', adopt: () => ({ ok: true }), forget: (k) => store.delete(k) },
  };

  // ① 自建的续不上 ⇒ load 报错后自动 new 一条
  const g1 = acpSpy();
  const d1 = createDispatcher({ ...base, boundSessionId: '', fetchImpl: async (url, init) => {
    const u = String(url);
    if (u.endsWith('/api/v1/acp') && String(init?.body ?? '').includes('"session/load"')) {
      return { ok: false, status: 500, text: () => Promise.resolve('no such session') };
    }
    return g1.fetchImpl(url, init);
  } });
  const r1 = await d1.run({ prompt: 'x', cwd: 'D:\\work', modelId: 'hy3' });
  assert.equal(r1.ok, true, `★ 自建会话失效属于可自愈：${JSON.stringify(r1.error)}`);
  assert.equal(r1.sessionOrigin, 'new', '★ 失效后本轮重建');
  assert.equal(r1.sessionRenewed, 'own_session_unloadable', '★ **为什么**又建了必须带出来，不能无声换一条');
  assert.equal(r1.sessionId, NEW_SESSION);

  // ② 绑定的续不上 ⇒ 如实失败，**不**换一条跑
  const g2 = acpSpy();
  const r2 = await createDispatcher({ ...base, boundSessionId: BOUND, fetchImpl: async (url, init) => {
    const u = String(url);
    if (u.endsWith('/api/v1/acp') && String(init?.body ?? '').includes('"session/load"')) {
      return { ok: false, status: 500, text: () => Promise.resolve('no such session') };
    }
    return g2.fetchImpl(url, init);
  } }).run({ prompt: 'x', cwd: 'D:\\work', modelId: 'hy3' });
  assert.equal(r2.ok, false, '★ 绑定的对话没了不许擅自换一条跑');
  assert.equal(r2.error.code, 'bound_session_unloadable');
  assert.match(r2.error.message, /boundSessionId/, '★ 处置必须可执行：直接指到那个设置项');
  assert.ok(!g2.calls.includes('session/prompt'), '★ 失败时绝不能还去发任务');
  assert.ok(!g2.calls.includes('session/new'), '★ 更不许偷偷 new 一条顶上（那正是"冒充承诺兑现"）');
});

test('★★ 绑了 ⇒ 下发到那条 id，且**绝不调 session/new**', async () => {
  // ★ 这是整套改动的核心命题。真机依据 ②③：第 1 次 session/new 返回 GUI 当前那条，
  //   并且会切走 active。插件只要碰它一次，用户的活会话就可能被接管。
  const { calls, fetchImpl } = acpSpy();
  const seen = [];
  const d = createDispatcher({
    run: runStub, now: () => NOW, gatewayToken: 'tok', boundSessionId: BOUND, fetchImpl, isPidAlive: () => true,
    sessionsDir: sessionsDirWith(RAW_USER),
  });
  const realFetch = fetchImpl;
  const r = await d.run({ prompt: 'x', cwd: 'D:\\work', modelId: 'hy3' });
  for (const c of calls) seen.push(c);
  assert.equal(r.ok, true, `★ 绑了就应该能跑：${JSON.stringify(r.error)}`);
  assert.ok(!calls.includes('session/new'),
    `★ 绝不能 session/new（真机：第 1 次返回用户当前那条、并切走 active）：实际 ${JSON.stringify(calls)}`);
  assert.ok(calls.includes('session/prompt'), '★ 还是要真发 prompt');
  assert.equal(r.usedModelId, 'hy3');
  assert.equal(typeof realFetch, 'function');
});

test('★★ 绑了但没给模型 ⇒ **不许猜**，但也不该再报 model_required（沿用会话模型）', async () => {
  // ★ 这条测试**本意没变**：反对"猜一个看起来便宜的模型"。曾经就是 `models[0]`，
  //   而倍率表和接口已经对不上过——猜就是在复现那个错。
  //
  // ★ 变的是"没给模型"的处置：2026-09-28 之前报 `model_required` 硬失败，
  //   理由是"bound 路径拿不到清单只能瞎猜"。现在 `session/load` 把清单带回来了，
  //   而且**会话自己记着上次用的模型**——那是用户自己选的，不是猜的。
  //   所以正确处置是"不设、直接跑"，而不是硬失败。
  const { calls, fetchImpl } = acpSpy();
  const d = createDispatcher({
    run: runStub, now: () => NOW, gatewayToken: 'tok', boundSessionId: BOUND, fetchImpl, isPidAlive: () => true,
    sessionsDir: sessionsDirWith(RAW_USER),
  });
  const r = await d.run({ prompt: 'x', cwd: 'D:\\work' });
  assert.equal(r.ok, true, '★ 没显式给模型不该阻断下发');
  // ★ 反对意见仍然成立的那一半：不能偷偷替用户换一个模型。
  assert.ok(!calls.includes('session/set_model'),
    `★ 没给模型就不许 set_model（那等于替用户猜一个）：实际 ${JSON.stringify(calls)}`);
  assert.ok(calls.includes('session/prompt'), '★ 沿用会话模型照常发 prompt');
  // ★ 负控：给了模型就必须真的设下去。
  const withModel = await d.run({ prompt: 'x', cwd: 'D:\\work', modelId: 'hy3' });
  assert.ok(calls.includes('session/set_model'), '★ 给了模型就必须 set_model');
  assert.equal(withModel.usedModelId, 'hy3');
});

test('★ 负控：sessionId 只认字面量非空串，空格也算没绑', async () => {
  // 归一化漏一个 `.trim()`，`"  "` 就会被当成已绑定而放行——这是能靠肉眼放过的错。
  // ★ 2026-09-28 变化：`boundSessionId:'   '` 现在**不再**是错误态（自建那道闸已删），
  //   但它**仍然必须等价于"没绑"** —— 判据是走**自建**那一支，而不是去 load 一个空白 id。
  const { calls, fetchImpl } = acpSpy();
  const r = await createDispatcher({
    run: runStub, now: () => NOW, gatewayToken: 'tok', boundSessionId: '   ', fetchImpl, isPidAlive: () => true,
    sessionsDir: sessionsDirWith(RAW_USER),
  }).run({ prompt: 'x', cwd: 'D:\\work', modelId: 'hy3' });
  assert.equal(r.ok, true, '★ 纯空白不该阻断下发（自建那条路就是给它用的）');
  assert.equal(r.sessionOrigin, 'new', '★ 纯空白必须等价于"没绑" ⇒ 走自建');
  assert.ok(!calls.includes('session/load'), `★ 绝不能拿空白 id 去 load：实际 ${JSON.stringify(calls)}`);
  assert.equal(r.sessionId, NEW_SESSION);
});

test('★ 负控：绑定态确实**放开**了 interactive 拒选（否则整套改动等于永远不可用）', async () => {
  // 这一条是上一条的对照：上面证明"没绑时关着"，这条证明"绑了时开着"。
  // 只测关闭侧的话，把 `interactiveAllowed` 改成恒 false 也能全绿——那就白改了。
  const { fetchImpl } = acpSpy();
  const d = createDispatcher({
    run: runStub, now: () => NOW, gatewayToken: 'tok', boundSessionId: BOUND, fetchImpl, isPidAlive: () => true,
    sessionsDir: sessionsDirWith(RAW_USER),
  });
  const picked = await d.run({ prompt: 'x', cwd: 'D:\\work', modelId: 'hy3' });
  assert.equal(picked.ok, true, '★ 绑了 + 用户活会话在场 ⇒ 仍应选中它（否则功能不可用）');
  assert.equal(picked.sidecar.pid, 16080);
});

test('★★★★ 权限必须在 session/prompt **之前**设好（顺序是正确性，不是排版）', async () => {
  // ★ 真机依据：`dontAsk` 下 Bash 被拒（"Permission to use Bash has been denied because
  //   CodeBuddy is running in dontAsk mode"），而 `default`(Always Ask) 下没人点对话框就一直挂。
  //   两者处置完全相反 ⇒ 权限必须**这次**设，不能沿用会话上次残留的值。
  //   顺序反了就是"带着旧权限把任务发出去"，正是当初跑出 64 次无人授权工具调用的事故形态。
  const { calls, fetchImpl } = acpSpy();
  const d = createDispatcher({
    run: runStub, now: () => NOW, gatewayToken: 'tok', boundSessionId: BOUND, fetchImpl, isPidAlive: () => true,
    sessionsDir: sessionsDirWith(RAW_USER),
  });
  const r = await d.run({ prompt: 'x', cwd: 'D:\\work', permissionMode: 'fullAccess' });
  assert.equal(r.ok, true, `★ 设了权限就该能跑：${JSON.stringify(r.error)}`);
  assert.ok(calls.includes('session/set_mode'), '★ 必须真的下发权限');
  assert.ok(calls.indexOf('session/set_mode') < calls.indexOf('session/prompt'),
    `★ set_mode 必须早于 prompt：实际 ${JSON.stringify(calls)}`);
  // ★ 负控：不给权限就不许乱设（沿用会话当前值，不替用户决定）。
  const { calls: c2, fetchImpl: f2 } = acpSpy();
  const r2 = await createDispatcher({
    run: runStub, now: () => NOW, gatewayToken: 'tok', boundSessionId: BOUND, fetchImpl: f2, isPidAlive: () => true,
    sessionsDir: sessionsDirWith(RAW_USER),
  }).run({ prompt: 'x', cwd: 'D:\\work' });
  assert.equal(r2.ok, true);
  assert.ok(!c2.includes('session/set_mode'), '★ 没给权限就不许 set_mode（那等于替用户选授权强度）');
});

test('★★★★ 默认路径 load，new 只在"自建"和"显式 createNew"时发生', async () => {
  // ★ 这是"不劫持 GUI 活跃会话"这条安全性质的直接断言——注意它**没有变弱**，
  //   变的是"默认 load 的对象"：从"用户绑的那条"扩到"上次自己建的那条"。
  //   new 仍然只发生在两种明确情形：自建（首轮）、用户显式要求（createNew）。
  const { calls, fetchImpl } = acpSpy();
  const base = {
    run: runStub, now: () => NOW, gatewayToken: 'tok', fetchImpl, isPidAlive: () => true,
    sessionsDir: sessionsDirWith(RAW_USER),
  };
  const viaLoad = await createDispatcher({ ...base, boundSessionId: BOUND })
    .run({ prompt: 'x', cwd: 'D:\\work', permissionMode: 'plan' });
  assert.equal(viaLoad.ok, true);
  assert.ok(calls.includes('session/load'), '★ 绑定态走 load');
  assert.ok(!calls.includes('session/new'), '★ 绑定态绝不许 new');

  // ★ 负控：什么都没绑、也没记住 ⇒ 才走自建；且**必须留下 new 的痕迹**。
  //   这条对照是上面那条的对面：只测"绑了不 new"的话，把 `sessionId === ''` 那支
  //   整个删掉也能全绿——那就白改了。
  const { calls: c2, fetchImpl: f2 } = acpSpy();
  const selfNew = await createDispatcher({ ...base, fetchImpl: f2, boundSessionId: '' })
    .run({ prompt: 'x', cwd: 'D:\\work' });
  assert.equal(selfNew.ok, true);
  assert.ok(c2.includes('session/new'), `★ 首次必须自建：实际 ${JSON.stringify(c2)}`);
  assert.ok(!c2.includes('session/load'), '★ 首轮没有可 load 的东西');
});

test('★★★★ 已绑定 + 显式 createNew:true ⇒ 必须真的 session/new，不能静默 load 绑定会话', async () => {
  // ★★★ 上一条测试的**正对面**，原套件里根本没有这一格，所以 bug 活了下来：
  //   判定条件原本只写 `sessionId === ''`，而 `createNew` 只在早退那关被看了一眼。
  //   于是"绑定态 + 显式新建"被**静默降级成 load**——任务跑成功、状态全绿，
  //   唯独跑在了用户明确不要的那条对话里，还接上了上一轮的上下文。
  //   **一个不报错的违约，比一个报错贵**：报错用户会改，违约用户会去信结果。
  const { calls, fetchImpl, newSessionCalls } = acpSpy();
  const out = await createDispatcher({
    run: runStub, now: () => NOW, gatewayToken: 'tok', boundSessionId: BOUND,
    fetchImpl, isPidAlive: () => true, sessionsDir: sessionsDirWith(RAW_USER),
  }).run({ prompt: 'x', cwd: 'D:\\work', createNew: true });

  assert.ok(calls.includes('session/new'), `★ 显式新建必须真建：实际 ${JSON.stringify(calls)}`);
  assert.ok(!calls.includes('session/load'), '★ 新建那支绝不许顺手 load 绑定会话');
  assert.equal(out.ok, true);
  assert.equal(newSessionCalls.length, NEW_SESSION_ATTEMPTS,
    '★ 连着 new 两次：第 1 次返回的是 GUI 当前那条（真机实测），必须被丢弃');
  // ★★★ 关键断言：实际下发的必须是**第 2 次那条**（真新建的）。
  //   只看 `calls` 不够——"调了 new 却仍拿着 GUI 当前那条下发"照样能骗过上面几行，
  //   而那才是真正的违约（等于把用户正在用的对话接管了）。
  assert.notEqual(out.sessionId, BOUND, '★ 不许把绑定会话当成新建的那条报回来');
  assert.notEqual(out.sessionId, GUI_CURRENT_SESSION,
    '★ 绝不能留第 1 次那条（真机上它就是 GUI 当前会话，不是新建的）');
  assert.equal(out.sessionId, NEW_SESSION, '★ 留的必须是第 2 次那条');
  assert.equal(out.sessionOrigin, 'new');
  assert.equal(out.sessionRenewed, 'create_new_requested', '★ 显式新建要能被读出来');
});

test('★★★ 默认路径（createNew 未给 / false）绝不因这次修复而改变', async () => {
  // ★ 反向防过修：`|| createNew` 加错了作用域会**让每次下发都新建**，
  //   而那正是"抢 GUI 活跃会话"这条安全性质被拆掉的表现，且同样不报错。
  for (const createNew of [undefined, null, false]) {
    const { calls, fetchImpl } = acpSpy();
    await createDispatcher({
      run: runStub, now: () => NOW, gatewayToken: 'tok', boundSessionId: BOUND,
      fetchImpl, isPidAlive: () => true, sessionsDir: sessionsDirWith(RAW_USER),
    }).run({ prompt: 'x', cwd: 'D:\\work', createNew });
    assert.ok(calls.includes('session/load'), `★ createNew=${createNew} 必须走 load`);
    assert.ok(!calls.includes('session/new'), `★ createNew=${createNew} 不许新建`);
  }
});

test('★★★ load 回传的模型清单（含倍率）必须真的到达调用方', async () => {
  // ★ 倍率是展示层唯一的数据源。load 拿不到清单 ⇒ 界面只能显示"未知"，
  //   而"未知"被当 0（=免费）渲染是最贵的一次错账。
  const { fetchImpl } = acpSpy();
  const r = await createDispatcher({
    run: runStub, now: () => NOW, gatewayToken: 'tok', boundSessionId: BOUND, fetchImpl, isPidAlive: () => true,
    sessionsDir: sessionsDirWith(RAW_USER),
  }).run({ prompt: 'x', cwd: 'D:\\work' });
  assert.equal(r.ok, true, `★ 绑了就能跑：${JSON.stringify(r.error)}`);
  const byId = Object.fromEntries((r.models ?? []).map((m) => [m.modelId, m]));
  assert.equal(byId.hy3?.credits, 'x0.00', '★ 倍率取 _meta.credits 原值');
  assert.equal(byId['kimi-k3-1']?.credits, 'x1.62');
  // ★ 负控：清单为空时不得凭空造一条——"没有"必须如实是"没有"。
  const { fetchImpl: emptyFetch } = acpSpy({ models: [] });
  const r2 = await createDispatcher({
    run: runStub, now: () => NOW, gatewayToken: 'tok', boundSessionId: BOUND, fetchImpl: emptyFetch, isPidAlive: () => true,
    sessionsDir: sessionsDirWith(RAW_USER),
  }).run({ prompt: 'x', cwd: 'D:\\work' });
  assert.deepEqual(r2.models, [], '★ 清单为空就如实为空，不得回落到本地硬编码表');
});

test('★★★ 工作区必须随任务送进 prompt（cwd 不生效，这是唯一路径）', async () => {
  // 真机四次反证（acp.js `buildPromptBlocks` 里逐条记着）：`session/new`/`session/load`
  // 的 `cwd` 被静默丢弃——连不存在的盘 Z: 都"成功"。所以工作区只能当**输入**送。
  const sent = [];
  const { fetchImpl } = acpSpy({ capturePrompt: sent });
  const r = await createDispatcher({
    run: runStub, now: () => NOW, gatewayToken: 'tok', boundSessionId: BOUND, fetchImpl, isPidAlive: () => true,
    sessionsDir: sessionsDirWith(RAW_USER),
  }).run({ prompt: '看这个目录', cwd: 'D:\\Box\\交易知识库' });
  assert.equal(r.ok, true);
  const blocks = sent[0]?.params?.prompt;
  assert.ok(Array.isArray(blocks) && blocks.length >= 2, `★ 至少要有正文块 + 资源块：${JSON.stringify(blocks)}`);
  const text = blocks.find((b) => b.type === 'text')?.text ?? '';
  assert.ok(text.includes('D:\\Box\\交易知识库'),
    `★ 正文里必须点名工作区，否则模型无从知道：${JSON.stringify(text)}`);
  const res = blocks.find((b) => b.type === 'resource')?.resource;
  assert.equal(res?.uri, 'file:///D:/Box/交易知识库', '★ 资源块必须给规范 file: URI');
  // ★ 负控：不传工作区时不得凭空编一个 URI 出来。
  const sent2 = [];
  const { fetchImpl: f2 } = acpSpy({ capturePrompt: sent2 });
  await createDispatcher({
    run: runStub, now: () => NOW, gatewayToken: 'tok', boundSessionId: BOUND, fetchImpl: f2, isPidAlive: () => true,
    sessionsDir: sessionsDirWith(RAW_USER),
  }).run({ prompt: 'x', cwd: '   ' });
  assert.equal(sent2[0]?.params?.prompt.length, 1, '★ 无工作区时只发一个纯正文块');
});

test('★★★★ capabilities()：只 load 不 prompt，取回服务端那份权限表', async () => {
  // ★ `permission_mode` 是 `workbuddy_run` 的参数，而那张表**只在服务端**（config_option_update）。
  //   模型要能在第一次下发**之前**知道有哪些合法值，就必须有个只读探针。
  //   正控：绑了对话 ⇒ known:true + 服务端那份 4 值表 + 当前值。
  const { calls, fetchImpl } = acpSpy();
  const c = await createDispatcher({
    run: runStub, now: () => NOW, gatewayToken: 'tok', boundSessionId: BOUND, fetchImpl, isPidAlive: () => true,
    sessionsDir: sessionsDirWith(RAW_USER),
  }).capabilities();
  assert.equal(c.known, true, `★ 绑定态必须探得到：${JSON.stringify(c.error)}`);
  assert.deepEqual(c.options.map((o) => o.value), ['default', 'plan', 'dontAsk', 'fullAccess'],
    '★ 表必须来自服务端事件，且 fullAccess 不能缺（本地 6 值 flag 表就缺它）');
  assert.equal(c.current, 'default', '★ 当前值也要带出来');
  assert.equal(c.error, null);
  assert.ok(calls.includes('session/load'), '★ 探针靠 load');
  assert.ok(!calls.includes('session/prompt'), '★ 探针绝不许发任务（那就变成白烧一次积分）');
  assert.ok(!calls.includes('session/new'), '★ 探针绝不许 new（new 有副作用，会切 GUI active）');
  assert.ok(!calls.includes('session/set_mode'), '★ 探针是只读的：不许顺手改权限');

  // ★★ 负控（两个都必须成立，否则这张表会被当成"永远可信"）：
  //   ① 没绑对话 ⇒ known:false + 明确成因，且**一个 ACP 调用都不许有**。
  //   ② 事件流里没有那张表 ⇒ known:false 空表，**绝不用本地常量顶替**。
  const { calls: c1, fetchImpl: f1 } = acpSpy();
  const none = await createDispatcher({
    run: runStub, now: () => NOW, gatewayToken: 'tok', boundSessionId: '', fetchImpl: f1, isPidAlive: () => true,
    sessionsDir: sessionsDirWith(RAW_USER),
  }).capabilities();
  assert.equal(none.known, false);
  assert.equal(none.error.code, 'no_bound_session', '★ 空表必须带成因，否则分不清"没绑"和"桌面端挂了"');
  assert.deepEqual(c1, [], `★ 没绑对话时探针不许有任何副作用：实际 ${JSON.stringify(c1)}`);

  const { fetchImpl: f2 } = acpSpy({ modes: [] });
  const blind = await createDispatcher({
    run: runStub, now: () => NOW, gatewayToken: 'tok', boundSessionId: BOUND, fetchImpl: f2, isPidAlive: () => true,
    sessionsDir: sessionsDirWith(RAW_USER),
  }).capabilities();
  assert.equal(blind.known, false, '★ 收不到表就说收不到');
  assert.deepEqual(blind.options, [], '★ 绝不用本地 6 值 flag 表顶替（那份缺 fullAccess/delegate）');
});

test('★★★ startGatewayRun 必须把三个新参数**原样**透传给 dispatch.run', async () => {
  // ★ 这一层最容易出"加了参数但静默不生效"的错：`dispatch.run` 的形参写错一个字，
  //   参数就掉进默认值，而**所有其它测试照样绿**。所以直接断言落到的那个对象上。
  const seen = [];
  const g = startGatewayRun({
    prompt: 'x',
    cwd: 'D:\\work',
    modelId: 'hy3',
    permissionMode: 'fullAccess',
    workspace: 'D:\\Box\\交易知识库',
    createNew: true,
    dispatch: {
      run: async (req) => {
        seen.push(req);
        return { status: 'completed', exitCode: 0, gateway: { ok: true }, models: [], modes: null };
      },
    },
  });
  await g.done;
  assert.equal(seen.length, 1, '★ 恰好下发一次');
  assert.equal(seen[0].permissionMode, 'fullAccess', '★ 授权强度必须透传');
  assert.equal(seen[0].workspace, 'D:\\Box\\交易知识库', '★ 工作区必须透传（它只能靠 prompt 生效）');
  assert.equal(seen[0].createNew, true, '★ 新建对话标记必须透传');
  // ★ 负控：不给就是 null/undefined，让 dispatch 回落到配置值——**不是** '' 或 false。
  //   `createNew: false` 与 `createNew: null` 语义不同：前者是用户明确要求不新建。
  const seen2 = [];
  const g2 = startGatewayRun({
    prompt: 'x', cwd: 'D:\\work', modelId: 'hy3',
    dispatch: { run: async (req) => { seen2.push(req); return { status: 'completed', exitCode: 0, gateway: {} }; } },
  });
  await g2.done;
  assert.equal(seen2[0].permissionMode, null, '★ 没给权限必须传 null（空串会被当成显式值）');
  assert.equal(seen2[0].createNew, null, '★ 没给就必须传 null，不能传 false');
  assert.equal(seen2[0].workspace, '', '★ 没给工作区就是空串（dispatch 用它回落到设置）');
});

// ══════════════════════════════════════════════════════════════════════
// 权限模式：**不许把 set_mode 的回显当成功**（2026-09-28 真机三连证）
// ══════════════════════════════════════════════════════════════════════

const mkDispatcher = (opts) => createDispatcher({
  run: runStub, now: () => NOW, gatewayToken: 'tok', boundSessionId: BOUND,
  isPidAlive: () => true, sessionsDir: sessionsDirWith(RAW_USER), ...opts,
});

test('★★★ 服务端接受 set_mode 但不生效时，必须报 confirmed:false 而不是"设好了"', async () => {
  // ★ 这是本轮最贵的发现：真机 `session/set_mode` 回 200、回显你要的值，权限却纹丝不动。
  //   若上层拿回显当成功，用户就会以为自己放开了 Bash，实际跑在 Always Ask 下——
  //   **报假账比报错贵得多**，因为没报错。
  const { fetchImpl, calls } = acpSpy({ honorSetMode: false });
  const out = await mkDispatcher({ fetchImpl }).run({ prompt: 'x', permissionMode: 'fullAccess' });

  assert.equal(out.ok, true, '★ 没生效也**不中止**：中止等于"凡请求权限一律发不出去"');
  assert.deepEqual(out.permission, {
    requested: 'fullAccess', echoed: 'fullAccess', effective: 'default', confirmed: false,
  }, '★ 必须如实报"没生效"和实际生效值');
  assert.ok(calls.includes('session/set_mode'), '★ 仍然要下发（万一服务端将来修好）');
  // ★ 回读必须**另开一条连接**：真机上同一条连接的第二次 load 不再下发 config_option_update，
  //   同连接回读会拿到空值，把"没生效"误判成"读不到"。
  assert.equal(calls.filter((c) => c === 'connect').length, 2,
    '★ 验证权限必须新开连接；同连接回读在真机上恒为空');
});

test('★★★ 服务端真的生效时 confirmed:true（这条分支不能被上一条误伤）', async () => {
  const { fetchImpl } = acpSpy({ honorSetMode: true });
  const out = await mkDispatcher({ fetchImpl }).run({ prompt: 'x', permissionMode: 'fullAccess' });
  assert.equal(out.permission.confirmed, true);
  assert.equal(out.permission.effective, 'fullAccess');
});

test('★★★ 没请求权限时不得凭空造出 permission 字段', async () => {
  const { fetchImpl, calls } = acpSpy();
  const out = await mkDispatcher({ fetchImpl }).run({ prompt: 'x' });
  assert.equal(out.permission, null);
  assert.ok(!calls.includes('session/set_mode'), '★ 没要求就别去设——那是副作用');
});

test('★★★ 没生效这件事必须出现在**作业输出**里，不能只躺在机器可读字段里', async () => {
  // ★ 只放 `gateway.permission` 是不够的：那份不进 readOutput，读者看不到，
  //   "我设了 fullAccess"就成了没人反驳的假话。
  const { fetchImpl } = acpSpy({ honorSetMode: false });
  const d = mkDispatcher({ fetchImpl });
  const g = startGatewayRun({
    prompt: 'x', cwd: 'D:\\work', permissionMode: 'fullAccess', dispatch: d,
  });
  g.readOutput();
  await g.done;
  const out = g.readOutput();
  assert.match(out, /NOT applied/, '★ 作业输出里必须说清楚权限没生效');
  assert.match(out, /default/, '★ 还要说出实际生效的是哪个');
  assert.match(out, /dialog/, '★ 并给出后果：等一个没人点的对话框');
});

// ── sessionOrigin：权限没生效时，措辞必须指到**能动的那一步** ────────────────
// 真机（2026-09-28，probe-setmode-timing.mjs）：`set_mode` 在自建会话上真生效，
// 在已存在会话上只有回传。同样一句"没生效"，两种会话的下一步完全不同 ——
// 写成通用警告就等于没告诉读者怎么办。
test('权限没生效 + 载入了已有会话 ⇒ 必须点名"用 new_conversation 重开"这个出路', async () => {
  const { fetchImpl } = acpSpy({ honorSetMode: false });
  const g = startGatewayRun({
    prompt: 'x', cwd: 'D:\\work', permissionMode: 'fullAccess', dispatch: mkDispatcher({ fetchImpl }),
  });
  g.readOutput();
  await g.done;
  const out = g.readOutput();
  assert.match(out, /new_conversation/, '★ 已有会话这条路唯一的出路就是自建会话，必须点出来');
  assert.match(out, /Pre-existing conversations do not accept set_mode/);
});

test('权限没生效 + 这次确实自建了会话 ⇒ **不得**再建议 new_conversation（那已经用过了）', async () => {
  const { fetchImpl } = acpSpy({ honorSetMode: false });
  const g = startGatewayRun({
    prompt: 'x', cwd: 'D:\\work', permissionMode: 'fullAccess', createNew: true,
    dispatch: mkDispatcher({ fetchImpl }),
  });
  g.readOutput();
  await g.done;
  const out = g.readOutput();
  assert.match(out, /NOT applied/, '仍必须报没生效');
  assert.doesNotMatch(out, /new_conversation/,
    '★ 自建会话上再建议"开个新会话"是坏建议——它已经把该做的做过了');
  assert.match(out, /server-side refusal/);
});

test('sessionOrigin 随回执一起给出（新/旧各一次），否则工具层无从措辞', async () => {
  const loaded = await mkDispatcher({ fetchImpl: acpSpy().fetchImpl }).run({ prompt: 'x' });
  assert.equal(loaded.sessionOrigin, 'loaded', '没要求新建就是载入已有会话');
  const made = await mkDispatcher({ fetchImpl: acpSpy().fetchImpl }).run({ prompt: 'x', createNew: true });
  assert.equal(made.sessionOrigin, 'new');
});

// ★★★ 2026-09-28 真机才暴露的那个洞：**跨层的白名单会静默吞字段。**
// 上一条测试只断言 `dispatch.run()` 的返回值，**够不到 `startGatewayRun` 重新组装的那个
// `gateway` 对象**——而那才是真正喂给 `noteRun` 的东西。`sessionOrigin` 当时没在白名单里，
// 于是真机 `noteRun` 里查不到（单测全绿，因为全绿的路径压根没经过那一层）。
// 这条测试断言的是**经过 gateway-run.js 之后**的形状，专门钉这个接缝。
test('★★ sessionOrigin 必须穿过 startGatewayRun 的 gateway 白名单（真机上丢过一次）', async () => {
  const dispatcher = mkDispatcher({ fetchImpl: acpSpy().fetchImpl });
  for (const createNew of [true, false]) {
    const want = createNew ? 'new' : 'loaded';
    const g = startGatewayRun({
      prompt: 'x',
      modelId: null,
      cwd: '',
      permissionMode: null,
      createNew,
      signal: new AbortController().signal,
      dispatch: dispatcher,
    });
    const done = await g.done;
    assert.equal(done.gateway.sessionOrigin, want,
      `gateway 对象漏了 sessionOrigin ⇒ 作业输出里那条"哪条对话"永远查不到`
      + `（白名单少一行，字段在跨层时无声消失，且不报错）`);
  }
});

// B1: sessionId/sessionRenewed/sessionPersist 同一个坑再钉一次。对账键是 sessionId（ACP 会话 id），
// 不是 receipt.requestId（单次 prompt 幂等键）。白名单少一行 => noteRun 记不到落在哪条对话，回执与落库对不上。
test('B1 sessionId/sessionRenewed/sessionPersist 必须穿过 gateway 白名单（对账键是 sessionId，不是 requestId）', async () => {
  for (const createNew of [true, false]) {
    const dispatcher = mkDispatcher({ fetchImpl: acpSpy().fetchImpl });
    const g = startGatewayRun({
      prompt: 'x', modelId: null, cwd: '', permissionMode: null, createNew,
      signal: new AbortController().signal, dispatch: dispatcher,
    });
    const done = await g.done;
    if (createNew) {
      assert.equal(done.gateway.sessionId, 'ffffffff-0000-4000-8000-00000000beef');
      assert.equal(done.gateway.sessionRenewed, 'create_new_requested');
    } else {
      assert.equal(done.gateway.sessionId, '01a0e714-2298-7fef-b41c-2c8eb5247820');
      assert.equal(done.gateway.sessionRenewed, '');
    }
    assert.ok('sessionPersist' in done.gateway, 'sessionPersist 必须透传（null = 无持久化，对象 = 记账结果）');
    assert.notEqual(done.gateway.receipt?.requestId ?? null, done.gateway.sessionId, 'requestId 不得被当成 sessionId（两者无关）');
  }
});
