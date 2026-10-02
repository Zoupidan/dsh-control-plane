/**
 * 回执接线面：`dispatch.run()` 已经算好的字段，到 dsh 侧看得见为止。
 *
 * <p>★ 本文件测的是**接线**，不是判据的正确性 ★
 * `receipt.succeeded` 怎么判（`outcome` 优先、缺它才退回 `stopReason === 'end_turn'`）
 * 是 gateway 层的判据，那里有自己的测试文件。这里测的是：那些字段**被算出来之后，
 * 到底有没有到得了 dsh 侧**。这两件事容易混，混了就等于什么都没测。
 *
 * <p>★ 每条断言都配了反向对照 ★
 * 「断言能通过」本身不说明它能失败。本文件对每一条正面断言都问了一句
 * 「删掉接线之后它会不会露馅」，答不上来的那条不写进来。
 *
 * <p>★ 2026-10-01：本文件原先经由 `llm-adapter.js` 的 `stream()` 断言上述字段 ★
 * 那个适配器（一条挂在 `workbuddy` 路由上的反向代理）已删除。本文件改为直接断言
 * **存活的那一层**：`notes.js` 的 `receiptNote` / `permissionNote` / `failureDetailFor` /
 * `joinBody` / `lastPhaseOf`。断言的是同一批**事实**（字段有没有到得了正文），
 * 不是同一批函数名。随适配器一起消失、本层**无法**再断言的，逐条在各自用例里如实标注：
 * dsh `FinishReasonMap` 的 kind 映射（`finishReasonFor`）、`tool-call-delta` 不产出、
 * `reason.kind === 'stop'`、空 prompt 的 `workbuddy_empty_prompt` 码。
 *
 * @module test/subagent-receipt
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PERMISSION_NOTE_MARK,
  RECEIPT_NOTE_MARK,
  failureDetailFor,
  joinBody,
  lastPhaseOf,
  permissionNote,
  receiptNote,
} from '../src/host/subagent/notes.js';

/** 一轮跑通了的真机形状回执（字段取自 gateway/dispatch.js 的返回类型声明）。 */
function okReport(over = {}) {
  return {
    ok: true,
    reason: null,
    text: 'WorkBuddy 的回答',
    receipt: {
      stopReason: 'end_turn',
      finishReason: 'stop',
      outcome: 'SUCCESS',
      traceId: 'tr-1',
      requestId: 'rq-1',
      conversationRequestId: 'cr-1',
      userMessageId: 'um-1',
      timestamp: '2026-09-30T00:00:00Z',
      succeeded: true,
    },
    phases: ['idle', 'preparing', 'model_requesting', 'model_streaming', 'model_done'],
    tools: { count: 0, names: [] },
    models: [],
    modes: null,
    sessionId: 'acp-7',
    sessionOrigin: 'new',
    permission: { requested: 'bypassPermissions', confirmed: true },
    sidecar: { pid: 4242, url: 'http://127.0.0.1:9999' },
    error: null,
    ...over,
  };
}

/**
 * 走到调用方眼前的那段正文：结果 + 两行告示。
 * 这就是 `provider.js:322` 的组装方式（`joinBody(tone, permissionNote(...), receiptNote(...))`）——
 * 在这里复刻它，是为了让"字段到达调用方"这句话落在**同一条链**上，而不是另造一条。
 */
function bodyFor(report) {
  const text = typeof report?.text === 'string' ? report.text.trim() : '';
  return joinBody(text, permissionNote(report?.permission), receiptNote(report));
}

// ─────────────────────────────────────────────────────────────────────────────
// 成功路径：回执字段进正文 ⇒ 一路到 runOutcome 的 result 字符串
// ─────────────────────────────────────────────────────────────────────────────

