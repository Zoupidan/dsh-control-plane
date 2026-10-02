/**
 * host 端类型（JSDoc typedef）—— 纯文档，无运行时代码。
 *
 * Implements: 02-design/DESIGN-v3.md §7.2（ProbeResult）/ §8（两套正交状态）/ §4.5（参数接受度）
 * 说明：本仓库为 JS（非 TS）；类型以 JSDoc 表达，供编辑器与后续 declaration-merge 参考。
 */

/**
 * 探测证据条目 / 只读探测结果 / ① 注册态（§7.2 逐字字段 + §8 左图）——
 * **形状本体在 `packages/plugin-cli-core/src/types.js`**（§26）：这几个字段名是宿主协议，
 * 两个插件各留一份 typedef 必然漂移（同"两份解析器会漂移"那条理由）⇒ 单一出处在 core，此处 alias。
 * 与抽包前的唯一差异：`ProbeResult.target` 在 core 里是 `string`（不再是字面量 `'workbuddy'`），
 * 因为该值现在由本包的转发层注入 ⇒ 收窄到字面量这件事交给运行时的 `PROBE_TARGET`，不靠类型假装。
 * @typedef {import('../../../../plugin-cli-core/src/types.js').ProbeEvidence} ProbeEvidence
 * @typedef {import('../../../../plugin-cli-core/src/types.js').ProbeResult} ProbeResult
 * @typedef {import('../../../../plugin-cli-core/src/types.js').RegistryState} RegistryState
 */

/**
 * ② Job 执行态（§8 右图的插件侧子集；不写入 ctx.jobs）。
 * @typedef {'STARTING'|'RUNNING'} RunState
 */

/**
 * 在途作业记账（SSOT 的 in-flight run map；§3.4.2 R2）。
 * @typedef {Object} RunRecord
 * @property {number} exitCode 终态退出码（-1 = 失败/被终止，语义与 §3.4.3 settle 一致）
 */

