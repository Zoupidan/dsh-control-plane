/**
 * 失败原因归一（★ T04 职责之一；§7.4 落点）。
 *
 * Implements: 02-design/DESIGN-v3.md §7.4（**绝不**以 server/ACP 常驻模式运行；并发 1；把
 *             `EADDRINUSE` / 端口占用类文本归一为 `port_conflict`，UI 文案逐字给定）/
 *             §4.5（失败要能被人读懂，不能只给一个退出码）
 *
 * 为什么需要：**真机退出码不可信**——真机实测 `--model <不存在>` **exit code = 0**，失败只体现在输出里：
 *   带 `--output-format stream-json` 时落在帧内 `errors[]` / `errors_info[]`（`result` 字段缺失）；
 *   不带该 flag 时落在 stderr 的 400 文本。RECON-WINDOW-RESULT §4.5 记的"stdout 空 + stderr 400"是
 *   **未加**该 flag 的那次调用 —— 两种形态来自**不同调用**，不可互相印证（2026-09-19 复核纠正）。
 *   只凭 exitCode 判成败 = 把失败当成功。故本模块统一从"结构化错误码 + 文本证据 + 退出码 + 启动异常"归一。
 *
 * 归一分两级，**结构化优先、文案兜底**（与契约 `contracts/reason-codes.ts:extractQuotaSignal`
 *   "数字码优先（权威），message 兜底"同款原则）：
 *   ① **厂商结构化错误码**（`result.errors_info[]` = `{status, code, category?, details}`）：WorkBuddy
 *      官方文档给出码族（模型侧 1001/11133/11134/14003、网络 3002/3003/3007、频率 6003/6004、
 *      输入过长 11115）⇒ 本文件 `VENDOR_ERROR_CODES` 是**唯一**映射点。
 *      真机取证 2 例（2026-09-19 本机 WorkBuddy 2.137.1，原文入库 04-docs/）：
 *        `--model <不存在>` ⇒ `{status:400, code:11102}`；死代理 ⇒ `{status:502, code:3002, category:"network"}`。
 *   ② **文本形态**（`PATTERNS`）：只有拿不到结构化码时才用（老版本输出、CLI 进程级解析失败）。每条都标注
 *      来源 —— 真机原文 / 官方文档 / **无样本预置**（后者必须显式标注，见 `quota`）。
 *      未命中的一律 `unknown` ——**不猜**、不把"没见过"归成"没问题"。
 *
 * ★ 证据面纪律（2026-09-19 对抗审查 S1/S4 的根因）：本模块**只认错误面**（stderr + `frameErrorText`
 *   = `type:'error'` 帧 / `result.error` / `errors[]` / `errors_info[].details`）与非 JSON 行面
 *   （`unparsedText`）。**绝不读** assistant 正文或 `result.result`（成功帧里那是模型正文；模型讨论
 *   "EADDRINUSE"/"配额"会把成功判成失败）。故 `stdoutText` 参数**不参与归因**，仅保留签名兼容。
 *
 * 与跨端契约的对应（`contracts/reason-codes.ts`，字段名逐字对齐以免词汇二次漂移）：
 *   transport_unreachable / model_unavailable / input_too_long / quota_request_limit 为同名同义；
 *   `quota_exhausted` ↔ `quota_balance_exhausted`（本插件码名保留：U3 已砍查余额能力，但**失败可归因配额**）；
 *   `no_session_resume` ↔ `sessionIdUnavailable`（本插件只表达"CLI 侧没有这个会话可续"这一观测事实）。
 *
 * 约束：本文件属于 packages/*​/src（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 *
 * 约束：本文件属于 packages/*​/src（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 */