test('★ 成功路径：`sessionId` / `sessionOrigin` / `phases` / `receipt` 全部到达调用方可见的正文', () => {
  const body = bodyFor(okReport());

  // ★ 反向对照（必须排在正面断言**之前**写）：删掉接线之后，这一行应当整行消失。
  //   所以"正文里有阶段轨迹"这句话，必须能被一个没有轨迹的 report 打脸。
  const bare = receiptNote({ ok: true, text: 'x' });
  assert.equal(bare, '', '没有 receipt 也没有 phases 时不得凭空造一行回执 —— 那会让读者以为看到了回执');

  assert.ok(body.includes(RECEIPT_NOTE_MARK), `正文必须带回执行尾注；实际正文=${JSON.stringify(body)}`);
  for (const expected of [
    'session=acp-7',              // 连续两轮是否落同一条会话，dsh 侧唯一的可查证据
    'origin=new',                 // 决定权限提升成不成立（set_mode 只在自建会话上真生效）
    'phases=idle>preparing>model_requesting>model_streaming>model_done',
    'stopReason=end_turn',
    'outcome=SUCCESS',
    'traceId=tr-1',
  ]) {
    assert.ok(body.includes(expected), `回执行尾注必须带出 ${expected}；实际=${body}`);
  }
  // ★ 凭什么断言"阶段轨迹到了调用方"：正文进 `assistant/message` → `finalAssistantOutput`
  //   → `runOutcome` 的 `{status:'completed', result}`（`dsh-subagent/lib/index.js:2694-2697`），
  //   而 `joinBody` 是这段链的**入口**：它把回执原样拼进正文。这里把入口本身也钉住，
  //   否则"正文里有回执"可能只是这条用例自己拼出来的。
  assert.equal(
    joinBody('WorkBuddy 的回答', receiptNote(okReport())),
    body,
    '正文必须是"结果 + 告示"两段（`joinBody`），不能是别的组装方式',
  );

  // ★ 别的系统的幂等键不许混进给主控模型看的正文。
  //   排障用不上，只会增加跨系统串号的机会（`notes.js:202-204` 的结论）。
  for (const forbidden of ['rq-1', 'cr-1', 'um-1']) {
    assert.ok(!body.includes(forbidden), `${forbidden} 是别的系统的键，不该出现在正文里；实际=${body}`);
  }
});

test('★ 空正文的既有行为不变：回执照样到达调用方（不是"没文本就什么都不给"）', () => {
  const body = bodyFor(okReport({ text: '' }));
  assert.ok(body.includes(RECEIPT_NOTE_MARK), '没有正文不等于没有回执 —— 阶段轨迹与来源仍然要能查到');
  assert.ok(body.includes('session=acp-7'));
  assert.equal(body.startsWith('\n'), false, '空正文不得在正文开头留下一个空行');

  // ★ 反向对照：连回执也没有 ⇒ 正文真的是空串（而不是一段空白）。
  assert.equal(bodyFor({ ok: true, text: '' }), '', '两样都没有时就该是空串，不许塞空白块');
});

// ─────────────────────────────────────────────────────────────────────────────
// 失败面：诊断（`failureDetailFor`）
// ─────────────────────────────────────────────────────────────────────────────

