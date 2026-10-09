/**
 * settings 落盘契约（★ 2026-09-28 新增 —— 这条契约的违反**把 dsh 打死过**）。
 *
 * 事故：`launch/live-credits.js` 用 `settings.update(ns, { creditsRemain, creditsAt })`
 * 落盘积分快照，而这两个字段在 `config/schema.js` 里声明为**非 volatile**。
 * 宿主 `dsh-settings/lib/index.js` 的 `validatePaths`（:513-523，走 change 闭包）与
 * mutate 的路径预检（:507）**只允许改动里出现 volatile 路径**，遇到非 volatile 键抛
 * `Config field "…" is not volatile`。该抛错发生在 **rejected Promise** 上，
 * 而调用点写的是 `void svc.update(...)` ⇒ unhandled rejection ⇒ dsh 退出码 1。
 *
 * 两条独立的失效，必须分别堵住：
 *   ① **声明**：`Config` 里凡是经 `settings.update` 落盘的字段，必须 `.volatile()`；
 *   ② **隔离**：落盘失败必须 settle 掉，绝不把拒绝漏给宿主。
 * 只修①：字段合法了，但别的写失败仍会打死宿主。
 * 只修②：宿主不死了，但缓存永远写不进去，且错误被静默吞掉。
 *
 * ★ 检测器自证：下面的 `volatileOnlySettings` 会照抄宿主规则拒绝非 volatile 键，
 *   `负向对照` 用例**证明它真的会拒**。一个不会拒的假宿主只会让本文件全绿而毫无意义。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Config } from '../src/host/config/schema.js';
import { createLiveCredits } from '../src/host/launch/live-credits.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(ROOT, 'src');
const LIB = join(ROOT, 'lib');

/** 照抄宿主 `validatePaths` 的判据：改动里的每个键都必须在 Config 里且是 volatile。 */
function volatileOnlySettings(log) {
  const calls = [];
  return {
    calls,
    update(ns, patch) {
      for (const key of Object.keys(patch ?? {})) {
        const field = Config.dict[key];
        if (field === undefined || field.meta?.volatile !== true) {
          return Promise.reject(new Error(`Config field "${key}" is not volatile`));
        }
      }
      calls.push({ ns, patch });
      return Promise.resolve();
    },
  };
}

test('负向对照：假宿主确实会拒非 volatile 键（否则本文件全部无意义）', async () => {
  const svc = volatileOnlySettings();
  // 拿一个**确实非 volatile** 的字段喂它 —— `launch` 是 flag 名表，从不落盘。
  await assert.rejects(() => svc.update('dsh-plugin-workbuddy', { launch: {} }),
    /Config field "launch" is not volatile/);
  // 对照组：volatile 字段必须放行。
  await svc.update('dsh-plugin-workbuddy', { creditsRemain: 1 });
  assert.equal(svc.calls.length, 1);
});

test('★ credits* 必须声明为 volatile（它们是 settings 落盘的字段）', () => {
  for (const key of ['creditsRemain', 'creditsAt', 'creditsConsumed', 'creditsRuns']) {
    const field = Config.dict[key];
    assert.notEqual(field, undefined, `${key} 必须存在于 Config`);
    assert.equal(field.meta?.volatile, true,
      `${key} 经 settings.update 落盘，非 volatile 会被宿主拒绝并打死 dsh（见文件头事故记录）`);
  }
});

test('★ checkin* 必须声明为 volatile（签到结论同样经 settings 落盘）', () => {
  // ★ 2026-10-09 新增：与上面四行同一条硬约束（`launch/daily-checkin.js` 的 `persistClaim`）。
  //   开关 `enableAutoCheckin` 虽由用户写、也必须 volatile —— 0.1.7 的设置面只投影 volatile 字段，
  //   非 volatile 的开关在设置页根本不出现（见 schema.js 头注）。
  for (const key of ['checkinLastAt', 'checkinLastResult', 'checkinLastCredit', 'checkinStreakDays', 'enableAutoCheckin']) {
    const field = Config.dict[key];
    assert.notEqual(field, undefined, `${key} 必须存在于 Config`);
    assert.equal(field.meta?.volatile, true,
      `${key} 经 settings.update 落盘/投影，非 volatile 会被宿主拒绝（打死 dsh / 设置页消失）`);
  }
});