/** 归一后的原因码（SSOT）。`ok` 表示本次下发无失败证据。 */
export const REASON_CODES = Object.freeze({
  OK: 'ok',
  FLAG_REJECTED: 'flag_rejected',
  PORT_CONFLICT: 'port_conflict',
  AUTH_FAILED: 'auth_failed',
  /**
   * 工具调用被**权限策略**拒绝（非交互 `-p` 的固有形态；证据与修法见 REASON_TEXT）。
   *
   * ★ 与 `contracts/reason-codes.ts` 同名同义（该契约早已登记 `permission_denied`：class `permission`、
   *   `DEFAULT_RETRYABLE: false`、label"授权被拒绝"）⇒ 这里是**补齐实现**，不是新造词汇。
   * ★ 与 `AUTH_FAILED` 是两类故障：`auth_failed` = CLI 自身没登录/凭据无效（去登录）；本码 = 已登录但
   *   这次下发的工具调用被审批策略挡住（去放行工具或给插件配 `permissionMode`）。
   *   可执行动作不同 ⇒ 不得合并成一个码。
   */
  PERMISSION_DENIED: 'permission_denied',
  QUOTA_EXHAUSTED: 'quota_exhausted',
  // ── 官方错误码表落地的四族（码 → 语义见 VENDOR_ERROR_CODES；与契约 contracts/reason-codes.ts 同名）──
  /** 网络不可达/代理不通（官方码 3002/3003/3007；真机样本 `code:3002, category:"network"`）。 */
  TRANSPORT_UNREACHABLE: 'transport_unreachable',
  /** 模型侧状态异常（官方码 1001/11133/11134/14003 ⇒ 换模型重试，11133/11134 另建议新开会话）。 */
  MODEL_UNAVAILABLE: 'model_unavailable',
  /** 输入过长（官方码 11115 ⇒ 精简输入或换更大上下文模型）。 */
  INPUT_TOO_LONG: 'input_too_long',
  /** 请求频率受限（官方码 6003/6004 ⇒ 稍后重试或换模型；Pro 也会出现）。 */
  QUOTA_REQUEST_LIMIT: 'quota_request_limit',
  /**
   * 请求续接的会话在 CLI 侧不存在（真机：`{"type":"error","error":"No conversation found with session ID: …"}`）。
   * ★ DESIGN-v3 §7.4 明文要求新增此码：不新增 ⇒ `--resume` 一个死 id 会得到"exit 0 + 唯一一帧是 error 帧"
   *   ⇒ 旧实现判 `ok`，任务其实什么都没做，且死 id 被会话记录继续持有（静默空转）。
   */
  NO_SESSION_RESUME: 'no_session_resume',
  NODE_RUNTIME_NOT_FOUND: 'node_runtime_not_found',
  START_FAILED: 'start_failed',
  EXIT_NONZERO: 'exit_nonzero',
  TASK_ERROR: 'task_error',
  ABORTED: 'aborted',
  UNKNOWN: 'unknown',
  /**
   * 复用命中、未下发（★ 2026-10-02 诚实化；用户禁网关后恢复为现行口径）。
   *
   * <p>语义：`session_key` 命中了已记住的会话 id，但**本轮 prompt 未送达桌面端**
   * （`automation` 表只有 once 新建入口，没有"往已有对话追问"入口 ⇒ 复用不可能下发；
   * 网关已禁用，不走网关追问）。
   * 作业以失败收尾（`ok:false`），`detail` 逐字为
   * "本轮prompt未送达桌面端，automation表无追问入口；要跑请resume:false开新对话"，
   * `lastRun.sessionOrigin` 记 `reused-not-dispatched`，不计入 completed。
   * 要跑请 `resume:false` 开新对话（INSERT 一行 once）或换新 key。
   */
  ALREADY_REMEMBERED_NO_DISPATCH: 'already_remembered_no_dispatch',
});

/**
 * "有具体证据支撑的失败"集合（SSOT）—— 三个消费点共用同一判据，避免三处各判一次而漂移：
 *   `tools/run.js`（终态 failed + 通知 detail）、`prompts/availability.js`（最近一次下发的措辞）、
 *   测试。`unknown` / `aborted` **不在**此集合：前者是"没归一出来"（不能替 CLI 下结论），
 *   后者是"调用方取消"（不是失败）。二者由各自文案单独表达，见 availability.js。
 */
export const FAILURE_CODES = Object.freeze(new Set([
  REASON_CODES.FLAG_REJECTED,
  REASON_CODES.PORT_CONFLICT,
  REASON_CODES.AUTH_FAILED,
  REASON_CODES.PERMISSION_DENIED,
  REASON_CODES.QUOTA_EXHAUSTED,
  REASON_CODES.TRANSPORT_UNREACHABLE,
  REASON_CODES.MODEL_UNAVAILABLE,
  REASON_CODES.INPUT_TOO_LONG,
  REASON_CODES.QUOTA_REQUEST_LIMIT,
  REASON_CODES.NO_SESSION_RESUME,
  REASON_CODES.NODE_RUNTIME_NOT_FOUND,
  REASON_CODES.START_FAILED,
  REASON_CODES.EXIT_NONZERO,
  REASON_CODES.TASK_ERROR,
  // ★ 复用命中未下发是有具体证据的终态（记住的 id + 无追问入口），不是"未知"也不是"取消" ⇒ 进失败集合，
  //   availability 的 lastFailureHint 才配 failed 语义（与 completed/OK 的谎报划清界线）。
  REASON_CODES.ALREADY_REMEMBERED_NO_DISPATCH,
]));

/**
 * 该原因码是否"有具体证据支撑的失败"。★ 与 `FAILURE_CODES.has()` 同一判据，供只读一个字符串的调用方使用。
 * @param {unknown} code
 * @returns {boolean}
 */
export function isFailureCode(code) {
  return typeof code === 'string' && FAILURE_CODES.has(code);
}

/**
 * 面向人的中文说明。
 *
 * ★★ 2026-10-02 整表重写：这张表会**原样印在设置卡片上**（客户端 `失败原因：` + 本表），★★
 *   所以它必须是说人话，而不是排障记录。旧版的问题（用户原话："一堆乱七八糟的说明"）：
 *   ① 满篇实现视角 —— `CLI` / `stderr 摘录` / `result 帧` / `is_error` / `type:error` /
 *      `非交互 -p` / `resume:false` / `Node 运行时` / `权限策略` 判定过程；
 *   ② `PERMISSION_DENIED` 那条三行长串，还让用户去手改 `~/.codebuddy/settings.json`
 *      的 `permissions.allow` 并列举 `Read/Write/Edit/Bash` —— 那是**别的产品的**配置文件，
 *      本插件根本没有 CLI 了，照着做只会失败；
 *   ③ `FLAG_REJECTED` 指向「被拒证据」行，而客户端已把那行改名为「拒绝信息」⇒ 指向了一个
 *      **卡上不存在的行名**（跨文件破坏，客户端改名时没同步到这里）。
 * 纪律：**技术细节归日志和「原始错误输出」那几行，用户可见的这行只说"发生了什么 + 下一步"。**
 */
