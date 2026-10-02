/**
 * 参数接受度记录（★ §4.5 落点；T04 核心交付之一）。
 *
 * Implements: 02-design/DESIGN-v3.md §4.5（逐字：`lastRun = {argv, exitCode, stderrExcerpt, flagVerdict}`；
 *             accepted|rejected|unknown；UI 在 rejected 时回滚"未指定"）；
 *             04-docs/RECON-WINDOW-RESULT.md §5 **D-3**（真机**退出码不可信**：`--model <不存在>` 时
 *             stdout 空、stderr 打 400、**exit code = 0** ⇒ 单看退出码会把失败判成成功）
 *
 * 判据（**可被单测逐条证伪**，见 test/verdict.test.js）：
 *   1. `rejected`：**拒参证据面**里出现"参数被拒"证据（reason-codes.flagRejectionEvidence）——
 *      三个面 = stderr（进程级解析失败）/ 帧内**错误**字段 `frameErrorText` / 非 JSON 行 `unparsedText`；
 *      含真机 `400 model [xxx] service info not found` 形态。
 *      ★ **模型正文不作证据**：成功帧的 `result.result` 与 assistant 帧文本里复述
 *      `EADDRINUSE` / "unknown option" / "配额不足" 曾把一次**成功**判成 rejected（2026-09-19 S1 根因）。
 *   2. `accepted`：无拒绝证据 **且** exitCode === 0 **且** 未中止 **且** 未启动失败 **且**
 *      （帧数 > 0 **或** stderr 无错误迹象）。
 *      "帧数 > 0" 是**正向证据**：真机失败样本 stdout 为空、无任何帧；有帧 ⇒ 选项解析阶段已通过
 *      （CLI 先解析 argv 再执行任务）。缺此正向证据时只能给 `unknown`——**不拿"退出码 0"当接受证据**。
 *   3. `unknown`：其余全部（非 0 退出、被中止、启动失败、无帧且 stderr 有错误迹象、窗口截断到无法判断）。
 *   4. 终态 `reasonCode`：`succeeded` = accepted **且** 未报任务错 **且** exitCode === 0 **且**
 *      `!isFailureCode(归因码)` ⇒ `ok` 只在**没有失败归因**时给出（`unknown`/`aborted` 不是失败归因，
 *      不得强判 failed）；已归一出失败码时**原样保留**，不许被"exit 0"覆写成 ok。
 *
 * 诚实边界：
 *   - 逐 flag 归因（`flags[]`）只在证据里**点名**该 flag / 命中其取值时给 `rejected`，否则该 flag 记
 *     `unknown`——聚合值 rejected 不等于"每个 flag 都被拒"。UI 侧（§4.5 逐字）仍整体回滚"未指定"。
 *   - `stderrExcerpt` 首 2KB（§4.5 逐字）先**脱敏**再截断（R3-19：不把凭据写进记录/卡片）。
 *   - 本模块不启动任何程序；只对已回收的输出做判定。
 *
 * 约束：本文件属于 packages/*​/src（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 */

// ★ 脱敏/notSent 词汇表已随 CLI 一起从 `argv.js` 拆到 `run-report.js`（2026-10-02）。
import { NOT_SENT_HINT, redactArgv, redactText } from './run-report.js';
import { parseFrames, summariseFrames, framesIndicateError } from './stream-json.js';
import { REASON_CODES, REASON_TEXT, classifyFailure, flagRejectionEvidence, isFailureCode } from './reason-codes.js';

/** §4.5 取值域（SSOT）。 */
export const FLAG_VERDICTS = Object.freeze({
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  UNKNOWN: 'unknown',
});

/**
 * `init` 帧字段的**来源**取值域（SSOT；WB-2）。
 *
 * 为什么必须把来源写进记录：同一个 `initModel` 可能来自两处 —— 内存里的**保留窗口尾部**，或溢出后
 *   我们自己落盘的那份**完整流的头部**。两者是不同强度的证据（窗口形态是"CLI 说过且我们还留着"，
 *   落盘形态是"CLI 说过、文件里写着、我们刚读回来"），混成一个字段就会让人把兜底值当成窗口值去推理。
 *   值为 `null` 时来源也是 `null`：**没有值就没有来源**，不写 `'unavailable'` 之类的假出处。
 */
