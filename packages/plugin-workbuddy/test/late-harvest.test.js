/**
 * Milestone 2 / R2: 落盘守望、真实结果回显与延迟收割通道测试套件。
 *
 * 覆盖：
 *   ① 实时落盘守望（Disk Watch）：点火后在 1-3 秒内从 projects/<slug>/<UUID>.jsonl 捕获
 *      UUID 并实时回填到 sessionStore（long before SQLite settles）；
 *   ② 结果回显与产物抽取（Result Echo & Artifact Extraction）：
 *      - readReplyFromTranscript 抽取最后一条 assistant 正文；
 *      - extractTranscriptArtifacts 抽取工具调用及内容块引用的产物文件路径；
 *   ③ 延迟收割通道（harvestAutomationRun）：
 *      - 查询已完成任务（含 soft-deleted 行）；
 *      - 查询仍在运行任务（still_running 状态与 waitMs 超时）；
 *      - 查询失败任务（failure_code）；
 *      - 结构化回显 permission / effort / model / usage / artifacts / reply；
 *   ④ workbuddy_harvest 工具（makeHarvestTool / TOOL_HARVEST）：
 *      - 参数校验与执行回显；
 *      - 契约与 render 格式化；
 *   ⑤ apply.js 注册联动：
 *      - ctx.tools 上 workbuddy_harvest 注册确认。
 *
 * @module test/late-harvest.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  extractTranscriptArtifacts,
  harvestAutomationRun,
  readReplyFromTranscript,
  scanForNewSessionJsonl,
  slugForCwd,
  startAutomationRun,
  transcriptPathFor,
  workbuddyDbPath,
} from '../src/host/gateway/automation.js';
import { makeHarvestTool, TOOL_HARVEST, workbuddy_harvest } from '../src/host/tools/harvest.js';
import { apply } from '../src/host/apply.js';

function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), 'wb-late-harvest-'));
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

test('① 实时落盘守望：点火后即刻扫出 <UUID>.jsonl 并实时回填 sessionStore.adopt', async () => {
  const home = fixtureHome();
  const restore = useHome(home);
  try {
    const cwd = 'C:\\workspace\\test-project';
    const cid = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d';
    const projectDir = join(home, 'projects', slugForCwd(cwd));
    mkdirSync(projectDir, { recursive: true });
    const jsonlPath = join(projectDir, `${cid}.jsonl`);

    // 写入初始用户输入
    writeFileSync(
      jsonlPath,
      JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }) + '\n',
      'utf8',
    );

    const adoptedCalls = [];
    const mockSessionStore = {
      adopt(key, rec) {
        adoptedCalls.push({ key, rec });
        return { ok: true, cliSessionId: rec.cliSessionId };
      },
      forget() {},
    };

    // 点火并在首轮轮询中守望
    const run = startAutomationRun({
      prompt: 'hello',
      cwd,
      sessionKey: 'my-session-key',
      sessionStore: mockSessionStore,
      pollMs: 50,
      timeoutMs: 300,
      maxPollRounds: 2,
    });

    const outcome = await run.done;

    // 确认通过落盘守望在 SQLite 写入之前就已捕获会话 ID 并触发 adopt
    assert.ok(adoptedCalls.length >= 1, 'sessionStore.adopt 必须被至少触发一次');
    assert.equal(adoptedCalls[0].key, 'my-session-key');
    assert.equal(adoptedCalls[0].rec.cliSessionId, cid);
    assert.equal(adoptedCalls[0].rec.cwd, cwd);
    assert.equal(adoptedCalls[0].rec.own, true);
    assert.equal(outcome.automation.conversationId, cid);
    assert.equal(outcome.automation.sessionId, cid);
  } finally {
    restore();
    safeRm(home);
  }
});

test('② 结果回显：readReplyFromTranscript 正确抽取最后一条 assistant 正文', () => {
  const home = fixtureHome();
  const restore = useHome(home);
  try {
    const filePath = join(home, 'test-transcript.jsonl');

    // 构造包含用户输入、中间工具调用与最终回复的多轮转录
    const lines = [
      JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Build artifact' }] }),
      JSON.stringify({ type: 'message', content: [{ type: 'output_text', text: 'I will create the file now.' }] }),
      JSON.stringify({ type: 'tool_call', name: 'write_file', input: { path: 'dist/app.js' } }),
      JSON.stringify({ type: 'tool_result', result: 'file written successfully' }),
      JSON.stringify({ type: 'message', content: [{ type: 'output_text', text: 'All tasks completed successfully!' }] }),
    ];
    writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');

    const reply = readReplyFromTranscript(filePath);
    assert.equal(reply, 'All tasks completed successfully!');

    // 空转录或不存在转录回落为 null
    assert.equal(readReplyFromTranscript(join(home, 'non-existent.jsonl')), null);
  } finally {
    restore();
    safeRm(home);
  }
});

test('③ 产物提取：extractTranscriptArtifacts 正确抽取所有工具执行引用与生成的产物路径', () => {
  const home = fixtureHome();
  const restore = useHome(home);
  try {
    const filePath = join(home, 'artifacts-transcript.jsonl');

    const lines = [
      // 1. 顶层 tool_call input 中的多种路径候选
      JSON.stringify({ type: 'tool_call', input: { path: 'C:\\build\\output.bin' } }),
      JSON.stringify({ type: 'tool_use', input: { TargetFile: 'D:\\repo\\README.md' } }),
      JSON.stringify({ type: 'tool_use', input: { files: ['assets/icon.png', 'assets/logo.svg'] } }),
      // 2. content 数组中的嵌套 tool_use 与 artifact
      JSON.stringify({
        type: 'message',
        content: [
          { type: 'tool_use', input: { file_path: 'src/index.js' } },
          { type: 'artifact', path: 'dist/bundle.js' },
          { type: 'output_text', text: 'Done.' },
        ],
      }),
      // 3. 重复路径应被去重
      JSON.stringify({ type: 'tool_call', input: { path: 'C:\\build\\output.bin' } }),
    ];
    writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');

    const artifacts = extractTranscriptArtifacts(filePath);
    assert.ok(Array.isArray(artifacts));
    assert.equal(artifacts.length, 6);
    assert.ok(artifacts.includes('C:\\build\\output.bin'));
    assert.ok(artifacts.includes('D:\\repo\\README.md'));
    assert.ok(artifacts.includes('assets/icon.png'));
    assert.ok(artifacts.includes('assets/logo.svg'));
    assert.ok(artifacts.includes('src/index.js'));
    assert.ok(artifacts.includes('dist/bundle.js'));
  } finally {
    restore();
    safeRm(home);
  }
});

test('④ harvestAutomationRun：解析已完成且已软删（soft-deleted）的任务，回显完整结果与事实', async () => {
  const home = fixtureHome();
  const restore = useHome(home);
  let db = null;
  try {
    db = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoId = 'automation-1728420000000';
    const cid = 'c1c2c3c4-d5d6-4e5f-8a9b-0c1d2e3f4a5b';
    const cwd = 'D:\\projects\\demo';

    // 1. 插入 automations 行，模拟已软删（deleted_at 有值）
    const now = Date.now();
    db.prepare(`INSERT INTO automations (
      id, name, prompt, status, schedule_type, next_run_at, last_run_at,
      cwds, rrule, scheduled_at, valid_until, model_id, model_is_thinking, permission_mode,
      reasoning_effort, created_at, updated_at, deleted_at
    ) VALUES (?, 'Demo task', 'Run demo', 'ACTIVE', 'once', ?, ?, ?, '', ?, ?, 'deepseek-v3', 1, 'plan', 'high', ?, ?, ?)`).run(
      autoId, now, now, JSON.stringify([cwd]), String(now), String(now + 100000), now, now, now + 5000,
    );

    // 2. 插入 automation_runs 完成行
    db.prepare(`INSERT INTO automation_runs (
      thread_id, automation_id, status, result_success, metadata_json, runs_json, created_at, updated_at
    ) VALUES ('thread-1', ?, 'ACCEPTED', 1, ?, ?, ?, ?)`).run(
      autoId,
      JSON.stringify({ conversationId: cid }),
      JSON.stringify([{ conversationId: cid, cwd, output: 'Fallback text' }]),
      now, now + 4000,
    );

    // 3. 插入 sessions 真实生效事实
    db.prepare(`INSERT INTO sessions (
      id, cwd, title, model, permission_mode, thought_level, created_at, updated_at
    ) VALUES (?, ?, 'Demo task', 'deepseek-v3', 'plan', 'high', ?, ?)`).run(
      cid, cwd, now, now + 4000,
    );

    // 4. 插入 session_usage 积分与 token 消耗
    db.prepare(`INSERT INTO session_usage (
      session_id, used, size, credit_json
    ) VALUES (?, 1280, 256, ?)`).run(
      cid, JSON.stringify({ chat: 1.75 }),
    );

    // 5. 写入会话转录
    const projectDir = join(home, 'projects', slugForCwd(cwd));
    mkdirSync(projectDir, { recursive: true });
    const transcriptPath = join(projectDir, `${cid}.jsonl`);
    const lines = [
      JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run demo' }] }),
      JSON.stringify({ type: 'tool_call', input: { path: 'dist/report.pdf' } }),
      JSON.stringify({ type: 'message', content: [{ type: 'output_text', text: 'Demo executed successfully with report generated.' }] }),
    ];
    writeFileSync(transcriptPath, lines.join('\n') + '\n', 'utf8');

    // 执行收割
    const report = await harvestAutomationRun(db, autoId);

    assert.equal(report.ok, true);
    assert.equal(report.automationId, autoId);
    assert.equal(report.sessionId, cid);
    assert.equal(report.status, 'completed');
    assert.equal(report.reply, 'Demo executed successfully with report generated.');
    assert.deepEqual(report.artifacts, ['dist/report.pdf']);
    assert.equal(report.transcriptPath, transcriptPath);

    // 权限与思考强度真实核对
    assert.deepEqual(report.permission, { requested: 'plan', effective: 'plan', confirmed: true });
    assert.deepEqual(report.effort, { requested: 'high', effective: 'high', confirmed: true });
    assert.deepEqual(report.model, { requested: 'deepseek-v3', effective: 'deepseek-v3' });
    assert.deepEqual(report.usage, { tokens: 1280, credits: 1.75 });
  } finally {
    try { db?.close(); } catch {}
    restore();
    safeRm(home);
  }
});

test('⑤ harvestAutomationRun：解析仍处于运行中的任务（still_running 状态）', async () => {
  const home = fixtureHome();
  const restore = useHome(home);
  let db = null;
  try {
    db = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoId = 'automation-still-running-1';
    const cid = 'b1b2b3b4-c5c6-4d7e-8f9a-0b1c2d3e4f5a';
    const now = Date.now();

    db.prepare(`INSERT INTO automations (
      id, name, prompt, status, schedule_type, next_run_at, cwds,
      created_at, updated_at
    ) VALUES (?, 'Long task', 'Running long computation', 'ACTIVE', 'once', ?, '[]', ?, ?)`).run(
      autoId, now, now, now,
    );

    db.prepare(`INSERT INTO automation_runtime_state (
      automation_id, running, running_conversation_id
    ) VALUES (?, 1, ?)`).run(autoId, cid);

    const report = await harvestAutomationRun(db, autoId, { waitMs: 50 });
    assert.equal(report.ok, true);
    assert.equal(report.automationId, autoId);
    assert.equal(report.sessionId, cid);
    assert.equal(report.status, 'still_running');
    assert.equal(report.reply, null);
  } finally {
    try { db?.close(); } catch {}
    restore();
    safeRm(home);
  }
});

test('⑥ harvestAutomationRun：解析失败任务与不存在的任务', async () => {
  const home = fixtureHome();
  const restore = useHome(home);
  let db = null;
  try {
    db = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoId = 'automation-failed-1';
    const now = Date.now();

    db.prepare(`INSERT INTO automations (
      id, name, prompt, status, schedule_type, next_run_at, cwds,
      created_at, updated_at
    ) VALUES (?, 'Failed task', 'Failed run', 'ACTIVE', 'once', ?, '[]', ?, ?)`).run(
      autoId, now, now, now,
    );

    db.prepare(`INSERT INTO automation_runs (
      thread_id, automation_id, status, result_success, failure_code, created_at, updated_at
    ) VALUES ('thread-fail', ?, 'FAILED', 0, 'TASK_ERROR', ?, ?)`).run(autoId, now, now);

    const report = await harvestAutomationRun(db, autoId);
    assert.equal(report.ok, true);
    assert.equal(report.status, 'failed');

    // 不存在的 ID
    const notFound = await harvestAutomationRun(db, 'non-existent-id');
    assert.equal(notFound.ok, false);
    assert.equal(notFound.error, 'automation_not_found');
    assert.equal(notFound.status, 'failed');
  } finally {
    try { db?.close(); } catch {}
    restore();
    safeRm(home);
  }
});

test('⑦ workbuddy_harvest 工具实例与执行契约', async () => {
  const home = fixtureHome();
  const restore = useHome(home);
  let db = null;
  try {
    db = new DatabaseSync(join(home, 'workbuddy.db'));
    const autoId = 'automation-tool-test';
    const now = Date.now();

    db.prepare(`INSERT INTO automations (
      id, name, prompt, status, schedule_type, next_run_at, cwds, created_at, updated_at
    ) VALUES (?, 'Tool test', 'Prompt text', 'ACTIVE', 'once', ?, '[]', ?, ?)`).run(
      autoId, now, now, now,
    );

    db.prepare(`INSERT INTO automation_runs (
      thread_id, automation_id, status, result_success, thread_title, created_at, updated_at
    ) VALUES ('t1', ?, 'ACCEPTED', 1, 'Done title', ?, ?)`).run(autoId, now, now);

    const tool = makeHarvestTool(null, null, null, db);
    assert.equal(tool.name, TOOL_HARVEST);
    assert.equal(tool.name, 'workbuddy_harvest');
    assert.equal(typeof tool.execute, 'function');

    // 正常执行
    const result = await tool.execute({ automation_id: autoId });
    assert.equal(result.ok, true);
    assert.equal(result.automationId, autoId);
    assert.equal(result.status, 'completed');
    assert.equal(result.reply, 'Done title');

    // render 输出
    const rendered = tool.output.render({ automation_id: autoId }, result);
    assert.ok(Array.isArray(rendered));
    assert.ok(rendered[0].text.includes('Harvested automation automation-tool-test'));

    // 缺少必填参数触发参数验证错误
    await assert.rejects(
      async () => tool.execute({}),
      (err) => err.code === 'INVALID_ARGS' || /automation_id/.test(err.message),
    );
  } finally {
    try { db?.close(); } catch {}
    restore();
    safeRm(home);
  }
});

test('⑧ apply.js 装配：ctx.tools 成功挂载 workbuddy_harvest', async () => {
  const mockTools = {
    register: () => () => {},
    get: () => null,
  };
  const mockCtx = {
    tools: mockTools,
    subprocess: { spawn: () => {} },
    jobs: { start: () => {} },
    subagents: {},
    effect: () => () => {},
    inject: () => () => {},
    get: () => null,
  };

  apply(mockCtx, {});

  assert.ok(mockTools[TOOL_HARVEST], 'TOOL_HARVEST 必须挂载在 ctx.tools');
  assert.ok(mockTools.workbuddy_harvest, 'workbuddy_harvest 必须挂载在 ctx.tools');
  assert.equal(mockTools.get('workbuddy_harvest').name, 'workbuddy_harvest');
});
