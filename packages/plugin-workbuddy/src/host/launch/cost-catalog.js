/**
 * WorkBuddy 成本目录读取器（PRD-v4 A2）—— 从产品配置缓存归一出 `CostSnapshot`。
 *
 * Implements: 01-prd/PRD-v4-cost-routing.md §4.4（WorkBuddy 行：倍率 ✅ `discount.factor` /
 *             免费规则 ✅ `badge.label` / 时间窗 ✅ 带日期）
 *
 * 数据源优先序（与 `model-catalog.js` 同一族的覆盖机制 —— 那是 WorkBuddy **自己的**
 * env 覆盖面，产品配置本体就是同一份文件，这里只是多认一个"应用缓存"落点）：
 *   ① `ACC_PRODUCT_CONFIG_V3` / `_V2` / `ACC_PRODUCT_CONFIG`（内联 JSON，V3 最高）
 *   ② `ACC_PRODUCT_CONFIG_PATH`（指向替代配置文件）
 *   ③ `~/.workbuddy/cache/acc-product-config-v3.json`（桌面端刷新的应用缓存；只读，
 *      v3 红线 E.4 只禁**写**这棵树）
 * ★ ④ `<cli>/product.json` 兜底**已删**（2026-10-01）：CLI 线已整体移除，桌面缓存是唯一落盘来源。
 *
 * 归一规则（逐条有出处）：
 *   - 基础倍率 = `models[].credits`（形如 `x0.21` 的字符串，51/53 条有；解析不动 ⇒ null，
 *     "解析不出"不是 0 也不是 1，是**未知**）。
 *   - 促销覆盖 = `modelPromotions[]` 里 `kind==='discount'` 且 `enabled!==false` 的条目：
 *     对每个 `modelIds[]` 成员，取**所有适用促销中最低**的 factor（对用户最有利的已声明值）；
 *     badge/hover/schedule 随赢家一起带上。
 *   - 免费判定只信 `discount.factor === 0`（PRD §4.4 原话："factor === 0 即可判定免费——
 *     不需要解析文案"）；badge-only 条目（无 discount）**不**产生 factor，只补窗口文案。
 *   - 过期促销（`schedule.validUntil` 可解析且早于 now）**整条剔除**——把过期免费当有效是谎报。
 *   - `schedule.daily`（每日时段窗，H:MM，可跨午夜）**不做**运行时判定：freeWindow.text
 *     照抄 `hover.textZh` 原文（PRD §4.1"原文照抄"），"现在是否在窗内"留给 UI/用户判断
 *     —— 时段换算错了比不换算更糟（U9）。
 *
 * ★ 凭据零回显（PRD §5.2）：本文件只读上述缓存与 product.json；`~/.workbuddy/credentials/`
 *   一律不碰；sourceDetail 只记 文件来源 + 字段路径，绝不记值。
 *
 * 约束：本文件位于 packages 各插件的 src 树内（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { normalizeModelCostInfo } from './cost-model-info.js';
import { PROBE_TARGET } from '../config/constants.js';
import { isSelectableModel } from './model-filter.js';

/** @returns {any} */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * `x0.21` → 0.21；解析不动 → null（未知，绝不猜）。@param {unknown} v
 *
 * ★ 为什么容忍尾随单位（2026-10-01 实测）★
 * 同一份配置的**两份快照写法不同**：桌面端刷新出来的缓存写 `"x0.17"`，
 * 而 CLI 打包的 `product.json` 写 `"x0.06 credits"` —— 多个词。
 * 原正则 `/^x(\d+(\.\d+)?)$/` 会把后者判成"解析不出" ⇒ 倍率显示成**未知**。
 * 那是"读法不对"被报成"对方没声明"，方向错了。
 * 只容忍**数字后面**的单位词；`x` 开头没有数字、或数字前面带别的，照旧解析不动。
 */
