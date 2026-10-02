/**
 * systemPrompt.section 的可用性文案（§3.4.1 之 ⑥；order = 520）。
 *
 * Implements: 02-design/DESIGN-v3.md §3.4.1 / §4.4.1（三态：未安装 / 已装但 OFF / 已装且 ON）
 * 目的：让对话模型知道"能不能用 WorkBuddy 工具"，且**不撒谎**（未安装、被用户关闭都是明确状态）。
 *
 * 逐次可调（U1/U2 的可发现性渠道）：可用分支追加一句，说明当前 `model` / `effort` 生效值（空 ⇒ 明确
 * 说"未设置 ⇒ 由桌面端用自身默认"）、可在 workbuddy_run 里逐次覆盖、可用 id 用 workbuddy_status 查；
 * OFF 分支追加一句"用户确实需要 ⇒ 请去插件设置里打开"。**只加句子，不改既有句子**（既有措辞是契约）。
 *
 * ★ 模型面真实化（2026-09-21，ISSUE §5-1）：`model` 为空时**再**追一句"没人替你选 ⇒ 该你选"
 *   （`modelChoiceHint`）。此前只说"由 CLI 用自身默认"，而 GUI 那句「（DSH模型决定）」没有任何机制兑现
 *   ⇒ 标签替平台许了一个没实现的状态。现在两点分工：候选清单在 `workbuddy_run` 的 `model` 参数描述里
 *   （决策发生的那一刻），"这是你的决定"在系统提示里（每回合都在），**清单只有一份**（不抄进本节）。
 *
 * ★ 2026-09-19 对抗审查 S1/S3 修复（措辞必须与"证据"对齐，否则提示词在替平台下没有证据的结论）：
 *   S1 —— 只有 `isFailureCode(code)` 才配 "failed" 语义；`unknown`（未归一出来）/ `aborted`（调用方取消）
 *          各有自己的说法（详见 lastFailureHint）。旧实现把二者一并说成 failed ⇒ 与同步工具输出打架。
 *   S3 —— 档位只在本层数据表**确实含该档**时才敢说"可用"；表里没有就明说不可用，表缺失就说"未确认"
 *          （**绝不**默认为支持，详见 effortSupport）。
 *
 * ★ 长度预算（2026-10-01 收敛）：本节**每个模型回合都求值** ⇒ 追加句的每个 token 每回合都在付。
 *   既有句子（`WorkBuddy delegation is available…` 等）是契约，一个字不动；**追加句只许改说法与长度**：
 *   被说出来的事实、在什么条件下说、不说时是什么样，三者一条都没删（逐条对照见下方各函数的 ★）。
 *   最坏组合（可用 + 未固定模型 + 配置可读）**1801 → 1394 字符**，追加块逐条：
 *     subagentRouteHint 509→377 / continuityHint 300→194 / overrideHint 255→187 / modelChoiceHint 499→398。
 *     追加句里**最长的一句** 309 → 198（第二长 254 → 186，第三长 226 → 152）；整段最长单句只剩契约主句
 *     238（它不受 200 约束）。
 *   **900 的预算达不到，且这是算术问题不是措辞问题**：契约主句一个就占 238，剩 662 要装 17 条互不重复的
 *   事实（其中"子智能体面"一块 377、"该谁选模型"一块 398，各自带 6–8 条，压到 200 等于删事实）。
 *   再往下只剩两条路 —— 删事实（违反本节纪律），或把信息挪到**不每回合付钱**的地方（工具参数描述另算，
 *   见 `tools/run.js` 的 `MODEL_ARG_DESCRIPTION`）。两者都超出本节授权 ⇒ 如实超标并在此记账。
 */
import { REGISTRY_STATES } from '../config/constants.js';
import { REASON_CODES, REASON_TEXT, isFailureCode } from '../launch/reason-codes.js';

/** 失败提示里证据摘录的字符上限（本节每回合都进系统提示 ⇒ 必须截断）。 */
const FAILURE_EVIDENCE_CHARS = 200;

