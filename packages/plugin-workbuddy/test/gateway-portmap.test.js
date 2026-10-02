// 端点反查：session 文件里没有 `url` 时，按 pid 从 OS 端口表反查本机 HTTP 端点。
//
// ★ fixture 是本机 `netstat -ano -p tcp` 的**逐字**输出形状，pid/端口取自 2026-09-28
//   的真机实测（26080 在 53349 上监听，而它的 session 文件里没有 url）。
import assert from 'node:assert/strict';
import test from 'node:test';

import { createPortResolver, parseLsof, parseNetstat } from '../src/host/gateway/portmap.js';
import { resolveSidecarEndpoints, probeEntry, probeStatus, parseSessionEntry } from '../src/host/gateway/sidecar.js';

const NOW = 1790580258937;

/** 真机 netstat 形状。★ 故意混入 UDP、别的 pid、以及 ESTABLISHED 行当负控。 */
const NETSTAT = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    127.0.0.1:53349        0.0.0.0:0              LISTENING       26080',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1084',
  '  TCP    127.0.0.1:53349        127.0.0.1:51234        ESTABLISHED     26080',
  '  TCP    127.0.0.1:53349        127.0.0.1:51235        ESTABLISHED     26080',
  // ★ 这一行的**本地**端口是 53350，不是 53349。写负控时踩过一次：上面两条的本地端口
  //   与 LISTENING 那行相同，混进来也被 set 去重吃掉，于是"去掉 LISTENING 过滤"这个
  //   变异**测不出来**。负控要能真的让结果变化，否则它只是装饰。
  '  TCP    127.0.0.1:53350        127.0.0.1:51236        ESTABLISHED     26080',
  '  UDP    0.0.0.0:5353           *:*                                    3000',
  '  TCP    [::]:445               [::]:0                 LISTENING       4',
  '  TCP    192.168.1.5:8080       0.0.0.0:0              LISTENING       7',
  '',
].join('\r\n');

const LSOF = [
  'COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
  'node    26080 demo   20u  IPv4 123456      0t0   TCP 127.0.0.1:53349 (LISTEN)',
  'node    26080 demo   21u  IPv6 123456      0t0   TCP [::1]:53350 (LISTEN)',
  'node    12345 demo   22u  IPv4 123456      0t0   TCP 127.0.0.1:9999 (LISTEN)',
  'node    12345 demo   23u  IPv4 123456      0t0   TCP 127.0.0.1:9998 (LISTEN)',
  '',
].join('\n');

test('parseNetstat：只取该 pid 的 LISTENING 行', () => {
  assert.deepEqual(parseNetstat(NETSTAT, 26080), [53349]);
  // 负控①：ESTABLISHED 那几行 pid 也是 26080 —— 它们是"别人连到它上面"，
  //  当成端点会连到一个正在服务的第三方端口上（本地端口 53350 就是反例）。
  assert.equal(parseNetstat(NETSTAT, 26080).includes(53350), false);
  // 负控②：别的 pid 的 LISTENING 行。
  assert.deepEqual(parseNetstat(NETSTAT, 1084), [135]);
  // 负控③：UDP 没有状态列，长度对不上，不能被误当成 TCP。
  assert.deepEqual(parseNetstat(NETSTAT, 3000), []);
  // `[::]` 和 `0.0.0.0` 一样是**本机通配绑定**，要认（真机 26080 就是这类）。
  assert.deepEqual(parseNetstat(NETSTAT, 4), [445], 'IPv6 通配绑定也是本机');
  // 负控④：绑在局域网地址上的监听**不能**要 —— 我们只连 loopback，
  // 拿一个 `192.168.x.x` 的端口当端点等于往局域网上发探测请求。
  assert.deepEqual(parseNetstat(NETSTAT, 7), [], '★ 非本机绑定一律排除');
});

test('parseLsof：只取该 pid 的 (LISTEN) 行，IPv6 方括号要能拆', () => {
  assert.deepEqual(parseLsof(LSOF, 26080), [53349, 53350]);
  // 负控：别的 pid 的监听端口。
  assert.deepEqual(parseLsof(LSOF, 12345), [9998, 9999]);
});

test('createPortResolver：结果按 pid 缓存，TTL 内不再起进程', async () => {
  let calls = 0;
  const resolve = createPortResolver({
    platform: 'win32',
    now: () => NOW,
    run: async () => { calls += 1; return NETSTAT; },
  });
  assert.deepEqual(await resolve(26080), [53349]);
  assert.deepEqual(await resolve(26080), [53349]);
  assert.equal(calls, 1, '★ 同一次 dispatch 里不该反复起 netstat');

  // 负控：TTL 过了要重新查。
  const t0 = NOW;
  const resolve2 = createPortResolver({
    platform: 'win32',
    now: () => t0 + 120_000,
    run: async () => { calls += 1; return NETSTAT; },
  });
  await resolve2(26080);
  assert.equal(calls, 2);
});

test('createPortResolver：进程出口不可用时安静降级，不抛', async () => {
  const noRun = createPortResolver({ platform: 'win32' });
  assert.deepEqual(await noRun(26080), [], '★ 没注入 run ⇒ 查不到，而不是崩在装配期');

  const throwing = createPortResolver({ platform: 'win32', run: async () => { throw new Error('netstat not found'); } });
  assert.deepEqual(await throwing(26080), [], '★ netstat 不可用 ⇒ 当查不到，让调用方走别的路');
});

test('resolveSidecarEndpoints：缺 url 的按 pid 补端点，多端口留 altUrls', async () => {
  const e = parseSessionEntry({ pid: 26080, kind: 'interactive', cwd: 'D:\\Box\\x' }, NOW);
  const [one] = await resolveSidecarEndpoints([e], { resolvePorts: async () => [53349] });
  assert.equal(one.url, 'http://127.0.0.1:53349');
  assert.deepEqual(one.altUrls, []);

  const [multi] = await resolveSidecarEndpoints([e], { resolvePorts: async () => [53349, 53350] });
  assert.equal(multi.url, 'http://127.0.0.1:53349');
  assert.deepEqual(multi.altUrls, ['http://127.0.0.1:53350'], '★ 第二个监听端口不能丢');

  // 负控①：查不到端口 ⇒ 仍然是"没有端点"，不能编一个出来。
  const [none] = await resolveSidecarEndpoints([e], { resolvePorts: async () => [] });
  assert.equal(none.url, null);

  // 负控②：已有 url 的**不查**（省掉一次 netstat）。
  const has = parseSessionEntry({ pid: 22620, url: 'http://127.0.0.1:65252' }, NOW);
  let asked = 0;
  const [kept] = await resolveSidecarEndpoints([has], { resolvePorts: async () => { asked += 1; return [1]; } });
  assert.equal(kept.url, 'http://127.0.0.1:65252');
  assert.equal(asked, 0);

  // 负控③：反查抛异常不能整轮失败。
  const [safe] = await resolveSidecarEndpoints([e], { resolvePorts: async () => { throw new Error('boom'); } });
  assert.equal(safe.url, null);
});

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

test('probeStatus：全都不通 ⇒ null（不可用），不是抛', async () => {
  const dead = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal(await probeStatus('http://127.0.0.1:1', dead, 'tok'), null);
  // 负控：探到了但没有 busy 字段 ⇒ null（"未知 ≠ 空闲"）。
  const noBusy = async () => ({ ok: true, json: async () => ({ data: {} }) });
  assert.equal(await probeStatus('http://127.0.0.1:1', noBusy, 'tok'), null);
});
