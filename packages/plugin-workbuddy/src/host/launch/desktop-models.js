/**
 * @file 桌面端**实时**模型目录 —— 下拉框的真源。
 *
 * <p>★★★ 为什么落盘缓存不能当目录的权威来源（这是实测缺陷，不是设计偏好）★★★
 * 落盘的 `~/.workbuddy/cache/acc-product-config-v3.json` 是 `/v3/config` 的**产品级**快照：
 *   · 它**少 6 个**桌面端实际能选的模型 —— `hy3-x` / `glm-5.3` / `glm-5.3-flash` /
 *     `deepseek-v4.1-flash` / `hy4-preview` / `kimi-k2.8-preview`；
 *   · 它的**倍率是过期的**：同一个 `deepseek-v4-pro`，缓存写 `x0.16`，实时接口写 `x0.51`。
 * 而倍率本身是**账号 + 会话级**的（服务端按账号下发），产品级快照按定义就承载不了它。
 * ⇒ 目录与倍率**必须**取实时接口；落盘缓存只当"桌面端没开 / 实时读失败"时的兜底。
 *
 * <p>★ 数据源（实测 200，26 609 B）★
 *   `GET /v2/enterprises/personal/models` —— 经 wbipc 只读通道以**桌面端已登录的身份**发。
 *   ★ 这个端点**不需要**自定义 header（`tmp/recon-personal-models.mjs:31` 空 headers 拿到 200）；
 *   需要 UA 的那个是 `/v3/config`（空 header 恒回 `12403 check ua`）。两者别混。
 *
 * <p>★ "哪些算模型" ★
 *   响应里有两处清单，含义不同，必须分开：
 *   · `data.models[]` = 产品目录（30 条，含 `hunyuan-image-alpha` 这类非文本模型与
 *     `hunyuan-chat` 这类无倍率项）—— 是**商品清单**，不是"这个 agent 能跑什么"。
 *   · `data.agents[name=cli].models[]` = **CLI/桌面 agent 真正能下发的 id**（16 条）——
 *     这才是"下拉框该列什么"的答案。
 *   取后者；它缺失时才退回前者（并如实标 source，前端与人都知道降级了）。
 *   `auto` 留在列表里：它是**一种选择方式**（桌面端自选），不是模型，但确实可选、可下发。
 *   桌面端的 `fast-model` / `balanced-model` / `deep-model`（极致/均衡/快速）同理 ——
 *   它们是 AUTO 分层，**不在**本接口的清单里，插件也**不得**把它们当模型列出去。
 *
 * <p>★ 绝不抛 ★
 *   取不到就返回 `available:false` + 归因码，由调用方回落到落盘缓存。状态路由**永不**因它失败。
 *
 * @module host/launch/desktop-models
 */

import { connectWbipc, WBIPC_MISS } from '../gateway/wbipc.js';
import { parseCreditsFactor } from './cost-catalog.js';

/** 实时目录端点。 */
export const LIVE_MODELS_PATH = '/v2/enterprises/personal/models';

/** TTL 与积分面同款（60s）：目录是慢变量，1 分钟足够新，又不至于每次开卡片都打一次 IPC。 */
export const MODELS_TTL_MS = 60_000;

/** 取不到时的归因码。语义与 `live-credits.js` 对齐：告诉用户下一步该做什么。 */
export const REASONS = {
  NO_DESKTOP: 'workbuddy_desktop_closed',
  SHAPE: 'unexpected_response',
  UNAVAILABLE: 'catalog_unavailable',
  /** 测试进程里刻意不联机（见 `createDesktopModels` 的 fail-closed）。 */
  SKIPPED_IN_TEST: 'skipped_in_test_process',
};

/** @returns {string} 便于 `modelsSource` 落进 payload 让人一眼看出用的是哪条路。 */
export const LIVE_SOURCE = `desktop-live:${LIVE_MODELS_PATH}`;

/**
 * 把实时响应拆成两支平行数组（展示目录 / 倍率目录），形状与落盘路径**逐字一致** ——
 * 客户端 `buildModelOptions(models, costModels)` 因此不需要知道自己读的是哪条路。
 *
 * @param {any} json `/v2/enterprises/personal/models` 的已解析响应
 * @param {number} observedAt
 * @returns {{models: object[], cost: object[], degraded: boolean}|null} 形状不认识时返回 `null`
 */
