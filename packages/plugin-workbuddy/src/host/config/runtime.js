/**
 * 插件端 SSOT（Single Source of Truth）—— 全部可变状态的唯一持有者（§3.4.1 之 ①，R2）。
 *
 * Implements: 02-design/DESIGN-v3.md §3.4.1 / §3.4.2（响应式配置读取）/ §4.4.3（在途作业记账）/
 *             §4.5（lastRun 承载）/ §8（两套正交状态 —— H-ORTHOGONAL）
 *
 * 来源（§26 抽包第一刀）：本文件自 `packages/plugin-workbuddy/src/host/config/runtime.js` **逐字搬入**，
 *   只动两处：① `target` 由写死的厂商值改成 `createRuntime({ target })` 注入（消费者 = 该插件的转发层）；
 *   ② 类型引用指向本包的 `./types.js`。原路径保留为**转发层**，不删（"移动 + 转发"是本包的准入纪律）。
 *
 * 硬约束（H-ORTHOGONAL 的结构性保证）：本文件**不认识 ctx.jobs / ctx.subprocess**——
 * ① 注册态的转移（setRegistry）与 ② Job 执行态（start/finish/forget）是两个独立字段集合，
 * 彼此的转移函数签名里没有对方的句柄 ⇒ "关开关不杀在途作业"是结构事实，而非约定。
 *
 * ★ 本文件不许出现厂商字面值（准入判据见 `../package.json`）：它承载的是"任何一家 CLI 都需要
 *   的那套记账"，一旦掺进 `'workbuddy'` 这类常量，下一个消费者就只能整份 copy —— 那正是抽包要消灭的东西。
 */
import { REGISTRY_STATES, RUN_STATES, PROBE_TARGET } from './constants.js';

/**
 * 本插件用的 runtime —— 在通用实现上**注入** `target`。
 *
 * ★ 2026-10-02 ★
 * 这层包装原先指向 `packages/plugin-cli-core`（那个包整体退役了），而通用的 `createRuntime`
 * 里**没有**厂商标识 —— 它按 U9 要求"不发明缺省 target"。少了这层注入，
 * 探测函数抛异常时兜底 `ProbeResult.target` 就是 `undefined`，载荷里少了"这是哪个 agent"。
 * 厂商字面值只能出现在**本包这一层**（下面这行），通用实现里不许有。
 *
 * @param {{ pluginId: string, config: unknown, ns: string, target?: string }} init
 */
export function createRuntime(init) {
  return createRuntimeBase({ ...init, target: init.target ?? PROBE_TARGET });
}

/**
 * 通用实现（不含任何厂商字面值）。
 *
 * @param {{ pluginId: string, config: unknown, ns: string, target: string }} init
 *   `target` = 探测异常兜底时写进 `ProbeResult.target` 的厂商标识。**无缺省值**（U9：不猜）。
 */
