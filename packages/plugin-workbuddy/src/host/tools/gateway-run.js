/**
 * 把网关下发翻译成 dsh 的作业接口（★ `ctx.jobs.start()` 要求的那套 `{cancel, done, readOutput}`）。
 *
 * <p>★ 为什么要单独一层 ★★
 *
 * <p>`tools/run.js` 的作业收口逻辑（结算、判定、记账）是围绕 **spawn 出来的进程** 写的：
 * 读 `handle.collected`、等 `handle.done`、看退出码。网关这一路**没有进程、没有退出码** ——
 * 它是一次 HTTP 请求 + 一段 SSE 事件流。若把两套形状硬塞进同一个 `run()` 回调，
 * 每一处读流的地方都得写一遍 `handle === null ? … : …` 的分叉，而那种分叉不会被任何
 * 现有测试抓到。
 *
 * <p>所以这里做一层**同形适配**：进去是 `{prompt, cwd, modelId, signal, dispatch}`，
 * 出来是 `{cancel, done, readOutput}` + 一份**自描述**的结果。上层不用知道底下走的哪条路。
 *
 * <p>★ 阶段进度是这一路独有的东西：ACP 事件流会实时报 `codebuddy.ai/agentPhase`。
 *   长任务里"还在跑"和"卡住了"对用户是两回事，所以阶段被**实时**写进作业输出，
 *   而不是等回执出来一次性打印。
 *
 * @module host/tools/gateway-run
 */

import { REASON_CODES } from '../launch/reason-codes.js';
import { GATEWAY_REASON } from '../gateway/dispatch.js';
import { projectInstance } from '../gateway/ensure.js';
import { parseMultiplier } from '../gateway/receipt.js';

/**
 * 作业输出首行。
 *
 * ★ 网关这一路**没有 argv**。宁可写"transport=gateway"，也不拿一条编造的 argv 顶替 ——
 *   argv 是给人复核"插件到底发了什么"用的，编一条等于把复核通道堵死。
 *   sidecar 的 pid 放在终态行，因为开局那一刻还不知道会选中哪个。
 */
export function gatewayHeader({ model, cwd }) {
  return `transport=gateway · model=${model || '(sidecar default)'} · cwd=${cwd}`;
}

/**
 * 把"目标实例保障"的结论渲染成**一行**作业输出（★ 2026-09-30）。
 *
 * <p>★ 为什么这一行必须存在，而不能只靠 `noteRun` 里的机器可读字段 ★
 *   `report` 早就随 `run()` 的返回值算好了，但它原先只停在返回值上：`gateway` 白名单里没有它
 *   （`sessionOrigin` 就这么丢过一次，见下面那处注释），于是**用户和模型都看不到**
 *   「实例在不在、要不要启动」这个答案——整段保障工作在跨层时无声蒸发。
 *   而作业输出是本仓唯一**当场可读**的通道：`job_output` 一读就见，GUI 的作业卡片直接显示。
 *
 * <p>★ 措辞为什么这样切 ★
 *   成功时说"本来就在"还是"本轮拉起来的"——这是主理人问的第二句（是否要启动）。
 *   失败时必须**带上 `hint` 的一句处置动作**：只回一个 `no_sidecar` 码，
 *   等于把"该怎么办"退回去给用户自己猜。
 *
 * @param {object} r `ensure()` 的 `report`
 * @returns {string} 单行（不带换行；调用方拼行）
 */
export function instanceLine(r) {
  const d = r?.desktop ?? null;
  const wasRunning = d?.running === true;
  const didLaunch = d?.launched === true;
  const stage = typeof r?.stage === 'string' && r.stage !== '' ? r.stage : 'unknown';
  if (r?.ok === true) {
    // ★ 三个布尔里只有这两个回答得了"要不要启动"：`didLaunch` 本轮真的动手了；
    //   `wasRunning` 则说明它本来就在（`started` 的那一份）。`waited` 两者都否——
    //   桌面端开着，只是本轮轮询等到了 sidecar 出现。
    const how = didLaunch
      ? 'this run launched the desktop and waited for it'
      : (wasRunning ? 'the desktop was already open' : 'no launch was needed');
    return `[instance] ${stage} · ${how}`;
  }
  const code = typeof r?.code === 'string' && r.code !== '' ? r.code : 'unknown';
  const hint = typeof r?.hint === 'string' && r.hint !== '' ? ` · ${r.hint}` : '';
  return `[instance] failed · ${code}${hint}`;
}

/**
 * 从 sidecar 回的模型清单里取本次实际用的倍率（用来标"免费 x0.00"）。
 *
 * ★ 字段形状取自真机 `session/new` 的 `result.models.availableModels[]`：
 *   倍率在 **`_meta.credits`**（形如 `"x0.05"` 的**串**），部分条目落在 `description`。
 *   `parseMultiplier` 收的就是这种串（它要 `x` 前缀，不是裸数字）。
 */