test('★ 失败路径：诊断逐字带出原因 + 错误消息 + 卡在哪一阶段，以及成败矛盾', () => {
  const report = {
    ok: false,
    reason: 'task_error',
    error: { message: 'boom' },
    phases: ['idle', 'preparing', 'prompting'],
    receipt: { stopReason: 'end_turn', outcome: 'FAILED_MODEL_REQUEST', succeeded: false },
  };
  const detail = failureDetailFor(report);
  assert.ok(detail.includes('task_error'), `失败码要能定位原因；实际=${detail}`);
  assert.ok(detail.includes('boom'), '错误消息要逐字带出');
  assert.ok(detail.includes('last phase reached: prompting'), '★ 必须说清卡在哪一级 —— `phases` 是这件事的唯一数据来源');
  assert.ok(detail.includes('stopReason=end_turn'), '★ 真机见过 stopReason=end_turn 同时 outcome=FAILED_MODEL_REQUEST，矛盾必须逐字可见');
  assert.ok(detail.includes('outcome=FAILED_MODEL_REQUEST'));
  assert.ok(detail.includes('succeeded=false'));

  // ★ 反向对照：空轨迹必须说"空"，不能默默省略 —— 省掉之后
  //   "从没走到任何阶段"与"走到了某一级但那级没上报"读起来一模一样，而处置完全不同。
  const noPhase = failureDetailFor({ ...report, phases: [] });
  assert.equal(noPhase.includes('last phase reached'), false, '没有轨迹就不许报"最后到达"');
  assert.ok(noPhase.includes('no phase was ever reached'), '必须明说"一级都没到"');

  // ★ 反向对照：没有 ACP receipt 时不许编 stopReason / outcome。
  //   自动化传输面就是这样（`execute.js` 的 `reportFromAutomation` 一律 `receipt: null`）。
  const noReceipt = failureDetailFor({ ...report, receipt: null });
  assert.equal(noReceipt.includes('stopReason='), false, '没有 receipt 就不得编 stopReason');
  assert.equal(noReceipt.includes('outcome='), false, '没有 receipt 就不得编 outcome');

  // 字段缺失时给的是**占位符**，而不是空白 —— 否则"没上报"会被读成"没失败"。
  assert.equal(failureDetailFor(null), 'WorkBuddy run failed (unknown): no detail · no phase was ever reached');
});

test('★ 取消与故障在正文里读得出差别（旧的 `kind` 映射已随适配器删除）', () => {
  // 远端自己报的 aborted（本地并没有取消）也会走到这条失败路 ——
  // 见 `dsh-subagent/lib/index.js:2686-2687`：provider 诊断出来的远端 abort 判 failed。
  const abort = failureDetailFor({ ok: false, reason: 'aborted', error: { message: 'stopped by the caller' }, phases: [] });
  const boom = failureDetailFor({ ok: false, reason: 'task_error', error: { message: 'boom' }, phases: [] });
  assert.notEqual(abort, boom, '★ 用户点一次"停止"看到的东西，不能和"它坏了"一模一样');
  assert.ok(abort.includes('(aborted)'), `原因必须逐字可见；实际=${abort}`);
  assert.ok(boom.includes('(task_error)'));
  assert.equal(boom.includes('(aborted)'), false);

  // ★ 如实标注的**削弱**：旧适配器用 `finishReasonFor()` 把 `aborted` 映射成 dsh 的
  //   `{kind:'aborted'}`，于是 `runOutcome` 判 `killed`；`task_error` 判 `failed`。
  //   那条映射随 `llm-adapter.js` 一起删除，本层已无 `kind` 可断言。
  //   存活下来的分野在 `provider.js:304-311`：**取消不带 `diagnostic`、故障带**，
  //   `runOutcome`（`dsh-subagent/lib/index.js:2698-2707`）据此仍然分得出 killed / failed ——
  //   那两条断言归 `subagent-execute.test.js`（provider 层，本文件只拿到 report，碰不到输出帧）。
});

// ─────────────────────────────────────────────────────────────────────────────
// 词表与契约纪律：只发契约里逐字存在的取值 / 只发白名单里的键
// ─────────────────────────────────────────────────────────────────────────────

