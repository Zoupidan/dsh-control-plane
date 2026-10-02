/**
 * 模型过滤判据的回归（★ 2026-10-01 新增）。
 *
 * <p>★ 为什么这个文件存在 ★
 * 旧判据是「带 `tags` 就剔除」，依据是当初量到的 4 条带 tags 条目全是媒资。
 * 2026-10-01 在真机上量到 `tags` 有 15 条，其中 **13 条是 `tags:["craft"]` 的真对话模型**
 * （`glm-5.3` / `glm-5.2` / `glm-5.1` / `hy3` 家族 / `kimi-k2.5/2.6` / `minimax-m2.7` …）
 * ⇒ 旧判据把它们连同倍率一起吞掉，目录数 30 而非 43。
 *
 * <p>★ 判据的自我校验 ★
 * 每条规则都配**两个方向**的对照，且夹具直接取自当天真机读数（不是编的）：
 *   - `craft` ⇒ **保留**（正控：证明不是"无脑全留"）
 *   - `text-to-image` / `image-to-image` / `img` / `vision` ⇒ **剔除**（负控：证明不是"全留"）
 *   - `supportsExtra` ⇒ 剔除，且**这条规则本次没动**（回归护栏）
 * 若哪天规则退化成恒真或恒假，第二、三组立刻红。
 *
 * @module test/model-filter.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TIER_PRESET_MODEL_IDS,
  isAssetEntry,
  isCompletableEntry,
  isSelectableModel,
  isTierPresetModel,
} from '../src/host/launch/model-filter.js';

// ↓ 逐字取自 2026-10-01 本机 `~/.workbuddy/cache/acc-product-config-v3.json` 的 models[]（只保留判据相关字段）
const REAL = [
  { id: 'fast-model', name: '快速', credits: 'x0.21' },
  { id: 'balanced-model', name: '均衡', credits: 'x0.65' },
  { id: 'deep-model', name: '极致', credits: 'x1.20' },
  { id: 'hy3', name: 'Hy3', credits: 'x0.00', tags: ['craft'] },
  { id: 'hy3-b', name: 'Hy3', credits: 'x0.00', tags: ['craft'] },
  { id: 'hy3-c', name: 'Hy3', credits: 'x0.00', tags: ['craft'] },
  { id: 'hy3-x', name: 'Hy3', credits: 'x0.05', tags: ['craft'] },
  { id: 'glm-5.3', name: 'GLM-5.3', credits: 'x0.79', tags: ['craft'] },
  { id: 'glm-5.2', name: 'GLM-5.2', credits: 'x0.79', tags: ['craft'] },
  { id: 'glm-5.1', name: 'GLM-5.1', credits: 'x0.79', tags: ['craft'] },
  { id: 'glm-5.0-turbo', name: 'GLM-5.0-Turbo', credits: 'x0.95', tags: ['craft'] },
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', credits: 'x0.71', tags: ['craft'] },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', credits: 'x0.52', tags: ['craft'] },
  { id: 'kimi-k2.5', name: 'Kimi-K2.5', credits: 'x0.45', tags: ['craft'] },
  { id: 'minimax-m2.7', name: 'MiniMax-M2.7', credits: 'x0.26', tags: ['craft'] },
  { id: 'deepseek-v3-2-volc', name: 'DeepSeek-V3.2', credits: 'x0.29', tags: ['craft'] },
  { id: 'hunyuan-image-alpha', name: 'Hunyuan Image Alpha', tags: ['text-to-image'] },
  { id: 'hunyuan-image-alpha-edit', name: 'Hunyuan Image Alpha Edit', tags: ['image-to-image'] },
  { id: 'completion-gf', name: 'completion-gf', credits: '', supportsExtra: true },
  { id: 'codewise-completions', name: 'codewise-completions', credits: '', supportsExtra: true },
  { id: 'deepseek-r1-0528', name: 'deepseek-r1', credits: '', supportsExtra: true },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', credits: 'x0.11' },
  { id: 'kimi-k3-1', name: 'Kimi-K3', credits: 'x1.62' },
];

test('★ 真机夹具：`craft` 的 13 个真模型必须回到目录里（旧判据把它们全吞了）', () => {
  const kept = REAL.filter(isSelectableModel).map((m) => m.id);

  // ★ 正控：这 13 个以前全被吞掉，现在必须在。
  const craftModels = REAL.filter((m) => Array.isArray(m.tags) && m.tags.includes('craft')).map((m) => m.id);
  assert.equal(craftModels.length, 13, '夹具本身失效：今天的真机是 13 条 craft');
  for (const id of craftModels) {
    assert.ok(kept.includes(id), `${id} 被吞了 —— 这正是 2026-10-01 那个回归`);
  }
  // ★ 负控：媒资与补全类**仍然**必须被剔除（证明不是"无脑全留"）。
  for (const id of ['hunyuan-image-alpha', 'hunyuan-image-alpha-edit', 'completion-gf', 'codewise-completions', 'deepseek-r1-0528']) {
    assert.ok(!kept.includes(id), `${id} 必须被剔除 —— 规则退化成"全留"了`);
  }
  // 数量口径：真机全量 53 − 8 补全 − 2 图像 = **43**；本夹具取 23 条代表条目，按同一规则得 18。
  assert.equal(REAL.length, 23, '夹具条目数（口径注释按它算）');
  assert.equal(kept.length, 18, `夹具口径：23 − 3 supportsExtra − 2 图像 = 18，实际 ${kept.length}`);
});

test('媒资判据按 tag 的**内容**，不按"有没有 tag"', () => {
  // 负向：形态标记不是媒资类型。
  assert.equal(isAssetEntry({ id: 'glm-5.3', tags: ['craft'] }), false);
  assert.equal(isAssetEntry({ id: 'x', tags: ['code'] }), false);
  // 正向：真媒资类型。
  for (const t of ['text-to-image', 'image-to-image', 'img', 'vision', 'audio', 'video', 'embedding', 'tts', 'asr']) {
    assert.equal(isAssetEntry({ id: 'x', tags: [t] }), true, `${t} 必须是媒资`);
  }
  // 大小写不敏感（tag 是外部来的）。
  assert.equal(isAssetEntry({ id: 'x', tags: ['Text-To-Image'] }), true);
  // 混合标签：任一命中即剔除（不能发图的入口不该让用户选到只能发图的模型）。
  assert.equal(isAssetEntry({ id: 'x', tags: ['craft', 'text-to-image'] }), true);
  // 没有 tags / tags 不是数组 ⇒ 一律**不**判成媒资。
  assert.equal(isAssetEntry({ id: 'x' }), false);
  assert.equal(isAssetEntry({ id: 'x', tags: 'text-to-image' }), false, 'tags 形状不对时不猜');
  // ★ 刻意不含 multimodal：多模态是**对话能力**，带它的条目仍能发起会话。
  assert.equal(isAssetEntry({ id: 'x', tags: ['multimodal'] }), false);
});

test('`supportsExtra` 判据本次**未改动**（回归护栏）', () => {
  assert.equal(isCompletableEntry({ id: 'x', supportsExtra: true }), true);
  assert.equal(isCompletableEntry({ id: 'x', supportsExtra: false }), true, '键存在就是补全类，值真假不改变性质');
  assert.equal(isCompletableEntry({ id: 'x' }), false);
});

test('档位预设：快速/均衡/极致 是桌面端 id，且**有真实倍率**', () => {
  assert.deepEqual([...TIER_PRESET_MODEL_IDS], ['fast-model', 'balanced-model', 'deep-model']);
  assert.equal(isTierPresetModel('fast-model'), true);
  assert.equal(isTierPresetModel('deepseek-v4.1-flash'), false);
  // 它们是**可选模型**（有倍率 ⇒ 成本表要收），只是语义上"由对方挑路由"。
  for (const id of TIER_PRESET_MODEL_IDS) {
    const m = REAL.find((x) => x.id === id);
    assert.ok(m, `夹具缺 ${id}`);
    assert.ok(isSelectableModel(m), `${id} 必须留在可选目录里 —— 它有真实倍率`);
    assert.match(m.credits, /^x\d/, `${id} 的倍率必须被如实读到`);
  }
});

test('非对象 / 无 id 的条目一律不算可选模型', () => {
  for (const bad of [null, undefined, 'x', 1, {}, { id: '' }, { id: 1 }]) {
    assert.equal(isSelectableModel(bad), false, `${JSON.stringify(bad)} 必须被拒`);
  }
});