/**
 * 档位在当前配置下"到底能不能用"（三态）—— ★ 为什么不直接用 `argv.js:254` 的 `effortValues?.[effort]`：
 * 那里 `undefined` 同时表示两件**不同**的事 —— ①表里没有这个档（= 不支持，`argv.js:255` 不下发该 flag）；
 * ②整张表就没提供（schema 的 `{}` 默认值 = "形状正确但本层不提供数据"，见 config/schema.js:39）。
 * 照搬它写提示词就会把"我读不到数据"说成"平台不支持"（对抗审查 S3：提示词只许讲读得出来的话）。
 * 故显式分三态：表非空且有可用映射 ⇒ supported；表非空但无该档（或映射不是可用字符串，等价于
 * `argv.js:255` 的条件不成立 ⇒ flag 不会被下发）⇒ unsupported；表缺失/空/非对象 ⇒ unconfirmed。
 *
 * @param {any} cfg 解析后的配置（可能为 undefined —— 老调用方）
 * @param {string} effort canonical 档位（调用方已保证非空）
 * @returns {'supported'|'unsupported'|'unconfirmed'}
 */
function effortSupport(cfg, effort) {
  const table = cfg?.launch?.effortValues;
  if (table === null || typeof table !== 'object' || Array.isArray(table)) return 'unconfirmed';
  if (Object.keys(table).length === 0) return 'unconfirmed';
  return isUsableMapping(table, effort) ? 'supported' : 'unsupported';
}

/** 该档在表里是否有**可用**映射 —— 逐字对齐 `argv.js:255` 的判据（否则"我说支持"与"flag 真的下发"会分叉）。 */
function isUsableMapping(table, key) {
  return Object.prototype.hasOwnProperty.call(table, key)
    && typeof table[key] === 'string' && table[key] !== '';
}

/**
 * effort 的渲染 —— ★ **引号只出现在 supported 分支**。
 * 这是刻意的可判读约定：`effort "high"` 读作"平台支持该档"，不支持/未确认两个分支一律**不**加引号
 * （`effort off (not supported …)`），这样"声称支持一个并不支持的档位"（S3 的原始缺陷）在文本层
 * 就不可能复现，人也一眼分得清。
 *
 * @param {any} cfg @param {string} effort
 * @returns {string}
 */
function effortDescription(cfg, effort) {
  if (effort === '') return 'not set (the desktop uses its own default)';
  const support = effortSupport(cfg, effort);
  if (support === 'supported') return `"${effort}"`;
  if (support === 'unsupported') {
    // 可用档位只列"真的会被下发"的那些（同一判据），否则清单本身又是新的谎。
    const available = Object.keys(cfg.launch.effortValues).filter((k) => isUsableMapping(cfg.launch.effortValues, k));
    return `${effort} (not supported by the current install; available: ${available.length === 0 ? 'none' : available.join(', ')})`;
  }
  return `${effort} (support not confirmed: the current config provides no effort table)`;
}

/**
 * "该谁选模型"（★ 模型面真实化，2026-09-21；只在插件设置**没配** model 时追加）。
 *
 * 要修的事实：GUI 那个空选项过去写着「（DSH模型决定）」，但全链路没有任何一处真的让 DSH 的模型去决定 ——
 *   既没有候选清单，也没有一句"这是你的决定"，于是那句标签替平台许下一个没机制兑现的状态（ISSUE §5-1）。
 *   主理人裁决："没配置的时候，把模型列表交给调用的模型自己选"。兑现它需要两个条件，缺一不可：
 *     ① 选项**在决策发生的那一刻可见** ⇒ 清单落在 `workbuddy_run` 的 `model` 参数描述里
 *        （候选 = 桌面产品目录，由 `workbuddy_status` 实时回传）；
 *     ② 有人**被指明**来做这个决定 ⇒ 就是本节这一句（每回合求值的系统提示 ⇒ 不依赖模型主动去查）。
 *   只把标签改得"更诚实"而不补机制，仍然是假状态；只补机制而不点名决定者，模型会照旧以为"上面已经定了"。
 *
 * ★ 这里**不**重复 17 条清单：本节每次模型回合都求值，清单已在参数描述里，抄第二份只是把同一笔
 *   token 花两遍，且制造第二个真源（漂移时两处会互相打脸）。SSOT 的唯一消费点 = 参数描述。
 *
 * @param {string} model 归一后的生效模型（'' = 插件设置未指定）
 * @returns {string} 前置空格的句子；设置里已有模型时为 ''（那时没有"谁来选"的问题）
 */
