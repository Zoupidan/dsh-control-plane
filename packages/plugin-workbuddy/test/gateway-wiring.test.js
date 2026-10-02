/**
 * 网关路的**装配**测试（纯层 `gateway-run.js` + `run.js` 的 transport 分流）。
 *
 * <p>★ 为什么单开一个文件：`host.test.js` 那 67 条测的是 spawn 路（argv / resume / 落盘 /
 *   D-3 判定行），它们与网关路**形状不同**（没有 argv、没有退出码、没有 stdout 流）。
 *   把两种路塞进同一个文件，会诱导出"用 spawn 的断言去套网关"这种无效用例。
 *
 * <p>每条都带正/负控：既测"成立"，也测"该红的时候确实红"—— 只跑通过的那种测试等于没跑。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gatewayHeader, multiplierOfSelected, startGatewayRun } from '../src/host/tools/gateway-run.js';
import { REASON_CODES } from '../src/host/launch/reason-codes.js';
import { GATEWAY_REASON } from '../src/host/gateway/dispatch.js';

const SID = { pid: 22620, url: 'http://127.0.0.1:65252' };
const RECEIPT = { stopReason: 'end_turn', outcome: 'SUCCESS', succeeded: true, requestId: 'r-1' };

/** 造一个"成功一轮"的 dispatcher，把参数与阶段如实记下来。 */
function okDispatch(extra = {}) {
  const seen = { req: null };
  return {
    seen,
    dispatch: {
      async run(req) {
        seen.req = req;
        for (const p of ['discovering', 'handshaking', 'prompting']) req.onPhase?.(p);
        return {
          ok: true, reason: null, text: '完成', receipt: RECEIPT,
          phases: ['discovering', 'handshaking', 'prompting'],
          tools: { count: 0, names: [] },
          models: [{ modelId: 'hy3-x', _meta: { credits: 'x0.05' } }],
          usedModelId: 'hy3-x',
          sidecar: SID, error: null, ...extra,
        };
      },
    },
  };
}

// ── 头部 ────────────────────────────────────────────────────────────────────
test('gatewayHeader：说真话 —— 有传输面/模型/cwd，**没有 argv**', () => {
  const line = gatewayHeader({ model: 'hy3-x', cwd: 'D:/x' });
  assert.match(line, /transport=gateway/);
  assert.match(line, /model=hy3-x/);
  assert.doesNotMatch(line, /--model|--resume|argv/, '★ 不得编造一条命令行（argv 是给人复核用的）');
});

test('gatewayHeader：模型为空 ⇒ 明说用 sidecar 默认，不留空位让人猜', () => {
  assert.match(gatewayHeader({ model: '', cwd: 'D:/x' }), /model=\(sidecar default\)/);
});

// ── 成功路径 ────────────────────────────────────────────────────────────────
test('成功：作业头 + 正文 + [ok] 终态行；done 收敛为 completed', async () => {
  const { dispatch, seen } = okDispatch();
  const g = startGatewayRun({ prompt: '只回两个字：完成', cwd: 'D:/x', modelId: 'hy3-x', dispatch });
  const out = await g.done;

  assert.equal(out.status, 'completed');
  assert.equal(out.exitCode, 0);
  // ★ 2026-10-02 改判：成功时 `detail` **必须带回复正文**。
  //   旧断言是 `detail === undefined`，理由是"有 detail 的成功会让上层以为有话说"。
  //   真机打脸：任务 exit 0、receipt SUCCESS、积分真扣了，但 `lastRun.stdoutText` 记的是空
  //   —— 读回执的人（状态卡 / 监控 / 审计）永远拿不到"模型到底说了什么"。
  //   正文一直在作业输出缓冲里（`readOutput`），回执与它不一致才是那个 bug 的本质。
  assert.equal(out.detail, '完成', '★ 成功回执必须带模型回复正文（上层 noteRun 只读 stdoutText）');
  const log = g.readOutput();
  assert.match(log, /transport=gateway/);
  assert.match(log, /完成/);
  assert.match(log, /\[ok\]/, '★ 终态行必须自报成败，读者不必翻别处');
  assert.match(log, /sidecar pid 22620/);
  assert.equal(seen.req.prompt, '只回两个字：完成', 'prompt 必须原样下发');
  assert.equal(seen.req.cwd, 'D:/x');
  assert.equal(seen.req.modelId, 'hy3-x');
});

