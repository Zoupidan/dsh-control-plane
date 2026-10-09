/**
 * wbipc 通道：取积分用。
 *
 * <p>★ 这条路的价值在于**身份**：`http.fetch` 由**已登录的桌面端**代发，鉴权头由宿主填。
 * 也就是说插件借的是桌面端的登录态，而**不是**自己去持有 WorkBuddy 的账号凭据 ——
 * 这正是"积分获取 / 任务下发 / 任务验收"三条路里，积分这一条可以独立存在的原因。
 *
 * <p>★ 三个必须记住的协议点（每一个都是撞出来的）：
 * <ol>
 *   <li>握手是 **HMAC 双向证明**：服务端先自证（`session_challenge` → `session_prove`），
 *       对不上就断开。这一步是协议防"端点被抢占"的关键，不能跳过也不能只信客户端。</li>
 *   <li>通道**必须先经 `broker/GetPipe` 取出来**才能寻址，否则报
 *       `E_CHANNEL_UNKNOWN`，哪怕 `ListPipes` 里明明列着这个管道。
 *       `channel` 由服务端分配（实测 `wb.request` → `c:wb.request`），**不要硬编码**。</li>
 *   <li>通道调用必须带 `mode: 'call'`；body 只能走 `body_b64`（标准 base64，长度 %4==0）；
 *       GET/HEAD 带 body 会被协议拒。</li>
 * </ol>
 *
 * <p>★ 帧格式：`JSON.stringify(frame) + "\n"`，单帧上限 1 MiB。
 *
 * @module host/gateway/wbipc
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { readFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

import { BILLING_PATHS } from './credits.js';

const BROKER_GET_PIPE = 'broker/GetPipe';
const BROKER_LIST_PIPES = 'broker/ListPipes';
/** 桌面端唯一暴露的那条管道（真机枚举结果）。 */
export const REQUEST_PIPE = 'wb.request';

/** 单帧上限。超过就是对端不按协议说话，直接断。 */
const MAX_FRAME = 1024 * 1024;

/**
 * 端点不可用的**归因码**。
 *
 * <p>★ 机器可读，不是给人看的话。调用方要按码分流，不该去正则匹配错误文案 ——
 * 文案会被人改，而"为什么拿不到"是要直接透给用户的结论。
 */
export const WBIPC_MISS = {
  /**
   * 发现文件读不到。
   *
   * <p>真机观测（2026-09-29）：`endpoint.json` 在 Windows 上**是会写的** ——
   * 桌面跑起来后它确实落盘，且 `connectWbipc()` 能连上、读出 `remain=464.46`。
   * 所以这个码**只**在文件真的读不到时给，不能推广成"win32 上这条路不可用"。
   */
  DESKTOP_CLOSED: 'wbipc_desktop_closed',
  /**
   * ★ **端点在，但那个端点已经不在了**（本机最常见的一种）。
   *
   * <p>实测：`endpoint.json` 在桌面退出时**不删**，重新拉起时**滞后异步重写**。
   * 于是存在一个真实窗口 —— 文件在、端点已死：
   * <ul>
   *   <li>桌面被关掉 ⇒ 残留的 endpoint 指向一个已消失的命名管道 ⇒ `ENOENT`；</li>
   *   <li>桌面刚启动、broker 还没起来 ⇒ 文件里还是**上一个实例**的 endpoint ⇒ 同样 `ENOENT`。</li>
   * </ul>
   *
   * <p>旧代码把它归因成 `transport`，于是用户看到的是 `connect ENOENT \\.\pipe\wbipc-<id>`
   * 这种黑话外加**本机内部管道名**，完全不知道该做什么。而它和"桌面没开"是**同一件
   * 可执行的事**，应当并到同一个原因码。
   */
  ENDPOINT_GONE: 'wbipc_endpoint_gone',
};

/** 带归因码的错误。`code` 才是契约，`message` 只是给人看的。 */
export class WbipcError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'WbipcError';
    this.code = code;
  }
}

/** 连接被拒时的错码 —— 对应"端点没了"或"权限拒绝"而不是"协议说错了话"。 */
const DEAD_ENDPOINT_CODES = new Set(['ENOENT', 'ECONNREFUSED', 'EPIPE', 'ENOTCONN', 'EPERM', 'EACCES']);

