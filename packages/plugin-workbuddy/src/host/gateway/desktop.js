/**
 * 目标实例（WorkBuddy 桌面端）：**在不在 → 要不要起 → 起了没**。
 *
 * <p>★★★ 为什么这是下发链路的第 0 站（2026-09-30 真机取证）★★★
 *
 * <p>插件能连上的那个"网关"，从来不是自己起的进程，而是**桌面端为某条对话拉起来的 sidecar**。
 * 真机证据链（`~/.workbuddy/logs/2026-09-30/`）：
 * <pre>
 *   WorkBuddy__a85776a06….log:67  [PrewarmServer] activate: no deltaEnv
 *   WorkBuddy__a85776a06….log:68  [CredentialBootstrap] CBC prewarm receiver
 *        {…"cbcPid":3048,"parentPid":27584,"receiverOutcome":"fallback",
 *         "runtimeStatus":"unavailable","wholeFileProtectionReady":false,
 *         "reason":"transport-error","configured":true,
 *         "runtimeUnavailableCategory":"transport"}
 *   WorkBuddy__a85776a06….log:69  [CredentialProtection] prewarm bootstrap rejected:
 *        WorkBuddy prewarm credential bootstrap failed
 * </pre>
 * ⇒ 桌面端**自己**在 18:10 / 18:15 / 18:23 / 18:24 / 18:32 连续 5 次拉 sidecar 全部失败，
 *   失败点在**凭据引导的传输层**（父进程 27584 的凭据运行时不可达），不是模型、不是权限、不是网络。
 *   这解释了本模块存在的意义：**"要不要启动"这个判断本身，必须能和"启动了也没用"区分开**，
 *   否则每次都只能给用户一句"请打开 WorkBuddy 桌面端"——而桌面端当时明明开着。
 *
 * <p>★ 诚实边界（本模块**不**越过的三条）：
 *   1. **不**代替桌面端注入凭据：登录态在桌面进程内，凭据引导走父子 IPC，我们复现不了也不该复现；
 *   2. **不**把"我拉起了 WorkBuddy.exe"说成"任务可跑了"——拉起成功只推进到 `started`，
 *      真正的验收是 sidecar 出现并握手成功（`ensure.js` 负责）；
 *   3. **不**重启用户已开的桌面端：`isDesktopRunning` 为真时本模块一个字节都不写。
 *
 * <p>就绪信号为什么用 broker 端点文件：真机 18:00:13 进程起来、18:00:15 `endpoint.json` 落盘
 *   （`connectWbipc` 顺带会认它，见 `wbipc.js`），这是**唯一**一个"桌面端已完成启动"的可读信号 ——
 *   进程在的那 2 秒里它什么都还答不上。
 *
 * <p>★★★ 但"文件在"**不等于**"这次启动完成了"（★ 2026-09-30 对抗审查实测复现）★★★
 * `wbipc.js:58` 记着一条真机事实：`endpoint.json` 在桌面退出时**不删**、重启时**滞后异步重写**。
 * 于是"用户昨天开过、今天关着跑任务"这个**最常见**的局面下：
 * <pre>
 *   tasklist 看不到进程 → autoStart 拉起 → 进程刚可见 → 上一轮残留的 endpoint.json 还在
 *     ⇒ 立刻 ready:true，冷启动窗口（DEFAULT_READY_TIMEOUT_MS）被跳到第一轮轮询
 *     ⇒ 报告里落一句**假的** "broker endpoint present"
 * </pre>
 *  ⇒ 就绪判定必须带**新鲜度**：`notBeforeMs`（= 拉起那一刻）之前写的端点不算数。
 *     ★ 只**读**这个文件（`stat`），**一个字节都不写** —— 它归桌面端所有。
 *
 * 约束：本文件属于 packages 下的 src（CI ② 扫描范围）—— 不得出现裸进程出口字面量。
 * @module host/gateway/desktop
 */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readEndpoint } from './wbipc.js';

/** 桌面端主程序镜像名（`tasklist /FI "IMAGENAME eq …"` 的判据）。 */
export const DESKTOP_IMAGE = 'WorkBuddy.exe';

/**
 * 桌面端可执行文件的已知安装位（env 变量 → 相对路径）。
 * 与 `probe/detect.js` 的 `DESKTOP_EXE_KNOWN_PATHS` 同构但**不同物**：
 * 那份做只读探测，这份找 Electron 主程序供拉起。
 * 找不到不是致命错误 —— 返回 `null`，上层改走"让用户自己起"。
 */
