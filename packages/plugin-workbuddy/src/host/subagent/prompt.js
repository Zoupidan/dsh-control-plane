/**
 * 子智能体任务文本的下发整形 —— 把 seam 的 `ContentBlock[]` 压成网关 `run()` 认的那一个字符串。
 *
 * <p>★ 为什么不放在 provider.js 里顺手 `join('')` ★
 *
 * <p>`SubagentStartRequest.prompt` 是 `ContentBlock[]`（可含非文本块），而
 * `gateway/dispatch.js` 的 `run()` 入参是 `prompt: string`——两者之间必须有一步**显式**转换。
 * 惯用写法是 `.map(b => b.text).join('')`，它对**纯文本**输入是对的，也正是因此在真机上
 * 一直是对的：唯一会发非文本块的入口是 `dsh-tool-subagent`，而它的构造是
 * `prompt: [{ type: 'text', text: args.prompt }]`（`dsh-tool-subagent/lib/index.js:511-514`）——
 * 别的 provider（in-process 那几个）直接把块喂给本地 Agent，**不需要这一步**。
 * 于是"图块/工具回执块被静默压成 `undefined` 文本"这一类缺陷，在只有 in-process provider 的世界里
 * 不可能暴露。一旦本插件这条 out-of-process 路成为第一个需要转换的调用方，它就暴露了。
 *
 * <p>★ 处置：不静默丢。**每块非文本内容都在任务文本里留一行占位**，并在返回值里点名，
 * 让 provider 把它写进 diagnostic。丢内容而不留痕 = 让模型以为自己看过一张图。
 *
 * <p>约束：本文件属于 packages 下的 src（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 *
 * @module host/subagent/prompt
 */

/**
 * 非文本块在任务文本里留下的占位行前缀。
 *
 * ★ 刻意带 `[` 与 `]`：模型侧把它当**元信息**读，不会当成任务内容本身去照做。
 */
export const OMITTED_BLOCK_PREFIX = '[workbuddy-subagent: omitted content block]';

/** 单块占位行的长度上限 —— 防止一个巨大的 data URI 把任务提示撑爆。 */
const MAX_OMITTED_HINT_CHARS = 80;

/** 块类型名自报的长度上限 —— 类型名也是外部来的，不设闸它能把占位行撑到任意长。 */
const MAX_TYPE_CHARS = 24;

/**
 * 描述一块**不能**下发的内容。
 *
 * @param {unknown} block
 * @returns {string} 一行占位说明（已截断）
 */
export function describeOmittedBlock(block) {
  const type = clip(typeof block?.type === 'string' && block.type !== '' ? block.type : 'unknown', MAX_TYPE_CHARS);
  // 只取 `data`/`uri` 的**长度**，不取内容：占位行是用来解释"这里丢了一块"，不是把数据再抄一遍。
  const size = typeof block?.data === 'string'
    ? block.data.length
    : (typeof block?.uri === 'string' ? block.uri.length : 0);
  const hint = size > 0 ? ` (${size} chars of "${type}" payload)` : ` (type=${type})`;
  const line = `${OMITTED_BLOCK_PREFIX}${hint}`;
  return line.length <= MAX_OMITTED_HINT_CHARS ? line : `${OMITTED_BLOCK_PREFIX} (type=${type}, length elided)`;
}

/**
 * 收窄一行自由文本。
 * @param {string} value
 * @param {number} max
 * @returns {string}
 */
function clip(value, max) {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/**
 * 把 `ContentBlock[]` 压成一段任务文本。
 *
 * <p>★ 返回 `omitted` 而不是只返回字符串 ★：正文里那一行占位只说"这里丢了个块"，
 * 说清"丢的是什么"要靠 `omitted`。**载体在两条路上并不一样**（`provider.js:261-264`）：
 * 失败路径由 `diagnosticFor()` 追加进 `SubagentResult.diagnostic`；**成功路径没有 `diagnostic` 字段**
 * （`provider.js:321-324`），`omitted` 的信息就只剩正文里那行占位。
 * 〔2026-10-02 更正〕旧注释声称"provider 要把它写进 `diagnostic`"，对成功路径不成立；
 * 不给成功路径加 `diagnostic` 是有意的 —— `runOutcome`（`dsh-subagent/lib/index.js:2692-2713`）
 * 用 diagnostic 的有无区分 killed / failed，成功路径塞诊断会污染那个判定。
 *
 * @param {unknown} blocks `SubagentStartRequest.prompt`
 * @returns {{text: string, omitted: string[]}} `text` 为空串表示"这次委派没有可下发的正文"
 */
export function promptText(blocks) {
  if (!Array.isArray(blocks)) return { text: '', omitted: [] };
  const lines = [];
  /** @type {string[]} */
  const omitted = [];
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      lines.push(block.text);
      continue;
    }
    const line = describeOmittedBlock(block);
    omitted.push(line);
    lines.push(line);
  }
  return { text: lines.join('\n'), omitted };
}
