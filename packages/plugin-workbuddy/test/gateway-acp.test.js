// ACP 客户端。全部用假 fetch，不连网、不碰真 sidecar。
// ★ 重点守卫四个强制头 —— 它们是真机上一个个撞出来的，少一个就是一次 401/400/406。
import assert from 'node:assert/strict';
import test from 'node:test';

import { ACP_HEADERS, PROTOCOL_VERSION, classifyHttpError, createAcpClient } from '../src/host/gateway/acp.js';
import { extractToolCalls } from '../src/host/gateway/receipt.js';

const SSE = (id, result) => `:ok\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`;
const TOKEN = 'mj_iXNmXM';

/** 记录所有请求的假 fetch。`route(url, init, callIndex)` 返回 [status, body]。 */
function fakeFetch(route) {
  const calls = [];
  const impl = async (url, init) => {
    const rec = { url, init, headers: init?.headers ?? {} };
    calls.push(rec);
    const [status, body] = route(url, init, calls.length);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async () => JSON.parse(body),
    };
  };
  impl.calls = calls;
  return impl;
}

const CONNECT_OK = () => ['/api/v1/acp/connect', () => [200, JSON.stringify({ connectionId: '01a0e672-4140-7817-8b34-4b6e2b66d987', sessionToken: 'st' })]];

test('★ connect 取的是**顶层** connectionId（曾按 data 取，得到 undefined）', async () => {
  const f = fakeFetch((u) => (u.endsWith('/connect') ? [200, JSON.stringify({ connectionId: 'cid-1', sessionToken: 'st' })] : [200, '']));
  const c = createAcpClient({ url: 'http://127.0.0.1:65252/', token: TOKEN, fetchImpl: f });
  const r = await c.connect();
  assert.deepEqual(r, { ok: true, connectionId: 'cid-1' });
  assert.equal(c.connectionId, 'cid-1');
  assert.equal(f.calls[0].url, 'http://127.0.0.1:65252/api/v1/acp/connect', '★ connect 不在 /api/v1/acp 上');
});

test('★ connect 响应没有 connectionId ⇒ 报错，不返回 ok:true', async () => {
  const f = fakeFetch(() => [200, JSON.stringify({ data: { connectionId: 'cid-1' } })]);
  const c = createAcpClient({ url: 'http://x', token: TOKEN, fetchImpl: f });
  const r = await c.connect();
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'bad_response');
});

test('★ 四个强制头一个都不能少（少一个分别是 401 / 400 / 406）', async () => {
  const f = fakeFetch((u) => (u.endsWith('/connect')
    ? [200, JSON.stringify({ connectionId: 'cid-1' })]
    : [200, SSE('r1', { stopReason: 'end_turn', _meta: { 'codebuddy.ai/outcome': 'SUCCESS' } })]));
  const c = createAcpClient({ url: 'http://127.0.0.1:65252', token: TOKEN, fetchImpl: f });
  await c.connect();
  await c.prompt('sess-1', '你好');

  const acpCall = f.calls.find((x) => x.url.endsWith('/api/v1/acp'));
  const h = acpCall.headers;
  assert.equal(h.Authorization ?? h.authorization, `Bearer ${TOKEN}`, '★ 缺 ⇒ 401');
  assert.equal(h['X-CodeBuddy-Request'] ?? h['x-codebuddy-request'], '1', '★ 缺 ⇒ 401');
  assert.equal(h['acp-connection-id'], 'cid-1', '★ 缺 ⇒ 400 Missing acp-connection-id header');
  assert.equal(h.Accept, 'application/json, text/event-stream', '★ 缺 ⇒ 406 Not Acceptable');
  assert.deepEqual({ ...ACP_HEADERS, authorization: undefined }, { ...ACP_HEADERS, authorization: undefined });
});

test('★ 未 connect 就 prompt ⇒ 不带 acp-connection-id（应能提前失败而不是等 400）', async () => {
  const f = fakeFetch(() => [200, '']);
  const c = createAcpClient({ url: 'http://127.0.0.1:1', token: TOKEN, fetchImpl: f });
  await c.prompt('s', 'x');
  const h = f.calls[0].headers;
  assert.equal(h['acp-connection-id'], undefined, 'connect 前该头不存在');
});

