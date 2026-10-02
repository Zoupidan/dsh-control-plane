/**
 * 模型候选的**过滤判据**（一个事实一个出处 —— `model-catalog.js` 与 `cost-catalog.js` 共用）。
 *
 * ★★★ 这条规则改过，原因是一次真实的回归（2026-10-01 实测） ★★★
 *
 * <p>原判据是「**带 `tags` 就剔除**」，依据是当初在产品配置里量到的 4 条带 tags 条目
 * **全是媒资**（`text-to-image` / `image-to-image` / `embed` 一类）⇒ 推论「tags ⇒ 媒资」。
 *
 * <p>今天的真值（同机、`~/.workbuddy/cache/acc-product-config-v3.json`）打掉了这个推论：
 * <pre>
 *   models[] 原始          53 条
 *   带 tags 的             15 条  ← 其中 **13 条是 tags:["craft"] 的真对话模型**
 *                                  hy3/hy3-b/hy3-c/hy3-x · glm-5.3/5.2/5.1/5.0-turbo/5v-turbo
 *                                  kimi-k2.6/kimi-k2.5 · minimax-m2.7 · deepseek-v3-2-volc
 *   带 supportsExtra 的     8 条  ← 真·补全/辅助类，剔除是对的
 *   tags 取值分布           ["craft"]×13 · ["text-to-image"]×1 · ["image-to-image"]×1
 * </pre>
 *
 * ⇒ 旧判据把 **13 个真模型连同它们的倍率一起吞掉**（数量 30 而非 43），
 *   而被吞的恰好包括 `glm-5.3` / `glm-5.2` / `glm-5.1` 这几个主力档。
 *   `craft` 是**形态标记**（创作形态），不是媒资类型。
 *
 * ★ 新判据：按 tag 的**语义**判，不按"有没有 tag"判 ★
 *
 * <p>带一个 tag 就当媒资 = 把"这条被打了标签"误当成"这条不是对话模型"。所以改成
 * **tag 的内容**命中媒资模式才剔除。两个方向都验过：
 * <ul>
 *   <li>`craft` ⇒ 不命中 ⇒ **保留**（今天 13 个真模型回来了）；</li>
 *   <li>`text-to-image` / `image-to-image` / `img` / `vision` ⇒ 命中 ⇒ **剔除**（原行为不变）。</li>
 * </ul>
 *
 * ★ 为什么用模式而不是"枚举一份媒资 tag 清单" ★
 * 枚举只能覆盖**今天**出现过的取值；下个月产品加一个 `tts` 或 `asr`，枚举就会把它当对话模型放进来。
 * 模式对未见过的媒资取值天然兜底，而对 `craft` 这类形态标记**不会**误伤 ——
 * 误伤方向选成"多显示一个模型"而不是"少显示一个模型"：前者用户看得见、后者用户看不见。
 *
 * <p>约束：本文件位于 packages 各插件的 src 树内（CI ② 扫描范围）—— 不得出现裸进程出口字面。
 *
 * @module host/launch/model-filter
 */

/**
 * 媒资 tag 的判定模式（小写后匹配）。
 *
 * ★ 刻意**不含** `multimodal` ★
 * 多模态是**对话能力**，带它的条目仍然是能发起会话的模型；把它当媒资剔掉是同一种错。
 */
const ASSET_TAG_PATTERN = /image|img|vision|audio|video|embed|tts|asr|speech/;

/**
 * 一条目录项是否**纯媒资**（该剔除）。
 *
 * <p>多个 tag 时取「**任一**命中即剔除」：混合标签（对话 + 图像生成）里含媒资语义时，
 * 保留它会让用户在一个只能发文字的入口里选到发不出图的模型。
 *
 * @param {any} m `models[]` 的一��
 * @returns {boolean}
 */
export function isAssetEntry(m) {
  const tags = m?.tags;
  if (!Array.isArray(tags)) return false;
  return tags.some((t) => typeof t === 'string' && ASSET_TAG_PATTERN.test(t.toLowerCase()));
}

/**
 * 一条目录项是否**补全/辅助类**（该剔除）。
 *
 * <p>`supportsExtra` 是**能力扩展标记**（行内补全、跳转等），带它的条目不由用户发起会话。
 * 这条判据与本次回归无关，**未改动**。
 *
 * @param {any} m
 * @returns {boolean}
 */
export function isCompletableEntry(m) {
  return m !== null && typeof m === 'object' && m.supportsExtra !== undefined;
}

/**
 * 一条目录项是否算**用户可选的对话模型**。
 *
 * @param {any} m
 * @returns {boolean}
 */
export function isSelectableModel(m) {
  if (m === null || typeof m !== 'object') return false;
  if (typeof m.id !== 'string' || m.id === '') return false;
  return !isAssetEntry(m) && !isCompletableEntry(m);
}

/**
 * 桌面端的**档位预设**（不是固定模型，路由由 WorkBuddy 自己挑）。
 *
 * <p>实测（2026-10-01，产品配置逐字）：`fast-model`=「快速」x0.21、`balanced-model`=「均衡」x0.65、
 * `deep-model`=「**极致**」x1.20。它们和 CLI 那套 `auto` **不是同一套词表** ——
 * CLI 的 `--model` 取值里根本没有这三个 id，只有 `auto`。
 *
 * <p>它们**有真实倍率**，所以成本表照收；只是语义上属于"让对方自己挑"，UI 上不该
 * 让人以为是三个固定的第三方模型。
 */
export const TIER_PRESET_MODEL_IDS = Object.freeze(['fast-model', 'balanced-model', 'deep-model']);

/**
 * 该 id 是否是"由 WorkBuddy 自己挑路由"的档位预设。
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isTierPresetModel(id) {
  return typeof id === 'string' && TIER_PRESET_MODEL_IDS.includes(id);
}