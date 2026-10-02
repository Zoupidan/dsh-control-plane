#!/usr/bin/env node
/**
 * R3-7 ② · 进程出口审计（静态）：断言插件源码不直接使用 node:child_process。
 *
 * Implements: 02-design/DESIGN-v3.md §9 R3-7 ②（C2 红线自证 · 进程出口审计）
 * Related:    DESIGN-v3 §4.4.2（U4 零执行四断言 A1–A4）· §7.3（子进程生命周期）
 *
 * 为什么存在：U4 要求「OFF 时零执行」，C2 要求「不启动程序」。
 * 唯一允许的进程出口是官方 seam `ctx.subprocess`（§7.3）。
 * 插件代码里若出现裸 child_process / spawn / exec，本审计在 CI 阶段拦截。
 *
 * 用法：
 *   node tools/ci/check-no-process-exec.mjs                  # 扫描 packages/*​/src 与 packages/*​/lib（默认范围）
 *   node tools/ci/check-no-process-exec.mjs --target <dir>   # 扫描指定目录（绝对/相对均可；自检/临时用）
 *   node tools/ci/check-no-process-exec.mjs --allow-empty    # 显式放行"零文件"过渡期（见下）
 *   node tools/ci/check-no-process-exec.mjs --self-test      # 自检：逐样本断言（见文件尾注释）
 *
 * 依赖：零。node:child_process 仅用于 --self-test 起自检子进程；
 *       本文件按**精确 realpath** 排除自身（不是同名排除——R4-N4）。
 *
 * ⚠ 已知局限（诚实登记——本脚本是「防呆」，不是「防恶意」）：
 *   1. 字符串拼接绕过（如 require('child_' + 'process')）静态不可检；配套人工评审兜底。
 *   2. 字符串字面量内容**按代码扫描**（模块说明符 `"node:child_process"` 必须能抓到）⇒
 *      字符串里的 `spawn(`/`child_process` 字样会误报（可用行内 allow 令牌豁免）。
 *   3. 词法器用启发式区分正则/除法（前一有效字符 + 关键字 + 控制条件括号 + 后缀自增减），
 *      用 `${}` 深度栈追踪嵌套模板；块注释闭合采用「可信 `*​/`」扫描（跳过同行可闭合的
 *      字符串/模板，撇号等不闭合引号按普通字符处理）。残余误判一律**宁可误报不选漏检**：
 *      猜疑态下内容保持可扫（不置空），因此不产生致盲。
 *   4. 默认扫描范围 = packages/*​/src + packages/*​/lib；包根文件与 test/ 不在内（与设计一致）。
 *   5. **零文件 = FAIL（fail-closed）**：扫描范围内无文件时退出码 1——"没扫到东西"不构成红线自证；
 *      过渡期须显式 `--allow-empty` 放行。零字节文件等同"无内容可检"，不在本门禁语义内。
 *   6. `.exec(` 点前缀形态被豁免（正则方法 re.exec 合法）⇒ 若 child_process 别名对象的
 *      `.exec()` 出现，本门禁抓不到（裸 `exec(` 与任何 `.spawn(` 仍全抓）。
 *   豁免：行内 `//` 注释**以** `check-no-process-exec: allow` **开头**的行会被整行跳过（可续写理由）；
 *         字符串 / 块注释 / 注释中段出现的同名字样不算数（由词法器判定，R4-N2 / R5-E2）。
 *
 *
 *   R2-F1  `--target` 绝对路径 resolve() + 存在性检查（原先静默 PASS）。
 *   R2-F2  补 `.mts` / `.cts`。        R2-F3  块注释收尾行不再整行跳过。
 *   R2-F4  allow 令牌限定真行注释。    R2-F5  剥离合法出口后全扫（Bun.spawn 不漏）。
 *   R2-F6  补 process.binding/dlopen。 R2-F7  默认范围收敛 src/+lib/。
 *   R2-F9  零文件 fail-closed（R4-N7 升级）+ --allow-empty。
 *   R4-N1  单遍词法器（字符串内的注释符不再致盲）。
 *   R4-N3  注释符互截修（状态推进）。  R4-N4  自身按精确路径排除。
 *   R4-N5  块注释后行注释正确剥离。    R4-N6  walk 跟随链接 + realpath 防环。
 *   R4-N9  合法出口方法名白名单。      R4-N12 自检断言「退出码+输出标记」。
 *   R5-A1/A2/A3  正则字面量态（URL 正则、字符类内的注释符不再致盲）。
 *   R5-A4  未收尾 `/*` 回退为普通字符（防嵌套模板致盲）。
 *   R5-A5/A6 行终止符补齐（`\r` / `\r\n` / U+2028 / U+2029）。
 *   R5-B   `--target` 非目录显式报错（不再退化为"0 文件"）。
 *   R5-C  自检改**逐样本断言**（每个违规样本必须出现在输出且行号正确——删规则/削覆盖不再假绿）。
 *   R5-E2 allow 令牌收紧为"注释须以令牌开头"。
 *   R5-G  ③ 同族修复（计数改"成功读取数"）。
 *
 * 修正记录（2026-09-19 · R2 首轮 → R4 复核 → R5 终审 → R6 定向终审）：
 *   R6-P1  控制条件括号（if/while/for/with）闭合后 `/` 判正则——`if (x) /re/` 不再被误判为除法
 *          而产生幻影注释致盲。
 *   R6-P2  块注释闭合改「可信 `*​/`」前瞻：同行可闭合的字符串/模板内的 `*​/` 不算闭合；
 *          找不到可信闭合 ⇒ 按普通字符扫描（不置空）。模板 `${}` 用深度栈追踪（替代"数反引号"）。
 *   R6-P3  自检断言收紧为 `名字:行号 [规则]`（防 `:1` 前缀碰撞 `:12`）；补裸 exec / 同行正则 /
 *          幻影闭合回归样本。
 *   R6-P4  后缀自增减 `i++ / 2` 判除法（`//` 注释不再被误判进正则体）。
 */

