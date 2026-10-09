/**
 * Milestone 2 (R2) Disk Watch, Session Backfill & Transcript Artifact Extraction Stress Test Suite
 *
 * Empirical verification of:
 *   1. scanForNewSessionJsonl:
 *      - Concurrent files across same and fallback project directories
 *      - Boundary testing of ignitionMs - 2000ms window (threshold - 1s, exact, threshold + 1s)
 *      - Edge ignitionMs inputs (undefined, null, string, 0, clock skew)
 *      - Complex cwd paths (Chinese characters, spaces, directory fallback)
 *      - Resistance to noise, junk files, and malformed filenames
 *      - Cross-project concurrency isolation challenge
 *   2. sessionStore.adopt:
 *      - Captures true UUID upon disk watch discovery
 *      - Preserves UUID in memory and settings via loadSessionMap
 *      - Resumability and idempotency preserved across poll cycles
 *      - Protection against corruption from subsequent invalid adopt attempts
 *   3. extractTranscriptArtifacts:
 *      - Resilience against deep nesting, stringified JSON inputs, truncated lines, primitives
 *      - Extraction across all 21 candidate field variants and array properties
 *      - Deduplication and whitespace trimming
 *      - Empty file and missing file handling
 *      - [Bug Confirmation] Unhandled TypeError on null JSONL lines
 *
 * @module test/m2-disk-watch-stress.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  extractTranscriptArtifacts,
  readReplyFromTranscript,
  scanForNewSessionJsonl,
  slugForCwd,
  startAutomationRun,
} from '../src/host/gateway/automation.js';
import { loadSessionMap } from '../src/host/session/map.js';

function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), 'wb-m2-disk-watch-'));
  const db = new DatabaseSync(join(home, 'workbuddy.db'));
  db.exec(`CREATE TABLE automations (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL,
    schedule_type TEXT NOT NULL DEFAULT 'recurring', next_run_at INTEGER, last_run_at INTEGER,
    cwds TEXT NOT NULL DEFAULT '[]', rrule TEXT NOT NULL DEFAULT '', scheduled_at TEXT,
    valid_from TEXT, valid_until TEXT, model_id TEXT, model_is_thinking INTEGER NOT NULL DEFAULT 0,
    skills_json TEXT NOT NULL DEFAULT '[]', push_to_wechat INTEGER NOT NULL DEFAULT 0,
    push_to_wecom_bot INTEGER NOT NULL DEFAULT 0, owner_user_id TEXT,
    owner_status TEXT NOT NULL DEFAULT 'legacy_unassigned', owner_source TEXT,
    expert_id TEXT, expert_marketplace TEXT, connector_ids_json TEXT NOT NULL DEFAULT '[]',
    permission_mode TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
    wecom_bot_source TEXT, context_window TEXT, reasoning_effort TEXT);
    CREATE TABLE automation_runs (
    thread_id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, status TEXT NOT NULL, read_at TEXT,
    thread_title TEXT, source_cwd TEXT, runs_json TEXT, result_success INTEGER, metadata_json TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, failure_code TEXT, reason_code TEXT);
    CREATE TABLE automation_runtime_state (
    automation_id TEXT PRIMARY KEY, last_run_at INTEGER, last_error TEXT,
    running INTEGER NOT NULL DEFAULT 0, running_started_at INTEGER, running_conversation_id TEXT,
    metadata_json TEXT);
    CREATE TABLE sessions (
    id TEXT PRIMARY KEY, cwd TEXT, title TEXT, user_id TEXT, model TEXT, permission_mode TEXT,
    source_mode TEXT, is_background_automation INTEGER, session_settings TEXT, status TEXT,
    thought_level TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE session_usage (
    session_id TEXT PRIMARY KEY, used INTEGER, size INTEGER, credit_json TEXT);`);
  db.close();
  return home;
}

function useHome(home) {
  const previous = process.env.WORKBUDDY_HOME;
  process.env.WORKBUDDY_HOME = home;
  return () => {
    if (previous === undefined) delete process.env.WORKBUDDY_HOME;
    else process.env.WORKBUDDY_HOME = previous;
  };
}

function safeRm(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {}
}

function setFileMtime(filePath, mtimeMs) {
  const s = mtimeMs / 1000;
  utimesSync(filePath, s, s);
}

// ═══════════════════════════════════════════════════════════════════
// 1. scanForNewSessionJsonl Stress Tests
// ═══════════════════════════════════════════════════════════════════

test('1.1 scanForNewSessionJsonl: 应对同目录下多文件并发与递增 mtime，精准捕获最新会话', () => {
  const home = fixtureHome();
  const restore = useHome(home);
  try {
    const cwd = 'C:\\workspace\\concurrent-project';
    const projectDir = join(home, 'projects', slugForCwd(cwd));
    mkdirSync(projectDir, { recursive: true });

    const baseTime = Date.now() + 5000;
    const count = 30;
    let expectedCid = '';

    for (let i = 0; i < count; i++) {
      const hex = i.toString(16).padStart(4, '0');
      const cid = `00000000-0000-4000-8000-${hex}00000000`;
      const filePath = join(projectDir, `${cid}.jsonl`);
      writeFileSync(filePath, JSON.stringify({ index: i }) + '\n');
      setFileMtime(filePath, baseTime + i * 1000);
      expectedCid = cid;
    }

    const hit = scanForNewSessionJsonl(cwd, baseTime + 10_000);
    assert.ok(hit !== null, '应成功扫出有效会话');
    assert.equal(hit.conversationId, expectedCid, '必须准确选出 mtime 最大的最新会话');
    assert.equal(hit.path, join(projectDir, `${expectedCid}.jsonl`));
  } finally {
    restore();
    safeRm(home);
  }
});

test('1.2 scanForNewSessionJsonl: 严格验证 ignitionMs - 2000ms 临界时间窗口边界', () => {
  const home = fixtureHome();
  const restore = useHome(home);
  try {
    const cwd = 'C:\\workspace\\boundary-project';
    const projectDir = join(home, 'projects', slugForCwd(cwd));
    mkdirSync(projectDir, { recursive: true });

    const now = Date.now();
    const ignitionMs = now + 10_000;
    const threshold = ignitionMs - 2000; // now + 8_000

    const cidOld = '11111111-1111-4111-8111-111111111111';
    const cidBoundary = '22222222-2222-4222-8222-222222222222';
    const cidFresh = '33333333-3333-4333-8333-333333333333';

    const pOld = join(projectDir, `${cidOld}.jsonl`);
    const pBoundary = join(projectDir, `${cidBoundary}.jsonl`);
    const pFresh = join(projectDir, `${cidFresh}.jsonl`);

    // Case A: 仅有 threshold - 1000ms 的文件（小于阈值，应被丢弃忽略返回 null）
    writeFileSync(pOld, '{"role":"user"}\n');
    setFileMtime(pOld, threshold - 1000);
    const hitA = scanForNewSessionJsonl(cwd, ignitionMs);
    assert.equal(hitA, null, '早于 threshold 的文件不得被选为新会话');

    // Case B: 刚好处于 threshold 边界的文件（应被接纳）
    writeFileSync(pBoundary, '{"role":"user"}\n');
    setFileMtime(pBoundary, threshold);
    const hitB = scanForNewSessionJsonl(cwd, ignitionMs);
    assert.ok(hitB !== null, '处于 threshold 精确边界的文件必须被接纳');
    assert.equal(hitB.conversationId, cidBoundary);

    // Case C: threshold + 1000ms 的更新文件（覆盖边界文件成为最优）
    writeFileSync(pFresh, '{"role":"user"}\n');
    setFileMtime(pFresh, threshold + 1000);
    const hitC = scanForNewSessionJsonl(cwd, ignitionMs);
    assert.ok(hitC !== null);
    assert.equal(hitC.conversationId, cidFresh, '最新文件必须覆盖临界文件');
  } finally {
    restore();
    safeRm(home);
  }
});

test('1.3 scanForNewSessionJsonl: 极端/非法 ignitionMs 参数的自愈与防御性回退', () => {
  const home = fixtureHome();
  const restore = useHome(home);
  try {
    const cwd = 'C:\\workspace\\unusual-time-project';
    const projectDir = join(home, 'projects', slugForCwd(cwd));
    mkdirSync(projectDir, { recursive: true });

    const cid = '44444444-4444-4444-8444-444444444444';
    const filePath = join(projectDir, `${cid}.jsonl`);
    writeFileSync(filePath, '{"test":true}\n');

    // Case A: ignitionMs 为 undefined / null / 字符串时，平滑回落至 Date.now() - 2000
    const hitDef = scanForNewSessionJsonl(cwd, undefined);
    assert.ok(hitDef !== null, 'undefined ignitionMs 应回落到当前时间窗口成功扫出');
    assert.equal(hitDef.conversationId, cid);

    const hitNull = scanForNewSessionJsonl(cwd, null);
    assert.ok(hitNull !== null, 'null ignitionMs 应平滑回落');

    const hitStr = scanForNewSessionJsonl(cwd, '2026-10-09');
    assert.ok(hitStr !== null, '字符串 ignitionMs 应平滑回落');

    // Case B: ignitionMs 为 0 或 负数
    const hitZero = scanForNewSessionJsonl(cwd, 0);
    assert.ok(hitZero !== null, '0 作为 ignitionMs 应将 threshold 钳制在 0 并接纳文件');

    // Case C: 文件 mtime 在未来（时钟微幅偏差，+5000ms）
    setFileMtime(filePath, Date.now() + 5000);
    const hitFuture = scanForNewSessionJsonl(cwd, Date.now());
    assert.ok(hitFuture !== null, '未来时间戳文件（时钟偏差）仍应被正常识别');
    assert.equal(hitFuture.conversationId, cid);
  } finally {
    restore();
    safeRm(home);
  }
});

test('1.4 scanForNewSessionJsonl: 复杂/不寻常 cwd 路径（中文、空格、斜杠混杂）与目录回退', () => {
  const home = fixtureHome();
  const restore = useHome(home);
  try {
    // 1. 中文路径
    const cwdChinese = 'D:\\工作区\\核心模块\\子系统';
    const slugChinese = slugForCwd(cwdChinese);
    const dirChinese = join(home, 'projects', slugChinese);
    mkdirSync(dirChinese, { recursive: true });
    const cidChinese = '55555555-5555-4555-8555-555555555555';
    writeFileSync(join(dirChinese, `${cidChinese}.jsonl`), '{"role":"user"}\n');

    const hitChinese = scanForNewSessionJsonl(cwdChinese, Date.now() - 1000);
    assert.ok(hitChinese !== null, '中文工作区目录应顺利生成 slug 并匹配');
    assert.equal(hitChinese.conversationId, cidChinese);

    // 2. 空格与长路径
    const cwdSpaces = 'C:\\Program Files\\My Company\\Long Path Space';
    const slugSpaces = slugForCwd(cwdSpaces);
    const dirSpaces = join(home, 'projects', slugSpaces);
    mkdirSync(dirSpaces, { recursive: true });
    const cidSpaces = '66666666-6666-4666-8666-666666666666';
    writeFileSync(join(dirSpaces, `${cidSpaces}.jsonl`), '{"role":"user"}\n');

    const hitSpaces = scanForNewSessionJsonl(cwdSpaces, Date.now() - 1000);
    assert.ok(hitSpaces !== null, '含空格路径应顺利匹配');
    assert.equal(hitSpaces.conversationId, cidSpaces);

    // 3. 目录变形规则不一致时的兜底扫描（Fallback to any dir under projects）
    const cwdMismatched = 'C:\\arbitrary\\custom\\dir';
    const fallbackDir = join(home, 'projects', 'some-unpredicted-hash-name');
    mkdirSync(fallbackDir, { recursive: true });
    const cidFallback = '77777777-7777-4777-8777-777777777777';
    const pFallback = join(fallbackDir, `${cidFallback}.jsonl`);
    writeFileSync(pFallback, '{"fallback":true}\n');
    setFileMtime(pFallback, Date.now() + 100);

    const hitFallback = scanForNewSessionJsonl(cwdMismatched, Date.now() - 1000);
    assert.ok(hitFallback !== null, '无法直接命中 slug 时，必须自动遍历 projects 下子目录作为兜底');
    assert.equal(hitFallback.conversationId, cidFallback);
  } finally {
    restore();
    safeRm(home);
  }
});

test('1.5 scanForNewSessionJsonl: 杂物文件、垃圾命名与非会话文件干扰耐受力', () => {
  const home = fixtureHome();
  const restore = useHome(home);
  try {
    const cwd = 'C:\\workspace\\noisy-project';
    const projectDir = join(home, 'projects', slugForCwd(cwd));
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(join(projectDir, 'not-a-session.txt'), 'hello');
    writeFileSync(join(projectDir, 'short.jsonl'), 'short name');
    writeFileSync(join(projectDir, 'invalid-chars!@#.jsonl'), 'bad chars');
    writeFileSync(join(projectDir, 'package.json'), '{}');
    mkdirSync(join(projectDir, 'sub-dir.jsonl'), { recursive: true });

    const validCid = '88888888-8888-4888-8888-888888888888';
    writeFileSync(join(projectDir, `${validCid}.jsonl`), '{"role":"user"}\n');

    const hit = scanForNewSessionJsonl(cwd, Date.now() - 1000);
    assert.ok(hit !== null, '即使目录下存在大量杂物文件，也能精准定位合法会话');
    assert.equal(hit.conversationId, validCid);
  } finally {
    restore();
    safeRm(home);
  }
});

test('1.6 [Adversarial Challenge] scanForNewSessionJsonl: 揭示跨工作区并发扫描时的潜在串线风险', () => {
  const home = fixtureHome();
  const restore = useHome(home);
  try {
    const cwdTarget = 'C:\\workspace\\project-alpha';
    const cwdOther = 'C:\\workspace\\project-beta';

    const dirTarget = join(home, 'projects', slugForCwd(cwdTarget));
    const dirOther = join(home, 'projects', slugForCwd(cwdOther));
    mkdirSync(dirTarget, { recursive: true });
    mkdirSync(dirOther, { recursive: true });

    const now = Date.now();
    const cidTarget = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const cidOther = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    const pTarget = join(dirTarget, `${cidTarget}.jsonl`);
    const pOther = join(dirOther, `${cidOther}.jsonl`);

    writeFileSync(pTarget, '{"project":"alpha"}\n');
    writeFileSync(pOther, '{"project":"beta"}\n');

    setFileMtime(pTarget, now + 1000);
    setFileMtime(pOther, now + 1500);

    const hit = scanForNewSessionJsonl(cwdTarget, now);
    assert.ok(hit !== null);

    // 验证目标工作区优先机制：即使 project-beta 的时间戳更新 (now + 1500 vs now + 1000)，
    // 也必须锁定目标目录 project-alpha 的会话，杜绝跨项目串线 (theft)
    const isLeaked = hit.conversationId === cidOther;
    assert.equal(isLeaked, false, 'project-beta 不得抢夺 project-alpha 的会话');
    assert.equal(hit.conversationId, cidTarget, '目标工作区优先扫描机制必须杜绝跨项目串线');
  } finally {
    restore();
    safeRm(home);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 2. sessionStore.adopt UUID Capture & Preservation Tests
// ═══════════════════════════════════════════════════════════════════

test('2.1 sessionStore.adopt: 点火后落盘守望即刻捕获真实 UUID 并持久化到真实 sessionMap', async () => {
  const home = fixtureHome();
  const restore = useHome(home);
  try {
    const cwd = 'C:\\workspace\\real-adopt-project';
    const cid = '99999999-9999-4999-8999-999999999999';
    const projectDir = join(home, 'projects', slugForCwd(cwd));
    mkdirSync(projectDir, { recursive: true });
    const jsonlPath = join(projectDir, `${cid}.jsonl`);
    writeFileSync(jsonlPath, '{"type":"message","role":"user","content":[{"type":"input_text","text":"go"}]}\n');

    const ns = 'dsh-plugin-workbuddy';
    let savedSettings = {};
    const fakeCtx = {
      get: (n) => (n === 'settings' ? {
        describe: () => [{ ns, value: { sessions: savedSettings } }],
        update: async (_ns, patch) => {
          if (patch?.sessions) {
            savedSettings = { ...savedSettings, ...patch.sessions };
          }
          return true;
        },
      } : undefined),
    };
    const sessionMap = loadSessionMap(fakeCtx, ns);

    const run = startAutomationRun({
      prompt: 'go',
      cwd,
      sessionKey: 'key-m2-adopt',
      sessionStore: sessionMap,
      pollMs: 50,
      timeoutMs: 300,
      maxPollRounds: 2,
    });

    const outcome = await run.done;

    // 1. 验证 startAutomationRun 返回结构中的 sessionId / conversationId 保留真实 UUID
    assert.equal(outcome.automation.conversationId, cid);
    assert.equal(outcome.automation.sessionId, cid);
    assert.equal(outcome.automation.sessionKey, 'key-m2-adopt');

    // 2. 验证真实 sessionMap 内数据与状态标志
    const entry = sessionMap.lookup('key-m2-adopt');
    assert.ok(entry !== null, 'sessionMap 必须能够查出已 adopt 的记录');
    assert.equal(entry.cliSessionId, cid, '必须完整保留真实 UUID');
    assert.equal(entry.cwd, cwd);
    assert.equal(entry.own, true, '自建标记 own 必须为 true');
    assert.equal(entry.superseded, false, '未被 supersede');
    assert.equal(entry.unconfirmed, false, '未被置为 unconfirmed');

    const resumableInfo = sessionMap.resumable('key-m2-adopt');
    assert.ok(resumableInfo !== null, '该会话必须处于可续接状态 (非 null)');
    assert.equal(resumableInfo.cliSessionId, cid, '可续接会话 ID 必须等于 adopted UUID');

    // 3. 验证持久化 settings.sessions
    await sessionMap.settled();
    const persisted = savedSettings['key-m2-adopt'];
    assert.ok(persisted !== undefined, '必须写入持久化 settings.sessions');
    assert.equal(persisted.cliSessionId, cid);
    assert.equal(persisted.own, true);
  } finally {
    restore();
    safeRm(home);
  }
});

test('2.2 sessionStore.adopt: 多轮轮询与终态更新下的幂等性与 UUID 不变性', async () => {
  const home = fixtureHome();
  const restore = useHome(home);
  try {
    const cwd = 'C:\\workspace\\idempotency-project';
    const cid = 'bbbbbbbb-1111-4bbb-8bbb-111111111111';
    const projectDir = join(home, 'projects', slugForCwd(cwd));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, `${cid}.jsonl`), '{"type":"message","role":"user","content":[{"type":"input_text","text":"ping"}]}\n');

    const ns = 'dsh-plugin-workbuddy';
    let savedSettings = {};
    const fakeCtx = {
      get: (n) => (n === 'settings' ? {
        describe: () => [{ ns, value: { sessions: savedSettings } }],
        update: async (_ns, patch) => {
          if (patch?.sessions) {
            savedSettings = { ...savedSettings, ...patch.sessions };
          }
          return true;
        },
      } : undefined),
    };
    const sessionMap = loadSessionMap(fakeCtx, ns);

    // 模拟初次点火运行
    const run1 = startAutomationRun({
      prompt: 'ping',
      cwd,
      sessionKey: 'key-idempotent',
      sessionStore: sessionMap,
      pollMs: 50,
      timeoutMs: 300,
      maxPollRounds: 2,
    });
    await run1.done;

    const firstCreatedAt = sessionMap.lookup('key-idempotent').createdAt;

    // 模拟后续再次以相同会话 adopt
    const adoptRes = sessionMap.adopt('key-idempotent', {
      cliSessionId: cid,
      cwd,
      own: true,
    });
    assert.equal(adoptRes.ok, true);

    const secondEntry = sessionMap.lookup('key-idempotent');
    assert.equal(secondEntry.cliSessionId, cid, 'UUID 必须严格保持一致');
    assert.equal(secondEntry.createdAt, firstCreatedAt, '再次 adopt 时 createdAt 必须沿用旧值保持稳定');

    // 模拟传入非法 UUID 试图覆盖
    const badAdopt = sessionMap.adopt('key-idempotent', {
      cliSessionId: '',
      cwd,
    });
    assert.equal(badAdopt.ok, false, '非法 UUID 必须被拒绝');
    assert.equal(sessionMap.lookup('key-idempotent').cliSessionId, cid, '原有效 UUID 绝不被非法输入覆盖');
  } finally {
    restore();
    safeRm(home);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 3. extractTranscriptArtifacts Stress Tests & Vulnerability Verification
// ═══════════════════════════════════════════════════════════════════

test('3.1 extractTranscriptArtifacts: 畸形、残缺、截断与超深嵌套 JSON 格式容错', () => {
  const home = fixtureHome();
  const restore = useHome(home);
  try {
    const filePath = join(home, 'malformed.jsonl');

    const lines = [
      '', // 空行
      '   ', // 纯空白行
      'not json at all { broken', // 非 JSON
      '{"truncated": "json line', // 截断
      '12345', // 纯数字
      '"a string"', // 纯字符串
      '[]', // 空数组
      '{"type": "message", "role": "user"}', // 无 tool
      // 深度嵌套对象作为 input
      JSON.stringify({
        type: 'tool_call',
        name: 'deep_tool',
        input: {
          level1: { level2: { level3: { level4: { level5: { path: 'deep/nested/path.js' } } } } },
          targetFile: 'src/main/target.rs',
          artifacts: ['dist/bundle.js', 'dist/bundle.js.map', 123, '   '],
        },
      }),
      // input 为字符串化 JSON
      JSON.stringify({
        type: 'tool_use',
        name: 'write_file',
        input: JSON.stringify({ filePath: 'config/app.json' }),
      }),
      // input 为非 JSON 字符串
      JSON.stringify({
        type: 'action',
        input: 'unparseable string payload',
      }),
      // content 数组混合格式
      JSON.stringify({
        type: 'message',
        content: [
          null,
          'text only',
          { type: 'text', text: 'ignore me' },
          { type: 'tool_use', input: { AbsolutePath: 'D:\\build\\output.bin' } },
          { type: 'artifact', path: 'docs/report.pdf' },
          { type: 'file', path: 'images/diagram.png' },
          { type: 'unknown_type', path: 'should/not/match' },
        ],
      }),
    ];

    writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');

    const artifacts = extractTranscriptArtifacts(filePath);
    assert.ok(Array.isArray(artifacts));

    assert.ok(artifacts.includes('src/main/target.rs'));
    assert.ok(artifacts.includes('dist/bundle.js'));
    assert.ok(artifacts.includes('dist/bundle.js.map'));
    assert.ok(artifacts.includes('config/app.json'));
    assert.ok(artifacts.includes('D:\\build\\output.bin'));
    assert.ok(artifacts.includes('docs/report.pdf'));
    assert.ok(artifacts.includes('images/diagram.png'));

    assert.ok(!artifacts.includes(''));
    assert.ok(!artifacts.includes('   '));
    assert.ok(!artifacts.includes('should/not/match'));
  } finally {
    restore();
    safeRm(home);
  }
});

test('3.2 extractTranscriptArtifacts: 候选字段全量覆盖与路径去重、修剪', () => {
  const home = fixtureHome();
  const restore = useHome(home);
  try {
    const filePath = join(home, 'candidates.jsonl');

    const allFields = [
      ['path', 'a/path.txt'],
      ['Path', 'b/Path.txt'],
      ['filePath', 'c/filePath.txt'],
      ['file_path', 'd/file_path.txt'],
      ['target_file', 'e/target_file.txt'],
      ['targetFile', 'f/targetFile.txt'],
      ['TargetFile', 'g/TargetFile.txt'],
      ['file', 'h/file.txt'],
      ['File', 'i/File.txt'],
      ['destination', 'j/destination.txt'],
      ['Destination', 'k/Destination.txt'],
      ['dest', 'l/dest.txt'],
      ['outputPath', 'm/outputPath.txt'],
      ['output_path', 'n/output_path.txt'],
      ['filename', 'o/filename.txt'],
      ['fileName', 'p/fileName.txt'],
      ['artifact', 'q/artifact.txt'],
      ['artifact_path', 'r/artifact_path.txt'],
      ['artifactPath', 's/artifactPath.txt'],
      ['AbsolutePath', 't/AbsolutePath.txt'],
      ['TargetDirectory', 'u/TargetDirectory.txt'],
    ];

    const lines = [];
    for (const [key, val] of allFields) {
      lines.push(JSON.stringify({
        type: 'tool_call',
        input: { [key]: `  ${val}  ` },
      }));
    }

    lines.push(JSON.stringify({
      type: 'tool_call',
      input: { path: 'a/path.txt', files: ['a/path.txt', '  b/Path.txt  '] },
    }));

    writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');

    const artifacts = extractTranscriptArtifacts(filePath);

    assert.equal(artifacts.length, 21, '所有候选字段均应被捕获且完全去重');

    for (const [, val] of allFields) {
      assert.ok(artifacts.includes(val), `字段对应的值 ${val} 必须存在于提取结果中`);
    }
  } finally {
    restore();
    safeRm(home);
  }
});

test('3.3 extractTranscriptArtifacts: 不存在的文件与空文件返回空数组且不崩溃', () => {
  const missing = join(tmpdir(), 'non-existent-transcript.jsonl');
  const resMissing = extractTranscriptArtifacts(missing);
  assert.deepEqual(resMissing, []);

  const home = fixtureHome();
  const restore = useHome(home);
  try {
    const emptyFile = join(home, 'empty.jsonl');
    writeFileSync(emptyFile, '', 'utf8');
    const resEmpty = extractTranscriptArtifacts(emptyFile);
    assert.deepEqual(resEmpty, []);
  } finally {
    restore();
    safeRm(home);
  }
});

test('3.4 extractTranscriptArtifacts: 当 JSONL 存在 null 行或非对象基元时做防御性跳过，返回空数组且不抛出异常', () => {
  const home = fixtureHome();
  const restore = useHome(home);
  try {
    const filePath = join(home, 'null-crash.jsonl');
    writeFileSync(filePath, 'null\n123\n"primitive string"\ntrue\n', 'utf8');
    const res = extractTranscriptArtifacts(filePath);
    assert.deepEqual(res, [], '包含 null/基元行的 JSONL 必须被安全跳过，返回空数组且不发生崩溃');
  } finally {
    restore();
    safeRm(home);
  }
});