test('★ 词表对齐：`origin` / `continuity` 只发契约里逐字存在的取值，认不出的一律不回显', () => {
  // origin：只有 new / loaded 两种（dispatch.js:573-576 的真机结论）。
  assert.ok(receiptNote(okReport({ sessionOrigin: 'new' })).includes('origin=new'));
  assert.ok(receiptNote(okReport({ sessionOrigin: 'loaded' })).includes('origin=loaded'));
  const unknownOrigin = receiptNote(okReport({ sessionOrigin: 'resumed' }));
  assert.equal(unknownOrigin.includes('origin='), false, '★ 认不出的来源不得回显 —— 回显等于把没验证过的值当成事实');
  assert.notEqual(unknownOrigin, '', '★ 自证：这条用例不是靠"整行都空"才通过的');

  // continuity：三种，各自带自己的解释，不许一律叫"新对话"。**整句逐字比对** ——
  // 这是用户唯一能分辨"真续接 / 假续接（重放历史）/ 每轮新开"的地方，措辞本身就是契约。
  for (const [token, sentence] of [
    ['same-conversation', 'same-conversation (this round was appended to the SAME WorkBuddy conversation — the model carries its own context)'],
    ['new-conversation-with-replayed-history', 'new-conversation-with-replayed-history (the gateway could not continue the previous conversation, so a new one was opened and the earlier rounds were replayed into the prompt verbatim — this is NOT a true continuation)'],
    ['fresh-conversation-per-round', 'fresh-conversation-per-round (no session key, so this delegation cannot be attributed to a task and every round opens a new conversation)'],
  ]) {
    const line = receiptNote(okReport({ continuity: token }));
    assert.ok(line.includes(`continuity=${sentence}`), `${token} 必须逐字出现（含人话解释）；实际=${line}`);
  }
  const unknownCont = receiptNote(okReport({ continuity: 'whatever' }));
  assert.equal(unknownCont.includes('whatever'), false, '★ 认不出的连续性取值不许原样抄进正文');
  assert.notEqual(unknownCont, '', '★ 自证：不是靠空串通过的');
});

