/**
 * workbuddy_purge —— 精准清理对话（施工单 2026-10-10 #3）。
 *
 * <p>管理面此前只有"看"（workbuddy_status）与"发"（workbuddy_run），没有"删"：
 * 委派产生的对话只能去桌面端 GUI 里一条条手动删。本工具补上**精准**清理面：
 *
 * <p>★ 作用域红线：**只动匹配到的那一条对话** ★
 *  - `session_key` 入参：从会话记性（`session/map.js`）读出该 key 记住的 `cliSessionId`，
 *    软删那条对话 + 清掉该 key 的记性（`sessions.purge`）；
 *  - `idLike` 入参：按会话 id 子串匹配 `sessions` 表 —— **恰好命中一条**才执行；
 *    命中 0 条或 ≥2 条一律拒绝（≥2 时列出候选让调用方收窄），绝不触碰其他对话；
 *  - 软删 = `UPDATE sessions SET deleted_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL`
 *    （与桌面端自己的删除语义同列，可恢复、不真删文件）；
 *  - 绝不 INSERT、绝不删 automation 行、绝不碰别的会话行。
 *
 * <p>★ 两个入参都给时：session_key 优先（记性 id 与 idLike 同时校验，不一致 ⇒ 拒绝 ——
 * 防止"key 记的 A、想删的其实是 B"这种静默错位）。
 *
 * 约束：本文件属于 packages/*​/src（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 *
 * @module host/tools/purge
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import { loadSqlite, workbuddyDbPath } from '../gateway/automation.js';
import { TOOL_PURGE } from '../../shared/constants.js';

/**
 * 打开 WorkBuddy 库（测试可注入 `db`，不碰真库）。
 * @param {object|null} [injectedDb]
 * @returns {{ db: object, close: () => void, owned: boolean }}
 */
function openDb(injectedDb) {
  if (injectedDb !== null && injectedDb !== undefined) {
    return { db: injectedDb, close: () => {}, owned: false };
  }
  const DatabaseSync = loadSqlite();
  const db = new DatabaseSync(workbuddyDbPath(), { timeout: 3000 });
  return { db, close: () => { try { db.close(); } catch { /* 已关 */ } }, owned: true };
}

/**
 * 按 id 子串查候选（只查活行；软删过的不再二次处理）。
 * @param {object} db
 * @param {string} like
 * @returns {Array<{id: string, title: string|null}>}
 */
function candidatesByIdLike(db, like) {
  return db.prepare(
    'SELECT id, title FROM sessions WHERE deleted_at IS NULL AND id LIKE ? ORDER BY created_at DESC LIMIT 25',
  ).all(`%${like}%`).map((r) => ({ id: String(r.id), title: typeof r.title === 'string' ? r.title : null }));
}

/**
 * 创建 workbuddy_purge 工具实例。
 *
 * @param {object} [runtime] 宿主运行时（未直接消费；保留接线一致性）
 * @param {Function} [readConfig] 读最新配置（未直接消费；保留接线一致性）
 * @param {object} [ctx] 宿主 ctx（logger）
 * @param {object|null} [sessions] 会话记性（`loadSessionMap` 返回面；`lookup`/`purge`/`list`）
 * @param {object|null} [db] 可选注入已打开的 sqlite 数据库（测试专用；缺省按 WORKBUDDY_HOME 现开）
 */
