/**
 * 防裁剪与分节过滤回归测试套件 (status-anti-prune.test.js)
 *
 * 验证目标 (R1 - R4):
 * 1. R1 分节选择器 (section): 支持 all / overview / models / credits / sessions / checkin。
 *    每个切片载荷体积严格 <= 2KB (2048 字节)。未知参数提供清晰指导。
 * 2. R2 紧凑模式 (compact): models 映射为 { [modelId]: factor } 紧凑字典，43+ 模型体积严格 <= 1KB (1024 字节)。
 * 3. R3 顶层余额 (balance / creditsRemain): 直读 live-credits 服务，显式区分于 checkin 签到积分。
 * 4. R4 防裁剪布局: 核心高频字段坐镇顶层/底层安全边际，中部容纳大对象。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';

import { makeStatusTool, buildCompactModelsDict } from '../src/host/tools/status.js';
import { TOOL_STATUS } from '../src/shared/constants.js';

// 模拟 runtime SSOT
function createMockRuntime({ registry = 'REGISTERED', detected = null, inFlight = [], lastRun = null } = {}) {
  return {
    registry: () => registry,
    registrationError: () => null,
    detected: () => detected,
    inFlight: () => inFlight,
    lastRun: () => lastRun,
    probe: async () => {},
  };
}

// 模拟 live-credits 服务
function createMockCredits({ remain = 479.13, totalUsed = 520.87, total = 1000.0, unit = 'credits', ok = true } = {}) {
  return {
    projection: () => ({
      ok,
      source: 'live',
      remain,
      totalUsed,
      total,
      unit,
      isPaidUser: true,
      stale: false,
      packages: [
        {
          PackageCode: 'TCACA_PREVIEW',
          CapacityUnit: unit,
          CycleTotalCapacity: String(total),
          CycleRemainCapacity: String(remain),
          CycleUsedCapacity: String(totalUsed),
        },
      ],
      error: null,
      counters: { runs: 5, freeRuns: 2, unknownRuns: 3, failedRuns: 0 },
    }),
    refresh: async () => {},
    recordRun: () => {},
  };
}

// 模拟 daily-checkin 服务
function createMockCheckin({ active = true, todayCheckedIn = true, streakDays = 7, todayCredit = 100, totalCredits = 800 } = {}) {
  return {
    projection: () => ({
      ok: true,
      active,
      todayCheckedIn,
      streakDays,
      dailyCredit: 100,
      todayCredit,
      totalCredits,
      endTime: '2026-10-31T23:59:59Z',
      autoClaim: true,
    }),
  };
}

// 模拟 sessions 映射
function createMockSessions(list = []) {
  return {
    list: () => list,
  };
}

test('R1: makeStatusTool 声明 parameters 与 output.schema 契约', () => {
  const runtime = createMockRuntime();
  const tool = makeStatusTool(runtime, () => ({}), {});

  assert.equal(tool.name, TOOL_STATUS);
  assert.equal(tool.parameters.properties.reprobe.type, 'boolean');
  assert.equal(tool.parameters.properties.section.type, 'string');
  assert.equal(tool.parameters.properties.compact.type, 'boolean');

  assert.equal(tool.output.schema.type, 'object');
  assert.equal(tool.output.schema.additionalProperties, false);
  assert.ok(tool.output.schema.properties.balance, 'output.schema 应包含 balance 声明');
  assert.ok(tool.output.schema.properties.creditsRemain, 'output.schema 应包含 creditsRemain 声明');

  // ★ 2026-10-10 schema 违约修复的三条声明面契约：
  //   ① section 切片回传的 `section` 键必须被声明（枚举与实现合法值一致）；
  //   ② models 放宽为 oneOf（string array ∨ 紧凑字典对象）——切片/compact 形状也合法；
  //   ③ 顶层 required 只钉跨分支不变量 balance / creditsRemain（子集切片才能合法）。
  assert.deepEqual(
    tool.output.schema.properties.section.enum,
    ['all', 'overview', 'models', 'credits', 'sessions', 'checkin'],
    'section 必须被声明且枚举与实现一致',
  );
  assert.deepEqual(
    tool.output.schema.properties.models.oneOf?.map((b) => b.type),
    ['array', 'object'],
    'models 必须是 array ∨ object 的 oneOf',
  );
  assert.deepEqual(
    [...tool.output.schema.required].sort(),
    ['balance', 'creditsRemain'],
    '顶层 required 只保留跨分支不变量',
  );
  for (const sliced of ['count', 'credits', 'checkinCredits', 'distinction', 'error', 'message', 'supportedSections']) {
    assert.ok(tool.output.schema.properties[sliced], `切片/兜底分支字段 ${sliced} 必须被声明（additionalProperties:false）`);
  }
});

test('R1: 未传参 execute({}) 保持 100% 向后兼容与全量字段回显', async () => {
  const runtime = createMockRuntime();
  const credits = createMockCredits({ remain: 350.5 });
  const checkin = createMockCheckin({ totalCredits: 700 });
  const tool = makeStatusTool(runtime, () => ({ model: 'fast-model' }), {}, null, null, checkin, credits);

  const res = await tool.execute({});

  // 16 个传统顶层契约字段完整在场
  const legacyKeys = [
    'registry', 'registrationError', 'probe', 'config', 'permission', 'effort',
    'models', 'modelsSource', 'cost', 'checkin', 'cdp', 'ignition', 'account',
    'sessions', 'inFlight', 'lastRun',
  ];
  for (const key of legacyKeys) {
    assert.ok(Object.prototype.hasOwnProperty.call(res, key), `向后兼容必须包含字段 ${key}`);
  }

  // 新增顶层余额字段
  assert.equal(res.balance, 350.5);
  assert.equal(res.creditsRemain, 350.5);
  assert.equal(Array.isArray(res.models), true, '默认非 compact 模式下 models 仍为数组');

  // Schema 严格校验零违规
  const violations = validateJsonSchemaValue(tool.output.schema, res, 'workbuddy_status');
  assert.deepEqual(violations, [], 'execute({}) 载荷必须完全符合 output.schema');
});

test('R1: 全部分支载荷（all / all+compact / 五个切片 / invalid_section 兜底）零 schema 违约', async () => {
  // ★ 2026-10-10 缺陷回归钉：修复前，section 切片报 "value.section is not a declared
  //   property (additionalProperties: false)" / "missing required property ..."，
  //   models 切片与 compact=true 报 "value.models must be an array"。本用例把**每个**
  //   返回分支的实载荷交给官方校验器（与 DSH 宿主同一实现）逐字验收。
  const runtime = createMockRuntime();
  const credits = createMockCredits({ remain: 479.13 });
  const checkin = createMockCheckin({ totalCredits: 800 });
  const mockSessions = createMockSessions([
    { key: 'k-1', cliSessionId: 'sess-abc-1', lastUsedAt: 1700000000 },
  ]);
  const tool = makeStatusTool(runtime, () => ({ model: 'fast-model' }), {}, mockSessions, null, checkin, credits);

  const branches = [
    ['all（默认全量）', {}],
    ['all + compact=true（models 为字典）', { compact: true }],
    ['section=overview', { section: 'overview' }],
    ['section=models', { section: 'models' }],
    ['section=credits', { section: 'credits' }],
    ['section=sessions', { section: 'sessions' }],
    ['section=checkin', { section: 'checkin' }],
    ['invalid_section 兜底', { section: 'no_such_slice' }],
  ];

  for (const [label, args] of branches) {
    const res = await tool.execute(args);
    const violations = validateJsonSchemaValue(tool.output.schema, res, 'workbuddy_status');
    assert.deepEqual(violations, [], `分支 ${label} 的载荷必须完全落在声明的 output.schema 内`);
  }
});

test('R1: section=overview 切片过滤且体积严格 <= 2KB', async () => {
  const runtime = createMockRuntime();
  const credits = createMockCredits({ remain: 479.13 });
  const checkin = createMockCheckin({ totalCredits: 800 });
  const tool = makeStatusTool(runtime, () => ({ model: 'balanced-model' }), {}, null, null, checkin, credits);

  const res = await tool.execute({ section: 'overview' });

  assert.equal(res.section, 'overview');
  assert.equal(res.registry, 'REGISTERED');
  assert.equal(res.balance, 479.13);
  assert.equal(res.creditsRemain, 479.13);
  assert.ok(res.account);
  assert.ok(res.config);
  assert.ok(res.checkin);
  assert.ok(res.permission);
  assert.equal(res.cost, undefined, 'overview 切片不得包含沉重的 cost 大对象');
  assert.equal(res.models, undefined, 'overview 切片不得包含庞大的 models 列表');

  const jsonBytes = Buffer.byteLength(JSON.stringify(res, null, 2));
  assert.ok(jsonBytes <= 2048, `overview 切片体积 (${jsonBytes} 字节) 必须 <= 2048 字节`);
});

test('R1: section=models 切片且 compact 字典体积严格 <= 1KB', async () => {
  const runtime = createMockRuntime();
  const credits = createMockCredits();
  const tool = makeStatusTool(runtime, () => ({}), {}, null, null, null, credits);

  const res = await tool.execute({ section: 'models' });

  assert.equal(res.section, 'models');
  assert.equal(typeof res.models, 'object');
  assert.equal(Array.isArray(res.models), false, 'models 切片必须返回字典映射');
  assert.ok(res.count > 0, '模型总数应大于 0');

  // 验证倍率真值解析
  if ('fast-model' in res.models) assert.equal(res.models['fast-model'], 0.21);
  if ('deep-model' in res.models) assert.equal(res.models['deep-model'], 1.2);

  const dictBytes = Buffer.byteLength(JSON.stringify(res.models));
  assert.ok(dictBytes <= 1024, `models 紧凑字典体积 (${dictBytes} 字节) 必须严格 <= 1024 字节 (1KB)`);

  const totalBytes = Buffer.byteLength(JSON.stringify(res, null, 2));
  assert.ok(totalBytes <= 2048, `models 切片总载荷 (${totalBytes} 字节) 必须严格 <= 2048 字节 (2KB)`);
});

test('R1: section=credits 切片且体积严格 <= 2KB', async () => {
  const runtime = createMockRuntime();
  const credits = createMockCredits({ remain: 123.45 });
  const checkin = createMockCheckin({ totalCredits: 500 });
  const tool = makeStatusTool(runtime, () => ({}), {}, null, null, checkin, credits);

  const res = await tool.execute({ section: 'credits' });

  assert.equal(res.section, 'credits');
  assert.equal(res.balance, 123.45);
  assert.equal(res.creditsRemain, 123.45);
  assert.equal(res.checkinCredits, 500);
  assert.ok(res.credits);
  assert.ok(res.distinction, '必须明确解释 balance 与 checkinCredits 的语义区分');

  const totalBytes = Buffer.byteLength(JSON.stringify(res, null, 2));
  assert.ok(totalBytes <= 2048, `credits 切片总载荷 (${totalBytes} 字节) 必须严格 <= 2048 字节 (2KB)`);
});

test('R1: section=checkin 切片且体积严格 <= 2KB', async () => {
  const runtime = createMockRuntime();
  const credits = createMockCredits({ remain: 999.0 });
  const checkin = createMockCheckin({ streakDays: 14, totalCredits: 1400 });
  const tool = makeStatusTool(runtime, () => ({}), {}, null, null, checkin, credits);

  const res = await tool.execute({ section: 'checkin' });

  assert.equal(res.section, 'checkin');
  assert.equal(res.balance, 999.0);
  assert.equal(res.checkin.streakDays, 14);
  assert.equal(res.checkin.totalCredits, 1400);

  const totalBytes = Buffer.byteLength(JSON.stringify(res, null, 2));
  assert.ok(totalBytes <= 2048, `checkin 切片总载荷 (${totalBytes} 字节) 必须严格 <= 2048 字节 (2KB)`);
});

test('R1: section=sessions 切片且体积严格 <= 2KB', async () => {
  const runtime = createMockRuntime();
  const sampleSessions = [
    { key: 'k-1', cliSessionId: 'sess-abc-1', lastUsedAt: 1700000000 },
    { key: 'k-2', cliSessionId: 'sess-abc-2', lastUsedAt: 1690000000 },
  ];
  const tool = makeStatusTool(runtime, () => ({}), {}, createMockSessions(sampleSessions));

  const res = await tool.execute({ section: 'sessions' });

  assert.equal(res.section, 'sessions');
  assert.ok(Array.isArray(res.sessions));
  assert.equal(res.sessions.length, 2);
  assert.equal(res.sessions[0].session_key, 'k-1');

  const totalBytes = Buffer.byteLength(JSON.stringify(res, null, 2));
  assert.ok(totalBytes <= 2048, `sessions 切片总载荷 (${totalBytes} 字节) 必须严格 <= 2048 字节 (2KB)`);
});

test('R1: section=sessions 切片在 20, 50, 200 条会话下严格截断至 10 条且保留降序与体积 <= 1.5KB / <= 2KB', async () => {
  const runtime = createMockRuntime();

  for (const count of [20, 50, 200]) {
    const sampleSessions = Array.from({ length: count }, (_, i) => ({
      key: `k-workspace-item-${i}`,
      cliSessionId: `sess-${String(i).padStart(4, '0')}-0000-1111-2222-333344445555`,
      lastUsedAt: 1712600000000 - i * 60000,
      outputBytes: 2048,
      unconfirmed: false,
    }));

    const tool = makeStatusTool(runtime, () => ({}), {}, createMockSessions(sampleSessions));
    const res = await tool.execute({ section: 'sessions' });

    assert.equal(res.section, 'sessions');
    assert.equal(res.sessions.length, 10, `count=${count} 时必须严格截断至 10 条`);

    // 验证保留降序排列 (descending sort order by last_used_at)
    for (let j = 0; j < res.sessions.length - 1; j++) {
      assert.ok(
        res.sessions[j].last_used_at >= res.sessions[j + 1].last_used_at,
        `count=${count} 时第 ${j} 项 (${res.sessions[j].last_used_at}) 应 >= 第 ${j + 1} 项 (${res.sessions[j + 1].last_used_at})`,
      );
    }
    assert.equal(res.sessions[0].session_key, 'k-workspace-item-0');
    assert.equal(res.sessions[9].session_key, 'k-workspace-item-9');

    const compactBytes = Buffer.byteLength(JSON.stringify(res));
    const prettyBytes = Buffer.byteLength(JSON.stringify(res, null, 2));

    assert.ok(
      compactBytes <= 1536,
      `count=${count} 紧凑载荷 (${compactBytes} 字节) 必须严格 <= 1536 字节 (1.5KB)`,
    );
    assert.ok(
      prettyBytes <= 2048,
      `count=${count} 格式化载荷 (${prettyBytes} 字节) 必须严格 <= 2048 字节 (2KB)`,
    );
  }
});

test('R1: 未知参数提供清晰参数指引与宽容回退', async () => {
  const runtime = createMockRuntime();
  const credits = createMockCredits({ remain: 50.0 });
  const tool = makeStatusTool(runtime, () => ({}), {}, null, null, null, credits);

  const res = await tool.execute({ section: 'non_existent_section' });

  assert.equal(res.error, 'invalid_section');
  assert.match(res.message, /Unknown section 'non_existent_section'/);
  assert.deepEqual(res.supportedSections, ['all', 'overview', 'models', 'credits', 'sessions', 'checkin']);
  assert.equal(res.balance, 50.0);
  assert.equal(res.registry, 'REGISTERED');
});

test('R2: buildCompactModelsDict 算法提取与极限压缩测试', () => {
  const costModels = [
    { modelId: 'fast-model', factor: 0.21 },
    { modelId: 'deep-model', factor: 1.2 },
    { modelId: 'free-model', factor: 0 },
    { modelId: 'unknown-model', factor: null },
  ];
  const catalogModels = [{ id: 'extra-model' }];

  const dict = buildCompactModelsDict(costModels, catalogModels);
  assert.equal(dict['fast-model'], 0.21);
  assert.equal(dict['deep-model'], 1.2);
  assert.equal(dict['free-model'], 0);
  assert.equal(dict['unknown-model'], null);
  assert.equal(dict['extra-model'], null);

  // 46 个真实/权威模型紧凑压缩测试 (Survey 1 / Spec Miner 权威基线)
  const realisticModelIds = [
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
  const realisticList = realisticModelIds.map((id, i) => ({ modelId: id, factor: i % 2 === 0 ? 0.25 : null }));
  const realisticDict = buildCompactModelsDict(realisticList);
  assert.equal(Object.keys(realisticDict).length, 46);
  const realisticBytes = Buffer.byteLength(JSON.stringify(realisticDict));
  assert.ok(realisticBytes <= 1024, `46 个真实模型的紧凑字典 (${realisticBytes} 字节) 必须严格 <= 1024 字节 (1KB)`);
});

test('R2: compact=true 在 section=all 时将 models 格式化为倍率字典', async () => {
  const runtime = createMockRuntime();
  const tool = makeStatusTool(runtime, () => ({}), {});

  const res = await tool.execute({ compact: true });

  assert.equal(typeof res.models, 'object');
  assert.equal(Array.isArray(res.models), false);
  const dictBytes = Buffer.byteLength(JSON.stringify(res.models));
  assert.ok(dictBytes <= 1024, `compact models 字典大小 (${dictBytes} 字节) 必须严格 <= 1024 字节`);
});

test('R3: 顶层 balance / creditsRemain 暴露且与 checkin.totalCredits 严格区分', async () => {
  const runtime = createMockRuntime();
  const credits = createMockCredits({ remain: 888.88 });
  const checkin = createMockCheckin({ totalCredits: 1200 });
  const tool = makeStatusTool(runtime, () => ({}), {}, null, null, checkin, credits);

  const res = await tool.execute({});

  assert.equal(res.balance, 888.88, 'balance 必须如实反映实时账户余额');
  assert.equal(res.creditsRemain, 888.88, 'creditsRemain 必须如实反映实时账户余额');
  assert.equal(res.checkin.totalCredits, 1200, 'checkin.totalCredits 为签到累计积分');
  assert.notEqual(res.balance, res.checkin.totalCredits, '账户余额绝不可与签到积分混淆');
});

test('R3: credits 服务缺省或未接线时优雅回落为 null', async () => {
  const runtime = createMockRuntime();
  const tool = makeStatusTool(runtime, () => ({}), {}, null, null, null, null);

  const res = await tool.execute({});

  assert.equal(res.balance, null);
  assert.equal(res.creditsRemain, null);
});

test('R4: 回执键位顺序防裁剪安全周边布局验证', async () => {
  const runtime = createMockRuntime();
  const credits = createMockCredits();
  const tool = makeStatusTool(runtime, () => ({}), {}, null, null, null, credits);

  const res = await tool.execute({});
  const keys = Object.keys(res);

  // 顶部安全区验证 (必须前 6 位包含核心定位)
  const topSlice = keys.slice(0, 6);
  assert.ok(topSlice.includes('registry'), 'registry 必须位于顶部安全区');
  assert.ok(topSlice.includes('account'), 'account 必须位于顶部安全区');
  assert.ok(topSlice.includes('balance'), 'balance 必须位于顶部安全区');
  assert.ok(topSlice.includes('creditsRemain'), 'creditsRemain 必须位于顶部安全区');

  // 易裁剪中部包含大对象
  const modelsIdx = keys.indexOf('models');
  const costIdx = keys.indexOf('cost');
  assert.ok(modelsIdx > 6, 'models 应置于中部');
  assert.ok(costIdx > 6, 'cost 应置于中部');

  // 底部安全区验证 (最后 3 位包含 sessions / inFlight / lastRun)
  const bottomSlice = keys.slice(-3);
  assert.ok(bottomSlice.includes('sessions'), 'sessions 必须位于底部安全区');
  assert.ok(bottomSlice.includes('inFlight'), 'inFlight 必须位于底部安全区');
  assert.ok(bottomSlice.includes('lastRun'), 'lastRun 必须位于底部安全区');
});
