/**
 * ACP 通道的**纯解析层**：把网关吐出的原始文本/SSE 消息，变成"回执 / 正文 / 阶段 / 工具调用"四个可断言的结论。
 *
 * <p>★ 为什么要单独拆一层：本文件**不碰网络、不碰 fs、不碰进程**，全部是 `(string | object) -> object`。
 * 插件改了代码要重启 3080 才能验，而这里面的每一条判据都能在 `test/gateway-receipt.test.js`
 * 里离线跑 —— **把不能立刻验证的 I/O 面压到最薄，把能立刻验证的判据全提上来**。
 *
 * <p>★ 最反直觉的一条：网关的 POST 响应体是 **SSE 格式**（`:ok\n\nevent: message\ndata: {...}`），
 * 不是 JSON。直接 `JSON.parse(response.text)` 得到 null，于是 `result` 取不到、
 * `sessionId` 变成 undefined、下一条 `session/prompt` 报 `sessionId: expected string`。
 * 这不是网关的怪癖，是它所有 ACP POST 的统一形态，{@link parseSseMessages} 是唯一的读法。
 *
 * @module host/gateway/receipt
 */

/** ACP 侧把阶段写在这里的 meta 键。 */
const PHASE_META = 'codebuddy.ai/agentPhase';
/** 助手正文分片事件名。 */
const AGENT_CHUNK = 'agent_message_chunk';

/**
 * 把 SSE 响应体拆成 JSON 消息数组。
 *
 * <p>只取 `data:` 行。`event:` / `:ok` / 空行是 SSE 框架，与结论无关。
 * 单行 `JSON.parse` 失败（半包、注释行、非 JSON 的 data）**跳过而不是抛**——
 * 一条脏行不该让整次运行的回执丢失。
 *
 * @param {string} text SSE 响应体全文
 * @returns {object[]} 可解析的 JSON-RPC 消息，按出现顺序
 */
export function parseSseMessages(text) {
  if (typeof text !== 'string' || text === '') return [];
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (raw === '') continue;
    try {
      const msg = JSON.parse(raw);
      if (msg !== null && typeof msg === 'object') out.push(msg);
    } catch {
      /* 脏行跳过：不让一条坏 data 毁掉整次回执 */
    }
  }
  return out;
}

/**
 * 从流里挑出属于本次请求的那条 JSON-RPC 响应。
 *
 * <p>★ 为什么要按 `id` 挑：一条 `session/prompt` 的响应体里同时装着**本次运行产生的全部事件**
 * （`session/update` 流），按顺序取最后一条会拿到 update 而不是 result。
 *
 * @param {object[]} msgs {@link parseSseMessages} 的产物
 * @param {string|number} id 发起时用的 JSON-RPC id
 * @returns {object|null} 命中的消息；没有则 null
 */
export function pickResponse(msgs, id) {
  if (!Array.isArray(msgs)) return null;
  return msgs.find((m) => m && m.id !== undefined && String(m.id) === String(id)) ?? null;
}

/**
 * 抽完成回执。
 *
 * <p>★ **回执是 `session/prompt` 的 RPC result，不是流里的某个 SSE 事件。**
 * 曾按"等 `session_end` 事件"的思路写了 180 秒超时，实测该事件**根本不会来**——
 * 判完成只能看 result。`stopReason` 与 `_meta.outcome` 都要收：前者是 ACP 标准，后者才是
 * CodeBuddy 自己的成败结论（真机见过 `stopReason: end_turn` 同时 `outcome: SUCCESS`）。
 *
 * @param {object|null} response {@link pickResponse} 的产物
 * @returns {null|{stopReason: string|null, finishReason: string|null, outcome: string|null,
 *   traceId: string|null, requestId: string|null, conversationRequestId: string|null,
 *   userMessageId: string|null, timestamp: string|null, succeeded: boolean}}
 */