function modelChoiceHint(model) {
  if (model !== '') return '';
  // ★★ 2026-10-01 改判（主理人原话：「模型和推理强度用户没设置，那么下发任务的 LLM
  //   就应该要知道自己去根据任务难度去设置，自己去思考」）。旧文案说"不传就是交给 CLI 决定" ——
  //   真机上它落到**桌面端默认（快速 / fast-model）**，于是"我没设"在界面上显示成了"我设成快速"。
  //   现在把决定权**明确指给下发的那个模型**，并说清不选的后果。
  // ★★ 2026-10-02 切回计划任务主路：`effort` 有承载（`automations.reasoning_effort` 列，随行写库，
  //   由桌面端调度器建会话时带上）。旧文案说"网关无 effort 口、传了必 not_sent"已是过去式，
  //   在当前主路下照旧说就是撒谎（run.js buildNotSent 恒为空数组）。
  //   ⇒ 改成如实告诉模型：思考深度**靠选模型**与**传 effort**共同表达，两条都直达桌面端。
  // ★★ 模型兜底与 run.js 同口径（`awaitModelId` → `cheapestModelId`）：没人选时 dsh 按倍率挑最便宜的，
  //   只有目录读不到才落到桌面端默认。说"落到桌面端默认（快速）"已是过去式，照旧说就是撒谎。
  return ' Nobody has pinned a model for you then: omit it and dsh picks the cheapest catalog model for '
    + 'this run (read back lastRun.model to see which one) — only when the catalog cannot be read does '
    + 'the run fall back to the desktop default. Ids are in '
    + 'workbuddy_run\'s model parameter: read the task, judge its difficulty, pass the fitting id every time. '
    + 'Reasoning effort goes the same way: pass effort per run (it is written to the scheduled-task row '
    + 'and carried by the desktop scheduler).';
}

/**
 * 逐次覆盖提示（只在能读到实时配置时生成）。
 *
 * 既有句子是契约（测试逐字钉住 ⇒ **只加不改**）；末尾按条件追加 `modelChoiceHint` —— 仅当插件设置里
 * 没有 model 时才多说一句"该你选了"，配了 model 就一个字都不加（那时不存在"谁来选"的问题）。
 *
 * 防御（老调用方兼容）：测试桩可能**不含** `currentConfig`（它由 config/runtime.js 提供）——
 * 读不到就返回空串（**不追加这段，绝不抛**）。读配置本身抛错同样吞掉：这是每次对话都要算的
 * 提示文案，不能让配置层的一次异常把系统提示求值带崩。
 *
 * ★ 2026-10-01 长度收敛（255 → 187）：事实一条没删，删的是骨架词与重复。
 *   "to override them **for a single run**" ⇒ "per run"（同义；"override"这个动词在 "Current defaults: …"
 *   这个先行分句之后由 "per run" 承接，读作"这一次可以自带"；**取代关系不变**）。
 *   "(use workbuddy_status to list the model ids the CLI currently supports)" ⇒
 *   "(workbuddy_status lists them)"（"the model ids the CLI currently supports" 的所指已在同句前半的
 *   "model / effort" 上给出；"currently supports" 的时效性由 `workbuddy_status` 是**实时调用**这一点承担，
 *   与 `tools/status.js` 实际返回值一致，不是新事实）。
 *   条件、取值渲染（三档 effort）、以及"读不到配置就一个字都不加"的行为全部未动。
 *
 * @param {object} runtime
 * @returns {string} 前置空格的句子；不可用时为 ''
 */