export const INIT_SOURCES = Object.freeze({
  WINDOW: 'retained-window',
  SPILL_HEAD: 'spill-head',
});

/** §4.5 逐字：stderr 摘录首 2KB。 */
export const STDERR_EXCERPT_LIMIT = 2048;

/** stderr 里的"有错"迹象（用于在**没有帧**时拒绝给 accepted 结论）。 */
const STDERR_ERROR_MARKER = /\b(error|failed|failure|denied|refused|invalid|not found|unauthorized|exception)\b/i;

/**
 * stderr 摘录：先脱敏再截断（顺序不可颠倒——先截断会把凭据切成半截而使脱敏正则失配）。
 *
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
export function stderrExcerpt(text, limit = STDERR_EXCERPT_LIMIT) {
  if (typeof text !== 'string' || text === '') return '';
  const clean = redactText(text);
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit)}\n…（截断：stderr 共 ${clean.length} 字符，仅保留首 ${limit}）`;
}

/** 正则元字符转义（证据是**外部文本**，不能直接拼进正则）。 */
function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 证据里是否出现**旗标 token**（`--x` / `-x` 形状）——用于决定是否允许"按取值兜底点名"。 */
const ANY_FLAG_TOKEN_RE = /--?[A-Za-z][A-Za-z0-9_-]*/;

/**
 * evidence 是否**点名**了这个 flag？
 *
 * 三种命中形态（缺一不可 —— 少一种就会在最关键的样本上答 "unknown"）：
 *   ① 逐字 flag token（`unknown option '--model'`、`invalid value for --effort`）；
 *   ② 去掉前导 `-` 的词（真机样本是 `400 model [xxx] service info not found`，**不带** `--`）；
 *   ③ flag 的取值（`must be one of: high|low` 这类只点值不点名的形态）。
 *
 * ★ 形态① 必须是 **token 边界**匹配，不能是 `includes`：
 *   `-m`（可配置的短拼写）与 `--model` 是前缀关系，`includes('-m')` 会把 `--model` 误当成 `-m`。
 * ★ 形态③ 必须**让位**于①②：取值是任意用户输入，按子串点名的误伤面很大
 *   （实测：model 取值 `gpt-5-high` 会让 effort 取值 `high` 的行被判成"被拒"）。
 *   故仅当证据里**没有任何旗标 token**时，才允许按取值/裸词兜底。
 *
 * @param {string} evidence @param {string} flag @param {string} value
 */
function evidenceNamesFlag(evidence, flag, value) {
  if (typeof evidence !== 'string' || evidence === '') return false;
  if (typeof flag !== 'string' || flag === '') return false;
  // ① token 边界命中
  if (new RegExp(`(^|[^A-Za-z0-9_-])${escapeRe(flag)}(?![A-Za-z0-9_-])`).test(evidence)) return true;
  const bare = flag.replace(/^-+/, '');
  if (bare.length < 2) return false; // 单字符裸词（`-m`）无区分度 ⇒ 不靠裸词点名
  // ② 裸词
  if (new RegExp(`(^|[^A-Za-z0-9_-])${escapeRe(bare)}(?![A-Za-z0-9_-])`, 'i').test(evidence)) return true;
  // ③ 取值兜底：仅当证据里没有旗标 token（否则该由①②点名，别拿取值猜）
  if (ANY_FLAG_TOKEN_RE.test(evidence)) return false;
  if (typeof value !== 'string' || value === '') return false;
  return new RegExp(`(^|[^A-Za-z0-9_-])${escapeRe(value)}(?![A-Za-z0-9_-])`).test(evidence);
}

/**
 * 逐 flag 归因。
 *
 * ★ `source` 必须**原样保留**（`config.model` / `config.effort` / `plugin.outputFormat` / `session.cliSessionId`）：
 * 客户端据此把"被拒绝的参数"精确落到对应下拉行（§4.5「在模型/强度下拉**旁**显示 ⚠」），
 * 而不必硬编码 flag 拼写 —— 旗标名来自配置（`launch.modelFlag` 等，可被改写成 `-m`/`--reasoning-effort`）。
 * 丢掉 source ⇒ 客户端只能"整体回滚两行"，会把**没被拒的那一行**也显示成"未指定"（假状态，见 B-T04-4）。
 *
 * @param {Array<{flag: string, value: string, source?: string}>} flags 本次**实际下发**的可配置 flag（由 argv 组装返回）
 * @param {'accepted'|'rejected'|'unknown'} verdict
 * @param {string} evidence
 * @returns {Array<{flag: string, value: string, source: string, verdict: string, evidence: string}>}
 */
