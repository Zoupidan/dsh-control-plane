// 网关口令获取。纯解析 + 缓存语义，不起进程、不读任何真实进程环境。
// ★ 负对照的用意：确保"读不到"不会被降级成"随便用个空的/配置里的"，也确保口令不漏进错误信息。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GATEWAY_PASSWORD_ENV, POWERSHELL_CANDIDATES, autoReadSupport, createTokenProvider, normalizeHelperOutput, parseGatewayPassword, readGatewayPassword,
} from '../src/host/gateway/token.js';

// 真机环境块片段（形态：NUL 分隔、整块、双 NUL 结尾）
const V = 'mj_i…NmXM'; // 真机口令首 4/末 4，仅供对照，本仓不存真值
const REAL_BLOCK = [
  'SystemRoot=C:\\Windows',
  '=C:=C:\\Users\\demo',                 // ★ 盘符变量：以 = 开头，必须跳过
  'MY_CODEBUDDY_GATEWAY_PASSWORD=decoy',   // ★ 含子串的键，必须不被误取
  `${GATEWAY_PASSWORD_ENV}=${V.replace('…', 'X')}`,
  'PATHEXT=.COM;.EXE;.BAT',
  '',
].join('\0');

test('真实环境块形态：按 \\0 切出目标键', () => {
  assert.equal(parseGatewayPassword(REAL_BLOCK), 'mj_iXNmXM');
});

test('★ 负对照：含子串的键名不得被误取（MY_CODEBUDDY_GATEWAY_PASSWORD）', () => {
  assert.equal(parseGatewayPassword(REAL_BLOCK), 'mj_iXNmXM', '★ 拿到 decoy 就算泄露');
  assert.equal(parseGatewayPassword(`MY_${GATEWAY_PASSWORD_ENV}=decoy\0\0`), null);
});

test('★ 负对照：键不存在 ⇒ null，不是空串、不是 undefined', () => {
  assert.equal(parseGatewayPassword('SystemRoot=C:\\Windows\0PATH=/usr/bin\0\0'), null);
  assert.equal(parseGatewayPassword(`${GATEWAY_PASSWORD_ENV}=\0\0`), null, '空值算取不到');
  assert.notEqual(parseGatewayPassword('PATH=x\0\0'), '');
});

test('★ 负对照：非字符串 / 空块 ⇒ null（不抛）', () => {
  for (const bad of [null, undefined, '', 0, 42, {}, []]) {
    assert.equal(parseGatewayPassword(bad), null, `输入 ${JSON.stringify(bad)}`);
  }
});

test('值里含 = 号不能被截断（用最后一个 = 当分隔会错，这里用第一个）', () => {
  assert.equal(parseGatewayPassword(`${GATEWAY_PASSWORD_ENV}=ab=cd=ef\0\0`), 'ab=cd=ef');
});

test('多个同键条目取第一个', () => {
  assert.equal(parseGatewayPassword(`${GATEWAY_PASSWORD_ENV}=one\0${GATEWAY_PASSWORD_ENV}=two\0\0`), 'one');
});

test('★ 非 Windows 明确判不支持并给出下一步（不是抛一个原生异常给用户）', () => {
  const s = autoReadSupport();
  if (process.platform === 'win32') {
    assert.equal(s.supported, true);
    assert.equal(s.reason, null);
  } else {
    assert.equal(s.supported, false);
    assert.match(s.reason, /gatewayToken/, '必须告诉用户还能怎么配');
  }
});

test('readGatewayPassword：★ 口令绝不经过 argv', async () => {
  const calls = [];
  const got = await readGatewayPassword(22620, {
    helper: 'C:/x/read-sidecar-env.ps1',
    // ★ 助手的成功路径输出的是**裸值**（无 KEY= 前缀、无换行），不是环境块
    run: async ({ argv }) => { calls.push(argv); return 'mj_iXNmXM'; },
  });
  assert.equal(got, 'mj_iXNmXM');
  const argv = calls[0];
  const file = argv[0];
  const args = argv.slice(1);
  assert.ok(/^(pwsh|powershell)\.exe$/i.test(file), `必须走 PowerShell，实际是 ${file}`);
  assert.ok(args.includes('22620') || args.includes('22620'.toString()), 'pid 走参数');
  assert.ok(!args.some((a) => a.includes('secret')), '★ 值不在参数里');
  assert.ok(args.some((a) => /ProcessId/i.test(a)), '参数名必须是 -ProcessId（$Pid 是只读自动变量）');
});

test('readGatewayPassword：★ 逐个 shell 回落（5.1 解析无 BOM 脚本会失败，7.x 才能救）', async () => {
  // ★ 这条对应真机事故：powershell.exe 5.1 按 ANSI 解码无 BOM 的 .ps1，
  //   脚本里的中文注释被打乱 → `Unexpected token '}'` → 退出码 1，43 字节的口令永远拿不到。
  //   脚本已加 BOM 修复 5.1，但 BOM 会被编辑器/格式化工具抹掉，故留 7.x 通路。
  const seen = [];
  const got = await readGatewayPassword(22620, {
    helper: 'h',
    run: async ({ argv }) => {
      seen.push(argv[0]);
      if (/^pwsh/i.test(argv[0])) throw new Error('not installed');
      return 'mj_iXNmXM';
    },
  });
  assert.equal(got, 'mj_iXNmXM', '★ 前一个 shell 挂掉必须继续试下一个，而不是直接 null');
  assert.deepEqual(seen.slice(0, 2).map((f) => (/^pwsh/i.test(f) ? 'pwsh' : 'powershell')),
    ['pwsh', 'powershell'], '★ 顺序固定：先 7.x 后 5.1');
  assert.ok(seen.length <= POWERSHELL_CANDIDATES.length, '全部挂掉就该收手');
});

