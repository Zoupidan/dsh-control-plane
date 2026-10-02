/**
 * stream-json 帧解析（T04 新增；★ D-4 落点 + §5.3 会话 ID 抽取的**唯一**解析器）。
 *
 * Implements: 04-docs/RECON-WINDOW-RESULT.md §4.4（真实帧样本）· §5 D-4（按 type 判别，不按序号读）；
 *             02-design/DESIGN-v3.md §5.1/§5.3（记录 CLI 侧会话 ID，供 resume 下发）
 *
 * 为什么单独成文件（相对 §10 T04 的文件清单 +1，已登记）：
 *   verdict.js（D-3：解析 stderr/结果帧判参数接受度）与 session/map.js（§5.3：抽 session_id）都要读同一份
 *   JSONL 输出。若各自实现一份正则，**两份解析器会漂移**（同一份真机输出得出两种结论）
 *   ⇒ 抽成本模块，两个消费者共享同一实现。
 *
 * 真机形态（受控窗口取证，逐字见 RECON §4.4）：
 *   `--output-format stream-json` 每行一个 JSON 对象；`session_id` 出现在**每一帧**；
 *   首帧 `type:'system', subtype:'init'` 携带 session_id/uuid/cwd/tools/model/permissionMode；
 *   末帧 `type:'result', subtype:'success', is_error:false, result:'...'`；
 *   工具调用结果落在 `{type:'user'|…}` 帧的 `message.content[]` 里、`type:'tool_result'` 块（增量⑥：
 *   权限拒绝原文的唯一落点 —— 它既不在 stderr，也不在 result 帧）；
 *   帧数随任务变化 ⇒ 任何"按 printf 序号/第 N 行读"的实现都是错的。
 *
 * 诚实边界：
 *   - 保留窗口（readFrom 的 maxBytes 尾部）**可能从帧中间开始**，也可能在帧中间结束 ⇒ 首/末行可能是
 *     残帧。本模块对残帧**不抛异常**，标记 `incomplete` 并继续（`lossy` 语义由调用方另行记账）。
 *   - `session_id` 字符集按 RECON §4.2 实测约束校验；不合法的候选一律判为"抽不到"（**不猜**）——
 *     错挂会话 ID 会把新任务塞进旧对话，比抽不到更糟。
 *
 * 约束：本文件属于 packages/*​/src（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 */

/** RECON §4.2 实测：`--session-id` 值字符集 = 字母数字 + `-` `_` `:`，且必须以字母数字开头。 */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/;

/** 帧内错误文本的收集上限（够放下一条 400 + 支持模型清单；不进卡片，只做证据面）。 */
const FRAME_ERROR_TEXT_LIMIT = 16384;

/** 权限拒绝证据的收集上限（结构化条数 / 文本面字符数）—— 证据面要小到能进状态载荷。 */
const DENIAL_ITEMS_LIMIT = 16;
const DENIAL_TEXT_LIMIT = 2048;

/**
 * 权限拒绝的**文本形态**（真机逐字，2026-09-19 两次真实下发取证）。
 *
 * CLI 原话：`Error: Permission to use Bash has been denied because this tool requires approval but
 * permission prompts are not available in non-interactive mode.`
 * （受控探针 D1/D2/D3：`permissionMode:'default'` + 写命令 ⇒ `permission_denials: 2`；
 *   `--permission-mode bypassPermissions` ⇒ 0；`~/.codebuddy/settings.json` 白名单放行 ⇒ 0。）
 *
 * ★ 为什么收得这么窄：这面会在"读日志/写文档/讨论权限"的**工具输出**里被撞上，泛化的
 *   `permission denied` 会造出假证据。故只保留两条**完整句式**，通用词留作最后的兜底
 *   （`reason-codes.js` 的 `PATTERNS.permission` 与之同源，两处必须一起改）。
 */
const DENIAL_PATTERNS = [
  /Permission to use [^\n]{0,80}? has been denied/i,
  /permission prompts are not available/i,
  /requires approval but permission/i,
  /\bpermission denied\b/i,
];