export const REASON_TEXT = Object.freeze({
  [REASON_CODES.OK]: '本次下发未发现失败迹象。',
  [REASON_CODES.FLAG_REJECTED]: 'WorkBuddy 拒绝了本次下发的某个参数（拒绝信息见下方）。',
  [REASON_CODES.PORT_CONFLICT]: '检测到与正在运行的实例冲突，请先关闭该程序的同名实例或改用单次模式。',
  [REASON_CODES.AUTH_FAILED]: 'WorkBuddy 报告未登录或无权限，请先在 WorkBuddy 桌面端完成登录。',
  [REASON_CODES.PERMISSION_DENIED]: '任务中的某个操作被权限设置拒绝。请在下方「权限」里选一个更宽松的档位后重试。',
  [REASON_CODES.QUOTA_EXHAUSTED]: '账户余额或积分不足，请在 WorkBuddy 桌面端充值或更换账号后重试。',
  [REASON_CODES.TRANSPORT_UNREACHABLE]: '连不上 WorkBuddy 桌面端，请确认它已启动后重试。',
  [REASON_CODES.MODEL_UNAVAILABLE]: '所选模型当前不可用，请换一个模型重试。',
  [REASON_CODES.INPUT_TOO_LONG]: '输入过长，超出模型可接受的长度，请精简后重试。',
  [REASON_CODES.QUOTA_REQUEST_LIMIT]: '请求过于频繁被限流，请稍后重试或换一个模型。',
  [REASON_CODES.NO_SESSION_RESUME]: '要继续的那条 WorkBuddy 对话已经不存在，本次没有执行任何操作。'
    + '请换一条对话重新下发。',
  [REASON_CODES.NODE_RUNTIME_NOT_FOUND]: '未找到可用的运行时（仅在使用命令行传输时需要，本插件已不再走这条路）。',
  [REASON_CODES.START_FAILED]: '任务未能启动，详见下方「原始错误输出」。',
  [REASON_CODES.EXIT_NONZERO]: '运行以非 0 退出码结束，且没有识别出更具体的原因。',
  [REASON_CODES.TASK_ERROR]: 'WorkBuddy 报告本次任务失败，详见下方「原始错误输出」。',
  [REASON_CODES.ABORTED]: '本次任务被调用方取消。',
  // ★ 复用命中未下发（现行诚实口径；下一步唯一可执行动作是 resume:false 开新对话，或换新 key）。
  //   下一步唯一可执行动作是 resume:false 开新对话（或换新 key），不是重试同一 key。
  [REASON_CODES.ALREADY_REMEMBERED_NO_DISPATCH]: '命中的记性未下发：本轮prompt未送达桌面端，automation表无追问入口；要跑请resume:false开新对话。',
  // ★ 措辞纪律：`unknown` 是"**没归一出来**"，不是"失败"。旧文案"未能归一出失败原因"默认了失败，
  //   与"终态仍为 completed"矛盾（对抗审查 S1：同一个 lastRun 里两处结论打架）。此处只陈述"未能判定"。
  [REASON_CODES.UNKNOWN]: '未能判定本次下发是否失败（原始输出保留在下方供人工判断）。',
});

/**
 * 文本证据模式：
 *   - `flag`  参数被拒：进程级选项解析失败 / 真机 400-model 形态（RECON §4.5 逐字）——已取证
 *   - `port`  单例/端口冲突（§7.4）——已取证
 *   - `auth`  未登录/无权限——已取证
 *   - `permission` 工具调用被审批策略拒绝——已取证（真机逐字见该组注释；非交互 `-p` 的固有形态）
 *   - `quota` 配额/余额/积分耗尽——★**无真机样本**（预置形态，见该组的注释）
 */
