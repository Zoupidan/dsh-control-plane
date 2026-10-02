/**
 * `workbuddy` 子智能体 provider —— dsh 把**一次委派**下发到进程外的 WorkBuddy，
 * 由 WorkBuddy 自己跑完，再把结果送回这条 seam。
 *
 * <p>★★ 形状：OUT-OF-PROCESS（`localAgent: void 0`）★★
 *
 * <p>WorkBuddy 是一个**智能体**，不是一条 LLM 路由。所以本 provider 交付的是一个
 * 远端句柄（{@link subprocessRunHandle}），而不是一个真 Agent：
 * `run.localAgent` 恒为 `undefined` ⇒ `dsh-subagent` 的 `establishCatalogChild`
 * 判据不成立（`lib/index.js:3130` 读的正是 `run.localAgent?.session`）
 * ⇒ **父会话里没有 `subagent/catalog` 那一行，也没有一个可以点开的 dsh 子会话**。
 * 这是这条路的**代价**，不是 bug；"两边都能看得到"在这条路上的准确含义是：
 * dsh 这一侧看得到**这次工具调用与它回传的结果**，WorkBuddy 那一侧看得到
 * **它自己的那条对话**（`sessionKey` 认的就是它）。
 *
 * <p>★★ 为什么**不能**用"把 WorkBuddy 注册成 LLM 路由"来换回那个目录行 ★★
 *
 * <p>被删掉的 `./llm-adapter.js` 就是那种做法：它在 `workbuddy` 这个路由 id 上注册
 * 一个 LLM 适配器，于是 dsh **自己的 agent loop** 照常跑，只是每一次生成都落到
 * WorkBuddy 那一侧 —— 等于把 dsh 变成一个反向代理，让父 Agent 的 provider 能选成
 * `workbuddy`。那不是"dsh 把任务下发到 WorkBuddy"，那是**让 WorkBuddy 冒充一台模型**：
 * 两边各有一套权限、会话与工具语义，而谁说了算无从查证。用户对此的裁定是**绝对禁止**。
 * 所以本文件不再有任何 LLM 适配器、不再有 `agentOptions`、不再有 `prepareContinuable`
 * （方法存在**就是**能力，见下）。
 *
 * <p>★★ 能力面逐项为 `false`，且这是**诚实的**★★
 *
 * <p>直接复用宿主为此类后端准备的 {@link NO_START_CAPABILITIES}
 * （`dsh-subagent/lib/index.js:2517-2529`）：另一个进程里的子智能体**做不到**
 * 父侧强制的那些启动特性（`agentOptions` / `outputSchema` / `maxDepth` /
 * `toolFilter` / `persona`），所以服务层在 `start()` 之前就把需要它们的请求**拒掉** ——
 * "接受后忽略"是最坏的撒谎，这里从形状上就不可能发生。
 * `depthLimit: false` 与 patch 里的 `maxDepth: provider-managed` 是配套的
 * （`dsh-tool-subagent` 在装配期就会因为"配了深度上限但 provider 不认"而拒绝激活）。
 *
 * <p>★★ 唯一的执行出口：`createTaskExecutor`（`./execute.js`）★★
 *
 * <p>那是**工具面**（`workbuddy_run` 等工具）已经在用的同一条路：三级传输
 * （记住的对话 → 自动化点火 → 告知不可达）、`MAX_TURNS` 轮次预算、中文标记的
 * 转写与重放、如实回报模型/权限/阶段。本文件**不再持有第二条下发链**：`runTask`
 * 由 `./index.js` 注入，注入的就是那份 `createTaskExecutor`。
 * 于是"工具面看到的失败"和"子智能体面看到的失败"是同一条链上的同一个值，不可能分叉。
 *
 * <p>★★ 权限：没有人在子智能体背后 ★★
 *
 * <p>交互档（`default` = Always Ask）会永远挂着。所以 `sessionMode` 一律经
 * {@link effectiveSessionMode} 折成非交互档再下发，**不依赖用户正好配对**；
 * 真的被强制过（或没被确认生效）时，正文里会带上那一行告示（{@link permissionNote}）。
 * 本 provider 不给调用方开任何 dsh 工具面（`toolFilter: false`）——
 * 授权由 WorkBuddy 那一侧自己承担。
 *
 * <p>★★ 会话亲和：一个任务 = 一条 WorkBuddy 对话 ★★
 *
 * <p>用户的要求是"同一个任务的多轮必须落在**同一条**对话上，不要每轮开一个新对话"。
 * `one-shot` 这一侧宿主**不给**我们稳定的任务 id（`descriptor` 只有 `mode`/`provider`/`label`，
 * 句柄 id 由我们自己现取），所以可用的任务身份只有两个：
 * **父会话 id** + **这次委派的标签**（`request.label`，来自工具面的 `description`）。
 * {@link sessionKeyFor} 就按这两个值算亲和键（`subagent:<父会话>:<标签 slug>:<标签摘要>`）。
 * 取舍写在那个函数上：同标签 = 同一条对话（这正是"继续做同一件事"）；
 * 改了措辞 = 新对话。**没有标签就没有亲和**（宁可让回执如实说
 * `fresh-conversation-per-round`，也不把两件无关的事塞进同一条对话）。
 *
 * <p>约束：本文件属于 packages 下的 src（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 *
 * @module host/subagent/provider
 */

