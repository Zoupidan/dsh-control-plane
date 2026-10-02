#!/usr/bin/env node
/**
 * WB-7 · 旋钮必须有消费者（settings 声明 ↔ 真实下发 的一致性红线，静态 + 行为双查）。
 *
 * Implements: 02-design/DESIGN-v3.md §3.6（settings 唯一真源）/ §4.6（flag 表与取值表是**数据**）
 *             / §9 R3-7（红线自证）
 * Related:    04-docs/LLM-GUIDE-workbuddy-plugin.md §5-22（五个 launch.*Flag 声明后无人读取）
 *             · 04-docs/ISSUE-workbuddy-open-issues.md WB-7（本红线即其验收条件）
 *
 * 为什么存在（第一性原理）：
 *   插件的设置面是"声明式"的 —— schema.js 声明形状、cordis.patch.yml 给基线值、argv.js 决定**实际**
 *   下发什么。三者之间没有任何机制保证一致：一个声明了却没被读的 key，和一个"yml 里有、schema 里没有"
 *   的 key，都会**静默**变成无效设置。本仓库已经为此真实付过两次账：
 *     ① D-1/O-6（P1）：`permissionModeFlag` 声明齐全，但取值 `permissionMode` 从未被读取 ⇒ 非交互
 *        `-p` 下写/执行类工具全被拒，**两次真实下发失败**，而设置页看起来"一切正常"。
 *     ② WB-7：`sessionIdFlag` / `inputFormatFlag` / `permissionPromptToolFlag` /
 *        `includePartialMessagesFlag` / `noSessionPersistenceFlag` 五个旗标至今无消费者。
 *   原有的"三处同步"单测（host.test.js P2-11）用 `yaml.includes("key: 'value'")` 判定，**不看缩进层级**
 *   ⇒ 把 `permissionMode` 写在 `launch:` 块里也能过。这条红线补的就是"放置正确性 + 真实消费"。
 *
 * 三道检查（对每个含 schema 的 packages/*）：
 *   A. 声明同步：schema.js 的 `Config` 键（顶层 + `launch`）↔ cordis.patch.yml 的 `config:` 键
 *      （顶层 + `launch:`）。`patch-only` ⇒ schemastery 静默丢弃（用户改了没反应）= FAIL；
 *      `schema-only` ⇒ 基线里看不到该开关 = FAIL。**层级也算键的一部分**（`launch.x` ≠ `x`）。
 *   B. 行为消费：对每个 `launch.*` 注入唯一哨兵值，真实 `import()` 该包的 `launch/argv.js` 并调用
 *      `buildArgv`，哨兵出现在 `{argv, flags}` 的序列化文本里 = 被消费；否则 = inert。
 *      **为什么是行为而不是 grep**：grep "有没有读 `launch.x`" 会被注释里对同一 key 的讨论骗过
 *      （§5-22 之所以能长期隐形，正是因为那几行**注释**在解释它为什么没被用）。
 *   C. 惰性登记册 `src/host/config/inert-knobs.js`：`export default { 'launch.x': '理由' }`。
 *      确实**不该**被下发的旗标（如 `noSessionPersistenceFlag`：下发它会让 `--resume` 失效）登记为惰性
 *      才是诚实做法 —— 红线的目的不是"让所有旗标都活着"，而是"每一个旗标要么活着、要么写明为什么不做"。
 *      未登记的 inert / 已不 inert 却仍登记（stale）/ 登记了不存在的键（orphan）/ 理由为空 ⇒ 一律 FAIL。
 *
 * 范围与已知局限（诚实登记 —— 本脚本是「防呆」，不是「防恶意」）：
 *   1. 行为探针只覆盖 `launch.*`（旗标表）。顶层 key（model/effort/enabled/…）的消费者在 argv 之外
 *      （tools/index.js、session/map.js…），由 A 条保证"声明一致"，不保证"被读"。
 *   2. schema.js 用文本解析（不 `import`）⇒ 红线保持**零依赖**，不需要 dsh 发行版与 junction。
 *      代价：花括号配平靠字符串/注释感知的扫描器，正则字面量按 `/` 前后文猜测 —— 残余误判宁可
 *      多报不漏报（报错会指向具体键名，人一眼可判）。argv.js 同样**不被解析**，只被执行。
 *   3. 探针执行 `buildArgv`，因此**必须**假定 argv.js 顶层无副作用（现状成立：它只 import
 *        node:crypto/fs/os/path + ./stream-json.js）。argv.js 会尝试 `readdirSync(<home>/.workbuddy/...)`
 *        —— `home` 传入临时空目录，故只做路径判断，**绝不执行任何被探测程序**（H-NO-EXEC-PROBE）。
 *   4. 无 schema.js 的包（如尚未动工的 plugin-qoder）计为 SKIP，不算通过也不算失败；
 *      **零个可扫描包 ⇒ FAIL（fail-closed）**："没扫到东西"不构成红线自证。
 *
 * 用法：
 *   node tools/ci/check-consumed-knobs.mjs                 # 扫描 packages/*
 *   node tools/ci/check-consumed-knobs.mjs --root <dir>    # 指定仓库根（自检/临时副本用）
 *   node tools/ci/check-consumed-knobs.mjs --self-test     # 自检：好样本必须绿、每个坏样本必须红
 *
 * 依赖：零（node:fs / node:path / node:os / node:url）。不起子进程。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/* ------------------------------------------------------------------ *
 * 检查 A：声明解析（schema.js 文本 + cordis.patch.yml 文本）
 * ------------------------------------------------------------------ */

