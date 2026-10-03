/**
 * 子智能体面的**会话复用（Track A 追发）**回归（★ 2026-10-03 接入）。
 *
 * <p>★ 测的是 `execute.js` 追发分支的**接线与触发语义**，不是 dispatcher 本身 ★
 * `followup/dispatcher.js` 的 CDP 判别/错误指纹有自己的 `test/followup-dispatcher.test.js`；
 * 工具面（`tools/run.js`）的同一条三条件语义有自己的 `test/multi-turn-reuse.test.js`。
 * 本文件把 `followUp` 当 **seam 注入件**（假件，绝不触真 CDP —— 真机桌面端可能正开着 9222，
 * 记性命中 + 默认惰性构造的组合会真的往用户对话里追发，所以本文件**不给**真 dispatcher
 * 任何记性命中 + 总闸开启的执行机会；"缺省惰性构造"由构造点与调用点同分支这一结构保证，
 * 见 execute.js 追发块的注释）。
 *
 * <p>触发条件（与 run.js 同一条三条件语义，逐条配正/反对照）：
 *   ① `enableMultiTurnFollowUp === true`（总闸，默认 false）② taskKey 非空 ③ 记性命中。
 * 与 run.js 的语义差别只有一处：这里**不重放 replayPrefix** —— 追发进的是同一条对话，
 * 前情本来就在里面。回退轮（追发失败）才照旧重放 + 点火。
 *
 * @module test/subagent-followup
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTaskExecutor } from '../src/host/subagent/execute.js';
import { receiptNote, failureDetailFor } from '../src/host/subagent/notes.js';
import { REASON_CODES } from '../src/host/launch/reason-codes.js';

/** 追发总闸开启的配置（`setting` 的返回源）。 */
const CFG_ON = { enableMultiTurnFollowUp: true, followupCdpPort: 9222, followupTimeoutMs: 12345 };
/** 总闸关闭（schema 默认值同款）。 */
const CFG_OFF = { enableMultiTurnFollowUp: false, followupCdpPort: 9222, followupTimeoutMs: 12345 };
const settingOf = (cfg) => (key) => cfg?.[key];

/**
 * 假点火（spy）：真机形状的 `startAutomationRun` 产物。参数里记录 `prompt` /
 * `sessionKey` / `sessionStore`，供"重放照旧 / 记账照旧"断言用。
 */
function fakeAutomation(records, reply = 'FALLBACK-OK', conversationId = 'conv-new') {
  return (req) => {
    records.push(req);
    return {
      cancel: () => {},
      done: Promise.resolve({
        status: 'completed', detail: reply, exitCode: 0,
        automation: {
          reason: null, automationId: `automation-${records.length}`, conversationId,
          sessionId: conversationId, sessionKey: req.sessionKey ?? null, sessionPersist: { ok: true },
          retired: true, transcriptPath: null, reply,
          creditsUsed: null, model: 'deepseek-v4.1-flash', permission: 'fullAccess',
          usedModelId: 'deepseek-v4.1-flash', sessionCwd: req.cwd ?? null,
          tokensUsed: 4321, phases: ['db-open', 'awaiting-scheduler-tick', 'running'],
        },
      }),
      readOutput: () => reply,
    };
  };
}

/** 假记性（spy）：`resumable` 恒命中 `recorded`，`forget` / `touch` 全程记账。 */
function makeSessions(recorded = { cliSessionId: 'conv-kept', cwd: 'D:/repo' }) {
  const calls = { resumable: [], forget: [], touch: [], adopt: [] };
  return {
    calls,
    resumable: (k) => { calls.resumable.push(k); return recorded; },
    forget: (k, reason) => { calls.forget.push({ k, reason }); return { ok: true }; },
    touch: (k) => { calls.touch.push(k); return { ok: true }; },
    // ★ direct ignition 成功必须 adopt（直建不写 automations 行，记性是下轮追发的唯一入口）。
    adopt: (k, r) => {
      calls.adopt.push({ k, cliSessionId: r?.cliSessionId ?? '', own: r?.own === true });
      return { ok: true, cliSessionId: r?.cliSessionId ?? '' };
    },
    lookup: () => null,
  };
}

