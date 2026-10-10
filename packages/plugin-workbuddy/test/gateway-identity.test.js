// 进程身份核验（`src/host/gateway/identity.js`）已随 2026-10-10 P0 进程出口清理**整体删除**。
//
// ★★ 为什么这个文件还在 ★★
// 它原本一半的用例在钉 `createIdentityResolver()` 的接线契约：`['pwsh.exe', '-NoProfile',
// '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', <query-process-list.ps1>,
// '-ProcessIds', …]`，pwsh 不可用时回落到 `powershell.exe`。那是 **PowerShell 进程**，
// Owner 硬约束（插件任何路径都不许拉起显/隐 Shell/控制台进程）下必须删除，连同
// `assets/query-process-list.ps1` 与 `src/host/gateway/identity.js` 本体。
//
// ★ 另一半用例测的是 `summarizePool()` 的 pid 回收 / pid 消失文案。那是**纯函数**，
// 与进程枚举无耦合，所以整组搬到这里继续跑 —— 它们钉的是"别把用户送回重启循环"。
//
// ★★ 既知退化（如实记账）★★
// 删除之后插件**再也判不出**"pid 被回收给了别的程序"与"进程根本不存在"：
// 那要枚举 `Win32_Process` 的命令行，纯 JS 没有这条路（`process.kill(pid, 0)` 只能
// 回答"这个号有没有人占着"，回答不了"占着的是不是它"，而 EPERM 假阳性在真机上
// 会把死进程也报成活着）。于是 `dispatch.discover()` 的 `recycled` / `gone`
// 恒为空数组，`pid_recycled` / `pid_gone` 两个 code 在插件内不再产生。
// `summarizePool` 的两个分支与其文案**保留**（纯函数，零 importer 损失），
// 由下面这几条继续钉住 —— 它们不是"留着好玩"，是"谁再把它接回来时别写成那句假话"。
import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizePool } from '../src/host/gateway/sidecar.js';

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

test('★ pid_gone 的文案：不许出现"权限不够"，也不许叫用户去粘 gatewayToken', () => {
  const r = summarizePool([], [], { gone: [{ pid: 20868 }] });
  assert.equal(r.code, 'pid_gone');
  assert.doesNotMatch(r.detail, /权限不够|同等或更高的权限|提权/);
  assert.doesNotMatch(r.detail, /填进插件设置|粘/);
  assert.match(r.detail, /20868/, '要把那个 pid 点出来，否则用户无从判断是不是真有事');
});

test('★ token_unavailable 也不许把"权限不够"当成已证实的成因', () => {
  const r = summarizePool(
    [{ entry: { pid: 1 }, status: { busy: null, unavailable: 'token_unavailable' } }], [], {},
  );
  assert.equal(r.code, 'token_unavailable');
  assert.doesNotMatch(r.detail, /需要与 WorkBuddy 桌面端同等或更高的权限/);
  // ★ 2026-10-10 的新判据：自动读取 PowerShell 路已删 ⇒ 唯一管用的动作就是填 gatewayToken。
  assert.match(r.detail, /gatewayToken/);
});

test('★ 两个 code 的处置不同：gone 说"打开一次对话"，别把用户送去重启', () => {
  const gone = summarizePool([], [], { gone: [{ pid: 20868 }] });
  const recycled = summarizePool([], [], { recycled: [{ pid: 4304, name: 'TextInputHost.exe' }] });
  assert.notEqual(gone.code, recycled.code);
  assert.notEqual(gone.detail, recycled.detail);
});

// ── ★★ 新不变量：进程身份枚举整条路已不存在 ────────────────────────────────

test('★★ 进程身份枚举模块已删除，且不再有任何 importer', async () => {
  const { existsSync } = await import('node:fs');
  assert.equal(
    existsSync(new URL('../src/host/gateway/identity.js', import.meta.url)), false,
    '★ identity.js 必须已删除（它起 PowerShell 列进程）',
  );
  assert.equal(
    existsSync(new URL('../assets/query-process-list.ps1', import.meta.url)), false,
    '★ query-process-list.ps1 必须已删除',
  );
});

test('★★ dispatch 不再持有进程出口（deps.run 已从形参删除）', async () => {
  // 这不是装饰：`deps.run` 曾经是 PowerShell / netstat / tasklist 三条路的唯一入口。
  // 谁再把它加回 createDispatcher 的形参，这条会转红。
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(
    new URL('../src/host/gateway/dispatch.js', import.meta.url), 'utf8',
  )
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'))
    .join('\n');
  for (const needle of ['createPortResolver', 'createIdentityResolver', 'readGatewayPassword',
    'pwsh', 'powershell', 'netstat', 'lsof', 'tasklist']) {
    assert.equal(src.includes(needle), false, `★ dispatch.js 代码里不得再出现 ${needle}`);
  }
});