import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, statSync, realpathSync, symlinkSync } from 'node:fs';
import { join, relative, sep, extname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ *
 * 规则表
 * ------------------------------------------------------------------ */

const RULES = [
  {
    id: 'child-process-module',
    re: /child_process/,
    hint: 'node:child_process 引用（唯一允许的进程出口是 ctx.subprocess）',
  },
  {
    id: 'bare-spawn',
    re: /\bspawn\s*\(/,
    hint: '裸 spawn() 调用（允许的唯一形态是 ctx.subprocess.spawn()；点前缀形态如 Bun.spawn() 同样禁止）',
  },
  {
    id: 'exec-family',
    re: /\b(?:execFileSync|execFile|execSync|spawnSync|fork)(?:Async)?\s*\(/,
    hint: '裸进程调用（execFileSync / execFile / execSync / spawnSync / fork，含点前缀形态）',
  },
  {
    id: 'bare-exec',
    re: /(?<![\w.$])exec\s*\(/,
    hint: '裸 exec() 调用（re.exec() 等点前缀正则方法不受影响）',
  },
  {
    id: 'process-binding',
    re: /\bprocess\.(?:binding|dlopen)\s*\(/,
    hint: 'process.binding / process.dlopen（绕过正常模块系统的进程/原生加载后门）',
  },
];

/**
 * 合法出口：`ctx.subprocess.{spawn|spawnTerminal|resolveExecutable}(`（唯一官方 seam，§7.3）。
 * 扫描前把整段调用从文本中剥离；方法名白名单防止把 `subprocess.execSync(` 误当合法出口（R4-N9）。
 */
const ALLOWED_EXIT_CALL =
  /(?:ctx\.|[A-Za-z_$][\w$]*\.)?subprocess\.(?:spawn|spawnTerminal|resolveExecutable)\s*\(/g;

const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.mts', '.cts', '.ts', '.tsx', '.jsx']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.turbo', '.cache', '_legacy']);
/** allow 令牌：只在**真行注释**里匹配，且必须**以令牌开头**（R5-E2 收紧：注释里的引号/任意位置字样不再豁免）。 */
const ALLOW_COMMENT = /^\s*check-no-process-exec:\s*allow/;

const SELF_PATH = fileURLToPath(import.meta.url);

/* ------------------------------------------------------------------ *
 * 词法器：把注释挖成空白，字符串/模板串/正则内容保留
 * ------------------------------------------------------------------ */

/** 这些字符之后，`/` 更可能是正则字面量的开头（`}` 兼作块尾——见 R6：`} /[/*]/` 不得致盲）。 */
const REGEX_PRECEDING_OK = /[([{,;:=!&|?+\-*%^~<>}]/;
/** 这些关键字之后，`/` 更可能是正则开头（如 `return /re/`）。 */
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'instanceof', 'do', 'else', 'yield', 'await', 'throw',
]);
/** 控制流关键字：其条件括号闭合后处于"语句位"，`/` 可能是正则（R6-P1：`if (x) /re/`）。 */
const CONTROL_KEYWORDS = new Set(['if', 'while', 'for', 'with']);
const LINE_TERMINATOR = /\r\n|\r|\u2028|\u2029|\n/;

/** `/` 是除法还是正则字面量开头（启发式，配合 `if (x) /re/` 与 `i++ / 2` 两类实测形态）。 */
function isRegexStart(lastSignificant, prevSignificant, lastWord, afterControlParen) {
  if ((lastSignificant === '+' && prevSignificant === '+') || (lastSignificant === '-' && prevSignificant === '-')) {
    return false; // 后缀自增减 ⇒ 除法（R6-P4）
  }
  if (afterControlParen) return true; // `if (x) /re/`（R6-P1）
  if (lastSignificant === '') return true;
  if (REGEX_PRECEDING_OK.test(lastSignificant)) return true;
  if (/[A-Za-z0-9_$]/.test(lastSignificant)) return REGEX_KEYWORDS.has(lastWord);
  return false;
}

/**
 * R6-P2：为 `/*` 找「可信闭合」`*​/`——跳过**同行能正常闭合**的字符串/模板
 * （其中的 `*​/` 是字面量，不算闭合）；撇号等不闭合的引号按普通字符处理
 * （否则 `/* don't *​/` 会被误判为"无可信闭合"而整体转为普通字符扫描）。
 * 返回 -1 ⇒ 无可信闭合 ⇒ 调用方按普通字符处理（宁可误报不选漏检）。
 *
 * 已知与真实 JS 的偏离（登记）：若首个 `*​/` 恰好落在可闭合字符串内、
 * 而其后另有 `*​/`，真实 JS 会在前者处收尾，本函数会跳到后者——
 * 该形态仅出现在本已非法的源码里（字符串未闭合的后续无法通过编译）。
 */
function findCredibleBlockEnd(text, from) {
  for (let i = from; i < text.length; i += 1) {
    const c = text[i];
    if (c === '*' && text[i + 1] === '/') return i;
    if (c === '"' || c === "'" || c === '`') {
      const close = findClosingQuote(text, i + 1, c);
      if (close >= 0) i = close;
    }
  }
  return -1;
}

/** 找同行的闭合引号（`\` 转义跳过；跨行视为未闭合——防止撇号把整份文件吞进"字符串"）。 */
function findClosingQuote(text, from, quote) {
  for (let i = from; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (c === quote) return i;
    if (c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029') return -1;
  }
  return -1;
}

/**
 * 单遍状态机：code / 行注释 / 块注释 / '…' / "…" / `…` / 正则。
 *
 * 为什么不是"行级剥离 + 块注释状态"：glob 字符串（`'packages/*'`）与
 * 「`//` 先于 `*`+`/`」的行内混杂会让朴素实现把整份文件拖进块注释态——
 * R4-N1/N3 实证其可致盲整份违规文件；R5 又实证**正则字面量**
 * （如 `/^https?:\/\//`、`/[/*]/`）同样会致盲整行/整文件 ⇒ 本版补上正则态；
 * R6 再实证语句位正则（`if (x) /re/`）、后缀自增减、嵌套模板与"幻影 `/*`"
 * ⇒ 本版补控制条件括号追踪、`++/--` 判除法、`${}` 深度栈与「可信闭合」前瞻。
 *
 * 返回 { clean, lineComments }：
 *   clean        —— 与原文等长、仅注释被置空格的文本（换行位置不变，可直接按行切）
 *   lineComments —— Map<行号(0基), 该行行注释文本>
 *
 * 设计底线（R6）：置空（=把内容从扫描视野里移除）只在「无猜疑」状态生效；
 * 凡由启发式猜出的状态落到 `//` / `/*` 时，宁可不置空按代码扫描（可能误报），
 * 也不承担致盲（漏检）风险。
 */
function stripComments(text) {
  const out = new Array(text.length);
  const lineComments = new Map();
  const frames = []; // {kind:'tpl'} | {kind:'expr', depth}（R6-P2：`${}` 深度栈）
  let state = 'code';
  let line = 0;
  let commentBuf = null;
  let inClass = false;
  let lastSignificant = '';
  let prevSignificant = '';
  let lastWord = '';
  let prevWordChar = false;
  let controlDepth = 0; // if/while/for/with 条件括号深度
  let afterControlParen = false;

  const note = (ch) => {
    const isWord = /[A-Za-z0-9_$]/.test(ch);
    prevSignificant = lastSignificant;
    lastSignificant = ch;
    afterControlParen = false;
    if (isWord) {
      if (!prevWordChar) lastWord = ''; // 词以空白/标点分隔，防 `else if` 拼成 `elseif`
      lastWord += ch;
    } else {
      lastWord = '';
    }
    prevWordChar = isWord;
  };

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const d = text[i + 1];

    // 行终止符：\n / \r（含 \r\n 合并为一行）/ U+2028 / U+2029（R5-A5/A6）
    if (c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029') {
      if (state === 'line') {
        lineComments.set(line, commentBuf.join(''));
        commentBuf = null;
        state = 'code';
      } else if (state === 'sq' || state === 'dq') {
        state = 'code';
      } else if (state === 'regex') {
        state = 'code';
        inClass = false;
      }
      out[i] = c;
      if (c === '\r' && d === '\n') {
        out[i + 1] = '\n';
        i += 1;
      }
      line += 1;
      lastSignificant = '';
      prevSignificant = '';
      lastWord = '';
      prevWordChar = false;
      continue;
    }

    switch (state) {
      case 'code':
        if (c === '/' && d === '/') {
          state = 'line';
          commentBuf = [];
          out[i] = ' ';
          out[i + 1] = ' ';
          i += 1;
        } else if (c === '/' && d === '*') {
          // R5-A4 + R6-P2：只在存在「可信闭合」时置空；否则按普通字符扫描（不产生致盲）
          const close = findCredibleBlockEnd(text, i + 2);
          if (close >= 0) {
            state = 'block';
            out[i] = ' ';
            out[i + 1] = ' ';
            i += 1;
          } else {
            out[i] = c;
            note(c);
          }
        } else if (c === '/') {
          // 除法 vs 正则字面量（R5-A1/A2/A3 · R6-P1/P4）
          if (isRegexStart(lastSignificant, prevSignificant, lastWord, afterControlParen)) {
            state = 'regex';
            inClass = false;
            out[i] = c;
            afterControlParen = false;
          } else {
            out[i] = c;
            note(c);
          }
        } else if (c === "'") {
          state = 'sq';
          out[i] = c;
          note(c);
        } else if (c === '"') {
          state = 'dq';
          out[i] = c;
          note(c);
        } else if (c === '`') {
          frames.push({ kind: 'tpl' });
          state = 'tpl';
          out[i] = c;
          note(c);
        } else if (c === '{') {
          out[i] = c;
          note(c);
          const top = frames[frames.length - 1];
          if (top !== undefined && top.kind === 'expr') top.depth += 1;
        } else if (c === '}') {
          out[i] = c;
          note(c);
          const top = frames[frames.length - 1];
          if (top !== undefined && top.kind === 'expr') {
            if (top.depth === 0) {
              frames.pop();
              state = 'tpl'; // `${…}` 结束，回到模板文本
            } else {
              top.depth -= 1;
            }
          }
        } else if (c === '(') {
          out[i] = c;
          if (controlDepth === 0 && CONTROL_KEYWORDS.has(lastWord)) {
            controlDepth = 1;
          } else if (controlDepth > 0) {
            controlDepth += 1;
          }
          note(c);
        } else if (c === ')') {
          out[i] = c;
          const closingControl = controlDepth > 0;
          if (closingControl) controlDepth -= 1;
          note(c);
          if (closingControl && controlDepth === 0) afterControlParen = true;
        } else {
          out[i] = c;
          if (/\s/.test(c)) prevWordChar = false; // 空白断词（lastWord 保留，供 `if (` / `return /re/` 判定）
          else note(c);
        }
        break;
      case 'line':
        out[i] = ' ';
        commentBuf.push(c);
        break;
      case 'block':
        if (c === '*' && d === '/') {
          state = 'code';
          out[i] = ' ';
          out[i + 1] = ' ';
          i += 1;
        } else {
          out[i] = ' ';
        }
        break;
      case 'regex':
        out[i] = c;
        if (c === '\\') {
          if (i + 1 < text.length) {
            out[i + 1] = text[i + 1];
            i += 1;
          }
        } else if (c === '[') {
          inClass = true;
        } else if (c === ']') {
          inClass = false;
        } else if (c === '/' && !inClass) {
          state = 'code';
          note(c);
        }
        break;
      case 'sq':
      case 'dq':
        out[i] = c;
        if (c === '\\') {
          if (i + 1 < text.length) {
            out[i + 1] = text[i + 1];
            if (text[i + 1] === '\n') line += 1;
            i += 1;
          }
        } else if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"')) {
          state = 'code';
          note(c);
        }
        break;
      case 'tpl':
        out[i] = c;
        if (c === '\\') {
          if (i + 1 < text.length) {
            out[i + 1] = text[i + 1];
            if (text[i + 1] === '\n') line += 1;
            i += 1;
          }
        } else if (c === '`') {
          frames.pop(); // 关闭当前模板（外层可能是 expr ⇒ 回到表达式）
          state = 'code';
          note(c);
        } else if (c === '$' && d === '{') {
          frames.push({ kind: 'expr', depth: 0 });
          state = 'code';
          // R6 补：`${` 后是表达式起点 ⇒ 重置上下文（否则 `${ /re/ }` 的 `/` 会误判除法→幻影注释）
          lastSignificant = '';
          prevSignificant = '';
          lastWord = '';
          prevWordChar = false;
          out[i + 1] = d;
          i += 1;
        }
        break;
      default:
        out[i] = c;
    }
  }
  if (state === 'line' && commentBuf) lineComments.set(line, commentBuf.join(''));
  return { clean: out.join(''), lineComments };
}

/* ------------------------------------------------------------------ *
 * 扫描实现
 * ------------------------------------------------------------------ */

function walk(dir, out, visited = new Set()) {
  let real;
  try {
    real = realpathSync(dir);
  } catch {
    return out;
  }
  if (visited.has(real)) return out; // 防 symlink/junction 成环
  visited.add(real);

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    let st;
    try {
      st = statSync(full); // statSync 跟随链接（R4-N6：junction/symlink 目录不再整体隐形）
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, out, visited);
      continue;
    }
    if (st.isFile()) out.push(full);
  }
  return out;
}

/** 目录枚举同样跟随链接（R5 复核：packages/<p> 为 junction 时不得整包隐形）。 */
function listSubdirs(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    try {
      if (statSync(full).isDirectory()) out.push(e.name);
    } catch {
      continue;
    }
  }
  return out;
}

