/**
 * tmp/align-workbuddy.mjs —— 「模型清单 + 剩余积分」对齐验收脚本（验收方工具，非产品代码）。
 *
 * 立场：这是**验收**工具，不是自证工具。它必须先在**今天的代码**上跑成 RED，
 * 才允许用来给任何修复判 GREEN —— 一个抓不到已知缺陷的检测器，其"通过"没有意义。
 *
 * 它做的事（三层，逐层打印事实，不做推断）：
 *   ① 数据层：真宿主 `GET <gui>/plugin-workbuddy/status` 的**真** payload
 *      （`models` 条数 / 带倍率条数 / `credits` 对象 / `modelsSource`）。
 *   ② 渲染层：用真产物 `packages/plugin-workbuddy/lib/client.js` 走 test/client.test.js
 *      同一套伪宿主（伪 React + 伪 scope + 伪 ctx + 伪 primitives）渲染真卡片，
 *      读出模型下拉框的**实际 option**与卡片文本里的积分/CLI 残留。
 *   ③ 判据层：对每条判据打 RED/GREEN，并打印**判据自身的有效性前提**（它能不能红）。
 *
 * 判据（A1–A4，与 04-docs/ACCEPTANCE-workbuddy.md 对应）：
 *   A1 模型下拉框必须**不静默丢条目**：payload 里带倍率的每条模型都要出现；
 *      并报出 payload 条数 vs 桌面端权威条数（`--desktop=N` 或 tmp/recon-desktop-models.json）。
 *   A2 卡片必须画「剩余积分」（`payload.credits` 的 live/stale/unavailable 三态至少一态可见）。
 *   A3 卡片文本里**不得**残留 CLI 字样（用户明令：cli 清干净）。
 *   A4 模型 option 文本必须带倍率（`x0.11` 这类），否则"带倍率的模型"在 UI 上仍不可见。
 *
 * 用法：
 *   node tmp/align-workbuddy.mjs                 # 拉真 payload，跑全部判据
 *   node tmp/align-workbuddy.mjs --payload=tmp/live-status.json   # 用离线夹具
 *   node tmp/align-workbuddy.mjs --desktop=13    # 声明桌面端权威条数（A1 的对照）
 * 退出码：全部 GREEN → 0；任一 RED → 1。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * ★ 向上找仓库根，而不是 `join(HERE, '..')` ★
 *   本文件从 `tmp/` 移到 `tools/verify/`（为了让验收脚本随仓库发布、不被 `.gitignore` 吃掉）。
 *   写死 `'..'` 的话，挪一次目录就静默指到 `tools/` —— 而失败方式是"找不到插件、报一堆看不懂的错"，
 *   不是"路径不对"这种一眼能看出来的东西。向上找 `packages/plugin-workbuddy` 则与位置无关。
 */
function findRepoRoot(from) {
  let dir = from;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'packages', 'plugin-workbuddy', 'package.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`cannot locate the repository root from ${from} (expected packages/plugin-workbuddy/package.json above it)`);
}
const ROOT = findRepoRoot(HERE);
const PKG = join(ROOT, 'packages', 'plugin-workbuddy');
const CLIENT_PATH = join(PKG, 'lib', 'client.js');
/** 夹具目录（离线 payload）。缺了不影响实时模式。 */
const FIXTURES = join(ROOT, 'tmp');
// ★ 改成动态 import：静态 import 的路径是**相对于本文件**的，而本文件的位置会变
//   （`tmp/` → `tools/verify/`）。静态写法在换目录后不会报错在导入处，而是后面才炸，
//   报错信息还完全看不出是路径问题。动态 import 让"路径由 ROOT 决定"这件事显式。
const { EFFORT_LEVELS, NS, PACKAGE_NAME, ROUTE_STATUS } =
  await import(pathToFileURL(join(PKG, 'src', 'shared', 'constants.js')).href);

const argv = process.argv.slice(2);
const argOf = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};

const GUI = argOf('gui') ?? 'http://127.0.0.1:19387';
const PAYLOAD_FIXTURE = argOf('payload');

// ───────────────────────── 伪宿主（与 test/client.test.js 同契约，逐字对齐） ─────────────────────────

