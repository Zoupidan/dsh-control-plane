# dsh-plugin-workbuddy

把本机 **WorkBuddy 桌面端**暴露成 DH（DeepSeek Harness）的模型面工具：把编码任务下发给
WorkBuddy、读它的状态、收割结果、精准清理。插件**只经桌面端**通信，不拉任何 CLI。

> 一句话用法：在 DSH 对话里直接说"用 WorkBuddy 做 X"，模型会调用 `workbuddy_run` 下发；
> 想以"团队成员"形态可见地委派，让模型 `spawn_teammate` 建一个名为 `workbuddy` 的成员。

## 工具（4 个）

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `workbuddy_run` | 下发一个编码任务（后台作业） | `task`（必填）、`session_key`、`model`、`effort`、`cwd`、`permission_mode` |
| `workbuddy_status` |  inspect 本机 WorkBuddy 安装与最近一次下发 | `section`（models/credits/checkin/sessions/overview）、`compact` |
| `workbuddy_harvest` | 按 `automation_id` 收割过去/正在跑的任务结果 | `automation_id`（必填）、`wait_ms` |
| `workbuddy_purge` | 软删一条 WorkBuddy 对话 + 清 session map 记性 | `session_key` 或 `idLike` |

工具是否在场由两把闸决定：插件总开关 `enabled`（设置里可见）+ 桌面端探测结论。
关着时说"不可用"是真话（系统提示会明说），不假装在场。

## 在 DSH 里怎么看状态

1. **系统提示**：每个模型回合都会出现一段 "WorkBuddy delegation is available/unavailable…"，
   包含当前生效的 model/effort、追发开关、CDP 前置条件、最近一次失败原因。
2. **`workbuddy_status`**：模型可随时调；`section` 单节 ≤2KB 不截断，`compact:true` 全量字典化。
3. **DSH 界面状态卡片**：与状态路由同源（三态：未安装 / 已装但 OFF / 已装且 ON）。

## 智能团队（Agent Teams）用法

本插件选择**智能团队**而非经典子智能体作为委派面（2026-10-02 主理人裁决）。团队成员是
**真的 dsh agent**，不是代理壳——名字直接显示在团队界面上。

标准用法（模型按系统提示执行，人也可以直接要求）：

1. Lead 创建成员：`spawn_teammate(name="workbuddy", description="WorkBuddy · 你的工作全部通过调用 workbuddy_run 下发到本机…")`
   - 名字必须 **lower-kebab-case**（dsh 硬校验，`WorkBuddy` 这种大写名会被拒）；
   - 成员列表只显示名字，所以 `workbuddy` 这 4 个字是唯一强可见度；
   - description 以产品名打头（`WorkBuddy · …`），分类信息降为从句。
2. 之后给该成员派活：它调用 `workbuddy_run` 把工作真正下发到本机 WorkBuddy 桌面端。
3. 质疑/反驳：对同一成员 `send_message` 提异议，下一轮它反驳（默认最多两轮，可约）。

**明确不做**：把团队的 `freshProvider` 设成 `workbuddy`——那等于把 dsh 自己的生成经
WorkBuddy 路由，就是本项目禁止的反代。插件只做"成员是 dsh agent、工作落在 WorkBuddy"。

## 架构红线（改动前必读）

- **唯一通道**：CDP（`ws://127.0.0.1:9222`，追发/点火）+ 桌面端内部自动化队列
  （`~/.workbuddy/workbuddy.db` 的 `automations` 表）+ wbipc 命名管道（桌面端代发 HTTP）。
- **零 CLI**：任何路径（正常流/回退/探测）不得拉起 workbuddy.exe CLI、CodeBuddy Launcher、
  任何显隐 Shell/控制台进程（CI 红线 `check-no-process-exec` / `check-no-exec-probe` 钉死）。
- **零反代**：不监听端口、不转发流量、不做中间人（18488/sidecar 已废除，测试负控钉死）。
- **会话复用**：`session_key` 亲和 + `enableMultiTurnFollowUp` 追发（CDP 续接同一对话）。

## 维护者注记

- **team 栈依赖**：`cordis.patch.yml` 的 `dsh-session-persistence-jsonl-team` 必须带
  `config.root`（schema `root` required，缺了整个「智能团队」界面不激活，见
  `04-docs/FIX-20261010-team-persistence-root.md`）。
- **安装方式**：profile 的 `node_modules/dsh-plugin-workbuddy` 是指向本目录的 Junction，
  改这里即对所有 profile 生效；运行中的 DSH 需重启才重读 patch。
- **测试**：`npm run test:host` / `test:client`；红线 `npm run ci:redlines`。
- 详细决策与事故记录：仓库 `04-docs/`（按日期命名的 FIX/HANDOFF/TEAM-PLAN）。
