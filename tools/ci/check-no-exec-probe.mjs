#!/usr/bin/env node
/**
 * H-NO-EXEC-PROBE · 探测路径禁止执行程序（静态审计）。
 *
 * Implements: 02-design/DESIGN-v3.md §7.2（H-NO-EXEC-PROBE 硬约束）
 * Related:    DESIGN-v3 §9 R3-7 ③（C2 红线自证 · 探测方法审计）
 *
 * 为什么存在：L3 探测（spawn --version）曾触发身份握手、顶掉用户 Qoder 登录
 * （事故实证 F-47）。v1/v2 的该做法已被正式撤回 ⇒ 探测阶段不得启动任何目标程序，
 * 只允许 resolveExecutable / statSync / accessSync / 读环境变量。
 *
 * 审计对象：`packages/*​/src/host/probe/` 下的全部源码。
 * （比 check-no-process-exec.mjs 更严：探测路径里连 ctx.subprocess.spawn 也不允许。）
 *
 * 用法：
 *   node tools/ci/check-no-exec-probe.mjs                  # 扫描 packages/*​/src/host/probe/
 *   node tools/ci/check-no-exec-probe.mjs --target <dir>   # 扫描指定目录（绝对/相对均可；自检/临时用）
 *   node tools/ci/check-no-exec-probe.mjs --allow-empty    # 显式放行"零文件"过渡期（见下）
 *   node tools/ci/check-no-exec-probe.mjs --self-test      # 自检：逐样本断言
 *
 * 依赖：零。node:child_process 仅用于 --self-test 起自检子进程；本文件按精确 realpath 排除自身。
 *
 * ⚠ 已知局限（诚实登记——本脚本是「防呆」，不是「防恶意」）：
 *   1. 字符串拼接绕过（如 's' + 'pawn'）静态不可检；配套人工评审兜底。
 *   2. 字符串字面量内容**按代码扫描** ⇒ 字符串里的 `spawn(` 字样会误报（可用行内 allow 令牌豁免）。
 *   3. 词法器用启发式区分正则/除法（前一有效字符 + 关键字 + 控制条件括号 + 后缀自增减），
 *      用 `${}` 深度栈追踪嵌套模板；块注释闭合采用「可信 `*​/`」扫描（跳过同行可闭合的
 *      字符串/模板，撇号等不闭合引号按普通字符处理）。残余误判一律**宁可误报不选漏检**：
 *      猜疑态下内容保持可扫（不置空），因此不产生致盲。
 *   4. **零文件 = FAIL（fail-closed）**：扫描范围内无文件时退出码 1——"没扫到东西"不构成红线自证；
 *      过渡期须显式 `--allow-empty` 放行。零字节文件等同"无内容可检"。
 *   豁免：行内 `//` 注释**以** `check-no-exec-probe: allow` **开头**的行会被整行跳过（可续写理由）；
 *         字符串 / 块注释 / 注释中段出现的同名字样不算数（由词法器判定）。
 *
 * 修正记录（2026-09-19 · R2 首轮 → R4 复核 → R5 终审 → R6 定向终审）：
 *   R2-F1/F2/F3/F4/F6/F8/F9 + R4-N1/N3/N4/N5/N6/N12 + R5-A1/A2/A4/A5/A6/B/C/G —— 与 ② 同构修复，
 *   另：裸 `exec` 加负向后顾（re.exec 不误报）；execSync/execFile/fork 等点前缀形态全抓。
 *   计数改"成功读取数"（R5-G：不再把自排除/读失败的文件算进 PASS 计数）。
 *   R6-P1/P2/P4 —— 与 ② 同构：控制条件括号闭合判正则、可信 `*​/` 前瞻 + `${}` 深度栈、后缀自增减判除法。
 *   R6-P3 —— 自检断言收紧为 `名字:行号 [规则]`（防前缀碰撞、防删规则）；补裸 exec / process.binding /
 *   同行正则 / 幻影闭合回归样本。
 */