/** 假追发（spy）：默认返回真机形状的成功回执（`receipt.output` 是 ContentBlock text 拼接）。 */
function makeFollowUp(calls, failWith = null, throwWith = null) {
  return async (req) => {
    calls.push(req);
    if (throwWith !== null) throw throwWith;
    if (failWith !== null) return { ok: false, code: failWith, detail: 'simulated follow-up failure' };
    return {
      ok: true,
      channel: 'track_a',
      receipt: {
        output: 'REPLY-FU', state: 'completed', requestId: 'rq-fu', clientRequestId: 'cr-fu', responseModel: null,
        // ★ 施工单 #2：dispatcher 派发前读到的会话现配（读到什么带什么）。
        conversationModel: 'kimi-k3-1',
        conversationEffort: 'high',
        artifacts: [],
      },
    };
  };
}

test('★★★ 追发成功：不点火、不重放前情，回执 origin=resumed / continuity=same-conversation，尾注带 follow-up 位', async () => {
  const fireCalls = [];
  const fuCalls = [];
  const sessions = makeSessions();
  const exec = createTaskExecutor({
    automation: fakeAutomation(fireCalls),
    setting: settingOf(CFG_ON),
    sessions,
    followUp: makeFollowUp(fuCalls),
  });

  const report = await exec({ prompt: '第二轮：接着改', cwd: 'D:/repo', sessionKey: 'subagent:S1:task:abcd1234' });

  // ★ 不点火：追发成功 = 零 INSERT（没有 automations 行可建）。
  assert.equal(report.ok, true);
  assert.equal(fireCalls.length, 0, '★ 追发成功绝不点火');
  assert.equal(fuCalls.length, 1, '追发恰好一次');
  // 触发条件 ②③：taskKey 逐字当 conversationId 的来源；prompt 打包成 ContentBlock 数组。
  assert.equal(fuCalls[0].conversationId, 'conv-kept', 'conversationId 来自记性里的 cliSessionId');
  assert.deepEqual(
    fuCalls[0].prompt,
    [{ type: 'text', text: '第二轮：接着改' }],
    '★ prompt 必须是 ContentBlock 数组（桌面端拒收裸字符串）',
  );
  // ★ 不重放 replayPrefix：发进对话的就是本轮 prompt 本身 —— 前情已经在那条对话里，
  //   重放会把同样的历史说第二遍。这是与 run.js 追发分支唯一的语义差别，必须有正反对照。
  assert.equal(fuCalls[0].prompt[0].text.includes('本次任务此前的对话'), false, '★ 不得把重放前缀塞进追发 prompt');
  assert.equal(fuCalls[0].timeoutMs, 12345, '追发超时从配置现取');
  assert.equal(fuCalls[0].cdpPort, 9222, 'CDP 口从配置现取');

  // 回执形状（不走 reportFromAutomation；字段对齐，缺的事实如实 null/false，不编）。
  assert.equal(report.transport, 'followup');
  assert.equal(report.text, 'REPLY-FU');
  assert.equal(report.reason, REASON_CODES.OK);
  assert.equal(report.receipt, null, '没有 ACP 消息链就不许编 receipt');
  assert.equal(report.sessionId, 'conv-kept');
  assert.equal(report.sessionOrigin, 'resumed', '★ 续用同一条对话 ⇒ origin=resumed（词表 2026-10-03 起合法）');
  assert.equal(report.continuity, 'same-conversation', '★ 真续接 ⇒ same-conversation');
  assert.deepEqual(report.phases, ['followup-dispatch'], '追发轮的阶段轨迹如实只有一级');
  assert.deepEqual(report.permission, { requested: '', effective: '(unknown)', confirmed: false }, '追发沿用对话现配 ⇒ 未知，不编');
  assert.deepEqual(report.effort, { requested: '', effective: '(unknown)', confirmed: false });
  assert.equal(report.requestedModelId, null);
  assert.equal(report.usedModelId, null);
  assert.equal(report.usage, null);
  assert.equal(report.automationId, null, '没有 automations 行 ⇒ automationId 如实 null');
  assert.equal(report.title, null);
  assert.equal(report.transcriptPath, null);
  assert.equal(report.cwd, 'D:/repo');
  assert.equal(typeof report.createdAt, 'string', 'createdAt 是 ISO 时间戳');
  assert.equal(typeof report.followUp?.elapsedMs, 'number', '追发元数据（channel/elapsedMs）随回执带出');
  assert.equal(report.followUp.channel, 'track_a');
  // ★ 施工单 #2：只读识别两键随 followUp 元数据透传（与 tools/run.js 的 follow_up 同名同义）。
  assert.equal(report.followUp.conversationModel, 'kimi-k3-1', '会话当前模型随回执透传');
  assert.equal(report.followUp.conversationEffort, 'high', '会话当前思考强度随回执透传');
  assert.equal('fallback' in report, false, '成功轮不带回退键');

  // 记账：会话 id 没变 ⇒ 只 touch 推进热度戳，不 forget 不 adopt。
  assert.deepEqual(sessions.calls.touch, ['subagent:S1:task:abcd1234'], '★ 成功只 touch（sweepOwnSessions 按 lastUsedAt 判陈旧）');
  assert.equal(sessions.calls.forget.length, 0, '成功不 forget');

  // 尾注：追发轮的可读面（主控模型看得见的部分）。
  const note = receiptNote(report);
  assert.ok(note.includes('follow-up=track_a in '), `尾注必须带 follow-up 位；实际=${note}`);
  assert.ok(note.includes('origin=resumed'), '尾注必须回显 origin=resumed');
  assert.ok(note.includes('continuity=same-conversation'), '尾注必须带真续接解释');
  assert.ok(note.includes('phases=followup-dispatch'));
});

