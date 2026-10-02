#!/usr/bin/env node
/**
 * 把仓库内各插件包的 `node_modules/@deepseek-ai` 以【目录 junction】指向本机 dsh 安装体的
 * `node_modules/@deepseek-ai` scope 目录。
 *
 * 为什么需要（第一性）：T02 验收测试要求**真实的** `defineTool` / cordis 依赖（stub 无法证明
 * schema 编译、fiber 归属、effect 语义）。junction 使 `import '@deepseek-ai/dsh-tools'` 在仓库内可解析，
 * 而无需 `npm install`（该前提仍受 V24 数据根争用闭环约束，见 CONTRIBUTING）。
 *
 * 性质与边界：
 *   - **只读源**：绝不写入 dsh 安装体（仅 readdir/stat）。
 *   - 写入仅限本仓库 `packages/*​/node_modules/`（已 gitignore）。
 *   - 幂等：已存在且指向正确 ⇒ 跳过；指向其它路径 / 被真实目录占用 ⇒ 报告并保持原样（人工处置）。
 *   - 断链自愈：原指向的安装体被删除/改名（如换发行版 id 后 Roaming 目录消失）⇒ 断链属唯一
 *     可自动修复的冲突形态：写盘模式下重建为当前 scope；--check 模式下报告并 exit 1。
 *   - 环境不可用（未装 dsh / 无权限）⇒ 报告 + `exit 0`（测试侧按"依赖不可用"整组 skip）。
 *
 * 用法：
 *   node tools/dev/link-dsh-deps.mjs            # 建立/校验（默认）
 *   node tools/dev/link-dsh-deps.mjs --check    # 只报告，不写盘；不可用 ⇒ exit 1
 *   DSH_DEPS_SCOPE=<path> …                     # 显式指定 scope（CI / 非常规安装位）
 *
 * 约束：本文件位于 tools/（不在 CI ② / ③ 的 packages 扫描范围内），但仍遵守"C2：零进程出口"。
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const checkOnly = process.argv.includes('--check');

/** 关键包：链接后逐个探测其入口是否存在（证明 scope 内容可用，而非仅目录存在）。 */
const REQUIRED = [
  'cordis',
  'schemastery',
  'dsh-tools',
  'dsh-subprocess',
  'dsh-jobs',
  'dsh-settings',
  'dsh-system-prompt',
];

function scopeCandidates() {
  const list = [];
  const explicit = process.env.DSH_DEPS_SCOPE;
  if (typeof explicit === 'string' && explicit.trim() !== '') list.push(resolve(explicit.trim()));
  const roaming = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  if (existsSync(roaming)) {
    for (const entry of readdirSync(roaming, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // 本机实测布局：<Roaming>/<dist>/dependencies/dsh/node_modules/@deepseek-ai
      list.push(join(roaming, entry.name, 'dependencies', 'dsh', 'node_modules', '@deepseek-ai'));
    }
  }
  return list;
}

function findScope() {
  let fallback = null;
  for (const candidate of scopeCandidates()) {
    try {
      if (!statSync(candidate).isDirectory()) continue;
    } catch {
      /* 不存在/无权限 ⇒ 试下一个 */
    }
    if (fallback === null) fallback = candidate;
    // 优先「关键包齐全」的 scope：换发行版后旧 Roaming 目录可能残留半删状态，
    // 仅凭目录存在会挑中空壳，链接到没有 schemastery/dsh-tools 的残骸。
    const missing = REQUIRED.filter((name) => !existsSync(join(candidate, name, 'package.json')));
    if (missing.length === 0) return candidate;
  }
  return fallback;
}

/**
 * 读 target 的链接状态。lstat 能成功但 existsSync 为 false = 断链
 * （junction 条目在、指向的路径已消失）——existsSync 会跟随链接，故断链看起来"不存在"。
 */
function linkState(target) {
  try {
    const st = lstatSync(target);
    if (!st.isSymbolicLink()) return { kind: 'dir', alive: true };
    const current = resolve(dirname(target), readlinkSync(target));
    return { kind: 'link', current, alive: existsSync(target) };
  } catch {
    return null;
  }
}

function pluginPackageDirs() {
  const packagesDir = join(repoRoot, 'packages');
  if (!existsSync(packagesDir)) return [];
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(packagesDir, e.name, 'package.json')))
    .map((e) => join(packagesDir, e.name));
}