export function multiplierOfSelected(out) {
  const list = Array.isArray(out?.models) ? out.models : [];
  const hit = list.find((m) => m?.modelId === out?.usedModelId) ?? list[0];
  if (hit === undefined) return null;
  // ★ `out.models` 是 `receipt.extractSession()` 的**已归一**产物（`{modelId, name, credits}`），
  //   不是服务端的 `availableModels` 原始条目。原来只读 `_meta.credits / description`
  //   ——那两个字段在归一之后**已经不存在**，于是真机上这里**恒为 null**，
  //   `recordRun({multiplier:null})` 静默不记倍率。
  //   ★ 单测当时全绿，是因为它喂的是**原始形状**，也就是这个函数**从没见过**的形状。
  //   `credits` 放第一位（真源口径），另两个保留兜底，万一哪天真拿到未归一的清单。
  return parseMultiplier(hit.credits ?? hit._meta?.credits ?? hit.description);
}

/**
 * 跑一轮网关下发。
 *
 * @param {{prompt: string, cwd: string, modelId?: string|null, permissionMode?: string|null,
 *   workspace?: string, createNew?: boolean|null, sessionKey?: string, signal?: AbortSignal,
 *   dispatch: {run: Function}}} req
 * @returns {{cancel: () => void, done: Promise<object>, readOutput: () => string}}
 *   `done` 的产物就是作业的 `{status, detail, exitCode, gateway}`。
 */
