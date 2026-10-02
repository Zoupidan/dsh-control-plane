/**
 * 目录闸门的离线端到端测试 —— 用**真实的** `SubagentRuntime` 跑**真实的**闸门代码。
 *
 * <p>★★ 这个文件在守什么（WorkBuddy 现在是**进程外一次性** provider）★★
 *
 * <p>WorkBuddy 委派**不再**在进程内建 dsh 子会话。provider 的 `start()` 返回的是
 * `subprocessRunHandle()` 造出来的 run，里面 `localAgent` 写死为 `void 0`
 * （`dsh-subagent/lib/index.js:2651-2665`）。于是宿主那句
 * `if (run.localAgent?.session !== undefined) establishCatalogChild(...)`
 * （`:3130-3141`）**根本进不去**：父会话上不会出现 `subagent/catalog` 行，
 * 委派列表里也就没有可点开的 dsh 子会话。
 *
 * <p>这不是"漏了一条"，而是唯一诚实的读数：造一条点不开的行，等于给 UI 一个必然报错的入口。
 * WorkBuddy 委派在 dsh 里的可见性是**父对话里那次工具调用 + 它返回的结果**；
 * WorkBuddy 自己那条对话由 `sessionKey`（`src/host/subagent/provider.js:166-177`）串起来。
 * 所以下面那些 `length === 0` 是**被测的行为**，不是"还没做"。
 *
 * <p>★★ 三道闸，三道都守 ★★
 *
 * <p>① **授权闸**：`enabled !== true` ⇒ 一个 provider 都不注册
 * （`src/host/subagent/index.js:118-137`；出厂配置就是 `enabled: false`，见
 * `cordis.patch.yml:26,33`）。少了它，用户在没开授权时也会在委派面里看到 WorkBuddy。
 *
 * <p>② **能力闸**：调用方一旦索要 provider 声明为 `false` 的能力，宿主在
 * `provider.start()` **之前**就抛 `UNSUPPORTED_CAPABILITY`
 * （`dsh-subagent:3117` 调用、`:3172-3197` 判定），永不"收下了但做不到"。
 *
 * <p>③ **目录闸**：能力闸放行之后，进程外形状 ⇒ 父会话上**没有** `subagent/catalog` 行。
 *
 * <p>这三道里任何一道被"顺手放宽"，都是用户看得见的行为变化，所以每一道都在这里有正控。
 *
 * <p>★★ 负控怎么证明它不是空转 ★★
 *
 * <p>"没有 `localAgent` ⇒ 0 条目录事件"这种断言最容易写成永远绿的假阳性：计数器自己坏了，
 * 怎么数都是 0。所以本文件对**同一个计数器**都做了一次非平凡性自检：
 * 注册闸的计数器在 `enabled: true` 时数到 1、拨回 `false` 再数回 0；
 * 目录闸的计数器在 provider **真的**带回 `localAgent.session` 时数到 1（最后一条）。
 *
 * <p>宿主服务链（cordis service 装载、projection 注册、session 持久化）不在这里重建：
 * 本测试只断言闸门自己的输入与输出。
 *
 * @module plugin-workbuddy/test/catalog-gate
 */

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent';
import { reconcileSubagentProvider } from '../src/host/subagent/index.js';
import { PROVIDER_NAME, createWorkBuddyProvider } from '../src/host/subagent/provider.js';

/**
 * 真实调用面下发的任务正文形状 —— `ContentBlock[]`，**不是**裸字符串。
 *
 * <p>★ 这条是实测出来的，不是照着类型签名抄的 ★
 *
 * <p>provider 把 `prompt` 交给 `promptText()` 压成一段文本
 * （`src/host/subagent/prompt.js:72-87`），而它只认 `{ type: 'text', text }` 块。
 * 裸字符串进去会得到空文本，provider 随即落进 `nothing to send` 那条分支
 * （`provider.js:268-272`），**走不到执行口那一步**，诊断文本也就不是被测的那一句。
 * 真实调用面正是构造块的（`dsh-tool-subagent/lib/index.js:511-514`）。
 *
 * @param {string} text
 * @returns {Array<{type: string, text: string}>}
 */
