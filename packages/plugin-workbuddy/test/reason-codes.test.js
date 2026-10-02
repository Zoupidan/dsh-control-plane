/**
 * 归因词汇表 + 证据面纪律的**真机形态**探针（2026-09-19）。
 *
 * 为什么单独一个文件：`verdict.test.js` 测的是"证据面 → verdict 字段"的组装，本文件测的是
 * **归一表本身**——结构化错误码 → 原因码的映射、以及"正文永不作证据"这条纪律。
 * 这两件事此前都没有检测器（原实现把 assistant 正文混进证据面，147 条测试全绿）。
 *
 * ★ 样本来源纪律：本文件里的每条错误串都标注来源。
 *   - `真机` = 本机 WorkBuddy 2.137.1 实测逐字（可复现：`node <cli> -p --output-format stream-json`）
 *   - `官方` = WorkBuddy 官方错误码说明给出的码族（**本机未复现该码**，只是映射表口径）
 *   - 逐字录入的完整证据见 04-docs/（探测记录）。
 *
 * ★ 检测器有效性：本文件每条关键断言都做过变异验证（把对应修复回退 ⇒ 断言变 RED），
 *   变异记录见最后一次交付说明；不在此处写"已变异"字样冒充证据。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REASON_CODES, REASON_TEXT, FAILURE_CODES, isFailureCode, classifyFailure,
} from '../src/host/launch/reason-codes.js';
import { parseFrames, summariseFrames, framesIndicateError } from '../src/host/launch/stream-json.js';

// ── 真机样本 ────────────────────────────────────────────────────────────────────────────────

/** 真机：`--resume nonexistent-session-xyz-123` 的**全部** stdout（94 字节，exit 0，无 stderr 有用内容）。 */
const LIVE_NO_SESSION_STDOUT = '{"type":"error","error":"No conversation found with session ID: nonexistent-session-xyz-123"}\n';

/** 真机：死代理 `HTTPS_PROXY=http://127.0.0.1:9` 的 result 帧（摘其关键字段；`details` 逐字）。 */
const LIVE_PROXY_DETAILS = '502 连接被拒绝：可能是代理未启动或端口被拦截，请检查网络代理设置（connect ECONNREFUSED 127.0.0.1:9）';

// ── 1. 最严重的漏报：唯一一帧是 error 帧 ⇒ 必须成为失败证据 ────────────────────────────────────

test('真机 no-session stdout：parseFrames 收 1 帧，summariseFrames 必须把它落进错误面', () => {
  const parsed = parseFrames(LIVE_NO_SESSION_STDOUT);
  assert.equal(parsed.frames.length, 1, '94 字节的 error 帧必须被解析成 1 帧');
  const summary = summariseFrames(parsed);
  assert.equal(summary.hasErrorFrame, true, 'type:"error" 帧必须被识别（旧实现整帧不看 ⇒ 94 字节的证据被丢掉）');
  assert.match(summary.frameErrorText, /No conversation found with session ID: nonexistent-session-xyz-123/);
  assert.equal(framesIndicateError(summary), true, 'error 帧 ⇒ 必须是"任务报错"');
});

test('真机 no-session：classifyFailure 归 no_session_resume（不是 ok/unknown）', () => {
  const summary = summariseFrames(parseFrames(LIVE_NO_SESSION_STDOUT));
  const reason = classifyFailure({
    exitCode: 0,
    stderrText: '',
    frameErrorText: summary.frameErrorText,
    unparsedText: summary.unparsedText,
    errorSignals: summary.errorSignals,
    taskError: framesIndicateError(summary),
  });
  assert.equal(reason.reasonCode, REASON_CODES.NO_SESSION_RESUME);
  assert.equal(isFailureCode(reason.reasonCode), true, 'no_session_resume 必须属于"有证据的失败"');
  assert.match(reason.evidence, /No conversation found/);
});

// ── 2. 结构化错误码 → 原因码（官方码族；只有 3002 是本机真机复现的） ─────────────────────────────

test('真机 3002（死代理）⇒ transport_unreachable，证据带码与 details', () => {
  const reason = classifyFailure({
    exitCode: 0,
    errorSignals: [{ status: 502, code: 3002, category: 'network', details: LIVE_PROXY_DETAILS }],
    frameErrorText: LIVE_PROXY_DETAILS,
    taskError: true,
  });
  assert.equal(reason.reasonCode, REASON_CODES.TRANSPORT_UNREACHABLE);
  assert.match(reason.evidence, /code 3002/);
  assert.match(reason.evidence, /连接被拒绝/);
});

