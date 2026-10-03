/**
 * 子智能体回传面的**告示与回执** —— 一次委派跑完之后，主控模型与用户各自该看见的那几行。
 *
 * <p>★ 这些函数是 `llm-adapter.js` 被删除后**唯一**活下来的东西，为什么值得单独一个文件 ★
 *
 * <p>它们回答的都是"报告里没写、但读者必须知道"的问题：权限档到底生效没有（{@link permissionNote}）、
 * 这一轮是续接还是新开对话、模型是谁选的（{@link receiptNote}）、任务卡在哪一级
 * （{@link failureDetailFor}）。这些事实**只存在**于 `dispatch.run()` 的返回值里，
 * 而那个返回值除了本插件没有任何人看得到 —— 不写进正文就等于没有。</p>
 *
 * <p>★ 为什么走**正文**，而不是自定义字段 ★</p>
 *
 * <p>dsh 的 `StreamChunk` / `FinishReason` 是**闭集**：`finish` 帧只有 `reason` 与 `replayState`
 * 两个键，`FinishReasonMap` 的五个成员各自没有预留位，`LlmFailure` 更是逐字段校验。
 * 想在联合类型外面硬加键，就是往宿主词表外塞自定义字段：宿主一次升级就能把它悄悄吃掉，
 * 而本仓还测不出来。正文是 dsh 侧既有的通路 —— 正文 → `assistant/message` →
 * `finalAssistantOutput` → `runOutcome` 的 `{status:'completed', result}` ⇒
 * 主控模型看得见、`subagent` 工具的回传看得见。</p>
 *
 * <p>约束：本文件属于 packages 下的 src（CI ② 扫描范围）—— 不得出现裸进程出口字样。</p>
 *
 * @module host/subagent/notes
 */

/**
 * 本插件拥有的子智能体 provider 路由 id。
 *
 * <p>★ 与 `provider.js` 的注册 id 是**同一个字符串**（`providerInfo().id` 必须逐字等于它）。</p>
 */
export const WORKBUDDY_PROVIDER_ID = 'workbuddy';
/** GUI / 日志里显示的名字。 */
export const WORKBUDDY_PROVIDER_NAME = 'WorkBuddy';

/**
 * 判定为"非交互、不会把子智能体挂死"的权限档。
 * 只有这两个进白名单：`bypassPermissions`（跳过一切确认）与 `fullAccess`（完整访问）。
 */
export const NON_INTERACTIVE_MODES = Object.freeze(['bypassPermissions', 'fullAccess']);
/** 白名单为空 / 配了交互档时，强制落到的档。见 {@link effectiveSessionMode}。 */
export const FORCED_NON_INTERACTIVE_MODE = 'bypassPermissions';

/**
 * 把配置里的 `sessionMode` 折成一个**保证非交互**的档。
 *
 * 为什么必须强制，而不是"配了就尊重"：
 *   子智能体跑起来时**面前没有人**。真机实测（见 `src/host/gateway/dispatch.js` set_mode 段）记着
 *   `dontAsk` 会把 Bash 直接拒掉、`default` 会永远挂着。两种失败都不该由用户来兜底。
 *
 * 逐档判定（其余一律强制 `bypassPermissions`）：
 *   - 空串 / `''`（= 继承）        → 强制。继承到的默认就是 `Always Ask`。
 *   - `default`（Always Ask）       → 强制。有人点才算完 ⇒ 必然挂死。
 *   - `acceptEdits`                 → 强制。改文件不问，跑命令仍然要问。
 *   - `dontAsk`                    → 强制。实测 Bash 被直接拒，子智能体等于什么都做不了。
 *   - `plan`                       → 强制。只读，子智能体失去唯一能做的事。
 *   - `auto` / `delegate`           → 强制。两者的真实语义在真机上未验证，不拿它赌。
 *   - 不认识的值                    → 强制。宁可退回确定能跑通的档。
 *   - `bypassPermissions` / `fullAccess` → 原样尊重（用户显式选的）。
 *
 * @param {unknown} configured 配置里的 `sessionMode` 原值。
 * @returns {{mode: string, forced: boolean, configured: string, why: string}}
 */
export function effectiveSessionMode(configured) {
  const raw = typeof configured === 'string' ? configured.trim() : '';
  if (NON_INTERACTIVE_MODES.includes(raw)) {
    return {
      mode: raw,
      forced: false,
      configured: raw,
      why: `configured non-interactive mode ${raw}`,
    };
  }
  const why = raw === ''
    ? 'sessionMode is empty (inherits Always Ask), which hangs with no human present'
    : `sessionMode ${raw} is interactive or has unresolved semantics for a headless subagent`;
  return {
    mode: FORCED_NON_INTERACTIVE_MODE,
    forced: true,
    configured: raw,
    why,
  };
}

