# 修复记录：dsh 智能团队界面整体消失（2026-10-10）

## 症状

DSH 桌面端「智能团队」（Agent Teams）界面整体不显示——「之前有的，后面也没了」。
用户无法在 DSH 里看到、更无法使用团队成员（spawn_teammate）能力。

## 根因（boot 日志实锤 + schema 离线复现双重证据）

DSH 宿主 boot 日志（`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-2026-10-10T01-34-36-881Z-host.log`）：

```
dsh: warning: 2 entries did not activate
product-analytics (@deepseek-ai/dsh-client-product-analytics): pending (waiting for service: productTelemetry)
dsh-session-persistence-jsonl-team (@deepseek-ai/dsh-session-persistence-jsonl): ValidationError: invalid config:
  - $.root missing required value (at root)
```

链条：

1. `packages/plugin-workbuddy/cordis.patch.yml` 注册 team 栈四件套时，
   `dsh-session-persistence-jsonl-team` 条目**漏写 `config.root`**。
2. `@deepseek-ai/dsh-session-persistence-jsonl` 的 schema（asar 内 `lib/index.js` static Config）：
   `z.object({ root: z.string().required(), compression: … })`。
3. Team README 原话："The team features need durable session storage to activate"——
   `agent-team` / `tool-agent-team` / `ui-agent-team` 依赖持久化会话存储才激活；
   持久化条目激活失败 ⇒ team 栈不完整 ⇒「智能团队」UI 整个不见。
4. 缺陷自初始提交（`9594ce5`，2026-10-02 加 team 栈）即在场；DSH 升级后 schema 校验变严格
   才暴露 ⇒ 表现为无来由的"之前有、现在没"。

**离线复现**（用 dev-deps 里宿主自带的 schemastery，`verify-schema.mjs`）：

```
OLD (no root): FAIL -> $.root missing required value      ← 与 boot 日志逐字一致
NEW (root set): PASS -> {"root":"C:/Users/cheng/.dsh/sessions","compression":"zstd"}
```

## 修复

`packages/plugin-workbuddy/cordis.patch.yml`（Junction 链接进 `~/.dsh/profiles/*/node_modules/`，一处改全生效）：

```yaml
- id: dsh-session-persistence-jsonl-team
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js dshHomePath('sessions')
```

设计取舍：
- **root 与 dsh-base 基础条目同值**（`dshHomePath('sessions')`）：团队成员本就是 Lead 会话树
  下的子会话（`header.origin === 'subagent'`），同库存储保持血缘可查、可被历史代码复用。
- **服务键不随实例变**（`SessionPersistence`，jsonl lib 注释明示 "shadows Service.name
  without changing the service key"）⇒ 同 root 的第二实例无服务冲突。
- `dshHomePath` 由 loader `ctx.provide("dshHomePath", …)` 提供，`!!js` 在任意行 config 内合法。

## 生效与验证

- 补丁经 Junction 对所有 profile（desktop / cp-wb / cp-wb-hl / cp-wb-probe）即时生效路径一致；
  **运行中的 DSH 需重启**（patch 只在 boot 时读取）。
- 验收：重启后 boot 日志不再出现 `dsh-session-persistence-jsonl-team` 激活失败；
  DSH 界面「智能团队」恢复；模型按提示词 `spawn_teammate(name="workbuddy", description="WorkBuddy · …")`
  建成员后，界面成员列表可见该成员（名字是唯一强可见度，必须 lower-kebab-case）。

## 文档

- 插件使用说明（含智能团队用法）：`packages/plugin-workbuddy/README.md`（本次新建，
  同时修复 `files` 声明了却从不存在的 README 缺陷）。
- 模型面使用指引（系统提示内，每回合可见）：`src/host/prompts/availability.js` 的
  `subagentRouteHint()` —— 已有完整 spawn_teammate 契约，本次不改其措辞（契约逐字锁定）。
