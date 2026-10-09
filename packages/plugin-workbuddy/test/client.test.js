/**
 * T03 client bundle 验收测试（判据 ①–⑤ 机器断言）。
 *
 * 测试对象 = **真实产物** `lib/client.js`（不是源代码的副本）：以伪宿主捕获
 * `window.__ModuleLoader__.load` 的注册，再用「hook 运行时」做浅渲染 + 效果回放。
 *
 * ★ 2026-10-02（四块布局）：卡片内容区按 头 / 任务 / 配置 / 状态 四段组织。
 *   折叠纪律 —— `registrationError` 原文 / 旗标名（`--model` 之类）/ 退出码 /
 *   本机路径 / 各类 id **只进折叠**（`<details>`），主视图只留人话。
 *   本文件用 `mainText()`（剔掉折叠子树）与 `foldText()`（只取折叠子树）
 *   把这条纪律逐条钉死；只用 `textOf()` 的旧断言凡涉及内部串的一律改到这两口径。
 *
 * 可证边界（诚实登记，见 04-docs/RECON-T03-RESULT.md §6）：
 *   - 可证：模块注册形态 / 卡片与命令的注册描述符 / 读路径（settingsScope 快照 → 树）/ 写路径
 *     （交互回调 → scope.set → 快照变更 → 重渲染）/ 三态与状态区文案 / CSS 去重 / 常量同步。
 *   - 不可证（留受控窗口 W-11）：真机 React 渲染、slot dispatch、settings 写穿透到 host 落盘、
 *     `t()` 文案、真机 fetch 同源可达性。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { EFFORT_LEVELS, NS, PACKAGE_NAME, ROUTE_STATUS } from '../src/shared/constants.js';

/** 界面实际渲染的档位（6 档：canonical 7 档去 `off`；与产物内 `EFFORT_UI_LEVELS` 同口径）。 */
const EFFORT_UI = EFFORT_LEVELS.filter((level) => level !== 'off');

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = join(HERE, '..');
const CLIENT_PATH = join(PACKAGE_DIR, 'lib', 'client.js');
const PACKAGE_JSON = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'));

let importNonce = 0;

// ───────────────────────── 伪宿主 ─────────────────────────

/** 伪 React：真 hook 语义的极小子集（cells 跨渲染保留；effect 在 render 后回放，deps 相同则跳过）。 */
function makeFakeReact() {
  const cells = [];
  /** @type {number[]} */
  let scheduled = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(init) {
      const cursor = React.__cursor++;
      if (!(cursor in cells)) cells[cursor] = { value: typeof init === 'function' ? init() : init };
      const cell = cells[cursor];
      return [
        cell.value,
        (next) => {
          cell.value = typeof next === 'function' ? next(cell.value) : next;
        },
      ];
    },
    useEffect(fn, deps) {
      const cursor = React.__cursor++;
      const prev = cells[cursor];
      const same =
        prev !== undefined &&
        Array.isArray(deps) &&
        Array.isArray(prev.deps) &&
        deps.length === prev.deps.length &&
        deps.every((dep, i) => Object.is(dep, prev.deps[i]));
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
    render(Component, props) {
      React.__cursor = 0;
      return Component(props);
    },
    /** 回放本次渲染排定的 effect（返回其 cleanup 供断言）。 */
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

/** 伪 settingsScope（镜像真机契约 `dsh-client-ui-settings/lib/client.js:949-1081`）。 */
function makeScope(initialValue = {}, { writable = true, status = 'ready' } = {}) {
  let snapshot = {
    status,
    value: { ...initialValue },
    base: {},
    user: {},
    revision: 1,
    writable,
    mode: 'host',
  };
  const listeners = new Set();
  const commits = [];
  let failNextSet = false;
  const commit = (field, value) => {
    snapshot = {
      ...snapshot,
      value: { ...snapshot.value, [field]: value },
      user: { ...snapshot.user, [field]: value },
      revision: snapshot.revision + 1,
    };
    for (const listener of listeners) listener();
  };
  return {
    commits,
    listenerCount: () => listeners.size,
    failNextSet: () => {
      failNextSet = true;
    },
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: async (field, value) => {
      commits.push({ op: 'set', field, value });
      if (failNextSet) {
        failNextSet = false;
        throw new Error('settings write failed (fake)');
      }
      commit(field, value);
    },
    unset: async (field) => {
      commits.push({ op: 'unset', field });
      commit(field, undefined);
    },
  };
}

/** 伪 ctx：服务访问守卫（镜像 `dsh-cordis-client-runner/lib/client.js:320-322` —— 未声明即拒绝）。 */
function makeGuardedCtx(plugin, { scope, onEffect } = {}) {
  const declared = new Set(plugin.inject);
  const verbs = new Set(['effect', 'on', 'get']);
  const slotsCalls = [];
  const registrations = [];
  const bindSpecs = [];
  const locales = [];
  const real = {
    effect: (fn, label) => {
      const disposer = fn();
      if (onEffect) onEffect({ label, disposer });
      return disposer;
    },
    get: (name) => real[name],
    slots: {
      inject: (name, factory) => {
        slotsCalls.push({ name, factory });
        return () => {};
      },
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
    // ★★ 2026-10-01 迁移：宿主 0.2.0 里 `settingsScope` **已消失**
    //   （`04-docs/MIGRATION-0.1.5-to-0.1.7.md` §1.2 C2）。产品侧已改成 `ctx.configForms.get(NS)`
    //   并新增必需 inject `locale`；harness 必须跟上，否则 apply() 直接 TypeError，
    //   **整份套件全红且看起来像产品坏了** —— 与 2026-10-01 那次启动事故同一类根因，只是发生在测试侧。
    configForms: {
      get: (entryId) => {
        bindSpecs.push({ namespace: entryId });
        return scope;
      },
    },
    // locale 是必需 inject：注册项的 `label` thunk 通过 `ctx.locale.bind(NS)` 取值
    //   （0.1.7 的 slot renderer **不注入** locale prop）。用 bundle 自己注册的那份字典解析 ⇒ t 与产物同源。
    locale: {
      bind: (ns) => {
        const entry = locales.find((l) => l.ns === ns);
        const dicts = entry?.dicts ?? {};
        return (key) => {
          for (const lang of Object.keys(dicts)) {
            const group = key.includes('.') ? key.split('.')[0] : null;
            const leaf = group === null ? key : key.slice(group.length + 1);
            const table = dicts[lang][group];
            if (table && Object.hasOwn(table, leaf)) {
              return typeof table[leaf] === 'function' ? table[leaf]() : table[leaf];
            }
            if (Object.hasOwn(dicts[lang], key)) return dicts[lang][key];
          }
          return key;
        };
      },
      register: (ns, dicts) => {
        locales.push({ ns, dicts });
        return () => {};
      },
    },
  };
  const ctx = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        if (!declared.has(prop) && !verbs.has(prop)) {
          throw new Error(`undeclared service access: ${prop}（须在 plugin.inject 声明）`);
        }
        return real[prop];
      },
    },
  );
  return { ctx, slotsCalls, registrations, bindSpecs };
}

/** 伪 document（仅 CSS 去重所需面）。 */
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

/**
 * 状态载荷夹具。
 *
 * ★★ 2026-10-01：WorkBuddy 的命令行链路整体删除 ⇒ 载荷**两支平行数组**，读错字段会拿到假事实 ★★
 *   · `models[]`      展示目录 —— 决定下拉框**有哪些行**（含 `isFree`/`supportsReasoning`）；
 *   · `cost.models[]` 倍率目录 —— 倍率**只在这里**（`cost.models[].factor`）。
 *   `models[].factor` **恒为 `null`**（展示目录里没这个字段）：客户端若在 models 上找 factor，
 *   会把整张表标成"倍率未知"——那是把"读错字段"报成"厂商没声明"。
 *   ⇒ 夹具必须**同时**给两支，且让两边的倍率值互相自洽（真机 model-catalog/cost-catalog 同源）。
 *
 * ★ 再强调一处口径：**目录里有没有条目**只由 `models[]` 决定；**倍率有没有**只由 `cost.models[]` 决定。
 *   两者互不门禁 —— 某条目录项在 cost 里查不到，它的倍率是"未知"，不是"这条不该出现"。
 *
 * ★ 另：载荷里那份"命令行支持快照"（`cliModels`）已废弃，夹具不再提供，客户端也不再读。
 *
 * @param {object} [overrides] 覆盖载荷字段。
 *   ⚠️ 传了 `models` 而**没传** `cost` 时，`cost.models` 会**自动重算**为"覆盖后 models 里 id 为 m2 的那条
 *   = factor 0.06"——否则所谓"覆盖 models"会被默认 cost 悄悄贴上倍率，测试断言的就不是它自己写的那张表了
 *   （写这条测试时真踩到过：期望"未知"，实际拿到 0.06）。
 */
function statusPayload(overrides = {}) {
  const base = {
    pluginId: 'plugin-workbuddy',
    registry: 'REGISTERED',
    probe: { target: 'workbuddy', installed: true, reason: 'ok', resolvedPath: 'C:/wb/codebuddy', evidence: [], at: 1, method: 'no-exec' },
    config: { enabled: false, model: '', effort: '' },
    // xhigh 刻意取非恒等映射（'extra-high'）—— 让"读 values[level]"与"印 canonical"在测试里可区分。
    effort: { canonical: [...EFFORT_LEVELS], values: { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'extra-high', max: 'max' } },
    models: [
      { id: 'm1', label: 'Model One', detail: '', isFree: false, supportsReasoning: true },
      { id: 'm2', label: 'Model Two', detail: '10x', isFree: false, supportsReasoning: true },
    ],
    // 倍率单一来源。★ `m1` 刻意**不给**倍率 ⇒ "倍率未知"这条分支在默认夹具里就有一行可断言。
    cost: { models: [{ modelId: 'm2', displayName: 'Model Two', factor: 0.06, freeWindow: null, source: 'product' }] },
    modelsSource: 'product.json',
    // 默认给一份**有值**的积分：卡片必须能把它画出来（缺省 null 会让"加载中"分支在多数用例里被误当常态）。
    credits: { ok: true, source: 'live', remain: 987.47, at: 1, ageMs: 1_000, stale: false, unit: 'credits', isPaidUser: true, packages: [], error: null },
    inFlight: [],
    lastRun: null,
  };
  const merged = { ...base, ...overrides };
  const modelsOverridden = Object.hasOwn(overrides, 'models');
  const costOverridden = Object.hasOwn(overrides, 'cost');
  if (modelsOverridden && !costOverridden) {
    const ids = new Set((Array.isArray(merged.models) ? merged.models : []).map((m) => m && m.id));
    merged.cost = { models: base.cost.models.filter((c) => ids.has(c.modelId)) };
  }
  return merged;
}

/**
 * 桌面端通路（automation）的 `lastRun` 夹具 —— 当前 host 唯一会产出的形状
 * （见 `src/host/tools/run.js` 的 `runtime.noteRun` 调用点）。
 *
 * ★ 与 CLI 时代的字段表**不同**：`argv` 是数组（常为空）、`flags` 是对象（`{}`，不是数组），
 *   没有 `stderrExcerpt` / `flagEvidence`；失败经 `reasonCode`/`reasonText` 归一，
 *   回执经 `title` / `sessionId` / `automationId` / `retired` / `createdAt` 可视。
 *   ⇒ CLI 时代的逐 flag 回滚在本形状下**永远不触发**（`flags` 非数组 ⇒ 无归因 ⇒ 谁都不许动）。
 */
function autoRun(overrides = {}) {
  return {
    transport: 'automation',
    at: 2,
    exitCode: 0,
    reasonCode: 'ok',
    reasonText: '',
    receipt: null,
    model: null,
    permission: { requested: '', effective: '(unknown)', confirmed: false },
    effort: { requested: '', effective: '(unknown)', confirmed: false },
    automationId: null,
    sessionOrigin: null,
    sessionId: null,
    title: null,
    createdAt: null,
    created_at: null,
    sessionRenewed: '',
    sessionPersist: null,
    retired: null,
    sessionKey: '',
    resumed: false,
    // ★ M2 会话复用可见性：host 的 noteRun 现在总产出这三个键（fallback 恒布尔、
    //   fallbackReason 指纹码或 null、followUp 元数据或 null）—— 夹具形状保持与 host 同步。
    fallback: false,
    fallbackReason: null,
    followUp: null,
    recycle: null,
    instance: null,
    sidecar: null,
    toolCalls: { count: 0, names: [] },
    phases: [],
    stdoutText: '',
    argv: [],
    flags: {},
    notSent: [],
    usage: null,
    flagVerdict: null,
    ...overrides,
  };
}

/**
 * 在受控全局环境下加载 bundle 并捕获注册。
 * @param {{ document?: object, fetch?: Function }} env
 */
async function withBundle(env, fn) {
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  let captured = null;
  globalThis.window = { __ModuleLoader__: { load: (registration) => { captured = registration; } } };
  if (env.document !== undefined) globalThis.document = env.document;
  else delete globalThis.document;
  if (env.fetch !== undefined) globalThis.fetch = env.fetch;
  try {
    await import(pathToFileURL(CLIENT_PATH).href + '?case=' + String(++importNonce));
    assert.ok(captured !== null, 'bundle 必须经 window.__ModuleLoader__.load 注册');
    return await fn(captured);
  } finally {
    if (previous.window === undefined) delete globalThis.window;
    else globalThis.window = previous.window;
    if (previous.document === undefined) delete globalThis.document;
    else globalThis.document = previous.document;
    if (previous.fetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previous.fetch;
  }
}

/**
 * 伪 primitives（seed 模块之一）；图标渲染为可断言的 svg 节点（真机由 primitives 提供）。
 *
 * ★ 2026-10-02 事故复盘 —— 本文件当时为何放行了一个"设置页全白"的线上缺陷：
 * 这里原先伪造的成员名是 `IconChevronDownOutline14`，而真机导出表
 * （primitives/lib/index.js:12381）里**只有** `IconChevronDownOutline{Regular,Medium}`
 * ——`…Artwork` 是内部实现、`14` 只是它的 `size` 默认值（index.js:482），**不存在** `…14` 这个名字。
 * 伪件与真机同名 ⇒ 两边"都有"，而真机取到的是 `undefined` ⇒ `h(undefined)` 在设置页渲染期抛错
 * ⇒ 被宿主 SlotErrorBoundary（dsh-client-ui-renderer/lib/client.js:611-625）吞成一个空 div
 * ⇒ 用户看到"设置项在、里面全白"。绿测试从未覆盖这条路径。
 * 因此伪件改为两条硬约束：① 只镜像真机**同名**成员；② 读取未知成员立刻抛错。
 * 名字一旦对不上，测试必红 —— 这正是原先缺失的那道探测。
 */
function makeFakePrimitives(React) {
  const { createElement: h } = React;
  const exportsTable = {
    IconChevronDownOutlineRegular: (props) =>
      h('svg', {
        className: 'fake-primitives-icon-chevron-down-regular',
        'data-size': props && props.size,
        'aria-hidden': 'true',
      }),
  };
  return new Proxy(exportsTable, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return target[prop];
      if (!Object.prototype.hasOwnProperty.call(target, prop)) {
        throw new Error(
          `primitives.${String(prop)} 在真机导出表里不存在（伪件只镜像真机成员；` +
            '新增成员前先核对 primitives/lib/index.js 的导出表）',
        );
      }
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
    throw new Error(`require("${name}") missed the module table（白名单仅 9 个 seed）`);
  };
  return { fakeRequire, requested, primitives };
}

/** 展开函数组件后的全树搜集（子组件均为纯函数，可安全调用；嵌套数组展平）。 */
function collect(node, visit, depth = 0) {
  if (node === null || node === undefined || depth > 60) return;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, visit, depth + 1);
    return;
  }
  if (typeof node !== 'object') {
    if (typeof node === 'string' || typeof node === 'number') visit(node);
    return;
  }
  visit(node);
  if (typeof node.type === 'function') {
    collect(node.type(node.props), visit, depth + 1);
    return;
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) collect(child, visit, depth + 1);
  }
  if (node.props !== null && node.props !== undefined) {
    for (const value of Object.values(node.props)) {
      if (value !== null && typeof value === 'object') collect(value, visit, depth + 1);
    }
  }
}

function findAll(tree, predicate) {
  const found = [];
  collect(tree, (node) => {
    if (predicate(node)) found.push(node);
  });
  return found;
}

function textOf(tree) {
  const parts = [];
  collect(tree, (node) => {
    if (typeof node === 'string') parts.push(node);
    else if (typeof node === 'number') parts.push(String(node));
  });
  return parts.join('|');
}