test('★★★ 追发失败：forget 带指纹码、照旧 replayPrefix + 点火（追发轮的前情也在重放里），回执带 fallback 两键', async () => {
  const fireCalls = [];
  const fuCalls = [];
  const sessions = makeSessions();
  // 可切换的假追发：第一轮成功（前情落转写），第二轮失败（触发回退）。
  let failNext = false;
  const switchableFollowUp = async (req) => {
    fuCalls.push(req);
    if (failNext) return { ok: false, code: 'ERR_CONVERSATION_NOT_FOUND', detail: 'conversation gone' };
    return {
      ok: true,
      channel: 'track_a',
      receipt: {
        output: 'REPLY-FU', state: 'completed', requestId: 'rq-fu', clientRequestId: 'cr-fu', responseModel: null,
        // ★ 施工单 #2：dispatcher 派发前读到的会话现配（读到什么带什么）。
        conversationModel: 'kimi-k3-1',
        conversationEffort: 'high',
        artifacts: [],
      },
    };
  };
  const exec = createTaskExecutor({
    automation: fakeAutomation(fireCalls),
    setting: settingOf(CFG_ON),
    sessions,
    followUp: switchableFollowUp,
  });

  const r1 = await exec({ prompt: '第一轮的问题', sessionKey: 'K1' });
  assert.equal(r1.ok, true);
  assert.equal(r1.transport, 'followup', '第一轮记性命中 ⇒ 走追发');
  assert.equal(fireCalls.length, 0);

  failNext = true;
  const r2 = await exec({ prompt: '第二轮的问题', sessionKey: 'K1' });
  // ★ 回退轮 = 既有点火路逐字照旧：重放前情（含追发轮落下的转写）、同 sessionKey、sessionStore 透传。
  assert.equal(r2.ok, true);
  assert.equal(r2.transport, 'automation', '回退轮走的是既有点火路');
  assert.equal(fireCalls.length, 1, '只有回退轮点火');
  assert.equal(fireCalls[0].sessionKey, 'K1', '照旧透传 sessionKey（adopt 记账键）');
  assert.ok(fireCalls[0].sessionStore !== undefined, '照旧透传 sessionStore');
  assert.match(fireCalls[0].prompt, /第一轮的问题/, '★ 照旧 replayPrefix：追发轮的问题也进前情');
  assert.match(fireCalls[0].prompt, /REPLY-FU/, '追发轮的回复同样进前情');
  assert.match(fireCalls[0].prompt, /第二轮的问题/);
  // ★ forget 被带指纹码调用（死 id 不得留在记性里）。
  assert.deepEqual(
    sessions.calls.forget,
    [{ k: 'K1', reason: 'ERR_CONVERSATION_NOT_FOUND' }],
    '★ forget 必须带上 RFC 指纹码',
  );
  // 回执两键 + 尾注带码。
  assert.equal(r2.fallback, true);
  assert.equal(r2.fallbackReason, 'ERR_CONVERSATION_NOT_FOUND');
  const note = receiptNote(r2);
  assert.ok(note.includes('fallback=ERR_CONVERSATION_NOT_FOUND'), `回退轮尾注必须带指纹码；实际=${note}`);
  assert.ok(note.includes('origin=new'), '回退轮是点火自建的新对话');
  assert.ok(note.includes('continuity=fresh-conversation-per-round'));
  // 成功轮与回退轮必须读得出差别。
  assert.notEqual(receiptNote(r1), note);
});

