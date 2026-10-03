/**
 * T04 · §4.5 参数接受度 + 原因码归一 单测（§10 T04 文件清单指定）。
 *
 * 本文件是 **D-3 的防伪层**：真机上"用不存在的 model 跑一次"的成功/失败，
 * 退出码**说了不算**（`exit code = 0`，证据全在 stderr / result 帧）。所以这里逐条锁定：
 *   · exit 0 + stderr `400 model [...] service info not found` ⇒ **rejected**（不是 ok）
 *   · 有帧（正常样本）⇒ accepted；无帧且 stderr 有错误迹象 ⇒ **unknown**（不拿退出码 0 当接受证据）
 *   · spawnError / aborted ⇒ 永不 accepted
 *   · 逐 flag 归因：证据**点名**谁才算谁被拒，其余保持 unknown（不做有罪推定）
 *   · classifyFailure 优先级链：aborted > spawnError > 参数被拒 > 端口 > 鉴权 > 配额 > 非 0 退出 > 任务错 > unknown
 *     （`配额` 是**无真机样本**的预置形态，见文件末"配额/余额/积分耗尽"一节与 reason-codes.js PATTERNS.quota）
 *   · `stderrExcerpt`：先脱敏再截 2KB（顺序不可颠倒）
 *
 * ★ 样本来源与诚实边界：`400 model [<id>] service info not found` 与
 *   "Currently supported models for your account:" 两段是 RECON §4.5 【实测】的**原文片段**；
 *   本文件里的 stderr 是多行**复原**（真机输出含 17 项模型清单与修复提示，未逐字留存）。
 *   复原只保留"被拒证据"形态本身 —— 断言针对的是形态，不是那句提示的逐字内容。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { FLAG_VERDICTS, INIT_SOURCES, STDERR_EXCERPT_LIMIT, buildLastRun, stderrExcerpt } from '../src/host/launch/verdict.js';
import { REASON_CODES, REASON_TEXT, classifyFailure, isNodeRuntimeMissing } from '../src/host/launch/reason-codes.js';
import { extractSessionId, framesIndicateError, parseFrames, summariseFrames, isValidSessionId } from '../src/host/launch/stream-json.js';

/**
 * 脱敏用的**假** sk- 密钥（故意全字母+012345，绝非真凭据）。
 *
 * ★ 发布卫生（2026-10-04 发布审查）：源码里**不写连续的 `sk-` 长字面量**——那会被
 *   secret-scanner 与 `tools/ci/check-no-credential-echo.mjs` 的固定前缀规则命中（误报噪音）。
 *   两段拼接后运行时值逐字连续，脱敏断言与被测行为**完全不变**。
 */
const FAKE_SK = ['sk-', 'abcdefghijklmnopqrstuvwxyz012345'].join('');

/** D-3 真机样本（复原；见文件头"样本来源"）。 */
const D3_STDERR = [
  '400 model [definitely-not-a-real-model-xyz] service info not found',
  'Currently supported models for your account:',
  '  - deepseek-v3-2',
  '  - glm-4.6',
  'Please pick one of the models above, or omit --model to use the default.',
].join('\n');

/** 正常样本：真机 6 帧序列的最小骨架（RECON §4.4 帧表；thinking/tool 帧可变 ⇒ 此处只放固定帧）。 */
const OK_STDOUT = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-abc_1', uuid: 'u1', cwd: 'C:\\tmp', model: 'auto', permissionMode: 'default' }),
  JSON.stringify({ type: 'assistant', session_id: 'sess-abc_1', message: { content: [{ type: 'text', text: 'pong' }] } }),
  JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sess-abc_1', is_error: false, result: 'pong', duration_ms: 1234, num_turns: 1 }),
].join('\n');

// ───────────────────────── D-3：退出码不可信 ─────────────────────────

test('§4.5：exit 0 **但** stderr 打 400 拒绝 ⇒ flagVerdict=rejected 且 reasonCode=flag_rejected（不是 ok）', () => {
  const rec = buildLastRun({
    argv: ['node', 'cli', '-p', '--model', 'definitely-not-a-real-model-xyz', 'reply ok'],
    flags: [{ flag: '--model', value: 'definitely-not-a-real-model-xyz', source: 'config.model' }],
    exitCode: 0, stdoutText: '', stderrText: D3_STDERR,
  });
  assert.equal(rec.exitCode, 0, '真机就是 0 —— 本用例的意义全在"0 也要判失败"');
  assert.equal(rec.flagVerdict, FLAG_VERDICTS.REJECTED);
  assert.equal(rec.reasonCode, REASON_CODES.FLAG_REJECTED);
  assert.equal(rec.reasonCode === 'ok', false, '★ 绝不能因为 exit 0 就回 ok');
  assert.match(rec.flagEvidence, /400 model \[/);
  // 逐 flag 归因：证据**没有** `--`，只有裸词 `model` ⇒ 必须靠"去前导横线"形态命中
  assert.deepEqual(rec.flags, [{
    flag: '--model', value: 'definitely-not-a-real-model-xyz', source: 'config.model',
    verdict: FLAG_VERDICTS.REJECTED, evidence: rec.flagEvidence,
  }]);
});

test('§4.5（B-T04-4）：逐 flag 归因必须原样保留 `source` —— 客户端靠它把 ⚠ 落到**对应**下拉行', () => {
  // 反例史：attributeFlags 曾用 `({flag, value})` 解构 ⇒ 静默丢掉 source，
  // 客户端只能"整体回滚两行"，把没被拒的那行也显示成"未指定"（假状态）。
  const rec = buildLastRun({
    argv: ['node', 'cli', '-p', '--model', 'nope', '--effort', 'high', '--resume', 'sid-1', 'x'],
    flags: [
      { flag: '--model', value: 'nope', source: 'config.model' },
      { flag: '--effort', value: 'high', source: 'config.effort' },
      { flag: '--resume', value: 'sid-1', source: 'session.cliSessionId' },
    ],
    exitCode: 0, stdoutText: '', stderrText: D3_STDERR,
  });
  assert.deepEqual(rec.flags.map((f) => f.source), ['config.model', 'config.effort', 'session.cliSessionId']);
  const rejected = rec.flags.filter((f) => f.verdict === FLAG_VERDICTS.REJECTED);
  assert.deepEqual(rejected.map((f) => f.source), ['config.model'], '只有被点名的那一行算 rejected');
  // 逐字 flag 名也要在（UI 要用 DESIGN §4.5 的逐字文案「⚠ 该版本不接受 --model 参数」）
  assert.deepEqual(rejected.map((f) => f.flag), ['--model']);
});

test('§4.5：逐 flag 归因不做有罪推定 —— 证据只点名 model 时，effort 仍记 unknown', () => {
  const rec = buildLastRun({
    argv: ['node', 'cli', '-p', '--model', 'nope', '--effort', 'high', 'x'],
    flags: [{ flag: '--model', value: 'nope', source: 'config.model' }, { flag: '--effort', value: 'high', source: 'config.effort' }],
    exitCode: 0, stdoutText: '', stderrText: D3_STDERR,
  });
  assert.equal(rec.flagVerdict, FLAG_VERDICTS.REJECTED, '聚合面按证据整体 rejected（UI 侧据逐 flag 归因精确回滚）');
  const byFlag = Object.fromEntries(rec.flags.map((f) => [f.flag, f.verdict]));
  assert.deepEqual(byFlag, { '--model': FLAG_VERDICTS.REJECTED, '--effort': FLAG_VERDICTS.UNKNOWN });
  assert.match(rec.flags[1].evidence, /未点名/);
});

test('§4.5：正常样本（有帧 + exit 0 + stderr 干净）⇒ accepted + ok；帧里的 sessionId 被抽出', () => {
  const rec = buildLastRun({
    argv: ['node', 'cli', '-p', '--model', 'auto', '--pong'],
    flags: [{ flag: '--model', value: 'auto', source: 'config.model' }],
    exitCode: 0, stdoutText: OK_STDOUT, stderrText: '',
    sessionId: 'sess-abc_1', sessionIdSource: 'init',
  });
  assert.equal(rec.flagVerdict, FLAG_VERDICTS.ACCEPTED);
  assert.equal(rec.reasonCode, 'ok');
  assert.equal(rec.taskError, false);
  assert.equal(rec.frames, 3);
  assert.equal(rec.sessionId, 'sess-abc_1');
  assert.equal(rec.flags[0].verdict, FLAG_VERDICTS.ACCEPTED);
  assert.equal(rec.flags[0].source, 'config.model');
  assert.equal(rec.flags[0].evidence, '');
});

test('§4.5：exit 0 但**无帧且 stderr 有错误迹象** ⇒ unknown（不拿退出码当接受证据）', () => {
  const rec = buildLastRun({
    argv: ['node', 'cli', '-p', 'x'], flags: [], exitCode: 0,
    stdoutText: '', stderrText: 'spawn-related failure: unable to reach service',
  });
  assert.equal(rec.flagVerdict, FLAG_VERDICTS.UNKNOWN);
  assert.notEqual(rec.reasonCode, 'ok');
});

test('§4.5：exit 0 + 无帧但 stderr **干净** ⇒ accepted（stderr 空也算"无错误迹象"）', () => {
  const rec = buildLastRun({ argv: ['node', 'cli', '-p', 'x'], flags: [], exitCode: 0, stdoutText: '', stderrText: '' });
  assert.equal(rec.flagVerdict, FLAG_VERDICTS.ACCEPTED);
});

test('§4.5：**有帧**时噪声 stderr 不得推翻 accepted（正向证据优先于噪声）', () => {
  // 真机 stderr 会带良性告警（如本机 UNDICI/EHPA、可选缓存读取失败）——这些**不是**拒绝证据。
  // 若把规则收窄成"stderr 干净才 accepted"，本用例必红（该分支由变异实验校准，见 CONSTRUCTION-LOG §16）。
  const rec = buildLastRun({
    argv: ['node', 'cli', '-p', '--model', 'auto', 'hi'],
    flags: [{ flag: '--model', value: 'auto', source: 'config.model' }],
    exitCode: 0, stdoutText: OK_STDOUT,
    stderrText: '(node:123) Warning: failed to read optional cache, continuing',
  });
  assert.equal(rec.flagVerdict, FLAG_VERDICTS.ACCEPTED, '有帧 ⇒ argv 解析已通过、任务已执行：这是正向证据');
  assert.equal(rec.reasonCode, 'ok');
  assert.equal(rec.flags[0].verdict, FLAG_VERDICTS.ACCEPTED);
});

test('§4.5：spawnError / aborted / 非 0 退出 ⇒ 永不 accepted', () => {
  const spawn = buildLastRun({ argv: [], exitCode: null, spawnError: 'ENOENT', stdoutText: OK_STDOUT, stderrText: '' });
  assert.equal(spawn.flagVerdict, FLAG_VERDICTS.UNKNOWN);
  assert.equal(spawn.reasonCode, REASON_CODES.START_FAILED);

  const aborted = buildLastRun({ argv: [], exitCode: 0, aborted: true, stdoutText: OK_STDOUT, stderrText: '' });
  assert.equal(aborted.flagVerdict, FLAG_VERDICTS.UNKNOWN);
  assert.equal(aborted.reasonCode, REASON_CODES.ABORTED);

  const nonZero = buildLastRun({ argv: [], exitCode: 3, stdoutText: OK_STDOUT, stderrText: '' });
  assert.equal(nonZero.flagVerdict, FLAG_VERDICTS.UNKNOWN);
  assert.equal(nonZero.reasonCode, REASON_CODES.EXIT_NONZERO);
});

test('§4.5：result 帧 is_error=true（exit 0）⇒ taskError + reasonCode=task_error（D-3 的另一半）', () => {
  const stdout = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    JSON.stringify({ type: 'result', subtype: 'error_during_execution', session_id: 's1', is_error: true, result: 'boom' }),
  ].join('\n');
  const rec = buildLastRun({ argv: [], exitCode: 0, stdoutText: stdout, stderrText: '' });
  assert.equal(rec.taskError, true);
  assert.equal(rec.reasonCode, REASON_CODES.TASK_ERROR);
  assert.equal(rec.taskError && rec.reasonCode === 'ok', false);
});

