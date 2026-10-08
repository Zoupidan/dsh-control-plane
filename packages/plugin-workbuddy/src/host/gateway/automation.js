/**
 * 自动化点火传输面（★ 2026-10-01）。
 *
 * <p>★ 这一路解决的是**没有门**的问题 ★★
 *
 * <p>`gateway` 走的是桌面端已经拉好的 sidecar（ACP over HTTP）。真机实测（2026-09-30/10-01）：
 *   sidecar 是**逐轮**的——一轮跑完进程就被回收，`~/.workbuddy/sessions/<pid>.json` 随即停更、
 *   `selectSidecar` 再也选不中它。所以"等一个活着的 sidecar 再下发"这条路的可用窗口取决于
 *   桌面端此刻在不在跑对话，**插件无法自己把窗口打开**：桌面端创建对话的那套 MethodChannel
 *   （`wb:<domain>:<action>`）在本进程之外，没有可写的入口。
 *
 * <p>★ 但桌面端**自己**留着一个可写的点火面：`automations` 表 ★★
 *
 * <p>桌面端内嵌的 `LocalAutomationScheduler`（日志 `~/.workbuddy/logs/automation.log`，
 *   `tickMs=30000 activeTickMs=5000 missedWindowMs=86400000 concurrency=3`）会轮询
 *   `~/.workbuddy/workbuddy.db`，把任何 `deleted_at IS NULL` 且到点的自动化**用桌面端自己的内部
 *   通路**建成一场真对话并把它自己把 prompt 发出去。⇒ 插件只要往表里写一行，就等于让桌面端
 *   自己开一场对话、自己选模型、自己带着工作目录跑。没有 CLI、没有凭据、没有 GUI 自动化。
 *
 * <p>★ 为什么写库是安全的 ★
 *   · 单次 `INSERT` + 一次轮询 `SELECT`，全是 WAL 下的短事务（`busy_timeout` 兜底）；
 *   · 调度器只**读**该表、只**写** `automation_runs` / `automation_runtime_state`，不存在写冲突；
 *   · 行是一次性的（`schedule_type='once'`、`next_run_at=now`），触发后即过期；
 *   · 取消 = 置 `deleted_at`（软删），可逆、可审计。
 *
 * <p>★ 形状与 `startGatewayRun` 逐字同形 ★
 *   进去 `{prompt, cwd, modelId, …}`，出来 `{cancel, done, readOutput}`，
 *   `done` 的产物仍是作业的 `{status, detail, exitCode, <transport>}`。
 *   上层（`tools/run.js`）因此不必知道底下换了一套路。
 *
 * @module host/gateway/automation
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { REASON_CODES } from '../launch/reason-codes.js';

const require_ = createRequire(import.meta.url);

/** 运行时旋钮。全部有默认值，真机行为由这些数字决定，故集中在一处便于复核。 */
export const AUTOMATION_DEFAULTS = Object.freeze({
  /** 轮询间隔：调度器 `activeTickMs=5000`，1s 足够细又不至于把库读热。★ 遗留兼容：默认轮询已改走下面的退避表（首轮2s、之后5s、最多12轮约60s），本字段只在调用方显式覆盖时生效（测试快路径）。 */
  pollMs: 1_000,
  /** 单次下发总上限。真机自动化的 `timeoutMs` 是 5400000（90min），插件侧给 15min。★ 默认轮询已被 `maxPollRounds` 截到约60s，本字段只在调用方显式覆盖时生效（测试快路径）或作为退避表之外的第二道墙。 */
  timeoutMs: 900_000,
  /** 写库拿不到锁时的等待上限（与 `workbuddy.db` 的 WAL 并发量级相称）。 */
  dbBusyTimeoutMs: 8_000,
  /**
   * 点火宽限：行写下去之后多久还没出现 `automation_runs` 行就判定"没被接住"。
   * 实测一次点火约 15s 内被接住（2026-09-17/10-01 两次），给 60s 留足 tick 余量。
   */
  ignitionGraceMs: 60_000,
  /** ★ `valid_until` 比 `timeoutMs` 宽出多少（ms）—— 见点火那步的 ★★★ 段。 */
  validUntilGraceMs: 600_000,
  /**
   * ★★★ 即建即撤的退避轮询表（2026-10-02 防刷频）★★★
   * 一次下发只 INSERT 一行；轮询只 SELECT `automation_runs` / `automation_runtime_state`，
   * 不重建、不重发 prompt。首轮 2s、之后 5s、最多 12 轮约 60s（2 + 11×5 = 57s）。
   * 一旦 `sessionFacts` 拿到 `sessions.id` 立刻 `retireRow` + 记 session/map adopt，
   * 后续走复用不再建行；超时/取消同样 retire，绝不留活行到 `valid_until`。
   */
  pollFirstMs: 2_000,
  pollRestMs: 5_000,
  maxPollRounds: 12,
  /**
   * ★★★ 熔断：库里"**已到期、还没被作废**"的活行达到这个数，就**拒绝再点火** ★★★
   *
   * <p>为什么必须有这道闸（2026-10-02 真机事故，不是设想）★
   * 一行计划任务 = 桌面端调度器下一次 tick（5s）就会开一条**真会话**并**真扣积分**。
   * 而 `valid_until = now + timeoutMs(15min) + grace(10min)`，也就是**任何一行写下去之后
   * 都有 25 分钟的"已到期但仍有效"窗口**。若 dsh 在点火途中被杀掉 / 崩溃，回收那一步
   * （`retireRow`）就永远不会执行 —— 那一行以活状态留在库里，**下次你打开 WorkBuddy 它自己开工**。
   * 实测这一次：一轮裸跑测试往真库插了 8 行，8 行全部仍会被调度器捡起来 ⇒ 再建 8 条垃圾对话、
   * 按分钟级连续烧积分。没有任何一处会拦它。
   *
   * <p>所以：**写库之前先数一遍**。已有若干行处于"已到期且未作废" ⇒ 说明前几轮没有正常收口，
   * 此时再点火就是往同一个洞里继续灌 —— 直接失败，并说清"先回收旧行"。
   * 阈值取 3：插件本身并发上限就是 1，留 2 的余量足以容纳"上一轮刚崩"的正常情形，
   * 而真正的失控（每分钟一条）会在第 4 行就被挡住。
   */
  maxArmedRows: 3,
});

/**
 * `automation_runs.status` 的终态词表（**推断，未证**：本仓只实测过 `ACCEPTED`）。
 *
 * ★ 为什么不靠它一条判终态：实测那一轮的 `status` **全程是** `ACCEPTED`，而"跑完了"这件事
 *   体现在 `result_success` 从 NULL 变成 1。所以 `isTerminalRun` 以 `result_success` 为主判据，
 *   这张表只在真机上出现别的字面量时兜底——留着是为了"失败也认得出终态"，不是为了主判据。
 */
const TERMINAL_RUN_STATUS = Object.freeze(new Set([
  'FAILED', 'ERROR', 'CANCELLED', 'CANCELED', 'REJECTED', 'EXPIRED', 'SKIPPED', 'TIMEOUT',
]));

// ───────────────────────────── 小工具 ─────────────────────────────

/**
 * WorkBuddy 的家目录。环境变量优先，便于测试与多 profile。
 *
 * <p>★★★ 2026-10-02：测试进程里**没有** `WORKBUDDY_HOME` 时**直接抛错**（fail-closed）★★★
 *
 * <p>为什么不能"回落到真家目录" ★
 * 套件级护栏 `tools/dev/test-home-guard.mjs` 靠的就是给 `WORKBUDDY_HOME` 指一个临时目录。
 * 而它**只挂在 npm 脚本的命令行上**（`node --import ./tools/dev/test-home-guard.mjs --test …`）。
 * 只要有人绕过脚本、直接 `node --test <某个测试文件>`，护栏就不在 ——
 * 此时旧实现静默回落到 `~/.workbuddy`，于是**任何一处忘了注入的点火都会写进用户真库**。
 * 这不是设想：2026-10-02 我自己就踩了，一次裸跑往用户库里插了 8 行**已到期、未过期的活计划任务**，
 * 其中 8 行仍会被桌面端调度器捡起来、再建 8 条垃圾对话。
 *
 * <p>所以这里改成**失败即停**：宁可在测试里立刻炸掉，也不要静默写到用户真库里。
 * 判据用 `NODE_TEST_CONTEXT`（node:test 给每个测试子进程设的官方环境变量，实测 `child-v8`），
 * 不用"猜命令行"那种脆办法。
 *
 * @returns {string}
 */