test('官方码族逐码映射（矩阵完整性）：模型侧/网络/频率/输入过长', () => {
  const cases = [
    [1001, REASON_CODES.MODEL_UNAVAILABLE],
    [11133, REASON_CODES.MODEL_UNAVAILABLE],
    [11134, REASON_CODES.MODEL_UNAVAILABLE],
    [14003, REASON_CODES.MODEL_UNAVAILABLE],
    [3003, REASON_CODES.TRANSPORT_UNREACHABLE],
    [3007, REASON_CODES.TRANSPORT_UNREACHABLE],
    [6003, REASON_CODES.QUOTA_REQUEST_LIMIT],
    [6004, REASON_CODES.QUOTA_REQUEST_LIMIT],
    [11115, REASON_CODES.INPUT_TOO_LONG],
  ];
  for (const [code, expected] of cases) {
    const reason = classifyFailure({
      exitCode: 0,
      errorSignals: [{ status: 500, code, category: null, details: `vendor code ${code}` }],
    });
    assert.equal(reason.reasonCode, expected, `码 ${code} 应归 ${expected}`);
    assert.ok(REASON_TEXT[expected].length > 0, `码 ${code} 必须有可读文案`);
  }
});

test('category:"network" 兜底：未登记的码只要分类明确仍归网络族', () => {
  const reason = classifyFailure({
    exitCode: 0,
    errorSignals: [{ status: 599, code: 99999, category: 'network', details: 'proxy dead' }],
  });
  assert.equal(reason.reasonCode, REASON_CODES.TRANSPORT_UNREACHABLE);
});

test('11102 故意不入码表：只有码、没有文本时必须归 unknown（不据推测安语义）', () => {
  const reason = classifyFailure({
    exitCode: 0,
    errorSignals: [{ status: 400, code: 11102, category: null, details: '' }],
  });
  assert.equal(reason.reasonCode, REASON_CODES.UNKNOWN, '11102 的语义来自文本证据，不能凭码号猜');
  assert.match(REASON_TEXT[REASON_CODES.UNKNOWN], /^未能判定/, 'unknown 的文案必须自称"未能判定"，不得断言失败');
  assert.equal(REASON_TEXT[REASON_CODES.UNKNOWN].includes('失败。'), false, '不得以"失败"作句末结论');
});

// ── 3. 启动期失败：argv 过长（真机 ENAMETOOLONG） ─────────────────────────────────────────────

test('真机 spawnError ENAMETOOLONG ⇒ input_too_long（不是 start_failed）', () => {
  const reason = classifyFailure({
    spawnError: 'spawnSync C:\\Program Files\\nodejs\\node.exe ENAMETOOLONG',
  });
  assert.equal(reason.reasonCode, REASON_CODES.INPUT_TOO_LONG);
  assert.equal(isFailureCode(reason.reasonCode), true);
});

test('node 运行时缺失仍优先于输入过长', () => {
  const reason = classifyFailure({ spawnError: 'workbuddy: no node runtime found' });
  assert.equal(reason.reasonCode, REASON_CODES.NODE_RUNTIME_NOT_FOUND);
});

// ── 4. 证据面纪律：正文永不作证据（本文件存在的根本理由） ──────────────────────────────────────

/** 真机形态的成功帧 + 模型正文里"讨论"了这些词（文档类任务极常见）。 */
const PROSE = [
  '要复现 EADDRINUSE 需要先占用端口，例如 unknown option 会让 CLI 退出。',
  '如果账户配额不足，你需要去控制台充值。',
].join('\n');

function successStdout(prose) {
  const frames = [
    { type: 'system', subtype: 'init', model: 'some-model' },
    { type: 'assistant', message: { content: [{ type: 'text', text: prose }] } },
    {
      type: 'result', subtype: 'success', is_error: false, result: 'done',
      total_cost_usd: 0.01, errors: undefined, errors_info: undefined,
    },
  ];
  return `${frames.map((f) => JSON.stringify(f)).join('\n')}\n`;
}

test('成功帧 + 正文含 EADDRINUSE/配额不足 ⇒ 正文只进 frameProseText，错误面必须为空', () => {
  const summary = summariseFrames(parseFrames(successStdout(PROSE)));
  assert.equal(summary.frameErrorText, '', '正文不得出现在错误面（旧实现混装 ⇒ 成功判失败）');
  assert.match(summary.frameProseText, /EADDRINUSE/);
  assert.match(summary.frameProseText, /配额不足/);
  assert.equal(framesIndicateError(summary), false, '成功帧不是错误');
});

test('同一份成功输出：归因必须是 ok 语义（无失败证据）而不是 port_conflict/quota_exhausted', () => {
  const summary = summariseFrames(parseFrames(successStdout(PROSE)));
  const reason = classifyFailure({
    exitCode: 0,
    stderrText: '',
    frameErrorText: summary.frameErrorText,
    unparsedText: summary.unparsedText,
    errorSignals: summary.errorSignals,
    taskError: framesIndicateError(summary),
  });
  assert.equal(reason.reasonCode, REASON_CODES.UNKNOWN, '没有失败证据 + 未归一出结果 ⇒ unknown（调用方据 isFailureCode 判"未失败"）');
  assert.notEqual(reason.reasonCode, REASON_CODES.PORT_CONFLICT);
  assert.notEqual(reason.reasonCode, REASON_CODES.QUOTA_EXHAUSTED);
  assert.equal(isFailureCode(reason.reasonCode), false, 'unknown 不是失败归因');
});