/** 默认扫描范围：packages/*​/src 与 packages/*​/lib（设计 §9 R3-7② 红线范围；test/ 不在内）。 */
function collectPluginSources(root) {
  const pkgsDir = join(root, 'packages');
  const out = [];
  for (const p of listSubdirs(pkgsDir)) {
    for (const sub of ['src', 'lib']) walk(join(pkgsDir, p, sub), out);
  }
  return out.filter((f) => CODE_EXT.has(extname(f).toLowerCase()));
}

function sameFile(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

function scanText(relPath, text) {
  const hits = [];
  const { clean, lineComments } = stripComments(text);
  const lines = clean.split(LINE_TERMINATOR);
  for (let i = 0; i < lines.length; i += 1) {
    const lc = lineComments.get(i);
    if (lc !== undefined && ALLOW_COMMENT.test(lc)) continue;
    const target = lines[i].replace(ALLOWED_EXIT_CALL, '(').trim();
    if (!target) continue;
    for (const rule of RULES) {
      const flags = rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`;
      for (const m of target.matchAll(new RegExp(rule.re.source, flags))) {
        void m;
        hits.push({ file: relPath, rule: rule.id, line: i + 1, snippet: target.slice(0, 90), hint: rule.hint });
      }
    }
  }
  return hits;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return runSelfTest();

  const targetIdx = argv.indexOf('--target');
  const explicit = targetIdx >= 0 ? argv[targetIdx + 1] : undefined;
  if (targetIdx >= 0 && !explicit) {
    console.error('[R3-7/②] FAIL：--target 缺少参数值。');
    process.exit(1);
  }
  const allowEmpty = argv.includes('--allow-empty');

  const root = process.cwd();
  let targets;
  let scopeNote;
  if (explicit) {
    const scanRoot = resolve(root, explicit);
    if (!existsSync(scanRoot)) {
      console.error(`[R3-7/②] FAIL：--target 指向不存在的路径：${scanRoot}`);
      process.exit(1);
    }
    if (!statSync(scanRoot).isDirectory()) {
      console.error(`[R3-7/②] FAIL：--target 指向的是文件而非目录：${scanRoot}`); // R5-B
      process.exit(1);
    }
    targets = walk(scanRoot, []).filter((f) => CODE_EXT.has(extname(f).toLowerCase()));
    scopeNote = `--target ${scanRoot}`;
  } else {
    targets = collectPluginSources(root);
    scopeNote = 'packages/*/src + packages/*/lib';
  }

  const failures = [];
  let scanned = 0;
  for (const abs of targets) {
    if (sameFile(abs, SELF_PATH)) continue; // 精确 realpath 排除自身（R4-N4）
    const rel = relative(root, abs).split(sep).join('/');
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    scanned += 1;
    failures.push(...scanText(rel, text));
  }

  if (failures.length > 0) {
    console.error(
      `[R3-7/②] FAIL：检出 ${failures.length} 处直接进程出口（唯一允许的出口是 ctx.subprocess）。`,
    );
    for (const f of failures) {
      console.error(`  FAIL ${f.file}:${f.line} [${f.rule}] ${f.snippet}`);
      console.error(`       ↳ ${f.hint}`);
    }
    process.exit(1);
  }

  if (scanned === 0) {
    if (allowEmpty) {
      console.log(`[R3-7/②] ⚠ WARNING（--allow-empty 显式放行）：扫描范围（${scopeNote}）内 0 个源码文件。`);
      console.log('         本次未构成红线自证；T02 起 packages/*/src 应有真实源码。');
      process.exit(0);
    }
    console.error(`[R3-7/②] FAIL（fail-closed）：扫描范围（${scopeNote}）内 0 个源码文件——`);
    console.error('         "没扫到东西"不构成红线自证。若确属"源码尚未落盘"的过渡期，');
    console.error('         可显式加 --allow-empty 放行；若预期有源码，请检查扫描根目录是否配错。');
    process.exit(1);
  }

  console.log(`[R3-7/②] PASS：${scanned} 个源码文件未检出直接进程出口（范围：${scopeNote}）。`);
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * 自检：逐样本断言（R5-C）
 *   - 每个违规样本必须**单独出现**在 FAIL 输出中且行号正确（删规则/削覆盖面不再假绿）
 *   - 干净样本：status=0、输出含 PASS、且命中数为 0（输出不得含 'FAIL'）
 *   - 四类 CLI 断言：绝对路径 / 不存在路径 / 非目录 / 零文件 fail-closed + --allow-empty
 *   - junction 跟随（在支持创建的平台上）
 * ------------------------------------------------------------------ */

function runSelfTest() {
  const selfPath = fileURLToPath(import.meta.url);
  const dirty = mkdtempSync(join(tmpdir(), 'dsh-cpe-dirty-'));
  const clean = mkdtempSync(join(tmpdir(), 'dsh-cpe-clean-'));
  const empty = mkdtempSync(join(tmpdir(), 'dsh-cpe-empty-'));

  // 每个样本声明期望命中的**首行行号**（1 基）+ **规则 id**——自检逐条断言
  // `文件名:行号 [规则]` 出现在输出里（R6-P3：防 `:1` 前缀碰撞 `:12`、防删规则）
  const dirtySamples = [
    { name: 'sample-import.mjs', line: 1, rule: 'child-process-module', text: "import { spawn } from 'node:child_process';\nspawn('cmd');\n" },
    { name: 'sample-dynamic.mjs', line: 1, rule: 'child-process-module', text: "const { execSync } = await import('node:child_process');\nexecSync('whoami');\n" },
    { name: 'sample-bare.mjs', line: 1, rule: 'exec-family', text: 'fork("./child.js");\n' },
    { name: 'sample-require.ts', line: 1, rule: 'child-process-module', text: "const cp = require('child_process');\ncp.execFileSync('x');\n" },
    { name: 'sample-bun.mjs', line: 1, rule: 'bare-spawn', text: 'Bun.spawn(["cmd"]);\n' }, // R2-F5
    { name: 'sample-blockcomment.mjs', line: 2, rule: 'bare-spawn', text: 'const a = 1; /* c\n*/ spawn("x");\n' }, // R2-F3
    { name: 'sample-binding.mjs', line: 1, rule: 'process-binding', text: 'const b = process.binding("spawn_sync");\n' }, // R2-F6
    { name: 'sample-extension.mts', line: 1, rule: 'child-process-module', text: "import { spawnSync } from 'node:child_process';\nspawnSync('x');\n" }, // R2-F2
    { name: 'sample-glob.mjs', line: 2, rule: 'child-process-module', text: "const GLOB = 'packages/*/src';\nimport { spawn } from 'node:child_process';\nspawn('x');\n" }, // R4-N1
    { name: 'sample-allowstring.mjs', line: 2, rule: 'bare-spawn', text: 'const t = "// check-no-process-exec: allow";\nspawn("cmd");\n' }, // R4-N2
    { name: 'sample-mixedcomment.mjs', line: 2, rule: 'bare-spawn', text: 'const a = 1; /* c // d\n*/ spawn("x");\n' }, // R4-N3
    { name: 'sample-subpexec.mjs', line: 1, rule: 'exec-family', text: "subprocess.execSync('cmd');\n" }, // R4-N9
    { name: 'sample-bare-exec.mjs', line: 1, rule: 'bare-exec', text: "exec('cmd');\n" }, // R6-P3：钉住裸 exec 规则
    {
      name: 'sample-urlregex.mjs', // R5-A2：URL 正则里的 \/\/ 不得致盲
      line: 2,
      rule: 'bare-spawn',
      text: 'const U = /^https?:\\/\\//;\nspawn("x");\n',
    },
    { name: 'sample-classregex.mjs', line: 2, rule: 'bare-spawn', text: 'const R = /[/*]/;\nspawn("x");\n' }, // R5-A1
    { name: 'sample-nestedtpl.mjs', line: 2, rule: 'bare-spawn', text: 'const t = `${ `a /* b` }`;\nspawn("x");\n' }, // R5-A4
    {
      name: 'sample-tplregex.mjs', // R6 补：`${` 后是表达式起点——`/re/` 不得误判除法→幻影 //
      line: 1,
      rule: 'bare-spawn',
      text: 'const t = `${ /a\\//.test(u) }`; spawn("y");\n',
    },
    {
      name: 'sample-ctrlparen.mjs', // R6-P1：`if (x) /re/` 语句位正则（同行 spawn 不得被幻影 // 致盲）
      line: 1,
      rule: 'bare-spawn',
      text: 'if (x) /^https?:\\/\\//.test(u); spawn("y");\n',
    },
    {
      name: 'sample-elseif.mjs', // R6 补：`else if (x) /re/`（空白断词，防 `elseif` 拼接）
      line: 1,
      rule: 'bare-spawn',
      text: 'else if (x) /a\\//.test(u); spawn("y");\n',
    },
    {
      name: 'sample-phantomclose.mjs', // R6-P2：幻影 /* 不得吞到更晚的 */（多行致盲）
      line: 2,
      rule: 'bare-spawn',
      text: 'if (x) /[/*]/.test(s);\nspawn("y");\n/* doc */\n',
    },
    {
      name: 'sample-phantomstr.mjs', // R6-P2：更晚的 */ 在字符串里 ⇒ 无可信闭合 ⇒ 按代码扫
      line: 2,
      rule: 'bare-spawn',
      text: 'if (x) /[/*]/.test(s);\nspawn("y");\nconst t = "*/";\n',
    },
    {
      name: 'sample-closebrace.mjs', // R6：`} /[/*]/` 同样不得致盲（块尾后语句位判正则）
      line: 2,
      rule: 'bare-spawn',
      text: 'function f() {} /[/*]/.test(u);\nspawn("y");\n/* doc */\n',
    },
    { name: 'sample-crline.mjs', line: 1, rule: 'bare-spawn', text: 'spawn("x");\r// check-no-process-exec: allow\r' }, // R5-A6（CR-only：令牌在下一行）
    { name: 'sample-u2028.mjs', line: 2, rule: 'bare-spawn', text: 'const a = 1; // check-no-process-exec: allow\u2028spawn("x");\u2028' }, // R5-A5
    { name: 'sample-tokenmid.mjs', line: 1, rule: 'bare-spawn', text: "spawn('x'); // 注意不是豁免 check-no-process-exec: allow\n" }, // R5-E2：令牌不在注释开头不得生效
    { name: 'check-no-process-exec.mjs', line: 1, rule: 'child-process-module', text: "import { spawn } from 'node:child_process';\n" }, // R4-N4 同名文件不得成盲区
  ];
  const cleanSamples = [
    {
      name: 'sample-ok.mjs',
      text: [
        '// 允许的形态：ctx.subprocess.spawn + resolveExecutable',
        'const p = await ctx.subprocess.resolveExecutable("workbuddy");',
        'const h = ctx.subprocess.spawn({ argv: [p, "-p", "hi"] });',
        'const { exitCode } = await h.done;',
        'const re = /abc/; re.exec("abc");',
        'const GLOB = "packages/*/src";',
        'const U = /^https?:\\/\\//;',
      ].join('\n'),
    },
    {
      name: 'sample-comment-ok.mjs',
      text: 'const x = 1; /* c */ // spawn("cmd") is forbidden by R3-7\n', // R4-N5
    },
    {
      name: 'sample-postfix-ok.mjs', // R6-P4：`i++ / 2` 判除法 ⇒ 其后的 // 注释正常剥离
      text: 'let i = 0;\ni++ / 2; // spawn("x") is forbidden\n',
    },
    {
      name: 'sample-apostrophe-ok.mjs', // R6-P2：注释里的撇号不得吞掉注释（否则 child_process 误报）
      text: "const x = 1; /* don't use child_process directly */\n",
    },
    {
      name: 'sample-tplexpr-ok.mjs', // R6-P2：模板 `${}` 内注释正常剥离
      text: 'const t = `${ /* spawn("x") */ 1 }`;\n',
    },
  ];
  for (const s of dirtySamples) writeFileSync(join(dirty, s.name), s.text, 'utf8');
  for (const s of cleanSamples) writeFileSync(join(clean, s.name), s.text, 'utf8');

  const problems = [];
  try {
    const dirtyRun = runGate(selfPath, ['--target', '.'], dirty);
    if (dirtyRun.status !== 1 || !dirtyRun.out.includes('FAIL：检出')) {
      problems.push(`违规样本目录未被拦截或未走判定路径（status=${String(dirtyRun.status)}）`);
    } else {
      for (const s of dirtySamples) {
        if (!dirtyRun.out.includes(`${s.name}:${String(s.line)} [${s.rule}]`)) {
          problems.push(`样本未被单独检出或行号/规则不符：${s.name}:${String(s.line)} [${s.rule}]`);
        }
      }
    }
    const cleanRun = runGate(selfPath, ['--target', '.'], clean);
    if (cleanRun.status !== 0 || !cleanRun.out.includes('PASS：') || cleanRun.out.includes('FAIL：检出')) {
      problems.push(`干净样本目录被误报或未走判定路径（status=${String(cleanRun.status)}）`);
    } else if (!cleanRun.out.includes(`PASS：${String(cleanSamples.length)} 个源码文件`)) {
      problems.push(`干净样本扫描计数不符（应为 ${String(cleanSamples.length)}）`);
    }
    // R2-F1：--target 绝对路径必须真的扫描该目录
    const absRun = runGate(selfPath, ['--target', dirty], process.cwd());
    if (absRun.status !== 1 || !absRun.out.includes('FAIL：检出')) {
      problems.push(`--target 绝对路径未被正确解析（status=${String(absRun.status)}）`);
    }
    // R2-F1：--target 指向不存在路径必须 FAIL
    const missing = join(tmpdir(), `dsh-cpe-missing-${String(process.pid)}`);
    const missingRun = runGate(selfPath, ['--target', missing], process.cwd());
    if (missingRun.status !== 1 || !missingRun.out.includes('指向不存在的路径')) {
      problems.push(`--target 指向不存在路径时未按预期报错（status=${String(missingRun.status)}）`);
    }
    // R5-B：--target 指向文件（非目录）必须显式报错
    const fileTarget = join(tmpdir(), `dsh-cpe-file-${String(process.pid)}.mjs`);
    writeFileSync(fileTarget, 'export const ok = 1;\n', 'utf8');
    const fileRun = runGate(selfPath, ['--target', fileTarget], process.cwd());
    if (fileRun.status !== 1 || !fileRun.out.includes('文件而非目录')) {
      problems.push(`--target 指向文件时未明确报错（status=${String(fileRun.status)}）`);
    }
    rmSync(fileTarget, { force: true });
    // R4-N7 / R5-B：零文件 fail-closed + --allow-empty 显式放行
    const emptyRun = runGate(selfPath, ['--target', empty], process.cwd());
    if (emptyRun.status !== 1 || !emptyRun.out.includes('fail-closed')) {
      problems.push(`零文件未按 fail-closed 报红（status=${String(emptyRun.status)}）`);
    }
    const emptyAllowedRun = runGate(selfPath, ['--target', empty, '--allow-empty'], process.cwd());
    if (emptyAllowedRun.status !== 0 || !emptyAllowedRun.out.includes('WARNING')) {
      problems.push(`--allow-empty 未按预期显式放行（status=${String(emptyAllowedRun.status)}）`);
    }
    // R4-N6：junction / symlink 目录必须被跟随（Windows 上 junction 无需管理员）
    let linkStatus = 'skipped';
    try {
      const linkBase = mkdtempSync(join(tmpdir(), 'dsh-cpe-link-'));
      const linkPath = join(linkBase, 'link-to-dirty');
      symlinkSync(dirty, linkPath, 'junction');
      const linkRun = runGate(selfPath, ['--target', linkBase], process.cwd());
      linkStatus = String(linkRun.status);
      if (linkRun.status !== 1 || !linkRun.out.includes('FAIL：检出')) {
        problems.push(`junction 目录未被跟随扫描（status=${String(linkRun.status)}）`);
      }
      rmSync(linkPath, { recursive: false, force: true });
      rmSync(linkBase, { recursive: true, force: true });
    } catch (e) {
      linkStatus = `skip(${e.code ?? 'err'})`; // 平台不支持创建链接时不判失败
    }
    if (problems.length === 0) {
      console.log(
        `[R3-7/②] SELF-TEST PASS：${String(dirtySamples.length)} 个违规样本**逐个**被检出且行号+规则正确（含裸 exec/同行正则/幻影闭合/嵌套模板/CR/U+2028/同名文件回归）；` +
          `干净样本 ${String(cleanSamples.length)} 个 status=0 且无 FAIL；绝对路径/不存在路径/非目录/零文件 fail-closed/--allow-empty 全部按预期；junction=${linkStatus}。`,
      );
    }
  } finally {
    rmSync(dirty, { recursive: true, force: true });
    rmSync(clean, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }

  if (problems.length > 0) {
    console.error('[R3-7/②] SELF-TEST FAIL：');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  process.exit(0);
}

/** 在指定 cwd 里跑一遍门禁（附加 args），返回 { status, out }；崩溃返回 status=NaN。 */
function runGate(selfPath, args, cwd) {
  try {
    const r = spawnSync(process.execPath, [selfPath, ...args], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
    });
    return { status: r.status === null ? NaN : r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  } catch (e) {
    console.error(`[R3-7/②] 自检无法启动子进程：${e.message}`);
    return { status: NaN, out: '' };
  }
}

main();