export function workbuddyHome() {
  const env = process.env.WORKBUDDY_HOME;
  if (typeof env === 'string' && env !== '') return env;
  // ★ fail-closed：测试进程必须显式指家目录，否则拒绝解析到真家目录。
  if (typeof process.env.NODE_TEST_CONTEXT === 'string' && process.env.NODE_TEST_CONTEXT !== '') {
    throw new Error(
      'workbuddy: refusing to resolve the real ' + join(homedir(), '.workbuddy')
      + ' from a test process (WORKBUDDY_HOME is unset). Run the suite through '
      + '`npm run test:host` / `npm run test:client` — they carry '
      + '`--import ./tools/dev/test-home-guard.mjs`, which points WORKBUDDY_HOME at a temp dir. '
      + 'Bypassing that import is what wrote real scheduled tasks into the user database before.',
    );
  }
  return join(homedir(), '.workbuddy');
}

/** 点火面的落点：调度器读的就是这个文件。 */
export function workbuddyDbPath() {
  return join(workbuddyHome(), 'workbuddy.db');
}

/**
 * 数"**已到期、还没被作废**"的活行 —— 也就是**现在就会被桌面端调度器捡起来**的那些。
 *
 * <p>★ 判据必须与调度器一致，否则这道闸就是装饰 ★
 * 桌面端只认三件事同时成立：`deleted_at IS NULL`（没被软删）、`next_run_at <= now`（到点）、
 * `valid_until` 未过（数据层的"到点作废"闸）。三者缺一，它就不跑。
 * 所以这里照抄这三条 —— 用"创建时间在最近 N 分钟内"之类的近似判据，会把早已作废的行算进来，
 * 于是闸门在正常情况下也会误报；而误报的闸门等于没有闸门（用户会学会忽略它）。
 *
 * @param {import('node:sqlite').DatabaseSync} db 已打开的库
 * @param {number} now
 * @returns {number}
 */
export function countArmedRows(db, now = Date.now()) {
  const rows = db.prepare(
    `SELECT valid_until FROM automations
      WHERE deleted_at IS NULL AND next_run_at <= ?`,
  ).all(now);
  let armed = 0;
  for (const r of rows) {
    const vu = Date.parse(r?.valid_until ?? '');
    if (Number.isNaN(vu) || vu > now) armed += 1; // 解析不动 = 桌面端也没有理由作废它 ⇒ 算武装
  }
  return armed;
}

/**
 * 列出"**已到期、还没被作废**"的活行 id（与 `countArmedRows` 同判据，供启动清扫逐行退役）。
 *
 * ★ 判据必须与调度器一致（见 `countArmedRows`）：`deleted_at IS NULL` + `next_run_at <= now` +
 *   `valid_until` 未过。三者缺一，桌面端就不跑；这里照抄，缺一就不列。
 *
 * @param {import('node:sqlite').DatabaseSync} db 已打开的库
 * @param {number} [now]
 * @returns {string[]} 活行 id（按 `next_run_at` 升序，老的在前）
 */
export function listArmedRows(db, now = Date.now()) {
  const rows = db.prepare(
    `SELECT id, valid_until FROM automations
      WHERE deleted_at IS NULL AND next_run_at <= ? ORDER BY next_run_at ASC`,
  ).all(now);
  const out = [];
  for (const r of rows) {
    const id = r?.id;
    if (typeof id !== 'string' || id === '') continue;
    const vu = Date.parse(r?.valid_until ?? '');
    if (Number.isNaN(vu) || vu > now) out.push(id);
  }
  return out;
}

/**
 * 把库里所有活行一次性退役（启动清扫用）。只做 `SELECT` + 逐行 `retireRow`，不建行、不重发 prompt。
 *
 * @param {import('node:sqlite').DatabaseSync} db 已打开的库
 * @param {number} [now]
 * @param {(line: string) => void} [push]
 * @returns {{ armed: number, swept: string[] }} `armed` = 清扫前活行数，`swept` = 实际退役的 id
 */
export function retireArmedRows(db, now = Date.now(), push = () => {}) {
  const ids = listArmedRows(db, now);
  const swept = [];
  for (const id of ids) {
    if (retireRow(db, id, push)) swept.push(id);
  }
  return { armed: ids.length, swept };
}

/**
 * ★★★ 启动清扫：`apply.js` 启动时调一次，把上一次 dsh 中途被杀留下的活行全退役 ★★★
 *
 * <p>为什么必须有这一步（2026-10-02 真机事故，约 200 元积分，不是设想）：
 * 一行计划任务 = 桌面端调度器下一次 tick 就会开一条**真会话**并**真扣积分**。
 * `retireRow()` 只能在我们还跑着的时候执行；dsh 在点火中途被杀/崩溃 ⇒ 那一行以活状态
 * 留在库里直到 `valid_until`（写下去后约 25 分钟）⇒ **下次用户打开 WorkBuddy 它自己开工**。
 * 启动时扫一遍（只 `SELECT` 活行 + 逐行软删）是数据层的第二道闸：进程活着时的 `retireRow`
 * 是第一道，这一步兜"dsh 没活到收口"的那一次。
 *
 * <p>★ 永不抛：库文件不存在 / 表不存在 / sqlite 不可用 / `WORKBUDDY_HOME` 在测试进程里未设置
 * （fail-closed）—— 任何一种都如实回 `error`，不带崩插件装配。调用方（`apply.js`）再包一层
 * try/catch，双保险。
 *
 * @param {{ push?: (line: string) => void }} [opts]
 * @returns {{ armed: number, swept: string[], error: string }} `error === ''` = 成功（即使扫出 0 行）
 */
