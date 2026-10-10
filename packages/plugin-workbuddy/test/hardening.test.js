/**
 * 加固测试（复审报告的**检测器缺口**）—— 每个用例都必须能在被保护行为回退时变红。
 *
 * 背景：本仓库的 `package.json#scripts.test:host` **逐个列举**测试文件 ⇒ 不在清单里的文件永远不跑。
 * 本文件因此同时改了那一行（唯一被允许的清单变更）。
 *
 * 覆盖范围（与复审报告的目标编号一一对应）：
 *   目标① 未登记的厂商错误码：真实 `result` 帧 + `errors_info[].code` 不在码表时，落点必须是
 *         **已登记**的原因码（`task_error`）且证据引用帧内文本；不得静默 `ok`，也不得"就近"套用某个码族。
 *         （码表本身与 11102 的"故意不入表"另见 test/reason-codes.test.js；此处钉的是"帧 → 信号 → 分类"的接缝。）
 *   目标② 形变的 `errors_info[].details`（换行 / 超长 / 非字符串）：不抛、不字符串化、不冒充 stderr 面、
 *         不进散文面，且各自有长度上限。
 *   目标③ 未登记/缺失的 registry 态：文案**绝不**落 available 分支。
 *   目标④ status 工具面契约：`config.enabled` 声明与载荷**双缺席**；canonical 7 档含 `off`；
 *         档位表读不到 ⇒ "未确认"（unknown ≠ unsupported）；三份模型清单并列**不合并**。
 *   目标⑤ schema ↔ 载荷一致：用官方 `validateJsonSchemaValue` 做**真**校验（`defineTool` 只在
 *         参数面校验，输出值**从不**运行时校验 ⇒ 返回未声明键是**静默**契约破损）。
 *   目标⑥ 模型能力位三态：显式 `true`/`false` 原样，**键缺失 ⇒ `null`（未知）**，绝不谎报 `false`。
 *   目标⑦ 模型目录"读不到"的三态（§4-9）：探测在途 / 未排上 ⇒ `pending:*`，只有已出结论
 *         才允许 `unavailable:*`；缺省参数逐字沿用旧口径（既有读数不得被这次修复顺带改动）。
 *   目标⑧ cli-core 接缝（§26 抽包第一刀）：状态字母表必须是**同一个对象**（再导出，不是复制一份），
 *         兜底 `ProbeResult.target` 必须由本包的转发层注入 —— core 里既不许写死厂商名，
 *         也不许发明缺省值（U9）。"搬走了但没人引用"或"复制了但两份会漂"都在这条上变红。
 *
 * 依赖：**真实的** `@deepseek-ai/*`（经 `tools/dev/link-dsh-deps.mjs`）—— 缺依赖 ⇒ 整文件 `skip`。
 * 假宿主 `boot()` 与 `test/host.test.js` 同源**复制**（本文件不得反向依赖它的内部符号）。
 *
 * 约束：不启动任何进程、不读真实安装目录、不写任何 data root；全部输入自造（含 target⑥ 的内联目录）。
 *   ★ 本文件头注释里不得让 markdown 粗体收尾的 `*` 紧跟一个斜杠（那两位连起来就是块注释的终止符
 *     ⇒ 注释被提前闭合、后面的中文变成非法 token，整个文件 SyntaxError）。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// 目标⑧ 的被检对象：core 用**静态 import**（不走上面那个 try）—— 它零依赖，路径断了就该整文件报错，
// 而不是混进"缺 @deepseek-ai ⇒ 整文件 skip"那条合法的静默通道里被一起跳过。

const here = dirname(fileURLToPath(import.meta.url));
/** 探测用的"CLI 入口"：任意**存在**的文件即可（config 分支命中 ⇒ method=no-exec，不启动它）。 */
const CLI_FILE = join(here, '..', 'package.json');

/**
 * 一个**一定没有** `~/.workbuddy/cache/acc-product-config-v3.json` 的 home（★ 2026-10-01）。
 *
 * <p>目录读取器新增了"桌面端刷新缓存"这个优先源。断言「取不到目录时怎么说」的用例
 * 必须先把 homedir() 指走，否则结果取决于**本机装没装 WorkBuddy** ——
 * 装了必红、没装必绿，两边都是假信号。路径不需要真存在（只 statSync，不 mkdir）。
 */
const NO_DESKTOP_HOME = join(here, '.no-desktop-home-fixture');

// ═══════════════ 2026-10-02 探测换代（CLI → 桌面端）后的"家目录"隔离 ═══════════════
// 与 test/host.test.js 同款纪律。`probe/detect.js` 优先读 `WORKBUDDY_HOME`，
// `launch/model-catalog.js` 的 `desktopCachePath()` 读 `os.homedir()`（win32 = USERPROFILE）——
// 两个入口必须一起指走，否则"装没装桌面端"这件事由**本机状态**决定，本文件就成了假信号发生器。
const __wbHomes = [];

/** 桌面端产品配置缓存夹具：覆盖倍率三态（x0.00 / x0.05 / 无 credits 键）。 */
const DESKTOP_CATALOG_FIXTURE = {
  models: [
    { id: 'wb-free', name: 'WorkBuddy Free', credits: 'x0.00', supportsReasoning: false },
    { id: 'wb-pro', name: 'WorkBuddy Pro', credits: 'x0.05', supportsReasoning: true },
    { id: 'wb-unknown', name: 'WorkBuddy Unknown' },
  ],
};