// ───────────────────────── §4.5 四字段契约 + 脱敏/截断 ─────────────────────────

test('§4.5：四字段逐字形态 —— argv 是**字符串**（客户端契约）、exitCode 非整数时回落 -1', () => {
  const rec = buildLastRun({ argv: ['node', 'cli', '-p', '--model', 'auto', 'hi'], flags: [], exitCode: null });
  assert.equal(typeof rec.argv, 'string');
  assert.equal(rec.argv, 'node cli -p --model auto hi');
  assert.equal(rec.exitCode, -1, 'exitCode 缺失 ⇒ -1（不是 null/undefined：客户端按数字渲染）');
  assert.equal(rec.stderrExcerpt, '');
  assert.equal(Object.keys(rec).includes('flagVerdict'), true);
});

test('§4.5：argv 与 stderrExcerpt 都**先脱敏再截断**（凭据不落记录）', () => {
  const rec = buildLastRun({
    argv: ['node', 'cli', '--api-key', 'sk-live-abcdefgh', '-p', 'hi'], flags: [], exitCode: 0,
    stderrText: `Authorization: Bearer abcdefghijklmnop\n${'x'.repeat(STDERR_EXCERPT_LIMIT + 100)}`,
  });
  assert.equal(rec.argv.includes('sk-live-abcdefgh'), false);
  assert.equal(rec.stderrExcerpt.includes('abcdefghijklmnop'), false);
  assert.match(rec.stderrExcerpt, /截断：stderr 共 \d+ 字符/);
  assert.equal(rec.stderrBytes > STDERR_EXCERPT_LIMIT, true, '字节数按**原文**统计（截断只影响摘录）');
});

test('§4.5 argv 二层脱敏：位置参数里的值体凭据（Bearer / sk-）必须过 redactText（一层按 flag 名管不到）', () => {
  // ★ 2026-09-22 P1：`argv` 字段只过了 redactArgv（只认 `--flag value` / `--flag=value` 的旗标名）。
  //   位置参数与"旗标名不敏感"的值体（`-p Bearer …`、`--model sk-…`）原样进 lastRun ⇒ 凭据落记录。
  const rec = buildLastRun({
    argv: ['node', 'cli', '-p', 'Bearer abcdefghijklmnop', '--model', FAKE_SK, 'hi'],
    flags: [], exitCode: 0, stdoutText: '', stderrText: '',
  });
  assert.equal(rec.argv.includes('abcdefghijklmnop'), false, '★ 位置参数不在 `--flag value` 形态里 ⇒ 一层 redactArgv 放行，二层 redactText 必须管住');
  assert.equal(rec.argv.includes(FAKE_SK), false, '★ 值体 sk-（旗标名 --model 不敏感）同样必须打码');
  assert.equal(rec.argv.includes('$1'), false, '脱敏产物不得出现替换符字面量');
  assert.ok(rec.argv.startsWith('node cli -p'), '正控：命令本身逐字保留（脱敏不得吃掉 argv 的可读部分）');
});

test('§4.5：stderrExcerpt 顺序锁 —— 先脱敏再截断（先截断会把凭据切半而逃过脱敏）', () => {
  const secret = 'sk-live-abcdefgh'; // 17 字符；把 limit 卡在它中间
  const text = `${'a'.repeat(10)} ${secret} tail`;
  const cut = stderrExcerpt(text, 15);
  assert.equal(cut.includes('sk-live'), false, '若先截断，会留下 `sk-live` 半截明文 —— 此断言即为顺序锁');
});

// ───────────────────────── reason-codes：归一优先级链 ─────────────────────────