export function sweepStartupAutomationRows(opts = {}) {
  const push = typeof opts?.push === 'function' ? opts.push : () => {};
  try {
    const DatabaseSync = loadSqlite();
    let dbPath;
    try {
      dbPath = workbuddyDbPath();
    } catch (err) {
      return { armed: 0, swept: [], error: err instanceof Error ? err.message : String(err) };
    }
    // ★ 库文件不存在 = 没有可清扫的活行，直接回空。不能走到 `new DatabaseSync(dbPath)`：
    //   sqlite 会**创建**这个文件 —— 在没装 WorkBuddy 的机器上，每次启动插件都会凭空造出一个
    //   空 `workbuddy.db`，而随后的 SELECT（无表）必然抛错。这两种结果都是错的。
    if (!existsSync(dbPath)) return { armed: 0, swept: [], error: '' };
    let db;
    try {
      db = new DatabaseSync(dbPath, { timeout: AUTOMATION_DEFAULTS.dbBusyTimeoutMs });
    } catch (err) {
      // 库文件不存在 / 打不开 = 没有可清扫的活行，不是错误（新机首次装插件即此态）。
      return { armed: 0, swept: [], error: '' };
    }
    try {
      try { db.exec(`PRAGMA busy_timeout = ${AUTOMATION_DEFAULTS.dbBusyTimeoutMs}`); } catch { /* 设不上也不致命 */ }
      const out = retireArmedRows(db, Date.now(), push);
      return { armed: out.armed, swept: out.swept, error: '' };
    } catch (err) {
      return { armed: 0, swept: [], error: err instanceof Error ? err.message : String(err) };
    } finally {
      try { db?.close(); } catch { /* 已关 */ }
    }
  } catch (err) {
    return { armed: 0, swept: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * ★★★ 把"这一行"退役（软删 `deleted_at`）——**任何终态都要做，不分成功失败** ★★★
 *
 * <p>为什么失败也必须退役（2026-10-01 实测出来的洞，不是设想的）：
 * 旧实现只在 `ok === true` 时退役。于是**跑失败 / 点火超时 / 桌面端压根没开**这三条路
 * 都会留下一行 `deleted_at IS NULL` 且 `next_run_at = now` 的活行 ——
 * 而 `next_run_at` 还是"到点"的意思，于是**下次用户打开 WorkBuddy，它会自己跑起来**。
 * 那不是无限循环，但它是"我明明已经放弃了，它半夜自己开工"，比循环更难解释。
 *
 * <p>这一行的使命在**终态那一刻就结束了**：不管桌面端接没接住、不管跑成功还是失败，
 * 我们都已经知道了答案，也已经把结论交回调用方。留着它只会让用户在自己的
 * 「计划任务」列表里看到一条自己没建、还会到点自己跑的东西。
 *
 * <p>★ 为什么软删而不是物理删 ★
 * 可审计、可一键还原（`deleted_at = NULL`），且 `automation_runs` 台账完整保留 ——
 * 回执里的两个 id、模型、积分都不受影响。
 *
 * @param {import('node:sqlite').DatabaseSync|null} db
 * @param {string|null} id
 * @param {(line: string) => void} [push]
 * @returns {boolean} 是否真的退役了
 */
export function retireRow(db, id, push = () => {}) {
  if (db === null || typeof id !== 'string' || id === '') return false;
  const at = Date.now();
  try {
    const changed = db
      .prepare('UPDATE automations SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(at, at, id).changes;
    push(`[retire] the scheduled-task row was soft-deleted (deleted_at=${at}, terminal outcome — success or failure)`
      + ' so it can never fire again and no longer shows in the desktop\'s own task list; automation_runs is kept for auditing');
    return changed === 1;
  } catch (err) {
    // ★ 退役失败**不改判整轮成败**：这一行没删掉只是列表里多一条，不是"任务没跑成"。
    push(`[retire] could not soft-delete the row (${err instanceof Error ? err.message : String(err)}); it stays in the desktop's task list`);
    return false;
  }
}

/**
 * 惰性取 `node:sqlite`。
 *
 * ★ 为什么不写成顶部静态 import：本仓 `engines.node` 是 `>=22.5.0`，而 `node:sqlite` 正是
 *   v22.5.0 引入、且**早期版本要加 `--experimental-sqlite` 才可用**。静态 import 会把这件
 *   事变成**插件加载期**的硬依赖——sqlite 一不可用，整个插件连"网关那一路"都跟着起不来。
 *   惰性加载则把失败收敛到"只有走自动化这一路时"才报，且能给出可解释的原因码。
 *   宿主实测（2026-10-01）：Electron 44 内嵌 node v24.18.1，`node:sqlite` 可用且**无需 flag**。
 */
function loadSqlite() {
  const mod = require_('node:sqlite');
  const DatabaseSync = mod?.DatabaseSync;
  if (typeof DatabaseSync !== 'function') {
    throw new Error('node:sqlite does not expose DatabaseSync in this runtime');
  }
  return DatabaseSync;
}

function jparse(text, fallback) {
  if (typeof text !== 'string' || text === '') return fallback;
  try {
    const v = JSON.parse(text);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

/** 可被 abort 打断的 sleep——否则"取消"要等到下一次轮询才生效，最长空转一个 pollMs。 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted === true) { resolve(); return; }
    let settled = false;
    // ★ 必须显式摘监听：`once` 只在**触发**时自动摘，而轮询是"每次都没触发"的常态。
    //   一秒一次的 sleep 跑十分钟 = 往同一个 signal 上挂几百个监听 ⇒ MaxListenersExceededWarning。
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener?.('abort', finish, { once: true });
  });
}

/**
 * 从桌面端自己的磁盘痕迹里读「现在在服务哪个账号」。
 *
 * 每次启动 WorkBuddy 都会往 `epoch-marker.json` 写一条带 `_<pid>` 尾号的
 * sandbox pipe；`security/<uid>/data.lock.holder` 里的 pipe 带同一个尾号 ⇒
 * 现任进程服务的账号就是那个 uid。没有精确命中时，退化为「mtime 最新的 holder
 * 的 uid」（切号事件几乎总会改写 holder，即便还没产生过新对话）。
 * 任何异常都返回 null ⇒ 上游降级到 sessions / automations 旧链路。
 */
export function currentAccountFromSecurityDir(home = null) {
  return currentAccountDetection(home).uid;
}

/**
 * 与 `currentAccountFromSecurityDir` 同源，但把「从哪条证据识别到的」也如实报出
 * （`epoch-marker-align` = 现任实例 epoch 尾号与某个 holder 对齐；
 *  `security-holder-mtime` = 只能用最新改动的 holder 推断；`none` = 两者都没证据；
 *  `error` = 读盘异常）。状态面 / 回执用它让用户确认识别账号 id 的来源，
 *  而不是只给一个没有来由的 uid。
 */
export function currentAccountDetection(home = null) {
  const none = { uid: null, method: 'none' };
  try {
    const root = typeof home === 'string' && home !== '' ? home : workbuddyHome();
    const securityDir = join(root, 'security');
    if (!existsSync(securityDir)) return none;
    let lane = '';
    try {
      const marker = JSON.parse(readFileSync(join(root, 'epoch-marker.json'), 'utf8'));
      const m = /_(\d+)$/.exec(String(marker?.epochAddress ?? ''));
      if (m !== null) lane = m[1];
    } catch { /* 没有 marker：按 mtime 启发式 */ }
    let best = null;
    for (const entry of readdirSync(securityDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const holderPath = join(securityDir, entry.name, 'data.lock.holder');
      let holder, mtime = 0;
      try {
        holder = readFileSync(holderPath, 'utf8');
        mtime = statSync(holderPath).mtimeMs;
      } catch { continue; }
      if (lane !== '' && holder.includes(`_${lane}`)) return { uid: entry.name, method: 'epoch-marker-align' };
      if (best === null || mtime > best.mtime) best = { uid: entry.name, mtime };
    }
    const uid = typeof best?.uid === 'string' ? best.uid.trim() : '';
    return uid === '' ? none : { uid, method: 'security-holder-mtime' };
  } catch { return { uid: null, method: 'error' }; }
}

/**
 * 取本机账号 id。
 *
 * ★ 不硬编码任何账号 id：把某台机器的 `owner_user_id` 写死进源码，等于把源码变成"只对一台机器成立"。
 *
 * ★★ 取值顺序（2026-10-03 真机事故修正）：**sessions 表最近活跃的 user_id 优先** —— 它是守护进程
 *   自己盖章的"当前登录账号"。此前只抄 automations 历史行的 owner：桌面一旦切换账号，新点火的行
 *   顶着旧 owner，被调度器 `ownerVisibility()` 的 fail-closed 归属隔离整批过滤——**零日志、零 dispatch、
 *   桥面 list 返回 []**，点火在用户眼里表现为"永远没有新会话"。旧 owner 行只配当兜底。
 *   旧库/夹具可能没有 `last_activity_at` 列，逐级降级到 `updated_at` / 无排序。
 *
 * ★★ 2026-10-08 事故二修：sessions 表的最新行同样可能是陈旧的 —— 桌面切号
 *   后如果还没产生过新对话，表里的 latest user_id 就是**旧账号**，而调度器
 *   `ownerVisibility()` 会把按旧 owner 写的行静默整批过滤（表现又是
 *   "点火永远没有新会话"）。桌面端真正的现役账号痕迹在
 *   `~/.workbuddy/security/<uid>/data.lock.holder`：现任进程写的那份
 *   `epoch-marker.json` 与 holder 内容里带同一个 sandbox pipe 尾号。
 *   所以把这份磁盘证据挪到 sessions 表**之前**：命中即采用，否则降级到
 *   sessions / automations 的旧链路（夹具目录没有 security/ 时行为完全不变）。
 */
export function resolveOwnerUserId(db) {
  const fromSecurityDir = currentAccountFromSecurityDir();
  if (fromSecurityDir !== null) return fromSecurityDir;
  const sessionAttempts = [
    "SELECT user_id FROM sessions WHERE user_id IS NOT NULL AND user_id <> '' ORDER BY last_activity_at DESC LIMIT 1",
    "SELECT user_id FROM sessions WHERE user_id IS NOT NULL AND user_id <> '' ORDER BY updated_at DESC LIMIT 1",
  ];
  for (const sql of sessionAttempts) {
    try {
      const row = db.prepare(sql).get();
      // 与桌面 currentUserId() 的 `uid?.trim() || void 0` 同语义：trim 后判定，空白串不算登录态。
      const uid = typeof row?.user_id === 'string' ? row.user_id.trim() : '';
      if (uid !== '') return uid;
      break; // sessions 表存在但没有可用行：换排序不再有信息量，直接走兜底
    } catch { /* 列/表不存在（旧库或夹具）：降级到下一档 */ }
  }
  const a = db.prepare("SELECT owner_user_id FROM automations WHERE owner_user_id IS NOT NULL AND owner_user_id <> '' LIMIT 1").get();
  const legacyUid = typeof a?.owner_user_id === 'string' ? a.owner_user_id.trim() : '';
  if (legacyUid !== '') return legacyUid;
  return null;
}

/**
 * 生成点火 id，形态与真机既有的自动化 id 一致（`automation-<epochMs>`）。
 *
 * ★ 为什么保持同一形态：桌面端另有 UUIDv4 形态的 id（两套命名空间），而调度器如何解析 id
 *   本仓没有证据。**照抄实测可行的形态**比自创一个更安全；同毫秒撞车时顺延到空位。
 */
function nextAutomationId(db, at) {
  let n = at;
  for (;;) {
    const id = `automation-${n}`;
    const hit = db.prepare('SELECT id FROM automations WHERE id = ?').get(id);
    if (hit === undefined || hit === null) return id;
    n += 1;
  }
}

/**
 * 转成带本地时区偏移的 ISO（`2026-10-01T00:17:14+08:00`）。
 *
 * ★ `automations.scheduled_at` 真机存的就是这个形状（带偏移的串），而 `next_run_at` 是同刻的
 *   epoch ms。两列口径不同，必须都写上——只写一列会让"到点了吗"和"显示成几点"各说各话。
 */
export function localIso(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const p2 = (n) => String(Math.abs(n)).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
    + `T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
    + `${sign}${p2(Math.floor(Math.abs(off) / 60))}:${p2(Math.abs(off) % 60)}`;
}

/**
 * 工作目录 → 转录目录名的变形（真机：`D:\a\b` ⇒ `d-a-b`）。
 *
 * ★ 盘符字母**小写化**、盘符后的 `:` **丢掉**（不是替换成 `-`），分隔符 → `-`。
 *   实测反推：`D:\demo\…\wb-cwd-probe` ⇒ `d-demo-…-wb-cwd-probe`（注意是 `d-demo` 而非
 *   `d--user`，所以 `:` 是丢掉）。
 */
export function slugForCwd(cwd) {
  return String(cwd)
    .replace(/^([A-Za-z]):/, (_m, drive) => drive.toLowerCase())
    .replace(/[\\/]+/g, '-');
}

/**
 * 会话转录路径。
 *
 * ★ 先按推出来的目录名直接拼；**拼不中就把 `projects/` 扫一遍按会话 id 找**。
 *   为什么不只靠拼：目录名是工作目录经过一层**未公开**的变形规则得到的（中文、空格、
 *   大小写在别的路径上会怎样，本仓没有样本）。会话 id 是 UUID、全局唯一，按它找是确定的，
 *   而扫几百个目录的代价可以接受——把"猜变形规则"换成"找唯一键"。
 */
export function transcriptPathFor(cwd, conversationId) {
  if (typeof conversationId !== 'string' || conversationId === '') return null;
  const base = join(workbuddyHome(), 'projects');
  if (typeof cwd === 'string' && cwd !== '') {
    const direct = join(base, slugForCwd(cwd), `${conversationId}.jsonl`);
    if (existsSync(direct)) return direct;
  }
  try {
    for (const d of readdirSync(base)) {
      const p = join(base, d, `${conversationId}.jsonl`);
      if (existsSync(p)) return p;
    }
  } catch {
    // 没有 projects 目录：如实按"找不到"处理，由调用方退回 runs_json / thread_title
  }
  return null;
}

/**
 * 从转录里取**最后一条 assistant 正文**。
 *
 * ★★ 记录形状是实测出来的，不是猜的（这个坑已经踩过一次：早期提取器按
 *   `type:"user"/"assistant"` 找，结果一条都取不到、打印为空，因为 jsonl 里根本没有那种 type）：
 *     · assistant 正文：`type:"message"` + `content:[{type:"output_text", text}]`，
 *       而且这条**没有 `role` 字段**；
 *     · 用户输入：`type:"message"` + `role:"user"` + `content:[{type:"input_text"}]`。
 *   ⇒ 过滤条件必须是"**不是** user 且带 output_text"，写成 `role === 'assistant'` 会全空。
 *   取最后一条：中间可能有多段（工具调用之间的措辞），终稿才是要交回去的答案。
 */
export function readReplyFromTranscript(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let last = null;
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (s === '') continue;
    let rec;
    try { rec = JSON.parse(s); } catch { continue; }
    if (rec?.type !== 'message' || rec.role === 'user') continue;
    const parts = Array.isArray(rec.content) ? rec.content : [];
    const text = parts
      .filter((p) => p?.type === 'output_text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
    if (text.trim() !== '') last = text;
  }
  return last;
}

/**
 * 这一轮算跑完了吗。
 *
 * ★ 主判据是 `result_success` 非空（实测：跑完 = 1）。`failure_code` 与状态词表是兜底——
 *   让"失败收场"也认得出终态，否则一次硬失败会把插件挂到 timeout 才返回，用户看到的是转圈。
 */
export function isTerminalRun(row) {
  if (row === null || row === undefined) return false;
  if (row.result_success !== null && row.result_success !== undefined) return true;
  if (row.failure_code !== null && row.failure_code !== undefined && row.failure_code !== '') return true;
  return TERMINAL_RUN_STATUS.has(String(row.status ?? '').toUpperCase());
}

/** 会话侧的事实：模型/权限/强度是否真的按我们写的生效了，以及这一轮烧了多少积分。 */
export function sessionFacts(db, conversationId) {
  // ★ effective effort 的真源是 `sessions.thought_level`（真库实测：high/max 与 automations.reasoning_effort 同值域）。
  //   旧夹具库（automation-early-retire.test.js fixture）无该列 ⇒ 回落到旧查询，effort 记 null（未知，不编造）。
  let s = null;
  try {
    s = db.prepare(
      'SELECT model, permission_mode, cwd, title, thought_level, created_at, source_mode, is_background_automation FROM sessions WHERE id = ?',
    ).get(conversationId) ?? null;
  } catch {
    try {
      s = db.prepare(
        'SELECT model, permission_mode, cwd, title, created_at, source_mode, is_background_automation FROM sessions WHERE id = ?',
      ).get(conversationId) ?? null;
    } catch {
      s = null;
    }
  }
  const u = db.prepare('SELECT used, size, credit_json FROM session_usage WHERE session_id = ?')
    .get(conversationId) ?? null;
  let creditsUsed = null;
  const credit = jparse(u?.credit_json, null);
  if (credit !== null && typeof credit === 'object') {
    const vals = Object.values(credit).filter((v) => typeof v === 'number' && Number.isFinite(v));
    if (vals.length > 0) creditsUsed = vals.reduce((a, b) => a + b, 0);
  }
  return {
    model: s?.model ?? null,
    permissionMode: s?.permission_mode ?? null,
    sessionCwd: s?.cwd ?? null,
    title: s?.title ?? null,
    // ★ 推理强度实际生效值：sessions.thought_level（无列/无值 ⇒ null = 未知，不编造）。
    effort: s?.thought_level ?? null,
    createdAt: s?.created_at ?? null,
    creditsUsed,
    tokensUsed: u?.used ?? null,
    tokensSize: u?.size ?? null,
  };
}

/**
 * 把自动化创建的会话**归一成普通会话**（让它在桌面端正常会话列表里出现）。
 *
 * ★ 为什么需要它：用户的原话是"在 workerbuddy 上一个新会话记录都没看到"。实测两行的差异里，
 *   只有 `is_background_automation` 是**干净的分界**（自动化 = 1，正常 = 全 NULL）；
 *   `is_playground` 与 `source_mode` 在正常会话里本身就是**混的**（0/1 都有、
 *   working/craft/design/coding 都有）⇒ 它们不是列表的判据，动它们只有风险没有收益。
 *   所以这里**只动两列**：`is_background_automation` → NULL，`session_settings` → NULL
 *   （后者整段只装 `{"automation":{…},"conversationTags":{…}}`，而正常会话是 NULL）。
 *
 * ★ 这条归一目前是**推断，未证**：没有任何一条证据直接证明桌面端列表按这两列过滤。
 *   能保底的是它**不丢信息**——自动化 id / 子运行 id / 会话 id 都持久在 `automation_runs`
 *   那一侧（`thread_id` + `metadata_json`），这里是渲染提示，不是账本。
 *
 * ★ 只在 run **已终态之后**调用：`session_settings.automation.timeoutMs` 这些是**运行期**读的，
 *   跑完再改不会影响这一轮。
 *
 * @returns {number} 实际改动的行数（0 = 没找到会话，如实返回，不假装成功）
 */
export function promoteSession(db, conversationId) {
  const r = db.prepare(
    'UPDATE sessions SET is_background_automation = NULL, session_settings = NULL WHERE id = ?',
  ).run(conversationId);
  return Number(r?.changes ?? 0);
}

/** 作业输出首行。与 `gatewayHeader` 同位置：读者一眼知道底下走的是哪条路。 */
export function automationHeader({ model, cwd }) {
  return `transport=automation · model=${model || '(desktop default)'} · cwd=${cwd}`;
}

// ───────────────────────────── 下发主体 ─────────────────────────────

/**
 * 算出本轮的轮询等待表（退避：首轮2s、之后5s、最多12轮约60s）。
 *
 * <p>★★ 防刷频的执行点 ★★：默认走退避表（`AUTOMATION_DEFAULTS.pollFirstMs/pollRestMs/maxPollRounds`），
 * 轮询体内只 `SELECT automation_runs / automation_runtime_state`，不重建、不重发 prompt。
 * 调用方显式覆盖 `pollMs`/`timeoutMs`（测试快路径）时走遗留固定间隔，以便测试在毫秒级收敛；
 * 显式给出新三元组（`pollFirstMs`/`pollRestMs`/`maxPollRounds`）时以显式值为准。
 *
 * @param {{ pollMs?: number, timeoutMs?: number, pollFirstMs?: number, pollRestMs?: number, maxPollRounds?: number }} o
 * @returns {{ waits: number[], rounds: number, legacy: boolean }}
 */
export function buildPollWaits(o = {}) {
  const first = o.pollFirstMs ?? AUTOMATION_DEFAULTS.pollFirstMs;
  const rest = o.pollRestMs ?? AUTOMATION_DEFAULTS.pollRestMs;
  const rounds = o.maxPollRounds ?? AUTOMATION_DEFAULTS.maxPollRounds;
  const explicitNew = o.pollFirstMs !== undefined || o.pollRestMs !== undefined || o.maxPollRounds !== undefined;
  if (explicitNew) {
    const r = Number.isSafeInteger(rounds) && rounds > 0 ? rounds : AUTOMATION_DEFAULTS.maxPollRounds;
    const f = Number.isFinite(first) && first > 0 ? Math.round(first) : AUTOMATION_DEFAULTS.pollFirstMs;
    const s = Number.isFinite(rest) && rest > 0 ? Math.round(rest) : AUTOMATION_DEFAULTS.pollRestMs;
    return { waits: [f, ...Array(Math.max(0, r - 1)).fill(s)], rounds: r, legacy: false };
  }
  const legacyPoll = o.pollMs ?? AUTOMATION_DEFAULTS.pollMs;
  const legacyTimeout = o.timeoutMs ?? AUTOMATION_DEFAULTS.timeoutMs;
  if (legacyPoll !== AUTOMATION_DEFAULTS.pollMs || legacyTimeout !== AUTOMATION_DEFAULTS.timeoutMs) {
    const interval = Number.isFinite(legacyPoll) && legacyPoll > 0 ? Math.round(legacyPoll) : AUTOMATION_DEFAULTS.pollMs;
    const total = Number.isFinite(legacyTimeout) && legacyTimeout > 0 ? Math.round(legacyTimeout) : AUTOMATION_DEFAULTS.timeoutMs;
    const n = Math.max(1, Math.ceil(total / Math.max(1, interval)));
    return { waits: Array(n).fill(interval), rounds: n, legacy: true };
  }
  const r = AUTOMATION_DEFAULTS.maxPollRounds;
  return { waits: [AUTOMATION_DEFAULTS.pollFirstMs, ...Array(Math.max(0, r - 1)).fill(AUTOMATION_DEFAULTS.pollRestMs)], rounds: r, legacy: false };
}

/**
 * 确认桌面端会话行真实存在（`sessions.id`），存在才返回 `sessionFacts`，否则 null。
 *
 * <p>★ 为什么不能只看 `runtime_state.running_conversation_id`：那一列是调度器"正在跑"的记账，
 * 写进去与 `sessions` 行提交之间可能有窗口；没确认就 adopt 会把一个不存在的 id 记进会话映射，
 * 下一轮复用去 load 它必然失败。`sessionFacts` 本身在找不到时回全 null 行——调用方分不清
 * "会话存在但字段空"与"会话根本不存在"，所以这里先显式查存在性，再取 facts。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} conversationId
 * @returns {object|null} `sessionFacts` 的产物（含 `model/permission/credits`），不存在 ⇒ null
 */
export function confirmedSessionFacts(db, conversationId) {
  if (db === null || typeof conversationId !== 'string' || conversationId === '') return null;
  let hit = null;
  try {
    hit = db.prepare('SELECT id FROM sessions WHERE id = ?').get(conversationId) ?? null;
  } catch {
    return null; // 表不存在 / 锁失败 ⇒ 按"没确认"处理，由轮询继续等，不炸整轮
  }
  if (hit === null || hit === undefined) return null;
  try {
    return sessionFacts(db, conversationId);
  } catch {
    return null;
  }
}

/**
 * 跑一轮"自动化点火"下发。
 *
 * <p>★★★ 一次下发只 INSERT 一行（防刷频）★★★：函数体内有且仅有两个写点 ——
 * `automations` 一行 + `automation_runtime_state` 一行（`INSERT OR IGNORE`）。
 * 轮询体内只 `SELECT automation_runs / automation_runtime_state`（+ `sessions` 存在性确认），
 * 不重建、不重发 prompt。一旦 `sessionFacts` 拿到 `sessions.id` 立刻 `retireRow` +
 * 记 session/map adopt（`key=session_key`），后续走复用不再建行；超时/取消同样 retire，
 * 绝不留活行到 `valid_until`。
 *
 * @param {object} o
 * @param {string} o.prompt 任务文本（必填，非空）
 * @param {string} o.cwd 工作目录（写进 `automations.cwds`，桌面端据此建会话）
 * @param {string|null} [o.modelId] 模型 id（写进 `automations.model_id`）
 * @param {string|null} [o.permissionMode] 权限模式（写进 `automations.permission_mode`）
 * @param {string|null} [o.reasoningEffort] 推理档位（写进 `automations.reasoning_effort`）
 * @param {string|null} [o.name] 自动化名（桌面端拿它当**会话标题**）
 * @param {number} [o.timeoutMs] 总上限（遗留：默认轮询已被 `maxPollRounds` 截到约60s；显式覆盖时与 `pollMs` 联动走固定间隔快路径）
 * @param {number} [o.pollMs] 轮询间隔（遗留：同上）
 * @param {number} [o.pollFirstMs] 退避首轮等待（默认 2000）
 * @param {number} [o.pollRestMs] 退避后续等待（默认 5000）
 * @param {number} [o.maxPollRounds] 退避最大轮数（默认 12，约60s）
 * @param {string} [o.sessionKey] 会话映射键：拿到 `sessions.id` 后立刻 `sessionStore.adopt(key, …)`，后续走复用不再建行
 * @param {{ adopt?: (key: string, rec: object) => any, forget?: (key: string) => any }} [o.sessionStore] 会话映射写口（`loadSessionMap` 的子集即可）
 *   `adopt` = 记住本轮确认的会话（成功保留）；`forget` = 终态失败/取消/超时作废该 key（下轮重建）。
 * @param {AbortSignal} [o.signal] 上游取消信号
 * @param {(phase: string) => void} [o.onPhase] 阶段回调
 * @param {boolean} [o.promote] 跑完是否把会话归一成普通会话（默认 true）
 * @param {boolean} [o.retire] 跑完是否把**这一行**软删掉（默认 true）—— 见函数体内 ★★ 段。
 *   置 `false` 可保留这一行以便在桌面端里事后核对；代价是它会留在用户的计划任务列表里。
 * @returns {{cancel: () => void, done: Promise<object>, readOutput: () => string}}
 */
export function startAutomationRun({
  prompt, cwd, modelId = null, permissionMode = null, reasoningEffort = null,
  name = null, timeoutMs = AUTOMATION_DEFAULTS.timeoutMs, pollMs = AUTOMATION_DEFAULTS.pollMs,
  pollFirstMs, pollRestMs, maxPollRounds,
  sessionKey = '', sessionStore = null,
  signal, onPhase, promote = true, retire = true,
}) {
  const controller = new AbortController();
  const onUpstreamAbort = () => controller.abort();
  if (signal !== undefined) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener?.('abort', onUpstreamAbort, { once: true });
  }

  // 增量输出缓冲：语义与 spawn / gateway 两路一致（游标消费）。
  let buffer = '';
  let cursor = 0;
  let headerPending = true;
  let lastPhase = '';
  // 阶段轨迹单独留一份：作业收据要能说明"卡在哪一步"，而输出流是游标消费的、读完就没了。
  const phases = [];
  const push = (line) => { buffer += `${line}\n`; };
  const phase = (p) => {
    if (p === lastPhase) return;
    lastPhase = p;
    phases.push(p);
    push(`… ${p}`);
    onPhase?.(p);
  };

  const done = (async () => {
    // ★ 本层**永不 reject**：`done` 是作业收敛的唯一出口，让异常逃出去会变成未处理 rejection，
    //   作业永远停在 running——比报错更坏（用户看到的是转圈）。上游还兜一层，但兜底不该是唯一防线。
    let db = null;
    let automationId = null;
    let conversationId = null;
    // ★ 即建即撤的记账：`retired=true` 必须能被 `lastRun`/status 查到（任务要求）。
    //   `retire=false` 的显式保留路径除外，其余任何终态（成功/失败/超时/取消）都要置位。
    let retired = false;
    // ★ 会话复用的记账：`sessionStore.adopt(sessionKey, …)` 的产物（`null` = 没配写口或还没确认）。
    let sessionPersist = null;
    let adopted = false;
    const keyOf = typeof sessionKey === 'string' && sessionKey !== '' ? sessionKey : '';
    const doRetire = () => {
      if (!retire || retired || db === null || typeof automationId !== 'string' || automationId === '') return retired;
      try {
        if (retireRow(db, automationId, push)) retired = true;
      } catch { /* retireRow 内部已 push 成因，这里只保"不改判成败" */ }
      return retired;
    };
    // ★ 会话回收：终态失败/取消/超时 forget（下轮重建）；成功保留（不 forget）。
    //   调用方（run.js 复用链）按 `session_key` 查到记住的 id 才走复用；一旦本轮失败，
    //   记住的 id 很可能已死（桌面端会话不在/被拒），留着只会让下轮复用去 load 一个死会话。
    //   故失败即作废，成功则保留。`forget` 缺席（极简假宿主）时跳过，不炸整轮。
    const doForget = (why) => {
      if (keyOf === '' || typeof sessionStore?.forget !== 'function') return;
      try {
        sessionStore.forget(keyOf);
        push(`[session] forgot ${JSON.stringify(keyOf)} (${why}); next round rebuilds a new conversation`);
      } catch (err) {
        push(`[session] forget failed for ${JSON.stringify(keyOf)} (${err instanceof Error ? err.message : String(err)}); next round may retry reuse`);
      }
    };

    const fail = (reason, message) => {
      // ★★★ 失败**也**退役（根因修复，2026-10-01；2026-10-02 即建即撤收紧：连"会话已建但运行没收敛"也要退）★★★
      //   这一行的使命在终态就结束了。若失败时不删，它会以 `next_run_at = now` 的
      //   活状态留在用户库里 —— 那意味着**下次打开 WorkBuddy 它会自己跑**。
      //   （实测过：桌面端没开 / 点火超时 / 跑失败，旧实现全都留下了这种行。）
      doRetire();
      // ★ 终态失败/取消/超时 forget（下轮重建）；成功保留（见成功分支无 forget）。
      doForget(reason);
      push(`[failed] ${reason} · ${message}`);
      return {
        status: 'failed',
        detail: `${reason}: ${message}`,
        exitCode: 1,
        automation: {
          reason, automationId, conversationId,
          sessionId: conversationId, sessionKey: keyOf === '' ? null : keyOf,
          sessionPersist, retired,
          transcriptPath: null,
          reply: null, creditsUsed: null, model: null, permission: null,
          // ★ effort/任务可视占位：失败时 effective 未知 ⇒ null（不编造）；requested 由上层（run.js/execute.js）
          //   按入参补齐，本层如实给 null 占位以保形状稳定。
          requestedEffort: null, effectiveEffort: null, effort: null,
          title: null, createdAt: null,
          phases: [...phases],
        },
      };
    };

    try {
      const DatabaseSync = loadSqlite();
      db = new DatabaseSync(workbuddyDbPath(), { timeout: AUTOMATION_DEFAULTS.dbBusyTimeoutMs });
      // 双保险：构造函数收 `timeout` 之外，再显式设一次 pragma（不同小版本对构造项的处理不一致）。
      try { db.exec(`PRAGMA busy_timeout = ${AUTOMATION_DEFAULTS.dbBusyTimeoutMs}`); } catch { /* 读多写少，设不上也不致命 */ }
      phase('db-open');

      const now = Date.now();
      const requestedModel = typeof modelId === 'string' && modelId !== '' ? modelId : null;
      const requestedPerm = typeof permissionMode === 'string' && permissionMode !== '' ? permissionMode : null;
      const requestedEffort = typeof reasoningEffort === 'string' && reasoningEffort !== '' ? reasoningEffort : null;
      const title = typeof name === 'string' && name.trim() !== '' ? name.trim().slice(0, 80) : prompt.trim().slice(0, 60);
      const ownerUserId = resolveOwnerUserId(db);

      // ═══ ★★★ 熔断闸：写库之前先数"已到期且未作废"的活行 ★★★ ═══════════════════
      // 一行这样的活行 = 桌面端下一次 tick 就会开一条真会话、真扣积分。
      // 有若干行卡在这个状态 ⇒ 前几轮没有正常收口（dsh 中途被杀、或上一次点火超时）。
      // 此时再写一行就是**继续往同一个洞里灌**，所以直接失败 —— 并且必须说清下一步动作。
      const armed = countArmedRows(db, now);
      if (armed >= AUTOMATION_DEFAULTS.maxArmedRows) {
        return fail(
          REASON_CODES.TASK_ERROR,
          `refusing to start: the WorkBuddy database already has ${armed} scheduled task(s) that are due and not yet retired `
          + `(limit ${AUTOMATION_DEFAULTS.maxArmedRows}). Each of them will open a real conversation and spend credits when the `
          + `desktop next ticks. This means earlier runs did not finish cleanly. Open WorkBuddy once and let the scheduler drain them, `
          + `or retire them, then retry. Refusing to add one more.`,
        );
      }

      automationId = nextAutomationId(db, now);

      // ★ 写这一行 = 点火。`next_run_at = now` ⇒ 下一次 tick（activeTickMs=5000）就会命中。
      //   实测 ✓（2026-10-01）：写下去约 15s 内 automation.log 出现
      //   `dispatch automation … dispatchOrder=1 jitterMs=0`，随后真会话 + 真回复 + 积分扣减。
      db.prepare(
        `INSERT INTO automations (
           id, name, prompt, status, schedule_type, next_run_at, last_run_at,
           cwds, rrule, scheduled_at, valid_until, model_id, model_is_thinking, permission_mode,
           reasoning_effort, owner_user_id, owner_status, owner_source,
           created_at, updated_at, deleted_at
         ) VALUES (?, ?, ?, 'ACTIVE', 'once', ?, NULL, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, NULL)`,
      ).run(
        automationId, title, prompt, now,
        // ★ 没给工作目录就写 `[]`，**不写 `[""]`**：空串是一个"指定了一个空目录"的断言，
        //   而 `[]` 才是"没指定，由桌面端用它自己的默认值"。两者含义不同，别混。
        //   此时转录按会话 id 在 `projects/` 下扫（`transcriptPathFor` 的兜底），仍然找得到。
        cwd === '' ? '[]' : JSON.stringify([cwd]), localIso(now),
        // ★★★ `valid_until` = 数据层的"到点作废"闸，**不依赖我们的进程还活着** ★★★
        //   `retireRow()` 只能在我们还跑着的时候执行。若 dsh 在点火中途被杀/崩溃，
        //   那一行会以 `deleted_at IS NULL` + `next_run_at = now` 的活状态留在用户库里 ——
        //   而 `next_run_at` 还是"到点"的意思 ⇒ **下次用户打开 WorkBuddy，它会自己开工**。
        //   那是"我明明放弃了，它半夜自己跑"，比循环更难解释。
        //   窗口给得比 `timeoutMs` 宽（多 10 分钟），确保正常那一趟绝不会被自己的闸挡住。
        localIso(now + timeoutMs + AUTOMATION_DEFAULTS.validUntilGraceMs),
        requestedModel, requestedEffort === null ? 0 : 1, requestedPerm,
        requestedEffort, ownerUserId,
        ownerUserId === null ? 'legacy_unassigned' : 'confirmed',
        now, now,
      );
      // 运行时状态行（`running=0`）：让"这一条从没跑起来"和"跑起来了但卡住"在事后可区分。
      db.prepare('INSERT OR IGNORE INTO automation_runtime_state (automation_id, running) VALUES (?, 0)').run(automationId);
      // ★★★ 一次下发只 INSERT 一行（防刷频的断言点）★★★
      // 本函数至此有且仅有两个写点：上面那一个 `automations` INSERT + 这一行 `automation_runtime_state`
      // `INSERT OR IGNORE`。轮询体内**只有 SELECT**（`automation_runs` / `automation_runtime_state` /
      // `sessions` 存在性确认），不重建、不重发 prompt —— 测试据此断言"全表恰好一行"。
      try {
        const n = db.prepare('SELECT COUNT(*) AS n FROM automations WHERE id = ?').get(automationId)?.n ?? 0;
        if (n !== 1) {
          return fail(REASON_CODES.TASK_ERROR,
            `expected exactly one automation row for ${automationId} but found ${n} — refusing to poll a duplicated ignition`);
        }
      } catch (err) {
        return fail(REASON_CODES.TASK_ERROR, `could not verify the single-row ignition (${err instanceof Error ? err.message : String(err)})`);
      }

      push(`[automation] ${automationId} · name=${JSON.stringify(title)} · cwd=${cwd}`);
      push(`[automation] scheduled_at=${localIso(now)} · next_run_at=${now} · model=${requestedModel ?? '(desktop default)'}`
        + ` · permission=${requestedPerm ?? '(desktop default)'}${requestedEffort === null ? '' : ` · effort=${requestedEffort}`}`);
      phase('awaiting-scheduler-tick');

      // ★ 退避轮询表：默认首轮 2s、之后 5s、最多 12 轮约 60s（见 buildPollWaits）。
      //   显式覆盖 pollMs/timeoutMs（测试快路径）时走固定间隔，不在此处硬编码秒数。
      const schedule = buildPollWaits({ pollMs, timeoutMs, pollFirstMs, pollRestMs, maxPollRounds });
      const t0 = Date.now();
      let sawRun = false;
      const adoptSession = (sid) => {
        if (adopted || keyOf === '' || typeof sessionStore?.adopt !== 'function') return;
        if (typeof sid !== 'string' || sid === '') return;
        try {
          const r = sessionStore.adopt(keyOf, { cliSessionId: sid, cwd, own: true });
          sessionPersist = r ?? null;
          adopted = r?.ok === true;
          push(`[session] adopted ${sid} under key=${JSON.stringify(keyOf)} · ok=${adopted === true}`
            + ' · later runs reuse it instead of inserting another automation row');
        } catch (err) {
          push(`[session] adopt failed for ${sid} (${err instanceof Error ? err.message : String(err)}); later runs will insert again`);
        }
      };
      for (let round = 0; ; round += 1) {
        if (controller.signal.aborted) {
          // 取消 = 软删，可逆且可审计（调度器只认 `deleted_at IS NULL`）。
          // ★ 已经开跑的那一轮**掐不断**（对话在桌面端进程里），所以措辞要如实：
          //   能保证的只是"调度器不会再接住这一条"。取消同样 retire，绝不留活行。
          doRetire();
          return fail(REASON_CODES.ABORTED, `cancelled · ${automationId} was soft-deleted (deleted_at set) so the scheduler will not pick it up; a run already started inside the desktop cannot be interrupted from here`);
        }

        // ★ 轮询体内只 SELECT，不重建、不重发 prompt。
        const row = db.prepare('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC LIMIT 1').get(automationId) ?? null;
        const st = db.prepare('SELECT * FROM automation_runtime_state WHERE automation_id = ?').get(automationId) ?? null;

        if (typeof st?.running_conversation_id === 'string' && st.running_conversation_id !== '') {
          const sid = st.running_conversation_id;
          // ★ 一旦 sessionFacts 拿到 sessions.id 立刻 retireRow + 记 adopt，后续走复用不再建行。
          //   存在性确认（confirmedSessionFacts）是前提：running_conversation_id 先于 sessions 行提交时不 adopt。
          const facts = confirmedSessionFacts(db, sid);
          if (facts !== null) {
            if (conversationId === null) {
              conversationId = sid;
              push(`[conversation] ${sid} · (from automation_runtime_state, while running; sessions.id confirmed)`);
              phase('running');
            }
            if (!retired) {
              doRetire();
              push(`[retire] early-retired on session confirm (round ${round + 1}/${schedule.rounds}) so no live row survives even if this process is killed now`);
            }
            adoptSession(sid);
          } else if (conversationId === null) {
            conversationId = sid;
            push(`[conversation] ${sid} · (from automation_runtime_state, while running; sessions row not yet visible)`);
            phase('running');
          }
        }
        if (row !== null && !sawRun) {
          sawRun = true;
          push(`[run] ${row.thread_id} · status=${row.status} · cwd=${row.source_cwd ?? cwd}`);
          phase('running');
        }

        if (row !== null && isTerminalRun(row)) {
          // ── 终态：把五件事一起交回去（会话 id / 转录 / 回复 / 模型 / 积分） ──
          const meta = jparse(row.metadata_json, {}) ?? {};
          const runs = jparse(row.runs_json, []) ?? [];
          const last = Array.isArray(runs) && runs.length > 0 ? runs[runs.length - 1] : {};
          const cid = [meta.conversationId, last.conversationId, conversationId]
            .find((x) => typeof x === 'string' && x !== '') ?? null;
          conversationId = cid;
          const ok = row.result_success === 1 || row.result_success === true;
          const transcriptPath = transcriptPathFor(last.cwd ?? cwd, cid);
          const reply = (transcriptPath === null ? null : readReplyFromTranscript(transcriptPath))
            ?? (typeof last.output === 'string' && last.output !== '' ? last.output : null)
            ?? (typeof row.thread_title === 'string' && row.thread_title !== '' ? row.thread_title : null);
          const facts = cid === null ? null : sessionFacts(db, cid);

          if (cid !== null) push(`[conversation] ${cid} · transcript=${transcriptPath ?? '(not found)'}`);
          if (facts !== null) {
            // ★ 把"模型到底选没选上"当场说出来：`used=` 与 `requested=` 不一致时这是**证据**，
            //   不能只放在附加字段里——那份不进作业输出，读者看不到，于是"我设了模型"就成了没人反驳的假话。
            push(`[model] requested=${requestedModel ?? '(none)'} · used=${facts.model ?? '(unknown)'}`
              + `${facts.permissionMode === null ? '' : ` · permission=${facts.permissionMode}`}`
              + `${facts.effort === null && requestedEffort === null ? '' : ` · effort requested=${requestedEffort ?? '(none)'} used=${facts.effort ?? '(unknown)'}`}`);
            if (requestedModel !== null && facts.model !== null && requestedModel !== facts.model) {
              push(`[!] the model actually recorded on the conversation is ${facts.model}, NOT the requested ${requestedModel} — the request was not honored`);
            }
            if (requestedEffort !== null && facts.effort !== null && requestedEffort !== facts.effort) {
              push(`[!] the effort actually recorded on the conversation is ${facts.effort}, NOT the requested ${requestedEffort} — the request was not honored`);
            }
            if (facts.creditsUsed !== null) push(`[credits] this run used ${facts.creditsUsed} credits (from session_usage)`);
          }

          if (promote && ok && cid !== null) {
            const changed = promoteSession(db, cid);
            push(`[visibility] ${changed === 1
              ? 'conversation normalized into the normal list (is_background_automation → NULL, session_settings → NULL); a desktop that has already loaded its list may need a refresh to show it'
              : 'the conversation row was not found, so nothing was normalized'}`);
          }

          if (retire) {
            // ★★ 终态就退役，**成功与失败一视同仁**（见 `retireRow()` 的 ★★★ 段）★★
            // `automations` 是桌面端唯一的"建会话"入口，但它同时也是**用户可见的计划任务列表**。
            // 借它点火的代价是：用户打开桌面端会看到自己从没建过的计划任务。
            // `once` 行跑完后调度器已把 `next_run_at` 置 NULL（不会被再接住），使命到此结束。
            // ★ 即建即撤下这里多半已在会话确认那一刻退过（幂等，第二次 changes=0），照常记账。
            doRetire();
          }

          if (reply !== null) push(reply.trimEnd());
          const reason = ok ? null : (row.failure_code ?? row.reason_code ?? REASON_CODES.TASK_ERROR);
          push(`[${ok ? 'ok' : 'failed'}] run ${row.thread_id} · status=${row.status}`
            + ` · result_success=${row.result_success ?? 'NULL'}`
            + ` · ${Math.round(((row.updated_at ?? Date.now()) - t0) / 1000)}s`
            + `${ok ? '' : ` · ${reason}`}`);

          // ★ 终态才 adopt 兜底：会话确认那一步没 adopt 上（例如 sessions 行晚于终态提交），
          //   这里按终态 cid 再记一次，保证"后续走复用不再建行"不因时序丢记性。
          //   成功保留；失败 forget（下轮重建）—— adopt 后立刻判终态，失败的 adopt 必须作废，
          //   否则下轮复用会去 load 一个已失败的死会话。
          if (cid !== null) adoptSession(cid);
          if (!ok) doForget(reason ?? REASON_CODES.TASK_ERROR);
          return {
            status: ok ? 'completed' : 'failed',
            detail: ok ? undefined : `${reason}: the run settled as a failure (failure_code=${row.failure_code ?? 'NULL'}, reason_code=${row.reason_code ?? 'NULL'})`,
            exitCode: ok ? 0 : 1,
            automation: {
              reason: ok ? null : reason,
              automationId,
              conversationId: cid,
              sessionId: cid,
              sessionKey: keyOf === '' ? null : keyOf,
              sessionPersist, retired,
              transcriptPath,
              reply,
              creditsUsed: facts?.creditsUsed ?? null,
              model: facts?.model ?? null,
              permission: facts?.permissionMode ?? null,
              usedModelId: facts?.model ?? null,
              sessionCwd: facts?.sessionCwd ?? null,
              // ★ 推理强度真下发回显：requested = 本次点火写入 reasoning_effort 的值，effective = 会话上
              //   实际记着的 thought_level（sessionFacts 真源），两者逐字比得 confirmed（与 permission 同口径）。
              requestedEffort,
              effectiveEffort: facts?.effort ?? null,
              effort: facts?.effort ?? null,
              // ★ 任务可视：title = 会话标题（取不到则回落点火标题），createdAt = 会话 created_at（取不到则回落点火 now）。
              title: facts?.title ?? title ?? null,
              createdAt: facts?.createdAt ?? now ?? null,
              tokensUsed: facts?.tokensUsed ?? null,
              phases: [...phases],
            },
          };
        }

        const waited = Date.now() - t0;
        if (!sawRun && waited > AUTOMATION_DEFAULTS.ignitionGraceMs) {
          // ★ 这一条是**最有信息量的失败**：行写进去了、库也认了，但调度器没接住。
          //   原因可能是桌面端没在跑、版本里没有这个调度器、id/字段形态被它拒了，
          //   或（2026-10-03 真机事故）**调度器按登录账号做了归属隔离**：owner_user_id
          //   ≠ 当前登录 uid 的行被 fail-closed 过滤——零日志、零 dispatch。所以把
          //   "写进去了什么（含 owner）"一并印出来，让下一个人不用重跑一遍才能查。
          return fail(REASON_CODES.TASK_ERROR,
            `the automation row was written (${automationId}, owner_user_id=${ownerUserId === null ? 'NULL/legacy_unassigned' : ownerUserId})`
            + ` but no automation_runs row appeared within ${AUTOMATION_DEFAULTS.ignitionGraceMs}ms`
            + ' — the desktop scheduler did not pick it up. The scheduler only dispatches rows owned by the'
            + ' currently logged-in desktop account (owner-isolated, fail-closed): if the WorkBuddy desktop is'
            + ' logged into a different account than when this row\'s owner was resolved, the row is invisible'
            + ' and will never fire. Check that the WorkBuddy desktop is running and logged in, and read'
            + ` ${join(workbuddyHome(), 'logs', 'automation.log')} for a dispatch line.`);
        }
        if (waited > timeoutMs) {
          return fail(REASON_CODES.TASK_ERROR,
            `the run did not settle within ${timeoutMs}ms (thread ${automationId}) — it may still be running inside the desktop`);
        }
        if (round + 1 >= schedule.rounds) {
          // ★ 退避表耗尽（默认 12 轮约 60s）：超时同样 retire，绝不留活行到 valid_until。
          //   会话已确认时 adopt 早已记下，调用方可用同一 sessionKey 走复用，不再建行。
          return fail(REASON_CODES.TASK_ERROR,
            `the run did not settle within ${schedule.rounds} poll rounds (~${Math.round(schedule.waits.reduce((a, b) => a + b, 0) / 1000)}s backoff: first ${schedule.waits[0]}ms then ${schedule.waits[1] ?? schedule.waits[0]}ms)`
            + ` (thread ${automationId}) — it may still be running inside the desktop`);
        }
        await sleep(schedule.waits[Math.min(round, schedule.waits.length - 1)], controller.signal);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // `node:sqlite` 不可用 / 库打不开 —— 归为**启动面**失败，而不是任务失败：
      // 用户该动的是环境（宿主 node 版本、WorkBuddy 是否装过），不是重试 prompt。
      return fail(REASON_CODES.START_FAILED, `${message} (db=${workbuddyDbPath()})`);
    } finally {
      signal?.removeEventListener?.('abort', onUpstreamAbort);
      try { db?.close(); } catch { /* 已关或从未打开 */ }
    }
  })();

  return {
    cancel: () => controller.abort(),
    done,
    readOutput: () => {
      const header = headerPending ? `${automationHeader({ model: modelId, cwd })}\n` : '';
      headerPending = false;
      const fresh = buffer.slice(cursor);
      cursor = buffer.length;
      return header + fresh;
    },
  };
}
