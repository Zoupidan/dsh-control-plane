/**
 * `GET /plugin-workbuddy/diagnostics` —— 下发链路的**只读**体检。
 *
 * <p>★★ 为什么单独开一个端点，而不是把结论塞进状态载荷：
 *   状态路由是 UI 的轮询路径，而 `inspect()` 每次都要**逐个候选读一次进程环境块**
 *   （本机实测 760–1310ms/次）再加 HTTP 探活。挂上去等于每轮轮询都拖一秒以上。
 *   而这条链的失败在日志里**一个字都没有**（实测 2026-09-28：下发给桌面端两条空闲
 *   sidecar，dsh-web.log 里连 workbuddy 都没有），于是"为什么发不出去"只能靠猜。
 *   单独一个端点 = 需要时查一次，不拖 UI。
 *
 * <p>★ 安全性：只做发现与探活，**不下发任何东西**（`inspect()` 语义即如此），
 *   且沿用 `isLoopback` + `isLoopbackHost` 双闸。
 *
 * <p>★ 缓存：`inspect()` 要读进程内存，**连续点会连着付 PEB 读的代价**，
 *   所以按 TTL 缓存（默认 15s，够用又不至于把跨进程读打满）。`?refresh=1` 强制重算。
 */
import { isLoopback, isLoopbackHost } from '../loopback.js';

export const ROUTE_DIAGNOSTICS = '/plugin-workbuddy/diagnostics';

/** ★ 15s：够挡住"连点几下"的连打，又短到不会拿到过期结论。 */
export const DIAGNOSTICS_TTL_MS = 15_000;

/**
 * 与 `status/get.js` 同形的小工具。**不复用那边的**：那是该文件内部的私有函数，
 * 跨文件 import 一个私有实现是在给"顺手改一个影响两处"埋雷；要共用就先把它提到
 * `routes/` 下再让两边都引，而不是在第二个调用点复制一份。
 *
 * @param {any} res
 * @param {number} status
 * @param {object} payload
 */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

/**
 * ★★ 载荷字段**显式白名单**，绝不 `{...body}` 透传。
 *
 *   这不是洁癖：透传意味着"**将来谁给 `inspect()` 加一个带凭据的字段，就会自动泄漏**"，
 *   而 `tools/ci/check-no-credential-echo.mjs` 扫的是代码里的 echo 模式，**扫不到运行时载荷**。
 *   也就是说透传版会在没有任何红线报警的情况下把口令发到 HTTP 响应里。
 *   真机证据（2026-09-28）：本端点第一版就是透传，测试里塞一个 `leakedToken` 立刻原样出现在
 *   响应体中——那个测试是当场把这个洞钉住的。
 *
 *   `configuredToken` 只回**存在性**（boolean），不回数值。
 */
const ALLOWED_FIELDS = [
  'candidates', 'hostManaged', 'resolved', 'autoToken', 'autoTokenReason', 'configuredToken',
];

/** 逐个字段重建，不保留其它任何键。 */
function project(body) {
  const out = {};
  for (const k of ALLOWED_FIELDS) {
    if (k in body) out[k] = body[k];
  }
  // `picked` / `unavailable` 是嵌套对象 ⇒ 白名单**要递归**，否则就等于没白名单。
  if (body.picked && typeof body.picked === 'object') {
    const p = body.picked;
    out.picked = { pid: Number(p.pid) || 0, url: typeof p.url === 'string' ? p.url : '' };
  } else {
    out.picked = null;
  }
  if (body.unavailable && typeof body.unavailable === 'object') {
    out.unavailable = {
      code: String(body.unavailable.code ?? 'unknown'),
      detail: typeof body.unavailable.detail === 'string' ? body.unavailable.detail : '',
    };
  } else {
    out.unavailable = null;
  }
  return out;
}

/**
 * @param {{ inspect?: () => Promise<object> }|null} dispatch 下发器（缺省 ⇒ 该端点如实说不可用）
 * @returns {{ kind: 'exact', path: string, handler: (req: any, res: any) => Promise<void> }}
 */
export function makeDiagnosticsRoute(dispatch = null, { ttlMs = DIAGNOSTICS_TTL_MS, now = Date.now } = {}) {
  let cached = null;      // { at: number, body: object }
  return {
    kind: 'exact',
    path: ROUTE_DIAGNOSTICS,
    handler: async (req, res) => {
      if (!isLoopback(req) || !isLoopbackHost(req)) {
        sendJson(res, 403, { error: 'loopback-only' });
        return;
      }
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('allow', 'GET');
        res.end();
        return;
      }
      if (dispatch === null || typeof dispatch.inspect !== 'function') {
        // ★ 如实说"没接上"，不要返回空对象冒充"体检通过"——空对象会被读成"一切正常"。
        sendJson(res, 200, { available: false, reason: 'dispatcher not wired' });
        return;
      }
      const force = String(req.query?.refresh ?? '') === '1';
      if (!force && cached !== null && now() - cached.at < ttlMs) {
        sendJson(res, 200, { ...cached.body, cached: true });
        return;
      }
      let raw;
      try {
        raw = await dispatch.inspect();
      } catch (e) {
        // ★ inspect 自己抛出来也算**结论**（比如 ports 解析崩了）。不能吞成 500：
        //   那样就退回"猜"的老路，而这正是本端点要消灭的状态。
        sendJson(res, 200, { available: true, inspectThrew: true, error: String(e?.message ?? e) });
        return;
      }
      const body = { available: true, ...project(raw ?? {}) };
      cached = { at: now(), body };
      sendJson(res, 200, { ...body, cached: false });
    },
  };
}