function attributeFlags(flags, verdict, evidence) {
  const list = Array.isArray(flags) ? flags : [];
  return list.map((entry) => {
    // 形态健壮性：flags 由 argv 组装产生，但会被写进会话记录/载荷并再度读回 ⇒ 不信任其形态。
    // 曾经 `flags:[null]` 会让本函数抛 TypeError、`[{flag:123}]` 会在 evidenceNamesFlag 里炸。
    const { flag, value, source } = entry !== null && typeof entry === 'object' ? entry : {};
    const flagName = typeof flag === 'string' ? flag : '';
    const flagValue = typeof value === 'string' ? value : '';
    const src = typeof source === 'string' ? source : '';
    if (flagName === '') {
      return { flag: '', value: flagValue, source: src, verdict: FLAG_VERDICTS.UNKNOWN, evidence: 'flag 名缺失/非字符串，无法归因' };
    }
    if (verdict === FLAG_VERDICTS.ACCEPTED) {
      return { flag: flagName, value: flagValue, source: src, verdict: FLAG_VERDICTS.ACCEPTED, evidence: '' };
    }
    if (verdict === FLAG_VERDICTS.REJECTED) {
      return evidenceNamesFlag(evidence, flagName, flagValue)
        ? { flag: flagName, value: flagValue, source: src, verdict: FLAG_VERDICTS.REJECTED, evidence }
        : { flag: flagName, value: flagValue, source: src, verdict: FLAG_VERDICTS.UNKNOWN, evidence: '聚合判据为 rejected，但证据未点名该参数' };
    }
    return { flag: flagName, value: flagValue, source: src, verdict: FLAG_VERDICTS.UNKNOWN, evidence: '' };
  });
}

/**
 * 「有意图但没上线」清单的条数上限（这份记录会进模型可见的 `workbuddy_status` 载荷，不能无界）。
 * 现实里最多同时出现 5 项（outputFormat / model / effort / permissionMode / resume）。
 */
const NOT_SENT_LIMIT = 16;

/**
 * 归一 `buildArgv()` 交来的 `notSent[]`（★ 下发健康 A 组的记录面）。
 *
 * 与 `flags[]` 的分工是**这条设计的正文**：`flags[]` 是"线上实际有什么"，会被逐条送进 CLI 接受度归因；
 * `notSent[]` 是"要了但没上去"，**绝不参与归因** —— 让一条拒绝证据去点名一个根本没下发的旗标，
 * 就是凭空造出一个 `rejected`（B-T04-4 家族：客户端会据此回滚一行根本没动的设置）。
 *
 * @param {unknown} list
 * @returns {Array<{flag: string|null, value: string|null, source: string, reason: string, hint: string}>}
 */
function normaliseNotSent(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (out.length >= NOT_SENT_LIMIT) break;
    const entry = raw !== null && typeof raw === 'object' ? raw : {};
    const reason = typeof entry.reason === 'string' && entry.reason !== '' ? entry.reason : 'unspecified';
    out.push({
      flag: typeof entry.flag === 'string' && entry.flag !== '' ? entry.flag : null,
      // 取值可能来自用户设置（如被塞进 model 字段的凭据）⇒ 与其余对外文本同一脱敏路径（R3-19）。
      value: typeof entry.value === 'string' && entry.value !== '' ? redactText(entry.value) : null,
      source: typeof entry.source === 'string' ? entry.source : '',
      // 空原因 = 上游漏填。留着它并标 `unspecified`，比静默丢一条"东西没发出去"的事实好。
      reason,
      hint: NOT_SENT_HINT[reason] ?? '',
    });
  }
  return out;
}

