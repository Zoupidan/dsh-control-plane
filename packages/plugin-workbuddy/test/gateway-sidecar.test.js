// sidecar 发现与选择。★ fixture 是本机 `~/.workbuddy/sessions/` 里两个真文件的原文：
//   22620/65252 = 桌面端给宿主分配的（cwd 落在 workbuddy-host-cli 下）→ 可用
//   16080/63393 = 用户活会话（cwd 是他的工程目录 D:\Box\交易知识库）  → **永不选中**
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { discoverSidecars, isPidAlive, parseSessionEntry, probeEntry, probeStatus, selectSidecar, sessionsDirs, summarizePool } from '../src/host/gateway/sidecar.js';

// 真机原文（逐字取自 ~/.workbuddy/sessions/*.json）
const RAW_HOST = {
  pid: 22620, lastHeartbeat: 1790572260858, sessionId: '01a0e65b-7f51-7796-bfa1-be54df9e7615',
  cwd: 'C:\\Users\\demo\\AppData\\Local\\Temp\\workbuddy-host-cli\\__workbuddy_cli_host__-0-eade4501',
  startedAt: 1790555336298, kind: 'interactive', url: 'http://127.0.0.1:65252', endpoint: 'http://127.0.0.1:65252',
  mode: 'local', version: '2.147.0', os: 'win32', arch: 'x64', hostname: '空腹蟲', updatedAt: 1790572260860,
};
const RAW_USER = {
  pid: 16080, lastHeartbeat: 1790572258559, sessionId: 'f84b5022-78a6-40b0-8570-ac581c631962',
  cwd: 'D:\\Box\\交易知识库', startedAt: 1790560045063, kind: 'interactive',
  url: 'http://127.0.0.1:63393', endpoint: 'http://127.0.0.1:63393', mode: 'local', version: '2.147.0',
};
const NOW = 1790572261000;   // 两份心跳都在 1 秒内

test('真机两个文件都解析成功，且 hostManaged 判别正确', () => {
  const host = parseSessionEntry(RAW_HOST, NOW);
  const user = parseSessionEntry(RAW_USER, NOW);
  assert.equal(host.hostManaged, true, 'workbuddy-host-cli 下的 ⇒ 宿主可用');
  assert.equal(user.hostManaged, false, '★ 用户工程目录 ⇒ 不是宿主分配的');
  assert.equal(host.url, 'http://127.0.0.1:65252');
  assert.equal(user.url, 'http://127.0.0.1:63393');
  assert.equal(host.heartbeatAgeMs, NOW - RAW_HOST.lastHeartbeat);
});

test('★★ interactive（用户活会话）**默认拒选**，须显式开关（真机 ACP 注入回归）', async () => {
  // ★ 这条规则在 2026-09-28 被我改过两次，每次都往错的方向偏，先把来龙去脉写死：
  //
  //   ① 老规则"interactive 永不入选"。5.6.2 之后桌面端只拉 interactive / prewarm 两类，
  //      session 文件里没有 url，而 prewarm **不监听 TCP**（只有命名管道）⇒ 老规则等于
  //      "永远一个都选不出来"。**但这个理由不成立**：选不出来不是安全，是不可用。
  //   ② 我把规则改成"interactive 空闲即可用、排在 prewarm 之后"。**这是错的。**
  //      实测：ACP 的 `session/new` **不新建会话**——回传上一次的历史、继续在
  //      `/api/v1/status` 的 `activeSessionId` 上跑、`cwd` 被忽略。而 interactive 的
  //      activeSessionId **就是用户打开着的那条会话**。⇒ 下发把一条外来 prompt 插进
  //      他的对话，他的 agent 继续接手头的活（无视 `只回复 OK`，回 23 KB 报告、调 64 次工具）。
  //      证据：04-docs/RECON-DISPATCH-GATEWAY.md §6.5。
  //
  //   ③ 现在的规则：**默认拒**，由 dispatch 侧的"绑了对话"显式开（`allowInteractive`
  //      在 dispatch 里就是 `boundSessionId !== ''`，见 dispatch.js）。
  //      "分层排序"救不了这个——只剩它一个候选时排序照样会选中它。
  const user = parseSessionEntry(RAW_USER, NOW);

  // 默认（不传 allowInteractive）⇒ 不选。
  const dflt = await selectSidecar([user], { status: async () => ({ busy: false }) });
  assert.equal(dflt, null, '★ 默认必须拒选用户活会话——空闲与否都拒');

  // 显式允许 ⇒ 可用，且仍受 busy 闸约束。
  const allowed = await selectSidecar([user], {
    status: async () => ({ busy: false }), allowInteractive: true,
  });
  assert.equal(allowed.entry.pid, user.pid, '★ 显式开关打开后，它是 5.6.2 之后唯一可下发的形态');

  // 负控①：开关开了也**不得**放宽 busy 闸。开着它去碰正在跑的会话，比不开更糟。
  assert.equal(await selectSidecar([user], {
    status: async () => ({ busy: true }), allowInteractive: true,
  }), null, '★ 开关只管"选不选这一类"，不管"它忙不忙"');

  // 负控②：开关开了也**不得**让 interactive 压过 prewarm。
  const prewarm = { ...user, pid: 39896, kind: 'prewarm', cwd: 'C:\\Program Files\\WorkBuddy', url: 'http://127.0.0.1:53350' };
  const both = await selectSidecar([user, prewarm], {
    status: async () => ({ busy: false }), allowInteractive: true,
  });
  assert.equal(both.entry.pid, 39896, '★ 即便允许 interactive，prewarm 仍然优先');
});

