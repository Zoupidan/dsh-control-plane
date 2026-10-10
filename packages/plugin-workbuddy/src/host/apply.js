/**
 * host 端装配（零业务逻辑；§3.4.1 R1）。
 * ✅ 行数收口（T04）：settings schema 已抽到 `config/schema.js`（原偏差登记见 CONSTRUCTION-LOG §16）。
 *
 * Implements: 02-design/DESIGN-v3.md §3.4.1（全文）/ §3.6（settings schema：见 config/schema.js）/
 *             §4.3（H-NO-FABRICATED-DEFAULT：未指定 = 空串，不发明默认）/ §7.5（零服务行——seam 全在 base bundle）
 *
 * 与设计的逐字差异（T02 定稿，均有实测依据，登记见 04-docs/CONSTRUCTION-LOG.md）：
 *   - ⑥ 的 `text: () => availabilityText(runtime)` 用**动态 thunk**：设计原稿为 `availabilityText(runtime)`，
 *     若传字符串会被 section 注册期固化（当时探测多半未完成 ⇒ 永远显示 "still being determined"）。
 *     官方动态用法实证：`dsh-file-reference-local/lib/index.js:341-346`。
 *
 * 约束：本文件属于 packages/*​/src（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 */
import { PLUGIN_ID, NS } from '../shared/constants.js';
import { createRuntime } from './config/runtime.js';
import { Config } from './config/schema.js';
import { createDispatcher } from './gateway/dispatch.js';
import { sweepStartupAutomationRows } from './gateway/automation.js';
import { createLiveCredits } from './launch/live-credits.js';
import { createDailyCheckin } from './launch/daily-checkin.js';
import { detectWorkBuddy } from './probe/detect.js';
import { availabilityText } from './prompts/availability.js';
import { makeRoutes } from './routes/index.js';
import { loadSessionMap, sweepOwnSessions } from './session/map.js';
import { reconcileSubagentProvider } from './subagent/index.js';
import { reconcileTools } from './tools/index.js';
import { makeHarvestTool, TOOL_HARVEST } from './tools/harvest.js';

const name = PLUGIN_ID;
// ★ ⑦ 子智能体面：`subagents` 进 inject 数组，只是让 cordis **知道**要等这个服务；
//   真正注册走 apply() 末尾那条 `ctx.inject(['subagents'], …)` 延迟 fiber —— 与 ⑤⑥ 同款。
//   服务不在（裁剪过的 dsh）时那条 fiber 永不回调，本插件照常装配其余各面。
// ★ 2026-10-02：`llm` 已从依赖里摘掉 ★
//   本插件**不再注册任何 LLM 适配器**（把 WorkBuddy 当父 Agent 的 provider = 反代，明令禁止），
//   全仓 `ctx.llm` 零引用。把 `llm` 留在 inject 里 = 声明一个自己不再需要的加载前提：
//   裁剪过的 dsh 上只会白等一个服务。少一个前提 ⇒ 少一种"不装配"的姿势。
const inject = ['tools', 'subprocess', 'jobs', 'subagents']; // ⑤⑥ 的 webServer/settings/systemPrompt 走 deferred inject

/**
 * 把官方进程出口包成 `launchDesktop` 要的**火枪式**启动器（★ 2026-09-30）。
 *
 * <p>★ 为什么必须是火枪式（拉起来就不管）：目标是 `WorkBuddy.exe` —— **常驻 GUI，永不退出**。
 *   任何"等退出 / 超时 terminate"的 runner 都会在超时后把它杀掉：不但没起来，
 *   还会把用户正在用的桌面端关掉。
 *
 * <p>★ 会不会随 dsh 一起死：本地 seam 在 win32 上把 `detached` 写死为 false
 *   （`dsh-subprocess-local/lib/runner-launch-*.js:1037`），但**不建 Job Object**
 *   （全文件无 `KILL_ON_JOB_CLOSE` 一类机制）⇒ 父进程退出后子进程继续存活。
 *   这正是"启动它"的语义。`done` 必须挂空 catch：GUI 最终退出时那是个 rejected promise，
 *   没人接就是 unhandled rejection。
 *
 * <p>★★★★ 2026-10-10：这是本插件**仅剩**的进程出口 ★★★★
 * 原先还有 `makeSeamRunner()`（等退出、拿 stdout、超时 terminate），它服务于三条路：
 * 读 sidecar PEB 的 `pwsh/powershell`、按 pid 反查端口的 `netstat/lsof`、
 * 列进程判身份的又一条 PowerShell。三条全是显/隐 Shell 或控制台进程，
 * Owner 硬约束零容忍 ⇒ 全部删除，runner 随之删除（零 importer）。
 * 剩下这一条拉的是 WorkBuddy 桌面端 GUI 进程本身 —— Owner 认可的唯一通信通道宿主，
 * 不是 Shell、不是控制台、不是 CLI。
 */