export function makePurgeTool(runtime = null, readConfig = null, ctx = null, sessions = null, db = null) {
  void runtime;
  void readConfig;
  return defineTool({
    name: TOOL_PURGE,
    description:
      'Precisely purge (soft-delete) ONE WorkBuddy conversation: by session_key (the conversation remembered ' +
      'for that key in the session map) or by idLike (a substring of the conversation id — must match exactly ' +
      'one live conversation). Clears the session-map entry too. It NEVER touches any other conversation.',
    parameters: {
      session_key: {
        type: 'string',
        description: 'The session_key whose remembered conversation should be purged (from workbuddy_status).',
      },
      idLike: {
        type: 'string',
        description: 'A substring of the conversation id to purge. Must match exactly one live conversation.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          purged: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                softDeleted: { type: 'boolean', required: true },
              },
            },
            description: 'The conversations that were soft-deleted (exactly one on success).',
          },
          mapKeysCleared: {
            type: 'array',
            required: true,
            items: { type: 'string' },
            description: 'Session-map keys whose records were cleared.',
          },
          detail: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `Purged ${value.purged.length} conversation(s): ${value.purged.map((p) => p.id).join(', ')}`
            + ` · session-map keys cleared: ${value.mapKeysCleared.length === 0 ? '(none)' : value.mapKeysCleared.join(', ')}`
          : `Purge refused: ${value.detail ?? 'unknown error'}`,
      }],
    },
    presentCall: (a) => ({
      card: 'generic',
      title: `Purge WorkBuddy conversation${a?.session_key ? ` (key: ${a.session_key})` : (a?.idLike ? ` (idLike: ${a.idLike})` : '')}`,
      kind: 'execute',
    }),
    async execute(args) {
      const sessionKey = typeof args?.session_key === 'string' ? args.session_key.trim() : '';
      const idLike = typeof args?.idLike === 'string' ? args.idLike.trim() : '';
      if (sessionKey === '' && idLike === '') {
        return { ok: false, purged: [], mapKeysCleared: [], detail: 'provide session_key or idLike (at least one)' };
      }

      // ① 解析目标会话 id（session_key 优先；两参同给时校验一致，防静默错位）。
      let targetId = null;
      const mapKeysToClear = [];
      if (sessionKey !== '') {
        let record = null;
        try {
          record = typeof sessions?.lookup === 'function' ? sessions.lookup(sessionKey) : null;
        } catch (err) {
          return { ok: false, purged: [], mapKeysCleared: [], detail: `session map lookup failed: ${err instanceof Error ? err.message : String(err)}` };
        }
        if (record === null || typeof record.cliSessionId !== 'string' || record.cliSessionId === '') {
          return { ok: false, purged: [], mapKeysCleared: [], detail: `no recorded conversation for session_key "${sessionKey}"` };
        }
        targetId = record.cliSessionId;
        mapKeysToClear.push(sessionKey);
      }

      let handle = null;
      try {
        handle = openDb(db);
        const { db: conn } = handle;

        if (idLike !== '') {
          const matched = candidatesByIdLike(conn, idLike);
          if (targetId !== null) {
            // 两参同给：idLike 必须命中记性里那条，否则拒绝（不许"顺手"删别的）。
            if (!matched.some((c) => c.id === targetId)) {
              return {
                ok: false,
                purged: [],
                mapKeysCleared: [],
                detail: `idLike "${idLike}" does not match the conversation (${targetId}) recorded for session_key "${sessionKey}" — refusing to touch anything`,
              };
            }
          } else if (matched.length === 0) {
            return { ok: false, purged: [], mapKeysCleared: [], detail: `no live conversation matches idLike "${idLike}"` };
          } else if (matched.length > 1) {
            return {
              ok: false,
              purged: [],
              mapKeysCleared: [],
              detail: `idLike "${idLike}" matches ${matched.length} conversations — refine it to match exactly one. Candidates: `
                + matched.map((c) => `${c.id}${c.title ? ` (${c.title.slice(0, 60)})` : ''}`).join(' | '),
            };
          } else {
            targetId = matched[0].id;
          }
        }

        if (targetId === null) {
          return { ok: false, purged: [], mapKeysCleared: [], detail: 'could not resolve a conversation id (unreachable)' };
        }

        // ② 只读拿标题（回执可读），然后精准软删这一条。
        const row = conn.prepare('SELECT id, title FROM sessions WHERE id = ?').get(targetId) ?? null;
        if (row === null) {
          return { ok: false, purged: [], mapKeysCleared: [], detail: `conversation ${targetId} not found in the sessions table` };
        }
        const now = Date.now();
        const upd = conn.prepare(
          'UPDATE sessions SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
        ).run(now, now, targetId);
        const softDeleted = Number(upd?.changes ?? 0) === 1;
        const purged = [{ id: String(row.id), title: typeof row.title === 'string' ? row.title : null, softDeleted }];

        // ③ 清会话记性：显式给的 key 一定清；其它记性键若也记着这条 id，一并清（同一对话的唯一映射）。
        const cleared = [];
        const tryPurge = (k) => {
          try {
            const r = typeof sessions?.purge === 'function' ? sessions.purge(k) : null;
            if (r !== null && typeof r === 'object' && r.ok === true) cleared.push(k);
          } catch { /* 单个 key 清理失败不拦整体（对话本身已软删） */ }
        };
        for (const k of mapKeysToClear) tryPurge(k);
        if (typeof sessions?.list === 'function' && softDeleted) {
          let rows = [];
          try { rows = sessions.list(); } catch { /* 记性读失败不影响软删结果 */ }
          for (const r of (Array.isArray(rows) ? rows : [])) {
            if (r?.cliSessionId === targetId && !cleared.includes(r?.key)) tryPurge(r.key);
          }
        }

        return {
          ok: true,
          purged,
          mapKeysCleared: cleared,
          detail: softDeleted
            ? `conversation ${targetId} soft-deleted (deleted_at set); other conversations untouched`
            : `conversation ${targetId} was already soft-deleted; nothing changed`,
        };
      } catch (err) {
        return {
          ok: false,
          purged: [],
          mapKeysCleared: [],
          detail: `purge failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      } finally {
        try { handle?.close(); } catch { /* 已关 */ }
      }
    },
  });
}