/** `tool_result` 块的文本（`content` 可为字符串或 `[{type:'text',text}]`；缺字段一律空串）。 */
function toolResultTextOf(part) {
  const content = part?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    let out = '';
    for (const item of content) {
      if (typeof item === 'string') out += `${item}\n`;
      else if (typeof item?.text === 'string') out += `${item.text}\n`;
    }
    return out;
  }
  return typeof part?.text === 'string' ? part.text : '';
}

/** 命中拒绝句式时回传**原文片段**（截 200 字符，供人核对），否则 null。 */
function firstDenialHit(text) {
  if (typeof text !== 'string' || text === '') return null;
  for (const re of DENIAL_PATTERNS) {
    const m = re.exec(text);
    if (m !== null) return text.slice(m.index, m.index + 200).replace(/\s+/g, ' ').trim();
  }
  return null;
}

/**
 * `result.permission_denials[]` 的一项 → 短串（**不猜结构**：字符串原样、对象挑常见字段、
 * 其余 JSON 兜底切片）。空串表示"这项没内容"，调用方忽略。
 */
function normalizeDenialItem(item) {
  if (typeof item === 'string') return item.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (item !== null && typeof item === 'object') {
    const name = item.tool_name ?? item.toolName ?? item.tool ?? item.name ?? item.command ?? '';
    const reason = item.reason ?? item.message ?? item.error ?? item.description ?? item.details ?? '';
    const head = `${name === '' ? '' : String(name)}${reason === '' ? '' : `${name === '' ? '' : ': '}${String(reason)}`}`;
    if (head.trim() !== '') return head.replace(/\s+/g, ' ').trim().slice(0, 200);
    try {
      return JSON.stringify(item).replace(/\s+/g, ' ').trim().slice(0, 200);
    } catch {
      return '';
    }
  }
  return '';
}


/**
 * 会话 ID 合法性（argv 组装与抽取**共用同一判据** —— 避免"抽得出但下不发"或反之）。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidSessionId(value) {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

/** 从文本里捞 session_id 的兜底正则（仅当 JSON 帧解析失败/无 session_id 字段时使用）。 */
const SESSION_ID_INLINE_RE = /"session_id"\s*:\s*"([^"\\]{1,128})"/;

/**
 * 逐行解析 JSONL。
 *
 * `unparsed` 收集**看着不像 JSON**的非空行（老版本"把错误打到 stdout 纯文本"的形态只能从这些行里认，
 *   `verdict.js` 证据面 ③ / `reason-codes.js` 兜底面）；`fragments` 收集**`{`/`[` 开头却解析失败**的行
 *   ——那是窗口截断出来的半截帧，其内容可能正是**助手正文**（64 KiB 保留窗口会在正文中间切断），
 *   当成证据就会把一次成功判成"账户没额度"⇒ 两者必须分开，且 `fragments` **绝不进证据面**
 *   （2026-09-19 裁定；`trailingPartial`/`incomplete` 帧仍照旧标记，供上层判断"输出是否可解析"）。
 *
 * @param {string} text 作业 stdout（可能是保留窗口的尾部 ⇒ 允许残帧）
 * @returns {{ frames: Array<{ index: number, value: object, raw: string, incomplete: boolean }>,
 *             unparsed: string[], fragments: string[], parseErrors: number, lines: number,
 *             trailingPartial: boolean }}
 */
export function parseFrames(text) {
  const source = typeof text === 'string' ? text : '';
  const lines = source.split(/\r?\n/);
  /** @type {Array<{ index: number, value: object, raw: string, incomplete: boolean }>} */
  const frames = [];
  /** @type {string[]} 非 JSON 行（**不含**截断残片）——"CLI 把错误写成纯文本"的唯一证据面 */
  const unparsed = [];
  /** @type {string[]} JSON 形状但解析失败的行 = 截断残片（展示用，**不是**证据） */
  const fragments = [];
  let parseErrors = 0;
  // 末行若是"没有换行结尾"的半行，单独标记：它可能被 maxBytes 窗口截断（也可能是正常结尾）。
  const lastIndex = lines.length - 1;
  const trailingPartial = lastIndex >= 0 && lines[lastIndex] !== '' && !/(\r?\n)$/.test(source);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    try {
      const value = JSON.parse(raw);
      if (value === null || typeof value !== 'object') {
        parseErrors += 1;
        unparsed.push(raw);
        continue;
      }
      frames.push({ index: frames.length, value, raw, incomplete: false });
    } catch {
      parseErrors += 1;
      // ★ 分类而不是一律当证据：`{`/`[` 开头 = 半截帧（正文碎片可能落在里面）⇒ 只进 fragments；
      //   其余（`error: unknown option`、`EADDRINUSE`、`insufficient credits`）才是 CLI 级诊断文本。
      const trimmed = raw.trimStart();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) fragments.push(raw);
      else unparsed.push(raw);
      // 残帧（窗口边界）不抛：标记为 incomplete 的证据，供上层判断"输出是否可解析"。
      if (i === lastIndex) frames.push({ index: frames.length, value: {}, raw, incomplete: true });
    }
  }
  return { frames, unparsed, fragments, parseErrors, lines: lines.length, trailingPartial };
}

