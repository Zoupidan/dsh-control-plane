/**
 * 计划任务防刷频 + 即建即撤（2026-10-02）。
 *
 * <p>★ 本文件只碰临时库，绝不写真库 ★
 * `WORKBUDDY_HOME` 在每个用例里指向 `mkdtemp` 夹具；首尾各记一次真库活行数
 * （`deleted_at IS NULL`），真库存在时必须一字不动。`--import test-home-guard.mjs`
 * 是套件级兜底（结构上写不到真库），这里的行数断言是第二道（能报警）。
 * 不做任何 `git commit`（验证止于工作区）。
 *
 * 覆盖（与任务单逐条对应）：
 *   ⓪ 套件级护栏自证（WORKBUDDY_TEST_HOME_GUARD + 落点非真库）：没带 guard 跑就直接红；
 *   ① 一次下发只 INSERT 一行（全表恰好一行，轮询不重建）；
 *   ② 轮询退避（默认首轮2s、之后5s、最多12轮约60s），体内只 SELECT；
 *   ③ 一旦 `sessionFacts` 拿到 `sessions.id` 立刻 `retireRow` + `sessionStore.adopt(key)`，
 *      后续走复用不再建行；
 *   ④ 超时/取消同样 retire，绝不留活行到 `valid_until`；
 *   ⑤ 启动清理 `sweepStartupAutomationRows` 全 retire 活行；
 *   ⑥ `lastRun` 可查：`automation.{automationId,sessionId,sessionKey,retired}` + `status`。
 *
 * @module test/automation-early-retire.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  AUTOMATION_DEFAULTS,
  buildPollWaits,
  confirmedSessionFacts,
  listArmedRows,
  retireArmedRows,
  startAutomationRun,
  sweepStartupAutomationRows,
  workbuddyDbPath,
} from '../src/host/gateway/automation.js';

const REAL_DB = join(homedir(), '.workbuddy', 'workbuddy.db');

function realAutomationCount() {
  if (!existsSync(REAL_DB)) return null;
  const db = new DatabaseSync(REAL_DB, { readOnly: true });
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM automations WHERE deleted_at IS NULL').get().n;
  } finally {
    db.close();
  }
}

/** 造最小夹具库：点火 + 轮询 + sessionFacts 需要的五张表。 */
function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), 'wb-early-retire-'));
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
    created_at INTEGER, updated_at INTEGER);
    CREATE TABLE session_usage (
    session_id TEXT PRIMARY KEY, used INTEGER, size INTEGER, credit_json TEXT);`);
  db.close();
  return home;
}

/** 把 WORKBUDDY_HOME 指到夹具，返回还原函数。 */
function useHome(home) {
  const previous = process.env.WORKBUDDY_HOME;
  process.env.WORKBUDDY_HOME = home;
  return () => {
    if (previous === undefined) delete process.env.WORKBUDDY_HOME;
    else process.env.WORKBUDDY_HOME = previous;
  };
}

test('⓪ 套件级护栏生效：WORKBUDDY_HOME 指着一次性 tmp，真库结构上不可达', () => {
  // ★ 本文件是除 home-guard 外唯一真调 startAutomationRun 的用例文件。
  //   行数断言是第二道防线；第一道（结构上写不到真库）必须先自证，否则下一次漏注入照样安全无从谈起。
  //   直接 `node --test` 绕过 npm 脚本 ⇒ 护栏不在 ⇒ 这里立刻红，而不是静默写真库。
  assert.equal(
    process.env.WORKBUDDY_TEST_HOME_GUARD,
    'on',
    '★ 套件级护栏没生效 —— 必须经 npm run test:host（含 --import ./tools/dev/test-home-guard.mjs）运行',
  );
  const home = process.env.WORKBUDDY_HOME ?? '';
  assert.ok(
    home.startsWith(tmpdir()),
    `★ WORKBUDDY_HOME 必须落在系统临时目录下，实际：${home}`,
  );
  assert.ok(
    !REAL_DB.startsWith(home),
    '★ 真库路径必须不在 WORKBUDDY_HOME 之下（否则任何疏漏都会写进用户真库）',
  );
  assert.notEqual(workbuddyDbPath(), REAL_DB, '★★ 点火落点绝不能是真库');
});

test('① 退避表默认值：首轮2s、之后5s、动态181轮约15分钟（900_000ms）', () => {
  assert.equal(AUTOMATION_DEFAULTS.pollFirstMs, 2_000);
  assert.equal(AUTOMATION_DEFAULTS.pollRestMs, 5_000);
  assert.equal(AUTOMATION_DEFAULTS.timeoutMs, 900_000);
  const s = buildPollWaits({});
  assert.equal(s.rounds, 181);
  assert.equal(s.waits.length, 181);
  assert.equal(s.waits[0], 2_000);
  assert.ok(s.waits.slice(1).every((w) => w === 5_000));
  const total = s.waits.reduce((a, b) => a + b, 0);
  assert.equal(total, 902_000);

  // 显式指定 maxPollRounds 时保持显式轮数（测试快路径兼容）
  const explicit = buildPollWaits({ maxPollRounds: 12 });
  assert.equal(explicit.rounds, 12);
  assert.equal(explicit.waits.length, 12);
  const totalExplicit = explicit.waits.reduce((a, b) => a + b, 0);
  assert.ok(totalExplicit >= 55_000 && totalExplicit <= 60_000);
});

test('② confirmedSessionFacts：sessions.id 存在才回 facts，否则 null', () => {
  const home = fixtureHome();
  const restore = useHome(home);
  try {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    try {
      const sid = '11111111-1111-4111-8111-111111111111';
      db.prepare(`INSERT INTO sessions (id, cwd, title, model, permission_mode, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(sid, 'C:\\tmp', 't', 'm1', 'fullAccess', Date.now(), Date.now());
      db.prepare('INSERT INTO session_usage (session_id, used, size, credit_json) VALUES (?, ?, ?, ?)')
        .run(sid, 10, 100, JSON.stringify({ chat: 1.5 }));
      const facts = confirmedSessionFacts(db, sid);
      assert.ok(facts !== null, '存在行必须回 facts');
      assert.equal(facts.model, 'm1');
      assert.equal(confirmedSessionFacts(db, '00000000-0000-4000-8000-000000000000'), null, '不存在必须 null');
      assert.equal(confirmedSessionFacts(db, ''), null, '空串必须 null');
    } finally {
      db.close();
    }
  } finally {
    restore();
    rmSync(home, { recursive: true, force: true });
  }
});

