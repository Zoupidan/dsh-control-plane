// ────────────────────────────────────────────────────────────────────────────
// 「那个进程还在不在」：exists 这个维度必须与 isSidecar 正交（2026-09-30 真机回归）
//
// ★ 这组用例防的是一个**已经真机发生过**的假归因，链路完整如下：
//
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
//
//   本组用例把 ②③④ 逐段钉住：枚举成功且 pid 不在表里 = **确定的否定答案**（`exists:false`），
//   必须被剔出候选池、必须报 `pid_gone`，且**不得**走到 token 那一步。
//
// ★ 反向的安全网同样重要：**枚举失败**时必须仍然 fail-open
//   （`exists:null`），否则提权运行的 sidecar 会被静默丢掉 —— 那是本仓反复强调的教训。
// ────────────────────────────────────────────────────────────────────────────

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createDispatcher } from '../src/host/gateway/dispatch.js';
import { createIdentityResolver } from '../src/host/gateway/identity.js';
import { summarizePool } from '../src/host/gateway/sidecar.js';

// 进程清单助手的真实输出形状：pid<TAB>name<TAB>commandLine（合成内容，不含任何凭据）。
const PROC_LIST = [
  '2464\tDeepSeek Harness.exe\tDeepSeek Harness.exe --serve',
  '4304\tTextInputHost.exe\tC:\\Windows\\System32\\TextInputHost.exe',
].join('\n');

/** 逐字取自真机的宿主托管 session 形状（`~/.codebuddy/sessions/*.json`）。 */
const RAW = {
  pid: 20868, lastHeartbeat: 1790573813000, sessionId: '01a0e65b-7f51-7796-bfa1-be54df9e7615',
  cwd: 'C:\\Users\\demo\\AppData\\Local\\Temp\\workbuddy-host-cli\\__workbuddy_cli_host__-0-eade4501',
  startedAt: 1790572292000, kind: 'interactive', url: 'http://127.0.0.1:18489',
  endpoint: 'http://127.0.0.1:18489', mode: 'local', version: '2.147.0', os: 'win32',
  arch: 'x64', hostname: '空腹蟲', updatedAt: 1790573813060,
};
const NOW = 1790573820000;

// ── exists 的三态 ────────────────────────────────────────────────────────────

test('★ 枚举成功 + pid 不在表里 ⇒ exists:false（确定的否定答案，不是"存疑"）', async () => {
  const resolve = createIdentityResolver({ run: async () => PROC_LIST });
  const got = await resolve([20868, 2464, 4304]);
  // 死进程：进程不存在。
  assert.equal(got.get(20868).exists, false, '枚举成功 ⇒ 不在表里就是"没了"，不是"没权限"');
  // 活着的进程：身份另说，但存在性是确定的。
  assert.equal(got.get(2464).exists, true);
  assert.equal(got.get(4304).exists, true);
  assert.equal(got.get(4304).isSidecar, false, '存在但不是 WorkBuddy 的 ⇒ 这是"pid 被回收"');
});

test('★★ 死进程的 isSidecar 必须是 null 而不是 false（否则会被误报成"pid 被回收"）', async () => {
  const resolve = createIdentityResolver({ run: async () => PROC_LIST });
  const got = await resolve([20868]);
  assert.equal(got.get(20868).isSidecar, null,
    'false = "那个号还在，但归别的程序了"；死进程是另一回事，两者的文案与处置都不同');
});

test('★ 枚举失败 ⇒ exists:null（fail-open 不许退化，提权 sidecar 一个都不能丢）', async () => {
  const resolve = createIdentityResolver({ run: async () => { throw new Error('EACCES'); } });
  const got = await resolve([20868, 2464]);
  for (const pid of [20868, 2464]) {
    assert.equal(got.get(pid).exists, null, '查询本身失败 ⇒ 什么都判不了');
    assert.equal(got.get(pid).isSidecar, null);
  }
});

test('把"不存在"和"被回收"混成同一种答案，会把处置引反（★ 反向锁）', async () => {
  const resolve = createIdentityResolver({ run: async () => PROC_LIST });
  const gone = await resolve([20868]);
  const recycled = await resolve([4304]);
  assert.notEqual(gone.get(20868).isSidecar, recycled.get(4304).isSidecar,
    '两者必须能被上层区分开，否则又回到"重启桌面端"那个解不好的处方');
});

// ── 端到端：死 pid 不得进入候选池，更不得走到 token 那一步 ──────────────────

/** 造一个 sessions 目录，里面放一条 pid 已死的记录。 */
function deadSessionDir() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-gone-'));
  writeFileSync(join(dir, '20868.json'), JSON.stringify(RAW));
  return dir;
}

