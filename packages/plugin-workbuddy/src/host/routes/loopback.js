/**
 * loopback + Host 栅栏（状态路由与凭据路由**共用一份**）。
 *
 * 为什么不共用就会漂：R1-T03 的安全裁定是"载荷含本机路径 / argv / 凭据摘录，只许 loopback 读"。
 * 两份实现一旦各自演化，其中一份漏掉 DNS-rebinding 那一半（只判 socket 不判 Host），
 * 就是**静默放宽**——而这类放宽不会让任何测试变红，只会让人以为它还安全着。
 *
 * 用 `isIP` 严格判定，不靠字符串前缀（防 `127.0.0.1.example.com` 之类的伪装）。
 * 覆盖 `127.0.0.0/8`（整段回环）、`::1`、以及 IPv4-mapped 形态（`::ffff:127.x`，Node 的常见渲染）。
 *
 * 约束：本文件属于 packages/*​/src（CI ② 扫描面）—— 不得出现裸进程出口字样。
 */
import { isIP } from 'node:net';

/**
 * 对端地址是否回环。
 * @param {any} req Node 的 IncomingMessage
 * @returns {boolean}
 */
export function isLoopback(req) {
  let remote = req?.socket?.remoteAddress;
  if (typeof remote !== 'string') return false;
  if (remote.startsWith('::ffff:')) remote = remote.slice('::ffff:'.length);
  if (isIP(remote) === 4) return remote.startsWith('127.');
  return isIP(remote) === 6 && remote === '::1';
}

/**
 * Host 头是否回环 authority（挡 DNS-rebinding：外部域名解析到 127.0.0.1 会让同源页读到本机信息）。
 * @param {any} req Node 的 IncomingMessage
 * @returns {boolean}
 */
export function isLoopbackHost(req) {
  const host = req?.headers?.host;
  if (typeof host !== 'string' || host === '') return false;
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
  if (hostname === 'localhost') return true;
  if (isIP(hostname) === 4) return hostname.startsWith('127.');
  return isIP(hostname) === 6 && hostname === '::1';
}

/**
 * 两道栅栏的合取。
 * @param {any} req
 * @returns {boolean}
 */
export function isTrustedRequest(req) {
  return isLoopback(req) && isLoopbackHost(req);
}
