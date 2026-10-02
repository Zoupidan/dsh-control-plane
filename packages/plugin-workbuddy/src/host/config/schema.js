/**
 * settings schema（★ §3.6 的唯一真源；T04 从 apply.js 抽出 —— 收口 §3.4.1 的"apply.js ≤60 行"偏差）。
 *
 * Implements: 02-design/DESIGN-v3.md §3.6（settings 命名空间与字段语义）/ §4.3（H-NO-FABRICATED-DEFAULT：
 *             未指定 = 空串，**不发明**默认值）/ §4.6（flag 表 + 取值表：表内无 key = 该平台不支持）
 *
 * 为什么单独成文件（T04 决定，登记见 04-docs/CONSTRUCTION-LOG.md §16）：
 *   - apply.js 的职责是**装配**（§3.4.1 R1：零业务逻辑），schema 声明是数据、不是装配；
 *   - 三处同步（本文件 ↔ cordis.patch.yml ↔ §3.6 文档）需要一个**唯一的**可 diff 落点。
 *
 * ★ `sessions` 的 schema 选择（有意为之，勿"收紧"）：
 *   `z.dict(z.any())` = 任意键 + 任意值。原因：这份数据由**本插件自己**写入（会话记录），
 *   且用户可能手工编辑 settings 文件；若用严格对象，一条坏记录会让**整份 namespace 校验失败**，
 *   连带把 enabled/model 等用户设置一起拒掉（实测 schemastery 报错形态见 session/map.js 头注）。
 *   真正的类型净化在**写入前**做（session/map.js `sanitizeRecord`），读取侧再容错一次。
 *
 * ★★ 0.1.7 迁移：`volatile` 是 0.1.7 新增的**可编辑性判据**（0.1.5 无此概念，实测 0.1.5
 *   dsh-settings 内 `volatile` 零命中）。0.1.7 的设置面**只投影 volatile 字段**：
 *   `dsh-settings/lib/types/schema.js:43-53 volatileForm()` 无 volatile 字段时返回 undefined，
 *   `lib/index.js:418-419` 据此跳过整个 entry ⇒ **插件在设置页彻底不出现**；
 *   写入侧同理抛 `Plugin entry "…" has no volatile fields`（:506）与
 *   `Config field "…" is not volatile`（:507,520）。
 *   本文件顶层 `Config` 不加 `.volatile()`、而是**逐字段**加：只有 UI 真正要写的字段
 *   （enabled/model/effort/permissionMode/cwdRoot/sessions）需要可编辑；
 *   `launch.*` 是 flag 名表（数据，不是用户偏好），保持普通字段 —— **且从不经过 settings 写**。
 *   依据：`z.string().volatile()` 等方法见 schemastery `lib/types/index.d.ts:156`。
 *
 * ★★★ 硬约束（`test/settings-contract.test.js` 守着）：**凡是用 `settings.update` 落盘的字段，
 *   必须是 volatile**。宿主 `dsh-settings/lib/index.js:507,520` 会拒绝非 volatile 的写入，
 *   而该拒绝走的是 rejected Promise —— 配上 `void` 就是 unhandled rejection ⇒ **宿主退出**。
 *   `launch.*` 不受此约束，因为没有代码路径写它。
 *
 * 约束：本文件属于 packages/*​/src（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 */
import z from '@deepseek-ai/schemastery';