test('★★ 端到端：死 pid 被剔出候选池，报 pid_gone —— 而不是 token_unavailable', async () => {
  const d = createDispatcher({
    sessionsDir: deadSessionDir(),
    // ★ 这一条就是真机的样子：`isPidAlive` 对一个已经没了的 pid 返 true（EPERM 假阳性）。
    isPidAlive: () => true,
    resolveIdentities: async () => new Map([[20868, { isSidecar: null, name: '', exists: false }]]),
    // 任何子进程出口都不该被碰：既不该去列端口（文件里已有 url），更不该去读进程内存。
    run: async () => { throw new Error('run 不该被调用'); },
    now: () => NOW,
  });
  const r = await d.inspect();
  assert.equal(r.picked, null, '死进程当然选不出来');
  assert.equal(r.candidates, 0, '★★ 它连候选都不该是候选（修前这里是 1）');
  assert.equal(r.unavailable?.code, 'pid_gone',
    '★★ 归因必须是"进程已经没了"，不是"取不到口令"（修前这里是 token_unavailable）');
});

test('★★ 死 pid 不得触发任何"去读进程环境块"的动作（假故障的源头）', async () => {
  let runCalls = 0;
  const d = createDispatcher({
    sessionsDir: deadSessionDir(),
    isPidAlive: () => true,
    resolveIdentities: async () => new Map([[20868, { isSidecar: null, name: '', exists: false }]]),
    // ★ 观察点选 `run` 而不是"配置里的 token 被读了几次"：
    //   `configuredToken()` 在构造期与 inspect 的展示字段里本来就会被调（dispatch.js:229/377），
    //   数它只能测出装配行为，测不出"有没有去读一个不存在的进程"。
    //   读进程环境块必须跑 assets/read-sidecar-env.ps1，也就是**必须**经过 `run`。
    run: async () => { runCalls += 1; throw new Error('run 不该被调用'); },
    gatewayToken: 'tok',
    now: () => NOW,
  });
  const r = await d.inspect();
  assert.equal(runCalls, 0,
    '被剔掉之前就不该去读那个进程的内存；读了一个不存在的进程，才编得出"权限不够"');
  assert.equal(r.unavailable?.code, 'pid_gone');
});

test('★ 老式解析器（只回 isSidecar、没有 exists）仍按"被回收"处理（向后兼容）', async () => {
  const d = createDispatcher({
    sessionsDir: deadSessionDir(),
    isPidAlive: () => true,
    // 旧形状：{ isSidecar: false, name } —— 没有 exists 字段。
    resolveIdentities: async () => new Map([[20868, { isSidecar: false, name: 'TextInputHost.exe' }]]),
    run: async () => { throw new Error('run 不该被调用'); },
    now: () => NOW,
  });
  const r = await d.inspect();
  assert.equal(r.unavailable?.code, 'pid_recycled',
    'isSidecar:false 仍然是"pid 归别人了"，不能被新的 gone 分支误吞');
});

test('★ 枚举失败时死 pid 仍进候选池（安全网：宁可多探一次，也别丢提权 sidecar）', async () => {
  const d = createDispatcher({
    sessionsDir: deadSessionDir(),
    isPidAlive: () => true,
    // 枚举抛错 ⇒ createIdentityResolver 本身会全标 exists:null。
    run: async () => { throw new Error('EACCES'); },
    gatewayToken: () => 'tok',
    fetchImpl: async () => ({ ok: false, status: 0 }),
    now: () => NOW,
  });
  const r = await d.inspect();
  assert.equal(r.candidates, 1, '查询失败 = 什么都判不了 ⇒ 放行（不得静默丢候选）');
  assert.notEqual(r.unavailable?.code, 'pid_gone', '判不了就不许下"进程没了"这个结论');
});

// ── 结论文案：不得再编造"权限不够"，也不得把人送去手动粘 token ──────────────

test('★ pid_gone 的文案：不许出现"权限不够"，也不许叫用户去粘 gatewayToken', () => {
  const r = summarizePool([], [], { gone: [{ pid: 20868 }] });
  assert.equal(r.code, 'pid_gone');
  assert.doesNotMatch(r.detail, /权限不够|同等或更高的权限|提权/,
    '本机非提权 shell 读 WorkBuddy 进程的环境块是成功的，读到的是"键不存在"');
  assert.doesNotMatch(r.detail, /填进插件设置|粘/,
    'AC-0：插件不得把"人手动粘 token"当成出路——此刻压根没有 sidecar 可用');
  assert.match(r.detail, /20868/, '要把那个 pid 点出来，否则用户无从判断是不是真有事');
});

test('★ token_unavailable 也不许把"权限不够"当成已证实的成因', () => {
  const r = summarizePool(
    [{ entry: { pid: 1 }, status: { busy: null, unavailable: 'token_unavailable' } }], [], {},
  );
  assert.equal(r.code, 'token_unavailable');
  assert.doesNotMatch(r.detail, /需要与 WorkBuddy 桌面端同等或更高的权限/,
    '这句是未经验证的归因；助手其实分得清"环境块读不到"与"键不在"，文案应当说这个');
});

test('★ 两个 code 的处置不同：gone 说"打开一次对话"，别把用户送去重启', () => {
  const gone = summarizePool([], [], { gone: [{ pid: 20868 }] });
  const recycled = summarizePool([], [], { recycled: [{ pid: 4304, name: 'TextInputHost.exe' }] });
  assert.notEqual(gone.code, recycled.code);
  assert.notEqual(gone.detail, recycled.detail);
});