function overrideHint(runtime) {
  if (runtime === null || typeof runtime !== 'object' || typeof runtime.currentConfig !== 'function') return '';
  let cfg;
  try {
    cfg = runtime.currentConfig();
  } catch {
    return '';
  }
  const model = typeof cfg?.model === 'string' && cfg.model !== '' ? cfg.model : '';
  const effort = typeof cfg?.effort === 'string' && cfg.effort !== '' ? cfg.effort : '';
  const described = (v) => (v === '' ? 'not set (the desktop uses its own default)' : `"${v}"`);
  // ★ 计划任务主路下 `model` 与 `effort` 都有承载（前者进 `model_id`，后者进 `reasoning_effort`，
  //   均随行写库由调度器带上）。与 run.js buildNotSent（恒为空数组）同口径：此处邀约两者 per run。
  //   「Current defaults」里照实显示两者生效值（那是配置陈述，不是能力邀约）。
  return ` Current defaults: model ${described(model)}, effort ${effortDescription(cfg, effort)}; `
    + 'workbuddy_run accepts model / effort per run (workbuddy_status lists them).'
    + modelChoiceHint(model);
}

/**
 * 异议—反驳的**轮次约定**（★ 2026-10-02）。
 *
 * <p>形态：**非实时**。委派跑完、回执回来之后才发生，一轮接一轮，不做实时对谈。
 * <p>论据历史**不需要另存**：质疑走 `send_message` 给同一个成员（历史在团队会话里）。
 * <p>上限写在**系统提示**里而不是代码里：它是使用约定（"最多反驳两轮"），不是必须由插件
 *   强制的不变量。真要强制，断点是 `workbuddy_run` 的次数计数，而那需要状态跨作业存活，
 *   代价与收益不成比例 —— 所以这里**只声明不强制**，并且如实标注这一点。
 */
function debateHint() {
  return ' If the user asked you to challenge a result, or a returned answer looks wrong, you may contest it: '
    + 'send_message the SAME member with your objection, and it argues back on the next run. Two rules. '
    + '(1) Use the same session_key every round so the exchange stays grouped — but each round still opens '
    + 'a fresh conversation with no memory of its own argument, so restate the objection with enough context '
    + 'every time. (2) TWO rebuttal rounds is the **default ceiling, not a '
    + 'hard one**: if the user asked for a specific number of rounds, follow the user instead. Either way, '
    + 'stop as soon as you agree or the point is settled — do not spend the whole budget by default. Every '
    + 'round is a real WorkBuddy run and costs real credits.';
}

/**
 * 子智能体面的存在与形状（★ 2026-10-01 新增；每回合求值）。
 *
 * ★ 为什么必须在这里点名"它是子智能体" ★
 * 只有 `workbuddy_run` 那一句的话，模型面对"把一件事交给另一个 agent 产品去做"时
 * 唯一看得见的入口就是一个**作业**（background job）—— 于是它会走工具面，
 * 而工具面那条路在 dsh 的子智能体列表里**不留任何一行**。
 * 用户要的是"调用能在子智能体列表里被看见"，那就得让模型知道**还有另一条路**，
 * 并且知道那才是它。
 *
 * ★ 只讲能兑现的 ★
 * 〔2026-10-02 更正〕本段原先写的是"`subagent/provider.js` 的 `start()` 返回**真 Agent**
 * （`ctx.agents.create()` 出来的），所以 `subagent/catalog` 目录写得进去 ⇒ 列表里真的会多一行"。
 * **那是假的。** `provider.js:222` 明写 `localAgent: void 0` ⇒ 目录里**不出现**，
 * `catalog-gate.test.js` / `subagent-provider.test.js` 各有一条断言专门钉住"不得出现"。
 * 照原文写，主控模型会以为委派完能在子智能体列表里点开那一行 —— 而它永远点不开。
 * 真实形状：WorkBuddy **以 `workbuddy` 这个名字被选中**（provider 已注册、可用），
 * 但每次委派在 dsh 侧**不留会话、不留目录行**；会话开在 WorkBuddy 桌面里。
 * 所以这一段承诺"走 workbuddy provider 才是对的路"（真的），
 * **不**承诺"能在 dsh 的列表里点开它"（做不到，见 `provider.js:9-11`）。
 * 这条链路已由真机量过（子会话 `source_mode=work`、`is_background_automation` 被归一成 NULL），
 * 但**列表里那行的渲染**要重启后在界面上人眼确认 —— 本句只承诺机制，不承诺已经看过。
 *
 * ★ 2026-10-01 长度收敛（509 → 377）：六条事实一条没删（独立 agent 产品 / 非 shell 命令 / 由 WorkBuddy
 *   桌面驱动且那里开真会话 / 自带 cwd·模型·权限模式 / 该用 `workbuddy` 子智能体而非 workbuddy_run /
 *   跑完会进子智能体列表成为独立会话且用户能在桌面打开）。删的是：
 *   "its own working directory, model and permission mode" ⇒ "own cwd, model, permission mode"
 *   （`cwd` 是 `tools/run.js` 里那个参数的**真名**，改用它等于更准确，不是换事实）；
 *   "For **anything that** should be visible as delegated work, **prefer delegating through**" ⇒
 *   "For visible delegated work, **prefer**"（去冗余冠词与动词）；
 *   "so **the call** shows up **in** the subagent list … and the user can open **that conversation in the
 *   WorkBuddy desktop**" ⇒ "shows in the subagent list … the user can open **there**"（"there" =
 *   上一句刚点名的 WorkBuddy 桌面；同一段内第二次提及，指代不歧义）。
 *   顺带把第一句拆成两句：单句从 206 降到 65/127，**没有为了压过 200 而换掉任何事实**。
 */