test('reason-codes：优先级链 aborted > spawnError > 参数被拒 > 端口 > 鉴权 > 配额 > 非 0 退出 > 任务错 > unknown', () => {
  const C = REASON_CODES;
  const only = (input) => classifyFailure(input).reasonCode;
  // 同时给多个信号 ⇒ 取链路里更靠前者（顺序即语义）
  assert.equal(only({ aborted: true, spawnError: 'x', exitCode: 9, taskError: true }), C.ABORTED);
  assert.equal(only({ spawnError: 'ENOENT', exitCode: 9, taskError: true, flagVerdict: 'rejected' }), C.START_FAILED);
  assert.equal(only({ flagVerdict: 'rejected', exitCode: 9, stderrText: 'port 3000 in use', taskError: true }), C.FLAG_REJECTED);
  assert.equal(only({ exitCode: 9, stderrText: 'Error: listen EADDRINUSE: address already in use 127.0.0.1:3000', taskError: true }), C.PORT_CONFLICT);
  assert.equal(only({ exitCode: 9, stderrText: 'invalid api key provided', taskError: true }), C.AUTH_FAILED);
  assert.equal(only({ exitCode: 9, taskError: true }), C.EXIT_NONZERO);
  assert.equal(only({ exitCode: 0, taskError: true, resultText: 'boom' }), C.TASK_ERROR);
  assert.equal(only({ exitCode: 0 }), C.UNKNOWN, '无任何信号 ⇒ unknown（不伪装成成功，也不冒充已知原因）');
});

test('reason-codes：isNodeRuntimeMissing 双形态（Error / 字符串）—— 两处调用共用同一判据', () => {
  assert.equal(isNodeRuntimeMissing(new Error('workbuddy: no node runtime: x')), true);
  assert.equal(isNodeRuntimeMissing('workbuddy: no node runtime: configured nodePath is not a file: "p"'), true);
  assert.equal(isNodeRuntimeMissing('ENOENT: no such file'), false);
  assert.equal(isNodeRuntimeMissing(undefined), false);
  assert.equal(isNodeRuntimeMissing(null), false);
  // 字符串形态经 classifyFailure 必须落到专用码（回归锁：曾经只认 Error ⇒ 该分支死代码）
  assert.equal(classifyFailure({ spawnError: 'workbuddy: no node runtime: x' }).reasonCode, REASON_CODES.NODE_RUNTIME_NOT_FOUND);
});

// ───────────────────────── stream-json 抽取面（§5.3 / W-10 / D-4） ─────────────────────────

test('stream-json：session_id 抽自 init 帧（权威），缺 init 时任一帧兜底', () => {
  const withInit = extractSessionId(OK_STDOUT); // ★ 入参是**文本**（本函数内部自行 parseFrames）
  assert.equal(withInit.cliSessionId, 'sess-abc_1');
  assert.equal(withInit.source, 'init');
  assert.equal(withInit.cwd, 'C:\\tmp');
  assert.equal(withInit.model, 'auto');
  assert.equal(withInit.frames, 3);

  const noInit = extractSessionId([
    JSON.stringify({ type: 'assistant', session_id: 'sess-only-frame' }),
    JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sess-only-frame', is_error: false }),
  ].join('\n'));
  assert.equal(noInit.cliSessionId, 'sess-only-frame');
  assert.equal(noInit.source, 'frame');
  // 只从 init 帧取会话事实：无 init ⇒ 不"就近取值"（避免把工具/子代理上下文当成会话事实）
  assert.equal(noInit.cwd, null);
  assert.equal(noInit.model, null);
});

test('stream-json：抽不到就**不猜** —— 非法 session_id 与无 ID 输出都返回 null', () => {
  const illegal = extractSessionId(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'has space' }));
  assert.equal(illegal.cliSessionId, null);
  assert.equal(illegal.source, null);
  assert.equal(extractSessionId('no frames here').cliSessionId, null);
});

test('stream-json：非 JSON 行不致命（D-4 帧序列非固定）—— 计 parseErrors，残帧不抛而是标记 incomplete', () => {
  const mixed = ['plain text noise', ...OK_STDOUT.split('\n'), '{ broken json'].join('\n');
  const parsed = parseFrames(mixed);
  assert.equal(parsed.parseErrors, 2, '两行非 JSON：一行噪声 + 一行残帧');
  assert.equal(parsed.frames.length, 4, '3 个真帧 + 1 个残帧（残帧也入列，供上层判断"输出被截断"）');
  assert.equal(parsed.frames.filter((f) => f.incomplete === true).length, 1);
  assert.equal(parsed.frames.at(-1).incomplete, true, '只有**末行**解析失败才按残帧处理（窗口边界语义）');
  assert.equal(parsed.trailingPartial, true);
  const s = summariseFrames(parsed);
  assert.equal(s.resultSubtype, 'success');
  assert.equal(framesIndicateError(s), false);
  assert.equal(s.incomplete, true, '残帧 ⇒ 摘要必须自曝不完整（不静默当成完整输出）');
});

test('stream-json：session id 合法性按 RECON §4.2 字符集 —— 首字符须字母数字，禁空格/引号', () => {
  for (const good of ['a', 'sess-1_ab:C', 'A'.repeat(128)]) assert.equal(isValidSessionId(good), true, good);
  for (const bad of ['', '-lead', '_lead', 'has space', 'quote"', 'semi;colon', 'A'.repeat(129)]) {
    assert.equal(isValidSessionId(bad), false, JSON.stringify(bad));
  }
});

// ───────────────────────── 端到端形态：真机 stderr 走 buildLastRun ─────────────────────────

test('verdict：未知 model 的完整链路 —— reasonText 人可读且证据保留原文片段', () => {
  const rec = buildLastRun({
    argv: ['node', 'cli', '-p', '--model', 'definitely-not-a-real-model-xyz', 'reply ok'],
    flags: [{ flag: '--model', value: 'definitely-not-a-real-model-xyz', source: 'config.model' }],
    exitCode: 0, stdoutText: '', stderrText: D3_STDERR,
  });
  assert.equal(typeof rec.reasonText, 'string');
  assert.equal(rec.reasonText.length > 0, true);
  assert.equal(rec.reasonText.includes('undefined'), false);
  assert.equal(rec.flags[0].verdict, FLAG_VERDICTS.REJECTED, '端到端链路里逐 flag 归因同样成立');
  assert.match(rec.stderrExcerpt, /Currently supported models for your account:/);
  assert.equal(rec.stdoutBytes, 0);
});

// ───────────────── 真机取证修正（2026-09-19 本地实测，WorkBuddy 2.137.1） ─────────────────
//
// 下面四条锁的是**RECON D-3 假设与真机不符**之后修正的代码路径（结论只在本文件与宿主注释里，
// 真机原始输出未入库）。修正要点：证据面 ≠ stderr；证据提取 ≠ "命中片段"；归因 ≠ 子串包含。

/** 真机 `--model <非法>` 的真实形态：stderr 只有 Node 警告，400 落在 assistant 帧 + result.errors[]。 */
const LIVE_INVALID_MODEL_STDOUT = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'live-1', model: '__dcp_probe__', permissionMode: 'default' }),
  JSON.stringify({ type: 'assistant', session_id: 'live-1', message: { content: [{ type: 'text', text: '400 model [__dcp_probe__] service info not found (trace: abc)\nCurrently supported models for your account:\n  - auto\n  - hy3\nPlease use --model <model_id> or omit it.' }] } }),
  JSON.stringify({ type: 'result', subtype: 'error_during_execution', session_id: 'live-1', is_error: true, errors: ['400 model [__dcp_probe__] service info not found (trace: abc)'], num_turns: 1 }),
].join('\n');
const LIVE_NODE_WARN = '(node:20672) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental, expect them to change at any time.\n';

