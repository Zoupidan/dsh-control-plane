/**
 * workbuddy_status —— 模型可见的只读自查工具（注册态 / 探测证据 / 生效配置 / 在途作业）。
 *
 * Implements: 02-design/DESIGN-v3.md §3.4.3（defineTool 形态）/ §4.4.1（三态与证据展开）/ §4.5（lastRun 展示）/
 *             §7.2（H-NO-EXEC-PROBE：reprobe 仍是只读探测，绝不启动程序）
 *
 * 与 bridge 路由（routes/status/get.js）的分工：路由面供 UI 卡片；本工具面供对话模型。
 * 两者共享同一 runtime，字段命名保持同构（`registry` / `probe` / `config` / `effort` / `inFlight` / `lastRun`）。
 * ⚠️ 一处**刻意**不同构：`config.enabled` 只在路由面（GUI 需要），工具面不回传该字段 —— 见 execute() 内注释。
 *
 * 约束：本文件属于 packages/*​/src（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 */
import { existsSync } from 'node:fs';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { TOOL_STATUS } from '../../shared/constants.js';
import { readCostCatalog } from '../launch/cost-catalog.js';
import { readModelCatalog, detectionStateOf } from '../launch/model-catalog.js';
import { currentAccountDetection, workbuddyDbPath, loadSqlite } from '../gateway/automation.js';
import { detectWorkBuddy } from '../probe/detect.js';
// 档位能力表与状态路由**共用同一函数**（单一来源；此前两处各写一份已漂移）。
import { effortCapability } from '../routes/status/get.js';
// ★ D6（2026-10-04）：CDP 探针与点火面**共用同一实现**（dispatcher 闭包里的 UA ∧ target 判别）
//   ⇒ 状态面说"可用"而点火回退（或反之）从结构上不可能发生。
import { createFollowUpDispatcher } from '../followup/dispatcher.js';

/**
 * CDP 只读探针的单次预算（毫秒）。与 `followup/dispatcher.js` 的 `HTTP_PROBE_TIMEOUT_MS` 同值 ——
 * status 是**一次性**只读工具调用，本机回环 + 1.5s 足够给出结论；探不到就如实报 `reason`。
 * @type {number}
 */
const HTTP_PROBE_MS = 1_500;
import { sessionSummary } from '../session/map.js';

/**
 * 取任务权限（基于 SQLite `sessions` 表真实记录，或配置兜底；废除 18488 与 sidecar 依赖，F7/F8）。
 * **永不 throw**——status 是自查工具。
 *
 * @param {object} [cfg] 生效配置
 * @returns {{known: boolean, current: string, options: object[], at: number, error: string}}
 */
export function reportPermission(cfg = {}) {
  let currentPerm = '';
  try {
    const dbPath = workbuddyDbPath();
    if (existsSync(dbPath)) {
      const DatabaseSync = loadSqlite();
      let db = null;
      try {
        db = new DatabaseSync(dbPath, { timeout: 1000 });
        const row = db.prepare('SELECT permission_mode FROM sessions ORDER BY created_at DESC LIMIT 1').get();
        if (row && typeof row.permission_mode === 'string' && row.permission_mode.trim() !== '') {
          currentPerm = row.permission_mode.trim();
        }
      } finally {
        try { db?.close(); } catch {}
      }
    }
  } catch {}

  if (!currentPerm) {
    const cPerm = typeof cfg?.permissionMode === 'string' ? cfg.permissionMode.trim() : '';
    currentPerm = cPerm !== '' ? cPerm : 'default';
  }

  return {
    known: true,
    current: currentPerm,
    options: [
      { id: 'plan', label: 'Plan (Read-Only)', description: 'Read-only inspection and analysis' },
      { id: 'default', label: 'Default', description: 'Standard interactive permissions' },
      { id: 'fullAccess', label: 'Full Access', description: 'Full filesystem access' },
    ],
    at: Date.now(),
    error: '',
  };
}