const PATTERNS = Object.freeze({
  flag: [
    /\bunknown option\b/i,
    /\bunrecognized option\b/i,
    /\bunknown argument\b/i,
    /\bunexpected argument\b/i,
    /\binvalid option\b/i,
    /\bno such option\b/i,
    /\binvalid value for\b/i,
    /\bmust be one of\b/i,
    /\binvalid choice\b/i,
    /\binvalid\s+--?[a-z][a-z0-9-]*/i,
    // RECON §4.5 逐字：`400 model [xxx] service info not found`
    /\b400\b[^\n]{0,80}\bmodel\b[^\n]{0,80}\bnot found\b/i,
    /\bmodel\s*\[[^\]\n]{1,128}\][^\n]{0,80}\bnot found\b/i,
  ],
  port: [
    /\bEADDRINUSE\b/,
    /\baddress already in use\b/i,
    /\bport\b[^\n]{0,40}\b(?:in use|already in use|occupied|占用)/i,
    /\bonly one instance\b/i,
    /\banother instance\b/i,
    /\binstance is already running\b/i,
  ],
  // ★ `auth`：**含真机逐字样本（2026-09-27）**——此前六条**一条都盖不住** CLI 最常见的登录态失败。
  //   真机下发（`tools/recon/real-run-probe.mjs`，hy3，exit 0 + 6 帧）拿到的 assistant 帧原话：
  //     "Authentication required. Please use /login command to sign in to your account"
  //   三条最接近的既有模式全部错过它，理由逐条可查：
  //     ① `authentication failed` —— CLI 说的是 **required** 不是 failed；
  //     ② `login required`          —— CLI 的语序是 `Please use /login command`；
  //     ③ `please (?:log ?in|sign ?in)` —— 中间多了一个 `use /`，不相邻。
  //   ⇒ 真机分类实测落 `task_error`（泛化桶），而它明明有专属码 —— 这类漏判会让
  //     "你掉登录了"被报成"任务失败"，把一个可自助修复的问题说成不可解。
  //   ★ 复跑：tools/recon/auth-coverage-probe.mjs
  auth: [
    // ↓↓ 真机逐字（2026-09-27）
    /Authentication required\. Please use \/login command/i,
    /\bauthentication required\b/i,
    /\buse \/login\b/i,
    // ↓↓ 以下为既有族，保留
    /\b401\b/,
    /\b403\b/,
    /\bunauthorized\b/i,
    /\bauthentication failed\b/i,
    /\bnot logged in\b/i,
    /\blogin required\b/i,
    /\bplease (?:log ?in|sign ?in)\b/i,
    /\binvalid api key\b/i,
    /\bno valid (?:token|credential)/i,
  ],
  // ★ `permission`：真机逐字（2026-09-19，两次真实下发取证）。
  //   非交互 `-p` 下 `permissionMode: 'default'` 时写/执行类工具一律被拒，CLI 的原话是：
  //     "Error: Permission to use Bash has been denied because this tool requires approval but
  //      permission prompts are not available in non-interactive mode."
  //   受控探针（D1/D2/D3）：`default` + 写命令 ⇒ `permission_denials: 2`；
  //     `--permission-mode bypassPermissions` ⇒ 0；`~/.codebuddy/settings.json` 白名单放行 ⇒ 0。
  //   —— 两个「必须精确」的理由（这两条字符串是对**当前 CLI 版本**措辞的耦合，故收得很窄）：
  //   ① 不与 auth 族重叠：本组只认"审批被拒"的原话，不认 401/403（那是 `auth`）；
  //   ② 误判面：`permission denied` 这类通用词在"读日志/讨论权限"的任务输出里也会出现，
  //      故只保留 `Permission to use … has been denied` 与 `permission prompts are not available`
  //      两条**完整句式**；`\bpermission denied\b` 只在无其它更具体证据时兜底（见 classifyFailure 的
  //      `denialText` 面 —— 该面只扫 `tool_result` 块，永不扫模型正文）。
  permission: [
    /Permission to use [^\n]{0,80}? has been denied/i,
    /permission prompts are not available/i,
    /requires approval but permission/i,
    /\bpermission denied\b/i,
  ],
  // ★ `quota`：★ 2026-09-27 证据升级——从"无样本预置"升为"**厂商自身匹配口径逐字**"。
  //   取证：`codebuddy-headless.js` 的 `ec` 常量里有**四条**配额耗尽正则（逐字）：
  //     /(?:^|[^a-z0-9_])exceeded your current quota(?:[^a-z0-9_]|$)/i
  //     /(?:^|[^a-z0-9_])insufficient_quota(?:[^a-z0-9_]|$)/i
  //     /(?:^|[^a-z0-9_])credit balance is too low(?:[^a-z0-9_]|$)/i
  //     /(?:^|[^a-z0-9_])billing_hard_limit_reached(?:[^a-z0-9_]|$)/i
  //   （后两条是 OpenAI 风格码，第一条是 Anthropic 风格 ⇒ 厂商自己就在做跨厂商兜底。）
  //   **本族此前的四条一条都盖不住**（语序/词形全不同），实测归因落 `unknown` ——
  //   探针 `tools/recon/quota-coverage-probe.mjs` 可复跑。
  //   ★ 证据等级要说准：这是**厂商源码里的判据**，**不是**本机真机失败样本；
  //   一旦抓到真机原话（stderr 或帧内错误文本），仍须按本文件既有风格补"样本原文 + 来源 + 日期"。
  quota: [
    // ↓↓ 厂商口径四条（逐字对齐 codebuddy-headless.js 的 ec；`(?<![A-Za-z0-9_])`/`(?![A-Za-z0-9_])`
    //   是 Node lookbehind/lookahead，等价于厂商的 `(?:^|[^a-z0-9_])` 前后哨兵）
    /(?<![A-Za-z0-9_])exceeded your current quota(?![A-Za-z0-9_])/i,
    /(?<![A-Za-z0-9_])insufficient_quota(?![A-Za-z0-9_])/i,
    /(?<![A-Za-z0-9_])credit balance is too low(?![A-Za-z0-9_])/i,
    /(?<![A-Za-z0-9_])billing_hard_limit_reached(?![A-Za-z0-9_])/i,
    // ↓↓ 以下六条为 2026-09-27 之前的既有族，保留（"quota exceeded" 语序、余额不足的中文说法等）
    /\binsufficient\s+credits?\b/i,
    /\bcredits?\s+(?:exhausted|insufficient|used up|depleted|run out)\b/i,
    /\bquota\s+(?:exceeded|exhausted|insufficient|used up)\b/i,
    /\bout of credits?\b/i,
    /\bbalance\s+(?:insufficient|too low)\b/i,
    /\binsufficient\s+balance\b/i,
    /积分(?:不足|已用尽)/,
    /余额(?:不足|已用尽)/,
    /配额(?:不足|已用尽)/,
    /额度(?:不足|已用尽)/,
  ],
  // ── 以下五族是**文本兜底**：只在拿不到结构化码时才用（老版本输出 / 进程级失败）。
  //    `network` 有真机样本（死代理）；其余三族的依据是官方错误码说明的**码族语义**，
  //    文案本身**没有**真机逐字样本 ⇒ 命中时仍优先信结构化码（见 classifyFailure 顺序）。
  network: [
    // 真机逐字（2026-09-19，死代理）："502 连接被拒绝：可能是代理未启动或端口被拦截，请检查网络代理设置
    //（connect ECONNREFUSED 127.0.0.1:9）"
    /\bECONNREFUSED\b/,
    /\bCONNECTION\s+(?:REFUSED|RESET)\b/i,
    /连接被拒绝/,
    /连接超时|网络(?:异常|不可达|错误)|代理(?:未启动|不通)/,
    /\bECONNRESET\b/,
    /\bETIMEDOUT\b/,
    /\bEAI_AGAIN\b/,
    /\bENOTFOUND\b/,
    /\bnetwork\b[^\n]{0,40}\b(?:error|unreachable|failed|timeout)/i,
    /\b(?:connection|connect)\s+(?:refused|reset|timed out|failed)\b/i,
  ],
  model: [
    /\bmodel\b[^\n]{0,60}\b(?:not available|unavailable|unsupported|does not exist|service info not found)\b/i,
    /\bmodel\s*(?:side|error)\b/i,
    /模型[^\n]{0,40}(?:不可用|不存在|不支持|异常|维护)/,
  ],
  inputLimit: [
    /\bENAMETOOLONG\b/,
    /\bE2BIG\b/,
    /\bargument list too long\b/i,
    /\b(?:prompt|input|context)\b[^\n]{0,40}\b(?:too long|too large|exceeds?)\b/i,
    /输入(?:内容)?过长|超出[^\n]{0,20}(?:上下文|长度|上限)|context length exceeded/i,
  ],
  rateLimit: [
    /\b429\b/,
    /\brate[ -]?limit(?:ed|ing)?\b/i,
    /\btoo many requests\b/i,
    /请求(?:过于)?频繁/,
    /频率(?:受限|限制)|限流/,
  ],
  // 真机逐字（2026-09-19，`--resume <不存在的 id>`，94 字节 error 帧）。
  noSession: [
    /No conversation found with session ID/i,
    /\bno such session\b/i,
    /\bsession\b[^\n]{0,40}\bnot found\b/i,
    /会话(?:不存在|未找到)/,
  ],
});

