/**
 * Track A 追发调度器（★ M2 多轮追发；RFC-SESSION-RESUME-INTEGRATION §3.2 / §4.2）。
 *
 * <p>★ LIVE-CALIBRATED（2026-10-03 真机闭环，WorkBuddy 5.6.2 / Electron 37.10.3 / Chrome 138）★
 * 本文件已按真机证据校准：`00-recon/evidence/CDP-LIVE-20261003/EVIDENCE-CDP-LIVE-20261003.md`
 * （LIVE-VERIFIED：同会话两轮追发、第 2 轮复述第 1 轮约定回复、requests 通道证实轮次递增）。
 * 真机实测过的关键形状（下方逐处标注）：
 *   - 回执 `{clientRequestId, requestId, state:"completed", content:ContentBlock[], artifacts:[], responseModel:{id}}`
 *     —— 是 `state` 不是 `status`，是 `content[]` 不是 `output` 字符串，**无** turnCount / usage；
 *   - 跨桥错误**不 throw**，以返回值 `{__wbError:true, message, code}` 回来；
 *   - `/json/version` 的 `Browser` 只写 "Chrome/138…"，WorkBuddy 身份在 `User-Agent`
 *     （`WorkBuddy/5.6.2` + `Electron/…`）⇒ 判别 = UA ∧ target 启发式；
 *   - `__wbInvoke` 的 context 第二参被 main 侧 `buildTrustedContext` 按 sender 忽略重派 ⇒ 传 `{}`；
 *   - `clientRequestId`（options）真机原样回显 ⇒ 用作幂等/关联键。
 *
 * <p>★ 这一条路解决的是"追发不要新对话"★
 *
 * <p>automation 主路（`gateway/automation.js`）每轮 INSERT 一行 once ⇒ 桌面端建一条**全新**
 * 对话（`conversations.create(randomUUID)`）—— 单发是它的强项，多轮续聊它做不到。Track A
 * 走桌面端自己留的调试面：`WORKBUDDY_REMOTE_DEBUGGING_PORT`（CDP，默认 9222）→ 选定
 * WorkBuddy 自己的 renderer target → `Runtime.evaluate` 在**页面进程里**调
 * `window.__wbInvoke('wb:conversations:runPrompt', …)`，把 prompt 追加进**既有**对话。
 * 登录态、工具面、UI 同步全部原生继承（零补丁、零凭据、零 GUI 自动化——不走任何
 * 模拟点击/按键通路，只是让页面自己的 JS 桥执行它自己暴露的函数）。
 *
 * <p>★ 18488 预检**不判死** ★
 * `GET http://127.0.0.1:18488/workbuddy/probe`（桌面端 LocalProbeServer）只作**信息性**预检：
 * 它不可达**不**直接判死（可能只是版本差异），继续试 CDP —— 以 CDP 实测为准。
 *
 * <p>★ 端口 9222 是共享面，判别必须严格 ★
 * 该端口同时是外部 Chrome/Edge 用户开 `--remote-debugging-port` 的常用口 ⇒ 两级证据取 **AND**：
 * ① `/json/version` 响应的 `User-Agent` 含 `WorkBuddy/`（真机 Browser 字段只是 "Chrome/138…"，
 * 身份在 UA —— 2026-10-03 真机校准）；② `/json/list` 有页面型 target 命中 WorkBuddy 指纹
 * （真机 5/5 命中：app.asar / file:/// / url 含 workbuddy / title / type==='page'）。
 * 任一不成立 ⇒ `ERR_NON_WORKBUDDY_CDP_TARGET`（绝不去劫持别人的浏览器标签页）。
 *
 * <p>★ 错误 → RFC §4.2 七指纹（`ok:false` 的 `code` 字段，绝不抛异常）★
 * `ERR_CONVERSATION_NOT_FOUND` / `ERR_CONVERSATION_CLOSED` / `ERR_WORKBUDDY_CDP_UNAVAILABLE` /
 * `ERR_NON_WORKBUDDY_CDP_TARGET` / `ERR_ACP_CONNECTION_REQUIRED` / `ERR_DISPATCH_TIMEOUT` /
 * `ERR_PERMISSION_DENIED`，外加两个 RFC 之外的存在：`ERR_INVALID_PROMPT`（调用方契约违约）与
 * `ERR_FOLLOWUP_FAILED`（未映射形态的 catch-all —— 归因失真比"不在清单里"更坏）。
 * 调用方（`tools/run.js`）对任何 `ok:false` 走优雅回退：forget 记性 → 照旧点火新会话。
 *
 * <p>★ 轮次与计量不在本模块承诺面 ★（2026-10-03 真机校准）
 * runPrompt 回执**不含** turnCount / usage；轮次与用量走 `wb:conversations:requests(conversationId)`
 * （`{total, page, items[]}`，items 内含 `usage.outputTokens / details.promptTokens /
 * cost:{amount, currency:'credit'}`，且 items[].clientRequestId 与回执回显对齐）。本模块
 * **绝不**因回执缺这两个字段而失败；需要轮次/计量的调用方自行查 requests 通道（真机实测
 * 每轮消耗 credit，如 0.4 credit / 35315 prompt tokens —— 上线需额度意识）。
 *
 * <p>★ sendPrompt 勿用于阻塞收口 ★（2026-10-03 真机校准）
 * `wb:conversations:sendPrompt` 普通直发返回 `undefined`（void，21ms 实测）；`{disposition:…}`
 * 仅在忙时入队场景（options 带 `_expectQueueReceipt` + clientRequestId）出现。本模块用
 * `runPrompt`（阻塞、拿完整回执）—— 后人不要把 sendPrompt 的返回值当回执解析。
 *
 * <p>★ 零凭据 ★ CDP 本地回环无需鉴权；本模块全程不读、不存、不打任何凭据。日志只含端口、
 * target 标题/URL、指纹码与耗时；prompt 内容**不进日志**。
 *
 * <p>★ 只读识别面（★ 2026-10-03 施工单 #2；语义红线 = 零设置调用、不复位、不回写）★
 * 派发**前**用同一个桥读一次 `wb:conversations:get`，从回执的 `configManager` 取
 * `model`（会话当前模型，`''` = 桌面默认未覆盖）与 `thoughtLevel`（会话当前思考强度，
 * 缺席 = 从未覆盖）—— 源码依据：main 侧 `toRemoteConversationSnapshot()` 把这两个字段
 * 连同 `contextWindow` 一起放进跨桥快照（asar `conversations.js:34100`，getter 在 :10617），
 * 只因值为 `undefined` 时被 JSON 丢弃，早先"info 无 model 字段"的结论只看了 `info`。
 * 读到什么写什么：读取失败/会话不可见 ⇒ 两个键都 `null`（`conversationModel` 恒为字符串
 * ⇒ 它为 null 即"读取失败"这个事实的唯一标识）；**绝不**因为读不到就去改会话设定。
 * 本模块对会话的写操作面恒为空集：只允许 `wb:conversations:get` 这一个通道，
 * `set*` 类（含 `setThoughtLevel`/`setModel`）一次都不许出现在 evaluate 表达式里。
 *
 * 约束：本文件属于 packages/*​/src（CI ② 扫描范围）—— 不得出现裸进程出口字样；
 *       只用 Node >= 22.5 内置模块（node:http + node:crypto + 全局 WebSocket），零第三方依赖。
 */