/**
 * 轻量源码净化：把 `//` 与 `/* *​/` 注释、以及字符串/模板字面量**内部**的字符换成空格
 * （保留行数与引号本身，便于后续按 `{`/`}` 配平）。
 * 注释里出现的花括号与冒号是**本仓库最常见的误报源**（注释写得很满），必须先处理。
 */
function neutralize(src) {
  const out = src.split('');
  const blank = (from, to) => {
    for (let i = from; i < to; i += 1) if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
  };
  let i = 0;
  let quote = '';
  let prevSig = '';
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (quote !== '') {
      if (c === '\\') {
        blank(i, i + 2);
        i += 2;
        continue;
      }
      if (c === quote) {
        quote = '';
        prevSig = c;
        i += 1;
        continue;
      }
      if (c === '\n' && quote !== '`') quote = ''; // 未闭合的引号按普通字符处理，避免整份文件致盲
      blank(i, i + 1);
      i += 1;
      continue;
    }
    if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && canBeRegexStart(prevSig)) {
      // 正则字面量：吞到同行的闭合 `/`（字符类里的 `/` 不算闭合）
      let j = i + 1;
      let cls = false;
      let closed = false;
      while (j < src.length) {
        const rc = src[j];
        if (rc === '\\') {
          j += 2;
          continue;
        }
        if (rc === '\n') break;
        if (rc === '[') cls = true;
        else if (rc === ']') cls = false;
        else if (rc === '/' && !cls) {
          closed = true;
          break;
        }
        j += 1;
      }
      if (closed) {
        blank(i, j + 1);
        prevSig = '/';
        i = j + 1;
        continue;
      }
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      blank(i, i + 1);
      i += 1;
      continue;
    }
    if (!/\s/.test(c)) prevSig = c;
    i += 1;
  }
  return out.join('');
}

/** `/` 前面出现这些字符 ⇒ 更可能是正则字面量开头而不是除法。 */
function canBeRegexStart(prevSig) {
  return prevSig === '' || '=([{,;:!&|?+-*%<>~^'.includes(prevSig);
}

/** 从净化后的源码里找某个 `{` 起始的对象字面量，返回其**深度 1** 处的 `key:` 列表（带真实行号）。 */
function objectKeysAt(clean, openIdx) {
  const keys = [];
  let depth = 0;
  let line = 1 + countNewlines(clean.slice(0, openIdx));
  for (let i = openIdx; i < clean.length; i += 1) {
    const c = clean[i];
    if (c === '\n') {
      line += 1;
      continue;
    }
    if (c === '{' || c === '(' || c === '[') {
      depth += 1;
      continue;
    }
    if (c === '}' || c === ')' || c === ']') {
      depth -= 1;
      if (depth === 0) return keys;
      continue;
    }
    if (depth !== 1) continue;
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < clean.length && /[\w$]/.test(clean[j])) j += 1;
      const after = clean.slice(j).match(/^\s*([:(])/);
      if (after?.[1] === ':') keys.push({ name: clean.slice(i, j), line });
      i = j - 1;
      continue;
    }
  }
  return keys;
}

function countNewlines(text) {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') n += 1;
  return n;
}

/**
 * 解析 schema.js：返回 `{ top: [{name,line}], launch: [{name,line}] }`。
 * 定位方式：`launch: z.object(` 后的花括号 ⇒ launch 子键；`Config = z.object(` 的花括号 ⇒ 顶层键。
 */