/**
 * 把"连不上端点"翻译成归因码 + **干净**的文案。
 *
 * <p>★ 为什么必须重写文案：Node 的 ENOENT 消息里带着**完整的端点路径**
 * （`\\.\pipe\wbipc-<16hex>`）。那是本机内部实现细节，透给用户没有意义，
 * 还会让 UI 里出现一串没法解释的十六进制。
 *
 * @param {unknown} e
 * @returns {WbipcError}
 */
export function classifyConnectFailure(e) {
  const code = e && typeof e === 'object' ? e.code : undefined;
  if (DEAD_ENDPOINT_CODES.has(code)) {
    const isPerm = code === 'EPERM' || code === 'EACCES';
    return new WbipcError(
      isPerm
        ? 'the WorkBuddy desktop broker endpoint refused connection (EPERM / Access Denied) — '
          + 'please ensure WorkBuddy desktop is running normally without elevated UAC/Admin privileges, or restart it'
        : 'the WorkBuddy desktop broker endpoint no longer exists (it stops and is rewritten '
          + 'asynchronously as the desktop restarts) — open the WorkBuddy desktop',
      WBIPC_MISS.ENDPOINT_GONE,
    );
  }
  return new WbipcError(e instanceof Error ? e.message : String(e), 'transport');
}

/**
 * 读端点描述。
 *
 * @param {string} [file] 覆盖用（测试）；默认 `~/.workbuddy/wbipc/endpoint.json`
 * @returns {Promise<{endpoint: string, ticket: string, ticketId: string}|null>}
 *   ★ 桌面端没开 ⇒ 文件不存在 ⇒ 返回 null，**不抛**。上层据此说"请打开 WorkBuddy"，
 *   而不是甩一个 ENOENT 堆栈。
 */
export async function readEndpoint(file = join(homedir(), '.workbuddy', 'wbipc', 'endpoint.json')) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  let desc;
  try { desc = JSON.parse(raw); } catch { return null; }
  const endpoint = typeof desc?.endpoint === 'string' ? desc.endpoint : null;
  const ticket = typeof desc?.ticket === 'string' ? desc.ticket : null;
  if (endpoint === null || ticket === null || endpoint === '') return null;
  // ★ ticket 是本机凭据：对外只用它的 SHA256 前 16 位，绝不回显本身。
  return { endpoint, ticket, ticketId: createHash('sha256').update(ticket, 'utf8').digest('hex').slice(0, 16) };
}

/**
 * 建一条已鉴权的 wbipc 会话。
 *
 * @param {{timeoutMs?: number, endpointFile?: string, connectImpl?: typeof connect}} [opts]
 * @returns {Promise<{info: object, call: (method: string, params?: unknown, mode?: string) => Promise<any>,
 *   httpFetch: (req: {path: string, method?: string, json?: unknown}) => Promise<{status: number|null, json: object|null, text: string|null}>,
 *   close: () => void}>}
 */
