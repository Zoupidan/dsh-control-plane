// 「那个进程还在不在」：exists 这个维度必须与 isSidecar 正交（2026-09-30 真机回归）。
//
// ★★ 2026-10-10 P0 进程出口清理：本文件的"端到端"一半已随 `identity.js` 删除 ★★
//
// 真机链路（2026-09-30 完整记录，保留在此作为删除决策的证据）：
// <pre>
//   ① `~/.codebuddy/sessions/20868.json` 还在（startedAt 19:11:32，hb 19:23:33），
//      但 pid 20868 早就没了：tasklist、`Get-CimInstance Win32_Process`、
//      `GetProcessById` 三者**都不承认它**。
//   ② `isPidAlive(20868)` 返 `true` —— 因为 `process.kill(pid, 0)` 在这台机器上
//      对一个**不存在的** pid 抛的是 **EPERM 而不是 ESRCH**。
//   ③ 于是它进了候选池（`/plugin-workbuddy/diagnostics` 读到 `candidates: 1`），
//      接着插件去读一个不存在的进程的环境块 ⇒ 读不到。
//   ④ 而 ③ 的失败被原样归因为 `token_unavailable` + 一句"权限不够"——
//      **两处都是错的**：进程本来就不存在，跟权限无关；处置也全错
//      （用户被送去提权 / 去设置里粘 gatewayToken）。
// </pre>
// 2026-09-30 的修法是靠 `query-process-list.ps1`（PowerShell）拉整张 Win32_Process 表，
// 把"进程不存在"变成一个**确定的否定答案**（`exists:false`），与"被回收"分开报。
//
// ★★ 为什么现在必须删 ★★
// 那条修法**整体建立在一个 PowerShell 子进程上**。Owner 硬约束：插件任何路径
// （正常流、错误回退、探测逻辑）都不许拉起显/隐 Shell 或控制台进程。于是：
// <pre>
//   identity.js + query-process-list.ps1  删除
//   dispatch.discover() 的 recycled/gone  恒为空数组
//   pid_gone / pid_recycled 两个 code     在插件内不再产生（纯函数保留）
// </pre>
// ⇒ **`isPidAlive` 的 EPERM 假阳性又回来了**（②），死进程的残留 session 文件会重新
// 进入候选池。这是本次清理**已知且已记账**的退化：要么留着 PowerShell，要么接受它。
// 影响局限于诊断/归因文案，不再影响下发（`selectSidecar` 会因端点探不通把它筛掉）。
//
// 保留下来的用例钉的是**纯文本契约**：两个 code 的处置必须不同、都不许出现那句假话。
import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizePool } from '../src/host/gateway/sidecar.js';

test('★ pid_gone 与 pid_recycled 的处置必须真的不同（合成一句就把人送去重启）', () => {
  const gone = summarizePool([], [], { gone: [{ pid: 20868 }] });
  const recycled = summarizePool([], [], { recycled: [{ pid: 4304, name: 'TextInputHost.exe' }] });
  assert.equal(gone.code, 'pid_gone');
  assert.equal(recycled.code, 'pid_recycled');
  assert.notEqual(gone.detail, recycled.detail);
  // gone：真相是"只剩文件"，桌面端可能开着 ⇒ 指"打开一次对话"
  assert.match(gone.detail, /打开一次对话/);
  assert.doesNotMatch(gone.detail, /重启 WorkBuddy 桌面端会重新拉起/);
  // recycled：真相是"那个号归别人了"，重启治不好 ⇒ 明说治不好
  assert.match(recycled.detail, /重启桌面端也解决不了/);
});

test('★ pid_gone 的文案：不许编造"权限不够"，也不许把"粘 gatewayToken"当成出路', () => {
  const r = summarizePool([], [], { gone: [{ pid: 20868 }] });
  assert.doesNotMatch(r.detail, /权限不够|同等或更高的权限|提权/,
    '2026-09-30 真机：非提权 shell 读 WorkBuddy 进程环境块是成功的，问题从来不是权限');
  assert.doesNotMatch(r.detail, /填进插件设置|粘/,
    'AC-0：此刻压根没有 sidecar 可用，"粘一个 token"不解决任何事');
  assert.match(r.detail, /20868/);
});

test('★ 两条都出现时，gone 要压过 recycled（先回答"桌面端拉没拉起 sidecar"）', () => {
  const both = summarizePool([], [], {
    gone: [{ pid: 20868 }],
    recycled: [{ pid: 4304, name: 'TextInputHost.exe' }],
  });
  assert.equal(both.code, 'pid_gone',
    '同时有两种痕迹时先报"没有任何存活 sidecar"——它把"重启治不好"那半句也一起带出去');
  assert.match(both.detail, /pid 被 Windows 回收/);
});