test('★ 拒选判据是 hostManaged，**不是**只看 kind（真机 fixture 回归）', async () => {
  // ★ 这条是我改上面的规则时真踩到的坑，写下来免得再踩第二次：
  //   本机真机 RAW_HOST 的 `kind` 也是 `"interactive"`（WorkBuddy 2.147.0），
  //   但它的 cwd 落在 workbuddy-host-cli 下 ⇒ `hostManaged: true`。
  //   而 5.6.2 的用户活会话（26080）kind 同为 interactive，但 cwd 是用户工程目录
  //   ⇒ `hostManaged: false`。**两条 kind 相同，只有 hostManaged 不同。**
  //   只按 kind 过滤会把宿主分配的那条一起杀掉——"用户可见的活会话"才是要拒的那类。
  const host = parseSessionEntry(RAW_HOST, NOW);
  const user = parseSessionEntry(RAW_USER, NOW);
  assert.equal(host.kind, 'interactive', '前置：两条的 kind 确实一样');
  assert.equal(host.hostManaged, true, '前置：宿主那条 hostManaged 为真');
  assert.equal(user.kind, 'interactive', '前置：用户那条 kind 也是 interactive');
  assert.equal(user.hostManaged, false, '前置：用户那条 hostManaged 为假');

  const got = await selectSidecar([host, user], { status: async () => ({ busy: false }) });
  assert.equal(got.entry.pid, host.pid, '★ 宿主分配的必须仍可用，只有用户活会话被拒');
});

test('★ 全被拒时报 interactive_blocked——不能并进 no_endpoint', async () => {
  // ★ 为什么必须单开一个 code：并进 no_endpoint 会让人去"重启桌面端"，
  //   而真相是"你把它拒了，开个开关就行"。两种成因的处置完全不同。
  const user = parseSessionEntry(RAW_USER, NOW);
  let why = null;
  const got = await selectSidecar([user], {
    status: async () => ({ busy: false }),
    onUnavailable: (s) => { why = s; },
  });
  assert.equal(got, null);
  assert.equal(why?.code, 'interactive_blocked', '★ 成因要说清是"被拒"而不是"没找到"');
  assert.match(why.detail, /boundSessionId/, '★ 处置必须可执行：直接指到那个设置项');
});

