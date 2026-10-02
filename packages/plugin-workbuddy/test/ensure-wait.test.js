// ★★ `NO_SIDECAR_APPEARED` **不是终局**（2026-09-30，演示前最后一段路）
//
// ★ 这组测试的第一职责不是"证明能等"，而是证明**"等"这件事没有被实现成一次提前判死**。
//   真机读数：桌面端进程在跑，ACP 端点**不存在**——端点跟"人开了一条对话"走，不跟"进程"走。
//   旧行为：等满 30s 窗口即 `finish(FAILED, NO_SIDECAR_APPEARED)`，**此后没有任何恢复路径**：
//   人后来真的开了对话也救不回来；演示中途关一次会话 ⇒ 下一次下发必然直接失败。
//   ⇒ 所以下面四条钉的是**可观察的事实**，不是实现细节：
//     ① 第一窗口到点后 sidecar 才出现 ⇒ **成功**（旧实现在这里失败）
//     ② 一直不出现且到达总上限 ⇒ 失败，且 `code` 仍是 `no_sidecar_appeared`
//     ③ 续等**期间**取消 ⇒ `aborted`（而不是把用户的取消写成环境故障）
//     ④ 续等期间 `onPhase` 被**再次**推进 ⇒ "还在等"这件事外部看得见
//
// ★ 时钟纪律：**不许真睡**。总上限 / 两个节拍全部走 `deps` 注入（毫秒级），
//   假时钟按**传进来的那个 ms** 推进——于是"续等期间换了更长的节拍"是可断言的（`sleeps` 里能读到），
//   而不是靠人相信。真实墙钟只出现在第 ⑤ 条里，且那一条的唯一目的就是证明**注入真的生效**
//   （若 `totalWaitMs` 被忽略，那条会转满 10 分钟而被判超时——那是一个真探测器）。
//
// ★ fixture 纪律：`TASKLIST_REAL` 是 2026-09-30 本机 `tasklist /FI "IMAGENAME eq WorkBuddy.exe" /NH /FO CSV`
//   的逐字输出，与邻居 `gateway-instance-ensure.test.js` 同源同纪律：不编造。
//   端点夹具一律落在 `tmp/`，**绝不碰** `~/.workbuddy/`（也绝不读 `mcp-config.json`）。
//   这套测试没有任何一条会去碰真实桌面端：不注入 `launcher`，且 `run` 是纯函数。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createEnsurer, DEFAULT_CONTINUED_POLL_MS, DEFAULT_TOTAL_WAIT_MS, DEFAULT_WAIT_MS,
  ENSURE_CODE, ENSURE_PHASE, ENSURE_STAGE, projectInstance,
} from '../src/host/gateway/ensure.js';

// 真机逐字（2026-09-30 20:40，7 个 WorkBuddy.exe）
const TASKLIST_REAL = [
  '"WorkBuddy.exe","23696","Console","1","211,248 K"',
  '"WorkBuddy.exe","15192","Console","1","97,924 K"',
  '"WorkBuddy.exe","30800","Console","1","55,832 K"',
  '"WorkBuddy.exe","7364","Console","1","289,920 K"',
  '"WorkBuddy.exe","27584","Console","1","226,700 K"',
  '"WorkBuddy.exe","40344","Console","1","94,652 K"',
  '"WorkBuddy.exe","38340","Console","1","83,992 K"',
].join('\r\n');

const NO_SIDECAR = { picked: null, why: { code: 'all_busy', detail: 'n' }, scanned: 3 };
const PICKED = { pid: 4242, url: 'http://127.0.0.1:1234', kind: 'interactive' };

