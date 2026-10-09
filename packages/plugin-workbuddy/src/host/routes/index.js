/**
 * 路由装配（§3.4.1 之 ⑤：`makeRoutes(settings, runtime, NS)` → 描述符数组）。
 *
 * 注册形态（实证：`dsh-host-open-in-app/lib/index.js:1324-1335`）：
 *   `ctx.webServer.register({ kind: 'exact'|'prefix', path, handler })` → 返回注销函数
 *   apply() 里包裹进 `ctx.effect(() => { ...d() })`，随插件卸载一并撤销。
 */
import { makeStatusRoute } from './status/get.js';
import { makeDiagnosticsRoute } from './diagnostics/get.js';

/**
 * @param {{ get?: (ns: string) => any }} settings
 * @param {object} runtime
 * @param {string} ns settings namespace
 * @param {{ list?: () => any[] }|null} [sessions] 会话映射（供状态载荷展示"可续接会话"）
 * @param {{ projection?: () => any }|null} [credits] 积分账（★ 2026-09-27；缺省 ⇒ 载荷里 credits:null）
 * @param {{ inspect?: () => Promise<object> }|null} [dispatch] 下发器（★ 2026-09-28）
 *   状态路由拿不到它 ⇒ `dispatch.inspect()` 长期**零调用点**：真机下发给两条空闲 sidecar 全部失败，
 *   而 dsh-web.log 里连 workbuddy 都没出现，成因不可见。诊断端点把它接出来。
 * @param {{ projection?: () => any }|null} [checkin] 每日签到（★ 2026-10-09；缺省 ⇒ 载荷里 checkin:null）
 * @returns {Array<{ kind: string, path: string, handler: (req: any, res: any) => Promise<void> }>}
 */
export function makeRoutes(settings, runtime, ns, sessions = null, credits = null, dispatch = null, checkin = null) {
  // `env` 用进程环境（目录读取器的 ①/② 源）；`sessions` 作为第 5 位置参数追加（向后兼容）。
  return [
    makeStatusRoute(settings, runtime, ns, process.env, sessions, credits, checkin),
    makeDiagnosticsRoute(dispatch),
  ];
}