function subagentRouteHint() {
  // ★ 成员名必须是 lower-kebab-case —— dsh 硬校验，实测 `WorkBuddy` 被直接拒：
  //   "teammate name must be lower-kebab-case, at most 64 characters, and not 'lead'"。
  //   成员列表只显示**名字**，所以那 4 个字是唯一的强可见度。
  //
  // ★ description 的写法（真机截图核对后定的，2026-10-02）★
  //   成员行渲染成 `[external agent] WorkBuddy —— 你的工作全部通过…` 时，读起来是
  //   "先一个分类标签、再一个产品名"，**产品名被挤到中间**，一眼扫过去先看到的是标签。
  //   改成**产品名打头**：`WorkBuddy · 你的工作全部通过调用 workbuddy_run 下发到本机…`
  //   —— 分类信息降为从句里的"外部 agent 产品"一句话，不再抢第一眼。
  //   这也是多产品共存时唯一自洽的写法：`WorkBuddy · …` / 将来 `Qoder · …`，各打各的名。
  //   分隔符用 `·` 而不是 `——` 或 `[]`：前者最短、不与正文里的括号混在一起。
  return ' WorkBuddy is a separate agent product, not a shell command. dsh drives it through the WorkBuddy '
    + 'desktop, which opens a real conversation there (own cwd, model, permission mode). To delegate: call '
    + 'spawn_teammate with name "workbuddy" (names must be lower-kebab-case) and a description that STARTS '
    + 'with "WorkBuddy · " followed by what that member does (e.g. "WorkBuddy · your work runs by calling '
    + 'workbuddy_run; you do not implement it yourself"). The member list shows only the name, so the name is '
    + 'the main signal and the description must lead with the product name. That member is a real team member. '
    + 'Do NOT set the team\'s freshProvider to workbuddy: that would route dsh\'s own generation through '
    + 'WorkBuddy, which this plugin refuses to do.';
}

/**
 * 会话连续性的**传输面相关**说明（★ 2026-10-01 新增）。
 *
 * ★ 为什么按 `transport` 分支，而不是一句话说完 ★
 * 默认传输面（`automation`，桌面端自建会话）里 `automations` 表**没有会话 id 列**，
 * 调度器只按行新建 ⇒ 每一轮都是一条新对话，`session_key` 只是个归组用的键，不带记性。
 * 而 `gateway` 传输面恰恰相反：它按 `sessionKey` 绑定既有会话，**有**连续性。
 * 不看配置就下结论，等于在其中一条路上撒谎 —— 而且是用户最难察觉的那种（结果都对，只是不连着）。
 *
 * ★ 2026-10-01 长度收敛（automation 300 → 194 / gateway 147 → 143）：automation 三条事实（每轮新会话 /
 *   `session_key` 只归组、跨轮不带记性 / 要主动告诉用户）与 gateway 两条（`session_key` 绑定一个会话 /
 *   同键重复下发接着该会话）一条没删，分支条件、默认值（缺 `transport` ⇒ automation）、
 *   以及"读不到配置就一个字都不说"全部未动。automation 那句原本 226 字符（**超 200**），现在 152。
 *   "in the WorkBuddy desktop" ⇒ "there"（桌面已由 `subagentRouteHint` 在同段首次点名）。
 *   "only groups **related runs under one key for bookkeeping**" ⇒ "only groups runs"（"归组用于记账"
 *   就是"不带记性"的同一件事说了两遍，留后者）。
 *   "it does NOT carry conversation memory across rounds" ⇒ "carries NO memory across rounds"（去系动词）。
 *   "Say so when the user expects a follow-up to remember **the previous round**" ⇒
 *   "Say so when a follow-up should remember"（末句限定词是冗余修饰，不改所指）。
 *   gateway 分支 "under the same key" ⇒ "under it"（same key 就是前句的 the key）。
 *
 * @param {object} runtime
 * @returns {string} 前置空格的句子；读不到配置时为 `''`
 */