test('真机复现：exit 0 + stderr 只有 Node 警告 ⇒ 仍须 rejected，且证据来自帧（不是 stderr）', () => {
  const rec = buildLastRun({
    argv: ['node', 'cli', '-p', '--output-format', 'stream-json', '--model', '__dcp_probe__', 'hi'],
    flags: [
      { flag: '--output-format', value: 'stream-json', source: 'plugin.outputFormat' },
      { flag: '--model', value: '__dcp_probe__', source: 'config.model' },
    ],
    exitCode: 0, stdoutText: LIVE_INVALID_MODEL_STDOUT, stderrText: LIVE_NODE_WARN,
  });
  assert.equal(rec.flagVerdict, FLAG_VERDICTS.REJECTED, '★ 真机 --model 非法时 exit code = 0，不得据此判 accepted');
  assert.equal(rec.reasonCode, REASON_CODES.FLAG_REJECTED);
  assert.match(rec.flagEvidence, /400 model \[__dcp_probe__\]/, '被拒证据必须来自帧内文本');
  assert.equal(rec.stderrExcerpt.includes('400 model'), false, '诚实性：stderr 里确实没有 400 —— 摘录不得伪造');
  assert.match(rec.stderrExcerpt, /UNDICI-EHPA/);
  assert.equal(rec.flags.find((f) => f.source === 'config.model').verdict, FLAG_VERDICTS.REJECTED);
  assert.equal(rec.flags.find((f) => f.source === 'plugin.outputFormat').verdict, FLAG_VERDICTS.UNKNOWN, '未被点名者不得被推定有罪');
  assert.equal(rec.initModel, '__dcp_probe__', 'init 帧回显的就是被拒值（不构成"被接受"的证据）');
});

test('真机复现：任务态失败时证据取自 result.errors[]（`result字段` 缺失时不再是空证据）', () => {
  // ★ 判别力：旧实现只读 `result`/`error` 字段 ⇒ 证据为 ''（"任务失败"却给不出任何原因）。
  const rec = buildLastRun({
    argv: ['node', 'cli', '-p', 'hi'], flags: [], exitCode: 0,
    stdoutText: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'live-2', model: 'auto' }),
      JSON.stringify({ type: 'result', subtype: 'error_during_execution', session_id: 'live-2', is_error: true, errors: ['You have reached your credit usage limit.'] }),
    ].join('\n'),
    stderrText: LIVE_NODE_WARN,
  });
  assert.equal(rec.reasonCode, REASON_CODES.TASK_ERROR);
  assert.match(rec.reasonEvidence, /credit usage limit/, '失败原因必须可读（旧实现此处为空串）');
});

test('真机复现（③b）：CLI 未知选项 ⇒ 证据必须**点名 flag 名**，否则无法告诉用户是哪个参数被拒', () => {
  // ★ 判别力：旧实现只取正则命中片段（`unknown option`），而 flag 名在命中点**之后** ⇒ 归因全 unknown。
  const rec = buildLastRun({
    argv: ['node', 'cli', '-p', '--dcp-nonexistent', 'x', 'hi'],
    flags: [
      { flag: '--model', value: 'auto', source: 'config.model' },
      { flag: '--dcp-nonexistent', value: 'x', source: 'config.effort' },
    ],
    exitCode: 1, stdoutText: '', stderrText: "error: unknown option '--dcp-nonexistent'\n",
  });
  assert.equal(rec.flagVerdict, FLAG_VERDICTS.REJECTED);
  assert.match(rec.flagEvidence, /--dcp-nonexistent/, '证据窗口必须包含被拒的 flag 名');
  assert.equal(rec.flags.find((f) => f.source === 'config.effort').verdict, FLAG_VERDICTS.REJECTED, '被点名的行必须判 rejected');
  assert.equal(rec.flags.find((f) => f.source === 'config.model').verdict, FLAG_VERDICTS.UNKNOWN, '未被点名的行保持 unknown');
});

test('归因判别力：取值是子串不得误伤另一行（model 取值含档位词 `high` ⇒ effort 行不得被点名）', () => {
  const stderr = '400 model [gpt-5-high] service info not found\nPlease pick one of the models above.';
  const rec = buildLastRun({
    argv: ['node', 'cli', '-p', '--model', 'gpt-5-high', '--effort', 'high', 'hi'],
    flags: [
      { flag: '--model', value: 'gpt-5-high', source: 'config.model' },
      { flag: '--effort', value: 'high', source: 'config.effort' },
    ],
    exitCode: 0, stdoutText: '', stderrText: stderr,
  });
  assert.equal(rec.flags.find((f) => f.source === 'config.model').verdict, FLAG_VERDICTS.REJECTED);
  assert.equal(rec.flags.find((f) => f.source === 'config.effort').verdict, FLAG_VERDICTS.UNKNOWN, 'effort 的取值 `high` 是 model 取值的子串 —— 不得据此判它被拒');
});

test('形态健壮性：flags 含 null / 非字符串 flag 不得抛（记录会被写盘并再度读回）', () => {
  const rec = buildLastRun({
    argv: ['node', 'cli', '-p', 'hi'], flags: [null, { flag: 123, value: 'x', source: 'config.model' }, { flag: '--model', value: 'auto', source: 'config.model' }],
    exitCode: 1, stdoutText: '', stderrText: "error: unknown option '--model'\n",
  });
  assert.equal(rec.flags.length, 3, '逐条保留（不静默丢条目）');
  assert.equal(rec.flags[0].verdict, FLAG_VERDICTS.UNKNOWN);
  assert.equal(rec.flags[1].verdict, FLAG_VERDICTS.UNKNOWN);
  assert.equal(rec.flags[2].verdict, FLAG_VERDICTS.REJECTED);
});

test('脱敏：被拒证据与原因证据同样要过 redactText（不落凭据）', () => {
  const rec = buildLastRun({
    argv: ['node', 'cli', '-p', '--model', FAKE_SK, 'hi'],
    flags: [{ flag: '--model', value: FAKE_SK, source: 'config.model' }],
    exitCode: 0, stdoutText: '',
    stderrText: `error: unknown option for key ${FAKE_SK} (model)\n`,
  });
  assert.equal(rec.flagEvidence.includes(FAKE_SK), false, '证据不得回传明文密钥');
  assert.equal(rec.reasonEvidence.includes(FAKE_SK), false);
});

// ─────────────── 真机成功路径（2026-09-19 实际委派一次 WorkBuddy 成功后补的盲区） ───────────────
//
// 为什么之前没锁住：本文件 6 条真机形态测试**全是失败路径**，成功路径一条都没有 ⇒
// `reasonCode` 与 `reasonText` 出自两处判定（verdict 覆写 code / classifyFailure 给 text）这件事
// 一直没被任何断言碰到。真机一跑就暴露：
//   { reasonCode: "ok", reasonText: "未能归一出失败原因（保留原始摘录供人工判断）。" }
// 危害面不是 GUI 卡片（client.js:378 有 `reasonCode !== 'ok'` 守卫），而是 **lastRun 经
// workbuddy_status 工具直出给模型** ⇒ 模型会把一次成功报成失败。

/**
 * 真机成功形态。帧序列/字段名逐字取自实际委派（job workbuddy-1）的 stdout；
 * thinking 正文与 usage 计数为可读性截断/省略，形态本身未改（断言针对形态，不针对正文）。
 */
const LIVE_OK_STDOUT = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'live-ok', apiKeySource: 'copilot.tencent.com', cwd: 'C:\\Users\\demo\\AppData\\Local\\Temp\\dsh-workbuddy\\sess', tools: ['Read', 'Bash'], mcp_servers: [], model: 'auto', permissionMode: 'default' }),
  JSON.stringify({ type: 'system', subtype: 'status', status: null, session_id: 'live-ok' }),
  JSON.stringify({ type: 'assistant', session_id: 'live-ok', message: { id: 'gen-1', content: [{ type: 'thinking', thinking: '…（真机 thinking 正文已截断）', signature: '' }], model: 'hy4-preview-f', role: 'assistant', type: 'message', usage: { input_tokens: 0, output_tokens: 0 } } }),
  JSON.stringify({ type: 'assistant', session_id: 'live-ok', message: { id: 'gen-2', content: [{ type: 'text', text: 'DCP_E2E_OK' }], model: 'hy4-preview-f', role: 'assistant', type: 'message', usage: { input_tokens: 27328, output_tokens: 97 } } }),
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'DCP_E2E_OK', session_id: 'live-ok', duration_ms: 8528, num_turns: 3, total_cost_usd: 0, permission_denials: [] }),
].join('\n');