/**
 * 厂商结构化错误码 → 本插件原因码（**唯一**映射点；码表口径 = WorkBuddy 官方错误码说明）。
 *
 * 官方码族（逐字转写，2026-09-19 由用户提供官方文档内容）：
 *   1001        模型侧 ⇒ 切换模型
 *   3002/3003/3007  网络（公司网络/家庭网络差异、企业 IT、代理配置）
 *   6003/6004   请求频率受限（**付费档位也会出现**）⇒ 稍后重试 / 切换模型
 *   11115       输入内容过长 ⇒ 精简输入或换更大上下文模型
 *   11133/11134 模型侧 ⇒ 新开会话或切换模型重试
 *   14003       模型侧 ⇒ 切换模型
 * 真机已取证的码：**3002**（死代理，随帧带 `category:"network"`）。
 * ★ **11102 故意不入表**：它不在官方"常见码"清单里，本机观测到的语义只来自
 *   `errors_info.details` 的 400-model 文本（"Please use --model <model_id> to specify a valid model."）
 *   ⇒ 由 PATTERNS.flag（有真机样本）判为 `flag_rejected`，并驱动 GUI 下拉回滚。
 *   按推测给未登记码安语义 = 拿"没见过"当"知道"，违反"不猜"。
 */
const VENDOR_ERROR_CODES = new Map([
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
]);

/** 证据串上限（对外是 lastRun.flagEvidence / reasonEvidence，进卡片显示）。 */
export const EVIDENCE_LIMIT = 400;

/** 命中点前后各取多少字符作为上下文（真机 `unknown option '--flag'` 的 flag 名在命中点**之后**）。 */
const EVIDENCE_CONTEXT = 160;

/**
 * 命中证据：**命中点及其上下文**，不是只有命中片段。
 *
 * ★ 为什么不能只返回 `m[0]`（曾经的实现，真机踩到）：
 *   真机证据形态 `error: unknown option '--dcp-nonexistent'` 的正则只匹配 `unknown option` 两个字，
 *   而**被拒的 flag 名在命中点之后**。只回片段 ⇒ 逐 flag 归因拿不到任何 flag 名 ⇒ 客户端无法把
 *   "被拒"落到具体下拉行 ⇒ 退化成"整体回滚两行"的假状态（B-T04-4 复发；2026-09-19 真机复现）。
 *   取一段上下文即可同时满足两个消费者：人看的是证据原文，归因看的是其中出现的 flag 名/取值。
 *
 * @param {string} text @param {RegExp[]} patterns
 * @returns {string|null} 命中点 ± 上下文的单行化文本
 */