test('★★ 回退轮点火也失败 ⇒ 失败诊断拼进指纹码（failureDetailFor 消费 error.message）', async () => {
  const boomAutomation = () => ({
    cancel: () => {},
    done: Promise.reject(new Error('poll boom')),
    readOutput: () => '',
  });
  const sessions = makeSessions();
  const exec = createTaskExecutor({
    automation: boomAutomation,
    setting: settingOf(CFG_ON),
    sessions,
    followUp: makeFollowUp([], 'ERR_WORKBUDDY_CDP_UNAVAILABLE'),
  });
  const r = await exec({ prompt: 'x', sessionKey: 'K2' });
  assert.equal(r.ok, false);
  assert.equal(r.fallback, true);
  assert.equal(r.fallbackReason, 'ERR_WORKBUDDY_CDP_UNAVAILABLE');
  // ★ 失败诊断必须同时回答两个问题：点火为什么失败、追发先折在哪。
  assert.match(r.error.message, /poll boom/);
  assert.match(r.error.message, /ERR_WORKBUDDY_CDP_UNAVAILABLE/, '★ 追发指纹码必须拼进失败诊断');
  const detail = failureDetailFor(r);
  assert.match(detail, /WorkBuddy run failed \(task_error\)/);
  assert.match(detail, /ERR_WORKBUDDY_CDP_UNAVAILABLE/, '诊断行里同样读得到追发指纹码');
  assert.deepEqual(sessions.calls.forget, [{ k: 'K2', reason: 'ERR_WORKBUDDY_CDP_UNAVAILABLE' }]);
});

test('★★ 注入件抛异常 ⇒ 收敛为 ERR_FOLLOWUP_FAILED 回退，绝不炸整轮', async () => {
  const fireCalls = [];
  const sessions = makeSessions();
  const exec = createTaskExecutor({
    automation: fakeAutomation(fireCalls),
    setting: settingOf(CFG_ON),
    sessions,
    followUp: makeFollowUp([], null, new Error('seam boom')),
  });
  const r = await exec({ prompt: 'x', sessionKey: 'K3' });
  assert.equal(r.ok, true, '异常收敛为回退，点火照旧成功');
  assert.equal(r.transport, 'automation');
  assert.equal(r.fallback, true);
  assert.equal(r.fallbackReason, 'ERR_FOLLOWUP_FAILED', '归因不明 ⇒ RFC 外 catch-all 指纹');
  assert.deepEqual(sessions.calls.forget, [{ k: 'K3', reason: 'ERR_FOLLOWUP_FAILED' }]);
  assert.equal(fireCalls.length, 1, '照旧点火');
});

test('★★★ 总闸关闭：followUp 一次都不被调用、连记性都不查，行为与未接线版本逐字节一致（无新键）', async () => {
  const fireCalls = [];
  const fuCalls = [];
  const sessions = makeSessions(); // 记性命中也在 —— 短路必须发生在总闸之后、记性之前
  const exec = createTaskExecutor({
    automation: fakeAutomation(fireCalls),
    setting: settingOf(CFG_OFF),
    sessions,
    followUp: makeFollowUp(fuCalls),
  });

  const r = await exec({ prompt: '问一下', sessionKey: 'K1' });
  assert.equal(fuCalls.length, 0, '★ 总闸关闭时注入的 followUp 一次都不被调用（缺省惰性构造点与调用同分支 ⇒ 也一次不构造）');
  assert.deepEqual(sessions.calls.resumable, [], '★ 连记性都不查：短路在总闸之后');
  assert.deepEqual(sessions.calls.forget, [], '不 forget');
  assert.deepEqual(sessions.calls.touch, [], '不 touch');

  // 既有行为逐字节：transport=automation、每轮新对话、重放前情照旧、回执**无**任何新键。
  assert.equal(r.ok, true);
  assert.equal(r.transport, 'automation');
  assert.equal(r.continuity, 'fresh-conversation-per-round');
  assert.equal(r.sessionOrigin, 'new');
  assert.equal('followUp' in r, false, '关闭时回执不含追发键（键集与旧版本逐字节一致）');
  assert.equal('fallback' in r, false);
  assert.equal('fallbackReason' in r, false);
  assert.equal(receiptNote(r).includes('follow-up='), false);
  assert.equal(receiptNote(r).includes('fallback='), false);

  // 第二轮：重放前情（既有语义不动）。
  const r2 = await exec({ prompt: '第二轮', sessionKey: 'K1' });
  assert.equal(fireCalls.length, 2);
  assert.match(fireCalls[1].prompt, /问一下/, '开关关闭 ⇒ 仍是每轮新对话 + 重放前情');
  assert.equal(r2.continuity, 'fresh-conversation-per-round');
});