function continuityHint(runtime) {
  if (runtime === null || typeof runtime !== 'object' || typeof runtime.currentConfig !== 'function') return '';
  let cfg;
  try {
    cfg = runtime.currentConfig();
  } catch {
    return '';
  }
  // ★ 缺省必须跟 `schema.js` / `cordis.patch.yml` 的默认值一致（2026-10-02 切回 automation）。
  //   旧默认曾写成 `gateway`，而传输面已切回 `automation`（`tools/run.js` 的
  //   `const transport = 'automation'`，gateway 已下线）。
  //   配置里 `transport` 为空时，这一句必须说"每轮新会话、session_key 只归组" ——
  //   `automations` 表无对话列，调度器只按行新建，这是当前主路的真实语义。
  const transport = typeof cfg?.transport === 'string' && cfg.transport !== '' ? cfg.transport : 'automation';
  if (transport === 'automation') {
    return ' On the current transport (automation) every round opens a new WorkBuddy conversation there, so '
      + 'a session_key only groups runs and carries NO memory across rounds. Say so when a follow-up should remember.';
  }
  // ★ gateway 路已下线（本机 ACP 不再被生产引用）：配置里残留该值时如实说已下线，
  //   不再描述它的会话语义（"绑定一条对话"已是过去式，说成现在式就是撒谎）。
  return ' The gateway transport has been removed. '
    + 'Runs now go through automation, where every round opens a new conversation.';
}

/**
 * 最近一次下发失败的提示（★ **推送**信道：不必等模型主动去查 workbuddy_status）。
 *
 * 动机：失败原因原本只在 `workbuddy_status` 的 `lastRun` 里（**拉取式**）—— 主控不去查就永远不知道；
 *   而 dsh 的作业结算通知只带 kind / label / status（`dsh-tool-jobs/lib/index.js:109-111`）。本节是
 *   **每次模型回合都会求值**的系统提示 ⇒ 把最近一次失败写在这里，是最稳的"第一时间"保证
 *   （不依赖 wake 预算，也不依赖 owner 当时是否空闲）。
 * 判据只有"最近一次下发的判定不是 ok"，且**必须带时间戳**：一行"上次失败"是要自描述的，否则隔了很久
 *   仍在提示里出现就变成误导（时间戳让模型自己判断这行有多新）。
 *
 * ★ 三档措辞（对抗审查 S1，根因修复）：旧实现的门槛是 `code !== '' && code !== ok` ⇒ 只要不是"成功/空"
 *   就一律说 "the most recent delegation failed" —— 于是 `unknown`（没归一出来）与 `aborted`（调用方
 *   自己取消）都被讲成失败，而**同一条 lastRun** 在同步工具返回里写的是"未能判定"／"被调用方取消"
 *   （run.js:95-105 的判定行 + REASON_TEXT）⇒ 一次下发两处结论打架，模型据此会去报一个没发生的失败。
 *   现在三档，且**只有第一档**配 failed 语义：
 *     (a) `isFailureCode(code)` ⇒ 有具体证据的失败：保留原措辞（failed at <ISO> + code + 说明 + 证据摘录）。
 *     (b) `aborted` ⇒ 被调用方取消：不是失败，**也绝不**叫用户去改配置/换模型（他没做错事）。
 *     (c) 其余（`unknown` 及任何未登记码）⇒ 结果**未确认**：既不声称成功，也不声称失败。
 *   为什么 (c) 不搬 `REASON_TEXT[unknown]`：那条中文文案自带"是否**失败**"字样，进系统提示后照样会被
 *   模型读成一个失败（本修复要消掉的就是这个误读）⇒ (c) 只用"未确认"的英文措辞，原始摘录留给
 *   workbuddy_status / 作业输出（那两处本来就有，不必在每回合都求值的系统提示里重复）。
 *
 * 防御与 overrideHint 同：runtime / lastRun 缺失或读到异常 ⇒ 返回空串，绝不因此带崩系统提示求值。
 *
 * @param {object} runtime
 * @returns {string} 前置空格的句子；没有失败记录时为 ''
 */