// ── 5. 失败帧里的 errors/errors_info 仍必须能归因（别把正文剥离做过头） ─────────────────────────

test('失败帧（result 无 result 字段、错误在 errors[] 与 errors_info[]）⇒ 仍有证据可读', () => {
  const stdout = `${JSON.stringify({
    type: 'result', subtype: 'error_during_execution', is_error: true,
    errors: ['400 model [ghost-1] service info not found'],
    errors_info: [{ status: 400, code: 11102, details: '400 model [ghost-1] service info not found' }],
  })}\n`;
  const summary = summariseFrames(parseFrames(stdout));
  assert.match(summary.frameErrorText, /service info not found/);
  assert.equal(summary.errorSignals.length, 1, 'errors_info 必须进结构化信号');
  assert.equal(summary.errorSignals[0].code, 11102);
  // `errors[]` 与 `errors_info[].details` 在真机里是同一句 ⇒ 去重后不应出现两次
  assert.equal(summary.frameErrorText.match(/service info not found/g).length, 1, '同一句不得重复入证据');
  assert.equal(framesIndicateError(summary), true);
});

test('非 JSON 行（老版本纯文本 stdout）进 unparsedText，可作最后兜底证据面', () => {
  const parsed = parseFrames('Error: EADDRINUSE address already in use :::8080\n');
  assert.equal(parsed.unparsed.length, 1);
  const summary = summariseFrames(parsed);
  assert.match(summary.unparsedText, /EADDRINUSE/);
  const reason = classifyFailure({ exitCode: 1, unparsedText: summary.unparsedText });
  assert.equal(reason.reasonCode, REASON_CODES.PORT_CONFLICT);
});

// ── 5b. 文本兜底四族（**结构化码拿不到时唯一的路**：老版本 CLI / 进程级失败） ─────────────────────
//
// ★ 这一组是被变异测试逼出来的：把 classifyFailure 里的 textClasses 循环整体改成 `hit = null`，
//   原先 13 条测试**全绿** —— 也就是说 network/model/inputLimit/rateLimit 四族当时根本没有检测器，
//   删掉它们不会有任何红灯。这正是"没有检测器的修复等于没修"。

test('文本兜底：真实 502 文案**去掉结构化码后**仍归网络族（老版本 CLI 的形态）', () => {
  const reason = classifyFailure({ exitCode: 0, frameErrorText: LIVE_PROXY_DETAILS, taskError: true });
  assert.equal(reason.reasonCode, REASON_CODES.TRANSPORT_UNREACHABLE, '没有 errorSignals 时也必须靠文案归网络族');
  assert.match(reason.evidence, /连接被拒绝/);
});

test('★ auth 族含真机逐字样本：CLI 掉登录时必须归 auth_failed（此前落 task_error）', () => {
  // 样本逐字取自 2026-09-27 真机下发（tools/recon/real-run-probe.mjs，hy3，exit 0 + 6 帧）
  // 的 assistant 帧原文。既有六条模式一条都盖不住它（required≠failed；语序；中间多个 `use /`）。
  // 复跑：tools/recon/auth-coverage-probe.mjs
  const reason = classifyFailure({
    exitCode: 0,
    taskError: true,
    frameErrorText: 'Authentication required. Please use /login command to sign in to your account',
  });
  assert.equal(reason.reasonCode, REASON_CODES.AUTH_FAILED,
    '★ "掉登录"是可自助修复的问题，被报成 task_error 等于把可解的问题说成不可解');
  assert.notEqual(reason.reasonCode, REASON_CODES.TASK_ERROR, '不得落进泛化桶');

  // 同一 CLI 的其它登录态话术也要覆盖
  for (const text of ['Authentication required', 'Please use /login to continue']) {
    assert.equal(
      classifyFailure({ exitCode: 0, taskError: true, frameErrorText: text }).reasonCode,
      REASON_CODES.AUTH_FAILED, `「${text}」应归 auth_failed`,
    );
  }
});

