/**
 * ACP（Agent Client Protocol）客户端：与本机 WorkBuddy sidecar 的 Express 网关对话。
 *
 * <p>══════════ 四个强制头，一个都不能少 ══════════
 *
 * <p>这四个头是逐个撞出来的，每一条都对应一次真实失败：
 * <ol>
 *   <li>`Authorization: Bearer <token>` —— token **就是**网关口令本身（真机核对：login 返回的
 *       token 与口令 43 字符逐位相同），不是另一个凭据。</li>
 *   <li>`X-CodeBuddy-Request: 1` —— Express 侧 `CustomRequestHeader` 安全方案；缺了直接 401。</li>
 *   <li>`acp-connection-id: <cid>` —— 缺了 400 `Missing acp-connection-id header`。
 *       ★ 这个头当初漏了，报错信息还指向"缺头"，很容易误以为是 body 的问题。</li>
 *   <li>`Accept: application/json, text/event-stream` —— 缺了 406
 *       `Not Acceptable: Client must accept both application/json and text/event-stream`。
 *       ★ 提示只说"两个都要收"，不说是哪个少。</li>
 * </ol>
 *
 * <p>★ 第四个头存在的原因见 {@link postAcp} 的返回值说明：`session/prompt` 的 **POST 响应体
 * 本身就是完整的运行事件流**（SSE 形态），不是 JSON。所以"两个都要收"是字面意思。
 *
 * @module host/gateway/acp
 */

import {
  extractAssistantText, extractPhases, extractReceipt, extractSession, extractToolCalls, extractModes,
  parseSseMessages, pickResponse,
} from './receipt.js';

/** `POST /api/v1/acp` 上的四个强制头。抽出常量是因为漏头是这层最常见的失败，且报错不友好。 */
export const ACP_HEADERS = Object.freeze({
  'X-CodeBuddy-Request': '1',
  Accept: 'application/json, text/event-stream',
});
/** 真机 `initialize` 的协议版本。 */
export const PROTOCOL_VERSION = 1;

/** 一次 prompt 的墙钟上限。真机一轮最短 ~7s，模型慢时能到分钟级；默认给足。 */
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * 把工作区路径转成 `file:` URI。
 *
 * <p>★★★ 这个 URI **不会**成为会话的工作目录——它只是随任务文本送给模型的一个锚点。
 * 之所以还要转 URI，是因为协议里 `resource.uri` 必须是 URI，而 `text` 块里给裸路径更易读，
 * 两者都要。
 *
 * @param {string} p
 * @returns {string} `file:///C:/path`，`p` 非字符串时返回 `''`
 */
export function pathToFileUri(p) {
  if (typeof p !== 'string' || p.trim() === '') return '';
  let s = p.trim().replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(s)) s = `/${s}`;          // `C:/x` -> `/C:/x`
  else if (!s.startsWith('/')) s = `/${s}`;          // 相对路径也绝对化
  return `file://${s.replace(/^\/+/, '/')}`;
}

