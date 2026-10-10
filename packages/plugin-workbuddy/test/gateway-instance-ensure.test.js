// 目标实例保障（★ 2026-09-30）：下发链路的第 0 站「实例在不在 → 要不要起 → 起了没 → 等到了吗」。
//
// ★ 这组测试的第一职责**不是**证明"能起"，而是证明**别把四种处置不同的局面说成同一句话**：
//   桌面端没开 / 活性判不出 / 拉起失败 / 起了没就绪 / 起了也不出 sidecar —— 五种各有各自的 code，
//   而旧代码全报 `no_sidecar` + 一句"请打开桌面端"。真机上桌面端开着 7 个进程时，
//   那句话是**错的**，且会把用户送去重启一个正在好好运行的桌面端。
//
// ★★ fixture 纪律（2026-10-10 起改写）：本文件原先钉的是 `tasklist` CSV 逐字输出
//   （`TASKLIST_REAL` = 7 个 WorkBuddy.exe，`TASKLIST_NO_MATCH` = `INFO: No tasks…`）。
//   `tasklist` 是**控制台进程**，Owner 硬约束（插件任何路径都不许拉起显/隐 Shell/控制台
//   进程）下整体删除，`parseTasklistPids` 一并删除。判据换成 **broker 命名管道握手**
//   （`isDesktopRunning`）：连 `endpoint.json` 里那个管道、完成 HMAC 双向证明。
//   fixture 因此从"一段 CSV 文本"变成"一个假 `connect`"，见下面 `brokerStub()`。
//   ★ 依旧不编造：假件按 `wbipc.js` 的协议真的算一遍 proof，而不是"连上就算活"。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BROKER_PROBE_TIMEOUT_MS, DEFAULT_READY_TIMEOUT_MS, DESKTOP_IMAGE, findDesktopExe,
  isBrokerReady, isDesktopRunning, launchDesktop, waitForDesktop,
} from '../src/host/gateway/desktop.js';
import { createEnsurer, ENSURE_CODE, ENSURE_STAGE, projectInstance } from '../src/host/gateway/ensure.js';
import { createDispatcher } from '../src/host/gateway/dispatch.js';
import { instanceLine, startGatewayRun } from '../src/host/tools/gateway-run.js';
import { makeStatusTool } from '../src/host/tools/status.js';

// ══════════════════════════════════════════════════════════════════════════════
// 0. broker 管道探针的假件（2026-10-10 起"桌面端在不在"的唯一判据）
// ══════════════════════════════════════════════════════════════════════════════

const EP_BYTES = JSON.stringify({ endpoint: '\\\\.\\pipe\\wbipc-fixture', ticket: 'fixture-ticket' });

