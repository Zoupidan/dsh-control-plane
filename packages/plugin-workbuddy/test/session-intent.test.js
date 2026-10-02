/**
 * 会话意图跨文件契约（2026-09-19 集成期新增）—— 补上 SA-6 指出的**端到端断点**的检测器。
 *
 * 背景（这是本文件存在的唯一理由）：`session/map.js` 实现了"调用方显式 `resume:false` 且本轮没有确认
 * 新会话 ⇒ 旧 id 标 `superseded`、下次自动下发不得再 resume 它"这条闸门，闸门由第四参
 * `options.resumeIntent === 'fresh'` 驱动。而 `run.js` 原先只传三个实参 ⇒ **闸门在真实链路上永不触发**：
 * 用户在旧会话里 `resume:false` 开了新会话，若这一轮没拿到 session_id（崩溃/被拒/输出无 id），
 * 旧 id 仍是"可续接"，下一次自动下发会把用户明确放弃的旧会话**悄悄续起来**。
 *
 * 两类断言，缺一不可：
 *   G1 **静态守卫**（本项目既有惯例：CI ② 也是静态扫描）：`run.js` 的 `capture(...)` 必须递出意图。
 *      它只防"这一行被顺手删掉/改成三参"，**不**证明运行期行为 —— 名字里就写明是 guard。
 *   G2 **行为断言**（真模块、内存态、零 CLI）：闸门本身在两个方向上都能区分（能拦、也能在健康轮次自愈），
 *      否则 G1 会守着一条本来就恒真的判据。G2 用 `get: () => undefined` 的假 ctx ⇒ 没有 settings 服务
 *      ⇒ 不落盘、不触碰真实数据根。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadSessionMap, noSessionEvidence } from '../src/host/session/map.js';

const here = dirname(fileURLToPath(import.meta.url));
const RUN_SRC = readFileSync(join(here, '..', 'src', 'host', 'tools', 'run.js'), 'utf8');
// ★ 2026-10-02 切回计划任务主路：会话 id 的写路径在点火侧。
//   `tools/run.js` 把 `sessionKey` + `sessionStore.adopt` 透给 `startAutomationRun`，
//   点火在 `sessions.id` 一确认就 `retireRow` + `adopt`（见 automation.js adoptSession）。
//   守卫盯 `run.js` 透传 + `automation.js` 落子，两处缺一即红。
const AUTOMATION_SRC = readFileSync(join(here, '..', 'src', 'host', 'gateway', 'automation.js'), 'utf8');

const INIT = `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-ok-1', cwd: 'C:\\tmp' })}\n`;
/** 真机形态 C：单帧 `type:'error'`（`--resume <已不存在的 id>`），无 result 帧。 */
const DEAD = `${JSON.stringify({ type: 'error', error: 'No conversation found with session ID: sess-ok-1' })}\n`;
/** 本轮没确认新会话，也没有"会话不存在"证据（例如参数被 CLI 拒掉）。 */
const INCONCLUSIVE = `${JSON.stringify({ type: 'system', subtype: 'init' })}\n`;

const freshMap = () => loadSessionMap({ get: () => undefined }, 'dsh-plugin-workbuddy');