function makeFakeReact() {
  const cells = [];
  let scheduled = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(init) {
      const cursor = React.__cursor++;
      if (!(cursor in cells)) cells[cursor] = { value: typeof init === 'function' ? init() : init };
      const cell = cells[cursor];
      return [cell.value, (next) => { cell.value = typeof next === 'function' ? next(cell.value) : next; }];
    },
    useEffect(fn, deps) {
      const cursor = React.__cursor++;
      const prev = cells[cursor];
      const same =
        prev !== undefined && Array.isArray(deps) && Array.isArray(prev.deps) &&
        deps.length === prev.deps.length && deps.every((dep, i) => Object.is(dep, prev.deps[i]));
      if (prev === undefined || !same) {
        if (prev !== undefined && typeof prev.cleanup === 'function') prev.cleanup();
        cells[cursor] = { deps, fn, cleanup: undefined };
        scheduled.push(cursor);
      }
    },
    __cursor: 0,
  };
  return {
    React,
    render(Component, props) { React.__cursor = 0; return Component(props); },
    flushEffects() {
      const pending = scheduled;
      scheduled = [];
      for (const cursor of pending) {
        const cell = cells[cursor];
        const cleanup = cell.fn();
        cell.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
      }
    },
  };
}

function makeScope(initialValue = {}, { writable = true, status = 'ready' } = {}) {
  let snapshot = { status, value: { ...initialValue }, base: {}, user: {}, revision: 1, writable, mode: 'host' };
  const listeners = new Set();
  const commits = [];
  const commit = (field, value) => {
    snapshot = { ...snapshot, value: { ...snapshot.value, [field]: value }, user: { ...snapshot.user, [field]: value }, revision: snapshot.revision + 1 };
    for (const listener of listeners) listener();
  };
  return {
    commits,
    listenerCount: () => listeners.size,
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    set: async (field, value) => { commits.push({ op: 'set', field, value }); commit(field, value); },
    unset: async (field) => { commits.push({ op: 'unset', field }); commit(field, undefined); },
  };
}

function makeGuardedCtx(plugin, { scope, onEffect } = {}) {
  const declared = new Set(plugin.inject);
  const verbs = new Set(['effect', 'on', 'get']);
  const slotsCalls = [];
  const registrations = [];
  const commands = [];
  const bindSpecs = [];
  const locales = [];
  const real = {
    effect: (fn, label) => { const disposer = fn(); if (onEffect) onEffect({ label, disposer }); return disposer; },
    get: (name) => real[name],
    slots: {
      inject: (name, factory) => { slotsCalls.push({ name, factory }); return () => {}; },
      register: (options, component) => { registrations.push({ options, component }); return () => {}; },
    },
    configForms: { get: (entryId) => { bindSpecs.push({ namespace: entryId }); return scope; } },
    locale: {
      bind: (ns) => {
        const entry = locales.find((l) => l.ns === ns);
        const dicts = entry?.dicts ?? {};
        return (key) => {
          for (const lang of Object.keys(dicts)) {
            const group = key.includes('.') ? key.split('.')[0] : null;
            const leaf = group === null ? key : key.slice(group.length + 1);
            const table = dicts[lang][group];
            if (table && Object.hasOwn(table, leaf)) return typeof table[leaf] === 'function' ? table[leaf]() : table[leaf];
            if (Object.hasOwn(dicts[lang], key)) return dicts[lang][key];
          }
          return key;
        };
      },
      register: (ns, dicts) => { locales.push({ ns, dicts }); return () => {}; },
    },
    commandUi: { register: (contribution) => { commands.push(contribution); return () => {}; } },
  };
  const ctx = new Proxy({}, {
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined;
      if (!declared.has(prop) && !verbs.has(prop)) throw new Error(`undeclared service access: ${prop}`);
      return real[prop];
    },
  });
  return { ctx, slotsCalls, registrations, commands, bindSpecs };
}

function makeFakeDocument() {
  const created = [];
  return {
    created,
    head: { appendChild: (tag) => created.push(tag) },
    createElement: () => ({ dataset: {}, textContent: '' }),
    querySelector: (selector) => {
      const match = /^style\[data-plugin-css="(?<id>.+)"\]$/.exec(selector);
      if (match === null) return null;
      const id = match.groups.id;
      return created.find((tag) => tag.dataset.pluginCss === id) ?? null;
    },
  };
}