test('★ 总闸开着但记性未命中 ⇒ 照旧点火，无追发无回退键（触发条件③不成立）', async () => {
  const fireCalls = [];
  const fuCalls = [];
  const sessions = makeSessions(null); // 记性不命中
  const exec = createTaskExecutor({
    automation: fakeAutomation(fireCalls),
    setting: settingOf(CFG_ON),
    sessions,
    followUp: makeFollowUp(fuCalls),
  });
  const r = await exec({ prompt: 'x', sessionKey: 'K1' });
  assert.equal(fuCalls.length, 0, '记性未命中 ⇒ 不追发');
  assert.equal(r.ok, true);
  assert.equal(r.transport, 'automation');
  assert.equal('fallback' in r, false, '没尝试追发就没有回退键（回退键只描述"试过且失败"）');
  assert.equal('fallbackReason' in r, false);
  assert.equal(fireCalls.length, 1);
});

test('★ 记性命中但 cliSessionId 为空 ⇒ 不追发（对话 id 是追发的唯一目标，没有就不试）', async () => {
  const fireCalls = [];
  const fuCalls = [];
  const sessions = makeSessions({ cliSessionId: '', cwd: null });
  const exec = createTaskExecutor({
    automation: fakeAutomation(fireCalls),
    setting: settingOf(CFG_ON),
    sessions,
    followUp: makeFollowUp(fuCalls),
  });
  const r = await exec({ prompt: 'x', sessionKey: 'K1' });
  assert.equal(fuCalls.length, 0, '空 id 不得当追发目标');
  assert.equal(r.transport, 'automation');
  assert.equal(fireCalls.length, 1);
  // 防御性分支不产生回退键：没有"试过追发"这回事。
  assert.equal('fallback' in r, false);
});

/* ═══════════════ direct ignition · 团队链（2026-10-04 用户拍板 D2：两条点火都覆盖）═══════════════ */

/** direct 总闸**开**的配置（只配 directIgnite seam 一起用，绝不单开 —— 见文件头红线）。 */
const CFG_DIRECT = { enableDirectIgnition: true, followupCdpPort: 9222, followupTimeoutMs: 12345 };
/** schema 默认值同款：总闸关。 */
const CFG_DIRECT_OFF = { enableDirectIgnition: false, followupCdpPort: 9222, followupTimeoutMs: 12345 };

/** 假直接点火（spy）：默认成功回执（dispatcher.ignite 真实信封形状）。 */
function makeDirectIgnite(calls, outcome = null) {
  return async (req) => {
    calls.push(req);
    if (outcome !== null) return outcome;
    return {
      ok: true,
      stage: 'dispatch',
      dispatched: true,
      created: true,
      conversationId: 'dsh-ignite-sub-1',
      title: 'SUB-TASK',
      elapsedMs: 33,
      model: 'kimi-k3-1',
      effort: 'high',
      receipt: {
        raw: { state: 'completed' },
        output: 'REPLY-DIRECT',
        state: 'completed',
        requestId: 'rq-di',
        clientRequestId: 'cr-di',
        responseModel: null,
        artifacts: [],
      },
    };
  };
}

test('★★★ 团队链总闸关闭 ⇒ directIgnite 零构造零调用，回执与未接线版逐字一致', async () => {
  const fireCalls = [];
  const diCalls = [];
  const exec = createTaskExecutor({
    automation: fakeAutomation(fireCalls),
    setting: settingOf(CFG_DIRECT_OFF),
    sessions: makeSessions(null),
    directIgnite: makeDirectIgnite(diCalls),
  });
  const r = await exec({ prompt: 'x', sessionKey: 'K9' });
  assert.equal(diCalls.length, 0, '★ 总闸关 ⇒ direct 面一次都不许碰');
  assert.equal(fireCalls.length, 1, '★ 照旧点火（零回归）');
  assert.equal(r.transport, 'automation');
  assert.equal('fallback' in r, false);
  assert.equal(r.ok, true);
});