/**
 * 剥掉块注释与行注释，只留代码。
 *
 * ★ 为什么静态守卫必须先剥注释 ★
 * 源码里"解释某个东西为什么被删掉"的注释，**必然**包含那个东西的名字。
 * 不剥注释就匹配，等于逼着后来的人"要么别解释，要么去改断言"——两条路都会让守卫失去意义。
 * （第一版 G1 就是这么红的：它红在自己写的说明文字上。）
 *
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // 块注释
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1'); // 行注释（跳过 URL 里的 //）
}

test('G1 静态守卫：run.js 可二次下发/透传记账/回收，automation.js 落 adopt+forget+retire，全程禁网关', () => {
  // ★ 可二次下发记性链：调用方只传 session_key + resume，插件管记住/回收。
  //   run.js 每轮都走点火 INSERT 一行 once 建新可见对话（不再有“已记住就失败”分支）；
  //   点火侧 adopt 覆盖新 id、forget 回收失败；run 收口失败同样 forget（双保险）。
  //   网关全禁（void dispatch，不调 continueSession）。任一缺失 ⇒ 记账断裂或死会话永不回收。
  assert.ok(
    !/sessions\.capture\(/.test(stripComments(RUN_SRC)),
    'G1：run.js 不得再调 sessions.capture(...) —— CLI 已删、stdout 无 id，调用点是死的；改用 adopt/forget 透传',
  );
  // ★ 写口必须透传：sessionKey + sessionStore（含 adopt）缺一，记账即断。
  assert.match(
    stripComments(RUN_SRC),
    /sessionKey/,
    'G1：★ run.js 必须把 sessionKey 透给点火（adopt 记账的键）',
  );
  assert.match(
    stripComments(RUN_SRC),
    /sessionStore/,
    'G1：★ run.js 必须把 sessionStore 透给点火（adopt 写口）——不传则记性永不更新',
  );
  assert.match(
    stripComments(RUN_SRC),
    /sessions\.resumable\(/,
    'G1：★ run.js 必须查 sessions.resumable（resume:true 无记录即报错的判据）——不查则该闸门恒断',
  );
  // ★ 可二次下发：每轮新对话 ⇒ resumed:false。不再有 resumed:true 的“命中即失败”分支。
  assert.match(
    stripComments(RUN_SRC),
    /resumed:\s*false/,
    'G1：★ run.js 每轮新对话必须记 resumed:false（无复用分支，每轮都新建）',
  );
  assert.doesNotMatch(
    stripComments(RUN_SRC),
    /shouldReuse/,
    'G1：★★ 不再有 shouldReuse 分支（“已记住就失败”已删除，每轮都可下发）',
  );
  assert.doesNotMatch(
    stripComments(RUN_SRC),
    /reused-not-dispatched|REUSED_NOT_DISPATCHED/,
    'G1：★★ 不再有 reused-not-dispatched 口径（每轮新对话 origin 为 new）',
  );
  assert.doesNotMatch(
    stripComments(RUN_SRC),
    /already_remembered_no_dispatch|ALREADY_REMEMBERED_NO_DISPATCH/,
    'G1：★★ 不再以 already_remembered_no_dispatch 收尾（记性命中不再是失败条件）',
  );
  assert.doesNotMatch(
    RUN_SRC,
    /本轮prompt未送达桌面端，automation表无追问入口/,
    'G1：★★ 不再逐字写未送达（每轮真下发，无未送达分支）',
  );
  assert.match(
    stripComments(RUN_SRC),
    /void\s+dispatch\s*;/,
    'G1：★★ 网关仍全禁：dispatch 必须被 void 掉（每轮都不调网关）',
  );
  assert.doesNotMatch(
    stripComments(RUN_SRC),
    /continueSession/,
    'G1：★★ 网关续跑已回滚：不得再调 dispatch.continueSession（可二次下发亦不调）',
  );
  assert.doesNotMatch(
    stripComments(RUN_SRC),
    /startGatewayContinuation/,
    'G1：★★ 网关续跑已回滚：不得再调 startGatewayContinuation',
  );
  assert.doesNotMatch(
    stripComments(RUN_SRC),
    /loaded-reused|REUSED_VIA_GATEWAY_ORIGIN/,
    'G1：★★ 网关续跑已回滚：不得再记 loaded-reused',
  );
  // ★ 无 shouldReuse 分支；点火是每轮唯一写入点（由 multi-turn R2 的 automationCalls==2 覆盖次数，此处只钉存在）。
  {
    const code = stripComments(RUN_SRC);
    assert.ok(code.indexOf('if (shouldReuse)') === -1, 'G1：★★ 不得再有 if (shouldReuse) 分支');
    assert.ok(code.includes('startAutomationRun'), 'G1：★★ 点火必须存在（每轮唯一写入点）');
    assert.ok(!code.includes('continueSession') && !code.includes('startGatewayContinuation'), 'G1：★★ 全文件不得再调网关续跑');
  }
  assert.match(
    stripComments(AUTOMATION_SRC),
    /sessionStore\.adopt\(/,
    'G1：★ automation.js 必须在 sessions.id 一确认就 adopt（覆盖记性为新 id）——'
    + '漏掉它，记性永不更新',
  );
  assert.match(
    stripComments(AUTOMATION_SRC),
    /sessionStore\.forget\(|\.forget\(/,
    'G1：★ automation.js 必须在终态失败/取消/超时 forget（下轮重建）——漏掉它，死会话会被复用',
  );
  assert.match(
    stripComments(AUTOMATION_SRC),
    /retireRow/,
    'G1：★ automation.js 必须在会话确认/任何终态 retireRow 软删（止损就靠删行）',
  );
  // ★ 每轮唯一写入点是点火（由 multi-turn R2 的 automationCalls==2 断言次数，此处只钉存在）。
  assert.match(
    stripComments(RUN_SRC),
    /startAutomationRun/,
    'G1：★ run.js 每轮必须走唯一写入点 startAutomationRun（新对话 INSERT automations once）',
  );
  // 意图闸门必须还在：`resume:true` + 没有可续接记录 ⇒ 明确报错，不静默开新对话。
  assert.match(
    RUN_SRC,
    /intent\s*===\s*true\s*&&\s*recorded\s*===\s*null/,
    'G1：resume:true 仍必须显式报错（"要续接却没得续"不能悄悄变成另开一条）',
  );
  // ★ resume:false 同样新开（与自动一致，每轮 INSERT）。
  assert.match(
    RUN_SRC,
    /resume:false/,
    'G1：★★ resume:false 同样新开（可二次下发语义）',
  );
});

test('G2 行为：resumeIntent:fresh 且本轮无确认 ⇒ 旧 id 只留痕、不再可续接', () => {
  const sessions = freshMap();
  const key = 'sess-intent-fresh';
  assert.notEqual(sessions.capture(key, INIT).cliSessionId, null, '前置：健康轮次先记下一个可续接的 id');
  assert.equal(sessions.resumable(key)?.cliSessionId, 'sess-ok-1', '前置：此时该 key 是可续接的');

  const c = sessions.capture(key, INCONCLUSIVE, false, { resumeIntent: 'fresh' });
  assert.equal(sessions.resumable(key), null, '★ 显式要新会话却没确认新 id ⇒ 旧 id 不得再被自动 resume');
  assert.equal(c.resumable, false, '返回字段与 resumable() 判据必须同源');
  assert.equal(sessions.lookup(key)?.cliSessionId, 'sess-ok-1', '旧 id 仍留痕（"是哪个会话被放弃"要能查到）');
  assert.equal(sessions.lookup(key)?.superseded, true, '留痕要带 superseded 位，否则下一次空输出会把它洗白');
  assert.notEqual(sessions.unresumableReason(key), '', '要给出稳定的不可续接原因');
});

test('G2 反向对照：不带该意图时不得判死（否则这条闸门恒真，等于没测）', () => {
  const sessions = freshMap();
  const key = 'sess-intent-auto';
  sessions.capture(key, INIT);
  sessions.capture(key, INCONCLUSIVE); // 同一份"没有确认"的输出，唯一差别 = 没有 resumeIntent
  assert.equal(sessions.resumable(key)?.cliSessionId, 'sess-ok-1', '★ 对照组：auto 意图下旧 id 仍可续接（说明上一条测的是意图，不是"抽不到 id 就判死"）');
  assert.equal(sessions.lookup(key)?.superseded, false, '不得无端置 superseded');
});

test('G2 缺陷①回归：CLI 说会话不存在 ⇒ 判死；下一轮健康输出可自愈', () => {
  const sessions = freshMap();
  const key = 'sess-dead';
  // 前置：`noSessionEvidence` 返回的是 `{reason, evidence}` 证据对象（不是布尔）——正反两面都要先锁，
  //   否则"判死"这个前提一旦恒真/恒假，后面的断言就失去意义。
  assert.equal(noSessionEvidence(DEAD)?.reason, 'no_session_resume', '前置：死亡证据必须能被识别');
  assert.ok(!noSessionEvidence(INIT), '前置反向对照：健康帧不得被认成"会话不存在"');
  sessions.capture(key, INIT);
  const c = sessions.capture(key, DEAD);
  // 注意：`unconfirmed` 是**记录**上的位（`lookup()`/落盘可见），不在 `capture()` 的返回值里
  //   —— 返回值只给 `resumable` 这个"对外结论"。断言要打在真正承载它的那一层（本轮我自己先写错了一次）。
  assert.equal(sessions.lookup(key)?.unconfirmed, true, '判死位要落在记录上');
  assert.equal(c.resumable, false, '对外结论（capture 返回值）必须与记录同源');
  assert.equal(sessions.resumable(key), null, '★ 死 id 不得留成可续接（原缺陷：此后每次自动下发都空转）');
  assert.equal(sessions.lookup(key)?.cliSessionId, 'sess-ok-1', '死 id 仍要留痕，便于告诉用户"是哪个会话没了"');

  const healed = sessions.capture(key, `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-ok-2' })}\n`);
  assert.equal(healed.cliSessionId, 'sess-ok-2', '下一轮确认了新会话 ⇒ 取新 id');
  assert.equal(sessions.resumable(key)?.cliSessionId, 'sess-ok-2', '★ 判死位不得粘住：健康轮次必须能恢复续接');
});

// ★★★ 2026-09-22 P1 洗白双回归（原缺陷：`capture` 的**非 fresh 分支**把两个判死位写成当轮观测值
//    ⇒ 深度合并把 `true` 洗成 `false` ⇒ 判死被下一轮空轮撤销。判死位只能被**证据/本轮确认**推动：
//    置真靠证据（DEAD）、置真靠意图（fresh⇒supersede）、清真只靠确认 —— "什么都没读到"没有投票权。

test('★ 洗白回归①（P1）：superseded 不得被下一轮非 fresh 空轮洗掉（否则用户放弃的会话悄悄复活）', () => {
  const sessions = freshMap();
  const key = 'sess-wash-superseded';
  sessions.capture(key, INIT);
  sessions.capture(key, INCONCLUSIVE, false, { resumeIntent: 'fresh' }); // 意图判死（既有 G2 锁过）
  assert.equal(sessions.lookup(key)?.superseded, true, '前置：fresh 意图已判死');
  sessions.capture(key, INCONCLUSIVE); // ★ 同一份无确认输出，但本轮不是 fresh —— 病灶分支
  assert.equal(sessions.lookup(key)?.superseded, true, '★★ 下一轮非 fresh 空轮不得洗掉 superseded（原缺陷：非 fresh 分支无条件写 false）');
  assert.equal(sessions.resumable(key), null, '洗白一旦发生，下一次自动下发就会把用户明确放弃的旧会话悄悄续上');
  assert.equal(sessions.lookup(key)?.cliSessionId, 'sess-ok-1', '★ 同 id 留痕：判死轮的 id 不得从记录上消失（null 会与磁盘上的旧 id 形成双口径）');
  assert.equal(sessions.unresumableReason(key)?.reason, 'superseded', '不可续接原因必须钉在 superseded（id 被丢掉时会退化成 no_session_id = 归因失真）');
});

test('★ 洗白回归②（P1）：unconfirmed 不得被下一轮"什么都没读到"洗掉（否则死 id 复活 = 缺陷①复发）', () => {
  const sessions = freshMap();
  const key = 'sess-wash-unconfirmed';
  sessions.capture(key, INIT);
  sessions.capture(key, DEAD);
  assert.equal(sessions.lookup(key)?.unconfirmed, true, '前置：死亡证据已判死');
  sessions.capture(key, INCONCLUSIVE); // 无死亡证据、无确认 —— 病灶分支（原实现写死当轮观测值）
  assert.equal(sessions.lookup(key)?.unconfirmed, true, '★★ 判死只能被"本轮确认"清除；空轮没有投票权');
  assert.equal(sessions.resumable(key), null, '洗白 ⇒ 死 id 复活 ⇒ 此后每次自动下发都空转（原缺陷①的复发形态）');
  assert.equal(sessions.lookup(key)?.cliSessionId, 'sess-ok-1', '同 id 留痕照旧');
  // 粘滞的对立面：确认轮必须能自愈（否则"粘滞"就成了把健康会话永久判死）。
  const healed = sessions.capture(key, `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-ok-9' })}\n`);
  assert.equal(healed.cliSessionId, 'sess-ok-9');
  assert.equal(sessions.resumable(key)?.cliSessionId, 'sess-ok-9', '★ 确认轮清除判死位（与既有 G2 自愈断言同判据，锁在新位公式上）');
});

test('G3 ★ 会话复用做实：adopt/lookup/forget 按 session_key 记 own 映射（成功保留、失败回收）', () => {
  const sessions = freshMap();
  const key = 'sess-own-reuse';
  // adopt 记住（own:true = 插件自建、可回收；createdAt 首次落盘）
  const adopted = sessions.adopt(key, { cliSessionId: 'sess-ok-1', cwd: 'C:\\tmp', own: true });
  assert.equal(adopted.ok, true, 'adopt 必须成功');
  assert.equal(sessions.lookup(key)?.cliSessionId, 'sess-ok-1');
  assert.equal(sessions.lookup(key)?.own, true, '★ own 标记必须透出（回收判据）');
  assert.equal(sessions.resumable(key)?.cliSessionId, 'sess-ok-1', '★ 记住后即可复用（load）');
  // 成功保留：不 forget ⇒ 仍可复用
  assert.equal(sessions.resumable(key)?.cliSessionId, 'sess-ok-1', '成功保留 ⇒ 下轮继续复用');
  // 终态失败/取消/超时 forget ⇒ 下轮重建（不再可复用，但留痕）
  assert.equal(typeof sessions.forget, 'function', '★ map 必须暴露 forget（sessionStore 三件套）');
  const forgot = sessions.forget(key);
  assert.equal(forgot.ok, true, 'forget 必须成功');
  assert.equal(sessions.resumable(key), null, '★ forget 后不再可复用（下轮重建）');
  assert.equal(sessions.lookup(key)?.cliSessionId, 'sess-ok-1', '★ forget 留痕（是哪个会话被作废要能查到）');
  assert.equal(sessions.lookup(key)?.superseded, true, '留痕要带 superseded 位');
  assert.equal(sessions.unresumableReason(key)?.reason, 'superseded', '原因必须钉在 superseded');
  // 新对话 adopt 覆盖 ⇒ 恢复可复用（重建）
  sessions.adopt(key, { cliSessionId: 'sess-ok-2', cwd: 'C:\\tmp', own: true });
  assert.equal(sessions.resumable(key)?.cliSessionId, 'sess-ok-2', '★ 重建后恢复可复用');
});

test('G3b 反向对照：forget 无记录 ⇒ no_record，不凭空造空壳', () => {
  const sessions = freshMap();
  const r = sessions.forget('never-used-key');
  assert.equal(r.ok, false, '无记录 forget 不得谎报成功');
  assert.equal(sessions.resumable('never-used-key'), null);
  assert.equal(sessions.lookup('never-used-key'), null, '不得为一次作废凭空造记录');
});