export const DESKTOP_KNOWN_PATHS = [
  { envs: ['ProgramFiles', 'ProgramW6432'], rel: 'WorkBuddy/WorkBuddy.exe' },
  { envs: ['ProgramFiles(x86)'], rel: 'WorkBuddy/WorkBuddy.exe' },
  { envs: ['LOCALAPPDATA'], rel: 'Programs/WorkBuddy/WorkBuddy.exe' },
];

/** 拉起后等待"进程在 + broker 端点落盘"的上限。Electron 冷启动实测 2s 起，留足冷盘/杀软余量。 */
export const DEFAULT_READY_TIMEOUT_MS = 90_000;

/**
 * 新鲜度判定的**容差**（ms）。
 *
 * <p>★ 为什么不能写成 `mtime >= launchT0` 就完事（★ 本机实测，2026-09-30）：
 *   墙钟与文件系统时间戳**不是同一把尺子**。同一次 `tmp/skew-probe.mjs` 量到
 *   `mtime - Date.now()` 的分布是 `[-0.960ms, +1.578ms]`，3000 次里 **203 次为负** ——
 *   也就是"紧接着 `Date.now()` 写下去的文件，有 7% 的概率 mtime 比那个 `Date.now()` 还早一点**。
 *   严格比较会把**本轮自己刚落盘**的端点判成陈旧，然后白等满 90s 再报 `desktop_not_ready`：
 *   那是一条**假阴性**，比修复前的假阳性更难查（用户会以为桌面端起不来）。
 * <p>2s ≫ 实测 1ms 的负偏，又远小于"上一轮残留"可能的年龄（桌面退出到下次拉起，秒级以上）；
 *   两条约束同时满足的窗口很宽，取 2s。
 */
export const ENDPOINT_FRESHNESS_SLACK_MS = 2_000;

/** 就绪轮询间隔。真机上端点在进程起来后约 2s 出现，500ms 足够密又不至于把 CPU 跑满。 */
export const DEFAULT_POLL_MS = 500;

/**
 * broker 端点文件的**默认位**（`readEndpoint()` 不传参时用的那一个）。
 *
 * ★ 这里必须知道路径，是因为新鲜度要读 `mtime`，而 `wbipc.js` 只把**内容**交出来。
 *   两处各写一份路径常量、升级时必漂一处 —— 所以这条不是"顺手抄一下"：
 *   `test/gateway-instance-ensure.test.js` 里"默认位必须与 wbipc 同位"那条把它钉住了，
 *   谁改了一边而没改另一边，那条会转红。
 */
const defaultEndpointFile = () => join(homedir(), '.workbuddy', 'wbipc', 'endpoint.json');

/** 纯读：文件的最后修改时间（epoch ms）。读不到（不存在/无权限）一律 `null`，不抛。 */
function mtimeOf(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/** 纯读判定：路径存在且为文件。异常（含拒绝访问）一律记 false，不抛。 */
function isReadonlyFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * 解析 `tasklist /NH /FO CSV` 的输出，取指定镜像名的 pid 列表。
 *
 * <p>★ 为什么用 CSV + `/NH` 而不是抓表头对齐的固定列：Windows 的 `tasklist` 列数/列名随
 *   "映像名称 / Image name" 语言不同而变，**固定列解析在中文版上整条失配**。CSV 行首固定带引号，
 *   字段数稳定（映像名, PID, 会话名, 会话号, 内存），且不匹配时输出是本地化的
 *   `INFO: No tasks are running which match the specified criteria.`（英文/中文都不含 `"` + 数字的形态）
 *   —— **正例可精确认、负例自然落空**，不需要识别任何一句提示文案。
 *
 * @param {string} text
 * @param {string} [image]
 * @returns {number[]} 升序、去重的 pid
 */
export function parseTasklistPids(text, image = DESKTOP_IMAGE) {
  const want = image.toLowerCase();
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith('"')) continue;           // 表头/INFO 行一律跳过（不猜本地化文案）
    const cols = s.split('","').map((c) => c.replace(/^"|"$/g, '').trim());
    if (cols.length < 2) continue;
    if (cols[0].toLowerCase() !== want) continue;
    const pid = Number(cols[1]);
    if (Number.isInteger(pid) && pid > 0) out.push(pid);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * 枚举桌面端可执行文件路径（纯读，不启动）。
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{path: string, source: string}|null}
 */