test('★ 成功但模型没给任何文本：必须说清"完成但无正文"，不能留空让人以为没跑', async () => {
  // 反向对照：正文为空是**另一种**情况，不能和"成功"混成同一个空字符串。
  // 空 detail 会让上层把"跑完了但没话说"读成"什么都没发生" —— 那是两件事。
  const { dispatch } = okDispatch({ text: '' });
  const g = startGatewayRun({ prompt: 'p', cwd: 'D:/x', dispatch });
  const out = await g.done;
  assert.equal(out.status, 'completed');
  assert.equal(out.detail, '(completed with no text output)', '★ 成功但无正文 ⇒ 逐字说明，不留空');
});

test('★ 成功时也要说"实际用的模型"：请求的模型可能被 sidecar 否决', async () => {
  const { dispatch } = okDispatch({ usedModelId: 'glm-5.3-flash' });
  const g = startGatewayRun({ prompt: 'p', cwd: 'D:/x', modelId: 'hy3-x', dispatch });
  const out = await g.done;
  assert.equal(out.gateway.usedModelId, 'glm-5.3-flash', '回执里必须是**实际**那个，不是我请求的那个');
});

test('回执原样透出：上层判定/验收靠它，不靠 stdout 猜', async () => {
  const { dispatch } = okDispatch();
  const g = startGatewayRun({ prompt: 'p', cwd: 'D:/x', dispatch });
  const out = await g.done;
  assert.deepEqual(out.gateway.receipt, RECEIPT);
  assert.equal(out.gateway.reason, null);
  assert.equal(out.gateway.sidecar.pid, 22620);
});

test('倍率取实际选中项：用于标"免费 x0.00"', async () => {
  const { dispatch } = okDispatch();
  const g = startGatewayRun({ prompt: 'p', cwd: 'D:/x', dispatch });
  const out = await g.done;
  assert.equal(out.gateway.multiplier, 0.05);
});

// ── 阶段去重 ────────────────────────────────────────────────────────────────
test('阶段：连续同名只出一行（否则一个阶段刷十几行），换名才追加', async () => {
  let emit;
  const dispatch = { run: (req) => { emit = req.onPhase; return new Promise(() => {}); } };
  const g = startGatewayRun({ prompt: 'p', cwd: 'D:/x', dispatch });
  g.readOutput();
  emit('prompting'); emit('prompting'); emit('prompting'); emit('model_streaming');
  const log = g.readOutput();
  assert.equal(log.match(/… prompting/g)?.length, 1, '同名阶段必须去重');
  assert.match(log, /… model_streaming/);
});

// ── 失败路径（负控：必须红，不能被当成成功）──────────────────────────────────
test('★ 负控：有回执但 succeeded !== true ⇒ failed，且 detail 带上 reason', async () => {
  const { dispatch } = okDispatch({
    ok: false, reason: GATEWAY_REASON.run_failed, text: '半截输出',
    receipt: { stopReason: 'error', outcome: 'ERROR', succeeded: false },
    error: { code: 'not_successful', message: 'run did not succeed' },
  });
  const g = startGatewayRun({ prompt: 'p', cwd: 'D:/x', dispatch });
  const out = await g.done;
  assert.equal(out.status, 'failed', '★ 拿到一段正文不等于成功');
  assert.equal(out.exitCode, 1);
  assert.match(out.detail, /task_error/, 'detail 必须带 reason code，否则上层只能报"运行失败"');
  assert.match(g.readOutput(), /\[failed\]/);
});

test('★ 负控：dispatch 抛异常 ⇒ 不能变成未处理 rejection，必须收敛成 failed', async () => {
  const dispatch = { run: async () => { throw new Error('ECONNREFUSED 127.0.0.1:65252'); } };
  const g = startGatewayRun({ prompt: 'p', cwd: 'D:/x', dispatch });
  const out = await g.done;   // ★ 这里能拿到值就说明没有 unhandled rejection
  assert.equal(out.status, 'failed');
  assert.match(out.detail, /ECONNREFUSED/);
});

test('dispatch 返回垃圾形状 ⇒ 不崩，按失败处理（不能 throw 出去打穿作业）', async () => {
  const dispatch = { run: async () => ({}) };
  const g = startGatewayRun({ prompt: 'p', cwd: 'D:/x', dispatch });
  const out = await g.done;
  assert.equal(out.status, 'failed');
  assert.equal(out.gateway.reason, GATEWAY_REASON.run_failed);
});