function createRuntimeBase({ pluginId, config, ns, target }) {
  /** @type {Set<(probe: import('./types.js').ProbeResult) => void>} */
  const listeners = new Set();
  /** @type {Map<string, {jobId: string, state: string, startedAt: number, exitCode?: number}>} */
  const runs = new Map();

  const state = {
    latestProbe: /** @type {import('./types.js').ProbeResult | null} */ (null),
    registry: /** @type {import('./types.js').RegistryState} */ (REGISTRY_STATES.UNKNOWN),
    source: /** @type {unknown | (() => any)} */ (config), // 响应式源：对象或函数（§3.4.2 H-REACTIVE）
    // 记录形状由消费者定义（workbuddy：`src/host/types/index.js` 的 `LastRunRecord`）⇒ core 只**承载**不解释，
    // 所以这里刻意是 unknown：把某一家的字段表写进 core 就是又一次"两份定义会漂移"。
    lastRun: /** @type {unknown | null} */ (null),
    lastProbeArgs: /** @type {null | { fn: Function, ctx: unknown, config: unknown }} */ (null),
    probeInFlight: /** @type {Promise<import('./types.js').ProbeResult> | null} */ (null),
    /** 工具注册失败的原始信息（★ C 组：撞名等注册期异常不再外抛，改由此字段承载 ⇒ 见 tools/index.js）。 */
    registrationError: /** @type {string | null} */ (null),
  };

  return {
    pluginId,
    ns,

    /**
     * 只读探测（U6）。永不抛：探测函数本身的异常也会收敛为 reason:'error' 的结果。
     * 并发去重：探测进行中重复调用 ⇒ 复用同一 Promise。
     */
    probe(fn, ctx, probeConfig = config) {
      if (state.probeInFlight !== null) return state.probeInFlight;
      state.lastProbeArgs = { fn, ctx, config: probeConfig };
      state.probeInFlight = (async () => {
        let result;
        try {
          result = await fn(ctx, probeConfig);
        } catch (err) {
          result = {
            target,
            installed: false,
            reason: 'error',
            resolvedPath: null,
            evidence: [{ kind: 'error', value: err instanceof Error ? err.message : String(err), found: false }],
            at: Date.now(),
            method: 'no-exec',
          };
        }
        state.latestProbe = result;
        // ★ 必须先清 in-flight 再通知：监听器（reconcile）可能因配置变更发起【复探】，
        //   若此刻仍视为 in-flight，该次复探会被去重直接吞掉 ⇒ 配置变更永不生效。
        state.probeInFlight = null;
        for (const cb of [...listeners]) {
          try {
            cb(result);
          } catch {
            /* 监听器自担其责；不得影响探测结果分发 */
          }
        }
        return result;
      })();
      return state.probeInFlight;
    },

    /** 重探（status 工具/用户手点"重新检测"用）：复用上次的探测函数与上下文。 */
    reprobe() {
      const args = state.lastProbeArgs;
      if (args === null) return Promise.resolve(null);
      return this.probe(args.fn, args.ctx, args.config);
    },

    /**
     * 等待**已在途**的那次探测出结论（★ 下发健康 C 组 —— 首轮竞态的执行侧出口）。
     *
     * 为什么不新起一次探测：`probe()` 自带在途去重，但"再叫一次"会因配置快照不同而留下
     *   `lastProbeArgs` 被改写的副作用；这里只做一件事 —— 已经排队的结论到手没有。
     * 无在途 ⇒ 立即返回 `null`（**不原地打转、不假装成功**）：调用方据此如实拒绝，
     *   而不是把"探测压根没跑过"说成"CLI 未安装"。
     * 有界性：探测本身是纯读（`resolveExecutable` / `statSync`，H-NO-EXEC-PROBE 由 CI ③ 静态把关），
     *   不含任何进程等待；`tools/status.js` 的 `reprobe` 早已用同一条 await 路径 ⇒ 不引入新的挂起面。
     *
     * @returns {Promise<import('./types.js').ProbeResult|null>}
     */
    async awaitDetection() {
      const inflight = state.probeInFlight;
      return inflight === null ? null : await inflight;
    },

    /**
     * 最近一次探测的入参 `{fn, ctx, config}`（未探测为 null）。
     * 用途：reconcile 侧判"生效配置的 cliPath 已变化 ⇒ 复探"（否则改路径后永远停在旧结论）。
     */
    probeArgs: () => state.lastProbeArgs,

    /** 最近一次探测结果（未探测完成为 null）。 */
    detected: () => state.latestProbe,
    /** 订阅探测完成事件；返回退订函数。 */
    onDetected(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    // ── ① 工具注册态（与 ② 正交） ──────────────────────────────
    registry: () => state.registry,
    setRegistry(next) {
      state.registry = next;
    },
    /**
     * 记录/清除"工具注册失败"的原始信息（★ 下发健康 C 组）。
     *
     * 为什么要有这个字段：`ctx.tools.register()` 重名即抛（实测 `dsh-tools:2538`）。旧写法把该异常
     *   **外抛**，而它只在"探测落地后由 onDetected 触发的那一次"里被 `runtime.probe` 的监听器 try/catch
     *   悄悄吞掉 —— 也就是说外抛从来没换来任何可观察性，只换来一条没人看的堆栈。C 组把注册提前到
     *   `apply()` 的同步回合后，同一句 throw 会**穿透 `ctx.effect`（实测 cordis `lib/index.js:1248-1261`
     *   的 `catch (reason) { … throw reason }`）打到 apply() 上 ⇒ 紧随其后的 ⑤ 状态路由 / ⑥ 提示词 section
     *   全部不再装配**：一个第三方插件撞走 `workbuddy_run` 这个名字，就能让整块状态卡片消失。
     *   （末句按 WorkBuddy 的实际工具名记录 —— 机制与厂商无关，任何重名同此。）
     * ⇒ 现在：回滚 + DEGRADED + 把原因**存下来**（经状态路由 / workbuddy_status / 系统提示 / GUI 卡片四处如实可见），
     *   不再外抛。成功注册时写 `null` 清除，避免留下一条已经不复在的旧故障。
     */
    setRegistrationError(message) {
      state.registrationError = typeof message === 'string' && message !== '' ? message : null;
    },
    registrationError: () => state.registrationError,

    // ── 配置（响应式：settings 的响应式源注入） ───────────────
    /** 原始源（对象或读取函数）—— §3.4.2 reconcile 的 read() 基础。 */
    current: () => state.source,
    setSource(source) {
      state.source = source;
    },
    /**
     * 解析后的最新配置（把"对象或函数"统一成对象）。
     *
     * ★ 0.1.7 变更：`.volatile()` 字段的 schema 输出**不是裸值，而是 `{ get() }` 包装器**
     *   （实测：schemastery 3.18.4 对 `z.string().default('').volatile()` 产出 `{get:fn}`，
     *   `JSON.stringify` 看到的是 `{}`；官方读法 `config.model.get()` 见
     *   `dsh-agent-default-model/lib/index.js:39-42`）。cordis 把 `Config['~standard'].validate()`
     *   的结果原样交给 apply（`cordis/lib/index.js:956-962`）⇒ 插件内的 `cfg.enabled` 会是对象。
     *   dsh-settings 自己那侧在 `describe()` 里先过 `plainConfig()`（`lib/types/schema.js:9-17`）解包，
     *   插件这条路没有 ⇒ **必须自己解**，否则开关恒假、模型恒空。
     *
     * 只解一层包装器，非包装值原样返回（普通字段与 0.1.5 行为不变）。
     *
     * @returns {Record<string, any>}
     */
    currentConfig() {
      const src = state.source;
      const raw = typeof src === 'function' ? src() : src;
      if (raw === null || typeof raw !== 'object') return raw;
      const out = {};
      for (const [key, value] of Object.entries(raw)) {
        out[key] =
          value !== null && typeof value === 'object' && typeof (/** @type {any} */ (value).get) === 'function'
            ? /** @type {any} */ (value).get()
            : value;
      }
      return out;
    },

    // ── ② Job 执行态（插件侧记账；不写入 ctx.jobs） ──────────────
    /**
     * 记账一条在途作业。调用时机（§3.4.3 P0-1b）：必须在 `ctx.jobs.start()` **返回之后**
     * （此刻 run 回调已被同步调用、handle 已就绪）。
     */
    start(jobId, handle) {
      runs.set(jobId, { jobId, state: RUN_STATES.RUNNING, startedAt: Date.now(), handle });
    },
    /** 作业收敛（成功/失败统一入口）：只记账，不做任何进程操作。 */
    finish(jobId, exitCode) {
      const rec = runs.get(jobId);
      if (rec !== undefined) {
        rec.exitCode = exitCode;
        rec.state = exitCode === 0 ? RUN_STATES.COMPLETED : RUN_STATES.FAILED;
      }
    },
    /** 从在途表移除（finish 之后调用）。 */
    forget(jobId) {
      runs.delete(jobId);
    },
    /** 在途作业数（§4.4.3：UI 显示"◐ 已关闭 · 仍有 N 个任务在运行"的数据源）。 */
    inFlightCount: () => runs.size,
    /** 在途作业明细（status 工具展示用；不含句柄）。 */
    inFlight() {
      return [...runs.values()].map((r) => ({ jobId: r.jobId, state: r.state, startedAt: r.startedAt }));
    },

    // ── 参数接受度记录（§4.5；写入方 = 发起的 run 收敛路径，判定逻辑属 T04） ──
    noteRun(record) {
      state.lastRun = record;
    },
    lastRun: () => state.lastRun,
  };
}