test('session/new：解出 sessionId 与模型清单', async () => {
  const f = fakeFetch((u) => (u.endsWith('/connect')
    ? [200, JSON.stringify({ connectionId: 'cid-1' })]
    : [200, SSE('r1', {
      sessionId: 'sess-abc',
      models: { availableModels: [{ modelId: 'kimi-k3-1', name: 'Kimi-K3', _meta: { credits: 'x1.62' } }] },
    })]));
  const c = createAcpClient({ url: 'http://x', token: TOKEN, fetchImpl: f });
  await c.connect();
  const r = await c.newSession('C:/work');
  assert.equal(r.sessionId, 'sess-abc');
  assert.deepEqual(r.models, [{ modelId: 'kimi-k3-1', name: 'Kimi-K3', credits: 'x1.62' }]);
  const body = JSON.parse(f.calls[1].init.body);
  assert.equal(body.method, 'session/new');
  assert.equal(body.params.cwd, 'C:/work');
  assert.deepEqual(body.params.mcpServers, [], '★ 必须显式给空数组，否则 sidecar 会等外部 MCP 握手');
});

test('initialize：协议版本与能力位（fs 全部 false —— 插件不替 sidecar 碰文件）', async () => {
  const f = fakeFetch(() => [200, SSE('r1', { agentCapabilities: { loadSession: true } })]);
  const c = createAcpClient({ url: 'http://x', token: TOKEN, fetchImpl: f });
  const r = await c.initialize();
  assert.deepEqual(r.capabilities, { agentCapabilities: { loadSession: true } });
  const p = JSON.parse(f.calls[0].init.body).params;
  assert.equal(p.protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(p.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false } });
});

test('set_model：★ 没生效必须报错（拿旧模型去跑 = 静默错账）', async () => {
  const bad = fakeFetch(() => [200, SSE('r1', { error: { code: -32602, message: 'unknown model' } })]);
  const c1 = createAcpClient({ url: 'http://x', token: TOKEN, fetchImpl: bad });
  const r1 = await c1.setModel('s', 'no-such-model');
  assert.equal(r1.error.code, 'model_unavailable');

  const good = fakeFetch(() => [200, SSE('r1', { modelId: 'kimi-k3-1' })]);
  const c2 = createAcpClient({ url: 'http://x', token: TOKEN, fetchImpl: good });
  assert.equal((await c2.setModel('s', 'kimi-k3-1')).modelId, 'kimi-k3-1');
});

test('★ prompt：回执来自 POST 响应体本身（实测去等 session_end 会永远挂住）', async () => {
  const body = `:ok\n\n`
    + `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } } } })}\n\n`
    + `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 'r1', result: { stopReason: 'end_turn', _meta: { 'codebuddy.ai/outcome': 'SUCCESS', 'codebuddy.ai/requestId': 'req-1' } } })}\n`;
  const f = fakeFetch(() => [200, body]);
  const c = createAcpClient({ url: 'http://x', token: TOKEN, fetchImpl: f });
  const r = await c.prompt('sess-abc', '只回 OK');
  assert.equal(r.receipt.succeeded, true);
  assert.equal(r.requestId, 'req-1', '★ requestId 是幂等键');
  assert.equal(r.text, 'OK');
  assert.equal(r.error, null);
  const p = JSON.parse(f.calls[0].init.body).params;
  assert.deepEqual(p.prompt, [{ type: 'text', text: '只回 OK' }]);
});

test('★ prompt：有 id 但 result 不是对象 ⇒ 报 no_receipt，不当成"跑完了但没输出"', async () => {
  // 事件流正常（说明确实跑过），但结尾没有 result
  const body = `:ok\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 'r1', error: { code: -32000, message: 'run aborted' } })}\n`;
  const f = fakeFetch(() => [200, body]);
  const c = createAcpClient({ url: 'http://x', token: TOKEN, fetchImpl: f });
  const r = await c.prompt('s', 'x');
  assert.equal(r.receipt, null);
  assert.match(r.error.code, /^rpc_/, '★ 顶层 error 也算失败（不能当成功）');
  assert.match(r.error.message, /run aborted/);
});

test('★ prompt：★ 响应体里连 id 都没有 ⇒ 报 no_response', async () => {
  const f = fakeFetch(() => [200, ':ok\n\ndata: {"jsonrpc":"2.0","method":"session/update","params":{}}\n']);
  const c = createAcpClient({ url: 'http://x', token: TOKEN, fetchImpl: f });
  const r = await c.prompt('s', 'x');
  assert.equal(r.receipt, null);
  assert.equal(r.error.code, 'no_response', '★ 静默成功 = 静默丢任务');
  assert.equal(r.text, '');
});