function lastFailureHint(runtime) {
  if (runtime === null || typeof runtime !== 'object' || typeof runtime.lastRun !== 'function') return '';
  let rec;
  try {
    rec = runtime.lastRun();
  } catch {
    return '';
  }
  if (rec === null || typeof rec !== 'object') return '';
  const code = typeof rec.reasonCode === 'string' ? rec.reasonCode : '';
  if (code === '' || code === REASON_CODES.OK) return '';
  const at = typeof rec.at === 'number' && Number.isFinite(rec.at) && rec.at > 0
    ? new Date(rec.at).toISOString()
    : '';
  const stamp = at === '' ? '' : ` at ${at}`;

  // (a) 有具体证据的失败 —— 唯一允许出现 "failed" 的分支（措辞逐字保留：既有契约/测试依赖它）。
  if (isFailureCode(code)) {
    const recText = typeof rec.reasonText === 'string' ? rec.reasonText.trim() : '';
    const text = recText !== '' ? recText : (typeof REASON_TEXT[code] === 'string' ? REASON_TEXT[code] : '');
    const raw = typeof rec.reasonEvidence === 'string' && rec.reasonEvidence !== ''
      ? rec.reasonEvidence
      : (typeof rec.stderrExcerpt === 'string' ? rec.stderrExcerpt : '');
    const evidence = raw.replace(/\s+/g, ' ').trim().slice(0, FAILURE_EVIDENCE_CHARS);
    return ` NOTE: the most recent delegation failed${stamp} (${code})`
      + `${text === '' ? '' : `: ${text}`}${evidence === '' ? '' : ` | evidence: ${evidence}`}`;
  }

  // (b) 调用方取消 —— 措辞**同样**避开 fail 词干（连"not a failure"这种否定式也不用）：S1 的病害就是
  //     模型在提示里读到 fail* 就转述成"上次失败了"，否定式并不能阻止这一点。给的是"无需动作"这一事实，
  //     也**不**建议去改设置/换模型（用户主动取消，无错可改）。
  if (code === REASON_CODES.ABORTED) {
    return ` NOTE: the most recent delegation was cancelled by the caller${stamp} (${code}); no action is needed.`;
  }

  // (c) 未确认（unknown / 未登记码）—— 两边的结论都**不**替 CLI 下：这就是与判定行"未能判定"的同款口径。
  return ` NOTE: the most recent delegation's outcome could not be confirmed${stamp} (${code}); `
    + 'do not assume it succeeded and do not report it as an error.';
}

/**
 * 依据 runtime 的当前状态生成可用性说明。
 * 纯函数：不读全局、不产生副作用；可在每次 section 求值时重算。
 *
 * @param {object} runtime
 * @returns {string}
 */