test('★★ "被拒"要压过"探不通"——真机 2026-09-28 的池子长这样', async () => {
  // ★ 这是真机池子的真实构成（2026-09-28 15:5x，`wb-interactive-block-check.mjs` 输出）：
  //   候选 5 · 端点已知 3 —— 那 3 条**全是用户活会话**（全被拒），
  //   剩下 2 条 hostManaged 是死进程残留（端点反查不到 / 探不通）。
  //
  //   此时若照 `summarizePool` 报 `probe_unreachable`（"去重启 WorkBuddy 桌面端"），
  //   就会把人送去重启一个**没坏**的东西，而唯一能推进的动作是"开开关"。
  //   判据：只要 `rejected` 非空，开开关就至少多一条可试的 ⇒ 它是更靠前的瓶颈。
  const user = parseSessionEntry(RAW_USER, NOW);
  const dead = { pid: 22696, kind: 'interactive', hostManaged: true, cwd: 'C:\\Users\\demo\\AppData\\Local\\Temp\\workbuddy-host-cli\\x', url: 'http://127.0.0.1:53351' };
  let why = null;
  const got = await selectSidecar([user, dead], {
    status: async (e) => (e.pid === user.pid ? { busy: false } : null),   // 宿主那条探不通
    onUnavailable: (s) => { why = s; },
  });
  assert.equal(got, null);
  assert.equal(why?.code, 'interactive_blocked',
    '★ 活会话被拒是更靠前的瓶颈——不该报成"去重启桌面端"');
  assert.match(why.detail, /boundSessionId/, '★ 处置仍须指向那个设置项');

  // 负控：宿主那条**探通了但正在跑**时，瓶颈就不是"被拒"了，不该抢报 interactive_blocked。
  let why2 = null;
  await selectSidecar([user, dead], {
    status: async (e) => (e.pid === user.pid ? { busy: false } : { busy: true, runStatus: 'running' }),
    onUnavailable: (s) => { why2 = s; },
  });
  assert.equal(why2?.code, 'busy_running',
    '★ 有一条能通且只是真在跑 ⇒ 成因是"等它完"，不是"被拒"');
});

test('★★ 开关已开（绑了对话）时，"探不通"不得再被说成"被拒"——真机 2026-09-28 踩中', async () => {
  // ★ 这条是上一条规则的**反面**，而且是踩出来的：上一条（:109）只测了开关**关着**时
  //   "被拒压过探不通"，没有人测开关**开着**时的同一池子。
  //
  //   上一条判据里 `rejected 非空` 就算数，可**它没看 `allowInteractive`**。
  //   开关开着时 `candidates === pool`、`rejected` 退化成 pool 的无关子集，
  //   "探不通"却是**完全独立**的故障。此时若仍报 interactive_blocked，
  //   给出的处置就是"去绑一条对话"——而对话早就绑好了。
  //   真机症状：boundSessionId 已填、status 回 bound:true，dispatch 仍报 interactive_blocked，
  //   于是"去绑对话"这条假指引把真正的故障（端点探不通）整个盖住。
  const user = parseSessionEntry(RAW_USER, NOW);
  let why = null;
  const got = await selectSidecar([user], {
    status: async () => null,                       // ★ 端点已知，但状态接口探不通
    allowInteractive: true,                          // ★ 已经绑了对话
    onUnavailable: (s) => { why = s; },
  });
  assert.equal(got, null);
  assert.equal(why?.code, 'probe_unreachable',
    '★ 开关已开 ⇒ 没有任何东西被拒，"探不通"是唯一的成因，不许抢报 interactive_blocked');
  assert.doesNotMatch(why.detail, /boundSessionId/,
    '★ 更要紧的是处置不得骗人：不能让人去绑一条他早就绑好的对话');

  // 负控：开关**关着**时同一池子仍必须报"被拒"——修复不得反过来削弱上一条规则。
  let why2 = null;
  await selectSidecar([user], {
    status: async () => null,
    onUnavailable: (s) => { why2 = s; },
  });
  assert.equal(why2?.code, 'interactive_blocked',
    '★ 开关关着时，被拒仍是更靠前的瓶颈（上一条规则不得被削弱）');
});