/**
 * 主视图文本：`textOf` 减去**所有折叠子树**（`<details>` 整体跳过，含其 summary）。
 *
 * ★ 折叠纪律的判定口径（2026-10-02）：内部串（registrationError 原文 / 旗标名 /
 *   退出码 / 本机路径 / 各类 id）**只进折叠** ⇒ 它们在 `mainText()` 里必须缺席、
 *   在 `foldText()` 里必须出现。注意折叠的 summary 自身也是主视图的一部分，
 *   所以这里连 summary 一起跳过 —— summary 里本来就不许出现内部串（另有断言锁）。
 */
function mainText(tree) {
  const parts = [];
  const walk = (node, inDetails, depth = 0) => {
    if (node === null || node === undefined || depth > 60) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, inDetails, depth + 1);
      return;
    }
    if (typeof node !== 'object') {
      if (!inDetails && (typeof node === 'string' || typeof node === 'number')) parts.push(String(node));
      return;
    }
    const isDetails = node.type === 'details';
    const inside = inDetails || isDetails;
    if (typeof node.type === 'function') {
      walk(node.type(node.props), inside, depth + 1);
      return;
    }
    if (node.type === 'summary' || node.type === 'details') {
      // summary 是主视图（折叠的"门"），details 本体是折叠内容 —— 门要收，内容要剔。
      if (node.type === 'summary' && !inDetails) {
        if (Array.isArray(node.children)) for (const child of node.children) walk(child, false, depth + 1);
        return;
      }
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) walk(child, inside, depth + 1);
    }
    if (node.props !== null && node.props !== undefined) {
      for (const value of Object.values(node.props)) {
        if (value !== null && typeof value === 'object') walk(value, inside, depth + 1);
      }
    }
  };
  walk(tree, false);
  return parts.join('|');
}

/** 折叠文本：所有 `<details>` 子树（含其 summary）的文本。 */
function foldText(tree) {
  const details = findAll(tree, (n) => n.type === 'details');
  return details.map((d) => textOf(d)).join('||');
}

/** 元素自身子文本（伪 createElement 把 variadic children 存于 node.children）。 */
function labelText(node) {
  return Array.isArray(node.children) ? node.children.filter((c) => typeof c === 'string').join('') : '';
}

/** 收起态三值摘要各值（model · effort · credits）的文本。 */
function summaryItems(tree) {
  return findAll(
    tree,
    (n) => n.type === 'span' && String(n.props?.className ?? '').split(' ').includes('dsh-wb-card__summary-item'),
  ).map((n) => labelText(n));
}

/**
 * 起一套完整宿主：注册（apply）→ 卡片 props（inject 面）→ 渲染。
 *
 * ⚠️ 与 withBundle 不同，boot 会在**整个用例生命周期内**保留全局覆盖（fetch 在 effect 回放时
 *    才被调用 ⇒ 不能在导入后立即还原）；每次 boot 覆盖上一例，进程随测试结束退出。
 */