export function availabilityText(runtime) {
  const probe = runtime.detected();
  const registry = runtime.registry();

  // ★ PRD-v4 B1：OFF 的判定权在**开关**，不在探测状态。B1 之前 OFF 必然已有探测结论
  //   （v3 无条件探测 ⇒ 落到下面的 probe 分支）；B1 之后 OFF ⇒ 探测从未启动 ⇒ probe===null
  //   会掉进"还在确定"分支 —— 对"用户亲手关掉"的情形是假状态。⇒ 开关 OFF 是最高优先级分支。
  //   句子逐字保留（既有契约），只改它的到达路径。stub 无 currentConfig 不得抛（可选链）。
  if (runtime.currentConfig?.()?.enabled === false) {
    return 'WorkBuddy delegation is currently switched OFF by the user (plugin settings). The tools are not offered; '
      + 'do not attempt to delegate. If the user really needs it, ask them to enable the plugin in its settings.';
  }
  if (!probe) {
    // ★ 下发健康 C 组：**未结论不等于未安装**，措辞也不能替注册器说话。
    //   工具现在会在探测在途期间乐观在场（`tools/index.js` 的 `want`），此时旧文案"tools are not offered"
    //   就成了假状态（模型据此会放弃一次本可成功的下发）⇒ 跟着 `registry` 实况说。
    //   两条旧句子**逐字保留**在各自仍然为真的分支里（既有契约）。
    if (registry === REGISTRY_STATES.REGISTERED) {
      return 'WorkBuddy availability is still being determined (the read-only detection has not finished yet). '
        + 'The workbuddy_run / workbuddy_status tools are offered in the meantime: a run started now waits for '
        + 'that detection and is rejected only if the CLI turns out to be absent.';
    }
    return 'WorkBuddy delegation is unavailable: availability is still being determined. '
      + 'The workbuddy_run / workbuddy_status tools are not offered.';
  }
  if (probe.installed !== true) {
    return 'WorkBuddy delegation is unavailable: the WorkBuddy desktop was not found on this machine. '
      + 'The workbuddy_run / workbuddy_status tools are not offered.';
  }
  if (registry === REGISTRY_STATES.REGISTERED || registry === REGISTRY_STATES.DEGRADED) {
    /**
     * ★ 下发健康 C 组：DEGRADED 有一类成因**与"能不能启动"无关** —— 工具注册本身失败（重名被别的插件
     *   占走）。那一类下工具**确实不在场**（`tools/index.js` 已回滚），此时若仍说 "delegation is available:
     *   use workbuddy_run" 就是让模型去调一个不存在的工具。故障原因由 runtime 承载，不靠猜。
     */
    const registrationFailure = typeof runtime.registrationError === 'function' ? runtime.registrationError() : null;
    if (typeof registrationFailure === 'string' && registrationFailure !== '') {
      return 'WorkBuddy delegation is unavailable right now: its tools could not be registered on this host ' +
        `(${registrationFailure}). The workbuddy_run / workbuddy_status tools are not offered; ` +
        'tell the user another plugin may already own those tool names, and do not retry delegating.';
    }
    /**
     * DEGRADED 有**四个**互不相同的成因，措辞不得只认其中一个：
     *   ① `run.js` 运行期缺失（node 跑不起来）② `run.js` 真启动失败（"用户取消"不算）
     *   ③ `run.js` §4.5 判定 `flagVerdict==='rejected'`（参数被拒 —— 退出码可能仍为 0）
     *   ④ `tools/index.js` 注册失败回滚（与"有没有启动过"**完全无关**；已由上面的
     *      `registrationFailure` 分支单独成句 —— 那一类工具不在场）
     * 旧文案 "the last launch failed" 对 ④ 是纯错误信息、对 ③ 也不准。这里只陈述状态本身，
     * 具体原因交给紧随其后的 `lastFailureHint(runtime)`（有失败码时才出）。
     */
    const degraded = registry === REGISTRY_STATES.DEGRADED
      ? ' Note: this plugin is registered but degraded; call workbuddy_status for the current state.'
      : '';
    return (
      'WorkBuddy delegation is available: use workbuddy_run to delegate a coding task as a background job '
      + '(read progress with job_output, cancel with job_kill), and workbuddy_status to inspect the local '
      + 'WorkBuddy install and the most recent run.'
      + subagentRouteHint() + debateHint() + continuityHint(runtime) + degraded
      + overrideHint(runtime) + lastFailureHint(runtime)
    );
  }
  if (registry === REGISTRY_STATES.UNKNOWN) {
    return 'WorkBuddy availability is being re-evaluated (settings changed); the tools are temporarily not offered.';
  }
  return 'WorkBuddy delegation is currently switched OFF by the user (plugin settings). The tools are not offered; '
    + 'do not attempt to delegate. If the user really needs it, ask them to enable the plugin in its settings.';
}