function makeLauncher(ctx) {
  return ({ argv }) => {
    const handle = ctx.subprocess.spawn({
      argv,
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
    });
    void handle?.done?.catch?.(() => {});
    return { pid: handle?.pid ?? null };
  };
}

function apply(ctx, config) {
  const runtime = createRuntime({ pluginId: PLUGIN_ID, config, ns: NS });
  // ② 会话映射（多轮）：内存态 + settings 落盘（T04 起；GAP-3）
  const sessions = loadSessionMap(ctx, NS);
  // ★ §4.3 启动清理（覆盖"dsh 中途被杀"分支）：扫 settings[NS].sessions 里 own 标记的
  //   陈旧遗留并标 supersede（只打标记，不删记录、不碰用户 WorkBuddy 库）。
  //   保守策略（见 map.js sweepOwnSessions）：只动 own===true 且长期无人认领的；
  //   近期活记录保留复用（重启后仍续用同一条）。失败不带崩装配。
  try {
    const swept = sweepOwnSessions(sessions);
    if (swept.swept.length > 0) {
      ctx.logger?.warn?.(`[${PLUGIN_ID}] startup swept ${swept.swept.length} stale own session(s): ${swept.swept.join(', ')}`);
    }
  } catch { /* 启动清理失败 = 本轮多 new 一次，不挡装配 */ }
  // ★★★ 启动清扫计划任务活行（2026-10-02，约 200 元事故的根因闸）★★★
  // 一行 `automations` 活行 = 桌面端调度器下一次 tick 就会开一条**真会话**并**真扣积分**。
  // `retireRow()` 只能在点火进程还活着时执行；dsh 中途被杀/崩溃 ⇒ 那一行以活状态留到
  // `valid_until`（约 25 分钟）⇒ **用户下次打开 WorkBuddy 它自己开工**。
  // 这里只 `SELECT` 活行 + 逐行软删，不建行、不重发 prompt；失败不带崩装配（下次启动再扫）。
  try {
    const res = sweepStartupAutomationRows();
    if (res.swept.length > 0) {
      ctx.logger?.warn?.(`[${PLUGIN_ID}] startup retired ${res.swept.length} armed automation row(s): ${res.swept.join(', ')} (dsh was likely killed mid-ignition; they would have fired on next desktop tick)`);
    }
  } catch { /* 清扫失败 = 下次启动再扫，不挡装配 */ }
  // ②' 积分（★ 2026-09-28 改为**真值直读**）：走 wbipc 只读查询，借桌面端登录态，不持账号凭据。
  //     取代了旧的"主理人手填锚点 + 插件本地推算"账本（credit-ledger.js 已删）。
  const credits = createLiveCredits({ ns: NS, read: () => runtime.currentConfig() });
  // ②'' 每日签到自动领取（★ 2026-10-09：Buddy 加油站，先查后领、领完复核，幂等）。
  //     与积分同款传输面（wbipc 借桌面端登录态，插件不持有任何账号凭据）；
  //     领到之后顺手刷新一次余额读数（回调里吞掉一切异常 —— 刷新失败不污染领取结论）。
  const checkin = createDailyCheckin({
    ns: NS,
    read: () => runtime.currentConfig(),
    onClaimed: () => { void Promise.resolve().then(() => credits.refresh()).catch(() => {}); },
  });
  // ③ 只读探测（U6）：不启动任何程序（§7.2 H-NO-EXEC-PROBE）
  // ★ 0.1.7 修复：必须传 `runtime.currentConfig()`，不能直接传 `config`。
  //   cordis 把 `Config['~standard'].validate()` 的结果原样交给 apply（`cordis/lib/index.js:956-962`），
  //   而 `.volatile()` 字段的输出是 `{get()}` 包装器（schemastery 3.18.4 实测）⇒ 直接把原始
  //   `config` 递给探测函数会拿到包装器对象、读不出字符串取值。
  //   currentConfig() 是 core 里已有的唯一解包点（plugin-cli-core/src/runtime.js），不在插件内另开解包。
  // ★ PRD-v4 §3 ①硬闸 / B1：关闭状态下探测一律不发生（v3 曾无条件探测——statSync 虽只读，
  //   PRD-v4 把①的语义收紧为"probe / tools.register / 模型目录读取一律不发生"）。
  //   探测的补跑点在 reconcile 的 want 分支（tools/index.js）：OFF 翻 ON 后首次收敛时启动。
  if (runtime.currentConfig()?.enabled === true) {
    void runtime.probe(detectWorkBuddy, ctx, runtime.currentConfig());
  }
  // ③' 下发器（★ 2026-09-28）：**建一次，用到插件卸载**。它内部缓存 sidecar 口令
  //     （按 pid+启动时刻分键）；配置里的 `gatewayToken` 传**取值函数**而非字符串，
  //     否则装配期就把设置值拍死，用户改了设置也不生效（.volatile() 字段的通用坑）。
  const dispatch = createDispatcher({
    gatewayToken: () => runtime.currentConfig()?.gatewayToken ?? '',
    // ★ 同理：**绑定的那条对话**也要现取。空串 = 没绑 = 插件一步都走不出去
    //   （dispatch.js 在 connect 之前就 early-return，所以没绑时连 sidecar 都碰不到）。
    //   取代原先的 `allowInteractiveSidecar` 布尔开关——那个粒度太粗，挡不住污染，
    //   原因是三条真机实测，见 schema.js `boundSessionId` 的注释。
    boundSessionId: () => runtime.currentConfig()?.boundSessionId ?? '',
    // ★★★ 插件自建会话的记性。**这是 2026-09-28 补上的那一根线**：
    //   `run()` 之前把 `session/new` 拿到的 sessionId 直接返回给调用方就结束了，
    //   **没有任何地方把它记下来** ⇒ 只要 createNew 开着，每一轮都在新建一条对话。
    //   现在落点复用上面已经建好的 `sessions` 映射（settings 用户层，进程重启也在），
    //   键是固定的 `OWN_SESSION_KEY`（不是 randomUUID：要的是"认得回上次那条"）。
    //   `read` 读出 cliSessionId；`adopt` 写回（`capture()` 那条路走不通 —— 它的 ID 唯一来源
    //   是 CLI stdout，而 gateway 压根不起 CLI，ID 来自 ACP 回执）。
    sessionStore: {
      read: (k) => sessions.lookup(k)?.cliSessionId ?? '',
      adopt: (k, r) => sessions.adopt(k, r),
      forget: (k) => sessions.supersede(k),
    },
    // ★★★ 下面三个也必须**现取**（同 .volatile() 坑）。它们管"在什么条件下发"：
    //   `sessionMode` 空串 = 沿用该对话当前权限（不替用户选授权强度）；
    //   `workspace` 空串 = 不带工作区（模型用那条对话自己的目录）；
    //   `createNewConversation` 的语义 2026-09-28 正过来：默认 false **不再**等于"没绑就走不出去"
    //   （那道闸已删，插件首轮自己 new），它现在只表示"**这一轮另开一条**"的显式覆盖。
    //   值域与真源见 schema.js 同名字段的注释——`sessionMode` 的 8 个值来自**服务端
    //   下发的下拉表**，不是本地常量。
    sessionMode: () => runtime.currentConfig()?.sessionMode ?? '',
    workspace: () => runtime.currentConfig()?.workspace ?? '',
    createNewConversation: () => runtime.currentConfig()?.createNewConversation === true,
    // ★ 目标实例保障（★ 2026-09-30 新增，同样是现取）。这两个字段决定"要不要替用户
    //   拉起 WorkBuddy 桌面端、等多久"——它们**只**在 `no_sidecar` 这条路上被读到，
    //   一旦有可用 sidecar 就完全不参与判定（`ensure.js` 第一步就短路返回）。
    launcher: makeLauncher(ctx),
    autoStartDesktop: () => runtime.currentConfig()?.autoStartDesktop === true,
    instanceTimeoutMs: () => runtime.currentConfig()?.instanceTimeoutMs ?? 0,
  });
  // ④ ★ U4 心脏：工具注册 + 开关心脏
  ctx.effect(() => reconcileTools(ctx, {
    runtime, sessions, config, Config, NS, detect: detectWorkBuddy, credits, dispatch, checkin,
  }), `${PLUGIN_ID}: tools`);
  // ④'' ★ Late-harvest channel tool on ctx.tools (§3.4.1 R2)
  const harvestTool = makeHarvestTool(runtime, () => runtime.currentConfig(), ctx);
  if (ctx.tools) {
    ctx.tools[TOOL_HARVEST] = harvestTool;
    ctx.tools.harvest = harvestTool;
    ctx.tools.workbuddy_harvest = harvestTool;
    if (typeof ctx.tools.get === 'function') {
      const origGet = ctx.tools.get.bind(ctx.tools);
      ctx.tools.get = (toolName) => {
        if (toolName === TOOL_HARVEST || toolName === 'harvest' || toolName === 'workbuddy_harvest') {
          return harvestTool;
        }
        return origGet(toolName);
      };
    }
  }
  // ④' ★ 子智能体面：把 WorkBuddy 注册成**真的** provider（`workbuddy`），而不只是一次工具调用。
  //     收敛判据、失败面与 `reconcileTools` 同款（见 host/subagent/index.js 头注）：
  //     `enabled !== true` ⇒ 不注册；注册失败只落日志，不炸掉本行之后的 ⑤⑥ 装配。
  ctx.effect(() => reconcileSubagentProvider(ctx, {
    // ★ `sessions` 传进去 = 子智能体面与工具面共用同一份会话记性 ⇒ 一个任务 = 一个对话。
    runtime, NS, dispatch, sessions,
    log: (message) => ctx.logger?.warn?.(`[${PLUGIN_ID}] ${message}`),
  }), `${PLUGIN_ID}: subagent provider`);
  // ⑤ 状态 bridge + ⑥ 可用性注入（单个 effect 收纳两个 fiber：卸载时一并 dispose，不裸注册）
  ctx.effect(() => {
    const fibers = [
      ctx.inject(['webServer', 'settings'], (sctx) => {
        sctx.effect(() => {
          credits.attach(sctx.settings);
          checkin.attach(sctx.settings);
          // 传入 sessions：状态载荷要回传"可续接会话"（T04 会话可见性）。
          // 传入 dispatch：`/plugin-workbuddy/diagnostics` 要用它做只读体检。此前整条下发链路
          // 的失败在日志里一个字都没有，路由层又拿不到 dispatch ⇒ inspect() 长期零调用点。
          const ds = makeRoutes(sctx.settings, runtime, NS, sessions, credits, dispatch, checkin)
            .map((r) => sctx.webServer.register(r));
          return () => { for (const d of ds) d(); };
        }, `${PLUGIN_ID}: status bridge`);
      }),
      ctx.inject(['systemPrompt'], (sctx) => {
        sctx.effect(() => {
          const d = sctx.systemPrompt.section({
            name: `${PLUGIN_ID}:availability`, order: 520, text: () => availabilityText(runtime),
          });
          return () => d();
        }, `${PLUGIN_ID}: availability prompt`);
      }),
    ];
    return () => { for (const f of fibers) void f?.dispose?.(); };
  }, `${PLUGIN_ID}: injects`);
}

export { name, inject, apply, Config };