test('★★ "要不到口令"不得被说成"探不通"——真机 2026-09-28，两端点裸探都是 401', async () => {
  // ★ 真机形态：dsh 跑在**普通用户**上下文，读 sidecar 的 PEB 被 Windows 拒绝，
  //   于是取口令**恒定失败**；而两个端点裸探都是 HTTP 401 —— 端点健康，只缺口令。
  //   旧行为里 status 的 catch 把这两种失败压成同一个 `null`，全池被判"探不通"，
  //   处置写成"去重启 WorkBuddy 桌面端"。而桌面端好好的，重启一万次也没用。
  //   两者处置**完全相反**，所以必须能分开。
  const user = parseSessionEntry(RAW_USER, NOW);
  const noToken = { busy: null, unavailable: 'token_unavailable', detail: 'PEB read denied' };
  let why = null;
  const got = await selectSidecar([user], {
    status: async () => noToken,
    allowInteractive: true,
    onUnavailable: (s) => { why = s; },
  });
  assert.equal(got, null);
  assert.equal(why?.code, 'token_unavailable', '★ 唯一的成因是要不到口令');
  assert.match(why.detail, /gatewayToken/, '★ 处置必须指向真正管用的那个动作');
  assert.doesNotMatch(why.detail, /重启 WorkBuddy 桌面端/,
    '★ 桌面端没坏，不该把人送去重启它');

  // 负控：只要还有一条给出了**具体**成因（在等授权），就该先说那条——处置更可执行。
  let why2 = null;
  await selectSidecar([user, { ...user, pid: 39896, kind: 'prewarm', cwd: 'x', url: 'u' }], {
    status: async (e) => (e.pid === user.pid
      ? noToken
      : { busy: true, runStatus: 'waiting_for_permission' }),
    allowInteractive: true,
    onUnavailable: (s) => { why2 = s; },
  });
  assert.equal(why2?.code, 'waiting_permission',
    '★ 有具体成因时不让"取不到口令"抢报');
});

test('★ 心跳过期**不得**否决一个探活成功的条目（真机 5.6.2 回归）', async () => {
  // 2026-09-28 真机：5.6.2 拉起的 sidecar，session 文件的 lastHeartbeat 只在 spawn
  // 那一刻写一次就停住（4 秒后 mtime 纹丝不动），而进程活着、/api/v1/status 正常应答。
  // 老逻辑拿 120s 心跳当硬过滤，会把**唯一可用**的目标判死，报出的症状是
  // "桌面端没启动"——把用户送去重启一个根本没坏的东西。
  const stale = parseSessionEntry(RAW_HOST, NOW + 10 * 60_000);
  assert.equal(stale.heartbeatAgeMs > 120_000, true, '前置：它确实是"过期"的');
  const got = await selectSidecar([stale], { status: async () => ({ busy: false }) });
  assert.notEqual(got, null, '★ 心跳陈旧但 HTTP 探活答得上 ⇒ 仍然可用');

  // 负控：心跳再陈旧，**探不通就是不通**。去掉心跳不等于去掉探活。
  assert.equal(await selectSidecar([stale], { status: async () => null }), null,
    '★ 探不通的条目仍然出局 —— 活性判据从心跳换成了探活，不是被删掉了');
});

test('★ 两个都在时选 hostManaged 那个（探活显示它空闲）', async () => {
  const entries = [parseSessionEntry(RAW_USER, NOW), parseSessionEntry(RAW_HOST, NOW)];
  const got = await selectSidecar(entries, { status: async () => ({ busy: false }) });
  assert.equal(got.entry.pid, 22620);
  assert.equal(got.entry.url, 'http://127.0.0.1:65252');
});

test('★ 宿主那个在忙 ⇒ 不用，也不回头去用用户的（明确报不可用）', async () => {
  const entries = [parseSessionEntry(RAW_USER, NOW), parseSessionEntry(RAW_HOST, NOW)];
  const got = await selectSidecar(entries, { status: async () => ({ busy: true }) });
  assert.equal(got, null, '★ busy 必须真的被尊重，不能当成"大概没事"');
});

test('★ 探不到 busy（status 返回 null）算不可用，不算空闲', async () => {
  const host = parseSessionEntry(RAW_HOST, NOW);
  assert.equal(await selectSidecar([host], { status: async () => null }), null);
  assert.equal(await selectSidecar([host], { status: async () => undefined }), null);
  assert.equal(await selectSidecar([host], { status: async () => ({}) }), null, '缺 busy 字段 ⇒ 不可用');
});

