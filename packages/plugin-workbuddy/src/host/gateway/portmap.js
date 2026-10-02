/**
 * 端点反查：session 文件里**没有 `url`** 时，按 pid 从 OS 端口表反查本机 HTTP 端点。
 *
 * <p>★★ 为什么需要这个模块（2026-09-28，WorkBuddy 5.6.2 实测）★★
 *
 * <p>老版本桌面端写进 `~/.workbuddy/sessions/<pid>.json` 的条目带
 * `"url": "http://127.0.0.1:65252"`，插件据此就能连上本机网关。
 *
 * <p>5.6.2 拉起的条目**不再有 `url` 字段**（真机两条活着的条目全文如下）：
 *
 * <pre>
 * { pid: 39896, kind: "prewarm",    cwd: "C:\Program Files\WorkBuddy",
 *   meta: { socketPath: "\\.\pipe\codebuddy-prewarm-…", status: "idle" } }
 * { pid: 26080, kind: "interactive", sessionId: "509eeb5e-…",
 *   cwd: "D:\Box\交易知识库\agenttrading" }
 * </pre>
 *
 * <p>但**网关并没有消失**：pid 26080 仍在 `127.0.0.1:53349` 上 LISTENING，
 * `GET /api/v1/status` 返回 `{"busy":false}`，PEB 读出的 43 字符口令直接可用。
 * 端点只是**不再被写进 session 文件**了 —— 全盘搜索 `.workbuddy` 下的 JSON，
 * 没有任何一个文件包含 `53349`。
 *
 * <p>⇒ 端点只能从 OS 端口表反查。这是纯查询，不读别的进程内存，杀软不会因此报警
 *   （与 {@link module:host/gateway/token} 的 PEB 读环境是两种风险量级）。
 *
 * @module host/gateway/portmap
 */

/** 可以接受的本机绑定地址。★ 只连 `127.0.0.1`，`0.0.0.0`/`::` 视为本机通配绑定。 */
const LOCAL_BINDS = new Set(['127.0.0.1', '0.0.0.0', '::1', '::', 'localhost']);

/** 端口缓存有效期。进程不变则端口不变，但 pid 会被系统回收复用，所以留个短 TTL。 */
export const PORT_TTL_MS = 60_000;

/**
 * 拆 `host:port`，容忍 IPv6 的方括号。
 *
 * @param {string} s
 * @returns {{host: string, port: number}|null}
 */
function splitHostPort(s) {
  const i = s.lastIndexOf(':');
  if (i < 0) return null;
  const host = s.slice(0, i).replace(/^\[/, '').replace(/\]$/, '');
  const port = Number(s.slice(i + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

/**
 * 解析 `netstat -ano -p tcp` 的输出，取该 pid 在**本机**上的监听端口。
 *
 * <p>★ 只认 `LISTENING`：`ESTABLISHED` 那几行是**别的进程**连到本机服务上的连接，
 *   拿它们当端点会连到一个正在服务的第三方端口上 —— 纯逻辑错误，且很难查。
 *
 * @param {string} text
 * @param {number} pid
 * @returns {number[]} 升序、去重
 */
export function parseNetstat(text, pid) {
  const out = [];
  if (typeof text !== 'string') return out;
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0] !== 'TCP') continue;
    // TCP 行固定为 `TCP <本地> <远端> <状态> <pid>`；UDP 行没有状态列，长度对不上。
    if (cols[3] !== 'LISTENING') continue;
    if (Number(cols[4]) !== pid) continue;
    const hp = splitHostPort(cols[1]);
    if (hp !== null && LOCAL_BINDS.has(hp.host)) out.push(hp.port);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * 解析 `lsof -nP -iTCP -sTCP:LISTEN -a -p <pid>` 的输出（Linux/macOS）。
 *
 * @param {string} text
 * @param {number} pid
 * @returns {number[]} 升序、去重
 */
export function parseLsof(text, pid) {
  const out = [];
  if (typeof text !== 'string') return out;
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    // 表头与 COMMAND 无关的行直接排除；pid 是第 2 列。
    if (cols.length < 2 || Number(cols[1]) !== pid) continue;
    const m = line.match(/TCP\s+(\S+)\s+\(LISTEN\)/);
    if (m === null) continue;
    const hp = splitHostPort(m[1]);
    if (hp !== null && LOCAL_BINDS.has(hp.host)) out.push(hp.port);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * 建一个带缓存的端口反查器。
 *
 * <p>★ 进程出口只有注入的 `run`，本模块**自己不起任何进程**（R3-7 ②）。
 *   `run` 必须由调用方接到 `ctx.subprocess.spawn`。
 *
 * @param {{run?: (spec: {argv: string[]}) => Promise<string>, platform?: string,
 *   now?: () => number, ttlMs?: number}} [deps]
 * @returns {(pid: number) => Promise<number[]>} 该 pid 的本机监听端口（可能为空数组）
 */
export function createPortResolver(deps = {}) {
  const { run, platform = process.platform, now = Date.now, ttlMs = PORT_TTL_MS } = deps;
  /** @type {Map<number, {at: number, ports: number[]}>} */
  const cache = new Map();

  return async function resolvePorts(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return [];
    if (typeof run !== 'function') return [];   // 没注入进程出口 ⇒ 查不了，安静降级
    const hit = cache.get(pid);
    if (hit !== undefined && now() - hit.at < ttlMs) return hit.ports;

    const spec = platform === 'win32'
      ? { argv: ['netstat', '-ano', '-p', 'tcp'] }
      : { argv: ['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid)] };

    let ports = [];
    try {
      const text = await run(spec);
      ports = platform === 'win32' ? parseNetstat(text, pid) : parseLsof(text, pid);
    } catch {
      ports = [];   // netstat/lsof 不可用或超时 ⇒ 当作"查不到"，让调用方走别的路
    }
    cache.set(pid, { at: now(), ports });
    return ports;
  };
}