/**
 * 组装 prompt 的内容块，必要时把工作区**锚进去**。
 *
 * <p>★★★ 本仓最重要的一条实测结论，没有例外：**工作区无法设置为会话属性。**
 *
 * <p>`session/new` / `session/load` 的 `cwd` 参数被**静默丢弃**，四种独立方式验证过：
 * <ol>
 *   <li>裸 Windows 路径 `D:\demo\…`</li>
 *   <li>`file:///D:/demo/…` URI</li>
 *   <li>`file:///Z:/definitely-not-a-real-path-xyz`（不存在的盘符）</li>
 *   <li>模型自报 cwd —— 无论传哪个，回的都是 sidecar 自己的临时目录
 *       `…\Temp\workbuddy-host-cli\__workbuddy_cli_host__-0-fa34166b`</li>
 * </ol>
 * 后三条同时成功返回（连不存在的盘都"成功"），所以这不是校验失败，是**参数根本不参与寻址**。
 *
 * <p>★ 而且**没有结构化回读**：回执里没有任何字段带工作目录，模型是在正文散文里自述的，
 *   所以也不能靠回执来确认工作区对不对。
 *
 * <p>⇒ 唯一可行路径是**把它当任务输入送进去**，本函数就是这么做的。两段一起送：
 * <ul>
 *   <li>正文前缀——明确写出来，因为模型只读得到自己读到的文本；</li>
 *   <li>`resource` 块——给协议层一个正式锚点，URI + 人类可读 text。</li>
 * </ul>
 *
 * <p>★★ **效果已用硬负控验证**：只给工作区 URI、不给任何文件线索，问一个"只可能真读该目录
 * 才知道"的文件是否存在，模型答"存在"（该文件确实存在），且它的工具调用从
 * `{"command":"ls -1"}`（无路径）变成带完整路径的 `ls "D:\demo\…"`。
 * 对照组：不送工作区时命令不带路径。**这才是工作区真的生效的证据。**
 *
 * <p>★★★ **这是提示，不是约束。** 没有任何服务端机制把模型钉在这个目录里——它可以
 * 走别的目录、也可以读写别处。UI 和文档都必须如实这么讲，不能说成"已限制在该目录"。
 * 真正的硬约束只能靠**服务端**的权限模式（见 {@link createAcpClient} 的 `setMode`）。
 *
 * @param {string} promptText
 * @param {string|null|undefined} workspace
 * @returns {object[]} `session/prompt` 的 `prompt` 数组
 */
export function buildPromptBlocks(promptText, workspace) {
  const text = typeof promptText === 'string' ? promptText : '';
  const uri = pathToFileUri(workspace);
  if (uri === '') return [{ type: 'text', text }];
  return [
    {
      type: 'text',
      text: `本次任务的工作区是 ${workspace}。\n`
        + '不要依赖你默认的工作目录，一切以上面这个路径为准；'
        + '凡是要读写文件，都用这个路径下的相对路径。\n\n'
        + text,
    },
    { type: 'resource', resource: { uri, mimeType: 'text/plain', text: `workspace: ${workspace}` } },
  ];
}

/**
 * 把网关的 HTTP 失败翻译成可判定的形状。
 *
 * <p>★ 不把响应体原样往外抛：sidecar 的错误体偶尔会带上内部路径；只留状态码和一行自己的话。
 *
 * @param {Response} res
 * @param {string} what 正在做的动作（用于错误信息）
 * @returns {{status: number, code: string, message: string}}
 */
export function classifyHttpError(status, what) {
  const map = {
    400: 'bad_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found',
    406: 'not_acceptable', 408: 'timeout', 429: 'rate_limited', 500: 'server_error',
    502: 'bad_gateway', 503: 'unavailable', 504: 'gateway_timeout',
  };
  const code = map[status] ?? (status >= 500 ? 'server_error' : 'http_error');
  // ★ 四个头的两类报错要单独点出来，否则用户只会看到"网关请求失败"
  let hint = '';
  if (status === 406) hint = ' — the Accept header must list BOTH application/json and text/event-stream';
  if (status === 400) hint = ' — check the acp-connection-id header and the request body';
  if (status === 401) hint = ' — the gateway token is stale; the sidecar restarted';
  return { status, code, message: `${what} failed: HTTP ${status}${hint}` };
}

/**
 * 建一个绑定了某 sidecar 的 ACP 客户端。
 *
 * @param {{url: string, token: string, fetchImpl?: typeof fetch, timeoutMs?: number,
 *   onEvent?: (msg: object) => void}} opts
 *   ★ `token` 会被原样放进 `Authorization` 头。它**不会**出现在任何错误信息里（见 {@link classifyHttpError}）。
 */