/**
 * 单帧的 session_id（真机每帧都有；`uuid` 是**帧**标识，不是会话标识 ⇒ 绝不混用）。
 * @param {object} value
 * @returns {string|null}
 */
function sessionIdOf(value) {
  const id = value?.session_id;
  if (typeof id !== 'string') return null;
  return SESSION_ID_RE.test(id) ? id : null;
}

/**
 * 从作业输出抽取会话事实（§5.1：cliSessionId / cwd；§5.3：新建会话 ⇒ 记下 ID）。
 *
 * 优先级：`system/init` 帧 > 任意帧的 session_id > 文本正则兜底。
 * 全部失败 ⇒ `cliSessionId: null` 且给出 `source: null`（**不猜**）。
 * `cwd` / `model` / `permissionMode` 只取自 `system/init` 帧（真机仅该帧携带，RECON §4.4）——
 * 其它帧的同名字段不做"就近取值"，避免把子代理/工具上下文的值当会话事实。
 *
 * @param {string} text
 * @returns {{ cliSessionId: string|null, source: 'init'|'frame'|'regex'|null, cwd: string|null,
 *             model: string|null, permissionMode: string|null, uuid: string|null,
 *             frames: number, parseErrors: number, raw: string }}
 */
export function extractSessionId(text) {
  const { frames, parseErrors } = parseFrames(text);
  for (const frame of frames) {
    const value = frame.value;
    if (value.type === 'system' && value.subtype === 'init') {
      const id = sessionIdOf(value);
      if (id !== null) {
        return {
          cliSessionId: id,
          source: 'init',
          cwd: typeof value.cwd === 'string' && value.cwd !== '' ? value.cwd : null,
          model: typeof value.model === 'string' && value.model !== '' ? value.model : null,
          permissionMode: typeof value.permissionMode === 'string' ? value.permissionMode : null,
          uuid: typeof value.uuid === 'string' ? value.uuid : null,
          frames: frames.length,
          parseErrors,
          raw: frame.raw,
        };
      }
    }
  }
  for (const frame of frames) {
    const id = sessionIdOf(frame.value);
    if (id !== null) {
      return {
        cliSessionId: id, source: 'frame', cwd: null, model: null, permissionMode: null, uuid: null,
        frames: frames.length, parseErrors, raw: frame.raw,
      };
    }
  }
  const source = typeof text === 'string' ? text : '';
  const inline = SESSION_ID_INLINE_RE.exec(source);
  if (inline !== null && SESSION_ID_RE.test(inline[1])) {
    return {
      cliSessionId: inline[1], source: 'regex', cwd: null, model: null, permissionMode: null, uuid: null,
      frames: frames.length, parseErrors, raw: inline[0],
    };
  }
  return {
    cliSessionId: null, source: null, cwd: null, model: null, permissionMode: null, uuid: null,
    frames: frames.length, parseErrors, raw: '',
  };
}