export function extractReceipt(response) {
  const result = response?.result;
  if (result === null || typeof result !== 'object') return null;
  const meta = (result._meta !== null && typeof result._meta === 'object') ? result._meta : {};
  const outcome = typeof meta['codebuddy.ai/outcome'] === 'string' ? meta['codebuddy.ai/outcome'] : null;
  const stopReason = typeof result.stopReason === 'string' ? result.stopReason : null;
  return {
    stopReason,
    finishReason: typeof meta['codebuddy.ai/finishReason'] === 'string' ? meta['codebuddy.ai/finishReason'] : null,
    outcome,
    traceId: typeof meta['codebuddy.ai/traceId'] === 'string' ? meta['codebuddy.ai/traceId'] : null,
    // ★ requestId 在**下发被拒时也会出现**，可当幂等键（真机 2026-09-28 观察到）。
    //   ★ B1：`requestId ≠ sessionId` —— requestId 是**单次 `session/prompt` 的 RPC 幂等键**，
    //     与"落在哪条对话"无关；对账（回执 ↔ 会话 ↔ 落库）唯一可用的键是 dispatch 侧的
    //     `sessionId`（见 dispatch.js `resolved` + gateway-run.js 白名单 + run.js noteRun）。
    //     拿 requestId 去 sessions 表里查必然零命中，那不是"会话没创建"，是查错了键。
    requestId: typeof meta['codebuddy.ai/requestId'] === 'string' ? meta['codebuddy.ai/requestId'] : null,
    conversationRequestId: typeof meta['codebuddy.ai/conversationRequestId'] === 'string'
      ? meta['codebuddy.ai/conversationRequestId'] : null,
    userMessageId: typeof result.userMessageId === 'string' ? result.userMessageId : null,
    timestamp: typeof meta.timestamp === 'string' ? meta.timestamp : null,
    // 成败双判：outcome 优先（CodeBuddy 自己的结论），缺它才退回 stopReason。
    succeeded: outcome !== null ? outcome === 'SUCCESS' : stopReason === 'end_turn',
  };
}

/**
 * 拼助手正文。
 *
 * <p>正文不是回执里的一个字段，而是散落在流里的一串 `session/update`
 * （`sessionUpdate === 'agent_message_chunk'`，取 `update.content.text`）。
 *
 * @param {object[]} msgs
 * @returns {string} 拼接结果；没有分片则空串
 */
export function extractAssistantText(msgs) {
  if (!Array.isArray(msgs)) return '';
  let out = '';
  for (const m of msgs) {
    const u = m?.params?.update;
    if (u?.sessionUpdate !== AGENT_CHUNK) continue;
    const c = u.content;
    if (c === null || typeof c !== 'object') continue;
    out += typeof c.text === 'string' ? c.text : JSON.stringify(c);
  }
  return out;
}

/**
 * 阶段轨迹（去重保序）：`idle -> preparing -> model_requesting -> model_streaming -> model_done`。
 *
 * <p>用于回答"卡在哪一步"，不参与成败判定。阶段值来自 `update._meta['codebuddy.ai/agentPhase'].phase`。
 *
 * @param {object[]} msgs
 * @returns {string[]}
 */