export function findDesktopExe(env = process.env) {
  const seen = new Set();
  for (const tpl of DESKTOP_KNOWN_PATHS) {
    let base = null;
    for (const name of tpl.envs) {
      const v = env[name];
      if (typeof v === 'string' && v !== '') { base = v; break; }
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
 * 桌面端在不在（只看进程，不改任何东西）。
 *
 * <p>★ 进程枚举失败（`tasklist` 不可用/被策略挡）与"确实没在跑"**必须分开**：
 *   两者都返回 `running:false` 会让上层去拉起一个已经开着的桌面端（多开实例 = 抢同一个
 *   凭据运行时，正是 `WorkBuddy__a85776a06….log:68` 那类失败的高发场景）。
 *
 * @param {{run: (spec: {argv: string[]}) => Promise<string>}} deps
 * @param {{image?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<{running: boolean, pids: number[], error: string|null}>}
 */
export async function isDesktopRunning({ run }, opts = {}) {
  const image = opts.image ?? DESKTOP_IMAGE;
  try {
    const text = await run({ argv: ['tasklist', '/FI', `IMAGENAME eq ${image}`, '/NH', '/FO', 'CSV'] });
    const pids = parseTasklistPids(text, image);
    return { running: pids.length > 0, pids, error: null };
  } catch (e) {
    return { running: false, pids: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * broker 端点是否已落盘（= 桌面端启动完成）。
 *
 * <p>★ 复用 `wbipc.js` 的 `readEndpoint`，不自己拼路径：那个默认路径已经被积分链路验过，
 *   两处各写一份路径常量，升级时必漂一处。
 *
 * <p>★★ `notBeforeMs`：**新鲜度**闸门（★ 见模块头 ★）
 *   传了它，"这一轮拉起之前写下的 `endpoint.json`"一律判 `ready:false`。
 *   这是"上一轮残留"与"本轮桌面端刚落盘"之间**唯一**能免开眼的差别，而它们在内容上**逐字节同形**。
 *
 * @param {{endpointFile?: string, notBeforeMs?: number}} [opts]
 *   `notBeforeMs` 取**真实墙钟**（`Date.now()`）—— 它要和文件系统的 mtime 同一把尺子；
 *   测试里那个注入的假时钟与 mtime 不同源，拿来比大小没有意义。
 * @returns {Promise<{ready: boolean, detail: string|null, stale: boolean}>}
 */
export async function isBrokerReady(opts = {}) {
  const given = typeof opts.endpointFile === 'string' ? opts.endpointFile : undefined;
  try {
    const ep = await readEndpoint(given);
    // ★ 这里**只有**一个失败理由：读不出 / 解析不出 / endpoint 或 ticket 为空。
    //   `readEndpoint()` 已经把那几种都归一成 `null`（`wbipc.js:123-125`），
    //   所以本函数**不再**自己复述一遍"有没有 endpoint"—— 那会是一段走不到的死代码，
    //   看上去像一道校验、实际什么也没验（同 `DEFAULT_READY_TIMEOUT_MS` 曾经的毛病）。
    if (!ep) return { ready: false, detail: 'endpoint.json unreadable or incomplete', stale: false };
    // ★ 新鲜度：**只 stat，不写**。文件归桌面端所有。
    //   比较带 `ENDPOINT_FRESHNESS_SLACK_MS` 容差（墙钟与文件时间戳不同源，见常量处的实测）。
    const notBefore = Number(opts.notBeforeMs);
    if (Number.isFinite(notBefore) && notBefore > 0) {
      const mtime = mtimeOf(given ?? defaultEndpointFile());
      if (mtime === null) return { ready: false, detail: 'endpoint.json mtime unreadable', stale: false };
      if (mtime + ENDPOINT_FRESHNESS_SLACK_MS < notBefore) {
        return { ready: false, detail: 'endpoint.json predates this launch (stale)', stale: true };
      }
    }
    return { ready: true, detail: null, stale: false };
  } catch (e) {
    return { ready: false, detail: e instanceof Error ? e.message : String(e), stale: false };
  }
}

/**
 * 拉起桌面端（**一次性**，不等待退出）。
 *
 * <p>★ 为什么不复用 `makeSeamRunner`：那个 runner 的契约是"跑完拿 stdout"，
 *   而 `WorkBuddy.exe` 是常驻 GUI —— 等它退出等于永远等不到。Electron 冷启动还会 fork 出
 *   一串子进程，`graceMs`/drain 那套在"父进程一直活着"时毫无意义。
 *
 * <p>★ 为什么不 `detached`：本地 seam 在 win32 上把 `detached` 写死为 false
 *   （`dsh-subprocess-local/lib/runner-launch-*.js:1037`），且该 seam 不建 Job Object ——
 *   实测无 `KILL_ON_JOB_CLOSE` 一类父死子亡机制 ⇒ dsh 退出后桌面端继续存活，符合"启动它"的语义。
 *
 * @param {{launcher: (spec: {argv: string[]}) => {done?: Promise<any>}}} deps
 *   `launcher` 由 `apply.js` 接官方 seam（`ctx.subprocess.spawn`）构造后**作为依赖注入** ——
 *   本模块只认这个依赖，不自己触碰任何进程出口（CI ② 只放行点前缀形态）。
 * @param {{exe: string, image?: string}} args
 * @returns {Promise<{started: boolean, pid: number|null, error: string|null}>}
 */
export async function launchDesktop({ launcher }, { exe, image = DESKTOP_IMAGE }) {
  try {
    const handle = launcher({ argv: [exe] });
    // ★ 只取 pid，**不 await 退出**；给 `done` 挂一个空 catch 防止"进程最终退出"变成未处理拒绝。
    void handle?.done?.catch?.(() => {});
    const pid = Number(handle?.pid);
    return { started: true, pid: Number.isInteger(pid) && pid > 0 ? pid : null, error: null };
  } catch (e) {
    return { started: false, pid: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 等待桌面端就绪（进程在 **且** broker 端点**本轮**落盘）。
 *
 * @param {object} deps `run`（进程枚举）+ 可注入的 `sleep`/`now`（测试不必真等）
 * @param {{timeoutMs?: number, pollMs?: number, image?: string, endpointFile?: string,
 *          notBeforeMs?: number, signal?: AbortSignal}} [opts]
 *   `notBeforeMs` = 本轮拉起那一刻（真实墙钟）；`signal` 让调用方的取消能**打断**这个轮询。
 * @returns {Promise<{ready: boolean, pids: number[], waitedMs: number, error: string|null,
 *                    lastDetail: string|null, aborted: boolean, stale: boolean}>}
 */
export async function waitForDesktop({ run, sleep, now }, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_READY_TIMEOUT_MS;
  const pollMs = Number.isFinite(opts.pollMs) && opts.pollMs > 0 ? opts.pollMs : DEFAULT_POLL_MS;
  const signal = opts.signal ?? null;
  const t0 = now();
  let lastDetail = null;
  let lastError = null;
  let lastPids = [];
  let sawStale = false;
  for (;;) {
    // ★ 取消必须在**每轮顶部**就认：等桌面端启动是这段里最长的一步（默认 90s），
    //   用户点了取消却还要再等这么久才拿到一句"桌面端没起来"——那是**把他刚取消的运行
    //   写成环境故障**，然后让他去看一个他刚刚亲手关掉的窗口。
    if (signal?.aborted) {
      return {
        ready: false, pids: lastPids, waitedMs: now() - t0, error: lastError,
        lastDetail, aborted: true, stale: sawStale,
      };
    }
    const proc = await isDesktopRunning({ run }, opts);
    if (proc.error !== null) lastError = proc.error;
    if (proc.pids.length > 0) lastPids = proc.pids;
    if (proc.running) {
      const broker = await isBrokerReady(opts);
      if (broker.ready) {
        return {
          ready: true, pids: proc.pids, waitedMs: now() - t0, error: null,
          lastDetail: null, aborted: false, stale: false,
        };
      }
      lastDetail = broker.detail;
      if (broker.stale) sawStale = true;
    }
    if (now() - t0 >= timeoutMs) {
      return {
        ready: false, pids: proc.pids, waitedMs: now() - t0, error: lastError,
        lastDetail, aborted: false, stale: sawStale,
      };
    }
    await sleep(pollMs);
  }
}
