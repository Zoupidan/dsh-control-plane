/**
 * 下发结果的**脱敏与措辞**工具集。
 *
 * <p>★★ 为什么从 `argv.js` 拆出来（2026-10-02，删净 CLI 线的一步）★★
 * CLI 传输被整体删除后，`argv.js` 里只剩下两类**与 CLI 无关**的职责：
 *   ① 脱敏（`redactArgv` / `redactText`）—— 作业输出、回执、stderr 摘录都要过它，
 *      两条桌面端通路（automation / gateway）都还在用；
 *   ② `notSent` 的取值域与文案 —— "有意图但没下发"的记账词汇表。
 * 而 `buildArgv` / `resolveNodeRuntime`（旗标名、node 路径解析）**只服务于 CLI**，
 * 已随 CLI 一并删除。留着它们 = 留着一张永远不会被下发的旗标表，
 * 而那张表在 `cordis.patch.yml` 里还会让人以为"配了就能生效"（schemastery 静默丢弃未知键）。
 *
 * <p>脱敏规则本身**一字未改**（R3-19）：两层、按顺序，先按参数名再按值体形态。
 *
 * @module host/launch/run-report
 */

/** 敏感参数名（R3-19：`--mcp-config` 等可能内联凭据）。 */
const SENSITIVE_NAME = /(api[-_]?key|token|secret|password|authorization|credential)/i;

/**
 * 内联凭据文本形态（R3-19 加固：值体内的凭据与旗标名无关，按名字匹配抓不到）。
 * ★ [0]/[1] 的捕获组是**必需**的：替换串是 `'$1***'` —— 无组时 `$1` 不被替换、作为字面量
 *   漏进脱敏产物（2026-09-22 P2 实测事故）。
 */
const SENSITIVE_TEXT_PATTERNS = [
  /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /(\bsk-)[A-Za-z0-9_-]{8,}/g,
  /((?:x-api-key|api[-_]?key|token|secret|password|authorization|credential)("|')?\s*[:=]\s*)("([^"]*)"|'([^']*)'|[^\s,;}]+)/gi,
];

/** preview 长度上限（回传/作业首行用；超出带显式省略标记，绝不静默丢尾）。 */
export const PREVIEW_LIMIT = 4096;

/**
 * `notSent[].reason` 取值域（SSOT 白名单）。
 *
 * 只在「**有意图、但被组装环节拦下**」时记账 —— 未指定取值**不是** notSent：
 * 那是正确行为，记进去就成了噪声，读的人会以为丢了东西。
 */
export const NOT_SENT_REASONS = Object.freeze({
  /** 配置里没有给出对应的下发键（缺失/空串/非字符串）。 */
  MISSING_FLAG_NAME: 'missing_flag_name',
  /** 键有、取值本身却没有 ⇒ 线格式退化成未知形态。 */
  MISSING_VALUE: 'missing_value',
  /** 请求的档位不在 `launch.effortValues` 表内 ⇒ 按"不静默升/降档"不传。 */
  UNSUPPORTED_LEVEL: 'unsupported_level',
});

/**
 * 原因码 → 一句可执行说明（与 `reason-codes.js` 的 `REASON_TEXT` 同构：码给机器读，话给人读）。
 * 说"下一步该动哪里"，不说"发生了什么"——后者字段里已经有了。
 */
export const NOT_SENT_HINT = Object.freeze({
  [NOT_SENT_REASONS.MISSING_FLAG_NAME]: '配置里对应的下发键为空 ⇒ 改 cordis.patch.yml',
  [NOT_SENT_REASONS.MISSING_VALUE]: '配置里对应的取值为空 ⇒ 改 cordis.patch.yml',
  [NOT_SENT_REASONS.UNSUPPORTED_LEVEL]: '该档位不在 launch.effortValues ⇒ 换一档或补表',
});

/**
 * argv → 可回传的 preview 文本（C3 透明度）。
 *
 * 两层脱敏（顺序不可颠倒）：
 *   ① `redactArgv`：按**参数名**命中（`--flag value` / `--flag=value` 两种形态）；
 *   ② `redactText`：按**值体形态**命中（`{"X-Api-Key":"…"}` 这类内联凭据，① 抓不到）。
 *
 * 仅当**前一项是独立旗标名**（`-x` / `--xxx`，且不含 `=`）且名字命中敏感词时才脱敏其值 ——
 * 否则"值本身含 secret 字样"或"前一项是 `--token=x` 形态"会让**下一个正常参数**被误脱敏。
 *
 * @param {string[]} argv
 * @returns {string[]}
 */
export function redactArgv(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const current = String(argv[i]);
    const previous = i > 0 ? String(argv[i - 1]) : '';
    if (i > 0 && /^--?[^=]+$/.test(previous) && SENSITIVE_NAME.test(previous)) {
      out.push('***'); // `--flag value` 形态
      continue;
    }
    const eq = /^(--?[^=]+)=(.*)$/s.exec(current);
    if (eq !== null && SENSITIVE_NAME.test(eq[1])) {
      out.push(`${eq[1]}=***`); // `--flag=value` 形态（正则候选，逐字保留旗标名）
      continue;
    }
    out.push(current);
  }
  return out;
}

/**
 * 文本脱敏（值体形态；R3-19）。用于 **preview / stderr 摘录 / 记录**，不改变真实 argv。
 * @param {string} text
 * @returns {string}
 */
export function redactText(text) {
  if (typeof text !== 'string' || text === '') return '';
  let out = text;
  for (const re of SENSITIVE_TEXT_PATTERNS) {
    out = out.replace(re, '$1***');
  }
  return out;
}

/** preview 单行化 + 脱敏 + 限长（保持"首行 = 概要"的作业输出契约）。 */
export function toPreviewLine(argv) {
  const line = redactText(redactArgv(argv).join(' ')).replace(/\s+/g, ' ').trim();
  if (line.length <= PREVIEW_LIMIT) return line;
  return `${line.slice(0, PREVIEW_LIMIT)} …（preview 截断，共 ${line.length} 字符）`;
}