export function parseLiveCatalog(json, observedAt = Date.now()) {
  const data = json?.data ?? null;
  if (data === null || typeof data !== 'object') return null;
  const all = Array.isArray(data.models) ? data.models : null;
  if (all === null) return null;

  /** @type {Map<string, any>} */
  const byId = new Map();
  for (const m of all) {
    if (m !== null && typeof m === 'object' && typeof m.id === 'string' && m.id !== '') byId.set(m.id, m);
  }
  if (byId.size === 0) return null;

  const agents = Array.isArray(data.agents) ? data.agents : [];
  const cli = agents.find((a) => a !== null && typeof a === 'object' && a.name === 'cli');
  const agentIds = (Array.isArray(cli?.models) ? cli.models : [])
    .filter((v) => typeof v === 'string' && v !== '');
  // ★ 降级路径：agent 清单缺失/为空 ⇒ 用产品目录顶上，但**必须**让调用方知道降级了。
  const useIds = agentIds.length > 0 ? agentIds : [...byId.keys()];
  const degraded = agentIds.length === 0;

  const models = [];
  const cost = [];
  const seen = new Set();
  /** @type {Array<{id: string, m: any}>} */
  const picked = [];
  for (const id of useIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    picked.push({ id, m: byId.get(id) ?? null });
  }

  // ★★ 显示名去重（实测缺陷）★★
  //   桌面端给的 `name` **不是**唯一的：`hy3` 与 `hy3-x` 都叫 `Hy3`（`hy4-preview` 与
  //   `hy4-preview-x` 同理）。只印名字 ⇒ 下拉框里两行长得一模一样，用户无从分辨，
  //   选错一个就是"下发了别的模型"，而界面上看不出任何差别。
  //   ⇒ 只在**真的撞名**时补 id（`Hy3（hy3-x）`），其余保持干净名字。
  //   不采取"每行都印 id"：那会让 15 行全部变长，噪音大于收益。
  const nameCount = new Map();
  for (const { id, m } of picked) {
    const raw = typeof m?.name === 'string' && m.name !== '' ? m.name : id;
    nameCount.set(raw, (nameCount.get(raw) ?? 0) + 1);
  }

  for (const { id, m } of picked) {
    const raw = typeof m?.name === 'string' && m.name !== '' ? m.name : id;
    const label = (nameCount.get(raw) ?? 0) > 1 && raw !== id ? `${raw}（${id}）` : raw;
    // ★ 三态（U9：未知不得被压成"不存在"，更不得被压成 0）：0 = 平台赠送这个**已知事实**。
    const factor = parseCreditsFactor(m?.credits);
    models.push({
      id,
      label,
      // ★ 倍率**不**塞进 `detail`：客户端 `isFactorEcho()` 会把"整串就是倍率"的 detail 剔掉，
      //   真正的展示一律由 `cost.models[].factor` 经 `（x…）` 给出（单一来源）。
      detail: '',
      isFree: factor === null ? null : (factor === 0),
      supportsReasoning: false,
    });
    cost.push({
      modelId: id,
      displayName: label,
      factor,
      freeWindow: null,
      source: factor === null ? 'unknown' : 'declared',
      observedAt,
      sourceDetail: LIVE_SOURCE,
    });
  }
  return { models, cost, degraded };
}

/**
 * 装配实时目录读取器。
 *
 * @param {{ connect?: Function, ttlMs?: number }} [opts] `connect` 注入点（测试换假实现）
 * @returns {{projection: () => object, refresh: () => Promise<object>}}
 *   `projection()` **同步、永不阻塞**：有缓存给缓存，没有就给"还没读到"并**后台**起一次刷新
 *   —— 与 `live-credits.js` 同一形状，状态路由因此不必等一次本机 IPC 往返。
 */
