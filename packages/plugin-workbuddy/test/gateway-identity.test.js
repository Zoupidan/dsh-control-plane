// 进程身份核验：session 文件里的 pid **现在还是不是** WorkBuddy 自己的进程。
//
// ★ 这组 fixture 全部是 2026-09-29 真机逐字采集的，不是编的：
//   - 4304  记在 ~/.workbuddy/sessions/4304.json 里的是 `kind: interactive`，
//           但该 pid 实际已被 Windows 回收给 `TextInputHost.exe`（触摸键盘）。
//   - 33368 / 13828 是真的 WorkBuddy 进程。
import assert from 'node:assert/strict';
import test from 'node:test';

import { createIdentityResolver, isSidecarProcess, parseProcessList } from '../src/host/gateway/identity.js';
import { POWERSHELL_CANDIDATES } from '../src/host/gateway/token.js';
import { summarizePool } from '../src/host/gateway/sidecar.js';

// 真机 query-process-list.ps1 输出（逐字）
const REAL_OUTPUT = [
  '4304\tTextInputHost.exe\t"C:\\WINDOWS\\SystemApps\\MicrosoftWindows.Client.CBS_cw5n1h2txyewy\\TextInputHost.exe" -ServerName:InputApp.AppXk0mrh4r2q0ct33a9wgbez0x7v9cz5y.mca',
  '13828\tWorkBuddy.exe\t"C:\\Program Files\\WorkBuddy\\WorkBuddy.exe" ',
  '33368\tWorkBuddy.exe\t"C:\\Program Files\\WorkBuddy\\WorkBuddy.exe" "C:\\Program Files\\WorkBuddy\\resources\\app.asar\\main\\daemon-app-server-entry.js" --stdio',
].join('\n');

// ── 必须判 false 的那一侧（这是本组测试存在的理由）─────────────────────────
test('★ 被回收给系统程序的 pid 必须判 false（真机 TextInputHost）', () => {
  const proc = parseProcessList(REAL_OUTPUT, 4304);
  assert.notEqual(proc, null, 'fixture 自检：4304 应能解析出来');
  assert.equal(proc.name, 'TextInputHost.exe');
  assert.equal(isSidecarProcess(proc), false,
    '这是本次修复的核心：旧逻辑只查 isPidAlive，而这个 pid 确实活着');
});

// ── 必须判 true 的那一侧（防止"过滤得太狠，把真的也滤掉"）─────────────────
test('真的 WorkBuddy 进程必须判 true', () => {
  assert.equal(isSidecarProcess(parseProcessList(REAL_OUTPUT, 33368)), true);
  assert.equal(isSidecarProcess(parseProcessList(REAL_OUTPUT, 13828)), true);
});

test('node 跑 codebuddy 入口也算（sidecar 可能不是 WorkBuddy.exe）', () => {
  assert.equal(isSidecarProcess({
    name: 'node.exe',
    commandLine: '"C:\\Program Files\\nodejs\\node.exe" C:\\...\\cli\\dist\\codebuddy-headless.js daemon start',
  }), true);
});

test('空输入判 false', () => {
  assert.equal(isSidecarProcess({ name: '', commandLine: '' }), false);
  assert.equal(isSidecarProcess({}), false);
  assert.equal(isSidecarProcess(null), false);
});

test('★ 不能只看可执行文件名——node.exe 满机器都是', () => {
  assert.equal(isSidecarProcess({ name: 'node.exe', commandLine: 'node D:\\demo\\my-project\\server.js' }), false);
});

// ── 解析器 ────────────────────────────────────────────────────────────────
test('parseProcessList：查不到的 pid 返回 null（⇒ 上层存疑 ⇒ fail-open）', () => {
  assert.equal(parseProcessList(REAL_OUTPUT, 99999), null);
  assert.equal(parseProcessList('', 13828), null);
  assert.equal(parseProcessList(null, 13828), null);
});

test('parseProcessList：命令行里带 tab 也不能错位', () => {
  const line = '77\tWorkBuddy.exe\tsome\tweird\tcommand';
  const p = parseProcessList(line, 77);
  assert.equal(p.name, 'WorkBuddy.exe');
  assert.equal(p.commandLine, 'some\tweird\tcommand');
  assert.equal(isSidecarProcess(p), true);
});

// ── 批量解析器 ────────────────────────────────────────────────────────────
test('createIdentityResolver：一次查询覆盖多个 pid，缺的记为存疑', async () => {
  const resolve = createIdentityResolver({ run: async () => REAL_OUTPUT });
  const got = await resolve([4304, 33368, 99999]);
  assert.equal(got.get(4304).isSidecar, false);
  assert.equal(got.get(4304).name, 'TextInputHost.exe');
  assert.equal(got.get(33368).isSidecar, true);
  assert.equal(got.get(99999).isSidecar, null, '查不到必须存疑，不能当成 false');
});

test('createIdentityResolver：整个查询失败 ⇒ 全部存疑（不许静默丢候选）', async () => {
  const resolve = createIdentityResolver({ run: async () => { throw new Error('EACCES'); } });
  const got = await resolve([4304, 33368]);
  assert.equal(got.get(4304).isSidecar, null);
  assert.equal(got.get(33368).isSidecar, null);
});

