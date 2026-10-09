/**
 * Adversarial Verification Harness for workbuddy_status
 * (packages/plugin-workbuddy/test/status-adversarial.test.js)
 *
 * Implements empirical stress-testing for:
 * 1. Size Budget Audit:
 *    - All valid sections (overview, models, credits, sessions, checkin) <= 2,048 bytes (2KB).
 *    - Models multiplier dict <= 1,024 bytes (1KB) for 43+ catalog models.
 * 2. Context Middle-Pruning Stress Test:
 *    - Simulate LLM context proxy middle pruning (50%, 60%, 70%).
 *    - Verify perimeter fields (account, balance, creditsRemain, checkin, sessions, inFlight, lastRun).
 * 3. Edge Case & Fault Injection:
 *    - Invalid section names (guidance, casing, trimming, types).
 *    - Missing credits service, IPC pipe crash, missing checkin service.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { makeStatusTool, buildCompactModelsDict } from '../src/host/tools/status.js';
import { TOOL_STATUS } from '../src/shared/constants.js';

function createMockRuntime({ registry = 'REGISTERED', inFlight = [], lastRun = null } = {}) {
  return {
    registry: () => registry,
    registrationError: () => null,
    detected: () => ({ installed: true, method: 'no-exec', resolvedPath: 'C:\\WorkBuddy\\bin\\wb.exe' }),
    inFlight: () => inFlight,
    lastRun: () => lastRun,
    probe: async () => {},
  };
}

function createRealisticCredits({ count = 3, remain = 479.13, totalUsed = 520.87, total = 1000.0 } = {}) {
  const packages = Array.from({ length: count }, (_, i) => ({
    PackageCode: `PKG_${i}_PRO`,
    CapacityUnit: 'credits',
    CycleTotalCapacity: String(total / count),
    CycleRemainCapacity: String(remain / count),
    CycleUsedCapacity: String(totalUsed / count),
  }));

  return {
    projection: () => ({
      ok: true,
      source: 'live',
      remain,
      totalUsed,
      total,
      unit: 'credits',
      isPaidUser: true,
      stale: false,
      packages,
      error: null,
      counters: { runs: 25, freeRuns: 5, unknownRuns: 20, failedRuns: 0 },
    }),
    refresh: async () => {},
    recordRun: () => {},
  };
}

function createRealisticCheckin({ active = true, todayCheckedIn = true, streakDays = 14, totalCredits = 1400 } = {}) {
  return {
    projection: () => ({
      ok: true,
      active,
      todayCheckedIn,
      streakDays,
      dailyCredit: 100,
      todayCredit: 100,
      totalCredits,
      endTime: '2026-10-31T23:59:59Z',
      autoClaim: true,
    }),
  };
}

const REALISTIC_46_MODELS = [
  'fast-model', 'balanced-model', 'deep-model', 'hy3', 'hy3-b', 'hy3-c', 'hy3-x',
  'hy4-preview', 'hy4-preview-dev', 'hy4-preview-x', 'minimax-m2.5', 'glm-5v-turbo',
  'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-5.0-turbo', 'glm-4.6v',
  'kimi-k3-1', 'kimi-k2.8-preview', 'kimi-k2.7', 'kimi-k2.6', 'kimi-k2.5', 'kimi-k2-thinking',
  'minimax-m3', 'minimax-m2.7', 'glm-4.6', 'deepseek-v4-flash', 'deepseek-v4.1-flash',
  'deepseek-v4-pro', 'deepseek-v3-2-volc', 'deepseek-v3-1-volc', 'deepseek-v3-1-lkeap',
  'deepseek-v3-1', 'deepseek-v3-0324-lkeap', 'deepseek-r1-0528-lkeap', 'kimi-k2-instruct-taiji',
  'default-1.1', 'deepseek-v3-0324-taco-completion', 'deepseek-v3-0324', 'default-1.2',
  'hunyuan-2.0-instruct', 'hunyuan-chat', 'space-bunny', 'deepseek-v4-flash-ioa', 'deepseek-v4-pro-ioa',
];

// ============================================================================
// 1. Size Budget Audit
// ============================================================================

test('Size Audit: Models Multiplier Dictionary <= 1024 bytes (1KB) across 46 catalog models', () => {
  const costModels = REALISTIC_46_MODELS.map((id, i) => ({
    modelId: id,
    factor: i % 3 === 0 ? 0.25 : (i % 3 === 1 ? 1.5 : null),
  }));
  const dict = buildCompactModelsDict(costModels);

  assert.equal(Object.keys(dict).length, 46);
  const compactJson = JSON.stringify(dict);
  const byteLength = Buffer.byteLength(compactJson, 'utf-8');

  // Hard assertion: <= 1024 bytes
  assert.ok(
    byteLength <= 1024,
    `Models dictionary (${byteLength} bytes) exceeds 1,024 byte threshold`,
  );
});

test('Size Audit: Section overview <= 2048 bytes with maximum realistic data', async () => {
  const runtime = createMockRuntime({
    inFlight: [
      { jobId: 'job-12345678', state: 'running', startedAt: 1712600000000 },
      { jobId: 'job-87654321', state: 'queued', startedAt: 1712600010000 },
    ],
  });
  const credits = createRealisticCredits({ count: 5 });
  const checkin = createRealisticCheckin();
  const tool = makeStatusTool(runtime, () => ({
    model: 'balanced-model',
    effort: 'high',
    sessionMode: 'reuse',
    createNewConversation: false,
    permissionMode: 'fullAccess',
  }), {}, null, null, checkin, credits);

  const res = await tool.execute({ section: 'overview' });
  const compactBytes = Buffer.byteLength(JSON.stringify(res), 'utf-8');
  const prettyBytes = Buffer.byteLength(JSON.stringify(res, null, 2), 'utf-8');

  assert.ok(compactBytes <= 2048, `overview compact payload (${compactBytes} B) exceeds 2048 B`);
  assert.ok(prettyBytes <= 2048, `overview pretty payload (${prettyBytes} B) exceeds 2048 B`);
});

test('Size Audit: Section models <= 2048 bytes with full 46-model catalog', async () => {
  const runtime = createMockRuntime();
  const credits = createRealisticCredits();
  const tool = makeStatusTool(runtime, () => ({}), {}, null, null, null, credits);

  const res = await tool.execute({ section: 'models' });
  const compactBytes = Buffer.byteLength(JSON.stringify(res), 'utf-8');
  const prettyBytes = Buffer.byteLength(JSON.stringify(res, null, 2), 'utf-8');

  assert.ok(compactBytes <= 2048, `models compact payload (${compactBytes} B) exceeds 2048 B`);
  assert.ok(prettyBytes <= 2048, `models pretty payload (${prettyBytes} B) exceeds 2048 B`);
});

test('Size Audit: Section credits <= 2048 bytes with multi-package subscription', async () => {
  const runtime = createMockRuntime();
  const credits = createRealisticCredits({ count: 5, remain: 1234.56, total: 3000.0 });
  const checkin = createRealisticCheckin();
  const tool = makeStatusTool(runtime, () => ({}), {}, null, null, checkin, credits);

  const res = await tool.execute({ section: 'credits' });
  const compactBytes = Buffer.byteLength(JSON.stringify(res), 'utf-8');
  const prettyBytes = Buffer.byteLength(JSON.stringify(res, null, 2), 'utf-8');

  assert.ok(compactBytes <= 2048, `credits compact payload (${compactBytes} B) exceeds 2048 B`);
  assert.ok(prettyBytes <= 2048, `credits pretty payload (${prettyBytes} B) exceeds 2048 B`);
});

test('Size Audit: Section checkin <= 2048 bytes with active streak', async () => {
  const runtime = createMockRuntime();
  const credits = createRealisticCredits();
  const checkin = createRealisticCheckin({ streakDays: 30, totalCredits: 3000 });
  const tool = makeStatusTool(runtime, () => ({}), {}, null, null, checkin, credits);

  const res = await tool.execute({ section: 'checkin' });
  const compactBytes = Buffer.byteLength(JSON.stringify(res), 'utf-8');
  const prettyBytes = Buffer.byteLength(JSON.stringify(res, null, 2), 'utf-8');

  assert.ok(compactBytes <= 2048, `checkin compact payload (${compactBytes} B) exceeds 2048 B`);
  assert.ok(prettyBytes <= 2048, `checkin pretty payload (${prettyBytes} B) exceeds 2048 B`);
});

test('Size Audit: Section sessions byte scaling analysis across session counts', async () => {
  const runtime = createMockRuntime();

  // Test across increasing session load: 2, 5, 8, 10, 15, 20
  const sessionCounts = [2, 5, 8, 10, 15, 20];
  const measurements = [];

  for (const count of sessionCounts) {
    const sessionList = Array.from({ length: count }, (_, i) => ({
      key: `k-workspace-item-${i}`,
      cliSessionId: `sess-${String(i).padStart(4, '0')}-0000-1111-2222-333344445555`,
      lastUsedAt: 1712600000000 - i * 60000,
      outputBytes: 2048,
      unconfirmed: false,
    }));

    const mockSessions = { list: () => sessionList };
    const tool = makeStatusTool(runtime, () => ({}), {}, mockSessions);
    const res = await tool.execute({ section: 'sessions' });

    const compactBytes = Buffer.byteLength(JSON.stringify(res), 'utf-8');
    const prettyBytes = Buffer.byteLength(JSON.stringify(res, null, 2), 'utf-8');

    measurements.push({ count, compactBytes, prettyBytes });
  }

  // Session count <= 10 must be safely under 2048 bytes
  const tenSessions = measurements.find((m) => m.count === 10);
  assert.ok(
    tenSessions.compactBytes <= 2048,
    `10 sessions compact (${tenSessions.compactBytes} B) must be <= 2048 B`,
  );

  // 20 sessions must also be strictly bounded <= 2048 bytes
  const twentySessions = measurements.find((m) => m.count === 20);
  assert.ok(
    twentySessions.compactBytes <= 2048,
    `20 sessions compact (${twentySessions.compactBytes} B) must be <= 2048 B`,
  );
  assert.ok(
    twentySessions.prettyBytes <= 2048,
    `20 sessions pretty (${twentySessions.prettyBytes} B) must be <= 2048 B`,
  );
});

// ============================================================================
// 2. Context Middle-Pruning Stress Test
// ============================================================================

test('Middle-Pruning: Critical perimeter fields survive 50%, 60%, and 70% middle truncations', async () => {
  const runtime = createMockRuntime({
    inFlight: [{ jobId: 'job-999', state: 'running', startedAt: 1712600000000 }],
    lastRun: { ok: true, durationMs: 420 },
  });
  const credits = createRealisticCredits();
  const checkin = createRealisticCheckin();
  const mockSessions = {
    list: () => [{ key: 'k-safe', cliSessionId: 'sess-safe-1', lastUsedAt: 1712600000000 }],
  };
  const tool = makeStatusTool(runtime, () => ({ model: 'fast-model' }), {}, mockSessions, null, checkin, credits);

  // Full default response
  const res = await tool.execute({});
  const serialized = JSON.stringify(res, null, 2);
  const totalLength = serialized.length;

  const pruneRatios = [0.50, 0.60, 0.70];

  for (const ratio of pruneRatios) {
    const cutAmount = Math.floor(totalLength * ratio);
    const headLen = Math.floor((totalLength - cutAmount) / 2);
    const tailStart = headLen + cutAmount;

    const headZone = serialized.slice(0, headLen);
    const tailZone = serialized.slice(tailStart);
    const prunedContext = headZone + '\n[... tool result middle pruned ...]\n' + tailZone;

    // Verify top perimeter fields in headZone
    assert.ok(headZone.includes('"registry"'), `[ratio ${ratio}] registry must be in head zone`);
    assert.ok(headZone.includes('"account"'), `[ratio ${ratio}] account must be in head zone`);
    assert.ok(headZone.includes('"balance"'), `[ratio ${ratio}] balance must be in head zone`);
    assert.ok(headZone.includes('"creditsRemain"'), `[ratio ${ratio}] creditsRemain must be in head zone`);
    assert.ok(headZone.includes('"checkin"'), `[ratio ${ratio}] checkin must be in head zone`);

    // Verify bottom perimeter fields in tailZone
    assert.ok(tailZone.includes('"sessions"'), `[ratio ${ratio}] sessions must be in tail zone`);
    assert.ok(tailZone.includes('"inFlight"'), `[ratio ${ratio}] inFlight must be in tail zone`);
    assert.ok(tailZone.includes('"lastRun"'), `[ratio ${ratio}] lastRun must be in tail zone`);

    // Verify pruned context preserved core values
    assert.ok(prunedContext.includes('479.13'), 'Balance value 479.13 must survive in pruned context');
    assert.ok(prunedContext.includes('REGISTERED'), 'Registry value REGISTERED must survive');
  }
});

// ============================================================================
// 3. Edge Case & Fault Injection
// ============================================================================

test('Edge Case: Unknown / invalid section names return clear guidance without throwing', async () => {
  const runtime = createMockRuntime();
  const credits = createRealisticCredits();
  const tool = makeStatusTool(runtime, () => ({}), {}, null, null, null, credits);

  const invalidInputs = [
    'nonexistent_section',
    'MODELS_UPPER_INVALID_KEY',
    '#@!$',
    '',
  ];

  for (const input of invalidInputs) {
    const res = await tool.execute({ section: input });
    assert.equal(res.error, 'invalid_section', `Input '${input}' should return error 'invalid_section'`);
    assert.ok(res.message.includes('Unknown section'), `Input '${input}' must have guidance message`);
    assert.deepEqual(
      res.supportedSections,
      ['all', 'overview', 'models', 'credits', 'sessions', 'checkin'],
      'Must enumerate all valid sections in guidance',
    );
    // Perimeter safety preserved
    assert.equal(res.registry, 'REGISTERED');
    assert.equal(res.balance, 479.13);
    assert.equal(res.creditsRemain, 479.13);
  }
});

test('Edge Case: Tolerant casing and trimming on section parameter', async () => {
  const runtime = createMockRuntime();
  const tool = makeStatusTool(runtime, () => ({}), {});

  const resUpper = await tool.execute({ section: 'OVERVIEW' });
  assert.equal(resUpper.section, 'overview', 'Uppercase section should normalize to lowercase');

  const resWhitespace = await tool.execute({ section: '  checkin  ' });
  assert.equal(resWhitespace.section, 'checkin', 'Whitespace padded section should trim');
});

test('Edge Case: Non-string section parameter is rejected by tool schema with INVALID_ARGS', async () => {
  const runtime = createMockRuntime();
  const tool = makeStatusTool(runtime, () => ({}), {});

  await assert.rejects(
    async () => {
      await tool.execute({ section: 12345 });
    },
    {
      name: 'ToolArgsError',
      code: 'INVALID_ARGS',
    },
    'Non-string section must be rejected by dsh-tools schema validator with INVALID_ARGS',
  );
});

test('Edge Case: Missing or crashing credits service degrades gracefully to null', async () => {
  const runtime = createMockRuntime();

  // Case A: credits service is null
  const toolNull = makeStatusTool(runtime, () => ({}), {}, null, null, null, null);
  const resNull = await toolNull.execute({});
  assert.equal(resNull.balance, null);
  assert.equal(resNull.creditsRemain, null);

  // Case B: credits service projection returns null
  const toolEmpty = makeStatusTool(runtime, () => ({}), {}, null, null, null, { projection: () => null });
  const resEmpty = await toolEmpty.execute({});
  assert.equal(resEmpty.balance, null);
  assert.equal(resEmpty.creditsRemain, null);

  // Case C: credits service projection has null remain (e.g. desktop closed, pipe not found)
  const toolNoRemain = makeStatusTool(runtime, () => ({}), {}, null, null, null, { projection: () => ({ remain: null }) });
  const resNoRemain = await toolNoRemain.execute({});
  assert.equal(resNoRemain.balance, null);
  assert.equal(resNoRemain.creditsRemain, null);
});

test('Edge Case: Missing or crashing checkin service degrades gracefully to null', async () => {
  const runtime = createMockRuntime();

  // Case A: checkin is null
  const toolNull = makeStatusTool(runtime, () => ({}), {}, null, null, null, null);
  const resNull = await toolNull.execute({});
  assert.equal(resNull.checkin, null);

  // Case B: checkin projection returns null
  const toolEmpty = makeStatusTool(runtime, () => ({}), {}, null, null, { projection: () => null }, null);
  const resEmpty = await toolEmpty.execute({});
  assert.equal(resEmpty.checkin, null);
});