import { randomUUID } from 'node:crypto';
import http from 'node:http';

/** 桌面端 LocalProbeServer（信息性预检；不可达不判死）。 */
const DESKTOP_PROBE_PORT = 18488;
/** CDP 远程调试口默认值（桌面端须以 WORKBUDDY_REMOTE_DEBUGGING_PORT 启动才监听）。 */
export const DEFAULT_CDP_PORT = 9222;
/**
 * 追发确认超时默认值（RFC §4.2 指纹 6）。
 * ★ 2026-10-03 真机校准：首转（worker 冷启动）实测 13.4s、次转 9.1s —— 15s 已在冷启动边缘，
 * 慢盘/杀软/更长系统提示下必然越界 ⇒ 默认 180s（真机依据见 00-recon/evidence/CDP-LIVE-20261003/）。
 */
export const DEFAULT_TIMEOUT_MS = 180_000;
/** 预检/判别两个 HTTP 请求的单请求上限（探针同款；受总 deadline 二次约束）。 */
const HTTP_PROBE_TIMEOUT_MS = 1_500;

/** 追发通道：等待本轮跑完再回（拿到完整回执）。★ 真机已验证。 */
const CHANNEL_RUN_PROMPT = 'wb:conversations:runPrompt';
/**
 * 只读识别通道（施工单 #2）：取会话快照 `{info, configManager}` —— **本模块唯一允许的
 * 会话通道**，纯读、无副作用；`set*` 类写口一次都不许出现在表达式里（测试钉死）。
 */
