/**
 * @file automation 主路的积分归类 —— `unknownRuns=1` 含义的钉子。
 *
 * <p>★ 起因：状态接口 `credits.counters` 里 `unknownRuns=1` —— 是正常初值还是漏归类 ★
 * 查证结论（见 `tools/run.js multiplierOfUsedModel` 头注）：
 *   · `runs` / `unknownRuns` 只在 `recordRun({ok:true})` 时 +1（初值全 0，没有 1 的种子）；
 *   · 失败走 `failedRuns`，与这里无关；
 *   · 旧收口硬编码 `multiplier: null` ⇒ 每一轮成功都记 `unknownRuns` —— 付费模型下这是
 *     正常语义（本地无公式，只能记未知），免费 x0.00 模型下是**漏归类**。
 * 本文件钉修复后的行为：按实记模型查实时目录，免费记 `freeRuns`，其余记 `unknownRuns`。
 *
 * <p>★ 真库零写 ★：点火经 `seams.automationRun` 注入假实现，目录经 `seams.catalog`
 * 注入假目录；`createLiveCredits` 的 `connect` 直接抛（读数面永不联机），`recordRun`
 * 不 attach 宿主 ⇒ 无 settings 落盘。
 *
 * @module test/run-credits
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeRunTool, multiplierOfUsedModel } from '../src/host/tools/run.js';
import { createLiveCredits } from '../src/host/launch/live-credits.js';

const PROBE_OK = { installed: true, reason: 'ok' };

/** 假目录：hy3 = x0.00 免费（真机归一形状 `session/new` 那一份），另含付费与未知条目。 */
function fakeCatalog() {
  return {
    projection: () => ({
      available: true,
      cost: {
        models: [
          { modelId: 'hy3', factor: 0 },
          { modelId: 'hy3-x', factor: 0.05 },
          { modelId: 'kimi-k3-1', factor: 1.62 },
          { modelId: 'weird', factor: null },
        ],
      },
    }),
  };
}

/** 永不联机的积分实例：只验计数器，不读真值。 */
function testCredits() {
  return createLiveCredits({
    ns: 'test-run-credits',
    read: () => ({}),
    connect: async () => { throw new Error('no-live-read-in-test'); },
  });
}

function harness({ usedModelId, status = 'completed', catalog = fakeCatalog() } = {}) {
  const runtime = {
    notes: [],
    detected: () => PROBE_OK,
    awaitDetection: async () => PROBE_OK,
    inFlightCount: () => 0,
    start: () => {}, finish: () => {}, forget: () => {},
    noteRun: (rec) => { runtime.notes.push(rec); },
    registry: () => undefined,
    setRegistry: () => {},
  };
  const handles = [];
  const jobs = { start(spec) { handles.push(spec.run()); return `job-${handles.length}`; } };
  const sessions = {
    createKey: () => 'auto-1',
    resumable: () => null,
    adopt: () => ({ ok: true }),
  };
  const credits = testCredits();
  const automation = {
    reason: status === 'completed' ? null : 'task_error',
    automationId: 'automation-1', conversationId: 'conv-1', sessionId: 'conv-1',
    retired: true, transcriptPath: null, reply: 'REPLY',
    creditsUsed: null, model: usedModelId ?? null, permission: null,
    usedModelId: usedModelId ?? null, phases: [],
  };
  const tool = makeRunTool(
    runtime, sessions,
    () => ({ enabled: true, model: '', effort: '', cwdRoot: 'C:/repo', boundSessionId: '' }),
    { jobs, subprocess: {} },
    credits, null,
    {
      automationRun: () => ({
        cancel: () => {},
        done: Promise.resolve({ status, detail: 'REPLY', exitCode: status === 'completed' ? 0 : 1, automation }),
        readOutput: () => 'REPLY',
      }),
      catalog,
    },
  );
  return { tool, handles, credits };
}

async function runOnce(h, args = { prompt: 'x', session_key: 'K' }) {
  await h.tool.execute(args, { signal: new AbortController().signal });
  await h.handles[0].done;
  return h.credits.projection().counters;
}

// ── 纯函数：multiplierOfUsedModel ─────────────────────────────────────────────