/**
 * `errors_info[]` 单条（真机形态：`{status, code, category?, details}`）归一为结构化错误信号。
 *
 * 真机两例（2026-09-19 本机 WorkBuddy 2.137.1，逐字入库见 04-docs/）：
 *   - `--model <不存在>` ⇒ `{status:400, code:11102, details:"400 model [x] service info not found …"}`
 *   - 死代理           ⇒ `{status:502, code:3002, category:"network", details:"502 连接被拒绝…"}`
 * 官方文档把码分成模型侧/网络/频率/输入过长几族 ⇒ **数字码是权威证据**（契约
 * `contracts/reason-codes.ts:extractQuotaSignal` 同款原则：数字码优先，文案兜底）。故这里只做
 * 结构抽取，**不**解释语义（映射表在 reason-codes.js，一处定义）。
 *
 * @param {unknown} value
 * @returns {{ status: number|null, code: number|null, category: string|null, details: string }|null}
 */
function errorSignalOf(value) {
  if (value === null || typeof value !== 'object') return null;
  const src = /** @type {any} */ (value);
  const num = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
    // 纯数字字符串也收（不同版本可能把码序列化成字符串）；其余一律 null（**不猜**）。
    if (typeof v === 'string' && /^\d{1,9}$/.test(v)) return Number(v);
    return null;
  };
  const signal = {
    status: num(src.status),
    code: num(src.code),
    category: typeof src.category === 'string' && src.category !== '' ? src.category : null,
    details: typeof src.details === 'string' ? src.details : '',
  };
  if (signal.status === null && signal.code === null && signal.category === null && signal.details === '') {
    return null;
  }
  return signal;
}

/**
 * 结果帧摘要（D-3：`result.is_error` / `subtype` 是"exit 0 但失败"的证据面之一）。
 *
 * ★ 证据面与正文面**必须分开**（2026-09-19 对抗审查 S1/S4 + 真机复核，本函数的根本职责）：
 *   旧实现把 `assistant` 帧的 `message.content[].text` 也拼进 `frameErrorText`，而 `frameErrorText` 是
 *   flag/quota 归因的证据面 ⇒ 模型在正文里讨论 `EADDRINUSE` / "unknown option" / 配额（文档类任务极常见）
 *   会把一次**成功**判成失败、把一次超时判成"账户没额度"。真机对照也证明这个混装没有必要：
 *     失败帧 `result` 的字段是 `errors[]` + `errors_info[]`（**没有** `result`/`error` 字段），
 *     成功帧的 `result` 才装模型正文 ⇒ "正文进证据面"纯属自伤。
 *   故本函数输出三个互斥面：
 *     - `frameErrorText`  ← **错误面**：`type:'error'` 帧的 `error`、`result.error`、`result.errors[]`、
 *                            `errors_info[].details`（真机 400/502 文本的落点）
 *     - `frameProseText`  ← **正文面**：assistant 文本；只可用于展示，**任何归因都不得读它**
 *     - `resultText`      ← 兼容字段（`result.result` 或 `result.error`）：成功帧里它是正文 ⇒ 同样不作为证据
 *   `unparsedText` 另给出"非 JSON 行"面（老版本把错误写成纯文本 stdout 的唯一形态）。
 *   ★ 第四面（增量⑥ fix#2）：`permissionDenials`/`permissionDenialCount`/`denialText` ← **工具输出面**
 *     （仅在 `tool_result` 块 `is_error:true` 且命中拒绝句式时才收集）。它不是正文面：模型正文不以
 *     `tool_result` 形态出现，故"正文永不作证据"这条纪律不被削弱。
 *
 * @param {ReturnType<typeof parseFrames>} parsed
 * @returns {{ types: string[], resultIsError: boolean|null, resultSubtype: string|null,
 *             resultText: string, frameErrorText: string, frameProseText: string,
 *             errorSignals: Array<{status: number|null, code: number|null, category: string|null, details: string}>,
 *             unparsedText: string, hasErrorFrame: boolean, initModel: string|null,
 *             initPermissionMode: string|null, incomplete: boolean,
 *             permissionDenials: string[], permissionDenialCount: number, denialText: string,
 *             resultUsage: {inputTokens:number|null,outputTokens:number|null,
 *                          cacheReadInputTokens:number|null,cacheCreationInputTokens:number|null}|null }}
 */