const CHANNEL_GET_CONVERSATION = 'wb:conversations:get';
/**
 * 只读识别的独立预算（毫秒）：与派发预算分开 —— 识别读失败**绝不**吃掉 runPrompt 的
 * 确认窗口（读超时 ⇒ 如实 null，照常追发）。取 2s：本地回环一次快照读远用不到，
 * 但桌面端卡顿时也只允许它最多拖 2s 就放弃（"近乎即时"优先于"读到识别面"）。
 */
const READ_SETTINGS_BUDGET_MS = 2_000;

/**
 * RFC §4.2 七指纹 + 两个 RFC 外成员（`ok:false` 时 `code` 的取值域）。
 * @type {Readonly<{CDP_UNAVAILABLE: string, NON_WORKBUDDY_TARGET: string, CONVERSATION_NOT_FOUND: string,
 *   CONVERSATION_CLOSED: string, DISPATCH_TIMEOUT: string, PERMISSION_DENIED: string,
 *   ACP_CONNECTION_REQUIRED: string, FOLLOWUP_FAILED: string, INVALID_PROMPT: string}>}
 */
export const FOLLOWUP_CODES = Object.freeze({
  /** 桌面端没开 / 没带调试口启动 / CDP 口连不上。 */
  CDP_UNAVAILABLE: 'ERR_WORKBUDDY_CDP_UNAVAILABLE',
  /** 9222 活着但不是 WorkBuddy（UA 不含 WorkBuddy/ 或 target 全是外部浏览器页面）。 */
  NON_WORKBUDDY_TARGET: 'ERR_NON_WORKBUDDY_CDP_TARGET',
  /** 目标对话已被用户删除/归档。 */
  CONVERSATION_NOT_FOUND: 'ERR_CONVERSATION_NOT_FOUND',
  /** 目标对话已关闭/终止。 */
  CONVERSATION_CLOSED: 'ERR_CONVERSATION_CLOSED',
  /** 超时窗口内没等到确认（默认 180000ms，真机冷启动依据见 DEFAULT_TIMEOUT_MS）。 */
  DISPATCH_TIMEOUT: 'ERR_DISPATCH_TIMEOUT',
  /** 通道授权失败 / 上下文非法（含 renderer 里没有 `window.__wbInvoke` 桥）。 */
  PERMISSION_DENIED: 'ERR_PERMISSION_DENIED',
  /** 网关 ACP 连接缺失（`code:-32000` / `Missing acp-connection-id`）。 */
  ACP_CONNECTION_REQUIRED: 'ERR_ACP_CONNECTION_REQUIRED',
  /** RFC 清单外的 catch-all（未映射错误形态；不硬塞七指纹）。 */
  FOLLOWUP_FAILED: 'ERR_FOLLOWUP_FAILED',
  /** 调用方契约违约：prompt 不是 ContentBlock 数组（桌面端 conversations.js 同样拒收裸字符串）。 */
  INVALID_PROMPT: 'ERR_INVALID_PROMPT',
});

/**
 * 把一段纯文本打包成桌面端要求的 ContentBlock 数组
 * （`materializeConversationRuntimePrompt` 拒收裸字符串 —— 真机数组直通成功，2026-10-03）。
 *
 * @param {string} text
 * @returns {Array<{type: 'text', text: string}>}
 */
export function packageContentBlocks(text) {
  return [{ type: 'text', text: String(text) }];
}

/**
 * ContentBlock 数组的**结构校验**：非空数组、每块是带 `type` 字符串的对象。
 * 裸字符串 / 空数组 / 缺 type 一律不合格。
 *
 * @param {unknown} prompt
 * @returns {{ valid: boolean, error?: string }}
 */
export function isValidPromptBlocks(prompt) {
  if (!Array.isArray(prompt) || prompt.length === 0) {
    return { valid: false, error: 'PROMPT_MUST_BE_NON_EMPTY_ARRAY_OF_BLOCKS' };
  }
  for (const block of prompt) {
    if (block === null || typeof block !== 'object' || typeof block.type !== 'string') {
      return { valid: false, error: 'INVALID_CONTENT_BLOCK_SCHEMA' };
    }
  }
  return { valid: true };
}

