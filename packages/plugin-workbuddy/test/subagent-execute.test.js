/**
 * 子智能体面的执行口回归（★ 2026-10-01 建，2026-10-02 切回计划任务主路）。
 *
 * <p>★ 当前只走 `automation`：往计划任务表写一行 `once`（`startAutomationRun` 唯一写入点），
 *   等桌面端调度器建会话。`gateway`（本机 ACP）已下线，不再走 `dispatch.run`。
 *   每轮都是新对话（该表无对话列），多轮靠 `transcript` 重放前情，
 *   回执如实标 `continuity='fresh-conversation-per-round'`。
 *
 * <p>★ 判据的自我校验（防止"检测器测不出已知故障"）★
 * 每条负向断言都配一条**已知应当通过**的正向对照：
 *   - 点火分支真被选中（对照：空 prompt 时不点火）；
 *   - 失败轮不伪装成成功（对照：成功轮确有正文）；
 *   - 没有 `receipt` 就不编（对照：真有 receipt 的照常带出来）。
 *
 * <p>本文件**不**碰真实数据库：点火一律用注入的假函数，真机那一趟由
 * `test/automation-early-retire.test.js` 覆盖（临时夹具库，真库零写入）。
 *
 * @module test/subagent-execute.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import {
  automationModelId,
  createTaskExecutor,
  reportFromAutomation,
  resolveTransport,
} from '../src/host/subagent/execute.js';
// ★ 2026-10：本插件注册过的那个 LLM 适配器（`llm-adapter.js`）已删除 —— 它把
//   `workbuddy` 这条**反向代理**路径塞回了 dsh 的模型路由里，与本 provider 的
//   "进程外委派"语义冲突。留下来的具名助手（回执尾注、权限告示、失败诊断）原样搬进了
//   `notes.js`；正文的组装者是 `provider.js`。本文件改为在**存活的那两个面**上断言。
import { PERMISSION_NOTE_MARK, receiptNote } from '../src/host/subagent/notes.js';
import { createWorkBuddyProvider } from '../src/host/subagent/provider.js';
import { REASON_CODES } from '../src/host/launch/reason-codes.js';

const okAutomation = {
  status: 'completed',
  automation: {
    reason: null,
    automationId: 'automation-1',
    conversationId: 'conv-1',
    transcriptPath: '/t/conv-1.jsonl',
    reply: 'IGNITION-OK',
    creditsUsed: 0.06,
    model: 'deepseek-v4.1-flash',
    permission: 'fullAccess',
    usedModelId: 'deepseek-v4.1-flash',
    sessionCwd: 'D:/repo/tmp/wb',
    tokensUsed: 38059,
    phases: ['db-open', 'awaiting-scheduler-tick', 'running'],
  },
};

test('传输面归一：只剩 automation，认不出的值也不换路', () => {
  // ★ gateway / spawn 已删（前者本机 ACP 下线，后者无登录态必然 auth_failed）。
  //   只剩一个值时直接钉死，不再按名分流。
  assert.equal(resolveTransport('spawn'), 'automation');
  assert.equal(resolveTransport('gateway'), 'automation');
  assert.equal(resolveTransport('automation'), 'automation');
  // 写错一个字母也不换实现（单值钉死后这条恒真，留作回归）。
  for (const typo of ['Gateway', 'GATEWAY', ' acp', '', undefined, null, 42]) {
    assert.equal(resolveTransport(typo), 'automation', `${JSON.stringify(typo)} 必须落 automation`);
  }
});

test('`auto` 折成"让桌面端自己挑"，不把一个不存在的模型 id 写库', () => {
  // `auto` 是**调用侧语义**；`automations.model_id` 要真实模型 id。
  assert.equal(automationModelId('auto'), null);
  assert.equal(automationModelId(''), null);
  assert.equal(automationModelId('   '), null);
  assert.equal(automationModelId(undefined), null);
  // 反向对照：真模型 id 原样透传，证明上面的断言不是"恒等于 null"。
  assert.equal(automationModelId('deepseek-v4.1-flash'), 'deepseek-v4.1-flash');
});

test('折算出的回执形状与 dispatch 逐字同构，且**不编** ACP receipt', () => {
  const r = reportFromAutomation(okAutomation);
  assert.equal(r.ok, true);
  assert.equal(r.text, 'IGNITION-OK', '回复正文就是子智能体该交回的东西');
  assert.equal(r.reason, REASON_CODES.OK);
  assert.deepEqual(r.phases, ['db-open', 'awaiting-scheduler-tick', 'running'], '阶段轨迹是"卡在哪一步"的唯一来源');
  // ★ 自动化那一趟根本没有 ACP 的消息链。编一个 `end_turn` 进去 = 凭空造证据。
  assert.equal(r.receipt, null, '没有 ACP 回执就不许造一个');
  assert.equal(r.sessionId, 'conv-1', '桌面端建的会话 id 是"对话真的存在"的硬证据');
  assert.equal(r.sessionOrigin, 'new');
  assert.equal(r.continuity, 'fresh-conversation-per-round');
  assert.deepEqual(r.usage, { used: 38059, credits: 0.06 }, '真机读数：一次点火 38059 tokens / 0.06 积分');
  // 反向对照：读不到 token 数时如实落 null，而不是编一个 0（"用了 0"是另一个意思）。
  assert.equal(reportFromAutomation({ status: 'completed', automation: { conversationId: 'c', phases: [] } }).usage, null);
});

test('失败轮：ok=false 且带原因，绝不像一段"看起来成功"的文本', () => {
  const r = reportFromAutomation({
    status: 'failed',
    detail: 'task_error: the automation row was written but no run appeared',
    automation: { reason: REASON_CODES.TASK_ERROR, automationId: 'automation-2', conversationId: null, phases: ['db-open'] },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, REASON_CODES.TASK_ERROR);
  assert.match(r.error.message, /no run appeared/, '失败面必须说清卡在哪，否则用户只能重发同样的任务');
  assert.equal(r.sessionId, null, '没有会话 id 就如实落 null，不编一个');
});

test('权限是否兑现由两边真值逐字比，不在这一侧自称', () => {
  const honored = reportFromAutomation(okAutomation);
  honored.permission = { requested: 'fullAccess', effective: 'fullAccess', confirmed: true };
  assert.equal(honored.permission.confirmed, true);

  const ignored = reportFromAutomation(okAutomation);
  ignored.permission = { requested: 'bypassPermissions', effective: 'default', confirmed: false };
  assert.equal(ignored.permission.confirmed, false, '请求的档与实际记着的档不一致 ⇒ 未兑现');
});

test('★ 施工单 2026-10-10 #2：请求 fullAccess ⇒ 会话读回 fullAccess（真源形状 = startAutomationRun 终态回执）', () => {
  // ★ 形状取自 gateway/automation.js 终态组装点（成功分支 return 的 automation.permission
  //   是**对象** `{requested, effective, confirmed}`，另有 `requestedPermissionMode` /
  //   `effectivePermissionMode` 两个纯字符串键）。旧代码把 `au.permission` 当字符串读 ⇒
  //   恒不命中 ⇒ 读回值被吞成 '(unknown)'，每轮回执都报 "NOT confirmed (unknown)"。
  //   本用例按**真实对象形状**钉死：读回必须透传，绝不退回 '(unknown)'。
  const terminalShape = {
    status: 'completed',
    automation: {
      reason: null,
      automationId: 'automation-9',
      conversationId: 'conv-9',
      sessionId: 'conv-9',
      sessionKey: 'k',
      sessionPersist: { ok: true },
      retired: true,
      transcriptPath: null,
      reply: 'PERM-READBACK-OK',
      artifacts: [],
      creditsUsed: null,
      model: 'glm-5.3-flash',
      usedModelId: 'glm-5.3-flash',
      // ★ 真源形状：对象 + 两个字符串键（automation.js:1507-1528 逐字段同形）。
      permission: {
        requested: 'fullAccess',
        effective: 'fullAccess',
        confirmed: true,
        toString() { return 'fullAccess'; },
        valueOf() { return 'fullAccess'; },
        [Symbol.toPrimitive](hint) { return hint === 'string' ? 'fullAccess' : true; },
      },
      requestedPermissionMode: 'fullAccess',
      effectivePermissionMode: 'fullAccess',
      sessionCwd: null,
      requestedEffort: null,
      effectiveEffort: null,
      effort: {
        requested: null,
        effective: null,
        confirmed: false,
        toString() { return ''; },
        valueOf() { return ''; },
        [Symbol.toPrimitive](hint) { return hint === 'string' ? '' : false; },
      },
      title: null,
      createdAt: null,
      tokensUsed: null,
      phases: ['db-open', 'awaiting-scheduler-tick', 'running'],
    },
  };
  const r = reportFromAutomation(terminalShape);
  assert.equal(r.permission.requested, 'fullAccess');
  assert.equal(r.permission.effective, 'fullAccess', '会话读回的档必须透传，不得被形状失配吞成 (unknown)');
  assert.equal(r.permission.confirmed, true, '请求 fullAccess 且会话读回 fullAccess ⇒ 已兑现');
  // 反向对照：请求与读回不一致 ⇒ 如实 confirmed:false（带真实读回值，而不是 (unknown)）。
  const mismatched = reportFromAutomation({
    ...terminalShape,
    automation: {
      ...terminalShape.automation,
      permission: { ...terminalShape.automation.permission, requested: 'bypassPermissions', effective: 'fullAccess', confirmed: false },
      requestedPermissionMode: 'bypassPermissions',
    },
  });
  assert.equal(mismatched.permission.requested, 'bypassPermissions');
  assert.equal(mismatched.permission.effective, 'fullAccess');
  assert.equal(mismatched.permission.confirmed, false);
  // 旧字符串形状（early-fail 分支 / 旧测试同款）保持兼容。
  const legacy = reportFromAutomation({
    status: 'completed',
    automation: { ...okAutomation.automation, permission: 'fullAccess' },
  });
  assert.equal(legacy.permission.effective, 'fullAccess');
  // 真的读不到 ⇒ 仍是 '(unknown)'（不编造），但这是唯一的 '(unknown)' 路径。
  const unknown = reportFromAutomation({
    status: 'completed',
    automation: { conversationId: 'c', phases: [], requestedPermissionMode: 'fullAccess' },
  });
  assert.equal(unknown.permission.effective, '(unknown)');
  assert.equal(unknown.permission.confirmed, false);
});

test('★ 只走 automation：点火键名逐字对上，且 sessionKey/sessionStore 透给点火（adopt 记账用）', async () => {
  const seen = [];
  const fakeAutomation = (req) => {
    seen.push(req);
    return {
      cancel: () => {},
      done: Promise.resolve({
        status: 'completed', detail: 'ok', exitCode: 0,
        automation: {
          reason: null, automationId: 'automation-1', conversationId: 'conv-1',
          sessionId: 'conv-1', sessionKey: req.sessionKey ?? null, sessionPersist: { ok: true },
          retired: true, transcriptPath: null, reply: 'via-automation',
          creditsUsed: null, model: 'deepseek-v4.1-flash', permission: 'fullAccess',
          usedModelId: 'deepseek-v4.1-flash', sessionCwd: req.cwd ?? null,
          tokensUsed: null, phases: ['db-open', 'running'],
        },
      }),
      readOutput: () => 'via-automation',
    };
  };

  // 对照①：显式 automation ⇒ 真的落到点火（证明执行口不是"永远空转"）。
  const viaAuto = await createTaskExecutor({ automation: fakeAutomation })({
    prompt: 'go', cwd: 'D:/repo', model: 'deepseek-v4.1-flash', permissionMode: 'fullAccess', sessionKey: 'subagent:S1',
  });
  assert.equal(viaAuto.text, 'via-automation');
  assert.equal(viaAuto.transport, 'automation');
  assert.equal(seen.length, 1);
  // ★ 点火收 `modelId`，调用方手里是 `model`。对不上 = 模型被静默丢掉。
  assert.equal(seen[0].modelId, 'deepseek-v4.1-flash', '键名对不上 ⇒ 请求的模型被点火忽略，用户以为设了其实没设');
  assert.equal(seen[0].model, undefined, '不许把 `model` 一起塞过去（那是个点火不认的键）');
  assert.equal(seen[0].cwd, 'D:/repo');
  assert.equal(seen[0].permissionMode, 'fullAccess');
  assert.equal(seen[0].sessionKey, 'subagent:S1', '★ taskKey 必须逐字递成 sessionKey（它是 adopt 记账的键）');
  // 反向对照：`auto` 同样折成"不指定"，而不是塞一个不存在的模型 id 写库。
  await createTaskExecutor({ automation: fakeAutomation })({ prompt: 'go', model: 'auto' });
  assert.equal(seen[1].modelId, null, '`auto` = 由桌面端自己选，不是"把 auto 这个字符串写库"');

  // 对照②：默认（transport 未设）⇒ automation（单值钉死）。
  assert.equal(resolveTransport(undefined), 'automation');
});

test('空 prompt ⇒ 如实报任务失败，不点火、不静默成功', async () => {
  let fireCount = 0;
  const fakeAutomation = () => { fireCount += 1; throw new Error('must not ignite on empty prompt'); };
  const r = await createTaskExecutor({ automation: fakeAutomation })({ prompt: '   ' });
  assert.equal(r.ok, false);
  assert.equal(r.transport, 'automation');
  assert.equal(r.reason, REASON_CODES.TASK_ERROR);
  assert.equal(r.text, '', '"没跑起来"和"跑起来但没话说"在上层是两种故障，不能混成后者');
  assert.equal(fireCount, 0, '★ 空 prompt 不许点火');
});

test('★ 会话不连续这件事必须印进正文，不能藏在内部字段里', () => {
  const note = receiptNote(reportFromAutomation(okAutomation));
  assert.match(note, /session=conv-1/);
  assert.match(note, /origin=new/);
  assert.match(
    note,
    /continuity=fresh-conversation-per-round/,
    '读者看到两个不同的 session= 却没被告知不续接，那就是自己骗自己',
  );
  // 反向对照：真有 ACP receipt 的形状照旧只带它自己的那几项（既有行为不被改动）。
  const gw = receiptNote({ ok: true, sessionId: 'acp-1', sessionOrigin: 'new', phases: ['ready'], receipt: { stopReason: 'end_turn', outcome: 'COMPLETED', succeeded: true } });
  assert.doesNotMatch(gw, /continuity=/, '没有这条事实时不许凭空写出来');
});

test('★★★ 没人指定模型 ⇒ 绝不静默变成桌面端默认档（2026-10-01 12:48 实踩）', () => {
  // 负控前提：真机上就是它 —— 会话上 model 记成 null，界面显示"快速"。
  const nobody = reportFromAutomation({
    status: 'completed',
    automation: {
      conversationId: 'c1',
      reply: 'ok',
      model: null, // ← 桌面端自己的默认档（fast-model/快速）不会写在会话上
      usedModelId: null,
      requestedModelId: '',
      phases: ['db-open', 'running'],
    },
  });
  assert.equal(nobody.requestedModelId, '', '没人选 ⇒ 请求值必须是空串，而不是替它填一个');
  const note = receiptNote(nobody);
  assert.match(note, /model-chosen-by=NOBODY/, '"我没设"绝不能被读成"我设成快速"');
  // ★ 措辞于 2026-10 改过：模型是**插件级设置**，不是每次下发时的一个参数。
  //   所以这里钉的是"用户该去哪儿设"，而不是旧措辞里的"下发时传 model=" ——
  //   钉旧措辞会让这条断言在人话改好的那天反而变红，那是把测试当成了措辞的复印件。
  assert.match(note, /has no model configured/, '必须说清"没人选"的根因是本插件没配模型');
  assert.match(note, /set the model field in the WorkBuddy settings card/, '必须指出用户到底该去哪里设模型');
  assert.doesNotMatch(note, /model-used=/, '会话上没有记录模型时，不能编一个"实际用了 X"');

  // 正控：指定了 ⇒ 请求值与实际值**并排**在场，缺一不可（否则"设了模型"又是没人反驳的假话）。
  const chosen = reportFromAutomation({
    status: 'completed',
    automation: {
      conversationId: 'c2',
      reply: 'ok',
      model: 'deepseek-v4.1-flash',
      usedModelId: 'deepseek-v4.1-flash',
      requestedModelId: 'deepseek-v4.1-flash',
      phases: ['db-open', 'running'],
    },
  });
  const chosenNote = receiptNote(chosen);
  assert.match(chosenNote, /model-requested=deepseek-v4\.1-flash/);
  assert.match(chosenNote, /model-used=deepseek-v4\.1-flash/);
  assert.doesNotMatch(chosenNote, /NOBODY/);

  // ★ 负控：请求与实际**不一致**时两行都要在（不一致本身就是最该被看见的东西）。
  const mismatched = reportFromAutomation({
    status: 'completed',
    automation: {
      conversationId: 'c3', reply: 'ok',
      model: 'fast-model', usedModelId: 'fast-model',
      requestedModelId: 'glm-5.3', phases: ['running'],
    },
  });
  const mm = receiptNote(mismatched);
  assert.match(mm, /model-requested=glm-5\.3/);
  assert.match(mm, /model-used=fast-model/);

  // ★ 网关那一路**不许**被贴上"没人选"的标签：那边模型是 dispatch 自己管的，
  //   本插件没参与决策，说那句话是假的。
  assert.doesNotMatch(receiptNote({ ok: true, phases: ['ready'], receipt: { stopReason: 'end_turn', outcome: 'COMPLETED', succeeded: true } }), /model-chosen-by/);
});

test('★★★ 每轮都是新对话：同一个 taskKey 连发两轮 ⇒ 两次点火、前情重放进第二轮 prompt，且 sessionStore 透给点火', async () => {
  // ★★ 计划任务主路（2026-10-02 起唯一主路）★★
  // `automations` 表没有对话列 ⇒ 调度器只按行新建，"复用同一条对话"物理上不可能。
  // 同一个任务的多轮靠 `transcript` 重放前情，并在回执里如实标
  // `continuity='fresh-conversation-per-round'`。点火只 INSERT 一行 once，
  // 轮询只 SELECT，拿到 sessions.id 立刻 retire + adopt（见 automation-early-retire.test.js）。
  //
  // 本文件的判据是**可观察的契约**，而不是内部实现：
  //   ① 两轮都走点火（automation），② 两轮带同一个 sessionKey + sessionStore，
  //   ③ 第二轮 prompt 里带第一轮的前情，④ 两轮回执都是新会话（continuity 恒 fresh）。
  const seen = [];
  const fakeAutomation = (req) => {
    seen.push(req);
    const n = seen.length;
    return {
      cancel: () => {},
      done: Promise.resolve({
        status: 'completed', detail: `REPLY-${n}`, exitCode: 0,
        automation: {
          reason: null, automationId: `automation-${n}`, conversationId: `conv-${n}`,
          sessionId: `conv-${n}`, sessionKey: req.sessionKey ?? null, sessionPersist: { ok: true },
          retired: true, transcriptPath: null, reply: `REPLY-${n}`,
          creditsUsed: null, model: 'deepseek-v4-pro', permission: 'fullAccess',
          usedModelId: 'deepseek-v4-pro', sessionCwd: req.cwd ?? null,
          tokensUsed: null, phases: ['db-open', 'running'],
        },
      }),
      readOutput: () => `REPLY-${n}`,
    };
  };
  const adopted = [];
  const sessions = { lookup: () => null, adopt: (k, r) => { adopted.push({ k, r }); return { ok: true }; } };
  const exec = createTaskExecutor({ automation: fakeAutomation, sessions });

  const first = await exec({ prompt: '第一轮：看看这个仓库', sessionKey: 'subagent:S1', model: 'deepseek-v4-pro' });
  assert.equal(first.ok, true);
  assert.equal(first.transport, 'automation');
  assert.equal(seen.length, 1, '第一轮走点火');
  assert.equal(seen[0].sessionKey, 'subagent:S1', '★ taskKey 必须逐字递成 sessionKey（它是 adopt 记账的键）');
  assert.ok(seen[0].sessionStore !== undefined, '★ sessionStore 必须透给点火（否则 adopt 永不发生）');
  assert.equal(first.continuity, 'fresh-conversation-per-round');
  assert.equal(first.sessionOrigin, 'new');

  const second = await exec({ prompt: '第二轮：接着刚才那个文件改', sessionKey: 'subagent:S1', model: 'deepseek-v4-pro' });
  assert.equal(second.ok, true);
  assert.equal(seen.length, 2, '第二轮也走点火（每轮都是新对话）');
  assert.equal(seen[1].sessionKey, 'subagent:S1', '★★ 两轮必须是同一个 sessionKey（归组键）');
  assert.match(seen[1].prompt, /第一轮：看看这个仓库/, '★★ 第二轮 prompt 必须带上第一轮前情（重放，不是续接）');
  assert.match(seen[1].prompt, /REPLY-1/, '★★ 第一轮的回复也必须带过去');
  assert.equal(second.continuity, 'fresh-conversation-per-round', '★★ 每轮都是新对话，必须如实标 fresh');
  assert.notEqual(second.sessionId, first.sessionId, '★★ 两轮是两条新对话，sessionId 必须不同（不是同一条）');
});

test('★ 点火抛错 / done 抛错 ⇒ 如实报任务失败，不静默成功', async () => {
  const throwing = () => { throw new Error('ignition boom'); };
  const r1 = await createTaskExecutor({ automation: throwing })({ prompt: 'x', sessionKey: 'S' });
  assert.equal(r1.ok, false);
  assert.equal(r1.transport, 'automation');
  assert.match(r1.error.message, /ignition boom/);

  const rejecting = () => ({ cancel: () => {}, done: Promise.reject(new Error('poll boom')), readOutput: () => '' });
  // ★ 必须先挂住 rejection，否则断言之前就变成 unhandled rejection。
  const r2p = createTaskExecutor({ automation: rejecting })({ prompt: 'x', sessionKey: 'S' });
  const r2 = await r2p;
  assert.equal(r2.ok, false);
  assert.match(r2.error.message, /poll boom/);
});

test('★★ 记不住对话 id 时必须说出来（不许静默开新对话）', async () => {
  // 记性拒收（模拟 schema 校验失败/写盘失败）
  const sessions = { lookup: () => null, adopt: () => ({ ok: false, persistError: 'malformed session id' }) };
  const report = {
    ok: true, sessionId: 'conv-x', sessionOrigin: 'new', continuity: 'fresh-conversation-per-round',
    phases: ['db-open', 'running'], receipt: null, text: 'ok', reason: 'ok',
    permission: { requested: 'fullAccess', effective: 'fullAccess', confirmed: true },
    usedModelId: 'glm-5.3', requestedModelId: 'glm-5.3',
    sessionMemory: 'not remembered (malformed session id)',
  };
  const note = receiptNote(report);
  assert.match(note, /session-memory=not remembered/, '★ 记不住就必须上报 —— 否则第二轮会静默开新对话');
  assert.match(note, /will start a new one/, '必须说清后果');
});

test('★★★ 三种连续性在回执里必须各自说清，不许一律叫"新对话"', () => {
  for (const [value, mustMatch] of [
    ['same-conversation', /SAME WorkBuddy conversation/],
    ['new-conversation-with-replayed-history', /NOT a true continuation/],
    ['fresh-conversation-per-round', /every round opens a new conversation/],
  ]) {
    const note = receiptNote({
      ok: true, phases: ['running'], receipt: null, sessionId: 'c', sessionOrigin: 'new',
      continuity: value, permission: { requested: '', effective: '', confirmed: true },
    });
    assert.match(note, new RegExp(`continuity=${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), `${value} 必须出现在回执里`);
    assert.match(note, mustMatch, `${value} 必须附带人话解释`);
  }
  // 未知的连续性取值不许被编成人话。
  assert.doesNotMatch(
    receiptNote({ ok: true, phases: ['running'], receipt: null, continuity: 'whatever', permission: { requested: '' } }),
    /continuity=/,
    '认不出的连续性取值不许硬编解释',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// ★ 旧 LLM 适配器（`llm-adapter.js`）已删除：下面两个用例改成在**存活的那一层**上断言。
//   会话标题与正文组装现在归 `provider.js`（本插件唯一还在的组装者），告示/回执仍由
//   `notes.js` 产出 —— 断言的是同一批**事实**，不是同一批函数名。
//   ★ 如实标注的差别：标题不再由本插件从消息里"挑用户那条"（宿主现在直接把 `label` 递下来），
//     剩下的责任是"压成一行、长度封顶、没标签就报 null"；`tool-call-delta` 不产出与
//     `reason.kind==='stop'` 这两个断言随适配器一起消失（本路只回正文，没有流式帧可断言）。
// ─────────────────────────────────────────────────────────────────────────────

/** 一个**绝对且真实存在**的目录：`resolveChildCwd` 会校验可进入，编一个不存在的路径它会抛。 */
const TEST_CWD = fileURLToPath(new URL('.', import.meta.url));

