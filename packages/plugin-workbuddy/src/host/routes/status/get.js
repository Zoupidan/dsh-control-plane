/**
 * 从 lastRun 里取本次运行的 token 用量。
 *
 * ★ 为什么单独回传：CLI 的 result 帧把 `total_cost_usd` **写死 0**、usage 只装 token
 *   （实测 codebuddy-headless.js 三处构造点），且 `-p` 模式**不落盘** ⇒ 积分真值拿不到，
 *   token 是唯一能观测到的消耗代理。**没有它 ⇒ `null`（不是 0）**。
 *
 * @param {any} lastRun
 * @returns {object|null}
 */
function lastRunUsage(lastRun) {
  const u = lastRun?.usage;
  if (u === null || u === undefined || typeof u !== 'object') return null;
  const n = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const out = {
    inputTokens: n(u.inputTokens),
    outputTokens: n(u.outputTokens),
    cacheReadInputTokens: n(u.cacheReadInputTokens),
    cacheCreationInputTokens: n(u.cacheCreationInputTokens),
  };
  return Object.values(out).every((v) => v === null) ? null : out;
}

/**
 * GET <prefix>/status —— 状态 bridge（§3.4.1 之 ⑤；client 卡片与 `/` 命令消费）。
 *
 * Implements: 02-design/DESIGN-v3.md §3.5.1（bridgeGet(`${ROUTE_PREFIX}/status`)）/ §4.1.1（模型清单）/
 *             §4.4.1（三态）/ §4.4.3（在途作业数）/ §4.5（参数接受度字段）
 * 约束：本文件属于 packages/*​/src（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 *
 * 目录解析已抽出到 `launch/model-catalog.js`（T04：工具面 `workbuddy_status` 与本路由共用一份判定）。
 *
 * 返回载荷（稳定契约，T03 依赖）：
 *   { pluginId, registry, registrationError, probe, config{enabled,model,effort},
 *     effort{canonical,values}, models[], modelsSource, sessions[], inFlight, lastRun }
 *   ★ `effort{canonical,values}` 由 effortCapability() **单一来源**产出（工具面复用同一函数）。
 *   ★ `config.enabled` 只存在于**本路由**：GUI 需要它；模型可见的工具面（tools/status.js）不暴露该字段。
 *   ★ `models[]` = UI 目录（桌面产品配置缓存，含 `isFree` / `supportsReasoning` 标注）。
 */
import { isLoopback, isLoopbackHost } from '../loopback.js';
import { EFFORT_LEVELS, PLUGIN_ID, ROUTE_STATUS } from '../../../shared/constants.js';
import { disabledSnapshot, readCostCatalog } from '../../launch/cost-catalog.js';
import { desktopModels } from '../../launch/desktop-models.js';
import { readModelCatalog, detectionStateOf } from '../../launch/model-catalog.js';
import { currentAccountDetection } from '../../gateway/automation.js';
import { sessionSummary } from '../../session/map.js';

/**
 * 实时目录读取器**单例**（模块级，与 `live-credits` 同款）。
 *
 * ★ 必须是单例，不得每次请求 new 一个 ★
 * `projection()` 内部带 TTL 缓存与 in-flight 去重；每次 new ⇒ 缓存永远命中不了，
 * 每开一次卡片就打一次本机 IPC，且并发请求会各自起一条连接。单例才有"1 分钟最多读一次"。
 */
// ★ 用**共享单例**（2026-10-02 修正）：此前这里自己 createDesktopModels()，而工具面用的是
//   launch/desktop-models.js 导出的那个单例 —— 两份缓存 ⇒ 工具面那份永远冷，
//   于是「没人选模型时按倍率兜底」永远拿不到目录，实际不生效（真机实测 model=(sidecar default)）。
//   卡片与工具面必须是**同一份读数**，否则又会重现「卡片 x0.51 / 工具面 x0.16」那种分裂。

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/**
 * 仅 loopback 可读（R1-T03 安全裁定）：载荷含本机路径 / argv / stderr 摘录，
 * 若 dsh webserver 被配置为 `0.0.0.0`（webServer.Config 允许），裸 exact 路由不经 `/api` 网关鉴权
 * ⇒ 会对局域网暴露本机信息。此处 fail-closed：非 loopback / 无 socket 一律 403。
 *
 * ★ 2026-09-27：`isLoopback` / `isLoopbackHost` 的实现已**上移到 `routes/loopback.js`**，
 *   与凭据路由 `routes/auth.js` 共用同一份。两份实现各自演化时，其中一份漏掉 DNS-rebinding
 *   那一半（只判 socket 不判 Host）就是**静默放宽**，而静默放宽不会让任何测试变红。
 *   本文件从那里 import，本地副本已删除（下方 `isIP` import 随之不再需要）。
 */