function realPrompt(text) {
  return [{ type: 'text', text }];
}

/**
 * 一个只记事的假 Session。
 *
 * <p>只实现宿主在这条链路上**真正读到**的东西：header（`id` / `cwd` /
 * `delegationDepth`）、`append()`、`requestHeader()`、`snapshotEvents()`。
 * 多实现一行就多一处"我以为宿主会读它"的臆测，所以刻意不加。
 *
 * <p>★ `cwd` 必须是**真实存在**的绝对目录：宿主解子任务工作目录时会真的去看它
 * （`resolveChildCwd` → `assertUsableCwd`，`dsh-subagent:2564-2601`），
 * 假路径会当场抛。系统临时目录是这里最省事又必然成立的选择。
 *
 * @param {object} [headerExtra] 追加进 header 的字段（可覆盖 `cwd`）
 * @returns {object}
 */
function fakeSession(headerExtra = {}) {
  const events = [];
  return {
    events,
    seq: 0,
    inheritedEventCount: 0,
    header: {
      id: `session-${events.length}-${headerExtra.id ?? 'root'}`,
      createdAt: 1_700_000_000_000,
      cwd: tmpdir(),
      ...headerExtra,
    },
    append(type, data) {
      this.seq += 1;
      events.push({ seq: this.seq, type, data });
    },
    requestHeader() {
      return undefined;
    },
    snapshotEvents() {
      return events;
    },
  };
}

/**
 * 假父 Agent。
 *
 * <p>★ `ctx.agents.create()` **一被调用就抛** ★
 * 旧实现是在这里造一个进程内子会话，好让"点得开"那一半跑通。那条路已经不存在了，
 * 所以现在这个假父的作用反过来：它是"进程外 provider 不得建 dsh 子会话"的**探针**。
 * 谁要是把 `localAgent` 加回 provider，这里立刻炸，而不是悄悄多出一条目录行。
 * `childSpawns.attempts` 让"一次都没试过"成为可观测的事实。
 *
 * @returns {object}
 */
function fakeParentAgent() {
  const session = fakeSession({ id: 'parent-session' });
  const childSpawns = { attempts: 0 };
  return {
    session,
    childSpawns,
    options: { provider: 'deepseek', model: 'deepseek-chat' },
    ctx: {
      get() {
        return undefined;
      },
      agents: {
        async create() {
          childSpawns.attempts += 1;
          throw new Error('进程外 provider 不得建 dsh 子会话：WorkBuddy 委派没有 localAgent');
        },
      },
    },
  };
}

/** 真实的运行时：闸门、capability 校验、目录投影全走宿主真代码。 */
function realRuntime() {
  return new SubagentRuntime(new Context(), SubagentRuntime.Config({ maxDepth: 1, maxActiveSubagents: 8 }));
}

/**
 * 走一次**真实闸门**：真 `SubagentRuntime` + 真 provider。
 *
 * <p>★ 请求形状是刻意的：只传 `label` / `prompt` / `parent` / `signal` ★
 * 这正是真实调用面会传的东西。`dsh-tool-subagent` 只在字段**有值**时才展开
 * `agentOptions` / `persona` / `toolFilter` / `maxDepth`
 * （`dsh-tool-subagent/lib/index.js:508-520`，且 `agentOptions` 的 schema 默认是 `void 0`），
 * 而本插件的配置行这几项全空、`maxDepth` 是 `provider-managed`
 * （`resolveMaxDepth` → `void 0`，`dsh-subagent:2856-2869`）。
 *
 * <p>这一条很要紧：provider 的能力面**逐项 false**，真实请求又**恰好一项都不碰**，
 * 两者合起来才是线上能跑通的原因。多传一个 `maxDepth: 1` 或 `agentOptions`，
 * 能力闸就会在 `provider.start()` 之前把请求拒掉（那正是下面能力闸负控在做的事）。
 *
 * @param {object} [deps]
 * @param {object} [deps.provider] 要注册的 provider，默认真实的 `createWorkBuddyProvider()`
 * @returns {Promise<{runtime: object, parent: object, run: object}>}
 */