const scope = findScope();
if (scope === null) {
  console.log('[link-dsh-deps] 未找到本机 dsh 安装体的 @deepseek-ai scope。');
  console.log('  探测过的位置（首个存在者胜）：');
  for (const c of scopeCandidates()) console.log(`    - ${c}`);
  console.log('  提示：可用 DSH_DEPS_SCOPE=<path> 显式指定；测试将按“依赖不可用”整组 skip。');
  process.exit(checkOnly ? 1 : 0);
}
console.log(`[link-dsh-deps] scope: ${scope}`);

let missingRequired = [];
for (const name of REQUIRED) {
  if (!existsSync(join(scope, name, 'package.json'))) missingRequired.push(name);
}
if (missingRequired.length > 0) {
  console.log(`[link-dsh-deps] ⚠ scope 内缺少关键包：${missingRequired.join(', ')}`);
}

let linked = 0;
let already = 0;
let healed = 0;
let conflicts = 0;
let broken = 0;

for (const pkgDir of pluginPackageDirs()) {
  const nodeModules = join(pkgDir, 'node_modules');
  const target = join(nodeModules, '@deepseek-ai');
  const label = pkgDir.slice(repoRoot.length + 1).replaceAll('\\', '/');
  const st = linkState(target);

  if (st !== null && st.kind === 'link' && !st.alive) {
    // 断链：唯一自动修复形态（原安装体已消失，链接本身没有可保留的价值）
    if (checkOnly) {
      console.log(`[link-dsh-deps] ✗ ${label}/node_modules/@deepseek-ai → 断链（原指向已消失：${st.current}）`);
      broken += 1;
      continue;
    }
    rmSync(target); // 只删 junction 条目，不触碰任何一侧的目录内容
    mkdirSync(nodeModules, { recursive: true });
    symlinkSync(scope, target, 'junction');
    console.log(`[link-dsh-deps] ✔ ${label}/node_modules/@deepseek-ai → 断链已修复 → ${scope}`);
    healed += 1;
    continue;
  }

  if (st !== null) {
    if (st.kind === 'link') {
      if (st.current === resolve(scope)) {
        console.log(`[link-dsh-deps] ✓ ${label}/node_modules/@deepseek-ai → 已就位`);
        already += 1;
      } else {
        console.log(`[link-dsh-deps] ✗ ${label}/node_modules/@deepseek-ai → 指向其它位置（保持原样）：${st.current}`);
        conflicts += 1;
      }
    } else {
      console.log(`[link-dsh-deps] ✗ ${label}/node_modules/@deepseek-ai → 已被真实目录占用（保持原样）`);
      conflicts += 1;
    }
    continue;
  }

  if (checkOnly) {
    console.log(`[link-dsh-deps] · ${label}/node_modules/@deepseek-ai → 尚未建立（--check 不写盘）`);
    continue;
  }
  mkdirSync(nodeModules, { recursive: true });
  symlinkSync(scope, target, 'junction'); // Windows 目录 junction：无需管理员权限
  console.log(`[link-dsh-deps] ＋ ${label}/node_modules/@deepseek-ai → 已建立 junction`);
  linked += 1;
}

console.log(
  `[link-dsh-deps] 汇总：新建 ${linked}，已就位 ${already}，断链修复 ${healed}，冲突 ${conflicts}` +
    (missingRequired.length > 0 ? `，缺包 ${missingRequired.length}` : ''),
);
process.exit(
  checkOnly && (conflicts > 0 || broken > 0 || missingRequired.length > 0) ? 1 : 0,
);