test('真机复现（成功路径）：accepted + exit 0 + result/success ⇒ reasonText 必须与 ok 配套', () => {
  const rec = buildLastRun({
    argv: ['node', 'cli', '-p', '--output-format', 'stream-json', 'Reply with exactly: DCP_E2E_OK'],
    flags: [{ flag: '--output-format', value: 'stream-json', source: 'plugin.outputFormat' }],
    exitCode: 0, stdoutText: LIVE_OK_STDOUT, stderrText: LIVE_NODE_WARN,
  });
  assert.equal(rec.flagVerdict, FLAG_VERDICTS.ACCEPTED);
  assert.equal(rec.resultSubtype, 'success');
  assert.equal(rec.taskError, false);
  assert.equal(rec.reasonCode, REASON_CODES.OK);
  // ★ 判别力：修好之前这里拿到的是 classifyFailure 的 UNKNOWN 兜底文案。
  assert.equal(rec.reasonText, REASON_TEXT[REASON_CODES.OK]);
  assert.equal(rec.reasonText.includes('未能归一'), false, '成功载荷不得复用 UNKNOWN 的"未能归一"文案');
  // 成功并不等于"证据全空"：stderr 里的 Node 警告是真机事实，照实保留（不粉饰）。
  assert.match(rec.stderrExcerpt, /UNDICI-EHPA/);
});

test('矛盾对不可构造：`reasonCode === ok` 与 `REASON_TEXT.ok` 必须同时成立或同时不成立', () => {
  // 不变量式断言（而非单点）：任何形态下都不许出现 "ok 码 + 失败文案" 或 "失败码 + ok 文案"。
  const shapes = [
    { name: '成功', input: { exitCode: 0, stdoutText: LIVE_OK_STDOUT, stderrText: LIVE_NODE_WARN, flags: [] } },
    { name: '参数被拒', input: { exitCode: 0, stdoutText: LIVE_INVALID_MODEL_STDOUT, stderrText: LIVE_NODE_WARN, flags: [] } },
    { name: '任务错', input: { exitCode: 0, stdoutText: JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['credit usage limit'] }), stderrText: LIVE_NODE_WARN, flags: [] } },
    { name: '非 0 退出', input: { exitCode: 2, stdoutText: '', stderrText: 'boom\n', flags: [] } },
    { name: '端口冲突', input: { exitCode: 1, stdoutText: '', stderrText: 'EADDRINUSE: address already in use\n', flags: [] } },
    { name: '鉴权失败', input: { exitCode: 1, stdoutText: '', stderrText: '401 unauthorized\n', flags: [] } },
    { name: '被取消', input: { exitCode: null, aborted: true, stdoutText: '', stderrText: '', flags: [] } },
    { name: '启动失败', input: { exitCode: null, spawnError: 'ENOENT', stdoutText: '', stderrText: '', flags: [] } },
    { name: 'exit 0 但无帧且 stderr 有错迹象（不拿退出码当接受证据）', input: { exitCode: 0, stdoutText: '', stderrText: 'Error: something failed\n', flags: [] } },
  ];
  for (const { name, input } of shapes) {
    const rec = buildLastRun({ argv: ['node', 'cli', '-p', 'hi'], ...input });
    if (rec.reasonCode === REASON_CODES.OK) {
      assert.equal(rec.reasonText, REASON_TEXT[REASON_CODES.OK], `${name}: ok 码必须配 ok 文案`);
    } else {
      assert.notEqual(rec.reasonText, REASON_TEXT[REASON_CODES.OK], `${name}: 非 ok 码不得配 ok 文案`);
    }
    assert.equal(typeof rec.reasonText === 'string' && rec.reasonText !== '', true, `${name}: reasonText 不得为空`);
  }
});

// ───────────── 配额/余额/积分耗尽（★ 无真机样本 —— 预置形态，见 reason-codes.js PATTERNS.quota） ─────────────
//
// 为什么要这一节：任务**执行中途**失败（典型症状"积分没了"）时主控必须第一时间知道。dsh 作业层的
// notice 只带 kind/label/status、**不带原因**，而 status 只看退出码 ⇒ 原因码这一层认不出配额耗尽，
// 它就会落到 `unknown`，人看到的是"未能归一出失败原因"。
//
// ★ 诚实边界（本节的形态**全部没有真机样本**）：下面这些 stderr/帧内文本是按"用户报告的症状 + 通用
//   文案"预置的，**不是**实测取证结果；断言锁的是**归类行为**（进哪条分支、算不算成功），不是真机逐字原文。
//   一旦拿到真机原话，必须回填登记并复核这些断言。
//
// ★ 结构性事实（决定了本节断言为什么用 `reasonCode`/`reasonText` 这一对来锁"成功与否"）：
//   `succeeded` 是 buildLastRun 的**内部变量**，既不出现在 LastRunRecord 里、也未导出 ⇒ 无法直接断言。
//   其可观察后果就是 `reasonCode === 'ok'` ⇒ 与 `REASON_TEXT.ok` 配套（失败码 ⇒ 失败文案），
//   与上面"矛盾对不可构造"不变量、既有成功用例（真机成功路径）是同一手法：`ok` ⇔ `succeeded`。

test('配额（a）：exit 0 + stderr `insufficient credits` ⇒ quota_exhausted，且**不算成功**（不是 unknown、不是 ok）', () => {
  const rec = buildLastRun({
    argv: ['node', 'cli', '-p', 'hi'], flags: [], exitCode: 0, stdoutText: '',
    stderrText: 'insufficient credits: please recharge your account\n',
  });
  // ★ 判别力所在：这三个条件同时为真时，旧实现（无配额码/未排除配额）会给出 `ok` —— 把失败报成成功。
  //   它们也是"这次失败**只能**由配额分支造成"的证明（不是 accepted 变 unknown 之类的旁路）。
  assert.equal(rec.flagVerdict, FLAG_VERDICTS.ACCEPTED, '参数面是干净的：失败判定的唯一来源只能是配额文本');
  assert.equal(rec.taskError, false, '帧面没有 is_error：不得靠 task_error 顶包');
  assert.equal(rec.exitCode, 0, '★ 真机退出码不可信：exit 0 也必须能被配额文本判失败');
  assert.equal(rec.reasonCode, REASON_CODES.QUOTA_EXHAUSTED);
  assert.notEqual(rec.reasonCode, REASON_CODES.UNKNOWN, '配额是可识别原因，不得落到"未能归一"');
  assert.notEqual(rec.reasonCode, REASON_CODES.OK, '配额文本 ⇒ succeeded === false');
  assert.equal(rec.reasonText, REASON_TEXT[REASON_CODES.QUOTA_EXHAUSTED], '文案必须与失败码同源（不得复用 ok 文案）');
  assert.match(rec.reasonEvidence, /insufficient credits/, '证据保留原文供人工判断');
});

test('配额（b）：中文形态 积分不足 / 余额不足 / 配额不足 / 额度已用尽 ⇒ 同上（exit 0 也不算成功）', () => {
  const cases = ['错误：积分不足，请先充值后再试\n', '账户余额不足\n', '配额不足\n', '本周期额度已用尽\n'];
  for (const stderrText of cases) {
    const rec = buildLastRun({ argv: ['node', 'cli', '-p', 'hi'], flags: [], exitCode: 0, stdoutText: '', stderrText });
    assert.equal(rec.flagVerdict, FLAG_VERDICTS.ACCEPTED, `${stderrText}: 参数面干净（同 (a) 的判别力前提）`);
    assert.equal(rec.taskError, false, `${stderrText}: 帧面无错`);
    assert.equal(rec.reasonCode, REASON_CODES.QUOTA_EXHAUSTED, `${stderrText}: 中文形态必须能认`);
    assert.notEqual(rec.reasonCode, REASON_CODES.OK, `${stderrText}: 不得算成功`);
    assert.equal(rec.reasonText, REASON_TEXT[REASON_CODES.QUOTA_EXHAUSTED], `${stderrText}: 文案同源`);
  }
});

