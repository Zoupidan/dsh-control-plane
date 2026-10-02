/**
 * `src/host/subagent/provider.js` —— 出进程「一次性子智能体提供者」的边界测试。
 *
 * ★ 这个文件在 2026-10-XX 被整篇重写过，原因值得写在这里，免得后人以为是随手改的：
 *   本插件原先在 `workbuddy` 路由上注册过一个 **LLM 适配器**（`llm-adapter.js`）。
 *   那件事的实质是**反向代理** —— 让 dsh 的对话循环跑在 WorkBuddy 上，父会话的
 *   每一轮 turn 都从这条路由过。它被判定为不该存在，源码已删除。
 *   现在 WorkBuddy 只是**出进程的一次性子智能体提供者**：父智能体调一次、拿一段文本、
 *   结束。唯一的执行出口是 `createTaskExecutor()`。
 *
 * 于是本文件的两条主线是：
 *   1. **不许回头**：反向代理留下的两个钩子（`agentRouteDefaults`、`prepareContinuable`）
 *      必须**明确缺席** —— 用 `in` / `=== undefined` 断言，不是"没测到"。
 *   2. **新面子的真实行为**：注入 `runTask` / `readConfig` 假件，把 `start()` 真跑一遍，
 *      看它下发了什么、收尾成什么、什么时候才肯抛。
 *
 * 不测的东西（如实说明为什么测不了）：
 *   - `establishCatalogChild` 是模块内私有的，只能经 `start()` 观察；本文件的做法是
 *     给 `runTask` 记账，看它**真的**收到了什么，而不是去读内部状态。
 *   - `localAgent`：本提供者**没有** dsh 侧的 Agent（WorkBuddy 是另一个进程），
 *     所以这里断言的是它 `undefined`。真正的「有 Agent」路径由 `dsh-subagent` 自己测。
 *   - 把 provider 注册进 `ctx.subagents`（`reconcileSubagentProvider`）不在本文件：
 *     那需要一整个 ctx，属于 `catalog-gate.test.js` 那一侧的面。
 *   - `taskTitle` / `clip` / `flatten` 都是模块内私有的，只能从 `runTask` 收到的
 *     `name`、或日志行里间接观察（本文件就是这么做的）。
 *
 * ★ 一个反复踩到的坑，写在这儿免得再踩 ★
 *   `start()` 是 `async` ⇒ 它交出来的是 **handle 的 Promise**，不是 handle。于是：
 *     1. `provider.start(x).localAgent` / `.id` / `.dispose()` —— 全是 `undefined`，
 *        `run.dispose is not a function` 才是它的真面目。
 *     2. `await provider.start(x).result` —— 点号比 `await` 绑得紧，实际是
 *        `await (promise.result)`，也就是 `await undefined`；`result` 一路是 `undefined`，
 *        断言**静默空转**（不抛，只是什么都没验）。这一种最阴，别写成这样。
 *   本文件两种写法都出现、都安全：`const run = await provider.start(x)` 之后取
 *   `.result` / `.dispose()`，或者 `await (await provider.start(x)).result` 一步到位。
 *
 * @module test/subagent-provider
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NO_START_CAPABILITIES } from '@deepseek-ai/dsh-subagent';

import {
  FORCED_NON_INTERACTIVE_MODE,
  NON_INTERACTIVE_MODES,
  PERMISSION_NOTE_MARK,
  RECEIPT_NOTE_MARK,
  WORKBUDDY_PROVIDER_ID,
  effectiveSessionMode,
  permissionNote,
} from '../src/host/subagent/notes.js';
import { OMITTED_BLOCK_PREFIX } from '../src/host/subagent/prompt.js';
import { createWorkBuddyProvider, PROVIDER_NAME, sessionKeyFor } from '../src/host/subagent/provider.js';

const PREFIX = 'dsh-plugin-workbuddy: subagent provider workbuddy';

/** 真目录：`cwd` 必须存在且可进入，所以不能拿字面量凑。 */
const TMP = mkdtempSync(join(tmpdir(), 'dsh-wb-provider-test-'));
const CONFIG_CWD = mkdtempSync(join(tmpdir(), 'dsh-wb-provider-config-'));
const PARENT_CWD = mkdtempSync(join(tmpdir(), 'dsh-wb-provider-parent-'));

test.after(() => {
  for (const dir of [TMP, CONFIG_CWD, PARENT_CWD]) rmSync(dir, { recursive: true, force: true });
});

/** 把告示标记（含 `[` `]`）转成能塞进 `assert.match` 的正则。 */
function markRe(mark) {
  return new RegExp(mark.replace(/[[\]]/g, '\\$&'));
}

/**
 * 一个"父会话"的最小可信形状。
 *
 * ★ 读的是 `parent.session.header` ★
 * provider 只从 `request.parent.session.header` 取 `id` / `cwd`（provider.js:226-229）。
 * 旧适配器时代的假父件读的是 `session.requestHeader()` —— 那是另一条路，这里用不上。
 */
function startRequest({ label = 'demo task', prompt = 'do it', cwd = PARENT_CWD, id = 'parent-1', signal } = {}) {
  const request = {
    label,
    prompt: [{ type: 'text', text: prompt }],
    parent: { session: { header: { id, cwd } } },
  };
  if (signal !== undefined) request.signal = signal;
  return request;
}

/** 一份"跑成功"的 runTask 回执，形状照 `execute.js` 的 `reportFromAutomation`。 */
function okReport(text, permission = { requested: 'bypassPermissions', confirmed: true }) {
  return { ok: true, reason: 'done', text, permission, sessionId: 'acp-1', sessionOrigin: 'new' };
}

/** 记账的 runTask：把每次收到的参数原样留下来，回执由调用方给。 */
function recordingRun(report, { calls = [], logs = [] } = {}) {
  return {
    calls,
    logs,
    runTask: async (arg) => {
      calls.push(arg);
      return report;
    },
  };
}