test('★★★ 团队链 direct 成功 ⇒ 零点火、transport=direct、adopt 记性、**重放前情前缀**', async () => {
  const fireCalls = [];
  const diCalls = [];
  const sessions = makeSessions(null);
  const exec = createTaskExecutor({
    automation: fakeAutomation(fireCalls),
    setting: settingOf(CFG_DIRECT),
    sessions,
    directIgnite: makeDirectIgnite(diCalls),
  });

  const first = await exec({ prompt: '第一轮任务', cwd: 'D:/repo', sessionKey: 'K10' });
  assert.equal(fireCalls.length, 0, '★★ 直接点火成功 ⇒ 零 INSERT');
  assert.equal(diCalls.length, 1);
  const req = diCalls[0];
  assert.deepEqual(req.prompt, [{ type: 'text', text: '第一轮任务' }], '★ prompt 打包成 ContentBlock[]');
  assert.equal(req.cwd, 'D:/repo');
  assert.equal(req.modelId, null, '★ 没选模型 ⇒ 传 null（dispatcher 归一后不下发 model，沿用桌面默认）');
  assert.equal(req.timeoutMs, 900_000, '★ 点火预算 = 计划任务 15min 口径');
  assert.equal(req.cdpPort, 9222, '★ 复用 followupCdpPort');

  assert.equal(first.ok, true);
  assert.equal(first.transport, 'direct');
  assert.equal(first.text, 'REPLY-DIRECT');
  assert.equal(first.reason, REASON_CODES.OK);
  assert.equal(first.sessionId, 'dsh-ignite-sub-1');
  assert.equal(first.sessionOrigin, 'new', '★ 新对话 ⇒ origin=new（不谎称 resumed）');
  assert.equal(first.continuity, 'fresh-conversation-per-round');
  assert.deepEqual(first.phases, ['direct-ignite']);
  assert.equal(first.automationId, null, '★ 直建不写 automations 表 ⇒ 如实 null');
  assert.equal(first.receipt, null, '没有 ACP 消息链就不许编 receipt');
  assert.equal(first.usedModelId, 'kimi-k3-1', '★ 回显派发前读回的现配');
  assert.equal(first.effort.effective, 'high');
  assert.equal(first.effort.requested, '', '未请求强度 ⇒ requested 空，confirmed 不许谎称');
  assert.equal('fallback' in first, false, '★ 成功不带回退键');
  // ★ 记性：直建不写 automations 行 ⇒ 记性是下轮追发的唯一入口。
  assert.deepEqual(
    sessions.calls.adopt.map((a) => a.cliSessionId),
    ['dsh-ignite-sub-1'],
    '★★ 必须 adopt（否则下轮 resume 命中不了）',
  );
  assert.equal(sessions.calls.adopt[0].k, 'K10');
  assert.equal(sessions.calls.adopt[0].own, true);

  // ★ 直建是**新对话** ⇒ 第二轮必须重放前情（与点火同形；追发才不重放）。
  await exec({ prompt: '第二轮任务', cwd: 'D:/repo', sessionKey: 'K10' });
  assert.equal(diCalls.length, 2);
  const second = diCalls[1].prompt[0].text;
  assert.ok(second.endsWith('第二轮任务'), `本轮 prompt 在尾部：${second}`);
  assert.ok(
    second.includes('本次任务此前的对话'),
    `★★ 直建新对话必须带重放前缀（否则丢了上下文）：${second.slice(0, 160)}`,
  );
});