test('配额（c）防误判守卫：配额词只出现在 stdout 正文 ⇒ **不得**判成配额，成功不得被判成失败', () => {
  // 命中面收窄的守卫：stdout 里含**模型自己写的正文**，一次正常成功的回答完全可能在复述/讨论
  // "配额不足"（例如它在解释别的东西、或把用户给的字串写进回答）。拿 stdout 匹配 ⇒ 成功判失败。
  const rec = buildLastRun({
    argv: ['node', 'cli', '-p', 'hi'], flags: [], exitCode: 0,
    stdoutText: 'quota exceeded — 积分不足，请充值\n', stderrText: '',
  });
  assert.notEqual(rec.reasonCode, REASON_CODES.QUOTA_EXHAUSTED, '★ 只出现在 stdout 的配额词不得触发配额判定');
  assert.equal(rec.reasonCode, REASON_CODES.OK, 'stderr/帧内都没有配额证据 ⇒ 这就是一次成功');
  assert.equal(rec.reasonText, REASON_TEXT[REASON_CODES.OK], '成功载荷必须配 ok 文案');
  assert.equal(rec.reasonEvidence, '', '不得凭空造证据');
  // 本守卫覆盖**原始 stdout 兜底面**；**帧正文面**由下面 (d) 的 `taskError` 门控守卫覆盖。
});

