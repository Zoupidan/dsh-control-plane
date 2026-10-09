/**
 * U6 只读探测：判定 WorkBuddy 桌面端是否可用（H-NO-EXEC-PROBE）。
 *
 * Implements: 02-design/DESIGN-v3.md §7.1（探测原则）/ §7.2（撤回 L3 的修正）
 * 约束（硬）：探测阶段不得启动任何目标程序 —— 只允许读文件系统 / 读环境变量。
 *   完全废除 18488 端口与 TCP 探测（F7 / 2026-10-09）。
 *
 * 本文件位于 `packages/*​/src/host/probe/`（CI ③ H-NO-EXEC-PROBE 扫描范围），
 * 全文件不得出现任何进程执行形态（spawn / exec / fork / child_process / process.binding）
 * —— 由 CI ③ 拦截。
 *
 * 判据优先级：
 *   L-D1  desktop-cache：`~/.workbuddy/cache/acc-product-config-v3.json` 存在**且可解析**
 *         —— 主判据（installed === true 的唯一依据）。
 *   L-D2  desktop-exe：桌面端可执行文件已知安装位（resolvedPath 的兜底来源）。
 *
 * 产出 ProbeResult（§7.2 逐字字段）：
 *   { target, installed, reason, resolvedPath, evidence, at, method }
 *   - evidence: Array<{ kind, value, found }> —— 让用户可复核"查了哪些地方"
 *   - method  : 'desktop-cache'（缓存命中）/'desktop-probe'（未命中）—— 如实记录本次探测方式
 *
 * 可测试性：`env` 为可选第三参（默认 process.env）；apply() 按设计只传 (ctx, config)。
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { PROBE_TARGET } from '../config/constants.js';

/** 桌面产品配置缓存的相对路径段（`~/.workbuddy/cache/acc-product-config-v3.json`）。 */
const DESKTOP_CACHE_SEGMENTS = ['.workbuddy', 'cache', 'acc-product-config-v3.json'];

/**
 * 桌面端可执行文件已知安装位（env 变量 → 相对路径）。
 * 与 `gateway/desktop.js` 的 `DESKTOP_KNOWN_PATHS` **同物**（那份找 Electron 主程序，本份只做只读判定）。
 * 找不到不是致命错误 —— 只影响 resolvedPath 的兜底值。
 */
const DESKTOP_EXE_KNOWN_PATHS = [
  { envs: ['ProgramFiles', 'ProgramW6432'], rel: 'WorkBuddy/WorkBuddy.exe' },
  { envs: ['ProgramFiles(x86)'], rel: 'WorkBuddy/WorkBuddy.exe' },
  { envs: ['LOCALAPPDATA'], rel: 'Programs/WorkBuddy/WorkBuddy.exe' },
];

/** 纯读判定：路径存在且为文件。任何异常（含拒绝访问）一律记 false，不抛。 */
function isReadonlyFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 解析 JSON：任何异常/非对象一律 null，不抛。 */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}


/**
 * 枚举桌面端可执行文件路径（纯读，不启动）。
 * @param {Record<string, string | undefined>} env
 * @returns {{path: string, source: string}|null}
 */
function findDesktopExe(env) {
  const seen = new Set();
  for (const tpl of DESKTOP_EXE_KNOWN_PATHS) {
    let base = null;
    for (const name of tpl.envs) {
      const v = env[name];
      if (typeof v === 'string' && v !== '') {
        base = v;
        break;
      }
    }
    if (base === null) continue;
    const candidate = join(base, tpl.rel);
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (isReadonlyFile(candidate)) return { path: candidate, source: `knownPath:${tpl.envs[0]}` };
  }
  return null;
}

/**
 * 只读探测 WorkBuddy 桌面端。永不抛：一切异常收敛为 reason:'error' 的结果对象。
 *
 * @param {object} _ctx 宿主 ctx（桌面端探测为纯只读 fs，不再需要 TCP 或 subprocess）
 * @param {object} _config 生效配置（本探测不读取 config.cliPath —— 该字段已删除）
 * @param {Record<string, string | undefined>} [env]
 * @returns {Promise<import('../types/index.js').ProbeResult>}
 */
export async function detectWorkBuddy(_ctx, _config, env = process.env) {
  const evidence = [];
  const at = Date.now();
  // ★★★ `WORKBUDDY_HOME` 优先（2026-10-02）★★★ 探测要读的是"插件会去写的那个家"，
  //   而那个位置由 `automation.js#workbuddyHome()` 决定 —— 它认 `WORKBUDDY_HOME`。
  //   只认 `HOME`/`USERPROFILE` 时，测试（`tools/dev/test-home-guard.mjs` 只设前者）
  //   会从**用户真实的** `~/.workbuddy/cache/` 读出桌面端配置 ——
  //   那不是假红，是**测试在读用户数据**，和"测试往用户库里写"是同一类事故。
  const whome = typeof env.WORKBUDDY_HOME === 'string' && env.WORKBUDDY_HOME !== '' ? env.WORKBUDDY_HOME : '';
  const home = whome !== ''
    ? whome
    : (typeof env.HOME === 'string' && env.HOME !== ''
      ? env.HOME
      : (typeof env.USERPROFILE === 'string' && env.USERPROFILE !== '' ? env.USERPROFILE : homedir()));
  const cachePath = join(home, ...DESKTOP_CACHE_SEGMENTS);
  try {
    // ── L-D1：桌面产品配置缓存（主判据） ──────────────────────────
    let cacheOk = false;
    let cacheState = 'missing';
    if (isReadonlyFile(cachePath)) {
      let text = null;
      try {
        text = readFileSync(cachePath, 'utf8');
      } catch {
        text = null; // 存在但读不出（权限等）—— 记 unreadable，不抛
      }
      if (text === null) {
        cacheState = 'unreadable';
      } else {
        const parsed = parseJson(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) cacheState = 'invalid-json';
        else cacheOk = true;
      }
    }
    evidence.push({ kind: 'desktop-cache', value: cachePath, found: cacheOk });
    if (!cacheOk) evidence.push({ kind: 'desktop-cache-state', value: cacheState, found: false });


    // ── L-D3：桌面可执行文件（resolvedPath 兜底） ─────────────────
    const exe = findDesktopExe(env);
    if (exe !== null) evidence.push({ kind: 'desktop-exe', value: exe.path, found: true });

    if (cacheOk) {
      return { target: PROBE_TARGET, installed: true, reason: 'ok', resolvedPath: cachePath, evidence, at, method: 'desktop-cache' };
    }
    // 缓存缺失/读不出/非法 JSON ⇒ 桌面端不可用。resolvedPath 退到桌面可执行文件路径（若找到）。
    return {
      target: PROBE_TARGET,
      installed: false,
      reason: 'not_found',
      resolvedPath: exe === null ? null : exe.path,
      evidence,
      at,
      method: 'desktop-probe',
    };
  } catch (err) {
    // 防御性兜底：探测本身出错（而非"未找到"）—— 与 not_found 区分，UI 可显示原因
    evidence.push({ kind: 'error', value: err instanceof Error ? err.message : String(err), found: false });
    return { target: PROBE_TARGET, installed: false, reason: 'error', resolvedPath: null, evidence, at, method: 'desktop-probe' };
  }
}
