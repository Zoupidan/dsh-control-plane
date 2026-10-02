#!/usr/bin/env node
/**
 * C3 红线 · 禁止模拟点击（GUI 自动化）的 CI 强制点。
 *
 * Implements: 02-design/DESIGN-v3.md §9 R3-7 ①（C2 红线自证 · lint 红线）
 * Related:    01-prd/PRD.md P0-TR2（编译期 lint 失败）
 * 历史:       v1/v2 注释曾引用 DESIGN.md §A.3 —— 该文档已作废；v3 权威 = 02-design/DESIGN-v3.md
 *
 * 为什么存在：C3 是用户下达的硬约束。若只写在文档里，迟早会有人"留个兜底"
 * 然后把这条路走通，于是保真度问题变成"薛定谔的成功"（DESIGN §A.3 理由 1）。
 * ⇒ 把它做成**退出码非 0 的自动判定**。
 *
 * 用法：
 *   node tools/lint/no-gui-automation.mjs               # 扫描源码（默认）
 *   node tools/lint/no-gui-automation.mjs --include-docs # 连 Markdown 一起扫
 *   node tools/lint/no-gui-automation.mjs --self-test    # 自检（在临时目录验证规则真的会失败）
 *
 * 依赖：零。只用 node:fs / node:path / node:os。
 *
 * ⚠ 注意：本文件自身包含被禁模式的**字面量**（作为规则定义），因此被列入 SELF_EXCLUDE。
 *   这是标准做法（同类工具都会排除自己的规则表），不构成绕过口子。
 */

import { readdirSync, readFileSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative, sep, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ *
 * 规则表
 * ------------------------------------------------------------------ */

/**
 * 命中任一即失败。
 * 前 8 条为 DESIGN §A.3 原文列出的模式；其余为同类族的补充（跨平台/跨语言）。
 *
 * ⚠ QA 修订（见 05-construction/QA-REVIEW-ROUND1.md 维度 1）：
 *   原实现有 3 个使本红线形同虚设的缺陷，均已修：
 *     (1) `CODE_EXT` 只含 JS/TS 系 ⇒ 下面 7 条 py/ps1/au3/sh/vbs/cs 规则对真实文件
 *         **永远不可能命中**（已补扩展名）。
 *     (2) `scanFile` 用 `new RegExp(rule.re.source,'g')` 重建正则 ⇒ **原 flags 丢失**，
 *         带 `i` 的规则（sikuli）大小写失效（已保留 flags）。
 *     (3) 规则表缺 Windows 上最常见的两条注入路径：`SendKeys`（WinForms /
 *         `WScript.Shell`）与 `mshta`（已补）。
 */
const RULES = [
  { id: 'win32-sendinput', re: /\bSendInput\s*\(/ },
  { id: 'win32-mouse-event', re: /\bmouse_event\s*\(/ },
  { id: 'win32-keybd-event', re: /\bkeybd_event\s*\(/ },
  // Windows 上最易被漏掉的键盘注入：`[System.Windows.Forms.SendKeys]::SendWait()` /
  // `WScript.Shell.SendKeys()` / VBScript `SendKeys`。
  { id: 'win-sendkeys', re: /\bSendKeys\b/ },
  { id: 'win-wscript-shell', re: /WScript\.Shell/ },
  { id: 'win-mshta', re: /\bmshta\b/ },
  { id: 'node-robotjs', re: /\brobotjs\b/ },
  { id: 'node-nut-js', re: /(?:nut-js|nutjs|@nut-tree\/nut-js)/ },
  { id: 'py-pyautogui', re: /\bpyautogui\b/ },
  { id: 'py-pywinauto', re: /\bpywinauto\b/ },
  { id: 'win-uiautomation', re: /(?:uiautomation|UIAutomation|IUIAutomation)/ },
  { id: 'a11y-tree-walk', re: /Accessibility[\s\S]{0,40}?(?:tree|Tree)/ },
  { id: 'cv-template-match', re: /cv2\.matchTemplate|(?:matchTemplate\s*\()/ },
  { id: 'autoit', re: /\bAutoItX?\b|\bautoit3\b/i },
  { id: 'sikuli', re: /\bsikuli\b/i },
  { id: 'xdotool', re: /\b(?:xdotool|ydotool)\b/ },
  { id: 'mac-cgevent', re: /(?:CGEventCreate|CGEventPost|Quartz\.CGEvent)/ },
  { id: 'mac-pyobjc-accessibility', re: /AXUIElement|NSAccessibility/ },
];

/* ------------------------------------------------------------------ *
 * 扫描范围
 * ------------------------------------------------------------------ */

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
/**
 * 脚本/托管语言扩展名。
 * ⚠ QA 补：没有这一组，规则表里全部 py/ps1/au3/sh/vbs/cs 规则都是死规则
 * —— 它们在默认扫描下对真实文件命中概率恒为 0。
 */
const SCRIPT_EXT = new Set([
  '.py',
  '.pyw',
  '.ps1',
  '.psm1',
  '.psd1',
  '.vbs',
  '.au3',
  '.ahk',
  '.sh',
  '.bash',
  '.bat',
  '.cmd',
  '.cs',
]);
const DOC_EXT = new Set(['.md', '.markdown']);

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.cache',
  // v1/v2 冻结区：历史资产不设活动门禁（其纪律见 _legacy/README.md）
  '_legacy',
]);

/** 规则表自身所在文件（含被禁字面量）。 */
const SELF_EXCLUDE = new Set([
  'tools/lint/no-gui-automation.mjs',
  'tools\\lint\\no-gui-automation.mjs',
]);

/**
 * `--include-docs` 下的豁免目录：**只读前置产出**，它们引用被禁 API 名是为了
 * 解释"为什么禁止"（例如 DESIGN §A.2 图里的 `A1["键鼠注入 / SendInput"]`）。
 * 其余任何 .md 命中仍然失败。
 */
const DOC_BASELINE_ALLOWLIST = new Set([
  '00-recon',
  '01-prd',
  '02-design',
  '03-adr',
  '04-docs',
  '05-construction',
]);

/**
 * 根目录门面文档中同样在"解释禁令"的文件（如 `CONTRIBUTING.md` 列出被禁 API 清单）。
 *
 * ⚠ QA 补：`--include-docs` 原本对这些文件 FAIL ⇒ `npm run lint:c3:docs`
 * **从写出来的那天起就是红的**（11 处命中全部来自 `CONTRIBUTING.md` 的规则清单引用，
 * 且全部命中原规则集中的 ID，与本轮新增规则无关）。已纳入 WARN 基线。
 * 注意：这里只放"引用禁令清单"的门面文档，**不要**用它豁免新文档。
 */
const ROOT_DOC_ALLOWLIST = new Set([
  'CONTRIBUTING.md',
  'README.md',
  'CHANGELOG.md',
  'VERSION.md',
  // 状态台账：与 CONTRIBUTING.md 同性质（引用禁令清单解释禁令），v3 新增
  'HANDOFF.md',
  'CODEMAP.md',
]);

/* ------------------------------------------------------------------ *
 * 扫描实现
 * ------------------------------------------------------------------ */

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, out);
      continue;
    }
    if (e.isFile()) out.push(full);
  }
  return out;
}