async function boot({ scopeValue = {}, scopeOptions = {}, status = statusPayload(), fetchImpl } = {}) {
  const runtime = makeFakeReact();
  const scope = makeScope(scopeValue, scopeOptions);
  const fetches = [];
  const fetchFn =
    fetchImpl ??
    (async (url, options) => {
      fetches.push({ url, options });
      return { ok: true, status: 200, json: async () => status };
    });
  let captured = null;
  globalThis.window = { __ModuleLoader__: { load: (registration) => { captured = registration; } } };
  globalThis.document = makeFakeDocument();
  globalThis.fetch = fetchFn;
  await import(pathToFileURL(CLIENT_PATH).href + '?case=' + String(++importNonce));
  assert.ok(captured !== null, 'bundle 必须经 window.__ModuleLoader__.load 注册');

  const { fakeRequire, requested } = makeRequire(runtime.React);
  const plugin = captured.factory(fakeRequire);
  const effects = [];
  const host = makeGuardedCtx(plugin, { scope, onEffect: (e) => effects.push(e) });
  plugin.apply(host.ctx);
  const slotCall = host.slotsCalls[0];
  slotCall.factory(); // 槽已声明 ⇒ 工厂触发注册（真机由 slots.inject 在声明期回调）
  const registrationEntry = host.registrations[0];
  /**
   * ★ 2026-10-02 更正（测试侧契约错，非产品缺陷）：
   *   `settings.section` 的注册项**不带 `inject`** —— 宿主渲染处是
   *   `renderSlot("settings.section", { close: onClose }, { only: active })`
   *   （`dsh-client-ui-settings-general/lib/client.js:337`），props 只有 `{ close }`；
   *   官方注册样板（同文件 `:1171-1181`）同样不写 `inject`。配置面（scope）由**闭包**注入组件。
   *   旧写法无条件调 `options.inject()` ⇒ 45 例 `ERR_TEST_FAILURE`（"inject is not a function"），
   *   看上去像产品全红，实为本 harness 在断言一条**宿主并不存在的契约**。
   *   这里照真机传 `{ close }`；若日后注册项真带上 `inject`，优先采用它（两种都合规）。
   */
  const cardProps =
    typeof registrationEntry.options.inject === 'function'
      ? registrationEntry.options.inject()
      : { close: () => {} };
  const render = () => runtime.render(registrationEntry.component, cardProps);
  /**
   * 幂等展开卡片并返回展开后的树（收纳语义 ⇒ 内容断言需先确保展开）。
   * 已展开（aria-expanded=true）时直接返回当前树 —— 可安全替换内容断言里的单点 render()。
   * ★ 2026-10-02：卡片默认改为**展开**（宿主惯例 `open ?? true`，见 settings-plugin-inventory:339-340），
   * 因此本助手在默认态下退化为纯 render()；保留它是因为它同时充当"折叠头必须存在"的断言。
   */
  const expand = () => {
    const tree = render();
    const toggle = findAll(tree, (n) => n.type === 'button' && n.props.className === 'dsh-wb-card__toggle')[0];
    assert.ok(toggle !== undefined, '卡片必须渲染折叠头（dsh-wb-card__toggle）');
    if (toggle.props['aria-expanded'] === true) return tree;
    toggle.props.onClick();
    return render();
  };
  return {
    registration: captured,
    plugin,
    requested,
    runtime,
    scope,
    fetches,
    host,
    slotCall,
    registrationEntry,
    cardProps,
    render,
    expand,
    flushEffects: () => runtime.flushEffects(),
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

// ───────────────────────── 判据 + 组成前提 ─────────────────────────

test('组成前提：bundle id = 包名，dsh.client.platform=web，exports["./client"] 文件真实存在', async () => {
  await withBundle({}, async (registration) => {
    assert.equal(registration.id, PACKAGE_JSON.name, 'load id 必须 === package.json name（dsh-client-modules:648-659）');
    assert.equal(registration.id, PACKAGE_NAME);
    assert.equal(PACKAGE_JSON.dsh.client.platform, 'web', 'platform !== web 会被静默跳过（dsh-client-modules:650）');
    const clientRel = PACKAGE_JSON.exports['./client'];
    assert.equal(typeof clientRel, 'string');
    assert.ok(existsSync(join(PACKAGE_DIR, clientRel)), 'exports["./client"] 指向的文件必须存在（缺失 = 启动期 loud 失败）');
    assert.ok(PACKAGE_JSON.files.includes(clientRel.replace(/^\.\//, '')), 'files 白名单必须含 client 产物');
    // inject 指向真实存在的服务提供包（回归：旧值 dsh-client-runtime 在 scope 内不存在）
    assert.deepEqual(PACKAGE_JSON.dsh.client.inject, [
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-settings',
    ]);
  });
});

test('判据①：★ 卡片注册进 settings.section（0.1.7+ 契约），id = settings namespace', async () => {
  await withBundle({}, async (registration) => {
    const { fakeRequire } = makeRequire(makeFakeReact().React);
    const plugin = registration.factory(fakeRequire);
    const scope = makeScope();
    const host = makeGuardedCtx(plugin, { scope });
    plugin.apply(host.ctx);

    assert.equal(host.slotsCalls.length, 1);
    // ★ 2026-10-01 迁移：`settings.plugin.item` 在 0.1.7 已被移除（该槽全树零命中），
    //   设置导航栏条目改挂 `settings.section`（`MIGRATION-0.1.5-to-0.1.7.md` §2.1）。
    assert.equal(host.slotsCalls[0].name, 'settings.section', '导航栏条目必须挂 settings.section');
    assert.equal(host.bindSpecs.length, 1);
    assert.deepEqual(host.bindSpecs[0], { namespace: NS }, 'configForms.get 必须用与 loader 行 id 相同的 namespace');

    await host.slotsCalls[0].factory();
    assert.equal(host.registrations.length, 1);
    const { options } = host.registrations[0];
    assert.equal(options.name, 'settings.section');
    // ★ 0.1.7 的 section 注册项用 `id`（不再是 `key`），并带 `order` / `label` thunk / `locale`。
    assert.equal(options.id, NS, 'id 必须是 settings namespace');
    assert.equal(typeof options.order, 'number', 'section 是 list 注册项 ⇒ 必须给排序位次');
    assert.equal(typeof options.label, 'function', '★ label 必须是 thunk：0.1.7 的 section 把它当函数求值');
    assert.equal(typeof options.label(), 'string', 'label thunk 必须真的求得出字符串（否则导航栏里是空标题）');
    assert.equal(options.locale, NS, '★ locale 选项决定 t 从哪个命名空间解析（slot renderer 不注入 locale prop）');
    /**
     * ★ 2026-10-02 更正：断言"注册项必须带 `inject`"是**测试侧的假契约**。
     *   `settings.section` 的渲染处是
     *   `renderSlot("settings.section", { close: onClose }, { only: active })`
     *   （`dsh-client-ui-settings-general/lib/client.js:337`）—— 只递 `{ close }`；
     *   官方样板（同文件 `:1171-1181`）同样不写 `inject`。配置面（scope）由**闭包**注入组件。
     *   旧断言无条件调 `options.inject()` ⇒ 45 例 `ERR_TEST_FAILURE`，看起来像产品全红。
     *   这里改为断言真契约 + 用真机 props 渲染，证明闭包确实绑上了 scope。
     */
    assert.equal(options.inject, undefined, '★ settings.section 不收 inject：宿主只递 { close }，配置面走闭包');
    assert.equal(typeof host.registrations[0].component, 'function');
    const runtime = makeFakeReact();
    const tree = runtime.render(host.registrations[0].component, { close: () => {} });
    assert.ok(
      !textOf(tree).includes('设置服务（configForms）不可用'),
      '★ 闭包必须已绑定 scope：掉进降级分支 = 配置面没接上（2026-10-01 空白事故的同类症状）',
    );
  });
});

test('service 声明守卫：apply 只触达声明过的服务（未声明即抛，镜像真机 guard）', async () => {
  await withBundle({}, async (registration) => {
    const { fakeRequire } = makeRequire(makeFakeReact().React);
    const plugin = registration.factory(fakeRequire);
    // ★ 2026-10-01 迁移：`settingsScope` 在 0.2.0 已消失，`locale` 成为必需 inject。
    //   ⚠ 这条判据是**启动级**的：`inject` 是硬依赖门顶，少一个服务不是"这插件不显示"，
    //   而是 web boot 完整性校验失败 ⇒ **整个 DSH 起不来**（2026-10-01 真机事故）。
    assert.deepEqual(plugin.inject, ['slots', 'locale', 'configForms']);
    assert.equal(typeof plugin.apply, 'function');
    const host = makeGuardedCtx(plugin, { scope: makeScope() });
    assert.doesNotThrow(() => plugin.apply(host.ctx), 'apply 触达未声明服务会被守卫拒绝');
  });
});

test('require 白名单：factory 只 require("react") + primitives（均为 seed 表内模块）', async () => {
  await withBundle({}, async (registration) => {
    const { fakeRequire, requested } = makeRequire(makeFakeReact().React);
    assert.doesNotThrow(() => registration.factory(fakeRequire));
    assert.deepEqual([...new Set(requested)].sort(), [
      '@deepseek-ai/dsh-client-ui-primitives',
      'react',
    ]);
  });
});

test('判据②a：开关读写 —— 快照 → 树；交互 → scope.set → 快照变更 → 重渲染反映新值', async () => {
  const app = await boot({ scopeValue: { enabled: false, model: '', effort: '' } });
  app.expand();
  app.flushEffects();
  await settle();
  // ★ 骨架态（载荷未到达）下内容区只有一个骨架 ⇒ 断言用的树必须取加载完成后的。
  let tree = app.expand();

  const inputOf = (t) => findAll(t, (n) => n.type === 'input' && n.props.className === 'dsh-wb-switch')[0];
  assert.equal(inputOf(tree).props.checked, false);
  assert.equal(inputOf(tree).props.disabled, false);

  inputOf(tree).props.onChange(); // 用户拨 ON
  await settle();
  assert.deepEqual(app.scope.commits[0], { op: 'set', field: 'enabled', value: true });
  assert.equal(app.scope.getSnapshot().value.enabled, true);

  tree = app.expand(); // 订阅回调已使快照替换（真机由 mirror fold 驱动）
  assert.equal(inputOf(tree).props.checked, true, '写后 bridge 应反映新值');
});

test('判据②b：模型读写 —— options 来自状态路由；选择写回 scope', async () => {
  const app = await boot({ scopeValue: { enabled: false, model: '', effort: '' } });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();

  const select = findAll(tree, (n) => n.type === 'select' && n.props.id === 'dsh-wb-model')[0];
  const options = findAll(select, (n) => n.type === 'option');
  // ★ 分组渲染改变顺序：免费 → 按量 → 未知。默认夹具里 m2 有倍率（按量组）、m1 未知 ⇒ m2 在前。
  //   顺序本身由 MODEL_GROUPS 决定（另有分组测试逐字锁），这里锁"条目一个不少"。
  assert.deepEqual(
    options.map((o) => o.props.value).sort(),
    ['', 'm1', 'm2'].sort(),
    '★ 目录 2 条 ⇒ 下拉必须有 2 条（+1 个哨兵行），分组不得吞条目',
  );
  assert.equal(labelText(options.find((o) => o.props.value === '')), '未固定（每次用时现选）');
  // 空值 ⇒ 这一行必须把"谁在选 + 没选会怎样"两分支说出来（模型面真实化；见 MODEL_UNSET_HINT）
  assert.match(
    textOf(findAll(tree, (n) => /(^|\s)dsh-wb-row--model(\s|$)/.test(String(n.props?.className ?? '')))[0]),
    /每次用时重新选；那次也没选，就用桌面端自己的默认。/,
  );

  select.props.onChange({ target: { value: 'm2' } });
  await settle();
  assert.deepEqual(app.scope.commits[0], { op: 'set', field: 'model', value: 'm2' });
  assert.equal(app.scope.getSnapshot().value.model, 'm2');
});

test('判据②c：强度读写 —— 6 档（不含 off）+ 不支持档置灰（§4.2.1：不静默改档）', async () => {
  const app = await boot({ scopeValue: { enabled: false, model: '', effort: '' } });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();

  const select = findAll(tree, (n) => n.type === 'select' && n.props.id === 'dsh-wb-effort')[0];
  const options = findAll(select, (n) => n.type === 'option').filter((o) => o.props.value !== '');
  // ★ 2026-10-02：`off` 不是可下发的强度档，界面只渲染 6 档（见 EFFORT_UI_LEVELS）。
  assert.deepEqual(options.map((o) => o.props.value), [...EFFORT_UI], '★ 强度下拉必须是 6 档（off 不进界面）');
  assert.equal(options.some((o) => o.props.value === 'off'), false, '★ off 不得渲染（点不了还占一行的置灰项是噪音）');
  const minimal = options.find((o) => o.props.value === 'minimal');
  assert.equal(minimal.props.disabled, false);
  const xhigh = options.find((o) => o.props.value === 'xhigh');
  assert.equal(xhigh.props.disabled, false);
  assert.ok(labelText(xhigh).includes('→ extra-high'), 'label 必须印 values 表里的映射值（非 canonical）');

  select.props.onChange({ target: { value: 'xhigh' } });
  await settle();
  assert.deepEqual(app.scope.commits[0], { op: 'set', field: 'effort', value: 'xhigh' });
});

test('判据②d：档位候选集以宿主 canonical 为准 —— 宿主多出的档位必须能渲染（本地表只是退路）', async () => {
  // 宿主侧 `effort.canonical` 是"合法取值集合"（get.js:82-90 唯一构造点），与本地常量**故意不同**：
  // 多一个 `none` 且顺序不同。回归点：客户端只认本地那份副本 ⇒ 宿主新增档位**根本不渲染**，
  // 用户在 UI 里看不到、也选不到该平台的合法档位（不报错，静默缺失）。
  const app = await boot({
    status: statusPayload({ effort: { canonical: ['off', 'none', 'high'], values: { high: 'high' } } }),
  });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();

  const select = findAll(tree, (n) => n.type === 'select' && n.props.id === 'dsh-wb-effort')[0];
  const options = findAll(select, (n) => n.type === 'option').filter((o) => o.props.value !== '');
  assert.deepEqual(
    options.map((o) => o.props.value),
    ['none', 'high'],
    '★ 候选集与顺序跟宿主 canonical 走（不是本地表），且 off 照例不进界面',
  );
  const none = options.find((o) => o.props.value === 'none');
  assert.equal(none.props.disabled, true, 'canonical 只表示"合法"，不在 values 表 ⇒ 置灰；不得发明映射');
  assert.ok(labelText(none).includes('不支持'));
  const high = options.find((o) => o.props.value === 'high');
  assert.equal(high.props.disabled, false);
  assert.ok(labelText(high).includes('→ high'));
});

test('判据②e：宿主 payload 缺 canonical ⇒ 回落到本地 6 档（不得退化成空下拉）', async () => {
  // 对称面：路由不可达 / 旧宿主只给 values 时，退路必须仍然产出完整候选集。
  const app = await boot({
    status: statusPayload({ effort: { values: { high: 'high' } } }),
  });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();

  const select = findAll(tree, (n) => n.type === 'select' && n.props.id === 'dsh-wb-effort')[0];
  const options = findAll(select, (n) => n.type === 'option').filter((o) => o.props.value !== '');
  assert.deepEqual(options.map((o) => o.props.value), [...EFFORT_UI], '缺 canonical ⇒ 用本地 6 档退路表');
  const high = options.find((o) => o.props.value === 'high');
  assert.equal(high.props.disabled, false);
  const low = options.find((o) => o.props.value === 'low');
  assert.equal(low.props.disabled, true, 'values 表只有 high ⇒ 其余档置灰（与 canonical 是否存在无关）');
});

test('判据④：任务块 —— 对话标题 + 回执人话 + 在途数；编号/退出码只进折叠', async () => {
  const app = await boot({
    scopeValue: { enabled: true, model: 'm1', effort: 'low' },
    status: statusPayload({
      inFlight: [{ jobId: 'workbuddy-1' }, { jobId: 'workbuddy-2' }],
      lastRun: autoRun({
        title: '给 README 加一段',
        sessionId: 'sess-aaa-1111',
        automationId: 'auto-aaa-1',
        retired: false,
        createdAt: 1727846400000,
        reasonCode: 'ok',
        exitCode: 0,
        model: 'm1',
        effort: { requested: 'low', effective: 'low', confirmed: true },
      }),
    }),
  });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();
  const main = mainText(tree);
  const fold = foldText(tree);
  assert.ok(main.includes('● 开启'), 'REGISTERED ⇒ ● 开启（头徽标，主视图）');
  assert.ok(main.includes('仍有 2 个任务在运行'), '在途作业数必须显示（主视图）');
  assert.ok(main.includes('任务对话：给 README 加一段'), '对话标题必须显示（主视图，用户自己的内容）');
  assert.ok(main.includes('回执：已收到'), '回执收到与否必须显示（主视图，人话）');
  assert.ok(main.includes('未退役'), '退役位必须显示（主视图，人话）');
  assert.ok(main.includes('模型列表来源：product.json'));
  // ★ 折叠纪律：编号与退出码只进折叠，主视图不得出现。
  for (const leaked of ['sess-aaa-1111', 'auto-aaa-1']) {
    assert.equal(main.includes(leaked), false, `★ 编号 ${leaked} 不得出现在主视图（只进折叠）`);
    assert.ok(fold.includes(leaked), `★ 编号 ${leaked} 必须在折叠里可核对`);
  }
  assert.equal(main.includes('退出码'), false, '★ 退出码只进折叠（主视图不出现"退出码"三字）');
  assert.ok(fold.includes('退出码：0'), '★ 退出码在折叠里可核对');
});

test('状态块：模型列表来源中文化 —— 实时/缓存说人话，端点原串不进界面', async () => {
  for (const [source, expected] of [
    ['desktop-live:/v2/enterprises/personal/models', '模型列表来源：WorkBuddy 桌面端（实时）'],
    ['desktop-cache:acc-product-config-v3', '模型列表来源：WorkBuddy 桌面端（缓存）'],
    ['product.json', '模型列表来源：product.json'],
  ]) {
    const app = await bootFromStatus({ modelsSource: source });
    const main = mainText(app.expand());
    assert.ok(main.includes(expected), `★ ${source} ⇒ ${expected}`);
  }
  const live = await bootFromStatus({ modelsSource: 'desktop-live:/v2/enterprises/personal/models' });
  assert.equal(mainText(live.expand()).includes('/v2/enterprises/personal/models'), false, '★ 内部端点路径不得进主视图');
});

test('判据④：在途为空 ⇒ 空态文案；无 lastRun ⇒ 空态文案（未知不编造）', async () => {
  const app = await boot({
    scopeValue: { enabled: true, model: 'm1', effort: 'low' },
    status: statusPayload({ inFlight: [], lastRun: null }),
  });
  app.expand();
  app.flushEffects();
  await settle();
  const main = mainText(app.expand());
  assert.ok(main.includes('在途任务：无'), '★ 在途为空必须有明确空态（不是直接少一行）');
  assert.ok(main.includes('最近一次启动：暂无记录'), '★ 无 lastRun 必须有明确空态');
});

test('判据④：任务失败 —— 人话主视图，归因码/编号/退出码只进折叠', async () => {
  const app = await boot({
    scopeValue: { enabled: true, model: 'm1', effort: 'low' },
    status: statusPayload({
      lastRun: autoRun({
        title: '修 flaky',
        sessionId: 'sess-bbb-2222',
        automationId: 'auto-bbb-2',
        retired: true,
        createdAt: 1727846400000,
        reasonCode: 'task_error',
        reasonText: '任务执行失败，桌面端返回错误。',
        exitCode: 1,
      }),
    }),
  });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();
  const main = mainText(tree);
  const fold = foldText(tree);
  assert.ok(main.includes('失败原因：任务执行失败，桌面端返回错误。'), '★ 失败人话必须在主视图');
  assert.ok(main.includes('已退役'), '★ 退役位是人话，主视图');
  for (const leaked of ['task_error', 'sess-bbb-2222', 'auto-bbb-2']) {
    assert.equal(main.includes(leaked), false, `★ ${leaked} 不得出现在主视图（只进折叠）`);
    assert.ok(fold.includes(leaked), `★ ${leaked} 必须在折叠里可核对`);
  }
  assert.ok(fold.includes('退出码：1'), '★ 退出码在折叠里可核对');
});

test('判据⑤：会话复用可见 —— 追发轮主视图一行人话，通道/耗时/origin/编号只进折叠', async () => {
  const app = await boot({
    scopeValue: { enabled: true, model: 'm1', effort: 'low' },
    status: statusPayload({
      lastRun: autoRun({
        title: '续跑任务',
        sessionId: 'conv-resumed-1',
        transport: 'followup',
        sessionOrigin: 'resumed',
        resumed: true,
        followUp: { channel: 'track_a', elapsedMs: 6217 },
      }),
    }),
  });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();
  const main = mainText(tree);
  const fold = foldText(tree);
  assert.ok(main.includes('会话复用：复用上次对话续发'), '★ 复用续发必须显示（主视图人话）');
  for (const leaked of ['track_a', '6217', 'resumed', 'conv-resumed-1']) {
    assert.equal(main.includes(leaked), false, `★ ${leaked} 不得出现在主视图（只进折叠）`);
    assert.ok(fold.includes(leaked), `★ ${leaked} 必须在折叠里可核对`);
  }
  assert.ok(fold.includes('追发通道：track_a · 6217ms'), '★ 追发通道与耗时的折叠记账行');
  assert.ok(fold.includes('会话来源：resumed'), '★ 会话来源枚举在折叠里可核对');
});

test('判据⑤：回退轮 —— 主视图说"已回退新开"，指纹码只进折叠', async () => {
  const app = await boot({
    scopeValue: { enabled: true, model: 'm1', effort: 'low' },
    status: statusPayload({
      lastRun: autoRun({
        title: '回退轮',
        sessionId: 'conv-fallback-1',
        fallback: true,
        fallbackReason: 'ERR_WORKBUDDY_CDP_UNAVAILABLE',
      }),
    }),
  });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();
  const main = mainText(tree);
  const fold = foldText(tree);
  assert.ok(main.includes('会话复用：续发失败，已回退新开对话'), '★ 回退轮必须有人话（主视图）');
  assert.equal(main.includes('ERR_WORKBUDDY_CDP_UNAVAILABLE'), false, '★ 回退指纹码不得进主视图');
  assert.ok(fold.includes('回退原因：ERR_WORKBUDDY_CDP_UNAVAILABLE'), '★ 回退原因在折叠里可核对');
  assert.equal(fold.includes('会话来源：resumed'), false, '★ 回退轮的 origin 是 new/null，不得冒充 resumed');
});

test('判据⑤：默认轮（开关关闭的既有形状）不渲染任何追发字样 —— 未知不编造', async () => {
  const app = await boot({
    scopeValue: { enabled: true, model: 'm1', effort: 'low' },
    status: statusPayload({
      lastRun: autoRun({ title: '普通轮', sessionId: 'conv-plain-1', retired: true, createdAt: 1727846400000 }),
    }),
  });
  app.expand();
  app.flushEffects();
  await settle();
  const main = mainText(app.expand());
  assert.equal(main.includes('会话复用'), false, '★ 普通点火轮不得出现"会话复用"行');
  assert.equal(main.includes('追发'), false, '★ 普通点火轮不得出现任何追发字样');
});

test('判据④：未安装 ⇒ ○ 未安装 + 开关置灰 + 探测证据只进折叠（S1 责任归属）', async () => {
  const app = await boot({
    status: statusPayload({
      registry: 'NOT_INSTALLED',
      probe: {
        target: 'workbuddy',
        installed: false,
        reason: 'not_found',
        resolvedPath: null,
        evidence: [
          { kind: 'resolveExecutable', value: 'codebuddy', found: false },
          { kind: 'knownPath', value: 'C:/PF/WorkBuddy/cli/bin/codebuddy', found: false },
        ],
        at: 1,
        method: 'no-exec',
      },
    }),
  });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();
  const text = textOf(tree);
  const main = mainText(tree);
  const fold = foldText(tree);
  assert.ok(main.includes('○ 未安装'));
  assert.ok(fold.includes('（未找到）'), '证据在折叠里展开（只说找到/没找到，不印内部探测步骤名）');
  assert.ok(!text.includes('knownPath'), '★ 探测步骤名（宿主枚举）不得进界面（含折叠）');
  // ★ 候选路径是本机路径 ⇒ 只进折叠。
  assert.equal(main.includes('C:/PF/WorkBuddy/cli/bin/codebuddy'), false, '★ 本机路径不得出现在主视图');
  assert.ok(fold.includes('C:/PF/WorkBuddy/cli/bin/codebuddy'), '★ 候选路径在折叠里可核对');
  const input = findAll(tree, (n) => n.type === 'input' && n.props.className === 'dsh-wb-switch')[0];
  assert.equal(input.props.disabled, true, 'S1 ⇒ 开关置灰');
});

test('判据④：状态未到达 ⇒ 单个加载骨架（各行不再各自报"读取中"）', async () => {
  const app = await boot({ fetchImpl: async () => new Promise(() => {}) }); // 永不 settle
  const tree = app.expand();
  app.flushEffects();
  const main = mainText(app.render());
  assert.ok(main.includes('… 检测中'), '徽标仍按 UNKNOWN 显示（头不因加载丢失状态）');
  assert.equal(
    findAll(tree, (n) => n.type === 'div' && n.props.className === 'dsh-wb-skeleton').length,
    1,
    '★ 加载态必须是**单个**骨架占位',
  );
  assert.equal(
    findAll(tree, (n) => n.type === 'select').length,
    0,
    '★ 骨架态不渲染任何下拉（各行不再各自报"读取中/对应值未知"）',
  );
  assert.equal(main.includes('运行状态：读取中…'), false, '★ 状态区整体未渲染时不得再出一行"读取中"');
});

test('判据④b：flagVerdict=rejected 但**无逐 flag 归因** ⇒ 谁都不许动，如实说明"未点名"（§4.5）', async () => {
  // ★★ 口径在 2026-10-02 被改正，方向是**从"多动"改成"不动"** ★★
  // 旧口径：没有 `flags[]` ⇒ 保守**整体回滚**，两行都清空，理由是"宁可少显示也不谎报"。
  // CLI 传输删除后 `flags` 永远为空 ⇒ 这条旧口径的实际效果是
  // **"任务一失败，用户的模型和强度就显示成空的"**。设置其实好好地在那儿，
  // 失败原因是桌面端不认那个模型 —— 把两行清空是在替用户编一个他没做过的操作。
  // 什么都没点名 ⇒ "是你这一行设错了"没有依据 ⇒ 一行都不许动；
  // 但**失败本身必须照样可见**（人话主视图 + 编号证据折叠），不得因为不归因就一并吞掉。
  const app = await boot({
    scopeValue: { enabled: true, model: 'm2', effort: 'high' },
    status: statusPayload({
      lastRun: {
        argv: '', exitCode: 2, stderrExcerpt: 'error: unknown option --model',
        flagVerdict: 'rejected', reasonCode: 'flag_rejected',
        reasonText: '本次下发的参数被拒绝。',
      },
    }),
  });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();
  const main = mainText(tree);
  const fold = foldText(tree);
  // 失败仍然必须上屏（不归因 ≠ 不报告）：人话主视图，证据折叠。
  assert.ok(main.includes('失败原因：本次下发的参数被拒绝。'), '★ 失败人话必须在主视图');
  assert.equal(main.includes('error: unknown option --model'), false, '★ 原始错误输出只进折叠');
  assert.ok(fold.includes('error: unknown option --model'), '★ 原始错误输出在折叠里可核对');
  assert.ok(fold.includes('被拒绝的参数：无'), '★ 无归因 ⇒ 折叠里如实说明没点出是哪个');
  assert.equal(main.includes('被拒绝的参数'), false, '★ 归因行只进折叠（主视图不出现）');
  // 核心：不得凭空回滚任何一行。
  const modelSelect = findAll(tree, (n) => n.type === 'select' && n.props.id === 'dsh-wb-model')[0];
  const effortSelect = findAll(tree, (n) => n.type === 'select' && n.props.id === 'dsh-wb-effort')[0];
  assert.equal(modelSelect.props.value, 'm2', '★ 无归因 ⇒ 模型行保留真实值（不得显示成"未指定"）');
  assert.equal(effortSelect.props.value, 'high', '★ 无归因 ⇒ 强度行保留真实值');
  assert.equal(textOf(tree).split('⚠').length - 1, 0, '★ 没有可点名的行 ⇒ 不得给出行级警告（那是在指控一个没证据的行）');
});

test('判据③+④b（B-T04-4）：逐 flag 归因 —— 只有 --model 被拒 ⇒ **仅**模型行回滚，强度行显示真实值', async () => {
  // 反例史：客户端曾只看聚合 flagVerdict ⇒ 两行都显示"未指定"。
  // 但本次 argv 里 `--effort high` 是**真下发**的、且证据没点它的名 —— 显示"未指定"就是假状态。
  // ★ 2026-10-02 补充：旗标名只进折叠。主视图的回滚行只挂一句不带名的提示，
  //   点的是哪个参数去折叠里核对（`被拒绝的参数：--model`）。
  const app = await boot({
    scopeValue: { enabled: true, model: 'm2', effort: 'high' },
    status: statusPayload({
      lastRun: {
        argv: 'node codebuddy -p --model m2 --effort high hi', exitCode: 0,
        stderrExcerpt: '400 model [m2] service info not found',
        flagVerdict: 'rejected', reasonCode: 'flag_rejected',
        reasonText: '本次下发的参数被拒绝。',
        flags: [
          { flag: '--model', value: 'm2', source: 'config.model', verdict: 'rejected', evidence: '400 model [m2] service info not found' },
          { flag: '--effort', value: 'high', source: 'config.effort', verdict: 'unknown', evidence: '聚合判据为 rejected，但证据未点名该参数' },
        ],
      },
    }),
  });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();
  const main = mainText(tree);
  const fold = foldText(tree);
  const modelSelect = findAll(tree, (n) => n.type === 'select' && n.props.id === 'dsh-wb-model')[0];
  const effortSelect = findAll(tree, (n) => n.type === 'select' && n.props.id === 'dsh-wb-effort')[0];
  assert.equal(modelSelect.props.value, '', '被点名的 --model ⇒ 回滚显示"未指定"');
  assert.equal(effortSelect.props.value, 'high', '★ 未被点名 ⇒ 必须显示真实值（回滚它 = 谎报未指定）');
  assert.ok(main.includes('⚠ 该参数曾被拒绝，已按归因回滚显示'), '★ 回滚行在主视图挂不带名的提示');
  assert.equal(main.split('⚠').length - 1, 1, '只有被拒的那一行该有警告');
  assert.equal(main.includes('--model'), false, '★ 旗标名不得出现在主视图');
  assert.equal(main.includes('--effort'), false, '★ 没被拒的旗标更不得出现在主视图');
  assert.ok(fold.includes('被拒绝的参数：--model'), '★ 折叠里必须列出被拒的参数（可核对）');
  assert.equal(fold.includes('该版本不接受 --effort'), false, '不得把没被拒的 flag 也点名为不接受');
});

test('判据③+④b 对称面：只有 --effort 被拒 ⇒ 仅强度行回滚，模型行显示真实值', async () => {
  const app = await boot({
    scopeValue: { enabled: true, model: 'm2', effort: 'xhigh' },
    status: statusPayload({
      lastRun: {
        argv: 'node codebuddy -p --model m2 --effort extra-high hi', exitCode: 2,
        stderrExcerpt: 'error: unknown option --effort',
        flagVerdict: 'rejected', reasonCode: 'flag_rejected', reasonText: '本次下发的参数被拒绝。',
        flags: [
          { flag: '--model', value: 'm2', source: 'config.model', verdict: 'unknown', evidence: '聚合判据为 rejected，但证据未点名该参数' },
          { flag: '--effort', value: 'extra-high', source: 'config.effort', verdict: 'rejected', evidence: 'error: unknown option --effort' },
        ],
      },
    }),
  });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();
  const main = mainText(tree);
  const fold = foldText(tree);
  const modelSelect = findAll(tree, (n) => n.type === 'select' && n.props.id === 'dsh-wb-model')[0];
  const effortSelect = findAll(tree, (n) => n.type === 'select' && n.props.id === 'dsh-wb-effort')[0];
  assert.equal(modelSelect.props.value, 'm2', '模型未被点名 ⇒ 显示真实值');
  assert.equal(effortSelect.props.value, '', '强度被点名 ⇒ 回滚');
  assert.ok(main.includes('⚠ 该参数曾被拒绝，已按归因回滚显示'));
  assert.equal(main.includes('--effort'), false, '★ 旗标名只进折叠');
  assert.ok(fold.includes('被拒绝的参数：--effort'), '★ 折叠里列出被拒的参数');
  assert.equal(main.split('⚠').length - 1, 1);
});

test('判据④b（B-T04-4）：警告文案点名的是**配置里的**旗标名（不硬编码 --model/--effort）', async () => {
  // 旗标名来自 config（`launch.modelFlag` 可被改成 `-m`）⇒ 客户端必须用 host 回传的逐字 flag，
  // 否则用户会看到与实际 argv 不符的参数名（可核对性 = C3 透明度）。
  // ★ 2026-10-02：点名只进折叠，主视图的回滚提示不带名。
  const app = await boot({
    scopeValue: { enabled: true, model: 'm2', effort: '' },
    status: statusPayload({
      lastRun: {
        argv: 'node codebuddy -p -m m2 hi', exitCode: 2, stderrExcerpt: 'error: unknown option -m',
        flagVerdict: 'rejected', reasonCode: 'flag_rejected', reasonText: '本次下发的参数被拒绝。',
        flags: [{ flag: '-m', value: 'm2', source: 'config.model', verdict: 'rejected', evidence: 'error: unknown option -m' }],
      },
    }),
  });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();
  const main = mainText(tree);
  const fold = foldText(tree);
  assert.ok(fold.includes('被拒绝的参数：-m'), '★ 点名必须用配置里的旗标名（-m），而非硬编码 --model');
  assert.equal(fold.includes('被拒绝的参数：--model'), false);
  assert.equal(main.includes('-m'), false, '★ 旗标名不得出现在主视图');
  assert.equal(main.includes('--model'), false);
});

test('§4.5 跨层锁补强：source=call.model 被拒 ⇒ 模型行照常归因回滚、强度行不连坐（ROW_SOURCES 必须认 call.*）', async () => {
  // ★ 2026-09-22 P2：argv.js 对**逐次覆盖**的旗标如实标 `call.model` / `call.effort`（真写在
  //   argv.js:311/319），而客户端 ROW_SOURCES 只认 `config.*` ⇒ call.* 的被拒旗标一个行都落不上
  //   ⇒ mapped=0 ⇒ attributed=false ⇒ 退回**保守整体回滚**：没被拒的强度行被显示成"未指定" = 假状态
  //   （B-T04-4 修过的那个形态，经 call.* 这条缝原样复发）。
  const lastRun = {
    argv: 'C:/x/codebuddy.exe -p --model kimi-k3-1 hi', exitCode: 1, stderrExcerpt: "error: unknown option '--model'",
    flagVerdict: 'rejected', reasonCode: 'flag_rejected', reasonText: '本次下发的参数被拒绝。',
    flags: [{ flag: '--model', value: 'kimi-k3-1', source: 'call.model', verdict: 'rejected', evidence: "error: unknown option '--model'" }],
  };
  const app = await boot({ scopeValue: { enabled: true, model: 'm2', effort: 'low' }, status: statusPayload({ lastRun }) });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();
  const main = mainText(tree);
  const fold = foldText(tree);
  assert.equal(findAll(tree, (n) => n.type === 'select' && n.props.id === 'dsh-wb-model')[0].props.value, '', '被点名的 call.model ⇒ 模型行回滚');
  assert.equal(
    findAll(tree, (n) => n.type === 'select' && n.props.id === 'dsh-wb-effort')[0].props.value,
    'low',
    '★★ 未点名 ⇒ 强度行显示真实值（ROW_SOURCES 缺 call.* 时这里会变成 ""—— 保守整体回滚把假状态带回来了）',
  );
  assert.ok(main.includes('⚠ 该参数曾被拒绝，已按归因回滚显示'), '★ 归因成立 ⇒ 主视图挂不带名的回滚提示');
  assert.ok(fold.includes('被拒绝的参数：--model'), '★ 点名细节在折叠里可核对');
});

test('§4.5 跨层锁（M6 盲区）：CLI 删除后没有 flags 生产者 ⇒ 卡片不得伪造行级回滚', async () => {
  // ★ 这条测试在 2026-10-02 被**改写**，不是被删除 ★
  // 原版是"真实 buildArgv → 真实 buildLastRun → 客户端行级回滚"，用 `buildArgv` 产出的
  // `flags[].source`（'config.model'/'config.effort'）做跨层字面量锁。
  // CLI 传输整体删除后，`flags` **再没有生产者**：两条桌面端通路都写 `flags: {}`
  // （`tools/run.js` 的两个 settle 分支），因为"某个旗标被拒"这件事只存在于 CLI 的 stderr 里。
  // ⇒ 行级回滚（§4.5）失去了归因来源。此时最危险的不是"不滚"，而是**照滚不误**：
  // 拿一个空 `flags` 去反推"哪一行被拒了"，就会凭空回滚用户没配过的行。
  // 所以本条钉的是**保守方向**：没有点名 ⇒ 谁都不许动。
  const { buildLastRun } = await import('../src/host/launch/verdict.js');
  const runtime = { detected: () => ({ resolvedPath: 'C:\\fake\\codebuddy' }) };
  const lastRun = buildLastRun({
    argv: [], flags: [], exitCode: 1, signal: null,
    stdoutText: '', stderrText: "error: unknown option '--model'", sessionId: null, runtime,
  });
  // 前提自检：没有旗标可点名 ⇒ 归因不得成立。
  assert.equal(Array.isArray(lastRun.flags) ? lastRun.flags.length : 0, 0,
    '前提：CLI 已删 ⇒ 运行记录里没有任何可点名的旗标');

  const app = await boot({ scopeValue: { enabled: true, model: 'm2', effort: 'low' }, status: statusPayload({ lastRun }) });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();
  const modelSelect = findAll(tree, (n) => n.type === 'select' && n.props.id === 'dsh-wb-model')[0];
  const effortSelect = findAll(tree, (n) => n.type === 'select' && n.props.id === 'dsh-wb-effort')[0];
  // ★ 核心断言：一次失败**不得**把两行都清空（那会让用户以为自己的设置没生效）。
  assert.equal(modelSelect.props.value, 'm2', '★ 无旗标可点名 ⇒ 模型行必须保留真实值，不得被凭空回滚');
  assert.equal(effortSelect.props.value, 'low', '★ 同上：强度行必须保留真实值');
  // 被拒证据仍可上屏（stderr 是真的），但**不得**据此宣称"某一版不接受 --model"——
  // 那句话的判据是"被点名的旗标"，现在没有 ⇒ 说了就是编的。
  assert.equal(mainText(tree).includes('--model'), false,
    '★ 没有点名对象时旗标名不得出现在主视图（那是凭空归因）');
});

test('§4.5 回滚口径：点名的 flag 来源**不可映射**时 ⇒ 同样一行都不动（不得凭空归因到某一设置）', async () => {
  // ★ 判别力：这里 `flags[]` **有**一条被点名（`--model`），但它的 `source` 是
  //   `config.unknown` —— 映射不到 model/effort 任何一行。
  //   旧口径此时"整体回滚"两行，理由是"宣称 attributed 却不动行"是自相矛盾的。
  //   2026-10-02 改正：那个自相矛盾可以用**文案**解决，不必用**清空用户设置**来解决。
  //   真实形态就是它 —— CLI 删除后 `source` 只可能是 `call.*` / `config.*` 之外的东西或根本不存在，
  //   而"桌面端不认这个模型"这类失败**根本不是旗标被拒**。把两行清空 = 伪造一次用户操作。
  //   ⇒ 不动行；同时折叠里只说"被点名参数：--model"，**不说**"你的模型设置有问题"。
  const app = await boot({
    scopeValue: { enabled: true, model: 'm2', effort: 'low' },
    status: statusPayload({
      lastRun: {
        argv: '', exitCode: 1, stderrExcerpt: "error: unknown option '--model'",
        flagVerdict: 'rejected', reasonCode: 'flag_rejected', reasonText: '本次下发的参数被拒绝。',
        flags: [{ flag: '--model', value: 'm2', source: 'config.unknown', verdict: 'rejected', evidence: "error: unknown option '--model'" }],
      },
    }),
  });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();
  const modelSelect = findAll(tree, (n) => n.type === 'select' && n.props.id === 'dsh-wb-model')[0];
  const effortSelect = findAll(tree, (n) => n.type === 'select' && n.props.id === 'dsh-wb-effort')[0];
  assert.equal(modelSelect.props.value, 'm2', '★ 来源不可映射 ⇒ 模型行保留真实值（清空它就是凭空归因）');
  assert.equal(effortSelect.props.value, 'low', '★ 同上：强度行保留真实值');
  // 反向对照：被点名的旗标名**仍要如实显示**（隐藏它才是真的不诚实）—— 但只在折叠里。
  assert.ok(foldText(tree).includes('--model'), '★ 被点名的旗标名必须在折叠里照实显示');
  assert.equal(mainText(tree).includes('--model'), false, '★ 但不得出现在主视图');
});

test('§4.5 证据行：stderr 摘录为空 ⇒ 不渲染空白 mono 行（真机 stderr 常为空的形态）', async () => {
  const app = await boot({
    scopeValue: { enabled: true, model: 'm2', effort: '' },
    status: statusPayload({
      lastRun: {
        argv: 'node codebuddy -p --model m2 hi', exitCode: 0, stderrExcerpt: '',
        flagVerdict: 'rejected', flagEvidence: '400 model [m2] service info not found',
        reasonCode: 'flag_rejected', reasonText: '本次下发的参数被拒绝。',
        flags: [{ flag: '--model', value: 'm2', source: 'config.model', verdict: 'rejected', evidence: '400 model [m2] service info not found' }],
      },
    }),
  });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();
  // ★ 2026-10-02：证据行整体搬进任务折叠（主视图只留人话）。判别目标依旧是下方三条**定向**断言，
  //   只是口径从"全树 mono 计数"换成"折叠内 mono"。
  const fold = foldText(tree);
  const foldMono = findAll(
    findAll(tree, (n) => n.type === 'details'),
    (n) => n.props && typeof n.props.className === 'string' && n.props.className.includes('dsh-wb-status__mono'),
  );
  const monoTexts = foldMono.map((n) => textOf(n));
  assert.ok(fold.includes('拒绝信息：400 model [m2] service info not found'));
  assert.equal(monoTexts.some((t) => t.trim() === ''), false, '不得存在空白 mono 行');
  assert.equal(monoTexts.some((t) => t.includes('原始错误输出')), false, '★ 摘录为空 ⇒ 折叠里不得渲染"原始错误输出："行');
  assert.ok(fold.includes('桌面端：C:/wb/codebuddy'), '折叠里确实含桌面端路径行');
  assert.equal(mainText(tree).includes('400 model [m2] service info not found'), false, '★ 证据原文只进折叠');
});

test('§4.5 证据行正控：错误输出摘录**非空** ⇒ 折叠里必须渲染"原始错误输出："行（与上一条构成正/负控对）', async () => {
  // 正控的意义：没有它，上一条的"不得出现"可能只是因为这条路径根本没被走到（负控空转）。
  const app = await boot({
    scopeValue: { enabled: true, model: 'm2', effort: '' },
    status: statusPayload({
      lastRun: {
        argv: 'node codebuddy -p hi', exitCode: 0,
        stderrExcerpt: '(node:1) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental',
        flagVerdict: 'rejected', flagEvidence: '400 model [m2] service info not found',
        reasonCode: 'flag_rejected',
        reasonText: '本次下发的参数被拒绝。',
      },
    }),
  });
  app.expand();
  app.flushEffects();
  await settle();
  const foldMono = findAll(
    findAll(app.expand(), (n) => n.type === 'details'),
    (n) => n.props && typeof n.props.className === 'string' && n.props.className.includes('dsh-wb-status__mono'),
  );
  assert.ok(
    foldMono.map((n) => textOf(n)).some((t) => t.includes('原始错误输出：(node:1) [UNDICI-EHPA] Warning')),
    '非空摘录必须上屏（否则上一条的负控是空转的）—— 位置在折叠里',
  );
});

test('§4.5 失败归因文案上屏：reasonText 逐字可见（§7.4 port_conflict），ok 不得渲染成"失败原因"', async () => {
  const app = await boot({
    status: statusPayload({
      lastRun: {
        argv: 'node codebuddy -p hi', exitCode: 0, stderrExcerpt: '', flagVerdict: 'unknown',
        reasonCode: 'port_conflict',
        reasonText: '检测到与正在运行的实例冲突，请先关闭该程序的同名实例或改用单次模式',
      },
    }),
  });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();
  const main = mainText(tree);
  assert.ok(main.includes('失败原因：'), '失败原因行必须渲染（主视图，人话）');
  assert.ok(main.includes('检测到与正在运行的实例冲突，请先关闭该程序的同名实例或改用单次模式'), '§7.4 逐字文案必须上屏（host 是唯一文案源）');
  // ★ 归因码是内部串 ⇒ 只进折叠（全树仍可核对，主视图不得出现）。
  assert.equal(main.includes('port_conflict'), false, '★ 归因码不得出现在主视图');
  assert.ok(foldText(tree).includes('port_conflict'), '★ 归因码在折叠里可核对');
});

test('§4.5 失败归因文案：reasonCode=ok ⇒ 不渲染"失败原因"（不造反义句）', async () => {
  const app = await boot({
    status: statusPayload({
      lastRun: {
        argv: 'node codebuddy -p hi', exitCode: 0, stderrExcerpt: '', flagVerdict: 'accepted',
        reasonCode: 'ok', reasonText: '本次下发未见失败证据。',
      },
    }),
  });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();
  const main = mainText(tree);
  assert.equal(main.includes('失败原因'), false, '成功记录不得出现"失败原因：本次下发未见失败证据"');
  // ★ 接受度行只进折叠（全树仍可核对）。
  assert.ok(textOf(tree).includes('参数是否被接受：已接受'));
  assert.equal(main.includes('参数是否被接受'), false, '★ 接受度行只进折叠');
});

test('判据⑤：CSS 去重注入 —— 同页重复物化不叠加 <style>', async () => {
  const documentFake = makeFakeDocument();
  await withBundle({ document: documentFake }, async (registration) => {
    const { fakeRequire } = makeRequire(makeFakeReact().React);
    registration.factory(fakeRequire);
    assert.equal(documentFake.created.length, 1, '首次物化注入 1 份样式');
    const tag = documentFake.created[0];
    assert.equal(tag.dataset.plugin, PACKAGE_NAME);
    assert.equal(tag.dataset.pluginCss, PACKAGE_NAME + '/ConfigCard.css');
    assert.ok(tag.textContent.includes('.dsh-wb-card'));
    // ★ 四块布局的新类名必须随同一份样式下发（不另起 style tag）。
    for (const cls of ['.dsh-wb-task', '.dsh-wb-card__summary', '.dsh-wb-skeleton', '.dsh-wb-toast', '.dsh-wb-search', '.dsh-wb-block-title']) {
      assert.ok(tag.textContent.includes(cls), `★ 样式必须含 ${cls}（四块布局）`);
    }

    registration.factory(fakeRequire); // 模拟同页再次物化（HMR/重载路径）
    assert.equal(documentFake.created.length, 1, '去重查询命中 ⇒ 不追加第二份');
  });
});

test('CSS 注入对无 document 环境安全（bundle 不得在 Node 侧炸）', async () => {
  await withBundle({}, async (registration) => {
    const { fakeRequire } = makeRequire(makeFakeReact().React);
    assert.doesNotThrow(() => registration.factory(fakeRequire));
  });
});

test('常量同步：bundle 内常量与 src/shared/constants.js 逐字对齐', async () => {
  const text = readFileSync(CLIENT_PATH, 'utf8');
  assert.ok(text.includes("const PACKAGE_NAME = '" + PACKAGE_NAME + "'"));
  assert.ok(text.includes("const ROUTE_STATUS = '" + ROUTE_STATUS + "'"));
  const match = /const EFFORT_LEVELS = \[(?<body>[^\]]*)\]/.exec(text);
  assert.ok(match !== null, '必须能从产物中读出 EFFORT_LEVELS');
  const levels = match.groups.body
    .split(',')
    .map((part) => part.trim().replace(/^'|'$/g, ''))
    .filter((part) => part !== '');
  assert.deepEqual(levels, [...EFFORT_LEVELS]);
  // ★ 界面 6 档表必须存在且恰为"7 档去 off"（改一边就要同时改另一边）。
  assert.ok(text.includes('EFFORT_UI_LEVELS'), '必须能从产物中读出 EFFORT_UI_LEVELS（6 档）');
});

test('降级路径：状态路由不可达 ⇒ 显式错误文案（不把失败当数据）', async () => {
  const app = await boot({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();
  assert.ok(mainText(tree).includes('状态读取失败：status HTTP 500'));
});

test('降级路径：无 scope（服务未绑定）⇒ 卡片渲染降级文案而非抛错', async () => {
  await withBundle({}, async (registration) => {
    const { fakeRequire } = makeRequire(makeFakeReact().React);
    const plugin = registration.factory(fakeRequire);
    const runtime = makeFakeReact();
    /**
     * ★ 2026-10-02 更正：本用例的**意图**是"`configForms` 未绑定"，但旧写法把 `makeScope()`
     *   交给了 harness，而 harness 的 `configForms.get` 原样 `return scope`（见 `:166`）
     *   ⇒ `apply()` 里的 `scope` 恒为真，卡片永远走**正常**分支，降级文案永远不出现。
     *   这条断言此前长期为假（先被 #80 的 `inject` 崩掩盖，修掉 #80 后才暴露出来）。
     *   真契约：宿主服务未绑定时 `get()` 返回 `undefined`。显式不传 scope 才是这个场景。
     */
    const host = makeGuardedCtx(plugin, { scope: undefined });
    plugin.apply(host.ctx);
    host.slotsCalls[0].factory();
    assert.equal(host.bindSpecs[0].namespace, NS, '仍应尝试解析 configForms（失败也不许抛）');
    const card = host.registrations[0].component;
    const tree = runtime.render(card, {});
    assert.ok(
      textOf(tree).includes('设置服务不可用'),
      '★ 降级文案不得带宿主服务名（`configForms` / `settingsScope`）：用户查不到这个符号，只会以为是坏了',
    );
    assert.equal(textOf(tree).includes('configForms'), false, '★ 宿主服务名不得出现在界面上');
  });
});

test('刷新按钮：点击触发状态路由再读（refreshNonce → effect 重跑），且文案明确只重拉状态', async () => {
  const app = await boot({});
  app.expand();
  app.flushEffects();
  await settle();
  assert.equal(app.fetches.length, 1);
  const button = findAll(app.expand(), (n) => n.type === 'button' && n.props.className === 'dsh-wb-card__refresh')[0];
  assert.equal(labelText(button), '刷新状态');
  assert.equal(button.props.title, '重新拉取运行状态（不改配置）', '★ 按钮必须明确"只重拉状态，不碰配置"');
  button.props.onClick();
  app.expand();
  app.flushEffects();
  await settle();
  assert.equal(app.fetches.length, 2, '刷新必须重新拉取状态');
});

// ───────────────────────── R1 补强（测试有效性向审查后新增） ─────────────────────────

test('R1 补强：S2/DEGRADED 徽标（三态之 S2 与降级可见性，不得漏显示）', async () => {
  for (const [registry, expected, slug] of [
    ['UNREGISTERED', '○ 已关闭', 'dsh-wb-badge--unregistered'],
    ['DEGRADED', '⚠ 开启（功能受限）', 'dsh-wb-badge--degraded'],
    ['NOT_INSTALLED', '○ 未安装', 'dsh-wb-badge--not-installed'],
  ]) {
    const app = await boot({ status: statusPayload({ registry }) });
    app.expand();
    app.flushEffects();
    await settle();
    const tree = app.expand();
    assert.ok(mainText(tree).includes(expected), `${registry} ⇒ ${expected}（主视图，徽标不因折叠丢失）`);
    const badge = findAll(tree, (n) => n.type === 'span' && String(n.props.className).startsWith('dsh-wb-badge'))[0];
    assert.ok(String(badge.props.className).includes(slug), `class slug 必须为 ${slug}（'__'/'_' 会落空样式）`);
  }
});

test('★ 文案纪律：宿主给出**表里没有的枚举值**时，说"未知"，不得把机器标识符印上卡', async () => {
  // ★ 这条是被用户投诉逼出来的：旧写法是 `TABLE[value] ?? String(value)`。宿主加一个新枚举
  //   （或老插件遇到新枚举），卡片上就直接冒出 `PARTIAL_REGISTRATION` 这类标识符 ——
  //   用户看不懂，也判断不出"到底开没开"。未知就说未知；真值在载荷里，排查看日志。
  const app = await boot({
    scopeOptions: { status: 'warming_up', writable: false },
    status: statusPayload({
      registry: 'PARTIAL_REGISTRATION',
      lastRun: { argv: '', exitCode: 0, stderrExcerpt: '', flagVerdict: 'maybe_rejected' },
    }),
  });
  app.expand();
  app.flushEffects();
  await settle();
  const text = textOf(app.expand());
  for (const leaked of ['PARTIAL_REGISTRATION', 'warming_up', 'maybe_rejected']) {
    assert.equal(text.includes(leaked), false, `★ 未知枚举 ${leaked} 不得上屏（宁可说"未知"，含折叠）`);
  }
  // ★ 徽标 / 设置状态 / 参数接受度（折叠）三处都应说"未知"。
  assert.equal(text.split('未知').length - 1 >= 3, true, '徽标 / 设置状态 / 参数接受度三处都应说"未知"');
  // 负控：兜底只影响**不认识的值**，认识的照旧逐字显示（否则这条测试是空转的）。
  const ok = await boot({ status: statusPayload({ registry: 'REGISTERED' }) });
  ok.expand();
  ok.flushEffects();
  await settle();
  assert.ok(mainText(ok.expand()).includes('● 开启'), '已认识的枚举仍按表显示');
});

test('★ C 组上屏：registrationError 有值 ⇒ 只进诊断折叠；老 host 缺该字段不得渲染空行（正/负控制对）', async () => {
  // ★ 2026-10-02 改判：注册失败原文是内部串（英文堆栈式文案），主视图不出现，
  //   只进诊断折叠。否则它与"上次启动失败"共用一个 ⚠，用户会去查一个从没跑起来的程序。
  const app = await boot({
    status: statusPayload({ registry: 'DEGRADED', registrationError: 'duplicate tool registration: workbuddy_status' }),
  });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();
  const main = mainText(tree);
  const fold = foldText(tree);
  assert.equal(
    main.includes('duplicate tool registration: workbuddy_status'),
    false,
    '★ 注册失败原文不得出现在主视图（只进折叠）',
  );
  assert.ok(
    fold.includes('duplicate tool registration: workbuddy_status'),
    '★ DEGRADED 的注册期成因必须在折叠里可核对',
  );
  assert.ok(!main.includes('最近一次启动：退出码'), '没有 lastRun 记录就不得凭空造一行启动信息');
  assert.ok(main.includes('⚠ 开启（功能受限）'), '徽标仍按 registry 显示（本字段不抢状态）');

  const legacy = await boot({ status: statusPayload({ registry: 'DEGRADED' }) }); // 老 host：字段缺席
  legacy.expand();
  legacy.flushEffects();
  await settle();
  const legacyFold = foldText(legacy.expand());
  assert.ok(!legacyFold.includes('duplicate tool registration'), '字段缺席 ⇒ 折叠里也不加（不把"没有数据"读成"有故障"）');
  assert.ok(mainText(legacy.expand()).includes('⚠ 开启（功能受限）'), '徽标仍按 registry 显示');
});

test('R1 补强：不可写快照（unavailable/writable=false）⇒ 三控件全置灰 + 只读文案', async () => {
  const app = await boot({ scopeOptions: { status: 'unavailable', writable: false } });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();
  const input = findAll(tree, (n) => n.type === 'input' && n.props.className === 'dsh-wb-switch')[0];
  const selects = findAll(tree, (n) => n.type === 'select');
  assert.equal(input.props.disabled, true);
  assert.equal(selects.length, 2);
  assert.ok(selects.every((s) => s.props.disabled === true), '不可写 ⇒ 模型/强度也置灰');
  const text = textOf(tree);
  assert.ok(text.includes(' · 只读，当前页面无法保存'));
  assert.ok(text.includes('不可用（设置服务未连接）'));
  assert.equal(text.includes('namespace'), false, '★ 宿主内部说法不得上屏');
});

test('R2 补强：{status:"unavailable", writable:true}（真机可达）⇒ 三控件仍置灰（门控看 status，不只看 writable）', async () => {
  // 真机可达性：ui-settings:1089-1094（namespace 行缺失/decode 失败时 writable 仍为 host 值）。
  // 若只看 writable ⇒ 控件显示可编辑、改完宿主 mutate 静默失败 = "点了没反应"。
  // ★ 这条断言原属已移除的 /workbuddy-model 命令面；门控本身（lib/client.js:1346
  //   `snap.status === 'ready' && snap.writable === true`）留在卡片上，判据随之搬到这里。
  const app = await boot({ scopeOptions: { status: 'unavailable', writable: true } });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();
  const input = findAll(tree, (n) => n.type === 'input' && n.props.className === 'dsh-wb-switch')[0];
  const selects = findAll(tree, (n) => n.type === 'select');
  assert.equal(input.props.disabled, true, '快照未 ready ⇒ 开关必须置灰');
  assert.equal(selects.length, 2);
  assert.ok(selects.every((s) => s.props.disabled === true), '快照未 ready ⇒ 模型/强度也置灰');
});

test('R1 补强：路由失败后档位"对应值未知"而非谎报"不支持"（诚实性）', async () => {
  // ★ 载荷未到达**且无失败**时走单骨架（下拉根本不渲染）；"对应值未知"只出现在
  //   "路由失败但卡片仍要给出可操作配置"的形态下 —— 那时能力表确实未知，不得谎报不支持。
  const app = await boot({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();
  const options = findAll(tree, (n) => n.type === 'option' && n.props.value !== '');
  assert.equal(options.length, EFFORT_UI.length, '★ 失败态仍渲染 6 档（off 永不进界面）');
  assert.ok(options.every((o) => labelText(o).includes('对应值未知')), '未知 ⇒ 对应值未知');
  assert.ok(options.every((o) => o.props.disabled !== true), '未知 ⇒ 不置灰（不谎报不支持）');
  assert.ok(options.every((o) => !labelText(o).includes('不支持')));
});

test('R1 补强：卡片必须订阅 settingsScope 快照（防"只在 render 直读"的静默不更新）', async () => {
  const app = await boot({});
  app.expand();
  app.flushEffects();
  await settle();
  assert.ok(app.scope.listenerCount() >= 1, '必须订阅快照变更');
});

test('R1 补强：stale 响应竞态 —— 刷新后旧响应不得覆盖新值', async () => {
  // ★ 骨架态没有刷新按钮（内容区只有一个骨架）⇒ 竞态必须搭在"已加载后连点两次刷新"上：
  //   第 2 次 fetch 慢（被门闩住）、第 3 次快（先返回），旧响应后到 ⇒ 必须被丢弃。
  let resolveSecond = null;
  const second = new Promise((resolve) => {
    resolveSecond = resolve;
  });
  let calls = 0;
  const app = await boot({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: true, status: 200, json: async () => statusPayload({ registry: 'REGISTERED' }) };
      }
      if (calls === 2) {
        const payload = await second; // 第二次：慢
        return { ok: true, status: 200, json: async () => payload };
      }
      return { ok: true, status: 200, json: async () => statusPayload({ registry: 'UNREGISTERED' }) };
    },
  });
  app.expand();
  app.flushEffects();
  await settle();
  assert.ok(textOf(app.expand()).includes('● 开启'), '前提：首次加载已完成');
  const clickRefresh = () =>
    findAll(app.expand(), (n) => n.type === 'button' && n.props.className === 'dsh-wb-card__refresh')[0].props.onClick();
  clickRefresh(); // 第二次 fetch（慢）开始
  app.expand();
  app.flushEffects();
  clickRefresh(); // 第三次 fetch（快）开始，第二次变旧
  app.expand();
  app.flushEffects();
  await settle();
  assert.ok(textOf(app.expand()).includes('○ 已关闭'), '新响应必须生效');
  resolveSecond(statusPayload({ registry: 'DEGRADED' })); // 旧响应此后才到
  await settle();
  assert.ok(textOf(app.expand()).includes('○ 已关闭'), '旧响应必须被丢弃');
  assert.ok(!textOf(app.expand()).includes('环境降级'), '旧响应不得覆盖');
});

test('R1 补强：写失败（scope.set reject）⇒ Toast 如实说出来（不静默吞掉）', async () => {
  const app = await boot({});
  app.expand();
  app.flushEffects();
  await settle();
  const input = findAll(app.expand(), (n) => n.type === 'input' && n.props.className === 'dsh-wb-switch')[0];
  app.scope.failNextSet();
  input.props.onChange(); // write → set rejects → Toast
  await settle();
  assert.deepEqual(app.scope.commits[0], { op: 'set', field: 'enabled', value: true }, '写请求已发出');
  assert.equal(app.scope.getSnapshot().value.enabled, undefined, '失败 ⇒ 快照未被伪造更新');
  const toast = findAll(app.expand(), (n) => n.props && n.props.className === 'dsh-wb-toast')[0];
  assert.ok(toast !== undefined, '★ 写失败必须出 Toast（此前是 .catch(()=>{}) 静默吞掉）');
  assert.ok(labelText(toast).startsWith('保存失败：'), '★ Toast 必须说清是保存失败');
  assert.equal(toast.props.role, 'alert', '★ Toast 必须 role=alert（无障碍树可达）');
});

test('收纳：默认展开 —— 标题/徽标/描述可见，内容区即渲染（宿主惯例 `open ?? true`）', async () => {
  const app = await boot({});
  app.render(); // 首次渲染注册组件内 effect（fetch effect 由此进入收集器）
  app.flushEffects();
  await settle();
  const tree = app.render();
  const toggle = findAll(tree, (n) => n.type === 'button' && n.props.className === 'dsh-wb-card__toggle')[0];
  assert.ok(toggle !== undefined, '折叠头（dsh-wb-card__toggle）必须存在');
  // ★ 2026-10-02：由"默认折叠"改为"默认展开"。宿主惯例是 `open ?? true`（主内容）/
  // `?? false`（次级分组），见 settings-plugin-inventory/lib/client.js:339-340；本卡是该设置页
  // 唯一内容 ⇒ 属主内容。默认折叠会让用户打开设置页先看到一个空壳，与"能看到设置项但里面空白"同感。
  assert.equal(toggle.props['aria-expanded'], true, '默认必须展开（用户点一次才收起）');
  assert.equal(toggle.props['aria-label'], '收起设置: WorkBuddy');
  const text = textOf(tree);
  assert.ok(text.includes('WorkBuddy'), '标题可见');
  assert.ok(text.includes('● 开启'), '徽标可见（状态不因收纳丢失）');
  assert.ok(text.includes('在这里选 WorkBuddy 的模型、看剩余积分'), '描述行（官方 PluginCard 槽位）');
  assert.equal(
    findAll(tree, (n) => n.props && n.props.className === 'dsh-wb-card__body').length,
    1,
    '默认展开 ⇒ 内容区必须已渲染',
  );
  assert.equal(
    findAll(tree, (n) => n.type === 'input' && n.props.className === 'dsh-wb-switch').length,
    2,
    '默认展开 ⇒ 两个开关必须已渲染（总开关 + 自动领取每日积分），否则用户打开设置页看到的是空壳',
  );
});

test('收纳：默认展开 → 点击收起 → 再点展开 —— aria-expanded、内容区、chevron 类、primitives 图标来源', async () => {
  const app = await boot({});
  app.render();
  app.flushEffects();
  await settle();
  const opened = app.render();
  const chevron0 = findAll(
    opened,
    (n) => n.props && typeof n.props.className === 'string' && n.props.className.includes('dsh-wb-card__chevron'),
  )[0];
  assert.ok(chevron0 !== undefined, '必须渲染 chevron 容器');
  assert.ok(chevron0.props.className.includes('--open'), '默认展开态 chevron 必须带 --open（旋转指示）');
  assert.ok(
    findAll(opened, (n) => n.type === 'svg' && n.props.className === 'fake-primitives-icon-chevron-down-regular').length >= 1,
    'chevron 必须由 primitives 图标渲染（与官方/市场同源，而非自绘）',
  );

  const toggle = findAll(opened, (n) => n.type === 'button' && n.props.className === 'dsh-wb-card__toggle')[0];
  toggle.props.onClick();
  const collapsed = app.render();
  const toggle2 = findAll(collapsed, (n) => n.type === 'button' && n.props.className === 'dsh-wb-card__toggle')[0];
  assert.equal(toggle2.props['aria-expanded'], false, '收起后 aria-expanded=false');
  assert.equal(toggle2.props['aria-label'], '展开设置: WorkBuddy');
  assert.equal(
    findAll(collapsed, (n) => n.props && n.props.className === 'dsh-wb-card__body').length,
    0,
    '收起后内容区必须消失',
  );
  assert.equal(
    findAll(collapsed, (n) => n.type === 'input' && n.props.className === 'dsh-wb-switch').length,
    0,
    '收起后控件必须消失',
  );
  assert.equal(
    findAll(
      collapsed,
      (n) => n.props && typeof n.props.className === 'string' && n.props.className.includes('dsh-wb-card__chevron--open'),
    ).length,
    0,
    '收起态 chevron 不得带 --open',
  );

  toggle2.props.onClick();
  const reopened = app.render();
  assert.equal(
    findAll(reopened, (n) => n.props && n.props.className === 'dsh-wb-card__body').length,
    1,
    '再点必须重新展开',
  );
});

// ───────────── 功能①/③ 补强：模型目录 × 倍率目录合成（buildModelOptions）+ 会话可见性 ─────────────
// ★★ 2026-10-01 改判（命令行链路整体删除后）★★
//   旧判据编的是"目录 × 命令行支持快照"那一套（标注「CLI 未列」/ 补入快照独有 id / 快照行计数）。
//   那几个概念的**数据源已经不存在**（载荷里不再有支持快照），断言随之失去对象 ⇒ 本组整体重写为
//   当前真契约。每条新断言都做了变异验证（把产品改回任一侧都能红）：
//   （a）**不丢条目**：目录有 N 条 ⇒ 下拉有 N 条（含"倍率未知"的那些）；
//   （b）倍率按 `cost.models[].factor` 对齐：有 ⇒ `（x… credits）`，无 ⇒ `（倍率未知）`；
//   （c）`factor === 0` 印 `（x0）`（平台赠送是**已知事实**，不得与"未知"合并）；
//   （d）倍率目录缺失 / 条目不全 ⇒ 一律"未知"，不隐藏、不压成 0（缺数据 ≠ 免费）；
//   （e）任何模型 option 都不得 disabled；
//   （f）会话行「可续接 N/M：key→8 位前缀」保持不变（与本次改动无关，留作回归）。
// ★ 2026-10-02 补充：下拉按计费事实分组（免费 → 按量 → 未知）+ 搜索框过滤。
//   分组改变 option 顺序（同组内保持目录序），跨组顺序由 MODEL_GROUPS 决定 ——
//   断言顺序的用例一律按"免费→按量→未知"期望，断言条目的用例用排序后比较。

/**
 * 目录夹具。★ `isFree` 仍给（宿主目录项一定带它），但**客户端不再用它决定是否展示**——
 * 它只证明"目录项目带一个客户端不消费的字段时，行为不受影响"。
 * ⚠️ 这里**故意没有** `factor` 字段：真机 `models[]` 也没有（倍率只在 cost 里）。
 *    如果哪天有人把倍率读到 models 上，本夹具会让那些行全部变成"倍率未知" ⇒ 立刻红。
 */
const CATALOG_TWO = [
  { id: 'm1', label: 'Model One', detail: '', isFree: false, supportsReasoning: true },
  { id: 'm2', label: 'Model Two', detail: '10x', isFree: false, supportsReasoning: true },
];

/** 倍率目录夹具（与 CATALOG_TWO 同源：m2 有倍率、m1 刻意没有）。 */
const COST_TWO = [
  { modelId: 'm2', displayName: 'Model Two', factor: 0.06, freeWindow: null, source: 'product' },
];

/** 与 COST_TWO 同值的 `cost` 段（独立常量，让用例里"显式给倍率"这层意图一眼可见）。 */
const COST_TWO_COST = { models: COST_TWO };

/** 状态载荷 → 展开后的卡片（沿用既有 boot + effect 回放机制，不另造渲染入口）。 */
async function bootFromStatus(statusOverrides, { scopeValue = { enabled: false, model: '', effort: '' } } = {}) {
  const app = await boot({ scopeValue, status: statusPayload(statusOverrides) });
  app.expand();
  app.flushEffects();
  await settle();
  return app;
}

/** 模型下拉的 option 节点（含 value='' 的哨兵项）。 */
function modelOptionNodes(tree) {
  const select = findAll(tree, (n) => n.type === 'select' && n.props.id === 'dsh-wb-model')[0];
  assert.ok(select !== undefined, '模型下拉必须渲染');
  const options = findAll(select, (n) => n.type === 'option');
  assert.ok(options.length > 0, '模型下拉必须至少有一个 option');
  return options;
}

/** 取 value=id 的 option 文本（label（detail）+ 标注）。 */
function optionText(tree, id) {
  const node = modelOptionNodes(tree).find((o) => o.props.value === id);
  assert.ok(node !== undefined, `必须存在 value=${id} 的 option`);
  return labelText(node);
}

test('功能①（a）：不丢条目 —— 目录有多少条下拉就多少条；未知倍率**照常展示**（不得隐藏）', async () => {
  const app = await bootFromStatus({ models: CATALOG_TWO, cost: { models: COST_TWO } });
  const tree = app.expand();
  const options = modelOptionNodes(tree);
  // ★ 分组顺序：m2（按量组）在前，m1（未知组）在后；哨兵恒第一。
  assert.deepEqual(options.map((o) => o.props.value), ['', 'm2', 'm1'], '★ 目录 2 条 ⇒ 下拉必须有 2 条（+1 个哨兵行），按 免费→按量→未知 分组');
  // 正控：有倍率 ⇒ 印倍数。
  assert.equal(optionText(tree, 'm2'), 'Model Two · 10x（x0.06）', '★ 有倍率 ⇒ label（detail）（x… credits）');
  // ★★ 负控（本次修复的判别点）：无倍率的那条**必须还在**，且如实标"倍率未知"。
  assert.equal(optionText(tree, 'm1'), 'Model One（倍率未知）', '★★ 无倍率 ⇒ 标"倍率未知"，不得隐藏、不得压成 0/免费');
});

test('功能①（b）：倍率索引单一来源 —— 只读 `cost.models[].factor`，绝不读 `models[].factor`', async () => {
  // ★ 判别力：真机 `models[].factor` **恒为 `null`**。若有人把倍率读回 models 上（哪怕只是"顺手兜底"），
  //   下面这条会立刻变成"倍率未知"而红 —— 这正是把"读错字段"和"厂商没声明"区分开的那道探测。
  const app = await bootFromStatus({
    models: [
      { id: 'm1', label: 'Model One', detail: '', factor: 0.11, isFree: false, supportsReasoning: true },
    ],
    cost: { models: [{ modelId: 'm1', factor: 0.06 }] },
  });
  const tree = app.expand();
  assert.equal(
    optionText(tree, 'm1'),
    'Model One（x0.06）',
    '★ 倍率必须取自 cost.models（0.06），而不是 models 上那个值（0.11）',
  );
  assert.equal(textOf(tree).includes('0.11'), false, '★ models[].factor 上的值不得出现在任何文案里');
});

test('功能①（c）：`factor === 0` 是"平台赠送"这个**已知事实**，不得与"未知"合并成同一句话', async () => {
  const app = await bootFromStatus({
    // ⚠️ 这里必须把 `cost` 的**全貌**写出来：只覆盖 `models` 会让夹具把倍率目录收窄到本用例的
    //    两个 id（见 statusPayload 头注），期望值会随夹具行为漂 —— 测的就不是产品了。
    models: [
      { id: 'free1', label: 'Free One', detail: '' },
      { id: 'paid1', label: 'Paid One', detail: '', isFree: false },
    ],
    cost: { models: [{ modelId: 'free1', factor: 0 }] },
  });
  const tree = app.expand();
  assert.equal(optionText(tree, 'free1'), 'Free One（x0）', '★ 0 走有值分支（x0），不是"未知"');
  assert.equal(optionText(tree, 'paid1'), 'Paid One（倍率未知）', '★ 缺席才是"未知"——两条文案必须可区分');
  assert.notEqual(optionText(tree, 'free1'), optionText(tree, 'paid1'), '★ 免费与未知不得渲染成同一句（否则"没声明"被读成"免费"）');
});

test('功能①（c2）：倍率目录缺失 / 空 / 非对象 ⇒ 一律"未知"，且目录条目仍然全在', async () => {
  // 本用例的载荷**整份重写**：`cost` 显式写出（含 undefined），好让"没有倍率"这件事由**这一条**
  // 自己声明，而不是继承种子夹具的默认值 —— 真正接线到卡片 prop 上的载荷**不会**走夹具的收窄捷径。
  // ⚠️ 夹具的收窄规则是种子数据层的便利（由 |b-2| 用例单独锁），不是这一条要验的产品性质。
  //    写这条时真被"默认 cost 偷偷补上倍率"绊过两次：期望"未知"，实际拿到 0.06。
  const cases = [
    ['cost 段缺失', undefined, 'Model Two · 10x（倍率未知）'],
    ['cost.models 空数组', { models: [] }, 'Model Two · 10x（倍率未知）'],
    ['cost 非对象', 'nope', 'Model Two · 10x（倍率未知）'],
    ['cost 显式给出倍率（正控）', COST_TWO_COST, 'Model Two · 10x（x0.06）'],
  ];
  for (const [label, cost, expectedM2] of cases) {
    // ★ 直接给整份 status（不经 statusPayload 的默认值）⇒ 期望值与本行字面量一一对应。
    const app = await boot({
      scopeValue: { enabled: false, model: '', effort: '' },
      status: { ...statusPayload(), models: CATALOG_TWO, cost },
    });
    app.expand();
    app.flushEffects();
    await settle();
    const tree = app.expand();
    // ★ 分组会改变顺序（有倍率时 m2 先行），这里只锁"条目集合"，顺序由（a）用例锁。
    assert.deepEqual(
      modelOptionNodes(tree).map((o) => o.props.value).sort(),
      ['', 'm1', 'm2'].sort(),
      `★ ${label} ⇒ 目录条目必须**一条不少**（缺倍率不是隐藏它的理由）`,
    );
    assert.equal(optionText(tree, 'm1'), 'Model One（倍率未知）', `${label} ⇒ m1 一律未知`);
    assert.equal(optionText(tree, 'm2'), expectedM2, `${label} ⇒ m2 的倍率判定`);
  }
});

test('功能①（c3）：倍率目录**字段坏掉**（factor 非数 / modelId 非串）⇒ 该条按"未知"处理，绝不进索引', async () => {
  for (const [label, factor] of [
    ['factor 是字符串 "0.06"', '0.06'],
    ['factor 是 NaN', Number.NaN],
    ['factor 是布尔 true', true],
    ['factor 是 null', null],
  ]) {
    const app = await bootFromStatus({ cost: { models: [{ modelId: 'm2', factor }] } });
    const tree = app.expand();
    // 判别点：`buildFactorIndex` 只在 `typeof factor === 'number' && Number.isFinite` 时入库。
    // 少了这道自守，`'0.06'` 会印成 `（x0.06）`（字符串碰巧像数），`true` 会印成 `（xtrue credits）`。
    assert.equal(optionText(tree, 'm2'), 'Model Two · 10x（倍率未知）', `★ ${label} ⇒ 必须落到"未知"分支`);
  }
  const badId = await bootFromStatus({ cost: { models: [{ modelId: 42, factor: 0.06 }] } });
  assert.equal(optionText(badId.expand(), 'm2'), 'Model Two · 10x（倍率未知）', '★ modelId 非字符串 ⇒ 不入索引');
});

test('功能①（b-2）：夹具本身的判别点 —— 覆盖 models 而未覆盖 cost ⇒ 倍率目录同步收窄', async () => {
  // 这条锁的是**夹具**的诚实性：若"覆盖 models"后默认倍率仍被悄悄贴上，那么任何写
  // "外部目录 ⇒ 倍率未知"的用例都会拿到 0.06 而红 —— 与其让人以为是产品坏了，不如在这里锁死。
  const shrunk = await bootFromStatus({ models: [{ id: 'm1', label: 'Model One', detail: '' }] });
  const tree = shrunk.expand();
  assert.deepEqual(
    modelOptionNodes(tree).map((o) => o.props.value),
    ['', 'm1'],
    '覆盖后的目录只有 m1',
  );
  assert.equal(optionText(tree, 'm1'), 'Model One（倍率未知）', '★ m1 不在倍率目录里 ⇒ 未知（不得凭空继承默认的 m2 倍率）');
  const kept = await bootFromStatus({ models: CATALOG_TWO, cost: { models: COST_TWO } });
  assert.equal(optionText(kept.expand(), 'm2'), 'Model Two · 10x（x0.06）', '显式给出倍率目录 ⇒ 照常命中');
});

test('功能①（d）：会话行只给**计数信号**；key→id 明细进诊断折叠块；sessions 空 ⇒ 整行不渲染', async () => {
  // ★ 2026-10-02 改判：明细不再平铺。理由是真机读数 —— 4 条可继续会话在设置卡上
  //   展开成一串 `k1→abcdefgh、k2→…` 的长 UUID，挤在"剩余积分"和"模型"之间。
  //   用户在这张卡上要做的决定跟会话 id 无关；深排障本来就有 workbuddy_status。
  //   ⇒ 默认视图只留计数；明细进末尾默认收起的 <details>，一个都不丢。
  const app = await bootFromStatus({
    sessions: [
      { sessionKey: 'k1', cliSessionId: 'abcdefgh-1111-2222', resumable: true, lastUsedAt: 3 },
      { sessionKey: 'k2', cliSessionId: 'ZYXWVUTS-3333-4444', resumable: true, lastUsedAt: 2 },
      { sessionKey: 'k3', cliSessionId: '', resumable: false, lastUsedAt: 1 },
      { sessionKey: 'k4', cliSessionId: 'RESUME04-5555-6666', resumable: true, lastUsedAt: 0 },
      { sessionKey: 'k5', cliSessionId: 'RESUME05-7777-8888', resumable: true, lastUsedAt: -1 },
    ],
  });
  const tree = app.expand();
  const main = mainText(tree);

  // ① 默认视图：一行计数，且**不含**任何 key 或 id
  const line = findAll(
    tree,
    (n) => n.type === 'div' && n.props.className === 'dsh-wb-status__line' && labelText(n).startsWith('可继续的会话'),
  )[0];
  assert.ok(line !== undefined, '会话行必须渲染');
  assert.ok(labelText(line).startsWith('可继续的会话 4/5'), '★ 可继续计数必须逐字上屏');
  assert.equal(main.includes('k1'), false, '★ 默认视图不得再平铺会话 key');
  assert.equal(main.includes('abcdefgh'), false, '★ 默认视图不得再平铺会话 id');

  // ② 诊断折叠块存在，且明细一条不少（只是收起来了，不是删了）
  const fold = foldText(tree);
  for (const k of ['k1', 'k2', 'k4', 'k5']) {
    assert.ok(fold.includes(k), `★ 明细里不能丢 ${k}（收起来 ≠ 删掉）`);
  }
  assert.equal(fold.includes('k3'), false, '★ 不可继续的那条不进明细（计数的分母仍然算它）');
  assert.equal(fold.includes('abcdefgh-1111-2222'), false, '★ 仍然只印前 8 位，不上屏整串 id');

  const none = await bootFromStatus({ sessions: [] });
  assert.equal(textOf(none.expand()).includes('可继续的会话'), false, '★ sessions 为空 ⇒ 整行不渲染（不印 0/0）');
});

test('功能③（d-c）：sessions 非空但**无可继续** ⇒ 必须给出明确文案，不得以裸冒号收尾', async () => {
  const app = await bootFromStatus({
    sessions: [
      { sessionKey: 'k1', cliSessionId: '', resumable: false, lastUsedAt: 2 },
      { sessionKey: 'k2', cliSessionId: 'x', resumable: false, lastUsedAt: 1 },
    ],
  });
  const tree = app.expand();
  const line = findAll(
    tree,
    (n) => n.type === 'div' && n.props.className === 'dsh-wb-status__line' && labelText(n).startsWith('可继续的会话'),
  )[0];
  assert.ok(line !== undefined, '会话行必须渲染（sessions 非空）');
  assert.equal(
    labelText(line),
    '可继续的会话 0/2（记录里的会话都已失效）',
    '★ 0 可继续必须逐字给出明确文案，而不是「：」之后空无一物（也不得说"会话 id"这种内部说法）',
  );
  assert.equal(labelText(line).endsWith('：'), false, '★ 不得以裸冒号收尾（空列表）');
  assert.equal(textOf(tree).includes('：、'), false, '不得渲染空列表连接符（「：、」）');
});

test('功能①（e）：任何模型 option 都不得 disabled（倍率是标注，不是门禁）', async () => {
  const app = await bootFromStatus({ models: CATALOG_TWO, cost: { models: COST_TWO } });
  const options = modelOptionNodes(app.expand());
  assert.deepEqual(
    options.map((o) => o.props.value).sort(),
    ['', 'm1', 'm2'].sort(),
  );
  assert.equal(
    options.every((o) => o.props.disabled !== true),
    true,
    '★ 不得对任何模型 option 设 disabled —— 据此禁用会把实际可用的模型锁死',
  );
});

test('模型面真实化（f）：未固定 ⇒ hint 把"谁选 + 没选会怎样"两分支说全；已固定 ⇒ 不渲染（负控）', async () => {
  const UNSET_HINT = '每次用时重新选；那次也没选，就用桌面端自己的默认。';
  const status = { models: CATALOG_TWO, cost: { models: COST_TWO } };

  // 正控：设置里没钉模型 ⇒ 这一行必须自己解释清楚（否则「未固定」又只剩一句口号）
  const unset = await bootFromStatus(status);
  assert.ok(textOf(unset.expand()).includes(UNSET_HINT), '★ 未固定 ⇒ 两分支 hint 必须逐字上屏');

  // 负控：设置里钉死了 ⇒ 不谈"谁来选"（那段解释此刻是假的）
  const fixed = await bootFromStatus(status, { scopeValue: { enabled: false, model: 'm1', effort: '' } });
  assert.equal(
    textOf(fixed.expand()).includes(UNSET_HINT),
    false,
    '★ 已固定模型 ⇒ 不得渲染"该谁选"的解释（会与"当前用 m1"自相矛盾）',
  );
});

test('功能①（分组）：模型下拉按计费事实分组 —— 免费 → 按量 → 未知；搜索框过滤候选', async () => {
  const app = await bootFromStatus({
    models: [
      { id: 'free1', label: 'Free One', detail: '' },
      { id: 'paid1', label: 'Paid One', detail: '' },
      { id: 'unk1', label: 'Unk One', detail: '' },
    ],
    cost: { models: [{ modelId: 'paid1', factor: 0.5 }, { modelId: 'free1', factor: 0 }] },
  });
  const tree = app.expand();
  const groups = findAll(tree, (n) => n.type === 'optgroup');
  assert.deepEqual(
    groups.map((g) => g.props.label),
    ['免费模型', '按量计费', '倍率未知'],
    '★ 分组顺序固定：免费 → 按量 → 未知',
  );
  const inGroup = (label) => groups.find((g) => g.props.label === label);
  assert.deepEqual(
    findAll(inGroup('免费模型'), (n) => n.type === 'option').map((o) => o.props.value),
    ['free1'],
  );
  assert.deepEqual(
    findAll(inGroup('按量计费'), (n) => n.type === 'option').map((o) => o.props.value),
    ['paid1'],
  );
  assert.deepEqual(
    findAll(inGroup('倍率未知'), (n) => n.type === 'option').map((o) => o.props.value),
    ['unk1'],
  );
  // 搜索框存在且过滤候选（不写回设置）。
  const search = findAll(tree, (n) => n.type === 'input' && n.props.className === 'dsh-wb-search')[0];
  assert.ok(search !== undefined, '★ 模型行必须有搜索框');
  assert.equal(search.props.placeholder, '搜索模型…');
  search.props.onChange({ target: { value: 'paid' } });
  const filtered = app.expand();
  assert.deepEqual(
    modelOptionNodes(filtered).map((o) => o.props.value),
    ['', 'paid1'],
    '★ 搜索按 label/id 子串过滤（哨兵行恒在）',
  );
  assert.equal(app.scope.commits.length, 0, '★ 搜索不得写回设置');
  search.props.onChange({ target: { value: 'zzz-no-such-model' } });
  const nomatch = app.expand();
  assert.equal(modelOptionNodes(nomatch).length, 1, '★ 无匹配时只剩哨兵行');
  assert.ok(textOf(nomatch).includes('没有匹配的模型'), '★ 无匹配必须有明确提示');
});

test('功能②（强度 6 档）：off 永不进界面（可下发的才列出来）', async () => {
  const app = await bootFromStatus({});
  const tree = app.expand();
  const select = findAll(tree, (n) => n.type === 'select' && n.props.id === 'dsh-wb-effort')[0];
  assert.ok(select !== undefined, '强度下拉必须渲染');
  const values = findAll(select, (n) => n.type === 'option' && n.props.value !== '').map((o) => o.props.value);
  assert.deepEqual(values, [...EFFORT_UI], '★ 强度下拉恰为 6 档（minimal…max）');
  assert.equal(values.includes('off'), false, '★ off 不得渲染');
});

// ───────────── 「剩余积分」行（payload.credits）—— 宿主早算好了，卡片从来没画过 ─────────────
// 立场：这五条不是"文案检查"，是**诚实性检查**。核心禁忌只有一个：**把"没读到"画成 `0`**。
// 之所以值得单独立组：`0` 是一个**看起来正常的值** —— 它不会让任何断言凭直觉失败，
// 却会让用户以为"我的积分用光了"。所以每条负向用例都同时断言"该显示什么"与"不得显示 0"。
// ★ 2026-10-02：单位中文化 —— 载荷里的 `credits` 在界面上一律说"积分"。

/** 从树里取积分行（key='credits' 的那个 div）。 */
function creditsLine(tree) {
  const node = findAll(
    tree,
    (n) => n.type === 'div' && n.props && n.props.className === 'dsh-wb-status__line' && n.props.key === 'credits',
  )[0];
  assert.ok(node !== undefined, '积分行必须渲染（key=credits）');
  return labelText(node);
}

test('积分①：载荷未到达 ⇒ 单个加载骨架（积分行尚未存在，而不是"显示 0"或"不存在即无功能"）', async () => {
  const app = await boot({ fetchImpl: async () => new Promise(() => {}) }); // 永不 settle
  const tree = app.expand();
  app.flushEffects();
  assert.equal(
    findAll(app.render(), (n) => n.type === 'div' && n.props.className === 'dsh-wb-skeleton').length,
    1,
    '★ 载荷未到达 ⇒ 内容区只有一个骨架',
  );
  assert.equal(
    findAll(tree, (n) => n.type === 'div' && n.props && n.props.className === 'dsh-wb-status__line' && n.props.key === 'credits').length,
    0,
    '★ 骨架态下积分行尚未渲染（不得伪造一行"0"来占位）',
  );
});

test('积分①对称面：载荷到达但 credits 字段为 null（宿主无该服务）⇒ 仍是"读取中"，不得显示 0', async () => {
  const app = await bootFromStatus({ credits: null });
  const line = creditsLine(app.expand());
  assert.equal(line, '剩余积分：读取中', '★ credits:null ⇒ 与"未到达"同处理（都是"我们不知道"）');
  assert.ok(line.includes('0') === false, '★★ 不得显示 0');
});

test('积分②：有值 ⇒ `剩余积分：987.47 积分`（保留 2 位小数，不四舍五入成整数；单位中文化）', async () => {
  const app = await bootFromStatus({ credits: { ok: true, source: 'live', remain: 987.47, ageMs: 5_000, stale: false, unit: 'credits' } });
  assert.equal(creditsLine(app.expand()), '剩余积分：987.47 积分');
});

test('积分②b：超长小数位 ⇒ 截到 2 位（`1101.2500008900001` → `1101.25`），不原样倾倒', async () => {
  // 真机读数就是这种形态（浮点尾数），原样打印会让状态区出现一坨 17 位垃圾。
  const app = await bootFromStatus({ credits: { ok: true, source: 'live', remain: 1101.2500008900001, ageMs: 1_000, stale: false, unit: 'credits' } });
  assert.equal(creditsLine(app.expand()), '剩余积分：1101.25 积分', '★ 保留 2 位小数');
});

test('积分③：stale === true ⇒ 数值照印，但**必须**标注陈旧并带 ageMs', async () => {
  const app = await bootFromStatus({ credits: { ok: true, source: 'live', remain: 42.5, ageMs: 90_000, stale: true, unit: 'credits' } });
  const line = creditsLine(app.expand());
  assert.ok(line.includes('42.50 积分'), '★ 陈旧不是"不显示"：上次读到的真值照印');
  assert.ok(line.includes('数据陈旧'), '★ 必须标注陈旧（否则过期读数会被当成实时结论）');
  assert.ok(line.includes('1分钟'), `★ 必须带上 ageMs 的人话形式（收到：${line}）`);
  assert.ok(line.includes('90') === false, '★ 印的是人话（1分钟），不是裸毫秒');
});

test('积分④：source === workbuddy_desktop_closed ⇒ 说来由（"桌面端未运行"），不得显示 0', async () => {
  const app = await bootFromStatus({
    credits: { ok: false, source: 'workbuddy_desktop_closed', remain: null, ageMs: null, stale: true, unit: null, error: { code: 'workbuddy_desktop_closed', message: 'connect ENOENT \\.\pipe\wbipc-x' } },
  });
  const line = creditsLine(app.expand());
  assert.ok(line.includes('WorkBuddy 桌面端未运行'), '★ 必须把归因说成人话（可执行的动作：把桌面端打开）');
  assert.ok(line.includes('connect ENOENT') === false, '★ 不得把本机内部管道名当黑话抛给用户');
  assert.ok(line.includes('0') === false, '★★ 不得显示 0');
});

test('积分⑤：ok === false / error 有值 ⇒ 说来由（带机器可读 code），不得显示 0', async () => {
  const app = await bootFromStatus({
    credits: { ok: false, source: 'unavailable', remain: null, ageMs: null, stale: true, unit: null, error: { code: 'unexpected_response', message: 'billing returned a response we do not recognise' } },
  });
  const line = creditsLine(app.expand());
  assert.ok(line.includes('暂时读不到积分'), '★ 必须给出明确来由');
  assert.ok(line.includes('unexpected_response'), '★ 机器可读 code 随行（可核对、可搜）');
  assert.ok(line.includes('0') === false, '★★ 不得显示 0');
});

test('积分⑤b：ok === true 但 remain 非数 ⇒ "平台未返回数值"，不得显示 0（缺数据 ≠ 余额为 0）', async () => {
  for (const [label, remain] of [['remain 为 null', null], ['remain 是字符串', '987.47'], ['remain 缺失', undefined]]) {
    const credits = { ok: true, source: 'live', ageMs: 1_000, stale: false, unit: 'credits' };
    if (remain !== undefined) credits.remain = remain;
    const app = await bootFromStatus({ credits });
    const line = creditsLine(app.expand());
    assert.equal(line, '剩余积分：平台未返回数值', `★ ${label} ⇒ 如实说"没给数"`);
    assert.ok(line.includes('0') === false, `★★ ${label} ⇒ 不得显示 0`);
  }
});

test('积分⑥：单位缺失 ⇒ 回落到`积分`；行只在**状态区内**渲染（全卡文本不得出现第二个"剩余积分"）', async () => {
  const app = await bootFromStatus({ credits: { ok: true, source: 'live', remain: 12.345, ageMs: 1_000, stale: false } });
  const tree = app.expand();
  assert.equal(creditsLine(tree), '剩余积分：12.35 积分', '★ unit 缺失 ⇒ 用"积分"；12.345 进位到 12.35');
  const hits = findAll(
    tree,
    (n) => n.type === 'div' && String(n.props.className).includes('dsh-wb-status__line') && labelText(n).startsWith('剩余积分'),
  );
  assert.equal(hits.length, 1, '★ 积分行必须恰好一条（不该在别处再抄一份；收起摘要只印数字不印标签）');
});

test('积分⑦：与状态路由不可达共存 ⇒ 两行都在（积分说"加载中"，路由说来由，互不吞没）', async () => {
  const app = await boot({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();
  assert.equal(creditsLine(tree), '剩余积分：读取中', '★ 路由挂了 ⇒ 积分无从得知，仍是"加载中"');
  assert.ok(mainText(tree).includes('状态读取失败：status HTTP 500'), '★ 路由失败仍须显式上屏');
});

// ───────────── 「每日签到」行（payload.checkin）+ 自动领取开关 ─────────────
// 立场与积分组同款：**没读到不得说成"未领/已领"**。`0` 在这里不是风险项
// （签到行不印余额），风险项是"把未知说成一种结论" —— 用户会据此干等或白跑一趟。

/** 从树里取签到行（key='checkin' 的那个 div）。 */
function checkinLine(tree) {
  const node = findAll(
    tree,
    (n) => n.type === 'div' && n.props && n.props.className === 'dsh-wb-status__line' && n.props.key === 'checkin',
  )[0];
  assert.ok(node !== undefined, '签到行必须渲染（key=checkin）');
  return labelText(node);
}

test('签到①：老宿主无 checkin 字段 ⇒ "读取中"（不消失、不猜结论）', async () => {
  const app = await bootFromStatus({});
  assert.equal(checkinLine(app.expand()), '每日签到：读取中');
  const hits = findAll(
    app.expand(),
    (n) => n.type === 'div' && String(n.props.className).includes('dsh-wb-status__line') && labelText(n).startsWith('每日签到'),
  );
  assert.equal(hits.length, 1, '★ 签到行必须恰好一条');
});

test('签到②：已领 ⇒ `今日已领，今日 +100，连签 2 天`（缺数就略过该半句，不编数）', async () => {
  const app = await bootFromStatus({
    checkin: { ok: true, source: 'live', active: true, todayCheckedIn: true, streakDays: 2, dailyCredit: 100, todayCredit: 100, totalCredits: 200, endTime: '2026-10-15 23:59:59', autoEnabled: true, lastClaim: null, at: 1, ageMs: 1_000, stale: false, error: null },
  });
  assert.equal(checkinLine(app.expand()), '每日签到：今日已领，今日 +100，连签 2 天');
  const thin = await bootFromStatus({
    checkin: { ok: true, source: 'live', active: true, todayCheckedIn: true, streakDays: null, dailyCredit: null, todayCredit: null, totalCredits: null, endTime: null, autoEnabled: true, lastClaim: null, at: 1, ageMs: 1_000, stale: false, error: null },
  });
  assert.equal(checkinLine(thin.expand()), '每日签到：今日已领', '★ 数缺失 ⇒ 只说已领，不编数');
});

test('签到③：未领 ⇒ 按自动领取开关说"将自动领取"还是"已关闭"（不让用户干等）', async () => {
  const auto = await bootFromStatus({
    checkin: { ok: true, source: 'live', active: true, todayCheckedIn: false, streakDays: 1, dailyCredit: 100, todayCredit: null, totalCredits: 100, endTime: null, autoEnabled: true, lastClaim: null, at: 1, ageMs: 1_000, stale: false, error: null },
  });
  assert.equal(checkinLine(auto.expand()), '每日签到：今日未领，将自动领取');
  const manual = await bootFromStatus({
    checkin: { ok: true, source: 'live', active: true, todayCheckedIn: false, streakDays: 1, dailyCredit: 100, todayCredit: null, totalCredits: 100, endTime: null, autoEnabled: false, lastClaim: null, at: 1, ageMs: 1_000, stale: false, error: null },
  });
  assert.equal(checkinLine(manual.expand()), '每日签到：今日未领（自动领取已关闭）');
});

test('签到④：active === false ⇒ "签到活动已结束"（正常状态，不是故障）', async () => {
  const app = await bootFromStatus({
    checkin: { ok: true, source: 'live', active: false, todayCheckedIn: null, streakDays: null, dailyCredit: null, todayCredit: null, totalCredits: null, endTime: '2026-10-15 23:59:59', autoEnabled: true, lastClaim: null, at: 1, ageMs: 1_000, stale: false, error: null },
  });
  assert.equal(checkinLine(app.expand()), '每日签到：签到活动已结束');
});

test('签到⑤：ok === false ⇒ 说来由（带机器可读 code）；桌面端没开给可执行的话', async () => {
  const app = await bootFromStatus({
    checkin: { ok: false, source: 'unavailable', active: null, todayCheckedIn: null, streakDays: null, dailyCredit: null, todayCredit: null, totalCredits: null, endTime: null, autoEnabled: true, lastClaim: null, at: null, ageMs: null, stale: true, error: { code: 'unexpected_response', message: 'x' } },
  });
  const line = checkinLine(app.expand());
  assert.ok(line.includes('暂时读不到签到状态'), '★ 必须给出明确来由');
  assert.ok(line.includes('unexpected_response'), '★ 机器可读 code 随行');
  const closed = await bootFromStatus({
    checkin: { ok: false, source: 'workbuddy_desktop_closed', active: null, todayCheckedIn: null, streakDays: null, dailyCredit: null, todayCredit: null, totalCredits: null, endTime: null, autoEnabled: true, lastClaim: null, at: null, ageMs: null, stale: true, error: { code: 'workbuddy_desktop_closed', message: 'x' } },
  });
  const line2 = checkinLine(closed.expand());
  assert.ok(line2.includes('WorkBuddy 桌面端未运行'), '★ 可执行的动作：把桌面端打开');
  const thin = await bootFromStatus({
    checkin: { ok: true, source: 'live', active: true, todayCheckedIn: null, streakDays: null, dailyCredit: null, todayCredit: null, totalCredits: null, endTime: null, autoEnabled: true, lastClaim: null, at: 1, ageMs: 1_000, stale: false, error: null },
  });
  assert.equal(checkinLine(thin.expand()), '每日签到：平台未返回签到状态', '★ 字段缺失 ⇒ 如实说"没给"，不猜已领/未领');
});

test('签到⑥：自动领取开关读写 —— 缺省按开显示；交互 → scope.set → 快照变更 → 重渲染', async () => {
  const secondSwitch = (t) => findAll(t, (n) => n.type === 'input' && n.props.className === 'dsh-wb-switch')[1];
  const app = await boot({ scopeValue: { enabled: false, model: '', effort: '' } });
  app.expand();
  app.flushEffects();
  await settle();
  let tree = app.expand();
  assert.equal(secondSwitch(tree).props.checked, true, '★ 老快照无该键 ⇒ 按默认开显示（与宿主默认值一致）');
  assert.equal(secondSwitch(tree).props.disabled, false);
  secondSwitch(tree).props.onChange(); // 用户关闭
  await settle();
  assert.deepEqual(app.scope.commits[0], { op: 'set', field: 'enableAutoCheckin', value: false });
  tree = app.expand();
  assert.equal(secondSwitch(tree).props.checked, false, '写后 bridge 应反映新值');
  secondSwitch(tree).props.onChange(); // 再打开
  await settle();
  assert.deepEqual(app.scope.commits[1], { op: 'set', field: 'enableAutoCheckin', value: true });
});

test('功能①（d）倍率回声剔除：真 payload 的 detail 本身就是倍率文本 ⇒ 只印一份（不得说两遍）', async () => {
  // ★ 真机实测缺陷（2026-10-01）：宿主下发的 `models[].detail` 形如 `"x2.00 credits"` —— 它**就是**倍率文本，
  //   只不过来自展示目录（小数位固定两位）。而倍率的权威来源是 `cost.models[].factor`。
  //   两者叠加会印成 `Default（x2.00 credits）（x2）`：同一件事说两遍，且两遍数字写法不同
  //   （`2.00` vs `2`）—— 读者会以为是两个不同的数。修法是判"整串即倍率"⇒ 视为回声，丢弃 detail。
  const CATALOG_ECHO = [
    { id: 'echo1', label: 'Echo One', detail: 'x2.00 credits', isFree: false },
    { id: 'echo2', label: 'Echo Two', detail: 'x0.16 credits', isFree: false },
  ];
  const COST_ECHO = { models: [{ modelId: 'echo1', factor: 2 }, { modelId: 'echo2', factor: 0.16 }] };
  const app = await bootFromStatus({ models: CATALOG_ECHO, cost: COST_ECHO });
  const tree = app.expand();
  assert.equal(optionText(tree, 'echo1'), 'Echo One（x2）', '★ 回声被剔掉 ⇒ 只印权威倍率一份（不是 x2.00 + x2 两份）');
  assert.equal(optionText(tree, 'echo2'), 'Echo Two（x0.16）', '★ 同上');
  assert.ok(optionText(tree, 'echo1').includes('x2.00') === false, '★★ 展示目录的格式化写法（x2.00）不得残留');

  // 负控：`10x` 这类**不是**回声的 detail 必须保留 —— 它携带别处拿不到的信息，误杀会让目录信息静默消失。
  const CATALOG_NOT_ECHO = [
    { id: 'plain1', label: 'Plain One', detail: '10x', isFree: false },
    { id: 'plain2', label: 'Plain Two', detail: '上下文 1M', isFree: false },
    { id: 'plain3', label: 'Plain Three', detail: '', isFree: false },
  ];
  const app2 = await bootFromStatus({ models: CATALOG_NOT_ECHO, cost: { models: [] } });
  const tree2 = app2.expand();
  assert.equal(optionText(tree2, 'plain1'), 'Plain One · 10x（倍率未知）', '★ 非回声 detail 必须保留（10x 不是倍率写法）');
  assert.equal(optionText(tree2, 'plain2'), 'Plain Two · 上下文 1M（倍率未知）', '★ 中文 detail 同样保留');
  assert.equal(optionText(tree2, 'plain3'), 'Plain Three（倍率未知）', '★ 空 detail 不产生空括号');
});

// ───────────── 信息层次（2026-10-02，四块布局；措辞与判定一律未动） ─────────────
// 这组只锁**版式**：谁排在前面、哪一块是"大字"、收起态剩几行。
// 它与上面那组"诚实性"断言是互补的：措辞对了但排成等权灰字，用户照样找不到自己要的数。

/** 余额块（外层容器）的 className —— 语气修饰类挂在这里。 */
function creditsBlock(tree) {
  const node = findAll(
    tree,
    (n) => n.props && typeof n.props.className === 'string' && String(n.props.className).split(' ')[0] === 'dsh-wb-credits',
  )[0];
  assert.ok(node !== undefined, '余额块（dsh-wb-credits）必须渲染');
  return String(node.props.className);
}

/**
 * 卡片内容区里按文档顺序取各段的 className 索引（collect/findAll 本就是前序遍历 ⇒ 下标即顺序）。
 * ★ 2026-10-02：四段为 任务 → 配置 → 状态（含余额块） → 操作。
 */
function segmentOrder(tree) {
  const ordered = findAll(tree, (n) => n.props && typeof n.props.className === 'string');
  const at = (name) => ordered.findIndex((n) => String(n.props.className).split(' ').includes(name));
  return { task: at('dsh-wb-task'), credits: at('dsh-wb-credits'), controls: at('dsh-wb-group'), status: at('dsh-wb-card__status'), actions: at('dsh-wb-card__actions') };
}

/**
 * 元素节点的**直接子元素节点**（展平一层）。
 *
 * ⚠️ 伪 createElement 是 `(type, props, ...children)` —— 传数组时 `children` 变成 `[[a, b]]` 而不是
 *   `[a, b]`（真 React 会展平，伪实现不展平）。所以凡是数子节点/判包含，都必须先展平，
 *   否则会得出"标题区只有一行"这种**假阴性**（正控就是被这个坑绊倒的）。
 */
function childNodes(node) {
  const raw = Array.isArray(node && node.children) ? node.children : [];
  return raw.flat(Infinity).filter((c) => c !== null && typeof c === 'object');
}

test('信息层次：展开态四段依次为 任务 → 配置 → 状态（含余额） → 操作（等权行堆叠 ⇒ 用户找不到自己要的数）', async () => {
  const app = await bootFromStatus({});
  const order = segmentOrder(app.expand());
  assert.ok(order.task >= 0, '任务块必须存在');
  assert.ok(order.credits >= 0, '余额块必须存在');
  assert.ok(order.controls >= 0, '配置组必须存在');
  assert.ok(order.status >= 0, '状态区必须存在');
  assert.ok(order.actions >= 0, '操作区必须存在');
  assert.ok(
    order.task < order.controls && order.controls < order.status && order.status < order.actions,
    `★ 四段顺序错（任务 ${order.task} / 配置 ${order.controls} / 状态 ${order.status} / 操作 ${order.actions}）`,
  );
  assert.ok(
    order.status < order.credits && order.credits < order.actions,
    `★ 余额块必须在状态区内、操作区之前（状态 ${order.status} / 余额 ${order.credits} / 操作 ${order.actions}）`,
  );
});

test('信息层次：「刷新状态」必须排在状态区之后（它只重拉状态内容，原先吊在顶上像整卡按钮）', async () => {
  const app = await bootFromStatus({});
  const tree = app.expand();
  const order = segmentOrder(tree);
  assert.ok(order.actions > order.status, '★ 操作区排在状态区之后');
  // 负控（排除"因为操作区根本没渲染"这种空转）：按钮本体仍在，且就在操作区里。
  const button = findAll(tree, (n) => n.type === 'button' && n.props.className === 'dsh-wb-card__refresh')[0];
  assert.ok(button !== undefined, '刷新按钮必须仍可渲染');
  assert.equal(
    childNodes(findAll(tree, (n) => n.props && n.props.className === 'dsh-wb-card__actions')[0]).includes(button),
    true,
    '刷新按钮必须在操作区容器内（不是游离的）',
  );
});

test('余额语气（突出由**排版**承担，措辞不动）：实时⇒value / 旧读数⇒stale / 读不到⇒note', async () => {
  // ★ 判别点：三种语气都还印同一句文案，差别只在 className。
  //   所以这条同时钉住两件事 —— 读得到就得突出；**读不到绝不能被排成大字**（那是把"我不知道"
  //   排版成"这里有个重要结论"，与"不得谎报 0"是同一条底线的两种表现）。
  const live = await bootFromStatus({ credits: { ok: true, source: 'live', remain: 12, ageMs: 1_000, stale: false, unit: 'credits' } });
  assert.ok(creditsBlock(live.expand()).includes('dsh-wb-credits--value'), '★ 读到实时数 ⇒ 大字语气');

  const stale = await bootFromStatus({ credits: { ok: true, source: 'live', remain: 12, ageMs: 90_000, stale: true, unit: 'credits' } });
  assert.ok(creditsBlock(stale.expand()).includes('dsh-wb-credits--stale'), '★ 旧读数 ⇒ 仍是数字，但降一档字色');

  for (const [label, credits] of [
    ['读不到（ok=false）', { ok: false, source: 'unavailable', remain: null, ageMs: null, stale: true, unit: null, error: { code: 'x', message: 'y' } }],
    ['无值（remain 非数）', { ok: true, source: 'live', ageMs: 1_000, stale: false, unit: 'credits' }],
  ]) {
    const app = await bootFromStatus({ credits });
    assert.ok(
      creditsBlock(app.expand()).includes('dsh-wb-credits--note'),
      `★★ ${label} ⇒ 必须回落到诊断区的排版，不得占大字位`,
    );
  }
});

test('收纳：收起态只留一行摘要 —— 描述行不占位、三值摘要进标题行、内容区消失', async () => {
  const app = await bootFromStatus({}, { scopeValue: { enabled: true, model: 'm2', effort: '' } });
  const expanded = app.expand();
  const headExpanded = findAll(expanded, (n) => n.props && n.props.className === 'dsh-wb-card__head-text')[0];
  assert.equal(
    childNodes(headExpanded).length,
    2,
    '正控：展开态标题区是「标题行 + 描述行」两行（本条若恒绿即为空转）',
  );
  // ★ 展开态**不**带摘要：模型与强度就在下面的下拉里、积分就在状态块里，头部再抄一遍等于同一件事在屏幕上出现两次。
  assert.equal(
    findAll(expanded, (n) => n.props && typeof n.props.className === 'string' && n.props.className.includes('dsh-wb-card__summary')).length,
    0,
    '★ 展开态不渲染摘要（收起态专用，避免与正文重复）',
  );

  const toggle = findAll(expanded, (n) => n.type === 'button' && n.props.className === 'dsh-wb-card__toggle')[0];
  toggle.props.onClick();
  const collapsed = app.render();
  const text = textOf(collapsed);

  const head = findAll(collapsed, (n) => n.props && n.props.className === 'dsh-wb-card__head-text')[0];
  assert.equal(
    childNodes(head).length,
    1,
    '★ 收起态标题区只剩一行（描述行不占位）',
  );
  assert.equal(text.includes('在这里选 WorkBuddy 的模型、看剩余积分'), false, '★ 收起态不印描述行');
  assert.equal(
    findAll(collapsed, (n) => n.props && n.props.className === 'dsh-wb-card__body').length,
    0,
    '内容区仍然消失',
  );
  assert.ok(text.includes('● 开启'), '★ 徽标仍在（能不能跑是收起时最该看到的一件事）');
  // ★ 三值摘要：当前模型 · 推理强度 · 剩余积分。
  assert.deepEqual(
    summaryItems(collapsed),
    ['Model Two', '未指定', '987.47 积分'],
    '★ 收起态摘要必须是三值（模型 label · 强度 · 积分），且模型显示目录 label 不是机器 id',
  );
});

test('收纳：摘要里的模型取不到目录项时**不显示该值**（不得把机器 id 当文案印上卡）', async () => {
  // ★ 与 enumText 的"未知兜底"同一纪律：设置里存着一个目录已经没有的 id（桌面端下架/换了模型名）时，
  //   摘要宁可少一个值 —— 印出来的是 `ghost-model-7` 这种既看不懂、又会被截图传播的标识符。
  const app = await bootFromStatus({}, { scopeValue: { enabled: true, model: 'ghost-model-7', effort: '' } });
  const toggle = findAll(app.expand(), (n) => n.type === 'button' && n.props.className === 'dsh-wb-card__toggle')[0];
  toggle.props.onClick();
  const collapsed = app.render();
  assert.equal(textOf(collapsed).includes('ghost-model-7'), false, '★ 机器 id 不得上屏（含折叠外的任何位置）');
  assert.deepEqual(
    summaryItems(collapsed),
    ['未指定', '987.47 积分'],
    '★ 取不到目录 label ⇒ 模型值不渲染（摘要剩强度与积分两值，而不是渲染一个空占位）',
  );
});

test('收纳：模型未固定 ⇒ 摘要模型值显示"未固定"（不是留空让人以为卡片坏了）', async () => {
  const app = await bootFromStatus({}, { scopeValue: { enabled: true, model: '', effort: '' } });
  const toggle = findAll(app.expand(), (n) => n.type === 'button' && n.props.className === 'dsh-wb-card__toggle')[0];
  toggle.props.onClick();
  assert.deepEqual(
    summaryItems(app.render()),
    ['未固定（每次用时现选）', '未指定', '987.47 积分'],
    '★ 未固定也是一种状态，必须说出来（三值一个不少）',
  );
});

test('收纳：积分读不到 ⇒ 摘要不占位（"读不到"不是摘要，留空比写"读取中"诚实）', async () => {
  const app = await bootFromStatus(
    { credits: { ok: false, source: 'unavailable', remain: null, ageMs: null, stale: true, unit: null, error: { code: 'x', message: 'y' } } },
    { scopeValue: { enabled: true, model: 'm2', effort: 'high' } },
  );
  const toggle = findAll(app.expand(), (n) => n.type === 'button' && n.props.className === 'dsh-wb-card__toggle')[0];
  toggle.props.onClick();
  assert.deepEqual(
    summaryItems(app.render()),
    ['Model Two', 'high'],
    '★ 积分读不到 ⇒ 摘要只剩两值（不把"读不到"排成摘要结论）',
  );
});

test('CSS token 纪律：不得引用宿主**不存在**的别名（不存在的名字会让整条样式永远落硬编码色）', async () => {
  // ★ 实测缺陷（2026-10-03）：`--dsw-alias-state-warning-primary` 在宿主 token 表里**不存在**
  //   （真名 `--dsw-alias-state-warn-primary`，见本机 app.asar）。`var(不存在, #c98a00)` 不会报错，
  //   它安静地用 fallback —— 于是警告色与降级徽标一直是硬编码琥珀，深浅色主题都跟着错。
  //   这类缺陷没有任何运行时信号，只能在产物层断言。
  const documentFake = makeFakeDocument();
  await withBundle({ document: documentFake }, async (registration) => {
    const { fakeRequire } = makeRequire(makeFakeReact().React);
    registration.factory(fakeRequire);
    const css = documentFake.created[0].textContent;
    assert.equal(css.includes('--dsw-alias-state-warning-primary'), false, '★ 不得引用不存在的别名（会静默落硬编码色）');
    assert.ok(css.includes('--dsw-alias-state-warn-primary'), '警告色走真名 token');
    assert.ok(css.includes('--dsw-alias-switch-thumb'), '开关拇指走 token（深色主题下不该是纯白）');
  });
});