/**
 * 将模型列表与倍率压缩为紧凑字典映射 { [modelId]: factor }。
 *
 * <p>43+ 模型完整映射体积严格 <= 1KB（单行 JSON 约 958 字节），
 * 彻底消除在上下文中被中间裁剪截断倍率的问题。
 *
 * @param {Array<object>} costModels cost.snapshot.models 列表
 * @param {Array<object|string>} [catalogModels] modelCatalog 模型列表（补充未标价项）
 * @returns {Record<string, number|null>}
 */
export function buildCompactModelsDict(costModels, catalogModels = []) {
  const dict = {};
  if (Array.isArray(costModels)) {
    for (const m of costModels) {
      if (m && typeof m.modelId === 'string') {
        dict[m.modelId] = typeof m.factor === 'number' ? m.factor : null;
      }
    }
  }
  if (Array.isArray(catalogModels)) {
    for (const m of catalogModels) {
      const id = typeof m === 'string' ? m : m?.id;
      if (typeof id === 'string' && !(id in dict)) {
        dict[id] = null;
      }
    }
  }
  return dict;
}

/**
 * @param {object} runtime host SSOT
 * @param {() => any} cfg 配置读取器（同 run.js：不是快照）
 * @param {object} ctx 宿主 ctx（reprobe 时传给只读探测）
 * @param {{ list?: () => any[] }|null} [sessions] 会话映射（缺省 ⇒ `sessions: []`）
 * @param {{capabilities?: () => Promise<object>}|null} [dispatch] 下发器（已废除 sidecar 依赖，保留参数兼容）
 * @param {{projection?: () => any}|null} [checkin] 每日签到（★ 2026-10-09；提供时才报 `checkin` 快照）
 * @param {{projection?: () => any}|null} [credits] 账户余额（★ 2026-10-09；提供时报 `balance` / `creditsRemain`）
 */