/** 伪 primitives：只镜像真机**同名**成员（名字对不上必须抛错，否则测试会放行"设置页全白"）。 */
function makeFakePrimitives(React) {
  const { createElement: h } = React;
  const table = {
    IconChevronDownOutlineRegular: (props) =>
      h('svg', { className: 'fake-primitives-icon-chevron-down-regular', 'data-size': props && props.size, 'aria-hidden': 'true' }),
  };
  return new Proxy(table, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return target[prop];
      if (!Object.prototype.hasOwnProperty.call(target, prop)) throw new Error(`primitives.${String(prop)} 不在真机导出表里`);
      return target[prop];
    },
  });
}

function makeRequire(React) {
  const requested = [];
  const primitives = makeFakePrimitives(React);
  const fakeRequire = (name) => {
    requested.push(name);
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error(`require("${name}") missed the module table`);
  };
  return { fakeRequire, requested };
}

function collect(node, visit, depth = 0) {
  if (node === null || node === undefined || depth > 60) return;
  if (Array.isArray(node)) { for (const c of node) collect(c, visit, depth + 1); return; }
  if (typeof node !== 'object') { if (typeof node === 'string' || typeof node === 'number') visit(node); return; }
  visit(node);
  if (typeof node.type === 'function') { collect(node.type(node.props), visit, depth + 1); return; }
  if (Array.isArray(node.children)) for (const c of node.children) collect(c, visit, depth + 1);
  if (node.props !== null && node.props !== undefined) {
    for (const v of Object.values(node.props)) if (v !== null && typeof v === 'object') collect(v, visit, depth + 1);
  }
}
const findAll = (tree, predicate) => { const found = []; collect(tree, (n) => { if (predicate(n)) found.push(n); }); return found; };
const textOf = (tree) => { const parts = []; collect(tree, (n) => { if (typeof n === 'string') parts.push(n); else if (typeof n === 'number') parts.push(String(n)); }); return parts.join('|'); };
/** 元素自身子文本（伪 createElement 把 variadic children 存于 node.children）。 */
const labelText = (node) => (Array.isArray(node.children) ? node.children.filter((c) => typeof c === 'string').join('') : '');

let importNonce = 0;

async function boot({ status, fetchImpl } = {}) {
  const runtime = makeFakeReact();
  const scope = makeScope({});
  const fetchFn = fetchImpl ?? (async () => ({ ok: true, status: 200, json: async () => status }));
  let captured = null;
  globalThis.window = { __ModuleLoader__: { load: (registration) => { captured = registration; } } };
  globalThis.document = makeFakeDocument();
  globalThis.fetch = fetchFn;
  await import(pathToFileURL(CLIENT_PATH).href + '?align=' + String(++importNonce));
  if (captured === null) throw new Error('bundle 未经 window.__ModuleLoader__.load 注册');
  const { fakeRequire, requested } = makeRequire(runtime.React);
  const plugin = captured.factory(fakeRequire);
  const host = makeGuardedCtx(plugin, { scope });
  plugin.apply(host.ctx);
  host.slotsCalls[0].factory();
  const entry = host.registrations[0];
  const cardProps = typeof entry.options.inject === 'function' ? entry.options.inject() : { close: () => {} };
  const render = () => runtime.render(entry.component, cardProps);
  const expand = () => {
    const tree = render();
    const toggles = findAll(tree, (n) => n.type === 'button' && typeof n.props.className === 'string' && n.props.className.includes('dsh-wb-card__toggle'));
    if (toggles.length === 0) return tree; // 默认展开的新版卡片没有折叠头，不是错误
    if (toggles[0].props['aria-expanded'] === true) return tree;
    toggles[0].props.onClick();
    return render();
  };
  return { plugin, requested, scope, host, registration: captured, render, expand, flushEffects: () => runtime.flushEffects() };
}

// ───────────────────────── 取真 payload ─────────────────────────