test('③ 超时返回 still_running 且不 retire：只 INSERT 一行，行保持未软删，真库不动', async () => {
  const before = realAutomationCount();
  const home = fixtureHome();
  const restore = useHome(home);
  try {
    assert.equal(workbuddyDbPath(), join(home, 'workbuddy.db'));
    const run = startAutomationRun({
      prompt: 'EARLY-RETIRE-TIMEOUT-PROBE', cwd: '',
      timeoutMs: 60_000, pollFirstMs: 50, pollRestMs: 50, maxPollRounds: 6,
    });
    const out = await run.done;
    assert.equal(out.status, 'still_running', '超时必须收敛为 still_running（严禁判定为 failed）');
    assert.equal(out.exitCode, 0, 'still_running 退出码为 0');
    assert.ok(out.automation?.automationId, '必须真的建过 id');
    assert.equal(out.automation.reason, 'still_running', '原因码必须为 STILL_RUNNING');
    assert.equal(out.automation.retired, false, '超时不得 retire（严禁触发 retired: true 软删）');
    assert.equal(out.automation.sessionId, null, '没建会话时 sessionId 为 null');
    const db = new DatabaseSync(join(home, 'workbuddy.db'), { readOnly: true });
    try {
      const rows = db.prepare('SELECT id, deleted_at FROM automations').all();
      assert.equal(rows.length, 1, '一次下发只 INSERT 一行（轮询不重建）');
      assert.equal(rows[0].id, out.automation.automationId);
      assert.equal(rows[0].deleted_at, null, '行在超时后不得软删（不调用 retireRow）');
      const live = db.prepare('SELECT COUNT(*) AS n FROM automations WHERE deleted_at IS NULL').get().n;
      assert.equal(live, 1, '保持活行以供后续继续运行或 harvest');
    } finally {
      db.close();
    }
    if (before !== null) assert.equal(realAutomationCount(), before, '真库必须一字不动');
  } finally {
    restore();
    rmSync(home, { recursive: true, force: true });
  }
});