function firstHit(text, patterns) {
  if (typeof text !== 'string' || text === '') return null;
  for (const re of patterns) {
    const m = re.exec(text);
    if (m === null) continue;
    const start = Math.max(0, m.index - EVIDENCE_CONTEXT);
    const end = Math.min(text.length, m.index + m[0].length + EVIDENCE_CONTEXT);
    return text.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, EVIDENCE_LIMIT);
  }
  return null;
}

/**
 * 参数被拒证据（verdict.js 与 run.js 共用同一判据 —— 避免"两处各判一次"漂移）。
 * @param {string} text 合并后的 stderr+stdout+结果帧文本
 * @returns {string|null} 命中的证据片段
 */
export function flagRejectionEvidence(text) {
  return firstHit(text, PATTERNS.flag);
}

/**
 * 读取节点运行时缺失的专用原因码（argv 组装失败时使用；run.js 会把它落到 lastRun.reasonCode）。
 *
 * ★ 必须**同时**接受 Error 与字符串：run.js 传的是 Error（`err`），而 classifyFailure 传的是
 *   `spawnError` 字符串。只认 Error 形态时，classifyFailure 里那条分支永远不命中 —— 曾经真实踩到
 *   （症状：`reasonCode` 落到泛化的 start_failed，而 run.js 那侧却按 node_runtime_not_found 落 DEGRADED，
 *   两处判定漂移）。本函数是该判据的**唯一**实现，两侧共用。
 *
 * @param {unknown} input Error 或错误消息字符串
 * @returns {boolean}
 */
export function isNodeRuntimeMissing(input) {
  const message = typeof input === 'string' ? input : String(/** @type {any} */ (input)?.message ?? '');
  return /workbuddy: no node runtime/i.test(message);
}

/**
 * 结构化错误码信号 → 原因码（**结构化优先**的唯一入口；码表见 VENDOR_ERROR_CODES）。
 *
 * ★ 为什么单独成函数：归一链里"结构化码"这一档必须与"文本兜底"在代码上分开，
 *   否则后人读 classifyFailure 的 if 链会看不出"码优先、文案兜底"这条**跨端一致**的契约原则
 *   （contracts/reason-codes.ts 的 `extractQuotaSignal` 用的是同一条口径）。
 *   `category` 兜底：真机 3002 带 `category:"network"`；码未登记但分类明确时仍可归网络族。
 *
 * @param {Array<{status: number|null, code: number|null, category: string|null, details: string}>} errorSignals
 * @returns {{ reasonCode: string, evidence: string }|null}
 */
function vendorCodeSignal(errorSignals) {
  if (!Array.isArray(errorSignals)) return null;
  for (const signal of errorSignals) {
    if (signal === null || typeof signal !== 'object') continue;
    const mapped = typeof signal.code === 'number' ? VENDOR_ERROR_CODES.get(signal.code) : undefined;
    // ★ 2026-09-27：`category` 兜底补 `quota`。取证：`codebuddy-headless.js` 把配额耗尽**显式打标**
    //   为 `new QuotaError(msg, { ...err, category: "quota" })`（逐字：`category:"quota"`），
    //   并在重试判定里把它判为**不可重试**。此前本函数只认 `category === 'network'`，
    //   ⇒ CLI 已经自报"这是配额问题"，插件却把它当普通失败丢掉归因。
    //   另：厂商把 daily 额度放在**响应头**（`X-DailyQuota-Limit / -Remaining / -Reset`），
    //   插件读不到（见 04-docs/RECON-CREDITS-QUOTA.md §3）⇒ 本分支只解决**归因**，不解决读数。
    const byCategory = signal.category === 'network' ? REASON_CODES.TRANSPORT_UNREACHABLE
      : signal.category === 'quota' ? REASON_CODES.QUOTA_EXHAUSTED
        : undefined;
    const code = mapped ?? byCategory;
    if (code === undefined) continue;
    const head = signal.code === null || signal.code === undefined ? `category ${signal.category}` : `code ${signal.code}`;
    const detail = typeof signal.details === 'string' ? signal.details : '';
    const evidence = (detail === '' ? head : `${head}: ${detail}`).replace(/\s+/g, ' ').trim().slice(0, EVIDENCE_LIMIT);
    return { reasonCode: code, evidence };
  }
  return null;
}

/**
 * 归一失败原因。
 *
 * @param {{ exitCode?: number|null, signal?: string|null, stderrText?: string, unparsedText?: string,
 *           resultText?: string, frameErrorText?: string, stdoutText?: string,
 *           errorSignals?: Array<{status: number|null, code: number|null, category: string|null, details: string}>,
 *           spawnError?: string|null, aborted?: boolean, taskError?: boolean,
 *           permissionDenials?: string[], denialText?: string,
 *           flagVerdict?: 'accepted'|'rejected'|'unknown' }} input
 *   `permissionDenials` = `result` 帧 `permission_denials` 归一成的短串（CLI **自己**报的拒绝清单）；
 *   `denialText` = `tool_result`(is_error) 块里的拒绝原文（**工具输出面**，不是模型正文）。
 *   两者都只做 `permission_denied` 的证据，且只在本次下发已失败时生效（见下方门控注释）。
 * @returns {{ reasonCode: string, reasonText: string, evidence: string }}
 */