/**
 * ★ 平台能力表（canonical 档位 → 平台取值）的**唯一构造点**。
 *
 * 为什么要有这个函数：工具面 `workbuddy_status` 与状态路由必须给出**一致**的档位结论，此前两处
 * 各写一遍同样的表达式，已经漂移出两处差异 ——
 *   ① 路由把 `config.launch.effortValues` 的**活引用**直接回传（调用方/序列化路径可能顺手改到 SSOT），
 *      工具面则做浅拷贝；
 *   ② 任何一侧改了判定口径（例如"空表算不算已知"），另一侧不会跟着改。
 * 两份实现 = 两份漂移机会，而 UI 的置灰判定直接吃这张表 ⇒ 漂移会变成**假状态**（U9）。
 * ⇒ 收口成一个纯函数，工具面从这里 import（见 tools/status.js）。因改动范围受限，暂落在本路由文件；
 *    更合适的落点是 `launch/`（与 T04 的 `model-catalog.js` 同款收口，理由见交付报告）。
 *
 * 语义（§4.2 / §4.6，**保持不变**）：
 *   - `canonical` = 7 档全量（含 `off`）—— "合法取值"的集合，**不代表平台支持**；
 *   - `values`   = 平台**真正支持**的子集；表内**无**该 key ⇒ 不支持（argv 不下发该 flag、UI 置灰）；
 *   - 取不到表 ⇒ 回传空表 `{}`：空表的含义是"**未知**"，由消费端（lib/client.js）负责
 *     不把它读成"全档不支持"（缺数据 ≠ 否定结论）。
 * 返回浅拷贝：不把 config（SSOT）的活引用泄漏给载荷 / JSON 序列化路径。
 *
 * @param {object|null|undefined} config 生效配置（`settings.get(ns)` 或 `runtime.currentConfig()`）
 * @returns {{ canonical: string[], values: Record<string, string> }}
 */
export function effortCapability(config) {
  const raw = config?.launch?.effortValues;
  // 只认"普通对象"：null / 非对象 / 数组（坏配置或手改过的 settings）一律落回空表 = 未知。
  // 为什么连数组也要挡：`{...['a']}` 会变成 `{0:'a'}` 这种**像表又不是表**的东西，
  // 消费端会拿它当能力表逐档判定 ⇒ 又一次假状态（不猜修复，只如实说"未知"）。
  const values = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
  return { canonical: [...EFFORT_LEVELS], values };
}

/**
 * 构造状态路由描述符（`{ kind, path, handler }` —— ctx.webServer.register 的入参形态；
 * 实证：`dsh-host-open-in-app/lib/index.js:1324-1335` 的 `{ kind: "exact", path, handler(req, res) }`）。
 *
 * @param {{ get?: (ns: string) => any }} settings settings 服务（`dsh-settings/lib/index.js:388`）
 * @param {object} runtime host SSOT
 * @param {string} ns settings namespace
 * @param {Record<string, string | undefined>} [env]
 * @param {{ list?: () => any[] }|null} [sessions] 会话映射（缺省 ⇒ `sessions: []`；位置参数追加、向后兼容）
 */