export const makeStatusTool = (runtime, cfg, ctx, sessions = null, dispatch = null, checkin = null, credits = null) => {
  const tool = defineTool({
  name: TOOL_STATUS,
  description:
    'Inspect the WorkBuddy integration: registration state, detection evidence, effective settings, ' +
    'available models (UI catalog + CLI-supported snapshot), the tool-permission options this conversation ' +
    'accepts (the live values for the run tool\'s permission_mode parameter, plus which one is current), ' +
    'resumable sessions, and in-flight jobs. ' +
    'Pass reprobe:true to re-run the read-only detection (it never launches the CLI). ' +
    "Use section ('all' | 'overview' | 'models' | 'credits' | 'sessions' | 'checkin') to retrieve slices <= 2KB. " +
    'Use compact:true to receive a compact models multiplier dictionary <= 1KB.',
  parameters: {
    reprobe: { type: 'boolean', description: 'Re-run the read-only CLI detection before reporting.' },
    section: {
      type: 'string',
      description: "Filter status slice: 'all' | 'overview' | 'models' | 'credits' | 'sessions' | 'checkin' (defaults to 'all').",
    },
    compact: {
      type: 'boolean',
      description: 'Format models as a compact dictionary map of { [modelId]: factor } strictly <= 1KB.',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        // ★ 2026-10-10 schema 违约修复：顶层字段一律**非 required** —— section 切片只回传子集，
        //   任何"全量形状才成立"的 required 都会让合法切片被宿主校验打回。例外是 balance /
        //   creditsRemain：它们是每个返回分支（含 invalid_section 与 sessions 切片）都会携带的
        //   顶层安全周边字段（R3），钉 required 是真实不变量而非全量形状假设。
        registry: { type: 'string' },
        // ★ C 组：注册失败原因（重名被别的插件占走等）。`json` 型与 `lastRun` 同款（可为 null）。
        registrationError: { type: 'json' },
        probe: {
          type: 'object',
          additionalProperties: false,
          properties: {
            installed: { type: 'boolean', required: true },
            reason: { type: 'string', required: true },
            resolvedPath: { type: 'string', required: true },
            method: { type: 'string', required: true },
            at: { type: 'number', required: true },
            evidence: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true },
                  value: { type: 'string', required: true },
                  found: { type: 'boolean', required: true },
                },
              },
            },
          },
        },
        config: {
          type: 'object',
          additionalProperties: false,
          properties: {
            // ★ 刻意**不含** `enabled`：工具面是给模型调用的，暴露一个"能关掉自己"的开关只会让模型自伤
            //   （总开关的消费方是 GUI 路由与 tools/index.js 的注册判定，不是模型）。GUI 路由保留该字段。
            model: { type: 'string', required: true },
            effort: { type: 'string', required: true },
            // ★ 刻意**不含** `workspace` / `boundSessionId` / `gatewayToken`：前两个是"哪个目录、哪条
            //   对话"，模型自己填 `cwd` 就够，让它改绑定会劫持用户正在用的对话；后者是凭据形状。
            //   仍然如实回传 `sessionMode` 与 `createNewConversation`——它们决定**这次**能不能发、
            //   以什么授权强度发，模型有权知道。
            sessionMode: { type: 'string', required: true },
            createNewConversation: { type: 'boolean', required: true },
          },
        },
        // ★ 任务权限（`permission_mode` 参数的真源）：基于 SQLite `sessions` 表真实记录，或配置兜底（F7/F8）。
        //   彻底废除 18488 与 sidecar 依赖。
        permission: {
          type: 'object',
          additionalProperties: false,
          properties: {
            known: { type: 'boolean', required: true },
            current: { type: 'string', required: true },
            options: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  label: { type: 'string' },
                  value: { type: 'string' },
                  name: { type: 'string' },
                  description: { type: 'string', required: true },
                },
              },
            },
            at: { type: 'number', required: true },
            // ★ `known:false` 的**成因**。空表本身分不清"没接下发器"和"桌面端没起来"，
            //   而这两者的处置完全不同（前者是配置问题，后者是重启桌面端）⇒ 必须能区分。
            error: { type: 'string', required: true },
          },
        },
        effort: {
          type: 'object',
          additionalProperties: false,
          properties: {
            canonical: { type: 'array', required: true, items: { type: 'string' } },
            values: { type: 'object', required: true, additionalProperties: true }, // canonical→平台取值 映射表（数据）
          },
        },
        // ★ 模型清单（功能①"获取模型"）：目录 id 列表 + 目录来源。
        //   2026-10-10：放宽为 oneOf —— 'all' 非紧凑形状是 string array，section='models'
        //   切片与 compact=true 形状是 { [modelId]: factor } 紧凑字典（数组与普通对象在
        //   dsh-tools 校验器里互斥，恰好命中一个分支）。缺省模型 factor 为 null。
        models: {
          oneOf: [
            { type: 'array', items: { type: 'string' } },
            { type: 'object', additionalProperties: true },
          ],
        },
        modelsSource: { type: 'string' },
        // ★ 成本面（PRD-v4 A2/A5）：与状态路由同源（readCostCatalog）。`json` 型同 lastRun ——
        //   结构由 core 的 CostSnapshot 契约承载，这里不逐字段展开（展开=两份契约必然漂移）。
        cost: { type: 'json' },
        // ★ 每日签到（2026-10-09：Buddy 加油站自动领取）。`json` 型同上：
        //   今日是否已领 / 连签几天 / 自动领取开关，结构由 projection() 单处承载。
        checkin: { type: 'json' },
        // ★ CDP 前置条件面（2026-10-04 D6）：`cdp:{available, port, reason}` —— 模型据此判断
        //   "该不该开口问用户"（三个必须询问的触发之一 = mode=direct 而 available=false）。
        //   `json` 型同 lastRun：结构由 execute() 单处承载，不逐字段展开两份契约。
        cdp: { type: 'json' },
        // ★ 点火走向面（D6）：`ignition:{mode, reason}` —— 这一轮会走 direct 还是计划任务队列、
        //   为什么（含回退预期与"何时必须问"的来由）。
        ignition: { type: 'json' },
        // ★ 只读账号确认面：`account:{uid, method}` —— 插件识别到的现役账号 id
        //   与证据来源（epoch-marker-align / security-holder-mtime / none / error）。
        //   切号后这里应第一个变成新账号；任务 owner 与它对不上 ⇒ 调度器必然过滤。
        account: { type: 'json' },
        // ★ 会话（功能③"继续会话或新开会话"）：可续接的 session_key 列表。
        sessions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              session_key: { type: 'string', required: true },
              cli_session_id: { type: 'string', required: true },
              resumable: { type: 'boolean', required: true },
              last_used_at: { type: 'number', required: true },
            },
          },
        },
        inFlight: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              jobId: { type: 'string', required: true },
              state: { type: 'string', required: true },
              startedAt: { type: 'number', required: true },
            },
          },
        },
        lastRun: { type: 'json' },
        // ★ 顶层可用余额（2026-10-09 防裁剪 R3）：直读 live-credits，显式区分于 checkin 签到积分。
        //   2026-10-10：这两个字段是**唯一**钉 required 的顶层字段 —— 所有返回分支（全量、五个
        //   切片、invalid_section 兜底）都携带它们，是真实跨分支不变量。
        balance: { type: 'json', required: true },
        creditsRemain: { type: 'json', required: true },
        // ── 2026-10-10 schema 违约修复：补齐切片/兜底分支实际会出现的键 ──
        //   additionalProperties:false 之下，"实现里会返回但声明里没有"的键必然被宿主校验打回
        //   （实测：section:'overview'/'sessions' 报 "value.section is not a declared property"）。
        section: {
          type: 'string',
          description: "Echoed section name; present only in sliced responses ('overview'|'models'|'credits'|'sessions'|'checkin'), absent for 'all'.",
          enum: ['all', 'overview', 'models', 'credits', 'sessions', 'checkin'],
        },
        count: { type: 'integer', description: "Number of models in the compact dictionary; present only in section='models'." },
        credits: { type: 'json', description: "Full credits snapshot (packages/counters); present only in section='credits'." },
        checkinCredits: { type: 'json', description: "checkin.totalCredits mirror for A/B comparison; present only in section='credits' (number or null)." },
        distinction: { type: 'string', description: "Semantic distinction between live balance and checkin rewards; present only in section='credits'." },
        // invalid_section 兜底分支（永远不会 throw，只如实指引）：
        error: { type: 'string', description: "Machine-readable error code; present only for invalid section input ('invalid_section')." },
        message: { type: 'string', description: "Human-readable guidance for the invalid section input." },
        supportedSections: { type: 'array', items: { type: 'string' }, description: "All valid section values, for the model to retry with." },
      },
    },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  },
    async execute(args = {}) {
      if (args?.reprobe === true) await runtime.probe(detectWorkBuddy, ctx, cfg());
      const c = cfg() ?? {};
      const probe = runtime.detected();
      // 目录读取器与状态路由**共用**（launch/model-catalog.js）⇒ 工具面与 UI 面不可能给出不一致的清单。
      const catalog = readModelCatalog(probe, process.env, detectionStateOf(runtime));
      // 成本面与状态路由**共用**（launch/cost-catalog.js）——只读一次，三个字段同源拼装。
      //   home 缝合口同路由面：测试经 DSH_WB_COST_HOME 指向空目录（两出口同源含同一缝合）。
      const cost = readCostCatalog(null, process.env, { home: process.env.DSH_WB_COST_HOME || undefined });

      // ═══ D6（2026-10-04）：CDP 前置条件 + 点火走向 —— **只读、只告知、只询问** ═══
      //   插件绝不代设环境变量、绝不代杀/代重启 WorkBuddy、绝不静默回退却声称 direct（见 prompts/availability.js）。
      //   只有依赖 CDP 的面开着才付这一次探针（否则 reason 说清"没查、也不用查"，不让每次 status 白付 1.5s）。
      const portRaw = Number(c.followupCdpPort);
      const cdpPort = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 9222;
      const cdpNeeded = c.enableDirectIgnition === true || c.enableMultiTurnFollowUp === true;
      const cdpProbe = cdpNeeded
        ? await createFollowUpDispatcher({ cdpPort, timeoutMs: HTTP_PROBE_MS }).probeCdp(cdpPort, HTTP_PROBE_MS)
        : { available: false, reason: 'not-needed (direct ignition and multi-turn follow-up are both off)' };
      const cdp = {
        available: cdpProbe.available === true,
        port: cdpPort,
        reason: typeof cdpProbe.reason === 'string' ? cdpProbe.reason : 'probe-error: unknown',
      };
      // `mode` = **配置意图**（不是本轮实况）——触发条件(1)「mode=direct 而 available=false」才成立；
      // 实况写在 `reason` 里（回退预期逐字写清），避免模型只读 mode 就谎称 direct。
      const ignition = {
        mode: c.enableDirectIgnition === true ? 'direct' : 'automation',
        reason: c.enableDirectIgnition !== true
          ? 'enableDirectIgnition is off (schema default): rounds go through the automation queue (planned '
            + 'task), so each round pays the scheduling overhead on top of the model turn.'
          : (cdp.available === true
            ? `enableDirectIgnition is on and the desktop answers CDP on port ${cdpPort}: rounds create the `
              + 'conversation directly and skip the scheduling overhead.'
            : `enableDirectIgnition is on, but no WorkBuddy CDP endpoint answered on port ${cdpPort} `
              + `(${cdp.reason}), so rounds fall back to the automation queue. WorkBuddy must be started with `
              + `the user-level env var WORKBUDDY_REMOTE_DEBUGGING_PORT=${cdpPort} and then fully quit and `
              + 'relaunched — a running instance cannot gain the port. ASK the user before doing anything '
              + 'about it: never set env vars, never restart or kill WorkBuddy, and never report a round as '
              + 'direct when it fell back.'),
      };

      // ★ R3：账户可用余额提取（来自 live-credits 服务的 projection()）
      const credSnapshot = credits !== null && typeof credits.projection === 'function' ? credits.projection() : null;
      const liveBalance = credSnapshot?.remain ?? null;
      // ★ 每日签到快照：与状态路由同源（projection 单一来源）；未接线 ⇒ null（不是"未签"）。
      const checkinSummary = checkin === null || typeof checkin.projection !== 'function' ? null : checkin.projection();

      // ★ R1：分节过滤逻辑 (section: 'all' | 'overview' | 'models' | 'credits' | 'sessions' | 'checkin')
      const section = typeof args?.section === 'string' ? args.section.trim().toLowerCase() : 'all';
      const validSections = ['all', 'overview', 'models', 'credits', 'sessions', 'checkin'];
      if (!validSections.includes(section)) {
        return {
          error: 'invalid_section',
          message: `Unknown section '${args.section}'. Supported sections: 'all', 'overview', 'models', 'credits', 'sessions', 'checkin'.`,
          supportedSections: validSections,
          registry: runtime.registry(),
          account: currentAccountDetection(),
          balance: liveBalance,
          creditsRemain: liveBalance,
        };
      }

      // ── 独立切片 1: overview (系统宏观与账号摘要，<= 2KB) ──
      if (section === 'overview') {
        return {
          section: 'overview',
          registry: runtime.registry(),
          registrationError: runtime.registrationError?.() ?? null,
          account: currentAccountDetection(),
          balance: liveBalance,
          creditsRemain: liveBalance,
          checkin: checkinSummary,
          config: {
            model: c.model ?? '',
            effort: c.effort ?? '',
            sessionMode: c.sessionMode ?? '',
            createNewConversation: c.createNewConversation === true,
          },
          permission: reportPermission(c),
          inFlight: runtime.inFlight(),
        };
      }

      // ── 独立切片 2: models (全量模型倍率紧凑映射字典，<= 1KB / <= 2KB) ──
      if (section === 'models') {
        const compactModels = buildCompactModelsDict(cost.snapshot?.models, catalog.models);
        return {
          section: 'models',
          models: compactModels,
          modelsSource: catalog.reason === null ? catalog.source : `${catalog.source}:${catalog.reason}`,
          count: Object.keys(compactModels).length,
          balance: liveBalance,
          creditsRemain: liveBalance,
        };
      }

      // ── 独立切片 3: credits (账户计费包与余额详情，明确与 checkin 区分，<= 2KB) ──
      if (section === 'credits') {
        return {
          section: 'credits',
          account: currentAccountDetection(),
          balance: liveBalance,
          creditsRemain: liveBalance,
          credits: credSnapshot,
          checkinCredits: checkinSummary?.totalCredits ?? null,
          distinction: 'balance/creditsRemain is live account balance; checkin.totalCredits is promotional checkin streak rewards.',
        };
      }

      // ── 独立切片 4: checkin (Buddy 加油站每日签到详情，<= 2KB) ──
      if (section === 'checkin') {
        return {
          section: 'checkin',
          account: currentAccountDetection(),
          balance: liveBalance,
          creditsRemain: liveBalance,
          checkin: checkinSummary,
        };
      }

      // ── 独立切片 5: sessions (可续接会话列表，<= 2KB) ──
      //   ★ 2026-10-10：补 balance / creditsRemain —— 它们是 schema 里唯一 required 的顶层
      //   字段（跨分支不变量），sessions 切片原本是唯一漏带的分支。
      if (section === 'sessions') {
        return {
          section: 'sessions',
          account: currentAccountDetection(),
          balance: liveBalance,
          creditsRemain: liveBalance,
          sessions: sessionSummary(sessions, 10).map((s) => ({
            session_key: s.sessionKey,
            cli_session_id: s.cliSessionId,
            resumable: s.resumable,
            last_used_at: s.lastUsedAt,
          })),
          inFlight: runtime.inFlight(),
        };
      }

      // ── 默认: section === 'all' (全量防裁剪安全周边布局) ──
      const isCompact = args?.compact === true;
      return {
        // ── 顶层安全防线 (Top Perimeter: 高频核心信息永不被截断) ──
        registry: runtime.registry(),
        registrationError: runtime.registrationError?.() ?? null,
        account: currentAccountDetection(),
        balance: liveBalance,
        creditsRemain: liveBalance,
        checkin: checkinSummary,
        config: {
          model: c.model ?? '',
          effort: c.effort ?? '',
          sessionMode: c.sessionMode ?? '',
          createNewConversation: c.createNewConversation === true,
        },
        permission: reportPermission(c),
        effort: effortCapability(c),
        modelsSource: catalog.reason === null ? catalog.source : `${catalog.source}:${catalog.reason}`,
        cdp,
        ignition,
        probe: {
          installed: probe?.installed === true,
          reason: probe?.reason ?? 'not-probed',
          resolvedPath: typeof probe?.resolvedPath === 'string' ? probe.resolvedPath : '',
          method: probe?.method ?? 'no-exec',
          at: typeof probe?.at === 'number' ? probe.at : 0,
          evidence: Array.isArray(probe?.evidence) ? probe.evidence : [],
        },
        // ── 中部大对象 (Middle: 易裁剪区放置庞大数据) ──
        models: isCompact
          ? buildCompactModelsDict(cost.snapshot?.models, catalog.models)
          : catalog.models.map((m) => m.id),
        cost: {
          ...cost.snapshot,
          available: runtime.registry() === 'REGISTERED',
          source: cost.source,
          reason: cost.reason,
        },
        // ── 底部安全防线 (Bottom Perimeter: 会话与运行历史) ──
        sessions: sessionSummary(sessions).map((s) => ({
          session_key: s.sessionKey,
          cli_session_id: s.cliSessionId,
          resumable: s.resumable,
          last_used_at: s.lastUsedAt,
        })),
        inFlight: runtime.inFlight(),
        lastRun: runtime.lastRun(),
      };
    },
    presentCall: () => ({ card: 'generic', title: 'Inspect the WorkBuddy integration status', kind: 'read' }),
  });

  // ★ 2026-10-10 schema 违约修复：**删除**原先把 properties 的 ownKeys 钉死在 16 个
  //   "传统键"上的 Proxy。那个 Proxy 曾让 `balance` / `creditsRemain`（以及今后任何新键）
  //   对宿主校验器与 schema 物化（JSON 序列化 / structuredClone）**不可见**——声明在但
  //   列举不出，正是本缺陷"声明与实际返回形状脱节"的一半成因。现在 properties 是一个
  //   诚实的普通对象：声明的键集 = 全部实际会出现的键集（test/host.test.js 的键集硬断言
  //   已同步登记为全量键集）。
  return tool;
};
