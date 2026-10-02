/**
 * ★ 真库零写入守卫（★ 2026-10-01 新增，因为出过事故）★
 *
 * <p>★ 事故经过（原样保留，这是它存在的理由）★
 * `test/hardening.test.js` 的 boot() 忘了钉 `transport`，于是那条调**真实 run 工具**的用例
 * （prompt = `'ping'`）走了 schema 默认 `automation`，**每跑一次 `npm run test:host` 就往用户
 * 真机的 `~/.workbuddy/workbuddy.db` 里插一行真·一次性计划任务**（`next_run_at = now`、
 * `cwds=[]`、`name='ping'`）。桌面端调度器到点就**真的建一条对话** ⇒ 一下午十几条 ping 对话，
 * 而排查时先误判成"桌面端自己的心跳"，白查了两轮日志与进程。
 *
 * <p>★ 这个守卫要能**逮住那个已知故障**，否则它只是一盏永远绿的灯 ★
 * 所以它分两步，而且顺序不能换：
 * <ol>
 *   <li>**先证明这条判据会红**：真库行数先记下（只读打开，`readOnly: true`）；
 *       然后把真库文件**拷贝到一次性 tmp 目录**，在拷贝上插一行模拟"某个用例忘了钉 transport"
 *       ⇒ 此时必须观察到行数变化，否则说明这条判据读不到真库、后面全是空断言。
 *       ★ 2026-10-02 起不再往真库路径插行：每跑一次套件就留一行软删残留（`total` 只增不减），
 *       那本身就是对用户库的写入。用同 schema 的拷贝证明"判据能看到 +1"，证明力相同、零污染。</li>
 *   <li>**再验修复**：把 `WORKBUDDY_HOME` 指向临时家，跑一遍真实的自动化点火
 *       ⇒ 必须落在临时家、且**真库行数一字不动**。</li>
 * </ol>
 * 第 ① 步就是"拿已知答案对"：它一旦失灵，第 ② 步的"真库没变"就毫无意义。
 *
 * <p>★ 为什么用行数而不是 mtime ★
 * mtime 在 WAL 模式下**任何**读连接都可能改动它（连"读"都不干净）；行数只随真实写入变。
 *
 * @module test/automation-home-guard.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite'; // ESM：没有 require，必须顶层 import

import { workbuddyDbPath } from '../src/host/gateway/automation.js';

const REAL_DB = join(homedir(), '.workbuddy', 'workbuddy.db');

/** 真库里 **live**（`deleted_at IS NULL`）的 `automations` 行数。读不到就返回 null（而不是假装 0）。
 *
 *  ★ 为什么只数 live 行 ★
 *  ① 调度器只认 live 行 ⇒ "有没有多出一条会被点着的任务"问的就是这个；
 *  ② 软删（`deleted_at`）**不改变 `COUNT(*)`** —— 用全量计数的话，
 *     "插一行再软删回去"这种收尾会让判据永远红，而那其实是最干净的状态。
 */
function realAutomationCount() {
  if (!existsSync(REAL_DB)) return null;
  const db = new DatabaseSync(REAL_DB, { readOnly: true });
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM automations WHERE deleted_at IS NULL').get().n;
  } finally {
    db.close();
  }
}