test('★ 契约纪律：任何回执形状下只发白名单里的键，别的字段一个都不外泄', () => {
  const BIT_KEYS = [
    'session=', 'origin=', 'continuity=', 'session-memory=',
    'model-used=', 'model-chosen-by=', 'model-requested=',
    'phases=', 'stopReason=', 'outcome=', 'traceId=',
  ];
  const reports = [
    okReport(),
    okReport({ sessionOrigin: 'loaded' }),
    okReport({ continuity: 'same-conversation' }),
    okReport({ sessionMemory: 'mem-1' }),
    okReport({ usedModelId: 'fast-model' }),
    { ...okReport(), requestedModelId: '' },
    { ...okReport(), requestedModelId: 'deepseek-v4.1-flash' },
    { ok: false, reason: 'task_error', error: { message: 'boom' }, phases: ['prompting'], receipt: null },
  ];

  for (const report of reports) {
    const line = receiptNote(report);
    assert.equal(typeof line, 'string');
    assert.ok(line.startsWith(RECEIPT_NOTE_MARK), `回执必须以行首标记开头；实际=${line}`);
    const bits = line
      .slice(RECEIPT_NOTE_MARK.length)
      .split(' · ')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    assert.ok(bits.length > 0, `★ 这一圈的每条都必须真有内容，否则下面的检查全被跳过；实际=${line}`);
    for (const bit of bits) {
      assert.ok(BIT_KEYS.some((k) => bit.startsWith(k)), `回执里出现了白名单之外的字段：${bit}（整行=${line}）`);
    }
    // 别的系统的键、以及只在内部字段里的机器细节，都不得进正文。
    for (const forbidden of ['rq-1', 'cr-1', 'um-1', '4242', '127.0.0.1', 'Bash', 'sidecar']) {
      assert.equal(line.includes(forbidden), false, `${forbidden} 不该出现在给主控模型看的正文里；实际=${line}`);
    }
  }

  // ★ 自证：白名单确实能拒掉东西（否则上面那一圈等于没检）。
  assert.equal(BIT_KEYS.some((k) => 'model_requested=x'.startsWith(k)), false, '白名单必须能拒掉写法不同的键');

  // ★ 唯一的空回执形状：取消、且没有任何轨迹可报 ⇒ 空串，而不是一行空话。
  assert.equal(
    receiptNote({ ok: false, reason: 'aborted', error: { message: 'stop' }, phases: [], receipt: null }),
    '',
    '取消轮没有回执可报时就该是空串',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 会话亲和：连续两轮落同一条会话，dsh 侧唯一的可查证据
// ─────────────────────────────────────────────────────────────────────────────

test('★ 同一个 dsh 子会话连续两轮 ⇒ 正文里的 `session=` 可逐字比对', () => {
  const sessionOf = (report) => {
    const hit = /session=(\S+)/.exec(receiptNote(report));
    assert.ok(hit !== null, `回执里必须能取到 session=；实际=${JSON.stringify(receiptNote(report))}`);
    return hit[1];
  };

  // ★ 反向对照：换一个 sessionId 就必须读到另一个值（否则"两轮同会话"永远成立）。
  assert.equal(sessionOf(okReport({ sessionId: 'acp-8' })), 'acp-8');
  assert.equal(sessionOf(okReport()), 'acp-7');
  assert.equal(sessionOf(okReport({ text: '第二问的答案' })), 'acp-7');

  // 没有 sessionId ⇒ 不得凭空造一个（那会让"落同一条会话"变成无法证伪的说法）。
  assert.equal(/session=/.test(receiptNote({ ...okReport(), sessionId: null })), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 闸门：什么时候**不**写这一行
// ─────────────────────────────────────────────────────────────────────────────

test('★ 闸门诚实：没有可报的事实就给空串；自动化路靠 `phases` 过闸，且绝不编 `stopReason`', () => {
  assert.equal(receiptNote({ ok: true, text: 'x' }), '', '没有 receipt/phases/模型事实 ⇒ 不得造一行回执');
  assert.equal(receiptNote(null), '');
  assert.equal(receiptNote(undefined), '');
  // 空数组不算轨迹 —— 否则"阶段表空"会被写成一行看起来像回执的东西。
  assert.equal(receiptNote({ phases: [] }), '');

  // ★ 自动化传输面没有 ACP `receipt`（`execute.js` 一律 `receipt: null`，不编），
  //   `phases` 是它过这道闸的**唯一**入口：点火那一趟必然走
  //   `db-open → awaiting-scheduler-tick → running`。
  const auto = receiptNote({
    receipt: null,
    sessionId: 'conv-1',
    continuity: 'fresh-conversation-per-round',
    phases: ['db-open', 'awaiting-scheduler-tick', 'running'],
  });
  assert.ok(auto.includes('session=conv-1'));
  assert.ok(auto.includes('continuity=fresh-conversation-per-round'));
  assert.ok(auto.includes('phases=db-open>awaiting-scheduler-tick>running'));
  assert.equal(auto.includes('stopReason='), false, '★ 没有 ACP receipt 就**不**编 stopReason —— 编了等于伪造证据');
  assert.equal(auto.includes('outcome='), false, '★ 同上：outcome 也不许编');
  assert.notEqual(auto, '', '★ 自证：闸门不是恒空');
});

test('★ 记不住对话 id 时必须说出来（不许静默开新对话）', () => {
  const line = receiptNote(okReport({ sessionMemory: 'conv-9' }));
  assert.ok(line.includes('session-memory=conv-9'), `必须上报记不住这件事；实际=${line}`);
  assert.ok(line.includes('could NOT be remembered'), '必须说清后果：下一轮会开新对话');

  // ★ 反向对照：没发生这件事就不许出现这一段（否则这句告示会变成常驻噪声）。
  assert.equal(receiptNote(okReport()).includes('session-memory='), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 模型：谁选的，必须读得出差别
// ─────────────────────────────────────────────────────────────────────────────

test('★★★ 模型：只在报告自带模型事实时才写这一段，"没人选"与"请求了 X"必须读得出差别', () => {
  // ★ 网关那一路（dispatch 自己管模型，本插件没参与决策）⇒ 报告里没有这个键 ⇒ 一个字都不许写。
  //   否则那句"没人选"是假的，而且会天天挂在每一轮正文上。
  const gateway = receiptNote(okReport());
  assert.equal(gateway.includes('model-used='), false, '本插件没参与决策的路不许贴模型标签');
  assert.equal(gateway.includes('model-chosen-by='), false);
  assert.equal(gateway.includes('model-requested='), false);

  // ★ 自动化那一路：没人配模型 ⇒ 写清"我没选"，并指出该去哪里设。
  const nobody = receiptNote({ ...okReport(), requestedModelId: '', usedModelId: 'fast-model' });
  assert.ok(nobody.includes('model-used=fast-model'), '实际跑了哪个模型必须在场');
  assert.ok(nobody.includes('model-chosen-by=NOBODY'), '★ 没人选就必须明说"没人选"');
  assert.ok(nobody.includes('has no model configured'), '★ 必须说清根因：本插件没配模型');
  assert.ok(nobody.includes('set the model field in the WorkBuddy settings card'), '★ 必须指出用户到底该去哪里设模型');
  assert.equal(nobody.includes('model-requested='), false, '没请求过就不能出现"请求了"');

  // ★ 配了模型 ⇒ 报请求值，且**不再**声称没人选。
  const asked = receiptNote({ ...okReport(), requestedModelId: 'deepseek-v4.1-flash', usedModelId: 'deepseek-v4.1-flash' });
  assert.ok(asked.includes('model-requested=deepseek-v4.1-flash'));
  assert.equal(asked.includes('model-chosen-by=NOBODY'), false, '★ 配了模型还说"没人选"就是谎报');
  assert.notEqual(nobody, asked, '两种模型事实必须读得出差别');

  // 这一段确实进得了调用方可见的正文。
  assert.ok(bodyFor({ ...okReport(), requestedModelId: '', usedModelId: 'fast-model' }).includes('model-chosen-by=NOBODY'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 权限告示：没兑现才出声
// ─────────────────────────────────────────────────────────────────────────────

test('★ 权限告示：确认生效就一个字都不说，没确认才出声并给出读到的实际值', () => {
  assert.equal(permissionNote({ requested: 'bypassPermissions', confirmed: true }), '', '确认生效 ⇒ 不许加噪声');
  assert.equal(permissionNote({ requested: '', confirmed: false }), '', '没请求过就没有"没兑现"可谈');
  assert.equal(permissionNote(null), '');
  assert.equal(permissionNote({ confirmed: false }), '', '连请求值都没有时同样没有告示可说');

  const unconfirmed = permissionNote({ requested: 'fullAccess', effective: 'bypassPermissions', confirmed: false });
  assert.ok(unconfirmed.startsWith(PERMISSION_NOTE_MARK), `告示必须带行首标记；实际=${unconfirmed}`);
  assert.ok(unconfirmed.includes('"fullAccess"'), '要说清**请求的是哪一档**');
  assert.ok(unconfirmed.includes('"bypassPermissions"'), '也要说清**实际读到的是哪一档**');
  assert.ok(unconfirmed.includes('NOT confirmed to be in effect'), '★ 措辞是"没被确认"，不是"没生效" —— 两种场合含义不同');
  assert.notEqual(unconfirmed, '', '★ 自证：告示不是恒空');

  // 读不到实际值 ⇒ 如实写 (unknown)，不许编一个看起来成功的值。
  const unknown = permissionNote({ requested: 'fullAccess', confirmed: false });
  assert.ok(unknown.includes('"(unknown)"'), `读不到实际值时必须如实写 unknown；实际=${unknown}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 组装与阶段：两个纯函数
// ─────────────────────────────────────────────────────────────────────────────

test('`joinBody`：空的那些段不留下多余空行', () => {
  assert.equal(joinBody('正文'), '正文');
  assert.equal(joinBody('正文', '', null, undefined), '正文', '空/非字符串的段要被丢掉，而不是变成空行');
  assert.equal(joinBody('', '告示'), '告示', '没正文时告示仍然要能单独交付');
  assert.equal(joinBody('', ''), '', '两段都空 ⇒ 空串，不许塞一个空白块');
  assert.equal(joinBody('正文', '甲', '乙'), '正文\n\n甲\n\n乙');
});

test('`lastPhaseOf`：空/非数组/尾部有空项都要给出诚实答案', () => {
  assert.equal(lastPhaseOf(['idle', 'preparing', 'model_done']), 'model_done');
  assert.equal(lastPhaseOf([]), '', '空轨迹不得凭空返回 idle —— 那会造一级从未发生过的阶段');
  assert.equal(lastPhaseOf(null), '');
  assert.equal(lastPhaseOf(['idle', '']), 'idle', '尾部空项要被跳过，而不是当成答案');
});
