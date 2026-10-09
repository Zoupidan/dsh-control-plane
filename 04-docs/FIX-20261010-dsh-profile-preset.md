# 修复记录：desktop profile 的 dsh-tool-* 工具面缺失（2026-10-10）

- 对象文件：`C:\Users\cheng\.dsh\profiles\desktop\cordis.patch.yml`（**仓外文件**，本 commit 只落诊断与改法记录；改动本身已直接应用于该文件，备份在其同目录 `cordis.patch.yml.bak-20261010-toolfix`）。
- 安全边界：只改了 `~/.dsh` 内这一个文件，未触碰 WorkBuddy 实例与任何对话。

## 诊断（根因，file:line）

- `preset-partner`（:562 起）与 `preset-freedom6`（:905 起）两个块内的 `dsh-tool-*`
  （tool-pwsh / tool-fs / tool-web / tool-subagent / tool-todo 等）只存在于
  `- insert:` 的 preset 插件名单里，**顶层从未注册**（顶层条目扫描只有
  ui-* / permission / llm-* / dsh-plugin-workbuddy / better-sidebar，零 dsh-tool-*）。
- 部署默认 preset 是 `standard`：
  `node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml:561-565`
  （`- insert: - id: agent-preset-registry … config.default: standard`）。
  registry 取默认值的读法：`defaultId = selectedDefault.get() ?? config.default`
  （`dsh-agent-preset-registry/lib/index.js:493-495`；Config 声明 `:471-475`）。
- ⇒ 当前会话（自认为"伙伴模式 + 完全权限"）实际按 standard 挂载，一条 dsh-tool-* 都拿不到。

## 修复（最小改动路径）

不动 ~640 行 preset 名单，在顶层追加一条 registry 覆盖（`:1209-1227`）：

```yaml
- id: agent-preset-registry
  name: "@deepseek-ai/dsh-agent-preset-registry"
  config:
    default: partner
    selectedDefault: partner
```

选 **preset 覆盖** 而不是"把 dsh-tool-* 提到顶层注册"的理由：后者需要复制两个 preset
块里约 640 行带 isolate realm / persona / config 的插件行（两份手工拷贝必然漂移，且
realm 语义在顶层无 isolate 组会撞 registry 挂载校验）；前者一行覆盖、语义与
`cordis.patch.yml.BROKEN-20261008-1936:1349-1353` 里已验证过的写法逐字同形
（当时 `default: standard` + `selectedDefault: freedom6`）。
生效时机：下一次 DSH 会话创建时按新 default 挂载（本会话不重启，本轮刻意不 kill 实例）。