test('★ token_unavailable 的处置必须指向 gatewayToken（2026-10-10 起那是唯一来源）', () => {
  const r = summarizePool(
    [{ entry: { pid: 1 }, status: { busy: null, unavailable: 'token_unavailable' } }], [], {},
  );
  assert.equal(r.code, 'token_unavailable');
  assert.match(r.detail, /gatewayToken/);
  assert.doesNotMatch(r.detail, /需要与桌面端同等或更高的权限/);
  // ★ 2026-10-10 之前这里最后一句是"填 gatewayToken 在这台机器上帮不上忙，先得有 sidecar"。
  //   现在反过来了：自动读取已删，填 gatewayToken 就是这一路上唯一能推进的动作。
  assert.match(r.detail, /唯一能推进/);
});

// ── ★★ 新不变量：端到端那条"剔出候选池"的能力已随进程枚举删除 ──────────────

test('★★ dispatch 不再做身份核验：recycled / gone 恒为空（它来自已删除的 PowerShell）', async () => {
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(new URL('../src/host/gateway/identity.js', import.meta.url)), false,
    '★ identity.js 必须已删除');
  const { createDispatcher } = await import('../src/host/gateway/dispatch.js');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  // 真机形状：一条 hostManaged 的 session 文件（pid 早死了，且 isPidAlive 对它假阳性）。
  const RAW = {
    pid: 20868, lastHeartbeat: 1790573813000, sessionId: '01a0e65b-7f51-7796-bfa1-be54df9e7615',
    cwd: 'C:\\Users\\demo\\AppData\\Local\\Temp\\workbuddy-host-cli\\__workbuddy_cli_host__-0-eade4501',
    startedAt: 1790572292000, kind: 'interactive', url: 'http://127.0.0.1:18489',
    endpoint: 'http://127.0.0.1:18489', mode: 'local', version: '2.147.0',
  };
  const dir = mkdtempSync(join(tmpdir(), 'wb-gone-'));
  writeFileSync(join(dir, '20868.json'), JSON.stringify(RAW));

  let subprocessTouched = 0;
  const d = createDispatcher({
    sessionsDir: dir,
    // ★ 观察点：给一个**会抛**的 run。dispatch 若还敢经 seam 起进程，这里立刻炸。
    run: async () => { subprocessTouched += 1; throw new Error('任何进程出口都不该被碰'); },
    isPidAlive: () => true,          // ★ 真机形状：EPERM 假阳性 ⇒ 死 pid 仍算"活着"
    now: () => 1790573820000,
  });
  const r = await d.inspect();

  assert.equal(subprocessTouched, 0, '★★ 插件一个子进程都不该拉（Owner 硬约束）');
  // ★★ 既知退化如实断言：没有身份枚举 ⇒ 这条死 pid 现在**会**进候选池（修前 2026-09-30
  //   的样子），归因也不再是 pid_gone。把它钉住，让退化是**可见的**而不是被悄悄改掉的。
  assert.equal(r.candidates, 1, '★ 没有进程身份枚举 ⇒ EPERM 假阳性的死 pid 重新进入候选池（既知退化）');
  assert.notEqual(r.unavailable?.code, 'pid_gone', '该 code 已不可能产生');
});

test('★★ dispatch 不再反查端口：缺 url 的条目直接落 no_endpoint', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createDispatcher } = await import('../src/host/gateway/dispatch.js');

  // 真机 5.6.2 形状：没有 url 字段（旧解法是起 netstat/lsof 反查）。
  const RAW = {
    pid: 26080, lastHeartbeat: 1790573813000, sessionId: 'interactive-26080',
    cwd: 'D:\\Box\\交易知识库', startedAt: 1790572292000, kind: 'interactive',
  };
  const dir = mkdtempSync(join(tmpdir(), 'wb-nourl-'));
  writeFileSync(join(dir, '26080.json'), JSON.stringify(RAW));

  let subprocessTouched = 0;
  const d = createDispatcher({
    sessionsDir: dir,
    run: async () => { subprocessTouched += 1; throw new Error('任何进程出口都不该被碰'); },
    isPidAlive: () => true,
    gatewayToken: 'tok',
    fetchImpl: async () => ({ ok: false, status: 0 }),
    now: () => 1790573820000,
  });
  const r = await d.inspect();

  assert.equal(subprocessTouched, 0, '★★ netstat/lsof 一个都不该起');
  assert.equal(r.candidates, 1, '条目还在（活性判定没有变）');
  assert.equal(r.resolved, 0, '★ 没有端点：端口反查已删');
  assert.equal(r.unavailable?.code, 'no_endpoint', '★ 归因必须落在"解析不出端点"上');
});