export function parseSchemaKeys(text) {
  const clean = neutralize(text);
  const launchAt = clean.search(/\blaunch\s*:\s*z\.object\(/);
  if (launchAt < 0) {
    throw new Error('schema：未找到 `launch: z.object(` —— 声明结构变了，请同步本红线（不静默放行）');
  }
  const launchBrace = clean.indexOf('{', launchAt);
  const launch = objectKeysAt(clean, launchBrace);
  const configAt = clean.search(/\bConfig\s*=\s*z\.object\(/);
  if (configAt < 0) {
    throw new Error('schema：未找到 `Config = z.object(` —— 声明结构变了，请同步本红线（不静默放行）');
  }
  const top = objectKeysAt(clean, clean.indexOf('{', configAt)).filter((k) => k.name !== 'launch');
  return { top, launch };
}

/** 缩进式解析 cordis.patch.yml：`config:` 顶层键 + 其下 `launch:` 子块键。 */
export function parsePatchKeys(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const idx = lines.findIndex((l) => /^[ \t]*config:[ \t]*$/.test(l));
  if (idx < 0) {
    throw new Error('patch：未找到独立的 `config:` 行 —— 声明结构变了，请同步本红线（不静默放行）');
  }
  const base = /^[ \t]*/.exec(lines[idx])[0].length;
  const keyRe = /^([ \t]+)([A-Za-z_][\w-]*):/;
  let launchBase = -1;
  const top = [];
  const launch = [];
  for (let i = idx + 1; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.trim() === '' || /^[ \t]*#/.test(raw)) continue;
    const indent = /^ */.exec(raw.replace(/\t/g, '    '))[0].length;
    if (indent <= base) break; // 离开 config 块
    const m = keyRe.exec(raw);
    if (m === null) continue;
    const key = m[2];
    if (launchBase >= 0) {
      if (indent === launchBase) launch.push({ name: key, line: i + 1 });
      continue; // launch 更深一层（effortValues 的档位）不是旗标
    }
    if (indent === base + 2) {
      if (key === 'launch') {
        launchBase = indent + 2;
        continue;
      }
      top.push({ name: key, line: i + 1 });
    }
  }
  return { top, launch };
}

/** A 条：双向声明同步（层级参与键名 ⇒ `launch.x` 与 `x` 是两个键）。 */
function diffDeclarations(pkg, schema, patch) {
  const findings = [];
  const schemaKeys = new Map();
  for (const k of schema.top) schemaKeys.set(k.name, `schema.js:${k.line}`);
  for (const k of schema.launch) schemaKeys.set(`launch.${k.name}`, `schema.js:${k.line}`);
  const patchKeys = new Map();
  for (const k of patch.top) patchKeys.set(k.name, `cordis.patch.yml:${k.line}`);
  for (const k of patch.launch) patchKeys.set(`launch.${k.name}`, `cordis.patch.yml:${k.line}`);
  for (const [key, at] of patchKeys) {
    if (schemaKeys.has(key)) continue;
    findings.push({
      pkg,
      kind: 'declaration-drift',
      rule: 'patch-only',
      key,
      where: at,
      hint: `只在 patch 里声明：schemastery 会**静默丢弃**未知键 ⇒ 用户改了没有任何效果。`
        + (schemaKeys.has(key.replace(/^launch\./, '')) || schemaKeys.has(`launch.${key}`)
          ? ` 同名的另一层级存在（${schemaKeys.has(key.replace(/^launch\./, '')) ? key.replace(/^launch\./, '') : `launch.${key}`}）⇒ 多半是**缩进放错块**。`
          : ''),
    });
  }
  for (const [key, at] of schemaKeys) {
    if (patchKeys.has(key)) continue;
    findings.push({
      pkg,
      kind: 'declaration-drift',
      rule: 'schema-only',
      key,
      where: at,
      hint: '只在 schema 里声明：基线里没有这一行 ⇒ 设置页/手改 settings 的用户看不到该开关（§3.6 三处同步）。',
    });
  }
  return findings;
}

/* ------------------------------------------------------------------ *
 * 检查 B：行为消费探针
 * ------------------------------------------------------------------ */

const SENTINEL_MARK = '__DSHKNOB';

/** 哨兵值：唯一、可打印、绝不会与真实旗标值或 argv 里的其它内容碰撞。 */
function sent(name) {
  return `${SENTINEL_MARK}_${name}__`;
}

/**
 * 组装一次 `buildArgv` 调用。刻意**不**注入 `nodePath`（哨兵会让 resolveNodeRuntime 抛"不是文件"，
 * 那是配置校验的正常行为而不是旗标消费）；`home` 给空临时目录 ⇒ 只做路径判断，不执行任何程序。
 */
function buildProbeInput({ launchKeys, topKeys, launchWitness, useCall, workspace }) {
  const launch = {};
  for (const k of launchKeys) {
    if (k === 'printArgs') launch[k] = [sent(k)];
    else if (k === 'effortValues') launch[k] = { [sent(k)]: launchWitness.get(k) };
    else launch[k] = sent(k);
  }
  const cfg = { launch };
  if (topKeys.has('model')) cfg.model = sent('model');
  if (topKeys.has('effort')) cfg.effort = launchKeys.includes('effortValues') ? sent('effortValues') : sent('effort');
  if (topKeys.has('permissionMode')) cfg.permissionMode = sent('permissionMode');
  if (topKeys.has('cwdRoot')) cfg.cwdRoot = workspace;
  const call = useCall === true
    ? {
      model: sent('model'),
      effort: launchKeys.includes('effortValues') ? sent('effortValues') : sent('effort'),
    }
    : null;
  return {
    cfg,
    runtime: { detected: () => ({ resolvedPath: workspace }) },
    prompt: 'probe-prompt',
    sessionKey: 'dsh-knob-probe',
    cwd: workspace,
    home: workspace,
    resume: { cliSessionId: 'dsh_probe-session_1' },
    call,
  };
}

/**
 * 探针目标覆盖表：包名 → "哪个模块的哪个导出真正消费 `launch.*`"。
 *
 * ★★ 2026-10-02 新增。为什么要这张表 ★★
 * 探针原本硬编码为 `src/host/launch/argv.js#buildArgv`。`plugin-workbuddy` 删净 CLI 线后
 * argv.js 整个文件已删除，而它 `launch` 表里**只剩** `effortValues`（推理强度档位能力表），
 * 真实消费者变成状态路由的 `effortCapability(config)`。
 * 不改这里的结果是这条红线**误报**（"无法加载 argv.js" ⇒ FAIL），
 * 而"顺手把它关掉"更糟 —— 那等于把一条红线删掉。所以探针改为**按包指名真实消费者**。
 * `call(mod, input)` 的返回值会被 JSON 序列化后拿哨兵值比对，与原探针口径一致。
 */
const PROBE_TARGETS = {
  'plugin-workbuddy': {
    module: ['src', 'host', 'routes', 'status', 'get.js'],
    export: 'effortCapability',
    call: (mod, cfg) => mod.effortCapability(cfg),
  },
};

/**
 * 执行一次包的行为探针。
 * @returns {{ observed: string, inert: string[], consumed: string[], error: string|null }}
 */
export async function probeLaunchConsumption({ packageDir, schema, workspace }) {
  const argvPath = join(packageDir, 'src', 'host', 'launch', 'argv.js');
  const inertPath = join(packageDir, 'src', 'host', 'config', 'inert-knobs.js');
  const launchKeys = schema.launch.map((k) => k.name);
  const topKeys = new Set(schema.top.map((k) => k.name));
  const launchWitness = new Map(launchKeys.map((k) => [k, k === 'effortValues' ? sent('effortValues_V') : sent(k)]));

  // ── 覆盖分支：本包的 argv.js 已删除，改打真实消费者 ──────────────────────────
  const override = PROBE_TARGETS[basename(packageDir)];
  if (override !== undefined && !existsSync(argvPath)) {
    const modPath = join(packageDir, ...override.module);
    let omod;
    try {
      omod = await import(pathToFileURL(modPath).href);
    } catch (err) {
      return {
        observed: '', inert: [], consumed: [],
        error: `无法加载 ${relPath(modPath)}：${err instanceof Error ? err.message : String(err)}`
          + '（探针必须真实调用消费者 ⇒ 加载失败即无法自证，本包按 FAIL 处理）',
        inertRegister: new Map(),
        inertRegisterPath: inertPath,
      };
    }
    const fn = omod[override.export];
    if (typeof fn !== 'function') {
      return {
        observed: '', inert: [], consumed: [],
        error: `${relPath(modPath)} 未导出 ${override.export} ⇒ 探针无处可跑`,
        inertRegister: new Map(),
        inertRegisterPath: inertPath,
      };
    }
    let observed = '';
    for (const useCall of [false, true]) {
      const input = buildProbeInput({ launchKeys, topKeys, launchWitness, useCall, workspace });
      try {
        observed += JSON.stringify(override.call(omod, input.cfg)) + '\n';
      } catch (err) {
        return {
          observed: '', inert: [], consumed: [],
          error: `${override.export} 在哨兵输入下抛错（探针无法判定消费）：${err instanceof Error ? err.message : String(err)}`,
          inertRegister: new Map(),
          inertRegisterPath: inertPath,
        };
      }
    }
    const consumed = [];
    const inert = [];
    for (const k of launchKeys) {
      if (observed.includes(launchWitness.get(k))) consumed.push(k);
      else inert.push(k);
    }
    // ★ 覆盖分支同样要读真实登记册：返回空 Map 会让 C 条的 orphan-register 检查失明 ——
    //   登记册里写一个已删除的键也不会变红（inert-knobs.js 的 5 条 CLI 旗标残留就是这么漏网的）。
    let inertRegister = new Map();
    try {
      inertRegister = new Map(Object.entries(await import(pathToFileURL(inertPath).href).then((m) => m.default ?? {})));
    } catch {
      inertRegister = new Map(); // 没有登记册 = 声明"我没有任何惰性旗标"，仍需接受 C 条检验
    }
    return {
      observed,
      inert,
      consumed,
      error: null,
      inertRegister,
      inertRegisterPath: inertPath,
    };
  }

  let mod;
  try {
    mod = await import(pathToFileURL(argvPath).href);
  } catch (err) {
    return {
      observed: '',
      inert: [],
      consumed: [],
      error: `无法加载 ${relPath(argvPath)}：${err instanceof Error ? err.message : String(err)}`
        + '（探针必须真实调用 buildArgv ⇒ 加载失败即无法自证，本包按 FAIL 处理）',
      inertRegister: new Map(),
      inertRegisterPath: inertPath,
    };
  }
  const build = mod.buildArgv;
  if (typeof build !== 'function') {
    return {
      observed: '',
      inert: [],
      consumed: [],
      error: 'argv.js 未导出 buildArgv 函数 ⇒ 探针无处可跑',
      inertRegister: new Map(),
      inertRegisterPath: inertPath,
    };
  }
  let observed = '';
  for (const useCall of [false, true]) {
    const input = buildProbeInput({
      launchKeys, topKeys, launchWitness, useCall, workspace,
    });
    try {
      const result = build(input);
      observed += JSON.stringify({ argv: result.argv, flags: result.flags }) + '\n';
    } catch (err) {
      return {
        observed: '',
        inert: [],
        consumed: [],
        error: `buildArgv 在哨兵输入下抛错（探针无法判定消费）：${err instanceof Error ? err.message : String(err)}`,
        inertRegister: new Map(),
        inertRegisterPath: inertPath,
      };
    }
  }
  const consumed = [];
  const inert = [];
  for (const k of launchKeys) {
    if (observed.includes(launchWitness.get(k))) consumed.push(k);
    else inert.push(k);
  }
  let inertRegister = null;
  try {
    const raw = readFileSync(inertPath, 'utf8');
    inertRegister = new Map(Object.entries(await import(pathToFileURL(inertPath).href).then((m) => m.default ?? {})));
    void raw;
  } catch {
    inertRegister = new Map(); // 没有登记册 = 声明"我没有任何惰性旗标"，仍需接受 C 条检验
  }
  return { observed, inert, consumed, error: null, inertRegister, inertRegisterPath: inertPath };
}

/** C 条：惰性登记册与实测结果的三方一致性。 */
function diffInertRegister(pkg, probeResult, schema) {
  const findings = [];
  const declared = new Set([
    ...schema.launch.map((k) => `launch.${k.name}`),
    ...schema.top.map((k) => k.name),
  ]);
  for (const entry of probeResult.inert) {
    const key = `launch.${entry}`;
    const reason = probeResult.inertRegister.get(key);
    if (reason === undefined) {
      findings.push({
        pkg,
        kind: 'inert-knob',
        rule: 'inert-unregistered',
        key,
        where: `cordis.patch.yml（launch.${entry}）`,
        hint: `声明了旗标但**从未进入 argv/flags**（哨兵 ${sent(entry)} 未出现）。`
          + '要么在 argv.js 里真正下发它，要么在 src/host/config/inert-knobs.js 写明"为什么不下发"。',
      });
      continue;
    }
    if (String(reason).trim() === '') {
      findings.push({
        pkg, kind: 'inert-knob', rule: 'empty-reason', key,
        where: relPath(probeResult.inertRegisterPath),
        hint: '登记了惰性旗标却没写理由 —— 理由才是这条登记的的全部内容（防"先挂个名字再说"）。',
      });
    }
  }
  for (const [key, reason] of probeResult.inertRegister) {
    if (!declared.has(key)) {
      findings.push({
        pkg,
        kind: 'inert-knob',
        rule: 'orphan-register',
        key,
        where: relPath(probeResult.inertRegisterPath),
        hint: `登记了 "${key}"，但 schema 里没有这一层级的该键（改名/放错层级/键已删）。`
          + (declared.has(key.replace(/^launch\./, '')) || declared.has(`launch.${key.replace(/^launch\./, '')}`)
            ? ' 同名的另一层级存在 ⇒ 请核对缩进层级。'
            : ''),
      });
      continue;
    }
    if (key.startsWith('launch.') && !probeResult.inert.includes(key.slice('launch.'.length))) {
      findings.push({
        pkg,
        kind: 'inert-knob',
        rule: 'stale-register',
        key,
        where: relPath(probeResult.inertRegisterPath),
        hint: `登记为惰性，但哨兵**确实出现在 argv/flags 里** ⇒ 旗标已被真实下发（${String(reason).slice(0, 40)}…）。`
          + '留着会让下一次"其实没消费"隐形。',
      });
    }
  }
  return findings;
}

function relPath(p) {
  return typeof p === 'string' ? p.split(sep).join('/') : '?';
}

/* ------------------------------------------------------------------ *
 * 包发现 + 主流程
 * ------------------------------------------------------------------ */

function listSubdirs(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    try {
      if (statSync(join(dir, e.name)).isDirectory()) out.push(e.name);
    } catch {
      /* 读不到就跳过 */
    }
  }
  return out;
}

/**
 * 扫描一个仓库根。
 * @param {string} root
 * @param {(msg: string) => void} [log]
 * @returns {{ findings: any[], scanned: string[], skipped: string[], notes: string[] }}
 */
export async function scanRoot(root, log = () => {}) {
  const findings = [];
  const scanned = [];
  const skipped = [];
  const notes = [];
  const pkgsDir = join(root, 'packages');
  for (const pkg of listSubdirs(pkgsDir).sort()) {
    if (pkg === 'node_modules' || pkg.startsWith('_')) continue;
    const packageDir = join(pkgsDir, pkg);
    const schemaPath = join(packageDir, 'src', 'host', 'config', 'schema.js');
    const patchPath = join(packageDir, 'cordis.patch.yml');
    const hasSchema = statSync(schemaPath, { throwIfNoEntry: false })?.isFile() === true;
    const hasPatch = statSync(patchPath, { throwIfNoEntry: false })?.isFile() === true;
    if (!hasSchema || !hasPatch) {
      skipped.push(pkg);
      // 两条都缺时曾被读成一个路径（"src/host/config/schema.js cordis.patch.yml 缺席"）⇒ 用 " + " 分隔。
      // §26 新包 plugin-cli-core 是第一个"两者皆无"的样本（它是库，不是插件壳）。
      const missing = [hasSchema ? null : 'src/host/config/schema.js', hasPatch ? null : 'cordis.patch.yml']
        .filter((x) => x !== null).join(' + ');
      notes.push(`SKIP ${pkg}：${missing} 缺席 —— 该包尚未进入"有设置面"的阶段（不计通过，也不计失败）`);
      continue;
    }
    scanned.push(pkg);
    let schema;
    let patch;
    try {
      schema = parseSchemaKeys(readFileSync(schemaPath, 'utf8'));
      patch = parsePatchKeys(readFileSync(patchPath, 'utf8'));
    } catch (err) {
      findings.push({
        pkg, kind: 'parse', rule: 'parse-failed', key: '(整包)', where: pkg,
        hint: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    findings.push(...diffDeclarations(pkg, schema, patch));
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-knob-probe-'));
    let probe;
    try {
      probe = await probeLaunchConsumption({ packageDir, schema, workspace });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
    if (probe.error !== null) {
      findings.push({
        pkg,
        kind: 'probe',
        rule: 'probe-unavailable',
        key: 'launch',
        where: relPath(argvNote(packageDir)),
        hint: probe.error,
      });
      log(`  probe 不可用：${pkg}`);
      continue;
    }
    findings.push(...diffInertRegister(pkg, probe, schema));
    notes.push(
      `OK   ${pkg}：launch 旗标 ${schema.launch.length} 个 ⇒ 实测下发 ${probe.consumed.length}、`
      + `登记惰性 ${probe.inert.length}；顶层键 ${schema.top.length} + launch 已在 patch 中对齐`,
    );
  }
  if (scanned.length === 0) {
    findings.push({
      pkg: '(仓库)',
      kind: 'scope',
      rule: 'fail-closed',
      key: 'packages/*',
      where: relPath(join(root, 'packages')),
      hint: '0 个包可扫描（每个包都需要 src/host/config/schema.js + cordis.patch.yml）——'
        + '"没扫到东西"不构成红线自证。',
    });
  }
  return { findings, scanned, skipped, notes };
}

function argvNote(packageDir) {
  return join(packageDir, 'src', 'host', 'launch', 'argv.js');
}

/* ------------------------------------------------------------------ *
 * 自检：好样本必须绿、每个坏样本必须红
 * ------------------------------------------------------------------ */

const FIX_SCHEMA = [
  "import z from '@deepseek-ai/schemastery';",
  'export const Config = z.object({',
  "  enabled: z.boolean().default(false),",
  "  model: z.string().default(''),",
  "  effort: z.string().default(''),",
  "  permissionMode: z.string().default(''),",
  '  launch: z.object({',
    "    modelFlag: z.string().default('--model'),",
    "    effortFlag: z.string().default('--effort'),",
    "    effortValues: z.object({}).default({}),",
    "    printArgs: z.array(z.string()).default(['-p']),",
    "    unusedFlag: z.string().default('--unused'),",
    '  }).default({}),',
  '});',
  '',
].join('\n');

const FIX_PATCH = [
  '- insert:',
  '    - id: fixture',
  "      name: 'dsh-plugin-fixture'",
  '      config:',
  '        enabled: false',
  "        model: ''",
  "        effort: ''",
  "        permissionMode: ''",
  '        launch:',
  "          modelFlag: '--model'",
  "          effortFlag: '--effort'",
  '          effortValues:',
  "            low: 'low'",
  "          printArgs: ['-p']",
  "          unusedFlag: '--unused'",
  '',
].join('\n');

/** 只下发 modelFlag / effortFlag / printArgs / permissionModeFlag；effortValues 走档位映射。 */
const FIX_ARGV_CONSUMING = `
export function buildArgv({ cfg, runtime }) {
  const l = cfg.launch;
  const argv = [l.printArgs[0], runtime.detected().resolvedPath, l.modelFlag, cfg.model];
  const flags = [{ flag: l.modelFlag, value: cfg.model, source: 'config.model' }];
  const mapped = l.effortValues[cfg.effort];
  if (mapped) { argv.push(l.effortFlag, mapped); flags.push({ flag: l.effortFlag, value: mapped, source: 'config.effort' }); }
  if (cfg.permissionMode) { argv.push('perm', cfg.permissionMode); flags.push({ flag: 'perm', value: cfg.permissionMode, source: 'config.permissionMode' }); }
  return { argv, flags };
}
`;

const FIX_INERT_OK = `
export default {
  'launch.unusedFlag': '样本：说明为什么暂不下发（真实包里对应 noSessionPersistenceFlag 会破坏 --resume）',
};
`;

function writeFixtureRoot(name, { schema = FIX_SCHEMA, patch = FIX_PATCH, argv = FIX_ARGV_CONSUMING, inert = FIX_INERT_OK } = {}) {
  const root = mkdtempSync(join(tmpdir(), `dsh-knob-selftest-${name}-`));
  const pkg = join(root, 'packages', 'fixture');
  mkdirSync(join(pkg, 'src', 'host', 'config'), { recursive: true });
  mkdirSync(join(pkg, 'src', 'host', 'launch'), { recursive: true });
  writeFileSync(join(pkg, 'src', 'host', 'config', 'schema.js'), schema);
  writeFileSync(join(pkg, 'src', 'host', 'config', 'inert-knobs.js'), inert);
  writeFileSync(join(pkg, 'src', 'host', 'launch', 'argv.js'), argv);
  writeFileSync(join(pkg, 'cordis.patch.yml'), patch);
  return root;
}

const CASES = [
  {
    name: 'clean', expectFinding: null, expectPass: true,
    build: () => writeFixtureRoot('clean'),
  },
  {
    // 真实事故形态：permissionMode 被放进 launch 块（层级错），schema 侧在顶层
    name: 'misplaced-key', expectFinding: 'patch-only launch.permissionMode',
    build: () => writeFixtureRoot('misplaced', {
      patch: FIX_PATCH.replace("        permissionMode: ''\n", '').replace("          modelFlag:", "          permissionMode: ''\n          modelFlag:"),
    }),
  },
  {
    name: 'schema-only', expectFinding: 'schema-only launch.effortValues',
    build: () => writeFixtureRoot('schema-only', {
      patch: FIX_PATCH.replace("          effortValues:\n            low: 'low'\n", ''),
    }),
  },
  {
    name: 'inert-unregistered', expectFinding: 'inert-unregistered launch.unusedFlag',
    build: () => writeFixtureRoot('unregistered', { inert: 'export default {};\n' }),
  },
  {
    name: 'stale-register', expectFinding: 'stale-register launch.modelFlag',
    build: () => writeFixtureRoot('stale', {
      inert: "export default { 'launch.modelFlag': '样本：它其实已被下发，登记必须被抓出来' };\n",
    }),
  },
  {
    name: 'orphan-register', expectFinding: 'orphan-register launch.goneFlag',
    build: () => writeFixtureRoot('orphan', {
      inert: "export default { 'launch.goneFlag': '键已删' };\n",
    }),
  },
  {
    name: 'empty-reason', expectFinding: 'empty-reason launch.unusedFlag',
    build: () => writeFixtureRoot('empty', { inert: "export default { 'launch.unusedFlag': '   ' };\n" }),
  },
  {
    name: 'argv-unloadable', expectFinding: 'probe-unavailable',
    build: () => writeFixtureRoot('unloadable', { argv: 'this is not valid javascript ((((\n' }),
  },
  {
    // 无 schema 的包 ⇒ SKIP；只剩它时零可扫包 ⇒ fail-closed
    name: 'nothing-scannable', expectFinding: 'fail-closed',
    build: () => {
      const root = mkdtempSync(join(tmpdir(), 'dsh-knob-selftest-empty-'));
      mkdirSync(join(root, 'packages', 'bare'), { recursive: true });
      writeFileSync(join(root, 'packages', 'bare', 'cordis.patch.yml'), '- insert:\n');
      return root;
    },
  },
];

async function runSelfTest() {
  let pass = 0;
  const failures = [];
  for (const c of CASES) {
    let root = null;
    try {
      root = c.build();
      const { findings } = await scanRoot(root);
      if (c.expectPass === true) {
        if (findings.length === 0) {
          pass += 1;
          console.log(`  ok   ${c.name}：绿（0 findings）`);
        } else {
          failures.push(`${c.name}：期望绿，实得 ${findings.map((f) => `${f.rule} ${f.key}`).join(', ')}`);
        }
        continue;
      }
      const hit = findings.some((f) => `${f.rule} ${f.key}` === c.expectFinding || f.rule === c.expectFinding);
      if (hit) {
        pass += 1;
        console.log(`  ok   ${c.name}：红于 ${c.expectFinding}`);
      } else {
        failures.push(`${c.name}：期望红于 "${c.expectFinding}"，实得 [${findings.map((f) => `${f.rule} ${f.key}`).join(', ') || '无'}]`);
      }
    } catch (err) {
      failures.push(`${c.name}：自检抛错 ${err instanceof Error ? err.stack : String(err)}`);
    } finally {
      if (root !== null) rmSync(root, { recursive: true, force: true });
    }
  }
  // 正向对照：确认"探针真的能看见哨兵"（否则上面所有红都是假红）
  const root = writeFixtureRoot('witness');
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-knob-probe-'));
  try {
    const schema = parseSchemaKeys(readFileSync(join(root, 'packages/fixture/src/host/config/schema.js'), 'utf8'));
    const p = await probeLaunchConsumption({ packageDir: join(root, 'packages', 'fixture'), schema, workspace });
    if (p.consumed.includes('modelFlag') && p.consumed.includes('effortFlag') && p.inert.includes('unusedFlag')) {
      pass += 1;
      console.log('  ok   witness：哨兵可分辨（下发态 vs 惰性态）');
    } else {
      failures.push(`witness：哨兵不可分辨 consumed=[${p.consumed}] inert=[${p.inert}]`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }

  console.log(`[KNOBS] SELF-TEST ${pass}/${pass + failures.length}`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

async function main() {
  const argvList = process.argv.slice(2);
  if (argvList.includes('--self-test')) return runSelfTest();
  const rootIdx = argvList.indexOf('--root');
  if (rootIdx >= 0 && !argvList[rootIdx + 1]) {
    console.error('[KNOBS] FAIL：--root 缺少参数值。');
    process.exit(1);
  }
  const root = resolve(argvList[rootIdx + 1] ?? process.cwd());

  const { findings, scanned, skipped, notes } = await scanRoot(root, (m) => console.log(m));
  for (const n of notes) console.log(`[KNOBS] ${n}`);
  if (findings.length > 0) {
    console.error(`[KNOBS] FAIL：检出 ${findings.length} 处"声明了却没有消费者/层级不一致"（红线）。`);
    for (const f of findings) {
      console.error(`  FAIL ${f.pkg}: [${f.rule}] ${f.key} @ ${f.where}`);
      console.error(`       ↳ ${f.hint}`);
    }
    console.error('说明：设置面是声明式的 —— 没有这道红线时，一个写错层级或没人读的旗标会**静默**失效');
    console.error('      （D-1/O-6 即为漏网：两次真实下发失败，设置页却"一切正常"）。');
    process.exit(1);
  }
  console.log(`[KNOBS] PASS：${scanned.length} 个包的 launch 旗标全部"要么实测下发、要么写明惰性"`
    + `${skipped.length > 0 ? `（跳过：${skipped.join(', ')}）` : ''}。`);
  process.exit(0);
}

/** 只有作为脚本直接运行时才扫仓库；被 import（测试用）时不产生副作用。 */
const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) await main();