/**
 * 落盘路径的归一：只认**非空字符串**，其余（含 `undefined` / 空串 / 数字）一律 `null`。
 *
 * 为什么不能用空串当"没有"：`lastRun` 会进模型可见的 `workbuddy_status` 载荷，而 `''` 与 `null` 在
 *   消费端读起来是两件事 —— `''` 像"有字段但值丢了"，`null` 才是"这次运行没有完整副本"（WB-1 的判据）。
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function spillPathOf(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 生成 §4.5 的 `LastRunRecord`（+ 本层额外证据字段，客户端只消费 §4.5 四字段）。
 *
 * @param {{ argv?: string[], exitCode?: number|null, signal?: string|null,
 *           stdoutText?: string, stderrText?: string, stdoutTruncated?: boolean,
 *           stdoutSpillPath?: string|null, stderrSpillPath?: string|null,
 *           spillInitHead?: (() => string|null)|null,
 *           spawnError?: string|null, aborted?: boolean,
 *           flags?: Array<{flag: string, value: string}>,
 *           notSent?: Array<{flag: string|null, value: string|null, source: string, reason: string}>,
 *           sessionId?: string|null, sessionIdSource?: string|null,
 *           runtime?: { nodePath?: string, nodeSource?: string }|null,
 *           at?: number }} input
 * @returns {object} LastRunRecord
 */