export async function connectWbipc({ timeoutMs = 15000, endpointFile, connectImpl = connect } = {}) {
  const desc = await readEndpoint(endpointFile);
  if (desc === null) {
    // 文件读不到：保留旧文案（含 "endpoint not found"），免得按文案分流的地方被打断。
    throw new WbipcError('wbipc endpoint not found — is the WorkBuddy desktop running?', WBIPC_MISS.DESKTOP_CLOSED);
  }
  const { endpoint, ticket, ticketId } = desc;

  /** 4 字节 BE 长度前缀 + 内容，HMAC 的转录本。 */
  function transcript(role, t) {
    const parts = [role === 'server' ? 'wbipc-s' : 'wbipc-c', String(t.protocol), t.endpoint, t.clientNonce, t.serverNonce];
    const chunks = [];
    for (const p of parts) {
      const b = Buffer.from(p, 'utf8');
      const len = Buffer.alloc(4);
      len.writeUInt32BE(b.length, 0);
      chunks.push(len, b);
    }
    return Buffer.concat(chunks);
  }
  const proof = (role, t) => createHmac('sha256', Buffer.from(ticket, 'utf8')).update(transcript(role, t)).digest('base64url');

  const clientNonce = randomBytes(16).toString('base64url');
  const sock = connectImpl(endpoint);
  const waiters = new Map();
  const info = { endpoint, ticketId, epoch: null, maxInflight: null, serverPipes: [] };
  let buf = Buffer.alloc(0);
  let nextId = 1;

  let settle;
  let fail;
  const readyPromise = new Promise((res, rej) => { settle = res; fail = rej; });
  const deadline = setTimeout(() => { fail(new Error('wbipc handshake timed out')); sock.destroy(); }, timeoutMs);

  const send = (obj) => sock.write(`${JSON.stringify(obj)}\n`);

  sock.on('connect', () => send({
    type: 'session_hello', protocol_min: 1, protocol_max: 1, client_nonce: clientNonce, ticket_id: ticketId,
  }));

  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (buf.length > MAX_FRAME) { fail(new Error('wbipc frame exceeded 1 MiB — dropping the connection')); sock.destroy(); return; }
    for (;;) {
      const nl = buf.indexOf(10);
      if (nl < 0) break;
      const line = buf.subarray(0, nl).toString('utf8');
      buf = buf.subarray(nl + 1);
      if (line === '') continue;
      let f;
      try { f = JSON.parse(line); } catch { continue; }

      if (f.type === 'session_challenge') {
        const t = { protocol: Number(f.protocol) || 1, endpoint, clientNonce, serverNonce: String(f.server_nonce ?? '') };
        // ★ 服务端必须先自证；对不上就断开。
        if (String(f.server_proof ?? '') !== proof('server', t)) {
          clearTimeout(deadline); fail(new Error('server proof mismatch — the endpoint is not trustworthy')); sock.destroy(); return;
        }
        send({ type: 'session_prove', client_proof: proof('client', t) });
        continue;
      }
      if (f.type === 'session_hello_ack') {
        info.epoch = f.connection_epoch ?? null;
        info.maxInflight = f.max_inflight ?? null;
        info.serverPipes = Array.isArray(f.pipes) ? f.pipes : [];
        clearTimeout(deadline);
        settle();
        continue;
      }
      if (f.type === 'session_hello_error') {
        clearTimeout(deadline); fail(new Error(`wbipc handshake rejected: ${f.code}`)); sock.destroy(); return;
      }
      if (f.id !== undefined && waiters.has(f.id)) {
        const { resolve, reject } = waiters.get(f.id);
        waiters.delete(f.id);
        if (f.error) reject(new Error(`wbipc rpc error: ${f.error.code ?? ''} ${f.error.message ?? ''}`.trim()));
        else resolve(f.result ?? f.params ?? null);
      }
    }
  });
  sock.on('error', (e) => {
    clearTimeout(deadline);
    // ★ 这里才归因。桌面退出/重启会留下一个**指向已消失管道**的残留 endpoint
    //   （实测：endpoint.json 退出时不删、重启时滞后重写），所以"连不上"是常态之一，
    //   必须翻成可执行的原因，而不是把 `connect ENOENT \\.\pipe\wbipc-<16hex>` 原样透出去。
    fail(classifyConnectFailure(e));
  });
  await readyPromise;

  function call(method, params, mode) {
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { waiters.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      waiters.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      send({ id, method, ...(params === undefined ? {} : { params }), ...(mode === undefined ? {} : { mode }) });
    });
  }

  // ★ 必须先经 broker/GetPipe 认领，通道才可寻址。漏这步 ⇒ E_CHANNEL_UNKNOWN。
  let claimed = null;
  async function resolveChannel(pipe = REQUEST_PIPE) {
    if (claimed === null) {
      const got = await call(BROKER_GET_PIPE, { pipe });
      if (typeof got?.channel !== 'string' || got.channel === '') throw new Error(`${BROKER_GET_PIPE}(${pipe}) returned no channel`);
      claimed = { pipe, channel: got.channel, methods: got.methods ?? [] };
    }
    return claimed;
  }

  /**
   * 以**桌面端已登录的身份**发一个只读 HTTP 请求。
   *
   * ★ 调用方指定不了 host（协议如此），鉴权头由宿主填 ⇒ 凭证不出这个进程。
   */
  async function httpFetch({ path, method = 'GET', json }) {
    const { channel } = await resolveChannel();
    const params = { path, method };
    if (json !== undefined) {
      params.body_b64 = Buffer.from(JSON.stringify(json), 'utf8').toString('base64');
      params.headers = { 'content-type': 'application/json' };
    }
    const r = await call(`${channel}/http.fetch`, params, 'call');
    const text = r?.body_b64 === undefined ? null : Buffer.from(r.body_b64, 'base64').toString('utf8');
    let parsed = null;
    try { parsed = text === null ? null : JSON.parse(text); } catch { parsed = null; }
    return { status: r?.status ?? null, json: parsed, text };
  }

  return { info, call, resolveChannel, httpFetch, close: () => sock.destroy() };
}

/** 列管道（诊断用；取积分不需要）。 */
export const listPipes = (s) => s.call(BROKER_LIST_PIPES);

export { BILLING_PATHS };