test('createIdentityResolver：空输入不发起查询', async () => {
  let called = 0;
  const resolve = createIdentityResolver({ run: async () => { called += 1; return ''; } });
  assert.equal((await resolve([])).size, 0);
  assert.equal(called, 0);
});

// ── 结论文案（★ 这里防的是回归：别再把用户送进重启循环）───────────────────
test('★ pid 回收要单开一个 code，且文案里不许出现"重启"能治好的暗示', () => {
  const r = summarizePool([], [], { recycled: [{ pid: 4304, name: 'TextInputHost.exe' }] });
  assert.equal(r.code, 'pid_recycled');
  assert.match(r.detail, /4304/);
  assert.match(r.detail, /TextInputHost\.exe/);
  // ★ 关键回归护栏：旧文案说"重启桌面端会重新拉起带端点的 sidecar"，实测为假。
  //   断言的是**那一句假话不许再出现**，而不是笼统地不许出现"重启"二字
  //   —— 新文案必须明确说"重启解决不了"，禁掉"重启"本身反而会把正确文案也毙掉。
  assert.ok(!r.detail.includes('重启 WorkBuddy 桌面端会重新拉起'),
    `文案又变回那句实测为假的话：${r.detail}`);
  assert.match(r.detail, /重启桌面端也解决不了/);
});

test('没有回收条目时，行为与旧逻辑完全一致（不回归）', () => {
  assert.equal(summarizePool([], []).code, 'no_desktop');
  const aliveNoUrl = { pid: 1, url: null, hostManaged: false, kind: 'interactive' };
  assert.equal(summarizePool([], [aliveNoUrl]).code, 'no_endpoint');
});

// ════════════════════════════════════════════════════════════════════════════
// ★★ 接线契约：argv[0] 必须是**可执行程序**，不能是开关。
//
// 2026-09-30 真机发现。上面这一整组测试全都注入 `run: async () => REAL_OUTPUT`
// —— 假 runner **根本不看 argv**，所以"argv 拼错"这条在单元测试里是不可见的。
// 而真实 seam（`ctx.subprocess.spawn`，apply.js makeSeamRunner）把 `argv[0]` 当程序名：
//     token.js    → ['pwsh.exe',  '-NoProfile', ...]
//     portmap.js  → ['netstat',   '-ano', ...]
//     hardening.test.js 的 seam 测试 → ['pwsh.exe', '-NoProfile']
// 全仓 139 处 argv 里，只有本模块写成了 `['-NoProfile', ...]`。
// ⇒ seam 去执行一个名叫 `-NoProfile` 的程序 ⇒ 必抛 ⇒ 下面 catch 里的 fail-open
//   把**全部 pid 判成"存疑"** ⇒ pid 回收防线（本模块存在的唯一理由）在真机从未生效。
// 症状不是"少一条候选"，而是结论被带歪成 `no_endpoint`（"去重启桌面端"），
// 而真正该报的是 `pid_recycled`（"重启解决不了"）—— 用户因此被送进重启循环。
test('★★ 身份查询的 argv[0] 必须是 shell 可执行程序（不是开关）', async () => {
  const seen = [];
  const resolve = createIdentityResolver({
    run: async (spec) => { seen.push(spec.argv); return REAL_OUTPUT; },
  });
  const got = await resolve([4304]);
  assert.equal(seen.length, 1, '一次查询只发起一次进程');
  const argv = seen[0];
  assert.ok(!String(argv[0]).startsWith('-'),
    `argv[0]="${argv[0]}" 是开关不是程序 ⇒ seam ENOENT ⇒ 身份核验整轮塌成"存疑"`);
  assert.match(String(argv[0]), /pwsh|powershell/i, '身份查询必须走 PowerShell');
  assert.equal(argv[1], '-NoProfile', '开关要跟在程序名后面');
  assert.ok(argv.includes('-File'), '仍以 -File 调 helper');
  assert.ok(argv.some((a) => String(a).includes('query-process-list.ps1')),
    '调的必须是进程清单 helper');
  assert.equal(got.get(4304).isSidecar, false,
    '★ 接线修好后必须真的判出 false —— 这正是 pid 4304 → TextInputHost 那条真机结论');
});

test('★★ pwsh 不可用时回落到 powershell.exe（与 token.js 同一套候选）', async () => {
  const seen = [];
  const resolve = createIdentityResolver({
    run: async (spec) => {
      seen.push(spec.argv[0]);
      if (spec.argv[0] === POWERSHELL_CANDIDATES[0]) throw new Error('ENOENT');
      return REAL_OUTPUT;
    },
  });
  const got = await resolve([4304]);
  assert.deepEqual(seen, [...POWERSHELL_CANDIDATES],
    '必须先试 pwsh.exe 再回落 powershell.exe');
  assert.equal(got.get(4304).isSidecar, false,
    '回落成功后必须真的判出 false，不许停在"存疑"');
});

test('两个 shell 都起不来 ⇒ 仍然全部存疑（fail-open 不许退化成"全判 false"）', async () => {
  let calls = 0;
  const resolve = createIdentityResolver({
    run: async () => { calls += 1; throw new Error('EACCES'); },
  });
  const got = await resolve([4304, 33368]);
  assert.equal(got.get(4304).isSidecar, null);
  assert.equal(got.get(33368).isSidecar, null);
  assert.equal(calls, POWERSHELL_CANDIDATES.length, '每个候选 shell 各试一次');
});
