// 网关通道的纯解析层。★ fixture 全部是 2026-09-28 真机 `session/prompt` 响应体的原文片段
//   （`tools/recon/last-run-stream.txt`，kimi-k3-1，traceId b82bea1e…），不是手编的样例。
//   负对照（outcome:FAILURE / 无 result / 非 SSE 文本）必须判错，否则这条绿灯没有意义。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractAssistantText, extractPhases, extractReceipt, extractSession, extractToolCalls,
  parseMultiplier, parseSseMessages, pickResponse,
} from '../src/host/gateway/receipt.js';

// ── 真机原文（逐字取自 last-run-stream.txt） ───────────────────────────────
const REAL_RECEIPT = '{"jsonrpc":"2.0","id":"r4","result":{"stopReason":"end_turn","userMessageId":"01a0e665-bdba-75e7-8ce8-f002efa49a11","_meta":{"timestamp":"2026-09-28T05:03:49.691Z","codebuddy.ai/requestId":"01a0e665bdba75e78ce8f001f146eff1","codebuddy.ai/conversationRequestId":"01a0e665bdba75e78ce8f001f146eff1","codebuddy.ai/traceId":"b82bea1e5f75e290ac02deba0b83c135","baggage":"codebuddy.session_id=01a0e665-bd8e-7104-bea9-d0108454e281,codebuddy.conversation_request_id=01a0e665bdba75e78ce8f001f146eff1","codebuddy.ai/finishReason":"stop","codebuddy.ai/outcome":"SUCCESS"}}}';

const REAL_CHUNK = '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"01a0e665-bd8e-7104-bea9-d0108454e281","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"OK"},"messageId":"01a0e665-bdf4-7d91-9a34-ba83560c8c5d","_meta":{"codebuddy.ai/requestModelId":"kimi-k3-1","codebuddy.ai/requestModelName":"Kimi-K3","codebuddy.ai/traceId":"b82bea1e5f75e290ac02deba0b83c135"}}}}';

const REAL_PHASE = '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"session_info_update","_meta":{"codebuddy.ai/agentPhase":{"phase":"model_streaming","startedAt":1790571820000}}}}}';

const REAL_USAGE = '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"usage_update","used":0,"size":300000,"_meta":{"codebuddy.ai/requestId":"01a0e665bdba75e78ce8f001f146eff1"}}}}';

const REAL_TOOL = '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","title":"Read(README.md)"}}}';

/** 把若干条真件消息拼成一条真机形态的 SSE 响应体。 */
const sse = (...dataLines) => `:ok\n\nevent: message\ndata: ${dataLines.join('\n\nevent: message\ndata: ')}\n`;

// ── parseSseMessages ─────────────────────────────────────────────────────
test('真机响应体：拆出全部 JSON-RPC 消息，SSE 框架行（:ok / event:）不算消息', () => {
  const msgs = parseSseMessages(sse(REAL_PHASE, REAL_CHUNK, REAL_RECEIPT));
  assert.equal(msgs.length, 3);
  assert.equal(msgs[2].id, 'r4');
});

test('★ 直接 JSON.parse 会抛 —— 这正是当初 sessionId 取成 undefined 的原因', () => {
  const body = sse(REAL_RECEIPT);
  // 真脚本里 `try { json = JSON.parse(text) } catch {}` ⇒ catch 之后 json 才留成 null，
  // 于是 `sessionId` 取成 undefined、`session/prompt` 报 `sessionId: expected string`。
  assert.throws(() => JSON.parse(body), '★ SSE 形态不可直接 JSON.parse（守卫这条前提不被后人改掉）');
  let json = null;
  try { json = JSON.parse(body); } catch { /* 真脚本就是这么写的 */ }
  assert.equal(json, null);
  assert.notEqual(parseSseMessages(body).length, 0);
});

test('脏行跳过而不是抛：一条坏 data 不该毁掉整次回执', () => {
  const msgs = parseSseMessages(':ok\n\ndata: {坏掉的\n\ndata: ' + REAL_RECEIPT);
  assert.equal(msgs.length, 1, '只留下能解析的那条');
  assert.equal(msgs[0].id, 'r4');
});