test('命中免费模型 ⇒ 0（不是 null：0 是"免费"这个已知事实）', () => {
  assert.equal(multiplierOfUsedModel('hy3', fakeCatalog().projection()), 0);
});

test('命中付费模型 ⇒ 原值', () => {
  assert.equal(multiplierOfUsedModel('hy3-x', fakeCatalog().projection()), 0.05);
  assert.equal(multiplierOfUsedModel('kimi-k3-1', fakeCatalog().projection()), 1.62);
});

test('★ 未命中 / factor 非有限数 / 目录缺席 ⇒ null（未知，绝不猜成 0）', () => {
  const cat = fakeCatalog().projection();
  assert.equal(multiplierOfUsedModel('ghost-9', cat), null, '目录里没有 ⇒ 未知');
  assert.equal(multiplierOfUsedModel('weird', cat), null, 'factor 本来就是 null ⇒ 未知');
  assert.equal(multiplierOfUsedModel('hy3', { cost: null }), null, '目录冷启动 ⇒ 未知');
  assert.equal(multiplierOfUsedModel('hy3', null), null);
  assert.equal(multiplierOfUsedModel('hy3', undefined), null);
  assert.equal(multiplierOfUsedModel('', cat), null, '空模型 id ⇒ 未知');
  assert.equal(multiplierOfUsedModel(null, cat), null, '模型缺席 ⇒ 未知，不猜');
  assert.equal(multiplierOfUsedModel(undefined, cat), null);
});

// ── 接线：收口记账 ───────────────────────────────────────────────────────────

test('★★ 免费轮（hy3 x0.00）⇒ freeRuns=1，unknownRuns=0（旧行为记成 unknownRuns=1）', async () => {
  const c = await runOnce(harness({ usedModelId: 'hy3' }));
  assert.equal(c.runs, 1);
  assert.equal(c.freeRuns, 1, 'x0.00 是平台赠送的事实，必须记 freeRuns');
  assert.equal(c.unknownRuns, 0, '★ 旧行为这里是 1（漏归类），修后必须归零');
  assert.equal(c.failedRuns, 0);
});

test('付费轮（kimi-k3-1 x1.62）⇒ unknownRuns=1（本地无公式，这是正常语义）', async () => {
  const c = await runOnce(harness({ usedModelId: 'kimi-k3-1' }));
  assert.equal(c.runs, 1);
  assert.equal(c.freeRuns, 0);
  assert.equal(c.unknownRuns, 1, '付费轮记 unknownRuns 是设计（结算在平台侧），不是缺陷');
});

test('目录里没有该模型 ⇒ unknownRuns=1（未知，不谎报免费）', async () => {
  const c = await runOnce(harness({ usedModelId: 'ghost-9' }));
  assert.equal(c.runs, 1);
  assert.equal(c.freeRuns, 0, '★ 没查到倍率就记免费，会把"不知道"读成"不花钱"');
  assert.equal(c.unknownRuns, 1);
});

test('实记模型缺席（usedModelId/model 全 null）⇒ unknownRuns=1', async () => {
  const c = await runOnce(harness({ usedModelId: null }));
  assert.equal(c.runs, 1);
  assert.equal(c.freeRuns, 0);
  assert.equal(c.unknownRuns, 1);
});

test('失败轮 ⇒ failedRuns=1，runs/freeRuns/unknownRuns 全不动', async () => {
  const c = await runOnce(harness({ usedModelId: 'hy3', status: 'failed' }));
  assert.equal(c.runs, 0);
  assert.equal(c.freeRuns, 0);
  assert.equal(c.unknownRuns, 0);
  assert.equal(c.failedRuns, 1);
});

test('★ 负控：目录抛错 ⇒ 仍收敛成 unknownRuns=1，不打穿收口', async () => {
  const broken = { projection: () => { throw new Error('catalog boom'); } };
  const c = await runOnce(harness({ usedModelId: 'hy3', catalog: broken }));
  assert.equal(c.runs, 1);
  assert.equal(c.unknownRuns, 1, '目录读不到 ⇒ 未知，不改判成败');
});