export function buildLastRun(input) {
  const {
    argv = [], exitCode = null, signal = null,
    stdoutText = '', stderrText = '', stdoutTruncated = false,
    stdoutSpillPath = null, stderrSpillPath = null, spillInitHead = null,
    spawnError = null, aborted = false,
    flags = [], notSent = [], sessionId = null, sessionIdSource = null, runtime = null, at = Date.now(),
  } = input ?? {};

  const parsed = parseFrames(stdoutText);
  const summary = summariseFrames(parsed);
  const excerpt = stderrExcerpt(stderrText);

  // ── WB-2：`init` 帧的**落盘头部兜底**（信息面补全，不改任何判定）────────────────────
  // 保留窗口只留尾部 ⇒ 一次超过 64 KiB 的下发**必然**裁掉第一行的 `system/init` 帧
  //   （真机 2026-09-21：落盘文件第 0 字节写着 `"permissionMode":"default"`，同一次运行的 status 里
  //   `initModel`/`initPermissionMode` 双双为 `null`）。完整流就在我们自己申请落盘的那个文件里，
  //   所以这里补读它的**头部**，只取两个 init 字段。
  // ★ 三条硬边界，缺一条这条兜底就变成了新的不确定性来源：
  //   ① **只在窗口真的没给值时**才调用 reader（懒执行：reader 是一次同步文件读，不白读）；
  //   ② 头部文本**只**贡献 `initModel`/`initPermissionMode`。它的 `frameErrorText` / `unparsedText` /
  //      帧数**一律不取** —— 拒绝证据链必须只有"窗口里那份 stdout"这一个出处，否则同一事实两处裁决
  //      （且头部没有窗口的截断语义，半截帧的概率更高）。
  //   ③ 窗口已有值时**不覆盖**（窗口 = CLI 输出与我们读取之间最短的路径；兜底不得越权改写实测值）。
  let initModel = typeof summary.initModel === 'string' ? summary.initModel : null;
  let initPermissionMode = typeof summary.initPermissionMode === 'string' ? summary.initPermissionMode : null;
  let initModelSource = initModel === null ? null : INIT_SOURCES.WINDOW;
  let initPermissionModeSource = initPermissionMode === null ? null : INIT_SOURCES.WINDOW;
  if ((initModel === null || initPermissionMode === null) && typeof spillInitHead === 'function') {
    let head = null;
    try {
      head = spillInitHead();
    } catch {
      head = null; // 读不到 = 没有兜底来源；不因此改变任何判定，也不谎称出处
    }
    if (typeof head === 'string' && head !== '') {
      const headSummary = summariseFrames(parseFrames(head));
      if (initModel === null && typeof headSummary.initModel === 'string') {
        initModel = headSummary.initModel;
        initModelSource = INIT_SOURCES.SPILL_HEAD;
      }
      if (initPermissionMode === null && typeof headSummary.initPermissionMode === 'string') {
        initPermissionMode = headSummary.initPermissionMode;
        initPermissionModeSource = INIT_SOURCES.SPILL_HEAD;
      }
    }
  }

  // ★ 准入规则（2026-09-19 裁定，跨文件契约）：非 JSON 行**只有在本调用确实请求了 stream-json 时**
  //   才算证据面。理由是一条会出假警报的路径：`argv.js:235-239` 仅在 `launch.outputFormatFlag` 与
  //   `launch.streamJsonValue` **都非空**时才下发 `--output-format stream-json`；配置缺这两个键时
  //   （RECON D-3 记下的旧观测形态正是**没有** stream-json 的调用）stdout 整片就是模型正文 ⇒
  //   正文里复述"积分不足/EADDRINUSE"会把一次**成功**报成"账户没额度/端口冲突"，
  //   而配额假警报会把用户指去充值（比沉默更坏）。
  //   请求了 stream-json 时，stdout 理应是全 JSON，非 JSON 行只可能是 CLI 级诊断 ⇒ 才可当证据。
  //   判据取 `flags` 的来源标注（`source: 'plugin.outputFormat'`），**不比对 flag 字面量**：
  //   flag 名是数据（cordis.patch.yml），在代码里硬编码会让"改配置"静默失效。
  const streamJsonRequested =
    Array.isArray(flags) && flags.some((f) => f?.source === 'plugin.outputFormat');
  const unparsedEvidence = streamJsonRequested ? summary.unparsedText : '';

  // 拒绝证据面（三个面，按"最可能是证据"到"最兜底"排序）：
  //   ① stderr（进程级选项解析失败：`error: unknown option '--flag'`）
  //   ② 帧内**错误**面 frameErrorText（真机 400-model / 502 的落点：`result.errors[]` / `errors_info[].details`）
  //   ③ 非 JSON 行 unparsedText（**须过准入闸**：只在本调用请求了 stream-json 时才算，见上）
  //      —— 老版本把错误打成纯文本 stdout 的形态
  // ★ 为什么**移除**旧面的 ③`summary.resultText` 与 ④ 原始 `stdoutText`（2026-09-19 对抗审查 S1 根因）：
  //   这两面装的是**模型正文**（成功帧的 `result.result`、assistant 帧文本）。模型在回答里复述
  //   `EADDRINUSE`、`unknown option`、"配额不足"（文档/排障类任务极常见）时，正文会命中拒绝正则 ⇒
  //   一次**成功**被判成 rejected，而 flagVerdict 又被下游当"CLI 拒绝了参数"的证据面 ⇒ 假归因 + 假回滚。
  //   拒参证据的真机落点只有 ①②（stderr / 帧内错误字段）与 ③（非 JSON 行）；正文不在其中。
  // ★ 顺序即优先级：stderr 是进程级解析失败（选项压根没进 CLI），帧内错误字段是**CLI 自己认定的失败**，
  //   两者比"非 JSON 行"更权威（后者可能只是窗口截断出来的半截帧）。
  //   ③ 用 `unparsedEvidence`（经上方准入规则过滤）而不是 `summary.unparsedText`：未请求 stream-json 时
  //   那一面装的是模型正文，进了证据链就会把成功判成拒参。
  const rawEvidence =
    flagRejectionEvidence(stderrText) ??
    flagRejectionEvidence(summary.frameErrorText) ??
    flagRejectionEvidence(unparsedEvidence) ??
    null;
  // 证据会进会话记录/状态载荷/卡片 ⇒ 与 stderr 摘录同样先脱敏（R3-19：不落凭据）。
  const evidence = rawEvidence === null ? null : redactText(rawEvidence);

  // ★ 增量⑥ fix#2：权限拒绝证据（两个面 —— 结构化 `permission_denials` 与 `tool_result` 原文）。
  //   两件事必须分清，否则这一整块就白做了：
  //     ① **可见性**：只要 CLI 报了拒绝，就如实记进 LastRunRecord（`permissionDenials`），
  //        **无论本次判成成功还是失败**。一个"被拒了几次但模型绕过去了"的成功运行也该让人看见。
  //     ② **判定**：是否把终态改判成 `permission_denied` 由 `classifyFailure` 的"已失败"门控决定
  //        （见 reason-codes.js）。不在这里判 —— 信息面与判定面混在一处，就是旧实现的病根。
  //   脱敏在**收集时**做（不是展示时）：这些串会进状态载荷与作业输出正文。
  const denialList = Array.isArray(summary.permissionDenials)
    ? summary.permissionDenials.map((item) => redactText(item)).filter((item) => item !== '')
    : [];
  const denialTextFace = typeof summary.denialText === 'string' && summary.denialText !== ''
    ? redactText(summary.denialText)
    : '';

  let flagVerdict = FLAG_VERDICTS.UNKNOWN;
  if (evidence !== null) {
    flagVerdict = FLAG_VERDICTS.REJECTED;
  } else if (aborted !== true && spawnError === null && exitCode === 0) {
    const hasFrames = parsed.frames.length > 0;
    const stderrLooksBad = stderrText !== '' && STDERR_ERROR_MARKER.test(stderrText);
    if (hasFrames || !stderrLooksBad) flagVerdict = FLAG_VERDICTS.ACCEPTED;
  }

  const taskError = framesIndicateError(summary);
  // 入参形状 = `classifyFailure` 的完整契约（reason-codes.js 的 @param 逐条对应）。
  // ★ 为什么**不再传** `resultText` / `stdoutText`：归因表已把它们列为"不参与归因"的兼容入参
  //   （成功帧里那是模型正文）；继续传就是在给"正文当证据"留后门（见上方证据面注释）。
  //   `stdoutText` 仍用于解析帧与长度统计（`stdoutBytes`），但**不进归因**。
  // ★ `signal` 一并传：它是契约声明的入参，当前归一表尚未读它 —— 不传会让"归一表某天开始读 signal"
  //   时静默失效（进程被杀但 exitCode 缺省，我们拿不到任何信号面）。传了不会改变现有结论。
  const reason = classifyFailure({
    exitCode, signal, stderrText, unparsedText: unparsedEvidence,
    frameErrorText: summary.frameErrorText, errorSignals: summary.errorSignals,
    spawnError, aborted, taskError, flagVerdict,
    // ★ 增量⑥ fix#2：权限拒绝的两个证据面（结构化 + 工具输出）。**先脱敏**（R3-19）——它们会进
    //   LastRunRecord（模型可见载荷）与作业输出正文。门控不在这里：`classifyFailure` 只在本次下发
    //   **已失败**时才据此改判，未失败的运行靠记录字段/告知行暴露，不改终态（理由见那边的注释）。
    permissionDenials: denialList, denialText: denialTextFace,
  });

  // 归一为"本次下发是否成功"：accepted + 任务无错 + exit 0 **且归因面没有失败证据**才算 ok；其余一律保留具体原因码。
  // ★ 为什么 reasonText 必须与 reasonCode 同源（2026-09-19 真机踩到）：
  //   `classifyFailure()` **没有** ok 分支 —— 成功形态会一路落到它的 UNKNOWN 兜底。若只覆写
  //   reasonCode 而沿用 `reason.reasonText`，就会产出 `ok` + "未能归一出失败原因" 的**矛盾对**；
  //   而 lastRun 是**模型可见**载荷（workbuddy_status 工具直出）⇒ 模型会把成功误报成失败。
  //   （GUI 卡片侧另有 `reasonCode !== 'ok'` 守卫，所以这个矛盾只在模型/状态载荷面暴露。）
  //   两者同取自 `succeeded`，矛盾在构造上不可能出现。
  // ★ 也**不能**改成"classifyFailure 里 exit 0 即 ok"：`flagVerdict === 'unknown'`
  //   （CLI 认没认下参数我们并不知道）时那样会误报成功。unknown ≠ ok。
  // ★ `succeeded` 不是从 `reasonCode === 'ok'` 推导来的，而是**独立合取**（accepted + 无任务错 + exit 0）
  //   ⇒ 新原因码**不会**天然生效。故成功判据必须取"**没有失败归因**"= `!isFailureCode(reason.reasonCode)`，
  //   而不是枚举/排除某个码：旧的 `reasonCode !== QUOTA_EXHAUSTED` 只在"已知码恰好是 quota"时成立 ——
  //   `exit 0 + stderr 只有网络错误文本`（无帧 ⇒ accepted、无任务错、exit 0 三项全真）会被那一行
  //   覆写成 `ok`（把失败报成成功）；`transport_unreachable` / `no_session_resume` / `model_unavailable`
  //   等新码全部落在同一个洞里，且每加一个码就复发一次。
  // ★ 边界（不得为了好看而收紧）：`unknown`（没归一出来）与 `aborted`（调用方取消）**不是**失败归因
  //   ⇒ 不算失败；FAILURE_CODES 的取值域就是这条边界（见 reason-codes.js 同名注释）。
  const succeeded = flagVerdict === FLAG_VERDICTS.ACCEPTED && taskError !== true && exitCode === 0
    && !isFailureCode(reason.reasonCode);
  const reasonCode = succeeded ? REASON_CODES.OK : reason.reasonCode;
  const reasonText = succeeded ? REASON_TEXT[REASON_CODES.OK] : reason.reasonText;

  return {
    // ── §4.5 逐字四字段（客户端契约：argv 必须是**字符串**，见 lib/client.js:327）──
    // ★ 2026-09-22 P1：二层脱敏 —— redactArgv 只认 `--flag value`/`--flag=value` 的旗标名形态，
    //   位置参数与值体凭据（`-p Bearer …`、`--model sk-…`）必须由 redactText 接住（顺序同 toPreviewLine：
    //   redactArgv → redactText → 截断），否则凭据原样落 lastRun 记录。
    argv: redactText(redactArgv(Array.isArray(argv) ? argv : []).join(' ')),
    exitCode: Number.isInteger(exitCode) ? exitCode : -1,
    stderrExcerpt: excerpt,
    flagVerdict,
    // ── 本层证据（供状态载荷/日志；不改变上述四字段语义）──
    flags: attributeFlags(flags, flagVerdict, evidence ?? ''),
    notSent: normaliseNotSent(notSent),
    flagEvidence: evidence ?? '',
    reasonCode,
    reasonText,
    reasonEvidence: typeof reason.evidence === 'string' ? redactText(reason.evidence) : '',
    signal: typeof signal === 'string' ? signal : null,
    taskError,
    frames: parsed.frames.length,
    frameTypes: summary.types,
    parseErrors: parsed.parseErrors,
    resultSubtype: summary.resultSubtype,
    initModel,
    initModelSource,
    initPermissionMode,
    initPermissionModeSource,
    permissionDenials: denialList,
    permissionDenialCount: Number.isInteger(summary.permissionDenialCount)
      ? summary.permissionDenialCount
      : denialList.length,
    sessionId: typeof sessionId === 'string' && sessionId !== '' ? sessionId : null,
    sessionIdSource: typeof sessionIdSource === 'string' ? sessionIdSource : null,
    // ★★ token 用量（2026-09-27）：积分扣减的**唯一可观测输入**。
    //   CLI 的 result 帧把 `total_cost_usd` **写死 0**、usage 只装 token（实测三处构造点），
    //   且 `-p` 模式不落盘 ⇒ **拿不到积分真值**，token 是唯一的代理量。
    //   ⚠ 失败时这些字段**全为 0**（401 那次实测如此）⇒ 0 不等于"没用 token"，
    //     只说明"这次没跑起来"；消费方须结合 reasonCode 判，别拿 0 当消耗记账。
    //   取不到 ⇒ `null`（未知），不是 0。
    usage: summary.resultUsage ?? null,
    stdoutTruncated: stdoutTruncated === true,
    // ★ WB-1：落盘路径进结构化面。此前 `spillPath` 只出现在**给人看的那行作业通知**里（`truncationNote()`），
    //   `workbuddy_status` / 会话记录里拿不到 ⇒ 主控与自动化**看不见完整流在哪**，只能靠翻日志找回现场。
    //   无落盘 ⇒ `null`（不是空串，见 `spillPathOf`）。两条流分开记：溢出可能是 stdout、stderr 或两者。
    stdoutSpillPath: spillPathOf(stdoutSpillPath),
    stderrSpillPath: spillPathOf(stderrSpillPath),
    stdoutBytes: Buffer.byteLength(typeof stdoutText === 'string' ? stdoutText : '', 'utf8'),
    stderrBytes: Buffer.byteLength(typeof stderrText === 'string' ? stderrText : '', 'utf8'),
    runtime: runtime === null || typeof runtime !== 'object'
      ? null
      : { nodePath: String(runtime.nodePath ?? ''), nodeSource: String(runtime.nodeSource ?? '') },
    at,
  };
}