export function makeStatusRoute(settings, runtime, ns, env = process.env, sessions = null, credits = null) {
  return {
    kind: 'exact',
    path: ROUTE_STATUS,
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
      // ★ 0.1.7：原来的 `settings?.get?.(ns)` 分支已删——`settings.get` 在 0.1.7 整体移除
      //   （0.1.5 在 `dsh-settings/lib/index.js:388`；0.1.7 公共面见 `lib/types/index.d.ts:80-114`）。
      //   可选链让它恒为 undefined，是**死代码**：留着会让下一个人以为还有第二条读配置的路。
      const cfg = runtime.currentConfig() ?? {};
      const probe = runtime.detected();
      // ★ PRD-v4 §3 ①硬闸 / B1：关闭状态下"模型目录读取一律不发生"⇒ 目录都不读、列表给空。
      //   旧行为是"OFF 也读目录"——读盘虽无害，但①的语义是用户对"关了就是关了"的信任，
      //   不是性能优化；`modelsSource:'disabled'` 让 UI 能把"空"归因到"你关了它"。
      const enabled = cfg.enabled === true;
      const catalog = enabled
        ? readModelCatalog(probe, env, detectionStateOf(runtime))
        : { models: [], source: 'disabled', reason: null };
      const registry = runtime.registry();
      // ★ 成本面（PRD-v4 A2/A5）：与工具面同源（readCostCatalog 单一来源）；
      //   available 按注册态覆写——① 硬闸字段不许由读取器猜。
      //   home 缝合口：测试经 DSH_WB_COST_HOME 指向空目录 ⇒ 永远摸不到真实用户缓存。
      //   ★ ①硬闸（审查 BLOCKER#1）：OFF ⇒ 连成本目录也不读，用关断快照顶替。
      const cost = enabled
        ? readCostCatalog(null, env, { home: env.DSH_WB_COST_HOME || undefined })
        : { snapshot: disabledSnapshot(), source: 'disabled', reason: 'program-switch-off' };
      // ★★★ 实时目录优先（2026-10-02 实测缺陷修复）★★★
      // 落盘缓存是 `/v3/config` 的**产品级**快照：少 6 个桌面端实际能选的模型，且倍率是**过期**的
      // （倍率按账号+会话下发，还会随夜间折扣变动 —— 同一 `deepseek-v4-pro` 缓存写 x0.16、
      //  实时写 x0.51）。所以目录与倍率都必须取实时；读不到才回落缓存，并把来源如实标出去。
      // ★ ①硬闸仍然优先：`enabled !== true` ⇒ 实时读取**一律不发生**（连 IPC 都不发）。
      // ★ 冷启动这一次**等**它（`ensure()` 自带 5s 上限）—— 只用 `projection()` 的话，
      //   dsh 刚起时第一次请求会拿到 `available:false` 而回落到落盘缓存，用户第一次打开卡片
      //   看到的是**少 6 个模型、倍率还是旧的**那份目录，要第二次请求才对。实测就是这个顺序。
      const live = enabled ? await desktopModels.ensure() : null;
      const useLive = live !== null && live.available === true
        && Array.isArray(live.models) && live.models.length > 0;
      sendJson(res, 200, {
        pluginId: PLUGIN_ID,
        // B2 readonly diagnostic: settings namespace (= loader row id). Check this key in settings.yaml, not pluginId.
        ns,
        registry,
        // ★ C 组：注册失败（重名被占）的原因经此字段可见 —— 该情形下 registry 停在 DEGRADED 而
        //   `probe` 可能写着"已安装"，卡片必须能解释这对看似矛盾的值（否则它只会显示一个没有来由的降级）。
        registrationError: runtime.registrationError?.() ?? null,
        probe,
        // ★ `boundSessionId` 必须**可见**：它是"能不能下发"的唯一开关（见 gateway/dispatch.js
        //   的 no_bound_session 早退），而它不在 schema 的前三键白名单里。不回显的话，用户
        //   填没填、填对没填对，界面上一个信号都没有 —— 下发失败时只能去翻 profile YAML。
        //   只回显「绑没绑 + 末 8 位」：够定位，又不把整条 id 摊在状态接口上。
        bound: (() => {
          const id = typeof cfg.boundSessionId === 'string' ? cfg.boundSessionId.trim() : '';
          return { bound: id !== '', tail: id === '' ? null : id.slice(-8) };
        })(),
        config: { enabled: cfg.enabled === true, model: cfg.model ?? '', effort: cfg.effort ?? '' },
        effort: effortCapability(cfg),
        models: useLive ? live.models : catalog.models,
        modelsSource: useLive
          ? live.source
          : (catalog.reason === null ? catalog.source : `${catalog.source}:${catalog.reason}`),
        // ★ 成本快照（A2）：models[] 归一后的 ModelCostInfo + 整端未知态（A5）+ available（① 硬闸）。
        cost: useLive
          ? { ...live.cost, available: registry === 'REGISTERED' }
          : { ...cost.snapshot, available: registry === 'REGISTERED', source: cost.source, reason: cost.reason },
        // §5.1：会话映射（key → CLI session id）—— 让"继续会话"这件事在 UI 侧可见。
        sessions: sessionSummary(sessions),
        inFlight: runtime.inFlight(),
        lastRun: runtime.lastRun(),
        // ★ 只读账号确认面：插件识别到的现役账号 id 与证据来源。
        //   切号后这里应第一个翻到新账号；点火 owner 与之不符 ⇒ 调度器必然过滤。
        account: currentAccountDetection(),
        // ★★ 积分（2026-09-28 起为**真值直读**，不再由主理人手填）。
        //   同步投影 + 后台刷新：状态路由**不等**网络往返（读数含一次本机 IPC 往返）。
        //   三态（live / stale / unavailable）由 launch/live-credits.js 判，UI 照着画。
        credits: credits === null || typeof credits.projection !== 'function'
          ? null
          : credits.projection(),
        // ★ 本次运行的 token 用量（积分扣减的唯一可观测输入；`total_cost_usd` 在 CLI 侧写死 0）
        usage: lastRunUsage(runtime.lastRun()),
      });
    },
  };
}