async function startThroughRealGate({ provider = createWorkBuddyProvider() } = {}) {
  const runtime = realRuntime();
  runtime.registerProvider(provider);
  const parent = fakeParentAgent();
  const run = await runtime.start(PROVIDER_NAME, {
    parent,
    prompt: realPrompt('你好'),
    signal: new AbortController().signal,
    label: 'wb-child',
  });
  return { runtime, parent, run };
}

/**
 * 父会话上的目录事件 —— 这就是委派列表（projection）的**唯一**输入。
 * 别的地方（`subagent/start` / `subagent/end`）走的是运行时的生命周期通道，
 * 不落在父会话里，所以不在这里断言。
 */
function catalogEvents(parent) {
  return parent.session.events.filter((event) => event.type === 'subagent/catalog');
}

/**
 * 与真实 provider **形状相同**的假 provider：能力面逐项 false、不继承父上下文、
 * `start()` 直接返回进程外形状的 run。
 *
 * <p>唯一可调的是 `localAgent` —— 好让目录闸的负控与自检**只差这一个变量**：
 * 同一个请求、同一套能力面、同一个真闸门，只把 `localAgent` 从 `undefined`
 * 换成 `{ session }`，父会话上的目录事件就必须从 0 变成 1。
 *
 * @param {object|undefined|null} localAgent
 * @returns {object}
 */
function outOfProcessLikeProvider(localAgent) {
  return {
    name: PROVIDER_NAME,
    capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
    inheritsParentContext: false,
    async start(request) {
      return {
        id: `run-${request.label ?? 'x'}`,
        localAgent,
        result: Promise.resolve({ output: [], stopReason: 'completed' }),
        async dispose() {},
      };
    },
  };
}

/**
 * 假宿主 ctx：只实现 `reconcileSubagentProvider()` 真正用到的三样东西
 * （`ctx.inject(['subagents'])`、`sctx.effect()`、`sctx.on()`）与
 * `ctx.subagents.registerProvider()`。
 *
 * <p>★ 重名照抄真服务的硬抛 ★（`dsh-subagent:3079` 的 `DUPLICATE_PROVIDER`）：
 * 否则"没有重复注册"就退化成"没被检查"。
 *
 * @returns {object}
 */