/** 正文尾部那段"权限没生效"告示的行首标记。 */
export const PERMISSION_NOTE_MARK = '[workbuddy-subagent: permission]';

/**
 * 权限"没被确认"时的正文告示。
 *
 * ★ 为什么必须让它出现在**正文**里而不是只落在内部字段 ★
 * 子智能体的产出就是正文。`dispatch.run()` 会在 `permission.confirmed === false` 时
 * 带回"我请求的权限档没被回显确认"这件事，若只把它记在内部字段里，
 * 用户读到的是一段漂亮的执行报告，而"我要求的权限其实没生效"在别处无声蒸发。
 *
 * ★ 措辞为什么说"没被确认"而不是"没生效" ★
 * dispatch 读的是 `session/load` 回显的 `currentValue`；在自建会话上 `set_mode` 是真生效的，
 * 所以两种场合含义不同 —— 告示里同时给出读到的实际值，不替读者下结论。
 *
 * @param {object|null} permission `dispatch.run()` 返回值里的 `permission`。
 * @returns {string} 空串 = 无需告示。
 */
export function permissionNote(permission) {
  const requested = typeof permission?.requested === 'string' ? permission.requested.trim() : '';
  if (requested === '') return '';
  if (permission?.confirmed === true) return '';
  const effective = typeof permission?.effective === 'string' && permission.effective !== ''
    ? permission.effective
    : '(unknown)';
  return `${PERMISSION_NOTE_MARK} the requested ACP permission mode "${requested}" was NOT confirmed to be in effect `
    + `(the session reports "${effective}"). dsh-side approval does not gate this child: its generation runs `
    + 'inside the WorkBuddy desktop session under that ACP mode.';
}

/** 正文尾部那段"任务回执"的行首标记。取方能按行定位，不需要猜哪一行是插件加的。 */
export const RECEIPT_NOTE_MARK = '[workbuddy-subagent: receipt]';

/** 阶段轨迹里"最后到达的那一级"。轨迹空 ⇒ 空串（**不是** `'idle'`，那会凭空造一级）。 */
export function lastPhaseOf(phases) {
  if (!Array.isArray(phases)) return '';
  for (let i = phases.length - 1; i >= 0; i -= 1) {
    const p = phases[i];
    if (typeof p === 'string' && p !== '') return p;
  }
  return '';
}