export function summariseFrames(parsed) {
  const types = [];
  let resultIsError = null;
  let resultSubtype = null;
  let resultText = '';
  /** @type {{inputTokens:number|null,outputTokens:number|null,cacheReadInputTokens:number|null,cacheCreationInputTokens:number|null}|null} */
  let resultUsage = null;
  let frameErrorText = '';
  let frameProseText = '';
  let hasErrorFrame = false;
  /** @type {Array<{status: number|null, code: number|null, category: string|null, details: string}>} */
  const errorSignals = [];
  let initModel = null;
  let initPermissionMode = null;
  let incomplete = false;
  // ── 权限拒绝证据（T04 增量⑥ fix#2）：两个来源分开记，别互相冒充 ──
  /** CLI 自己报的拒绝清单（`permission_denials`）归一后的**去重**短串，最多 DENIAL_ITEMS_LIMIT 条。 */
  const permissionDenials = [];
  /** 结构化项**总数**（含超上限没记下的）；0 表示"CLI 没给这个字段"。 */
  let denialItemsTotal = 0;
  /** `tool_result`(is_error) 面命中的**去重**原文条数（结构化字段缺失时的计数来源）。 */
  let denialTextHits = 0;
  /** 文本面命中的原文片段（**仅在结构化清单整体缺失时**才充当清单 —— 否则同一件事会有两种写法）。 */
  const denialFromText = [];
  let denialText = '';
  for (const frame of parsed.frames) {
    const value = frame.value;
    if (frame.incomplete === true) incomplete = true;
    // ★ 结构化拒绝清单：**逐帧**看（真机落在 `result` 帧，但不赌"只在那儿"）。字段不存在 ⇒ 一个字都不记。
    if (Array.isArray(value.permission_denials)) {
      denialItemsTotal += value.permission_denials.length;
      for (const item of value.permission_denials) {
        const norm = normalizeDenialItem(item);
        if (norm === '' || permissionDenials.includes(norm)) continue;
        if (permissionDenials.length < DENIAL_ITEMS_LIMIT) permissionDenials.push(norm);
      }
    }
    // ★ 工具输出面：拒绝**原文**只落在 `tool_result` 块里（不落 stderr、不落 result 帧）。
    //   三个收紧条件，缺一不可：① 块的 `is_error === true`；② 文本命中上面那两条完整句式；
    //   ③ 只读 `tool_result` 的 content —— `type:'text'` 块（模型正文）在本函数里**只**进
    //   `frameProseText`（见下方 assistant 分支），任何归因都不得读它。
    const content = value?.message?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type !== 'tool_result' || part.is_error !== true) continue;
        const hit = firstDenialHit(toolResultTextOf(part));
        if (hit === null || denialText.includes(hit)) continue;
        denialTextHits += 1;
        denialText += `${hit}\n`;
        // 同一条拒绝也进**文本面清单**（结构化字段整体缺失时才启用它）⇒ 清单与计数不会给出
        // "0 次拒绝却有 1 条证据"这种自相矛盾的载荷。
        if (denialFromText.length < DENIAL_ITEMS_LIMIT) denialFromText.push(hit);
      }
    }
    const type = typeof value.type === 'string' ? value.type : '(unparsed)';
    types.push(typeof value.subtype === 'string' ? `${type}/${value.subtype}` : type);
    if (type === 'error') {
      // ★ 真机：`--resume <不存在的 id>` 的唯一一帧是 94 字节的
      //   `{"type":"error","error":"No conversation found with session ID: …"}`（exit 0，无 result 帧、无 stderr）。
      //   旧实现整帧不看 ⇒ 任务什么都没发生却被判 ok。此帧是**明确的失败帧**，必须进证据面并置错误标志。
      hasErrorFrame = true;
      const text = typeof value.error === 'string' ? value.error : (typeof value.details === 'string' ? value.details : '');
      if (text !== '' && !frameErrorText.includes(text)) frameErrorText += `${text}\n`;
      const signal = errorSignalOf(value);
      if (signal !== null) errorSignals.push(signal);
    }
    if (type === 'result') {
      if (typeof value.is_error === 'boolean') resultIsError = value.is_error;
      if (typeof value.subtype === 'string') resultSubtype = value.subtype;
      if (typeof value.result === 'string') resultText = value.result;
      else if (typeof value.error === 'string') resultText = value.error;
      if (typeof value.error === 'string' && value.error !== '' && !frameErrorText.includes(value.error)) {
        frameErrorText += `${value.error}\n`;
      }
      // 真机形态：错误文本在 `errors: string[]`（`result` 字段缺失）
      if (Array.isArray(value.errors)) {
        for (const item of value.errors) {
          if (typeof item === 'string' && item !== '' && !frameErrorText.includes(item)) frameErrorText += `${item}\n`;
        }
      }
      // ★ 结构化错误码（官方文档口径）：数字码优先，details 作证据文本。
      if (Array.isArray(value.errors_info)) {
        for (const item of value.errors_info) {
          const signal = errorSignalOf(item);
          if (signal === null) continue;
          errorSignals.push(signal);
          if (signal.details !== '' && !frameErrorText.includes(signal.details)) frameErrorText += `${signal.details}\n`;
        }
      }
      // ★★ token 用量（2026-09-27）：积分扣减的**唯一输入**。
      //   真机形态（`real-run-probe` 逐字）：`result` 帧带
      //   `usage:{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens,…}`，
      //   另有按模型分组的 `modelUsage`。
      //   ⚠ 失败时这些字段**全为 0**（实测 401 那次就是）⇒ **0 不等于"没用 token"**，
      //   只说明"这次没跑起来"。消费方必须结合 `is_error` 判断，不得拿 0 当消耗记账。
      if (value.usage && typeof value.usage === 'object' && !Array.isArray(value.usage)) {
        const n = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
        resultUsage = {
          inputTokens: n(value.usage.input_tokens),
          outputTokens: n(value.usage.output_tokens),
          cacheReadInputTokens: n(value.usage.cache_read_input_tokens),
          cacheCreationInputTokens: n(value.usage.cache_creation_input_tokens),
        };
      }
    }
    if (type === 'assistant') {
      const content = value?.message?.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part?.type === 'text' && typeof part.text === 'string' && part.text !== '') {
            frameProseText += `${part.text}\n`;
          }
        }
      }
    }
    if (type === 'system' && value.subtype === 'init') {
      if (typeof value.model === 'string') initModel = value.model;
      if (typeof value.permissionMode === 'string') initPermissionMode = value.permissionMode;
    }
  }
  return {
    types, resultIsError, resultSubtype, resultText, resultUsage,
    frameErrorText: frameErrorText.slice(0, FRAME_ERROR_TEXT_LIMIT),
    frameProseText: frameProseText.slice(0, FRAME_ERROR_TEXT_LIMIT),
    errorSignals,
    unparsedText: Array.isArray(parsed?.unparsed) ? parsed.unparsed.join('\n') : '',
    hasErrorFrame,
    initModel, initPermissionMode, incomplete,
    // 权限拒绝证据：`permissionDenialCount` 取**权威来源**——结构化字段存在时用 CLI 报的总数
    // （即使超过 DENIAL_ITEMS_LIMIT 也不会少报），缺失时才回落到文本面命中数。两者语义不同，故不混算。
    // `permissionDenials` 是**单一来源**的清单（结构化优先；它整体缺失时才用工具输出原文）——
    // 混装会让同一次拒绝出现两种写法（`Bash: <原文>` 与 `<原文>`），清单长度就再也读不准。
    permissionDenials: denialItemsTotal > 0 ? permissionDenials : denialFromText,
    permissionDenialCount: denialItemsTotal > 0 ? denialItemsTotal : denialTextHits,
    denialText: denialText.slice(0, DENIAL_TEXT_LIMIT),
  };
}

/**
 * 是否为"任务本身报错"的完整证据（非参数问题）：`result.is_error === true` 且 subtype 非 success。
 * ★ 再加一条：出现 `type:'error'` 帧（真机未找到会话的形态）——那是 CLI 自己打的失败帧，与 is_error 同级。
 * @param {{ resultIsError: boolean|null, resultSubtype: string|null, hasErrorFrame?: boolean }} summary
 */
export function framesIndicateError(summary) {
  if (summary?.hasErrorFrame === true) return true;
  if (summary?.resultIsError === true) return true;
  // 真机成功帧是 subtype:'success'；窗口内未见非 success 且 is_error 缺省的样本 ⇒ 只把"明确非 success"当证据。
  return typeof summary?.resultSubtype === 'string' && summary.resultSubtype !== 'success';
}