async function loadPayload() {
  if (PAYLOAD_FIXTURE !== null) {
    const p = join(ROOT, PAYLOAD_FIXTURE);
    return { payload: JSON.parse(readFileSync(p, 'utf8')), origin: `fixture:${PAYLOAD_FIXTURE}` };
  }
  const url = `${GUI}${ROUTE_STATUS}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const payload = await res.json();
  writeFileSync(join(HERE, 'align-live-payload.json'), JSON.stringify(payload, null, 2));
  return { payload, origin: `live:${url} (http ${res.status})` };
}

/**
 * 桌面端权威条数。
 *
 * ★ 判据必须拿一个**独立于被测 payload** 的数来比 ★
 * 拿 `--desktop=N` 手输的数字，早先是"我以为的数"——它和 payload 来自同一条推理，
 * 于是 A1b 只是在自我印证。优先**当场直读桌面端**（经 wbipc，同一条真实通路），
 * 读不到才退回 `--desktop` / 落盘夹具，并在 detail 里写明用的是哪一条。
 */
async function desktopTruth() {
  const live = argOf('live') ?? '1';
  if (live !== '0') {
    try {
      const { createDesktopModels } = await import(pathToFileURL(
        join(PKG, 'src', 'host', 'launch', 'desktop-models.js'),
      ).href);
      const dm = createDesktopModels({ ttlMs: 0 });
      await dm.refresh();
      const p = dm.projection();
      if (p.available === true && Array.isArray(p.models) && p.models.length > 0) {
        return { n: p.models.length, from: 'live-fetch(/v2/enterprises/personal/models)' };
      }
    } catch { /* 桌面端没开 / 读不到 ⇒ 落到下面两条 */ }
  }
  const flag = argOf('desktop');
  if (flag !== null) return { n: Number(flag), from: '--desktop' };
  const p = join(FIXTURES, 'recon-desktop-models.json');
  if (existsSync(p)) {
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      const n = Array.isArray(j.models) ? j.models.length : (typeof j.count === 'number' ? j.count : null);
      if (n !== null) return { n, from: 'fixtures/recon-desktop-models.json' };
    } catch { /* 忽略坏夹具，走 null */ }
  }
  return { n: null, from: 'unavailable' };
}

// ───────────────────────── 主流程 ─────────────────────────

const results = [];
const judge = (id, ok, detail) => { results.push({ id, ok, detail }); };

const { payload, origin } = await loadPayload();

console.log('═'.repeat(78));
console.log('A. 数据层 —— 真宿主 payload');
console.log('═'.repeat(78));
console.log(`  payload 来源      : ${origin}`);
console.log(`  modelsSource      : ${String(payload.modelsSource)}`);
// ★ 真 payload 是**两个平行数组**，不是一个：
//   payload.models[]      = 展示目录 {id,label,detail,isFree,supportsReasoning,cliSupported}
//   payload.cost.models[] = 成本目录 {modelId,displayName,factor,freeWindow,source,observedAt,sourceDetail}
//   倍率在 cost 里，三态 isFree 在 models 里 —— 早先脚本在 payload.models 上找 factor，
//   于是把"倍率全缺"当成事实报了出来，那是脚本自己看错了字段。
const catalog = Array.isArray(payload.models) ? payload.models : [];
const costModels = Array.isArray(payload.cost?.models) ? payload.cost.models : [];
const factorOf = new Map(costModels.map((m) => [String(m.modelId), m]));
const withFactor = catalog.filter((m) => {
  const hit = factorOf.get(String(m.id));
  return hit !== undefined && hit.factor !== null && hit.factor !== undefined;
});
const withIsFree = catalog.filter((m) => m && m.isFree !== null && m.isFree !== undefined);
console.log(`  models 条数(展示) : ${catalog.length}`);
console.log(`  cost.models 条数  : ${costModels.length}  available=${String(payload.cost?.available)} source=${String(payload.cost?.source)} unknown=${String(payload.cost?.unknown)}`);
console.log(`  带倍率条数(factor != null): ${withFactor.length}`);
console.log(`  倍率明细          : ${withFactor.map((m) => `${m.id}=x${factorOf.get(String(m.id)).factor}`).join(' ')}`);
console.log(`  isFree != null 条数: ${withIsFree.length}（${withIsFree.map((m) => `${m.id}=${m.isFree}`).join(' ')}）`);
console.log(`  ★ 不变式 isFree非空 ⟺ 有倍率 : ${withIsFree.length === withFactor.length && withIsFree.every((m) => factorOf.get(String(m.id))?.factor != null) ? '成立' : '不成立（两个数据面已经漂开）'}`);
console.log(`  credits           : ${JSON.stringify(payload.credits ?? null)}`);
console.log(`  cliModels         : ${payload.cliModels === undefined ? '(缺字段)' : JSON.stringify(payload.cliModels).slice(0, 160)}`);

const desktop = await desktopTruth();
console.log(`  桌面端权威条数    : ${desktop.n === null ? '(未知 — 侦察未回)' : `${desktop.n}（来源 ${desktop.from}）`}`);
console.log('');

console.log('═'.repeat(78));
console.log('B. 渲染层 —— 真产物 lib/client.js 渲染真卡片');
console.log('═'.repeat(78));
const b = await boot({ status: payload, fetchImpl: async () => ({ ok: true, status: 200, json: async () => payload }) });
/**
 * ★ 结算必须**轮询到卡片真的离开加载态**，不能按固定 tick 数猜 ★
 * 早先只等 8 个 setImmediate：卡片仍停在「剩余积分：读取中」就取了树，于是
 * "模型下拉 0 条"这个 RED **是脚本自己造成的假红**，而 A2 那个只查字面的判据又同时给了假绿
 * —— 一假一假抵消，看起来"还有 3 项没做"，其实一项都没测到。
 * 现在按**可观测状态**收敛：反复 flush + 让微任务跑完，直到积分行不再是"读取中"，或到上限。
 * 到上限仍未加载 ⇒ 判据照常报 RED，并把"卡片没加载"这件事本身说出来。
 */
const SETTLE_MAX = 200;
let settleRounds = 0;
let loaded = false;
for (let i = 0; i < SETTLE_MAX; i += 1) {
  b.flushEffects();
  for (let k = 0; k < 4; k += 1) await new Promise((r) => setImmediate(r));
  settleRounds = i + 1;
  const probeText = textOf(b.expand());
  if (probeText.includes('剩余积分：读取中')) continue;
  loaded = true;
  break;
}
console.log(`  结算轮数          : ${settleRounds}（${loaded ? '卡片已离开加载态' : '★ 到上限仍未加载 —— 判据读数一律不可信'}）`);
const tree = b.expand();
const fullText = textOf(tree);
const selects = findAll(tree, (n) => n.type === 'select');
console.log(`  require() 清单    : ${b.requested.join(', ')}`);
console.log(`  卡片内 select 数  : ${selects.length}`);
let modelSelect = null;
for (const [i, sel] of selects.entries()) {
  const opts = findAll(sel, (n) => n.type === 'option');
  const texts = opts.map((o) => labelText(o));
  console.log(`  select[${i}] options=${opts.length}`);
  for (const t of texts) console.log(`      · ${t}`);
  const ids = opts.map((o) => String(o.props.value ?? ''));
  if (modelSelect === null && ids.some((v) => catalog.some((m) => m.id === v))) modelSelect = { sel, opts, texts, ids };
}
const renderedOptions = modelSelect === null ? [] : modelSelect.opts;

console.log('');
console.log('  —— 卡片全文本（截断 700）——');
console.log('  ' + fullText.slice(0, 700).split('|').join(' | '));
console.log('');

// A1：不静默丢条目（客户端侧契约）
// ★ 口径修正：早先只拿"带倍率的那几条"当分母，于是"无倍率的条目被整片隐藏"这件事**测不到**
//   —— 而那恰恰是 8 vs 13 那个缺陷的形态。分母必须是**整份目录**。
const renderedIds = new Set((modelSelect?.ids ?? []).map(String));
const catalogIds = catalog.map((m) => String(m.id));
const missing = catalogIds.filter((id) => !renderedIds.has(id));
// ★ 只统计"确实是目录项"的 option：下拉第一行是「未固定（每次下发时由 DSH 现选）」这个**哨兵**，
//   它的 value 是空串。把哨兵算进条数 = 分母多 1，于是条数永远对不上（判据自己造假的）。
const renderedModelOptions = (modelSelect?.opts ?? []).filter((o) => catalogIds.includes(String(o.props.value ?? '')));
judge('A1 模型下拉框不丢条目', missing.length === 0 && modelSelect !== null,
  modelSelect === null ? '没找到模型 select' : `payload 目录 ${catalogIds.length} 条，渲染 ${renderedModelOptions.length} 条，缺失=[${missing.join(',')}]`);

// A1b：与桌面端权威条数对照（数据层缺口）
const renderedCount = renderedModelOptions.length;
const desktopGap = desktop.n === null ? null : desktop.n - renderedCount;
judge('A1b 渲染条数 == 桌面端权威条数', desktopGap === null ? false : desktopGap === 0,
  desktopGap === null ? '桌面端权威条数未知，无法对照（视为 RED：验收前提未满足）'
    : `桌面端 ${desktop.n} vs 卡片 ${renderedCount}（差 ${desktopGap}）`);

// A2：剩余积分必须**画出一个数**，而不是只出现这三个字。
// ★ 2026-10-02 修正一处**假绿**：原判据只测 `fullText.includes('剩余积分')`，
//   而卡片在"加载中"态下这三个字照样在树上 ⇒ 宿主明明返回了 remain=942.03，判据仍判 GREEN。
//   这就是"验收脚本测的是文案而不是需求"的典型：它把"有这行标题"读成了"积分读到了"。
//   现在要求：出现「剩余积分」**且**出现一个真数字，且**不在**加载态。
const creditsObj = payload.credits ?? null;
const remaining = typeof creditsObj?.remain === 'number' ? creditsObj.remain : null;
const stillLoading = /剩余积分：(读取中|加载中)/.test(fullText);
const creditsNumberShown = remaining === null
  ? false
  // 两位小数是卡片自己的口径（`toFixed(2)`）；先按它找，找不到再放宽成"任意数字"，
  // 以免"卡片改了精度"被误判成"积分没读出来"——判据要钉需求，不是钉格式。
  : (fullText.includes(remaining.toFixed(2)) || new RegExp(`${remaining.toFixed(2).split('.')[0]}(\\.\\d+)?`).test(fullText));
const creditsInText = fullText.includes('剩余积分');
judge('A2 卡片画出「剩余积分」（要有数值，不接受加载态）',
  creditsInText && !stillLoading && creditsNumberShown,
  stillLoading
    ? '★ RED：卡片仍停在「剩余积分：加载中」⇒ 要么宿主没回、要么**脚本没等到 fetch 结算**（先查检测器，别急着改产品）'
    : creditsInText && creditsNumberShown
      ? `可见（remain=${remaining}）`
      : `卡片文本里没有「剩余积分」或没有数值（字典 key 残留=${fullText.includes('credits')}）`);

// A3：CLI 残留
const cliHits = (fullText.match(/CLI|cli/gi) ?? []).length;
judge('A3 卡片无 CLI 残留', cliHits === 0, `命中 ${cliHits} 处`);
const cliInOptions = renderedOptions.filter((o) => /CLI|cli/.test(labelText(o))).length;
judge('A3b 模型 option 无 CLI 标记', cliInOptions === 0, `命中 ${cliInOptions} 条`);

// A4：凡是**声明了倍率**的目录项，option 文本必须把倍率印出来。
// ★ 口径修正：早先分母是"全部 option"，于是两行永远过不了 ——
//   「未固定（每次下发时由 DSH 现选）」是哨兵、`Auto` 服务端就没给倍率，两者都**本该**没有倍率。
//   正确判据是两条，正反都要：
//     ① 有倍率的 ⇒ 必须印 `（x…）`；
//     ② 无倍率的 ⇒ 必须印「倍率未知」，**不得**静默留白（留白 = 看起来像没有倍率这回事）。
const withFactorIds = new Set(withFactor.map((m) => String(m.id)));
const shouldShow = renderedModelOptions.filter((o) => withFactorIds.has(String(o.props.value ?? '')));
const noFactorIds = new Set(catalogIds.filter((id) => !withFactorIds.has(id)));
const shouldSayUnknown = renderedModelOptions.filter((o) => noFactorIds.has(String(o.props.value ?? '')));
const shownFactor = shouldShow.filter((o) => /x\s*[0-9]/.test(labelText(o))).length;
const shownUnknown = shouldSayUnknown.filter((o) => /倍率未知/.test(labelText(o))).length;
judge('A4 倍率展示：有值印值、无值明说未知',
  renderedModelOptions.length > 0 && shownFactor === shouldShow.length && shownUnknown === shouldSayUnknown.length,
  `有倍率 ${shownFactor}/${shouldShow.length} 印出倍率；无倍率 ${shownUnknown}/${shouldSayUnknown.length} 印出「倍率未知」`);

console.log('═'.repeat(78));
console.log('C. 判据');
console.log('═'.repeat(78));
for (const r of results) console.log(`  [${r.ok ? 'GREEN' : ' RED '}] ${r.id} — ${r.detail}`);
const reds = results.filter((r) => !r.ok);
console.log('');
console.log(`  ${results.length - reds.length}/${results.length} GREEN；${reds.length} RED`);
console.log('');
console.log('  检测器有效性自检（这个脚本能不能红）：');
console.log('    · A2 若 lib/client.js 里没有任何 credits 代码 → 必 RED（今天即是）');
console.log('    · A3 若卡片仍含 "CLI 未列"/"CLI 路径" → 必 RED（今天即是）');
console.log('    · A4 若 option 文本只有 label 无倍率 → 必 RED');
process.exit(reds.length === 0 ? 0 : 1);
