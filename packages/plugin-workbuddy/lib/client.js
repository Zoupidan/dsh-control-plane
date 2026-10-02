/**
 * client 端 bundle —— 手写单文件（本仓库无构建器，见 04-docs/RECON-T03-RESULT.md §4 D-1）。
 *
 * Implements: 02-design/DESIGN-v3.md §3.5（client 契约）/ §4.2.1（档位矩阵，不支持档置灰）/
 *             §4.3（未指定 ⇒ 由桌面端自决，UI 必须显式告知）/ §4.4.1（三态 UI）/ §4.4.3（在途作业数）/
 *             §4.5（参数接受度 + rejected ⇒ 回滚显示"未指定"）
 *
 * ★ 2026-10-01：WorkBuddy 的命令行链路已**整体删除**（宿主侧已完成：探测改为桌面端探测、
 *   `cliPath`/`nodePath` 已从配置 schema 移除、`launch/` 下的模型快照模块已删）。本文件随之清干净
 *   全部命令行（command line）残留，数据源收敛为两支：
 *     · `payload.models[]`      展示目录 {id,label,detail,isFree,supportsReasoning}
 *     · `payload.cost.models[]` 倍率目录 {modelId,displayName,factor,freeWindow,source}
 *   ★★ 倍率**只在** `cost.models[].factor`；`models[].factor` 恒为 `null`（模型侧读错字段会
 *      得到"36 条全无倍率"的假结论）。★★
 *   宿主载荷里那份"命令行支持快照"已废弃，本文件不再读它。
 *
 * ★ 2026-10-02（四块布局）：卡片内容区按**四段**组织，而不是等权行堆叠 ——
 *     ① 头（`header`）：标题 + 三态徽标 + 收起态**三值摘要**（当前模型 · 推理强度 · 剩余积分）；
 *     ② 任务（`TaskBlock`）：对话标题 + 回执（人话）+ 在途空态；失败只说人话，编号/证据进详情折叠；
 *     ③ 配置（`dsh-wb-group`）：开关 + 模型（搜索 + 按倍率分组）+ 推理强度（6 档，不含 off）；
 *     ④ 状态（`StatusBlock`）：积分（单位中文化）+ 列表来源 + 诊断折叠。
 *   折叠纪律：`registrationError` / 旗标名（`--model` 之类）/ 退出码 / 本机路径 / 各类 id
 *   **只进折叠**，主视图只留人话。加载态是**单个骨架**（`dsh-wb-skeleton`），写失败走 Toast，
 *   "刷新状态"只重拉状态区（按钮带说明，不碰配置）。
 *
 * 形态依据（全部为本机 dsh 安装体只读实测，逐字）：
 *   - 加载形态 `window.__ModuleLoader__.load({ id, factory })`：官方产物
 *     `@deepseek-ai/dsh-client-ui-deliverables/lib/client.js:1-6`；id 必须 === package.json 的 name
 *     （`dsh-client-modules/lib/client.js:248` 对不上即抛 "bundle ... loaded without registering"；
 *      包名派发见 `dsh-client-modules/lib/index.js:648-663`）。
 *   - factory 返回的 module.exports 即 cordis 插件对象（`{ apply, inject }`）：
 *     composed 路径由 `cordis-plugin-loader/lib/index.js:466`（unwrapExports(import)）装载、
 *     `:709`（Inject.resolve 按声明注入服务）装配；动态包路径另经
 *     `dsh-cordis-client-runner/lib/client.js:594-620` 的 guardedSurface 转发（两条路径均要求对象形态）。
 *   - require 白名单 = 9 个 seed（app bundle 内联表）；本 bundle 只用 `react`。
 *   - 卡片槽 `settings.plugin.item` 的 key = settings namespace：`dsh-client-ui-settings-plugins/lib/client.js:416`；
 *     host 未服务该 namespace ⇒ 卡片永不 dispatch（同文件 :1093-1097）—— host 侧由 0.1.7 隐式发现服务（loader 行 id 即 namespace + 导出 Config，见 src/host/tools/index.js:137-142；旧 installSection 已在 0.1.7 移除）。
 *   - 注册形态 `{ name, key, inject }` + 组件 props 注入：`dsh-client-ui-settings-plugins/lib/client.js:1785-1810`（BashCard 样例）。
 *   - settings 读写 = `ctx.settingsScope.bind({ namespace })` → `{ getSnapshot, subscribe, set, unset, mutate }`：
 *     `dsh-client-ui-settings/lib/client.js:949-1081` + `:1169-1179`；快照字段 {status,value,base,user,revision,writable,mode}。
 *   - `commandUi.register` 形态与 `(session, signal)` 参数序：`dsh-client-ui-model-selection/lib/client.js:919-937`。
 *   - CSS 去重注入模式（tagId + `style[data-plugin-css]` 查询）：`dsh-client-ui-settings-plugins/lib/client.js:378-385`。
 *   - 状态 bridge = 同源 fetch 相对路径（先例 `dsh-client-ui-deliverables/lib/client.js:13-15,136`）。
 *
 * ⚠️ 真机渲染 / slot dispatch / 写入落盘均需受控窗口（W-11），本文件级验收以 test/client.test.js 的
 *    伪宿主（模块加载器 / React hook 运行时 / settingsScope / fetch）断言到注册与浅渲染层。
 *
 * 约束：本文件属于 packages/*​/lib（CI ② 进程出口审计 + C3 扫描范围）——
 *       不得出现任何进程出口字样。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-workbuddy',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    // primitives 为 9 个 seed 模块之一（前端 staticModules 表实测：`@deepseek-ai/dsh-client-ui-primitives`）。
    // 〔2026-10-01 修正〕图标名必须是该包**公开导出表**里的名字。实测 lib/index.js:12381 的 export{} 表只导出
    // IconChevronDownOutline{Medium,Regular}（Artwork 为内部实现），**不存在** IconChevronDownOutline14 ——
    // `14` 是 Artwork 的 size 默认值（lib/index.js:482 `({ size = 14, … })`），不是名字的一部分。
    // 旧代码取 primitives.IconChevronDownOutline14 ⇒ undefined ⇒ h(undefined) 抛错 ⇒ 被宿主
    // SlotErrorBoundary（dsh-client-ui-renderer/lib/client.js:611-625）吞掉并渲染成空的 div[data-slot-error]，
    // 这正是"能看到设置项，但是里面空白"的成因。
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const { createElement: h, useEffect, useState } = React;
    // dsh 自身用法一律是 `jsx(IconChevronDownOutlineRegular, { className })`，从不传 size（默认 14 由 Artwork 兜底）。
    const IconChevronDownOutlineRegular = primitives.IconChevronDownOutlineRegular;

    // ───────────────────────── 常量（与 src/shared/constants.js 同步；bundle 不能 import 它） ─────────────────────────
    const PACKAGE_NAME = 'dsh-plugin-workbuddy';
    const NS = PACKAGE_NAME;

    /**
     * 设置导航栏里的**排序位次**（0.1.7 的 `settings.section` 是 list 注册项，需要 `order`）。
     * 取 20：官方 `plugins` = 15、`general` = 0 ⇒ 本条目排在其后，不与官方条目抢位置。
     */
    const SECTION_ORDER = 20;

    /**
     * 本条目在导航栏里的文案（0.1.7 起 `label` 是 thunk，`t` 靠注册项的 `locale: NS` 选项获得）。
     *
     * ★★ DICT 的两段式约定（2026-10-01 定；新文案必须照此写，不得散落中文字面量）★★
     *   · **顶层键**（`nav` / `credits.*` / `models.*`）→ 走 `ctx.locale.bind(NS)`，
     *     消费方是注册项的 `locale` 选项（典型：`label` thunk）。
     *   · **`detail` 子表** → 卡内文案的**唯一来源**，按宿主契约形状分组（见各 Group 头注）。
     *     这些文案在渲染期被读，而卡片组件拿不到 `t`（`settings.section` 的 renderer 只递
     *     `{ close }`，不注入 locale prop —— 见 `makeConfigCard` 头注）⇒ 组件直接读
     *     `DICT.zh.detail.*`。⭐ **故意只读 `zh`**：本包只有一份中文界面，读 `zh` 是"取当前语言"
     *     而非"忽略 en"；换成读 `en` 会让同一份界面在中英分支下显示两套文案。
     *   · 新增一条文案 = 在 `detail` 里加一个键，然后引用它 —— 不许就地写中文字面量。
     */
    const DICT = {
      zh: {
        nav: 'WorkBuddy',
        detail: {
          /** 卡片标题与描述行（官方卡片同款槽位）。卡片标题 WorkBuddy 保持，插件归属注明 DshAgentHub。 */
          card: {
            // ★ "暴露为模型可见的 dsh 工具"是实现视角的说法（对用户描述的是系统怎么搭的，不是他能做什么）⇒ 说人话。
            desc: 'DshAgentHub 插件 · 在这里选 WorkBuddy 的模型、看剩余积分',
          },
          /** 模型下拉行（含搜索与分组）。 */
          models: {
            // ★ 界面文案纪律（2026-10-02）：**需求代号不得出现在给用户看的字上**。
            //   原来的「模型（U1）」「推理强度（U2）」「启用工具（U4）」里的 U1/U2/U4 是
            //   本仓库的验收编号，对用户零信息量，只是噪音。代号留在代码注释里。
            rowLabel: '模型',
            unsetOption: '未固定（每次用时现选）',
            /** 未固定时模型行上的说明：谁在选 + 没选会怎样（两分支都要说，否则会以为"总会挑一个"）。 */
            // ★ 与上面 `unsetOption` 用词一致（"每次用时现选"）：同一张卡里两处对同一件事
            //   说两种话 = 用户以为它们是两回事。下半句保留"没选会怎样"，那是唯一有用的信息。
            unsetHint: '每次用时重新选；那次也没选，就用桌面端自己的默认。',
            /** 倍率来自 `cost.models[].factor`（实时值）。 */
            factor: (x) => '（x' + x + '）',
            factorUnknown: '（倍率未知）',
            /** 模型搜索框与倍率分组（配置块；分组依据是计费事实，不是目录备注）。 */
            searchPlaceholder: '搜索模型…',
            noMatch: '没有匹配的模型',
            groupFree: '免费模型',
            groupPaid: '按量计费',
            groupUnknown: '倍率未知',
          },
          /** 强度下拉行（6 档：minimal/low/medium/high/xhigh/max，不含 off）。 */
          effort: {
            rowLabel: '推理强度',
            noneOption: '未指定',
            // ★ "映射"是实现词；下拉里那一列印的是"这一档在 WorkBuddy 上叫什么"，说成"对应值"用户才读得懂。
            mappingUnknown: '（对应值未知）',
            unsupported: '（不支持）',
          },
          /** 配置块（开关行 + 块标题 + 回滚提示）。 */
          config: {
            blockTitle: '配置',
            /** §4.5 回滚后的行内提示：只说"发生什么 + 现显示什么"，**不点旗标名**
             *  （旗标名是内部串，只进任务折叠；见 TaskBlock 头注）。 */
            rowRolledBack: '⚠ 该参数曾被拒绝，已按归因回滚显示',
          },
          /** 任务块（对话标题 + 回执 + 在途；失败人话主视图，编号证据进折叠）。 */
          task: {
            blockTitle: '任务',
            titlePrefix: '任务对话：',
            receiptPrefix: '回执：',
            receiptOk: '已收到',
            receiptNone: '暂无',
            retiredYes: '已退役',
            retiredNo: '未退役',
            failPrefix: '失败原因：',
            // ★ 折叠标题不得含内部串：它是主视图的一部分，`--model`/退出码/路径/id 一个都不许出现。
            detailsSummary: '任务详情（排障用，默认收起）',
            exitPrefix: '退出码：',
            acceptPrefix: '参数是否被接受：',
            argvPrefix: '下发参数：',
            modelPrefix: '实际模型：',
            effortPrefix: '推理强度：',
            /** 上次实际用了什么（折叠记账行；调用方先把空值换成"未指定"/"未知"再传进来）。 */
            effortLine: (req, cur) => '请求 ' + req + ' / 实际 ' + cur,
            namedPrefix: '被拒绝的参数：',
            evidencePrefix: '拒绝信息：',
            stderrPrefix: '原始错误输出：',
            sessionPrefix: '会话：',
            automationPrefix: '任务编号：',
          },
          /** 状态区。 */
          status: {
            blockTitle: '状态',
            settingsPrefix: '设置：',
            readonly: ' · 只读，当前页面无法保存',
            routeDown: '状态读取失败：',
            runtimeLoading: '运行状态：读取中…',
            notInstalled: '未检测到 WorkBuddy 桌面端',
            desktopPathPrefix: '桌面端：',
            inFlightSome: (n) => '仍有 ' + n + ' 个任务在运行',
            inFlightNone: '在途任务：无',
            lastRunNone: '最近一次启动：暂无记录',
            reasonPrefix: '失败原因：',
            // ★ "被点名"是归因视角（我们点名了哪个参数），用户视角是"哪个参数被拒了"。
            namedSome: (flags) => '被拒绝的参数：' + flags,
            namedNone: '被拒绝的参数：无',
            sourcePrefix: '模型列表来源：',
            /** 列表来源人话：实时读 vs 上次缓存（端点原串回答不了这个问题，只留在载荷里）。 */
            sourceLive: 'WorkBuddy 桌面端（实时）',
            sourceCache: 'WorkBuddy 桌面端（缓存）',
            /** 探测证据行：只说"找到没找到"，不把内部枚举名（`knownPath` 之类）印给用户。 */
            evidenceFound: '（已找到）',
            evidenceMissing: '（未找到）',
            /** 可继续会话计数（"续接/resume"是接口词，界面说"可继续"）。 */
            sessionsSome: (ok, all) => '可继续的会话 ' + ok + '/' + all + (ok > 0 ? '（点下方「诊断信息」看是哪几条）' : '（记录里的会话都已失效）'),
            sessionsNone: '无（记录里的会话都已失效）',
            /** 会话明细超 6 条时的截断行（明细只进折叠；这里只说条数，不抄 id）。 */
            sessionsMore: (n) => '… 共 ' + n + ' 条',
            // ★ 折叠块的标题。措辞要说人话，且**不承诺**里面有用户需要的东西 ——
            //   它就是排障出口，深排障另有 workbuddy_status。
            //   ★ 标题本身是主视图 ⇒ 不得含内部串（路径/id/退出码/旗标名都不许出现）。
            diagnosticsSummary: '诊断信息（排障用，默认收起）',
            boundPrefix: '绑定会话尾号：',
          },
          /** `payload.credits` —— 「剩余积分」行（五种状态，见 formatCredits）。 */
          credits: {
            label: '剩余积分：',
            loading: '读取中',
            /** 单位中文化：载荷里的 `credits` 是英文复数单位，界面一律说"积分"。 */
            unitZh: '积分',
            unknownUnit: 'credits',
            // ★ 陈旧必须**说出来**（"上次读到的值"不说 = 过期读数被当成实时结论），
            //   但不必写成括号长句：`· 数据陈旧 1分钟` 已经把两件事说全了。
            stale: (age) => ' · 数据陈旧 ' + age,
            // ageMs 不可算时只说"数据陈旧"；旧文案硬拼成"数据陈旧 时长未知"，读起来像半句话。
            staleUnknown: ' · 数据陈旧',
            desktopClosed: 'WorkBuddy 桌面端未运行，暂时读不到积分',
            // ★ 归因码**要**留在这行：它是"可核对、可搜"的机器可读线索，去掉就只剩一句
            //   "读不到"，用户既没法自查也没法反馈。用 `·` 分隔，不套括号。
            unknown: (code) => '暂时读不到积分' + (typeof code === 'string' && code !== '' ? ' · ' + code : ''),
            /** `remain` 为空但 `ok === true` ⇒ 平台没给数，不得写成 0。 */
            noValue: '平台未返回数值',
            /** 陈旧读数的时长单位（人话；只做量级，不精确报时）。 */
            age: {
              second: '秒',
              minute: '分钟',
              hour: '小时',
              day: '天',
            },
          },
          /** 开关行。 */
          toggle: {
            rowLabel: '启用',
            hintNotInstalled: '未检测到 WorkBuddy 桌面端',
          },
          /** 卡片外壳与命令面。 */
          shell: {
            refresh: '刷新状态',
            /** 刷新按钮的悬停说明：明确它只重拉状态，不碰配置。 */
            refreshHint: '重新拉取运行状态（不改配置）',
            collapse: '收起设置',
            expand: '展开设置',
            // ★ 不写宿主服务名（`configForms` / `settingsScope`）：用户查不到这个符号，只会以为是坏了。
            scopeMissing: 'WorkBuddy：设置服务不可用。',
            /** 加载骨架：载荷未到达时的**唯一**占位（各行不再各自报"读取中"）。 */
            skeleton: '加载中…',
            /** 写失败 Toast：`scope.set` 被拒时如实说出来，不静默吞掉。 */
            toastPrefix: '保存失败：',
            toastDismiss: '关闭',
            /** 命令面的描述行（斜杠菜单里可见）与写不进去时的报错。 */
            commandDesc: '切换 WorkBuddy 模型',
            writeBlocked: '当前页面无法保存设置',
            /** 枚举值不认识时的统一兜底（宁可说"未知"，也不把机器标识符印给用户，见 enumText）。 */
            unknownText: '未知',
            /** 命令哨兵行（未固定）的 label 与 detail。 */
            commandUnsetLabel: '未固定（每次用时现选）',
            commandUnsetDetail: '每次用时重新选；那次也没选，就用桌面端自己的默认。',
          },
        },
      },
      en: { nav: 'WorkBuddy' },
    };

    /**
     * 卡内文案的取用点：`L.<group>.<key>`。
     * 只读 `zh` 子表（理由见 DICT 头注）—— 缺段时退化成空对象而不是抛错，
     * 免得一条漏写的文案把整张卡渲染成空白（2026-10-01 空白事故的教训）。
     */
    const L = DICT.zh.detail;

    /**
     * 枚举 → 界面文案时的**兜底**。
     *
     * ★ 旧写法是 `TABLE[value] ?? String(value)`：宿主一旦新增一个枚举值（老插件对新宿主、
     *   或枚举被改名），卡片上就会直接冒出 `PARTIAL_REGISTRATION` 这种机器标识符 ——
     *   用户既看不懂也没法据此判断"到底开没开"。未知就老老实实说"未知"：
     *   少一个可读的分类，比多一个看不懂的分类好；真值在载荷里，需要排查的人去看日志。
     * @param {Record<string, string>} table
     * @param {unknown} value
     * @param {string} fallback
     */
    function enumText(table, value, fallback) {
      return Object.hasOwn(table, value) ? table[value] : fallback;
    }

    /** 状态 bridge 路由（§3.4.1 之 ⑤；host 侧由 T02 的 makeStatusRoute 注册）。 */
    const ROUTE_STATUS = '/plugin-workbuddy/status';

    /**
     * canonical 7 档（§4.2.1 矩阵左列；不支持档由 values 表缺 key 表达 —— 不发明映射）。
     * ★ 这是**退路**，不是首选：正常路径用宿主 payload 的 `effort.canonical`（唯一构造点
     * `src/host/routes/status/get.js:82-90`），只有 payload 缺该字段（旧宿主 / 路由不可达）时
     * 才回落到本表。两份都在是历史遗留：宿主加了新档位而这里没跟上，就会漏渲染那个档位。
     */
    const EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

    /**
     * 界面实际渲染的档位（6 档）。
     *
     * ★ `off` 不是"可下发的强度"：桌面端能力表（`cordis.patch.yml` 的 `launch.effortValues`）
     *   只有 minimal…max 六档，`off` 恒无映射（旧界面把它渲染成置灰项，用户点不了还占一行）。
     *   宿主 canonical 里纵然带着 `off`（"合法取值集合"，含它只是为了与 7 档常量同构），
     *   界面也**不渲染**它 —— 藏起一个永远点不了的选项，不是隐瞒，是减噪。
     *   本表只在宿主 canonical 缺席时兜底；宿主给了 canonical ⇒ 过滤掉 off 后照单渲染。
     */
    const EFFORT_UI_LEVELS = EFFORT_LEVELS.filter((level) => level !== 'off');

    /** ① 工具注册态 → 三态 UI（§4.4.1）；DEGRADED 也如实显示（不静默）。 */
    const REGISTRY_TEXT = {
      REGISTERED: '● 开启',
      UNREGISTERED: '○ 已关闭',
      NOT_INSTALLED: '○ 未安装',
      UNKNOWN: '… 检测中',
      // ★ "环境降级"是内部判定结论；用户只需要知道"能用，但少了点什么"。
      DEGRADED: '⚠ 开启（功能受限）',
    };

    /** settings 快照状态文案（settingsScope 快照的 status 字段）。 */
    const SETTINGS_TEXT = {
      loading: '读取中…',
      ready: '已就绪',
      // ★ 原文写着"Host 未服务该 namespace"——那是宿主服务名与命名空间，用户既查不到也不知道该做什么。
      unavailable: '不可用（设置服务未连接）',
    };

    /**
     * 参数接受度文案（§4.5；"被接受"可证、"被尊重"不可证 —— 措辞不得超承诺）。
     *
     * ★ `rejected` 的旧文案"（非 0 且 stderr 提及该参数）"是**假信息**，2026-09-19 真机证伪：
     *   `--model <非法>` 时 **exit code = 0**，且证据根本不在 stderr（stderr 只有 Node 的 UNDICI 警告），
     *   而在 stream-json 的 assistant 帧文本与 `result.errors[]` 里。
     *   判据是"输出里出现被拒证据"，与退出码无关 ⇒ 文案不得把退出码/stderr 写进判据描述。
     *
     * ★ 2026-10-02：接受度行**只进任务折叠**（它与退出码/证据是同一组排障信息）。
     *   主视图的失败只说人话（`task.failPrefix + reasonText`），判据细节在折叠里。
     */
    const ACCEPT_TEXT = {
      // ★ 只给结论，不给判据。判据（"进程退出码 0 且输出无被拒证据"）是**我们的推理过程**，
      //   印在卡片上既让用户去查"退出码"是什么，也让文案随判据改动而漂 ⇒ 留在注释里。
      //   真正的原始输出由下面"拒绝信息/原始错误输出"两行原样给出，需要核对的人去那里看。
      accepted: '已接受',
      rejected: '未被接受',
      unknown: '未知',
    };

    /**
     * 配置行 ← flag **来源**（host `flags[].source`，由 argv.js 落点）。
     * 刻意不硬编码 flag 拼写：旗标名来自配置（`launch.modelFlag` 可被改成 `-m` / `--reasoning-effort`），
     * 客户端只认来源，由 host 的逐 flag 归因决定**哪一行**被拒（B-T04-4 的反例史：
     * 归因丢 source ⇒ 只能整体回滚两行 ⇒ 没被拒的那行显示成"未指定" = 假状态）。
     */
    // ★ 2026-09-22 P2：每行 = 可能写该行的**全部**来源（设置面 `config.*` + 逐次覆盖面 `call.*`——
    //   argv.js:311/319 对 call.* 如实标注）。只认 config.* 时 call.* 的被拒旗标落不到任何行
    //   ⇒ mapped=0 ⇒ attributed=false ⇒ 退回保守整体回滚：没被拒的那行显示成"未指定" = 假状态。
    const ROW_SOURCES = Object.freeze({
      model: ['config.model', 'call.model'],
      effort: ['config.effort', 'call.effort'],
    });

    /**
     * 逐 flag 接受度归因（§4.5）。
     * - `attributed=true`：只回滚**被点名**的那一行；没被点名的行显示真实值（不做有罪推定）；
     * - `attributed=false`：被拒但证据未点名任何参数（或记录里没有 flags 字段，或点名了但来源不可映射）
     *   ⇒ **保守**两行都回滚。
     *
     * ★ `attributed` 必须定义成"**至少一个被点名的 flag 真的落到了某一行**"，不能只数"被点名个数"：
     *   点名了 flag 但 `source` 缺失/未知时，行级不会发生任何回滚；若此时仍宣称 attributed=true，
     *   状态区会写"被点名参数：--model"，而两行照旧显示请求值 —— 自相矛盾，且比保守回滚更不安全。
     *
     * ★ 2026-10-02 补充：归因结论的**旗标名**只进任务折叠（`namedSome` 行在折叠里）。
     *   主视图的配置行只挂一句不带名的提示（`L.config.rowRolledBack`），点名细节去折叠里核对。
     * @param {object|null} lastRun
     */
    function attributeRows(lastRun) {
      const rejectedRun = !!(lastRun && lastRun.flagVerdict === 'rejected');
      const rawFlags = rejectedRun ? lastRun.flags : null;
      // ★ 桌面端通路（automation）写 `flags: {}`（对象，不是数组）—— "某个旗标被拒"这件事
      //   只存在于 CLI 的 stderr 里，两条桌面端通路都不产它。非数组 ⇒ 无归因 ⇒ 谁都不许动。
      const list = Array.isArray(rawFlags) ? rawFlags : [];
      const named = list.filter(
        (f) => f && f.verdict === 'rejected' && typeof f.flag === 'string' && f.flag !== '',
      );
      const rows = {};
      let mapped = 0;
      for (const row of Object.keys(ROW_SOURCES)) {
        const hit = named.find((f) => ROW_SOURCES[row].includes(f.source)) ?? null;
        rows[row] = hit;
        if (hit !== null) mapped += 1;
      }
      return { rejectedRun, attributed: mapped > 0, named, rows };
    }

    /** 卡片描述行（官方 PluginCard 的 description 槽位同款；文案取自字典）。 */
    const CARD_DESC = L.card.desc;

    // ───────────────────────── CSS（去重注入；iOS 克制风 · token 化） ─────────────────────────
    // 基线 = 官方 PluginCard 布局（`YyYd_a_*`），在此之上按 iOS 克制原则收敛：
    //   · 更浅的 12px 圆角描边（浅色主题下 bg-layer-3 与页面同白——卡片感只能来自边框，实测）
    //   · 控件去边框化（灰底 pill select / iOS 式开关）· 文字按钮（品牌色，无边框）
    //   · 层级靠字号/字色（15/600 · 13 · 12 tertiary）与留白，不靠装饰与重色
    // 颜色全部走 dsh token（--dsw-alias-*）——深色主题自动跟随，不硬编码主题色。
    //
    // ★★ 2026-10-02 信息层次改造（纯样式/结构，文案一字未动）★★
    //   用户的三个真问题各有各的"看得见"方式，所以版式改成**四段节奏**而不是等权行堆叠：
    //     ① `.dsh-wb-task`    任务块 —— 对话标题 + 回执 + 在途，失败人话主视图、编号证据进折叠；
    //     ② `.dsh-wb-group`   配置组 —— 启用/模型/推理强度，等距栅格，一眼扫完；
    //     ③ `.dsh-wb-card__status` 诊断区 —— 积分（独立成块、全卡唯一大字）+ 来源 + 诊断折叠；
    //     ④ `.dsh-wb-card__actions` 操作区 —— "刷新状态"只作用于状态，就放在状态下面。
    //   收起态则退成**一行**：名称在左、三值摘要（模型 · 强度 · 积分）在右。
    //
    // ★ 两个真实缺陷（token 名写错 ⇒ 一直走 fallback，深浅色主题下颜色不受控）：
    //   ① `--dsw-alias-state-warning-primary` **不存在**（真名 `--dsw-alias-state-warn-primary`，
    //      见本机 app.asar token 表）⇒ `.dsh-wb-warn` / `--degraded` 徽标一直在用硬编码 `#c98a00`。
    //   ② 开关拇指硬编码 `#fff`；宿主有 `--dsw-alias-switch-thumb`（浅色=白 / 深色=中性蓝灰 400）。
    const CARD_CSS =
      '.dsh-wb-card{list-style:none;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;transition:border-color .16s,background .16s}' +
      '.dsh-wb-card:hover{border-color:var(--dsw-alias-label-dimmed)}' +
      '.dsh-wb-card--open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}' +
      '.dsh-wb-card__head{display:flex;align-items:center}' +
      '.dsh-wb-card__toggle{appearance:none;flex:1;min-width:0;display:flex;align-items:center;gap:12px;background:0 0;border:0;border-radius:10px;padding:12px 14px;font:inherit;color:inherit;text-align:left;cursor:pointer}' +
      '.dsh-wb-card__toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}' +
      '.dsh-wb-card__toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}' +
      '.dsh-wb-card__head-text{flex-direction:column;flex:1;gap:3px;min-width:0;display:flex}' +
      '.dsh-wb-card__title-row{display:flex;align-items:center;gap:8px;min-width:0}' +
      '.dsh-wb-card__title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}' +
      // 收起态三值摘要：三个值靠右横排（margin-left:auto），与名称同排 ⇒ 整颗头只有一行。
      // 值之间用 `· ` 分隔（CSS 伪元素，不占文案字典 —— 它是排版，不是措辞）。
      // 不加"当前模型："这类标签文案 —— 设置列表惯例里右值自带语义，加标签反而多一份要维护的字。
      '.dsh-wb-card__summary{margin-left:auto;flex:0 1 auto;min-width:0;display:flex;align-items:baseline;gap:0;overflow:hidden;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.4}' +
      '.dsh-wb-card__summary-item{flex:none;max-width:12em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.dsh-wb-card__summary-item+.dsh-wb-card__summary-item::before{content:"·";margin:0 6px;color:var(--dsw-alias-label-tertiary)}' +
      // 兼容旧单值摘要类名（测试与旧样式按它查找；新结构里不再使用，保留选择器无害）。
      '.dsh-wb-card__value{margin-left:auto;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.4}' +
      '.dsh-wb-card__desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.45}' +
      '.dsh-wb-card__chevron{color:var(--dsw-alias-label-tertiary);flex:none;display:flex;transition:transform .16s}' +
      '.dsh-wb-card__chevron--open{transform:rotate(180deg)}' +
      // 内容区：14px 段距把四段分开（原先 12px 均匀铺开 ⇒ 读起来是一坨等权信息）。
      '.dsh-wb-card__body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 14px;padding:14px 0;display:flex;flex-direction:column;gap:14px}' +
      // 块标题：12px tertiary，三个正文块各一个（任务/配置/状态），只做"分段"不抢视觉重量。
      '.dsh-wb-block-title{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:500;line-height:1.5}' +
      '.dsh-wb-task{display:flex;flex-direction:column;gap:5px}' +
      '.dsh-wb-group{display:flex;flex-direction:column;gap:10px}' +
      '.dsh-wb-card__actions{display:flex;justify-content:flex-end}' +
      '.dsh-wb-card__refresh{appearance:none;border:0;background:0 0;font:inherit;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-state-business-primary);cursor:pointer;padding:4px 8px;border-radius:6px;transition:background-color .15s}' +
      '.dsh-wb-card__refresh:hover{background:var(--dsw-alias-interactive-bg-hover)}' +
      '.dsh-wb-card__refresh:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}' +
      // 加载骨架：载荷未到达时的**唯一**占位（一行 tertiary，不伪装成任何具体内容）。
      '.dsh-wb-skeleton{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}' +
      // 写失败 Toast：警告级底纹 + 警告字色，点按关闭（role=alert，无障碍树可达）。
      '.dsh-wb-toast{display:flex;align-items:center;gap:8px;border-radius:8px;padding:8px 10px;background:var(--dsw-alias-fill-tertiary,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-state-warn-primary);font-size:13px;line-height:1.5;cursor:pointer}' +
      // 徽标做成低对比小胶囊：够看清三态即可，不与标题（15/600）抢视觉重量。
      '.dsh-wb-badge{flex:none;padding:1px 8px;border-radius:999px;white-space:nowrap;background:var(--dsw-alias-fill-tertiary,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}' +
      '.dsh-wb-badge--registered{color:var(--dsw-alias-state-business-primary)}' +
      '.dsh-wb-badge--degraded{color:var(--dsw-alias-state-warn-primary)}' +
      // 配置行改栅格：标签列定宽 5.5em ⇒ 三行的控件左边缘对齐（原先 flex+min-width:9em 会因标签
      // 长度不同而错位）。提示/警告换行独占整行（grid-column:1/-1），不再挤在控件右边。
      '.dsh-wb-row{display:grid;grid-template-columns:5.5em minmax(0,1fr);align-items:center;column-gap:12px;row-gap:3px;font-size:13px;line-height:1.5}' +
      '.dsh-wb-row__label{color:var(--dsw-alias-label-secondary)}' +
      '.dsh-wb-row__hint{grid-column:1/-1;color:var(--dsw-alias-label-tertiary);font-size:12px}' +
      '.dsh-wb-row>.dsh-wb-warn{grid-column:1/-1}' +
      // iOS 式开关：appearance:none + track/thumb 伪元素（仍然是一个 checkbox input —— 测试与真机语义不变）
      '.dsh-wb-switch{appearance:none;-webkit-appearance:none;justify-self:end;flex:none;width:36px;height:22px;margin:0;border-radius:11px;background:var(--dsw-alias-border-l4);position:relative;cursor:pointer;transition:background-color .2s ease}' +
      '.dsh-wb-switch::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-switch-thumb,#fff);box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .2s ease}' +
      '.dsh-wb-switch:checked{background:var(--dsw-alias-state-business-primary)}' +
      '.dsh-wb-switch:checked::after{transform:translateX(14px)}' +
      '.dsh-wb-switch:disabled{opacity:.38;cursor:default}' +
      '.dsh-wb-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}' +
      // 控件去边框化：灰底 pill（iOS 表单控件观感）。
      // `width:100%` 让「标签 · 备注（倍率）」整条不被截断（原先 min-width:16em 会截）；
      // `max-width:30em` 兜住宽设置面板 —— 铺满一整行反而像一张没排版的表。
      '.dsh-wb-select{font:inherit;font-size:13px;width:100%;min-width:0;max-width:30em;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-border-l1,rgba(0,0,0,.04));border:0;border-radius:8px;padding:5px 10px}' +
      // 模型搜索框与下拉同款灰底 pill，独占一行（栅格换行），筛选只影响分组内的候选。
      '.dsh-wb-search{font:inherit;font-size:13px;width:100%;min-width:0;max-width:30em;grid-column:1/-1;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-border-l1,rgba(0,0,0,.04));border:0;border-radius:8px;padding:5px 10px}' +
      // 倍率对比：原生 <select> 的 option 无法逐项排版，能做的是让数字**列对齐**（等宽数字）
      // 并给每项留出行高 —— 十几条倍率竖着扫时，这是唯一能让"x0.06 / x0.16"不靠逐行辨读的杠杆。
      '.dsh-wb-select,.dsh-wb-select option{font-variant-numeric:tabular-nums;font-feature-settings:"tnum"}' +
      '.dsh-wb-select option{padding:5px 8px}' +
      '.dsh-wb-warn{color:var(--dsw-alias-state-warn-primary)}' +
      // ① 余额块：全卡唯一的大字。三种语气分得很清（这是**排版**决定，不是措辞决定）：
      //   --value  实时读到数 → 突出；--stale 读到的是旧数 → 同样突出但降一档字色（别把过期读数喊成实时结论）；
      //   --note   读不到/无值 → 回落到 12px tertiary，与诊断区同级（"读不到"不是新闻，不该占大字位）。
      '.dsh-wb-credits{padding:2px 0 1px}' +
      '.dsh-wb-credits--value{font-size:15px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary)}' +
      '.dsh-wb-credits--stale{font-size:15px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-secondary)}' +
      '.dsh-wb-credits--note{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}' +
      // ③ 诊断区：顶部细线 + 全 tertiary，比配置组明确低一档（不是靠缩字号到看不清，只是降权）。
      '.dsh-wb-card__status{display:flex;flex-direction:column;gap:5px;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:12px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}' +
      '.dsh-wb-status__mono{font-family:ui-monospace,Consolas,monospace;font-size:12px;word-break:break-all}' +
      '.dsh-wb-evidence{margin:0;padding-left:18px;font-size:12px}' +
      // 诊断折叠块：默认收起。summary 给手型光标与弱化色，让"这里可以展开"这件事
      // 一眼可见，但不与上面的真实状态抢注意力。任务详情折叠复用同一套。
      '.dsh-wb-diag{margin-top:6px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));padding-top:4px}' +
      '.dsh-wb-diag__summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-tertiary);list-style:none}' +
      '.dsh-wb-diag__summary::-webkit-details-marker{display:none}' +
      '.dsh-wb-diag__summary::before{content:"▸ ";color:var(--dsw-alias-label-tertiary)}' +
      '.dsh-wb-diag[open]>.dsh-wb-diag__summary::before{content:"▾ "}' +
      '.dsh-wb-diag__body{padding-top:2px}';

    const CSS_TAG_ID = PACKAGE_NAME + '/ConfigCard.css';
    if (
      typeof document !== 'undefined' &&
      document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') === null
    ) {
      const tag = document.createElement('style');
      tag.dataset.plugin = PACKAGE_NAME;
      tag.dataset.pluginCss = CSS_TAG_ID;
      tag.textContent = CARD_CSS;
      document.head.appendChild(tag);
    }

    // ───────────────────────── 状态 bridge ─────────────────────────

    /**
     * 读状态路由（同源相对路径；非 2xx 抛错 —— 不把失败当数据）。
     * @param {AbortSignal} [signal]
     */
    async function fetchStatus(signal) {
      const response = await fetch(ROUTE_STATUS, { signal });
      if (!response.ok) throw new Error('status HTTP ' + String(response.status));
      return await response.json();
    }

    function errorText(error) {
      return error instanceof Error ? error.message : String(error);
    }

    // ───────────────────────── 组件（§10 T03 文件表的 5 个组件，合并于本单文件） ─────────────────────────

    /**
     * 折叠 chevron（收纳指示；open 时旋转 180°）。
     * 折叠为生态惯例而非宿主契约：宿主 `settings.plugin.item` dispatch 不做包裹
     * （ui-settings-plugins:416 `renderSlot(...)` 直渲注册组件），每个卡片自实现——
     * 官方 PluginCard 的 `.YyYd_a_chevronOpen{transform:rotate(180deg)}` 同款。
     * 图标用 primitives 公开导出的 `IconChevronDownOutlineRegular`，按 dsh 自身用法只传 `{}`
     * （尺寸默认 14 由 `IconChevronDownOutlineArtwork` 的 `size = 14` 兜底；**不存在** `…14` 这个名字）。
     */
    function Chevron(props) {
      return h(
        'span',
        { className: 'dsh-wb-card__chevron' + (props.open ? ' dsh-wb-card__chevron--open' : '') },
        h(IconChevronDownOutlineRegular, {}),
      );
    }

    /** ① 三态徽标（§4.4.1）。 */
    function StatusBadge(props) {
      const registry = typeof props.registry === 'string' ? props.registry : 'UNKNOWN';
      const slug = registry.toLowerCase().replace(/_/g, '-');
      return h('span', { className: 'dsh-wb-badge dsh-wb-badge--' + slug }, enumText(REGISTRY_TEXT, registry, L.shell.unknownText));
    }

    /** ② 开关行（U4）。 */
    function SwitchRow(props) {
      return h('label', { className: 'dsh-wb-row dsh-wb-row--switch' }, [
        h('span', { className: 'dsh-wb-row__label', key: 'label' }, props.label),
        h('input', {
          key: 'input',
          type: 'checkbox',
          className: 'dsh-wb-switch',
          checked: props.checked === true,
          disabled: props.disabled === true,
          onChange: props.onChange,
        }),
        props.hint ? h('span', { className: 'dsh-wb-row__hint', key: 'hint' }, props.hint) : null,
      ]);
    }

    /**
     * 倍率目录索引：`cost.models[]` → `Map<modelId, factor>`。
     *
     * ★★ 为什么必须单独建这张表（不是可选优化，是缺陷防线）★★
     *   倍率**只在** `payload.cost.models[].factor`；`payload.models[].factor` **恒为 `null`**
     *   （展示目录里根本没有这个字段，是两支平行数组）。在模型目录上读 `factor` 会得到
     *   "36 条全无倍率"的**假事实**，进而把整张下拉框标成"倍率未知"。
     *   ⇒ 单一来源：倍率一律经本函数解析，别处不得再 `m.factor`。
     *
     * 三态在这里就地成形（U9：未知不得被压成 0，也不得被压成"不存在"）：
     *   · 命中且 `factor` 是有限数 → 返回该数（含 0：`x0.00` = 平台赠送，**不是**"没有"）；
     *   · 未命中 / `factor` 非有限数（`null` / `undefined` / 字符串 / `NaN`）→ 返回 `null` = 倍率未知。
     *
     * @param {Array<{modelId?: string, factor?: number|null}>|null|undefined} costModels
     * @returns {Map<string, number>}
     */
    function buildFactorIndex(costModels) {
      const index = new Map();
      for (const c of Array.isArray(costModels) ? costModels : []) {
        const id = c && typeof c.modelId === 'string' ? c.modelId : '';
        if (id === '') continue;
        const factor = c.factor;
        if (typeof factor !== 'number' || !Number.isFinite(factor)) continue;
        index.set(id, factor);
      }
      return index;
    }

    /**
     * 模型行在 option 文本里怎么显示倍率。
     *
     * ⚠️ `factor === 0` 走有值分支（印 `（x0 credits）`）—— 0 是"平台赠送"这个**已知事实**，
     *   不是"未知"；把它和 `null` 合并会让免费模型看起来像数据缺失。
     * @param {number|null} factor
     */
    function factorText(factor) {
      if (typeof factor !== 'number' || !Number.isFinite(factor)) return L.models.factorUnknown;
      return L.models.factor(String(factor));
    }

    /**
     * 一条候选在界面上怎么写：`标签 · 目录备注`。
     *
     * ★ 旧写法把目录备注塞进括号（`Model Two（10x）（倍率未知）`）—— 一个下拉项里两层括号，
     *   括号已经从"补充说明"退化成噪音。备注改用 ` · ` 分隔，括号只留给**倍率**那一项
     *   （倍率是有语义的标注："这一条按多少倍计费"，读者要能一眼区分它和备注）。
     *
     * ★ 命令面与卡片下拉**必须**共用本函数：两侧分叉过一次就会变成两件不同的事。
     * @param {{label?: string, detail?: string}} row
     */
    function modelOptionLabel(row) {
      const label = String(row.label);
      return row.detail ? label + ' · ' + String(row.detail) : label;
    }

    /**
     * `payload.models[].detail` 是不是"倍率的回声"（即它自己就是在说倍率）。
     *
     * ★★ 为什么必须剔掉它（2026-10-01，实测缺陷）★★
     *   真 payload 的 `detail` 长这样：`"x2.00 credits"` / `"x0.16 credits"` —— 它就是倍率文本，
     *   只不过来自展示目录（格式化过、位数固定两位）。
     *   而倍率的**权威来源**是 `payload.cost.models[].factor`（本文件 `buildFactorIndex`）。
     *   两者叠加 ⇒ option 文本变成 `Default（x2.00 credits）（x2 credits）`，
     *   同一件事说了两遍，且两遍的**数字写法还不一样**（`2.00` vs `2`）—— 读者会以为是两个不同的数。
     *   ⇒ 判据：`detail` 命中"整串就是一个倍率"的形状时视为回声，**丢弃它**，只印权威倍率那一份。
     *
     * ⚠️ 只匹配"整串即倍率"，不匹配"含倍率"：像 `10x`（夹具里的目录 detail，见 test/client.test.js:1397）
     *   这种**不是**回声 —— 它携带的是别处拿不到的信息，必须保留。误杀它会让目录信息静默消失。
     */
    function isFactorEcho(detail) {
      return typeof detail === 'string' && /^\s*x\s*[0-9]+(?:\.[0-9]+)?\s*credits\s*$/i.test(detail);
    }

    /**
     * 功能①（模型候选合成）：把**展示目录**（`payload.models`）与**倍率目录**（`payload.cost.models`）
     * 合成为下拉候选。
     *
     * ★★ 2026-10-01 改判（本条是缺陷修复，不是措辞调整）★★
     *   旧实现读 `payload.cliModels`（命令行支持快照）做标注，并**丢弃**所有
     *   `isFree == null` 的目录项（那时命令行是数据源）。命令行这条线整体删除后：
     *     · `cliModels` 已废弃 ⇒ 不再读它，"未列/已列"标注随之删除；
     *     · 桌面端目录有 36 条，旧过滤会把无倍率的那批整片隐藏 ⇒ **下拉框丢条目**。
     *   ⇒ 铁律改为两条：
     *     ① **目录有多少条就展示多少条**（`seen` 只去重用，不做任何倍率门禁）；
     *     ② 倍率按 `modelId` 从 `cost.models` 对齐：有则印 `（x… credits）`，
     *        无则印 `（倍率未知）` —— 未知**不得**压成 0、**不得**隐藏、**不得**假装成免费。
     *   旧实现那句"`isFree:null` 是第三态，删了就无处可查"的顾虑由 `（倍率未知）` 承接：
     *   未知照样上屏，只是换了判据来源（`factor` 而非 `isFree`）。
     *
     * @param {Array<{id?: string, label?: string, detail?: string}>|null|undefined} models `payload.models`
     * @param {Array<{modelId?: string, factor?: number|null}>|null|undefined} costModels `payload.cost.models`
     */
    function buildModelOptions(models, costModels) {
      const factorIndex = buildFactorIndex(costModels);
      const seen = new Set();
      const rows = [];
      for (const m of Array.isArray(models) ? models : []) {
        const id = m && typeof m.id === 'string' ? m.id : '';
        if (id === '' || seen.has(id)) continue;
        // ★ 这里**没有** `continue`：任何目录项都必须变成一行。
        seen.add(id);
        const factor = factorIndex.has(id) ? factorIndex.get(id) : null;
        rows.push({
          id,
          label: typeof m.label === 'string' && m.label !== '' ? m.label : id,
          // ★ 倍率回声剔除：`detail` 自己就在说倍率时留空，让权威倍率那一份独占该信息
          //   （否则真 payload 会印成 `Default（x2.00 credits）（x2 credits）` —— 同一件事说两遍）。
          detail: typeof m.detail === 'string' && !isFactorEcho(m.detail) ? m.detail : '',
          factor,
        });
      }
      return { rows, total: rows.length };
    }

    /**
     * 候选按**计费事实**分组（模型下拉的 `<optgroup>` 依据）。
     *
     * ★ 分组只认 `factor`（与倍率同一来源 `buildFactorIndex` 的产出），不认目录备注：
     *   备注是展示字符串，哪天改个写法分组就漂；`factor` 是数值事实。
     *   · `0`（平台赠送）→ 免费；有限数 → 按量；`null`（未知）→ 单独一组，不与免费合并。
     * @param {number|null} factor
     */
    function factorGroup(factor) {
      if (typeof factor !== 'number' || !Number.isFinite(factor)) return 'unknown';
      return factor === 0 ? 'free' : 'paid';
    }

    /** 分组 key → `<optgroup>` 标签（顺序即渲染顺序：免费 → 按量 → 未知）。 */
    const MODEL_GROUPS = [
      { key: 'free', label: L.models.groupFree },
      { key: 'paid', label: L.models.groupPaid },
      { key: 'unknown', label: L.models.groupUnknown },
    ];

    /**
     * 空值（未固定）这一行**真实**发生了什么（★ 模型面真实化，2026-09-21）。
     *
     * 旧标签只写「（DSH模型决定）」，但全链路没有任何机制让"DSH 的模型"去决定（既无候选清单，也无
     *   "该你选"的指令）⇒ 标签替平台许了一个没兑现的状态（ISSUE §5-1）。现在机制到位（候选在
     *   `workbuddy_run` 的 model 参数描述里 + 系统提示在 model 为空时点名"没人替你选 ⇒ 该你选"），
     *   标签才第一次说得出话；这里再把**第二层**补上：调用方那一次也没传 ⇒ 连"选"这个动作都没发生，
     *   于是不下发参数，由桌面端用自身默认。两分支都写，是因为只写第一半仍会让人以为"总会挑一个"。
     *
     * ★ 文案本体在 `L.models.unsetHint`（DICT 才是卡内文案的唯一来源）——这里只留"为什么这么写"。
     */
    const MODEL_UNSET_HINT = L.models.unsetHint;

    /**
     * ③ 模型行（U1）：搜索框 + 按倍率分组的下拉。
     *
     * ★ 为什么要搜索：桌面端目录 30+ 条，原生下拉只能靠滚；搜索按 label/id 子串过滤，
     *   分组（免费/按量/未知）保持可见 —— 过滤掉的是行，不是组（空组直接不渲染）。
     * ★ 哨兵行（未固定）恒在最前，不参与分组与过滤：它是"不选"这个决定，不是候选项。
     */
    function ModelRow(props) {
      const options = Array.isArray(props.options) ? props.options : [];
      const query = typeof props.query === 'string' ? props.query.trim().toLowerCase() : '';
      const hint = props.value === '' ? MODEL_UNSET_HINT : props.hint;
      const visible = query === ''
        ? options
        : options.filter(
          (m) => String(m.label).toLowerCase().includes(query) || String(m.id).toLowerCase().includes(query),
        );
      const groups = MODEL_GROUPS.map((g) => ({
        label: g.label,
        rows: visible.filter((m) => factorGroup(m.factor) === g.key),
      })).filter((g) => g.rows.length > 0);
      return h('div', { className: 'dsh-wb-row dsh-wb-row--model' }, [
        h('label', { className: 'dsh-wb-row__label', key: 'label', htmlFor: 'dsh-wb-model' }, L.models.rowLabel),
        h('input', {
          key: 'search',
          type: 'search',
          className: 'dsh-wb-search',
          placeholder: L.models.searchPlaceholder,
          value: typeof props.query === 'string' ? props.query : '',
          disabled: props.disabled === true,
          onChange: (event) => props.onQuery(event.target.value),
        }),
        h(
          'select',
          {
            key: 'select',
            id: 'dsh-wb-model',
            className: 'dsh-wb-select',
            value: props.value,
            disabled: props.disabled === true,
            onChange: (event) => props.onChange(event.target.value),
          },
          [
            h('option', { key: '__none', value: '' }, L.models.unsetOption),
            ...groups.map((g) =>
              h(
                'optgroup',
                { key: g.label, label: g.label },
                g.rows.map((m) => {
                  // `m.detail` 已在 buildModelOptions 里剔掉"倍率回声"（它自己就是在说倍率的那种）。
                  // 残余的 detail 是**另一件事**（如 `10x`），用 ` · ` 并入，不套括号。
                  return h('option', { key: m.id, value: m.id }, modelOptionLabel(m) + factorText(m.factor));
                }),
              ),
            ),
          ],
        ),
        props.warn ? h('span', { className: 'dsh-wb-warn', key: 'rejected' }, props.warn) : null,
        hint ? h('span', { className: 'dsh-wb-row__hint', key: 'hint' }, hint) : null,
        visible.length === 0
          ? h('span', { className: 'dsh-wb-row__hint', key: 'nomatch' }, L.models.noMatch)
          : null,
      ]);
    }

    /**
     * ④ 强度行（U2；不支持档置灰 —— §4.2.1 规则"不静默升档/降档"）。
     *
     * ★ `props.levels` 已由调用方过滤到 6 档（`off` 不进界面，见 EFFORT_UI_LEVELS 头注）。
     *   这里只管"给定的档在能力表里有没有映射"：有 ⇒ 可选并印映射值；无（且表已知）⇒ 置灰；
     *   表未知（空表/非对象）⇒ 如实说"对应值未知"，不置灰、不谎报不支持。
     */
    function EffortRow(props) {
      const values = props.values && typeof props.values === 'object' ? props.values : {};
      return h('div', { className: 'dsh-wb-row dsh-wb-row--effort' }, [
        h('label', { className: 'dsh-wb-row__label', key: 'label', htmlFor: 'dsh-wb-effort' }, L.effort.rowLabel),
        h(
          'select',
          {
            key: 'select',
            id: 'dsh-wb-effort',
            className: 'dsh-wb-select',
            value: props.value,
            disabled: props.disabled === true,
            onChange: (event) => props.onChange(event.target.value),
          },
          [
            h('option', { key: '__none', value: '' }, L.effort.noneOption),
            ...props.levels.map((level) => {
              // mappingKnown 由调用方按"能力表非空"判定（见 ConfigCard 内 rawValues / effortValues /
              // mappingKnown 三行）。这里只在 mappingKnown === true 时才敢下"不支持"的结论；否则如实说"未知"——
              // 绝不用"（该平台不支持）"表达"我们没有数据"（旧代码在空表 `{}` 下正是这么谎报的）。
              if (props.mappingKnown !== true) {
                return h('option', { key: level, value: level }, level + L.effort.mappingUnknown);
              }
              const supported = Object.hasOwn(values, level);
              return h(
                'option',
                { key: level, value: level, disabled: !supported },
                supported ? level + ' → ' + String(values[level]) : level + L.effort.unsupported,
              );
            }),
          ],
        ),
        props.warn ? h('span', { className: 'dsh-wb-warn', key: 'rejected' }, props.warn) : null,
        props.hint ? h('span', { className: 'dsh-wb-row__hint', key: 'hint' }, props.hint) : null,
      ]);
    }

    /**
     * 数值 → 固定 2 位小数的字符串（**不用**做本地化分组）。
     *
     * ★ 为什么不用 `toLocaleString`：本文件在浏览器里跑，分组分隔符随宿主 locale 变
     *   （`1,101.25` / `1 101,25`），而卡片其余数字全是原样打印 ⇒ 同一个界面里出现两套数字排版。
     *   固定 `toFixed(2)` 与目录里的 `x0.06` 写法同源，且可被测试逐字断言。
     *
     * @param {number|null|undefined} value
     * @returns {string} 非有限数返回 `''`（调用方据此走"无值"分支，不谎报 0）
     */
    function formatNumber(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '';
    }

    /**
     * `ageMs` → 人话（`90秒` / `5分钟` / `2小时` / `3天`）。
     * 只做**量级**归因：目的不是精确报时，而是让"这个数有多旧"一眼可判。
     * @param {number|null|undefined} ms
     */
    function formatAge(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
      const u = L.credits.age;
      const seconds = Math.floor(ms / 1000);
      if (seconds < 60) return String(seconds) + u.second;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return String(minutes) + u.minute;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return String(hours) + u.hour;
      return String(Math.floor(hours / 24)) + u.day;
    }

    /**
     * 积分单位中文化：载荷里的 `credits` 是英文复数单位，界面一律说"积分"。
     * 缺失/空串同样回落到"积分"（"没给单位"不是"没单位"，不把英文复数印上卡）。
     * 非空且不是 `credits` 的单位（如服务端改了单位名）原样保留 —— 不替服务端翻译没见过的词。
     * @param {unknown} unit
     */
    function unitText(unit) {
      if (typeof unit !== 'string' || unit === '' || unit === L.credits.unknownUnit) return L.credits.unitZh;
      return unit;
    }

    /**
     * `payload.credits` → `{ body, tone }`（判定与措辞的**唯一**出处）。
     *
     * ★★ 本函数存在的理由：宿主**早就算好了**这个数（`launch/live-credits.js:projection()`），
     *   而卡片从来没画过 —— 用户界面上一个积分数字都没有。★★
     *
     * 五种状态必须**分清**，核心禁忌是**把"没读到"画成 `0`**（U9；宿主自己的注释也写着
     * "绝不把'没读到'画成'0'"）。判定顺序即优先级：
     *   ① 载荷未到达（`credits === null/undefined`，含 `makeStatusRoute` 无 credits 服务时下发的
     *      `null`）→ 「读取中」。**不显示 0**：此刻"还剩多少"这件事我们一无所知。
     *   ② `ok !== true` 或 `error` 有值 → 说来由（带机器可读 `code`），**不显示 0**。
     *      `source === 'workbuddy_desktop_closed'` 是其中最常见的成因（桌面端没开 / 端点已失效），
     *      用户下一步动作唯一（把桌面端打开）⇒ 给一句可执行的话，而不是抛黑话。
     *   ③ `ok === true` 且 `remain` 是有限数 → 印 `剩余积分：987.47 积分`（单位已中文化）。
     *   ④ `stale === true` → 数值照印（是上次读到的真值），但**必须**标注陈旧与 `ageMs`——
     *      过期的读数不标注就会被当成实时结论。
     *   ⑤ `ok === true` 但 `remain` 非有限数 → 「平台未返回数值」。**不显示 0**。
     *
     * ★ 收起态三值摘要复用本函数：摘要要的只是"有没有一个可印的数"（`remain`），
     *   判定口径必须与这里一致 —— 两处各写一遍迟早会漂（"摘要有数、块里说没数"）。
     *
     * @param {object|null|undefined} credits `payload.credits`
     * @returns {{ body: string, tone: 'value'|'stale'|'note' }}
     */
    function creditsText(credits) {
      const text = L.credits;
      if (credits === null || credits === undefined) {
        return { body: text.loading, tone: 'note' };
      }
      if (credits.ok !== true) {
        const code = credits.source === 'workbuddy_desktop_closed'
          ? ''
          : String((credits.error && credits.error.code) || credits.source || '');
        const body = credits.source === 'workbuddy_desktop_closed' ? text.desktopClosed : text.unknown(code);
        return { body, tone: 'note' };
      }
      const remain = formatNumber(credits.remain);
      if (remain === '') {
        return { body: text.noValue, tone: 'note' };
      }
      const unit = unitText(credits.unit);
      const age = formatAge(credits.ageMs);
      const body = remain + ' ' + unit + (credits.stale === true
        ? (age === '' ? text.staleUnknown : text.stale(age))
        : '');
      return { body, tone: credits.stale === true ? 'stale' : 'value' };
    }

    /**
     * ⑤ 剩余积分块（`payload.credits`，状态块的头）。
     *
     * ★ 2026-10-02 版式：它是用户进这张卡最想问的数，独立成块放在状态块最上，并由 `tone` 决定语气：
     *   读到实时数 ⇒ 大字；读到旧数 ⇒ 大字但降字色；读不到 ⇒ 回落到诊断区的排版（"读不到"不是新闻）。
     *   ★ 语气只由**排版**承担，判定与措辞一字未动：真正的"读不到"永远不会被排成大字。
     *
     * ⚠️ 内层那一行必须继续渲染成 `className: 'dsh-wb-status__line'` + `key: 'credits'` 的**单个字符串**
     *   （见 test/client.test.js 的 `creditsLine()` 与"积分行必须恰好一条"两处断言）：
     *   把标签与数字拆成两个 span 会让"自身子文本"只剩前半截。
     *
     * ⚠️ 签名是 `props` 而不是 `credits` —— 它是被 `h(CreditsBlock, {credits})` **当组件**调用的，
     *   React 递进来的是 props 对象；写成 `CreditsBlock(credits)` 会读到 `{credits: …}` 这个壳，
     *   于是恒定落进"读不到"分支（本次改造实测踩到）。
     *
     * @param {{credits?: object|null}} props `props.credits` = `payload.credits`
     * @returns {object} 一个 `div` 节点
     */
    function CreditsBlock(props) {
      const credits = props ? props.credits : null;
      const decided = creditsText(credits);
      return h('div', { className: 'dsh-wb-credits dsh-wb-credits--' + decided.tone, key: 'credits' }, [
        h('div', { className: 'dsh-wb-status__line', key: 'credits' }, L.credits.label + decided.body),
      ]);
    }

    /**
     * 任务块（②）：对话标题 + 回执（人话）+ 在途；失败人话主视图，编号证据进折叠。
     *
     * ★ 折叠纪律（2026-10-02）：`--model` 这类旗标名 / 退出码 / 本机路径 / 会话与任务 id /
     *   `registrationError` 这类内部串**只进折叠**（`<details>`），主视图只留人话。
     *   主视图回答三件事："哪条对话"（标题）、"回执收到没"（已收到/暂无 + 退役位 + 时间）、
     *   "在途有没有活"。其余（编号、参数、原始输出）去折叠里核对。
     * ★ 缺字段 ⇒ 不渲染该行（未知不编造）；有字段才上屏。
     * ★ `flags` 非数组（桌面端通路写 `{}`）⇒ 无归因 ⇒ 折叠里不写"被拒绝的参数"行（不凭空指控）。
     *
     * @param {{status?: object|null}} props
     */
    function TaskBlock(props) {
      const status = props ? props.status : null;
      const t = L.task;
      const s = L.status;
      const lines = [];
      const fold = [];
      const inFlight = status !== null && status !== undefined && Array.isArray(status.inFlight)
        ? status.inFlight.length
        : 0;
      lines.push(
        h(
          'div',
          { className: 'dsh-wb-status__line', key: 'inflight' },
          inFlight > 0 ? s.inFlightSome(String(inFlight)) : s.inFlightNone,
        ),
      );
      const lastRun = status !== null && status !== undefined ? status.lastRun ?? null : null;
      if (lastRun === null) {
        lines.push(h('div', { className: 'dsh-wb-status__line', key: 'lastrun' }, s.lastRunNone));
      } else {
        // 对话标题：用户自己的内容，不是内部串 ⇒ 主视图。
        if (typeof lastRun.title === 'string' && lastRun.title !== '') {
          lines.push(h('div', { className: 'dsh-wb-status__line', key: 'task-title' }, t.titlePrefix + lastRun.title));
        }
        // 回执（主视图只说人话）：收到没 + 退役位 + 时间；编号只进折叠。
        {
          const sid = typeof lastRun.sessionId === 'string' && lastRun.sessionId !== '' ? lastRun.sessionId : '';
          const aid = typeof lastRun.automationId === 'string' && lastRun.automationId !== '' ? lastRun.automationId : '';
          const at = typeof lastRun.createdAt === 'number' && Number.isFinite(lastRun.createdAt) ? lastRun.createdAt
            : (typeof lastRun.created_at === 'number' && Number.isFinite(lastRun.created_at) ? lastRun.created_at : 0);
          const retired = lastRun.retired === true ? t.retiredYes : (lastRun.retired === false ? t.retiredNo : '');
          const bits = [sid !== '' || aid !== '' ? t.receiptOk : t.receiptNone];
          if (retired !== '') bits.push(retired);
          if (at > 0) {
            try { bits.push(new Date(at).toLocaleString()); } catch { /* 时间印不出就不印，不挡回执 */ }
          }
          lines.push(h('div', { className: 'dsh-wb-status__line', key: 'task-receipt' }, t.receiptPrefix + bits.join(' · ')));
          // 编号（折叠）：会话与任务 id 是内部串，主视图不出现。
          if (sid !== '') {
            fold.push(h('div', { className: 'dsh-wb-status__line dsh-wb-status__mono', key: 'fold-session' }, t.sessionPrefix + sid));
          }
          if (aid !== '') {
            fold.push(h('div', { className: 'dsh-wb-status__line dsh-wb-status__mono', key: 'fold-automation' }, t.automationPrefix + aid));
          }
        }
        // 实际模型与强度（折叠）：它们是"上次实际用了什么"的记账，不是本次配置 ⇒ 不进配置行，去折叠。
        {
          const usedModel = typeof lastRun.model === 'string' && lastRun.model !== '' ? lastRun.model : '';
          if (usedModel !== '') {
            fold.push(h('div', { className: 'dsh-wb-status__line', key: 'fold-model' }, t.modelPrefix + usedModel));
          }
          const eff = lastRun && typeof lastRun.effort === 'object' && lastRun.effort !== null ? lastRun.effort : null;
          const req = eff !== null && typeof eff.requested === 'string' ? eff.requested : '';
          const cur = eff !== null && typeof eff.effective === 'string' ? eff.effective : '';
          if (req !== '' || (cur !== '' && cur !== '(unknown)')) {
            fold.push(h('div', { className: 'dsh-wb-status__line', key: 'fold-effort' },
              t.effortPrefix + t.effortLine(
                req === '' ? L.effort.noneOption : req,
                cur === '' ? L.shell.unknownText : cur,
              )));
          }
        }
        // §4.5 失败归因（host 已归一）：主视图只说人话（reasonText），归因码只进折叠。
        // 只在**非 ok** 时渲染 —— 拿 ok 的说明当"失败原因"会造出"失败原因：本次下发未见失败证据"这种反义句。
        const reasonCode = typeof lastRun.reasonCode === 'string' ? lastRun.reasonCode : '';
        const reasonText = typeof lastRun.reasonText === 'string' ? lastRun.reasonText : '';
        if (reasonText !== '' && reasonCode !== '' && reasonCode !== 'ok') {
          lines.push(
            h(
              'div',
              { className: 'dsh-wb-status__line dsh-wb-warn', key: 'reason' },
              s.reasonPrefix + reasonText,
            ),
          );
          fold.push(
            h('div', { className: 'dsh-wb-status__line dsh-wb-status__mono', key: 'fold-code' }, t.failPrefix + reasonCode),
          );
        }
        // 退出码 / 接受度 / 下发参数 / 被拒证据（折叠）：排障信息，主视图不出现。
        if (typeof lastRun.exitCode === 'number' && Number.isFinite(lastRun.exitCode)) {
          fold.push(
            h('div', { className: 'dsh-wb-status__line dsh-wb-status__mono', key: 'fold-exit' }, t.exitPrefix + String(lastRun.exitCode)),
          );
        }
        if (typeof lastRun.flagVerdict === 'string' && lastRun.flagVerdict !== '') {
          fold.push(
            h(
              'div',
              { className: 'dsh-wb-status__line', key: 'fold-accept' },
              t.acceptPrefix + enumText(ACCEPT_TEXT, lastRun.flagVerdict, L.shell.unknownText),
            ),
          );
        }
        {
          const argv = Array.isArray(lastRun.argv)
            ? lastRun.argv.filter((a) => typeof a === 'string' && a !== '').join(' ')
            : (typeof lastRun.argv === 'string' ? lastRun.argv : '');
          if (argv !== '') {
            fold.push(h('div', { className: 'dsh-wb-status__line dsh-wb-status__mono', key: 'fold-argv' }, t.argvPrefix + argv));
          }
        }
        // 逐 flag 归属（B-T04-4）：被点名者才置为 rejected；旗标名只进折叠，主视图不见 `--model`。
        const attributed = attributeRows(lastRun);
        if (attributed.named.length > 0) {
          fold.push(
            h(
              'div',
              { className: 'dsh-wb-status__line', key: 'fold-named' },
              s.namedSome(attributed.named.map((f) => f.flag).join('、')),
            ),
          );
        } else if (attributed.rejectedRun) {
          fold.push(
            h(
              'div',
              { className: 'dsh-wb-status__line', key: 'fold-named' },
              s.namedNone,
            ),
          );
        }
        // 被拒证据行（§4.5）：真机上"被拒"的证据**常常不在 stderr**（`--model <非法>` 时 stderr 只有
        // Node 的 UNDICI 警告，证据在 assistant 帧文本/`result.errors[]`）。所以先渲染 host 归一后的
        // `flagEvidence`，再渲染原始 stderr 摘录；后者为空则**不渲染空行**（避免一条空白 mono 行）。
        if (lastRun.flagVerdict === 'rejected' && typeof lastRun.flagEvidence === 'string' && lastRun.flagEvidence !== '') {
          fold.push(
            h(
              'div',
              { className: 'dsh-wb-status__line dsh-wb-status__mono', key: 'fold-evidence' },
              t.evidencePrefix + lastRun.flagEvidence,
            ),
          );
        }
        if (
          lastRun.flagVerdict === 'rejected' &&
          typeof lastRun.stderrExcerpt === 'string' &&
          lastRun.stderrExcerpt !== ''
        ) {
          fold.push(
            h(
              'div',
              { className: 'dsh-wb-status__line dsh-wb-status__mono', key: 'fold-stderr' },
              t.stderrPrefix + lastRun.stderrExcerpt,
            ),
          );
        }
      }
      const details = fold.length === 0
        ? null
        : h(
          'details',
          { className: 'dsh-wb-diag dsh-wb-task__details', key: 'details' },
          h('summary', { className: 'dsh-wb-diag__summary' }, t.detailsSummary),
          h('div', { className: 'dsh-wb-diag__body' }, fold),
        );
      return h('div', { className: 'dsh-wb-task' }, [
        h('div', { className: 'dsh-wb-block-title', key: 'title' }, t.blockTitle),
        ...lines,
        ...(details === null ? [] : [details]),
      ]);
    }

    /**
     * 状态块（④）：积分 + 列表来源 + 诊断折叠。
     *
     * ★ 诊断细节单独收集，收进默认收起的折叠块。动机是真机读数：探测路径 + 逐条命中 +
     *   会话明细 + 注册失败原文 + 绑定尾号，把"积分/来源"挤到了下面。
     *   设置卡该回答"现在能不能用、还剩多少、用哪个"，其余按需展开。
     * ★ 主视图禁内部串：`registrationError` 原文 / 本机路径 / 绑定尾号 / 会话 id 明细
     *   只进折叠（深排障仍有 `workbuddy_status`，那里是结构化全量，不受折叠影响）。
     */
    function StatusBlock(props) {
      const snap = props.snap ?? {};
      const status = props.status;
      const s = L.status;
      const lines = [];
      // ★ 诊断明细单独收集，末尾收进默认收起的折叠块。
      const diag = [];

      lines.push(
        h(
          'div',
          { className: 'dsh-wb-status__line', key: 'settings' },
          s.settingsPrefix + enumText(SETTINGS_TEXT, snap.status, L.shell.unknownText) + (snap.writable === false ? s.readonly : ''),
        ),
      );
      if (props.failure !== '') {
        lines.push(h('div', { className: 'dsh-wb-status__line dsh-wb-warn', key: 'failure' }, s.routeDown + props.failure));
      }
      if (status === null || status === undefined) {
        lines.push(h('div', { className: 'dsh-wb-status__line', key: 'loading' }, s.runtimeLoading));
      } else {
        const probe = status.probe ?? null;
        if (status.registry === 'NOT_INSTALLED') {
          lines.push(h('div', { className: 'dsh-wb-status__line', key: 's1' }, s.notInstalled));
        }
        // ★ 下发健康 C 组：`registry=DEGRADED` 有一类成因与"能不能启动"毫无关系 —— 工具注册本身失败
        //   （工具名被别的插件占走）。那种情况下 ⚠ 标记会与"上次启动失败"撞脸，用户会去查一个从没
        //   跑起来的桌面端。来由由 host 随载荷下发 —— 但**原文只进折叠**，主视图不出现。
        //   （无内容 ⇒ 一行都不加；老 host 缺该字段 ⇒ 同样不加。）
        if (typeof status.registrationError === 'string' && status.registrationError !== '') {
          diag.push(
            h(
              'div',
              { className: 'dsh-wb-status__line dsh-wb-status__mono', key: 'regfail' },
              status.registrationError,
            ),
          );
        }
        if (probe && typeof probe.resolvedPath === 'string' && probe.resolvedPath !== '') {
          // ★ 诊断细节，不再平铺在设置卡上。
          //   这三类内容 —— 缓存文件路径、探测候选逐条命中与否、会话 key→id 明细 ——
          //   都是**排障**信息，不是设置。真机读数里它们连着占 6 行，
          //   把"剩余积分 / 模型 / 能否下发"这三件用户真正要看的挤到了下面。
          //   ⇒ 收进末尾一个默认收起的「诊断信息」折叠块；需要时点开。
          diag.push(h('div', { className: 'dsh-wb-status__line dsh-wb-status__mono', key: 'path' }, s.desktopPathPrefix + probe.resolvedPath));
        }
        const evidence = probe && Array.isArray(probe.evidence) ? probe.evidence : [];
        if (evidence.length > 0) {
          diag.push(
            h(
              'ul',
              { className: 'dsh-wb-evidence', key: 'evidence' },
              // ★ 逐条印 `e.kind`（`knownPath` / `envVar` …）是把**宿主内部的探测步骤名**倒给用户：
              //   用户读到的是一串没解释过的英文标识符，却丢掉了真正有用的信息 —— "这一步找到了没有"。
              //   ⇒ 只印候选位置与命中与否；"是按哪条规则找到的"属于排障细节，需要时看桌面端日志。
              evidence.map((e, i) =>
                h(
                  'li',
                  { key: String(i) },
                  String(e.value) + (e.found === true ? s.evidenceFound : s.evidenceMissing),
                ),
              ),
            ),
          );
        }
        // ★ 绑定会话尾号：它是"能不能下发"的定位线索，但尾号本身是 id 片段 ⇒ 只进折叠。
        {
          const bound = status.bound && typeof status.bound === 'object' ? status.bound : null;
          const tail = bound !== null && typeof bound.tail === 'string' && bound.tail !== '' ? bound.tail : '';
          if (tail !== '') {
            diag.push(h('div', { className: 'dsh-wb-status__line dsh-wb-status__mono', key: 'bound' }, s.boundPrefix + tail));
          }
        }
        if (typeof status.modelsSource === 'string') {
          // ★ 别把内部端点路径原样倒给用户（`desktop-live:/v2/enterprises/personal/models`）。
          //   用户要能分辨的是"这份列表是**实时**读的、还是读的上次缓存"——
          //   端点字符串回答不了这个问题，只会让界面更难读。原始出处仍留在状态载荷里。
          const src = status.modelsSource;
          const human = src.startsWith('desktop-live:')
            ? s.sourceLive
            : (src.startsWith('desktop-cache') ? s.sourceCache : src);
          lines.push(h('div', { className: 'dsh-wb-status__line', key: 'models' }, s.sourcePrefix + human));
        }
        // ★★ 「支持 N/M 条目录项…」与「已隐藏 N 个未声明倍率的模型…」两行**已整体删除**
        //   （2026-10-01）。它们读的是 `status.cliModels`（废弃字段）与 `hiddenNoFactor`
        //   （被删掉的隐藏过滤的产物）。删除理由不是"不好看"，是**这两行现在恒假**：
        //     · 命令行这条线整体删除 ⇒ 没有任何"支持快照"可以计数；
        //     · 展示面不再隐藏任何条目 ⇒ "已隐藏 N 个"永远是 0，报 0 反而是噪声。
        //   目录条数不再由状态区报（下拉框本身就是全量），倍率有无也随 option 逐条上屏。
        // 功能③：可续接会话的**只读**可见性。真正的"继续/新开"由 workbuddy_run 的 resume 参数决定
        // （GUI 不执行外部进程 —— 红线 C3），此处只回答"哪些 key 还能接着聊"。
        const sessionRows = Array.isArray(status.sessions) ? status.sessions : [];
        if (sessionRows.length > 0) {
          const resumable = sessionRows.filter((st) => st && st.resumable === true);
          // ★ 明细（key→id）移出默认视图。真机上它是一条 4 项的长串，
          //   挤在"剩余积分"和"模型"之间，是设置卡上最难看的一行 —— 而用户在这张卡上
          //   要做的决定跟会话 id 无关。默认只留一个**计数信号**（"有 N 条能接着聊"），
          //   明细进折叠块。深排障看 workbuddy_status，那里是结构化全量。
          lines.push(
            h(
              'div',
              { className: 'dsh-wb-status__line', key: 'sessions' },
              s.sessionsSome(resumable.length, sessionRows.length),
            ),
          );
          diag.push(
            h(
              'ul',
              { className: 'dsh-wb-evidence', key: 'session-detail' },
              resumable
                .slice(0, 6)
                .map((st, i) => h('li', { key: String(i) }, String(st.sessionKey) + ' → ' + String(st.cliSessionId).slice(0, 8)))
                .concat(resumable.length > 6 ? [h('li', { key: 'more' }, s.sessionsMore(resumable.length))] : []),
            ),
          );
        }
      }
      // ★ 诊断折叠块：默认收起。用原生 <details>/<summary>，不引 UI 库、不加状态机。
      //   折叠标题本身是主视图 ⇒ 不得含内部串（路径/id/退出码/旗标名都不许出现，见 DICT 头注）。
      const diagnostics = diag.length === 0
        ? null
        : h(
          'details',
          { className: 'dsh-wb-diag', key: 'diag' },
          h('summary', { className: 'dsh-wb-diag__summary' }, s.diagnosticsSummary),
          h('div', { className: 'dsh-wb-diag__body' }, diag),
        );
      return h('div', { className: 'dsh-wb-card__status' }, [
        h('div', { className: 'dsh-wb-block-title', key: 'title' }, s.blockTitle),
        // ① 余额块：与状态无关，载荷未到达也画（否则"这一行不存在"会被读成"没有积分功能"）。
        h(CreditsBlock, {
          key: 'credits',
          credits: status === null || status === undefined ? null : status.credits,
        }),
        ...lines,
        ...(diagnostics === null ? [] : [diagnostics]),
      ]);
    }

    /**
     * ⑤ 配置卡片主体。
     *
     * ★ `scope` 走**闭包**而不是 props —— 这是**契约事实**，不是"空白事故的根因"。
     *   〔2026-10-02 更正〕本注释此前把空白事故归因于"沿用 `inject` 写法导致 scope 为
     *   `undefined`"，**该因果链已被推翻**，见下"真正的根因"。
     *
     * `settings.section` 这个槽与前一代的 `settings.plugin.item` **不是同一套机制**：
     *   - 老槽（`settings.plugin.item`）支持注册项带 `inject: () => ({...})`，宿主把返回面当 props 递给组件；
     *   - 新槽（`settings.section`）**只传 `{ close }`** —— 槽声明
     *     `"settings.section": { kind: "list", scope: "root" }`（**无 `inject` 字段**），
     *     渲染处 `renderSlot("settings.section", { close: onClose }, { only: active })`
     *     （`dsh-client-ui-settings-general/lib/client.js:1136-1139` / `:337`），
     *     官方注册样板（同文件 `:1171-1181`）同样**不写 `inject`**。
     * ⇒ 注册项上的 `inject` 在本槽是**被忽略的可选字段**（不是"会炸"），
     *   组件拿不到 `scope` 是因为宿主压根不递它 ⇒ 必须走闭包。
     *
     * ★★★ 真正的根因（2026-10-01 "设置项在、里面全白"）★★★
     *   `primitives.IconChevronDownOutline14` **不存在**（primitives 导出表里只有
     *   `IconChevronDownOutlineRegular`；`14` 只是该图形自己的 `size = 14` 默认值）。
     *   `h(undefined, …)` 抛错 ⇒ 每个槽条目外层的 `SlotErrorBoundary.render()` 兜底返回一个
     *   **裸的** `jsx("div", { "data-slot-error": slotKey })`，`componentDidCatch` 只 `console.error`
     *   ⇒ 界面上就是"设置项在、里面全白"，且不弹错。修法是把名字改成 `IconChevronDownOutlineRegular`
     *   （见本文件顶部 `:51`）。**根因在图标名，不在 `inject`。**
     *
     * @param {object} props 宿主递给 section 组件的 props（本卡片只用不到，但保留签名）
     */
    const makeConfigCard = (scope) => function ConfigCard(props) {
      void props;
      const [snap, setSnap] = useState(() => (scope ? scope.getSnapshot() : { status: 'unavailable', value: undefined, writable: false }));
      useEffect(() => (scope ? scope.subscribe(() => setSnap(scope.getSnapshot())) : undefined), [scope]);

      const [status, setStatus] = useState(null);
      const [failure, setFailure] = useState('');
      const [refreshNonce, setRefreshNonce] = useState(0);
      // 收纳语义沿用宿主自身惯例（dsh-client-ui-settings-plugin-inventory/lib/client.js:290,339-340）：
      // 状态 `null` = "用户尚未表态" ⇒ 落到本区默认值。官方对**主内容**用 `?? true`，对次级分组用 `?? false`。
      // 本卡是该设置页的唯一内容，属主内容 ⇒ 默认展开；用户点一次即收起。
      const [open, setOpen] = useState(null);
      const effectiveOpen = open ?? true;
      // 模型搜索框的查询（只影响下拉候选的过滤，不写回设置）。
      const [modelQuery, setModelQuery] = useState('');
      // 写失败 Toast：`scope.set` 被拒时如实说出来（点按关闭）。成功写入不碰它。
      const [toast, setToast] = useState('');
      useEffect(() => {
        if (!scope) return undefined;
        let live = true;
        const controller = new AbortController();
        fetchStatus(controller.signal)
          .then((payload) => {
            if (!live) return;
            setStatus(payload);
            setFailure('');
          })
          .catch((error) => {
            if (live && !controller.signal.aborted) setFailure(errorText(error));
          });
        return () => {
          live = false;
          controller.abort();
        };
      }, [scope, refreshNonce]);

      if (!scope) {
        return h('div', { className: 'dsh-wb-card' }, L.shell.scopeMissing);
      }

      const value = snap && typeof snap.value === 'object' && snap.value !== null ? snap.value : {};
      const writable = snap.status === 'ready' && snap.writable === true;
      const registry = status ? status.registry : 'UNKNOWN';
      const installed = registry !== 'NOT_INSTALLED';
      const lastRun = status ? status.lastRun : null;
      // §4.5 回滚口径：**只回滚被点名的那一行**。
      // ★★ 2026-10-02 修正一处**凭空归因**（删净 CLI 线之后才暴露）★★
      //   旧口径：`attributed === false`（一个旗标都没点名）时**退回"整体回滚"**，两行一起清空。
      //   那在 CLI 时代是"宁可少显示也不谎报"的保守；CLI 删除后 `flags` **永远为空**
      //   （"某个旗标被拒"这件事只存在于 CLI 的 stderr 里，两条桌面端通路都不产它），
      //   于是**每一次失败的任务都会把模型和强度两行清空** ——
      //   用户看到的是"我的设置没了"，而设置其实好好地在那儿，失败原因是桌面端不认那个模型。
      //   什么都没点名时，"是你设错了"这个结论**没有依据**：不点名 ⇒ 谁都不许动。
      //   保守的正确方向是**不动**（并照常显示这次运行失败），而不是动得更多。
      // ★ 2026-10-02 补充：回滚提示**不带旗标名**（`--model` 只进任务折叠）。
      //   主视图的配置行只说"这一行被回滚了"，点的是哪个参数去折叠里核对。
      const attribution = attributeRows(lastRun);
      const rollback = (row) => attribution.rejectedRun && attribution.attributed && attribution.rows[row] !== null;
      const modelRollback = rollback('model');
      const effortRollback = rollback('effort');
      const modelWarn = modelRollback ? L.config.rowRolledBack : '';
      const effortWarn = effortRollback ? L.config.rowRolledBack : '';
      // ★ 模型行的**当前值**只在这里判定一次：下拉与收起态摘要共用（两处各算一遍必然漂）。
      const modelValue = modelRollback ? '' : typeof value.model === 'string' ? value.model : '';
      const effortValue = effortRollback ? '' : typeof value.effort === 'string' ? value.effort : '';
      const models = status && Array.isArray(status.models) ? status.models : [];
      // 功能①：展示目录 + 倍率目录 ⇒ 下拉候选。倍率从 `cost.models` 对齐（**不是** `models[].factor`，
      // 那个字段恒为 null —— 见 buildFactorIndex 头注）。目录有多少条就出多少条，不丢条目。
      const costModels = status && status.cost && Array.isArray(status.cost.models) ? status.cost.models : [];
      const modelOptions = buildModelOptions(models, costModels);
      // 能力表"已知"的判据 = **非空**表。为什么不能只判 `typeof === 'object'`：`{}` 同时能表示
      // 两件相反的事 —— "表已加载且平台一档都不支持" 与 "还没有数据"。旧判据按前者处理，
      // 于是把 7 档全标成"（该平台不支持）"，这是**谎报**（U9：缺数据 ≠ 否定结论）。
      // 现在：空表 / 非对象 / 数组 ⇒ 未知 ⇒ 不置灰、不声称不支持；只有拿到非空表才逐档下结论。
      const rawValues = status && status.effort ? status.effort.values : null;
      const effortValues = rawValues !== null && typeof rawValues === 'object' && !Array.isArray(rawValues) ? rawValues : {};
      const mappingKnown = Object.keys(effortValues).length > 0;
      // ★ 候选集/顺序**以宿主为准**：`effort.canonical` 是合法取值集合（不代表平台支持，
      // 支持与否仍由 effortValues 缺 key 表达）。宿主新增档位必须能渲染出来，
      // 所以不能只认本地那份常量；本地表仅在 payload 缺 canonical 时兜底。
      // ★ 两处同时过滤掉 `off`：它不是可下发的强度档（见 EFFORT_UI_LEVELS 头注）。
      //   宿主 canonical 里带着它只是为了与 7 档常量同构，界面不渲染。
      const rawCanonical = status && status.effort ? status.effort.canonical : null;
      const canonicalLevels = Array.isArray(rawCanonical) ? rawCanonical.filter((v) => typeof v === 'string' && v !== '' && v !== 'off') : [];
      const effortLevels = canonicalLevels.length > 0 ? canonicalLevels : EFFORT_UI_LEVELS;

      // 写失败由 Toast 如实说出来（此前是 `.catch(() => {})` 静默吞掉 —— 用户点了开关，
      // 界面没动静，他只能以为"没点上"再点一次）。settingsScope 的恢复路径照旧收敛快照。
      const write = (field, next) => {
        scope.set(field, next).catch((error) => setToast(L.shell.toastPrefix + errorText(error)));
      };

      // 收起态三值摘要：当前模型 · 推理强度 · 剩余积分（设置列表惯例：右值自带语义，不加标签）。
      // ★ 三处取值各有各的诚实口径，且都与正文共用同一判定（两处各算一遍必然漂）：
      //   · 模型：与 ModelRow **同一个** modelValue（§4.5 回滚口径只在一处判定）；
      //     取不到目录项时**不显示该值**（宁可少一个值也不把机器 id 当文案印出去）；
      //   · 强度：与 EffortRow 同一个 effortValue，未指定就说"未指定"；
      //   · 积分：与 CreditsBlock 同一个 `creditsText` 判定 —— 只有印得出数的状态才进摘要，
      //     读不到/无值时**不占位**（"读不到"不是摘要，摘要里留空比写一句"读取中"诚实）。
      const summaryItems = [];
      if (modelValue === '') {
        summaryItems.push({ key: 'model', text: L.models.unsetOption });
      } else {
        const found = modelOptions.rows.find((r) => r.id === modelValue);
        if (found) summaryItems.push({ key: 'model', text: found.label });
      }
      summaryItems.push({ key: 'effort', text: effortValue === '' ? L.effort.noneOption : effortValue });
      {
        const decided = creditsText(status === null || status === undefined ? null : status.credits);
        if (decided.tone !== 'note') summaryItems.push({ key: 'credits', text: decided.body });
      }

      // ★ 加载骨架（2026-10-02）：载荷未到达**且**没有失败时，内容区只有**一个**骨架占位。
      //   各行不再各自报"读取中 / 对应值未知" —— 一屏里五个"加载中"是噪音，一个就够了。
      //   路由失败（failure 非空）时不走这里：失败有明确来由，必须显式上屏（见 StatusBlock）。
      const body = status === null && failure === ''
        ? h('div', { className: 'dsh-wb-card__body', key: 'body' }, [
          h('div', { className: 'dsh-wb-skeleton', key: 'skeleton' }, L.shell.skeleton),
        ])
        : h('div', { className: 'dsh-wb-card__body', key: 'body' }, [
          toast !== ''
            ? h('div', {
              key: 'toast',
              className: 'dsh-wb-toast',
              role: 'alert',
              title: L.shell.toastDismiss,
              onClick: () => setToast(''),
            }, toast)
            : null,
          // ② 任务块：对话标题 + 回执 + 在途（失败人话主视图，编号证据进折叠）。
          h(TaskBlock, { key: 'task', status }),
          // ③ 配置组：三行等距，控件左边缘对齐（栅格 5.5em 标签列，见 CARD_CSS）。
          h('div', { className: 'dsh-wb-group', key: 'controls' }, [
            h('div', { className: 'dsh-wb-block-title', key: 'title' }, L.config.blockTitle),
            h(SwitchRow, {
              key: 'switch',
              label: L.toggle.rowLabel,
              checked: value.enabled === true,
              disabled: !writable || !installed,
              hint: installed ? undefined : L.toggle.hintNotInstalled,
              onChange: () => write('enabled', value.enabled !== true),
            }),
            h(ModelRow, {
              key: 'model',
              value: modelValue,
              options: modelOptions.rows,
              disabled: !writable,
              warn: modelWarn,
              query: modelQuery,
              onQuery: setModelQuery,
              onChange: (next) => write('model', next),
            }),
            h(EffortRow, {
              key: 'effort',
              value: effortValue,
              values: effortValues,
              levels: effortLevels,
              mappingKnown,
              disabled: !writable,
              warn: effortWarn,
              onChange: (next) => write('effort', next),
            }),
          ]),
          h(StatusBlock, { key: 'status', snap, status, failure }),
          // ④ 操作区："刷新状态"重拉的正是状态块的内容，所以贴着状态放（原先吊在内容区顶上，
          //   视觉上像"整张卡的刷新"，实际只管状态区）。悬停说明写清"不改配置"。
          h('div', { className: 'dsh-wb-card__actions', key: 'actions' }, [
            h(
              'button',
              {
                className: 'dsh-wb-card__refresh',
                key: 'refresh',
                type: 'button',
                title: L.shell.refreshHint,
                onClick: () => {
                  setFailure('');
                  setRefreshNonce((n) => n + 1);
                },
              },
              L.shell.refresh,
            ),
          ]),
        ]);

      return h('section', { className: 'dsh-wb-card' + (effectiveOpen ? ' dsh-wb-card--open' : '') }, [
        h('header', { className: 'dsh-wb-card__head', key: 'head' }, [
          // 折叠头。展开态 = 标题行 + 描述行；收起态**只留一行**（名称 + 三值摘要 + 徽标 + chevron）——
          // 收起的目的就是"知道现在是什么、能不能跑"，多一行说明反而挤。
          h(
            'button',
            {
              className: 'dsh-wb-card__toggle',
              key: 'toggle',
              type: 'button',
              'aria-expanded': effectiveOpen,
              'aria-label': (effectiveOpen ? L.shell.collapse : L.shell.expand) + ': WorkBuddy',
              onClick: () => setOpen(!effectiveOpen),
            },
            [
              h('span', { className: 'dsh-wb-card__head-text', key: 'text' }, [
                h('span', { className: 'dsh-wb-card__title-row', key: 'title-row' }, [
                  h('span', { className: 'dsh-wb-card__title', key: 'title' }, 'WorkBuddy'),
                  effectiveOpen || summaryItems.length === 0
                    ? null
                    : h(
                      'span',
                      { className: 'dsh-wb-card__summary', key: 'summary' },
                      summaryItems.map((item) =>
                        h('span', { className: 'dsh-wb-card__summary-item', key: item.key }, item.text),
                      ),
                    ),
                  h(StatusBadge, { registry, key: 'badge' }),
                ]),
                effectiveOpen ? h('span', { className: 'dsh-wb-card__desc', key: 'desc' }, CARD_DESC) : null,
              ]),
              h(Chevron, { open: effectiveOpen, key: 'chevron' }),
            ],
          ),
        ]),
        effectiveOpen ? body : null,
      ]);
    };

    // ───────────────────────── 装配（cordis 插件对象形态；apply 保持 ≤50 行） ─────────────────────────

    /**
     * @param {object} ctx 浏览器插件上下文（fiber inject 保证三服务就绪后才回调）。
     */
    function apply(ctx) {
      // ★★★ 0.1.7 / 0.2.0 迁移（★ 2026-10-01 实机事故后补）★★★
      //
      // 事故：`inject` 仍写着 `settingsScope`，而 dsh 0.2.0 **全树零命中**该服务
      //   ⇒ 插件永远 `pending (waiting for service: settingsScope)`
      //   ⇒ web boot 的完整性校验失败 ⇒ **整个 DSH 起不来**（crash 日志：
      //   `1 entry did not activate / dsh-plugin-workbuddy: pending`）。
      //   top-level `inject` 是**硬依赖门限**：少一个服务不是"这插件不显示"，是"宿主起不来"。
      //
      // 三处断裂，逐条对齐 `packages/plugin-qoder/lib/client.js`（已迁移的那份）：
      //   ① `ctx.settingsScope.bind({namespace})` → `ctx.configForms.get(NS)`
      //   ② 槽 `settings.plugin.item`（0.1.7 已删）→ `settings.section`（设置导航栏独立条目）
      //   ③ `locale` 成为**必需** inject（`t` 靠注册项的 `locale` 选项获得；slot renderer 不注入 locale prop）
      const scope = ctx.configForms.get(NS);
      // ★ 注册字典：`label` thunk 通过 `ctx.locale.bind(NS)` 取值（0.1.7 的 slot renderer
      //   **不注入** locale prop，所以 `t` 只能从注册项的 `locale: NS` 声明处解析）。
      ctx.effect(() => ctx.locale.register(NS, DICT), PACKAGE_NAME + ': dictionaries');
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: NS,
            order: SECTION_ORDER,
            // ★ 0.1.7 的 section 注册项用 `label` thunk + `locale`，不用 `key`。
            label: () => ctx.locale.bind(NS)('nav'),
            locale: NS,
            // ★ **没有 `inject`**：`settings.section` 的宿主渲染处只传 `{ close }`
            //   （`dsh-client-ui-settings-general/lib/client.js:337`），没有 `inject` 机制。
            //   写上去也不会生效 —— `scope` 走**闭包**（见 `makeConfigCard` 的头注）。
          },
          // ★ 组件在装配期就把 `scope` **闭**进去：不依赖宿主传不传那个 prop。
          makeConfigCard(scope),
        ),
      );

      // ② 快速切换（R3-9：description 必须是函数，传字符串会拖垮整份 `/` 菜单的该 source）。
      // ⚠ 门控与卡片同规（R2-MEDIUM）：真机可达 {status:'unavailable', writable:true}
      //   （ui-settings:1089-1094），只看 writable 会让宿主 mutate 静默失败 ⇒"点了没反应"。
      const writableNow = () => {
        const snapshot = scope.getSnapshot();
        return snapshot.status === 'ready' && snapshot.writable === true;
      };
      ctx.effect(
        () =>
          ctx.commandUi.register({
            name: 'workbuddy-model',
            description: () => L.shell.commandDesc,
            available: () => writableNow(),
            ui: {
              kind: 'popupSelect',
              options: async (session, signal) => {
                const payload = await fetchStatus(signal);
                const current = scope.getSnapshot().value?.model ?? '';
                const built = buildModelOptions(
                  Array.isArray(payload.models) ? payload.models : [],
                  payload.cost && Array.isArray(payload.cost.models) ? payload.cost.models : [],
                );
                return [
                  {
                    id: '',
                    label: L.shell.commandUnsetLabel,
                    detail: L.shell.commandUnsetDetail,
                    active: current === '',
                  },
                  ...built.rows.map((m) => ({
                    id: m.id,
                    // ★ 命令面与卡片下拉**同一套**候选与同一套措辞（`标签 · 备注（倍率）`，同一函数 modelOptionLabel）。
                    //   两侧规则分叉是最难查的一类偏差：用户在菜单里看到的与卡片里看到的必须是同一件事。
                    label: modelOptionLabel(m),
                    detail: factorText(m.factor),
                    active: m.id === current,
                  })),
                ];
              },
              onSelect: async (option) => {
                // 竞态防御：菜单构建到选择之间快照可能翻转（available 不是围栏）。
                if (!writableNow()) throw new Error(L.shell.writeBlocked);
                await scope.set('model', option.id);
              },
            },
          }),
        PACKAGE_NAME + ': /workbuddy-model command',
      );
    }

    /**
     * 必需服务（cordis fiber inject）。
     *
     * ★ 这是**硬依赖门限**，不是"可选服务列表**：任何一项在当前宿主里不存在，该插件就永远
     *   `pending`，而 web boot 的完整性校验会因为"1 entry did not activate"**拒绝启动整个 DSH**。
     *   2026-10-01 的启动事故就是这么来的（`settingsScope` 在 0.2.0 已消失）。
     *   ⇒ 改名/下线宿主服务时，这里必须同步；判定依据用 `04-docs/MIGRATION-0.1.5-to-0.1.7.md` §1.2。
     *
     * - `slots`        = ui-renderer
     * - `locale`       = ui-locale（0.1.7 新增：注册项的 `t` 靠 `locale: NS` 选项获得）
     * - `configForms`  = ui-settings（0.1.7 原 `settingsScope`，`bind()` 一并没了）
     * - `commandUi`    = ui-commands
     */
    const inject = ['slots', 'locale', 'configForms', 'commandUi'];

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