/**
 * 把 daemon 侧错误（message 文本 / `__wbError.code`）映射到 RFC §4.2 指纹；
 * 映射不到 ⇒ null（由调用方给 catch-all）。
 * 顺序即语义：先判 ACP 连接面，再判对话面，再判授权面，最后超时。
 * @param {string} message 错误文本（`__wbError` 时 = `code + ' ' + message` 拼接，code 能对上
 *   CONVERSATION_NOT_FOUND/CLOSED 即映射，其余形态落 catch-all）
 * @returns {string|null}
 */
function fingerprintFromMessage(message) {
  const m = String(message ?? '');
  if (m === '') return null;
  // ★ 桥缺失是最常见的"上下文非法"形态（preload 没注入 / 页面不对）⇒ 授权面指纹，先于一切。
  if (/__wbInvoke\s+is\s+not\s+(?:defined|a function)|__wbInvoke[^\n]{0,20}missing/i.test(m)) return FOLLOWUP_CODES.PERMISSION_DENIED;
  if (/acp[-_ ]?connection|missing acp|"-32000"|\b-32000\b/i.test(m)) return FOLLOWUP_CODES.ACP_CONNECTION_REQUIRED;
  if (/not[_ ]?found|no such conversation|unknown conversation|不存在|未找到/i.test(m)) return FOLLOWUP_CODES.CONVERSATION_NOT_FOUND;
  if (/closed|terminated|已关闭|已结束/i.test(m)) return FOLLOWUP_CODES.CONVERSATION_CLOSED;
  if (/permission|denied|not permitted|unauthorized|forbidden/i.test(m)) return FOLLOWUP_CODES.PERMISSION_DENIED;
  if (/timed?[ _-]?out|timeout/i.test(m)) return FOLLOWUP_CODES.DISPATCH_TIMEOUT;
  return null;
}

/**
 * WorkBuddy renderer target 的指纹判别（探针 `detectLiveCdp` 启发式，真机 5/5 命中）。
 *
 * ★ 2026-10-03 真机校准：`file:///` 前缀保守匹配**保留**（真机唯一 target 即 file:///…/app.asar/…，
 * 5/5 关键字命中、无误报）；`wb-cover:` / `vscode-file:` 分支真机未触发，保留但未验证。
 * 多窗口/多 renderer 时 /json/list 可能出现多个 target —— 本判别取**第一个**命中项，
 * 多 target 逐个探桥的升级留待多窗口环境复测（见 live_runner handoff Caveats）。
 *
 * @param {{ type?: unknown, url?: unknown, title?: unknown, webSocketDebuggerUrl?: unknown }} t
 * @returns {boolean}
 */
function looksLikeWorkBuddyTarget(t) {
  if (!t || typeof t.webSocketDebuggerUrl !== 'string' || t.webSocketDebuggerUrl === '') return false;
  const url = String(t.url ?? '').toLowerCase();
  const title = String(t.title ?? '').toLowerCase();
  const isPage = t.type === 'page' || t.type === 'app';
  const hasWorkBuddyUrl = url.includes('app.asar') || url.includes('workbuddy')
    || url.startsWith('file:///') || url.startsWith('wb-cover:') || url.startsWith('vscode-file:');
  const hasWorkBuddyTitle = title.includes('workbuddy');
  return isPage && (hasWorkBuddyUrl || hasWorkBuddyTitle);
}

/**
 * @param {{ log?: (message: string) => void, cdpPort?: unknown, timeoutMs?: unknown,
 *           desktopProbePort?: unknown }} [deps]
 *   `log` = 日志出口（调用方接 `ctx.logger`；缺省静默）。`cdpPort` / `timeoutMs` /
 *   `desktopProbePort` 为缺省值，可被单次调用的同名入参覆盖。
 * @returns {{ followUp: (req: {
 *   conversationId: string, prompt: Array<{type: string, text?: unknown}>, timeoutMs?: number,
 *   cdpPort?: number }) => Promise<{ok: true, channel: string, receipt: object} |
 *   {ok: false, code: string, detail: string}> }}
 */