// ── 取消 ────────────────────────────────────────────────────────────────────
test('★ 取消：调用方的 signal 真的掐到 dispatch（否则"取消"只是不看输出，任务还在烧积分）', async () => {
  const ac = new AbortController();
  let inner = null;
  const dispatch = { run: (req) => { inner = req.signal; return new Promise(() => {}); } };
  const g = startGatewayRun({ prompt: 'p', cwd: 'D:/x', signal: ac.signal, dispatch });
  g.readOutput();
  assert.equal(inner.aborted, false);
  ac.abort();
  assert.equal(inner.aborted, true, '上游 signal 必须透传到 ACP prompt');
  g.cancel();
  assert.equal(inner.aborted, true, '作业 cancel() 同样要掐');
});

test('传进来就已经 aborted ⇒ 立刻透传，不等下一次 abort 事件', async () => {
  const ac = new AbortController();
  ac.abort();
  let inner = null;
  const dispatch = { run: (req) => { inner = req.signal; return new Promise(() => {}); } };
  startGatewayRun({ prompt: 'p', cwd: 'D:/x', signal: ac.signal, dispatch });
  assert.equal(inner.aborted, true);
});

// ── 增量读 ──────────────────────────────────────────────────────────────────
test('readOutput 首批含头、后续只给增量（与 spawn 路同一游标语义）', async () => {
  let release;
  const dispatch = { run: () => new Promise((r) => { release = r; }) };
  const g = startGatewayRun({ prompt: 'p', cwd: 'D:/x', modelId: 'hy3-x', dispatch });
  const first = g.readOutput();
  assert.match(first, /transport=gateway/, '首批必须是头 —— 没有 argv 就靠它交代走了哪条路');
  assert.equal(g.readOutput(), '', '★ 首批已取走内容，第二批不得重复吐（否则 settle 时会读出双份）');
  release({ ok: true, reason: null, text: '答案', receipt: RECEIPT, phases: [], tools: { count: 0, names: [] }, models: [], usedModelId: null, sidecar: SID, error: null });
  await g.done;
  assert.match(g.readOutput(), /答案/);
});

// ── 倍率解析 ────────────────────────────────────────────────────────────────
test('multiplierOfSelected：命中实际模型；清单为空 ⇒ null（不是 0）', () => {
  assert.equal(multiplierOfSelected({ models: [{ modelId: 'a', _meta: { credits: 'x1.62' } }], usedModelId: 'a' }), 1.62);
  assert.equal(multiplierOfSelected({ models: [{ modelId: 'a', description: 'x0.00' }], usedModelId: 'a' }), 0, '回退字段 description 也要认');
  assert.equal(multiplierOfSelected({ models: [], usedModelId: 'a' }), null, '★ 未知必须 null —— 0 会被当成"免费"');
  assert.equal(multiplierOfSelected(undefined), null);
});

// ★★★ 2026-09-28 真机才暴露：上面那条测试喂的是**原始形状**（`_meta.credits`），
//   而真正的调用方 `dispatch.run()` 传进来的是 `receipt.extractSession()` 的**已归一**产物
//   `{modelId, name, credits}`。两种形状字段名不同，于是真机上这个函数**恒返回 null**，
//   倍率**静默不记**——而单测全绿，因为它验的是生产路径**根本不会产生**的输入。
//   这条用**归一后**的形状重钉一遍，把生产形状变成受测输入。
test('★★ multiplierOfSelected 必须认 extractSession 归一后的形状（真机上恒为 null 过）', () => {
  // 逐字照抄 2026-09-28 真机 `session/new` 回的那一份
  const normalized = [
    { modelId: 'fast-model', name: '快速', credits: 'x0.21' },
    { modelId: 'hy3', name: 'Hy3', credits: 'x0.00' },
    { modelId: 'kimi-k3-1', name: 'Kimi K3.1', credits: 'x1.62' },
  ];
  assert.equal(multiplierOfSelected({ models: normalized, usedModelId: 'hy3' }), 0,
    'hy3 真源是 x0.00：读不出来就退化成 null，看起来像"倍率未知"而不是"免费"');
  assert.equal(multiplierOfSelected({ models: normalized, usedModelId: 'kimi-k3-1' }), 1.62);
  assert.equal(multiplierOfSelected({ models: normalized, usedModelId: 'fast-model' }), 0.21);
  assert.equal(multiplierOfSelected({ models: normalized, usedModelId: 'absent' }), 0.21,
    '命中不了就取清单第一条（与既有行为一致）');
});

test('GATEWAY_REASON 的码都是插件既有枚举里的（不另造一套）', () => {
  for (const v of Object.values(GATEWAY_REASON)) {
    assert.ok(Object.values(REASON_CODES).includes(v), `${v} 不在 REASON_CODES 里`);
  }
});