test('★ 端点已知的才算候选（缺 url 的条目现在一个都探不了）', async () => {
  const noUrl = parseSessionEntry({ pid: 26080, kind: 'interactive', cwd: 'D:\\Box\\x' }, NOW);
  assert.equal(noUrl.url, null, '缺 url ⇒ 没有端点（端口反查已随进程出口清理删除）');
  assert.equal(await selectSidecar([noUrl], { status: async () => ({ busy: false }) }), null,
    '★ 反查不出端点 ⇒ 不可用');
});

test('★ 非本机 / 非 http 的 URL 一律丢弃（session 文件是可写数据，不能任它指路）', () => {
  const now = NOW;
  assert.equal(parseSessionEntry({ ...RAW_HOST, url: 'http://evil.example.com:80' }, now), null);
  assert.equal(parseSessionEntry({ ...RAW_HOST, url: 'file:///C:/x' }, now), null);
  assert.equal(parseSessionEntry({ ...RAW_HOST, url: 'ws://127.0.0.1:1' }, now), null);
  assert.equal(parseSessionEntry({ ...RAW_HOST, url: 'not a url' }, now), null);
  assert.equal(parseSessionEntry({ ...RAW_HOST, url: 'http://127.0.0.1:65252' }, now).url, 'http://127.0.0.1:65252', '本机 loopback 照常');
});

test('坏数据不抛：pid 不对 / 非对象 / pid 缺失 ⇒ null', () => {
  assert.equal(parseSessionEntry(null, NOW), null);
  assert.equal(parseSessionEntry('x', NOW), null);
  assert.equal(parseSessionEntry({ ...RAW_HOST, pid: 0 }, NOW), null);
  assert.equal(parseSessionEntry({ ...RAW_HOST, pid: '22620' }, NOW), null, 'pid 必须是整数');
  const noCwd = parseSessionEntry({ ...RAW_HOST, cwd: undefined }, NOW);
  assert.equal(noCwd.hostManaged, false, '没有 cwd 就无法证明是宿主分配的 ⇒ 不可用');
});

test('★ discoverSidecars：坏文件跳过，好文件照常（一个坏了不该让整轮归零）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-sidecar-'));
  writeFileSync(join(dir, '22620.json'), JSON.stringify(RAW_HOST));
  writeFileSync(join(dir, '16080.json'), JSON.stringify(RAW_USER));
  writeFileSync(join(dir, 'broken.json'), '{ 写到一半');
  writeFileSync(join(dir, 'empty.json'), 'null');
  writeFileSync(join(dir, 'notjson.txt'), '忽略我');
  // ★ 显式钉住活性：默认的活性过滤是**真检查**，让这条测试的结果取决于
  //   "22620/16080 此刻是否还活着"就变成测机器状态了，不是测"坏文件跳过"。
  const got = discoverSidecars({ dir, now: NOW, isPidAlive: () => true });
  assert.deepEqual(got.map((e) => e.pid).sort((a, b) => a - b), [16080, 22620]);
});

test('★ discoverSidecars：默认就做活性过滤（否则每次下发都去读 20 个死进程的内存）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-sidecar-'));
  // process.pid 一定活着；用一个保证不存在的 pid 做对照。
  const alive = { ...RAW_HOST, pid: process.pid };
  writeFileSync(join(dir, 'alive.json'), JSON.stringify(alive));
  writeFileSync(join(dir, 'ghost.json'), JSON.stringify({ ...RAW_HOST, pid: 0x7FFFFFF0 }));

  const got = discoverSidecars({ dir, now: NOW });
  assert.deepEqual(got.map((e) => e.pid), [process.pid],
    '死进程残留的 session 文件必须在发现阶段就被剔除');
});

test('★ isPidAlive：EPERM 算"活着"（提权跑的用户 sidecar 绝不能被静默丢掉）', () => {
  const real = process.kill;
  const probe = (code) => {
    process.kill = () => { const e = new Error('boom'); e.code = code; throw e; };
    try { return isPidAlive(4242); } finally { process.kill = real; }
  };
  assert.equal(probe('ESRCH'), false, '进程真的没了');
  assert.equal(probe('EPERM'), true, '存在但无权打开 ⇒ 仍然活着');
  assert.equal(probe('EACCES'), true);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(1.5), false, 'pid 必须是整数');
});