export function parseCreditsFactor(v) {
  if (typeof v !== 'string') return null;
  const m = /^x(\d+(?:\.\d+)?)(?:\s+\D+)?$/.exec(v.trim());
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * 促销条目是否仍然有效（validUntil 可解析 ⇒ 必须晚于 now；解析不动 ⇒ 当作有效并如实保留原文）。
 * @param {any} promo @param {number} now @returns {boolean}
 */
export function promotionActive(promo, now) {
  const vu = promo?.schedule?.validUntil;
  if (typeof vu !== 'string' || vu.trim() === '') return true;
  const t = Date.parse(vu);
  return Number.isNaN(t) ? true : t > now;
}

/**
 * ①硬闸的关断快照（PRD-v4 §3：关闭状态下"模型目录读取一律不发生"）。
 * 发布面/状态面在 enabled!==true 时**必须**用它顶替 readCostCatalog —— models 为空数组
 * 且 unknown 写明原因：路由器按 available:false 出局，卡片把"空"归因到"你关了它"。
 * @param {number} [now]
 */
export function disabledSnapshot(now = Date.now()) {
  return {
    target: PROBE_TARGET,
    models: [],
    unknown: {
      reason: '程序开关关闭：成本目录一律不读取（PRD-v4 §3 ①硬闸）',
      attempted: [],
      suggestion: '在设置中开启后自动读取',
    },
    observedAt: now,
    available: false,
  };
}

/**
 * @param {{ resolvedPath?: unknown }|null|undefined} probe 只读探测结果（★ 保留仅为签名兼容，
 *   本读取器不再据此推导路径 —— <cli>/product.json 兜底已删）
 * @param {Record<string, string | undefined>} env
 * @param {{ now?: number, home?: string }} [opts] now/home 可注入（测试零机器状态；home 注入后
 *   缺省源永远指向测试夹具，不会读到真实用户缓存）。
 * @returns {{ snapshot: { target: string, models: Array<object>, unknown: object|null, observedAt: number, available: boolean },
 *             source: string, reason: string|null }}
 *   `available` 由调用方按注册态覆写（本函数只给 false 占位 —— 它是①硬闸字段，不许猜）。
 */
export function readCostCatalog(probe, env, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  /** @type {{ label: string, data: any, source: string }[]} */
  const tried = [];

  // —— 解析数据源（①②③ 依序，命中即停）——
  let data = null;
  let source = '';
  const inline = [env.ACC_PRODUCT_CONFIG_V3, env.ACC_PRODUCT_CONFIG_V2, env.ACC_PRODUCT_CONFIG].find(
    (v) => typeof v === 'string' && v.trim() !== '',
  );
  if (inline !== undefined) {
    tried.push({ label: 'env:inline', data: parseJson(inline) });
  } else if (typeof env.ACC_PRODUCT_CONFIG_PATH === 'string' && env.ACC_PRODUCT_CONFIG_PATH.trim() !== '') {
    const p = env.ACC_PRODUCT_CONFIG_PATH;
    try {
      tried.push({ label: `env:path:${p}`, data: parseJson(readFileSync(p, 'utf8')) });
    } catch (err) {
      tried.push({ label: `env:path:${p}`, data: null, error: /** @type {Error} */ (err).code ?? 'unreadable' });
    }
  }
  if (tried.length === 0 || tried.every((t) => t.data === null || t.data === undefined)) {
    const cachePath = join(opts.home ?? homedir(), '.workbuddy', 'cache', 'acc-product-config-v3.json');
    try {
      if (statSync(cachePath).isFile()) tried.push({ label: cachePath, data: parseJson(readFileSync(cachePath, 'utf8')) });
      else tried.push({ label: cachePath, data: null, error: 'not-a-file' });
    } catch (err) {
      tried.push({ label: cachePath, data: null, error: /** @type {Error} */ (err).code ?? 'unreadable' });
    }
  }
  if (tried.every((t) => t.data === null || t.data === undefined)) {
    // ★ <cli>/product.json 兜底分支已删（CLI 线移除）：桌面缓存 + env 是仅剩的数据源。
    //   `probe` 参数保留仅为签名兼容，不再用于推导任何路径。
  }

  const hit = tried.find((t) => t.data !== null && t.data !== undefined);
  if (hit === undefined) {
    return {
      snapshot: {
        target: PROBE_TARGET,
        models: [],
        unknown: {
          reason: '产品配置缓存不可读（models 与 promotions 都没拿到）',
          attempted: tried.map((t) => `${t.label}${t.error ? ` ⇒ ${t.error}` : ' ⇒ 解析失败'}`),
          suggestion: '启动 WorkBuddy 桌面端让其刷新缓存，或用 ACC_PRODUCT_CONFIG_* 注入副本',
        },
        observedAt: now,
        available: false,
      },
      source: 'unavailable',
      reason: 'no-source',
    };
  }
  data = hit.data;
  source = hit.label;

  // —— 基础表：models[]（过滤判据 SSOT = `launch/model-filter.js`，与 model-catalog.js 共用）——
  // ★ 2026-10-01：旧判据「带 tags 就剔除」在这里同样吞掉了 13 个 `tags:["craft"]` 的真模型
  //   连同它们的倍率（数量 30 而非 43，含 glm-5.3/5.2/5.1）。详见 model-filter.js 头注。
  const all = Array.isArray(data?.models) ? data.models : [];
  /** @type {Map<string, {factor: number|null, displayName: string, sourceDetail: string, window: {text: string, validUntil: string|null}|null}>} */
  const byId = new Map();
  for (const m of all) {
    if (!isSelectableModel(m)) continue;
    byId.set(m.id, {
      factor: parseCreditsFactor(m.credits),
      displayName: typeof m.name === 'string' && m.name !== '' ? m.name : m.id,
      sourceDetail: `${source}#models[].credits`,
      window: null,
    });
  }

  // —— 促销覆盖：最低 factor 赢家；badge/hover/schedule 随赢家 ——
  const promos = Array.isArray(data?.modelPromotions) ? data.modelPromotions : [];
  for (const promo of promos) {
    if (!promo || promo.kind !== 'discount' || promo.enabled === false) continue;
    if (!promotionActive(promo, now)) continue;
    const ids = Array.isArray(promo.modelIds) ? promo.modelIds : [];
    const pf =
      promo.discount && typeof promo.discount.factor === 'number' && Number.isFinite(promo.discount.factor)
        ? promo.discount.factor
        : null;
    const text =
      promo.hover && typeof promo.hover.textZh === 'string' && promo.hover.textZh !== ''
        ? promo.hover.textZh
        : promo.badge && typeof promo.badge.label === 'string'
          ? promo.badge.label
          : '';
    const vu = promo.schedule && typeof promo.schedule.validUntil === 'string' ? promo.schedule.validUntil : null;
    for (const id of ids) {
      if (typeof id !== 'string') continue;
      const cur = byId.get(id) ?? {
        factor: null,
        displayName: id,
        sourceDetail: `${source}#modelPromotions[].discount.factor`,
        window: null,
      };
      const overridesBase = cur.factor === null || (pf !== null && pf < cur.factor);
      if (pf !== null && overridesBase) {
        // 促销倍率是**折后有效值**：比当前已知更低（或基础值缺失）才覆盖——
        // 更高的促销倍率不动基础值。窗口文案随赢家走（描述生效中的那个折扣），
        // 赢家没带文案且旧窗口在 ⇒ 保留旧窗口。
        cur.factor = pf;
        cur.sourceDetail = `${source}#modelPromotions[].discount.factor`;
        if (text !== '' || vu !== null) cur.window = { text, validUntil: vu };
      } else if (cur.window === null && (text !== '' || vu !== null)) {
        // 不改倍率的促销（badge-only / 同价带文案）：只补窗口文案（首个补上的生效）。
        cur.window = { text, validUntil: vu };
      }
      byId.set(id, cur);
    }
  }

  const models = [];
  for (const [modelId, entry] of byId) {
    models.push(
      normalizeModelCostInfo(
        {
          modelId,
          displayName: entry.displayName,
          factor: entry.factor,
          freeWindow: entry.window,
          source: entry.factor === null ? 'unknown' : 'declared',
          observedAt: now,
          sourceDetail: entry.sourceDetail,
        },
        { now },
      ),
    );
  }

  return {
    snapshot: {
      target: PROBE_TARGET,
      models,
      unknown: models.length === 0 ? { reason: '配置可读但归一后零条目', attempted: [source], suggestion: '核对过滤规则与文件版本' } : null,
      observedAt: now,
      available: false, // ★ 占位：注册态由调用方覆写（① 硬闸字段不许由读取器猜）
    },
    source,
    reason: null,
  };
}