export const Config = z.object({
  // ★★ 授权总闸（铁律 U4）：`enabled !== true` ⇒ 工具面与委派面**一处都不注册**。
  //   委派面读它的地方是 `host/subagent/index.js` 的 `reconcile`。
  //   默认 `false` 是**对外契约**：`cordis.patch.yml` 的字面量必须与本默认值一致（test:host 断言），
  //   改默认值会同时动到 schema 默认值断言与补丁一致性断言，三处要一起改。
  enabled: z.boolean().default(false).volatile(),
  model: z.string().default('').volatile(), // ★ U1（'' = 未指定 ⇒ 不下发 --model）
  effort: z.string().default('').volatile(), // ★ U2（'' = 未指定 ⇒ 不下发 --effort）
  // ★ D-1 / O-6 闭合（2026-09-19 真机取证）：非交互 `-p` **没有审批通道**，`default` 模式下写/执行类
  //   工具一律被拒（真机逐字见 launch/argv.js 同一段注释）。取值只来自**插件设置**（不做逐次调用参数，
  //   否则模型可自行提权）。'' = 未指定 ⇒ 不下发 `--permission-mode`（U9/H-NO-FABRICATED-DEFAULT：
  //   安全相关默认值必须由人显式给出，插件不替用户选 `bypassPermissions`）。
  //   合法取值 = **服务端下发的下拉表**（与 `sessionMode` 同域，见下方同名字段注释）：
  //   default / acceptEdits / plan / auto / dontAsk / bypassPermissions / fullAccess / delegate。
  //   旧注释里的 6 值 CLI 表（缺 fullAccess/delegate）已作废：那是 spawn 路由的旗标名，
  //   不是服务端的权限域。
  //   ★★ **这是任务下发的权限请求值域。** 见下面的 `sessionMode`。
  permissionMode: z.string().default('').volatile(),
  cwdRoot: z.string().default('').volatile(), // 子进程工作目录根；'' = 用默认（§7.3 优先级）
  // ★ T04：§5.1 的会话映射落盘位（key → {cliSessionId, cwd, lastUsedAt, …}）。见上方注释。
  sessions: z.dict(z.any()).default({}).volatile(),
  // ═══ 目标实例保障（★ 2026-09-30 新增）═══════════════════════════════════════════
  // 下发链路的第 0 站回答"目标实例在不在、要不要启动它"。为什么这两个开关是**有据的默认**
  // 而不是 H-NO-FABRICATED-DEFAULT 说的"不发明默认值"：
  //   `autoStartDesktop` 默认 true 的依据是**主理人给的流程**——「目标实例是否存在，是否要启动」
  //   是一句**要求插件自己回答**的话。默认 false 会把这句话原样退回给用户，流程就等于没实现。
  //   它**只**在"没有可用 sidecar 且桌面端确实没在跑"时才触发，且从不重启已开的桌面端；
  //   流程与全部边界见 `gateway/ensure.js` 头注。
  autoStartDesktop: z.boolean().default(true).volatile(),
  // 等目标实例出现的窗口（毫秒）。0/非法 ⇒ 用 `ensure.js` 的 DEFAULT_WAIT_MS（30s）。
  // 取 30s 的依据：桌面端激活 prewarm sidecar 实测 1–3s；30s 是"慢盘/杀软冷扫"的量级，
  // 再大就等于让用户对着一个转圈的作业干等，而那条作业本来也不会成功。
  instanceTimeoutMs: z.number().default(30_000).volatile(),
  // ═══ 传输面（★ 2026-10-02 起只有 `automation`）════════════════════
  // `automation` = 往计划任务表写一行 `once`（`startAutomationRun` 唯一写入点），
  // 等桌面端调度器建会话。`schedule_type='once'`、`next_run_at=now`、`valid_until=+25min`，
  // 附 `model_id` / `permission_mode` / `cwd`；建会话成功立刻 `retireRow` 软删，
  // 任何终态都退役，启动期扫遗留活行全软删（止损就靠删行）。
  // ★ `spawn`（自己拉 CLI）已**整体删除**（2026-10-01）：自 spawn 的 CLI 无登录态、必然
  //   auth_failed，既不能干活也不是合法数据源 ⇒ 该传输面随 CLI 线一并移除。
  // ★ `gateway`（本机 ACP 网关）已**下线**：本文件仅在注释里保留该字符串，不再走 `dispatch.run`，
  //   不再建网关会话、不再调网关任何接口。
  //   配置里残留 `transport:'gateway'` 一律按 automation 跑（见 execute.js），不走网关。
  transport: z.string().default('automation').volatile(),
  // ★ 绑定的对话 id：插件**只**把任务下发给这一条。**默认空 = 插件一步都走不出去。**
  //
  //   2026-09-28 真机实测（pid 26080 / 127.0.0.1:53349）定了三条，缺一不可：
  //   1) `session/new` 的 `cwd` **不生效**——回执无工作区字段，124 条 `session/update`
  //      事件里零回声。⇒ 插件自己 new 的对话工作区是未知的，而工作区是下发的核心诉求。
  //   2) 每个新 ACP connection 的**第 1 次** `session/new` 返回 GUI 当前那条（不是新建），
  //      第 2 次起才真新建（4 次独立复现）。⇒ 走 new 就必然先"取出"用户正在做的那条。
  //   3) `session/new` **会切走 GUI 当前会话**（实测 active 被切到新建那条）。
  //
  //   ⇒ 自己 new 这条路同时踩中"工作区错"和"切用户会话"，直接废掉。
  //     工作区只能由人在桌面端建对话时自己选，然后把那条绑进来。
  //
  //   ★ 本字段**取代**了原先的 `allowInteractiveSidecar` 布尔开关。那个开关粒度太粗：
  //   "放开 interactive 整个类别"挡不住上面 2/3 两条，只能改成"不绑就不发"。
  //     绑了之后插件不再 `session/new`，也就没有机会碰用户正在做的那条。
  //
  //   怎么填：桌面端**新建**一条对话 → 选好工作区 → 保持打开 → 把它的 id 填到这里。
  //   ★ 换工作区就重建一条对话再改这个值；旧对话删不删由人定，插件不管。
  //
  //   ★★★★ 2026-09-28 更正：本字段的定位**正过来了**。当初因为 `session/new` 会切走
  //   GUI 活跃会话（见上面 2/3），写成了"不 new 就只能绑着用户那条"，那是个**绕过方案**。
  //   现在走 `session/load`（服务端 `initialize` 宣告 `loadSession: true`），
  //   实测跨连接载入**不改 sessionId**、**不切 active**、还**顺带回模型清单+权限表**，
  //   所以本字段回到它名字本来的意思：**要续用哪条对话**。
  boundSessionId: z.string().default('').volatile(),
  // ═══ 会话面（★ 2026-09-28 新增）═════════════════════════════════════════════════
  // 上面三个字段管"能不能发出去"；这三个管"发出去时**在什么条件下**发"。
  //
  // ── 任务权限：ACP 会话权限模式 ────────────────────────────────────────────────
  // ★★ 真源是**服务端下发的下拉表**，不是本地常量：`session/load` / `session/new` 期间
  //   服务端通过 `config_option_update` 事件给出一组 `category: "mode"` 的选项，
  //   共 8 个（2026-09-28 真机读全）：
  //   `default`=Always Ask / `acceptEdits` / `plan` / `auto` / `dontAsk` /
  //   `bypassPermissions` / `fullAccess`=Full Access / `delegate`。
  //   设置页必须用**这张表**渲染，不能用本地硬编码——上面的 `permissionMode`（CLI flag）
  //   正好缺 `fullAccess` 和 `delegate`，把那份当权威就会让用户选不到"完全权限"。
  //   '' = 沿用该对话**当前**的权限，不替用户选授权强度（H-NO-FABRICATED-DEFAULT）。
  sessionMode: z.string().default('').volatile(),
  // ── 任务工作区 ────────────────────────────────────────────────────────────────
  // ★★★ 工作区**不是会话属性**。`session/new` / `session/load` 的 `cwd` 被**静默丢弃**，
  //   四种独立方式验证过：裸 Windows 路径、`file:///` URI、以及一个**根本不存在的盘** `Z:/`——
  //   后者同样"成功"，所以不是校验失败，是这个参数根本不参与寻址。回执里也没有任何
  //   结构化字段带工作目录（模型只在正文散文里自述）。
  //   ⇒ 唯一可行路径：把它**随任务文本**送进 `session/prompt`（见 gateway/acp.js
  //     `buildPromptBlocks`），并用硬负控验证过模型确实照着那个目录干活。
  //   ★ 这是**提示不是约束**——没有任何服务端机制把模型钉在该目录，UI 不能说成"已限制"。
  //   '' = 不带工作区（模型用桌面端那条对话自己的目录）。
  workspace: z.string().default('').volatile(),
  // ── 新建对话 ──────────────────────────────────────────────────────────────────
  // ★ true = 这次下发**自己新建**一条对话。默认 false。
  //   新建会**切走桌面端 GUI 的活跃会话**（真机复现 4 次），所以**必须由人显式打开**，
  //   不能默认开启。关着时若 `boundSessionId` 也为空，则**一个 ACP 调用都不发**
  //   （连 connect/initialize 都不做——那两步打在用户正在用的 sidecar 上）。
  createNewConversation: z.boolean().default(false).volatile(),
  // ★ Gateway 的 localhost 口令。**留空 = 自动从桌面端 sidecar 进程的环境里读**（仅 Windows，
  //   走 PEB，src/host/gateway/token.js）。手填只作为自动读失败的兜底。
  //   它不是 WorkBuddy 账号凭据：作用域仅限本机该 sidecar 的一次会话，且**从不落盘、不进 argv**。
  //   ★ 仍然**不该**进任务下发面的 env（见 tools/run.js 的边界注释）；本字段只喂 gateway 鉴权。
  gatewayToken: z.string().default('').volatile(),
  // ── 积分（★ 2026-09-28）─────────────────────────────────────────────────────
  // ★ 这四个字段是**插件写**的，但**必须**是 volatile —— 与上面的 `sessions` 同理。
  //
  //   踩过的坑（2026-09-28 真机把 dsh 打死）：它们原先是非 volatile，而
  //   `launch/live-credits.js` 用 `settings.update(ns, { creditsRemain, creditsAt })` 去落盘。
  //   宿主 `dsh-settings/lib/index.js:513-523` 的 `validatePaths` 只允许改动里出现
  //   **volatile** 路径，遇到非 volatile 键直接 `throw Config field "…" is not volatile`
  //   （:507 是 mutate 的路径预检，同一句话）。**非 volatile 字段在设计上就写不进去。**
  //   即：声明为"非 volatile（用户面不暴露）"与"用 settings 落盘"是自相矛盾的。
  //
  //   volatile 不等于"露在设置页上"——那由各插件的 client 自己决定渲染哪几行
  //   （lib/client.js 一行 credits* 都没画）。它只决定**可编辑性与落盘通道**。
  //
  //   积分余额的本地快照：真值来自 wbipc 只读查询；这里存"上一次成功读到"，
  //   供离线时显示，并附 `creditsAt` 供用户判断新鲜度。
  creditsRemain: z.number().default(0).volatile(),
  creditsAt: z.number().default(0).volatile(),
  // 自锚点起的累计扣减（插件写；仅作参考，**不是**账单 —— 折算已被 315 条样本证伪，见 credit-anchor.js）
  creditsConsumed: z.number().default(0).volatile(),
  creditsRuns: z.number().default(0).volatile(),
  // ★★★ `launch` 里的**旗标表已整体删除**（2026-10-02，删净 CLI 线）★★★
  //   原来这里声明 `--model` / `--effort` / `-p` / `--resume` / `--session-id` /
  //   `--output-format` / `--input-format` / `--permission-mode` 等 13 个 CLI 旗标。
  //   CLI 传输被整体删除后**没有任何代码读它们** —— 而留着它们比删掉更坏：
  //   用户在设置里改一个不存在的旗标名，看不到任何效果，也没有任何报错
  //   （schemastery 对未知键是**静默丢弃**）。一张永远不发出去的表 = 一个永远不生效的承诺。
  //   唯一留下的是 `effortValues`：**它不是旗标**，是"这个平台支持哪几档推理强度"的能力表，
  //   卡片要用它决定哪些档位可选/置灰（与旗标名无关）。
  launch: z.object({ // 与 cordis.patch.yml + §3.6 【两处同步】
    // ★ 档位表是【数据】，不硬编码进 schema：基线在 cordis.patch.yml 的 `launch.effortValues`
    //   （WorkBuddy 6 档，无 `off`；真源是桌面端下发的能力表）。
    //   schema 留 `{}` = "形状正确但本层不提供数据"。
    //   表内**无**该 key = 该平台不支持 ⇒ 该档位不下发（不静默升/降档），UI 置灰。
    effortValues: z.object({}).default({}),
  }).default({}),
});