test('④ 即建即撤：会话一确认就 retireRow + adopt，后续可复用；终态回执带 lastRun 四件套', async () => {
  const before = realAutomationCount();
  const home = fixtureHome();
  const restore = useHome(home);
  const sid = '22222222-2222-4222-8222-222222222222';
  const adopted = [];
  const sessionStore = {
    adopt: (key, rec) => {
      adopted.push({ key, rec });
      return { ok: true, cliSessionId: rec.cliSessionId, persistState: 'attempted', persistError: '' };
    },
  };
  // ★ 模拟桌面端调度器：扫到新行 → 建 sessions 行 → 写 running_conversation_id → 写终态 runs 行。
  const simulateDesktop = (async () => {
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    try { db.exec('PRAGMA busy_timeout = 8000'); } catch { /* 忽略 */ }
    try {
      let automationId = null;
      for (let i = 0; i < 100 && automationId === null; i += 1) {
        const hit = db.prepare('SELECT id FROM automations WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1').get()
          ?? null;
        if (hit?.id) automationId = hit.id;
        else await new Promise((r) => setTimeout(r, 50));
      }
      if (automationId === null) return;
      const now = Date.now();
      db.prepare(`INSERT OR IGNORE INTO sessions (id, cwd, title, model, permission_mode, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(sid, 'C:\\tmp', 'sim', 'm-sim', 'fullAccess', now, now);
      db.prepare('INSERT OR REPLACE INTO session_usage (session_id, used, size, credit_json) VALUES (?, ?, ?, ?)')
        .run(sid, 7, 70, JSON.stringify({ chat: 0.5 }));
      db.prepare(`UPDATE automation_runtime_state
        SET running = 1, running_conversation_id = ?, running_started_at = ? WHERE automation_id = ?`)
        .run(sid, now, automationId);
      await new Promise((r) => setTimeout(r, 120)); // 给点火轮询留出"先看到会话、即刻 retire"的窗口
      db.prepare(`INSERT OR IGNORE INTO automation_runs
        (thread_id, automation_id, status, thread_title, source_cwd, runs_json, result_success, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          `thread-${automationId}`, automationId, 'ACCEPTED', 'sim-title', 'C:\\tmp',
          JSON.stringify([{ conversationId: sid, output: 'SIM-REPLY', cwd: 'C:\\tmp' }]),
          1, JSON.stringify({ conversationId: sid }), now, now,
        );
    } finally {
      try { db.close(); } catch { /* 忽略 */ }
    }
  })();

  try {
    const run = startAutomationRun({
      prompt: 'EARLY-RETIRE-ADOPT-PROBE', cwd: '',
      sessionKey: 'wb-test-key-1', sessionStore,
      timeoutMs: 30_000, pollFirstMs: 50, pollRestMs: 50, maxPollRounds: 80,
    });
    const out = await run.done;
    await simulateDesktop;
    assert.equal(out.status, 'completed', `应收敛为成功，实际: ${JSON.stringify(out).slice(0, 500)}`);
    // ★ lastRun 四件套：automation_id / session_id / retired / status 可查
    assert.match(out.automation.automationId, /^automation-\d+$/);
    assert.equal(out.automation.sessionId, sid, 'sessionId 必须是对上 sessions.id 的那一个');
    assert.equal(out.automation.conversationId, sid);
    assert.equal(out.automation.retired, true, '即建即撤：终态必须已 retire');
    assert.equal(out.automation.sessionKey, 'wb-test-key-1');
    assert.ok(out.automation.sessionPersist?.ok === true, 'adopt 产物必须带回');
    assert.equal(out.automation.reply, 'SIM-REPLY');
    // ★ adopt 恰好一次，key 就是传下去的 session_key（后续走复用不再建行）
    assert.equal(adopted.length, 1, 'adopt 必须恰好一次（不多记、不少记）');
    assert.equal(adopted[0].key, 'wb-test-key-1');
    assert.equal(adopted[0].rec.cliSessionId, sid);
    // ★ 单行 + 已退役
    const db = new DatabaseSync(join(home, 'workbuddy.db'), { readOnly: true });
    try {
      const rows = db.prepare('SELECT id, deleted_at FROM automations').all();
      assert.equal(rows.length, 1, '一次下发只 INSERT 一行');
      assert.notEqual(rows[0].deleted_at, null, '即建即撤：活行不得留到 valid_until');
    } finally {
      db.close();
    }
    assert.match(run.readOutput(), /\[retire\]/, '输出必须印退役动作');
    if (before !== null) assert.equal(realAutomationCount(), before, '真库必须一字不动');
  } finally {
    restore();
    rmSync(home, { recursive: true, force: true });
  }
});

test('⑤ 启动清扫：活行全 retire，过期/未到期/已删的不动', () => {
  const home = fixtureHome();
  const restore = useHome(home);
  try {
    const now = Date.now();
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    const put = (id, nextRunAt, validUntil, deletedAt) => {
      db.prepare(`INSERT INTO automations
        (id, name, prompt, status, schedule_type, next_run_at, cwds, scheduled_at, valid_until, owner_status, owner_source, created_at, updated_at, deleted_at)
        VALUES (?, ?, ?, 'ACTIVE', 'once', ?, '[]', ?, ?, 'confirmed', 'created', ?, ?, ?)`)
        .run(id, id, 'p', nextRunAt, new Date(now).toISOString(), validUntil, now, now, deletedAt);
    };
    const future = new Date(now + 600_000).toISOString();
    const past = new Date(now - 600_000).toISOString();
    put('armed-1', now - 1_000, future, null); // 活：到点 + 未过 → 扫掉
    put('armed-2', now - 2_000, future, null); // 活：同上
    put('expired-1', now - 1_000, past, null); // 已过期：调度器不会捡 → 不动
    put('future-1', now + 600_000, future, null); // 未到点 → 不动
    put('deleted-1', now - 1_000, future, now - 500); // 已删 → 不动
    db.close();

    const res = sweepStartupAutomationRows();
    assert.equal(res.error, '', `清扫不得报错，实际: ${res.error}`);
    assert.equal(res.armed, 2);
    assert.deepEqual([...res.swept].sort(), ['armed-1', 'armed-2']);

    const check = new DatabaseSync(join(home, 'workbuddy.db'), { readOnly: true });
    try {
      const isLive = (id) => check.prepare('SELECT deleted_at FROM automations WHERE id = ?').get(id)?.deleted_at ?? null;
      assert.notEqual(isLive('armed-1'), null);
      assert.notEqual(isLive('armed-2'), null);
      assert.equal(isLive('expired-1'), null, '过期行不动');
      assert.equal(isLive('future-1'), null, '未到点行不动');
      assert.notEqual(isLive('deleted-1'), null, '已删行保持');
      assert.deepEqual(listArmedRows(check, Date.now()), [], '扫完后无活行');
    } finally {
      check.close();
    }
  } finally {
    restore();
    rmSync(home, { recursive: true, force: true });
  }
});

test('⑤b 启动清扫：库文件不存在 ⇒ 回空且不得创建空库（没装桌面端的机器上不能凭空造文件）', () => {
  const home = mkdtempSync(join(tmpdir(), 'wb-early-retire-'));
  const restore = useHome(home);
  try {
    const dbFile = join(home, 'workbuddy.db');
    assert.equal(existsSync(dbFile), false, '前置：夹具里本来就没有库文件');
    const res = sweepStartupAutomationRows();
    assert.equal(res.error, '', `清扫不得报错，实际: ${res.error}`);
    assert.equal(res.armed, 0);
    assert.deepEqual(res.swept, []);
    assert.equal(existsSync(dbFile), false, '★ 不得为一次只读清扫创建空库文件');
  } finally {
    restore();
    rmSync(home, { recursive: true, force: true });
  }
});

test('⑥ retireArmedRows 只 SELECT 活行 + 逐行软删，不建行', () => {
  const home = fixtureHome();
  const restore = useHome(home);
  try {
    const now = Date.now();
    const db = new DatabaseSync(join(home, 'workbuddy.db'));
    try {
      db.prepare(`INSERT INTO automations
        (id, name, prompt, status, schedule_type, next_run_at, cwds, scheduled_at, valid_until, owner_status, owner_source, created_at, updated_at, deleted_at)
        VALUES (?, ?, ?, 'ACTIVE', 'once', ?, '[]', ?, ?, 'confirmed', 'created', ?, ?, NULL)`)
        .run('sweep-1', 'sweep-1', 'p', now - 1000, new Date(now).toISOString(), new Date(now + 600_000).toISOString(), now, now);
      const out = retireArmedRows(db, now, () => {});
      assert.equal(out.armed, 1);
      assert.deepEqual(out.swept, ['sweep-1']);
      const total = db.prepare('SELECT COUNT(*) AS n FROM automations').get().n;
      assert.equal(total, 1, '清扫不得建行');
    } finally {
      db.close();
    }
  } finally {
    restore();
    rmSync(home, { recursive: true, force: true });
  }
});