test('★ 配额族覆盖 CLI 自己的四条判据（逐字取自 codebuddy-headless.js 的 ec 常量）', () => {
  // 取证 2026-09-27：CLI 内部用这四条正则判"配额耗尽"，并把结果包成
  // `new QuotaError(msg, {...err, category:"quota"})`。本族此前**一条都盖不住**
  // （语序/词形全不同），实测全部落 `unknown` —— 复跑：tools/recon/quota-coverage-probe.mjs
  // 证据等级：**厂商源码里的判据**，不等于本机真机失败样本（拿到真机原话仍须回填样本出处）。
  for (const text of [
    'exceeded your current quota',
    'insufficient_quota',
    'credit balance is too low',
    'billing_hard_limit_reached',
  ]) {
    const reason = classifyFailure({ exitCode: 0, frameErrorText: text, taskError: true });
    assert.equal(reason.reasonCode, REASON_CODES.QUOTA_EXHAUSTED, `CLI 判据「${text}」必须归 quota_exhausted`);
  }
  // 前哨兵语义照抄厂商：不能被更长 token 的子串误命中
  for (const text of ['myinsufficient_quota_thing', 'xbilling_hard_limit_reached_x']) {
    const reason = classifyFailure({ exitCode: 0, frameErrorText: text, taskError: true });
    assert.notEqual(reason.reasonCode, REASON_CODES.QUOTA_EXHAUSTED, `前后哨兵外不得命中：「${text}」`);
  }
});

test('★ category:"quota" 结构化信号 ⇒ quota_exhausted（CLI 显式自报，此前只认 network）', () => {
  // 逐字：`new ec(rs, \`Quota exceeded: ${el}\`, {...eh, category:"quota"})`
  // 与 3002 的 `category:"network"` 同一档兜底；此前本分支只处理 network ⇒ CLI 已经
  // 自报"这是配额问题"，插件却当普通失败丢掉归因。
  const reason = classifyFailure({
    exitCode: 0,
    errorSignals: [{ status: 400, code: null, category: 'quota', details: 'Quota exceeded: insufficient_quota' }],
  });
  assert.equal(reason.reasonCode, REASON_CODES.QUOTA_EXHAUSTED);
  assert.match(reason.evidence, /category quota/, '证据须自报出处，不得只给一个原因码');
  // 码优先仍然高于 category：已登记的码不能被 category 改判
  const withCode = classifyFailure({
    exitCode: 0,
    errorSignals: [{ status: 502, code: 3002, category: 'quota', details: 'proxy dead' }],
  });
  assert.equal(withCode.reasonCode, REASON_CODES.TRANSPORT_UNREACHABLE, '★ 已登记码 3002 优先于 category 兜底');
});

test('文本兜底四族逐族命中（顺序 network → model → inputLimit → rateLimit）', () => {
  const cases = [
    ['connect ECONNREFUSED 127.0.0.1:9', REASON_CODES.TRANSPORT_UNREACHABLE],
    ['Error: connect ETIMEDOUT 10.0.0.1:443', REASON_CODES.TRANSPORT_UNREACHABLE],
    ['模型不可用，请切换模型后重试', REASON_CODES.MODEL_UNAVAILABLE],
    ['input exceeds the maximum context length', REASON_CODES.INPUT_TOO_LONG],
    ['429 too many requests, please retry later', REASON_CODES.QUOTA_REQUEST_LIMIT],
  ];
  for (const [text, expected] of cases) {
    const reason = classifyFailure({ exitCode: 0, frameErrorText: text, taskError: true });
    assert.equal(reason.reasonCode, expected, `文案「${text}」应归 ${expected}`);
  }
});

test('文本兜底不得越过结构化码：码存在时以码为准', () => {
  // 同一份证据里既有 3002 码、又有会被 model 族命中的文案 ⇒ 必须是码的语义（网络），不能被文案改判。
  const reason = classifyFailure({
    exitCode: 0,
    errorSignals: [{ status: 502, code: 3002, category: 'network', details: 'proxy dead' }],
    frameErrorText: '模型不可用（这是模型正文在讨论上一轮故障，不得改判）',
  });
  assert.equal(reason.reasonCode, REASON_CODES.TRANSPORT_UNREACHABLE);
});

// ── 6. 词汇表自身的一致性 ────────────────────────────────────────────────────────────────────

test('每个原因码都有非空文案；FAILURE_CODES 与"失败"语义一致', () => {
  for (const code of Object.values(REASON_CODES)) {
    assert.equal(typeof REASON_TEXT[code], 'string', `码 ${code} 缺文案`);
    assert.ok(REASON_TEXT[code].length > 0, `码 ${code} 文案为空`);
  }
  assert.equal(FAILURE_CODES.has(REASON_CODES.UNKNOWN), false, 'unknown = 未能判定，不是失败');
  assert.equal(FAILURE_CODES.has(REASON_CODES.ABORTED), false, 'aborted = 调用方取消，不是失败');
  assert.equal(FAILURE_CODES.has(REASON_CODES.OK), false, 'ok 不是失败');
  assert.equal(isFailureCode(undefined), false);
  assert.equal(isFailureCode('not-a-code'), false, '未登记的码不得被当成失败');
});