/** 取一个非空字符串，否则回退值。用来读 report 上那些"可能压根没这条键"的字段。 */
function str(value, fallback = '') {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

/**
 * 把 `dispatch.run()` 的回执压成**一行**、可直接进正文的尾注。
 *
 * ★ 什么时候**不**写这一行 ★
 * 既没有 `receipt` 也没有 `phases` 时返回空串。没有轨迹可报却硬写一行，
 * 产出的正是"用无关的成功信号冒充承诺兑现"—— 读者会以为看到了回执，其实那行里没有任何回执。
 *
 * ★ `automation` 传输面靠 `phases` 过这道闸 ★
 * 它没有 ACP 的 `receipt`（不编，见 `./execute.js`），但点火那一趟一定会走
 * `db-open → awaiting-scheduler-tick → running`，所以 `phases` 必然非空 ——
 * `session=` 与下面的 `continuity=` 尾注因此一定会被带上。
 *
 * @param {object|null} report `dispatch.run()` 的返回值
 * @returns {string} 一行尾注；无内容时 `''`
 */
export function receiptNote(report) {
  const receipt = report?.receipt ?? null;
  const phases = Array.isArray(report?.phases) ? report.phases.filter((p) => typeof p === 'string' && p !== '') : [];
  // ★ `continuity` 那一支也要过这道闸（自动化路必然带 `phases`，所以实践上不受影响；
  //   这里把它算进去是为了**形状变了也不会沉默**）。回退轮的 `fallbackReason` 同理：
  //   一个只带"追发失败回退了"这一件事的回执，同样不该被这道闸吞成空串。
  if (receipt === null && phases.length === 0 && str(report?.continuity) === '' && str(report?.usedModelId) === ''
    && str(report?.sessionMemory) === '' && str(report?.fallbackReason) === ''
    && !(report !== null && typeof report === 'object' && 'requestedModelId' in report)) return '';

  const bits = [];
  const sessionId = str(report?.sessionId);
  // ★ `sessionId` + `origin` 是一对，缺一半就没有意义：
  //   只报 id 不报来源，读者无法判断"权限提升成不成立"（dispatch.js:573-576 的真机结论：
  //   `set_mode` 只在**自建**会话上真生效，在已有会话上只有回传）。
  if (sessionId !== '') bits.push(`session=${sessionId}`);
  // ★ `origin` 词表三个值，各有出处：
  //   `new`     —— 点火轮：桌面端调度器按 automations 行新建（dispatch.js:573-576 的真机结论：set_mode
  //                只在自建会话上真生效，所以"是不是自建"必须可见）；
  //   `loaded`  —— ACP `session/load` 绑定的既有会话（gateway 时代；保留作历史兼容）；
  //   `resumed` —— ★ 2026-10-03 起合法（Track A 追发接入子智能体面）：本轮被追加进**既有**的
  //                WorkBuddy 对话（`execute.js` 的追发分支）。此前它被当负控（"认不出不得回显"），
  //                随词表扩容翻转为正控 —— 认得出的值必须回显，否则追发轮在正文里读不出
  //                "接在哪条对话上"。其余认不出的值仍然一律不回显（那条纪律本身不变）。
  if (report?.sessionOrigin === 'new' || report?.sessionOrigin === 'loaded' || report?.sessionOrigin === 'resumed') {
    bits.push(`origin=${report.sessionOrigin}`);
  }
  // ★ 会话亲和**没有**成立，或成立的方式与用户想的不同 —— 三种都要说清，不能一律叫"新对话"。
  //   `same-conversation`                  真续接：`session/load` 同一条 WorkBuddy 对话（模型自己带着上文）
  //   `new-conversation-with-replayed-history` 网关续不上（无 sidecar/鉴权不过）：开了新对话，
  //                                          但把此前几轮原样带进了 prompt
  //   `fresh-conversation-per-round`       真的每轮新对话（没有 sessionKey ⇒ 无法归属到同一个任务）
  const CONT_TEXT = {
    'same-conversation': 'same-conversation (this round was appended to the SAME WorkBuddy conversation — the model carries its own context)',
    'new-conversation-with-replayed-history': 'new-conversation-with-replayed-history (the gateway could not continue the previous conversation, so a new one was opened and the earlier rounds were replayed into the prompt verbatim — this is NOT a true continuation)',
    'fresh-conversation-per-round': 'fresh-conversation-per-round (no session key, so this delegation cannot be attributed to a task and every round opens a new conversation)',
  };
  const cont = str(report?.continuity);
  if (cont !== '' && CONT_TEXT[cont] !== undefined) bits.push(`continuity=${CONT_TEXT[cont]}`);
  // ★ 追发位（★ 2026-10-03 新增，Track A 追发成功时出现；与 run.js lastRun 的 followUp 同源同值）：
  //   `follow-up=<channel> in <ms>` —— 这一轮没点火、是追加进既有对话的，耗时多少毫秒。
  //   主控模型据此能分辨"等了 9 秒的真追发"与"又开了一条新对话"。
  const fu = report?.followUp;
  if (fu !== null && typeof fu === 'object' && str(fu.channel) !== '' && Number.isFinite(fu.elapsedMs)) {
    bits.push(`follow-up=${str(fu.channel)} in ${Math.max(0, Math.round(fu.elapsedMs))}ms`);
  }
  // 记不住对话 id = 下一轮会静默开新对话。这件事必须抢在用户自己发现之前说出来。
  const mem = str(report?.sessionMemory);
  if (mem !== '') bits.push(`session-memory=${mem} (the conversation id could NOT be remembered, so the next round will start a new one)`);
  // ★ 回退位（★ 2026-10-03 新增）：追发失败 ⇒ 该轮照旧点火成了新对话。指纹码必须可见 ——
  //   否则"为什么这轮没接上前情"只剩一个没有归因的 `fresh-conversation-per-round`。
  const fallback = str(report?.fallbackReason);
  if (fallback !== '') {
    bits.push(`fallback=${fallback} (the follow-up attempt failed with this code, so this round was ignited as a NEW conversation instead)`);
  }
  // ★★★ 模型：**请求了什么** 与 **实际跑了什么** 必须同时在场 ★★★
  //   实测（2026-10-01 12:48）：没人指定模型 ⇒ 写进去 `model_id=NULL` ⇒ 桌面端落它自己的默认
  //   （快速 / fast-model），会话上 `model` 记成 null。用户只看到"快速"，
  //   而我们从没选过 —— "我没设"被读成了"我设成快速"。这里把两者并排写出来。
  //   ★ 只在**报告本身带模型事实**时才写这一段（`requestedModelId` 这个键存在）。
  //   否则网关那一路也会被贴上"没人选"的标签 —— 那边是 dispatch 自己管模型，
  //   本插件压根没参与决策，那句话是假的。
  if (report !== null && typeof report === 'object' && 'requestedModelId' in report) {
    const usedModel = str(report.usedModelId);
    if (usedModel !== '') bits.push(`model-used=${usedModel}`);
    const askedModel = str(report.requestedModelId);
    if (askedModel === '') {
      bits.push('model-chosen-by=NOBODY (this plugin has no model configured, so the WorkBuddy side fell back to '
        + 'its own default — read "I did not choose" as "I did not choose", not as "I chose that default") — '
        + 'set the model field in the WorkBuddy settings card to pin one');
    } else {
      bits.push(`model-requested=${askedModel}`);
    }
  }
  // ★ 推理强度同上：请求了什么与实际跑了什么并排（requestedEffort/effectiveEffort），只在报告带该键时写。
  //   无请求 ⇒ 不写"NOBODY"（强度未指定是合法态，由桌面端用自身默认，不算"没人选"的事故）。
  if (report !== null && typeof report === 'object' && ('requestedEffort' in report || 'effectiveEffort' in report)) {
    const askedEff = str(report.requestedEffort);
    const usedEff = str(report.effectiveEffort);
    if (askedEff !== '' || usedEff !== '') {
      if (askedEff !== '') bits.push(`effort-requested=${askedEff}`);
      if (usedEff !== '') bits.push(`effort-used=${usedEff}`);
    }
  }
  if (phases.length > 0) bits.push(`phases=${phases.join('>')}`);
  if (receipt !== null) {
    bits.push(`stopReason=${str(receipt.stopReason, '?')}`);
    bits.push(`outcome=${str(receipt.outcome, '?')}`);
    // ★ 只带 `traceId`（CodeBuddy 自己的那一条）。`receipt` 里另有 `requestId` /
    //   `conversationRequestId` / `userMessageId` —— 那是**别的**系统的幂等键，
    //   抄进给主控模型看的正文只会增加跨系统串号的机会，排障用不上。
    const traceId = str(receipt.traceId);
    if (traceId !== '') bits.push(`traceId=${traceId}`);
  }
  return bits.length === 0 ? '' : `${RECEIPT_NOTE_MARK} ${bits.join(' · ')}`;
}

/**
 * 失败面的一句话诊断：原因 + 错误消息 + **卡在哪一阶段**。
 *
 * ★ 阶段轨迹为什么必须进这句话 ★
 * `phases` 是"任务卡在哪一步"的**唯一**数据来源，没有第二处（`tools/gateway-run.js`
 * 只把 `phases` 挂在 `gateway` 附加字段上，那份不进作业输出）。
 * 不带它，用户拿到的是一句"run failed"，只能一次次重发同样的任务。
 *
 * ★ 成败的矛盾也必须逐字带出 ★
 * 真机见过 `stopReason: end_turn` 同时 `outcome: FAILED_MODEL_REQUEST`。
 * `receipt.succeeded` 用 `outcome` 优先判（`gateway/receipt.js:94`），于是这类矛盾
 * 会被判成失败——这是对的。但**为什么**判成失败只有这两个字段能回答，所以都带上。
 *
 * @param {object|null} report `dispatch.run()` 的返回值
 * @returns {string}
 */
export function failureDetailFor(report) {
  const reason = str(report?.reason, 'unknown');
  const message = str(report?.error?.message, 'no detail');
  const phase = lastPhaseOf(report?.phases);
  // ★ 空轨迹要**说"空"**，不能默默省略：省掉之后，"从没走到任何阶段"与
  //   "走到了某一级但那级没上报"读起来一模一样，而这两种的处置完全不同。
  const where = phase === '' ? 'no phase was ever reached' : `last phase reached: ${phase}`;
  const receipt = report?.receipt ?? null;
  const verdict = receipt === null
    ? ''
    : ` · receipt: stopReason=${str(receipt.stopReason, '?')} outcome=${str(receipt.outcome, '?')} succeeded=${str(String(receipt.succeeded), '?')}`;
  return `WorkBuddy run failed (${reason}): ${message} · ${where}${verdict}`;
}

/** 正文与告示的拼接：任一为空就只给其余的，都空就空串（不塞空白块）。 */
export function joinBody(text, ...notes) {
  const kept = notes.filter((n) => typeof n === 'string' && n !== '');
  if (text === '') return kept.join('\n\n');
  return [text, ...kept].join('\n\n');
}