/**
 * 参数接受度记录（§4.5；写入负责方：T04 `verdict.buildLastRun`，本层仅承载）。
 *
 * ★ 前四个字段是 §4.5 **逐字契约**（客户端 `lib/client.js` 按此渲染；`argv` 必须是**字符串** ——
 *   T03 卡片曾经按数组渲染会导致 `[object Object]` 之类形态，改变它会静默破坏卡片）。
 *   其余字段是**本层证据**：给状态载荷/日志/排障用，客户端不消费，可增删但不得改变前四者语义。
 *
 * @typedef {Object} LastRunRecord
 * @property {string} argv 实际 argv（脱敏后、空格连接的单行；供用户复核"到底下发了什么"）
 * @property {number} exitCode 退出码（缺失 ⇒ -1。⚠️ D-3：真机失败时也可能为 0 ⇒ **不得**单凭它判成败）
 * @property {string} stderrExcerpt stderr 摘录（先脱敏再截首 2KB）
 * @property {'accepted'|'rejected'|'unknown'} flagVerdict 参数接受度聚合判定
 * @property {Array<{flag: string, value: string, source: string, verdict: string, evidence: string}>} flags 逐 flag 归因
 *   （证据**点名**该 flag 才给 rejected；聚合 rejected ≠ 每个 flag 都被拒）
 *   `source` = 该 flag 的来源（`config.model` / `config.effort` / `plugin.outputFormat` / `session.cliSessionId`）——
 *   **UI 靠它把 ⚠ 落到对应下拉行**（§4.5），故不得在归因时丢弃（B-T04-4）
 * @property {string} flagEvidence 命中的拒绝证据原文片段（'' = 无）
 * @property {Array<{flag: string|null, value: string|null, source: string, reason: string, hint: string}>} notSent
 *   「有意图但**没上线**」的入参（★ 下发健康 A 组；取值域见 `launch/argv.js` 的 `NOT_SENT_REASONS`）。
 *   与 `flags` 严格分工：`flags` = 线上实际有什么（参与 CLI 接受度归因）；`notSent` = 压根没发出去
 *   （**不参与**归因 —— 让拒绝证据去点名一个没下发的旗标就是编造一次 `rejected`，会触发假回滚）。
 *   未指定取值（U9 的不传）**不算** notSent：那是正确行为，记进去只剩噪声。
 * @property {string} reasonCode 归一失败原因（'ok' | 见 reason-codes.REASON_CODES）
 * @property {string} reasonText 人可读原因（UI 直出；无则 ''）
 * @property {string} reasonEvidence 归一判据所用的证据片段
 * @property {string|null} signal 被信号终止时的信号名
 * @property {boolean} taskError 结果帧 `is_error`/非 success subtype（D-3 的另一半证据面）
 * @property {number} frames 解析到的帧数（0 帧 + exit 0 ⇒ 不给 accepted 的正向证据缺失）
 * @property {string[]} frameTypes 帧类型序列（`type/subtype`；D-4：不按序号读）
 * @property {number} parseErrors 非 JSON 行数
 * @property {string|null} resultSubtype 结果帧 subtype
 * @property {string|null} initModel init 帧携带的**实际**模型（≠ 我们下发的 --model；D-2：目录不同源）
 * @property {'retained-window'|'spill-head'|null} initModelSource initModel 的**出处**（★ WB-2）：
 *   'retained-window' = 内存保留窗口里的帧；'spill-head' = 从落盘文件头部补读回来的。
 *   值为 null 时出处也是 null（**没有值就没有来源** ⇒ 不写 'unavailable' 之类的假出处）。
 * @property {string|null} initPermissionMode init 帧携带的**实际**权限模式
 * @property {'retained-window'|'spill-head'|null} initPermissionModeSource 同 initModelSource，**逐字段独立**：
 *   窗口给了模型、落盘头部才给出权限模式，是完全可能的（两字段各有出处，才不至于互相冒充）
 * @property {string[]} permissionDenials CLI `result` 帧 `permission_denials` 归一后的**去重**短串
 *   （最多 16 条；空数组 = CLI 报了"没有拒绝"或本次没拿到该字段 —— 两种情况不区分，见下条计数）
 * @property {number} permissionDenialCount 拒绝**次数**：结构化字段存在时取 CLI 自报总数（不受 16 条上限影响），
 *   该字段缺失时回落到 `tool_result` 原文命中数。★ 非 0 **不等于**本次失败（模型可绕开被拒的工具）——
 *   只有"已失败"（exit≠0 或 taskError）时它才会把原因码改判成 `permission_denied`
 * @property {string|null} sessionId 抽取到的 CLI 会话 ID（null = 没抽到，不猜）
 * @property {string|null} sessionIdSource 'init' | 'frame' | 'regex' | null
 * @property {boolean} stdoutTruncated 保留窗口是否截断（lossy 语义）
 * @property {string|null} stdoutSpillPath stdout 完整流的落盘文件路径（★ WB-1；null = 本次没有完整副本）。
 *   dsh 只在文件**完好**时回传（超过落盘上限会删文件并停止回传，close 失败亦然）⇒ 有路径就可当现场可查。
 *   ⚠ 与 `initModelSource: null` **同时出现**时含义有歧义："文件读不到"与"文件头部没有 init 帧"不区分 ——
 *   两者都只是"没能兜底"，去 `stdoutSpillPath` 那个人类可点的文件里看一眼即可，故不为区分再加字段。
 * @property {string|null} stderrSpillPath stderr 完整流的落盘路径（同 stdoutSpillPath；真机失败证据常在 stderr）
 * @property {number} stdoutBytes / @property {number} stderrBytes 原文**字节**数（截断只影响摘录）
 * @property {{nodePath: string, nodeSource: string}|null} runtime 本次使用的 node 运行时与来源
 * @property {number} at 记录时间戳（ms）
 */

/**
 * 状态 bridge 载荷（GET <prefix>/status；T03 卡片与命令消费）。
 * @typedef {Object} StatusPayload
 * @property {string} pluginId
 * @property {RegistryState} registry
 * @property {ProbeResult|null} probe
 * @property {{enabled: boolean, model: string, effort: string}} config
 * @property {{canonical: string[], values: Record<string, string>}} effort 档位映射表（§4.2；缺 key = 不支持）
 * @property {Array<{id: string, label: string, detail: string, isFree: boolean|null, supportsReasoning: boolean|null}>} models
 *   `isFree` = **倍率三态**：`true` 0 倍（免费）｜ `false` > 0 倍（付费）｜ **`null` 倍率未知**
 *   （本机 product.json 48 条里仅 9 条带 `credits` 键；未知不得折成 false 或 true，见 launch/model-catalog.js 的 creditFreeFlag）
 * @property {string} modelsSource 目录出处，**三态**（§4-9）：`<source>` = 已读到 ｜
 *   `unavailable:<reason>` = 探测已结论但目录取不到 ｜ `pending:<reason>` = 探测尚无结论
 *   （`detection-in-flight` / `detection-not-started`）—— 在途**不得**写成不可用
 * @property {Array<object>} inFlight 在途作业明细数组（§4.4.3；长度 = UI 显示数）
 * @property {LastRunRecord|null} lastRun
 */

export {};
