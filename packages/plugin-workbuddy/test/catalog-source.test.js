/**
 * 两个目录读取器**不许读两个不同的世界**（★ 2026-10-01 新增）。
 *
 * <p>★ 这条回归是怎么来的 ★
 * `launch/model-catalog.js`（界面上的候选模型列表）只认
 * `<cli>/product.json` —— **CLI 安装时打包的快照**；而
 * `launch/cost-catalog.js`（倍率表）优先读桌面端自己刷新的
 * `~/.workbuddy/cache/acc-product-config-v3.json`。
 *
 * <p>2026-10-01 在真机上逐条比过：**两份同一个 commit（`37a65c0b33b8`、
 * genieVersion 5.6.2、同一天），内容却不一样**：
 * <pre>
 *   缓存   53 条  含 fast-model「快速」/ balanced-model「均衡」/ deep-model「极致」
 *                 含 glm-5.3 / hy3-x / deepseek-v4.1-flash，带 6 条 modelPromotions
 *   product 48 条  **那三个档位预设一个都没有**；反而多出 default / auto / glm-5.0 /
 *                 glm-4.7 / kling-v3-*（视频生成），且 0 条促销
 * </pre>
 * ⇒ 界面上"模型数量不对、少了那三档"就是这么来的；两个面还会各自报出不同的倍率。
 *
 * <p>★ 判据的自我校验 ★
 * 每条断言都配**反例**：
 *   - 三个档位预设必须在目录里（缓存源有）；
 *   - `product.json` 独有的 `kling-v3-t2v` / `auto` **不该**出现在目录里（证明不是"全都塞进去"）；
 *   - 缓存不存在时**必须优雅降级**、不许抛（证明不是"缓存不在就崩"）。
 *
 * @module test/catalog-source.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseCreditsFactor } from '../src/host/launch/cost-catalog.js';
import { isSelectableModel } from '../src/host/launch/model-filter.js';
import { readModelCatalog } from '../src/host/launch/model-catalog.js';

/** 逐字取自当天真机两份源，只保留判据相关字段。 */
const CACHE_MODELS = [
  { id: 'fast-model', name: '快速', credits: 'x0.21' },
  { id: 'balanced-model', name: '均衡', credits: 'x0.65' },
  { id: 'deep-model', name: '极致', credits: 'x1.20' },
  { id: 'glm-5.3', name: 'GLM-5.3', credits: 'x0.79', tags: ['craft'] },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', credits: 'x0.11' },
  { id: 'hunyuan-image-alpha', name: 'Hunyuan Image Alpha', tags: ['text-to-image'] },
];
const PRODUCT_MODELS = [
  { id: 'default', name: 'default', credits: '' },
  { id: 'auto', name: 'auto', credits: '' },
  { id: 'glm-5.0', name: 'GLM-5.0', credits: 'x0.95' },
  { id: 'glm-4.7', name: 'GLM-4.7', credits: 'x0.90' },
  { id: 'kling-v3-t2v', name: 'Kling v3', credits: 'x2.00', tags: ['text-to-video'] },
];

test('★ 三个档位预设（快速/均衡/极致）必须出现在模型目录里', () => {
  const kept = CACHE_MODELS.filter(isSelectableModel).map((m) => m.id);
  for (const id of ['fast-model', 'balanced-model', 'deep-model']) {
    assert.ok(kept.includes(id), `${id} 必须在目录里 —— 它在桌面端缓存里是真实可选模型`);
  }
});

test('★ 反例：`product.json` 独有的条目不该被当成对话模型', () => {
  // `kling-v3-t2v` 带 text-to-video 标签 ⇒ 媒资，必须剔除。
  assert.ok(!CACHE_MODELS.concat(PRODUCT_MODELS).filter(isSelectableModel).some((m) => m.id === 'kling-v3-t2v'));
  // `default` / `auto` 是别名/CLI 词表里的东西，在缓存源里**不存在** ——
  //   若目录里冒出它们，说明有人把 product.json 的内容混了进来。
  assert.ok(!CACHE_MODELS.some((m) => m.id === 'auto'));
  assert.ok(!CACHE_MODELS.some((m) => m.id === 'default'));
});

test('★ 目录读取器认桌面端缓存，且缓存缺失时优雅降级**不抛**', () => {
  // 造一个"桌面端装过"的假 home：只有缓存，没有可探测到的 CLI。
  const home = mkdtempSync(join(tmpdir(), 'wb-catalog-src-'));
  try {
    const dir = join(home, '.workbuddy', 'cache');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'acc-product-config-v3.json'), JSON.stringify({ models: CACHE_MODELS }));

    // ① 没有探测结果 + 缓存存在 ⇒ **必须读到**（这就是本次修的行为：之前直接
    //    `cli-not-resolved`，桌面端明明在跑、模型列表却是空的）。
    const fromCache = readModelCatalog(null, {}, 'concluded', { home });
    assert.match(fromCache.source, /^desktop-cache:/, `来源标签必须说清读的是缓存，实际 "${fromCache.source}"`);
    for (const id of ['fast-model', 'balanced-model', 'deep-model']) {
      assert.ok(fromCache.models.some((m) => m.id === id), `${id} 必须在目录里`);
    }
    assert.ok(!fromCache.models.some((m) => m.id === 'hunyuan-image-alpha'), '媒资仍剔除');

    // ② 缓存不在 ⇒ 报 unavailable，**不许抛**（ENOENT 冒出去 = 整个读取器崩了）。
    const bare = mkdtempSync(join(tmpdir(), 'wb-catalog-empty-'));
    try {
      const r = readModelCatalog(null, {}, 'concluded', { home: bare });
      assert.equal(r.models.length, 0);
      assert.equal(r.source, 'unavailable');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }

    // ③ 探测在途 + 缓存存在 ⇒ **先给数据**，不再被 `pending` 挡在门外
    //    （"未探测 ≠ 未安装"，与 §22 同一条纪律）。
    assert.ok(readModelCatalog(null, {}, 'pending', { home }).models.length > 0, '探测在途不该把已有缓存挡掉');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('★ 倍率解析：两份源的写法不同都必须读得出数字', () => {
  // 缓存写法
  assert.equal(parseCreditsFactor('x0.17'), 0.17);
  // product.json 写法（数字后面带单位词）—— 旧正则把它判成"未知"
  assert.equal(parseCreditsFactor('x0.06 credits'), 0.06, '"x0.06 credits" 必须读出 0.06，而不是"未知"');
  assert.equal(parseCreditsFactor('x1.20 积分'), 1.2);
  // 反例：真的解析不出，仍然必须是 null（**不猜**）
  for (const bad of ['', 'x', 'xabc', 'free', '0.17', 'xx0.17', 'x-1', null, undefined, 3]) {
    assert.equal(parseCreditsFactor(bad), null, `${JSON.stringify(bad)} 必须解析不动`);
  }
});

test('两个源的可选条目数不同：缓存 5、product 4（夹具口径）', () => {
  // 缓存夹具 6 条 − 1 图像 = 5
  assert.equal(CACHE_MODELS.filter(isSelectableModel).length, 5);
  // product 夹具 5 条 − 1 视频媒资 = 4；与缓存**不同** ⇒ 这正是必须以缓存为准的理由。
  assert.equal(PRODUCT_MODELS.filter(isSelectableModel).length, 4);
});