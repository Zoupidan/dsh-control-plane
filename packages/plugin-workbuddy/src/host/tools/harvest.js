/**
 * workbuddy_harvest —— 延迟收割工具（Late-Harvest Channel）。
 *
 * <p>允许调用方通过 automation_id 检索任何过去或正在运行的 WorkBuddy 任务结果、
 * assistant 响应正文、生成的产物文件列表以及会话句柄。
 *
 * @module host/tools/harvest
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import { harvestAutomationRun } from '../gateway/automation.js';

export const TOOL_HARVEST = 'workbuddy_harvest';

/**
 * 创建 workbuddy_harvest 工具实例。
 *
 * @param {object} [runtime]
 * @param {Function} [readConfig]
 * @param {object} [ctx]
 * @param {object} [db] 可选注入已打开的 sqlite 数据库（测试或专用连接）
 */
export function makeHarvestTool(runtime = null, readConfig = null, ctx = null, db = null) {
  return defineTool({
    name: TOOL_HARVEST,
    description:
      'Harvest the result, assistant reply text, generated artifacts, and session state of any ' +
      'WorkBuddy automation task by its automation_id (supporting completed, still_running, and past tasks).',
    parameters: {
      automation_id: {
        type: 'string',
        required: true,
        description: 'The unique automation ID (e.g. automation-1728420000000) to harvest.',
      },
      wait_ms: {
        type: 'number',
        description: 'Optional milliseconds to wait for the task to settle if it is still running.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          automationId: { type: 'string', required: true },
          sessionId: {
            oneOf: [{ type: 'string' }, { type: 'null' }],
            description: 'The conversation UUID associated with this automation run.',
          },
          status: {
            type: 'string',
            enum: ['completed', 'still_running', 'failed'],
            required: true,
          },
          reply: {
            oneOf: [{ type: 'string' }, { type: 'null' }],
            description: 'The final assistant response text.',
          },
          artifacts: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of artifact/file paths generated or referenced during tool execution.',
          },
          transcriptPath: {
            oneOf: [{ type: 'string' }, { type: 'null' }],
            description: 'Path to the session transcript JSONL file on disk.',
          },
          permission: {
            type: 'object',
            additionalProperties: false,
            properties: {
              requested: { type: 'string' },
              effective: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              confirmed: { type: 'boolean' },
            },
          },
          effort: {
            type: 'object',
            additionalProperties: false,
            properties: {
              requested: { type: 'string' },
              effective: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              confirmed: { type: 'boolean' },
            },
          },
          model: {
            type: 'object',
            additionalProperties: false,
            properties: {
              requested: { type: 'string' },
              effective: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            },
          },
          usage: {
            type: 'object',
            additionalProperties: false,
            properties: {
              tokens: { type: 'number' },
              credits: { type: 'number' },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `Harvested automation ${value.automationId} · status=${value.status}` +
            (value.sessionId ? ` · session=${value.sessionId}` : '') +
            (value.reply ? `\n\n--- Assistant Reply ---\n${value.reply}` : '') +
            (Array.isArray(value.artifacts) && value.artifacts.length > 0
              ? `\n\n--- Artifacts (${value.artifacts.length}) ---\n${value.artifacts.map((a) => `  - ${a}`).join('\n')}`
              : '')
          : `Failed to harvest automation ${value.automationId}: ${value.error ?? 'unknown error'}`,
      }],
    },
    async execute(args, exec) {
      if (!args || typeof args.automation_id !== 'string' || args.automation_id.trim() === '') {
        return {
          ok: false,
          error: 'invalid_automation_id',
          automationId: String(args?.automation_id ?? ''),
          sessionId: null,
          status: 'failed',
          reply: null,
          artifacts: [],
          transcriptPath: null,
          permission: { requested: '', effective: null, confirmed: false },
          effort: { requested: '', effective: null, confirmed: false },
          model: { requested: '', effective: null },
          usage: { tokens: 0, credits: 0 },
        };
      }
      const waitMs = typeof args.wait_ms === 'number' && args.wait_ms > 0 ? args.wait_ms : 0;
      return harvestAutomationRun(db, args.automation_id.trim(), { waitMs, signal: exec?.signal });
    },
    presentCall: (a) => ({
      card: 'generic',
      title: `Harvest WorkBuddy automation: ${a?.automation_id ?? ''}`,
      kind: 'read',
    }),
  });
}

export const workbuddy_harvest = makeHarvestTool();