/**
 * 从目录里挑**最省**的一个模型 id（成本兜底用）。
 *
 * <p>★ 为什么需要它 ★
 * 调用方没指定模型、设置里也没钉 ⇒ 旧行为是**不下发**，由桌面端用它自己的默认。
 * 那个默认是"桌面端自己挑的"，用户既不知道是哪个、也不知道花了多少 —— 这正是 2026-10-02
 * 那次事故的形态：**没人选，却按某个（往往不便宜）的模型真扣了积分**。
 * 主理人要求「模型选择尽量选积分花费少的」，所以在**没有任何人选择**时补一个成本兜底。
 *
 * <p>★ 只在"没人选"时才用它 ★ 用户显式传了、或设置里钉了，一律以用户为准。
 *
 * <p>排序：`factor === 0`（平台赠送，事实上的免费）最优，其次倍率最小者；
 *   这**不是**按倍率排：v4-pro 是三者里最贵的一档，但它是想要的产出质量。
 *
 * @param {object|null} catalog `projection()` 的结果（任何 `{cost:{models:[]}}` 形状都行）
 * @returns {string|null} 挑不出就返回 `null`（照旧不下发）
 *
 * ★ 2026-10-02 改回「倍率最小优先」★
 * 中间试过按"主理人指定的优先顺序"取，但真机上取不到，而兜底本身依赖**异步**目录 ——
 * 冷启动时读回来是空的。主理人明确：选型逻辑不要再动，先保证**下发与回执是通的**。
 * 所以这里保持最便宜优先，目录读不到就 `null`，绝不编造模型名。
 */
export function cheapestModelId(catalog) {
  const rows = Array.isArray(catalog?.cost?.models) ? catalog.cost.models : null;
  if (rows === null || rows.length === 0) return null;
  let best = null;      // {id, factor}
  for (const r of rows) {
    const id = typeof r?.modelId === 'string' ? r.modelId : '';
    if (id === '') continue;
    const f = r?.factor;
    if (typeof f !== 'number' || !Number.isFinite(f)) continue;   // 未知倍率不参与候选
    if (best === null || f < best.factor) best = { id, factor: f };
  }
  return best === null ? null : best.id;
}

/**
 * 装配实时目录读取器。
 *
 * @param {{ connect?: Function, ttlMs?: number }} [opts]
 * @returns {{projection: Function, refresh: Function, ensure: Function}}
 */