/**
 * 起一次真的 `provider.start()`，执行出口用注入的 `runTask`（★ 不碰任何真实传输/数据库）。
 * @returns {Promise<object>} 结算后的结果（`{output, stopReason, diagnostic?}`，永不 reject）
 */
async function startProvider({ runTask = null, readConfig = null, label, prompt = [{ type: 'text', text: '你好' }], signal = null } = {}) {
  const provider = createWorkBuddyProvider({ runTask, readConfig });
  const run = await provider.start({
    parent: { session: { header: { id: 'S1', cwd: TEST_CWD } } },
    label,
    prompt,
    signal: signal ?? new AbortController().signal,
  });
  const settled = await run.result;
  run.dispose();
  return settled;
}

test('★ 会话标题只认宿主下发的标签：压成一行、长度封顶，没标签就是 null（绝不拿别的文本冒充）', async () => {
  const seen = [];
  const runTask = async (req) => {
    seen.push(req);
    return { ok: true, text: 'IGNITION-OK', phases: ['running'], receipt: null, sessionId: 'c1', sessionOrigin: 'new' };
  };

  // 负控前提：真机上 dsh 的 system prompt 就长这样 —— 它**绝不能**变成会话标题。
  const systemFirst = 'You are an AI agent powered by DeepSeek Harness.\n\nYou are a ';
  assert.ok(systemFirst.startsWith('You are an AI agent'), '负控前提本身失效');

  await startProvider({ runTask, label: '把 README 翻译成英文' });
  await startProvider({ runTask, label: '  把 README 翻译成英文  ' });
  await startProvider({ runTask, label: 'a\n\n  b' });
  await startProvider({ runTask, label: 'x'.repeat(200) });
  // ★★ 2026-10-01 真机踩到的正是这一条：标题取到了 system prompt 的头 60 字。
  await startProvider({ runTask, label: undefined, prompt: [{ type: 'text', text: systemFirst }] });
  await startProvider({ runTask, label: '   ' });

  assert.equal(seen.length, 6);
  assert.equal(seen[0].name, '把 README 翻译成英文');
  assert.equal(seen[1].name, '把 README 翻译成英文', '首尾空白必须去掉');
  // 换行压成一行、长度封顶 —— 桌面端拿它当会话标题，长文本会变成一堵墙。
  assert.equal(seen[2].name, 'a b', '换行/连续空白必须压成一行');
  assert.equal(seen[3].name.length, 61, '长文本必须封顶（60 + 省略号）');
  assert.equal(seen[4].prompt, systemFirst, '负控前提：这一轮下发的正文确实以 system prompt 开头');
  assert.equal(seen[4].name, null, '★★ 没标签就是 null，绝不能拿正文/系统提示的头 60 字冒充标题');
  assert.equal(seen[5].name, null, '只有空白的标签等于没给');
  // 执行口拿到的是**压好的任务文本**，不是原始块数组。
  for (const req of seen) assert.equal(typeof req.prompt, 'string');
  assert.equal(seen[0].cwd, TEST_CWD, '工作目录必须落回父会话的工作区，而不是本进程的启动目录');
  assert.equal(seen[0].permissionMode, 'bypassPermissions', '★ 没配权限档 ⇒ 强制非交互档（面前没有人）');
  assert.equal(seen[0].model, '', '没配模型 ⇒ 报空串，由回执去说"没人选"');
});