test('配额（d）：帧内错误面（frameErrorText）生效 ⇒ quota_exhausted，不退化成 task_error', () => {
  // 端到端：真机形态的配额文本落在 result 帧 `errors[]`（stream-json 收集进 frameErrorText），stderr 干净。
  const stdout = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'quota-1', model: 'auto' }),
    JSON.stringify({ type: 'result', subtype: 'error_during_execution', session_id: 'quota-1', is_error: true, errors: ['insufficient credits'] }),
  ].join('\n');
  const rec = buildLastRun({ argv: ['node', 'cli', '-p', 'hi'], flags: [], exitCode: 0, stdoutText: stdout, stderrText: '' });
  assert.equal(rec.reasonCode, REASON_CODES.QUOTA_EXHAUSTED);
  assert.notEqual(rec.reasonCode, REASON_CODES.TASK_ERROR, '有配额证据时不得退化成泛化的"任务失败"');
  assert.match(rec.reasonEvidence, /insufficient credits/, '证据取自帧内错误文本');
  // 直连判据：证明帧面是**独立**证据面（若实现只认 stderr，这里会落到 unknown）
  assert.equal(
    classifyFailure({ exitCode: 0, taskError: true, frameErrorText: 'quota exceeded' }).reasonCode,
    REASON_CODES.QUOTA_EXHAUSTED,
  );
  // ★ 断言更换（2026-09-19，T04 集成）：这里原先直接把"助手正文"塞进 `frameErrorText` 再要求不判配额，
  //   其前提是"stream-json.js 把 `message.content[].text` 也拼进 frameErrorText"。该前提**已被修掉**：
  //   正文现在只进 `frameProseText`（展示面），`frameErrorText` 只装错误字段。
  //   前提消失后，旧断言退化成"要求实现无视一个它根本收不到的入参"——没有检测力（它红过一轮，红的原因
  //   是恰好测到了别的机制）。换成同一意图在**生产路径**上的形式，并**故意把 stream-json 准入闸敞开**
  //   （`flags` 带 `plugin.outputFormat`），这样拦住假证据的只能是"正文/错误字段分离"本身：
  //   正文复述 `unknown option` / `积分不足` 若进了 frameErrorText，本断言立刻双红
  //   （reasonCode=quota_exhausted 且 flagVerdict=rejected ⇒ 假归因 + 假回滚）。
  const STREAM_JSON_FLAG = [{ flag: '--output-format', value: 'stream-json', source: 'plugin.outputFormat' }];
  const proseStdout = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'prose-1', model: 'auto' }),
    JSON.stringify({ type: 'assistant', session_id: 'prose-1', message: { content: [{ type: 'text', text: '你遇到的报错是 unknown option --nope，也可能是积分不足。' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', session_id: 'prose-1', is_error: false, result: 'DONE' }),
  ].join('\n');
  const proseRec = buildLastRun({
    argv: ['node', 'cli', '-p', 'hi'], flags: STREAM_JSON_FLAG, exitCode: 0, stdoutText: proseStdout, stderrText: '',
  });
  assert.notEqual(proseRec.reasonCode, REASON_CODES.QUOTA_EXHAUSTED, '★ 正文复述配额词不得当配额证据');
  assert.equal(proseRec.flagVerdict, 'accepted', '★ 正文复述拒参词不得当拒参证据（否则触发假回滚）');
  assert.equal(proseRec.reasonEvidence, '', '拒参证据面必须为空：正文不是证据');
  // 端到端负控：assistant 正文提到配额 + result 帧是**成功**帧 ⇒ 这是一次成功，不是配额耗尽
  const successStdout = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'quota-ok', model: 'auto' }),
    JSON.stringify({ type: 'assistant', session_id: 'quota-ok', message: { content: [{ type: 'text', text: '已按你的要求把"积分不足"的提示文案改写好了。' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', session_id: 'quota-ok', is_error: false, result: 'DONE' }),
  ].join('\n');
  const okRec = buildLastRun({ argv: ['node', 'cli', '-p', 'hi'], flags: [], exitCode: 0, stdoutText: successStdout, stderrText: '' });
  assert.equal(okRec.reasonCode, REASON_CODES.OK, '★ 正文复述配额词不得把成功报成失败');
  assert.equal(okRec.flagVerdict, 'accepted', '成功帧 + 干净的 stderr ⇒ 参数被接受');
});

test('配额（e）优先级不回归：同时出现 401/403 与配额词 ⇒ **仍然**归 auth_failed', () => {
  const only = (input) => classifyFailure(input).reasonCode;
  assert.equal(only({ exitCode: 1, stderrText: '401 unauthorized: insufficient credits\n' }), REASON_CODES.AUTH_FAILED,
    '★ 凭据无效 ≠ 账户没额度：鉴权证据必须优先，否则会把人指向"去充值"这个错误动作');
  assert.equal(only({ exitCode: 0, stderrText: '403 forbidden — 余额不足\n' }), REASON_CODES.AUTH_FAILED);
  // 反向锁：**没有**鉴权证据时配额才生效（避免两个原因码互相吞并）
  assert.equal(only({ exitCode: 0, stderrText: 'insufficient credits\n' }), REASON_CODES.QUOTA_EXHAUSTED);
});

test('配额：位置理由可证伪 —— 鉴权 > 配额 > 非 0 退出 / 任务错；且文案可执行、证据留痕', () => {
  const only = (input) => classifyFailure(input).reasonCode;
  // ① 排在 exit 码**之前**：真机退出码不可信，配额耗尽既可能 exit 1 也可能 exit 0
  assert.equal(only({ exitCode: 1, stderrText: 'insufficient credits\n' }), REASON_CODES.QUOTA_EXHAUSTED,
    'exit 1 + 配额文本 ⇒ 归配额（若排在 exit 码之后会被 exit_nonzero 抢走）');
  // ② 由此也先于 taskError：帧内配额证据比泛化的 task_error 更可执行
  assert.equal(only({ exitCode: 0, taskError: true, frameErrorText: '积分不足\n' }), REASON_CODES.QUOTA_EXHAUSTED);
  // ③ 值域冻结为逐字 `quota_exhausted`（跨进程/记录载荷的契约，改名即破坏消费者）
  assert.equal(REASON_CODES.QUOTA_EXHAUSTED, 'quota_exhausted');
  const { reasonText, evidence } = classifyFailure({ exitCode: 0, stderrText: 'account balance insufficient\n' });
  assert.match(reasonText, /充值|更换账号/, '面向人的说明必须给出可执行动作，不能只说"配额不足"');
  assert.match(evidence, /balance insufficient/, '证据保留原文片段');
});

test('非 JSON 行证据面的准入闸：请求了 stream-json ⇒ 算证据；没请求 ⇒ 那是正文，不算', () => {
  // 2026-09-19 裁定（跨文件契约，落点 verdict.js buildLastRun）：
  //   ① 请求 stream-json（argv.js:235-239 下发了格式旗标）时 stdout 理应是全 JSON ⇒ 非 JSON 行只能是
  //      CLI 级诊断 ⇒ 可当证据（否则"选项被 CLI 拒绝"这类真机形态会失去唯一证据面）。
  //   ② **没**请求时（配置缺 outputFormatFlag/streamJsonValue，RECON D-3 的旧观测形态就是这样）
  //      整片 stdout 都是模型正文 ⇒ 正文里复述拒参词/配额词**绝不能**成为证据。
  //   两个方向都断言：只锁一个方向的话，把闸门恒置 true/false 都能骗过测试。
  const nonJson = 'error: unknown option \'--nope\'\n';
  const asked = buildLastRun({
    argv: ['node', 'cli', '-p', 'hi'], flags: [{ flag: '--output-format', value: 'stream-json', source: 'plugin.outputFormat' }],
    exitCode: 1, stdoutText: nonJson, stderrText: '',
  });
  assert.equal(asked.flagVerdict, 'rejected', '★ 请求了 stream-json 的非 JSON 行 = CLI 级诊断 ⇒ 必须仍能当拒参证据');
  assert.match(asked.flagEvidence, /unknown option/, '证据取自该行原文');
  assert.equal(asked.reasonCode, REASON_CODES.FLAG_REJECTED);

  const notAsked = buildLastRun({
    argv: ['node', 'cli', '-p', 'hi'], flags: [], exitCode: 1, stdoutText: nonJson, stderrText: '',
  });
  assert.equal(notAsked.flagVerdict, 'unknown', '★ 没请求 stream-json ⇒ 该行是模型正文，不得当证据');
  assert.equal(notAsked.flagEvidence, '', '不得凭空造证据');
  assert.notEqual(notAsked.reasonCode, REASON_CODES.FLAG_REJECTED, '正文不得被归因成参数被拒');
});

test('窗口截断残片不得进证据面：`{` 开头的半截帧里可能正是助手正文', () => {
  // 64 KiB 保留窗口会在正文中间把一帧切断 ⇒ 残片形如 `{"type":"assistant","message":{"content":[{"type":"text","text":"…积分不足…"`
  // 若把这种行当"非 JSON 行（CLI 纯文本错误）"用，一次**截断但成功**的下发就会被判成账户没额度
  // （假警报会把人指去充值）。parseFrames 把它归入 fragments，证据面 unparsed 不含它。
  const truncated = '{"type":"assistant","session_id":"t-1","message":{"content":[{"type":"text","text":"本次结果：积分不足，请先充值';
  const stdout = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 't-1', model: 'auto' }),
    JSON.stringify({ type: 'result', subtype: 'success', session_id: 't-1', is_error: false, result: 'DONE' }),
    truncated, // 末行无换行 = 被窗口截断
  ].join('\n');
  const parsed = parseFrames(stdout);
  assert.equal(parsed.unparsed.length, 0, '★ 截断残片不得出现在证据面 unparsed');
  assert.equal(parsed.fragments.length, 1, '残片要留痕（fragments），不是丢弃');
  assert.ok(parsed.parseErrors >= 1 && parsed.trailingPartial === true, '解析错误与截断都要如实标记');
  const rec = buildLastRun({
    argv: ['node', 'cli', '-p', 'hi'],
    flags: [{ flag: '--output-format', value: 'stream-json', source: 'plugin.outputFormat' }],
    exitCode: 0, stdoutText: stdout, stderrText: '', stdoutTruncated: true,
  });
  assert.equal(rec.reasonCode, REASON_CODES.OK, '★ 截断残片里的配额词不得把成功判成配额耗尽');
  assert.equal(rec.flagVerdict, 'accepted', '残片里的"未识别选项"式文本同样不得当拒参证据');
});

// ─────────── 下发健康 A 组：`notSent[]` 进记录，但**绝不进** CLI 接受度归因 ───────────

test('notSent：原样承载 + 补可执行 hint（原因码来自 argv.js 的 SSOT）', () => {
  const rec = buildLastRun({
    argv: ['node', 'cli', '-p', 'hi'],
    flags: [{ flag: '--model', value: 'auto', source: 'config.model' }],
    notSent: [{ flag: '--effort', value: 'turbo', source: 'call.effort', reason: 'unsupported_level' }],
    exitCode: 0, stdoutText: '{"type":"result","subtype":"success","is_error":false,"session_id":"s1"}\n',
  });
  assert.equal(rec.notSent.length, 1);
  assert.equal(rec.notSent[0].reason, 'unsupported_level');
  assert.equal(rec.notSent[0].source, 'call.effort');
  assert.match(rec.notSent[0].hint, /effortValues/, 'hint 要说"下一步动哪里"，不是复述发生了什么');
  assert.equal(rec.flags.some((f) => f.flag === '--effort'), false, '★ flags[] 只装线上有的：混进去就会被逐条归因成 rejected');
});

test('notSent 判别力：CLI 报错原文点名了同一个旗标 ⇒ 未下发项**不得**被算成"被拒"', () => {
  // 场景（真机可复现）：`effortFlag` 配成了空串 ⇒ 没有任何 --effort 上线，但 CLI 因**别的**原因
  // 在 stderr 里提到 `--effort`。旧风险：把未下发项塞进 flags[] ⇒ evidenceNamesFlag 命中 ⇒ 该行被判
  // rejected ⇒ 客户端把用户**从没生效过**的设置显示成"未指定"（B-T04-4 假回滚家族）。
  const rec = buildLastRun({
    argv: ['node', 'cli', '-p', 'hi'],
    flags: [],
    notSent: [{ flag: '--effort', value: 'turbo', source: 'config.effort', reason: 'missing_flag_name' }],
    exitCode: 1, stdoutText: '',
    stderrText: "error: unknown option '--effort'\n",
  });
  assert.equal(rec.flagVerdict, FLAG_VERDICTS.REJECTED, '聚合面照旧（stderr 确实报了拒参）');
  assert.deepEqual(rec.flags, [], '线上没有旗标 ⇒ 归因表必须是空的');
  assert.equal(rec.notSent.length, 1, '未下发项保持未下发身份，一条不少');
  assert.equal(rec.notSent[0].verdict, undefined, 'notSent 条目**没有** verdict 这一维');
});

test('notSent 形态健壮性：非数组 ⇒ []；缺 reason ⇒ unspecified；条目数封顶', () => {
  assert.deepEqual(buildLastRun({ argv: [], notSent: 'nope' }).notSent, []);
  const noReason = buildLastRun({ argv: [], notSent: [{ flag: '--x', value: 'v', source: 's' }] });
  assert.equal(noReason.notSent[0].reason, 'unspecified', '上游漏填原因也要留痕，不得静默丢事实');
  const many = buildLastRun({
    argv: [],
    notSent: Array.from({ length: 40 }, (_, i) => ({ flag: `--f${i}`, value: 'v', source: 's', reason: 'unsupported_level' })),
  });
  assert.equal(many.notSent.length, 16, '载荷封顶（这份记录会进模型可见的状态面）');
});

test('notSent 脱敏：取值可能被人塞进凭据 ⇒ 与其余对外文本同一条 redactText 路径（R3-19）', () => {
  const rec = buildLastRun({
    argv: [],
    notSent: [{ flag: '--model', value: FAKE_SK, source: 'config.model', reason: 'missing_flag_name' }],
  });
  assert.equal(rec.notSent[0].value.includes(FAKE_SK), false, '原样回传会把凭据写进记录/卡片');
  assert.match(rec.notSent[0].value, /\*\*\*/, '打码后要看得出打过码');
});

// ───────────────────── WB-1 / WB-2：落盘路径与 init 帧兜底 ─────────────────────

/** 落盘头部文本：第 0 行就是 `system/init` 帧（真机 JSONL 形态，帧后紧跟正文帧）。 */
const SPILL_HEAD = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-head', cwd: 'C:\\tmp', model: 'glm-4.6', permissionMode: 'acceptEdits' }),
  JSON.stringify({ type: 'assistant', session_id: 'sess-head', message: { content: [{ type: 'text', text: 'head prose' }] } }),
].join('\n');

