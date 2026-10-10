/**
 * T02 验收测试 —— 5 条完成判据的机器断言（+ P2-9b 契约断言与若干加固项）。
 *
 * 依赖：**真实的** `@deepseek-ai/*`（schemastery / dsh-tools）—— 经 `tools/dev/link-dsh-deps.mjs`
 *   的目录 junction 提供；不可用时整组 skip（先跑 `npm run link:dsh-deps`）。
 *
 * 判据映射（DESIGN-v3 §10 T02 / §4.4.2）：
 *   ① ON ⇒ 工具注册（`workbuddy_run` / `workbuddy_status`）；OFF ⇒ 不注册
 *   ② OFF ⇒ `ctx.subprocess.spawn` 调用计数 === 0
 *   ③ OFF 后在途作业仍正常完成（H-ORTHOGONAL）；且注销路径不触碰作业（terminate 计数 0）
 *   ④ 探测 CLI 不存在 ⇒ `installed:false` + `evidence` 非空 + `method:'no-exec'`（H-NO-EXEC-PROBE）
 *   ⑤ 每个 `defineTool` 都有 `output.schema` + **可实际调用的** `output.render`
 *   ⑥（P2-9b 契约级）`kind:'workbuddy'` 被 jobs.start 接受且 list 可按 kind 召回
 *
 * 零执行（C2）：全部进程出口为**假 ctx 计数桩**，本测试不启动任何程序。
 *   ⚠️ 精确边界：本测试只能证明"**不触达 `ctx.subprocess` 出口**"；"探测源码里不存在其它执行通道"
 *   由 **CI ③（H-NO-EXEC-PROBE 静态扫描）** 保证 —— 两者互补，缺一不可。
 *
 * 假宿主保真（对照真机源码，子代理 t02-api-recon 逐字取证）：
 *   - `jobs.start`：**同步**调用 `spec.run()`、返回 `${kind}-${n}`；start 前校验 kind/label 非空、
 *     outputLimitBytes 正整数、owner 合法、并发上限（真机默认 **10/owner**）（`dsh-jobs-local:127-142`）
 *   - `settings.installSection`：注册即 `setSource(thunk)` + `onChange()` 立即回调（`dsh-settings:316-343`）
 *   - `tools.register` / `webServer.register`：重名/重复路由 ⇒ **抛错**（`dsh-tools:2538` / `dsh-host-webserver:176`）
 *   - `ctx.inject`：deps 未满足**不回调**；返回 fiber（dispose 逆序清理其内部 effect）（`cordis:1592-1640`）
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** 一个**确实存在**的本地文件：充当"已安装"的 cliPath（L-D1 命中 ⇒ 探测确定性成立，不依赖真机）。 */
const CLI_FILE = join(here, '..', 'package.json');

/**
 * 一个**一定没有** `~/.workbuddy/cache/acc-product-config-v3.json` 的 home。
 *
 * ★ 为什么需要它（2026-10-01）★
 * 目录读取器新增了"桌面端刷新缓存"这个优先源（model-catalog.js 头注）。凡是断言
 * **"取不到目录时怎么说"** 的用例，都必须先把 homedir() 指走 ——
 * 否则结果取决于**本机装没装 WorkBuddy**：装了必红、没装必绿，两边都是假信号。
 * 这个路径不需要真的存在（读取器只 statSync，不 mkdir），也不会被写到。
 */
const NO_DESKTOP_HOME = join(here, '.no-desktop-home-fixture');

// ═══════════════ 2026-10-02 探测换代（CLI → 桌面端）后的"家目录"隔离 ═══════════════
// `probe/detect.js` 的判据已经换成桌面端产品配置缓存，且它**优先读 `WORKBUDDY_HOME`**
// （2026-10-02），再退 HOME / USERPROFILE，最后退 `os.homedir()`。
// `launch/model-catalog.js` 的 `desktopCachePath()` 走的是 `os.homedir()`（win32 = USERPROFILE）。
//
// ⇒ 三个入口必须**一起**指走，否则本文件会同时踩两个"取决于本机装没装 WorkBuddy"的假信号：
//   · 只设 HOME/USERPROFILE：探测**照旧**读用户真缓存 ⇒ 「未安装」用例假绿，
//     而「已安装」用例是在读用户数据（与"往用户库里写"同一类事故，只是方向反过来）。
//   · 只设 WORKBUDDY_HOME：目录读取器仍读用户真缓存 ⇒ models 相关断言随机漂。
//
// 每个 boot() 一个一次性 mkdtemp；`desktopInstalled` 决定要不要落那份缓存夹具
// —— 桌面端判据就是"`<home>/.workbuddy/cache/acc-product-config-v3.json` 存在且可解析"。
const __wbHomes = [];

/** 桌面端产品配置缓存夹具：三个 id，覆盖倍率三态（x0.00 / x0.05 / 无 credits 键）。 */
const DESKTOP_CATALOG_FIXTURE = {
  models: [
    { id: 'wb-free', name: 'WorkBuddy Free', credits: 'x0.00', supportsReasoning: false },
    { id: 'wb-pro', name: 'WorkBuddy Pro', credits: 'x0.05', supportsReasoning: true },
    { id: 'wb-unknown', name: 'WorkBuddy Unknown' },
  ],
};

/**
 * 造一个隔离的"家"并把三个环境入口都指过去。
 * @param {{installed?: boolean, catalog?: object|null}} opts
 * @returns {string} 该 home 路径（探测的 `resolvedPath` 在 installed 时**就是**缓存文件路径）
 */
function makeDesktopHome({ installed, catalog }) {
  const home = mkdtempSync(join(_tmpdir(), 'wb-home-'));
  if (installed !== false && catalog !== null) {
    const dir = join(home, '.workbuddy', 'cache');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'acc-product-config-v3.json'), JSON.stringify(catalog ?? DESKTOP_CATALOG_FIXTURE));
  }
  __wbHomes.push(home);
  return home;
}
process.on('exit', () => {
  for (const h of __wbHomes) {
    try { rmSync(h, { recursive: true, force: true }); } catch { /* 退出期清理失败不该盖掉测试结论 */ }
  }
});

// ★ PRD-v4 成本面：reconcile 每次收敛都会向共享目录发布成本快照（A2 通道）。
//   测试必须把这个目录指到一次性 mkdtemp —— 否则每条 boot() 都会往真实 %TEMP%\dsh-cost-plane\ 写文件
//   （机器状态污染；并发跑测试时还会互相覆盖同一份 workbuddy.json）。进程退出时清理。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir as _tmpdir } from 'node:os';
const __costSnapDir = mkdtempSync(join(_tmpdir(), 'wb-host-cost-'));
process.env.DSH_COST_SNAPSHOT_DIR = __costSnapDir;
process.env.DSH_WB_COST_HOME = __costSnapDir; // 成本读取器：home 指向空 mkdtemp ⇒ 测试密闭（摸不到真实用户缓存）

let mods = null;
let importError = null;
try {
  mods = {
    apply: await import('../src/host/apply.js'),
    detect: await import('../src/host/probe/detect.js'),
    sessionMap: await import('../src/host/session/map.js'),
    streamJson: await import('../src/host/launch/stream-json.js'),
    verdict: await import('../src/host/launch/verdict.js'),
    reasonCodes: await import('../src/host/launch/reason-codes.js'),
    constants: await import('../src/host/config/constants.js'),
    // ★ 逐次可调增量：可用性文案（U1/U2 的可发现性渠道）需直调 + 经 systemPrompt section 观察。
    availability: await import('../src/host/prompts/availability.js'),
    // ★ T05 增量：CLI 模型快照 + 路由装配（供"省略 sessions 参数"的向后兼容断言直调）。
    statusRoute: await import('../src/host/routes/status/get.js'),
    // §4-9：工具面装配（与路由面**共用**目录判定 ⇒ 两出口的出处必须逐字相同，需直调才能钉住）。
    statusTool: await import('../src/host/tools/status.js'),
    routes: await import('../src/host/routes/index.js'),
  };
} catch (err) {
  importError = err;
}
const SKIP = mods === null
  ? `缺 @deepseek-ai 依赖（${importError?.code ?? String(importError)}）—— 先跑 npm run link:dsh-deps`
  : false;

/** stderr 采集上限（真机 `stdio.stderr = { maxBytes }`）—— 与 src 常量同源，不抄字面量。 */
const STDERR_LIMIT_BYTES = mods?.constants?.STDERR_LIMIT_BYTES;

/** WorkBuddy 6 档（§4.2.1：无 off、无 ultracode）—— 与 cordis.patch.yml 同表。 */
const EFFORT_VALUES = Object.freeze({
  minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
});

const ROUTE_STATUS = '/plugin-workbuddy/status';
const ROUTE_DIAGNOSTICS = '/plugin-workbuddy/diagnostics';