test('非 SSE 输入 ⇒ 空数组，不抛', () => {
  assert.deepEqual(parseSseMessages(''), []);
  assert.deepEqual(parseSseMessages('{"result":{}}'), [], '★ 纯 JSON（无 data: 行）解不出消息，不能当成成功');
  assert.deepEqual(parseSseMessages(null), []);
});

// ── pickResponse ─────────────────────────────────────────────────────────
test('按 id 挑响应：★ 顺序取最后一条会拿到 session/update 而不是 result', () => {
  const msgs = parseSseMessages(sse(REAL_PHASE, REAL_CHUNK, REAL_USAGE, REAL_RECEIPT));
  const r = pickResponse(msgs, 'r4');
  assert.equal(r.result.stopReason, 'end_turn');
  assert.equal(pickResponse(msgs, 'r99'), null, '不存在的 id ⇒ null，不能退化成最后一条');
  assert.equal(pickResponse(msgs, undefined), null);
});

// ── extractReceipt ───────────────────────────────────────────────────────
test('真机回执：字段逐个对上，succeeded=true', () => {
  const r = extractReceipt(pickResponse(parseSseMessages(sse(REAL_RECEIPT)), 'r4'));
  assert.equal(r.stopReason, 'end_turn');
  assert.equal(r.finishReason, 'stop');
  assert.equal(r.outcome, 'SUCCESS');
  assert.equal(r.traceId, 'b82bea1e5f75e290ac02deba0b83c135');
  assert.equal(r.userMessageId, '01a0e665-bdba-75e7-8ce8-f002efa49a11');
  assert.equal(r.timestamp, '2026-09-28T05:03:49.691Z');
  assert.equal(r.succeeded, true);
  assert.ok(r.requestId, 'requestId 是幂等键，下发被拒时也会出现');
});

test('★ 负对照：outcome:FAILURE 必须判失败（哪怕 stopReason 是 end_turn）', () => {
  const bad = REAL_RECEIPT.replace('"codebuddy.ai/outcome":"SUCCESS"', '"codebuddy.ai/outcome":"FAILURE"');
  const r = extractReceipt(pickResponse(parseSseMessages(sse(bad)), 'r4'));
  assert.equal(r.stopReason, 'end_turn', '（stopReason 确实还是 end_turn —— 这正是必须双判的原因）');
  assert.equal(r.succeeded, false, '★ outcome 优先于 stopReason');
});

test('★ 负对照：stopReason 非 end_turn 且无 outcome ⇒ 失败', () => {
  // 同时改两处：outcome 的**键名**挪走（模拟"没有这个字段"），且 stopReason 真的不是 end_turn
  const bad = REAL_RECEIPT
    .replace('"stopReason":"end_turn"', '"stopReason":"max_tokens"')
    .replace(/"codebuddy\.ai\/outcome"/g, '"codebuddy.ai/other"');
  const r = extractReceipt(pickResponse(parseSseMessages(sse(bad)), 'r4'));
  assert.equal(r.outcome, null, 'outcome 键确实不在了');
  assert.equal(r.stopReason, 'max_tokens');
  assert.equal(r.succeeded, false, '★ 没有 outcome 时退回 stopReason 判，非 end_turn 即失败');
});

test('★ 负对照：既无 outcome 又 stopReason=end_turn ⇒ 仍判成功（回退路径本身要有覆盖）', () => {
  const only = REAL_RECEIPT.replace(/"codebuddy\.ai\/outcome":"SUCCESS"/, '"codebuddy.ai/other":"SUCCESS"');
  const r = extractReceipt(pickResponse(parseSseMessages(sse(only)), 'r4'));
  assert.equal(r.outcome, null);
  assert.equal(r.succeeded, true, 'outcome 缺失时，ACP 标准的 end_turn 就是完成信号');
});

test('没有 result ⇒ null（不返回半截对象）', () => {
  assert.equal(extractReceipt(null), null);
  assert.equal(extractReceipt({}), null);
  assert.equal(extractReceipt({ result: 'not-an-object' }), null);
});