import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { brandString } from '@deepseek-ai/dsh-brand';
import {
  NO_START_CAPABILITIES,
  assertUsableCwd,
  resolveChildCwd,
  settleRunResult,
  subprocessRunHandle,
} from '@deepseek-ai/dsh-subagent';
import {
  WORKBUDDY_PROVIDER_ID,
  effectiveSessionMode,
  failureDetailFor,
  joinBody,
  permissionNote,
  receiptNote,
} from './notes.js';
import { promptText } from './prompt.js';

/** provider 名。**同时是 seam 里可被 `dsh-tool-subagent` 选中的那个名字**。 */
export const PROVIDER_NAME = WORKBUDDY_PROVIDER_ID;

/** 诊断前缀：本插件在 seam 面抛出的每一句都带它，用户搜得到出处。 */
const PREFIX = 'dsh-plugin-workbuddy: subagent provider workbuddy';

/** diagnostic 里单个自由文本字段的长度上限（seam 另有 4096 字节的总闸，这里先收窄）。 */
const MAX_DETAIL_CHARS = 200;

/** 日志行的长度上限：日志是给人扫的，再长也读不完。 */
const MAX_LOG_CHARS = 400;

/** 任务标签（= WorkBuddy 对话标题）的长度上限。 */
const MAX_LABEL_CHARS = 60;

/** 亲和键里 slug 段的长度上限（键要短到能被人眼看懂）。 */
const MAX_SLUG_CHARS = 32;

/**
 * 截断自由文本。
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string} 非字符串一律回 `''`（**不**把 `undefined` 印成 "undefined"）
 */
function clip(value, max = MAX_DETAIL_CHARS) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * 把任意值压成"单行、去首尾空白"的字符串。非字符串 ⇒ `''`。
 * @param {unknown} value
 * @returns {string}
 */
