# 更新日志（Changelog）

本项目版本号遵循 [SemVer](https://semver.org/)，格式参照 [Keep a Changelog](https://keepachangelog.com/)。

## [Unreleased] - 2026-10-10

### 修复（Fixed）
- **fix(team): dsh 智能团队界面整体消失的根因修复** —— `cordis.patch.yml` 的
  `dsh-session-persistence-jsonl-team` 条目漏写 `config.root`，撞
  `dsh-session-persistence-jsonl` 的 `root: z.string().required()`（boot 日志实锤
  `ValidationError: $.root missing required value`）。team 栈依赖持久化会话存储才激活
  ⇒「智能团队」UI 整个不见。补 `root: !!js dshHomePath('sessions')`（与 dsh-base 基础条目
  同库，团队成员本就是 Lead 会话树下的子会话）。缺陷自初始提交即在场，DSH 升级后
  schema 校验变严格才暴露。复现/验证：`04-docs/FIX-20261010-team-persistence-root.md`。
### 新增（Added）
- **插件使用说明 `packages/plugin-workbuddy/README.md`**（此前 `files` 声明了却从不存文件，
  本次新建）：工具用法、智能团队用法（`spawn_teammate(name="workbuddy",
  description="WorkBuddy · …")` → 成员调 `workbuddy_run` 下发）、硬约束（唯一桌面端通道 /
  零 CLI / 零反代）与状态查看方式。

## [0.3.0] - 2026-10-10

### 本次更新的目的

每天打开 WorkBuddy 点一次签到才能到账的积分，改成插件自动领。先查后领、领完复核，全程幂等——今天已经领过（不管是谁领的）就只读收尾，不会重复发放。

同一轮还收口三件事：点火轮改为**零计划任务 INSERT** 的直接点火通道；任务权限真源改**直读 SQLite**（彻底废除 18488 端口与 sidecar 依赖）；以及 `workbuddy_status` 输出 schema 的违约修复。

### 修复（Fixed）

- **fix(status): `workbuddy_status` 输出 schema 违约**——补声明 `section` / `count` 等切片键；`models` 放宽为 `array | object` oneOf；顶层 required 收敛为 `balance` / `creditsRemain`；删除 ownKeys Proxy（原先把 properties 的键集钉死在 16 个传统键上，`balance` / `creditsRemain` 及今后任何新键都会被 schema 校验误判违约）。

### 新增（Added）

- **每日签到自动领取**（Buddy 加油站）：状态面读到"活动进行中且今日未签"时在后台顺手领掉；领到后刷新一次余额读数。开关 `enableAutoCheckin` **默认开**（关掉即停；总开关 `enabled` 关着时一次都不跑）。跨天按**北京时间**算（腾讯按北京时间记账，北京时间无夏令时）。
- **直接点火通道（`enableDirectIgnition`）**：CDP 9222 直连桌面直接建对话并下发，**零计划任务 INSERT**；派发前失败回退自动化队列（回执带 `fallback` / `fallbackReason`），任务不丢。
- **权限真源直读 SQLite**：任务权限改直读 `sessions.permission_mode`，**废除 18488 端口与 sidecar 依赖**。
- **晚收获通道（`workbuddy_harvest`）**：按 `automation_id` 检索任何过去或正在运行的 WorkBuddy 任务结果、assistant 回复正文、生成产物列表与会话句柄（支持已完成 / 运行中 / 历史任务，`wait_ms` 可等待收尾）。
- **状态面 +1**：本机状态接口 `/plugin-workbuddy/status` 与模型工具 `workbuddy_status` 各 +1 个顶层键 `checkin:{active, todayCheckedIn, streakDays, dailyCredit, todayCredit, totalCredits, endTime, autoEnabled, lastClaim}`；`workbuddy_run` 回执键集一字未动。
- **设置卡片**：状态区 +1 行「每日签到：今日已领（今日 +N，连签 M 天）/ 今日未领，将自动领取 / 签到活动已结束」；配置组 +1 个开关「自动领取每日积分」。没读到就说"暂时读不到签到状态"，不猜已领/未领。
- **落盘快照**（供离线显示）：`checkinLastAt` / `checkinLastResult`（claimed / already / inactive / failed-*）/ `checkinLastCredit` / `checkinStreakDays`，与积分四字段同一条 volatile 硬约束。

> ⚠️ 备注：dsh有了这个插件越来越懒了什么都派出去干。

### 维护（Chore）

- `automationTimeoutMs` 默认改为 **15 分钟**（900000ms）。
- 自动化下发 prompt 注入 **`READ_ONLY_PROMPT_GUARD`**（只读工作区守卫）。
- 测试扩充：e2e tier1–4、adversarial/stress、late-harvest 等 **22 个新测试文件**。

### 接口来由（不重复造轮子）

- 签到协议（状态→领取→复核三段式、HTTP 400 + `code:10001` = 今日已签的幂等口径、北京时间跨天）复用公开仓库 [`88lin/workbuddy-auto-signin`](https://github.com/88lin/workbuddy-auto-signin)（1k star）与 [`SIMON-WORLD/workbuddy-daily-credit`](https://github.com/SIMON-WORLD/workbuddy-daily-credit) 的逆向结论；
- **传输面不抄**：公开仓库是直连 HTTPS + 自读登录态文件（插件进程持有账号凭据，本仓红线 E3 禁止）；本插件走既有 `wbipc` 通道由桌面端代发，插件不读凭据文件、不组装鉴权头。真机双通路实测：状态 200 全字段、已签领取 400+10001。
- **范围**：只动免费的每日签到；成长中心（旅行礼物/盲盒/补登/兑换）是另一套活动接口，不在本轮 scope。

### 验证

- **门禁**：`test:host` **617** 例 · `test:client` **83** 例 · CI 红线 4 项全绿（含 `check-no-credential-echo` 51 文件零凭据形状）。
- **真机**（WorkBuddy 桌面端在跑且已登录，2026-10-09）：状态 200（`today_checked_in:true`，连签 2 天，日 100）；领取走已签分支（领取接口零调用）；余额直读 663.27。
- 新增 `test/daily-checkin.test.js` 19 例（解析三态纪律、领取幂等、总闸/开关门禁、北京跨天、落盘 volatile、unhandled rejection 双半）。

### 兼容性

- 只增不减：`checkin` 缺省即 `null`（老 host 不传 ⇒ 卡片显示"读取中"）；`enableAutoCheckin` 缺省按开显示，与宿主默认值一致。
- 无默认行为变化外的风险：非活动季静默收尾；桌面端没开如实报读不到，不代启动 WorkBuddy。

## [0.2.3] - 2026-10-08

### 本次更新的目的

设置卡片「乱」的两处具体病灶：**下拉框被挤成半截**，**状态区读数没有列**。三刀纯排版改动，一行文案未改。

### 变更（Changed）

- **模型 / 推理强度下拉独占整行**（`dsh-wb-row--model` / `--effort` 改单列栅格：标签在上、控件在下满宽）。原布局是「5.5em 标签列 + minmax(0,1fr)」，面板一窄模型名就被切掉、倍率看不见。
- **去掉 `max-width:30em`**，改 `min-width:12em` 作为极窄面板下限。30em 这条当初的理由是「兜住宽面板」，实际效果是把宽面板也压成半截；搜索框同步去帽。
- **状态区「标签：值」行改悬挂缩进**（首行 −6.5em、折行 +6.5em）⇒ 标签列与值列对齐，不再每行各自乱折。靠 `[data-kv]` 属性选中，**文本节点一字未动**（折叠纪律与逐字断言都要求主视图原样）。
- **状态行字色/字号提一档**：12px tertiary → 13px primary（此前整块像脚注）；警告行仍走 warn 字色，折叠内部仍是 12px tertiary mono。

### 兼容性

- **纯 CSS + 一个 `data-kv` 属性**：DOM 结构与文案零改动，既有逐字断言（会话计数文本、任务块人话、折叠纪律）全部原样通过。
- 不改任何字段语义、键集、默认值；`workbuddy_run` 回执一字未动。
- 门禁：`test:client` **77** 例 · `test:host` **597** 例 · CI 红线 5 项全绿 · `check:knobs` PASS · `check-no-credential-echo` PASS。

### 说明（关于本地 profile，不是代码变更）

2026-10-08 本机 `~/.dsh/profiles/desktop/cordis.patch.yml` 曾因一次错误的整文件重写被损坏，已用 `~/.dsh/backups` 中的已知良好版本恢复，损坏件隔离留存。**本插件的改动全部只经 `node` 写 UTF-8**；今后不再对用户 profile 使用 PowerShell 默认编码的整文件写入。

## [0.2.2] - 2026-10-08

### 本次更新的目的

切号之后点火连败的根因修复 + 账号识别变**只读可见**。三件事，同一个方向——**点火写进去的 owner 必须等于桌面端现役账号，而且这件事你随时能自己确认**。

### 新增（Added）
- **现役账号只读确认面**：`workbuddy_status` 顶层键集 +1（`account:{uid, method}`），本机状态接口 `/plugin-workbuddy/status` 与设置卡片「状态」区同步透传。`method` 取值 `epoch-marker-align`（与当前桌面实例的 epoch 精确对齐，权威）／`security-holder-mtime`（只能用最新改动的 holder 推断）／`none`（无证据，如实说"未识别"）／`error`。设置卡片上多一行「账号：<uid> · 来源」——**只读**，不可写、不参与点火；它的作用是让你能自己判断"行的 owner 和它是不是同一个"。**`workbuddy_run` 回执键集一个字未动。**
- **owner 真源升级**：点火行的 `owner_user_id` 先取 `~/.workbuddy/security/<uid>/data.lock.holder` 与 `epoch-marker.json`（当前实例 epoch）**对齐命中**的账号，取不到才降级到「holder mtime 最新」，再取不到才是旧链路的 sessions 表 / automations 历史行。夹具目录没有 `security/` 时行为与旧版逐字节一致。

### 修复（Fixed）
- **切号后桌面调度器"不运转"、点火永远没有新会话**：`resolveOwnerUserId` 原先从 `sessions` 表取最近活跃的 `user_id`，而切号后该表最新行仍属**旧账号**（要等产生过新对话才会刷新）⇒ 新点火的行顶着旧 owner，被调度器 `ownerVisibility()` 的 fail-closed 归属隔离**静默整批过滤**（零 dispatch 行、零会话、界面一个新对话都没有）。真机 2026-10-08 复现：三次注入全部 12 轮轮询超时、`toolCalls=0`、无 `sessionId`。修复后同一台机、同一账号，两次真机点火 **23s / 21s** 闭环成功（会话 `f431614b…` / `6770a509…`，模型 `deepseek-v4.1-flash`，积分 0.54 / 0.08）。

### 变更（Changed）
- 本机 profile `dsh-plugin-workbuddy.config.model` 若残留旧账号才有的模型 id（如 `glm-5.3-flash`），切号后会被服务端拒（400 model unavailable）⇒ **清成 `''`**（未指定，桌面端用其默认模型）。**这是本机配置修正，不是代码变更**：新账号的可用模型以桌面端目录为准。
- 设置卡片「状态」区新增账号行（位置：设置状态之后、模型来源之前）；其余行文案与 DOM 形状一字未动。

### 验证（真机实测，WorkBuddy 5.7.6 + 新账号）
- **门禁**：`test:host` **597** 例 · `test:client` **77** 例 · CI 红线 5 项全绿 · `check:knobs` PASS · `check-no-credential-echo` PASS（50 文件零凭据形状）。
- **真机点火两连发**：`automation.log` 出现 `dispatch automation … dispatchOrder=1` 且 `run finished success=true`（11:41:22Z / 11:42:00Z），对话在桌面端 `sessions` 表里可见，账号为切号后的新账号。
- **账号识别**：`currentAccountFromSecurityDir()` 在切号后立即返回新账号 uid（epoch 尾号与 holder 精确对齐），不等 `sessions` 表刷新。

### 兼容性
- 只增不减：`account` 缺省即 `null`，老 host / 老夹具一律不渲染该行。
- 无默认行为变化：`security/` 不存在（测试夹具、非常规安装）时 owner 解析链与 0.2.1 **逐字节一致**（回归用例仍绿）。

## [0.2.1] - 2026-10-04

### 本次更新的目的

两件事，方向一致——**让点火这一轮更快、并且如实说出自己跑在什么环境上**：

1. **计划任务改 CDP 直接点火**：点火轮绕过桌面端计划任务的调度排队，直接建对话并下发，实测砍掉约 14 秒调度开销；开关默认关闭，未开启时与 0.2.0 逐字节一致。
2. **会话模型 / 思考强度只读识别**：向已有会话续发的那一轮，回执如实带回这条对话当前用的是哪个模型、哪一档思考强度。语义钉死为**只识别、不复位、不改动**——你在桌面端手动改过的设定，插件读到什么就报什么，绝不回写。

### 新增（Added）

- **直接点火（CDP ignition）**：新增设置项 `enableDirectIgnition`（默认 **false**）。开启后 `workbuddy_run` 与智能体团队链（subagent）的**点火轮**经 WorkBuddy 桌面端调试通道（CDP）直接 `create` 对话并 `runPrompt` 下发，跳过计划任务队列。回执 `transport:'direct'`、`phases:['direct-ignite']`，成功即 `sessions.adopt` 记性（下一轮同会话追发能命中）。
  - **派发前 / 派发后两段语义**：探测、建会话、设配阶段失败（`dispatched:false`）⇒ 照旧**回退计划任务队列**，回执带 `fallback` / `fallbackReason`，任务不丢；`runPrompt` 已发出之后的任何失败（超时、`state` 非 completed）**一律不回退**——回退会把同一条 prompt 再跑一遍（双份积分 + 两条对话），如实记 `failed` 并带上 `conversationId`。
  - **只设请求过的项**：模型走 `create` 入参，思考强度 / 权限模式走 `configSetThoughtLevel` / `configSetPermissionMode`；未请求则零 setter 调用，绝不复位你在桌面端的既有设定。
  - **状态面看得见**：`workbuddy_status` 新增 `cdp:{available, port, reason}` 与 `ignition:{mode, reason}`；模型据此判断该不该问你。可用性提示写明：依赖 CDP、配置方法、**三个必须询问你的触发点**，并禁止插件静默回退、禁止谎称走 direct、禁止代设环境变量或代杀/代重启 WorkBuddy。
- **会话模型 / 思考强度只读识别**：追发轮在派发**前**通过桌面端调试通道读一次会话快照，回执新增 `follow_up.conversationModel` 与 `follow_up.conversationEffort`（`string | null`）。读到什么报什么；读不到如实 `null`，**不编造、更不会为了"读不到"就去改会话设定**。`workbuddy_status` 的 `lastRun.followUp` 与智能体团队回执同名同义透传。
- **识别读取与派发预算分离**：识别走独立的 2 秒小预算——桌面端卡顿时最多拖 2 秒即放弃并照常追发。识别失败**绝不**把这一轮判死，也绝不蚕食追发的确认窗口。

### 变更（Changed）

- `workbuddy_status` 顶层键集 +2（`cdp` / `ignition`）；**`workbuddy_run` 回执键集一个字未动**（既有字段语义与键集由测试逐字锁死）。
- 追发回执 `follow_up` 与 `lastRun.followUp` 新增 `conversationModel` / `conversationEffort` 两键，schema 中声明为 `string | null`。
- 主控模型的可用性提示（availability）随开关状态说明：直接点火与追发依赖桌面端调试口；追发轮**不发送**任何模型/强度设定，沿用该对话现有设定，回执只读如实回报。
- 智能体团队链（subagent）回执尾注新增 `transport=direct` 语义，`BIT_KEYS` 白名单未改（不新增字表项）。

### 验证（真机实测，WorkBuddy 5.6.2 + 调试口 9222）

- **延迟拆解**：direct 点火 **12542ms** / 同会话追发 **13585ms** / 第二次 direct **9545ms**；扣除桌面端记录的模型轮次后，我们的链路开销 **5893 / 851 / 893ms** ⇒ 稳态 ≈0.9s，对基线 `42100ms（27000 模型 + 15100 调度）` **砍掉约 14 秒**调度。首条 5.9s 是新建对话在桌面端的前置排队，同路径第二条只剩 0.9s。
- **回退路径**：把 `followupCdpPort` 指向错口（19999）⇒ **3ms** 返回 `{stage:'detect', dispatched:false, code:'ERR_WORKBUDDY_CDP_UNAVAILABLE'}`，**连对话都没建**（可回退、零垃圾）；"回退后任务照跑 + `fallback` 两键"由单测断言。
- **完全权限补测**：`permissionMode:'fullAccess'` 点火后回读 `fullAccess`，+3s 复核、**同会话复用第二条之后仍为 `fullAccess`**；两轮 Bash 探针 token 命中（真执行，非仅回传）。已存在的旧对话补设同样 `"" → fullAccess` 并稳定。
- **只读识别三连发**：点火（带模型 + 思考强度）→ 同会话追发 → 桌面端**手动改模型** → 第三轮追发。回执如实显示改后模型，追发前后会话设定**逐字未变**（零复位、零回写）。
- **门禁**：`test:host` **595** 例、`test:client` **82** 例、CI 红线 5 项全绿、`check:knobs` PASS；发布前凭据/隐私扫描对**被跟踪文件**逐条复核，高危 0。

### 兼容性

- 不改默认行为：`enableDirectIgnition` 与 `enableMultiTurnFollowUp` 默认均为 **false**，两个都未开启时与 0.2.0 逐字节一致（既有测试零改动通过）。
- 对既有消费者**只增不减**：新增键缺省/读不到时为 `null`，不改变任何既有字段语义。
- **依赖披露**：直接点火与追发都依赖 WorkBuddy 桌面端带 `WORKBUDDY_REMOTE_DEBUGGING_PORT`（默认 9222）启动，需一次性设置用户环境变量后**完全退出并重启 WorkBuddy**。插件只告知、只询问，不代设、不代杀、不代重启，也不静默回退。**不引入任何网关或反向代理变种**——链路始终是本机 CDP 直连。

## [0.2.0] - 2026-10-03

### 本次更新的目的

把"向已有会话继续下发任务"（同会话多轮追问 / 会话复用）从原型研究推进为可用的默认安全能力，并修复一个会让**任何开源用户**的点火功能静默失效的可移植性缺陷。

### 新增（Added）

- **会话复用通道（多轮追问）**：新增设置项 `enableMultiTurnFollowUp`（默认关闭）。开启后，`workbuddy_run` 带 `resume:true` 且记性命中时，通过 WorkBuddy 桌面端调试通道向既有会话追发消息，**同一条对话继续执行**——桌面端可见、上下文连续。回执带 `resumed:true` 与 `follow_up:{channel, elapsedMs}`；状态卡片显示「会话复用：复用上次对话续发」。
- **确定性回退（graceful fallback）**：追发失败（桌面未带调试端口、会话已删除/关闭、目标端口被外部浏览器占用、超时等，共 7 类标准指纹）时，自动作废该会话记性并回退到既有点火路线新开会话——**任务不丢**。回执与状态卡带 `fallback:true` 与 `fallbackReason` 指纹码。
- **智能体团队链路支持**：团队委派（subagent）同样走会话复用——记性命中即续接同一对话（不重放历史前情，避免重复），失败自动回退点火；团队回执尾注带 `origin=resumed`、`continuity=same-conversation`、`follow-up=track_a in <耗时>ms`、`fallback=<原因码>`。
- **追发目标判别**：CDP 两级判别（版本接口 User-Agent 含 WorkBuddy/ 且目标列表命中桌面渲染层），防止调试端口被外部浏览器占用时误把消息派发给无关浏览器。
- 新增设置项：`enableMultiTurnFollowUp`（默认 **false**）、`followupCdpPort`（默认 9222）、`followupTimeoutMs`（默认 180000ms，依据真机冷启动实测数据）。

### 修复（Fixed）

- **【严重 · 可移植性】点火在桌面切换账号后静默失效**：点火写入的归属字段（`owner_user_id`）此前从本机历史数据行里抄写——桌面端一旦切换登录账号，新写入的任务行会被调度器的归属隔离（fail-closed 安全设计）整批过滤：**零日志、零派发、桌面端自己的接口也查不到**，用户侧表现为"点火永远不产生新对话"。现在从会话表中解析**当前登录账号**（按最近活跃时间，旧库结构逐级降级），空值/空白串按桌面端同款语义处理；回归测试 5 例钉死该行为。
- **点火失败诊断增强**：任务行写入后调度器未接住的错误文案，现在携带写入行的归属值并说明归属隔离语义，把"静默不可见"变成"可自行诊断"。
- **测试可移植性**：本机没有 WorkBuddy 真库（未安装/未初始化）时，`test:host` 中 4 条真库护栏改为**显式跳过**（SKIP 可见，不假红不假绿）；其余测试全部自包含。
- **隐私清理**：移除随仓库发布的内部台账中残留的作者机器账号 id 片段。

### 变更（Changed）

- 作业回执与运行状态（lastRun）新增如实记账键：`fallback` / `fallbackReason`，以及复用轮辨认键 `transport` / `sessionOrigin` / `followUp`。
- 本机状态接口 `/plugin-workbuddy/status` 与 `workbuddy_status` 工具的 `lastRun` 自动透传上述新键。
- 主控模型的可用性提示（availability）随开关状态说明复用语义，避免模型按"每轮新开无记性"的旧口径行事。

### 兼容性

- 所有新设置项默认关闭：不开启 `enableMultiTurnFollowUp` 时，行为与 0.1.x 逐字节一致（既有测试断言零改动通过）。
- 追发依赖 WorkBuddy 桌面端以 `WORKBUDDY_REMOTE_DEBUGGING_PORT`（默认 9222）环境变量启动；未启用时自动回退点火路线，不新增部署负担。

## [0.1.0] - 初始开源版本

DshAgentHub 把本机 agent（首个 WorkBuddy）变成看得见、可调度、可观测的执行方：工具面下发、桌面端可见对话、回执与作业面板、启动清扫、积分只读显示。