function fakeHostCtx() {
  const registrations = [];
  const listeners = new Map();
  const logs = [];
  let effectBody = null;

  const sctx = {
    effect(body) {
      effectBody = body;
      return () => {
        effectBody = null;
      };
    },
    on(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
      return () => {
        const list = listeners.get(type) ?? [];
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
  };

  const ctx = {
    subagents: {
      registerProvider(provider) {
        if (registrations.some((registered) => registered.name === provider.name)) {
          throw new Error(`a subagent provider named "${provider.name}" is already registered`);
        }
        registrations.push(provider);
        return () => {
          const index = registrations.indexOf(provider);
          if (index >= 0) registrations.splice(index, 1);
        };
      },
    },
    inject(services, callback) {
      assert.deepEqual(services, ['subagents'], '收敛器只注入 `subagents` 一个服务');
      const fiber = callback(sctx);
      return {
        dispose() {
          fiber?.();
        },
      };
    },
  };

  return {
    ctx,
    registrations,
    logs,
    /** 真实时机：服务就位时 `sctx.effect()` 跑一次，此后每次 volatile 更新重跑。 */
    mountEffect() {
      assert.notEqual(effectBody, null, '`ctx.inject()` 必须先把 effect 装进来');
      effectBody();
    },
    /** 触发一次已注册的宿主事件（如 `loader/volatile-update`）。 */
    fire(type) {
      for (const handler of listeners.get(type) ?? []) handler();
    },
  };
}

/**
 * 假插件运行时：`reconcileSubagentProvider()` 只读它四样东西
 * （`current()` / `currentConfig()` / `detected()` / `onDetected()`，
 * 见 `src/host/subagent/index.js:63`）。
 *
 * @param {object|undefined} config 设置投影（`enabled` 是授权总闸）
 * @returns {object}
 */
function fakePluginRuntime(config) {
  const detectedListeners = [];
  return {
    /** 探测三态：`null` = 还没探过（乐观注册），否则看 `installed`。 */
    probe: null,
    current: () => config,
    currentConfig: () => config,
    detected() {
      return this.probe;
    },
    onDetected(handler) {
      detectedListeners.push(handler);
      return () => {
        const index = detectedListeners.indexOf(handler);
        if (index >= 0) detectedListeners.splice(index, 1);
      };
    },
    fireDetected() {
      for (const handler of [...detectedListeners]) handler();
    },
  };
}

// ─────────────────────────── ① 授权闸 ───────────────────────────

test('正控（授权闸）：`enabled !== true` ⇒ 一个 provider 都不注册', () => {
  // 出厂配置就是 `enabled: false`（`cordis.patch.yml:26,33`）。这里的判据是硬读 `=== true`：
  // 缺字段、`false`、以及"看起来像真值的字符串/数字"都**不算**授权。
  for (const config of [{}, { enabled: false }, { enabled: 'true' }, { enabled: 1 }]) {
    const host = fakeHostCtx();
    reconcileSubagentProvider(host.ctx, {
      runtime: fakePluginRuntime(config),
      NS: 'plugin-workbuddy',
      dispatch: {},
      log: (message) => host.logs.push(message),
    });
    host.mountEffect();
    assert.equal(host.registrations.length, 0, `enabled=${JSON.stringify(config.enabled)} 时不该注册`);
    assert.deepEqual(host.logs, []);
  }

  // 设置投影整个读不出来（运行时还没就绪）也必须是不注册，而不是抛。
  const host = fakeHostCtx();
  reconcileSubagentProvider(host.ctx, {
    runtime: fakePluginRuntime(undefined),
    NS: 'plugin-workbuddy',
    dispatch: {},
  });
  host.mountEffect();
  assert.equal(host.registrations.length, 0, '设置读不出来 ⇒ 授权无从谈起 ⇒ 不注册');
});

test('正控（授权闸自检）：同一个计数器在 `enabled === true` 时确实数到 1，关掉再数回 0', () => {
  const host = fakeHostCtx();
  const config = { enabled: false };
  const runtime = fakePluginRuntime(config);
  const uninstall = reconcileSubagentProvider(host.ctx, {
    runtime,
    NS: 'plugin-workbuddy',
    dispatch: {},
    log: (message) => host.logs.push(message),
  });
  host.mountEffect();
  assert.equal(host.registrations.length, 0);

  config.enabled = true;
  host.fire('loader/volatile-update');
  assert.deepEqual(host.logs, [], '注册失败会被 catch 吞掉并落日志 ⇒ 这里必须一条日志都没有');
  assert.equal(host.registrations.length, 1, '同一个计数器必须数得到 1，否则上面那个 0 是空转');
  assert.equal(host.registrations[0].name, PROVIDER_NAME);
  assert.equal(typeof host.registrations[0].start, 'function');

  // 仍然 enabled 时再收敛一次：实例**按引用**复用（`src/host/subagent/index.js:76-82`），
  // 绝不重复注册。真服务对重名是硬抛，假服务照抄了那一条，所以这里是真的被检测。
  const first = host.registrations[0];
  host.fire('loader/volatile-update');
  assert.equal(host.registrations.length, 1, '重复注册会被假服务当场抛成 DUPLICATE_PROVIDER');
  assert.equal(host.registrations[0], first, 'provider 实例只造一次，按引用复用');
  assert.deepEqual(host.logs, []);

  config.enabled = false;
  host.fire('loader/volatile-update');
  assert.equal(host.registrations.length, 0, '关掉授权总闸 ⇒ 必须撤下注册');

  // 卸载路径：插件被 dispose 时必须撤下 provider，别把注册留在服务上。
  config.enabled = true;
  host.fire('loader/volatile-update');
  assert.equal(host.registrations.length, 1);
  uninstall();
  assert.equal(host.registrations.length, 0, '卸载收敛器 ⇒ 撤下注册');
});

test('正控（授权闸）：探测落地说"没装" ⇒ 即便 enabled 也撤下注册；说"装了" ⇒ 注册回来', () => {
  const host = fakeHostCtx();
  const runtime = fakePluginRuntime({ enabled: true });
  reconcileSubagentProvider(host.ctx, { runtime, NS: 'plugin-workbuddy', dispatch: {} });
  host.mountEffect();
  assert.equal(host.registrations.length, 1, '还没探过（null）⇒ 乐观注册');

  runtime.probe = { installed: false };
  runtime.fireDetected();
  assert.equal(host.registrations.length, 0, '探测落地说没装 ⇒ 撤下');

  runtime.probe = { installed: true };
  runtime.fireDetected();
  assert.equal(host.registrations.length, 1, '装好了 ⇒ 注册回来');
});

// ─────────────────────────── ② 能力闸 ───────────────────────────

test('正控（能力面契约）：五项能力逐项 false，且没有续用口、没有路由默认值', () => {
  const provider = createWorkBuddyProvider();
  assert.deepEqual(
    provider.capabilities,
    { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
    '进程外后端一项都不承诺：声明 true 而实际忽略，就是把调用方的要求静默吞掉',
  );
  assert.equal(provider.inheritsParentContext, false, 'WorkBuddy 有自己的对话历史，父上下文搬不过去也不该搬');
  assert.equal(
    provider.prepareContinuable,
    undefined,
    '方法存在**就是**能力（`dsh-subagent:3149-3152` 按这个判）；没有可续的 dsh 子会话，这个口就不能有',
  );
  assert.equal(
    provider.agentRouteDefaults,
    undefined,
    '刻意不写：写了会让工具面先做一次没有适配器的模型路由预检',
  );
});

test('负控（能力闸）：索要 provider 声明为 false 的能力 ⇒ 闸门前抛 UNSUPPORTED_CAPABILITY', async () => {
  // ★ 一次只索要**一项** ★
  // 混着传是查不出"到底哪一项被忽略"的：`assertCapabilities` 按
  // agentOptions → outputSchema → depthLimit → toolFilter → persona 的顺序判，
  // 一次传 `maxDepth + toolFilter` 只会先撞上 `depthLimit`，toolFilter 那半根本没被验证到。
  const cases = [
    { request: { agentOptions: { provider: PROVIDER_NAME } }, capability: 'agentOptions' },
    { request: { outputSchema: { type: 'object' } }, capability: 'outputSchema' },
    { request: { maxDepth: 1 }, capability: 'depthLimit' }, // 请求侧叫 maxDepth，能力侧叫 depthLimit
    { request: { toolFilter: ['some-tool'] }, capability: 'toolFilter' },
    { request: { persona: '某人' }, capability: 'persona' },
  ];

  for (const { request, capability } of cases) {
    const runtime = realRuntime();
    runtime.registerProvider(createWorkBuddyProvider());
    const parent = fakeParentAgent();
    await assert.rejects(
      () =>
        runtime.start(PROVIDER_NAME, {
          parent,
          prompt: realPrompt('你好'),
          signal: new AbortController().signal,
          ...request,
        }),
      (error) => {
        assert.equal(error.code, 'UNSUPPORTED_CAPABILITY', `${capability} 必须以 UNSUPPORTED_CAPABILITY 拒绝`);
        assert.match(error.message, new RegExp(`"${capability}"`), `错误消息必须指名 ${capability}`);
        return true;
      },
    );
    assert.equal(catalogEvents(parent).length, 0, '闸门前抛错 ⇒ 一条目录事件都不该有');
    assert.equal(parent.childSpawns.attempts, 0, '闸门前抛错 ⇒ 连子会话都不该试建');
  }
});

test('负控（续用面）：`prepareContinuable` 一律被拒 —— 旧的"可续子会话"路径已经不存在', async () => {
  // 这条替代了旧的 continuable 目录行：`dsh-tool-subagent` 只有在 provider 有
  // `prepareContinuable` 时才允许 `backgroundMode: continuable`（`:380`），
  // 本 provider 没有 ⇒ 续用端子智能体这条路是**关着**的，而且关得能被测出来。
  const runtime = realRuntime();
  runtime.registerProvider(createWorkBuddyProvider());
  await assert.rejects(
    () => runtime.prepareContinuable(PROVIDER_NAME, {}),
    (error) => {
      assert.equal(error.code, 'UNSUPPORTED_CAPABILITY');
      assert.match(error.message, /does not support continuable children/);
      return true;
    },
  );
});

// ─────────────────────────── ③ 目录闸 ───────────────────────────

test('正控（真实链路）：真实 provider 走真实闸门 ⇒ run 是进程外形状，父会话上没有目录行', async () => {
  const { parent, run } = await startThroughRealGate();

  assert.equal(typeof run.id, 'string');
  assert.ok(run.id.length > 0);
  assert.equal(typeof run.dispose, 'function');
  assert.equal(run.localAgent, undefined, '进程外：没有 dsh 子会话，就没有可交出去的 Agent');

  const settled = await run.result;
  assert.equal(settled.stopReason, 'error');
  assert.deepEqual(settled.output, []);
  assert.match(
    String(settled.diagnostic),
    /no execution outlet is wired/,
    '本测试只装 provider 不装执行口（runTask 缺位），provider 必须如实回报而不是抛（provider.js:273-276）',
  );

  // ★ 核心读数：这里为什么**必须是 0**，而不是"还差一条" ★
  // 进程外 provider 不建进程内子会话 ⇒ `run.localAgent` 是 `void 0` ⇒ 宿主那句
  // `if (run.localAgent?.session !== undefined) establishCatalogChild(...)`（`dsh-subagent:3130-3141`）
  // 根本进不去 ⇒ 父会话上没有 `subagent/catalog` 行。这条行就是委派列表（projection）的唯一输入，
  // 所以"没有行"= 列表里没有这一条，且**没有可点开的 dsh 子会话**。
  // 这是设计而不是缺口：造一条点不开的行，等于给 UI 一个必然报错的入口。
  // WorkBuddy 委派在 dsh 里的可见性 = 父对话里那次工具调用 + 它返回的结果；
  // WorkBuddy 自己那条对话由 `sessionKey` 串起来（`provider.js:166-177`）。
  assert.equal(catalogEvents(parent).length, 0, '进程外一次性 run ⇒ 父会话上不该有 subagent/catalog');
  assert.equal(parent.childSpawns.attempts, 0, '进程外委派不得建进程内子会话');
});

test('负控（正文整形）：裸字符串正文 ⇒ 如实回报"没有可下发的正文"，而不是静默当作空任务去跑', async () => {
  // 这一条解释上面为什么必须用 `realPrompt()`：正文整形这一步是真会丢内容的。
  // 非 `ContentBlock[]`（或没有文本块）的输入压出来是空串，provider 必须在**下发之前**
  // 就停住并留下可读诊断（`provider.js:268-272`），不能把它当一次"空任务"送给后端 ——
  // 那会让模型收到一条无内容的委派却看起来一切正常。
  const runtime = realRuntime();
  runtime.registerProvider(createWorkBuddyProvider());
  const parent = fakeParentAgent();
  const run = await runtime.start(PROVIDER_NAME, {
    parent,
    prompt: '你好',
    signal: new AbortController().signal,
    label: 'wb-child',
  });

  const settled = await run.result;
  assert.equal(settled.stopReason, 'error');
  assert.deepEqual(settled.output, []);
  assert.match(String(settled.diagnostic), /nothing to send/, '丢内容必须留痕，且诊断要点明是正文缺位');
  assert.equal(catalogEvents(parent).length, 0);
});

test('正控（请求形状）：真实调用面只传 label/prompt/parent/signal ⇒ 全 false 的能力面不挡路', async () => {
  let seen = null;
  const real = createWorkBuddyProvider();
  const recording = {
    ...real,
    start(request) {
      seen = request;
      return real.start(request);
    },
  };
  const { parent } = await startThroughRealGate({ provider: recording });

  assert.notEqual(seen, null, 'provider.start() 必须真的被调用（能力闸放行了）');
  assert.deepEqual(seen.prompt, realPrompt('你好'), '正文按 `ContentBlock[]` 下发，provider 靠 `promptText()` 压成文本');
  for (const key of ['agentOptions', 'outputSchema', 'toolFilter', 'persona', 'maxDepth']) {
    assert.equal(key in seen, false, `真实调用面不该带 ${key}（dsh-tool-subagent:508-520 只在有值时展开）`);
  }
  assert.deepEqual(
    Object.keys(seen).sort(),
    ['descriptor', 'label', 'parent', 'prompt', 'signal'],
    '宿主只补一个 descriptor，别的不许凭空多出来',
  );
  assert.equal(seen.descriptor.mode, 'one-shot');
  assert.equal(seen.descriptor.provider, PROVIDER_NAME);
  assert.equal(seen.descriptor.label, 'wb-child');
  assert.equal(catalogEvents(parent).length, 0);
});

test('负控（目录闸）：localAgent 是 undefined ⇒ 父会话上没有任何目录事件', async () => {
  const { parent } = await startThroughRealGate({ provider: outOfProcessLikeProvider(undefined) });
  assert.equal(catalogEvents(parent).length, 0);
});

test('负控（目录闸）：localAgent 是 null ⇒ 同样不建目录项（`?.` 短路后是 null 而非 undefined）', async () => {
  const { parent } = await startThroughRealGate({ provider: outOfProcessLikeProvider(null) });
  assert.equal(catalogEvents(parent).length, 0);
});

test('负控（目录闸）：localAgent 在、但 session 是 undefined ⇒ 不建目录项', async () => {
  const { parent } = await startThroughRealGate({ provider: outOfProcessLikeProvider({ id: 'not-an-agent' }) });
  assert.equal(catalogEvents(parent).length, 0);
});

test('负控自检：同一个计数器在 provider 真的带回 localAgent.session 时确实数到 1（负控不是空转）', async () => {
  // 与真实 provider 的唯一差别就是这一处 `localAgent`：请求、能力面、闸门全同。
  // 它证明上面那些 0 是**被测出来的**，而不是计数器本身坏了。
  const childSession = fakeSession({ id: 'fake-child-session' });
  const { parent } = await startThroughRealGate({
    provider: outOfProcessLikeProvider({ session: childSession }),
  });

  const events = catalogEvents(parent);
  assert.equal(events.length, 1, '同一个计数器必须数得到 1，否则上面那些 0 全是空转');

  const data = events[0].data;
  assert.deepEqual(Object.keys(data).sort(), ['childCreatedAt', 'childId', 'label', 'mode', 'version']);
  assert.equal(data.version, 0);
  assert.equal(data.mode, 'one-shot');
  assert.equal(data.label, 'wb-child');
  assert.equal(data.childId, childSession.header.id, 'childId 来自子会话 header，不是 run.id');
  assert.equal(data.childCreatedAt, childSession.header.createdAt);

  // 反过来再钉一次：同一个计数器对一个空父会话必须是 0，否则上面那句 1 也没意义。
  assert.equal(catalogEvents(fakeParentAgent()).length, 0);
});
