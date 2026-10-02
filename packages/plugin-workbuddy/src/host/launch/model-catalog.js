/**
 * 模型候选目录读取器（§4.1.1）—— **从 routes/status/get.js 原样抽出**，供 UI 路由面与
 * `workbuddy_status` 工具面共用同一份判定与同一份缓存（避免两处各写一遍目录解析）。
 *
 * 数据源优先序（本机 `product.json:3-9` 的 env 覆盖机制，逐字依据）：
 *   ① `ACC_PRODUCT_CONFIG_V3` / `_V2` / `ACC_PRODUCT_CONFIG`（内联 JSON，V3 最高）
 *   ② `ACC_PRODUCT_CONFIG_PATH`（指向替代配置文件）
 *   ③ `~/.workbuddy/cache/acc-product-config-v3.json`（桌面端刷新的应用缓存；只读）
 * ★ `<cli>/product.json` 兜底分支**已删**（2026-10-01）：CLI 线已整体移除，
 *   桌面端缓存是唯一落到磁盘的产品配置来源。
 * 过滤（§4.1.1）：剔除媒资与补全类。判据 SSOT 在 `launch/model-filter.js`，
 *   本文件与 `launch/cost-catalog.js` **必须共用同一份** —— 两处各写一遍就会各自漂移
 *   （2026-10-01 已发生过一次：旧判据「带 tags 就剔除」把 13 个 `tags:["craft"]` 的真模型吞掉，
 *   数量 30 而非 43；详见 `model-filter.js` 头注）。
 * 说明（§4.1.1 坑① 二选一，本实现选"故意排除"并注释）：`completion.jumpToHere.models`
 *   嵌套短名单（`codewise-navi-v1-2-taco`）属非 agent 模型 ⇒ **不读**。
 * 兜底（§4.1.1 第二兜底）：主清单缺失时读 `agents[].name === 'cli'` 的 `models[]`。
 *   能力位未知 ⇒ `supportsReasoning: null`（客户端不硬过滤）。
 * 读盘失败 ⇒ 空列表 + reason（§4.1.1 升级风险②：静默降级到"自由输入"，不报错阻塞）。
 *
 * ★ 本模块给每条目录项附加**倍率三态** `isFree` 与 `detail`（`credits` 原值），
 *   **不在宿主侧按"是否有倍率"过滤**——那属于展示层（客户端）的职责。
 *   数据照旧全量给，让客户端能按 `isFree` 过滤。
 *
 * 约束：本文件属于 packages/*​/src（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 */
import { statSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { isSelectableModel } from './model-filter.js';

let catalogCache = { key: null, value: null };

/**
 * 桌面端刷新的产品配置缓存落点（与 `launch/cost-catalog.js` 的 ③ 号源**同一个路径常量**）。
 * @returns {string}
 */
export function desktopCachePath(home = homedir()) {
  return join(home, '.workbuddy', 'cache', 'acc-product-config-v3.json');
}

/**
 * 纯读存在性判定。**绝不抛**：文件不存在是常态（没装桌面端），
 * 让它冒出去会把"缓存不在"变成"整个目录读取器崩了"。
 * @param {string} p
 * @returns {boolean}
 */
function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * 倍率三态：**0 倍 ⇒ 免费（true）｜ > 0 倍 ⇒ 付费（false）｜ 取不到 ⇒ null（未知）**。
 *
 * 判据是厂商自己的倍率串（本机缓存实测 `"x0.00 credits"` ~ `"x5.00 credits"`），
 * 积分制下 0 倍即免费——这是算术事实，不是本插件发明的分类。
 *
 * ★ 为什么必须三态、不能是布尔（本机实测：**48 条里只有 8 条带 `credits` 倍率**）：
 *   ① 折成 `false` ⇒ 把"厂商没说"的模型谎报成"要花钱"，用户会为一个免费模型去充值；
 *   ② 折成 `true`  ⇒ 把同样"厂商没说"的谎报成"免费"，用户会选一个实际扣钱的模型。
 *   与 `supportsReasoning` 同一原则：「还不知道」不得被发布成任何一个肯定答案，
 *   消费端必须能区分 `null` 与 `false`。
 *
 * @param {unknown} credits 缓存里的 credits 原值（可能是缺失/非字符串/无法解析的形态）
 * @returns {boolean|null}
 */
function creditFreeFlag(credits) {
  if (typeof credits !== 'string') return null;
  const m = /^\s*x\s*([0-9]+(?:\.[0-9]+)?)/i.exec(credits);
  if (m === null) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return n === 0;
}


function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 「目录读不到」这件事其实有**三种**现实，压成一种就是在说谎（§4-9，真机首帧抓到的）：
 * 探测结论已出但确实解析不出 / 探测**还在路上** / 探测**根本没排上**。
 * 判定只出自 `runtime` 的两个既有读数（`detected()` 与 `probeArgs()`），**不新增状态**：
 * `lastProbeArgs` 在 `probe()` 同步段就写入 ⇒ 「排上了但没结论」= 在途。
 *
 * @param {{detected?: () => any, probeArgs?: () => any}} runtime
 * @returns {'concluded'|'pending'|'not-started'}
 */
export function detectionStateOf(runtime) {
  if (runtime?.detected?.() != null) return 'concluded';
  return runtime?.probeArgs?.() == null ? 'not-started' : 'pending';
}

/**
 * @param {{ resolvedPath?: unknown }|null|undefined} probe 只读探测结果（本读取器不再据此推导路径；
 *   参数保留仅为调用方签名兼容 —— 数据源已收敛为桌面缓存 + env）。
 * @param {Record<string, string | undefined>} env
 * @param {'concluded'|'pending'|'not-started'} [detection='concluded'] 探测面实况（★ §4-9）。
 *   缺省 `'concluded'` = 沿用旧口径（"没路径"就是"没路径"），既有调用方与测试的读数逐字不变。
 * @returns {{ models: Array<{ id: string, label: string, detail: string,
 *              supportsReasoning: boolean|null, isFree: boolean|null }>,
 *             source: string, reason: string|null }}
 */
export function readModelCatalog(probe, env, detection = 'concluded', opts = {}) {
  // ★ `opts.home` 与 `cost-catalog.js` 同款：测试注入后永远指向夹具，不会读到真实用户缓存
  //   （没有注入时读不到机器状态这件事，测试就只能靠"本机恰好装了"来通过 = 假绿）。
  const cachePath = desktopCachePath(opts.home ?? homedir());
  let data = null;
  let sourceRef = null;
  const inline = [env.ACC_PRODUCT_CONFIG_V3, env.ACC_PRODUCT_CONFIG_V2, env.ACC_PRODUCT_CONFIG].find(
    (v) => typeof v === 'string' && v.trim() !== '',
  );
  if (inline !== undefined) {
    data = parseJson(inline);
    sourceRef = 'env:inline';
  } else if (typeof env.ACC_PRODUCT_CONFIG_PATH === 'string' && env.ACC_PRODUCT_CONFIG_PATH.trim() !== '') {
    sourceRef = `env:path:${env.ACC_PRODUCT_CONFIG_PATH}`;
  } else if (isFile(cachePath)) {
    // ★ 桌面端刷新的缓存是唯一落到磁盘的产品配置来源（<cli>/product.json 分支已删）。
    //   缓存是**桌面端自己刷新、给它自己的界面用**的那份 ⇒ 以它为准。
    sourceRef = cachePath;
  }
  if (sourceRef === null) {
    // ★ §4-9：无路径 ≠ 无桌面端。探测还没给结论时把目录说成"不可用"，与 §22 刚修掉的
    //   "disabled or not installed" 是同一种折叠 ⇒ 前缀换成 `pending`，reason 再说清是哪一种在途。
    if (detection === 'pending') return { models: [], source: 'pending', reason: 'detection-in-flight' };
    if (detection === 'not-started') return { models: [], source: 'pending', reason: 'detection-not-started' };
    return { models: [], source: 'unavailable', reason: 'catalog-not-resolved' };
  }

  // 文件型源：按 (路径, mtimeMs) 缓存；内联源每次解析（无 stat 可依）
  let mtimeMs = 0;
  if (data === null && !sourceRef.startsWith('env:inline')) {
    const file = sourceRef.startsWith('env:path:') ? sourceRef.slice('env:path:'.length) : sourceRef;
    try {
      const st = statSync(file);
      if (!st.isFile()) return { models: [], source: 'unavailable', reason: 'catalog-not-a-file' };
      mtimeMs = st.mtimeMs;
      if (catalogCache.key === `${file}:${String(mtimeMs)}`) return catalogCache.value;
      data = parseJson(readFileSync(file, 'utf8'));
    } catch {
      return { models: [], source: 'unavailable', reason: 'catalog-unreadable' };
    }
    if (data === null) return { models: [], source: 'unavailable', reason: 'catalog-invalid-json' };
  }

  const all = Array.isArray(data?.models) ? data.models : [];
  let models = all
    // ★ 这里**不**按"有没有倍率"过滤。主理人的要求是「没有带倍率的模型**不要显示**」
    //   —— 那是**展示面**的要求，不是数据面的。在这一层滤会把 `isFree: null`（未知）这个
    //   三态**整个删掉**，于是"未知倍率"这件事再也无处可查、也无法被如实汇报。
    //   展示面的过滤在 `lib/client.js`（下拉选项组装）那里做，数据照旧全量给。
    .filter((m) => isSelectableModel(m))
    .map((m) => ({
      id: m.id,
      label: typeof m.name === 'string' && m.name !== '' ? m.name : m.id,
      detail: typeof m.credits === 'string' ? m.credits : '',
      // ★ 倍率三态：0 倍 = 免费。**未知必须留 null**（多数条没有 credits 键，见 creditFreeFlag 头注）。
      isFree: creditFreeFlag(m.credits),
      // ★ 三态：显式 true / false 原样保留，**键缺失 ⇒ null（未知）**。
      supportsReasoning: typeof m.supportsReasoning === 'boolean' ? m.supportsReasoning : null,
    }));
  // ★ 来源标签必须**逐字对得上真正读的那个文件**。非 env 源只有桌面缓存一种。
  // ★ 用 `let`：下面的 agents.cli 兜底分支会给它追加一段来源说明。
  //   （此前这里是 `const`，于是"桌面产品配置里没有可选项、只能退回 agent 清单"这条
  //   **真实存在的**分支一走进来就抛 TypeError —— 写的时候没人走过它。）
  let source = sourceRef.startsWith('env:')
    ? sourceRef
    : `desktop-cache:${sourceRef.split(/[\\/]/).pop()}`;
  if (models.length === 0) {
    const cliAgent = Array.isArray(data?.agents) ? data.agents.find((a) => a && a.name === 'cli') : undefined;
    const short = Array.isArray(cliAgent?.models) ? cliAgent.models.filter((id) => typeof id === 'string') : [];
    if (short.length > 0) {
      models = short.map((id) => ({ id, label: id, detail: '', isFree: null, supportsReasoning: null }));
      source = `${source}#agents.cli.models`;
    } else {
      const result = { models: [], source: 'unavailable', reason: 'models-missing' };
      catalogCache = { key: `${sourceRef}:${String(mtimeMs)}`, value: result };
      return result;
    }
  }
  const result = { models, source, reason: null };
  if (mtimeMs > 0) catalogCache = { key: `${sourceRef.startsWith('env:path:') ? sourceRef.slice('env:path:'.length) : sourceRef}:${String(mtimeMs)}`, value: result };
  return result;
}