export function startGatewayRun({
  prompt, cwd, modelId = null, permissionMode = null, workspace = '', createNew = null,
  sessionKey = '', signal, dispatch,
}) {
  const controller = new AbortController();
  // ★ 调用方的 signal 要能真的把请求掐掉，否则"取消"只是不再读输出，任务还在烧积分。
  const onUpstreamAbort = () => controller.abort();
  if (signal !== undefined) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener?.('abort', onUpstreamAbort, { once: true });
  }

  /** 增量输出缓冲。`readOutput` 靠游标消费，语义与 spawn 路径一致（offset 语义）。 */
  let buffer = '';
  let cursor = 0;
  let headerPending = true;
  let lastPhase = '';
  const push = (line) => { buffer += `${line}\n`; };

  const done = (async () => {
    // ★ 这一层**永不 reject**：`done` 是作业收敛的唯一出口，让异常从这里逃出去会变成
    //   未处理 rejection，作业永远停在 running（比报错更坏：用户看到的是"转圈"）。
    //   上游 run.js 也兜一层，但兜底不该是唯一的防线。
    let out;
    try {
      out = await dispatch.run({
        prompt,
        cwd,
        modelId,
        permissionMode,
        workspace,
        createNew,
        // ★★★ 键必须一路透传到这里：`dispatch.run()` 靠它读 `ownSession(ownKey)`
        //   （`dispatch.js:650`）——**漏掉它，多轮的记性就整个断掉**，每轮都新开一条对话。
        ...(sessionKey !== '' ? { sessionKey } : {}),
        signal: controller.signal,
        // ★ 目标实例的结论**当场**写作业输出：`ensure()` 在下发 prompt 之前就收敛了，
        //   而 prompt 那一段才是长的一段。挂到返回值上就等于让用户对着转圈干等到整轮结束。
        onInstance: (r) => { push(instanceLine(r)); },
        onPhase: (p) => {
          // 只在**真的变了**时追加，否则同一阶段会刷出十几行
          if (p === lastPhase) return;
          lastPhase = p;
          push(`… ${p}`);
        },
      });
    } catch (err) {
      signal?.removeEventListener?.('abort', onUpstreamAbort);
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 'failed',
        detail: `${REASON_CODES.TRANSPORT_UNREACHABLE}: ${message}`,
        exitCode: 1,
        gateway: { reason: REASON_CODES.TRANSPORT_UNREACHABLE, receipt: null, tools: { count: 0, names: [] } },
      };
    }

    // ★ 权限**没生效**必须写进行业输出。只放在 `gateway` 附加字段里是不够的：那份不进作业输出，
    //   读者看不到，于是"我设了 fullAccess"就成了没人反驳的假话——而任务其实跑在 Always Ask 下。
    //
    // ★★ 措辞必须**指到能动的那个动作上**。真机实测（2026-09-28）：`set_mode` 在本插件自建的
    //   会话上是真生效的，在**已存在**的会话上只有回传、模式不变。所以同一句"没生效"，
    //   在这两种会话下的下一步完全不同——写成通用警告等于没告诉读者怎么办。
    if (out.permission !== null && out.permission !== undefined && out.permission.confirmed !== true) {
      const why = out.sessionOrigin === 'new'
        ? 'This run DID create its own conversation, so an unset mode is a genuine server-side refusal,'
          + ' not the pre-existing-conversation case — report it rather than retrying.'
        : 'Pre-existing conversations do not accept set_mode (measured 2026-09-28: a conversation this'
          + ' plugin creates does). Re-run with new_conversation: true to get a mode that actually applies.';
      push(`[!] requested permission ${out.permission.requested} was NOT applied`
        + ` · the server still has ${out.permission.effective ?? 'an unknown mode'}`
        + ' · session/set_mode answers 200 and echoes the value, so the echo proves nothing.'
        + ` · ${why}`
        + ' If a tool needs approval, expect a dialog (or a hang when nobody can click it).');
    }

    // ★ sidecar 回的形状不保证；`.trimEnd()` 上一次 undefined 就足以打穿整个作业。
    if (typeof out?.text === 'string' && out.text !== '') push(out.text.trimEnd());
    // ★ 终态行与 spawn 路径的 failureLine 同一位置：读者不用翻别处才知道成没成。
    const who = out.sidecar === null || out.sidecar === undefined ? '' : ` · sidecar pid ${out.sidecar.pid}`;
    if (out.ok) {
      push(`[ok]${who} stopReason=${out.receipt?.stopReason ?? '?'} outcome=${out.receipt?.outcome ?? '?'}`
        + ` tools=${out.tools?.count ?? 0}`);
    } else {
      push(`[failed]${who} ${out.reason ?? REASON_CODES.TASK_ERROR} · ${out.error?.message ?? 'unknown'}`);
    }

    signal?.removeEventListener?.('abort', onUpstreamAbort);

    // ★ reason 与 detail 用**同一个**兜底。给两个答案（detail 说 task_error、
    //   gateway.reason 却是 null）等于让上层替我们猜哪个是真的。
    const reason = out.ok ? null : (out.reason ?? GATEWAY_REASON.run_failed);
    const why = out.error?.message ?? 'unknown';
    // ★★ `detail` 在**成功时也必须带上回复正文**（2026-10-02 实测缺陷）★★
    //   旧写法 `detail: out.ok ? undefined : …` 只在失败时给内容，于是成功那一轮
    //   `run.js` 的 `noteRun({stdoutText: out.detail})` 记的是空 —— 回执里看不到模型说了什么。
    //   真机症状：任务 exit 0、receipt 是 SUCCESS、积分也扣了，但用户与上层读到的是
    //   **"跑完了但什么都没说"**。作业输出缓冲（`readOutput`）里有正文，可回执没有，
    //   两处不一致 ⇒ 读回执的人（状态卡、监控、审计）永远拿不到结果。
    //   ⇒ 正文进 `detail`；失败时再前置失败原因，两者都不丢。
    const reply = typeof out.text === 'string' ? out.text.trim() : '';
    const detail = out.ok
      ? (reply === '' ? '(completed with no text output)' : reply)
      : `${reason}: ${why}`;
    return {
      status: out.ok ? 'completed' : 'failed',
      detail,
      exitCode: out.ok ? 0 : 1,
      /** 附加信息（不进通知文案），供上层记账与状态路由使用。 */
      gateway: {
        reason,
        receipt: out.receipt ?? null,
        models: out.models,
        usedModelId: out.usedModelId ?? null,
        sidecar: out.sidecar ?? null,
        tools: out.tools,
        phases: out.phases,
        permission: out.permission ?? null,
        // ★ 这份 gateway 对象是**白名单**：少一个键，那个字段就在跨层时**静默消失**。
        //   `sessionOrigin` 就这么丢过一次（单测全绿——因为单测直接断言告警文案，
        //   而告警读的是 `out`，没走这层；直到真机 noteRun 里查不到才暴露）。
        //   ★ 新增 dispatch 字段时，**这里必须同步加一行**，否则等于没加。
        //   ★ 对账字段是 `sessionId`（ACP 会话 id，dispatch.js 的 `resolved.sessionId`），
        //     不是 `receipt.requestId`（见 receipt.js：requestId 是单次 prompt 的 RPC 幂等键，
        //     与会话无关，拿它去库里查必然查不到 —— HANDOFF B1）。
        sessionOrigin: out.sessionOrigin ?? null,
        // ★ d) 回执透传：sessionId/sessionRenewed/sessionPersist/recycle 必须同步穿过白名单。
        //   白名单少一行 = 跨层无声消失且不报错（sessionOrigin 丢过一次，instance 丢过一次）。
        sessionId: out.sessionId ?? null,
        sessionRenewed: out.sessionRenewed ?? '',
        sessionPersist: out.sessionPersist ?? null,
        recycle: out.recycle ?? null,
        // ★ 同一个坑，`instance` 再踩一次：白名单少一行 = 字段跨层时无声消失且不报错。
        //   走 `projectInstance`（ensure.js）而不是原样透传，是为了不让 `desktop.exe`
        //   （本机安装路径）与 `attempts` 跟着进 `lastRun`——那份每次自查都重读。
        instance: projectInstance(out.instance),
        multiplier: multiplierOfSelected(out),
      },
    };
  })();

  return {
    cancel: () => controller.abort(),
    done,
    readOutput: () => {
      const header = headerPending ? `${gatewayHeader({ model: modelId, cwd })}\n` : '';
      headerPending = false;
      const fresh = buffer.slice(cursor);
      cursor = buffer.length;
      return header + fresh;
    },
  };
}