export function createAcpClient({ url, token, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, onEvent }) {
  const base = url.replace(/\/+$/, '');
  let connectionId = null;
  let nextId = 0;

  /**
   * 发一个 ACP JSON-RPC。
   *
   * @param {string} method
   * @param {unknown} [params]
   * @returns {Promise<{messages: object[], text: string, status: number}>}
   *   ★ `text` 是**原始响应体**，`messages` 是从它切出来的 JSON-RPC 消息。
   *   ★ 不做 `JSON.parse`（会抛）——`session/prompt` 的响应体是 SSE 形态。
   */
  async function postAcp(method, params) {
    const id = `r${++nextId}`;
    const headers = {
      ...ACP_HEADERS,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    if (connectionId !== null) headers['acp-connection-id'] = connectionId;
    let res;
    try {
      res = await fetchImpl(`${base}/api/v1/acp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return { id, messages: [], text: '', status: 0, error: { code: 'unreachable', message: `${method}: sidecar unreachable at ${base} (${e.message})` } };
    }
    // ★ 读**响应体**同样会断。上面那个 try 只护住了 fetch() 本身：sidecar 在 body 还没
    //   发完就关连接时，`res.text()` 抛 ECONNRESET（表现为 `TypeError: terminated`），
    //   而这行在 try 之外 ⇒ 未捕获异常一路冲出 postAcp/newSession，把整个 run 打成崩溃，
    //   上层拿不到任何可判定的 reasonCode。实测：prewarm 激活态在 `session/new` 上必现。
    //   护住之后统一收敛成可判定的 `unreachable`，与 fetch 失败同形。
    let text;
    try {
      text = await res.text();
    } catch (e) {
      // ★ 读**响应体**同样会断。上面那个 try 只护住了 fetch() 本身：sidecar 在 body 还没
      //   发完就关连接时，`res.text()` 抛 ECONNRESET（表现为 `TypeError: terminated`），
      //   而这行在 try 之外 ⇒ 未捕获异常一路冲出 postAcp/newSession，把整个 run 打成崩溃，
      //   上层拿不到任何可判定的 reasonCode。实测：prewarm 激活态在 `session/new` 上必现。
      //   护住之后统一收敛成可判定的 `unreachable`，与 fetch 失败同形。
      return { id, messages: [], text: '', status: 0, error: { code: 'unreachable', message: `${method}: sidecar closed the connection while reading the response at ${base} (${e.cause?.code ?? e.message})` } };
    }
    if (!res.ok) return { id, messages: [], text, status: res.status, error: classifyHttpError(res.status, method) };
    const messages = parseSseMessages(text);
    if (typeof onEvent === 'function') for (const m of messages) onEvent(m);
    const resp = pickResponse(messages, id);
    if (resp === null || resp === undefined) {
      // 期望的响应没来：不能静默当成成功（当初 sessionId 取成 undefined 就是这么漏过去的）
      return {
        id,
        messages,
        text,
        status: res.status,
        error: { code: 'no_response', message: `${method}: the response carried no result for id ${id}` },
      };
    }
    // ★ 这个网关把错误放在 `result.error` 里（JSON-RPC 惯例是顶层 `error`）。
    //   在这一处统一判，免得每个方法各写一遍、漏一个就变成"静默成功"。
    const rpcError = resp.error ?? resp.result?.error;
    if (rpcError !== undefined && rpcError !== null) {
      const m = typeof rpcError === 'object' ? rpcError.message : undefined;
      return {
        id,
        messages,
        text,
        status: res.status,
        error: { code: typeof rpcError === 'object' && rpcError.code !== undefined ? `rpc_${rpcError.code}` : 'rpc_error', message: `${method} failed${m === undefined ? '' : `: ${m}`}` },
      };
    }
    return { id, messages, text, status: res.status, error: null };
  }

  return {
    get base() { return base; },
    get connectionId() { return connectionId; },

    /** `POST /api/v1/acp/connect` → 换 connectionId。★ 这条路径**不**在 `/api/v1/acp` 上。 */
    async connect() {
      let res;
      try {
        res = await fetchImpl(`${base}/api/v1/acp/connect`, {
          method: 'POST',
          headers: { ...ACP_HEADERS, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        return { ok: false, error: { code: 'unreachable', message: `connect: sidecar unreachable at ${base} (${e.message})` } };
      }
      if (!res.ok) return { ok: false, error: classifyHttpError(res.status, 'connect') };
      const j = await res.json().catch(() => null);
      // ★ connectionId/sessionToken 在**顶层**，不在 data 下（曾按 data 取，得到 undefined）
      if (j?.connectionId === undefined || j?.connectionId === null) {
        return { ok: false, error: { code: 'bad_response', message: 'connect: response has no connectionId' } };
      }
      connectionId = j.connectionId;
      return { ok: true, connectionId: j.connectionId };
    },

    /** `initialize`。返回 agent 的能力集，供上层判断可用特性。 */
    async initialize() {
      const r = await postAcp('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });
      if (r.error) return r;
      const resp = pickResponse(r.messages, r.id);
      return { ...r, capabilities: resp?.result ?? null };
    },

    /** `session/new` → `{sessionId, models, modes}`。 */
    async newSession(cwd) {
      const r = await postAcp('session/new', { cwd, mcpServers: [] });
      if (r.error) return r;
      const resp = pickResponse(r.messages, r.id);
      return { ...r, ...extractSession(resp), modes: extractModes(r.messages) };
    },

    /**
     * `session/load` → 载入**已存在**的会话，返回同样的 `{sessionId, models}`。
     *
     * <p>★★★ 这是本仓续用对话的**正当路径**，不是绕过方案。依据是 `initialize` 宣告的
     * `agentCapabilities.loadSession === true`（真机读到），加上两项实测：
     *
     * <p>1) **id 不变**：跨连接 load 一个已存在会话，事件里的 `sessionId` 仍是原 id，
     *    所以后续 `set_mode` / `set_model` / `prompt` 都能继续用**用户填的那个 id**。
     *    这正是 `boundSessionId` 名字该有的语义——它不再是"绕过 new 的替代品"。
     * <p>2) **能力表会回传**：load 的 `result` 帧带 `models.availableModels`，
     *    且事件流里下发 `config_option_update`（权限模式表）+ 各自的 `currentValue`。
     *    所以"载入"顺带把**模型清单、倍率真源、当前权限**一次性拿齐。
     * <p>3) **状态跨连接持久**：在连接 A 上 `set_mode plan`，连接 B 上 load 回来
     *    `currentValue` 仍是 `plan` ⇒ mode 是**会话级**属性，不是连接级，
     *    因此"载入既有对话"不会把用户已经设好的权限/模型打回默认。
     *
     * <p>★ 与 `newSession` 的关键差别：`session/new` 会把新建会话顶成 GUI 的活跃会话
     *   （真机复现 4 次），而 `load` 不新建，因此不抢 GUI。这条是选它做默认路径的原因。
     */
    async loadSession(sessionId, cwd) {
      const r = await postAcp('session/load', { sessionId, cwd, mcpServers: [] });
      if (r.error) return r;
      const resp = pickResponse(r.messages, r.id);
      const s = extractSession(resp);
      // ★ 服务端在 `result.sessionId` 缺失时会回显请求里的 id；优先用回显值，
      //   但**不覆盖**用户配置的 id —— load 认不出这个会话时必须报错，不能悄悄改名。
      return { ...r, ...s, sessionId: s.sessionId ?? sessionId, modes: extractModes(r.messages) };
    },

    /**
     * `session/set_mode` —— 设权限模式。
     *
     * <p>★★ 权限模式的**唯一真源**：模式是 `session/new` / `session/load` 时随
     * `config_option_update` 事件下发的下拉项，**不是**我们能自己编的字符串。
     * 8 个值：`default`(Always Ask) / `acceptEdits` / `plan` / `auto` / `dontAsk` /
     * `bypassPermissions` / `fullAccess`(Full Access) / `delegate`。
     *
     * <p>★ 走**别的**方法名都会失败（真机逐个试过）：`session/set_config_option` 回
     * "Invalid params"；`session/configure`、`session/set_permission_mode` 回 "Method not found"。
     *
     * <p>★ `dontAsk` **不等于**"完全权限"：同一会话下它让 Bash 被拒
     *   （"Permission to use Bash has been denied because CodeBuddy is running in dontAsk mode"），
     *   而文件读写工具没被拒。权限是**按工具类别**判的，不是一个布尔值。
     *   真要"完全权限"只能用 `fullAccess`。
     *
     * <p>★★ **返回值里的 `modeId` 只是"我收到了"，不是"它生效了"。** 本方法成功时
     *   返回的就是回传值，恒等于入参 —— 它无法区分"设上了"和"被丢了"。
     *   真机实测（2026-09-28）：本插件**自己用 `session/new` 建的会话**上，`set_mode`
     *   是真生效的（`fullAccess` 在另一条连接上回读仍是 `fullAccess`，立刻、3s 后、
     *   跑完一轮之后都是）；但在**已存在的会话**上，只有回传没有生效，回读仍是原值。
     *   ⇒ 判定必须由**另一条连接**回读 `config_option_update` 得出，见
     *   `dispatch.js` 的 `verifyPermissionMode`；本方法的返回值只能用来判"请求送到了"。
     *
     * @returns {Promise<{error: object|null, modeId: string|null}>}
     */
    async setMode(sessionId, modeId) {
      if (typeof modeId !== 'string' || modeId === '') {
        return { error: { code: 'mode_invalid', message: 'permission mode id is empty' }, modeId: null };
      }
      const r = await postAcp('session/set_mode', { sessionId, modeId });
      if (r.error) {
        return { error: { code: 'mode_unavailable', message: r.error.message }, modeId: null };
      }
      const resp = pickResponse(r.messages, r.id);
      const current = resp?.result?.currentModeId;
      return { error: null, modeId: typeof current === 'string' ? current : modeId };
    },

    /** `session/set_model`。★ 不成功就报错：拿着旧模型去跑是静默的错账。 */
    async setModel(sessionId, modelId) {
      const r = await postAcp('session/set_model', { sessionId, modelId });
      if (r.error) {
        // ★ 归一成 model_unavailable：上层要据此选 reason code（MODEL_UNAVAILABLE），
        //   让"模型名写错"不要伪装成一坨 JSON-RPC 数字。
        const looksLikeModel = /model|模型/i.test(r.error.message);
        return looksLikeModel ? { ...r, error: { code: 'model_unavailable', message: r.error.message } } : r;
      }
      const resp = pickResponse(r.messages, r.id);
      if (resp === null || resp === undefined || resp.result === undefined || typeof resp.result !== 'object') {
        return { ...r, error: { code: 'model_unavailable', message: `set_model(${modelId}) did not take effect` } };
      }
      return { ...r, error: null, modelId: resp.result.modelId ?? modelId };
    },

    /**
     * `session/prompt` —— 跑一轮。
     *
     * ★ **回执在 POST 响应体里**，不是另开一条 SSE 事件。实测去等 `session_end` 事件会永远挂住
     *   （真机白等 180s）。一次 prompt 的完整生命周期就在这个响应体里。
     *
     * @returns {Promise<{receipt: object|null, text: string, phases: string[],
     *   tools: {count: number, names: string[]}, requestId: string|null}>}
     */
    async prompt(sessionId, promptText, { signal, workspace } = {}) {
      if (signal?.aborted) return { receipt: null, text: '', phases: [], tools: { count: 0, names: [] }, requestId: null, error: { code: 'aborted', message: 'aborted before dispatch' } };
      const blocks = buildPromptBlocks(promptText, workspace);
      const r = await postAcp('session/prompt', { sessionId, prompt: blocks });
      if (r.error) {
        return { receipt: null, text: '', phases: [], tools: { count: 0, names: [] }, requestId: null, error: r.error };
      }
      const resp = pickResponse(r.messages, r.id);
      const receipt = extractReceipt(resp);
      return {
        receipt,
        text: extractAssistantText(r.messages),
        phases: extractPhases(r.messages),
        tools: extractToolCalls(r.messages),
        requestId: receipt?.requestId ?? null,
        error: receipt === null ? { code: 'no_receipt', message: 'prompt: the response carried no result (the run may have been cut off)' } : null,
      };
    },
  };
}