export function createFollowUpDispatcher(deps = {}) {
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const defaultCdpPort = Number.isFinite(deps.cdpPort) && Number(deps.cdpPort) > 0 ? Number(deps.cdpPort) : DEFAULT_CDP_PORT;
  const defaultTimeoutMs = Number.isFinite(deps.timeoutMs) && Number(deps.timeoutMs) > 0 ? Number(deps.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const defaultProbePort = Number.isFinite(deps.desktopProbePort) && Number(deps.desktopProbePort) > 0
    ? Number(deps.desktopProbePort)
    : DESKTOP_PROBE_PORT;

  /** 单请求 JSON GET（127.0.0.1 回环；有界，错误一律收敛为 {ok:false}，绝不抛）。 */
  const fetchJson = (port, path, timeoutMs) => new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ ok: true, data: JSON.parse(data) });
        } catch {
          resolve({ ok: false, code: 'INVALID_JSON' });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, code: 'ETIMEDOUT' }); });
    req.on('error', (err) => resolve({ ok: false, code: err?.code ?? 'ECONNREFUSED' }));
  });

  /** 桌面端预检：只作信息记录，结论不影响走向（CDP 实测才是判据）。 */
  async function desktopPrecheck(port) {
    const res = await fetchJson(port, '/workbuddy/probe', HTTP_PROBE_TIMEOUT_MS);
    const healthy = res.ok === true
      && res.data?.ok === true
      && res.data?.app === 'workbuddy-desktop';
    if (healthy) log(`followup precheck: desktop probe ok (version=${String(res.data?.version ?? '?')})`);
    else log(`followup precheck: desktop probe not conclusive (${res.ok === true ? 'unexpected payload' : res.code}); continuing with CDP anyway`);
    return healthy;
  }

  /**
   * CDP 两级判别（/json/version + /json/list），**UA ∧ target 双证据 AND**（2026-10-03 真机校准）。
   * @returns {Promise<{live: boolean, target?: object, browser?: string, code: string, detail: string}>}
   */
  async function detectLiveCdp(port, remainingMs) {
    const perRequest = Math.max(1, Math.min(HTTP_PROBE_TIMEOUT_MS, remainingMs));
    const [versionRes, listRes] = await Promise.all([
      fetchJson(port, '/json/version', perRequest),
      fetchJson(port, '/json/list', perRequest),
    ]);
    if (!versionRes.ok && !listRes.ok) {
      return {
        live: false,
        code: FOLLOWUP_CODES.CDP_UNAVAILABLE,
        detail: `port ${port} refused/timed out — WorkBuddy is not running or was started without WORKBUDDY_REMOTE_DEBUGGING_PORT`,
      };
    }
    const version = versionRes.ok ? versionRes.data : {};
    const targets = (listRes.ok && Array.isArray(listRes.data)) ? listRes.data : [];
    // ★ 证据①：UA 含 WorkBuddy/（真机 /json/version 的 Browser 只写 "Chrome/138…"，
    //   WorkBuddy 身份在 User-Agent: "…WorkBuddy/5.6.2 … Electron/37.10.3…"）。
    const userAgent = typeof version?.['User-Agent'] === 'string' ? version['User-Agent'] : '';
    const uaIsWorkBuddy = userAgent.includes('WorkBuddy/');
    // ★ 证据②：target 启发式（app.asar / workbuddy / file:/// / title / type）。
    const matched = targets.find((t) => looksLikeWorkBuddyTarget(t)) ?? null;
    if (uaIsWorkBuddy && matched !== null) {
      log(`followup: CDP target matched (ua=WorkBuddy, title=${JSON.stringify(String(matched.title ?? ''))}, url=${String(matched.url ?? '')})`);
      return { live: true, target: matched, code: '', detail: '' };
    }
    const browser = typeof version?.Browser === 'string' ? version.Browser : 'Unknown Chromium';
    const sample = targets.slice(0, 3).map((t) => String(t?.title ?? t?.url ?? '?')).join(' | ');
    return {
      live: false,
      browser,
      code: FOLLOWUP_CODES.NON_WORKBUDDY_TARGET,
      detail: `port ${port} is active with ${browser} but is NOT proven WorkBuddy `
        + `(user-agent ${uaIsWorkBuddy ? 'matches' : `lacks "WorkBuddy/" (${userAgent === '' ? 'absent' : JSON.stringify(userAgent.slice(0, 80))})`}; `
        + `${matched === null ? `no target matches WorkBuddy fingerprints (${targets.length} target(s); sample: ${sample})` : 'a target matched but the user-agent did not'})`,
    };
  }

  /**
   * 最小 CDP 客户端：全局 WebSocket（Node >= 22.5 内置）+ Runtime.evaluate
   * （awaitPromise + returnByValue）。真机验证成立（bridge-probe-live.json：`typeof
   * window.__wbInvoke === "function"`，runPrompt 两轮回执原样取回）。
   */
  function evaluateOverWebSocket(wsUrl, expression, deadlineMs) {
    return new Promise((resolve) => {
      let settled = false;
      /** @type {any} */
      let ws;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws?.close(); } catch { /* 已关或未开 */ }
        resolve(value);
      };
      // ★ 总 deadline 兜底：连接、执行任一环卡住都收敛为超时指纹，绝不挂死整轮。
      const timer = setTimeout(() => finish({ ok: false, code: FOLLOWUP_CODES.DISPATCH_TIMEOUT, detail: 'CDP evaluation did not settle within the follow-up timeout budget (ERR_DISPATCH_TIMEOUT)' }), Math.max(1, deadlineMs - Date.now()));
      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        finish({ ok: false, code: FOLLOWUP_CODES.CDP_UNAVAILABLE, detail: `WebSocket setup failed: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }
      ws.onerror = () => finish({ ok: false, code: FOLLOWUP_CODES.CDP_UNAVAILABLE, detail: `WebSocket connection to ${wsUrl} failed` });
      ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(String(event.data)); } catch { return; }
        if (msg?.id === undefined || msg.id === null) return; // 事件帧不是本轮的回执
        if (msg.error !== undefined) {
          finish({ ok: false, code: FOLLOWUP_CODES.PERMISSION_DENIED, detail: `CDP error: ${msg.error?.message ?? JSON.stringify(msg.error)}` });
          return;
        }
        if (msg.result?.exceptionDetails !== undefined) {
          const text = String(msg.result.exceptionDetails?.exception?.description
            ?? msg.result.exceptionDetails?.text ?? 'renderer exception');
          finish({ ok: false, code: fingerprintFromMessage(text) ?? FOLLOWUP_CODES.FOLLOWUP_FAILED, detail: text.slice(0, 400) });
          return;
        }
        finish({ ok: true, value: msg.result?.result?.value });
      };
      ws.onopen = () => {
        try {
          ws.send(JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: { expression, awaitPromise: true, returnByValue: true },
          }));
        } catch (err) {
          finish({ ok: false, code: FOLLOWUP_CODES.CDP_UNAVAILABLE, detail: `WebSocket send failed: ${err instanceof Error ? err.message : String(err)}` });
        }
      };
    });
  }

  /**
   * 组装 runPrompt 的 evaluate 表达式（真机逐字验证的形状，见 runprompt-round*-receipt.json）。
   * ★ context 第二参传 `{}`：main 侧 `buildTrustedContext` 会按 event.sender 忽略重派 ——
   *   自造 `{subject:{type:'window',…}}` 多余且无作用（2026-10-03 校准）。
   * ★ options 传 `clientRequestId`（真机合法且回显）⇒ 幂等/关联键。
   */
  function buildRunPromptExpression(conversationId, blocks, options) {
    return `(async () => {
  if (typeof window.__wbInvoke !== 'function') {
    return { __error: true, message: 'window.__wbInvoke is not defined' };
  }
  return await window.__wbInvoke(
    ${JSON.stringify(CHANNEL_RUN_PROMPT)},
    {},
    ${JSON.stringify(conversationId)},
    ${JSON.stringify(blocks)},
    ${JSON.stringify(options)}
  );
})()`;
  }

  /**
   * 组装 `wb:conversations:get` 的只读表达式（施工单 #2）。与 runPrompt 表达式同形：
   * 桥缺失哨兵 + context 第二参传 `{}` + 单参数 conversationId。**纯读**：该通道在
   * main 侧只做快照序列化（`toRemoteConversationSnapshot`），不写任何会话状态。
   */
  function buildGetConversationExpression(conversationId) {
    return `(async () => {
  if (typeof window.__wbInvoke !== 'function') {
    return { __error: true, message: 'window.__wbInvoke is not defined' };
  }
  return await window.__wbInvoke(
    ${JSON.stringify(CHANNEL_GET_CONVERSATION)},
    {},
    ${JSON.stringify(conversationId)}
  );
})()`;
  }

  /**
   * 只读识别：会话"当前模型 / 当前思考强度"（★ 施工单 #2；语义红线见模块头注）。
   *
   * <p>失败语义（**不编造**）：读取异常 / 超预算 / 回执无 `configManager`（会话不可见等）
   * ⇒ `{model:null, effort:null}`；读到但桌面从未覆盖 `thoughtLevel` ⇒ `effort:null`
   * （`model` 读到时恒为字符串 ⇒ `model === null` 唯一指向"没读到"）。
   *
   * @param {{webSocketDebuggerUrl?: unknown}} target 已判别的 WorkBuddy renderer target
   * @param {string} conversationId
   * @param {number} deadlineMs 派发总 deadline（识别走独立小预算，不蚕食派发窗口）
   * @returns {Promise<{model: string|null, effort: string|null}>}
   */
  async function readConversationSettings(target, conversationId, deadlineMs) {
    const budget = Math.max(1, Math.min(READ_SETTINGS_BUDGET_MS, deadlineMs - Date.now()));
    try {
      const outcome = await evaluateOverWebSocket(
        String(target.webSocketDebuggerUrl),
        buildGetConversationExpression(conversationId),
        Date.now() + budget,
      );
      // ★ 信封：evaluateOverWebSocket 给的是 {ok:true, value} / {ok:false, code, detail}；
      //   任何非 ok（超预算/CDP 报错/表达式异常）都只落成 null，绝不影响本轮派发。
      if (outcome === null || typeof outcome !== 'object' || outcome.ok !== true) return { model: null, effort: null };
      const value = outcome.value;
      if (value === null || typeof value !== 'object') return { model: null, effort: null };
      if (value.__error === true || value.__wbError === true) return { model: null, effort: null };
      const cm = value.configManager;
      if (cm === null || typeof cm !== 'object') return { model: null, effort: null };
      return {
        model: typeof cm.model === 'string' ? cm.model : null,
        effort: typeof cm.thoughtLevel === 'string' ? cm.thoughtLevel : null,
      };
    } catch {
      return { model: null, effort: null };
    }
  }

  /**
   * 从 runPrompt 回执提取人话输出：`content[]` 里 text block 的 text 拼接
   * （真机形状 `[{type:'text', text:'收到', messageId:…}]`；无 output 字符串字段）。
   */
  function extractReceiptOutput(value) {
    const blocks = Array.isArray(value?.content) ? value.content : [];
    return blocks
      .map((b) => (b !== null && typeof b === 'object' && typeof b.text === 'string' ? b.text : ''))
      .filter((t) => t !== '')
      .join('\n');
  }

  /**
   * 追发一次。**永不抛**：一切失败收敛为 `{ ok:false, code, detail }`（调用方据此优雅回退）。
   *
   * @param {object} req
   * @param {string} req.conversationId 目标对话 id（记性里的 `cliSessionId`）
   * @param {Array<{type: string, text?: unknown}>} req.prompt **必须**已是 ContentBlock 数组
   *   （调用方用 `packageContentBlocks` 打包；裸字符串直接拒绝 —— 桌面端同样拒收）
   * @param {number} [req.timeoutMs] 确认超时（默认 180000 —— 真机首转冷启动依据见 DEFAULT_TIMEOUT_MS）
   * @param {number} [req.cdpPort] CDP 口（默认 9222）
   */
  async function followUp(req = {}) {
    const t0 = Date.now();
    const conversationId = typeof req.conversationId === 'string' ? req.conversationId : '';
    if (conversationId === '') {
      return { ok: false, code: FOLLOWUP_CODES.CONVERSATION_NOT_FOUND, detail: 'followUp: conversationId is required (nothing to append to)' };
    }
    const check = isValidPromptBlocks(req.prompt);
    if (!check.valid) {
      return {
        ok: false,
        code: FOLLOWUP_CODES.INVALID_PROMPT,
        detail: `followUp: prompt must be packaged as a non-empty ContentBlock[] array (${check.error}); package raw text with packageContentBlocks() first`,
      };
    }
    const timeoutMs = Number.isFinite(req.timeoutMs) && Number(req.timeoutMs) > 0 ? Number(req.timeoutMs) : defaultTimeoutMs;
    const cdpPort = Number.isFinite(req.cdpPort) && Number(req.cdpPort) > 0 ? Number(req.cdpPort) : defaultCdpPort;
    const deadline = t0 + timeoutMs;

    // ① 信息性预检（不可达不判死 —— 以 CDP 实测为准）。
    await desktopPrecheck(defaultProbePort);

    // ② UA ∧ target 双证据判别。
    const cdp = await detectLiveCdp(cdpPort, Math.max(1, deadline - Date.now()));
    if (!cdp.live) {
      return { ok: false, code: cdp.code, detail: cdp.detail };
    }

    // ②′ 只读识别（施工单 #2）：派发前读一次会话当前模型/思考强度，随回执如实带回。
    //    ★ 零设置调用：本步只发 `wb:conversations:get`；读失败不改判本轮走向（null 照发）。
    const settings = await readConversationSettings(cdp.target, conversationId, deadline);

    // ③ 连 renderer target 并在页面里调 runPrompt（options 带 clientRequestId，真机原样回显）。
    const clientRequestId = `dsh-cdp-${randomUUID()}`;
    const outcome = await evaluateOverWebSocket(
      String(cdp.target.webSocketDebuggerUrl),
      buildRunPromptExpression(conversationId, req.prompt, { clientRequestId }),
      deadline,
    );
    if (!outcome.ok) {
      return { ok: false, code: outcome.code, detail: outcome.detail };
    }
    const value = outcome.value;
    if (value === null || typeof value !== 'object') {
      // 真机 runPrompt 回执恒为对象；到这里说明桥/通道形状有变 ⇒ catch-all 如实报。
      return {
        ok: false,
        code: FOLLOWUP_CODES.FOLLOWUP_FAILED,
        detail: `runPrompt returned a non-object value (${value === undefined ? 'undefined' : JSON.stringify(value)?.slice(0, 200)})`,
      };
    }
    // ④ 跨桥错误**不 throw**，以 `{__wbError:true, message, code}` 返回值带回（真机校准）
    //    —— code 能对上 CONVERSATION_NOT_FOUND/CLOSED 等即映射，其余落 catch-all。
    if (value.__wbError === true) {
      const message = String(value.message ?? 'unknown __wbError');
      const code = typeof value.code === 'string' ? value.code : '';
      const mapped = fingerprintFromMessage(code !== '' ? `${code} ${message}` : message)
        ?? FOLLOWUP_CODES.FOLLOWUP_FAILED;
      return { ok: false, code: mapped, detail: `${code === '' ? '' : `${code}: `}${message}`.slice(0, 400) };
    }
    // ⑤ 表达式自带的桥缺失哨兵（preload 未注入 / 页面不对 ⇒ 上下文非法面）。
    if (value.__error === true) {
      const message = String(value.message ?? 'unknown __wbInvoke error');
      return { ok: false, code: fingerprintFromMessage(message) ?? FOLLOWUP_CODES.FOLLOWUP_FAILED, detail: message.slice(0, 400) };
    }
    // ⑥ 完成判定：`state === 'completed'`（真机字段名是 state，不是 status）。
    if (value.state !== 'completed') {
      return {
        ok: false,
        code: FOLLOWUP_CODES.FOLLOWUP_FAILED,
        detail: `runPrompt did not complete: state=${JSON.stringify(value.state ?? null)}`
          + `${typeof value.error === 'string' && value.error !== '' ? ` · ${value.error.slice(0, 200)}` : ''}`,
      };
    }
    log(`followup: dispatched to ${JSON.stringify(conversationId)} in ${Date.now() - t0}ms (requestId=${String(value.requestId ?? '?')})`);
    // ★ 回执信封：raw = 原始对象逐字保留；output = content[] 的 text block 拼接；
    //   turnCount / usage 不在此处（回执没有，走 wb:conversations:requests —— 见模块头注）。
    // ★ conversationModel/conversationEffort（施工单 #2）：派发**前**读到的会话现配，
    //   读到什么写什么；`conversationModel` 为 null ⇔ 识别面没读到（此时 effort 也是 null）。
    return {
      ok: true,
      channel: 'track_a',
      receipt: {
        raw: value,
        output: extractReceiptOutput(value),
        state: value.state,
        requestId: typeof value.requestId === 'string' ? value.requestId : null,
        clientRequestId: typeof value.clientRequestId === 'string' ? value.clientRequestId : clientRequestId,
        responseModel: value.responseModel ?? null,
        conversationModel: settings.model,
        conversationEffort: settings.effort,
        artifacts: Array.isArray(value.artifacts) ? value.artifacts : [],
      },
    };
  }

  return { followUp };
}
