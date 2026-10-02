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
import { defineTool } from '@deepseek-ai/dsh-tools';

import { TOOL_STATUS } from '../../shared/constants.js';
import { readCostCatalog } from '../launch/cost-catalog.js';
import { readModelCatalog, detectionStateOf } from '../launch/model-catalog.js';
import { detectWorkBuddy } from '../probe/detect.js';
// 档位能力表与状态路由**共用同一函数**（单一来源；此前两处各写一份已漂移）。
import { effortCapability } from '../routes/status/get.js';
import { sessionSummary } from '../session/map.js';

/**
 * 取"这条对话此刻支持哪些工具权限"。**永不 throw**——status 是自查工具，
 * 它自己抛异常的话，模型连"为什么查不到"都看不到。
 *
 * @param {{capabilities?: () => Promise<object>}|null} dispatch
 * @returns {Promise<{known: boolean, current: string, options: object[], at: number, error: string}>}
 */
async function reportPermission(dispatch) {
  const empty = { known: false, current: '', options: [], at: 0, error: 'not_wired' };
  if (dispatch?.capabilities !== undefined) {
    try {
      const r = await dispatch.capabilities();
      return {
        known: r?.known === true,
        current: r?.current ?? '',
        options: Array.isArray(r?.options) ? r.options : [],
        at: typeof r?.at === 'number' ? r.at : 0,
        error: r?.error?.code ?? (r?.known === true ? '' : 'unavailable'),
      };
    } catch (e) {
      return { ...empty, at: Date.now(), error: e instanceof Error ? e.message : String(e) };
    }
  }
  return empty;
}

/**
 * @param {object} runtime host SSOT
 * @param {() => any} cfg 配置读取器（同 run.js：不是快照）
 * @param {object} ctx 宿主 ctx（reprobe 时传给只读探测）
 * @param {{ list?: () => any[] }|null} [sessions] 会话映射（缺省 ⇒ `sessions: []`）
 * @param {{capabilities?: () => Promise<object>}|null} [dispatch] 下发器；提供时才报 `permission`
 *   （`permission_mode` 参数的唯一真源，不接线就不给这个字段，而不是给一份本地兜底表）
 */
export const makeStatusTool = (runtime, cfg, ctx, sessions = null, dispatch = null) => defineTool({
  name: TOOL_STATUS,
  description:
    'Inspect the WorkBuddy integration: registration state, detection evidence, effective settings, ' +
    'available models (UI catalog + CLI-supported snapshot), the tool-permission options this conversation ' +
    'accepts (the live values for the run tool\'s permission_mode parameter, plus which one is current), ' +
    'resumable sessions, and in-flight jobs. ' +
    'Pass reprobe:true to re-run the read-only detection (it never launches the CLI).',
  parameters: {
    reprobe: { type: 'boolean', description: 'Re-run the read-only CLI detection before reporting.' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        registry: { type: 'string', required: true },
        // ★ C 组：注册失败原因（重名被别的插件占走等）。`json` 型与 `lastRun` 同款（可为 null）。
        registrationError: { type: 'json', required: true },
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
        // ★ 任务权限（`permission_mode` 参数的唯一真源）。**这张表来自服务端**，不是本地常量：
        //   dispatch 在 `session/load`/`session/new` 期间从 `config_option_update` 事件里取回，
        //   缓存 15s（见 `permissionCapability`）。`currentValue` 是那条对话**此刻**的真实权限。
        //   ★ 服务端不可达时 `known:false` + 空表 ⇒ 工具面必须说"不知道"，绝不用本地表顶替
        //   （本地那份 6 值 CLI flag 表缺 fullAccess/delegate，顶替等于让用户选不到完全权限）。
        permission: {
          type: 'object',
          required: true,
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
                  value: { type: 'string', required: true },
                  name: { type: 'string', required: true },
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
        models: { type: 'array', required: true, items: { type: 'string' } },
        modelsSource: { type: 'string', required: true },
        // ★ 成本面（PRD-v4 A2/A5）：与状态路由同源（readCostCatalog）。`json` 型同 lastRun ——
        //   结构由 core 的 CostSnapshot 契约承载，这里不逐字段展开（展开=两份契约必然漂移）。
        cost: { type: 'json', required: true },
        // ★ 会话（功能③"继续会话或新开会话"）：可续接的 session_key 列表。
        sessions: {
          type: 'array',
          required: true,
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
          required: true,
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
        lastRun: { type: 'json', required: true },
      },
    },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  },
    async execute(args) {
      if (args.reprobe === true) await runtime.probe(detectWorkBuddy, ctx, cfg());
      const c = cfg() ?? {};
      const probe = runtime.detected();
      // 目录读取器与状态路由**共用**（launch/model-catalog.js）⇒ 工具面与 UI 面不可能给出不一致的清单。
      const catalog = readModelCatalog(probe, process.env, detectionStateOf(runtime));
      // 成本面与状态路由**共用**（launch/cost-catalog.js）——只读一次，三个字段同源拼装。
      //   home 缝合口同路由面：测试经 DSH_WB_COST_HOME 指向空目录（两出口同源含同一缝合）。
      const cost = readCostCatalog(null, process.env, { home: process.env.DSH_WB_COST_HOME || undefined });
    return {
      registry: runtime.registry(),
      // 与状态路由同源同字段：注册失败时 `registry=DEGRADED` 需要一个能自解释的来由（两处不说两种话）。
      registrationError: runtime.registrationError?.() ?? null,
      probe: {
        installed: probe?.installed === true,
        reason: probe?.reason ?? 'not-probed',
        resolvedPath: typeof probe?.resolvedPath === 'string' ? probe.resolvedPath : '',
        method: probe?.method ?? 'no-exec',
        at: typeof probe?.at === 'number' ? probe.at : 0,
        evidence: Array.isArray(probe?.evidence) ? probe.evidence : [],
      },
      // ★ 工具面不回传 `enabled`（同 output.schema 的口径）：总开关不属于模型可见面。
      config: {
        model: c.model ?? '',
        effort: c.effort ?? '',
        sessionMode: c.sessionMode ?? '',
        createNewConversation: c.createNewConversation === true,
      },
      // ★ 任务权限表。**只有接线了 dispatch 才报**（`null` = 本次调用没有下发器），
      //   探不到时是 `known:false` + 空表，而不是拿本地 6 值 flag 表顶替。
      //   ★ 探针会 `load` 那条对话，因此**只在这里调**（status 是一次性的只读工具调用），
      //     绝不在 run 路径里探——那会让每次下发都多付一次连接 + load。
      permission: await reportPermission(dispatch),
      // 能力表由路由侧的 effortCapability() **单一来源**产出（含 canonical 7 档与平台 values 的
      // "空表 = 未知"口径）⇒ 工具面与 UI 面不可能给出不一致的档位结论。
      effort: effortCapability(c),
      // 功能①：目录清单（桌面产品配置缓存）。
      models: catalog.models.map((m) => m.id),
      modelsSource: catalog.reason === null ? catalog.source : `${catalog.source}:${catalog.reason}`,
      // 成本面：与状态路由同源同字段（readCostCatalog 单一来源）；available 按注册态覆写（① 硬闸）。
      cost: {
        ...cost.snapshot,
        available: runtime.registry() === 'REGISTERED',
        source: cost.source,
        reason: cost.reason,
      },
      // 功能③：会话映射的可续接视图（与状态路由共用 sessionSummary）。
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