export function extractPhases(msgs) {
  if (!Array.isArray(msgs)) return [];
  const seen = new Set();
  const out = [];
  for (const m of msgs) {
    const p = m?.params?.update?._meta?.[PHASE_META]?.phase;
    if (typeof p !== 'string' || p === '' || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * 工具调用面：这次运行碰了哪些工具。
 *
 * <p>不判成败，只作证据（"它到底用没用工具"）。
 *
 * @param {object[]} msgs
 * @returns {{count: number, names: string[]}}
 */
export function extractToolCalls(msgs) {
  if (!Array.isArray(msgs)) return { count: 0, names: [] };
  const names = [];
  for (const m of msgs) {
    const kind = m?.params?.update?.sessionUpdate;
    if (typeof kind !== 'string' || !/tool_call|tool_use/.test(kind)) continue;
    const title = m.params.update.title ?? m.params.update.name ?? m.params.update.rawInput?.command;
    names.push(typeof title === 'string' ? title : kind);
  }
  return { count: names.length, names };
}

/**
 * 从 `session/new` 的 result 里取模型清单与**本次会话实际生效的积分倍率**。
 *
 * <p>★ **"接口给的是权威值"这句已经不成立**（2026-09-28 真机推翻，别再引用）：
 *   同一个真 sidecar（pid 26080 / 127.0.0.1:53349）上，
 *   `session/new` 的 `result.models.availableModels` 回的是 **`[]`**，
 *   而同一时刻 `modelId: 'hy3-x'` 下发**照常成功**。
 *   ⇒ 空的清单不代表"没有权限/没配额"，更不代表**不能**拿它当可用性判据。
 *   三条"权威源"互相矛盾的事已经记在案（`04-docs/RECON-CREDITS-QUOTA.md:65`、
 *   `README.md:233` D-2），要判"这个模型我能不能用"，**唯一可靠的是实际发一次**。
 *   倍率同理：下面的 `credits` 字段在清单为空时恒为 null，
 *   展示层必须对此有分支，不能把 null 当 0.00（"免费"）渲染。
 *
 * <p>★ 倍率是**字符串** `'x0.00'`。`x0.00` 就是不扣分（真机：同一提示词 `fast-model` x0.21 扣 0.00，
 * `kimi-k3-1` x1.62 扣 0.30）。但它可能是限时促销（本机 `hy3` x0.00 有效期到 2026-10-31），
 * **对外展示必须带有效期，不能当永久属性**。
 *
 * @param {object|null} response `session/new` 的 {@link pickResponse} 产物
 * @returns {{sessionId: string|null, models: {modelId: string, name: string|null, credits: string|null}[]}}
 */
export function extractSession(response) {
  const result = response?.result;
  const models = [];
  for (const m of result?.models?.availableModels ?? []) {
    if (typeof m?.modelId !== 'string' || m.modelId === '') continue;
    models.push({
      modelId: m.modelId,
      name: typeof m.name === 'string' ? m.name : null,
      credits: typeof m._meta?.credits === 'string'
        ? m._meta.credits
        : (typeof m.description === 'string' ? m.description : null),
    });
  }
  return { sessionId: typeof result?.sessionId === 'string' ? result.sessionId : null, models };
}

/**
 * 解析权限模式表。
 *
 * <p>★ 模式**不是**我们自己列的常量表，而是 `session/new` / `session/load` 期间
 * 由服务端通过 `config_option_update` 事件下发的下拉项（真机形状）：
 *
 * <pre>
 * { sessionUpdate: "config_option_update",
 *   configOptions: [{ type: "select", id: "mode", name: "Permission Mode",
 *                     category: "mode", currentValue: "default",
 *                     options: [{ value: "default", name: "Always Ask" }, ...] }] }
 * </pre>
 *
 * <p>所以展示层的选项**必须**来自这里，不能来自本地硬编码——`src/host/config/schema.js`
 * 里那份是 spawn 路由的 CLI flag 名，两者是**不同的集合**（CLI 侧缺 `fullAccess` 和 `delegate`）。
 * 当初就是把这张表当成"唯一权威"才让 UI 少了两个选项。
 *
 * <p>★ `currentValue` 是**载入时该会话的真实权限**，所以它同时是"用户当前在哪个权限下"
 * 的权威值，也能在设置页如实回显（而不是猜一个 default 盖掉）。
 *
 * @param {object[]} messages {@link parseSseMessages} 的产物
 * @returns {{id: string, name: string|null, description: string|null,
 *   currentValue: string|null, options: {value: string, name: string|null, description: string|null}[]}|null}
 */
export function extractModes(messages) {
  let best = null;
  for (const msg of messages ?? []) {
    const update = msg?.params?.update;
    if (update?.sessionUpdate !== 'config_option_update') continue;
    for (const opt of update.configOptions ?? []) {
      if (opt?.id !== 'mode' && opt?.category !== 'mode') continue;
      const options = [];
      for (const o of opt.options ?? []) {
        if (typeof o?.value !== 'string' || o.value === '') continue;
        options.push({
          value: o.value,
          name: typeof o.name === 'string' ? o.name : null,
          description: typeof o.description === 'string' ? o.description : null,
        });
      }
      // ★ 同一次握手可能下发多次（每次 new/load 各一次）。取**选项最全**的那次，
      //   避免半包事件把可选值砍掉几个。
      if (best === null || options.length > best.options.length) {
        best = {
          id: 'mode',
          name: typeof opt.name === 'string' ? opt.name : null,
          description: typeof opt.description === 'string' ? opt.description : null,
          currentValue: typeof opt.currentValue === 'string' ? opt.currentValue : null,
          options,
        };
      }
    }
  }
  return best;
}

/**
 * 倍率串 → 数值。
 *
 * <p>★ **不另写一份**：解析口径由 `launch/credit-anchor.js` 的 `parseMultiplier` 唯一定义
 * （`'x0.21'` / `'x0.06 credits'` / `'X5.00 credits'` 都吃，取不到返回 `null`）。
 * 这里只做转出，避免出现第二个正则随时间分叉——本仓已经吃过"同一语义两处实现"的亏。
 *
 * <p>★ `null` 表示"读不到"，**不是 0**。把读不到当成免费，是 {@link credit-anchor.js} BASIS
 * 伪证记录里最贵的一条教训。
 *
 * @type {(credits: unknown) => number|null}
 */
export { parseMultiplier } from '../launch/credit-anchor.js';