/** 在 `tmp/` 里造一份端点文件（★ 绝不碰 `~/.workbuddy/`），`staleMs` = 把 mtime 往回拨多少毫秒。 */
function endpointFixture({ staleMs = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-ep-'));
  const file = join(dir, 'endpoint.json');
  writeFileSync(file, EP_BYTES);
  const mtime = Date.now() - staleMs;
  utimesSync(file, mtime / 1000, mtime / 1000);
  return { file, mtime, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * 假 `net.connect`：三种桌面端局面各有一个形状。
 *
 * <p>★ 为什么自己算一遍 proof，而不是"连上就判活"：
 *   `isDesktopRunning` 的真契约是"broker 此刻应不应答"，而应答应由**服务端自证**
 *   （`session_challenge` → `session_prove`）来证明。假件按协议真算，
 *   于是它验的是"自证通过后判活"，而不是"只要 connect 回调了就判活"——
 *   后者会把一个连上但回话的不是我们那个 broker 的管道也判成桌面端活着。
 *
 * <p>★ `gone` 必须在 **socket 上发 error**，不能同步 throw：
 *   真实 `net.connect` 从不同步抛错，`wbipc.js` 的 `classifyConnectFailure` 挂在
 *   socket 的 `error` 事件上。同步 throw 会把"管道不在了"变成"代码抛异常"，
 *   `isDesktopRunning` 就只能判 `running:null`（判不出来）而不是 `false`。
 */
function brokerStub({ mode = 'up' } = {}) {
  return (endpoint) => {
    const sock = new EventEmitter();
    let clientNonce = '';
    sock.write = (line) => {
      const f = JSON.parse(String(line));
      if (f.type === 'session_hello') clientNonce = String(f.client_nonce ?? '');
      if (f.type === 'session_prove') {
        setImmediate(() => sock.emit('data', Buffer.from('{"type":"session_hello_ack","connection_epoch":1}\n')));
      }
      return true;
    };
    sock.destroy = () => {};
    setImmediate(() => {
      sock.emit('connect');
      if (mode === 'gone') {
        const e = new Error(`connect ENOENT ${endpoint}`);
        e.code = 'ENOENT';
        sock.emit('error', e);
        return;
      }
      const serverNonce = 'srv-nonce';
      const proof = mode === 'untrusted'
        ? 'deliberately-wrong'
        : createHmac('sha256', Buffer.from('fixture-ticket', 'utf8'))
          .update(Buffer.concat(['wbipc-s', '1', endpoint, clientNonce, serverNonce]
            .map((p) => {
              const b = Buffer.from(p, 'utf8');
              const len = Buffer.alloc(4);
              len.writeUInt32BE(b.length);
              return Buffer.concat([len, b]);
            }))).digest('base64url');
      sock.emit('data', Buffer.from(JSON.stringify({
        type: 'session_challenge', protocol: 1, server_nonce: serverNonce, server_proof: proof,
      }) + '\n'));
    });
    return sock;
  };
}

/** 桌面端"活着"⇒ `running:true`。 */
const BROKER_UP = { brokerConnect: brokerStub({ mode: 'up' }) };
/** 管道 ENOENT ⇒ `running:false`（确定的否定答案，可以走拉起那一支）。 */
const BROKER_GONE = { brokerConnect: brokerStub({ mode: 'gone' }) };
/** 连上但服务端自证不过 ⇒ `running:null`（判不出来，**不许**去拉起）。 */
const BROKER_UNTRUSTED = { brokerConnect: brokerStub({ mode: 'untrusted' }) };

// ══════════════════════════════════════════════════════════════════════════════
// 1. isDesktopRunning —— broker 管道探针（2026-10-10 取代 tasklist 枚举）
//
//    ★ 先证明这个探测器**认得**已知失败。三态，对应三种处置：
//      true  管道握手通过 ⇒ 桌面端活着
//      false 管道 ENOENT / 端点文件读不到 ⇒ **确定的否定答案**，可以走拉起那一支
//      null  协议不信赖 / 超时 ⇒ 判不出来 ⇒ 不许去拉起（多开实例抢凭据运行时）
// ══════════════════════════════════════════════════════════════════════════════

test('★ 探测器自检：管道握手通过 ⇒ running:true，且不带 error', async () => {
  const fx = endpointFixture({ staleMs: 60_000 });
  const yes = await isDesktopRunning({ endpointFile: fx.file, connect: brokerStub({ mode: 'up' }) });
  fx.cleanup();
  assert.equal(yes.running, true);
  assert.equal(yes.error, null);
});

test('★ 管道 ENOENT ⇒ running:false（确定的否定答案，**不是**"枚举失败"）', async () => {
  // ★ 没有这一条，"能跑通"就只是一句自夸：一个把 ENOENT 也当"判不出来"的探测器
  //   永远返回 null ⇒ 永远不去拉起 ⇒ autoStartDesktop 整个静默失效。
  const fx = endpointFixture({ staleMs: 60_000 });
  const no = await isDesktopRunning({ endpointFile: fx.file, connect: brokerStub({ mode: 'gone' }) });
  fx.cleanup();
  assert.equal(no.running, false);
  assert.match(no.error, /no longer exists|open the WorkBuddy desktop/i,
    '★ 文案必须由 classifyConnectFailure 翻成可执行的那句，而不是裸 ENOENT 路径');
});

test('★★ 活性判不出必须与"没在跑"分开（分不清就会多开一个桌面端抢凭据运行时）', async () => {
  const fx = endpointFixture({ staleMs: 60_000 });
  const boom = await isDesktopRunning({ endpointFile: fx.file, connect: brokerStub({ mode: 'untrusted' }) });
  fx.cleanup();
  assert.equal(boom.running, null, '★ 服务端自证不过 ⇒ 判不出来，不是"没在跑"');
  assert.match(boom.error, /not trustworthy/);
});

test('★★ 端点文件整个读不到 ⇒ running:false（wbipc_desktop_closed）', async () => {
  const no = await isDesktopRunning({
    endpointFile: 'C:\\definitely-not-here\\endpoint.json',
    connect: brokerStub({ mode: 'up' }),   // 连不连都无所谓：文件就没有
  });
  assert.equal(no.running, false);
  assert.match(no.error, /endpoint not found/i);
});

test('★★ 探针**一个进程都不起**：isDesktopRunning 的形参里没有 run/argv', async () => {
  // 这不是装饰：`tasklist` 那条 argv 曾经就在这个形参里。把它加回来，
  // 这条连同下面的 desktop.js 源码断言会一起转红。
  const fx = endpointFixture({ staleMs: 60_000 });
  const r = await isDesktopRunning({
    endpointFile: fx.file,
    // 观察点：给一个会抛的 `run`（旧签名）。新实现**不该**读它。
    run: async () => { throw new Error('任何进程出口都不该被碰'); },
    connect: brokerStub({ mode: 'up' }),
  });
  fx.cleanup();
  assert.equal(r.running, true, '★ 只有 brokerConnect 参与判定');
});

test('★★ desktop.js 源码里不得再出现任何进程出口字样', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/host/gateway/desktop.js', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'))
    .join('\n');
  for (const needle of ['tasklist', 'netstat', 'lsof', 'pwsh', 'powershell', 'spawn(']) {
    assert.equal(src.includes(needle), false, `★ desktop.js 代码里不得再出现 ${needle}`);
  }
  assert.doesNotMatch(src, /parseTasklistPids/, '★ parseTasklistPids 必须已删除');
  assert.match(src, /isDesktopRunning/, '★ 新的 broker 管道探针必须在位');
  assert.match(src, /BROKER_PROBE_TIMEOUT_MS/, '★ 探针必须有界');
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. launchDesktop
// ══════════════════════════════════════════════════════════════════════════════

test('★ 拉起是"火枪式"的：绝不 await 退出（GUI 永不会退出）', async () => {
  // 一个**永不 settle** 的 done。若实现去 await 它，这个测试会超时而不是通过。
  const handle = { pid: 31337, done: new Promise(() => {}) };
  const r = await launchDesktop({ launcher: () => handle }, { exe: 'C:\\x\\WorkBuddy.exe' });
  assert.equal(r.started, true);
  assert.equal(r.pid, 31337);
  assert.equal(r.error, null);
});

test('launcher 抛异常 ⇒ started:false 且带上原因（不外抛）', async () => {
  const r = await launchDesktop({
    launcher: () => { throw new Error('EPERM'); },
  }, { exe: 'C:\\x\\WorkBuddy.exe' });
  assert.equal(r.started, false);
  assert.equal(r.pid, null);
  assert.match(r.error, /EPERM/);
});

test('handle 无 pid 时报 null 而不是 0/NaN', async () => {
  const r = await launchDesktop({ launcher: () => ({}) }, { exe: 'C:\\x\\WorkBuddy.exe' });
  assert.equal(r.started, true);
  assert.equal(r.pid, null);
});

test('★★ launcher 的 `done` **reject** ⇒ 不变成未处理拒绝（T7）', async () => {
  // ★ 为什么单独一条：`launchDesktop` 故意不 await `done`（GUI 永不会退出），
  //   所以只能给它挂一个空 catch。**没挂**的话，进程将来以非 0 退出会在这一轮**之外**
  //   炸出一个 unhandledRejection —— 那不是本次作业的错，却会把整条作业带下去。
  // ★ 证法不是"没抛"（没抛也可能只是还没轮到）：挂一个监听器，**等它真的落地**再断言没响过。
  const seen = [];
  const onUnhandled = (e) => seen.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const r = await launchDesktop({
      launcher: () => ({ pid: 31337, done: Promise.reject(new Error('workbuddy exited with code 1')) }),
    }, { exe: 'C:\\x\\WorkBuddy.exe' });
    assert.equal(r.started, true, '★ 拉起本身仍然算成功（退出是之后的事）');
    assert.equal(r.pid, 31337);
    // ★ 等两个宏任务：unhandledRejection 在微任务检查点之后才发。
    await new Promise((r2) => { setImmediate(r2); });
    await new Promise((r2) => { setTimeout(r2, 10); });
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(seen.map((e) => e.message), [], '★ `done` 的拒绝必须已被吞掉（拉起路径不负责它）');
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. findDesktopExe（纯读）
// ══════════════════════════════════════════════════════════════════════════════

test('找不到任何已知安装位 ⇒ null（不是瞎猜一条路径去启动）', () => {
  assert.equal(findDesktopExe({}), null);
  assert.equal(findDesktopExe({ ProgramFiles: 'C:\\no-such-dir' }), null);
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. waitForDesktop
// ══════════════════════════════════════════════════════════════════════════════
//
// ★★ 端点夹具：为什么不能"随手写一份 endpoint.json" ★★
//   `wbipc.js:58` 记着一条真机事实：桌面退出时 `endpoint.json` **不删**，重启时**滞后异步重写**。
//   于是"本轮落盘的端点"与"上一轮残留的端点"在**内容上逐字节同形** —— 上一版的夹具在 launcher
//   里同步写好一份，因此这套测试根本分辨不出"刚落的"和"3 小时前落的"，F1 才能全绿。
//   唯一能免开眼的差别是 **mtime**：下面一律用 `utimesSync` 把同一份字节的 mtime 钉到指定时刻，
//   于是"新不新鲜"成为判定的**唯一变量**。
//   （夹具本体 `EP_BYTES` / `endpointFixture()` 已在文件头部定义，见第 0 节。）

/** 每 100 走 100ms 的假时钟（供 `waitForDesktop` 用）。 */
const tickingClock = () => (() => { let t = 0; return () => (t += 100); })();

test('★★ T1·正面：同一份端点字节，mtime 落在拉起**之后** ⇒ ready:true（这一支原先零覆盖）', async () => {
  const fx = endpointFixture({ staleMs: 3 * 3600_000 });   // 文件本身是"旧的"写法，但 stamp 更旧
  const r = await waitForDesktop(
    { sleep: async () => {}, now: tickingClock() },
    { timeoutMs: 1000, endpointFile: fx.file, notBeforeMs: fx.mtime - 10_000 },
  );
  fx.cleanup();
  assert.equal(r.ready, true, '★ mtime ≥ 拉起那一刻 ⇒ 本轮桌面端确实落过盘了');
  assert.equal(r.aborted, false);
  assert.equal(r.error, null);
  assert.ok(r.waitedMs <= 100, `第一轮就该就绪，跑了 ${r.waitedMs}ms`);
});

test('★★★ T1·反面：同一份端点字节，mtime 落在拉起**之前** ⇒ 不 ready（F1·残留冒充就绪）', async () => {
  // ★ 与上一条**逐字节同一个文件**，唯一差别是 stamp 相对 mtime 的位置 ——
  //   换句话说：这一对用例合起来证明"新鲜度真的参与了判定"，而不是被别的东西顺带判过。
  // ★ 间隔取 10s 而不是 1s：新鲜度判定带 2s 容差（`ENDPOINT_FRESHNESS_SLACK_MS`，
  //   墙钟与文件时间戳不同源），间隔小于容差的用例会只测到容差。
  const fx = endpointFixture({ staleMs: 3 * 3600_000 });
  const r = await waitForDesktop(
    { sleep: async () => {}, now: tickingClock() },
    { timeoutMs: 1000, endpointFile: fx.file, notBeforeMs: fx.mtime + 10_000 },
  );
  fx.cleanup();
  assert.equal(r.ready, false, '★ 上一轮的残留端点不能当成本轮"桌面端已就绪"');
  assert.equal(r.stale, true, '★ 归因要能说清是"陈旧"而不是"读不到"');
  assert.match(r.lastDetail, /stale/);
});

test('★★ 新鲜度容差：mtime 只比 stamp 早 1s 仍算新鲜（别把本轮自己的端点判成陈旧）', async () => {
  // ★ 本机实测：紧接着 `Date.now()` 写下去的文件，3000 次里 203 次 mtime **比它还早**（最多 0.96ms）。
  //   没有这道容差的话，桌面端刚落盘就有一小撮概率被判成"陈旧"，然后白等满 90s
  //   报 `desktop_not_ready` —— 那是**假阴性**，比修复前的假阳性更难查。
  const fx = endpointFixture({ staleMs: 3 * 3600_000 });
  const r = await isBrokerReady({ endpointFile: fx.file, notBeforeMs: fx.mtime + 1000 });
  fx.cleanup();
  assert.equal(r.ready, true, '★ 1s 偏差属于墙钟/文件系统时间戳的正常噪声');
});

test('★★ 新鲜度容差：mtime 比 stamp 早 5s 就算陈旧（容差不许膨胀到能放行残留）', async () => {
  const fx = endpointFixture({ staleMs: 3 * 3600_000 });
  const r = await isBrokerReady({ endpointFile: fx.file, notBeforeMs: fx.mtime + 5000 });
  fx.cleanup();
  assert.equal(r.ready, false, '★ 容差必须落在 (1s, 5s) 这个窄窗口里，不能拿它当"差不多就算新"');
  assert.equal(r.stale, true);
});

test('★★ 残留端点 + 桌面端随后重写 ⇒ 从"陈旧"翻到"就绪"（真机那 2s 窗口）', async () => {
  const fx = endpointFixture({ staleMs: 3 * 3600_000 });
  let polls = 0;
  const r = await waitForDesktop({
    sleep: async () => {
      polls += 1;
      // ★ 桌面端在第 3 轮把端点**重写** —— 正是真机那 2s 的形状（`wbipc.js:58`：
      //   "重启时滞后异步重写"）。没有这个翻转，这条用例永远翻不过去，也就什么都没测。
      if (polls >= 3) writeFileSync(fx.file, EP_BYTES);
    },
    now: tickingClock(),
  }, { timeoutMs: 5000, endpointFile: fx.file, notBeforeMs: fx.mtime + 10_000, pollMs: 1 });
  fx.cleanup();
  assert.equal(r.ready, true, '★ 陈旧端点不得让整个窗口一票否决（真机 desktop 会重写它）');
});

test('waitForDesktop：端点**根本没有** ⇒ 不 ready（真机启动那 2 秒）', async () => {
  const notReady = await waitForDesktop(
    {
      sleep: async () => {},
      now: tickingClock(),
    },
    { timeoutMs: 250, endpointFile: 'C:\\definitely-not-here\\endpoint.json' },
  );
  assert.equal(notReady.ready, false, '端点没落盘 ≠ 就绪');
  assert.equal(notReady.stale, false, '★ 文件压根没有 ⇒ 不是"陈旧"，是"没有"（归因不同）');
  assert.match(notReady.lastDetail ?? '', /endpoint\.json/);
});

test('★ 没有 stamp ⇒ 不做新鲜度判断（"本来就在跑"的桌面端，其端点必然早于本次调用）', async () => {
  const fx = endpointFixture({ staleMs: 30 * 24 * 3600_000 });
  const r = await isBrokerReady({ endpointFile: fx.file });     // 老到离谱，但没给 stamp
  fx.cleanup();
  assert.equal(r.ready, true, '★ 一个月前的端点在"本来就在跑"这条路上仍算就绪（那是它的启动时刻）');
});

test('isBrokerReady：endpoint 为空 / 缺 ticket ⇒ 不 ready（归一在 `readEndpoint` 里，detail 不许说谎）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-ep-'));
  const a = join(dir, 'empty.json');
  const b = join(dir, 'no-ticket.json');
  writeFileSync(a, JSON.stringify({ endpoint: '', ticket: 't' }));
  writeFileSync(b, JSON.stringify({ endpoint: '\\\\.\\pipe\\x' }));
  const ra = await isBrokerReady({ endpointFile: a });
  const rb = await isBrokerReady({ endpointFile: b });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(ra.ready, false);
  assert.equal(rb.ready, false);
  assert.match(ra.detail, /endpoint\.json/);
  assert.match(rb.detail, /endpoint\.json/);
});

test('★★ 默认端点路径必须与 `wbipc.js` 同位（`desktop.js` 里那份是抄来的）', async () => {
  // ★ 为什么需要这条：`desktop.js` 为了读 mtime 自己拼了一份默认路径常量。
  //   两份常量必漂一处，所以**不是"顺手抄一下"就完事** —— 这里把它钉死：
  //   `USERPROFILE` 指向 tmp ⇒ `os.homedir()` 换位（`readEndpoint` 的默认参数每次调用现取），
  //   于是"不传 endpointFile"时两个模块必须读到**同一个**文件。谁改了一边而没改另一边，这里转红。
  const dir = mkdtempSync(join(tmpdir(), 'wb-home-'));
  mkdirSync(join(dir, '.workbuddy', 'wbipc'), { recursive: true });
  writeFileSync(join(dir, '.workbuddy', 'wbipc', 'endpoint.json'), EP_BYTES);
  const prev = process.env.USERPROFILE;
  process.env.USERPROFILE = dir;
  let r;
  try {
    r = await isBrokerReady({ notBeforeMs: Date.now() - 60_000 });
  } finally {
    if (prev === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(r.ready, true, '★ `desktop.js` 的默认位与 `wbipc.js` 的默认位必须一致（★ 全程不碰真 ~/.workbuddy）');
});

test('waitForDesktop：超时后带出最后一条 detail，不抛', async () => {
  const r = await waitForDesktop({
    sleep: async () => {},
    now: tickingClock(),
  }, { timeoutMs: 300, endpointFile: 'C:\\definitely-not-here\\endpoint.json' });
  assert.equal(r.ready, false);
});

test('★★ waitForDesktop：轮询途中取消 ⇒ 立刻返回 aborted（不跑满窗口）', async () => {
  const ac = new AbortController();
  let polls = 0;
  const r = await waitForDesktop({
    sleep: async () => { polls += 1; if (polls === 2) ac.abort(); },
    now: tickingClock(),
  }, {
    timeoutMs: 60_000, endpointFile: 'C:\\definitely-not-here\\endpoint.json', signal: ac.signal,
  });
  assert.equal(r.ready, false);
  assert.equal(r.aborted, true, '★ 取消必须被认出来，而不是伪装成"超时"');
  assert.equal(polls, 2, `★ 第 2 轮取消 ⇒ 之后一次端点轮询都不该再发（实际 ${polls} 次）`);
  assert.ok(r.waitedMs <= 300, `窗口是 60s，实际只跑了 ${r.waitedMs}ms`);
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. ensure —— ★ 每一条 stage/分支都要有一个"必须失败"的负例和一个"必须通过"的正例
// ══════════════════════════════════════════════════════════════════════════════

const NO_SIDECAR = { picked: null, why: { code: 'all_busy', detail: 'n' }, scanned: 3 };
const PICKED = { pid: 4242, url: 'http://127.0.0.1:1234', kind: 'interactive' };

/** 构造一个"假时钟"：每次 now() 前进 `step`，sleep 同步推进同样的量。 */
function fakeClock(start = 0, step = 1000) {
  let t = start;
  return { now: () => t, sleep: async () => { t += step; } };
}

test('★ stage=reused：一开始就有可用 sidecar ⇒ 全程零桌面端动作', async () => {
  let probed = 0;
  const { ensure } = createEnsurer({
    probe: async () => ({ picked: PICKED, why: null, scanned: 5 }),
    brokerProbe: async () => { probed += 1; return { running: true, error: null }; },
    launcher: () => { throw new Error('绝不该被调用'); },
  });
  const r = await ensure();
  assert.equal(r.ok, true);
  assert.equal(r.report.stage, ENSURE_STAGE.REUSED);
  assert.equal(r.report.code, 'ok');
  assert.deepEqual(r.report.desktop, null, '根本没走到桌面端那一步 ⇒ 不该有桌面端结论');
  assert.equal(r.sidecar.pid, 4242);
  assert.equal(probed, 0, '★ 已经有可用 sidecar 了，连 broker 管道都不该去连');
  assert.equal(r.report.hint, null);
});

test('★ 活性探针一句实话都递不出来（裁剪装配）⇒ desktop_probe_failed，且**不**去拉起', async () => {
  // ★ 这是"装配被裁剪、连 broker 管道探针都没接"的那种现场。
  //   注意它**不是**"桌面端没开"：两者处置不同，所以必须是两个 code。
  //   ★ 刻意用 `brokerProbe` 注入"我什么都判不出来"，而不是"什么都不注入"——
  //     后者会让测试去连**真机**的 `~/.workbuddy/wbipc/endpoint.json`（纪律禁止，
  //     且结论随测试机上桌面端开没开而漂）。
  let launched = 0;
  const { ensure } = createEnsurer({
    probe: async () => NO_SIDECAR,
    brokerProbe: async () => ({ running: null, error: 'broker probe not wired (trimmed assembly)' }),
    launcher: () => { launched += 1; return { pid: 1 }; },
    findExe: () => ({ path: 'C:\\x\\WorkBuddy.exe', source: 't' }),
  });
  const r = await ensure();
  assert.equal(r.report.code, ENSURE_CODE.DESKTOP_PROBE_FAILED);
  assert.match(r.report.desktop.probeError, /broker probe not wired/);
  assert.equal(launched, 0, '这一条是本模块最容易写错的地方');
  assert.match(r.report.hint, /did not launch a second copy on purpose/);
});

test('★ 活性判不出（管道连上但服务端自证不过）⇒ desktop_probe_failed，且**不**去拉起', async () => {
  // ★ 枚举失败 ≠ 没在跑的纪律原样保留，只是判据从 tasklist 换成 broker 管道。
  let launched = 0;
  const fx = endpointFixture({ staleMs: 60_000 });
  const { ensure } = createEnsurer({
    probe: async () => NO_SIDECAR,
    ...BROKER_UNTRUSTED,
    endpointFile: fx.file,
    launcher: () => { launched += 1; return { pid: 1 }; },
    findExe: () => ({ path: 'C:\\x\\WorkBuddy.exe', source: 't' }),
  });
  const r = await ensure();
  fx.cleanup();
  assert.equal(r.report.code, ENSURE_CODE.DESKTOP_PROBE_FAILED);
  assert.match(r.report.desktop.probeError, /not trustworthy/);
  assert.equal(launched, 0, '★ 判不出来就不许去拉起（多开实例抢凭据运行时）');
  assert.match(r.report.hint, /did not launch a second copy on purpose/);
});

test('★ 桌面端没开（管道 ENOENT）+ autoStart 关 ⇒ 不拉起，报 no_usable_sidecar', async () => {
  let launched = 0;
  const { ensure } = createEnsurer({
    probe: async () => NO_SIDECAR,
    ...BROKER_GONE,
    endpointFile: 'C:\\definitely-not-here\\endpoint.json',
    autoStart: () => false,
    launcher: () => { launched += 1; return { pid: 1 }; },
  });
  const r = await ensure();
  assert.equal(r.report.code, ENSURE_CODE.NO_USABLE_SIDECAR);
  assert.equal(r.report.desktop.running, false);
  assert.equal(launched, 0);
});

test('★ 桌面端没开 + 找不到安装位 ⇒ desktop_not_installed', async () => {
  const { ensure } = createEnsurer({
    probe: async () => NO_SIDECAR,
    ...BROKER_GONE,
    endpointFile: 'C:\\definitely-not-here\\endpoint.json',
    autoStart: () => true,
    findExe: () => null,
    launcher: () => ({ pid: 1 }),
  });
  const r = await ensure();
  assert.equal(r.report.code, ENSURE_CODE.DESKTOP_NOT_INSTALLED);
  assert.match(r.report.hint, /not found in any known install location/);
});

test('★ 拉起失败 ⇒ desktop_launch_failed，且带出原因', async () => {
  const { ensure } = createEnsurer({
    probe: async () => NO_SIDECAR,
    ...BROKER_GONE,
    endpointFile: 'C:\\definitely-not-here\\endpoint.json',
    autoStart: () => true,
    findExe: () => ({ path: 'C:\\x\\WorkBuddy.exe', source: 't' }),
    launcher: () => { throw new Error('access denied'); },
  });
  const r = await ensure();
  assert.equal(r.report.code, ENSURE_CODE.DESKTOP_LAUNCH_FAILED);
  assert.match(r.report.desktop.launchError, /access denied/);
});

test('★ 拉起了但端点始终不落盘 ⇒ desktop_not_ready（**不是**"任务可以跑了"）', async () => {
  const clk = fakeClock();
  let launched = 0;
  const { ensure } = createEnsurer({
    probe: async () => NO_SIDECAR,
    // ★ 关键：拉起**之前**桌面端必须"没在跑"（管道 ENOENT），否则 ensure 根本不会走
    //   拉起那条路，这条测试就会退化成 no_sidecar_appeared —— 一个看起来通过、
    //   其实什么都没测的测试。
    ...BROKER_GONE,
    endpointFile: 'C:\\definitely-not-here\\endpoint.json',
    sleep: clk.sleep,
    now: clk.now,
    waitMs: 3000,
    autoStart: () => true,
    findExe: () => ({ path: 'C:\\x\\WorkBuddy.exe', source: 't' }),
    launcher: () => { launched += 1; return { pid: 999 }; },
    endpointFile: 'C:\\definitely-not-here\\endpoint.json',
  });
  const r = await ensure();
  assert.equal(r.report.stage, ENSURE_STAGE.FAILED);
  assert.equal(r.report.code, ENSURE_CODE.DESKTOP_NOT_READY);
  assert.equal(r.report.desktop.launched, true, '确实拉起了');
  assert.equal(r.report.desktop.ready, false, '但没就绪 —— 这两件事必须分开记');
  assert.match(r.report.hint, /never published its broker endpoint/);
});

test('★ 桌面端在跑但不出 sidecar ⇒ no_sidecar_appeared（不是"去打开桌面端"）', async () => {
  const clk = fakeClock();
  // ★ 必须显式给一个**存在**的端点夹具：这一支现在会真去问 broker 端点（F2），
  //   不给就等于让测试去读本机 `~/.workbuddy`（纪律禁止，且结论会随测试机上
  //   桌面端开没开而漂）。`ready === true` 只有在端点真的在那儿时才是**真话**。
  const fx = endpointFixture({ staleMs: 60_000 });
  const { ensure } = createEnsurer({
    probe: async () => NO_SIDECAR,
    ...BROKER_UP,
    sleep: clk.sleep,
    now: clk.now,
    waitMs: 3000,
    autoStart: () => true,
    endpointFile: fx.file,
  });
  const r = await ensure();
  fx.cleanup();
  assert.equal(r.report.code, ENSURE_CODE.NO_SIDECAR_APPEARED);
  assert.equal(r.report.desktop.running, true);
  assert.equal(r.report.desktop.ready, true, '★ 端点夹具在位 ⇒ 这一支的 ready 是**真话**，不是"进程在就算"');
  assert.equal(r.report.desktop.launched, false, '已在跑 ⇒ 一个字节都不写');
  assert.match(r.report.hint, /no agent sidecar within the wait window/);
  // ★ 真机那 5 次凭据引导失败就在这个分支上；提示必须指向"桌面端侧的问题"，
  //   而不是让用户去重启一个已经好好运行的桌面端。
  assert.doesNotMatch(r.report.hint, /Start the WorkBuddy desktop and sign in/);
});

test('★★★ F2：桌面端活着但 broker 端点**根本不存在** ⇒ ready 必须是 false（旧代码零校验写死 true）', async () => {
  const clk = fakeClock();
  const { ensure } = createEnsurer({
    probe: async () => NO_SIDECAR,
    // ★ 管道握手通过（⇒ `running:true`），但端点文件根本读不出来（⇒ `ready:false`）。
    //   ★ 为什么必须用 `brokerProbe` 而不是 `brokerConnect`：`connectWbipc` 会先
    //     `readEndpoint(endpointFile)`，文件不存在时它直接抛 DESKTOP_CLOSED ⇒
    //     `running:false`，就走"没在跑"那一支了，这条用例根本到不了它要测的分支。
    //     两件事必须能分开喂：管道活着、端点文件没有。
    brokerProbe: async () => ({ running: true, error: null }),
    sleep: clk.sleep,
    now: clk.now,
    waitMs: 3000,
    autoStart: () => true,
    endpointFile: 'C:\\definitely-not-here\\endpoint.json',   // 永不存在
  });
  const r = await ensure();
  assert.equal(r.report.desktop.running, true, '★ 桌面端确实活着（这半句仍然为真）');
  assert.equal(r.report.desktop.ready, false,
    '★ "活着"与"broker 端点已就绪"是**两件事**，不能压进同一个布尔');
  assert.match(r.report.desktop.brokerDetail, /endpoint\.json/,
    '★ 归因要留下：不然 ready:false 和"桌面端刚起来还没写完"长得一模一样');
  // ★ 这条旧行为还会顺带污染投影：projectInstance 把它直接送到用户/模型眼前。
  const projected = projectInstance(r.report);
  assert.deepEqual(projected.desktop, { running: true, launched: false, ready: false },
    '★ 出插件的形状也必须说 ready:false');
});

test('★★ F2·不制造假阴性：真机场景（桌面端在跑 + 端点在）仍必须 ready:true', async () => {
  // ★ 只钉住"false 侧"是**半个探测器**：一个把所有 ready 都写成 false 的实现也能全绿。
  //   这条钉住反面 —— 端点真在位时，那一支不得退化成假阴性。
  const clk = fakeClock();
  const fx = endpointFixture({ staleMs: 5_000 });
  let calls = 0;
  const { ensure } = createEnsurer({
    probe: async () => {
      calls += 1;
      return calls < 3 ? NO_SIDECAR : { picked: PICKED, why: null, scanned: 1 };
    },
    ...BROKER_UP,
    sleep: clk.sleep,
    now: clk.now,
    waitMs: 10_000,
    autoStart: () => true,
    endpointFile: fx.file,
  });
  const r = await ensure();
  fx.cleanup();
  assert.equal(r.report.desktop.ready, true, '★ 端点在 ⇒ 桌面端在跑这一支必须照常判就绪');
  assert.equal(r.report.desktop.brokerDetail, null);
});

test('★ stage=waited：等的过程中 sidecar 出现 ⇒ ok，且记下等了多久', async () => {
  const clk = fakeClock(0, 500);
  const fx = endpointFixture({ staleMs: 30_000 });
  let calls = 0;
  const { ensure } = createEnsurer({
    probe: async () => {
      calls += 1;
      return calls < 3 ? NO_SIDECAR : { picked: PICKED, why: null, scanned: 1 };
    },
    ...BROKER_UP,
    sleep: clk.sleep,
    now: clk.now,
    waitMs: 10_000,
    autoStart: () => true,
    endpointFile: fx.file,
  });
  const r = await ensure();
  fx.cleanup();
  assert.equal(r.ok, true);
  assert.equal(r.report.stage, ENSURE_STAGE.WAITED);
  assert.equal(r.sidecar.pid, 4242);
  assert.ok(r.report.waitedMs >= 500, `等了 ${r.report.waitedMs}ms，应至少有一个轮询周期`);
});

test('★★★ F1·反面：残留端点 + 本轮桌面端**没重写** ⇒ desktop_not_ready（不是 ready:true）', async () => {
  // ★ 这是"用户昨天开过桌面端、今天关着跑任务"那个**最常见**局面的正面复现：
  //   `endpoint.json` 是昨天那次留下的（桌面退出不删），本轮拉起后它**一直没被重写**。
  //   旧代码第一轮轮询就 `ready:true`，90s 的冷启动窗口被跳到 10ms，
  //   报告里还落一句**假的** "broker endpoint present"。
  const clk = fakeClock(0, 1000);
  const fx = endpointFixture({ staleMs: 3 * 3600_000 });
  let launched = 0;
  const { ensure } = createEnsurer({
    probe: async () => NO_SIDECAR,
    ...BROKER_GONE,
    endpointFile: 'C:\\definitely-not-here\\endpoint.json',
    sleep: clk.sleep,
    now: clk.now,
    waitMs: 30_000,
    autoStart: () => true,
    findExe: () => ({ path: 'C:\\x\\WorkBuddy.exe', source: 't' }),
    launcher: () => { launched += 1; return { pid: 999 }; },   // ★ 故意**不**重写端点
    endpointFile: fx.file,
  });
  const r = await ensure();
  fx.cleanup();
  assert.equal(r.report.code, ENSURE_CODE.DESKTOP_NOT_READY, '★ 陈旧端点不得冒充"本轮已就绪"');
  assert.equal(r.report.desktop.launched, true);
  assert.equal(r.report.desktop.ready, false);
  assert.match(r.report.desktop.brokerDetail, /stale/, '★ 归因必须落在"陈旧"上');
  // ★ 那句假的 ready 记述不许出现在时间线里。
  assert.equal(
    r.report.attempts.some((a) => a.stage === 'ready' && /broker endpoint present/.test(a.detail)),
    false,
    `时间线里落了假的 ready 记述：${JSON.stringify(r.report.attempts)}`,
  );
  // ★ 冷启动窗口不许被跳掉：至少等满 DEFAULT_READY_TIMEOUT_MS。
  assert.ok(r.report.waitedMs >= DEFAULT_READY_TIMEOUT_MS,
    `只等了 ${r.report.waitedMs}ms，冷启动余量被跳过了`);
});

test('★★★ F1·回声：陈旧端点的那句 hint 不得说"桌面端没启动完"（同一个 code，两句不同的话）', async () => {
  // ★ 这条钉的是**两句自相矛盾**的那份回执：F1 修好之后，"端点陈旧"与"端点没落盘"
  //   共用 `DESKTOP_NOT_READY`，于是陈旧那一支也照抄了"the desktop did not finish starting.
  //   Check the desktop window" —— 而同一份回执的 `brokerDetail` 正写着
  //   `endpoint.json predates this launch (stale)`。盘上那份文件是**上一轮**留下的，
  //   桌面端完全可能好得很；被第一句指去查"启动失败"是**错的**排查方向。
  //
  // ★ 两个分支跑在**同一个 ensurer 形状**上，唯一差别是端点文件：一份 3 小时前的残留，
  //   一份根本不存在。**必须两个都跑** —— 只钉 stale 那一句的话，
  //   一个把 hint 改成常量 `''` 的实现也能全绿。
  const runScenario = async (endpointFile) => {
    const clk = fakeClock(0, 1000);
    let launched = 0;
    const { ensure } = createEnsurer({
      probe: async () => NO_SIDECAR,
      ...BROKER_GONE,
    endpointFile: 'C:\\definitely-not-here\\endpoint.json',
      sleep: clk.sleep,
      now: clk.now,
      waitMs: 1000,
      autoStart: () => true,
      findExe: () => ({ path: 'C:\\x\\WorkBuddy.exe', source: 't' }),
      launcher: () => { launched += 1; return { pid: 999 }; },
      endpointFile,
    });
    return ensure();
  };

  const fx = endpointFixture({ staleMs: 3 * 3600_000 });
  const stale = await runScenario(fx.file);
  const missing = await runScenario('C:\\definitely-not-here\\endpoint.json');
  fx.cleanup();

  // 前置：两边确实落在同一个 code 上 —— 不然"话不同"可能只是 code 不同带来的，白测。
  assert.equal(stale.report.code, ENSURE_CODE.DESKTOP_NOT_READY);
  assert.equal(missing.report.code, ENSURE_CODE.DESKTOP_NOT_READY,
    '★ 两支必须共用一个 code，这条才有意义（否则"话不同"是 code 不同的副产品）');
  assert.equal(stale.report.desktop.brokerStale, true, '★ 陈旧那一支的归因必须落在 stale 上');
  assert.equal(missing.report.desktop.brokerStale, false);
  assert.match(stale.report.desktop.brokerDetail, /stale/);
  assert.doesNotMatch(missing.report.desktop.brokerDetail, /stale/);

  // ★ 核心断言：两句必须不同。
  assert.notEqual(stale.report.hint, missing.report.hint,
    `陈旧与未落盘说了同一句话：${stale.report.hint}`);
  // ★ 陈旧那句不得断言"桌面端没启动完"——这句在陈旧侧没有证据支撑。
  assert.doesNotMatch(stale.report.hint, /did not finish starting/,
    `陈旧端点仍在断言"桌面端没启动完"：${stale.report.hint}`);
  // ★ 也要真的点出"陈旧"这件事，否则"换了一句同样误导的话"也算通过。
  assert.match(stale.report.hint, /predates this launch/);
  // ★ 非 stale 分支保留原义：这一支**没有**被顺带改掉。
  assert.match(missing.report.hint, /did not finish starting/,
    `非陈旧那一支的原义被改掉了：${missing.report.hint}`);
  // ★ 两句都还落在 `DESKTOP_NOT_READY` 上，不许退化成 HINT_DEFAULT（"去打开桌面端"）。
  assert.doesNotMatch(stale.report.hint, /No usable WorkBuddy sidecar/);
  assert.doesNotMatch(missing.report.hint, /No usable WorkBuddy sidecar/);
});

test('★★★ F1·正面：残留端点被本轮桌面端**重写** ⇒ ready:true（不许改出假阴性）', async () => {
  // ★ 与上一条**同一份夹具文件、同一份字节**，唯一差别是 launcher 有没有重写它。
  //   只钉住"陈旧侧"的话，一个"永远不判就绪"的实现也能全绿。
  const clk = fakeClock(0, 1000);
  const fx = endpointFixture({ staleMs: 3 * 3600_000 });
  let launched = 0;
  const { ensure } = createEnsurer({
    probe: async () => (launched > 0 ? { picked: PICKED, why: null, scanned: 1 } : NO_SIDECAR),
    ...BROKER_GONE,
    endpointFile: 'C:\\definitely-not-here\\endpoint.json',
    sleep: clk.sleep,
    now: clk.now,
    waitMs: 5000,
    autoStart: () => true,
    findExe: () => ({ path: 'C:\\x\\WorkBuddy.exe', source: 't' }),
    launcher: () => {
      launched += 1;
      writeFileSync(fx.file, EP_BYTES);           // ★ 本轮桌面端重写了端点（真机 ~2s）
      return { pid: 1234 };
    },
    endpointFile: fx.file,
  });
  const r = await ensure();
  fx.cleanup();
  assert.equal(r.ok, true, '★ 重写过的端点必须认（否则这条修复就改成了新的假阴性）');
  assert.equal(r.report.stage, ENSURE_STAGE.STARTED);
  assert.equal(r.report.desktop.ready, true);
  assert.equal(r.report.desktop.launchPid, 1234);
});

test('★ stage=started：桌面端没开 → 本轮拉起 → 端点落盘 → 真的等到了 sidecar', async () => {
  const clk = fakeClock(0, 500);
  // 端点夹具：**自己**写一份，不读本机真机那个（真机上桌面端正在跑 ⇒ 那条路径必然 ready，
  // 于是"started"这个分支在 CI 机器上也永远走不到 —— 一个只在别人机器上成立的测试等于没有测试）。
  const dir = mkdtempSync(join(tmpdir(), 'wb-ensure-'));
  const epFile = join(dir, 'endpoint.json');
  let launched = 0;
  const { ensure } = createEnsurer({
    probe: async () => (launched > 0 ? { picked: PICKED, why: null, scanned: 1 } : NO_SIDECAR),
    ...BROKER_GONE,
    endpointFile: 'C:\\definitely-not-here\\endpoint.json',
    sleep: clk.sleep,
    now: clk.now,
    waitMs: 5000,
    autoStart: () => true,
    findExe: () => ({ path: 'C:\\x\\WorkBuddy.exe', source: 't' }),
    // 端点落盘 = 桌面端完成启动的那一步（真机：进程起后约 2s）。
    // ★ 这份夹具与上面 F1·反面那条是**同一份字节**，唯一差别是这里在**拉起之后**写 ——
    //   旧版本这两条逐字节同形，所以"F1 能全绿"。见 F1·正面 / F1·反面对照读。
    launcher: () => {
      launched += 1;
      writeFileSync(epFile, EP_BYTES);
      return { pid: 1234 };
    },
    endpointFile: epFile,
  });
  const r = await ensure();
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.ok, true);
  assert.equal(r.report.stage, ENSURE_STAGE.STARTED);
  assert.equal(r.report.code, 'ok');
  assert.equal(r.report.desktop.launched, true);
  assert.equal(r.report.desktop.ready, true, '端点已落盘 ⇒ 就绪');
  assert.equal(r.report.desktop.launchPid, 1234);
  assert.equal(r.sidecar.pid, 4242);
  // ★ 时间线必须把"拉起"这一步留在案上，不能只留一个最终结论。
  assert.ok(r.report.attempts.some((a) => a.stage === 'launch'), JSON.stringify(r.report.attempts));
  assert.ok(r.report.attempts.some((a) => a.stage === 'ready'));
});

test('★★ T2·就绪阶段被取消 ⇒ aborted，且**没有**跑满就绪窗口（旧代码报成 desktop_not_ready）', async () => {
  // ★ 上一版这条标题写着"不是一个 30s 的空转"，但它在调 `ensure()` **之前**就 abort 了 ——
  //   它声称排除的空转，正是缺陷本身（实测：62 次 tasklist、30s 模拟等待、code=desktop_not_ready，
  //   作业输出照印"桌面端没起来"，把用户自己的取消写成环境故障）。
  // ★ 现在取消打在 **launcher 内部**：就绪窗口已经开了，这才是它该排除的那条路。
  const ac = new AbortController();
  const clk = fakeClock(0, 1000);
  let launched = 0;
  let endpointPolls = 0;
  const { ensure } = createEnsurer({
    probe: async () => NO_SIDECAR,
    ...BROKER_GONE,
    endpointFile: 'C:\\definitely-not-here\\endpoint.json',
    sleep: async (ms) => { endpointPolls += 1; await clk.sleep(ms); },
    now: clk.now,
    waitMs: 60_000,
    autoStart: () => true,
    findExe: () => ({ path: 'C:\\x\\WorkBuddy.exe', source: 't' }),
    launcher: () => { launched += 1; ac.abort(); return { pid: 4242 }; },   // ★ 拉起成功那一刻用户撤了
    endpointFile: 'C:\\definitely-not-here\\endpoint.json',                  // 桌面端永远不就绪
  });
  const r = await ensure({ signal: ac.signal });
  assert.equal(r.report.code, ENSURE_CODE.ABORTED,
    '★ 用户自己取消的运行不得被报成"桌面端没起来"（两种处置完全不同）');
  assert.equal(r.report.desktop.launched, true, '取消那一刻桌面端确实已经被拉起了');
  assert.equal(r.report.desktop.ready, false);
  assert.ok(endpointPolls <= 1, `取消后不该再轮询端点（实际 ${endpointPolls} 次）`);
  assert.ok(r.report.waitedMs < 5000, `窗口是 60s，实际空转了 ${r.report.waitedMs}ms`);
  assert.doesNotMatch(r.report.hint, /did not finish starting/,
    '★ 提示也不能让他去看一个他刚亲手取消的桌面端窗口');
});

test('★★ 动手之前就取消 ⇒ 一个字节都不动（launcher 一次都不许被调）', async () => {
  const ac = new AbortController();
  ac.abort();
  const clk = fakeClock();
  let launches = 0;
  const { ensure } = createEnsurer({
    probe: async () => NO_SIDECAR,
    sleep: clk.sleep,
    now: clk.now,
    waitMs: 60_000,
    autoStart: () => true,
    findExe: () => ({ path: 'C:\\x\\WorkBuddy.exe', source: 't' }),
    launcher: () => { launches += 1; return { pid: 1 }; },
    endpointFile: 'C:\\definitely-not-here\\endpoint.json',
  });
  const r = await ensure({ signal: ac.signal });
  assert.equal(r.report.code, ENSURE_CODE.ABORTED);
  assert.equal(launches, 0, '★ 已经撤了还替用户弹一个 WorkBuddy 窗口，是另一种越界');
  assert.equal(r.report.desktop.launched, false);
});

test('★ 取消落在等 sidecar 的窗口里 ⇒ aborted（这条本来就接了，别在修 F3 时弄丢）', async () => {
  const ac = new AbortController();
  const clk = fakeClock(0, 500);
  const fx = endpointFixture({ staleMs: 30_000 });
  let calls = 0;
  const { ensure } = createEnsurer({
    probe: async () => {
      calls += 1;
      if (calls === 3) ac.abort();        // ★ 取消打在**等 sidecar**的那一段
      return NO_SIDECAR;
    },
    brokerProbe: async () => ({ running: true, error: null }),
    sleep: clk.sleep,
    now: clk.now,
    waitMs: 60_000,
    autoStart: () => true,
    endpointFile: fx.file,
  });
  const r = await ensure({ signal: ac.signal });
  fx.cleanup();
  assert.equal(r.report.code, ENSURE_CODE.ABORTED);
  assert.ok(r.report.waitedMs < 60_000, `窗口 60s，实际只跑了 ${r.report.waitedMs}ms`);
});

test('★ 每个失败码都必须有一句带处置动作的 hint（"再试一次"等于没写）', async () => {
  const r = await createEnsurer({
    probe: async () => NO_SIDECAR,
    // ★ 用注入的探针，不让它去连真机 `~/.workbuddy/wbipc/endpoint.json`（纪律禁止）。
    brokerProbe: async () => ({ running: false, error: null }),
    sleep: async () => {},
    now: (() => { let t = 0; return () => (t += 100); })(),
    waitMs: 100,
    endpointFile: 'C:\\definitely-not-here\\endpoint.json',
  }).ensure();
  const hint = r.report.hint;
  assert.ok(typeof hint === 'string' && hint.length > 30, 'hint 必须是一句可执行的话');
  assert.doesNotMatch(hint, /再试一次|retry later|TODO/i);
});

test('attempts 时间线有界（会进作业输出，不能无限长）', async () => {
  const clk = fakeClock(0, 500);
  const fx = endpointFixture({ staleMs: 30_000 });
  const { ensure } = createEnsurer({
    probe: async () => NO_SIDECAR,
    brokerProbe: async () => ({ running: true, error: null }),
    sleep: clk.sleep,
    now: clk.now,
    waitMs: 600_000,          // 故意给一个巨大的窗口
    autoStart: () => true,
    endpointFile: fx.file,
  });
  const r = await ensure();
  fx.cleanup();
  assert.ok(r.report.attempts.length <= 8, `attempts 长度 ${r.report.attempts.length} 超界`);
  // 但**时间**上必须真的等到窗口结束，而不是被 attempts 上限截断
  assert.equal(r.report.code, ENSURE_CODE.NO_SIDECAR_APPEARED);
  assert.ok(r.report.waitedMs >= 600_000 - 1000);
});

// ══════════════════════════════════════════════════════════════════════════════
// 6.5 并发（F4）：N 个并发请求必须至多拉起一次
// ══════════════════════════════════════════════════════════════════════════════

test('★★★ F4：3 个并发 ensure() ⇒ 桌面端只被拉起 1 次', async () => {
  // ★ 实测旧行为：launcher 被调 3 次。三个实例抢**同一个凭据运行时**（`desktop.js` 模块头
  //   记的头号禁忌），而 `autoStartDesktop` 默认为开 —— 模型连发两个任务、用户点重试
  //   都能让两个请求落在同一秒内，各自看到"没在跑"。
  // ★ 2026-10-10：判据从"各自看到 tasklist 没有"换成"各自看到 broker 管道 ENOENT"。
  const fx = endpointFixture({ staleMs: 3 * 3600_000 });
  let launches = 0;
  let probed = 0;
  const { ensure } = createEnsurer({
    probe: async () => NO_SIDECAR,
    brokerProbe: async () => { probed += 1; return { running: false, error: null }; },
    sleep: async () => {},
    now: (() => { let t = 0; return () => (t += 100); })(),
    waitMs: 1000,
    autoStart: () => true,
    findExe: () => ({ path: 'C:\\x\\WorkBuddy.exe', source: 't' }),
    launcher: () => {
      launches += 1;
      writeFileSync(fx.file, EP_BYTES);
      return { pid: 1000 + launches };
    },
    endpointFile: fx.file,
  });
  const rs = await Promise.all([ensure(), ensure(), ensure()]);
  fx.cleanup();
  assert.equal(launches, 1, '★ 同一时刻只允许存在一次拉起（否则就是多开一个桌面端抢凭据运行时）');
  assert.ok(probed <= 3, `★ 三次调用共用同一轮探测，实际 ${probed} 次`);
  // ★ 三份结论必须一致 —— 后来者拿到的是同一轮的结论，不是"我什么都没查到"
  assert.equal(new Set(rs.map((r) => r.report.stage)).size, 1);
  assert.equal(new Set(rs.map((r) => r.report.code)).size, 1);
});

test('★★ F4·收尾：in-flight 结算后必须清空（否则第二轮请求会拿到上一轮的旧结论）', async () => {
  const fx = endpointFixture({ staleMs: 30_000 });
  let allowPicked = false;
  const { ensure } = createEnsurer({
    probe: async () => (allowPicked ? { picked: PICKED, why: null, scanned: 1 } : NO_SIDECAR),
    ...BROKER_UP,
    sleep: async () => {},
    now: (() => { let t = 0; return () => (t += 100); })(),
    waitMs: 1000,
    autoStart: () => true,
    endpointFile: fx.file,
  });
  const first = await ensure();
  assert.equal(first.report.code, ENSURE_CODE.NO_SIDECAR_APPEARED,
    '第一轮：桌面端在跑且已就绪，但窗口内没有 sidecar');
  assert.equal(first.ok, false);
  allowPicked = true;                        // ★ 第二轮才拿得到
  const second = await ensure();
  fx.cleanup();
  assert.notEqual(second.report, first.report, '★ 第二轮必须是**新跑一遍**，不是第一轮结论的重播');
  assert.equal(second.ok, true, '第二轮拿到了可用 sidecar');
  assert.equal(second.report.stage, ENSURE_STAGE.REUSED);
});

// ══════════════════════════════════════════════════════════════════════════════
// 6.6 归因不许在半路丢（F6b / F5）
// ══════════════════════════════════════════════════════════════════════════════

test('★★★ F6(b)：活性探针的错与就绪窗口的错必须分开落（不许互相顶替）', async () => {
  // ★ 旧代码有两个来源：`isDesktopRunning()` 的 error（tasklist 枚举失败）与
  //   `waitForDesktop()` 的 `ready.error`（整个就绪窗口 tasklist 全程失败）。
  //   2026-10-10 之后，就绪窗口里**只剩**"端点文件读不读得出"一件事，而
  //   `isBrokerReady` 自己把它收敛成 `{ready:false, detail}` 从不外抛
  //   ⇒ `ready.error` 恒为 null。于是 **`probeError` 只有一个来源：活性探针**。
  //   ★ 这条钉新不变量：两件事各自落在各自字段里，读回执的人不会把
  //     "活性探针的原文"当成"就绪超时的原因"，反过来也一样。
  const clk = fakeClock(0, 1000);
  const { ensure } = createEnsurer({
    probe: async () => NO_SIDECAR,
    ...BROKER_GONE,
    sleep: clk.sleep,
    now: clk.now,
    waitMs: 1000,
    autoStart: () => true,
    findExe: () => ({ path: 'C:\\x\\WorkBuddy.exe', source: 't' }),
    launcher: () => ({ pid: 999 }),
    endpointFile: 'C:\\definitely-not-here\\endpoint.json',
  });
  const r = await ensure();
  assert.equal(r.report.code, ENSURE_CODE.DESKTOP_NOT_READY);
  // ① 活性探针那一侧：桌面端没开（端点文件读不到 / 管道 ENOENT）的归因。
  assert.match(r.report.desktop.probeError ?? '', /endpoint not found|no longer exists/i,
    '★ 活性探针的原文必须留在 probeError 上（它是"要不要拉起"的判据来源）');
  // ② 就绪窗口那一侧：端点文件不存在的归因。
  assert.match(r.report.desktop.brokerDetail ?? '', /endpoint\.json unreadable or incomplete/,
    '★ 就绪窗口的归因必须落在 brokerDetail 上');
  // ③ 两句不是同一句话 —— 合成一句就等于把两种局面压平。
  assert.notEqual(r.report.desktop.probeError, r.report.desktop.brokerDetail,
    '★ 活性探针与就绪窗口是两件事，归因不许互相顶替');
});

test('★★ F5：就绪窗口不得被"等 sidecar 的窗口"顶掉（DEFAULT_READY_TIMEOUT_MS 必须真的生效）', async () => {
  // ★ 旧代码 `timeoutMs: waitMs()` ⇒ 那个 90s 的常量是**死代码**：写在那里像一道冷启动保障，
  //   实际从不生效（用户只配 `instanceTimeoutMs: 30000` 时，桌面端只有 30s 的启动余量）。
  const clk = fakeClock(0, 1000);
  let launched = 0;
  const { ensure } = createEnsurer({
    probe: async () => NO_SIDECAR,
    ...BROKER_GONE,
    endpointFile: 'C:\\definitely-not-here\\endpoint.json',
    sleep: clk.sleep,
    now: clk.now,
    waitMs: 3000,                 // ← 故意比 90s 小得多
    autoStart: () => true,
    findExe: () => ({ path: 'C:\\x\\WorkBuddy.exe', source: 't' }),
    launcher: () => { launched += 1; return { pid: 999 }; },
    endpointFile: 'C:\\definitely-not-here\\endpoint.json',
  });
  const r = await ensure();
  assert.equal(r.report.code, ENSURE_CODE.DESKTOP_NOT_READY);
  assert.ok(r.report.waitedMs >= DEFAULT_READY_TIMEOUT_MS,
    `就绪窗口只给了 ${r.report.waitedMs}ms，冷启动余量等于没有`);
});

// ══════════════════════════════════════════════════════════════════════════════
// （原先的 diagnose 只读路已随 `?instance=1` 路由一并撤掉：不在这条流程里，不做。）
// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════
// 4. 结论**到得了吗**（★ 2026-09-30 加测）
//
//    上面几节证明的是"结论被**正确算出来**"。这一节问的是另一个问题：
//    **算出来之后，它到得了用户和模型眼前吗**。
//
//    实测结论：到不了。`report` 原本只挂在 `dispatch.run()` 的返回值上，而
//    `tools/gateway-run.js` 重新组装 `gateway` 对象用的是**白名单**——少一行，
//    字段就在跨层时无声消失且**不报错**（`sessionOrigin` 这么丢过一次：真机
//    `noteRun` 里查不到，而当时单测全绿，因为全绿的路径压根没经过那一层）。
//    ⇒ "实例是否存在、是否要启动"这两个答案，用户和模型**一个都看不到**。
//
//    下面两条钉的是**真实可见面**（作业输出 / 回执形状），不是钉实现细节。
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 造一个"必然卡在实例这一步"的下发器。
 *
 * ★ 刻意**不传 `run`**（进程枚举）：那正是"装配被裁剪、连进程枚举都发不出去"的现场，
 *   ensure 必须报 `no_usable_sidecar` 而不是 `desktop_probe_failed`——两者的处置不同，
 *   所以这条测试才断在"用户该去桌面端开一个对话"这句话上（与 host.test.js 的同款纪律）。
 * ★ `autoStartDesktop: () => false` ⇒ 绝不碰本机桌面端（这类测试绝不能有副作用）。
 */
const failingDispatcher = () => createDispatcher({
  gatewayToken: () => '',
  boundSessionId: () => '',
  sessionMode: () => '', workspace: () => '', createNewConversation: () => false,
  autoStartDesktop: () => false,
  instanceTimeoutMs: () => 1000,
  // ★ 2026-10-10：显式注入 broker 探针与端点文件。不注入的话，ensurer 的默认判据走
  //   `os.homedir()/.workbuddy/wbipc/endpoint.json` —— 本机 WorkBuddy 正在运行时会连上
  //   **真** broker 管道并挂死在握手上（实测 >20s 不返回；CI 无桌面端时才"碰巧"快失败）。
  //   注入 ⇒ 结论确定、零真机依赖，与"这类测试绝不能有副作用"的纪律一致。
  brokerProbe: async () => ({ running: false, error: null }),
  endpointFile: 'C:\\definitely-not-here\\endpoint.json',
});

test('★★ `instance` 必须活着穿过 startGatewayRun 的 gateway 白名单（与 sessionOrigin 同一个坑）', async () => {
  const g = startGatewayRun({ prompt: 'x', cwd: 'D:\\work', dispatch: failingDispatcher() });
  const done = await g.done;
  assert.notEqual(done.gateway.instance, null,
    '★ 白名单少一行 ⇒ `instance` 跨层时无声消失且不报错，'
    + '于是 status 里的 lastRun 没有它、作业输出也没有它，整段保障工作等于没做');
  assert.equal(done.gateway.instance.code, 'no_usable_sidecar');
  assert.equal(done.gateway.instance.stage, 'failed');
});

test('★★★ 失败时"实例"必须在**作业输出**里说清楚成因与处置（`job_output` 一读就见的那一面）', async () => {
  const g = startGatewayRun({ prompt: 'x', cwd: 'D:\\work', dispatch: failingDispatcher() });
  g.readOutput();                       // 先取走首行（游标语义：首批/增量）
  await g.done;
  const out = g.readOutput();
  assert.match(out, /\[instance\] failed · no_usable_sidecar/,
    '★ 作业输出里必须点名成因，否则读者只能看到一句"运行失败"');
  // ★ 处置动作必须**在**同一行里。只回一个码，等于把"该怎么办"退回去让用户自己猜。
  assert.match(out, /Open the WorkBuddy desktop and start a conversation/,
    '★ 成因后面必须紧跟那句可执行的话（ENSURE 的 hint 契约）');
});

test('★★★ 这一行必须在**正文之前**落地（实例先于 prompt 收敛；晚一步用户就白等整轮）', async () => {
  // ★ 勾稽的是**时序**：`ensure()` 在下发 prompt 之前收敛，而 prompt 那一段才是长的那段。
  //   挂在 `run()` 的返回值上就没有"之前"可言——那时整轮已经结束了。
  //   证法：作业体一开就有一条 `[instance]` 行，且它早于 dispatch 记录的 prompt 时刻。
  const seen = [];
  const dispatch = {
    async run(req) {
      seen.push('run:start');
      req.onInstance?.({ stage: 'failed', code: 'no_usable_sidecar', ok: false, desktop: null, hint: 'go open it' });
      await Promise.resolve();
      seen.push('run:end');
      return { status: 'completed', exitCode: 0, gateway: { ok: true }, models: [], modes: null, instance: null };
    },
  };
  const g = startGatewayRun({ prompt: 'x', cwd: 'D:\\work', dispatch });
  // ★ 真正的判据不是"某一批里有这一行"，而是**第一批**里就有。
  //   `ensure()` 在下发 prompt 之前收敛，而 prompt 那一段才是长的那段；
  //   挂在 `run()` 的返回值上就没有"之前"可言——那时整轮已经结束、作业已经转完态了。
  const first = g.readOutput();
  assert.match(first, /^transport=gateway/, '首批以头行开头');
  assert.match(first, /\[instance\] failed · no_usable_sidecar · go open it/,
    '★ `[instance]` 必须落在**第一批**（作业还没转态时就已可见），否则用户白等整轮');
  await g.done;
  assert.deepEqual(seen, ['run:start', 'run:end'], '★ 派发恰好一次');
  assert.match(g.readOutput(), /\[failed\]/, '终态行仍在其后（次序不乱）');
});

test('★ 成功时这一行要回答"要不要启动"：`started` 必须说清是本轮动的手', async () => {
  // ★ 两种成功局面的处置不同：本来就开着 / 本轮拉起来了。只回一个 `reused` 就分不出
  //   "插件会不会偷偷开第二个桌面端"（而多开会和已开的那一个抢凭据运行时）。
  const line = (r) => instanceLine(r);
  assert.match(line({ ok: true, stage: 'reused', desktop: { running: true, launched: false, ready: true } }),
    /\[instance\] reused · the desktop was already open/);
  assert.match(line({ ok: true, stage: 'started', desktop: { running: true, launched: true, ready: true } }),
    /\[instance\] started · this run launched the desktop/,
    '★ 本轮真的动了手，必须说成"我拉起来的"，不能和"本来就在"混同');
  // `waited` 的桌面端**必然**是在跑的（拉起那一步会记 `started`），所以措辞是同一句
  assert.match(line({ ok: true, stage: 'waited', desktop: { running: true, launched: false, ready: true } }),
    /\[instance\] waited · the desktop was already open/);
  // 三种都成立时也不许说"启动"——没启动就不能暗示启动了
  for (const stage of ['reused', 'waited']) {
    assert.doesNotMatch(line({ ok: true, stage, desktop: { running: true, launched: false, ready: true } }),
      /launched the desktop/, `★ ${stage} 未启动，不得说成启动了`);
  }
});

// ── 投影：出了插件的形状由一份**显式清单**决定（不是"report 原样透传"）────────
//
// ★ 这条不是洁癖。`tools/ci/check-no-credential-echo.mjs` 扫的是**代码里的 echo 写法**，
//   扫不到运行时载荷 ⇒ "把一个将来可能被塞进凭据的字段原样透传"不会被任何红线拦下。
//   投影是那道显式闸门：不在清单上的字段根本不进门。
// ★ 负控的写法很重要：喂一个**确实带** exe/attempts 的 report 进去，
//   然后断言它们不在输出里 —— 换成"输入本来就没有这些键"的话，这条测试恒绿，是个假探测器。
test('projectInstance：出插件的字段里不得有安装路径与 attempts（它们是"这台机器的地图"）', () => {
  const out = projectInstance({
    stage: 'started', code: 'ok', ok: true, at: 1759000000000, waitedMs: 1234,
    desktop: {
      image: 'WorkBuddy.exe', running: true, pids: [23696, 15192],
      probeError: null, exe: 'C:\\Users\\someone\\AppData\\Local\\Programs\\WorkBuddy\\WorkBuddy.exe',
      launched: true, launchPid: 999, launchError: null, ready: true,
      brokerDetail: 'endpoint=C:\\Users\\someone\\AppData\\Local\\Temp\\wb\\broker.json',
    },
    sidecar: { scanned: 7, picked: 1, refused: { code: 'busy_running', detail: '一段很长的散文…'.repeat(20) } },
    attempts: Array.from({ length: 8 }, (_, i) => ({ at: i, note: '等 sidecar 出现…' })),
    hint: 'ok',
  });
  assert.equal(out.desktop.exe, undefined, '★ 安装路径不得出门（含本机用户名）');
  assert.equal(out.desktop.pids, undefined, '★ 进程号是诊断细节');
  assert.equal(out.desktop.brokerDetail, undefined);
  assert.equal(out.attempts, undefined, '★ attempts 最多 8 条散文，进不了每次重读的 lastRun');
  assert.equal(out.sidecar.refused, 'busy_running', '★ 成因**码**留（机器可判），散文不留');
  // ★ 但"本轮到底起没起"必须留：这是"是否要启动"那个问题的答案。
  assert.deepEqual(out.desktop, { running: true, launched: true, ready: true });
  assert.equal(out.stage, 'started');
  assert.equal(out.waitedMs, 1234);
});

test('projectInstance：吃空/null/非对象都不得抛（投影在收口路径上，抛了会连累整条作业）', () => {
  for (const v of [null, undefined, 0, '', 'x', []]) assert.equal(projectInstance(v), null, `输入 ${JSON.stringify(v)}`);
  // 缺字段的残缺 report 也要给出可用的形状，而不是半个 undefined
  const out = projectInstance({ stage: 'failed' });
  assert.equal(out.ok, false);
  assert.equal(out.code, '');
  assert.equal(out.desktop, null);
  assert.deepEqual(out.sidecar, { scanned: 0, picked: 0, refused: null });
});

// ── 第二个面：`workbuddy_status` 的 `lastRun.instance`（**事后**查得到的那一面）────
//
// ★ 为什么需要它：作业输出会随作业滚走，而"这轮为什么没跑起来 / 是不是我这边没实例"
//   恰恰是**事后**才被追问的那一问。`lastRun` 是唯一跨会话留存的面。
// ★ `lastRun` 在 schema 里是 `type:'json'`（status.js:200）⇒ 里面的形状不受键白名单约束，
//   所以这一面不需要动 schema——但"不需要动"必须被钉住，否则下一个人会为了"安全"去加白名单，
//   顺手把这个字段裁掉。
test('★★★ `workbuddy_status` 必须把 lastRun.instance 原样送到模型眼前（不裁、不抛、不吞）', async () => {
  const instance = {
    stage: 'failed', code: 'no_usable_sidecar', ok: false, waitedMs: 0, desktop: null,
    sidecar: { scanned: 3, picked: 0, refused: 'no_desktop' },
    hint: 'Open the WorkBuddy desktop and start a conversation there.',
  };
  const statusDef = makeStatusTool(
    {
      // ★ 负控：这份 lastRun **带** instance。若钉成"输出里出现 instance"就算过，
      //   那实现里任意一处静默吞字段也能绿 ⇒ 必须同时钉住"别的字段也还在"。
      lastRun: () => ({ transport: 'gateway', exitCode: 0, reasonCode: 'task_error', instance }),
      detected: () => null, registry: () => 'REGISTERED', inFlight: () => [], probe: async () => {},
    },
    () => ({ model: '', effort: '', sessionMode: '', createNewConversation: false }),
    {},
    { list: () => [], count: () => 0 },
    null,
  );
  const out = await statusDef.execute({});
  assert.equal(out.lastRun.instance.code, 'no_usable_sidecar', '★ instance 必须原样到达模型');
  assert.equal(out.lastRun.instance.hint, instance.hint);
  // ★ 负控：同一条记录里的**其它**字段也必须还在（证明这是一次透传，不是一次重建）
  assert.equal(out.lastRun.transport, 'gateway');
  assert.equal(out.lastRun.exitCode, 0);
  // ★ 负控：没有 instance 的运行（spawn 路径 / 老记录）不得被投影成半个假结论
  const bare = await makeStatusTool(
    { lastRun: () => ({ transport: 'spawn' }), detected: () => null, registry: () => 'REGISTERED',
      inFlight: () => [], probe: async () => {} },
    () => ({}), {}, { list: () => [], count: () => 0 }, null,
  ).execute({});
  assert.equal(bare.lastRun.instance, undefined, '★ 没有就是没有，不许补一个 stage:"" 的假结论');
  assert.equal(bare.lastRun.transport, 'spawn');
});
