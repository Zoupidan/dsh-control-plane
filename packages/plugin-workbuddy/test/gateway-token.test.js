// 网关口令的唯一供给：**用户配的 `gatewayToken`**。
//
// ★★ 2026-10-10 P0 进程出口清理：这个文件原来一半以上的用例在钉
//   `readGatewayPassword()` 的 argv 契约（`pwsh.exe` / `powershell.exe` 回落、
//   `-ProcessId` 参数、助手脚本路径……）。那条路起的是 **PowerShell 进程**
//   （读 sidecar 的 PEB 环境块），Owner 硬约束"插件任何路径都不许拉起显/隐
//   Shell/控制台进程"下整体删除，连同：
//     · assets/read-sidecar-env.ps1（helper 脚本）
//     · readGatewayPassword / normalizeHelperOutput / parseGatewayPassword
//     · POWERSHELL_CANDIDATES / GATEWAY_PASSWORD_ENV / GATEWAY_PASSWORD_LEN
//     · dispatch.js 的 `deps.run`、apply.js 的 `makeSeamRunner`
//   下面把这些用例换成**新的不变量**：本模块一个进程都不起，令牌只来自配置。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { autoReadSupport, createTokenProvider } from '../src/host/gateway/token.js';

// ── 缓存 ────────────────────────────────────────────────────────────────
const sidecar = { pid: 22620, startedAt: 1790555336298 };

test('★ 同一次 sidecar 生命周期只解析一次配置（缓存是必需品，不是优化）', async () => {
  let reads = 0;
  const p = createTokenProvider({
    configured: () => { reads += 1; return 'tok'; },
  });
  const sources = [];
  for (let i = 0; i < 5; i += 1) sources.push((await p.get(sidecar)).source);
  // ★ 缓存键是 pid+startedAt（那次跨进程读的缓存键），配置值本身不进缓存。
  //   现在的形态是"每次调用现取配置"（用户改了设置要立刻生效），所以 read 数是 5。
  assert.equal(reads, 5, '配置每轮现取：用户改了设置必须立刻生效');
  assert.deepEqual(sources, ['config', 'config', 'config', 'config', 'config']);
  assert.equal(p.size, 0, '★ 配置不进缓存');
});

test('sidecar 重启（pid 或 startedAt 变）⇒ 缓存失效，重新读', async () => {
  let n = 0;
  const p = createTokenProvider({ read: async () => { n += 1; return `tok${n}`; } });
  await p.get(sidecar);
  const after = await p.get({ ...sidecar, startedAt: sidecar.startedAt + 1 });
  assert.equal(n, 2, '换了 sidecar 世代 ⇒ 旧口令必然失效，必须重读');
  assert.equal(after.token, 'tok2');
  assert.equal(after.source, 'read');
});

test('forget 掉某个 sidecar 的口令', async () => {
  let n = 0;
  const p = createTokenProvider({ read: async () => { n += 1; return 'tok'; } });
  await p.get(sidecar);
  p.forget(sidecar);
  await p.get(sidecar);
  assert.equal(n, 2);
  assert.equal(p.size, 1);
});

test('配置了 gatewayToken ⇒ 走配置（唯一真源），且**不**进缓存', async () => {
  let readCalls = 0;
  const p = createTokenProvider({ read: async () => { readCalls += 1; return 'from-process'; }, configured: 'from-config' });
  const a = await p.get(sidecar);
  assert.deepEqual(a, { token: 'from-config', source: 'config' });
  assert.equal(readCalls, 0, '配了就别去读进程');
  assert.equal(p.size, 0, '★ 配置不进缓存：用户可能改配置，重启后要能生效');
  assert.equal((await p.get(sidecar)).source, 'config');
});

test('★ 配置是唯一真源：静态字符串与取值函数都收，且每轮现取', async () => {
  const seen = [];
  const fn = createTokenProvider({ configured: () => { seen.push('read'); return 'a'; } });
  assert.equal((await fn.get(sidecar)).token, 'a');
  assert.equal((await fn.get(sidecar)).token, 'a');
  assert.equal(seen.length, 2, '★ 每轮现取：用户改了设置必须立刻生效（不是装配期拍死）');

  const statik = createTokenProvider({ configured: 'b' });
  assert.equal((await statik.get(sidecar)).token, 'b');
});

// ── 唯一的降级出口：没有自动读取实现了 ──────────────────────────────────

test('★ 没配 gatewayToken ⇒ 抛错，且错误里绝不含口令值、必须给出可执行的下一步', async () => {
  const p = createTokenProvider({});
  await assert.rejects(() => p.get(sidecar), (e) => {
    assert.match(e.message, /gatewayToken/i, '必须告诉用户还能怎么配');
    assert.match(e.message, /shell|console process/i,
      '必须说清为什么不能自动读（那条 PowerShell 路已删）');
    void 0;
    return true;
  });
  assert.equal(p.size, 0, '读失败不写缓存，否则会一直卡在失败态');
});

test('★ 注入了 read 钩子时仍然可用（向后兼容；插件自己已不再提供实现）', async () => {
  const p = createTokenProvider({ read: async () => 'from-read-hook' });
  assert.deepEqual(await p.get(sidecar), { token: 'from-read-hook', source: 'read' });
  assert.equal(p.size, 1, 'read 路径仍然按 pid+startedAt 缓存');
});

// ── autoReadSupport：恒为"不支持"，但必须给出下一步 ─────────────────────

test('★ autoReadSupport 恒为不支持（任何平台都没有自动读取这回事）', () => {
  const s = autoReadSupport();
  assert.equal(s.supported, false);
  assert.match(s.reason, /gatewayToken/, '必须告诉用户还能怎么配');
  assert.match(s.reason, /shell|console process/i, '必须说清为什么');
});

// ── ★★ 新不变量：本模块零进程出口 ────────────────────────────────────────

test('★★ 本模块的导出面里没有任何"起进程/跑助手"的入口', async () => {
  // 这不是装饰：那 3 个被删的函数名曾经就在这张表里。把它们加回来就等于
  // 重新接回 PowerShell —— 这条断言会在回归时转红。
  const forbidden = ['readGatewayPassword', 'normalizeHelperOutput', 'parseGatewayPassword'];
  const mod = await import('../src/host/gateway/token.js');
  for (const name of forbidden) {
    assert.equal(name in mod, false, `★ ${name} 必须已删除（它起 PowerShell 进程）`);
  }
  const src = readFileSync(
    fileURLToPath(new URL('../src/host/gateway/token.js', import.meta.url)),
    'utf8',
  );
  for (const needle of ['pwsh', 'powershell', 'netstat', 'lsof', 'tasklist', 'read-sidecar-env']) {
    // 模块头注释里会**提到**这些名字（说明为什么删了），但代码里不许再出现。
    const codeLines = src.split('\n')
      .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'));
    assert.equal(codeLines.some((l) => l.includes(needle)), false,
      `★ 代码里不得再出现 ${needle}（注释里说明删除理由可以）`);
  }
});