test('readGatewayPassword：★ 两个 shell 都失败 ⇒ null（不是第一个失败就放弃）', async () => {
  let n = 0;
  const got = await readGatewayPassword(22620, { helper: 'h', run: async () => { n += 1; throw new Error('x'); } });
  assert.equal(got, null);
  assert.equal(n, POWERSHELL_CANDIDATES.length, '★ 每个候选都要试过');
});

test('★ normalizeHelperOutput 必须收 {stdout} 形状（promisify(execFile) 的真实返回值）', async () => {
  // ★ 这条是被真机抓出来的：单测注入 `async () => '口令'` 全绿，但生产里注入的是
  //   promisify(execFile)，它解析出的是 `{stdout, stderr}` 对象。旧实现只收裸字符串，
  //   于是每次都返回 null —— 表现为"口令永远读不到"，把接线错伪装成权限问题。
  assert.equal(normalizeHelperOutput({ stdout: 'mj_iXNmXM', stderr: '' }), 'mj_iXNmXM');
  assert.equal(normalizeHelperOutput({ stdout: '  mj_iXNmXM\n', stderr: 'warning: noise' }), 'mj_iXNmXM');
  assert.equal(normalizeHelperOutput({ stdout: '' }), null);
  assert.equal(normalizeHelperOutput({ stderr: 'x' }), null);
  assert.equal(normalizeHelperOutput(null), null);
  assert.equal(normalizeHelperOutput(undefined), null);
  assert.equal(normalizeHelperOutput(42), null);

  // 端到端：run 收 {stdout} 形状（seam 若改回 promisify 语义也不该断）
  const got = await readGatewayPassword(22620, {
    helper: 'h',
    run: async () => ({ stdout: 'mj_iXNmXM', stderr: '' }),
  });
  assert.equal(got, 'mj_iXNmXM', '★ {stdout} 形状下必须仍能拿到口令');
});

test('readGatewayPassword：pid 非法 / 助手报错 ⇒ null（不抛，让调用方降级）', async () => {
  const deps = { helper: 'h', run: async () => 'x' };
  assert.equal(await readGatewayPassword(0, deps), null);
  assert.equal(await readGatewayPassword(-1, deps), null);
  assert.equal(await readGatewayPassword(1.5, deps), null);
  assert.equal(await readGatewayPassword(22620, { helper: 'h', run: async () => { throw new Error('denied'); } }), null);
});

test('readGatewayPassword：★ 助手的裸值不会再被当环境块重解析（曾经恒返回 null）', async () => {
  // 裸值里没有 '='，若再过 parseGatewayPassword 就必然是 null ⇒ 静默失效。
  const got = await readGatewayPassword(22620, { helper: 'h', run: async () => 'mj_iXNmXM' });
  assert.equal(got, 'mj_iXNmXM');
});

test('readGatewayPassword：助手混进诊断噪声 ⇒ null（诊断串含空格，口令不含）', async () => {
  assert.equal(await readGatewayPassword(22620, { helper: 'h', run: async () => 'read-sidecar-env: ...\n' }), null);
  assert.equal(await readGatewayPassword(22620, { helper: 'h', run: async () => `${GATEWAY_PASSWORD_ENV}=x` }), null, '整行 KEY=VALUE 也不接受');
  assert.equal(await readGatewayPassword(22620, { helper: 'h', run: async () => '  mj_iXNmXM  \n' }), 'mj_iXNmXM', '尾部换行要能吃掉');
  assert.equal(await readGatewayPassword(22620, { helper: 'h', run: async () => 'a b' }), null, '★ 含空白 ⇒ 拒绝');
  assert.equal(await readGatewayPassword(22620, { helper: 'h', run: async () => 'x'.repeat(600) }), null, '超长 ⇒ 拒绝');
});

// ── 缓存 ────────────────────────────────────────────────────────────────
const sidecar = { pid: 22620, startedAt: 1790555336298 };

test('★ 同一次 sidecar 生命周期只读一次（跨进程读内���很贵：实测 760–1310ms）', async () => {
  let n = 0;
  const p = createTokenProvider({ read: async () => { n += 1; return 'tok'; } });
  const sources = [];
  for (let i = 0; i < 5; i += 1) sources.push((await p.get(sidecar)).source);
  assert.equal(n, 1, '★ 读 5 次就是白付 4 次进程开销');
  assert.deepEqual(sources, ['read', 'cache', 'cache', 'cache', 'cache']);
  assert.equal(p.size, 1);
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

test('配置了 gatewayToken ⇒ 走配置（跨平台回退），且**不**进缓存', async () => {
  let readCalls = 0;
  const p = createTokenProvider({ read: async () => { readCalls += 1; return 'from-process'; }, configured: 'from-config' });
  const a = await p.get(sidecar);
  assert.deepEqual(a, { token: 'from-config', source: 'config' });
  assert.equal(readCalls, 0, '配了就别去读进程');
  assert.equal(p.size, 0, '★ 配置不进缓存：用户可能改配置，重启后要能生效');
  assert.equal((await p.get(sidecar)).source, 'config');
});

test('★ 读不到时抛错，且★ 错误信息里绝不含口令值', async () => {
  const p = createTokenProvider({ read: async () => null });
  await assert.rejects(() => p.get(sidecar), (e) => {
    assert.ok(!/null|undefined/.test(e.message), '★ 错误信息别把内部取值原样带出去');
    assert.match(e.message, /desktop|sign in|gatewayToken/i, '必须给出可执行的下一步');
    return true;
  });
  assert.equal(p.size, 0, '读失败不写缓存，否则会一直卡在失败态');
});