// ── extractAssistantText / Phases / ToolCalls ────────────────────────────
test('正文取自 agent_message_chunk 分片，不是回执字段', () => {
  const msgs = parseSseMessages(sse(REAL_RECEIPT, REAL_CHUNK));
  assert.equal(extractAssistantText(msgs), 'OK');
  assert.equal(extractAssistantText(parseSseMessages(sse(REAL_RECEIPT))), '', '只有回执没有分片 ⇒ 空串');
  assert.equal(extractAssistantText(null), '');
});

test('多段分片按顺序拼接', () => {
  const a = REAL_CHUNK.replace('"text":"OK"', '"text":"第一段"');
  const b = REAL_CHUNK.replace('"text":"OK"', '"text":"第二段"');
  assert.equal(extractAssistantText(parseSseMessages(sse(a, b))), '第一段第二段');
});

test('★ 阶段轨迹去重保序 = 真机五段', () => {
  const phases = ['idle', 'preparing', 'model_requesting', 'model_streaming', 'model_done'];
  const body = sse(...phases.map((p) => REAL_PHASE.replace('"model_streaming"', `"${p}"`)), REAL_PHASE);
  assert.deepEqual(extractPhases(parseSseMessages(body)), phases);
  assert.deepEqual(extractPhases(parseSseMessages(sse(REAL_USAGE, REAL_RECEIPT))), []);
});

test('工具调用只数不判成败；没调用就是 0（真机那轮确实是 0）', () => {
  assert.equal(extractToolCalls(parseSseMessages(sse(REAL_CHUNK, REAL_RECEIPT))).count, 0);
  const used = extractToolCalls(parseSseMessages(sse(REAL_TOOL, REAL_RECEIPT)));
  assert.equal(used.count, 1);
  assert.deepEqual(used.names, ['Read(README.md)']);
  // usage_update 不是工具调用 —— 它是上下文 token（size 300000），与积分无关
  assert.equal(extractToolCalls(parseSseMessages(sse(REAL_USAGE))).count, 0);
});

// ── extractSession / 倍率 ───────────────────────────────────────────────
test('session/new：取 sessionId 与模型倍率（接口原样 "x0.21"）', () => {
  const r = extractSession({
    result: {
      sessionId: '01a0e665-9e4e-7f42-bb60-d435a9eb61e4',
      models: {
        availableModels: [
          { modelId: 'fast-model', name: '快速', description: 'x0.21', _meta: { credits: 'x0.21' } },
          { modelId: 'hy3', name: 'Hy3', description: 'x0.00', _meta: { credits: 'x0.00' } },
          { modelId: 'kimi-k3-1', name: 'Kimi-K3', description: 'x1.62', _meta: { credits: 'x1.62' } },
        ],
      },
    },
  });
  assert.equal(r.sessionId, '01a0e665-9e4e-7f42-bb60-d435a9eb61e4');
  assert.deepEqual(r.models.map((m) => m.modelId), ['fast-model', 'hy3', 'kimi-k3-1']);
  assert.equal(r.models[1].credits, 'x0.00');
  assert.equal(parseMultiplier(r.models[0].credits), 0.21);
  assert.equal(parseMultiplier(r.models[1].credits), 0, 'x0.00 是免费档，必须解析成 0');
  assert.equal(parseMultiplier(r.models[2].credits), 1.62);
});

test('★ 负对照：模型清单取不到 ⇒ 空数组 + sessionId null（不是抛错，也不是假装有模型）', () => {
  const r = extractSession({ result: {} });
  assert.equal(r.sessionId, null);
  assert.deepEqual(r.models, []);
  assert.equal(extractSession(null).sessionId, null);
});

test('★ 负对照：倍率读不到 ⇒ null 而不是 0（"读不到"被当成"免费"是本仓最贵的坑）', () => {
  assert.equal(parseMultiplier(undefined), null);
  assert.equal(parseMultiplier('见说明'), null);
  assert.notEqual(parseMultiplier('见说明'), 0);
});