async function waitFor(cond, { timeoutMs = 3000, stepMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** 假件判据：只有"要求保留 stderr"的 stdio 形态才会暴露 `collected.stderr`（见 spawn 内注释）。 */
function isStderrCollected(call) {
  const spec = call?.stdio?.stderr;
  return spec !== undefined && spec !== null && typeof spec === 'object';
}

/**
 * 假宿主：逐个照抄已实测的官方语义（见文件头）。所有 outbound 出口均为计数桩。
 * @param {{ enabled?: boolean, model?: string, effort?: string, cliPath?: string, resolvedCliPath?: string,
 *           nodePath?: string, cwdRoot?: string, probeGate?: Promise<any>, resolveOk?: boolean,
 *           desktopInstalled?: boolean, catalog?: object|null, desktopHome?: string }} overrides
 *   `probeGate` / `resolveOk` 属于 spawn 时代的残留注入面（探测已不再有 `resolveExecutable` 一支）。
 *   ★ 桌面端换代后真正决定「装没装」的是 `desktopInstalled`（默认 true = 落缓存夹具 ⇒ 探测 installed:true），
 *     `catalog: null` = 不落缓存但家目录仍隔离。
 */
function boot(overrides = {}) {
  const state = {
    registration: new Map(),
    effects: [],
    routes: new Map(),
    sections: new Map(),
    spawnCalls: [],
    terminateCount: 0,
    resolveExecutableCalls: [],
    settingsResolved: null,
    settingsArgs: null,
    settingsNs: 'dsh-plugin-workbuddy',
    settingsPresentation: null,
    settingsListeners: new Set(),
    settingsSection: null,
    updateCalls: [],
    updateFailures: 0,
    fiberDisposals: 0,
    pendingInjects: [],
  };
  /**
   * 0.1.7：loader 广播 volatile 字段更新（替代 0.1.5 的 settings onChange 钩子）。
   * 真机由 cordis-plugin-loader 就地更新 volatile 字段后 emit（`lib/index.js:380,400,612`）。
   */
  state.emitVolatileUpdate = () => {
    for (const listener of [...state.settingsListeners]) listener('loader/volatile-update');
  };

  const entry = {
    // ★ 2026-10-02 起唯一主路是 `automation`（计划任务表 once 行，等调度器建会话）。
    //   `gateway`（本机 ACP）已下线，`spawn`（自拉 CLI）2026-10-01 已删。
    //   这里钉真实的默认传输面 `automation`。
    transport: 'automation',
    enabled: overrides.enabled ?? false,
    model: overrides.model ?? '',
    effort: overrides.effort ?? '',
    cliPath: overrides.cliPath ?? CLI_FILE,
    cwdRoot: overrides.cwdRoot ?? '',
    // ★ T04：node 运行时解析需**可注入的确定性**（否则 argv[0] 取决于跑测试的机器上 ~/.workbuddy 是否存在）。
    //   默认指向"当前正在跑测试的这个 node 可执行文件"（真实存在的文件 ⇒ 走 config 分支）。
    nodePath: overrides.nodePath ?? process.execPath,
    launch: { effortValues: { ...EFFORT_VALUES } },
  };
  state.settingsResolved = mods.apply.Config['~standard'].validate(entry).value;
  state.settingsSection = { ...entry };
  // 裸值视图（解掉 volatile 包装器）——测试断言与"值是否真变"的比较都用它。
  state.settingsPlain = JSON.parse(
    JSON.stringify(state.settingsResolved, (_k, v) =>
      v !== null && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v,
    ),
  );
  // 0.1.7：schema 不再由 installSection 传入，而是从 `entry.fiber.runtime.Config` 隐式发现
  // （`dsh-settings/lib/index.js:539`）。fake 侧等价物 = 插件导出的 Config。
  state.settingsArgs = { ns: state.settingsNs, schema: mods.apply.Config };
  if (overrides.resolvedCliPath !== undefined) {
    // cliPath 现在是 volatile 字段 ⇒ 改裸值视图 + 重建包装器，否则 .get() 仍返回旧值。
    state.settingsPlain = { ...state.settingsPlain, cliPath: overrides.resolvedCliPath };
    const rebuilt = mods.apply.Config['~standard'].validate({ ...state.settingsSection, cliPath: overrides.resolvedCliPath });
    state.settingsResolved = rebuilt.value;
    state.settingsPlain = JSON.parse(
      JSON.stringify(rebuilt.value, (_k, v) =>
        v !== null && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v,
      ),
    );
  }

  const tools = {
    register(def) {
      if (state.registration.has(def.name)) throw new Error(`duplicate tool registration: ${def.name}`);
      state.registration.set(def.name, def);
      return () => { state.registration.delete(def.name); };
    },
    schemas() {
      return [...state.registration.values()].map((d) => ({ name: d.name, description: d.description, parameters: d.parameters }));
    },
    get(name) { return state.registration.get(name); },
  };
  for (const name of overrides.preRegistered ?? []) state.registration.set(name, { name }); // 冲突预置（测试回滚路径）

  const jobs = {
    store: new Map(),
    seq: 0,
    /** 实测契约：先校验（kind/label/outputLimitBytes/owner/并发）→ 同步调用 spec.run() → 返回 `${kind}-${n}`。 */
    start(spec) {
      if (typeof spec.kind !== 'string' || spec.kind.length === 0) throw new Error('invalid job kind: expected a non-empty string');
      if (typeof spec.label !== 'string' || spec.label.length === 0) throw new Error('invalid job label: expected a non-empty string');
      if (spec.outputLimitBytes !== undefined && (!Number.isSafeInteger(spec.outputLimitBytes) || spec.outputLimitBytes <= 0)) {
        throw new Error('invalid outputLimitBytes: expected a positive safe integer');
      }
      // 0.1.7 变更（B4）：`owner` 由 Agent 对象改为 **SessionId 字符串**
      // （真机 `dsh-jobs-local/lib/index.js:413→527-533 agents.get(session)`，miss 即抛）。
      if (spec.owner !== undefined && typeof spec.owner !== 'string') throw new Error('invalid job owner');
      if (jobs.activeCount(spec.owner) >= 10) throw new Error('background job limit reached for this owner (limit: 10)');
      const hooks = spec.run();
      const id = `${spec.kind}-${++jobs.seq}`;
      const record = { id, kind: spec.kind, label: spec.label, owner: spec.owner, hooks, status: 'running' };
      jobs.store.set(id, record);
      // 真机 registry 自行跟踪状态（settle 后转终态）——镜像之，使 activeCount 上限真实生效
      void Promise.resolve(hooks.done).then(
        (outcome) => { record.status = outcome?.status ?? 'completed'; },
        () => { record.status = 'failed'; },
      );
      return id;
    },
    activeCount(owner) {
      return [...jobs.store.values()].filter((j) => j.owner === owner && j.status === 'running').length;
    },
    list(caller) {
      // 0.1.7：owner 是 SessionId 字符串（`list` 的 caller 侧同理按 id 比对）。
      return [...jobs.store.values()]
        .filter((j) => j.owner === undefined || j.owner === caller?.id)
        .map((j) => ({ id: j.id, kind: j.kind, label: j.label, status: j.status }));
    },
    get(id) { return jobs.store.get(id); },
  };

  const subprocess = {
    stdoutText: '',
    stderrText: '',
    stdoutLossy: false,
    stderrLossy: false,
    // ★ WB-2 测试面：默认回传**不存在**的假路径（`__fake_spill_N.log`）⇒ 头部读取必然失败，
    //   这本身就是"文件不可读"那条分支的常驻覆盖。需要真读回内容时，测试把这里指向一个真实临时文件。
    stdoutSpillPath: null,
    stderrSpillPath: null,
    lastHandle: null,
    failNextSpawn: false,
    failNextSpawnError: null,
    spawn(call) {
      // 真机契约镜像：`SubprocessSpawnSpec.cwd` 是**必填 string**（validateNoNullByte(undefined) 会 TypeError）
      if (typeof call.cwd !== 'string') throw new TypeError('validateNoNullByte(options.cwd): value must be a string');
      if (!Array.isArray(call.argv) || call.argv.some((a) => typeof a !== 'string')) throw new TypeError('argv must be string[]');
      if (!Number.isFinite(call.graceMs) || call.graceMs <= 0) throw new TypeError('graceMs must be a positive finite number');
      if (subprocess.failNextSpawn) {
        subprocess.failNextSpawn = false;
        throw subprocess.failNextSpawnError ?? new Error('__fake_spawn_failed__');
      }
      state.spawnCalls.push(call);
      let resolveDone;
      const done = new Promise((resolve) => { resolveDone = resolve; });
      // 真机 `readFrom(fromByte)` 语义的共用镜像（stdout / stderr 同形）。
      // ★ 增量⑥ fix#1 镜像：真机 `OutputCollector.readFrom()` 回传 `spillPath` 是**有条件的** ——
      //   只有本次 spawn 申请了 `stdio.<流>.spill`（`spillDisabled = maxSpillBytes === undefined`）
      //   **且**确实溢出过（lossy）时才有文件。假件必须照抄这条条件，否则"落盘已启用"没有检测器：
      //   src 把 spill 去掉后本文件仍会全绿。
      const collector = (getText, getLossy, getSpillSpec, getSpillOverride) => ({
        readFrom: (fromByte = 0) => {
          const buf = Buffer.from(getText(), 'utf8');
          const text = buf.subarray(Math.max(0, Math.min(fromByte, buf.length))).toString('utf8');
          const spec = getSpillSpec();
          const spillRequested = spec !== undefined && spec !== null && Number.isSafeInteger(spec?.maxBytes);
          const lossy = getLossy();
          return {
            text, nextOffset: buf.length, lossy,
            ...(spillRequested && lossy
              ? { spillPath: getSpillOverride() ?? `__fake_spill_${state.spawnCalls.length}.log` }
              : {}),
          };
        },
      });
      const handle = {
        // 真机形态镜像：`readFrom(fromByte)` 返回 `{ text, nextOffset, lossy }`，
        // 其中 offset/nextOffset 是 **Buffer 字节**（`this.total += chunk.length`）——不是字符数。
        collected: {
          stdout: collector(() => subprocess.stdoutText, () => subprocess.stdoutLossy, () => call.stdio?.stdout?.spill, () => subprocess.stdoutSpillPath),
          // ★ T04：`stdio.stderr = { maxBytes }`（且**只有**该形态）才会暴露 `collected.stderr`。
          //   推断依据：真机 `SubprocessStdio` 的 `'ignore'` 语义是"不保留"，而保留窗口挂在 `{maxBytes}` 上。
          //   ⚠️ 诚实边界：`'ignore'` 时真机是"无 stderr reader"还是"有 reader 但恒空"**未取证**
          //     （需受控窗口读 dsh 运行器源码/行为）。此处取**更严**的一侧：src 若退回 `stderr:'ignore'`，
          //     本假件不给 reader ⇒ D-3 证据链断裂、相关断言失败（早失败优于静默退化）。
          ...(isStderrCollected(call)
            ? { stderr: collector(() => subprocess.stderrText, () => subprocess.stderrLossy, () => call.stdio?.stderr?.spill, () => subprocess.stderrSpillPath) }
            : {}),
        },
        done,
        // 真机语义：terminate 幂等，且随后 done 必 resolve/reject（终止会落地为一次退出）。
        terminate: async () => {
          state.terminateCount += 1;
          resolveDone({ exitCode: 143 });
        },
        _resolve: resolveDone,
      };
      subprocess.lastHandle = handle;
      return handle;
    },
    async resolveExecutable(name, env) {
      state.resolveExecutableCalls.push({ name, env });
      // ★ 下发健康 C 组的注入面：把"探测结论何时落地"交给测试控制（`cliPath: ''` 时探测才走这一支）。
      //   未给 gate ⇒ 与本文件既有行为逐字相同（立刻 loud 抛错 = 官方"找不到"语义）。
      if (overrides.probeGate !== undefined) await overrides.probeGate;
      if (overrides.resolveOk === true) return CLI_FILE; // 一个确实存在的文件 = "PATH 解析成功"
      throw new Error(`__fake_resolve_failed__: ${name}`); // 官方语义：失败 loud 抛错
    },
  };

  /**
   * 伪 settings（0.1.7 契约）。
   *
   * ★ 0.1.7 迁移：`installSection` 已从 dsh-settings 整体移除（0.1.7 全树零命中；0.1.5 在
   *   `dsh-settings/lib/index.js:327`）。0.1.7 改为隐式发现：namespace 取 loader 行 id，
   *   schema 取 `entry.fiber.runtime.Config`（`lib/index.js:539`），公共面只剩
   *   configure/writable/documentPath/prepareDocument/describe/update/replace/mutate
   *   （`lib/types/index.d.ts:80-114`）——**没有 get、没有订阅**。
   *   因此本 fake：① 去掉 installSection；② 去掉 get（改由 describe 提供行）；
   *   ③ 用 `configure()` + `loader/volatile-update` 事件替代 setSource/onChange。
   *   样板：`dsh-llm-deepseek/lib/index.js:2242-2264`。
   */
  const settingsService = {
    /** 0.1.7：只登记页面策略，不改 Config（`lib/types/index.d.ts:80-84`）。 */
    configure(presentation) {
      state.settingsPresentation = presentation;
      return () => {};
    },
    /** 0.1.7：读全部条目；调用方按 `row.ns` 自筛（真机 `lib/index.js:441-451`）。
     *  真机 describe 走 `plainConfig()` 解掉 volatile 包装器（`lib/types/schema.js:9-17`），
     *  这里同样返回裸值，否则 session/map 的冷恢复读到的会是包装器。 */
    describe() {
      return [
        {
          ns: state.settingsNs,
          revision: 1,
          value: state.settingsPlain,
          base: {},
          user: state.settingsSection,
        },
      ];
    },
    /**
     * 实测契约（0.1.7 `dsh-settings/lib/index.js:501-537 write()`）：
     *   ① 按 `entry.options.id === ns` 找条目，找不到即抛 `No configurable plugin entry`；
     *   ② 只接受 **volatile** 字段（`:506,513-523`）；
     *   ③ 深度合并进用户层 → 校验 → 持久化 → 值变化时由 loader 广播 `loader/volatile-update`。
     * 返回 Promise（真机 async），并允许注入一次失败（测落盘失败记账）。
     */
    update(ns2, patch) {
      if (settingsService.failNextUpdate === true) {
        settingsService.failNextUpdate = false;
        state.updateFailures += 1;
        return Promise.reject(new Error('__fake_settings_update_failed__'));
      }
      state.updateCalls.push({ ns: ns2, patch });
      if (ns2 !== state.settingsNs) {
        return Promise.reject(new Error(`No configurable plugin entry "${ns2}"`));
      }
      const merge = (a, b) => {
        const out = { ...(a ?? {}) };
        for (const [k, v] of Object.entries(b ?? {})) {
          out[k] = v !== null && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k] !== null
            ? merge(out[k], v) : v;
        }
        return out;
      };
      const mergedSection = merge(state.settingsSection, patch);
      const validated = state.settingsArgs?.schema?.['~standard']?.validate(mergedSection);
      if (validated?.issues !== undefined) {
        state.updateFailures += 1;
        return Promise.reject(new Error(`__fake_settings_invalid__: ${JSON.stringify(validated.issues)}`));
      }
      const before = JSON.stringify(state.settingsResolved);
      state.settingsSection = mergedSection;
      // 0.1.7：volatile 字段的 schema 输出是 `{get()}` 包装器（官方读法 `config.model.get()`，
      // 见 dsh-agent-default-model/lib/index.js:39-42）。真机 fiber.config 拿到的就是这个形态。
      state.settingsResolved = validated.value;
      // 真机：volatile 字段就地写进 fiber.config（`cordis-plugin-loader/lib/index.js:380,400`），
      // 再广播事件。插件的响应式读源读的是 fiber.config ⇒ 这里必须同步，否则读源永远停在旧值。
      ctx.fiber.config = state.settingsResolved;
      // 用于比较的裸值视图（包装器 JSON 化成 {}，直接比字符串会永远"相等"）。
      state.settingsPlain = JSON.parse(
        JSON.stringify(state.settingsResolved, (_k, v) =>
          v !== null && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v,
        ),
      );
      if (JSON.stringify(state.settingsPlain) !== before) state.emitVolatileUpdate();
      return Promise.resolve(state.settingsResolved);
    },
    failNextUpdate: false,
  };

  const webServer = {
    register(route) {
      if (state.routes.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
      state.routes.set(route.path, route);
      return () => { state.routes.delete(route.path); };
    },
  };

  const systemPrompt = {
    section(section) {
      state.sections.set(section.name, section);
      return () => { state.sections.delete(section.name); };
    },
  };

  /**
   * `subagents` 服务的最小可信假件。
   *
   * ★ 为什么要造它（2026-09-30）★
   * 子智能体面是 2026-09-30 新增的第 ⑦ 面。此前假件的 `services` 里没有这一项，
   * 于是 `ctx.inject(['subagents'], …)` 永远"依赖未就绪"，那条 fiber 从不回调 ——
   * 表现为 `pendingInjects.length !== 0`，而**注册面什么也测不到**（假绿）。
   *
   * ★ `registerProvider` 必须**抛**而不是静默覆盖 ★
   * 静默覆盖会让"provider 换了"这件事在测试里看不见；而 `dsh-tool-subagent`
   * 真机上确实按引用复核同一个 provider（`lib/index.js:505`），重复注册在真机上是硬错误。
   */
  const subagents = {
    providers: new Map(),
    registerProvider(provider) {
      const name = typeof provider === 'string' ? provider : provider?.name;
      if (this.providers.has(name)) throw new Error(`DUPLICATE_PROVIDER: ${name}`);
      this.providers.set(name, provider);
      return () => { this.providers.delete(name); };
    },
    getProvider(name) { return this.providers.get(name); },
  };

  /**
   * `llm` 服务的最小可信假件 —— 适配器注册面。
   *
   * ★ 语义对齐真机（`dsh-llm/lib/index.js:1863`）★
   * 重复 provider 抛 `DUPLICATE_ADAPTER`，返回的句柄可撤销注册。
   */
  const llm = {
    adapters: new Map(),
    registerAdapter(names, adapter) {
      if (names.length === 0) throw new Error('INVALID_ADAPTER');
      for (const n of names) {
        const info = adapter.providerInfo(n);
        if (info.id !== n) throw new Error(`INVALID_ADAPTER: ${info.id} != ${n}`);
        if (this.adapters.has(n)) throw new Error(`DUPLICATE_ADAPTER: ${n}`);
        this.adapters.set(n, adapter);
      }
      return () => { for (const n of names) this.adapters.delete(n); };
    },
    getAdapter(name) { return this.adapters.get(name); },
  };

  const services = { tools, jobs, subprocess, settings: settingsService, webServer, systemPrompt, subagents, llm };

  const ctx = {
    /**
     * 实测契约（`@deepseek-ai/cordis/lib/index.js:762-771` + `:804`）：
     *   `get(name, strict = true)` → `this.store[isolate[name]]?.value`，其中
     *   ① `isolate` 在**根** ctx 上按 service 名登记（子 ctx 经原型链继承 ⇒ 名字可见）；
     *   ② service 已被 provide 且其 fiber 状态为 ACTIVE 时返回**服务实例**，否则返回 `undefined`
     *      （**不抛错**，除非 strict=false 另论）。
     *   ⇒ 本假件返回"服务注册表里的实例 / undefined"，与真机同形。返回 `undefined` 是**未注册**语义，
     *     不是"永远拿不到"——早期版本恒返回 undefined，会让任何 `ctx.get('settings')` 的用法在测试里
     *     静默失效（永不落盘），而真机是好的（假件比真机更严 ⇒ 假失败）。
     */
    get: (name) => services[name],
    /**
     * 0.1.7：事件订阅（替代 0.1.5 settings 的 onChange 钩子）。
     * 插件侧唯一用到的是 `loader/volatile-update`（配置就地更新广播）。
     */
    on(event, listener) {
      if (event !== 'loader/volatile-update') return () => {};
      state.settingsListeners.add(listener);
      return () => { state.settingsListeners.delete(listener); };
    },
    /** 真机上 fiber 自身持有 config；插件的响应式读源取的就是它。 */
    fiber: { config: state.settingsResolved },
    config: state.settingsResolved,
    effect(fn, label) {
      const disposer = fn();
      const dispose = typeof disposer === 'function' ? disposer : () => {};
      state.effects.push({ label, dispose });
      return dispose;
    },
    /** 实测语义：deps 未满足 ⇒ 不回调；返回 fiber（dispose 逆序清理其内部 effect）。 */
    inject(deps, cb) {
      const list = Array.isArray(deps) ? deps : Object.keys(deps ?? {});
      const own = [];
      const fiber = {
        disposed: false,
        dispose: async () => {
          fiber.disposed = true;
          state.fiberDisposals += 1;
          for (const d of own.reverse()) d();
        },
      };
      const missing = list.filter((d) => services[d] === undefined);
      if (missing.length > 0) {
        state.pendingInjects.push({ deps: list, missing });
        return fiber;
      }
      const sctx = Object.create(ctx);
      sctx.effect = (fn, _label) => {
        const d = fn();
        const dispose = typeof d === 'function' ? d : () => {};
        own.push(dispose);
        return dispose;
      };
      for (const dep of list) sctx[dep] = services[dep];
      cb(sctx);
      return fiber;
    },
    tools, jobs, subprocess, subagents, llm,
  };

  // ★ 必须在 `apply.apply()` **之前**把家目录指走：`detectWorkBuddy()` 在函数体的**同步段**
  //   就读好了 `WORKBUDDY_HOME`（第一个 await 是端口可达性探测），而 apply ③ 会在同一同步
  //   回合里发起探测。放晚了 ⇒ 这一轮探测读的是上一个 boot() 的家 / 用户真家。
  state.desktopHome = overrides.desktopHome
    ?? makeDesktopHome({ installed: overrides.desktopInstalled ?? true, catalog: overrides.catalog });
  process.env.WORKBUDDY_HOME = state.desktopHome;
  process.env.HOME = state.desktopHome;
  process.env.USERPROFILE = state.desktopHome;

  mods.apply.apply(ctx, entry);

  return {
    state, ctx, tools, jobs, subprocess, entry, settingsService, subagents, llm,
    /**
     * 模拟"用户在卡片上拨开关"：走**同一条** settings.update 路径（用户层合并 + 校验 + onChange），
     *  否则用户层（settingsSection）与解析值会分叉 —— 后续任何一次真实写入都会把旧 enabled 合并回来。
     */
    setEnabled(value) {
      void settingsService.update(state.settingsArgs?.ns ?? 'dsh-plugin-workbuddy', { enabled: value });
    },
    /** 经**真实路由 handler**取状态载荷（顺带验证 bridge 契约）。 */
    async statusPayload(method = 'GET', remoteAddress = '127.0.0.1', host = '127.0.0.1:7777') {
      const route = state.routes.get(ROUTE_STATUS);
      assert.ok(route, 'status 路由应当已注册');
      const res = {
        statusCode: 0, headers: {}, body: '',
        setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
        end(b) { this.body = b ?? ''; },
      };
      const req = { method };
      if (remoteAddress !== null) req.socket = { remoteAddress };
      if (host !== null) req.headers = { host };
      await route.handler(req, res);
      return { statusCode: res.statusCode, headers: res.headers, json: res.body === '' ? null : JSON.parse(res.body) };
    },
  };
}

/** 临时改写 process.env（探测/目录读取默认读它）——测试需屏蔽本机真实安装位与环境覆盖。 */
async function withEnv(overrides, fn) {
  const saved = new Map();
  for (const [k, v] of Object.entries(overrides)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ───────────────────────── 判据④ · H-NO-EXEC-PROBE ─────────────────────────

// ★ 2026-10-02 删除：探测源已从「WorkBuddy CLI 可执行文件」换成「桌面端产品配置缓存」。
//   本用例钉的是 method:'no-exec' + resolveExecutable/knownPath 两份 evidence —— 判据本身已不存在
// ───────────────────── 判据① / ⑤ · 注册收敛 + 定义形态 ─────────────────────

test('模块契约：name / inject 依赖声明与真机加载前提一致', { skip: SKIP }, () => {
  assert.equal(mods.apply.name, 'plugin-workbuddy'); // = cordis.patch.yml 行 id
  // ★ `subagents` 是第 ⑦ 面（子智能体 provider）的加载前提；缺它 ⇒ 真宿主里插件等不到这个
  //   服务，`apply()` 不装配。`llm` **已于 2026-10-02 摘掉**：本插件不注册 LLM 适配器
  //   （把 WorkBuddy 当父 Agent 的 provider = 反代，明令禁止），`ctx.llm` 全仓零引用，
  //   留着它只是声明一个不存在的加载前提。这条断言是那个决定的机器可查形态。
  assert.deepEqual(mods.apply.inject, ['tools', 'subprocess', 'jobs', 'subagents']);
  assert.equal(typeof mods.apply.Config?.['~standard']?.validate, 'function');
});

test('第 ⑦ 面：ON ⇒ `workbuddy` 子智能体 provider 注册，且**一个 LLM 适配器都不许**注册', { skip: SKIP }, async () => {
  const host = boot({ enabled: true });
  await waitFor(() => host.state.registration.size === 3);

  // ★ 这条断言此前**根本不存在**，而 `ctx.inject(['subagents'], …)` 因为假件没有该服务
  //   从不回调 —— 也就是说"子智能体有没有真的注册进去"此前是**零覆盖**（假绿）。
  const provider = host.subagents.getProvider('workbuddy');
  assert.ok(provider, 'workbuddy 子智能体 provider 应当注册进 subagents 服务');
  assert.equal(typeof provider.start, 'function', 'provider 必须实现 seam 的 start');
  assert.equal(typeof provider.capabilities, 'object', '能力面缺席 ⇒ seam 的 assertCapabilities 无从核对');

  // ★★ 反代红线（2026-10-02）★★
  //   WorkBuddy 是**智能体**，不是 LLM。把它注册成 dsh 的 provider，就等于让父 Agent
  //   拿 WorkBuddy 当模型跑自己的 agent loop —— 那是反向代理，用户明令禁止。
  //   正确链路是：dsh 下发任务 → WorkBuddy 自己跑完 → 结果回传到父会话（`one-shot`）。
  //   ⇒ 这条断言就是那条红线的机器可查形态：谁把适配器加回来，这里立刻红。
  assert.equal(host.llm.getAdapter('workbuddy'), undefined,
    'WorkBuddy 不许注册成 LLM 适配器（禁止反代：父 Agent 的 provider 不得是 workbuddy）');
  assert.equal(host.llm.adapters.size, 0, 'llm 服务里不许出现任何来自本插件的适配器');
});

test('第 ⑦ 面：OFF ⇒ provider 与适配器**一处都不许**注册（U4）', { skip: SKIP }, async () => {
  const host = boot({ enabled: false });
  await waitFor(() => host.state.registration.size === 3);
  assert.equal(host.subagents.providers.size, 0, 'enabled=false 时注册 provider = 比工具注册更宽的口子被撬开');
  assert.equal(host.llm.adapters.size, 0, 'enabled=false 时注册适配器 = LLM 路由里多一个无人可委派的面');
});

test('第 ⑦ 面：OFF ⇒ ON 的重收敛能补注册 provider，且适配器**永远**不补（上一条不是"永远不可注册"）', { skip: SKIP }, async () => {
  const host = boot({ enabled: false });
  await waitFor(() => host.state.registration.size === 3);
  assert.equal(host.subagents.getProvider('workbuddy'), undefined, 'OFF 时就不该有 provider');
  host.setEnabled(true);
  const ok = await waitFor(() => host.subagents.getProvider('workbuddy') !== undefined);
  assert.ok(ok, 'OFF → ON 走的是同一条 reconcile，provider 应当补注册');
  assert.equal(host.llm.adapters.size, 0, '重收敛补的也只有 provider —— 适配器在任何路径上都不补');
});

test('判据① + ⑤：ON（已装）⇒ 注册三工具；每定义含 output.schema + 可调用 output.render', { skip: SKIP }, async () => {
  const host = boot({ enabled: true });
  // ★ 必须等**探测出结论**，不能只等注册：工具是在探测在途期间乐观注册的（未结论 ≠ 未安装），
  //   所以 registration.size > 0 在第一帧就成立 —— 下面要读 `probe.method` / `probe.resolvedPath`，
  //   读到 null 是"读早了"，不是缺陷。
  const ready = await waitFor(async () => (await host.statusPayload()).json.probe !== null);
  assert.ok(ready, '探测应在线性时间内出结论');
  assert.equal(host.state.pendingInjects.length, 0, 'deferred inject 的依赖应全部就绪');

  const names = [...host.state.registration.keys()].sort();
  assert.deepEqual(names, ['workbuddy_purge', 'workbuddy_run', 'workbuddy_status']);

  for (const [name, def] of host.state.registration) {
    assert.equal(def.name, name);
    assert.equal(typeof def.description, 'string');
    // ⑤：output.schema（编译后的 raw JSON Schema）+ output.render
    assert.equal(def.output.schema.type, 'object', `${name}: output.schema 应为对象根`);
    assert.equal(def.output.schema.additionalProperties, false);
    assert.ok(Array.isArray(def.output.schema.required), `${name}: 编译后的 required 应为数组`);
    assert.equal(typeof def.output.render, 'function');
    assert.equal(typeof def.presentCall, 'function');
    // parameters 已被 defineTool 编译成 raw JSON Schema（无 required 属性时该键缺省——官方编译器行为）
    assert.equal(def.parameters.type, 'object');
    assert.ok(def.parameters.required === undefined || Array.isArray(def.parameters.required));
  }

  const runDef = host.state.registration.get('workbuddy_run');
  const statusDef = host.state.registration.get('workbuddy_status');
  assert.deepEqual(runDef.parameters.required, ['prompt']);
  // ★ 键集是**契约**：新增字段必须在这里显式登记，否则客户端/模型看到的形状与测试认知脱节。
  assert.deepEqual(
    [...runDef.output.schema.required].sort(),
    ['argv_preview', 'job_id', 'not_sent', 'resumed', 'resumed_session_id', 'session_key'],
  );
  assert.deepEqual(
    Object.keys(statusDef.output.schema.properties).sort(),
    [
      // ★ 2026-10-02：`cliModels` / `cliSupportedModels` 随 `launch/cli-models.js` 一起删除 ——
      //   桌面产品目录是模型候选的**唯一**数据源，不再有"CLI 自述快照"需要并列回传。
      // ★ 2026-10-04：新增 `cdp` / `ignition`（D6 直接点火）—— 模型据此判断"该不该开口问用户"。
      //   两块都由 `execute()` 单处承载（`json` 型同 lastRun）；CDP 实况走 `probeCdp()`，
      //   与点火面**同一套** UA ∧ target 判别 ⇒ 状态说"可用"而点火回退这种自相矛盾不可能发生。
      // ★ 2026-10-08 新增 `account`：切号排障要能**读到**插件识别到的现役账号 uid 与识别来源
      //   （`epoch-marker-align` / `security-holder-mtime` / `none`）。缺它 ⇒ 模型与用户都不知道
      //   "行写的 owner 和桌面端现役账号是不是同一个"，而这正是 owner 静默过滤的唯一成因。
      // ★ 2026-10-09 新增 `checkin`：每日签到自动领取（Buddy 加油站）—— 今日是否已领 /
      //   连签几天 / 自动领取开关。`json` 型同 lastRun，结构由 projection() 单处承载；
      //   模型据此回答"今天领了没"，而不是猜。
      // ★ 2026-10-10 schema 违约修复：补齐切片/兜底分支实际会出现的键 —— `section` /
      //   `count` / `credits` / `checkinCredits` / `distinction`（五个 section 切片）与
      //   `error` / `message` / `supportedSections`（invalid_section 兜底）。同时**删除**
      //   曾把键集钉在 16 键上的 ownKeys Proxy（它让 balance/creditsRemain 对宿主校验器
      //   不可见）。键集 = 实际会出现的全部键，additionalProperties:false 继续成立。
      'account', 'balance', 'cdp', 'checkin', 'checkinCredits', 'config', 'cost', 'count',
      'credits', 'creditsRemain', 'distinction', 'effort', 'error', 'ignition', 'inFlight',
      'lastRun', 'message', 'models', 'modelsSource', 'permission', 'probe',
      'registrationError', 'registry', 'section', 'sessions', 'supportedSections',
    ],
    '★ C 组登记：`registrationError` —— DEGRADED 的注册期成因必须可读出（与状态路由面同字段）',
  );
  // ★ 2026-10-10 schema 违约修复：切片（section=overview/models/credits/sessions/checkin）
  //   只回传子集 ⇒ 顶层 required 不能再钉 permission/checkin（否则合法切片必被宿主校验
  //   打回 "missing required property"）。改为钉**每个返回分支都会携带**的两个顶层安全
  //   周边字段 balance / creditsRemain（sessions 切片已补齐）。permission / checkin 在
  //   'all' 形状下必然在场，由 status-anti-prune.test.js 的 execute({}) 16 键断言 +
  //   全分支零违约校验钉住。
  assert.deepEqual(
    [...statusDef.output.schema.required].sort(),
    ['balance', 'creditsRemain'],
    '顶层 required 只保留跨分支不变量 balance / creditsRemain',
  );
  assert.equal(runDef.presentCall({ prompt: 'x' }).kind, 'execute');
  assert.equal(statusDef.presentCall({}).kind, 'read');

  // ★ render 必须**实际调用**才构成证据：defineTool 会无条件包装 render，
  //   只查 `typeof render === 'function'` 是恒真的（官方包装见 dsh-tools:855-857）。
  const runBlocks = runDef.output.render({ prompt: 'p' }, { job_id: 'j-1', session_key: 's-1', argv_preview: 'codebuddy -p p' });
  assert.ok(Array.isArray(runBlocks) && runBlocks[0]?.type === 'text');
  assert.match(runBlocks[0].text, /j-1/);
  // ★ 正/负控制对：续接与新会话必须渲染出**不同**文本，否则 `resumed` 字段形同虚设（假绿）。
  const newSessionText = runDef.output.render({ prompt: 'p' }, {
    job_id: 'j-1', session_key: 's-1', argv_preview: 'a', resumed: false, resumed_session_id: '',
  })[0].text;
  const resumedText = runDef.output.render({ prompt: 'p' }, {
    job_id: 'j-1', session_key: 's-1', argv_preview: 'a', resumed: true,
    resumed_session_id: 'c1f0a70f-4023-4969-a037-f4947a05d9cf',
  })[0].text;
  assert.match(newSessionText, /new session/);
  assert.doesNotMatch(newSessionText, /c1f0a70f/);
  assert.match(resumedText, /c1f0a70f-4023-4969-a037-f4947a05d9cf/);
  assert.doesNotMatch(resumedText, /new session/);
  const statusBlocks = statusDef.output.render({}, { registry: 'REGISTERED', probe: { installed: true, reason: 'ok', resolvedPath: CLI_FILE, method: 'desktop-cache', at: 1, evidence: [] }, config: { enabled: true, model: '', effort: '' }, effort: { canonical: ['off'], values: {} }, inFlight: [], lastRun: null });
  assert.ok(Array.isArray(statusBlocks) && statusBlocks[0]?.type === 'text');

  // 状态载荷：三态落点 = REGISTERED
  const payload = await host.statusPayload();
  assert.equal(payload.statusCode, 200);
  assert.equal(payload.json.registry, 'REGISTERED');
  // ★ 2026-10-02 桌面端形状：缓存命中 ⇒ method='desktop-cache'，且 `resolvedPath` **就是**那份缓存文件
  //   （不是某个可执行文件路径 —— 探测源已从 CLI 换成桌面产品配置缓存）。
  assert.equal(payload.json.probe.method, 'desktop-cache');
  assert.equal(payload.json.probe.resolvedPath, join(host.state.desktopHome, '.workbuddy', 'cache', 'acc-product-config-v3.json'));
  assert.equal(payload.json.config.enabled, true);
  assert.equal(payload.json.effort.canonical.length, 7); // canonical 7 档（含 off）
  assert.equal(Object.keys(payload.json.effort.values).length, 6); // WorkBuddy 实际 6 档（无 off）
  assert.equal(host.state.settingsArgs.ns, 'dsh-plugin-workbuddy', 'settings namespace 必须与 client 卡片键一致');
});

test('判据②：OFF ⇒ 不注册任何工具；registry 落 UNKNOWN（B1：从未探测，不冒充查过）；spawn 计数 === 0', { skip: SKIP }, async () => {
  const host = boot({ enabled: false });
  // ★ PRD-v4 §3 ①硬闸 / B1（2026-09-27 语义收紧，本处按任务书"单独说明"改判据）：
  //   旧断言在这里**等探测完成**（v3 无条件探测的行为）；PRD-v4 把①收紧为
  //   "probe / tools.register / 模型目录读取一律不发生" ⇒ OFF 时探测必须**从未启动**。
  //   probe 保持 null 是机器证据（probe() 的同步段就会写 lastProbeArgs ⇒ 只要启动过就不是 null）。
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(host.state.registration.size, 0, 'OFF 时模型看不到任何工具（最外层短路）');
  assert.equal(host.state.spawnCalls.length, 0, 'OFF 时 spawn 调用计数 === 0');
  const payload = await host.statusPayload();
  assert.equal(payload.json.probe, null, 'B1：OFF ⇒ 探测从未启动（不是"查过没装"）');
  assert.equal(payload.json.registry, 'UNKNOWN', 'B1：没查过就落 UNKNOWN（旧 UNREGISTERED 冒充"查过且开关关"）');
  assert.equal(payload.json.config.enabled, false);
  assert.equal(payload.json.models.length, 0, 'B1：OFF ⇒ 模型目录一律不读，列表为空');
  assert.equal(payload.json.modelsSource, 'disabled', '空列表的归因必须是"你关了它"');
  assert.equal(payload.json.cost.available, false, '① 硬闸：OFF 的端不进成本路由候选');
});

test('判据② 变体 S1（未安装 + 开）：不注册；registry 落 NOT_INSTALLED —— 与 S2 可区分', { skip: SKIP }, async () => {
  // ★ 2026-10-02：「没装」现在只由"桌面缓存不存在"表达（探测源已从 CLI 可执行文件换成桌面产品配置缓存）。
  //   `desktopInstalled: false` = 家目录照样隔离，但**不落那份缓存夹具** ⇒ 探测结论恒为 installed:false。
  //   屏蔽 ProgramFiles/LOCALAPPDATA 仍要做（那是 resolvedPath 的兜底源，会影响 evidence 而非 installed）。
  await withEnv({ ProgramFiles: 'C:\\__dsh_none__', ProgramW6432: undefined, 'ProgramFiles(x86)': undefined, LOCALAPPDATA: 'C:\\__dsh_none__' }, async () => {
    const host = boot({ enabled: true, desktopInstalled: false, catalog: null });
    const settled = await waitFor(async () => (await host.statusPayload()).json.probe !== null, { stepMs: 10 });
    assert.ok(settled, '探测应在超时前完成');
    assert.equal(host.state.registration.size, 0, '未安装 ⇒ 不注册（即便开关是 ON）');
    assert.equal(host.state.spawnCalls.length, 0);
    const payload = await host.statusPayload();
    assert.equal(payload.json.probe.installed, false);
    assert.equal(payload.json.probe.method, 'desktop-probe', '缓存未命中 ⇒ method 走 desktop-probe');
    assert.equal(payload.json.registry, 'NOT_INSTALLED');
  });
});

//   （现有 method 只有 desktop-cache / desktop-probe）。等价的桌面端形状由「判据② 变体 S1」覆盖。
// ────────────── 判据③ · H-ORTHOGONAL（注销 ≠ 杀作业）+ ⑥ 契约 ──────────────

// ★ 2026-10-02 删除：`cliPath` 配置键与 `resolveExecutable` 探测支路都已删除，本用例测的是"配置里那条
//   CLI 路径命中 ⇒ installed:true + resolvedPath 一致"。桌面端形状下 resolvedPath = 缓存文件路径，
test('并发上限 = 1（§7.4 M2）：在途未收敛时二次下发放拒绝；收敛后可再次下发', { skip: SKIP }, async () => {
  // ★ 计划任务主路下用注入的悬挂点火测并发（真点火在缺表夹具里失败太快，窗口关得比断言快）。
  const { makeRunTool } = await import('../src/host/tools/run.js');
  const runtime = (await import('../src/host/config/runtime.js')).createRuntime({ pluginId: 'plugin-workbuddy', config: {}, ns: 'm2' });
  await runtime.probe(async () => ({ installed: true, reason: 'test', target: 'workbuddy' }), {});
  let release;
  const pending = new Promise((r) => { release = r; });
  const hanging = () => ({ cancel: () => {}, done: pending, readOutput: () => '' });
  // ★ 必须先挂住，否则第二轮断言前就变成 unhandled rejection。
  pending.catch(() => {});
  const jobs = {
    store: new Map(), seq: 0,
    start(spec) {
      const hooks = spec.run();
      const id = `${spec.kind}-${++jobs.seq}`;
      jobs.store.set(id, { id, hooks });
      return id;
    },
    get(id) { return jobs.store.get(id); },
  };
  const sessions = { createKey: () => 'k', capture: () => null, resumable: () => null, adopt: () => ({ ok: true }) };
  const cfg = () => ({ enabled: true, model: '', cwdRoot: '', boundSessionId: '' });
  const ctx = { jobs };
  const exec = { signal: new AbortController().signal };
  const runDef = makeRunTool(runtime, sessions, cfg, ctx, null, null, { automationRun: hanging });

  const first = await runDef.execute({ prompt: 'job one' }, exec);
  const jobsAfterFirst = jobs.store.size;
  await assert.rejects(() => runDef.execute({ prompt: 'job two' }, exec), /busy|concurrency/);
  assert.equal(jobs.store.size, jobsAfterFirst, '被拒的第二次下发不得建作业');

  // 收敛后容量释放：让悬挂的 done 落到 automation 终态形状，再等结算把在途清掉。
  release({ status: 'completed', detail: 'ok', exitCode: 0, automation: { reason: null, automationId: 'automation-m2', conversationId: 'conv-m2', sessionId: 'conv-m2', retired: true, phases: [] } });
  await jobs.get(first.job_id).hooks.done;
  const second = await runDef.execute({ prompt: 'job three' }, exec);
  assert.equal(jobs.store.size, jobsAfterFirst + 1, '收敛后容量释放');
  assert.notEqual(second.job_id, first.job_id);
});

test('A4 最外层短路：开关转 OFF 后，仍持有的 run 定义 execute 抛错且不再 spawn', { skip: SKIP }, async () => {
  const host = boot({ enabled: true });
  await waitFor(() => host.state.registration.size === 3);
  const runDef = host.state.registration.get('workbuddy_run');

  host.setEnabled(false);
  // ★ C 组改写：旧断言 `/disabled or not installed/` 把"没装"也写进同一句 ⇒ 该正则与"未安装"分支**同形**，
  //   换不成真判据。现在 OFF 只许说 OFF（见下一条：未安装说的是另一句话）。
  await assert.rejects(
    () => runDef.execute({ prompt: 'must not run' }, { signal: new AbortController().signal }),
    /switched OFF/,
  );
  assert.equal(host.state.spawnCalls.length, 0, '短路必须在 spawn 之前发生');
});

// ── 下发健康 C 组：首轮竞态（探测未结论 ≠ 未安装）────────────────────────────────
// 病害（LLM-GUIDE §5-21）：`apply.js` 故意不 await 探测，而注册判据曾是 `enabled && installed`
//   ⇒ 探测在途时 `installed` 读作 false ⇒ 这一回合**两个工具都不注册**，主控连"这里能委派"都不知道；
//   execute 那句 `disabled or not installed` 还会把一个装得好好的机器说成"没装"。

//   已由「判据① + ⑤」的状态载荷断言覆盖。
test('C-2 U4 未被放宽：开关 OFF 且探测在途 ⇒ 一个工具都不注册', { skip: SKIP }, async () => {
  const gate = new Promise(() => {}); // 永不落地
  const host = boot({ enabled: false, cliPath: '', probeGate: gate });
  assert.equal(host.state.registration.size, 0, 'OFF ⇒ 零注册（与探测结论无关，硬闸）');
  assert.equal(host.state.spawnCalls.length, 0);
});

test('C-3 结论"未安装"落地 ⇒ 乐观注册被撤销（收敛点只有一个：reconcile）', { skip: SKIP }, async () => {
  // ★ 2026-10-02：原来的 `probeGate` 注入面随 `resolveExecutable` 一起删除了，"结论何时落地"
  //   没法再钉在测试手里。现在用 `desktopInstalled: false` 直接给出"未安装"这个结论本身 ——
  //   本用例要钉的判据是**收敛点只有一个**（不是时序），时序只保证先在场、后注销。
  //   withEnv：屏蔽本机真实安装位（那是 resolvedPath 的兜底源，会污染 evidence）。
  await withEnv({ ProgramFiles: 'C:\\__dsh_none__', ProgramW6432: undefined, 'ProgramFiles(x86)': undefined, LOCALAPPDATA: 'C:\\__dsh_none__' }, async () => {
    const host = boot({ enabled: true, desktopInstalled: false, catalog: null });
    assert.equal(host.state.registration.size, 3, '未结论时在场');
    const cleared = await waitFor(() => host.state.registration.size === 0);
    assert.ok(cleared, '结论 = 未安装 ⇒ 必须注销');
    assert.equal(host.state.spawnCalls.length, 0, '注销路径不触碰进程');
  });
});

test('C-4 结论"未安装"时 execute 说的是**未安装**这句话（并指向证据面），不再顺嘴说"被关闭"', { skip: SKIP }, async () => {
  // 直接取定义复演"误注册"场景（A4 的原始命题）：注册器已注销时，这句话仍须分得清成因。
  const { makeRunTool } = await import('../src/host/tools/run.js');
  const runDef = makeRunTool(
    { detected: () => ({ installed: false, reason: 'not_found' }), awaitDetection: async () => null, inFlightCount: () => 0 },
    { createKey: () => 'k', capture: () => null, resumable: () => null },
    () => ({ enabled: true }),
    { jobs: {}, subprocess: {} },
  );
  await assert.rejects(
    () => runDef.execute({ prompt: 'x' }, { signal: new AbortController().signal }),
    /was not found[\s\S]*not_found[\s\S]*workbuddy_status/,
  );
});

test('C-4b 探测压根没跑过 ⇒ 说"还没有结论"，绝不说成"未安装"（第三成因独立成句）', { skip: SKIP }, async () => {
  const { makeRunTool } = await import('../src/host/tools/run.js');
  const runDef = makeRunTool(
    { detected: () => null, awaitDetection: async () => null, inFlightCount: () => 0 },
    { createKey: () => 'k', capture: () => null, resumable: () => null },
    () => ({ enabled: true }),
    { jobs: {}, subprocess: {} },
  );
  await assert.rejects(
    () => runDef.execute({ prompt: 'x' }, { signal: new AbortController().signal }),
    /no availability detection has completed yet/,
  );
});

test('C-5 可用性文案跟着注册实况：未结论**且工具在场**时不得说"tools are not offered"', { skip: SKIP }, async () => {
  const REGISTERED = mods.constants.REGISTRY_STATES.REGISTERED;
  const UNKNOWN = mods.constants.REGISTRY_STATES.UNKNOWN;
  const offeredText = mods.availability.availabilityText({
    detected: () => null, registry: () => REGISTERED, currentConfig: () => ({ model: '', effort: '' }),
  });
  assert.match(offeredText, /still being determined/);
  assert.ok(!/are not offered/.test(offeredText), '工具在场时说"not offered" = 假状态');
  assert.match(offeredText, /are offered in the meantime/);

  const absentText = mods.availability.availabilityText({ detected: () => null, registry: () => UNKNOWN });
  assert.match(absentText, /^WorkBuddy delegation is unavailable: availability is still being determined\. The workbuddy_run \/ workbuddy_status tools are not offered\./,
    '未注册时旧句子逐字保留（既有契约）');

  const notInstalledText = mods.availability.availabilityText({
    detected: () => ({ installed: false, reason: 'not_found' }), registry: () => mods.constants.REGISTRY_STATES.NOT_INSTALLED,
  });
  // ★ 2026-10-02：文案里的主语从「WorkBuddy CLI」换成「WorkBuddy desktop」——
  //   探测源已换成桌面端产品配置缓存，继续说"CLI 没装"会让用户去装一个已经不存在的东西。
  assert.match(notInstalledText, /the WorkBuddy desktop was not found on this machine\. The workbuddy_run \/ workbuddy_status tools are not offered\./);
});

test('C-6 探测在途时被拨 OFF ⇒ 落 UNREGISTERED，不得冒充"未安装"（未结论 ≠ 未安装的**落态**侧）', { skip: SKIP }, async () => {
  // 这条路径是 C 组**新打开**的：旧判据下"探测在途"根本轮不到注册 ⇒ 也就轮不到"在途期间被注销"。
  // 旧表达式 `installed ? UNREGISTERED : NOT_INSTALLED` 于是会把"还不知道"写成"查过且没有"。
  await withEnv({ ProgramFiles: 'C:\\__dsh_none__', ProgramW6432: undefined, 'ProgramFiles(x86)': undefined, LOCALAPPDATA: 'C:\\__dsh_none__' }, async () => {
    const gate = new Promise(() => {}); // 结论永不落地
    const host = boot({ enabled: true, cliPath: '', probeGate: gate });
    assert.equal(host.state.registration.size, 3, '未结论时在场');
    host.setEnabled(false);
    const off = await waitFor(() => host.state.registration.size === 0);
    assert.ok(off, 'OFF ⇒ 注销（硬闸与探测结论无关）');
    const payload = await host.statusPayload();
    assert.equal(payload.json.registry, 'UNREGISTERED', '只因开关注销 ⇒ 不得说成"未安装"');
    assert.equal(host.state.spawnCalls.length, 0);
  });
});

test('空 prompt 拒收（真机 label 校验的前置守卫）：不 spawn、不建作业', { skip: SKIP }, async () => {
  const host = boot({ enabled: true });
  await waitFor(() => host.state.registration.size === 3);
  const runDef = host.state.registration.get('workbuddy_run');
  await assert.rejects(() => runDef.execute({ prompt: '   ' }, { signal: new AbortController().signal }), /non-empty/);
  assert.equal(host.state.spawnCalls.length, 0);
  assert.equal(host.jobs.store.size, 0);
});

test('prompt 以 "-" 开头 ⇒ 拒收（防注入 CLI flag 的提权向量）', { skip: SKIP }, async () => {
  const host = boot({ enabled: true });
  await waitFor(() => host.state.registration.size === 3);
  const runDef = host.state.registration.get('workbuddy_run');
  await assert.rejects(
    () => runDef.execute({ prompt: '--permission-mode bypassPermissions do X' }, { signal: new AbortController().signal }),
    /must not start with/,
  );
  await assert.rejects(
    () => runDef.execute({ prompt: '   -m evil' }, { signal: new AbortController().signal }),
    /must not start with/,
  );
  assert.equal(host.state.spawnCalls.length, 0);
});

// ★ 2026-10-02 删除：`cliPath` 已从 Config 删除，"settings 覆盖 cliPath 触发复探"这条链不再存在。
// ★ 2026-10-02 删除：CLI 传输已整体删除，本用例的判据是 spawnCalls/argv（`-p`/`--output-format`）。
test('半注册回滚（U4 抗击穿）：第二个 register 抛 ⇒ 已注册项回滚 + DEGRADED + 原因可见但不炸穿装配', { skip: SKIP }, async () => {
  // ★ 下发健康 C 组改写了这一条的**前提**：乐观注册把撞名从"探测落地后（异步、被监听器 try/catch 吞掉）"
  //   提前到了 `apply()` 的同步回合。实测 cordis `lib/index.js:1248-1261`：`ctx.effect` 工厂里的同步异常
  //   会原样上抛 ⇒ 旧的 `throw err` 在此刻会穿透 apply()，让 ⑤ 状态路由与 ⑥ 提示词 section 都不再装配
  //   —— 别的插件只要占走一个工具名，就能把本插件的状态卡片整个抹掉（DEGRADED 反而无从观察）。
  //   因此现在：回滚 + DEGRADED + 把原因**记进 runtime**（三处可见），不外抛。boot() 本身必须**不抛**。
  const host = boot({ enabled: true, preRegistered: ['workbuddy_status'] });
  assert.equal(host.state.routes.has(ROUTE_STATUS), true, '注册故障不得带走状态路由（否则降级无处可读）');
  const settled = await waitFor(async () => (await host.statusPayload()).json.registry === 'DEGRADED', { stepMs: 10 });
  assert.ok(settled, '注册失败应落 DEGRADED（经状态载荷可观察）');
  const payload = await host.statusPayload();
  assert.equal(payload.json.registry, 'DEGRADED');
  assert.match(String(payload.json.registrationError), /duplicate tool registration: workbuddy_status/,
    '降级必须带着来由（"不静默"现在由字段承载，而不是一条没人看的堆栈）');
  assert.equal(host.tools.get('workbuddy_run'), undefined, '已成功的第一个注册必须被回滚（否则 OFF 永远注销不掉）');
  assert.deepEqual(host.state.registration.get('workbuddy_status'), { name: 'workbuddy_status' },
    '回滚只撤销本插件自己的注册，不得动占名者的条目');
  assert.equal(host.state.registration.size, 1);
  // 文案侧：DEGRADED 的这类成因下工具**确实不在场** ⇒ 不得再说 "delegation is available"
  const text = mods.availability.availabilityText({
    detected: () => ({ installed: true, reason: 'ok' }),
    registry: () => mods.constants.REGISTRY_STATES.DEGRADED,
    registrationError: () => 'duplicate tool registration: workbuddy_status',
    currentConfig: () => ({ model: '', effort: '' }),
  });
  assert.match(text, /could not be registered/, '须说清是注册失败，而非"上次启动失败"');
  assert.match(text, /are not offered/);
  assert.ok(!/use workbuddy_run to delegate/.test(text), '工具不在场时不得召唤模型去调它');

  // 自愈（★ 变异验证逼出来的写法）：占名者让开 ⇒ **下一次配置变更触发的 reconcile** 直接注册成功并清除旧来由。
  //   早先用 OFF→ON 做这一步，清除会被 `!want` 分支顺带做掉 ⇒ 成功路径自己清不清都测不出来（M10 当时"能绿"）。
  host.state.registration.delete('workbuddy_status');
  await host.settingsService.update(host.state.settingsArgs.ns, { model: 'heal-model-x' });
  const back = await waitFor(() => host.state.registration.size === 3);
  assert.ok(back, '占名者让开后的下一次 reconcile 应能重新注册');
  const healed = await host.statusPayload();
  assert.equal(healed.json.registry, 'REGISTERED');
  assert.equal(healed.json.registrationError, null, '注册成功后不得留下旧故障（清除必须发生在**成功路径本身**）');
});

// ── 以下 4 条同批删除（CLI 传输、`launch/argv.js` 已整体删除）：
//
// ★ 删除 `判据③ + ⑥`：判据是 `spawnCalls` / `argv`（`-p`、`--output-format`）。在途作业仍会完成这件事
//   改由网关路径承载；"注销不触碰作业"的钉子仍在 tools/index.js 的收敛点注释里。
// ★ 删除 `启动失败 ⇒ DEGRADED`：`failNextSpawn` 是 spawn 出口的注入面，网关路不再有"启动进程"这一步
//   （连"启动失败⇒DEGRADED / 任务失败≠环境故障"这组判据的触发器也没有了）。
// ★ 删除 `取消（AbortError）不是环境故障`：AbortError 来自 spawn 的 "aborted before spawn"，
//   网关路的取消走 AbortController。
// ★ 删除 `作业控制面`：判据是 `readFrom(fromByte)` 的**字节** offset 语义与作业首行 = argv preview；
//   网关路没有 argv，也没有进程收集器。
//
// ★ 删除 `C-1 探测在途`：`probeGate` 注入面随 `resolveExecutable` 一起删除，本用例靠它制造"探测在途"。
//   桌面端形状下探测在途是**自然**状态（端口可达性探测最多 200ms），这条判据改由「C-3 结论未安装落地」
//   与「模型目录三态：boot 首帧」覆盖 —— 后者显式断言首帧 `probe === null` 且 `modelsSource` 落 `pending:*`。

test('session/map 基线：uuid 键 / 只读 lookup（查不到返回 null，不猜）/ capture 记账 / list', { skip: SKIP }, () => {
  // 无 settings 服务（ctx.get ⇒ undefined）⇒ 落盘能力缺失，但内存视图与记账必须照常工作且**不抛**
  const sessions = mods.sessionMap.loadSessionMap({ get: () => undefined }, 'dsh-plugin-workbuddy');
  const key = sessions.createKey();
  assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(sessions.lookup(key), null, '未 capture 前不猜');
  assert.equal(sessions.lookup(''), null);
  assert.equal(sessions.resumable(key), null, '未捕获 session id ⇒ 不可恢复（不得发明）');
  sessions.capture(key, 'abcde');
  assert.equal(sessions.lookup(key).outputBytes, 5);
  assert.equal(sessions.lookup(key).outputTruncated, false, '未裁剪 ⇒ 不标记截断');
  sessions.capture(key, 'tail-only', true); // lossy=true（真机 readFrom 的字段）
  assert.equal(sessions.lookup(key).outputTruncated, true, 'lossy ⇒ 如实记账（T04 重放不得当全量）');
  assert.equal(sessions.lookup(key).cliSessionId, null, '非 JSONL 输出 ⇒ 抽不到 session id（不猜）');
  assert.equal(sessions.resumable(key), null);
  assert.equal(sessions.persistence().noop > 0, true, '无 settings 服务 ⇒ 如实记 noop（不静默成功）');
  const list = sessions.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].key, key);
});

test('session/map（T04）：从 stream-json 抽取 session id ⇒ 落盘（经 settings.update）+ 可恢复', { skip: SKIP }, async () => {
  const host = boot({ enabled: false });
  const ns = 'dsh-plugin-workbuddy';
  // 真机契约：`ctx.get('settings')` 返回 **settings 服务**（有 update/get），不是解析后的配置值
  const sessions = mods.sessionMap.loadSessionMap({ get: (n) => (n === 'settings' ? host.settingsService : undefined) }, ns);
  const key = sessions.createKey();
  assert.equal(sessions.resumable(key), null);

  const initFrame = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-abc_1', cwd: 'C:/proj', model: 'auto', permissionMode: 'default' });
  const assistant = JSON.stringify({ type: 'assistant', session_id: 'sess-abc_1', message: { content: [] } });
  const captured = sessions.capture(key, `${initFrame}\n${assistant}\n`);
  assert.equal(captured.cliSessionId, 'sess-abc_1');
  assert.equal(captured.source, 'init');
  assert.deepEqual(sessions.resumable(key), { cliSessionId: 'sess-abc_1', cwd: 'C:/proj' }, 'cwd 仅作记录（init 帧取值），不参与 spawn 决策（§7.3 优先级不变，T05 待议）');

  const res = await sessions.settled();
  assert.equal(res.ok, 1, '应经 settings.update 落盘一次');
  assert.equal(host.state.updateCalls.length, 1);
  assert.equal(host.state.updateCalls[0].ns, ns);
  assert.deepEqual(Object.keys(host.state.updateCalls[0].patch), ['sessions'], 'patch 形态 = { sessions: { <key>: … } }');
  const rec = host.state.updateCalls[0].patch.sessions[key];
  assert.equal(rec.cliSessionId, 'sess-abc_1');
  assert.equal(rec.lastUsedAt > 0, true);
  // 拒绝非法 id：不得把注入串写进 argv 可用的字段
  sessions.capture(key, '{"session_id":"bad id;rm -rf"}\n');
  await sessions.settled();
  assert.equal(sessions.resumable(key).cliSessionId, 'sess-abc_1', '非法 id 被丢弃 ⇒ 保留上一个合法值（不得清空）');

  // 落盘失败 ⇒ 记账为失败且不抛（作业收敛不能被 settings 写失败拖垮）
  host.settingsService.failNextUpdate = true;
  sessions.capture(key, 'x');
  const res2 = await sessions.settled();
  assert.equal(res2.failures > 0, true);
  assert.equal(res2.lastError.includes('__fake_settings_update_failed__'), true);
});

test('session/map（诚实性）：`persisted` 只在"提交真的出去了"时为 true —— 无 settings 服务（noop）必须 false，不得把"什么都没写"报成已落盘', { skip: SKIP }, () => {
  // 这条盯的是字段口径，不是机制：`persisted` 的字段名是"存下来了吗"，不是"没抛错吗"。
  const sessions = mods.sessionMap.loadSessionMap({ get: () => undefined }, 'dsh-plugin-workbuddy');
  const key = sessions.createKey();
  const captured = sessions.capture(key, '{"session_id":"sess-honest_1"}\n');
  assert.equal(captured.persistState, 'noop', '无 settings 服务 ⇒ 如实说"没提交"');
  assert.equal(captured.persistError, 'settings.update unavailable');
  assert.equal(captured.persisted, false, '★ 压根没提交就不许说 persisted（历史口径 `!== failed` 会在此谎报 true）');
  assert.equal(sessions.persistence().noop > 0, true, '同一事实在记账里也必须可见');
});

test('session/map（诚实性）：有 settings 服务 ⇒ `persisted:true` 只表示"已受理"；最终成败只能从 persistence()/settled() 读', { skip: SKIP }, async () => {
  const host = boot({ enabled: false });
  const sessions = mods.sessionMap.loadSessionMap({ get: (n) => (n === 'settings' ? host.settingsService : undefined) }, 'dsh-plugin-workbuddy');
  const key = sessions.createKey();
  const ok = sessions.capture(key, '{"session_id":"sess-honest_2"}\n');
  assert.equal(ok.persisted, true, '已受理 ⇒ true（口径：提交过就算 true，含尚未收敛）');
  assert.equal(ok.persistState, 'pending', 'settings.update 返回 thenable ⇒ 当场只能给 pending（收敛在 settled()）');
  assert.equal((await sessions.settled()).ok, 1);

  // ★ 受理 ≠ 写成：异步失败时 capture 的返回值仍是 true，真话在记账里（调用方不得把 capture 返回值当最终结论）。
  host.settingsService.failNextUpdate = true;
  const bad = sessions.capture(key, 'x');
  assert.equal(bad.persisted, true);
  assert.equal(bad.persistState, 'pending');
  const res = await sessions.settled();
  assert.equal(res.failures > 0, true, '★ persisted:true 不等于写成了 —— 最终成败只在记账里');
});

// ───────────────────────── 定义级 schema 断言（补强） ─────────────────────────

test('Config schema：默认 OFF + model/effort 空串（不发明默认）；launch 表默认空', { skip: SKIP }, () => {
  // ★ 0.1.7：`.volatile()` 字段的 schema 输出是 `{get()}` 包装器而非裸值
  //   （官方读法 `config.model.get()`，见 dsh-agent-default-model/lib/index.js:39-42）。
  //   默认值断言必须先解包，否则 assert.equal(包装器, false) 恒假。
  const plain = (value) =>
    JSON.parse(
      JSON.stringify(value, (_k, v) =>
        v !== null && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v,
      ),
    );
  const resolved = plain(mods.apply.Config['~standard'].validate({}).value);
  assert.equal(resolved.enabled, false);
  assert.equal(resolved.model, '');
  assert.equal(resolved.effort, '');
  assert.deepEqual(resolved.sessions, {}, 'T04：会话映射默认空表');
  assert.deepEqual(resolved.launch.effortValues, {}, '档位表是数据（补丁/用户层提供），不硬编码进 schema');
  // ★ 2026-10-02：CLI 线整体删除 ⇒ 这两个键**必须不在 schema 里**。
  //   断言"缺席"而不是不写：schemastery 对未知键是**静默丢弃**（用户改了永远没效果、也没有报错），
  //   一张没人读、也没人喂的旗标表 = 一个永远不生效的承诺。留着这两行是防止它们被悄悄加回来。
  assert.deepEqual(Object.keys(resolved.launch), ['effortValues'], 'launch 里只剩档位能力表（旗标表已删净）');
  assert.equal(Object.prototype.hasOwnProperty.call(resolved, 'nodePath'), false, '`nodePath` 键已随 CLI 线删除');
  assert.equal(Object.prototype.hasOwnProperty.call(resolved, 'cliPath'), false, '`cliPath` 键已随 CLI 线删除');
  // sessions 必须容忍任意记录形态（手改 settings 不能让整份 namespace 校验失败）
  const withSessions = mods.apply.Config['~standard'].validate({ sessions: { k: { cliSessionId: 'a', extra: 1 } } });
  assert.equal(withSessions.issues ?? null, null);
  assert.deepEqual(plain(withSessions.value).sessions, { k: { cliSessionId: 'a', extra: 1 } });
});

test('三处同步（P2-11）：patch 的键集合与层级 = Config 声明；取值逐字一致；档位表 = WorkBuddy 6 档', { skip: SKIP }, async () => {
  // 0.1.7：volatile 字段先解包（见上一条的说明），否则取值比对拿包装器去比字符串。
  const plain = (value) =>
    JSON.parse(
      JSON.stringify(value, (_k, v) =>
        v !== null && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v,
      ),
    );
  const yaml = readFileSync(join(here, '..', 'cordis.patch.yml'), 'utf8');
  const resolved = plain(mods.apply.Config['~standard'].validate({}).value);
  // ★ 键集合与**层级**由红线的同一个解析器给出（`tools/ci/check-consumed-knobs.mjs`）。
  //   本断言刻意不再硬编码键名清单：上一版写死 11 个键 + 用 `yaml.includes("permissionMode: ''")`
  //   判定，**看不见缩进层级** ⇒ 把顶层取值 `permissionMode` 放进 `launch:` 块也能过（WB-7 实录）。
  //   复用解析器 = 红线与测试共用一份真源，不会出现"测试放宽而红线仍严"的分裂。
  const { parsePatchKeys } = await import('../../../tools/ci/check-consumed-knobs.mjs');
  const patch = parsePatchKeys(yaml);
  const patchKeys = new Set([...patch.top.map((k) => k.name), ...patch.launch.map((k) => `launch.${k.name}`)]);
  const schemaKeys = new Set([
    ...Object.keys(resolved).filter((k) => k !== 'launch'),
    ...Object.keys(resolved.launch).map((k) => `launch.${k}`),
  ]);
  assert.deepEqual(
    [...patchKeys].sort(),
    [...schemaKeys].sort(),
    'cordis.patch.yml 与 Config 的键集合（含层级）不一致：patch-only 会被 schemastery 静默丢弃，schema-only 用户看不到',
  );
  // 取值逐字一致（这是本断言相对红线的**增量**：红线查键名与消费，不查默认值本身）
  const ymlScalar = (v) => (typeof v === 'string' ? `'${v}'` : Array.isArray(v) ? `[${v.map(ymlScalar).join(', ')}]` : typeof v === 'object' && v !== null ? '{}' : String(v));
  for (const [key, value] of Object.entries(resolved)) {
    if (key === 'launch') continue;
    assert.ok(yaml.includes(`${key}: ${ymlScalar(value)}`), `patch 取值漂移：${key}（期望一行 \`${key}: ${ymlScalar(value)}\`）`);
  }
  // ★ 2026-10-02：launch 旗标表已删净，只剩 `effortValues`（档位**能力**表，不是旗标名）。
  //   原先那 12 个 `launch.<flag>` 的逐字比对随 CLI 线一起作废 —— 它们没有任何代码读。
  assert.deepEqual(Object.keys(resolved.launch).sort(), ['effortValues'], 'launch 只剩档位能力表');
  for (const [k, v] of Object.entries(EFFORT_VALUES)) {
    assert.ok(yaml.includes(`${k}: '${v}'`), `档位表漂移：${k}`);
  }
  assert.ok(!yaml.includes('off:'), 'WorkBuddy 无 off 档（§4.2.1 置灰）——yml 不得出现该 key');
});

//   桌面端形状下探测在途是自然状态（端口可达性探测最多 200ms），改由「C-1 探测在途」覆盖，
// ─────────────── T04：参数接受度 / 会话续接 / 运行时缺失（§4.5 · §5.3 · D-3） ───────────────

//   那条已改成不依赖任何 spawn 计数桩。
// ★ 2026-10-02 删除：CLI 传输已整体删除，本用例读 `ctx.subprocess.spawn` 的 `call.cwd`。
//   网关路的 cwd 由 `run.js` 的 `gwCwd` 计算并**如实回传**在 `argv_preview` 里。
// ───────────────────────── 卸载收敛（无泄漏） ─────────────────────────

test('卸载收敛：工具 / 路由 / prompt section / settings fiber 随 effect disposer 全清', { skip: SKIP }, async () => {
  const host = boot({ enabled: true });
  await waitFor(() => host.state.registration.size === 3);
  // ★ 2026-09-28：第 2 个路由是**只读诊断端点**（`/plugin-workbuddy/diagnostics`），
  //   加它的理由不是"多暴露点"：整条下发链路此前**零可观测性**——真机向两条空闲 sidecar
  //   下发全败，而 dsh-web.log 里连 workbuddy 都没出现，成因只能靠猜。
  //   它与 2026-09-27 删掉的**凭据路由不是同一种东西**：那个回显凭据（E3c 红线），
  //   这个只回候选数/端点/picked/成因，且 loopback-only。下面另有"不回显凭据"的专项断言。
  assert.equal(host.state.routes.size, 2, '★ 状态路由 + 只读诊断路由（凭据路由 2026-09-27 已删）');
  assert.equal(host.state.sections.size, 1);

  for (const e of host.state.effects) e.dispose();
  assert.equal(host.state.registration.size, 0, '工具应全部注销');
  assert.equal(host.state.routes.size, 0, '路由应全部注销');
  assert.equal(host.state.sections.size, 0, 'prompt section 应全部注销');
  assert.equal(host.state.fiberDisposals, 4, '四个 fiber（tools 的 settings + injects 的两个 + 子智能体面）都应被 dispose');
});

test('bridge：非 GET ⇒ 405 + Allow: GET', { skip: SKIP }, async () => {
  const host = boot({ enabled: false });
  const res = await host.statusPayload('POST');
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, 'GET');
});

test('bridge：非 loopback / 无 socket ⇒ 403 fail-closed（载荷含本机路径与 argv，不向局域网暴露）', { skip: SKIP }, async () => {
  const host = boot({ enabled: false });
  const remote = await host.statusPayload('GET', '192.168.1.50');
  assert.equal(remote.statusCode, 403);
  assert.deepEqual(remote.json, { error: 'loopback-only' });
  const noSocket = await host.statusPayload('GET', null);
  assert.equal(noSocket.statusCode, 403, '缺 socket 必须 fail-closed');
  const nearMiss = await host.statusPayload('GET', '127.0.0.1.example.com');
  assert.equal(nearMiss.statusCode, 403, '前缀伪装（127. 开头但非 IP）不得放行');
  for (const loopback of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1']) {
    const res = await host.statusPayload('GET', loopback);
    assert.equal(res.statusCode, 200, `${loopback} 应放行（127/8 全段 + v6）`);
  }
});

test('bridge：Host 栅栏 —— 非 loopback authority ⇒ 403（DNS-rebinding 防 confused deputy）', { skip: SKIP }, async () => {
  const host = boot({ enabled: false });
  const rebind = await host.statusPayload('GET', '127.0.0.1', 'evil.example.com');
  assert.equal(rebind.statusCode, 403, '外部域名 Host 解析到 127.0.0.1 也不得放行');
  const noHost = await host.statusPayload('GET', '127.0.0.1', null);
  assert.equal(noHost.statusCode, 403, '缺 Host 头 fail-closed');
  const lanHost = await host.statusPayload('GET', '127.0.0.1', '192.168.1.50:7777');
  assert.equal(lanHost.statusCode, 403);
  for (const allowed of ['127.0.0.1:7777', 'localhost:7777', '[::1]:7777']) {
    const res = await host.statusPayload('GET', '127.0.0.1', allowed);
    assert.equal(res.statusCode, 200, `${allowed} 应放行（loopback authority）`);
  }
});

test('模型目录读取：无桌面产品配置 ⇒ 空列表 + 精确降级原因（不阻塞、不伪造）', { skip: SKIP }, async () => {
  await withEnv({
    ACC_PRODUCT_CONFIG: undefined, ACC_PRODUCT_CONFIG_V2: undefined, ACC_PRODUCT_CONFIG_V3: undefined,
    ACC_PRODUCT_CONFIG_PATH: undefined,
  }, async () => {
    // ★ 2026-10-02：`desktopHome` 指到一个**没有**那份缓存的目录。
    //   注意读法变了：`boot()` 现在自己把 WORKBUDDY_HOME/HOME/USERPROFILE 三者一起指到一次性临时家，
    //   所以外层 `withEnv` 里设 HOME/USERPROFILE 已经**盖不住**了（boot 会覆盖）——隔离改由 boot 的
    //   `desktopHome` 承担。旧写法（只设 HOME/USERPROFILE）会让结果取决于**本机装没装 WorkBuddy**。
    const host = boot({ enabled: true, desktopInstalled: false, catalog: null });
    const settled = await waitFor(async () => (await host.statusPayload()).json.probe !== null, { stepMs: 10 });
    assert.ok(settled, '探测应在超时前完成');
    const payload = (await host.statusPayload()).json;
    assert.deepEqual(payload.models, []);
    // ★ 取不到**任何**产品配置源（内联 env / env 路径 / 桌面缓存三处都没有）⇒ 归因是
    //   `catalog-not-resolved`。`catalog-unreadable`（stat 得到文件但读不出来）需要真的造一个
    //   读不出来的文件，那条分支由 test/hardening.test.js 的内联源用例覆盖，不在这里硬凑。
    assert.equal(payload.modelsSource, 'unavailable:catalog-not-resolved');
  });
});

// ───────── §4-9 · 模型目录三态：探测"在途"不得写成"不可用"（真机首帧抓到） ─────────

/**
 * 真机取证（RECON §9.4 / ISSUE §4-9）：探测仍在途时状态载荷给
 * `models:[], modelsSource:"unavailable:cli-not-resolved"` ⇒ 装了 CLI 的机器上卡片显示"不可用"。
 * 这与 §22 修掉的 "disabled or not installed" 是**同一种折叠**（三态压成两态），所以判据钉在两处：
 *   ① 真实 boot 的首帧（下方第一条）—— 钉"缺陷不再出现"；
 *   ② 两个出口的同一判定（下方第二条）—— 钉"UI 面与工具面不会说两种话"。
 */
test('模型目录三态：boot 首帧（探测尚无结论）⇒ pending:*，结论到手后才允许 unavailable:*', { skip: SKIP }, async () => {
  await withEnv({
    ACC_PRODUCT_CONFIG: undefined, ACC_PRODUCT_CONFIG_V2: undefined, ACC_PRODUCT_CONFIG_V3: undefined,
    ACC_PRODUCT_CONFIG_PATH: undefined,
  }, async () => {
    // `catalog: null` = 家目录照样隔离，但**不落**桌面产品配置缓存 ⇒ 目录取不到，而探测仍会正常出结论。
    // （隔离由 boot 的 `desktopHome` 承担：boot 把 WORKBUDDY_HOME/HOME/USERPROFILE 一起指到一次性临时家，
    //   外层 withEnv 设的 HOME/USERPROFILE 已被它覆盖。）
    const host = boot({ enabled: true, catalog: null });
    // `latestProbe` 只在 `await fn()` 之后写入 ⇒ boot 同步返回后的这一帧必然还没有结论。
    const first = (await host.statusPayload()).json;
    assert.equal(first.probe, null, '前提校验：首帧探测应尚未出结论（否则本判据什么都没测到）');
    assert.match(first.modelsSource, /^pending:/, `在途/未排上必须落 pending，实际：${first.modelsSource}`);
    assert.doesNotMatch(first.modelsSource, /^unavailable/, '★ 真机缺陷的名字：在途不得说"不可用"');
    assert.deepEqual(first.models, [], '无清单时保持空数组（不伪造、不给 null）');

    // 正控：pending 不是"永远不说不可用" —— 结论到手后同一出口必须能给出精确的 unavailable 来由。
    const settled = await waitFor(async () => (await host.statusPayload()).json.probe !== null, { stepMs: 10 });
    assert.ok(settled, '探测应在超时前完成');
    const done = (await host.statusPayload()).json;
    assert.match(done.modelsSource, /^unavailable:/, '已结论却取不到目录 ⇒ 仍要如实说不可用');
    // ★ 2026-10-02：桌面端形状下探测的结论只看那份缓存 —— 缓存不存在 ⇒ installed:false，
    //   而 `unavailable:*` 正是这个结论的如实投影（两者同源，不各说各话）。
    assert.equal(done.probe.installed, false, '家目录里没有桌面产品配置缓存 ⇒ 桌面端不可用');
    assert.equal(done.probe.method, 'desktop-probe');
  });
});

/** 最小 status runtime 桩：只暴露**真实存在**的读数（`detected` / `probeArgs` / `registry` / `inFlight` / `lastRun`）。 */
function statusRuntime({ probe, args }) {
  return {
    detected: () => probe,
    probeArgs: () => args,
    registry: () => mods.constants.REGISTRY_STATES.REGISTERED,
    registrationError: () => null,
    currentConfig: () => ({ enabled: true, transport: 'spawn', model: '', effort: '', launch: { effortValues: { ...EFFORT_VALUES } } }),
    inFlight: () => [],
    lastRun: () => null,
  };
}

/** 直接经路由 handler 取载荷（不经 boot：本用例要钉的是**判定**，不是装配）。 */
async function routePayload(runtime) {
  const route = mods.statusRoute.makeStatusRoute({ get: () => undefined }, runtime, 'dsh-plugin-workbuddy', {}, null);
  const res = {
    statusCode: 0, headers: {}, body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b) { this.body = b ?? ''; },
  };
  await route.handler({ method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:7777' } }, res);
  return JSON.parse(res.body);
}

test('模型目录三态：路由面与工具面对同一探测实况给出**逐字相同**的出处（两出口同源）', { skip: SKIP }, async () => {
  const CASES = [
    { label: '在途', probe: null, args: { fn: () => {}, ctx: {}, config: {} }, want: 'pending:detection-in-flight' },
    { label: '未排上', probe: null, args: null, want: 'pending:detection-not-started' },
    // 负控：探测确实给了"没有桌面端"的结论 ⇒ `unavailable:catalog-not-resolved` 这个措辞必须**活着**。
    // ★ 2026-10-02：旧口径是 `unavailable:cli-not-resolved`（"CLI 路径没解析出来"）。
    //   探测源换成桌面产品配置缓存后，目录读取器不再有"解析路径"这一步，归因随之改成
    //   `catalog-not-resolved` —— 三态的**结构**（pending:* / unavailable:*）没变。
    {
      label: '已结论且无目录',
      probe: { installed: false, reason: 'not_found', resolvedPath: null, evidence: [{ kind: 'desktop-cache', value: 'x', found: false }], at: 0, method: 'desktop-probe' },
      args: { fn: () => {}, ctx: {}, config: {} },
      want: 'unavailable:catalog-not-resolved',
    },
  ];
  await withEnv({
    ACC_PRODUCT_CONFIG: undefined, ACC_PRODUCT_CONFIG_V2: undefined, ACC_PRODUCT_CONFIG_V3: undefined,
    ACC_PRODUCT_CONFIG_PATH: undefined,
    // ★ 2026-10-02：家目录隔离改由 `boot()` 的 `desktopHome` 承担（boot 把 WORKBUDDY_HOME/HOME/
    //   USERPROFILE 一起指走），外层 withEnv 设 HOME/USERPROFILE 已盖不住它。直调路由/工具面这两条
    //   不经 boot ⇒ 仍要在这里把 homedir() 指走，否则"取不到目录"这件事取决于本机装没装 WorkBuddy。
    USERPROFILE: NO_DESKTOP_HOME, HOME: NO_DESKTOP_HOME, WORKBUDDY_HOME: NO_DESKTOP_HOME,
  }, async () => {
    for (const c of CASES) {
      const runtime = statusRuntime(c);
      const viaRoute = await routePayload(runtime);
      const viaTool = await mods.statusTool.makeStatusTool(runtime, () => ({}), {}, null)
        .execute({}, { signal: new AbortController().signal });
      assert.equal(viaRoute.modelsSource, c.want, `${c.label} · 路由面`);
      assert.equal(viaTool.modelsSource, c.want, `${c.label} · 工具面（与 UI 面不得说两种话）`);
      assert.deepEqual(viaRoute.models, [], `${c.label} · 路由面空清单`);
      assert.deepEqual(viaTool.models, [], `${c.label} · 工具面空清单`);
    }
  });
});


// ═══════════════ T05 增量 · resume 三态（功能③：继续会话 / 新开会话） ═══════════════

/** 合法会话 ID（`stream-json.SESSION_ID_RE`：首字符字母数字，其余 `[A-Za-z0-9_:-]`）。 */
const RECORDED_SID = 'sess-recorded-1';
/** **非法**会话 ID（含空格 ⇒ 真机会被 argv 拒绝，且会产生 flag 注入风险）。 */
const BOGUS_SID = 'bad id;rm -rf';

/**
 * 测试专用缝：把一批会话记录写进 settings 解析值（真机上该表由 session/map 落盘维护）。
 * 走**真实的** `settings.update`（用户层合并 + schema 校验）⇒ 与生产路径同形，不直接改内部状态。
 * @param {ReturnType<typeof boot>} host
 * @param {Record<string, object>} records
 */
async function seedSessions(host, records) {
  await host.settingsService.update(host.state.settingsArgs?.ns ?? 'dsh-plugin-workbuddy', { sessions: records });
}

/** 直调路由 handler 的假 req/res（形态与 boot().statusPayload 一致，供"省略 sessions"兼容断言用）。 */
async function callRoute(route, { method = 'GET', remoteAddress = '127.0.0.1', host = '127.0.0.1:7777' } = {}) {
  const res = {
    statusCode: 0, headers: {}, body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b) { this.body = b ?? ''; },
  };
  const req = { method };
  if (remoteAddress !== null) req.socket = { remoteAddress };
  if (host !== null) req.headers = { host };
  await route.handler(req, res);
  return { statusCode: res.statusCode, headers: res.headers, json: res.body === '' ? null : JSON.parse(res.body) };
}

// ★ 2026-10-02 删除：CLI 传输已整体删除。scratch 目录净化那条逻辑（session_key 拼进 cwd）
test('resume ②：resume:true 但该 key 无记录 ⇒ 抛错（点名 resume 与 session_key），零 spawn', { skip: SKIP }, async () => {
  const host = boot({ enabled: true });
  await waitFor(() => host.state.registration.size === 3);
  const runDef = host.state.registration.get('workbuddy_run');
  // 反向控制：同一次执行里，先证明"同一个 key 在省略 resume 时是可用的新会话"——否则上句是"永远抛错"
  const exec = { signal: new AbortController().signal };
  const fresh = await runDef.execute({ prompt: 'auto ok', session_key: 'k-empty' }, exec);
  assert.equal(fresh.resumed, false, '无记录 + 省略 resume ⇒ 新会话（不是报错）');
  // ★ 2026-10-02：网关路没有进程句柄可 `_resolve`（CLI 线已删）；作业由 dispatch 自己收敛。
  await host.jobs.get(fresh.job_id).hooks.done;

  const jobsBefore = host.jobs.store.size;
  await assert.rejects(
    () => runDef.execute({ prompt: 'must continue', session_key: 'k-empty', resume: true }, exec),
    (err) => {
      assert.match(err.message, /resume/, '错误必须点名 resume（否则调用方不知道是哪个意图失败）');
      assert.match(err.message, /k-empty/, '错误必须点名 session_key');
      return true;
    },
  );
  // ★ 旧口径是"零 spawn"；CLI 线删除后"没发出去"的机器证据是"没建作业"。
  //   （外层"零触达进程出口"这条断言已随之删除：网关路的 `ensure` 会经假 subprocess 做实例枚举，
  //   上一句那个**成功**的下发已经合法走过一次进程出口，用它当反证会恒假。）
  assert.equal(host.jobs.store.size, jobsBefore, 'resume:true 无记录 ⇒ 不得建作业（旧行为是静默开新会话）');
});

test('resume ③：resume:true 且未给 session_key ⇒ 抛错（新 key 无可续接），零 spawn', { skip: SKIP }, async () => {
  const host = boot({ enabled: true });
  await waitFor(() => host.state.registration.size === 3);
  const runDef = host.state.registration.get('workbuddy_run');
  await assert.rejects(
    () => runDef.execute({ prompt: 'continue what?', resume: true }, { signal: new AbortController().signal }),
    (err) => {
      assert.match(err.message, /resume/);
      // ★ 归因必须是"缺 session_key"，而不是（顺序变了之后的）"该 key 无记录"——两者都在 resume:true 下抛错，
      //   只有点名 requires session_key 才能区分（否则这个用例对"漏判 hasKey"完全无判别力）。
      assert.match(err.message, /requires session_key/);
      return true;
    },
  );
  assert.equal(host.state.spawnCalls.length, 0);
});

//   可二次下发（禁CLI禁网关）：有记住 + 省略 resume ⇒ 仍 INSERT 一行 once 建新可见对话
//   （resumed:false，真下发，不走网关）。成功 adopt 覆盖新 id，失败 forget。
//   每轮走点火 INSERT once。
test('resume ⑤：有记住 ⇒ 仍可二次下发（新对话 INSERT once、不走网关，真实 execute 载荷）', { skip: SKIP }, async () => {
  const host = boot({ enabled: true });
  await waitFor(() => host.state.registration.size === 3);
  const runDef = host.state.registration.get('workbuddy_run');
  const exec = { signal: new AbortController().signal };
  await seedSessions(host, { 'k-r': { cliSessionId: RECORDED_SID, lastUsedAt: 1 } });

  // ★ 有记住 + 省略 resume ⇒ 仍新开（可二次下发，再 INSERT 一行 once）。
  const second = await runDef.execute({ prompt: 'turn two', session_key: 'k-r' }, exec);
  assert.equal(second.session_key, 'k-r');
  assert.equal(second.resumed, false, '★ 可二次下发 ⇒ 每轮新对话（resumed:false）');
  assert.equal(second.resumed_session_id, '', '★ 新对话下发时 id 尚未确认 ⇒ 空');
  assert.match(second.argv_preview, /transport=automation/, '★ argv_preview 走 automation 主路');
  assert.doesNotMatch(second.argv_preview, /reused/, '★ 不再有 reused 标记');
  assert.deepEqual(second.not_sent, [], '★ 真下发 ⇒ not_sent 为空');
  const secondText = runDef.output.render({ prompt: 'p' }, second)[0].text;
  assert.match(secondText, /new session/, '★ 每轮新对话必须渲染 new session');
  await host.jobs.get(second.job_id).hooks.done;
  // ★ 第二轮 lastRun 口径：走 automation，不再是 already_remembered_no_dispatch/reused-not-dispatched。
  {
    const payload = await host.statusPayload();
    const last = payload.json.lastRun;
    assert.equal(last?.transport, 'automation', '★ 第二轮走 automation');
    assert.notEqual(last?.reasonCode, 'already_remembered_no_dispatch', '★ 不再以 already_remembered_no_dispatch 收尾');
    assert.notEqual(last?.sessionOrigin, 'reused-not-dispatched', '★ 不再记 reused-not-dispatched');
    assert.equal(last?.resumed, false);
    assert.equal(last?.sessionKey, 'k-r');
  }

  // ★ resume:false 同样新开（语义与自动一致）。
  const forced = await runDef.execute({ prompt: 'fresh-forced', session_key: 'k-r', resume: false }, exec);
  assert.equal(forced.resumed, false, '★ resume:false 同样新对话');
  assert.equal(forced.resumed_session_id, '');
  await host.jobs.get(forced.job_id).hooks.done;

  const fresh = await runDef.execute({ prompt: 'fresh', session_key: 'k-new' }, exec);
  const freshText = runDef.output.render({ prompt: 'p' }, fresh)[0].text;
  assert.match(freshText, /new session/, '新会话载荷必须渲染 new session');
  assert.doesNotMatch(freshText, new RegExp(RECORDED_SID));
});

// ═══════════════ T05 增量 · 会话摘要（sessionSummary / sessions 载荷） ═══════════════

test('sessionSummary：合法 id ⇒ resumable:true；非法/空 id ⇒ 恒 false；空 key 丢弃', { skip: SKIP }, () => {
  const { sessionSummary } = mods.sessionMap;
  const rows = sessionSummary({
    list: () => [
      { key: 'k-valid', cliSessionId: RECORDED_SID, lastUsedAt: 40, outputBytes: 7 },
      { key: 'k-bogus', cliSessionId: BOGUS_SID, lastUsedAt: 30 },
      { key: 'k-empty-id', cliSessionId: '', lastUsedAt: 20 },
      { key: 'k-null-id', cliSessionId: null, lastUsedAt: 10 },
      { key: '', cliSessionId: RECORDED_SID, lastUsedAt: 50 }, // 空 key ⇒ 无法定位会话 ⇒ 丢弃
    ],
  });
  assert.deepEqual(rows.map((r) => r.sessionKey), ['k-valid', 'k-bogus', 'k-empty-id', 'k-null-id']);
  assert.equal(rows[0].resumable, true, '合法 id ⇒ 可续接');
  assert.equal(rows[0].cliSessionId, RECORDED_SID);
  assert.equal(rows[0].outputBytes, 7);
  // ★ 负控制：非法 id 在任何情况下都不得被报成可续接（否则 UI 会诱导调用方下发 resume:true 然后失败）
  assert.equal(rows.some((r) => r.sessionKey !== 'k-valid' && r.resumable === true), false, '非法/空 id 必须为 false');
  assert.equal(rows.filter((r) => r.resumable === true).length, 1);
});

test('sessionSummary：按 lastUsedAt 倒序（与 UI"最近使用"排序一致）', { skip: SKIP }, () => {
  const { sessionSummary } = mods.sessionMap;
  const rows = sessionSummary({
    list: () => [
      { key: 'older', cliSessionId: 's-1', lastUsedAt: 10 },
      { key: 'newest', cliSessionId: 's-2', lastUsedAt: 300 },
      { key: 'middle', cliSessionId: 's-3', lastUsedAt: 20 },
      { key: 'no-timestamp', cliSessionId: 's-4', lastUsedAt: undefined },
    ],
  });
  assert.deepEqual(rows.map((r) => r.sessionKey), ['newest', 'middle', 'older', 'no-timestamp']);
  assert.deepEqual(rows.map((r) => r.lastUsedAt), [300, 20, 10, 0], '缺失/非法时间戳 ⇒ 0（不伪造"现在"）');
});

test('sessionSummary：默认 20 条封顶（保留最新 20 条，最旧被淘汰）', { skip: SKIP }, () => {
  const { sessionSummary, SESSION_SUMMARY_LIMIT } = mods.sessionMap;
  assert.equal(SESSION_SUMMARY_LIMIT, 20, '导出常量即契约值');
  const many = Array.from({ length: 25 }, (_, i) => ({ key: `k-${i}`, cliSessionId: `s-${i}`, lastUsedAt: i }));
  const rows = sessionSummary({ list: () => many });
  assert.equal(rows.length, 20, `默认必须封顶在 ${SESSION_SUMMARY_LIMIT} 条（否则状态载荷随会话数无界增长）`);
  assert.equal(rows[0].sessionKey, 'k-24', '保留的是最新的一条');
  assert.equal(rows.at(-1).sessionKey, 'k-5', '第 21 新的一条正好在界内');
  assert.equal(rows.some((r) => r.sessionKey === 'k-4'), false, '更旧的必须被淘汰');
  // 显式 limit 生效（0 ⇒ 空；不传 ⇒ 默认）
  assert.deepEqual(sessionSummary({ list: () => many }, 0), []);
  assert.equal(sessionSummary({ list: () => many }, 3).length, 3);
});

test('sessionSummary：list() 抛错 / sessions 为 null / undefined / 无 list ⇒ []（不拖崩状态载荷）', { skip: SKIP }, () => {
  const { sessionSummary } = mods.sessionMap;
  assert.deepEqual(sessionSummary({ list() { throw new Error('__list_broken__'); } }), [], '读会话映射失败 ⇒ 空表，不把整个状态查询带崩');
  assert.deepEqual(sessionSummary(null), []);
  assert.deepEqual(sessionSummary(undefined), []);
  assert.deepEqual(sessionSummary({}), []);
  // 非数组返回（坏实现）同样收敛为 []
  assert.deepEqual(sessionSummary({ list: () => 'not-an-array' }), []);
});

// ═══════════════ T05 增量 · 模型清单 / 会话在两条面上的可见性 ═══════════════

// ★ 2026-10-02 删除：内联目录 fixture（`CATALOG_FIXTURE`）随「workbuddy_status 模型字段」一起删除 ——
//   那条用例的"目录清单 ⊇ CLI 支持子集 ≠ CLI 自述快照"三份并列判据依赖已删除的 CLI 快照。
//   桌面产品目录夹具改由文件头的 `DESKTOP_CATALOG_FIXTURE` 提供（boot() 的 `catalog` 参数用它）。

// ★ 2026-10-02 删除：`failNextSpawn` 是 spawn 出口的注入面，网关路不再有"启动进程"这一步
test('workbuddy_status 会话字段：sessionSummary 映射（session_key/cli_session_id/resumable/last_used_at）+ 倒序 + 非法 id 恒不可续接', { skip: SKIP }, async () => {
  const host = boot({ enabled: true });
  await waitFor(() => host.state.registration.size === 3);
  await seedSessions(host, {
    'k-valid': { cliSessionId: RECORDED_SID, lastUsedAt: 2000, outputBytes: 12 },
    'k-bogus': { cliSessionId: BOGUS_SID, lastUsedAt: 1000 },
    'k-newest': { cliSessionId: 'sess-newest', lastUsedAt: 3000 },
  });
  const statusDef = host.state.registration.get('workbuddy_status');
  const out = await statusDef.execute({}, { signal: new AbortController().signal });

  assert.deepEqual(out.sessions.map((s) => s.session_key), ['k-newest', 'k-valid', 'k-bogus'], '按 lastUsedAt 倒序');
  assert.deepEqual(Object.keys(out.sessions[0]).sort(), ['cli_session_id', 'last_used_at', 'resumable', 'session_key'], '工具面字段名（snake_case）是契约');
  assert.equal(out.sessions[0].resumable, true);
  assert.equal(out.sessions[1].cli_session_id, RECORDED_SID);
  assert.equal(out.sessions[1].last_used_at, 2000);
  const bogus = out.sessions.find((s) => s.session_key === 'k-bogus');
  assert.equal(bogus.cli_session_id, BOGUS_SID, '非法 id 如实回传（不隐藏记录）');
  assert.equal(bogus.resumable, false, '★ 非法 id 必须报 false —— 否则调用方会照它下发 resume:true 然后失败');
});

//   （连"启动失败⇒DEGRADED / 任务失败≠环境故障"这组判据的触发器也没有了）。
test('向后兼容：makeStatusRoute / makeRoutes 省略 sessions 参数 ⇒ 200 + sessions: []（不崩）；传入时如实回传', { skip: SKIP }, async () => {
  const runtime = {
    currentConfig: () => ({ enabled: false, model: '', effort: '', launch: { effortValues: {} } }),
    detected: () => ({ installed: false, reason: 'not_found', resolvedPath: '', method: 'no-exec', at: 0, evidence: [] }),
    registry: () => 'UNKNOWN',
    inFlight: () => [],
    lastRun: () => null,
  };
  const settings = { get: () => ({ enabled: false, model: '', effort: '', launch: { effortValues: {} } }) };
  const withSessions = { list: () => [{ key: 'k-provided', cliSessionId: RECORDED_SID, lastUsedAt: 9 }] };

  // ① makeStatusRoute 传满 4 个旧参数（sessions 省略）—— 旧调用方不得因为新参数而崩
  const omitted = await callRoute(mods.statusRoute.makeStatusRoute(settings, runtime, 'dsh-plugin-workbuddy', {}));
  assert.equal(omitted.statusCode, 200);
  assert.deepEqual(omitted.json.sessions, [], '省略 sessions ⇒ 空表（不是 undefined/崩溃）');

  // ② 提供 sessions（第 5 参数）⇒ 如实回传
  const provided = await callRoute(mods.statusRoute.makeStatusRoute(settings, runtime, 'dsh-plugin-workbuddy', {}, withSessions));
  assert.equal(provided.statusCode, 200);
  assert.deepEqual(provided.json.sessions.map((s) => s.sessionKey), ['k-provided']);
  assert.equal(provided.json.sessions[0].resumable, true);

  // ③ makeRoutes 传满 3 个旧参数（sessions 省略）
  // ★ 2026-09-27：曾短暂是 2 个路由（加了**凭据**路由），同日**已随凭据设施一起删除**。
  //   凭据路由删除的理由见 routes/index.js 与 check-no-credential-echo.mjs 的 E3c 注释。
  // ★ 2026-09-28：回到 2 个，但第 2 个是**只读诊断**端点——不回显任何凭据，
  //   加它是因为下发链路此前零可观测性（失败连日志都没有）。见下方"不回显凭据"专项断言。
  const routes = mods.routes.makeRoutes(settings, runtime, 'dsh-plugin-workbuddy');
  assert.equal(routes.length, 2);
  assert.equal(routes[0].path, ROUTE_STATUS, '★ 状态路由仍在首位（UI 依赖它的路径）');
  assert.equal(routes[1].path, ROUTE_DIAGNOSTICS, '★ 第 2 个是只读诊断路由');
  const routedOmitted = await callRoute(routes[0]);
  assert.equal(routedOmitted.statusCode, 200);
  assert.deepEqual(routedOmitted.json.sessions, [], 'makeRoutes 省略 sessions ⇒ 空表');

  // ④ makeRoutes 提供 sessions（第 4 参数）⇒ 穿透到状态路由
  const routed = await callRoute(mods.routes.makeRoutes(settings, runtime, 'dsh-plugin-workbuddy', withSessions)[0]);
  assert.deepEqual(routed.json.sessions.map((s) => s.sessionKey), ['k-provided'], 'makeRoutes 必须把 sessions 穿透给状态路由');
});

test('诊断端点：只读 + loopback-only + **绝不回显凭据**（2026-09-28 取代"只有 1 个路由"这条不变量）', { skip: SKIP }, async () => {
  // ★ 真正的红线从来不是"路由只有一个"，而是 **E3c：不得回显凭据**
  //   （2026-09-27 删凭据路由的理由）。所以这里断言的正是 E3c 本身：
  //   诊断端点可以把候选数/端点/picked/成因全说出来，但**不能说出网关口令**。
  //   载荷里只允许出现 `configuredToken: boolean` 这种**存在性**，不允许出现值。
  const SECRET = 'S3CRET-GATEWAY-PASSWORD-43-CHARACTERS-XXXXXX';
  const dispatch = { inspect: async () => ({
    candidates: 3, hostManaged: 2, resolved: 2,
    picked: { pid: 17216, url: 'http://127.0.0.1:59168' },
    unavailable: null, autoToken: true, autoTokenReason: null, configuredToken: true,
    // ★ 就算 inspect 内部将来不小心带出了口令，这条断言也必须拦住它。
    leakedToken: SECRET,
  }) };
  // ★ 2026-10-10：`currentConfig` 必须回 `enabled:true` —— 诊断路由自此受插件 ① 硬闸
  //   门控（关着时如实回 `plugin-disabled`，不做任何发现/取口令/探活）。给 `{}` 会
  //   撞上新闸门拿到 `{available:false}`，测不到下面的 E3c 载荷断言。
  const route = mods.routes.makeRoutes({}, { currentConfig: () => ({ enabled: true }) }, 'ns', null, null, dispatch)[1];
  assert.equal(route.path, ROUTE_DIAGNOSTICS);

  const seen = [];
  const res = {
    set statusCode(v) { seen.push(['statusCode', v]); },
    setHeader() {}, end(s) { seen.push(['end', s]); },
  };
  await route.handler({ method: 'GET', query: {}, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' } }, res);
  const body = seen.find(([k]) => k === 'end')?.[1] ?? '';
  assert.equal(seen.find(([k]) => k === 'statusCode')?.[1], 200);
  assert.doesNotMatch(body, new RegExp(SECRET.slice(0, 20)), '★★ 诊断载荷里绝不许出现凭据原文');
  assert.equal(JSON.parse(body).configuredToken, true, '只允许回传"有没有配"，不回传值');

  // 非 loopback 一律 403（与状态路由同一道栅栏）
  const denied = [];
  await route.handler({ method: 'GET', query: {}, socket: { remoteAddress: '10.0.0.5' }, headers: { host: '127.0.0.1:3080' } },
    { set statusCode(v) { denied.push(v); }, setHeader() {}, end() {} });
  assert.equal(denied[0], 403, '★ 非 loopback 必须 403');
});

test('下发链路的第 0 站：`run()` 的结果面必须带 `instance`（★ 2026-09-30 新增）', { skip: SKIP }, async () => {
  const { createDispatcher } = await import('../src/host/gateway/dispatch.js');
  // ★ 刻意**不传** `run`：这才是"装配被裁剪、连进程枚举都发不出去"的那种现场，
  //   ensure 必须报 `no_usable_sidecar` 而不是"桌面端探测失败"——两者的处置完全不同。
  //   （传一个会抛的 `run` 会被判成 `desktop_probe_failed`，那是另一条已单测过的路。）
  const d = createDispatcher({
    gatewayToken: () => '',
    boundSessionId: () => '',
    sessionMode: () => '', workspace: () => '', createNewConversation: () => false,
    autoStartDesktop: () => false,
    instanceTimeoutMs: () => 1000,
    // ★ 2026-10-10：注入假 broker 探针 + 不存在的端点文件。默认判据读
    //   `os.homedir()/.workbuddy/…`（WORKBUDDY_HOME 守卫盖不住 homedir）⇒ 桌面端
    //   正在运行的机器上会连真 broker 并挂死。注入后与机器状态无关。
    brokerProbe: async () => ({ running: false, error: null }),
    endpointFile: 'C:\\definitely-not-here\\endpoint.json',
  });
  const r = await d.run({ prompt: 'hello', cwd: 'C:\\x' });
  assert.equal(r.ok, false);
  // ★ 失败在实例这一步 ⇒ `instance` 必须**在场**且自带处置动作，而不是让调用方去猜。
  assert.notEqual(r.instance, null, '★ 失败面必须带 instance');
  assert.equal(r.instance.code, 'no_usable_sidecar');
  assert.ok(r.instance.hint.length > 30);
  // `run()` 压根没走到 prompt，所以不该有任何会话痕迹
  assert.equal(r.sessionId, null);
});

// ★ 2026-10-02 删除：本用例钉的是「模型清单必须内联在 model 参数描述里」这件事。
//   2026-10-01 起清单不再硬编码（`launch/cli-models.js` 已随 CLI 线删除），参数描述改为
//   指向 `workbuddy_status` 的实时回传（桌面产品目录是候选的唯一数据源）。

// ★ 2026-10-02 删除：AbortError 来自 spawn 的 "aborted before spawn"，网关路的取消走 AbortController。
//
// ── 以下 13 条同批删除：CLI 传输、`launch/argv.js`、`launch/cli-models.js`、`cordis.patch.yml` 的
//    launch 旗标表与 `workbuddy_status` 的 cliModels/cliSupportedModels 字段都已整体删除。
//    逐条说明为什么删（测试名已按原文件顺序）：
//
// ★ 删除 `workbuddy_status：reprobe 参数为只读复探；输出含三态/证据/在途`：
//   断言 `probe.method === 'no-exec'` —— 桌面端形状下是 `desktop-cache`。复探只读、三态、证据、
//   在途表这些判据仍由「判据① + ⑤」与 C 组几条覆盖。
// ★ 删除 `T04 判据③（D-3）`：证据形态是 CLI 把 400 只写 stderr 而退出码为 0，`flagVerdict=rejected`
//   与逐 flag 归因（点名 `--model`）都建立在 CLI 输出上。网关路无 CLI、无 flagVerdict。
// ★ 删除 `T04：显式 nodePath 不是文件`：`nodePath` 配置键与"解析 node 运行时"整段逻辑已随 CLI 线删除。
// ★ 删除 `T04 判据④`：`resumeFlag` 与"会话 id 从 CLI stdout 的 init 帧抽出来"这两件事都没有了
//   （网关路的 sessionId 来自 ACP 回执）。会话续接语义改由「resume ② / resume ⑤」覆盖。
// ★ 删除 `resume ①`：判据是 argv 里的 `--resume <已记账 id>` 与 CLI 线格式顺序。网关路没有 argv；
//   "确实续接 vs 确实另开"的对外可见性改由「resume ⑤」覆盖（真实 execute 载荷）。
// ★ 删除 `resume ④`：新会话的 id 来自本次 CLI stdout 的 init 帧，覆盖记账那步在网关路不存在
//   （网关的 `session/load` 与 `session/new` 都由 dispatch 自己记账）。
// ★ 删除 `workbuddy_status 模型字段`：断言 `cliSupportedModels` / `cliModels` / `mods.cliModels.*` ——
//   "三份模型清单并列"这个产品判据随 CLI 线一起作废。目录清单本身由「模型目录读取」与
//   「模型目录三态」两条覆盖。
// ★ 删除 `GET status 路由载荷`：状态路由载荷里的 `cliModels{ids,version}` 字段已删除。sessions
//   （同源可续接视图）改由「workbuddy_status 会话字段」与「向后兼容」两条覆盖。
// ★ 删除 `下发健康：not_sent`：`not_sent` 的告知行不再过 `redactText`。网关路上"没下发"的唯一一项
//   是 effort，它按原样回报（脱敏会把这个唯一信号变成不可读）。
// ★ 删除 `失败收口①`：D-3 判定行来自 CLI 把 400 只写 stderr 而退出码为 0。网关路的终态行是
//   `gateway-run.js` 的 `[ok]` / `[failed]` 两分支，与 verdict.js 的失败码白名单无关。
// ★ 删除 `失败收口③`：失败推送读的是 spawn 收口的 `stderrExcerpt` / `flagVerdict` 字段。
// ★ 删除 `终态 × 判定行`：失败码白名单（FAILURE_CODES）与 `[workbuddy]` 判定行都随 CLI 收口删除；
//   网关路的终态由 ACP 回执的 ok/reason 决定。
// ★ 删除 `增量⑥ fix#1` 与 `fix#2`：stdio 落盘（spill）是进程收集器的机制，CLI 路整体删除后无溢出落盘。
// ★ 删除 `WB-1/WB-2 端到端`：`spillPath` 字段、init 帧、落盘头部回读 —— 全是 CLI 线独有的字段。

test('availability 文案：可用分支追加当前 model/effort + 逐次覆盖指引；OFF 分支指引去设置里打开；无 currentConfig 的 stub 不得抛', { skip: SKIP }, async () => {
  const sectionKey = `${mods.apply.name}:availability`;
  const readSection = (host) => {
    const section = host.state.sections.get(sectionKey);
    assert.ok(section, '可用性 section 必须注册（§3.4.1 ⑥）');
    assert.equal(section.order, 520, 'order 520 是注入位次契约');
    const text = section.text();
    assert.equal(typeof text, 'string');
    return text;
  };

  // ① 配置里有值 ⇒ 文案里如实出现这两个值
  const on = boot({ enabled: true, model: 'auto', effort: 'high' });
  // ★ 必须等探测出结论再读 section：工具在探测在途期间就乐观注册了，而 `availabilityText` 的
  //   主句分支由 `runtime.detected()` 决定（null ⇒ 走"还在确定"那句）。只等 registration 会读早。
  await waitFor(async () => (await on.statusPayload()).json.probe !== null);
  const onText = readSection(on);
  assert.match(onText, /WorkBuddy delegation is available: use workbuddy_run/, '既有句子必须逐字保留（本次只允许追加）');
  assert.match(onText, /model "auto"/);
  assert.match(onText, /effort "high"/);
  // ★ 计划任务主路下 model / effort 都有承载（分别进 model_id / reasoning_effort，随行写库）。
  assert.match(onText, /workbuddy_run accepts model \/ effort per run/, '必须告诉模型可以逐次覆盖（model + effort 都有口）');
  assert.match(onText, /workbuddy_status/, '必须告诉模型可用 id 从哪里查');
  // ★ 2026-10-02 改判：主理人裁决「子智能体与智能团队二选一，选团队」，
  //   且传输面已钉死 gateway。旧断言点名的是**子智能体**那条面（`subagent tool` +
  //   `provider workbuddy`），它描述的路径已不是推荐路径；旧断言还说"automation 下
  //   session_key 不带记性"，而真机实测同一 session_key 两次下发都**续用了同一条对话** ——
  //   照旧断言写，等于把两句**反的**话钉进契约。
  assert.match(onText, /spawn_teammate/, '必须点名智能团队这条面（成员名在列表里可见，这是"一眼看出是 WorkBuddy"的落点）');
  assert.match(onText, /name "workbuddy"/, '必须给出可直接用的成员名（dsh 硬校验 lower-kebab-case，WorkBuddy 会被拒）');
  assert.match(onText, /WorkBuddy · /, '★ 描述必须以产品名打头（成员行渲染成 "[x] WorkBuddy — …" 会把产品名挤到中间）');
  assert.match(
    onText,
    /On the current transport \(automation\) every round opens a new WorkBuddy conversation/,
    '★ 默认传输面是 automation，每轮都是新对话、session_key 只归组不带记性',
  );

  // ② 空配置 ⇒ 明确说"未设置 ⇒ 由桌面端用自身默认"（不得编造取值）
  const empty = boot({ enabled: true });
  await waitFor(async () => (await empty.statusPayload()).json.probe !== null);
  const emptyText = readSection(empty);
  // ★ 2026-10-02：主语从「the CLI」改成「the desktop」—— 下发只走桌面端网关，
  //   继续说"CLI 用自身默认"会让模型去找一个已经不存在的东西。
  assert.match(emptyText, /model not set \(the desktop uses its own default\)/);
  assert.match(emptyText, /effort not set \(the desktop uses its own default\)/);
  assert.doesNotMatch(emptyText, /model ""/, '空值不得被渲染成一个取值');

  // ③ OFF 分支：既有禁令保留 + 追加"去插件设置里打开"
  const off = boot({ enabled: false });
  await waitFor(() => off.state.sections.has(sectionKey));
  const offText = readSection(off);
  assert.match(offText, /do not attempt to delegate/, '既有句子必须逐字保留');
  assert.match(offText, /enable the plugin in its settings/);

  // ④ 防御：老 stub（**不含** currentConfig）直调 ⇒ 不抛，且不追加这段（老测试/老调用方兼容）
  const stub = {
    detected: () => ({ installed: true }),
    registry: () => mods.constants.REGISTRY_STATES.REGISTERED,
  };
  const stubText = mods.availability.availabilityText(stub);
  // ★ 2026-10-01 作废：旧断言 `Pass session_key to group related runs` 已删。
  //   理由：那句在默认传输面（automation）上是**假的** —— `automations` 表没有会话 id 列，
  //   调度器只按行新建，`session_key` 不携带任何对话记忆。
  //   现在由 `continuityHint(runtime)` 按**当前 transport** 分别给出两说，而读不到配置时
  //   一律不说（与 `overrideHint` 同一个"绝不猜"纪律）。
  assert.doesNotMatch(
    stubText,
    /On the current transport/,
    '读不到 transport 就不能断言会话连不连续（绝不猜），哪怕旧文案曾经无条件这么说',
  );
  assert.doesNotMatch(stubText, /Current defaults/, '读不到实时配置 ⇒ 不加这段（绝不猜）');
  // 其它分支同样不得因缺 currentConfig 而崩
  assert.equal(typeof mods.availability.availabilityText({ detected: () => ({ installed: true }), registry: () => mods.constants.REGISTRY_STATES.UNKNOWN }), 'string');
  assert.equal(typeof mods.availability.availabilityText({ detected: () => null, registry: () => mods.constants.REGISTRY_STATES.REGISTERED }), 'string');
  // 未安装分支：即便配置可读也不得混入"逐次覆盖"（不可用就别提怎么调）
  const notInstalled = mods.availability.availabilityText({
    detected: () => ({ installed: false }), registry: () => mods.constants.REGISTRY_STATES.NOT_INSTALLED,
    currentConfig: () => ({ model: 'auto', effort: 'high' }),
  });
  assert.doesNotMatch(notInstalled, /Current defaults/);

  // ★ 计划任务主路下 session_key **只归组、不带记性** ⇒ 每轮都是新对话，措辞必须如实。
  //   不按 transport 分支就是在其中一条路上撒谎，且是最难察觉的那种（结果都对，只是不连着）。
  const autoText = mods.availability.availabilityText({
    detected: () => ({ installed: true }),
    registry: () => mods.constants.REGISTRY_STATES.REGISTERED,
    currentConfig: () => ({ transport: 'automation', model: '', effort: '' }),
  });
  assert.match(autoText, /On the current transport \(automation\)/, 'automation 下每轮都是新对话');
  assert.match(autoText, /every round opens a new/, 'automation 下必须说每轮新会话');
  assert.doesNotMatch(autoText, /binds one WorkBuddy conversation/, 'automation 下不得说绑定一条对话');
  // 委派面在**每一条**传输面上都必须被点名（它是"这件事在不在列表里可见"的那一面）。
  // ★ 2026-10-02：由 `subagent tool` 改为智能团队 —— 主理人裁决二选一选团队，
  //   且团队成员名（`workbuddy`）是"一眼看出是 WorkBuddy"的唯一强可见度。
  assert.match(autoText, /spawn_teammate with name "workbuddy"/, '必须点名智能团队 + 可直接用的成员名');
});

test('模型面真实化：model 未设置 ⇒ 提示词点名"没人替你选 ⇒ 该你选"；已设置 ⇒ 不追加（负控）；清单不抄进提示词', { skip: SKIP }, async () => {
  const sectionKey = `${mods.apply.name}:availability`;
  const sectionText = (host) => host.state.sections.get(sectionKey).text();

  // 正控：设置里没钉模型 ⇒ 必须有个"人"被指出来做这个决定。GUI 那句「DSH 逐次决定」若没有这一行，
  //   就仍是一句没有机制兑现的标签（ISSUE §5-1 的原始缺陷）。
  const unset = boot({ enabled: true });
  await waitFor(async () => (await unset.statusPayload()).json.probe !== null);
  const unsetText = sectionText(unset);
  // ★ 2026-10-01 改判：措辞从"没人替你选"改成点名**后果** ——
  //   真机上省略模型会落到桌面端默认档（快速），"我没设"在界面上显示成了"我设成快速"。
  // ★ 计划任务主路 `awaitModelId` 改判：目录可读时 dsh 按倍率挑最便宜的（`cheapestModelId`），
  //   只有目录读不到才落到桌面端默认。"落到桌面端默认（快速）"已是过去式，断言跟到新行为。
  assert.match(unsetText, /Nobody has pinned a model for you then/, '★ 未固定 ⇒ 必须点名"该你选"');
  assert.match(unsetText, /dsh picks the cheapest catalog model/, '必须说清不选时由 dsh 按倍率选最便宜的，否则"不选"看起来是安全的');
  assert.match(unsetText, /judge its difficulty/, '必须把决定权指给下发的模型，并说清按什么判断');
  assert.match(unsetText, /effort/, '推理强度同一件事，必须一起说');
  assert.match(unsetText, /workbuddy_run's model parameter/, '★ 必须把决定者指向清单所在的参数（不是再抄一份清单）');
  // ★ 新行为的第二分支：目录读不到才落桌面端默认（`awaitModelId` 读不到 ⇒ null ⇒ 不下发）。
  assert.match(unsetText, /only when the catalog cannot be read/, '★ 第二分支要讲清：只有目录读不到才落桌面端默认（否则读起来像"总会挑一个"，而读不到时确实没人挑）');
  assert.doesNotMatch(unsetText, /leave it to the CLI backend/, '★ 旧措辞"由 CLI 自决"是假的：它其实落到了没人选过的默认档');

  // 负控：设置里已经钉住 ⇒ 这段解释当场变成假话，一个字都不许出现
  const fixed = boot({ enabled: true, model: 'auto' });
  await waitFor(async () => (await fixed.statusPayload()).json.probe !== null);
  assert.doesNotMatch(sectionText(fixed), /Nobody has (picked|pinned) a model/, '★ 已固定 ⇒ 不得再谈"该谁选"');
  assert.match(sectionText(fixed), /model "auto"/, '既有渲染不受影响');

  // 清单只有一份：本节每回合都求值 ⇒ 抄进提示词就是把同一笔 token 花两遍 + 造第二个真源。
  // ★ 2026-10-02：比对基准从已删除的 CLI 快照（`mods.cliModels.CLI_MODEL_IDS`）换成
  //   **桌面产品目录夹具**里的 id —— 那是现在唯一的候选数据源。
  assert.deepEqual(
    DESKTOP_CATALOG_FIXTURE.models.map((m) => m.id).filter((id) => unsetText.includes(id)),
    [],
    '★ 候选清单只准由 workbuddy_status 实时回传，不得抄进每回合求值的系统提示',
  );

  // 防御同 overrideHint：currentConfig 缺失 ⇒ 整段不追加，绝不抛
  const stub = {
    detected: () => ({ installed: true }),
    registry: () => mods.constants.REGISTRY_STATES.REGISTERED,
  };
  assert.doesNotMatch(mods.availability.availabilityText(stub), /Nobody has picked a model/, '读不到配置 ⇒ 不提"该谁选"');
});

// ────────────── PRD-v4 B1（三级开关之①：程序开关硬闸）+ 成本快照发布（A2 通道） ──────────────

test('B1：OFF ⇒ 探测从未启动；翻 ON ⇒ reconcile 补跑探测并注册（证据 = probe 从 null 变为落地）', { skip: SKIP }, async () => {
  const host = boot({ enabled: false });
  await new Promise((r) => setTimeout(r, 50));
  let payload = await host.statusPayload();
  assert.equal(payload.json.probe, null, 'OFF 期间探测从未启动（B1 硬闸）');
  assert.equal(host.state.registration.size, 0);

  // 用户拨开关：走真实 settings.update → volatile-update → reconcile 的同一条路径
  host.setEnabled(true);
  const registered = await waitFor(() => host.state.registration.size === 3);
  assert.ok(registered, '翻 ON 后 reconcile 必须补跑探测并注册（否则开关 ON 永远无效）');
  // ★ 必须等**探测出结论**：注册是乐观的（探测在途即注册），`probe !== null` 才是"补跑完成"的证据。
  const probed = await waitFor(async () => (await host.statusPayload()).json.probe !== null);
  assert.ok(probed, '补跑的探测必须在线性时间内出结论');
  payload = await host.statusPayload();
  assert.notEqual(payload.json.probe, null, '补跑的探测已落地');
  assert.equal(payload.json.probe.installed, true, 'boot() 落的桌面产品配置缓存夹具 ⇒ 探测结论"已装"');
  assert.equal(payload.json.probe.method, 'desktop-cache');
  assert.equal(payload.json.cost.available, true, '① 硬闸字段随注册态翻转');
});

test('B1 负控：OFF 期间 spawn 恒零；探测从未启动时"未知乐观注册"不会被 OFF 路径触发', { skip: SKIP }, async () => {
  const host = boot({ enabled: false });
  await new Promise((r) => setTimeout(r, 30));
  host.setEnabled(true); // 触发一次 reconcile（探测开始）
  const registered = await waitFor(() => host.state.registration.size === 3);
  assert.ok(registered);
  assert.equal(host.state.spawnCalls.length, 0, '仅注册不 spawn（执行面另有 A4 门）');
});