test('discoverSidecars：进程已死的条目按 isPidAlive 剔除', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-sidecar-'));
  writeFileSync(join(dir, '22620.json'), JSON.stringify(RAW_HOST));
  writeFileSync(join(dir, '16080.json'), JSON.stringify(RAW_USER));
  const got = discoverSidecars({ dir, now: NOW, isPidAlive: (pid) => pid === 22620 });
  assert.deepEqual(got.map((e) => e.pid), [22620]);
});

test('discoverSidecars：目录不存在 ⇒ 空数组，不抛', () => {
  assert.deepEqual(discoverSidecars({ dir: join(tmpdir(), '不存在的目录-xyz') }), []);
});

// ════════════════════════════════════════════════════════════════════════════
// ★★ 目录纳管：CLI 2.147.0 把 session 文件搬到了 `~/.codebuddy/sessions`。
//
// 2026-09-30 真机（逐字采集）：
//   `C:\Users\demo\.codebuddy\sessions\40076.json`
//     { pid: 40076, kind: "daemon", url: "http://127.0.0.1:9527",
//       configuredPort: 9527, version: "2.147.0", cwd: "...\dsh-control-plane" }
//     → 进程活着、端口在 LISTEN、`GET /` 返回 200。**这是唯一可用的目标。**
//   `C:\Users\demo\.workbuddy\sessions\4304.json`
//     { pid: 4304, kind: "interactive", lastHeartbeat: 1789772812335 }  ← 无 url，写于 09-19
//     → pid 已被 Windows 回收给 `TextInputHost.exe`。
//
// 旧逻辑只扫 `.workbuddy`，于是"唯一活着的 sidecar 在另一个目录里"从未被看见，
// 拿到的只有那条陈旧记录 ⇒ `no_endpoint` ⇒ 文案把人送去重启桌面端（实测无效）。

test('★ 默认扫描目录必须同时覆盖 ~/.codebuddy/sessions 与 ~/.workbuddy/sessions', () => {
  assert.deepEqual(sessionsDirs('/home/u'), [
    join('/home/u', '.codebuddy', 'sessions'),   // 当前（CLI 2.147.0）
    join('/home/u', '.workbuddy', 'sessions'),   // 旧版桌面端
  ]);
});

test('★★ discoverSidecars：两个目录的条目都要被纳入（真机 40076 在 .codebuddy 下）', () => {
  const newDir = mkdtempSync(join(tmpdir(), 'wb-cb-'));
  const oldDir = mkdtempSync(join(tmpdir(), 'wb-wb-'));
  // 真机原文
  writeFileSync(join(newDir, '40076.json'), JSON.stringify({
    pid: 40076, lastHeartbeat: NOW, sessionId: '01a0e961-0de5-7fa1-9bb4-19c5d6c790c2',
    cwd: 'D:\\demo\\Documents\\Code\\dsh-control-plane', startedAt: NOW - 3_600_000,
    kind: 'daemon', url: 'http://127.0.0.1:9527', endpoint: 'http://127.0.0.1:9527',
    configuredPort: 9527, version: '2.147.0',
  }));
  writeFileSync(join(oldDir, '4304.json'), JSON.stringify({
    pid: 4304, lastHeartbeat: 1789772812335, sessionId: 'interactive-4304',
    cwd: 'c:\\Users\\demo\\WorkBuddy\\2026-09-18-19-47-07', startedAt: 1789772812306,
    kind: 'interactive',
  }));

  const got = discoverSidecars({ dirs: [newDir, oldDir], now: NOW, isPidAlive: () => true });
  assert.deepEqual(got.map((e) => e.pid).sort((a, b) => a - b), [4304, 40076],
    '两个目录都扫，不许只看其中一个');
  const live = got.find((e) => e.pid === 40076);
  assert.equal(live.url, 'http://127.0.0.1:9527', '带 url 的那条必须带出端点');
});