test('★★★ 团队链 direct 派发前失败 ⇒ 照旧点火 + fallback 两键 + transport=automation', async () => {
  const fireCalls = [];
  const diCalls = [];
  const exec = createTaskExecutor({
    automation: fakeAutomation(fireCalls),
    setting: settingOf(CFG_DIRECT),
    sessions: makeSessions(null),
    directIgnite: makeDirectIgnite(diCalls, {
      ok: false,
      code: 'ERR_WORKBUDDY_CDP_UNAVAILABLE',
      detail: 'WorkBuddy 未带 WORKBUDDY_REMOTE_DEBUGGING_PORT 启动',
      stage: 'detect',
      dispatched: false,
      created: false,
      conversationId: null,
      cleanup: 'none',
    }),
  });
  const r = await exec({ prompt: 'x', sessionKey: 'K11' });
  assert.equal(diCalls.length, 1);
  assert.equal(fireCalls.length, 1, '★ 派发前失败 ⇒ 回退点火（任务不丢）');
  assert.equal(r.ok, true, '回退后照跑');
  assert.equal(r.fallback, true, '★ 回执必须带 fallback 两键（不静默）');
  assert.equal(r.fallbackReason, 'ERR_WORKBUDDY_CDP_UNAVAILABLE');
  assert.equal(r.transport, 'automation', '★★ 真跑在点火上 ⇒ 不谎称 direct');
  assert.equal(r.sessionId, 'conv-new');
});

test('★★ 回退诊断话术按来源分流：direct 回退说 direct，不套用追发那句"会话续不上"', async () => {
  const diCalls = [];
  const failingAutomation = (req) => {
    void req;
    return {
      cancel: () => {},
      done: Promise.resolve({
        status: 'failed',
        detail: 'scheduler boom',
        exitCode: 1,
        automation: {
          reason: REASON_CODES.TASK_ERROR, automationId: null, conversationId: 'conv-x',
          sessionId: 'conv-x', phases: [], retryable: false, transcriptPath: null,
        },
      }),
      readOutput: () => '',
    };
  };
  const exec = createTaskExecutor({
    automation: failingAutomation,
    setting: settingOf(CFG_DIRECT),
    sessions: makeSessions(null),
    directIgnite: makeDirectIgnite(diCalls, {
      ok: false, code: 'ERR_WORKBUDDY_CDP_UNAVAILABLE', detail: 'no debug port',
      stage: 'detect', dispatched: false, created: false, conversationId: null, cleanup: 'none',
    }),
  });
  const r = await exec({ prompt: 'x', sessionKey: 'K12' });
  assert.equal(r.ok, false, '前置：回退后的点火也失败（才有 error.message 可装饰）');
  assert.ok(
    r.error.message.includes('direct-ignition fallback ERR_WORKBUDDY_CDP_UNAVAILABLE'),
    `★ 话术须按真实来源：${r.error.message}`,
  );
  assert.equal(
    r.error.message.includes('follow-up fallback'),
    false,
    '★ 不许套用追发话术（那一轮根本没有"录下来的对话"可续）',
  );
  assert.equal(r.fallback, true);
  assert.equal(r.fallbackReason, 'ERR_WORKBUDDY_CDP_UNAVAILABLE');
});

test('★★★ 团队链 direct 派发后失败 ⇒ **零回退**（同一条 prompt 绝不跑第二遍）+ 如实失败', async () => {
  const fireCalls = [];
  const diCalls = [];
  const exec = createTaskExecutor({
    automation: fakeAutomation(fireCalls),
    setting: settingOf(CFG_DIRECT),
    sessions: makeSessions(null),
    directIgnite: makeDirectIgnite(diCalls, {
      ok: false,
      code: 'ERR_DISPATCH_TIMEOUT',
      detail: 'runPrompt evaluate timed out',
      stage: 'dispatch',
      dispatched: true,
      created: true,
      conversationId: 'dsh-ignite-stuck',
      cleanup: 'kept',
    }),
  });
  const r = await exec({ prompt: 'x', sessionKey: 'K13' });
  assert.equal(diCalls.length, 1);
  assert.equal(fireCalls.length, 0, '★★★ 派发后失败**绝不回退** —— 回退 = 双份积分 + 两条对话');
  assert.equal(r.ok, false, '★ 本轮如实失败（不静默成成功）');
  assert.equal(r.transport, 'direct');
  assert.equal(r.sessionId, 'dsh-ignite-stuck', '★ 报出是哪条对话（它可能还在跑）');
  assert.deepEqual(r.phases, ['direct-ignite']);
  assert.ok(
    r.error.message.includes('NOT retried'),
    `★ 失败诊断必须说清"为何不回退"：${r.error.message}`,
  );
  assert.ok(r.error.message.includes('ERR_DISPATCH_TIMEOUT'), '★ 指纹码可见');
  assert.equal('fallback' in r, false, '★ 没回退就不许带 fallback 键（不谎称回退）');
});