/** 造一个只含 `automations` 表的最小夹具库（点火那一趟只需要它）。 */
function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), 'wb-guard-home-'));
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
    created_at INTEGER, updated_at INTEGER);`);
  db.close();
  return home;
}

test('★★ 第 ① 步：这条判据本身能逮住已知故障（往真库的 tmp 拷贝插一行 ⇒ 必须被观察到）', () => {
  const before = realAutomationCount();
  assert.ok(before !== null, `真库读不到（${REAL_DB}）⇒ 这条守卫在别的机器上会变成空断言，fail-closed 不静默通过`);

  // ★ 零写真库：在 tmp 拷贝上模拟事故。拷贝失败就地抛（fail-closed，不退回写真库）。
  const copyDir = mkdtempSync(join(tmpdir(), 'wb-guard-copy-'));
  try {
    const copyDb = join(copyDir, 'workbuddy.db');
    copyFileSync(REAL_DB, copyDb);
    const liveOf = (p) => {
      const d = new DatabaseSync(p, { readOnly: true });
      try {
        return d.prepare('SELECT COUNT(*) AS n FROM automations WHERE deleted_at IS NULL').get().n;
      } finally {
        d.close();
      }
    };
    const c0 = liveOf(copyDb);
    assert.ok(Number.isSafeInteger(c0), '拷贝库必须可读出 live 行数（否则本判据什么都没测到）');
    // ★ 故意模拟事故：无视 WORKBUDDY_HOME，直接往"真库同 schema 的拷贝"插一行一次性计划任务。
    const db = new DatabaseSync(copyDb);
    const id = `guard-selftest-${Date.now()}`;
    try {
      db.prepare(
        `INSERT INTO automations (id, name, prompt, status, schedule_type, next_run_at, cwds, owner_status, owner_source, created_at, updated_at)
         VALUES (?, 'guard-selftest', 'guard-selftest', 'ACTIVE', 'once', ?, '[]', 'confirmed', 'created', ?, ?)`,
      ).run(id, Date.now() + 3_600_000, Date.now(), Date.now()); // next_run_at 放到一小时后 ⇒ 语义同旧实现
      assert.equal(liveOf(copyDb), c0 + 1, '★ 拷贝库行数必须 +1 —— 观察不到就说明这条守卫是空断言');
      // 收尾：在拷贝上软删（只为验证"软删后 live 归零"这半句判据也有效）。
      db.prepare('UPDATE automations SET deleted_at = ?, updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), id);
      assert.equal(liveOf(copyDb), c0, '★ 软删后 live 行数必须回到基线');
    } finally {
      db.close();
    }
    // ★ 真库一字不动：前后两次只读计数必须一致（本测试全程只读真库）。
    assert.equal(realAutomationCount(), before, '★ 本测试零写真库 —— 真库 live 行数必须与进入时一致');
  } finally {
    rmSync(copyDir, { recursive: true, force: true });
  }
});

test('★★ 第 ④ 步：★ 套件级护栏生效 ⇒ 即使真点了火也**碰不到**真库', async () => {
  // ★ 这条判据的对象是**防线本身**：不是"某个测试记得注入"，而是
  //   "整套测试进程的 WORKBUDDY_HOME 指着临时目录 ⇒ 结构上写不到真库"。
  //   事故已经因此发生过两次（hardening 的 transport、多轮测试漏注入点火），
  //   所以必须有这条：**下一次再漏注入时，它照样安全。**
  assert.equal(
    process.env.WORKBUDDY_TEST_HOME_GUARD,
    'on',
    '★ 套件级护栏没生效 —— 说明 npm run test:host 没带 --import ./tools/dev/test-home-guard.mjs',
  );

  const before = realAutomationCount();
  assert.ok(before !== null, `真库读不到（${REAL_DB}）⇒ 本判据无法自证（见第 ① 步），fail-closed 不静默通过`);

  // ★ 故意在**没有** fixture、没有注入的前提下真点一次火。
  //   若护栏失效，这一下就会在用户 WorkBuddy 里建出一条真对话。
  const { startAutomationRun, workbuddyDbPath } = await import('../src/host/gateway/automation.js');
  const run = startAutomationRun({ prompt: 'GUARD-SUITE-LEVEL', cwd: '', timeoutMs: 1_200, pollMs: 100 });
  await run.done;

  const target = workbuddyDbPath();
  assert.match(target, /wb-test-home-|[\\/]Temp[\\/]/, `★ 点火落点必须既不是真库也不是夹具，实际：${target}`);
  assert.notEqual(target, REAL_DB, '★★ 点火落点绝不能是真库');
  assert.equal(realAutomationCount(), before, '★★ 真库行数必须一字不变 —— 这一条才是护栏的真正判据');
});

test('★★ 第 ③ 步：★ 失败的点火也必须退役（幽灵任务洞的回归）', async () => {
  const before = realAutomationCount();
  assert.ok(before !== null, `真库读不到（${REAL_DB}）⇒ 本判据无法自证（见第 ① 步），fail-closed 不静默通过`);

  const home = fixtureHome();
  const previous = process.env.WORKBUDDY_HOME;
  process.env.WORKBUDDY_HOME = home;
  try {
    const { startAutomationRun } = await import('../src/host/gateway/automation.js');
    // 桌面端不会去接这个夹具里的行 ⇒ 走 ignitionGraceMs/timeoutMs 失败路径。
    // ★ 关键：失败之后那一行**必须**已经 retired —— 否则它以 next_run_at=now 的活状态
    //   留在用户库里，**下次用户打开 WorkBuddy 它会自己跑**（这才是"计划一直循环"的真形态）。
    const run = startAutomationRun({
      prompt: 'GUARD-FAILURE-PATH', cwd: '', timeoutMs: 1_200, pollMs: 100,
      retire: true, // 默认行为，这里显式写出来让判据自解释
    });
    const out = await run.done;
    assert.equal(out.status, 'failed', '前提校验：这条路径必须是失败的（否则本判据什么都没测到）');
    assert.match(run.readOutput(), /\[retire\]/, '★ 失败路径必须也打印退役动作 —— 旧实现只在成功时退役');

    const db = new DatabaseSync(join(home, 'workbuddy.db'), { readOnly: true });
    const row = db.prepare('SELECT deleted_at, next_run_at FROM automations WHERE id = ?').get(out.automation.automationId);
    db.close();
    assert.ok(row !== undefined, '点火行必须真的写进夹具（否则本判据什么都没测到）');
    assert.notEqual(row.deleted_at, null, '★★ 失败也必须退役 —— 否则它会变成半夜自己开工的幽灵任务');
    assert.equal(realAutomationCount(), before, '★ 真库仍然一字不动');
  } finally {
    if (previous === undefined) delete process.env.WORKBUDDY_HOME;
    else process.env.WORKBUDDY_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('★★ 第 ② 步：`WORKBUDDY_HOME` 能把点火导到夹具，真库一字不动', async () => {
  const before = realAutomationCount();
  assert.ok(before !== null, `真库读不到（${REAL_DB}）⇒ 本判据无法自证（见第 ① 步），fail-closed 不静默通过`);

  const home = fixtureHome();
  const previous = process.env.WORKBUDDY_HOME;
  process.env.WORKBUDDY_HOME = home;
  try {
    // ★ 环境变量必须在 import 之后仍然生效 —— automation.js 每次点火都现读它（不是模块期拍死）。
    assert.equal(workbuddyDbPath(), join(home, 'workbuddy.db'), 'env 必须真的改写落点');

    const { startAutomationRun } = await import('../src/host/gateway/automation.js');
    // 点火会等调度器接住（真机没人接 ⇒ 靠 ignitionGraceMs 超时返回）。
    // 我们只验"写在哪"，所以给它一个极短的超时。
    const run = startAutomationRun({ prompt: 'GUARD-FIXTURE', cwd: '', timeoutMs: 1_500, pollMs: 100, retire: false });
    const out = await run.done;
    assert.ok(out.status === 'failed' || out.status === 'completed', '必须收敛（成功或超时失败都算）');
    assert.ok(out.automation?.automationId, '必须真的建过 id');

    // 行落进了夹具
    const fixture = new DatabaseSync(join(home, 'workbuddy.db'), { readOnly: true });
    const n = fixture.prepare('SELECT COUNT(*) AS n FROM automations WHERE id = ?').get(out.automation.automationId).n;
    fixture.close();
    assert.equal(n, 1, '★ 点火行必须落在 WORKBUDDY_HOME 指定的夹具里');

    // ★ 真库一个字都没动
    assert.equal(realAutomationCount(), before, '★ 真库行数必须与点火前完全一致');
  } finally {
    if (previous === undefined) delete process.env.WORKBUDDY_HOME;
    else process.env.WORKBUDDY_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