test('★★ 同一 pid 落在两个目录 ⇒ 带 url 的胜出，且不许重复成两条候选', () => {
  const newDir = mkdtempSync(join(tmpdir(), 'wb-cb-'));
  const oldDir = mkdtempSync(join(tmpdir(), 'wb-wb-'));
  writeFileSync(join(newDir, '777.json'), JSON.stringify({
    pid: 777, kind: 'daemon', url: 'http://127.0.0.1:9527', startedAt: 200,
  }));
  // 旧目录里同 pid 的残影：无 url ⇒ 若它胜出，端点就丢了
  writeFileSync(join(oldDir, '777.json'), JSON.stringify({
    pid: 777, kind: 'interactive', startedAt: 100,
  }));

  const got = discoverSidecars({ dirs: [newDir, oldDir], now: NOW, isPidAlive: () => true });
  assert.equal(got.length, 1, '同一 pid 不许重复成两条候选');
  assert.equal(got[0].url, 'http://127.0.0.1:9527', '带 url 的那条必须胜出');
});

test('两个目录都没有 / 都不存在 ⇒ 空数组，不抛（不回归）', () => {
  const empty = join(tmpdir(), '不存在的目录-xyz');
  assert.deepEqual(discoverSidecars({ dirs: [empty, empty] }), []);
});

test('probeStatus：busy 从 data 或顶层都能取；失败一律 null', async () => {
  const ok = (body) => async () => ({ ok: true, json: async () => body });
  assert.deepEqual(await probeStatus('http://127.0.0.1:1', ok({ data: { busy: true } })), { busy: true, runStatus: null });
  assert.deepEqual(await probeStatus('http://127.0.0.1:1', ok({ busy: false })), { busy: false, runStatus: null });
  assert.equal(await probeStatus('http://127.0.0.1:1', async () => { throw new Error('ECONNREFUSED'); }), null);
  assert.equal(await probeStatus('http://127.0.0.1:1', async () => ({ ok: false })), null);
  assert.equal(await probeStatus('http://127.0.0.1:1', ok({ data: { busy: 'yes' } })), null, 'busy 不是布尔 ⇒ 不可用');
});

// ★★ 2026-10-10：`gateway-portmap.test.js`（netstat/lsof 解析 + `resolveSidecarEndpoints`
//   + 这两个探活用例）随 `portmap.js` 一起删除。两个探活用例与 sidecar 的发现/选择
//   同属一层，搬到这里继续跑；断言逐字未改。
test('probeEntry：第一个端点探不通就试下一个，探通就停', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    // ★ 注意 URL 后面还挂着 `/api/v1/status`，所以判端口要带斜杠，
    //   `endsWith(':53350')` 会恒为 false —— 写这个夹具时真踩过。
    return { ok: url.includes(':53350/'), json: async () => ({ data: { busy: false } }) };
  };
  const st = await probeEntry({ url: 'http://127.0.0.1:53349', altUrls: ['http://127.0.0.1:53350'] },
    fetchImpl, 'tok');
  assert.deepEqual(st, { busy: false, runStatus: null });
  assert.deepEqual(seen, ['http://127.0.0.1:53349/api/v1/status', 'http://127.0.0.1:53350/api/v1/status'],
    '★ 必须真的往后试，不能第一个不通就判死');

  // 负控：第一个就通时**不**多打一次（那是对着本机服务白刷一轮）。
  const first = [];
  const okFirst = async (url) => { first.push(url); return { ok: true, json: async () => ({ data: { busy: false } }) }; };
  await probeEntry({ url: 'http://127.0.0.1:1', altUrls: ['http://127.0.0.1:2'] }, okFirst, 'tok');
  assert.equal(first.length, 1);
});

test('★ probeStatus：透出 runStatus（等授权 vs 在跑，处置完全不同）', async () => {
  const ok = (body) => async () => ({ ok: true, json: async () => body });
  const st = await probeStatus('http://127.0.0.1:1',
    ok({ data: { busy: true, runStatus: 'waiting_for_permission' } }));
  assert.deepEqual(st, { busy: true, runStatus: 'waiting_for_permission' });
  // 负控：字段不是字符串时退成 null，**不能**变成 undefined 混进文案里。
  assert.deepEqual(await probeStatus('http://127.0.0.1:1', ok({ data: { busy: false, runStatus: 7 } })),
    { busy: false, runStatus: null });
});