function flatten(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/**
 * 任务标签 → WorkBuddy 对话标题。
 *
 * <p>★ 为什么**必须**有上限，而且必须来自 `request.label` ★
 * 真机踩过：调用方没给标签时曾经退而取"第一条 user 消息"，结果把**系统提示词**
 * 当成了标题（会话列表里躺着 `"You are an AI agent powered by DeepSeek Harness.\n\nYou are a "`）。
 * 标签要么是调用方明确给的任务名，要么就是**没有**——不存在"猜一个"。
 *
 * @param {string} flat {@link flatten} 之后的标签
 * @returns {string} 空串 = 这次委派没有标签
 */
function taskTitle(flat) {
  if (flat === '') return '';
  return flat.length <= MAX_LABEL_CHARS ? flat : `${flat.slice(0, MAX_LABEL_CHARS)}…`;
}

/**
 * 算这次委派的 WorkBuddy 会话亲和键。
 *
 * <p>键的形状：`subagent:<父会话 id>:<标签 slug>:<标签摘要>`。三段各有理由：
 * <ul>
 *   <li>`subagent:` 前缀 —— 工具面的键是裸 `randomUUID()` 与 `OWN_SESSION_KEY` 哨兵，
 *       加前缀保证两面的键永不相撞。</li>
 *   <li>父会话 id —— 同一个标签在两个不同的父会话里是两件事，不能共对话。</li>
 *   <li>标签 slug + 摘要 —— slug 给人眼认（回执/日志里一眼看出是哪件事），
 *       摘要（sha256 前 8 位十六进制）给**完整**标签兜底：slug 截到 32 字之后
 *       两个长标签可能长得一样，摘要不会。</li>
 * </ul>
 *
 * <p>★ 取舍（必须说清）★
 * 键里含标签 ⇒ **同标签 = 续用同一条对话，改措辞 = 开新对话**。
 * 这是 `one-shot` 面唯一能拿到的任务身份：宿主不给稳定 id（见文件头）。
 * **没有标签一律不给亲和**（回 `''`）：宁可让回执如实写
 * `fresh-conversation-per-round`，也不赌"这两件事其实是同一件"。
 *
 * @param {unknown} parentSessionId 父会话 id（`request.parent.session.header.id`）
 * @param {string} flatLabel {@link flatten} 之后的标签
 * @returns {string} 空串 = 没有亲和（执行层会每轮开一条新对话，并如实回报）
 */
export function sessionKeyFor(parentSessionId, flatLabel) {
  const sid = flatten(parentSessionId);
  if (sid === '' || flatLabel === '') return '';
  const slug = flatLabel
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-+$/g, '');
  const digest = createHash('sha256').update(flatLabel, 'utf8').digest('hex').slice(0, 8);
  return `subagent:${sid}:${slug === '' ? 'task' : slug}:${digest}`;
}

/**
 * 组装 `workbuddy` provider。
 *
 * @param {object} [deps]
 * @param {() => object} [deps.readConfig] 读取器：每次 `start()` 现取（`.volatile()` 字段的通用坑，
 *   装配期拍死会让用户改了设置也不生效 —— 见 `host/apply.js` 同处注释）
 * @param {(req: object) => Promise<object>} [deps.runTask] 执行出口：`./execute.js` 的 `createTaskExecutor`
 *   产物。**必须注入**；缺失时按"插件没装配完"如实报错，而不是假装成功。
 * @param {(message: string) => void} [deps.log] 可选落日志
 * @returns {object} `SubagentProvider`
 */