function makeDesktopHome({ installed, catalog }) {
  const home = mkdtempSync(join(tmpdir(), 'wb-hardening-home-'));
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

let mods = null;
let importError = null;
try {
  mods = {
    apply: await import('../src/host/apply.js'),
    availability: await import('../src/host/prompts/availability.js'),
    constants: await import('../src/host/config/constants.js'),
    constantsShared: await import('../src/shared/constants.js'),
    dshTools: await import('@deepseek-ai/dsh-tools'),
    modelCatalog: await import('../src/host/launch/model-catalog.js'),
    reasonCodes: await import('../src/host/launch/reason-codes.js'),
    runtimeFwd: await import('../src/host/config/runtime.js'),
    statusRoute: await import('../src/host/routes/status/get.js'),
    streamJson: await import('../src/host/launch/stream-json.js'),
    verdict: await import('../src/host/launch/verdict.js'),
  };
} catch (err) {
  importError = err;
}
const SKIP = mods === null
  ? `缺 @deepseek-ai 依赖（${importError?.code ?? String(importError)}）—— 先跑 npm run link:dsh-deps`
  : false;

/** WorkBuddy 6 档（§4.2.1：无 off、无 ultracode）—— 与 cordis.patch.yml 同表。 */
const EFFORT_VALUES = Object.freeze({
  minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
});

const ROUTE_STATUS = '/plugin-workbuddy/status';

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
 * 假宿主：逐个照抄已实测的官方语义（与 test/host.test.js 同源复制）。
 * @param {{ enabled?: boolean, model?: string, effort?: string, cliPath?: string, resolvedCliPath?: string,
 *           nodePath?: string, cwdRoot?: string }} overrides
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
    settingsPlain: null,
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
  /** 0.1.7：loader 广播 volatile 更新（替代 0.1.5 的 onChange 钩子）。 */
  state.emitVolatileUpdate = () => {
    for (const listener of [...state.settingsListeners]) listener('loader/volatile-update');
  };

  const entry = {
    enabled: overrides.enabled ?? false,
    model: overrides.model ?? '',
    effort: overrides.effort ?? '',
    // ★★★ 传输面必须显式钉 `spawn`，与 test/host.test.js:150 同一条纪律（2026-10-01 补）★★★
    //   事故经过：本文件原先**没钉**，于是走 schema 默认 `automation`；而 :786 那条用例
    //   调的是**真实的 run 工具**（prompt 就叫 'ping'）⇒ 每跑一次 `npm run test:host`，
    //   就往**用户真机**的 `~/.workbuddy/workbuddy.db` 的 `automations` 表里插一行
    //   真·一次性计划任务（`next_run_at = now`、`cwds=[]`、`name='ping'`）。
    //   桌面端调度器随后到点就**真的建一条对话** —— 于是一下午冒出十几条 ping 对话，
    //   而本仓把这条泄漏当成"桌面端自己的心跳"，白查了两轮日志与进程。
    //
    //   ⇒ 本文件里的 run 工具用例测的是**契约**（argv_preview / schema / not_sent），
    //     不是自动化点火；钉 spawn 既符合意图，又切断真库写入。
    //     自动化路本身由 `test/subagent-execute.test.js` + `scripts/ignition-smoke.mjs` 覆盖。
    transport: overrides.transport ?? 'spawn',
    cliPath: overrides.cliPath ?? CLI_FILE,
    cwdRoot: overrides.cwdRoot ?? '',
    nodePath: overrides.nodePath ?? process.execPath,
    launch: { effortValues: { ...EFFORT_VALUES } },
  };
  // 0.1.7：schema 隐式发现（`entry.fiber.runtime.Config`）⇒ fake 直接取插件导出的 Config。
  state.settingsArgs = { ns: state.settingsNs, schema: mods.apply.Config };
  const plainOf = (v) =>
    JSON.parse(
      JSON.stringify(v, (_k, x) =>
        x !== null && typeof x === 'object' && typeof x.get === 'function' ? x.get() : x,
      ),
    );
  state.settingsResolved = mods.apply.Config['~standard'].validate(entry).value;
  // 裸值视图：volatile 字段的 schema 输出是 `{get()}` 包装器（官方读法见
  // dsh-agent-default-model/lib/index.js:39-42），断言与变更比较都走它。
  state.settingsPlain = plainOf(state.settingsResolved);
  state.settingsSection = { ...entry };
  if (overrides.resolvedCliPath !== undefined) {
    state.settingsSection = { ...state.settingsSection, cliPath: overrides.resolvedCliPath };
    state.settingsResolved = mods.apply.Config['~standard'].validate(state.settingsSection).value;
    state.settingsPlain = plainOf(state.settingsResolved);
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
      if (spec.owner !== undefined && typeof spec.owner?.id !== 'string') throw new Error('invalid job owner');
      if (jobs.activeCount(spec.owner) >= 10) throw new Error('background job limit reached for this owner (limit: 10)');
      const hooks = spec.run();
      const id = `${spec.kind}-${++jobs.seq}`;
      const record = { id, kind: spec.kind, label: spec.label, owner: spec.owner, hooks, status: 'running' };
      jobs.store.set(id, record);
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
      return [...jobs.store.values()]
        .filter((j) => j.owner === undefined || j.owner.id === caller?.id)
        .map((j) => ({ id: j.id, kind: j.kind, label: j.label, status: j.status }));
    },
    get(id) { return jobs.store.get(id); },
  };

  const subprocess = {
    stdoutText: '',
    stderrText: '',
    stdoutLossy: false,
    stderrLossy: false,
    lastHandle: null,
    failNextSpawn: false,
    failNextSpawnError: null,
    spawn(call) {
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
      // ★ 读环境块的助手在假宿主里**确定性地不可用**（立即以 1 退出）。
      //   它不这么做的话，"口令读不到"这条路径就变成"等真实 PowerShell 跑完"，
      //   或者（runner 无界时）永远不收尾 —— 两种都是这条用例不该依赖的东西。
      const isEnvHelper = call.argv.some((a) => /read-sidecar-env\.ps1$/i.test(a));
      if (isEnvHelper) queueMicrotask(() => resolveDone({ exitCode: 1 }));
      // ★ 与 test/host.test.js 的假件**逐字同源**（增量⑥ fix#1：只有本次 spawn 申请了
      //   `stdio.<流>.spill` 且确实溢出（lossy）时才回传 `spillPath`；真机语义见 host.test.js 处注释）。
      const collector = (getText, getLossy, getSpillSpec) => ({
        readFrom: (fromByte = 0) => {
          const buf = Buffer.from(getText(), 'utf8');
          const text = buf.subarray(Math.max(0, Math.min(fromByte, buf.length))).toString('utf8');
          const spec = getSpillSpec();
          const spillRequested = spec !== undefined && spec !== null && Number.isSafeInteger(spec?.maxBytes);
          const lossy = getLossy();
          return {
            text, nextOffset: buf.length, lossy,
            ...(spillRequested && lossy ? { spillPath: `__fake_spill_${state.spawnCalls.length}.log` } : {}),
          };
        },
      });
      const handle = {
        collected: {
          stdout: collector(() => subprocess.stdoutText, () => subprocess.stdoutLossy, () => call.stdio?.stdout?.spill),
          ...(isStderrCollected(call)
            ? { stderr: collector(() => subprocess.stderrText, () => subprocess.stderrLossy, () => call.stdio?.stderr?.spill) }
            : {}),
        },
        done,
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
      throw new Error(`__fake_resolve_failed__: ${name}`);
    },
  };

  /**
   * 伪 settings（0.1.7 契约）。
   * `installSection` 已从 dsh-settings 移除（0.1.7 全树零命中）；0.1.7 改为隐式发现
   * （namespace 取 loader 行 id、schema 取 `entry.fiber.runtime.Config`，`lib/index.js:432,443,539`），
   * 公共面只剩 configure/writable/documentPath/prepareDocument/describe/update/replace/mutate。
   * 样板：`dsh-llm-deepseek/lib/index.js:2242-2264`。
   */
  const settingsService = {
    configure(presentation) {
      state.settingsPresentation = presentation;
      return () => {};
    },
    /** 真机 describe 先过 `plainConfig()` 解掉 volatile 包装器（`lib/types/schema.js:9-17`）。 */
    describe() {
      return [{ ns: state.settingsNs, revision: 1, value: state.settingsPlain, base: {}, user: state.settingsSection }];
    },
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
      const before = JSON.stringify(state.settingsPlain);
      state.settingsSection = mergedSection;
      state.settingsResolved = validated.value;
      state.settingsPlain = JSON.parse(
        JSON.stringify(validated.value, (_k, v) =>
          v !== null && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v,
        ),
      );
      // 0.1.7：volatile 字段就地写进 fiber.config，再广播 `loader/volatile-update`。
      ctx.fiber.config = state.settingsResolved;
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

  const services = { tools, jobs, subprocess, settings: settingsService, webServer, systemPrompt };

  const ctx = {
    get: (name) => services[name],
    /** 0.1.7 事件订阅：替代 0.1.5 的 settings onChange 钩子。 */
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
    tools, jobs, subprocess,
  };

  // ★ 必须在 `apply.apply()` **之前**把家目录指走：`detectWorkBuddy()` 在函数体同步段就
  //   读好了 `WORKBUDDY_HOME`，而 apply ③ 在同一同步回合里发起探测。
  state.desktopHome = overrides.desktopHome
    ?? makeDesktopHome({ installed: overrides.desktopInstalled ?? true, catalog: overrides.catalog });
  process.env.WORKBUDDY_HOME = state.desktopHome;
  process.env.HOME = state.desktopHome;
  process.env.USERPROFILE = state.desktopHome;

  mods.apply.apply(ctx, entry);

  return {
    state, ctx, tools, jobs, subprocess, entry, settingsService,
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

/** 造一个"CLI 自己报任务失败"的 result 帧（真机形态：is_error + 非 success subtype）。 */
function resultErrorFrame(extra = {}) {
  return `${JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's-1', ...extra })}\n`;
}

// ───────────────────────── 目标① · 未登记的厂商错误码 ─────────────────────────

test('目标①：未登记厂商码经真实 result 帧 ⇒ 落已登记的 task_error + 证据引用帧内文本；绝不静默 ok、绝不就近套用码族', { skip: SKIP }, () => {
  const { REASON_CODES, isFailureCode, REASON_TEXT } = mods.reasonCodes;
  // details 刻意用**中性文本**（不含 model/network/timeout/flag 等任何文本族关键词）⇒ 排除"靠文本猜出来的"可能。
  const DETAILS = 'vendor reported an odd condition';
  const lr = mods.verdict.buildLastRun({
    argv: ['codebuddy', '-p', 'x'],
    exitCode: 0,
    stderrText: '',
    stdoutText: resultErrorFrame({ errors_info: [{ status: 400, code: 77777, category: null, details: DETAILS }] }),
    flags: [],
  });

  // ① 绝不静默成功：`ok` 只能由"证据表明成功"得出，未登记码不是"没失败"。
  assert.notEqual(lr.reasonCode, REASON_CODES.OK, '未登记码不得被当成成功');
  // ② 落点必须是**已登记**的原因码（可判读、有中文说明），且被判为失败。
  assert.equal(lr.reasonCode, REASON_CODES.TASK_ERROR);
  assert.equal(isFailureCode(lr.reasonCode), true, 'task_error 必须属于"有证据支撑的失败"集合');
  assert.equal(lr.reasonText, REASON_TEXT[REASON_CODES.TASK_ERROR]);
  assert.equal(lr.taskError, true);
  assert.equal(lr.flagVerdict, mods.verdict.FLAG_VERDICTS.ACCEPTED, '本次没有参数被拒的迹象 ⇒ 不得凭空给出 rejected');
  // ③ 抗编造：不得"就近"套用任何一个具体码族（未见过 ≠ 知道）。
  for (const family of ['MODEL_UNAVAILABLE', 'TRANSPORT_UNREACHABLE', 'QUOTA_REQUEST_LIMIT', 'INPUT_TOO_LONG', 'AUTH_FAILED', 'PORT_CONFLICT']) {
    assert.notEqual(lr.reasonCode, REASON_CODES[family], `未登记码 ${77777} 不得被安上 ${family} 的语义`);
  }
  // ④ 证据必须**引用帧内文本**（不是空串、不是整帧 JSON 回灌）。
  assert.equal(typeof lr.reasonEvidence, 'string');
  assert.ok(lr.reasonEvidence.includes(DETAILS), '原因证据必须引用帧里的 details 原文');
  assert.ok(!lr.reasonEvidence.includes('errors_info'), '证据是帧内**文本**，不是把整帧 JSON 回灌当证据');
});

test('目标①：已登记厂商码经真实 result 帧 ⇒ 按码表落点（帧→信号→分类的接缝）；11102 故意不入表 ⇒ 不落任一码族', { skip: SKIP }, () => {
  const { REASON_CODES } = mods.reasonCodes;
  /** 官方码表口径（唯一映射点见 reason-codes.js:243-254）。 */
  const MATRIX = [
    [1001, REASON_CODES.MODEL_UNAVAILABLE],
    [11133, REASON_CODES.MODEL_UNAVAILABLE],
    [11134, REASON_CODES.MODEL_UNAVAILABLE],
    [14003, REASON_CODES.MODEL_UNAVAILABLE],
    [3002, REASON_CODES.TRANSPORT_UNREACHABLE],
    [3003, REASON_CODES.TRANSPORT_UNREACHABLE],
    [3007, REASON_CODES.TRANSPORT_UNREACHABLE],
    [6003, REASON_CODES.QUOTA_REQUEST_LIMIT],
    [6004, REASON_CODES.QUOTA_REQUEST_LIMIT],
    [11115, REASON_CODES.INPUT_TOO_LONG],
  ];
  for (const [code, expected] of MATRIX) {
    // details 中性化：不含任何文本族关键词 ⇒ 落点只可能来自**结构化码**（否则本断言测的是正则而不是码表）。
    const lr = mods.verdict.buildLastRun({
      argv: ['x'],
      exitCode: 0,
      stderrText: '',
      stdoutText: resultErrorFrame({ errors_info: [{ status: 400, code, category: null, details: `vendor code ${code}` }] }),
      flags: [],
    });
    assert.equal(lr.reasonCode, expected, `厂商码 ${code} 应经帧落到 ${expected}`);
  }

  // 11102：**故意**不在码表（它的语义只来自 400-model 文本，见 reason-codes.js:238-241）
  //   ⇒ 同样形态下不得被安上任何码族语义，只能落"CLI 自己报任务失败"这一句已登记的事实。
  const unknown = mods.verdict.buildLastRun({
    argv: ['x'],
    exitCode: 0,
    stderrText: '',
    stdoutText: resultErrorFrame({ errors_info: [{ status: 400, code: 11102, category: null, details: 'vendor code 11102' }] }),
    flags: [],
  });
  assert.equal(unknown.reasonCode, REASON_CODES.TASK_ERROR, '11102 未入表 ⇒ 不得凭推测给语义');
  for (const family of ['MODEL_UNAVAILABLE', 'TRANSPORT_UNREACHABLE', 'QUOTA_REQUEST_LIMIT', 'INPUT_TOO_LONG']) {
    assert.notEqual(unknown.reasonCode, REASON_CODES[family]);
  }
  // 反向控制（判别力）：把同一 details 放到**退出码非 0**的形态里，落点必须换 —— 证明上面的等号不是恒真。
  const nonzero = mods.verdict.buildLastRun({ argv: ['x'], exitCode: 1, stderrText: '', stdoutText: '', flags: [] });
  assert.equal(nonzero.reasonCode, REASON_CODES.EXIT_NONZERO);
});

// ─────────────────── 目标② · 形变的 errors_info[].details ───────────────────

test('目标②：非字符串 details（数字/对象/数组/null）⇒ 不抛、不字符串化、不冒充 stderr 面', { skip: SKIP }, () => {
  const { summariseFrames } = mods.streamJson;
  const { REASON_CODES } = mods.reasonCodes;
  const NOISE = 'STDERR-NOISE-ZZZ';
  /** 非字符串形态一律归一为 `''`（绝不 `String()` 化 ⇒ 不会出现 `[object Object]` / `12345` 这类伪造证据）。 */
  for (const details of [12345, { a: 1 }, ['x'], null, undefined, true]) {
    const stdout = resultErrorFrame({ errors_info: [{ status: 400, code: 3002, category: 'network', details }] });
    const summary = summariseFrames(mods.streamJson.parseFrames(stdout));
    assert.equal(summary.errorSignals.length, 1, `details=${JSON.stringify(details)} 应仍产出 1 条结构化信号`);
    assert.equal(summary.errorSignals[0].details, '', '非字符串 details 必须归一为**空串**（不是字符串化）');
    assert.equal(summary.frameErrorText, '', '非字符串 details 不得进入错误文本面（否则会污染整个证据面）');

    const lr = mods.verdict.buildLastRun({ argv: ['x'], exitCode: 0, stderrText: NOISE, stdoutText: stdout, flags: [] });
    assert.equal(lr.reasonCode, REASON_CODES.TRANSPORT_UNREACHABLE, '结构化码仍须独立生效（不因 details 形变而失效）');
    // 证据 = 码头本身；既没被字符串化，也没被"整段 stderr"顶替。
    assert.equal(lr.reasonEvidence, 'code 3002', '证据必须只剩码头，不得混入字符串化垃圾');
    assert.ok(!lr.reasonEvidence.includes('[object'), '绝不出现 [object Object]');
    assert.ok(!lr.reasonEvidence.includes('12345'), '绝不出现被字符串化的 details');
    assert.ok(!lr.reasonEvidence.includes(NOISE), 'details 形变时也不得退化成"把整段 stderr 当证据"');
  }
});

test('目标②：details 含换行 ⇒ 证据单行化；20000 字符 ⇒ 证据截到 400、帧错误面截到 16384', { skip: SKIP }, () => {
  const { summariseFrames } = mods.streamJson;
  const { REASON_CODES, EVIDENCE_LIMIT } = mods.reasonCodes;
  assert.equal(EVIDENCE_LIMIT, 400, '证据串上限是跨端可见常量，变更必须显式改测试');
  /** 帧错误文本上限（`stream-json.js:31`，未导出 ⇒ 在测试里固化契约）。 */
  const FRAME_ERROR_TEXT_LIMIT = 16384;

  // ① 换行必须被单行化（否则一条证据会撑破卡片的单行渲染，且"逐 flag 归因"的正则按行读会漏）
  const multiline = mods.verdict.buildLastRun({
    argv: ['x'],
    exitCode: 0,
    stderrText: '',
    stdoutText: resultErrorFrame({ errors_info: [{ status: 400, code: 3002, category: 'network', details: 'first line\nsecond line' }] }),
    flags: [],
  });
  assert.equal(multiline.reasonEvidence, 'code 3002: first line second line');
  assert.ok(!multiline.reasonEvidence.includes('\n'), '证据必须是单行');

  // ② 超长 details：错误文本面与证据面**各自**有上限（无上限 ⇒ 日志/卡片被一条外部文本撑爆）
  const HUGE = 'x'.repeat(20000);
  const stdout = resultErrorFrame({ errors_info: [{ status: 400, code: 3002, category: 'network', details: HUGE }] });
  const summary = summariseFrames(mods.streamJson.parseFrames(stdout));
  assert.equal(summary.frameErrorText.length, FRAME_ERROR_TEXT_LIMIT, '帧错误面必须截断到上限');
  assert.equal(summary.frameErrorText, HUGE.slice(0, FRAME_ERROR_TEXT_LIMIT), '截断必须是"取前缀"而不是"整体丢弃"');
  const lr = mods.verdict.buildLastRun({ argv: ['x'], exitCode: 0, stderrText: '', stdoutText: stdout, flags: [] });
  assert.equal(lr.reasonCode, REASON_CODES.TRANSPORT_UNREACHABLE);
  assert.equal(lr.reasonEvidence.length, EVIDENCE_LIMIT, '对外证据串必须截断到证据上限');
  assert.match(lr.reasonEvidence, /^code 3002: xxx/);
});

test('目标②：details 与助手散文各归其位（散文只进 frameProseText，绝不当证据）', { skip: SKIP }, () => {
  const { summariseFrames } = mods.streamJson;
  const { REASON_CODES } = mods.reasonCodes;
  const PROSE = 'I will now inspect the repository and summarise it.';
  const DETAILS = 'DETAILS-ONLY-IN-ERROR-FACE';
  const stdout = `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: PROSE }] } })}\n`
    + resultErrorFrame({ errors_info: [{ status: 400, code: 3002, category: 'network', details: DETAILS }] });
  const summary = summariseFrames(mods.streamJson.parseFrames(stdout));
  assert.ok(summary.frameProseText.includes(PROSE), '助手散文应落在 frameProseText（展示面）');
  assert.ok(!summary.frameProseText.includes(DETAILS), '错误面文本不得漏进散文面');
  assert.ok(summary.frameErrorText.includes(DETAILS), '错误面文本应落在 frameErrorText（证据面）');
  assert.ok(!summary.frameErrorText.includes(PROSE), '散文绝不得成为证据');

  const lr = mods.verdict.buildLastRun({ argv: ['x'], exitCode: 0, stderrText: '', stdoutText: stdout, flags: [] });
  assert.equal(lr.reasonCode, REASON_CODES.TRANSPORT_UNREACHABLE);
  assert.ok(lr.reasonEvidence.includes(DETAILS));
  assert.ok(!lr.reasonEvidence.includes(PROSE), '证据里不得出现助手散文');
});

// ────────────────────── 目标③ · 未登记的 registry 态 ──────────────────────

test('目标③：registry 未登记/缺失/形状不对 ⇒ 文案绝不落 available 分支；未确认态另有措辞', { skip: SKIP }, () => {
  const states = mods.constants.REGISTRY_STATES;
  const text = (registry) => mods.availability.availabilityText({
    detected: () => ({ installed: true }),
    registry: () => registry,
  });

  // 正向控制（判别力）：两个**已登记可用**的态必须落 available —— 否则"恒不 available"的坏实现也能骗过下面全部断言。
  for (const okState of [states.REGISTERED, states.DEGRADED]) {
    assert.match(text(okState), /WorkBuddy delegation is available/, `${okState} 应落可用分支`);
  }
  // 未确认/未登记/缺失/形状不对：一律**不得**落可用分支（保守兜底优于"假装能用"）。
  //   注：断言刻意只钉"绝不 available"，不钉兜底那一句的具体措辞（措辞随分支演进，可用性结论不能）。
  for (const bad of [states.UNKNOWN, states.UNREGISTERED, states.NOT_INSTALLED, undefined, null, '', '???', 42, {}, [], 'registered']) {
    const t = text(bad);
    assert.equal(typeof t, 'string', `registry=${JSON.stringify(bad)} 文案必须是字符串`);
    assert.doesNotMatch(t, /WorkBuddy delegation is available/, `registry=${JSON.stringify(bad)} 不得被当成"可用"`);
  }
  // UNKNOWN 有**专属**措辞（既不是可用、也不是"被用户关掉"）——否则"重新评估中"会被读成"用户关了"。
  assert.match(text(states.UNKNOWN), /being re-evaluated/);
  assert.doesNotMatch(text(states.UNKNOWN), /switched OFF by the user/);
});

// ───────────────────────── 目标④ · status 工具面契约 ─────────────────────────

test('目标④：config.enabled 在工具面"声明与载荷双缺席"；路由面必须保留（两份契约刻意不同构）', { skip: SKIP }, async () => {
  const host = boot({ enabled: true });
  await waitFor(() => host.state.registration.size === 2);
  const statusDef = host.state.registration.get('workbuddy_status');
  const out = await statusDef.execute({}, { signal: new AbortController().signal });

  // ① 载荷缺席（test/host.test.js 已钉）—— 这里补 ② **声明**缺席：
  //   只钉载荷的话，schema 里悄悄加一条 `enabled`（非 required）不会有任何测试变红，
  //   而模型看到的工具契约就多了一个永远不会出现的字段。
  const schema = statusDef.output.schema;
  assert.ok(!Object.prototype.hasOwnProperty.call(schema.properties, 'enabled'), '顶层不得声明 enabled');
  const cfgSchema = schema.properties.config;
  assert.equal(cfgSchema.additionalProperties, false);
  // ★ 2026-09-28：`config` 加了 `sessionMode` / `createNewConversation`——它们决定**这次**
  //   能不能发、以什么授权强度发，模型有权知道（这也是 `permission_mode` 的设置侧）。
  assert.deepEqual(
    Object.keys(cfgSchema.properties).sort(),
    ['createNewConversation', 'effort', 'model', 'sessionMode'],
    'config 的键集是契约：enabled / workspace / boundSessionId / gatewayToken 都不得进工具面',
  );
  assert.deepEqual([...cfgSchema.required].sort(), ['createNewConversation', 'effort', 'model', 'sessionMode']);
  // ★ 排除规则的具体理由（写死，别只靠"没加"）：
  //   - `enabled`：暴露一个"能关掉自己"的开关只会让模型自伤；
  //   - `boundSessionId` / `workspace`：模型自己填 `cwd` 就够，让它改绑定会劫持用户正在用的对话；
  //   - `gatewayToken`：凭据形状。
  for (const forbidden of ['enabled', 'workspace', 'boundSessionId', 'gatewayToken']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(cfgSchema.properties, forbidden),
      `★ config 不得声明 ${forbidden}`);
  }
  // ③ 载荷形状与声明逐字一致
  assert.ok(!Object.prototype.hasOwnProperty.call(out.config ?? {}, 'enabled'));
  assert.deepEqual(
    Object.keys(out.config).sort(),
    ['createNewConversation', 'effort', 'model', 'sessionMode'],
    '载荷的 config 键集必须与声明逐字一致',
  );
  // ④ 反控：路由面**必须**保留 enabled（GUI 卡片要它；工具面不回传是刻意的）
  const payload = await host.statusPayload();
  assert.equal(payload.json.config.enabled, true, '路由面不得把 enabled 一起砍掉');
});

test('目标④：档位能力 canonical = 7 档含 off；平台 values = 6 档无 off（不互相污染、不凭空补档）', { skip: SKIP }, async () => {
  const LEVELS = mods.constantsShared.EFFORT_LEVELS;
  assert.deepEqual([...LEVELS], ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'canonical 档位表是跨端契约');
  const { effortCapability } = mods.statusRoute;

  // ① 空配置（老调用方 / 表缺失）⇒ canonical 仍是 7 档、values 空（空 = 未知，见目标④下一条）。
  const empty = effortCapability({});
  assert.deepEqual(empty.canonical, [...LEVELS]);
  assert.equal(empty.canonical.length, 7);
  assert.ok(empty.canonical.includes('off'));
  assert.deepEqual(empty.values, {});
  // ② 平台表就位 ⇒ values 与平台表一致，且**不得**把 canonical 里的 off 补进平台表。
  const filled = effortCapability({ launch: { effortValues: { ...EFFORT_VALUES } } });
  assert.deepEqual(filled.canonical, [...LEVELS]);
  assert.deepEqual(Object.keys(filled.values).sort(), ['high', 'low', 'max', 'medium', 'minimal', 'xhigh']);
  assert.ok(!Object.prototype.hasOwnProperty.call(filled.values, 'off'), '平台没有 off 档 ⇒ 不得凭空补一个映射');
  // ③ 工具面如实回传同一份结论（工具面与路由面共用单一来源）。
  const host = boot({ enabled: true });
  await waitFor(() => host.state.registration.size === 2);
  const out = await host.state.registration.get('workbuddy_status').execute({}, { signal: new AbortController().signal });
  assert.deepEqual(out.effort.canonical, [...LEVELS]);
  assert.deepEqual(Object.keys(out.effort.values).sort(), ['high', 'low', 'max', 'medium', 'minimal', 'xhigh']);
});

test('目标④：平台档位表缺失/空/形状不对 ⇒ 文案说"未确认"，绝不说"不支持"（unknown ≠ unsupported）', { skip: SKIP }, () => {
  const REGISTERED = mods.constants.REGISTRY_STATES.REGISTERED;
  /** 只替换 launch.effortValues（undefined ⇒ 连 launch 都不提供）。 */
  const text = (effortValues) => mods.availability.availabilityText({
    detected: () => ({ installed: true }),
    registry: () => REGISTERED,
    currentConfig: () => (effortValues === undefined
      ? { model: '', effort: 'high' }
      : { model: '', effort: 'high', launch: { effortValues } }),
  });

  // ① 表里真有该档 ⇒ supported（该分支是唯一带引号的形态）
  assert.match(text({ high: 'high' }), /effort "high"/);
  // ② 表**非空**但该档没有可用映射 ⇒ unsupported（明确说当前安装不支持，并列出真的会下发的档）。
  //    ★ 边界（与 reason-codes 的判据逐字对齐，见 availability.js:42-56）：`{high:42}` / `{high:''}`
  //      属于"表在、但这一档不会被下发" ⇒ unsupported，**不是** unconfirmed。区分点是"表**整张**读不到"。
  //    ★ 2026-10-02：措辞里的主语从「the current CLI」改成「the current install」——
  //      下发只走桌面端网关，已经不存在"当前 CLI"这个东西。
  assert.match(text({ low: 'low' }), /effort high \(not supported by the current install; available: low\)/);
  assert.match(text({ high: 42 }), /effort high \(not supported by the current install; available: none\)/);
  assert.match(text({ high: '' }), /effort high \(not supported by the current install; available: none\)/);
  // ③ 表整张缺失/空/非对象/数组 ⇒ **未确认**：读不到数据 ≠ 平台不支持（这正是 S3 的原始缺陷）。
  for (const missing of [undefined, null, {}, [], 'high', 42]) {
    const t = text(missing);
    assert.match(t, /effort high \(support not confirmed/, `表=${JSON.stringify(missing)} 应落"未确认"`);
    assert.doesNotMatch(t, /not supported by the current install/, '读不到表时绝不能说"平台不支持"');
    assert.doesNotMatch(t, /effort "high"/, '读不到表时绝不默认支持');
  }
  // ④ 口径与工具面一致：空表在能力表里同样落"未知"（values = {}）。
  assert.deepEqual(mods.statusRoute.effortCapability({ launch: { effortValues: {} } }).values, {});
  assert.deepEqual(mods.statusRoute.effortCapability({ launch: { effortValues: null } }).values, {});
});

// ★ 2026-10-02 删除：「三份模型清单并列」这个产品判据依赖已删除的两份 —— `cliSupportedModels`
// ──────────────── 目标⑤ · schema ↔ 载荷一致（官方校验器做真校验） ────────────────

test('目标⑤：schema ↔ 载荷一致 —— 已声明/required 全覆盖，未声明键必被抓（含正控与负控）', { skip: SKIP }, async () => {
  const { validateJsonSchemaValue } = mods.dshTools;
  assert.equal(typeof validateJsonSchemaValue, 'function', '官方校验器必须可用（否则本用例退化为假绿）');

  // 先**验证测量工具本身**（已知好/已知坏各一例）：否则"全绿"可能只是校验器什么都没查。
  const probeSchema = mods.dshTools.valueSchemaSpecToJsonSchema({
    type: 'object',
    additionalProperties: false,
    properties: { a: { type: 'string', required: true } },
  });
  assert.deepEqual(validateJsonSchemaValue(probeSchema, { a: 'x' }, 'probe'), [], '正控：合法载荷必须零违规');
  assert.deepEqual(validateJsonSchemaValue(probeSchema, { a: 'x', z: 1 }, 'probe'), ['"probe.z" is not a declared property (additionalProperties: false)']);
  assert.deepEqual(validateJsonSchemaValue(probeSchema, {}, 'probe'), ['missing required property "probe.a"']);

  // `defineTool` 只校验**入参**（dsh-tools 的 execute 包装），输出值从不校验
  //   ⇒ 返回一个未声明的键是**静默**契约破损，只能靠测试抓。
  const host = boot({ enabled: true });
  // ★ 必须等**探测出结论**：工具在探测在途期间就乐观注册（未结论 ≠ 未安装），而
  //   `workbuddy_run.execute()` 会先 `awaitDetection()` 再判 installed —— 只等 registration 会读早。
  const probed = await waitFor(async () => (await host.statusPayload()).json.probe !== null);
  assert.ok(probed, '探测应在线性时间内出结论');
  const statusDef = host.state.registration.get('workbuddy_status');
  const runDef = host.state.registration.get('workbuddy_run');
  const signal = new AbortController().signal;

  const statusOut = await statusDef.execute({}, { signal });
  assert.deepEqual(
    validateJsonSchemaValue(statusDef.output.schema, statusOut, 'workbuddy_status'),
    [],
    'workbuddy_status：载荷必须完全落在已声明 schema 内（未声明键 / 缺 required 键都会在此变红）',
  );

  const started = await runDef.execute({ prompt: 'ping' }, { signal });
  assert.deepEqual(
    Object.keys(started).sort(),
    ['argv_preview', 'job_id', 'not_sent', 'resumed', 'resumed_session_id', 'session_key'],
    'workbuddy_run 返回值键集应与声明逐字一致',
  );
  assert.deepEqual(
    validateJsonSchemaValue(runDef.output.schema, started, 'workbuddy_run'),
    [],
    'workbuddy_run：载荷必须完全落在已声明 schema 内',
  );
  // ★ 施工单 #2：follow_up 识别面两键是 `oneOf(string|null)` —— 必须用**官方校验器**钉住
  //   （只在声明里加字段却不验 = 静默契约破损）：字符串 / null 合法，数字越界，未声明键越界。
  const fuSchema = runDef.output.schema.properties.follow_up;
  assert.equal(typeof fuSchema, 'object', 'follow_up 必须在声明里');
  const fuBase = { channel: 'track_a', elapsedMs: 12 };
  assert.deepEqual(
    validateJsonSchemaValue(fuSchema, { ...fuBase, conversationModel: 'kimi-k3-1', conversationEffort: null }, 'follow_up'),
    [],
    '识别面两键：字符串与 null 都必须是合法取值',
  );
  assert.deepEqual(
    validateJsonSchemaValue(fuSchema, { ...fuBase, conversationModel: null, conversationEffort: 'high' }, 'follow_up'),
    [],
    'conversationModel=null（读取失败）同样合法：null 就是"没读到"的如实表达',
  );
  assert.deepEqual(
    validateJsonSchemaValue(fuSchema, { ...fuBase, conversationModel: 42, conversationEffort: 'high' }, 'follow_up'),
    ['"follow_up.conversationModel" must match exactly one oneOf branch (matched 0)'],
    '越界取值必须被抓（否则 schema 只是装饰）',
  );
  assert.deepEqual(
    validateJsonSchemaValue(fuSchema, { ...fuBase, conversationModel: '', surprise: 1 }, 'follow_up'),
    ['"follow_up.surprise" is not a declared property (additionalProperties: false)'],
    'follow_up 仍是封闭对象：加键必须同时进声明',
  );
  // 收尾：不要让假宿主的在途作业悬着（本用例只关心形状，不关心终态）。
  // ★ 2026-10-02：网关路没有进程句柄可 `_resolve` —— 作业由 dispatch 自己收敛。
  await host.jobs.get(started.job_id)?.hooks?.done;
});

// ──────────────────── 目标⑨ · 响应式配置源不得绑到 inject 子 fiber ────────────────────

test('目标⑨：setSource 必须绑本插件自己的 fiber（不得绑 inject 子 fiber）—— 否则开关恒假、工具恒不注册', { skip: SKIP }, () => {
  // 静态守卫（与 session-intent G1 同形）：本条护的是一个**行为上无法用假宿主复现**的接缝 ——
  // cordis 构造 `inject()` 子 fiber 时不传 config，真机上 `sctx.fiber.config` 的键集是空的，
  // 而 `ctx.fiber.config === apply` 拿到的真实配置。假宿主里两者都能随手填成一样，
  // 所以行为测试天然测不出这条；这里钉住源码形态，让"改回子 fiber"当场变红。
  const src = readFileSync(join(here, '..', 'src', 'host', 'tools', 'index.js'), 'utf8');
  const binds = [...src.matchAll(/runtime\.setSource\(\s*\(\)\s*=>\s*([^)]+?)\s*\)/g)].map((m) => m[1].trim());
  assert.equal(binds.length, 1, `tools/index.js 应当只有一处 setSource，实际 ${binds.length} 处：${JSON.stringify(binds)}`);
  assert.ok(
    /^ctx\./.test(binds[0]),
    '★ 响应式源必须读**外层** `ctx.fiber.config`（= apply 收到的真实配置）；'
    + '绑 `sctx`（inject 子 fiber，真机键集为空）会让 enabled 恒 false ⇒ U4 零注册 ⇒ '
    + `"开关是开的但后台没跑"，且重启无效。实际绑定：${binds[0]}`,
  );
  // 负向断言：子 fiber 名字不许再出现在 setSource 上（防止换个变量名绕开）
  assert.doesNotMatch(
    src,
    /setSource\(\s*\(\)\s*=>\s*sctx\b/,
    'setSource 绝不能绑到 inject 子 fiber',
  );
});

// ──────────────────── 目标⑦ · 倍率三态（unknown ≠ free ≠ paid） ────────────────────

test('目标⑦：isFree 三态 —— 0 倍 = 免费、>0 倍 = 付费、无 credits 键 ⇒ null（绝不谎报 free 也不谎报 paid）', { skip: SKIP }, () => {
  // fixture 逐字取自本机 product.json @ 2.137.1 的真实形态：
  //   hy3 = "x0.00 credits"（唯一 0 倍 ⇒ 免费）、deepseek-v4-flash = "x0.06"、default = "x2.00"，
  //   其余 39/48 条**根本没有 credits 键**（⇒ 未知）。
  const CATALOG = {
    models: [
      { id: 'hy3', credits: 'x0.00 credits' },
      { id: 'deepseek-v4-flash', credits: 'x0.06 credits' },
      { id: 'default', credits: 'x2.00 credits' },
      { id: 'no-credits-key' },
      { id: 'credits-empty', credits: '' },
      { id: 'credits-unparseable', credits: '见说明' },
      { id: 'credits-non-string', credits: 0.5 },
    ],
  };
  const got = mods.modelCatalog.readModelCatalog(null, { ACC_PRODUCT_CONFIG_V3: JSON.stringify(CATALOG) });
  assert.equal(got.reason, null);
  const byId = new Map(got.models.map((m) => [m.id, m.isFree]));

  assert.equal(byId.get('hy3'), true, '★ 0 倍 ⇒ 免费（积分制算术事实）');
  assert.equal(byId.get('deepseek-v4-flash'), false, '>0 倍 ⇒ 付费（哪怕 0.06 也照样扣钱）');
  assert.equal(byId.get('default'), false, '>0 倍 ⇒ 付费');
  assert.equal(byId.get('no-credits-key'), null, '★ 键缺失 = 倍率**未知** ⇒ null（本机 39/48 条是这种形态）');
  assert.equal(byId.get('credits-empty'), null, '空串无法解析 ⇒ 未知');
  assert.equal(byId.get('credits-unparseable'), null, '无数字的串 ⇒ 未知，不猜');
  assert.equal(byId.get('credits-non-string'), null, '非字符串 ⇒ 未知');

  // 负向断言：两个方向都不许折进去（这是本条判据的全部意义）
  assert.notEqual(byId.get('no-credits-key'), true, '未知绝不能被发布成"免费"');
  assert.notEqual(byId.get('no-credits-key'), false, '未知绝不能被发布成"付费"');
  for (const m of got.models) {
    assert.ok(
      m.isFree === true || m.isFree === false || m.isFree === null,
      `${m.id}: isFree 取值域为 boolean|null`,
    );
  }
});

test('目标⑦：agents.cli 兜底目录不带倍率 ⇒ isFree 必须为 null（不得凭空说免费）', { skip: SKIP }, () => {
  const got = mods.modelCatalog.readModelCatalog(null, {
    ACC_PRODUCT_CONFIG_V3: JSON.stringify({ agents: [{ name: 'cli', models: ['a', 'b'] }] }),
  });
  assert.equal(got.source, 'env:inline#agents.cli.models');
  for (const m of got.models) assert.equal(m.isFree, null, `${m.id}: 兜底目录没有倍率信息 ⇒ 未知`);
});

// ──────────────────── 目标⑥ · 模型能力位三态（unknown ≠ false） ────────────────────

test('目标⑥：supportsReasoning 三态 —— 显式 true/false 原样，键缺失或非布尔 ⇒ null（绝不谎报 false）', { skip: SKIP }, () => {
  // 自造目录（不读真实安装目录、不写任何 data root）：内联源每次解析、无 stat ⇒ 无文件系统依赖。
  const CATALOG = {
    models: [
      { id: 'supports-yes', supportsReasoning: true },
      { id: 'supports-no', supportsReasoning: false },
      { id: 'key-absent' }, // 本机真机形态：48 个模型里 23 个没有该键
      { id: 'key-non-boolean', supportsReasoning: 'yes' },
    ],
  };
  const got = mods.modelCatalog.readModelCatalog(null, { ACC_PRODUCT_CONFIG_V3: JSON.stringify(CATALOG) });
  assert.equal(got.reason, null);
  assert.equal(got.source, 'env:inline');
  const byId = new Map(got.models.map((m) => [m.id, m.supportsReasoning]));

  assert.equal(byId.get('supports-yes'), true, '显式 true 必须原样保留');
  assert.equal(byId.get('supports-no'), false, '显式 false 必须原样保留（证否能力位是真实语义）');
  assert.equal(byId.get('key-absent'), null, '★ 键缺失 = **未知** ⇒ null（旧实现 `=== true` 在此谎报 false）');
  assert.equal(byId.get('key-non-boolean'), null, '非布尔值同样只能表达"未知"');
  // 负向断言（防止"把 null 写成 false"的等价回退再次混进来）
  assert.notEqual(byId.get('key-absent'), false, '键缺失绝不能被表达成 false');
  for (const m of got.models) {
    assert.ok(
      m.supportsReasoning === true || m.supportsReasoning === false || m.supportsReasoning === null,
      `${m.id}: 能力位取值域为 boolean|null`,
    );
  }
});

test('目标⑥：文件型目录源同样保持三态（且缓存命中不改变结论）', { skip: SKIP }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa8-catalog-'));
  try {
    const file = join(dir, 'product.json');
    writeFileSync(file, JSON.stringify({
      models: [
        { id: 'file-yes', supportsReasoning: true },
        { id: 'file-no', supportsReasoning: false },
        { id: 'file-absent' },
      ],
    }), 'utf8');
    const env = { ACC_PRODUCT_CONFIG_PATH: file };
    const first = mods.modelCatalog.readModelCatalog(null, env);
    const second = mods.modelCatalog.readModelCatalog(null, env); // 命中 (路径, mtimeMs) 缓存
    assert.deepEqual(first.models.map((m) => m.supportsReasoning), [true, false, null]);
    assert.deepEqual(second.models, first.models, '缓存命中不得改变能力位（含 null）');
    assert.equal(first.reason, null);
    assert.ok(first.source.startsWith('env:path:'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ──────────────── 目标⑦ · 目录"读不到"的三态（§4-9 · 在途 ≠ 不可用） ────────────────

/** 屏蔽本机真实安装位与环境覆盖（本机 `%TEMP%` 之外的一切目录都不进判定）。 */
const NO_CATALOG_ENV = Object.freeze({
  ACC_PRODUCT_CONFIG: undefined, ACC_PRODUCT_CONFIG_V2: undefined, ACC_PRODUCT_CONFIG_V3: undefined,
  ACC_PRODUCT_CONFIG_PATH: undefined,
});

test('目标⑦：detectionStateOf 映射 —— 只有"手里有结论"才允许说 unavailable', { skip: SKIP }, () => {
  const CONCLUSION = { installed: true, resolvedPath: 'x' };
  const cases = [
    // runtime 整个缺失 / 只有一半读数 ⇒ **无证据**说"探测已给结论" ⇒ 不得落 unavailable 分支。
    [undefined, 'not-started', 'runtime 缺失'],
    [null, 'not-started', 'runtime 为 null'],
    [{}, 'not-started', '两个读数都没有（旧式桩）⇒ 只能给"没有结论"这一半事实'],
    [{ detected: () => null, probeArgs: () => null }, 'not-started', '探测压根没排上'],
    [{ detected: () => null, probeArgs: () => ({}) }, 'pending', '排上了但结论还没回来'],
    [{ detected: () => CONCLUSION, probeArgs: () => null }, 'concluded', '有结论 ⇒ 一律 concluded（读数缺失不影响）'],
    [{ detected: () => ({ installed: false, resolvedPath: null }), probeArgs: () => ({}) }, 'concluded', '结论是"确实没装"也算已结论'],
    [{ detected: () => undefined, probeArgs: () => undefined }, 'not-started', 'undefined 与 null 同义（不得因 falsy 判定漂移）'],
  ];
  for (const [runtime, want, why] of cases) {
    assert.equal(mods.modelCatalog.detectionStateOf(runtime), want, why);
  }
});

test('目标⑦：三种"读不到"分别可辨 —— pending:* / unavailable:*，且缺省参数逐字沿用旧口径', { skip: SKIP }, () => {
  // ★ 2026-10-02：取不到目录的归因口径改了名字，理由与形状都没变。
  //   旧口径 `unavailable:cli-not-resolved`（"CLI 路径没解析出来"）描述的是**解析可执行文件路径**那一步；
  //   探测源换成桌面端产品配置缓存后，目录读取器不再有"解析路径"这一步 ⇒ 归因改成
  //   `unavailable:catalog-not-resolved`。**三态的结构**（pending:* / unavailable:*）逐字未动，
  //   而"缺省第三参 = 'concluded' = '已结论就按已结论说'"这条兼容契约也逐字未动。
  // ① 缺省（不传第三参）= 修复前的口径，一字不改 ⇒ 既有调用方与既有断言不受本次修复影响。
  const legacy = mods.modelCatalog.readModelCatalog(null, NO_CATALOG_ENV, 'concluded', { home: NO_DESKTOP_HOME });
  assert.deepEqual([legacy.models, legacy.source, legacy.reason], [[], 'unavailable', 'catalog-not-resolved'], '缺省必须复现旧读数');

  // ② 在途：探测还在路上 ⇒ 说"待着"，不说"不可用"（真机首帧抓到的是这条的反面）。
  const inflight = mods.modelCatalog.readModelCatalog(null, NO_CATALOG_ENV, 'pending', { home: NO_DESKTOP_HOME });
  assert.deepEqual([inflight.models, inflight.source, inflight.reason], [[], 'pending', 'detection-in-flight']);
  assert.notEqual(inflight.source, 'unavailable', '★ 在途不得写成 unavailable（RECON §9.4 / ISSUE §4-9 的原始缺陷）');

  // ③ 未排上：与在途是**两种**现实，reason 必须可辨（合并成一种就又是一次折叠）。
  const notStarted = mods.modelCatalog.readModelCatalog(null, NO_CATALOG_ENV, 'not-started', { home: NO_DESKTOP_HOME });
  assert.deepEqual([notStarted.models, notStarted.source, notStarted.reason], [[], 'pending', 'detection-not-started']);
  assert.notEqual(notStarted.reason, inflight.reason, '在途与未排上不得共用同一个 reason');

  // ④ pending **不掩盖**已知的出处：只要确实有一个源（哪怕它指向坏路径），结论照旧是 unavailable。
  //    ★ 2026-10-02：这一例的构造改了。旧写法靠 `probe.resolvedPath` 指向 CLI 入口来"有源"，
  //      而目录读取器**不再从 probe 推导路径**（CLI 线已删，桌面缓存是唯一落到磁盘的源）。
  //      现在用 `ACC_PRODUCT_CONFIG_PATH` 指向一个不存在的文件 —— 这是真机上确实会出现的形态
  //      （配置指了路径、文件被删），并且它落 `catalog-unreadable` 而不是 `catalog-not-resolved`
  //      ⇒ 两个 unavailable 归因也各自被覆盖到。
  const missingPathEnv = { ...NO_CATALOG_ENV, ACC_PRODUCT_CONFIG_PATH: join(NO_DESKTOP_HOME, 'no-such-config.json') };
  const withMissingPath = mods.modelCatalog.readModelCatalog(null, missingPathEnv, 'pending', { home: NO_DESKTOP_HOME });
  assert.deepEqual([withMissingPath.source, withMissingPath.reason], ['unavailable', 'catalog-unreadable'], '有源可读却没读到 ⇒ 仍是 unavailable，不因在途而改口');
  const noSourceAtAll = mods.modelCatalog.readModelCatalog(null, NO_CATALOG_ENV, 'pending', { home: NO_DESKTOP_HOME });
  assert.deepEqual([noSourceAtAll.source, noSourceAtAll.reason], ['pending', 'detection-in-flight'],
    '★ 在途且**一个源都没有** ⇒ 落 pending（与 inflight 那一例同源，不得说"不可用"）');
  const withInline = mods.modelCatalog.readModelCatalog(null, {
    ...NO_CATALOG_ENV, ACC_PRODUCT_CONFIG_V3: JSON.stringify({ models: [{ id: 'auto' }] }),
  }, 'pending');
  assert.deepEqual([withInline.source, withInline.reason, withInline.models.map((m) => m.id)], ['env:inline', null, ['auto']], '在途不影响内联源读数');
});

// ── 目标⑧：cli-core 接缝（§26 抽包第一刀）──────────────────────────────
// 抽包的唯一守卫是"测试全绿"，而全绿本身证明不了**东西真的搬走了**：
//   复制一份、两边各留一份，测试同样绿 ⇒ 那叫没抽。故此用例钉的是**同一性**与**注入方向**。
test('目标⑧：状态字母表冻结 + target 是参数不是常量', { skip: SKIP }, async () => {
  // ★ 2026-10-02 改写：原先这条验的是"本包转发的是 core 的那个对象"，
  //   而 core 已随 CLI 方向整体退役、`createRuntime` 与状态字母表一并内联进本包。
  //   **要守的性质没变**，只是不再有"两个包漂开"这个风险面了：
  //     ① 字母表冻结（运行时不许改写取值域）
  //     ② `createRuntime` 的 target 是**参数**，调用方不传它就不许发明一个厂商标识
  assert.ok(mods.constants.REGISTRY_STATES && typeof mods.constants.REGISTRY_STATES === 'object', 'REGISTRY_STATES 必须是对象');
  assert.ok(mods.constants.RUN_STATES && typeof mods.constants.RUN_STATES === 'object', 'RUN_STATES 必须是对象');
  assert.equal(Object.isFrozen(mods.constants.REGISTRY_STATES), true, '协议字母表必须冻结');
  assert.equal(Object.isFrozen(mods.constants.RUN_STATES), true, '协议字母表必须冻结');

  // 探测函数自己抛了 —— 这是注入值唯一会露出水面的地方，拿它当探针。
  const boom = () => { throw new Error('探测函数故意抛'); };

  // ② 本包注入 PROBE_TARGET
  const fwd = mods.runtimeFwd.createRuntime({ pluginId: 'plugin-workbuddy', config: {}, ns: 'dsh-plugin-workbuddy' });
  const fromFwd = await fwd.probe(boom, {});
  assert.equal(fromFwd.target, 'workbuddy', '兜底 ProbeResult.target 必须是本包注入的 PROBE_TARGET');
  assert.equal(fromFwd.reason, 'error', '探测函数异常必须收敛成 reason:error（永不外抛，U6）');

  // ③ 认参数不认厂商：换一个注入值就得另一个值 ⇒ 证明它是**参数**，不是抄漏的常量。
  const other = mods.runtimeFwd.createRuntime({ pluginId: 'p', config: {}, ns: 'n', target: 'acme' });
  assert.equal((await other.probe(boom, {})).target, 'acme', '必须照注入值回写');

  // ④ 本包的包装层**必须**补上本包自己的 target —— 通用实现里没有厂商字面值（U9：不猜），
  //   若这一层也不补，探测异常时兜底结果的 target 就是 undefined，载荷里少了"这是哪个 agent"。
  //   ★ 这与"发明缺省值"不是一回事：U9 禁的是**通用层**替所有插件猜一个；本包知道自己是 workbuddy。
  const bare = mods.runtimeFwd.createRuntime({ pluginId: 'p', config: {}, ns: 'n' });
  assert.equal((await bare.probe(boom, {})).target, 'workbuddy', '本包装层必须补上本包的 target');
});

// ──────────────────── 进程出口已按 Owner 硬约束清零（2026-10-10）────────────────────
//
// 这里原有四条 seam 用例（超时终止 / 非零退出 reject / exit 0 空输出 reject / drain 顺序），
// 钉的是 `makeSeamRunner()` —— 一个等退出、拿 stdout、超时 terminate 的进程 runner。
// 它服务的三条路（pwsh 读 sidecar PEB 口令 / netstat 反查端口 / PowerShell 列进程身份）
// **全部是显隐 Shell 或控制台进程**，Owner 硬约束零容忍 ⇒ 三条路与 runner 一并删除
// （见 apply.js 头注 2026-10-10 条、token.js 头注、desktop.js 的 broker 管道探针）。
// runner 不在了，继续给一个不存在的函数写行为测试就是假测试 ⇒ 改钉**新不变量**：
// seam 不得复辟，且代码里不得再出现任何 Shell/控制台进程字样。

test('★★ seam runner 保持删除状态，不得复辟（Owner 硬约束：零显隐 Shell/控制台进程）', { skip: SKIP }, async () => {
  const { makeSeamRunner } = mods.apply;
  assert.equal(typeof makeSeamRunner, 'undefined',
    'makeSeamRunner（等退出/拿 stdout/超时 terminate 的进程 runner）必须保持删除');
});

test('★★★ apply.js 代码里不得再出现任何 Shell/控制台进程字样', { skip: SKIP }, async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/host/apply.js', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'))
    .join('\n');
  for (const needle of ['pwsh', 'powershell', 'netstat', 'lsof', 'tasklist', 'makeSeamRunner']) {
    assert.equal(src.includes(needle), false, `★ apply.js 代码里不得再出现 ${needle}`);
  }
  // 仅剩的 subprocess 消费者 = makeLauncher（火枪式拉 WorkBuddy.exe GUI 本体，见 apply.js 头注）。
  // 钉住两件事：它没被顺手删掉；且全文件只有这一处 spawn 调用点（多一处就是新的出口）。
  assert.match(src, /makeLauncher\(ctx\)/, '★ 桌面端 GUI 启动器必须仍在位');
  const spawnSites = src.match(/subprocess\.spawn\(/g) ?? [];
  assert.equal(spawnSites.length, 1, `★ 全文件只允许 launcher 这一处进程出口，实际 ${spawnSites.length} 处`);
});