test('★ 正文 = 结果 + 两行告示；没有执行出口时报错，而不是返回一段空文本', async () => {
  // 正控：一条真的回执（自动化那趟的形状）⇒ 正文必须带出结果与尾注。
  const ok = await startProvider({ runTask: async () => reportFromAutomation(okAutomation) });
  assert.equal(ok.stopReason, 'completed');
  const text = ok.output[0].text;
  assert.match(text, /^IGNITION-OK/, '正文必须是 WorkBuddy 那边的真实回复');
  assert.match(text, /continuity=fresh-conversation-per-round/);
  assert.match(text, /session=conv-1/, '回执必须带出会话 id');
  assert.match(text, /phases=db-open>awaiting-scheduler-tick>running/);
  assert.match(text, /model-chosen-by=NOBODY/, '★ 没人选模型这件事必须进正文');
  assert.match(text, /has no model configured/, '必须说清"没人选"的根因是本插件没配模型');
  assert.match(text, /set the model field in the WorkBuddy settings card/, '必须指出用户到底该去哪里设模型');

  // 成功但没正文 ⇒ 也要把回执送出来，并明说"成功却没内容"，不许静默空串。
  const empty = await startProvider({
    runTask: async () => ({ ...reportFromAutomation(okAutomation), text: '   ' }),
  });
  assert.match(empty.output[0].text, /reported success but returned no text/);
  assert.match(empty.output[0].text, /continuity=fresh-conversation-per-round/, '没正文也要带回执');

  // 权限没被确认 ⇒ 正文里必须有一行告示（不是只留在内部字段里）。
  const unconfirmed = await startProvider({
    runTask: async () => ({
      ...reportFromAutomation(okAutomation),
      permission: { requested: 'fullAccess', effective: 'bypassPermissions', confirmed: false },
    }),
  });
  assert.ok(unconfirmed.output[0].text.includes(PERMISSION_NOTE_MARK), '权限没兑现必须印进正文');
  assert.match(unconfirmed.output[0].text, /NOT confirmed to be in effect/);

  // 反向对照：执行出口一个都没装配 ⇒ 报错（带诊断），而不是一段空文本。
  const bare = await startProvider({ runTask: null });
  assert.equal(bare.output.length, 0, '失败轮不许产出正文');
  assert.equal(bare.stopReason, 'error');
  assert.match(String(bare.diagnostic), /no execution outlet is wired/, '必须说清为什么没跑，而不是默默返回空');
});