function scanFile(relPath, text) {
  const hits = [];
  for (const rule of RULES) {
    // ⚠ QA 修：原先 `new RegExp(rule.re.source,'g')` 会丢掉规则自带的 flags，
    // 使 `/\bsikuli\b/i` 退化成大小写敏感（Sikuli / SIKULI 全部漏检）。
    const flags = rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`;
    for (const m of text.matchAll(new RegExp(rule.re.source, flags))) {
      const before = text.slice(0, m.index ?? 0);
      const line = before.split('\n').length;
      hits.push({ rule: rule.id, line, snippet: (m[0] ?? '').slice(0, 60) });
    }
  }
  return hits;
}

function main() {
  const argv = process.argv.slice(2);
  const includeDocs = argv.includes('--include-docs');
  const selfTest = argv.includes('--self-test');
  const root = process.cwd();

  if (selfTest) {
    return runSelfTest(root);
  }

  const files = walk(root, []);
  const failures = [];
  const warnings = [];

  for (const abs of files) {
    const rel = relative(root, abs).split(sep).join('/');
    if (SELF_EXCLUDE.has(rel)) continue;

    // ⚠ R4-N10 修：原先 `abs.slice(abs.lastIndexOf('.'))` 大小写敏感（`evil.PY` 漏检）
    //    且无扩展名文件的 ext 取值不可控；改用 extname + toLowerCase。
    const ext = extname(abs).toLowerCase();
    const isCode = CODE_EXT.has(ext) || SCRIPT_EXT.has(ext);
    const isDoc = DOC_EXT.has(ext);
    if (!isCode && !(includeDocs && isDoc)) continue;

    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }

    const hits = scanFile(rel, text);
    if (hits.length === 0) continue;

    const topDir = rel.split('/')[0] ?? '';
    const baselineDoc = isDoc && (DOC_BASELINE_ALLOWLIST.has(topDir) || ROOT_DOC_ALLOWLIST.has(topDir));
    const bucket = baselineDoc ? warnings : failures;
    for (const h of hits) {
      bucket.push({ file: rel, ...h });
    }
  }

  if (warnings.length > 0) {
    console.log('[C3] 以下命中位于只读前置产出目录（引用被禁 API 名是为了解释禁令），记为 WARN：');
    for (const w of warnings) {
      console.log(`  WARN ${w.file}:${w.line} [${w.rule}] ${w.snippet}`);
    }
  }

  if (failures.length > 0) {
    console.error(`[C3] FAIL：检出 ${failures.length} 处 GUI 自动化（模拟点击）痕迹。C3 是硬约束，禁止模拟点击。`);
    for (const f of failures) {
      console.error(`  FAIL ${f.file}:${f.line} [${f.rule}] ${f.snippet}`);
    }
    console.error('\n说明：GUI 自动化在本项目中连"兜底"资格都没有（DESIGN §A.3）。');
    console.error('若某平台确实没有可编程通道，正确做法是显示"本平台暂无可编程通道"，');
    console.error('而不是悄悄替它做 GUI 自动化。');
    process.exit(1);
  }

  console.log(
    `[C3] PASS：${includeDocs ? '源码 + 文档' : '源码'}未检出 GUI 自动化模式（规则 ${RULES.length} 条）。`,
  );
  process.exit(0);
}

/**
 * 自检：**真实跑一遍门禁进程并断言退出码**，而不是复用内部函数。
 *
 * ⚠ QA 修（这是本次审查最严重的一处）：
 *   原实现只调用 `scanFile()` 统计样本命中数，走的是**另一条代码路径** ——
 *   它绕过了扩展名过滤、绕过 `process.exit()`，因此会出现
 *   "规则永远命中不了真实文件，但 --self-test 依然 PASS" 的假绿灯。
 *   实测证据：修复前，在一个含 `evil.py`(pyautogui) / `evil.ps1`(SendKeys) 的目录里
 *   门禁返回 PASS(exit 0)，同时 --self-test 返回 PASS。
 *
 *   现在的自检：起子进程在样本目录里跑本脚本，断言「退出码 + 输出标记」双条件
 *     - 违规样本目录 ⇒ status === 1 且输出含「FAIL：检出」（门禁真的会拦）
 *     - 干净样本目录 ⇒ status === 0 且输出含「PASS：」（不误报）
 *   ⚠ R4-N12 修：原先只断言 `!== 0`，崩溃退出（-1）会被误读为"拦截成功"（假绿通道）。
 */
function runSelfTest(root) {
  const selfPath = fileURLToPath(import.meta.url);
  const dirty = mkdtempSync(join(tmpdir(), 'dsh-c3-dirty-'));
  const clean = mkdtempSync(join(tmpdir(), 'dsh-c3-clean-'));
  const samples = [
    { name: 'sample-gui.ts', text: 'import robotjs from "robotjs";\nrobotjs.moveMouse(1,1);\n' },
    { name: 'sample-gui.py', text: 'import pyautogui\npyautogui.click()\n' },
    { name: 'sample-gui.ps1', text: '$ws = New-Object -ComObject WScript.Shell\n$ws.SendKeys("x")\n' },
    { name: 'sample-gui-case.ts', text: 'export const a = "Sikuli";\nexport const b = "AUTOIT";\n' },
    // R4-N10 回归：大写扩展名（Windows 常见）不得漏检
    { name: 'sample-gui-ext.PY', text: 'import pyautogui\npyautogui.click()\n' },
    // R4-N10 回归：.mts / .cts 不得漏检
    { name: 'sample-gui-mod.mts', text: 'export const c = "SIKULI";\n' },
  ];
  for (const s of samples) writeFileSync(join(dirty, s.name), s.text, 'utf8');
  writeFileSync(join(clean, 'sample-clean.ts'), 'export const ok = 1;\n', 'utf8');

  const problems = [];
  try {
    // ⚠ R4-N12 修：断言改为「退出码 + 输出标记」双条件——崩溃（status=null→NaN）或
    //    "走错分支的 exit 1" 都不再被误读为"拦截成功"。
    const dirtyRun = runGate(dirty);
    if (dirtyRun.status !== 1 || !dirtyRun.out.includes('FAIL：检出')) {
      problems.push(`违规样本目录未被拦截或未走判定路径（status=${String(dirtyRun.status)}）`);
    }
    const cleanRun = runGate(clean);
    if (cleanRun.status !== 0 || !cleanRun.out.includes('PASS：')) {
      problems.push(`干净样本目录被误报或未走判定路径（status=${String(cleanRun.status)}）`);
    }
    if (problems.length === 0) {
      console.log(
        `[C3] SELF-TEST PASS：对违规样本目录（含 .PY 大写 / .mts 回归样本）status=${String(dirtyRun.status)} 且输出含 FAIL（拦截成功），` +
          `对干净目录 status=${String(cleanRun.status)} 且输出含 PASS（未误报）。`,
      );
    }
  } finally {
    rmSync(dirty, { recursive: true, force: true });
    rmSync(clean, { recursive: true, force: true });
  }

  if (problems.length > 0) {
    console.error('[C3] SELF-TEST FAIL：');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`[C3] 当前仓库自检请在 ${root} 下运行：node tools/lint/no-gui-automation.mjs`);
  process.exit(0);
}

/** 在指定 cwd 里跑一遍门禁，返回 { status, out }；崩溃返回 status=NaN。 */
function runGate(cwd) {
  try {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
    });
    return { status: r.status === null ? NaN : r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  } catch (e) {
    console.error(`[C3] 自检无法启动子进程：${e.message}`);
    return { status: NaN, out: '' };
  }
}

main();