test('★ summarizePool：三类"选不出来"必须可区分（否则用户会被引去重启桌面端）', () => {
  const e = { pid: 1, hostManaged: true, heartbeatAgeMs: 0 };
  const P = (status) => [{ entry: e, status }];

  // 负控①：仅仅"在跑"**不能**被说成在等授权 —— 处置是等它完，等一下就好了。
  assert.equal(summarizePool(P({ busy: true, runStatus: 'model_streaming' })).code, 'busy_running');
  assert.equal(summarizePool(P({ busy: true, runStatus: null })).code, 'busy_running');

  const w = summarizePool(P({ busy: true, runStatus: 'waiting_for_permission' }));
  assert.equal(w.code, 'waiting_permission');
  assert.match(w.detail, /应答/, '必须告诉用户"去点那个授权"，而不是"等一会儿"');

  // 负控②：探不通 ≠ 探出忙。混为一谈会把"桌面端没就绪"说成"它在跑"。
  assert.equal(summarizePool(P(null)).code, 'probe_unreachable');

  // ★ "一个都没探到"分两种**处置完全不同**的成因：连 sidecar 都没了（去启动桌面端）
  //   vs sidecar 活着但解析不出端点（重启桌面端让它重新拉起）。合成一句会把后者
  //   说成"桌面端没启动"，而真相是进程明明在跑。
  assert.equal(summarizePool([], []).code, 'no_desktop');
  const aliveNoUrl = { pid: 26080, url: null, altUrls: [], hostManaged: false, kind: 'interactive' };
  assert.equal(summarizePool([], [aliveNoUrl]).code, 'no_endpoint');
  assert.equal(summarizePool([], [{ pid: 1, url: 'http://127.0.0.1:1', hostManaged: true }]).code, 'probe_unreachable',
    '端点已知却全探不通 ⇒ 不能说成"没端点"，也不能说成"没启动"');

  // 负控：两个 code 必须真的不同，否则分类等于没做。
  assert.notEqual(summarizePool([], []).code, summarizePool([], [aliveNoUrl]).code);
});

test('★ summarizePool：结论必须交代它**解释不了**的那些条目（真机踩过：21 个里 20 个是死进程）', () => {
  const e = { pid: 1, hostManaged: true, heartbeatAgeMs: 0 };
  // 真实分布：一个在等授权，20 个探不通（死进程残留）。
  const probed = [
    { entry: e, status: { busy: true, runStatus: 'waiting_for_permission' } },
    ...Array.from({ length: 20 }, () => ({ entry: e, status: null })),
  ];
  const r = summarizePool(probed);
  assert.equal(r.code, 'waiting_permission');
  assert.match(r.detail, /另有 20 个探不通/, '必须说清还有 20 个探不通，否则一个卡住的条目冒充了整池子的解释');
  assert.match(r.detail, /进程已退/, '要指出成因方向：进程已退但 session 文件还在');

  // 负控：池子干净时**不得**多嘴（否则正常错误路径会一直带噪声尾巴）。
  const clean = summarizePool([{ entry: e, status: { busy: true, runStatus: 'waiting_for_permission' } }]);
  assert.doesNotMatch(clean.detail, /另有/);
});

test('★ selectSidecar 选不出来时必须回调 onUnavailable（不然上层只剩一句空话）', async () => {
  const got = [];
  const r = await selectSidecar([{ pid: 7, url: 'http://127.0.0.1:7', hostManaged: true, heartbeatAgeMs: 0 }], {
    status: async () => ({ busy: true, runStatus: 'waiting_for_permission' }),
    onUnavailable: (s) => got.push(s),
  });
  assert.equal(r, null);
  assert.equal(got.length, 1);
  assert.equal(got[0].code, 'waiting_permission');
});

test('★ selectSidecar 选到人时不回调 onUnavailable（别把成功也报成失败原因）', async () => {
  const got = [];
  const r = await selectSidecar([{ pid: 7, url: 'http://127.0.0.1:7', hostManaged: true, heartbeatAgeMs: 0 }], {
    status: async () => ({ busy: false, runStatus: 'idle' }),
    onUnavailable: (s) => got.push(s),
  });
  assert.notEqual(r, null);
  assert.deepEqual(got, [], '成功路径不得产生"不可用原因"');
});