// ─────────────────────────────────────────────────────────────────────────────
// ★ 取消 ≠ 故障：旧适配器用 `finishReasonFor()` 把两者映射成不同的 dsh `kind`，
//   那个函数随 `llm-adapter.js` 一起删掉了。存活下来的分野在 `provider.js:304-311` ——
//   **取消不带 `diagnostic`，故障带**；`runOutcome`（`dsh-subagent/lib/index.js:2698-2707`）
//   据此把前者判成 `killed`、后者判成 `failed`。下面断言的正是那两个返回值本身。
// ─────────────────────────────────────────────────────────────────────────────

test('★★ 取消与故障必须分开：取消不带诊断（⇒ killed），故障带诊断（⇒ failed）', async () => {
  // 取消：信号在开跑前就已经中止 ⇒ 执行层一次都不该被调用。
  const dead = new AbortController();
  dead.abort();
  let called = 0;
  const cancelled = await startProvider({
    signal: dead.signal,
    runTask: async () => { called += 1; return { ok: true, text: 'x', phases: ['running'], receipt: null }; },
  });
  assert.equal(called, 0, '★ 已取消就不许再点火 —— 否则"我让它停"变成了"它还在跑"');
  assert.equal(cancelled.stopReason, 'aborted');
  assert.equal(cancelled.output.length, 0, '取消轮不许产出半截正文');
  assert.equal(cancelled.diagnostic, undefined, '★ 取消**必须不带** diagnostic，否则 runOutcome 会把它判成 failed（"我让它停"被读成"它坏了"）');

  // 故障：执行层报 `ok !== true` ⇒ 必须带诊断，且诊断里逐字带出原因与"卡在哪一级"。
  const failed = await startProvider({
    runTask: async () => ({ ok: false, reason: 'task_error', error: { message: 'boom' }, phases: [], receipt: null }),
  });
  assert.equal(failed.stopReason, 'error');
  assert.equal(failed.output.length, 0, '失败轮不许产出正文');
  assert.match(String(failed.diagnostic), /task_error/, '★ 原因必须逐字带出，不许被归纳成"出错了"');
  assert.match(String(failed.diagnostic), /boom/);
  assert.match(String(failed.diagnostic), /no phase was ever reached/, '空轨迹要说"空"，不能默默省略');
  assert.notEqual(failed.diagnostic, cancelled.diagnostic, '两种结局必须可区分');

  // 空正文：也不许当成成功（那正是"看起来跑完了、其实什么都没发"）。
  let emptyCalled = 0;
  const empty = await startProvider({
    prompt: [],
    runTask: async () => { emptyCalled += 1; return { ok: true, text: 'x' }; },
  });
  assert.equal(emptyCalled, 0, '没有内容块可发时不该惊动执行层');
  assert.equal(empty.stopReason, 'error');
  assert.equal(empty.output.length, 0);
  assert.match(String(empty.diagnostic), /nothing to send/, '必须说清"没有任何内容块可发"');
  assert.match(String(empty.diagnostic), /carried no content block/);
});