/**
 * 静态扫描：凡是"经 settings 落盘"的键，都必须声明为 volatile。
 *
 * ★ 这条检查第一版**是假的**：只匹配 `update(ns, { 字面量 })`，而真实坏例是
 *   `submit({ creditsRemain })` → 函数体内 `svc.update(ns, patch)` —— 补丁是**变量**。
 *   结果：把 creditsRemain 改回非 volatile，用例 3 依然全绿。绿灯不是证据。
 *   现在做两级解析：`update(ns, <标识符>)` 反查其**最近的外层函数名**（转发写），
 *   再全仓匹配 `<函数名>({ 字面量 })`。
 *
 * 覆盖边界（写明，不假装更强）：只解析**一级**转发；`patch.creditsRemain` 这类
 * 动态键、以及跨文件的两级转发扫不出来。运行时用例 4/6 兜住 live-credits 这条真实路径。
 */
function enclosingFunctionName(before) {
  const decl = /(?:function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\()/g;
  let last = null;
  for (const m of before.matchAll(decl)) last = m[1] ?? m[2] ?? null;
  return last;
}

/** 从 `text[braceIndex] === '{'` 起做深度匹配，返回字面量内容；不闭合则返回 null。 */
function readObjectLiteral(text, braceIndex) {
  let depth = 0;
  for (let i = braceIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { body: text.slice(braceIndex + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** 只按**顶层**逗号切分：嵌套 `{}`/`[]`/`()` 内部的逗号不算分隔符。 */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
  }
  parts.push(body.slice(start));
  return parts;
}

/** 从 `({ k: v, ... })` 片段里取键名；取 `[k]`/裸展开则返回 null（动态，扫不出）。 */
function keysOfObjectLiteral(body) {
  return splitTopLevel(body).map((part) => {
    const km = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(part);
    return km === null ? null : km[1];
  });
}

/**
 * 剥掉注释再扫。
 * 不剥的话，schema.js 里那段解释本次事故的说明文档会被当成调用点，
 * 扫描器会被**自己的文档**永久污染（本条就是这么变红的）。
 * 字符串字面量内的 `//` 不能当注释，故做一次引号状态机。
 */
function stripComments(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      out += ch;
      if (ch === '\\') { out += text[i + 1] ?? ''; i += 1; }
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; continue; }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

/** @returns {{ violations: string[], covered: number }} */
function scanSettingsWrites(rawSources) {
  const sources = rawSources.map(([f, t]) => [f, stripComments(t)]);
  const violations = [];
  let covered = 0;

  // 第一级 —— 谁是"落盘转发器"：
  //   ① `update(<ns>, <标识符>)`：泛匹配即可（Map 之类没有 .update，不会误报）。
  //   ② `set(<标识符>, …)`：**必须**锚定到 configForms 取得的 receiver。
  //      泛匹配 `.set(` 会把 `cache.set(k, v)` 误判成 settings 写入（本条就是这么翻车的）。
  const formReceivers = new Set();
  for (const [, text] of sources) {
    for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*(?:ctx\.)?configForms\.get\(/g)) formReceivers.add(m[1]);
  }
  const writers = new Set();
  for (const [file, text] of sources) {
    for (const m of text.matchAll(/\.update\(\s*[A-Za-z_$][\w$.]*\s*,\s*([A-Za-z_$][\w$]*)\s*[,)]/g)) {
      const name = enclosingFunctionName(text.slice(0, m.index));
      if (name !== null) writers.add(name);
    }
    for (const recv of formReceivers) {
      const re = new RegExp(`(?<![\\w$.])${recv}\\.(?:set|update)\\(\\s*([A-Za-z_$][\\w$]*)\\s*[,)]`, 'g');
      for (const m of text.matchAll(re)) {
        const name = enclosingFunctionName(text.slice(0, m.index));
        if (name !== null) writers.add(name);
      }
    }
  }

  for (const [file, text] of sources) {
    const report = (key, where) => {
      const field = key === null ? undefined : Config.dict[key];
      if (key !== null && field !== undefined && field.meta?.volatile === true) return;
      violations.push(`${file} → ${where}${key === null ? '（动态键，扫不出，请人工确认）' : ` ${key}`}`);
    };
    // 直接字面量落盘：svc.update(ns, { creditsRemain, ... })
    for (const m of text.matchAll(/\.update\(\s*[A-Za-z_$][\w$.]*\s*,\s*\{/g)) {
      const lit = readObjectLiteral(text, m.index + m[0].length - 1);
      if (lit === null) continue;
      for (const k of keysOfObjectLiteral(lit.body)) { covered += 1; report(k, '直接字面量'); }
    }
    // 转发字面量落盘：submit({ creditsRemain, ... })  其中 submit 内部转给 update
    for (const w of writers) {
      const re = new RegExp(`(?<![\\w$.])${w}\\(\\s*\\{`, 'g');
      for (const m of text.matchAll(re)) {
        const lit = readObjectLiteral(text, m.index + m[0].length - 1);
        if (lit === null) continue;
        for (const k of keysOfObjectLiteral(lit.body)) { covered += 1; report(k, `经 ${w}()`); }
      }
      // 转发字符串落盘：write('enabled', …) —— client 侧 UI 行走的正是这条路。
      const sre = new RegExp(`(?<![\\w$.])${w}\\(\\s*'([A-Za-z_$][\\w$]*)'`, 'g');
      for (const m of text.matchAll(sre)) { covered += 1; report(m[1], `经 ${w}()`); }
    }
  }
  return { violations, covered };
}

function readPluginSources() {
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  // src 与 lib 都要扫：client 侧的 `write('enabled', …)` 经 ConfigForm.set → mutate
  // 走的是宿主同一条 :507 预检、同一条 "is not volatile" 抛错。
  walk(SRC);
  walk(LIB);
  return files.map((p) => [p.replace(ROOT, ''), readFileSync(p, 'utf8')]);
}

test('负向对照：静态扫描器能抓到一级转发写（否则下一条就是空转）', () => {
  // 照抄真实坏例的形状：字面量传给 submit，submit 内部把变量转给 update。
  const synthetic = [[
    'synthetic.js',
    'function submit(patch) {\n  void svc.update(ns, patch);\n}\n'
    + 'submit({ creditsRemain: 1, creditsAt: 2 });\n',
  ]];
  const { violations, covered } = scanSettingsWrites(synthetic);
  assert.equal(covered, 2, '扫描器必须真的解析出了这两个键');
  assert.equal(violations.length, 0, '此刻 credits* 已是 volatile ⇒ 不该报违规（证明它确实解析到了这两个键）');

  // 再把同一段里的 creditsRemain 换成非 volatile 字段 ⇒ 必须报。
  const bad = [[
    'synthetic.js',
    'function submit(patch) {\n  void svc.update(ns, patch);\n}\n'
    + 'submit({ launch: {} });\n',
  ]];
  const r2 = scanSettingsWrites(bad);
  assert.equal(r2.violations.length, 1, '非 volatile 键经转发写必须被报出来');
  assert.match(r2.violations[0], /launch/);

  // 字符串转发（client 侧 write('enabled', …)）这条路径也要自证。
  const strBad = [['synthetic-client.js',
    'const scope = ctx.configForms.get(NS);\n'
    + 'const write = (field, next) => { scope.set(field, next); };\n'
    + "write('enabled', false);\nwrite('launch', {});\n"]];
  const r3 = scanSettingsWrites(strBad);
  assert.equal(r3.covered, 2, '字符串转发这条路径必须真的解析到');
  assert.equal(r3.violations.length, 1, `只应报 launch，实际：${JSON.stringify(r3.violations)}`);
  assert.match(r3.violations[0], /launch/);

  // 负向对照的反面：`cache.set(k, v)` 不是 configForms receiver，不得被判成 settings 写入。
  const notSettings = [['synthetic-cache.js',
    'function makeTokenProvider() {\n  cache.set(key, value);\n  return x;\n}\n'
    + 'makeTokenProvider({ configured: 1 });\n']];
  assert.deepEqual(scanSettingsWrites(notSettings).violations, [],
    '普通 Map.set 不得被误判为 settings 写入');
});

test('★ 源码里经 settings 落盘的键，一律不得是非 volatile 字段', () => {
  const { violations, covered } = scanSettingsWrites(readPluginSources());
  assert.ok(covered >= 4, `扫描必须真的匹配到调用点（当前 ${covered}），否则本用例是空转`);
  assert.deepEqual(violations, [], `非 volatile 字段被 settings 落盘：\n  ${violations.join('\n  ')}`);
});

test('★ 落盘失败不得变成 unhandled rejection（显示缓存没有杀宿主的权力）', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    // 恒定拒绝：模拟"宿主拒绝了这次写入"。
    const svc = {
      update: () => Promise.reject(new Error('Config field "x" is not volatile')),
    };
    const credits = createLiveCredits({ ns: 'dsh-plugin-workbuddy', read: () => ({ creditsRuns: 0 }) });
    credits.attach(svc);

    credits.recordRun({ ok: true, multiplier: 0.05 });
    // 让 microtask 队列彻底排空：拒绝必须已经在这里被 settle 掉。
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(unhandled.map(String), [], '拒绝泄漏成了 unhandled rejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('★ 同步抛出的 update 也不得冒泡（老 try/catch 抓的那一半）', () => {
  const credits = createLiveCredits({ ns: 'dsh-plugin-workbuddy', read: () => ({ creditsRuns: 0 }) });
  credits.attach({ update: () => { throw new Error('boom'); } });
  assert.doesNotThrow(() => credits.recordRun({ ok: true, multiplier: 0.05 }));
});

test('★ 读数成功后，四个积分字段都经由假宿主落盘（正向：真走到 write）', async () => {
  const svc = volatileOnlySettings();
  const credits = createLiveCredits({
    ns: 'dsh-plugin-workbuddy',
    read: () => ({ creditsRuns: 0 }),
    connect: async () => ({
      httpFetch: async () => ({
        json: {
          code: 0,
          data: {
            Packages: [{
              PackageCode: 'TCACA_code_007_nzdH5h4Nl0',
              CycleTotalCapacity: '1605.00000000',
              CycleRemainCapacity: '470.01000076',
              CycleUsedCapacity: '1134.98999924',
              CycleFrozenCapacity: '0.00000000',
              CapacityUnit: 'credits',
              TotalCount: 1,
            }],
          },
        },
      }),
      close: () => {},
    }),
  });
  credits.attach(svc);
  const r = await credits.refresh();
  assert.equal(r.ok, true);
  assert.equal(r.remain, 470.01000076);
  assert.equal(svc.calls.length, 1, '读成功后应落盘一次');
  assert.equal(svc.calls[0].patch.creditsRemain, 470.01000076);
  assert.equal(typeof svc.calls[0].patch.creditsAt, 'number');

  credits.recordRun({ ok: true, multiplier: 0 });
  assert.equal(svc.calls.length, 2);
  assert.equal(svc.calls[1].patch.creditsRuns, 1);
});