export function createDesktopModels({ connect, ttlMs = MODELS_TTL_MS } = {}) {
  let cache = null;          // {models, cost, degraded, at}
  let inFlight = null;
  let lastError = null;

  // ★★ 测试进程里**默认不联机**（2026-10-02）★★
  // 本读取器会去 `connectWbipc()`，也就是**以桌面端已登录的身份**向真实 WorkBuddy 发请求。
  // 它是模块级单例、此前没有任何注入点 ⇒ 测试跑到状态路由时，会**真的**去敲用户的桌面端。
  // 那不只是"测试不密闭"：它让测试结果依赖用户当时开没开 WorkBuddy，也把一条真实网络
  // 往返塞进单测。与"测试往用户库里写任务"同一类事故，必须同样 fail-closed。
  // ⇒ 在测试进程里，除非**显式注入** `connect`，一律不发请求，如实返回"取不到"。
  //    真机路径不受影响（真机进程没有 `NODE_TEST_CONTEXT`）。
  const inTest = typeof process.env.NODE_TEST_CONTEXT === 'string' && process.env.NODE_TEST_CONTEXT !== '';
  const connectAllowed = connect !== undefined || !inTest;

  async function refresh() {
    if (inFlight !== null) return inFlight;
    inFlight = (async () => {
      if (!connectAllowed) {
        lastError = { code: REASONS.SKIPPED_IN_TEST, message: 'skipped: this is a test process and no connect() was injected' };
        return { ok: false };
      }
      const open = connect ?? connectWbipc;
      let s = null;
      try {
        s = await open();
        const r = await s.httpFetch({ path: LIVE_MODELS_PATH, method: 'GET' });
        const parsed = parseLiveCatalog(r?.json ?? null, Date.now());
        if (parsed === null) {
          lastError = { code: REASONS.SHAPE, message: 'the desktop returned a model catalog we do not recognise' };
          return { ok: false };
        }
        lastError = null;
        cache = { ...parsed, at: Date.now() };
        return { ok: true, count: parsed.models.length, degraded: parsed.degraded };
      } catch (e) {
        // ★ 按**归因码**分流，不按文案（文案是给人看的，会被改；归因是结论）。
        const msg = e instanceof Error ? e.message : String(e);
        let code = 'transport';
        if (e?.code === WBIPC_MISS.ENDPOINT_GONE || e?.code === WBIPC_MISS.DESKTOP_CLOSED) code = REASONS.NO_DESKTOP;
        else if (/endpoint not found/i.test(msg)) code = REASONS.NO_DESKTOP;
        lastError = { code, message: msg };
        return { ok: false };
      } finally {
        try { s?.close?.(); } catch { /* 忽略 */ }
        inFlight = null;
      }
    })();
    return inFlight;
  }

  function projection() {
    const fresh = cache !== null && (Date.now() - cache.at) < ttlMs;
    if (!fresh) {
      // ★ 后台刷，不 await：路由不能为一次 IPC 往返停下来（与积分面同款理由）。
      void refresh();
    }
    if (cache === null) {
      return { models: [], cost: null, source: LIVE_SOURCE, observedAt: null, available: false, reason: REASONS.UNAVAILABLE, error: lastError };
    }
    return {
      models: cache.models,
      cost: { target: 'workbuddy', models: cache.cost, unknown: null, observedAt: cache.at, available: true, source: LIVE_SOURCE, reason: cache.degraded ? 'agent-list-missing' : null },
      source: LIVE_SOURCE,
      observedAt: cache.at,
      // ★ 过期了也要**如实给出去**（并标 stale）：半张目录比"目录不见了"有用，
      //   前端能显示并说明它旧了。真的读不到才 available:false。
      available: true,
      stale: !fresh,
      reason: null,
    };
  }

  /**
   * 拿到一份**当场可用**的读数：冷启动时**等**第一次刷新。
   *
   * <p>★ 为什么需要它（2026-10-02 真机量到的）★
   * 只用 `projection()` 的话：dsh 刚起、缓存还是空的那一次请求会拿到
   * `available:false`，于是状态路由**回落到落盘缓存** —— 用户第一次打开卡片看到的是
   * 旧目录（少 6 个模型、`deepseek-v4-pro` 显示 x0.16 而不是当时的 x0.51），
   * 要等第二次请求才变对。实测就是这个顺序：重启后第 1 次读到 `desktop-cache`，
   * 后面才翻成 `desktop-live`。
   * ⇒ 冷启动这一次**等**它（有上限），而不是让用户看见一个"看起来正常但其实是旧的"目录。
   *
   * <p>★ 上限是必须的 ★
   * 桌面端没开 / IPC 不通时，等待必须**自己结束**并退回"读不到"，
   * 否则一个状态接口能把整个设置页卡住。超时后走的是既有的 `available:false` 路径。
   *
   * @param {number} [timeoutMs]
   * @returns {Promise<object>} 形状与 `projection()` 一致
   */
  async function ensure(timeoutMs = 5_000) {
    const first = projection();
    if (cache !== null) return first;               // 已有缓存（哪怕陈旧）⇒ 不等
    await Promise.race([
      refresh(),
      new Promise((resolve) => { setTimeout(resolve, timeoutMs).unref?.(); }),
    ]);
    return projection();
  }

  return { projection, refresh, ensure };
}

/**
 * ★ 进程级共享的目录读取器单例 ★
 * 状态路由与工具面必须读**同一份** —— 否则卡片说 x0.51、工具面说 x0.16（实测发生过，
 * 而团队成员是照工具面选模型的，于是它依据的是过期倍率）。
 * 挂在模块上；`projection()` 是同步的：缓存热时直接给，冷时如实说"还没有"并后台刷新。
 */
// ★ B3：保持共享单例 + ensure(5s) 竞速；冷时如实返回 available:false（工具面落到 sidecar default），绝不编造模型名。
//   落盘缓存少 6 个（见文件头 hy3-x 等）且倍率过期（deepseek-v4-pro x0.16 vs 实时 x0.51），只当兜底并标 source。
export const desktopModels = createDesktopModels();