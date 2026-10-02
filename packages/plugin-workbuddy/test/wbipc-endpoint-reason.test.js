/**
 * wbipc 端点不可用的**归因**契约（★ 2026-09-28 新增，2026-09-29 按实测重写）。
 *
 * <p>★ 要堵的是一个**假归因 + 内部细节泄漏**，不是崩溃。
 *
 * <p>实测（本机 2026-09-29）推翻了一版更早的猜测：Windows 上 `endpoint.json`
 * **是会写的**（桌面起来后确实落盘，`connectWbipc()` 能连上并读出 `remain=464.46`）。
 * 真缺陷在别处 —— 该文件在桌面退出时**不删**、重启时**滞后异步重写**，
 * 于是存在一个常态窗口：**文件在、端点已死**。
 *
 * <p>真机对照（同一个探针，只切换桌面开/关）：
 * <pre>
 *   桌面开着: ok=true  reasonCode=(none)      remain=464.46000077
 *   桌面关着: ok=false reasonCode=transport   connect ENOENT \\.\pipe\wbipc-5c76ec2b20365728
 * </pre>
 * `transport` 是没人知道该怎么办的黑话，而用户下一步明明是"把 WorkBuddy 打开"；
 * 那串 `\\.\pipe\wbipc-<16hex>` 更是本机内部实现细节，不该出现在用户界面上。
 *
 * <p>★★ 检测器自证：`classifyConnectFailure` 是纯函数、注入点明确，所以两个方向都能
 *   确定性测到；另有 `负向对照` 证明断言**真的会红**（死端点 vs 无关错码，结论必须反过来）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  connectWbipc, classifyConnectFailure, WBIPC_MISS, WbipcError,
} from '../src/host/gateway/wbipc.js';
import { createLiveCredits } from '../src/host/launch/live-credits.js';

/** 故意指向不存在的文件 —— 模拟"发现文件读不到"。 */
const MISSING = join(tmpdir(), 'dsh-no-such-wbipc-endpoint', 'endpoint.json');

test('死端点（ENOENT 等）⇒ 归因 ENDPOINT_GONE，且文案不得泄漏内部管道名', () => {
  // ★ 这是本文件的核心断言。`ENOENT` 是本机最常见的一种。
  const err = classifyConnectFailure(Object.assign(new Error('connect ENOENT \\\\.\\pipe\\wbipc-5c76ec2b20365728'), { code: 'ENOENT' }));
  assert.ok(err instanceof WbipcError, '必须翻成带归因码的 WbipcError');
  assert.equal(err.code, WBIPC_MISS.ENDPOINT_GONE);
  // ★ 文案里出现管道名 = 内部细节漏到用户面前。十六进制实例 id 尤其不能漏。
  assert.doesNotMatch(err.message, /wbipc-/i, '文案泄漏了 broker 实例 id');
  assert.doesNotMatch(err.message, /\\\\\.\\pipe/i, '文案泄漏了管道路径');
  assert.match(err.message, /WorkBuddy desktop/i, '文案必须给出可执行的下一步');
});

test('连接被拒的其它常见形态也归 ENDPOINT_GONE，不是 transport', () => {
  for (const code of ['ECONNREFUSED', 'EPIPE', 'ENOTCONN']) {
    assert.equal(classifyConnectFailure(Object.assign(new Error('x'), { code })).code, WBIPC_MISS.ENDPOINT_GONE,
      `${code} 应当并入 ENDPOINT_GONE`);
  }
});

test('★ 负向对照：与"端点无关"的错 ⇒ transport（这个检查必须能区分两类）', () => {
  const other = classifyConnectFailure(Object.assign(new Error('HMAC mismatch'), { code: 'EPROTO' }));
  assert.equal(other.code, 'transport', '协议类错误不得被误归成"桌面没开"');
  assert.notEqual(other.code, WBIPC_MISS.ENDPOINT_GONE);
});

test('connectWbipc：发现文件读不到 ⇒ DESKTOP_CLOSED，保留旧文案（别打断按文案分流的地方）', async () => {
  const err = await connectWbipc({ endpointFile: MISSING }).then(
    () => { throw new Error('本该抛出'); },
    (e) => e,
  );
  assert.ok(err instanceof WbipcError);
  assert.equal(err.code, WBIPC_MISS.DESKTOP_CLOSED);
  assert.match(err.message, /endpoint not found/i);
});

test('connectWbipc：端点文件在、管道已死 ⇒ ENDPOINT_GONE（复刻真机常态窗口）', async () => {
  // 造一个"存在但指向死管道"的 endpoint.json —— 这正是桌面退出后留在盘上的那个。
  const dir = join(tmpdir(), `dsh-wbipc-stale-${process.pid}`);
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'endpoint.json');
  writeFileSync(file, JSON.stringify({ endpoint: '\\\\.\\pipe\\wbipc-deadbeefdeadbeef', ticket: 't'.repeat(43) }));
  try {
    const err = await connectWbipc({ endpointFile: file }).then(
      () => { throw new Error('本该抛出'); },
      (e) => e,
    );
    assert.equal(err.code, WBIPC_MISS.ENDPOINT_GONE, '残留的死端点必须被认出来，而不是掉进 transport');
    assert.doesNotMatch(err.message, /deadbeef/i, '内部实例 id 漏进了文案');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('live-credits：死端点 ⇒ 归因 NO_DESKTOP，绝不是 transport（真机对照表的后半行）', async () => {
  const credits = createLiveCredits({
    ns: 'dsh-plugin-workbuddy',
    read: () => ({ creditsRuns: 0 }),
    connect: async () => { throw classifyConnectFailure(Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' })); },
  });
  const r = await credits.refresh();
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'workbuddy_desktop_closed');
  assert.notEqual(r.error.code, 'transport', '旧行为就在这里：连不上被归成 transport，用户不知道该干什么');
});

test('live-credits：协议类错误 ⇒ 仍归 transport（不许被"桌面没开"吞掉）', async () => {
  const credits = createLiveCredits({
    ns: 'dsh-plugin-workbuddy',
    read: () => ({ creditsRuns: 0 }),
    connect: async () => { throw classifyConnectFailure(Object.assign(new Error('wbipc handshake rejected: auth_failed'), { code: 'EPROTO' })); },
  });
  const r = await credits.refresh();
  assert.equal(r.error.code, 'transport');
});

test('live-credits：注入的 connect 抛旧式普通 Error ⇒ 兼容路径仍归因 NO_DESKTOP', async () => {
  const credits = createLiveCredits({
    ns: 'dsh-plugin-workbuddy',
    read: () => ({ creditsRuns: 0 }),
    connect: async () => { throw new Error('wbipc endpoint not found — is the WorkBuddy desktop running?'); },
  });
  const r = await credits.refresh();
  assert.equal(r.error.code, 'workbuddy_desktop_closed', '没带归因码时必须靠文案兜底，且不得回归成 transport');
});

test('live-credits：注入的 connect 抛无归因的杂错 ⇒ 归因 transport', async () => {
  const credits = createLiveCredits({
    ns: 'dsh-plugin-workbuddy',
    read: () => ({ creditsRuns: 0 }),
    connect: async () => { throw new Error('boom'); },
  });
  const r = await credits.refresh();
  assert.equal(r.error.code, 'transport');
});