/** 真机被裁过的**尾部**窗口：没有 init 帧（init 在第 0 行，早已被丢出窗口）。 */
const TAIL_ONLY = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'pong', session_id: 'sess-abc_1' });

test('WB-1：落盘路径进结构化面 —— 字符串原样、其余一律 null（不给空串）', () => {
  const both = buildLastRun({
    argv: [], exitCode: 0, stdoutText: TAIL_ONLY, stdoutTruncated: true,
    stdoutSpillPath: 'C:\\Users\\x\\AppData\\Local\\Temp\\dsh-subprocess-ab12\\dsh-subprocess-1-0-abc-stdout.log',
    stderrSpillPath: 'C:\\tmp\\dsh-subprocess-ab12\\dsh-subprocess-1-1-abc-stderr.log',
  });
  assert.equal(typeof both.stdoutSpillPath, 'string', '★ 路径必须在结构化字段里，不能只在给人看的通知行里');
  assert.match(both.stderrSpillPath, /stderr\.log$/, '两条流分开记（溢出可能是任一或两者）');

  for (const junk of ['', undefined, null, 123, {}, []]) {
    const rec = buildLastRun({ argv: [], exitCode: 0, stdoutText: '', stdoutSpillPath: junk, stderrSpillPath: junk });
    assert.equal(rec.stdoutSpillPath, null, `非"有路径"的取值必须归一成 null（实际 ${String(junk)}）`);
    assert.equal(rec.stderrSpillPath, null, '空串会与「有字段但值丢了」混淆（WB-1 判据）');
  }
  const clean = buildLastRun({ argv: [], exitCode: 0, stdoutText: OK_STDOUT });
  assert.equal(clean.stdoutSpillPath, null, '没溢出 ⇒ 没有副本，字段在场且为 null（不是缺字段）');
});

test('WB-2：init 帧从落盘头部补回，并逐字段标出处', () => {
  let calls = 0;
  const rec = buildLastRun({
    argv: [], exitCode: 0, stdoutText: TAIL_ONLY, stdoutTruncated: true,
    stdoutSpillPath: 'C:\\tmp\\x-stdout.log',
    spillInitHead: () => { calls += 1; return SPILL_HEAD; },
  });
  assert.equal(rec.initModel, 'glm-4.6', '窗口里没有的模型，从落盘头部读回');
  assert.equal(rec.initPermissionMode, 'acceptEdits');
  assert.equal(rec.initModelSource, INIT_SOURCES.SPILL_HEAD);
  assert.equal(rec.initPermissionModeSource, INIT_SOURCES.SPILL_HEAD);
  assert.equal(calls, 1, '兜底只读一次（两个字段各缺也不重复读盘）');
});

test('WB-2：窗口已有 init ⇒ 一个字都不覆盖，且**根本不读盘**（懒执行）', () => {
  let calls = 0;
  const rec = buildLastRun({
    argv: [], exitCode: 0, stdoutText: OK_STDOUT,
    spillInitHead: () => { calls += 1; return SPILL_HEAD; },
  });
  assert.equal(calls, 0, '★ 判别力：把 reader 改成无条件调用，本条立刻红 —— 兜底不得为一次不需要的读盘买单');
  assert.equal(rec.initModel, 'auto', '窗口 = CLI 输出与读取之间最短路径，兜底不得越权改写实测值');
  assert.equal(rec.initPermissionMode, 'default');
  assert.equal(rec.initModelSource, INIT_SOURCES.WINDOW);
  assert.equal(rec.initPermissionModeSource, INIT_SOURCES.WINDOW);
});

test('WB-2：出处**逐字段独立**（窗口给模型、头部只给权限模式）', () => {
  const head = JSON.stringify({ type: 'system', subtype: 'init', permissionMode: 'plan' });
  const window = JSON.stringify({ type: 'system', subtype: 'init', model: 'deepseek-v3-2' });
  const rec = buildLastRun({ argv: [], exitCode: 0, stdoutText: window, spillInitHead: () => head });
  assert.equal(rec.initModel, 'deepseek-v3-2');
  assert.equal(rec.initModelSource, INIT_SOURCES.WINDOW);
  assert.equal(rec.initPermissionMode, 'plan');
  assert.equal(rec.initPermissionModeSource, INIT_SOURCES.SPILL_HEAD, '两个字段各有出处才不会互相冒充');
});

test('WB-2：无值 ⇒ 出处为 null（没有值就没有来源，不写假出处）', () => {
  const rec = buildLastRun({ argv: [], exitCode: 0, stdoutText: TAIL_ONLY, stdoutSpillPath: 'C:\\tmp\\missing.log' });
  assert.equal(rec.initModel, null);
  assert.equal(rec.initModelSource, null, '不给 reader = 不做兜底；出处字段留 null，不谎称 ' + INIT_SOURCES.SPILL_HEAD);
  assert.equal(rec.stdoutSpillPath, 'C:\\tmp\\missing.log', '路径本身仍是事实，照记');
});

test('WB-2：reader 抛错 / 回空 ⇒ 不崩、不编造出处', () => {
  const boom = buildLastRun({
    argv: [], exitCode: 0, stdoutText: TAIL_ONLY, stdoutTruncated: true,
    spillInitHead: () => { throw new Error('ENOENT: 落盘文件已被外部清理'); },
  });
  assert.equal(boom.initModel, null);
  assert.equal(boom.initModelSource, null);
  assert.equal(boom.flagVerdict, FLAG_VERDICTS.ACCEPTED, '兜底失败不得改变判定（信息面与判定面分离）');
  for (const empty of ['', null, undefined, 42]) {
    const rec = buildLastRun({ argv: [], exitCode: 0, stdoutText: TAIL_ONLY, spillInitHead: () => empty });
    assert.equal(rec.initModelSource, null, `reader 回 ${String(empty)} 时不得产出出处`);
  }
});

test('★ WB-2 边界：落盘头部文本**绝不进拒绝证据链**（同一事实只能有一个裁决出处）', () => {
  const headWithRejection = [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'glm-4.6', permissionMode: 'default' }),
    '400 model [definitely-not-a-real-model-xyz] service info not found', // 头部里的非 JSON 诊断行
  ].join('\n');
  const rec = buildLastRun({
    argv: [], exitCode: 0,
    stdoutText: TAIL_ONLY, stdoutTruncated: true,
    // 请求过 stream-json ⇒ 窗口里的非 JSON 行**是**证据面；但头部的这一行必须不算
    flags: [{ flag: '--output-format', value: 'stream-json', source: 'plugin.outputFormat' }],
    stdoutSpillPath: 'C:\\tmp\\x-stdout.log',
    spillInitHead: () => headWithRejection,
  });
  assert.equal(rec.initModel, 'glm-4.6', '兜底**只**贡献 init 两个字段');
  assert.equal(rec.flagVerdict, FLAG_VERDICTS.ACCEPTED, '★ 判别力：把 headSummary 并进证据面，本条立刻 rejected');
  assert.equal(rec.flagEvidence, '', '头部文本不得成为归因证据');
  assert.equal(rec.frames, 1, '帧数仍只数窗口（头部帧不得混进计数）');
  assert.equal(rec.stdoutTruncated, true, '截断事实照旧');
});

test('WB-1/WB-2 载荷形态：新增三字段在**每条**记录里都在场（含启动失败路径）', () => {
  const failed = buildLastRun({ argv: ['node', 'cli'], exitCode: null, spawnError: 'boom' });
  for (const key of ['stdoutSpillPath', 'stderrSpillPath', 'initModelSource', 'initPermissionModeSource']) {
    assert.ok(key in failed, `${key} 必须恒在场（消费端不必区分"没这个字段"与"值为 null"）`);
    assert.equal(failed[key], null);
  }
});