/** 与邻居同款：broker 端点夹具（`ready === true` 只有在文件真在那儿时才是**真话**）。 */
const EP_BYTES = JSON.stringify({ endpoint: '\\\\.\\pipe\\wbipc-fixture', ticket: 'fixture-ticket' });
function endpointFixture({ staleMs = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-wait-'));
  const file = join(dir, 'endpoint.json');
  writeFileSync(file, EP_BYTES);
  const mtime = Date.now() - staleMs;
  utimesSync(file, mtime / 1000, mtime / 1000);
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * 假时钟：`sleep(ms)` 按**传进来的那个 ms**推进（不是一个写死的步长）。
 * 于是"续等期间确实换了更长的节拍"从 `sleeps` 里直接读得到，不需要相信注释。
 */
function fakeClock(start = 0) {
  let t = start;
  const sleeps = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += (Number.isFinite(ms) && ms > 0) ? ms : 1; },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// ① 第一窗口到点之后 sidecar 才出现 ⇒ **成功**
// ══════════════════════════════════════════════════════════════════════════════

test('★★ ① 第一窗口到点后 sidecar 才出现 ⇒ 成功（旧实现在这里就报 NO_SIDECAR_APPEARED）', async () => {
  const clk = fakeClock();
  const fx = endpointFixture({ staleMs: 60_000 });
  let probes = 0;
  const phases = [];
  const { ensure } = createEnsurer({
    probe: async () => {
      probes += 1;
      // 第 6 次探测（第 5 轮结束时 t 恰好过 1000ms 的第一窗口）才出现 ⇒ 必须走过续等。
      return probes >= 7 ? { picked: PICKED, why: null, scanned: 3 } : NO_SIDECAR;
    },
    run: async () => TASKLIST_REAL,
    sleep: clk.sleep,
    now: clk.now,
    endpointFile: fx.file,
    waitMs: 1000,          // ★ 毫秒级的第一窗口
    totalWaitMs: 20_000,   // ★ 毫秒级的总上限（单测绝不许真睡 10 分钟）
    pollMs: 200,
    continuedPollMs: 2000,
  });
  const r = await ensure({ onPhase: (p) => phases.push(p) });
  fx.cleanup();

  assert.equal(r.ok, true, '★ 人开了对话之后这一轮**必须**成功——这正是本次修的东西');
  assert.equal(r.report.stage, ENSURE_STAGE.WAITED);
  assert.equal(r.report.code, 'ok');
  assert.equal(r.sidecar.pid, 4242);
  // ★ "确实走过续等"必须被回执记下来，而不是只在这一条测试里发生过。
  assert.equal(r.report.wait.continued, true,
    '★ 这一轮越过了第一窗口 ⇒ 续等必须被记进报告（否则上层无从区分"30s 就死"与"人一直没来"）');
  assert.equal(r.report.wait.firstWindowMs, 1000);
  assert.equal(r.report.wait.totalWaitMs, 20_000);
  assert.ok(r.report.waitedMs > 1000,
    `只等了 ${r.report.waitedMs}ms，说明压根没走到第一窗口之后`);
  // ★ 让出与慢档：续等那几轮必须睡**更长**的节拍（默认 500ms→5s 的缩写在测试里是 200→2000）。
  assert.deepEqual(clk.sleeps, [200, 200, 200, 200, 200, 2000],
    '★ 续等期间必须继续让出，且换成更长的节拍（不等 = 空转占死事件循环；不减速 = 白烧 1200 轮 I/O）');
});

// ══════════════════════════════════════════════════════════════════════════════
// ② 一直不出现 + 到达总上限 ⇒ 失败，且 code 正确
// ══════════════════════════════════════════════════════════════════════════════

test('★★ ② 一直不出现、耗尽总上限 ⇒ 失败（code 仍为 no_sidecar_appeared，但必须带续等证据）', async () => {
  const clk = fakeClock();
  const fx = endpointFixture({ staleMs: 60_000 });
  const { ensure } = createEnsurer({
    probe: async () => NO_SIDECAR,
    run: async () => TASKLIST_REAL,
    sleep: clk.sleep,
    now: clk.now,
    endpointFile: fx.file,
    waitMs: 1000,
    totalWaitMs: 3000,
    pollMs: 200,
    continuedPollMs: 1000,
  });
  const r = await ensure();
  fx.cleanup();

  assert.equal(r.ok, false);
  assert.equal(r.report.stage, ENSURE_STAGE.FAILED);
  assert.equal(r.report.code, ENSURE_CODE.NO_SIDECAR_APPEARED,
    '★ 终局仍然是这个码（续等改变的是"何时失败"，不是"失败成什么"）');
  assert.notEqual(r.report.code, ENSURE_CODE.ABORTED, '★ 没被取消就不许报 aborted');
  assert.equal(r.report.wait.continued, true);
  assert.ok(r.report.waitedMs >= 3000,
    `总上限给了 3000ms，只等了 ${r.report.waitedMs}ms ⇒ 提前判死`);
  // ★ 总上限**必须真的兜住**：轮数有界，不许变成无终止的循环。
  //   逐轮账：t=200/400/600/800/1000（前 5 轮，200ms 密档；第 5 轮末尾 t 触到第一窗口 ⇒ 转续等）
  //         t=2000/3000（续等段，1000ms 慢档；t=3000 触到总上限 ⇒ 失败）。
  assert.equal(r.report.wait.polls, 7, '★ 探测轮数必须与 (窗口/节拍) 对得上，不许空转');
  assert.deepEqual(clk.sleeps, [200, 200, 200, 200, 200, 1000, 1000],
    '★ 每一轮都必须 sleep 让出；续等期间换慢档');
  // ★ 提示必须说清**恢复路径不存在**（"我去开对话它自己会跑起来"正是本次要修的旧症状）。
  assert.match(r.report.hint, /no agent sidecar within the wait window/,
    '★ 既有那句识别串不许被顶掉（追加，不是替换）');
  assert.match(r.report.hint, /does NOT revive this finished run/,
    '★ 耗尽续等之后必须点破"开了对话也救不回这一轮"，否则用户会以为不用重发');
});

// ══════════════════════════════════════════════════════════════════════════════
// ③ 续等期间取消 ⇒ ABORTED
// ══════════════════════════════════════════════════════════════════════════════

test('★★ ③ 续等**期间**取消 ⇒ aborted（不许把用户自己的取消写成环境故障）', async () => {
  const clk = fakeClock();
  const fx = endpointFixture({ staleMs: 60_000 });
  const ac = new AbortController();
  let probes = 0;
  const { ensure } = createEnsurer({
    probe: async () => {
      probes += 1;
      // 第 6 次探测落在 t=1000ms（第一窗口刚过 ⇒ 已转续等）的**续等段内**。
      if (probes === 6) ac.abort();
      return NO_SIDECAR;
    },
    run: async () => TASKLIST_REAL,
    sleep: clk.sleep,
    now: clk.now,
    endpointFile: fx.file,
    waitMs: 1000,
    totalWaitMs: 60_000,   // ★ 远大于取消发生的时刻 ⇒ 若取消不被认，它会一路转完 60s 才失败
    pollMs: 200,
    continuedPollMs: 1000,
  });
  const r = await ensure({ signal: ac.signal });
  fx.cleanup();

  assert.equal(r.report.code, ENSURE_CODE.ABORTED,
    '★ 取消必须在每轮顶部被认；认晚了就是"用户点了取消还要再等很久"（F3 的同款错）');
  assert.equal(r.report.wait.continued, true,
    '★ 取消发生在**续等段**内——不是第一窗口内（否则这条测不到续等的取消）');
  assert.ok(r.report.waitedMs < 60_000,
    `总上限 60000ms，只等了 ${r.report.waitedMs}ms ⇒ 取消没被认`);
  assert.match(r.report.hint, /Cancelled/);
});

// ══════════════════════════════════════════════════════════════════════════════
// ④ 续等期间 onPhase 被推进过（"还在等"外部看得见）
// ══════════════════════════════════════════════════════════════════════════════

test('★★ ④ 续等期间 onPhase 被**再次**推进，且不得声称进入任何模型阶段', async () => {
  const clk = fakeClock();
  const fx = endpointFixture({ staleMs: 60_000 });
  let probes = 0;
  const phases = [];
  const { ensure } = createEnsurer({
    probe: async () => {
      probes += 1;
      return probes >= 7 ? { picked: PICKED, why: null, scanned: 3 } : NO_SIDECAR;
    },
    run: async () => TASKLIST_REAL,
    sleep: clk.sleep,
    now: clk.now,
    endpointFile: fx.file,
    waitMs: 1000,
    totalWaitMs: 20_000,
    pollMs: 200,
    continuedPollMs: 2000,
  });
  const r = await ensure({ onPhase: (p) => phases.push(p) });
  fx.cleanup();

  assert.equal(r.ok, true);
  assert.equal(phases[0], ENSURE_PHASE.ENSURING_INSTANCE,
    '★ 词表第一个值必须与旧字面量逐字相同（`ensuring_instance`），否则作业输出的既有两行会变样');
  // ★ 判据是"**再次**推进"：只推一次 = 只在进入等待段时推过，续等段本身仍是静默的，
  //   那正是本次要修的症状的一半（用户看着一段毫无回执的长等待，与卡死同形）。
  const awaiting = phases.filter((p) => p === ENSURE_PHASE.AWAITING_SIDECAR);
  assert.equal(awaiting.length, 2,
    `续等期间必须再推一次 phase（实得 ${JSON.stringify(phases)}）`);
  // ★ 负控：一个看起来像"已进入思考"的 phase 会让用户以为不该打断——这一轮还没握手、没建会话。
  const MODEL_STAGES = new Set([
    'discovering', 'authenticating', 'handshaking', 'opening_session',
    'setting_permission', 'setting_model', 'using_session_model', 'prompting',
  ]);
  for (const p of phases) {
    assert.equal(MODEL_STAGES.has(p), false,
      `★ 这一轮还没发出任何 token，不得声称进入模型阶段 ${p}`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ⑤ 总上限真的可注入（真探测器：若注入被忽略，这一条会转满 10 分钟而超时）
// ══════════════════════════════════════════════════════════════════════════════

test('★★ ⑤ 总上限必须真的可注入（真实墙钟 60ms 的窗口：忽略注入 ⇒ 10 分钟后才失败）', async () => {
  const fx = endpointFixture({ staleMs: 60_000 });
  const { ensure } = createEnsurer({
    probe: async () => NO_SIDECAR,
    run: async () => TASKLIST_REAL,
    sleep: (ms) => new Promise((r) => { setTimeout(r, Math.min(Number(ms) || 1, 5)); }),
    now: Date.now,
    endpointFile: fx.file,
    waitMs: 10,
    totalWaitMs: 60,
    pollMs: 5,
    continuedPollMs: 5,
  });
  const t0 = Date.now();
  const r = await ensure();
  const elapsed = Date.now() - t0;
  fx.cleanup();
  assert.equal(r.report.code, ENSURE_CODE.NO_SIDECAR_APPEARED);
  assert.ok(elapsed < 3000,
    `注入了 totalWaitMs:60 却走了 ${elapsed}ms ⇒ deps.totalWaitMs 没被消费（默认会转满 ${DEFAULT_TOTAL_WAIT_MS}ms）`);
});

test('★★ 默认值的量级关系：第一窗口 ≤ 总上限，且总上限"明显更长"（不是一个随手写的数）', () => {
  assert.ok(DEFAULT_TOTAL_WAIT_MS >= 10 * DEFAULT_WAIT_MS,
    `总上限 ${DEFAULT_TOTAL_WAIT_MS} 相对第一窗口 ${DEFAULT_WAIT_MS} 不够"明显更长"`);
  assert.equal(DEFAULT_CONTINUED_POLL_MS > 500, true,
    '★ 续等必须比第一窗口慢一档（人开一条对话的时间尺度是秒~分钟，不是 500ms）');
});

// ══════════════════════════════════════════════════════════════════════════════
// ⑥ 可行动的成因不许被压平（`projectInstance` 这一层）
// ══════════════════════════════════════════════════════════════════════════════

test('★★ ⑥ 真跑的 `refused` 是**字符串**：投影不得把它压成 "unknown"', () => {
  // ★ 真值来自真跑路径：`runOnce` 每一处都写 `why: why?.code ?? null`（字符串），
  //   而投影原来只认 `{code}` 对象 ⇒ 每一次真实运行都被压成 'unknown'。
  //   'unknown' 就是"把可行动的原因压平"的字面形态：
  //   no_desktop（去开桌面端）/ all_busy·busy_running（去关掉占用中的会话）/
  //   probe_unreachable（去查端点）——三种处置**完全不同**，在用户与模型眼前长得一模一样。
  const projected = projectInstance({
    stage: 'failed', code: 'no_sidecar_appeared', ok: false,
    desktop: { running: true, launched: false, ready: true },
    sidecar: { scanned: 3, picked: 0, refused: 'all_busy' }, hint: 'h',
  });
  assert.equal(projected.sidecar.refused, 'all_busy');
  // 负控 ①：对象形状（`sidecar.js` 的 `onUnavailable` 原样）仍必须认。
  assert.equal(projectInstance({ stage: 'failed', sidecar: { refused: { code: 'busy_running' } } })
    .sidecar.refused, 'busy_running');
  // 负控 ②：没有成因就是没有 ⇒ null，不许补一个 'unknown' 的假出处。
  assert.equal(projectInstance({ stage: 'failed' }).sidecar.refused, null);
});

test('★★ ⑥·投影把等待的账带出去（`wait` 四个标量；没走到等待段时为 null）', () => {
  assert.equal(projectInstance({ stage: 'reused', sidecar: { picked: 1 } }).wait, null,
    '★ 这一轮压根没等 ⇒ 没有 wait，而不是一个假的 0 窗口');
  const out = projectInstance({
    stage: 'failed', code: 'no_sidecar_appeared',
    wait: { firstWindowMs: 30_000, totalWaitMs: 600_000, continued: true, polls: 144 },
  });
  assert.deepEqual(out.wait, { firstWindowMs: 30_000, totalWaitMs: 600_000, continued: true, polls: 144 },
    '★ "等了 10 分钟、人一直没来"必须与"30s 就死"在回执上长得不一样');
  // 负控：垃圾输入不许把投影变成一个看起来像真结论的东西。
  assert.deepEqual(projectInstance({ stage: 'failed', wait: 'x' }).wait,
    { firstWindowMs: 0, totalWaitMs: 0, continued: false, polls: 0 });
});