/**
 * 一个既记账、又能被外部推完的 runTask（用来测"还没跑完就中止"）。
 *
 * 默认行为照**执行层的契约**：`provider.js:348` 明说"执行层在信号被中止时才返回"，
 * 所以这里也在 abort 时结算 —— 假件不照这个契约做，测出来的就不是"取消能不能收成
 * `aborted`"，而是"假件会不会永远挂着"（挂住是超时，不是失败，最难查）。
 *
 * `ignoreCancel: true` 用来模拟**远端不配合**（`provider.js:343` 那句"不假设远端会配合"）：
 * 取消来了它也不返回，只有外部 `settle()` 能推完它。
 */
function deferredRun({ ignoreCancel = false } = {}) {
  const calls = [];
  let settle;
  const promise = new Promise((resolve) => { settle = resolve; });
  return {
    calls,
    settle,
    runTask: (arg) => {
      calls.push(arg);
      if (!ignoreCancel) {
        arg.signal.addEventListener('abort', () => settle({ ok: false, reason: 'cancelled' }), { once: true });
      }
      return promise;
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 【不许回头】反向代理的痕迹必须是"明确缺席"，不是"没测到"
// ───────────────────────────────────────────────────────────────────────────

test('★否定式★ provider：`agentRouteDefaults` 必须**不存在** —— 它就是反向代理的注册面', () => {
  const provider = createWorkBuddyProvider({});
  assert.equal(
    'agentRouteDefaults' in provider,
    false,
    '这个字段一旦出现，说明 provider 又想替父会话定引擎/模型 —— 那正是被删掉的那件事',
  );
});

test('★否定式★ provider：`prepareContinuable` 必须**不存在** —— 一次性子智能体没有"下一轮"', () => {
  const provider = createWorkBuddyProvider({});
  assert.equal(
    provider.prepareContinuable,
    undefined,
    '出现它就意味着要续接会话 —— 出进程一次性委派做不到，别在接口上假装能做到',
  );
});

test('provider：对外只有这四个面（多出来的一个都要问一句它是干什么的）', () => {
  const provider = createWorkBuddyProvider({});
  assert.deepEqual(Object.keys(provider), ['name', 'capabilities', 'inheritsParentContext', 'start']);
});

test('provider：名字与引擎是同一个 provider id（注册面与执行面对不上 = 委派起不来）', () => {
  const provider = createWorkBuddyProvider({});
  assert.equal(provider.name, 'workbuddy');
  assert.equal(PROVIDER_NAME, WORKBUDDY_PROVIDER_ID);
  assert.equal(provider.name, WORKBUDDY_PROVIDER_ID);
});

test('provider：能力面全关 —— 且与 dsh 的 `NO_START_CAPABILITIES` 逐字一致', () => {
  const { capabilities } = createWorkBuddyProvider({});

  // ① 对着宿主常量比：宿主改了常量、插件没跟上，这条会红。
  assert.deepEqual(capabilities, NO_START_CAPABILITIES, 'dsh 的契约是"需要任何一项就在 start 之前拒掉"，不许接受后再忽略');

  // ② 再对着**字面量**比一遍：宿主常量本身变了也要红。
  //    只比宿主常量的话，两边一起变成 `true` 就没人拦得住。
  assert.deepEqual(capabilities, {
    agentOptions: false,
    outputSchema: false,
    depthLimit: false,
    toolFilter: false,
    persona: false,
  });

  assert.equal(capabilities.toolFilter, false, '开着它就是给越权留后门：调用方不许给本子智能体开 dsh 工具');
  assert.equal(capabilities.outputSchema, false, '结构化输出需要一个 dsh 侧工具，本子智能体一个都没有');
  assert.equal(capabilities.agentOptions, false, '引擎与模型不由父会话指定，由 WorkBuddy 那一侧定');
});

test('provider：`inheritsParentContext` 关闭 —— WorkBuddy 的历史搬不过来，就别假装继承', () => {
  assert.equal(createWorkBuddyProvider({}).inheritsParentContext, false);
});

// ───────────────────────────────────────────────────────────────────────────
// 【取舍①】权限档：只放过真非交互档
// ───────────────────────────────────────────────────────────────────────────

test('取舍①：`effectiveSessionMode` 只放过真非交互档，其余一律强制', () => {
  for (const mode of NON_INTERACTIVE_MODES) {
    const got = effectiveSessionMode(mode);
    assert.equal(got.mode, mode, `${mode} 是用户的显式选择，要照办`);
    assert.equal(got.forced, false);
    assert.equal(got.configured, mode);
  }

  // ★ 首尾空白先 trim 再判档 ★：`'bypassPermissions '` 是**同一个档**，不是"不认识的值"。
  //   （这一条原先被错放进下面的反向对照里，于是"它被判成该强制"成了断言失败 ——
  //    错的是断言，不是源码：`notes.js` 的 `raw = configured.trim()` 就是先归一再判。
  //    放这里正面钉住，免得下次又有人按字面看字符串。）
  const padded = effectiveSessionMode('bypassPermissions ');
  assert.equal(padded.mode, 'bypassPermissions', 'trim 之后还是同一个档，要照办');
  assert.equal(padded.forced, false);
  assert.equal(padded.configured, 'bypassPermissions', '`configured` 报的是 trim 之后的值，不是原样的脏串');

  // 反向对照：任何"会弹窗等人点"的档都不能放过去 —— 无人值守时那是一个永远不来的回答。
  for (const mode of ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'delegate', '', undefined, null]) {
    const got = effectiveSessionMode(mode);
    assert.equal(got.mode, FORCED_NON_INTERACTIVE_MODE, `${String(mode)} 不是非交互档，必须强制`);
    assert.equal(got.forced, true);
    assert.equal(got.configured, typeof mode === 'string' ? mode : '', '非字符串按"没配"处理，不许把 null 塞进 configured');
    assert.ok(got.why !== '', '强制了就要说得出为什么，别让读者猜');
  }
});

test('权限没被确认 ⇒ 告示落在**正文**里（只记内部字段 = 让它无声蒸发）', () => {
  const confirmed = permissionNote({ requested: 'bypassPermissions', confirmed: true, effective: 'bypassPermissions' });
  assert.equal(confirmed, '', '确认过的不用刷屏');

  const unconfirmed = permissionNote({ requested: 'bypassPermissions', confirmed: false, effective: 'default' });
  assert.match(unconfirmed, markRe(PERMISSION_NOTE_MARK));
  assert.match(unconfirmed, /"default"/, '必须同时给出读到的实际值，不替读者下结论');
});

test('取舍①：被强制的权限档**真的下发**到 runTask，不是只在返回值里宣称', async () => {
  const { calls, runTask } = recordingRun(okReport('ok'));
  const provider = createWorkBuddyProvider({ readConfig: () => ({ cwdRoot: CONFIG_CWD, sessionMode: 'default' }), runTask });

  const run = await provider.start(startRequest());
  await run.result;

  assert.equal(calls.length, 1);
  assert.equal(calls[0].permissionMode, FORCED_NON_INTERACTIVE_MODE, '没下发 = 用户在 WorkBuddy 那边会被弹窗卡死');

  // 反向对照：用户显式选了非交互档就照办，不改写。
  const passthrough = recordingRun(okReport('ok'));
  const p2 = createWorkBuddyProvider({
    readConfig: () => ({ cwdRoot: CONFIG_CWD, sessionMode: 'fullAccess' }),
    runTask: passthrough.runTask,
  });
  await (await p2.start(startRequest())).result;
  assert.equal(passthrough.calls[0].permissionMode, 'fullAccess');
});

test('权限没被确认 ⇒ 告示真的会进到子智能体的输出正文里', async () => {
  const { runTask } = recordingRun(okReport('正文', { requested: 'bypassPermissions', confirmed: false, effective: 'default' }));
  const provider = createWorkBuddyProvider({ readConfig: () => ({ cwdRoot: CONFIG_CWD }), runTask });

  const result = await (await provider.start(startRequest())).result;
  const text = result.output.map((b) => b.text).join('');
  assert.match(text, /^正文/, '正文必须仍在，告示是追加不是替换');
  assert.match(text, markRe(PERMISSION_NOTE_MARK));
  assert.equal(result.stopReason, 'completed', '告示是如实说明，不是失败');
});

// ───────────────────────────────────────────────────────────────────────────
// 【取舍③】亲和：落点是下发的 sessionKey
// ───────────────────────────────────────────────────────────────────────────

test('取舍③：`sessionKeyFor` 的亲和落点 —— 同输入同键、异标签分流、缺一即无', () => {
  const a = sessionKeyFor('p1', 'Fix the thing');
  const b = sessionKeyFor('p1', 'Fix the thing');
  assert.equal(a, b, '同一对输入必须给同一个键，否则"同一个任务"每轮都开新会话');
  assert.notEqual(sessionKeyFor('p1', 'Other thing'), a, '标签不同 = 不是同一个任务');
  assert.notEqual(sessionKeyFor('p2', 'Fix the thing'), a, '父会话不同必须分流');

  // ★ 空的一侧不是"退化成默认"，是**明确的没有亲和**（返回空串），调用方据此不开会话复用。
  assert.equal(sessionKeyFor('', 'Fix the thing'), '');
  assert.equal(sessionKeyFor('p1', ''), '');
  assert.equal(sessionKeyFor(undefined, 'x'), '');
  assert.equal(sessionKeyFor(null, 'x'), '', 'null 也是"没有父会话"，同样不许造出键来');

  // ★ 标签这一侧是**不对称**的，如实钉住而不是假装它也能兜底 ★
  //   `sessionKeyFor` 对父会话 id 做了 `flatten`（非字符串 → 空串 → 走"没有亲和"），
  //   但对标签**没有**做：`provider.js:169-170` 直接 `flatLabel.toLowerCase()`。
  //   所以标签给 undefined 会 `TypeError` 抛出来，而不是安静地返回空串。
  //   今天炸不到线上：唯一的调用点 `provider.js:229` 传的是 `flatten(request?.label)`，
  //   永远是字符串。这里把真实行为写下来，等哪天有人从别处调它就有据可依。
  assert.throws(() => sessionKeyFor('p1', undefined), TypeError, '标签侧的兜底并不存在 —— 别以为它会返回空串');
});

test('取舍③：亲和真的落到下发的 sessionKey —— 同会话复用、异会话分流', async () => {
  const { calls, runTask } = recordingRun(okReport('ok'));
  const provider = createWorkBuddyProvider({ readConfig: () => ({ cwdRoot: CONFIG_CWD }), runTask });

  await (await provider.start(startRequest({ id: 'p1', label: 'Fix the thing' }))).result;
  await (await provider.start(startRequest({ id: 'p1', label: 'Fix the thing' }))).result;
  await (await provider.start(startRequest({ id: 'p1', label: 'Other thing' }))).result;
  await (await provider.start(startRequest({ id: 'p2', label: 'Fix the thing' }))).result;

  assert.equal(calls[0].sessionKey, calls[1].sessionKey, '同一父会话 + 同一标签 ⇒ 复用');
  assert.notEqual(calls[0].sessionKey, calls[2].sessionKey);
  assert.notEqual(calls[0].sessionKey, calls[3].sessionKey);
  assert.equal(calls[0].sessionKey, sessionKeyFor('p1', 'Fix the thing'), '下发的必须是同一个函数算出来的键');
  assert.match(calls[0].sessionKey, /^subagent:p1:fix-the-thing:[0-9a-f]{8}$/);
});

test('取舍③：没有标签 ⇒ 不下发 sessionKey（空串），但会话照样能跑', async () => {
  const { calls, runTask } = recordingRun(okReport('ok'));
  const provider = createWorkBuddyProvider({ readConfig: () => ({ cwdRoot: CONFIG_CWD }), runTask });

  const result = await (await provider.start(startRequest({ label: '', id: 'p1' }))).result;
  assert.equal(result.stopReason, 'completed');
  assert.equal(calls[0].sessionKey, '');
  assert.equal(calls[0].name, null, '没有标签就别编一个标题出来');
});

test('取舍③：标签再长也不撑爆标题与 slug（超长就截断，不是原样灌进去）', async () => {
  const { calls, runTask } = recordingRun(okReport('ok'));
  const provider = createWorkBuddyProvider({ readConfig: () => ({ cwdRoot: CONFIG_CWD }), runTask });

  const long = 'L'.repeat(80);
  await (await provider.start(startRequest({ label: long, id: 'p1' }))).result;

  // 标题（`provider.js:138-141`）：**保留原大小写**，只在第 60 字处剪断并留一个省略号。
  assert.equal(calls[0].name, `${'L'.repeat(60)}…`, '60 个字符 + 一个省略号，不能再长');
  // slug（`provider.js:169-174`）：为了给人眼认，**故意转小写** ——
  // 这里写死小写 `l`，谁把 `.toLowerCase()` 拿掉，这条就会红。
  assert.match(calls[0].sessionKey, /^subagent:p1:l{32}:[0-9a-f]{8}$/, 'slug 封顶 32 字符，且是小写形态');
  // ★ 摘要吃的是**完整、未转小写**的原标签（`provider.js:175`）★
  //   注释里说"slug 截断后两个长标签可能长得一样，摘要不会"——那就得能证明它真的不是从 slug 算的：
  //   构造一对只有大小写不同的标签，slug 段必须完全一样，整键必须不一样。
  const upper = sessionKeyFor('p1', long);
  const lower = sessionKeyFor('p1', long.toLowerCase());
  assert.equal(
    upper.split(':').slice(0, 3).join(':'),
    lower.split(':').slice(0, 3).join(':'),
    '只有大小写不同 ⇒ slug 段必须一样（不然大小写不该进摘要）',
  );
  assert.notEqual(upper, lower, '★ 摘要必须来自完整原标签，否则大小写不同的两件事会共用一条对话');
  assert.equal(calls[0].sessionKey, upper, 'provider 下发的键就是拿**原标签**算出来的那个');
});

test('取舍③：标签里没有可做 slug 的字符 ⇒ 退回 `task`，不是空 slug', () => {
  assert.match(sessionKeyFor('p1', '!!!'), /^subagent:p1:task:[0-9a-f]{8}$/);
});

// ───────────────────────────────────────────────────────────────────────────
// 【执行面】happy path 与结果形状
// ───────────────────────────────────────────────────────────────────────────

test('★ 执行面：正常跑完 ⇒ `completed` + 正文，且下发的参数就是记下来的那些', async () => {
  const { calls, runTask } = recordingRun(okReport('hello world'));
  const provider = createWorkBuddyProvider({ readConfig: () => ({ cwdRoot: CONFIG_CWD }), runTask });

  const run = await provider.start(startRequest());

  // ★ `localAgent` 必须是 `undefined`（而不是缺字段）：dsh 用它判"是不是有本地 Agent"。
  assert.equal(run.localAgent, undefined, 'WorkBuddy 是另一个进程，这里不许冒出一个本地 Agent');
  assert.equal(Object.hasOwn(run, 'localAgent'), true, '字段要在、值为 undefined —— 缺字段与"明确没有"是两件事');
  assert.equal(typeof run.id, 'string');
  assert.equal(typeof run.dispose, 'function');

  const result = await run.result;
  assert.deepEqual(result.output, [{ type: 'text', text: 'hello world' }]);
  assert.equal(result.stopReason, 'completed');

  // 成功路径上 diagnostic 必须**缺席**（不是空串）—— 见下面"回执"那组。
  assert.equal('diagnostic' in result, false);

  assert.deepEqual(calls[0], {
    prompt: 'do it',
    cwd: CONFIG_CWD,
    permissionMode: FORCED_NON_INTERACTIVE_MODE,
    model: '',
    sessionKey: sessionKeyFor('parent-1', 'demo task'),
    name: 'demo task',
    signal: calls[0].signal,
  });
  assert.ok(calls[0].signal instanceof AbortSignal, '必须把 signal 传下去，否则中止传不到 WorkBuddy');
});

test('★ 执行面：成功但正文为空 ⇒ 不产出空文本，明确写一句"没有正文"', async () => {
  const { runTask } = recordingRun(okReport(''));
  const provider = createWorkBuddyProvider({ readConfig: () => ({ cwdRoot: CONFIG_CWD }), runTask });

  const result = await (await provider.start(startRequest())).result;
  assert.equal(result.stopReason, 'completed');
  assert.match(result.output[0].text, /no text/, '空正文要有人话说明，不能是一段空白让父会话去猜');
  assert.equal('diagnostic' in result, false, '它不是失败，不该带 diagnostic');
});

test('★ 执行面：下发了配置里的 model，日志里也要看得见（不然排障只能靠猜）', async () => {
  const { calls, logs, runTask } = recordingRun(okReport('ok'));
  const provider = createWorkBuddyProvider({
    readConfig: () => ({ cwdRoot: CONFIG_CWD, model: 'glm-5.3' }),
    runTask,
    log: (line) => logs.push(line),
  });

  await (await provider.start(startRequest())).result;
  assert.equal(calls[0].model, 'glm-5.3');
  assert.ok(logs.some((l) => l.includes('model=glm-5.3')), '下发了什么模型，日志里必须留痕');
});

test('★ 执行面：模型没人钉 ⇒ 日志如实写"没人钉"，不假装有个默认模型', async () => {
  const { logs, runTask } = recordingRun(okReport('ok'));
  const provider = createWorkBuddyProvider({
    readConfig: () => ({ cwdRoot: CONFIG_CWD }),
    runTask,
    log: (line) => logs.push(line),
  });

  await (await provider.start(startRequest())).result;
  assert.ok(logs.length > 0, '一次委派至少要留下一行日志');
  assert.ok(logs.some((l) => l.includes('WorkBuddy side picks its own default')), '没人钉就说没人钉');
});

// ───────────────────────────────────────────────────────────────────────────
// 【失败面】每一种失败都要说得出卡在哪
// ───────────────────────────────────────────────────────────────────────────

test('失败面：runTask 报失败 ⇒ `error` + 诊断里有原因（不是一段"看起来成功"的空文本）', async () => {
  const { runTask } = recordingRun({ ok: false, reason: 'transport-dead', error: { message: 'no sidecar' } });
  const provider = createWorkBuddyProvider({ readConfig: () => ({ cwdRoot: CONFIG_CWD }), runTask });

  const result = await (await provider.start(startRequest())).result;
  assert.equal(result.stopReason, 'error');
  assert.deepEqual(result.output, [], '失败了就不该有正文 —— 半截文本会被当成答案');
  assert.match(result.diagnostic, /transport-dead/);
  assert.match(result.diagnostic, /no sidecar/);
});

test('★ 回执：失败带 failure.message ⇒ diagnostic 原样透出，父会话能读到卡在哪', async () => {
  const { runTask } = recordingRun({ ok: false, reason: 'gateway-unreachable', error: { message: 'boom' } });
  const provider = createWorkBuddyProvider({ readConfig: () => ({ cwdRoot: CONFIG_CWD }), runTask });

  const result = await (await provider.start(startRequest())).result;
  assert.equal(result.stopReason, 'error');
  assert.match(result.diagnostic, /gateway-unreachable/);
  assert.match(result.diagnostic, /boom/, '原始 message 必须原样透出，转述会把线索磨掉');
});

test('★ 回执：没有 failure ⇒ 也不许产出空 diagnostic（要 undefined，不是空串）', async () => {
  const { runTask } = recordingRun({ ok: false });
  const provider = createWorkBuddyProvider({ readConfig: () => ({ cwdRoot: CONFIG_CWD }), runTask });

  const result = await (await provider.start(startRequest())).result;
  assert.equal(result.stopReason, 'error');
  assert.notEqual(result.diagnostic, '', '空串会被当成"有诊断但读不出内容"');
  assert.ok(typeof result.diagnostic === 'string' && result.diagnostic.length > 0, '失败了就必须说得出话');
  assert.match(result.diagnostic, /unknown/, '不知道原因就说不知道，别留空');
});

test('★ 回执：failure.message 是空串 ⇒ 按"没有细节"处理，不产出只有前缀的空话', async () => {
  const { runTask } = recordingRun({ ok: false, reason: 'x', error: { message: '' } });
  const provider = createWorkBuddyProvider({ readConfig: () => ({ cwdRoot: CONFIG_CWD }), runTask });

  const result = await (await provider.start(startRequest())).result;
  assert.equal(result.stopReason, 'error');
  assert.match(result.diagnostic, /no detail/, '空 message 要落成"没有细节"，不是留一段空白');
});

test('★ 回执：失败时的阶段与回执摘要要进 diagnostic —— 否则"卡在哪"只能靠时间猜', async () => {
  const { runTask } = recordingRun({
    ok: false,
    reason: 'gateway-unreachable',
    error: { message: 'boom' },
    phases: ['db-open', 'awaiting-scheduler-tick'],
    receipt: { stopReason: 'end_turn', outcome: 'FAILED_MODEL_REQUEST', succeeded: false, traceId: 't-1' },
  });
  const provider = createWorkBuddyProvider({ readConfig: () => ({ cwdRoot: CONFIG_CWD }), runTask });

  const { diagnostic } = await (await provider.start(startRequest())).result;
  assert.match(diagnostic, /last phase reached: awaiting-scheduler-tick/, '要报**最后**到达的阶段，不是第一个');
  assert.match(diagnostic, /stopReason=end_turn/);
  assert.match(diagnostic, /outcome=FAILED_MODEL_REQUEST/);
});

test('失败面：runTask 自己抛 ⇒ 收成 `error`，诊断里带上抛出来的话（不是把异常捅给父会话）', async () => {
  const provider = createWorkBuddyProvider({
    readConfig: () => ({ cwdRoot: CONFIG_CWD }),
    runTask: async () => { throw new Error('wiring broke'); },
  });

  const result = await (await provider.start(startRequest())).result;
  assert.equal(result.stopReason, 'error');
  assert.match(result.diagnostic, /wiring broke/);
});

test('失败面：正文为空时早失败，且带着原因 —— 不占用一次 WorkBuddy 会话', async () => {
  const { calls, runTask } = recordingRun(okReport('never called'));
  const provider = createWorkBuddyProvider({ readConfig: () => ({ cwdRoot: CONFIG_CWD }), runTask });

  const result = await (await provider.start(startRequest({ prompt: '' }))).result;
  assert.equal(calls.length, 0, '没有正文就不该占用一次 WorkBuddy 会话');
  assert.equal(result.stopReason, 'error');
  assert.deepEqual(result.output, []);
  assert.match(result.diagnostic, /nothing to send/);
});

test('失败面：prompt 整块缺失（undefined / null / 不是数组）⇒ 同样早失败，不抛', async () => {
  const { calls, runTask } = recordingRun(okReport('never called'));
  const provider = createWorkBuddyProvider({ readConfig: () => ({ cwdRoot: CONFIG_CWD }), runTask });

  for (const prompt of [undefined, null, 'text']) {
    const result = await (await provider.start({ label: 'x', prompt, parent: { session: { header: { id: 'p', cwd: PARENT_CWD } } } })).result;
    assert.equal(result.stopReason, 'error', `prompt=${String(prompt)} 不该被当成有正文`);
    assert.match(result.diagnostic, /nothing to send/);
  }
  assert.equal(calls.length, 0);
});

test('★ 失败面：`runTask` 没接上 ⇒ `error` 且**不许从 `start()` 抛出来**', async () => {
  // readConfig 正常，只有执行出口缺了：这是"插件没启动完"的真实样子。
  // 两种缺法都要算：显式写 `null`，和干脆不写这个键（`undefined`）。
  // 后者是真实注册路径上的常见形态 —— 属性缺失和显式 null 在调用方看来是两件事，
  // 但对 provider 必须是同一个结果，否则"漏传"会变成一次静默的空跑。
  for (const runTask of [null, undefined]) {
    const provider = createWorkBuddyProvider({ readConfig: () => ({ cwdRoot: CONFIG_CWD }), runTask });

    const run = await provider.start(startRequest()); // ← 这一行不许抛
    const result = await run.result;
    assert.equal(result.stopReason, 'error', `runTask=${String(runTask)} 时不许假装跑成功`);
    assert.match(result.diagnostic, /runTask is missing/);
    assert.match(result.diagnostic, /did not finish booting/, '要说清是"没启动完"，不是"这次任务失败"');
    assert.equal('diagnostic' in result, true);
    assert.deepEqual(result.output, [], '没有正文，就别产出正文');
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 【非文本块】不静默丢
// ───────────────────────────────────────────────────────────────────────────

test('取舍②：非文本块不静默丢 —— 正文里点名，runTask 收到的是带占位行的那段', async () => {
  const { calls, runTask } = recordingRun(okReport('ok'));
  const provider = createWorkBuddyProvider({ readConfig: () => ({ cwdRoot: CONFIG_CWD }), runTask });

  await (await provider.start({
    label: 'x',
    prompt: [{ type: 'text', text: 'look' }, { type: 'image', data: 'A'.repeat(300) }],
    parent: { session: { header: { id: 'p1', cwd: PARENT_CWD } } },
  })).result;

  assert.match(calls[0].prompt, /^look\n/, '文本块照旧在前');
  assert.ok(calls[0].prompt.includes(OMITTED_BLOCK_PREFIX), '被丢下的块必须在正文里留下痕迹');
  assert.match(calls[0].prompt, /300 chars of "image"/, '要写清丢了多大一块，不然读者无法判断损失');
});

test('★ 已知缺口 ★ 非文本块在**成功**路径上没有"独立告示"，只剩正文里那行占位', async () => {
  // ★ 这里钉的是**当前行为**，不是理想行为 ★
  //   `provider.js` 的 `omissionNote()` 算出了"有 N 个非文本块没送出去"，
  //   但成功路径上它**没有载体**：completed 的结果按约定不带 diagnostic（见下面那组），
  //   日志里也没有它（下面的断言就是在证明这一点）。
  //   唯一痕迹是 prompt 里那行占位 —— WorkBuddy 那侧看不看得到、看不看得懂，本插件管不着。
  //   `prompt.js:66` 的注释说"由 provider 写进 SubagentResult.diagnostic"，在成功路径上够不着。
  //   ⇒ 这是一处源码缺口，已上报；本文件不改源码，所以按**实测**行为断言。
  const { calls, logs, runTask } = recordingRun(okReport('ok'));
  const provider = createWorkBuddyProvider({
    readConfig: () => ({ cwdRoot: CONFIG_CWD }),
    runTask,
    log: (line) => logs.push(line),
  });

  const result = await (await provider.start({
    label: 'x',
    prompt: [{ type: 'text', text: 'look' }, { type: 'image', data: 'A'.repeat(300) }],
    parent: { session: { header: { id: 'p1', cwd: PARENT_CWD } } },
  })).result;

  assert.equal(result.stopReason, 'completed');
  assert.ok(calls[0].prompt.includes(OMITTED_BLOCK_PREFIX), '占位行在');
  assert.equal('diagnostic' in result, false, '成功路径不带 diagnostic —— 这是 dsh 的约定');
  assert.equal(
    logs.some((l) => l.includes('non-text') || l.includes('omitted')),
    false,
    '★ 实测：日志里也没有这行告示。上面那句"缺载体"就是靠这条断言的',
  );
});

test('★ 失败面：非文本块的告示会跟着失败诊断一起出来（失败路径上它够得着载体）', async () => {
  const { runTask } = recordingRun({ ok: false, reason: 'boom', error: { message: 'x' } });
  const provider = createWorkBuddyProvider({ readConfig: () => ({ cwdRoot: CONFIG_CWD }), runTask });

  const { diagnostic } = await (await provider.start({
    label: 'x',
    prompt: [{ type: 'text', text: 'look' }, { type: 'image', data: 'A'.repeat(300) }],
    parent: { session: { header: { id: 'p1', cwd: PARENT_CWD } } },
  })).result;

  assert.match(diagnostic, /non-text content block/);
  assert.ok(diagnostic.includes(OMITTED_BLOCK_PREFIX));
});

// ───────────────────────────────────────────────────────────────────────────
// 【回执面】正文里要有"这次是怎么跑起来的"
// ───────────────────────────────────────────────────────────────────────────

test('★ 回执：正文 = 结果 + 权限告示 + 回执告示，三段拼起来，正文在前', async () => {
  const { runTask } = recordingRun({
    ok: true,
    reason: 'done',
    text: 'body',
    permission: { requested: 'bypassPermissions', confirmed: false, effective: 'default' },
    sessionId: 's1',
    sessionOrigin: 'new',
    continuity: 'fresh-conversation-per-round',
    phases: ['db-open', 'running'],
  });
  const provider = createWorkBuddyProvider({ readConfig: () => ({ cwdRoot: CONFIG_CWD }), runTask });

  const text = (await (await provider.start(startRequest())).result).output[0].text;

  assert.match(text, /^body\n\n/, '正文必须仍在最前面，告示是追加不是替换');
  assert.match(text, markRe(PERMISSION_NOTE_MARK));
  assert.match(text, markRe(RECEIPT_NOTE_MARK));
  assert.match(text, /session=s1/);
  assert.match(text, /origin=new/);
  assert.match(text, /fresh-conversation-per-round/);
  assert.match(text, /phases=db-open>running/, '阶段要按到达顺序连起来，不然读不出走到哪一步');
});

test('★ 回执：什么都没记到 ⇒ 不产出回执行（空告示比没有告示更吵）', async () => {
  const { runTask } = recordingRun(okReport('body'));
  const provider = createWorkBuddyProvider({ readConfig: () => ({ cwdRoot: CONFIG_CWD }), runTask });

  const text = (await (await provider.start(startRequest())).result).output[0].text;
  assert.equal(text, 'body', '没有任何可报的字段时，正文就该是正文本身');
  assert.equal(text.includes(RECEIPT_NOTE_MARK), false);
});

// ───────────────────────────────────────────────────────────────────────────
// 【cwd】三岔口：配置里给了就用它，没给就退回父会话，都没有就抛
// ───────────────────────────────────────────────────────────────────────────

test('cwd：配置里给了 `cwdRoot` ⇒ 就用它（父会话有别的目录也不动）', async () => {
  const { calls, runTask } = recordingRun(okReport('ok'));
  const provider = createWorkBuddyProvider({ readConfig: () => ({ cwdRoot: CONFIG_CWD }), runTask });

  await (await provider.start(startRequest({ cwd: PARENT_CWD }))).result;
  assert.equal(calls[0].cwd, CONFIG_CWD);
});

test('cwd：`cwdRoot` 是空串 ⇒ 退回**父会话**的目录（空串不是"没有目录"，是"没配"）', async () => {
  const { calls, runTask } = recordingRun(okReport('ok'));
  const provider = createWorkBuddyProvider({ readConfig: () => ({ cwdRoot: '' }), runTask });

  await (await provider.start(startRequest({ cwd: PARENT_CWD }))).result;
  assert.equal(calls[0].cwd, PARENT_CWD, '空串要是原样下发，WorkBuddy 会在一个不存在的地方开工');
});

test('cwd：父会话的目录不是绝对路径 ⇒ `start()` 直接拒绝（不许拿相对路径开工）', async () => {
  const provider = createWorkBuddyProvider({ readConfig: () => ({ cwdRoot: '' }), runTask: async () => okReport('ok') });

  // ★ 这里必须是 `assert.rejects`，不能是 `assert.throws` ★
  //   `start()` 是 `async`，它体内的 `throw` 一律先变成"被拒绝的 Promise"，
  //   永远不会同步抛出来。`assert.throws` 只盯同步调用，于是报
  //   "Missing expected exception." —— 那不是说源码错了，是说断言用错了。
  //   "拒绝"的含义仍然钉住了：交出来的不是 handle，而是一次失败。
  await assert.rejects(
    () => provider.start(startRequest({ cwd: 'relative/dir' })),
    (err) => err.message === `${PREFIX}: parent session cwd must be an absolute path: relative/dir`,
  );
});

test('cwd：两边都没有目录 ⇒ `start()` 拒绝，且给出可照做的下一步', async () => {
  const provider = createWorkBuddyProvider({ readConfig: () => ({}), runTask: async () => okReport('ok') });

  await assert.rejects(
    () => provider.start({ label: 'x', prompt: [{ type: 'text', text: 'go' }], parent: { session: { header: { id: 'p1' } } } }),
    (err) => {
      assert.match(err.message, /no working directory for the child/);
      // ★ 这句话里的 `cwd` 是**宿主**的措辞（`resolveChildCwd`），本插件的配置项叫 `cwdRoot`。
      //   照做的人会去翻 settings 找 `cwd` —— 如实记在这里，不假装它是一致的。
      assert.match(err.message, /configure `cwd`/);
      return true;
    },
  );
});

test('cwd：`cwdRoot` 指向一个不存在的目录 ⇒ `start()` 拒绝，不留给 WorkBuddy 去踩', async () => {
  const missing = join(CONFIG_CWD, 'no-such-dir');
  const provider = createWorkBuddyProvider({ readConfig: () => ({ cwdRoot: missing }), runTask: async () => okReport('ok') });

  await assert.rejects(
    () => provider.start(startRequest()),
    (err) => err.message === `${PREFIX}: config cwd is not an accessible directory: ${missing}`,
  );
});

test('cwd：没有父会话但配了 `cwdRoot` ⇒ 照样能跑（父会话不是必需的）', async () => {
  const { calls, runTask } = recordingRun(okReport('ok'));
  const provider = createWorkBuddyProvider({ readConfig: () => ({ cwdRoot: CONFIG_CWD }), runTask });

  const result = await (await provider.start({ label: 'x', prompt: [{ type: 'text', text: 'go' }] })).result;
  assert.equal(result.stopReason, 'completed');
  assert.equal(calls[0].cwd, CONFIG_CWD);
});

// ───────────────────────────────────────────────────────────────────────────
// 【中止面】abort 必须收成 `aborted`，且**不带** diagnostic
// ───────────────────────────────────────────────────────────────────────────

test('★ 中止：已 abort 的 signal ⇒ `aborted`，且不白跑一轮（runTask 都不该被调）', async () => {
  const { calls, runTask } = recordingRun(okReport('never called'));
  const provider = createWorkBuddyProvider({ readConfig: () => ({ cwdRoot: CONFIG_CWD }), runTask });

  const ac = new AbortController();
  ac.abort();

  const result = await (await provider.start(startRequest({ signal: ac.signal }))).result;
  assert.equal(result.stopReason, 'aborted');
  assert.deepEqual(result.output, []);
  assert.equal('diagnostic' in result, false, '★ aborted 一旦带 diagnostic，宿主会把"被叫停"读成"失败"');
  assert.equal(calls.length, 0, '已经中止了就别再占用一次 WorkBuddy 会话');
});

test('★ 中止：下发给 runTask 的是 provider 自己的 signal，但父信号一响它就跟着响', async () => {
  // ★ 这里曾写成"原样转发同一个对象"，是**错的** ★
  //   `provider.js:246-247,295`：provider 自己开一个 `local` 控制器，把 `local.signal` 交给执行层，
  //   只在**父信号**上挂监听（`signal = request?.signal ?? local.signal`）。
  //   这不是多此一举：`dispose()` 也要能单独叫停（见下一条），一个共享对象没法同时表达
  //   "父会话叫停"和"我自己叫停"。所以真正该钉的不是对象同一性，而是**父信号真的能传到执行层**。
  const { calls, runTask } = deferredRun();
  const provider = createWorkBuddyProvider({ readConfig: () => ({ cwdRoot: CONFIG_CWD }), runTask });

  const ac = new AbortController();
  const run = await provider.start(startRequest({ signal: ac.signal }));
  await Promise.resolve(); // 让 attempt 走到 runTask

  assert.equal(calls.length, 1, '这一轮已经跑起来了');
  assert.ok(calls[0].signal instanceof AbortSignal, '执行层拿到的是个真 signal');
  assert.equal(calls[0].signal.aborted, false, '刚下发时还没人叫停');
  assert.notEqual(calls[0].signal, ac.signal, '★ 不是同一个对象：provider 转了一手（理由见上）');
  assert.equal(ac.signal.aborted, false);

  ac.abort();
  // 同步检查：`onAbort` 是同步的，`local.abort()` 一调，`local.signal.aborted` 立刻为真。
  // 这一条才是"父会话能不能真的叫停"的证据 —— 对象同一性从来不是。
  assert.equal(calls[0].signal.aborted, true, '★ 父信号响了，下发给执行层的那个必须跟着响');

  const result = await run.result;
  assert.equal(result.stopReason, 'aborted');
  assert.equal('diagnostic' in result, false);
});

test('★ 中止：跑到一半被 abort ⇒ `aborted` + 无 diagnostic（runTask 还没结算也算数）', async () => {
  const { calls, runTask } = deferredRun();
  const provider = createWorkBuddyProvider({ readConfig: () => ({ cwdRoot: CONFIG_CWD }), runTask });

  const ac = new AbortController();
  const run = await provider.start(startRequest({ signal: ac.signal }));
  await Promise.resolve(); // 让 attempt 走到 runTask
  assert.equal(calls.length, 1, '这一轮已经跑起来了，记账里要看得见');
  ac.abort();

  const result = await run.result;
  assert.equal(result.stopReason, 'aborted');
  assert.deepEqual(result.output, []);
  assert.equal('diagnostic' in result, false);
});

test('★ 中止：`dispose()` 中途叫停 ⇒ 同样 `aborted` 且无 diagnostic（远端不配合也算数）', async () => {
  // 这一条故意用 `ignoreCancel`：执行层**没有**在取消时返回，最后还报了成功。
  // 结论仍必须是 `aborted` —— 判定的依据是"我让它停"，不是"远端说了什么"。
  const { runTask, settle } = deferredRun({ ignoreCancel: true });
  const provider = createWorkBuddyProvider({ readConfig: () => ({ cwdRoot: CONFIG_CWD }), runTask });

  const run = await provider.start(startRequest());
  await Promise.resolve();
  const disposal = run.dispose(); // ← 不 await：它要等执行层真的结算（`provider.js:350`）
  settle(okReport('too late'));   // 远端不配合：取消都发过去了，它照旧报成功
  await disposal;

  const result = await run.result;
  assert.equal(result.stopReason, 'aborted');
  assert.equal('diagnostic' in result, false);
});

test('★ 收敛：`dispose()` 拆得干净，且在结果已结算后重复调用也不抛', async () => {
  const { runTask } = recordingRun(okReport('ok'));
  const provider = createWorkBuddyProvider({ readConfig: () => ({ cwdRoot: CONFIG_CWD }), runTask });

  const run = await provider.start(startRequest());
  const settled = await run.result;
  await run.dispose();
  await run.dispose(); // ← 幂等：第二次不许抛
  assert.equal(settled.stopReason, 'completed', '收敛不该改写已经定下的结论');
  // ★ `run.result` 是 Promise，不是结果本身：`run.result.stopReason` 恒为 `undefined`。
  //   要读结论必须先 await —— 这一行是上面那个坑的另一种脸。
  assert.equal((await run.result).stopReason, 'completed', '结论本身也不该被 dispose 改写');
});

test('★ 收敛：同一 provider 起两次 ⇒ 两次的 id 不同（每次委派都是新的一轮）', async () => {
  const { runTask } = recordingRun(okReport('ok'));
  const provider = createWorkBuddyProvider({ readConfig: () => ({ cwdRoot: CONFIG_CWD }), runTask });

  const a = await provider.start(startRequest());
  const b = await provider.start(startRequest());
  await Promise.all([a.result, b.result]);
  assert.notEqual(a.id, b.id, 'id 撞了会让宿主把两轮当成同一轮');
});