import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, statSync, realpathSync, symlinkSync } from 'node:fs';
import { join, relative, sep, extname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ *
 * 规则表（大小写敏感；resolveExecutable 中的 "Executable" 为驼峰，不受影响）
 * ------------------------------------------------------------------ */

const RULES = [
  {
    id: 'child-process-module',
    re: /child_process/,
    hint: '探测代码不得引用 node:child_process',
  },
  {
    id: 'spawn-call',
    re: /\bspawn\s*\(/,
    hint: '探测路径禁止任何 spawn 调用（含 ctx.subprocess.spawn；只允许 resolveExecutable / statSync / accessSync / 环境变量）',
  },
  {
    id: 'exec-family-call',
    re: /\b(?:execFileSync|execFile|execSync|spawnSync|fork)(?:Async)?\s*\(/,
    hint: '探测路径禁止进程执行调用（execFileSync / execFile / execSync / spawnSync / fork，含点前缀形态）',
  },
  {
    id: 'bare-exec-call',
    re: /(?<![\w.$])exec\s*\(/,
    hint: '探测路径禁止裸 exec() 调用（re.exec() 等点前缀正则方法不受影响）',
  },
  {
    id: 'process-binding',
    re: /\bprocess\.(?:binding|dlopen)\s*\(/,
    hint: '探测路径禁止 process.binding / process.dlopen',
  },
];

const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.mts', '.cts', '.ts', '.tsx', '.jsx']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.turbo', '.cache', '_legacy']);
/** allow 令牌：只在**真行注释**里匹配，且必须**以令牌开头**（R5-E2 收紧）。 */
const ALLOW_COMMENT = /^\s*check-no-exec-probe:\s*allow/;

const SELF_PATH = fileURLToPath(import.meta.url);

/* ------------------------------------------------------------------ *
 * 词法器（与 ② 同构；三条红线脚本刻意各自独立、零依赖单文件，可单独审计）
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
 * （其中的 `*​/` 是字面量，不算闭合）；撇号等不闭合的引号按普通字符处理。
 * 返回 -1 ⇒ 无可信闭合 ⇒ 调用方按普通字符处理（宁可误报不选漏检）。
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
  if (visited.has(real)) return out;
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
      st = statSync(full);
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

/** 默认目标：packages/*​/src/host/probe/ 下的代码文件。 */
function collectProbeFiles(root) {
  const pkgsDir = join(root, 'packages');
  const out = [];
  for (const p of listSubdirs(pkgsDir)) {
    walk(join(pkgsDir, p, 'src', 'host', 'probe'), out);
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
    const target = lines[i].trim();
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
    console.error('[H-NO-EXEC-PROBE] FAIL：--target 缺少参数值。');
    process.exit(1);
  }
  const allowEmpty = argv.includes('--allow-empty');

  const root = process.cwd();
  let targets;
  let scopeNote;
  if (explicit) {
    const scanRoot = resolve(root, explicit);
    if (!existsSync(scanRoot)) {
      console.error(`[H-NO-EXEC-PROBE] FAIL：--target 指向不存在的路径：${scanRoot}`);
      process.exit(1);
    }
    if (!statSync(scanRoot).isDirectory()) {
      console.error(`[H-NO-EXEC-PROBE] FAIL：--target 指向的是文件而非目录：${scanRoot}`); // R5-B
      process.exit(1);
    }
    targets = walk(scanRoot, []).filter((f) => CODE_EXT.has(extname(f).toLowerCase()));
    scopeNote = `--target ${scanRoot}`;
  } else {
    targets = collectProbeFiles(root);
    scopeNote = 'packages/*/src/host/probe';
  }

  const failures = [];
  let scanned = 0; // R5-G：只有"成功读取"的文件才计入（自排除/读失败不算）
  for (const abs of targets) {
    if (sameFile(abs, SELF_PATH)) continue;
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
    console.error(`[H-NO-EXEC-PROBE] FAIL：检出 ${failures.length} 处探测路径内的进程执行痕迹（红线）。`);
    for (const f of failures) {
      console.error(`  FAIL ${f.file}:${f.line} [${f.rule}] ${f.snippet}`);
      console.error(`       ↳ ${f.hint}`);
    }
    console.error('说明：探测阶段启动任何目标程序都可能触发身份握手（事故 F-47），本红线不可协商。');
    process.exit(1);
  }

  if (scanned === 0) {
    if (allowEmpty) {
      console.log(`[H-NO-EXEC-PROBE] ⚠ WARNING（--allow-empty 显式放行）：扫描范围（${scopeNote}）内 0 个探测文件。`);
      console.log('         本次未构成红线自证；T02 起 packages/*/src/host/probe/ 应有真实源码。');
      process.exit(0);
    }
    console.error(`[H-NO-EXEC-PROBE] FAIL（fail-closed）：扫描范围（${scopeNote}）内 0 个探测文件——`);
    console.error('         "没扫到东西"不构成红线自证。若确属"探测目录尚未创建"的过渡期，');
    console.error('         可显式加 --allow-empty 放行；若预期有源码，请检查扫描根目录是否配错。');
    process.exit(1);
  }

  console.log(`[H-NO-EXEC-PROBE] PASS：${scanned} 个探测文件未检出进程执行痕迹（范围：${scopeNote}）。`);
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * 自检：逐样本断言（R5-C）——每个违规样本必须单独出现且行号正确
 * ------------------------------------------------------------------ */

function runSelfTest() {
  const selfPath = fileURLToPath(import.meta.url);
  const dirty = mkdtempSync(join(tmpdir(), 'dsh-probe-dirty-'));
  const clean = mkdtempSync(join(tmpdir(), 'dsh-probe-clean-'));
  const empty = mkdtempSync(join(tmpdir(), 'dsh-probe-empty-'));

  // 每个样本声明期望命中的**首行行号**（1 基）+ **规则 id**——自检逐条断言
  // `文件名:行号 [规则]` 出现在输出里（R6-P3：防 `:1` 前缀碰撞 `:12`、防删规则）
  const dirtySamples = [
    { name: 'detect-bad.mjs', line: 1, rule: 'child-process-module', text: "import { spawn } from 'node:child_process';\nspawn('qoderclicn', ['--version']);\n" },
    { name: 'detect-bad2.mjs', line: 1, rule: 'spawn-call', text: 'ctx.subprocess.spawn({ argv: [exe, "--version"] });\n' },
    { name: 'detect-bad3.mjs', line: 2, rule: 'exec-family-call', text: 'const a = 1; /* c\n*/ spawnSync("x");\n' }, // R2-F3
    { name: 'detect-bad4.mts', line: 1, rule: 'exec-family-call', text: 'execFile("x", []);\n' }, // R2-F2
    { name: 'detect-bad5.mjs', line: 2, rule: 'spawn-call', text: "const GLOB = 'packages/*';\nspawn('cmd');\n" }, // R4-N1
    { name: 'detect-bad6.mjs', line: 2, rule: 'spawn-call', text: 'const t = "// check-no-exec-probe: allow";\nspawn("cmd");\n' }, // R4-N2
    { name: 'detect-bad7.mjs', line: 2, rule: 'spawn-call', text: 'const a = 1; /* c // d\n*/ spawn("x");\n' }, // R4-N3
    { name: 'detect-bad8.mjs', line: 2, rule: 'spawn-call', text: 'const U = /^https?:\\/\\//;\nspawn("x");\n' }, // R5-A2
    { name: 'detect-bad9.mjs', line: 2, rule: 'spawn-call', text: 'const t = `${ `a /* b` }`;\nspawn("x");\n' }, // R5-A4
    {
      name: 'detect-bad19.mjs', // R6 补：`${` 后是表达式起点——`/re/` 不得误判除法→幻影 //
      line: 1,
      rule: 'spawn-call',
      text: 'const t = `${ /a\\//.test(u) }`; spawn("y");\n',
    },
    { name: 'detect-bad10.mjs', line: 1, rule: 'spawn-call', text: 'spawn("x");\r// check-no-exec-probe: allow\r' }, // R5-A6
    { name: 'detect-bad11.mjs', line: 2, rule: 'spawn-call', text: 'const a = 1; // check-no-exec-probe: allow\u2028spawn("x");\u2028' }, // R5-A5
    { name: 'detect-bad12.mjs', line: 1, rule: 'spawn-call', text: "spawn('x'); // 注意不是豁免 check-no-exec-probe: allow\n" }, // R5-E2
    { name: 'detect-bad13.mjs', line: 1, rule: 'bare-exec-call', text: "exec('cmd');\n" }, // R6-P3：钉住裸 exec 规则
    { name: 'detect-bad14.mjs', line: 1, rule: 'process-binding', text: 'const b = process.binding("spawn_sync");\n' }, // R6-P3：钉住 process.binding 规则
    {
      name: 'detect-bad15.mjs', // R6-P1：`if (x) /re/` 语句位正则（同行 spawn 不得被幻影 // 致盲）
      line: 1,
      rule: 'spawn-call',
      text: 'if (x) /^https?:\\/\\//.test(u); spawn("y");\n',
    },
    {
      name: 'detect-bad20.mjs', // R6 补：`else if (x) /re/`（空白断词，防 `elseif` 拼接）
      line: 1,
      rule: 'spawn-call',
      text: 'else if (x) /a\\//.test(u); spawn("y");\n',
    },
    {
      name: 'detect-bad16.mjs', // R6-P2：幻影 /* 不得吞到更晚的 */（多行致盲）
      line: 2,
      rule: 'spawn-call',
      text: 'if (x) /[/*]/.test(s);\nspawn("y");\n/* doc */\n',
    },
    {
      name: 'detect-bad17.mjs', // R6-P2：更晚的 */ 在字符串里 ⇒ 无可信闭合 ⇒ 按代码扫
      line: 2,
      rule: 'spawn-call',
      text: 'if (x) /[/*]/.test(s);\nspawn("y");\nconst t = "*/";\n',
    },
    {
      name: 'detect-bad18.mjs', // R6：`} /[/*]/` 同样不得致盲（块尾后语句位判正则）
      line: 2,
      rule: 'spawn-call',
      text: 'function f() {} /[/*]/.test(u);\nspawn("y");\n/* doc */\n',
    },
    { name: 'check-no-exec-probe.mjs', line: 1, rule: 'child-process-module', text: "import { spawn } from 'node:child_process';\n" }, // R4-N4
  ];
  const cleanSamples = [
    {
      name: 'detect-ok.mjs',
      text: [
        '// 合法探测形态：路径解析 + 只读文件系统 + 环境变量 + 正则',
        'const p = await ctx.subprocess.resolveExecutable("workbuddy");',
        'const ok = (() => { try { return statSync(p).isFile(); } catch { return false; } })();',
        'const env = process.env.PATH;',
        'const m = /v(\\d+)/.exec("v22");',
        'const U = /^https?:\\/\\//;',
      ].join('\n'),
    },
    {
      name: 'detect-ok2.mjs',
      text: 'const x = 1; /* c */ // 探测路径不得 spawn("cmd") 的原因见设计 §7.2\n', // R4-N5
    },
    {
      name: 'detect-ok3.mjs', // R6-P4：`i++ / 2` 判除法 ⇒ 其后的 // 注释正常剥离
      text: 'let i = 0;\ni++ / 2; // spawn("x") is forbidden\n',
    },
    {
      name: 'detect-ok4.mjs', // R6-P2：注释里的撇号不得吞掉注释（否则 spawn 字样误报）
      text: "const x = 1; /* don't spawn directly */\n",
    },
    {
      name: 'detect-ok5.mjs', // R6-P2：模板 `${}` 内注释正常剥离
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
    } else if (!cleanRun.out.includes(`PASS：${String(cleanSamples.length)} 个探测文件`)) {
      problems.push(`干净样本扫描计数不符（应为 ${String(cleanSamples.length)}）`);
    }
    // R2-F1：--target 绝对路径必须真的扫描该目录
    const absRun = runGate(selfPath, ['--target', dirty], process.cwd());
    if (absRun.status !== 1 || !absRun.out.includes('FAIL：检出')) {
      problems.push(`--target 绝对路径未被正确解析（status=${String(absRun.status)}）`);
    }
    // R2-F1：--target 指向不存在路径必须 FAIL
    const missing = join(tmpdir(), `dsh-probe-missing-${String(process.pid)}`);
    const missingRun = runGate(selfPath, ['--target', missing], process.cwd());
    if (missingRun.status !== 1 || !missingRun.out.includes('指向不存在的路径')) {
      problems.push(`--target 指向不存在路径时未按预期报错（status=${String(missingRun.status)}）`);
    }
    // R5-B：--target 指向文件（非目录）必须显式报错
    const fileTarget = join(tmpdir(), `dsh-probe-file-${String(process.pid)}.mjs`);
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
    // R4-N6：junction / symlink 目录必须被跟随
    let linkStatus = 'skipped';
    try {
      const linkBase = mkdtempSync(join(tmpdir(), 'dsh-probe-link-'));
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
      linkStatus = `skip(${e.code ?? 'err'})`;
    }
    if (problems.length === 0) {
      console.log(
        `[H-NO-EXEC-PROBE] SELF-TEST PASS：${String(dirtySamples.length)} 个违规样本**逐个**被检出且行号+规则正确（含裸 exec/process.binding/同行正则/幻影闭合/嵌套模板/CR/U+2028/同名文件回归）；` +
          `干净样本 ${String(cleanSamples.length)} 个 status=0 且无 FAIL；绝对路径/不存在路径/非目录/零文件 fail-closed/--allow-empty 全部按预期；junction=${linkStatus}。`,
      );
    }
  } finally {
    rmSync(dirty, { recursive: true, force: true });
    rmSync(clean, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }

  if (problems.length > 0) {
    console.error('[H-NO-EXEC-PROBE] SELF-TEST FAIL：');
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
    console.error(`[H-NO-EXEC-PROBE] 自检无法启动子进程：${e.message}`);
    return { status: NaN, out: '' };
  }
}

main();