export function createWorkBuddyProvider({ readConfig = null, runTask = null, log = null } = {}) {
  const read = () => (typeof readConfig === 'function' ? readConfig() : null);

  return {
    name: PROVIDER_NAME,

    /**
     * ★ 逐项 `false`，直接抄宿主的 {@link NO_START_CAPABILITIES} ★
     * 语义见文件头：需要这些特性的请求在 `start()` 之前就被拒，
     * 永不出现"收下了但做不到"。
     */
    capabilities: { ...NO_START_CAPABILITIES },

    /**
     * **不**继承父上下文，这是诚实的：WorkBuddy 那一侧有自己的对话历史
     * （`sessionKey` 认的就是它），dsh 父会话的上下文搬不过去（也不该搬）。
     * 多轮亲和靠 WorkBuddy 自己那条会话，不靠假装继承了父上下文。
     */
    inheritsParentContext: false,

    /**
     * 起一次**进程外**委派。
     *
     * <p>刻意**没有** `agentRouteDefaults`：那是给"子 Agent 要在 dsh 内部跑一次生成"
     * 准备默认路由的；本 provider 不在 dsh 内部跑生成，写它只会让
     * `dsh-tool-subagent` 去做一次必然失败的模型路由预检（没有适配器了）。
     *
     * <p>刻意**没有** `prepareContinuable`：方法存在**就是**能力
     * （`dsh-subagent/lib/index.js:3149-3152` 就是按这个判的），
     * 续用端子智能体需要 dsh 侧真有一个子会话可续 —— 本路没有。
     *
     * @param {object} request `ResolvedSubagentStartRequest`（含宿主补上的 `descriptor`）
     * @returns {Promise<object>} `SubagentRun`（`localAgent: void 0` ⇒ 目录里不出现）
     */
    async start(request) {
      const cfg = read();
      const label = flatten(request?.label);
      const prompt = promptText(request?.prompt);
      const parentHeader = request?.parent?.session?.header;
      const sessionKey = sessionKeyFor(parentHeader?.id, label);

      // ★ 工作目录必须**吵着要**，不能默默落回"本进程的启动目录" ★
      //   `resolveChildCwd`（`dsh-subagent/lib/index.js:2597-2601`）就是宿主给出的这条策略：
      //   配置里的覆盖优先，否则用**父会话的工作区**，两者都没有就抛 ——
      //   一个服务进程同时伺候多个会话，退回进程 cwd 会把子任务静默绑到服务自己的目录上。
      //   ★ 与旧适配器的差别（有意为之）：`cwdRoot` 为空串（= 本插件的"未设置"哨兵）时
      //   不再原样把空串递下去，而是**落回父会话的工作区**。
      const configured = flatten(cfg?.cwdRoot);
      const override = configured === '' ? undefined : assertUsableCwd(PREFIX, 'config cwd', resolve(configured));
      const cwd = resolveChildCwd(PREFIX, override, flatten(parentHeader?.cwd) || undefined);

      const id = brandString(randomUUID());

      // ★ 取消线：父信号 → 本地信号 → 执行层 ★
      //   `subprocessRunHandle` 只管**摘**监听器（`:2659`），**装**是 provider 的事；
      //   而 `settleRunResult` 也会在 finally 里摘一次（`:2640`），摘两次是无害的。
      const local = new AbortController();
      const signal = request?.signal ?? local.signal;
      let cancelled = false;
      const onAbort = () => {
        cancelled = true;
        local.abort();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();

      /** 最近一次失败的一句话诊断（`settleRunResult` 的意外抛出也读它）。 */
      let lastDiagnostic;
      // ★ 被丢掉的内容块**必须**在诊断里留字 ★
      //   `./prompt.js:66` 的约定：文本里留一行占位、诊断里留出处。少了后半句，
      //   失败时读者只能反推"这一行是谁加的"。
      const omissionNote = prompt.omitted.length === 0
        ? ''
        : `${PREFIX}: ${prompt.omitted.length} non-text content block(s) were not sent as text: ${clip(prompt.omitted.join(' | '))}`;
      const diagnosticFor = (text) => (omissionNote === '' ? text : `${text} · ${omissionNote}`);

      const attempt = async () => {
        if (cancelled) return { output: [], stopReason: 'aborted' };
        if (prompt.text.trim() === '') {
          // 空正文**不**当成成功：那正是"看起来跑完了、其实什么都没发"。
          lastDiagnostic = `${PREFIX}: nothing to send — this delegation carried no content block`;
          return { output: [], stopReason: 'error', diagnostic: diagnosticFor(lastDiagnostic) };
        }
        if (typeof runTask !== 'function') {
          lastDiagnostic = `${PREFIX}: no execution outlet is wired (runTask is missing) — the plugin did not finish booting`;
          return { output: [], stopReason: 'error', diagnostic: diagnosticFor(lastDiagnostic) };
        }

        const permission = effectiveSessionMode(cfg?.sessionMode);
        const model = typeof cfg?.model === 'string' ? cfg.model : '';
        log?.(`${PREFIX}: run ${id}: dispatching to WorkBuddy (cwd=${cwd}, permission=${permission.mode}`
          + `${permission.forced ? ' [forced, configured=' + (permission.configured === '' ? 'empty' : permission.configured) + ']' : ''}`
          + `, model=${model === '' ? '(none — the WorkBuddy side picks its own default)' : model}`
          + `, sessionKey=${sessionKey === '' ? '(none — every round will open a new conversation)' : sessionKey}`
          + `${label === '' ? ', name=(none)' : `, name=${taskTitle(label)}`})`);

        let report;
        try {
          report = await runTask({
            prompt: prompt.text,
            cwd,
            permissionMode: permission.mode,
            model,
            sessionKey,
            name: label === '' ? null : taskTitle(label),
            signal: local.signal,
          });
        } catch (error) {
          // 执行层自己抛 = 本进程里的装配/接线问题（传输层的失败走 `ok: false` 那条路）。
          lastDiagnostic = `${PREFIX}: the delegation failed inside dsh: ${clip(error?.message ?? String(error))}`;
          log?.(`${PREFIX}: run ${id}: ${clip(lastDiagnostic, MAX_LOG_CHARS)}`);
          return { output: [], stopReason: 'error', diagnostic: diagnosticFor(lastDiagnostic) };
        }

        if (report?.ok !== true) {
          // ★ 取消与失败必须分开 ★：`aborted` **不带** `diagnostic` 才会被判成 `killed`
          //   （`dsh-subagent/lib/index.js:2692-2713` 的 `runOutcome`）；
          //   带上诊断就变成 `failed`，把"我让它停"说成"它坏了"。
          if (cancelled) return { output: [], stopReason: 'aborted' };
          lastDiagnostic = failureDetailFor(report);
          log?.(`${PREFIX}: run ${id}: ${clip(lastDiagnostic, MAX_LOG_CHARS)}`);
          return { output: [], stopReason: 'error', diagnostic: diagnosticFor(lastDiagnostic) };
        }

        const body = typeof report.text === 'string' ? report.text.trim() : '';
        const tone = body === ''
          ? '(the WorkBuddy run reported success but returned no text)'
          : body;
        // ★ 正文 = 结果 + 两行告示 ★
        //   告示只写"报告里说了、而读者必须知道"的事：权限到底生效没有、这一轮是不是真续接、
        //   模型是谁选的。它们**只存在**于执行层的返回值里，不写进正文就等于没有。
        return {
          output: [{ type: 'text', text: joinBody(tone, permissionNote(report.permission), receiptNote(report)) }],
          stopReason: 'completed',
        };
      };

      const settled = settleRunResult({
        attempt,
        cancelled: () => cancelled,
        // 本路不流式累积输出：取消 ⇒ 没有正文（半截结果比没有结果更容易被误读）。
        collectOutput: () => [],
        collectDiagnostic: () => (lastDiagnostic === undefined ? undefined : diagnosticFor(lastDiagnostic)),
        onError: (error) => log?.(`${PREFIX}: run ${id}: unexpected failure while settling: ${clip(error?.message ?? String(error), MAX_LOG_CHARS)}`),
        signal,
        onAbort,
      });

      return subprocessRunHandle({
        id,
        result: settled,
        signal,
        onAbort,
        // 本地立刻结算取消状态：**不假设**远端会配合。
        requestCancel: () => {
          cancelled = true;
          local.abort();
        },
        // 等到这次执行真的结束（执行层在信号被中止时才返回）。
        // 已知边界：若某条传输在取消时永不结算，这里会一直等 —— 见本仓 04-docs 的待验证清单。
        teardown: () => settled.then(() => undefined, () => undefined),
      });
    },
  };
}