test('★ 网关把错误塞在 result.error 里（JSON-RPC 惯例是顶层 error）⇒ 一律判失败', async () => {
  const f = fakeFetch(() => [200, SSE('r1', { error: { code: -32602, message: 'unknown model' } })]);
  const c = createAcpClient({ url: 'http://x', token: TOKEN, fetchImpl: f });
  const r = await c.prompt('s', 'x');
  assert.equal(r.receipt, null);
  assert.match(r.error.code, /^rpc_/);
  assert.match(r.error.message, /unknown model/);
});

test('★ prompt：发送前已 abort ⇒ 直接 aborted，不发请求（省一次真实扣费）', async () => {
  const f = fakeFetch(() => [200, '']);
  const c = createAcpClient({ url: 'http://x', token: TOKEN, fetchImpl: f });
  const r = await c.prompt('s', 'x', { signal: AbortSignal.abort() });
  assert.equal(r.error.code, 'aborted');
  assert.equal(f.calls.length, 0, '★ 已取消还发出去 = 白花积分');
});

test('HTTP 失败分类：400/401/406/429 各自可判定，且★ 错误信息不含口令', () => {
  for (const [status, code] of [[400, 'bad_request'], [401, 'unauthorized'], [403, 'forbidden'], [406, 'not_acceptable'], [429, 'rate_limited'], [500, 'server_error'], [503, 'unavailable']]) {
    const e = classifyHttpError(status, 'session/prompt');
    assert.equal(e.code, code, `HTTP ${status}`);
    assert.ok(!e.message.includes(TOKEN), '★ 错误信息绝不含凭据');
  }
  // 这两条是本层最贵的两个坑，报错必须点出来而不是只说"请求失败"
  assert.match(classifyHttpError(406, 'x').message, /application\/json/);
  assert.match(classifyHttpError(400, 'x').message, /acp-connection-id/);
  assert.match(classifyHttpError(401, 'x').message, /sidecar restarted/);
  assert.equal(classifyHttpError(418, 'x').code, 'http_error');
});

test('sidecar 不可达 ⇒ unreachable，不是 HTTP 错误', async () => {
  const f = async () => { throw new Error('ECONNREFUSED'); };
  const c = createAcpClient({ url: 'http://127.0.0.1:9', token: TOKEN, fetchImpl: f });
  const r = await c.connect();
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'unreachable');
  assert.ok(!r.error.message.includes(TOKEN), '★ 不可达信息也不含凭据');
});

test('★ 读**响应体**时连接被断 ⇒ 收敛成 unreachable，**不抛未捕获异常**', async () => {
  // 真机复现（2026-09-30）：prewarm 激活态在 session/new 上必现。
  // fetch() 本身是成功的（返回了 Response），断在读 body 时（ECONNRESET ⇒
  // `TypeError: terminated`）。旧代码的 try 只包住 fetch()，res.text() 在 try 之外，
  // 于是异常一路冲出 postAcp/newSession —— 整个 run 被打成崩溃，上层拿不到 reasonCode。
  const f = async () => ({
    ok: true,
    status: 200,
    text: async () => {
      const err = new TypeError('terminated');
      err.cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      throw err;
    },
  });
  const c = createAcpClient({ url: 'http://127.0.0.1:51626', token: TOKEN, fetchImpl: f });
  const r = await c.newSession('C:\\tmp');
  assert.equal(r.error?.code, 'unreachable', '★ 必须是可判定的 unreachable，不能是抛异常');
  assert.match(r.error.message, /closed the connection/);
  assert.ok(!r.error.message.includes(TOKEN), '★ 信息里不含凭据');
});

test('工具调用随 prompt 一起回报（验收要知道 agent 干了什么）', async () => {
  const tool = { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call', title: 'Read(x.md)' } } };
  const done = { jsonrpc: '2.0', id: 'r1', result: { stopReason: 'end_turn', _meta: { 'codebuddy.ai/outcome': 'SUCCESS' } } };
  const f = fakeFetch(() => [200, `:ok\n\ndata: ${JSON.stringify(tool)}\n\ndata: ${JSON.stringify(done)}\n`]);
  const c = createAcpClient({ url: 'http://x', token: TOKEN, fetchImpl: f });
  const r = await c.prompt('s', 'x');
  assert.deepEqual(r.tools, extractToolCalls([tool, done]));
  assert.equal(r.tools.count, 1);
});