export function classifyFailure(input) {
  const {
    exitCode = null, stderrText = '', unparsedText = '', frameErrorText = '',
    errorSignals = [], spawnError = null, aborted = false, taskError = false, flagVerdict = 'unknown',
    permissionDenials = [], denialText = '',
  } = input ?? {};

  if (aborted === true) {
    return { reasonCode: REASON_CODES.ABORTED, reasonText: REASON_TEXT[REASON_CODES.ABORTED], evidence: 'abort signal' };
  }
  if (typeof spawnError === 'string' && spawnError !== '') {
    // ★ 真机（2026-09-19）：`-p <40000 字符 prompt>` ⇒ `spawnSync … ENAMETOOLONG`（进程压根没起来）。
    //   插件的 prompt 走 argv 末尾 ⇒ Windows 命令行上限（≈32767）是**用户可达**的硬边界；
    //   旧实现归成 start_failed（文案是"可执行文件缺失/被拒"）⇒ 用户拿到完全错误的动作建议。
    const code = isNodeRuntimeMissing(spawnError)
      ? REASON_CODES.NODE_RUNTIME_NOT_FOUND
      : (firstHit(spawnError, PATTERNS.inputLimit) === null ? REASON_CODES.START_FAILED : REASON_CODES.INPUT_TOO_LONG);
    return { reasonCode: code, reasonText: REASON_TEXT[code], evidence: spawnError.slice(0, 200) };
  }
  // 证据面合并顺序 = "最可能是证据"优先：stderr（进程级解析失败）→ 帧内**错误**文本（真机 400/502 落点）
  // → 非 JSON 行（老版本把错误打成纯文本 stdout 的形态）。★ 正文面**不在其中**（见文件头"证据面纪律"）。
  const merged = `${stderrText}\n${frameErrorText}\n${unparsedText}`;
  if (flagVerdict === 'rejected') {
    const hit = flagRejectionEvidence(merged);
    const code = REASON_CODES.FLAG_REJECTED;
    return { reasonCode: code, reasonText: REASON_TEXT[code], evidence: hit === null ? '(flag verdict rejected)' : hit };
  }
  const port = firstHit(merged, PATTERNS.port);
  if (port !== null) {
    return { reasonCode: REASON_CODES.PORT_CONFLICT, reasonText: REASON_TEXT[REASON_CODES.PORT_CONFLICT], evidence: port };
  }
  // ★ 结构化错误码优先于一切文本族（官方码表口径见 VENDOR_ERROR_CODES）。放在端口之后、auth 之前：
  //   端口冲突是**本地**已知条件（DESIGN §7.4 要求归一），比任何远端码都更具体；而凭据类文本
  //   （401/403）与厂商码不重叠，先后无实质差别。
  const vendor = vendorCodeSignal(errorSignals);
  if (vendor !== null) {
    return { reasonCode: vendor.reasonCode, reasonText: REASON_TEXT[vendor.reasonCode], evidence: vendor.evidence };
  }
  const auth = firstHit(merged, PATTERNS.auth);
  if (auth !== null) {
    return { reasonCode: REASON_CODES.AUTH_FAILED, reasonText: REASON_TEXT[REASON_CODES.AUTH_FAILED], evidence: auth };
  }
  // ★ 会话不可续接：真机是**唯一一帧** 94 字节 `{"type":"error","error":"No conversation found with session ID: …"}`，
  //   exit 0。它必须**先于** taskError：否则这条最该被识别的"任务什么都没做"会被泛化成 task_error，
  //   用户拿不到"该开新会话"这个唯一可执行动作。放在 auth 之后、文本族之前：它是具体事实，不该被
  //   泛化的网络/模型文案抢走（noSession 的文本与 auth 族无重叠，所以顺序对 auth 无影响）。
  const noSession = firstHit(merged, PATTERNS.noSession);
  if (noSession !== null) {
    return { reasonCode: REASON_CODES.NO_SESSION_RESUME, reasonText: REASON_TEXT[REASON_CODES.NO_SESSION_RESUME], evidence: noSession };
  }
  // ★ 文本兜底族（结构化码缺失时用；顺序即语义）：
  //   network 有真机样本（死代理 502）；model/inputLimit/rateLimit 的依据是官方码族语义，文案本身无真机样本。
  //   必须**先于** exitCode 判定（真机退出码不可信：3002 那次也 exit 0），且**先于** taskError（泛化原因会吃掉可执行原因）。
  const textClasses = [
    ['network', REASON_CODES.TRANSPORT_UNREACHABLE],
    ['model', REASON_CODES.MODEL_UNAVAILABLE],
    ['inputLimit', REASON_CODES.INPUT_TOO_LONG],
    ['rateLimit', REASON_CODES.QUOTA_REQUEST_LIMIT],
  ];
  for (const [family, code] of textClasses) {
    const hit = firstHit(merged, PATTERNS[family]);
    if (hit !== null) {
      return { reasonCode: code, reasonText: REASON_TEXT[code], evidence: hit };
    }
  }
  // ★ 配额/余额/积分耗尽（"积分没了"）。位置理由（顺序即语义，逐条给出为什么必须在**这里**）：
  //   ① 必须在 `auth` **之后**：配额耗尽与"未登录"是两类不同故障（账户没额度 vs 凭据无效），
  //      登录态类文本（401/403/unauthorized）必须先归 auth —— 否则 `401 ... insufficient credits`
  //      会被误报成"去充值"，把人指向错误的动作。
  //   ② 必须在 `exitCode !== 0` **之前**：真机退出码不可信（见文件头 D-3），配额耗尽既可能 exit 1
  //      也可能 exit 0；排在 exit 码之后就永远被 exit_nonzero 抢走，用户拿到"进程非 0 退出"这种
  //      不可执行的信息。由此它也顺带**先于**下面的 taskError —— 帧内报"积分不足"时归配额，
  //      比泛化的 task_error 更可执行。
  //   ③ ★ **原 `taskError` 门控已删除**（2026-09-19 根因修复）：那道门控存在的唯一理由是旧 `frameErrorText`
  //      混装了 assistant 帧正文 ⇒ 正文里的配额词成了假证据。现在正文已从错误面剥离（stream-json.js 输出
  //      独立的 `frameProseText`），门控前提消失；**保留它反而会漏报**——"CLI 只在错误面报配额、却没有
  //      is_error 字段"的真实失败会被放过（漏报同样是通知信道的硬伤）。
  const quota = firstHit(merged, PATTERNS.quota);
  if (quota !== null) {
    return { reasonCode: REASON_CODES.QUOTA_EXHAUSTED, reasonText: REASON_TEXT[REASON_CODES.QUOTA_EXHAUSTED], evidence: quota };
  }
  // ★ 权限拒绝（T04 增量⑥ fix#2）。位置与门控是本分支的全部要点，逐条给出理由：
  //   ① **门控 = 本次下发已经失败了**（exit≠0 或 CLI 报任务错）。这是"不猜"的落点：非空
  //      `permission_denials` 只证明"有工具调用被拒"，**不证明任务失败** —— 模型被拒后换个路子
  //      （改读别的文件、换工具）把活干完、CLI 以 exit 0 + is_error:false 收尾，是完全合法的成功形态。
  //      把那种运行判成 permission_denied 就是拿"出现过拒绝"冒充"因此失败"，会假报警并把用户指去改配置。
  //      ⇒ 未判失败时拒绝证据**照样回传**（LastRunRecord.permissionDenials + 作业输出的一行告知），
  //      只是不改判终态。可见性由数据面给，判定由门控给 —— 两者不混。
  //   ② **必须在 `exitCode !== 0` 之前**：真机证据就是"被拒 + 非 0 退出/任务报错"，排在 exitCode 之后
  //      就永远被 `exit_nonzero`（文案"进程以非 0 退出码结束"，不可执行）抢走 —— 用户要的可执行动作是
  //      "放行工具或配 permissionMode"，只有本码给得出。
  //   ③ **必须在文本兜底族之后**：本码的证据面是一条**句式固定**的 CLI 原话，比泛化的网络/模型文案更具体，
  //      但只有在前面的具体族（端口/结构化码/auth/会话/文本族/配额）都没命中时才可能拿它当唯一证据。
  //   ④ 证据优先级：结构化 `permission_denials`（CLI 自己报的，最权威）→ `denialText`（`tool_result`
  //      is_error 块的原文；该面由 stream-json.js 保证**只含工具输出、不含模型正文**）→ `merged`
  //      文本面（stderr/帧内错误/非 JSON 行）。结构化面存在时**不**用文本面覆盖它。
  const failing = (typeof exitCode === 'number' && exitCode !== 0) || taskError === true;

  if (failing) {
    const structured = Array.isArray(permissionDenials)
      ? permissionDenials.filter((item) => typeof item === 'string' && item.trim() !== '').join(' | ')
      : '';
    const toolFace = typeof denialText === 'string' ? denialText.replace(/\s+/g, ' ').trim() : '';
    const textFace = firstHit(merged, PATTERNS.permission);
    if (structured !== '' || toolFace !== '' || textFace !== null) {
      const evidence = structured !== '' ? structured : (toolFace !== '' ? toolFace : textFace);
      return {
        reasonCode: REASON_CODES.PERMISSION_DENIED,
        reasonText: REASON_TEXT[REASON_CODES.PERMISSION_DENIED],
        evidence: String(evidence).replace(/\s+/g, ' ').trim().slice(0, EVIDENCE_LIMIT),
      };
    }
  }
  if (typeof exitCode === 'number' && exitCode !== 0) {
    return { reasonCode: REASON_CODES.EXIT_NONZERO, reasonText: REASON_TEXT[REASON_CODES.EXIT_NONZERO], evidence: `exit ${exitCode}` };
  }
  // exit 0 但结果帧 is_error（D-3：退出码不可信）⇒ 明确归为任务失败，不伪装成成功。
  if (taskError === true) {
    // 证据优先取帧内**错误**文本（真机失败 result 帧里根本没有 `result` 字段、正文在 assistant 帧里，
    // 而正文是模型自由文本、不得当证据）；帧内错误面为空时退回非 JSON 行——**不再**读 `resultText`。
    const detail = frameErrorText !== '' ? frameErrorText : unparsedText;
    return { reasonCode: REASON_CODES.TASK_ERROR, reasonText: REASON_TEXT[REASON_CODES.TASK_ERROR], evidence: detail.replace(/\s+/g, ' ').trim().slice(0, EVIDENCE_LIMIT) };
  }
  // 归一表未覆盖的失败形态：不伪装成成功，也不冒充已知原因。
  return { reasonCode: REASON_CODES.UNKNOWN, reasonText: REASON_TEXT[REASON_CODES.UNKNOWN], evidence: '' };
}
