# 更新日志（Changelog）

本项目版本号遵循 [SemVer](https://semver.org/)，格式参照 [Keep a Changelog](https://keepachangelog.com/)。

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
