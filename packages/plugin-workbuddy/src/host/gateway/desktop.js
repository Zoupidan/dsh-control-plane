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
 *   3. **不**重启用户已开的桌面端：本模块判定桌面端已经在跑时一个字节都不写。
 *
 * <p>就绪信号为什么用 broker 端点文件：真机 18:00:13 进程起来、18:00:15 `endpoint.json` 落盘
 *   （`connectWbipc` 顺带会认它，见 `wbipc.js`），这是**唯一**一个"桌面端已完成启动"的可读信号 ——
 *   进程在的那 2 秒里它什么都还答不上。
 *
 * <p>★★★ 但"文件在"**不等于**"这次启动完成了"（★ 2026-09-30 对抗审查实测复现）★★★
 * `wbipc.js:58` 记着一条真机事实：`endpoint.json` 在桌面退出时**不删**、重启时**滞后异步重写**。
 * 于是"用户昨天开过、今天关着跑任务"这个**最常见**的局面下：
 * <pre>
 *   端点文件是上一轮残留的 → 立刻 ready:true，冷启动窗口（DEFAULT_READY_TIMEOUT_MS）被跳到第一轮轮询
 *     ⇒ 报告里落一句**假的** "broker endpoint present"
 * </pre>
 *  ⇒ 就绪判定必须带**新鲜度**：`notBeforeMs`（= 拉起那一刻）之前写的端点不算数。
 *     ★ 只**读**这个文件（`stat`），**一个字节都不写** —— 它归桌面端所有。
 *
 * <p>★★★ 2026-10-10 P0 进程出口清理：`tasklist` 枚举已删，换成 broker 管道探针 ★★★★
 * 本模块原先靠 `tasklist /FI "IMAGENAME eq WorkBuddy.exe" /NH /FO CSV` 枚举进程来判断
 * "桌面端在不在"。那是**控制台进程**，Owner 硬约束（插件任何路径都不许拉起显/隐 Shell
 * 或控制台进程）下整体删除，连带 `parseTasklistPids` 一并删除。
 * <pre>
 *   删除前：tasklist 枚举 ⇒ running 三态（在跑 / 没跑 / 枚举失败）；枚举失败时**不**去拉起。
 *   删除后：broker 命名管道握手 ⇒ running 二态（连上 / 连不上），连不上的原因进 `error`。
 * </pre>
 * 这不是降级而是换了一把更准的尺子：tasklist 答"有没有这个进程"，管道握手答
 * "桌面端的 broker 此刻应不应答"—— 第 0 站要问的本来就是后者。而且 `endpoint.json`
 * 退出时不删（`wbipc.js:58`），只看文件存在与否会把残留端点读成"桌面端开着"。
 * 详见 {@link isDesktopRunning} 的注释。
 *
 * 约束：本文件属于 packages 下的 src（CI ② 扫描范围）—— 不得出现裸进程出口字面量。
 * @module host/gateway/desktop
 */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readEndpoint, connectWbipc } from './wbipc.js';

/**
 * 桌面端主程序镜像名。
 *
 * <p>★ 它**不再**是任何进程枚举的判据（`tasklist /FI "IMAGENAME eq …"` 已删）。
 *   现在只用于**回执里的自述字段**与"这就是我们要拉起的那个程序"的常量声明；
 *   "桌面端在不在"由 {@link isDesktopRunning} 的 broker 管道探针回答。
 */
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

/** 拉起后等待"broker 端点落盘"的上限。Electron 冷启动实测 2s 起，留足冷盘/杀软余量。 */
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
 * broker 管道连通性探测的超时（毫秒）。
 *
 * <p>★ 本地命名管道 + 一次 HMAC 握手，正常是几毫秒。给到 1.5s 是为了冷盘 / 杀软
 *   扫管道名的余量；再大就只会把 `ensure()` 的第 0 站拖长。
 */
export const BROKER_PROBE_TIMEOUT_MS = 1_500;

/**
 * 桌面端在不在 —— 只连 broker 命名管道，**不起任何进程**。
 *
 * <p>★★ 2026-10-10：判据从"列进程"换成"broker 管道连得上吗" ★★
 * 原实现起 `tasklist /FI "IMAGENAME eq WorkBuddy.exe" /NH /FO CSV` 枚举进程。
 * 那是控制台进程，Owner 硬约束（插件任何路径都不许拉起显/隐 Shell/控制台进程）下删除。
 * 换成的这个探针走的是 Owner 认可的**唯一合法通信通道**：`~/.workbuddy/wbipc/endpoint.json`
 * 里那个命名管道。连得上并完成 HMAC 握手 ⇒ 桌面端的 broker 此刻活着。
 *
 * <p>★ 为什么它比 tasklist 更好（不是仅仅"因为不能用进程"）：
 * <ul>
 *   <li>tasklist 答的是"有没有一个叫 WorkBuddy.exe 的进程"；管道握手答的是
 *       "桌面端的 broker 现在应不应答"—— 后者才是第 0 站真正要问的那一句。</li>
 *   <li>`endpoint.json` 在桌面退出时**不删**（`wbipc.js:58` 真机事实）。只看文件
 *       存在与否，会把"昨天留下的残留"读成"桌面端正开着"，于是 `autoStartDesktop`
 *       永远不触发；只看文件 + 管道连通性，残留端点会因管道 ENOENT 被正确判成"没在跑"。</li>
 *   <li>多开实例是 `desktop.js` 模块头记的头号禁忌（抢同一个凭据运行时）。管道连不上
 *       才去拉起 ⇒ 方向是安全的：宁可漏拉，也不多开。</li>
 * </ul>
 *
 * <p>★ 三种"连不上"分两档，**处置不同**（沿用 tasklist 时代"枚举失败 ≠ 没在跑"的纪律）：
 * <pre>
 *   管道 ENOENT / 文件读不到（WBIPC_MISS.ENDPOINT_GONE、DESKTOP_CLOSED）
 *       ⇒ `running: false` —— 确定的否定答案，可以走"要不要拉起"那一支。
 *   协议不信赖 / 握手超时 / 其它
 *       ⇒ `running: null` —— 判不出来。此时**不许**去拉起：多开一个实例
 *          会和已开的那一个抢同一个凭据运行时（头号禁忌）。走 DESKTOP_PROBE_FAILED。
 * </pre>
 *
 * @param {{endpointFile?: string, connect?: typeof import('node:net').connect}} [opts]
 *   `connect` 只为可测而开（测试注入假管道客户端，绝不碰真机）。
 * @returns {Promise<{running: boolean|null, error: string|null}>}
 */
export async function isDesktopRunning(opts = {}) {
  try {
    const s = await connectWbipc({
      timeoutMs: BROKER_PROBE_TIMEOUT_MS,
      ...(typeof opts.endpointFile === 'string' ? { endpointFile: opts.endpointFile } : {}),
      ...(typeof opts.connect === 'function' ? { connectImpl: opts.connect } : {}),
    });
    s.close();   // 只做活性探测，不占着会话
    return { running: true, error: null };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // `classifyConnectFailure` 已经把"管道不在了 / 桌面没开"翻成这两个码；
    // 别的（协议不信赖、超时）保持原样 ⇒ 判不出来。
    const KNOWN_DOWN = new Set(['wbipc_endpoint_gone', 'wbipc_desktop_closed']);
    const code = e !== null && typeof e === 'object' ? e.code : undefined;
    return { running: KNOWN_DOWN.has(code) ? false : null, error };
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
 * <p>★ 为什么不复用"跑完拿 stdout"的 runner：`WorkBuddy.exe` 是常驻 GUI ——
 *   等它退出等于永远等不到。Electron 冷启动还会 fork 出一串子进程，
 *   `graceMs`/drain 那套在"父进程一直活着"时毫无意义。
 *
 * <p>★ 为什么不 `detached`：本地 seam 在 win32 上把 `detached` 写死为 false
 *   （`dsh-subprocess-local/lib/runner-launch-*.js:1037`），且该 seam 不建 Job Object ——
 *   实测无 `KILL_ON_JOB_CLOSE` 一类父死子亡机制 ⇒ dsh 退出后桌面端继续存活，符合"启动它"的语义。
 *
 * <p>★ 这条是 2026-10-10 清理后**仅剩**的进程出口，且它是合法的：目标是 WorkBuddy
 *   桌面端 GUI 进程（Owner 认可的唯一通信通道宿主），不是 Shell、不是控制台、不是 CLI。
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
 * 等待桌面端就绪（broker 端点**本轮**落盘）。
 *
 * <p>★ 2026-10-10 起这里**不再**枚举进程：`waitForDesktop` 只管 broker 端点是否**本轮**落盘，
 *   "桌面端在不在"由 {@link isDesktopRunning} 的 broker 管道探针在 `ensure.js` 里先问一次。
 *   两件事分开问：管道探针答"活不活"，本函数答"这一轮启动走完了没"。
 *
 * @param {object} deps 可注入的 `sleep`/`now`（测试不必真等）
 * @param {{timeoutMs?: number, pollMs?: number, endpointFile?: string,
 *          notBeforeMs?: number, signal?: AbortSignal}} [opts]
 *   `notBeforeMs` = 本轮拉起那一刻（真实墙钟）；`signal` 让调用方的取消能**打断**这个轮询。
 * @returns {Promise<{ready: boolean, waitedMs: number, error: string|null,
 *                    lastDetail: string|null, aborted: boolean, stale: boolean}>}
 */
export async function waitForDesktop({ sleep, now }, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_READY_TIMEOUT_MS;
  const pollMs = Number.isFinite(opts.pollMs) && opts.pollMs > 0 ? opts.pollMs : DEFAULT_POLL_MS;
  const signal = opts.signal ?? null;
  const t0 = now();
  let lastDetail = null;
  let sawStale = false;
  for (;;) {
    // ★ 取消必须在**每轮顶部**就认：等桌面端启动是这段里最长的一步（默认 90s），
    //   用户点了取消却还要再等这么久才拿到一句"桌面端没起来"——那是**把他刚取消的运行
    //   写成环境故障**，然后让他去看一个他刚刚亲手关掉的窗口。
    if (signal?.aborted) {
      return {
        ready: false, waitedMs: now() - t0, error: null,
        lastDetail, aborted: true, stale: sawStale,
      };
    }
    const broker = await isBrokerReady(opts);
    if (broker.ready) {
      return {
        ready: true, waitedMs: now() - t0, error: null,
        lastDetail: null, aborted: false, stale: false,
      };
    }
    lastDetail = broker.detail;
    if (broker.stale) sawStale = true;
    if (now() - t0 >= timeoutMs) {
      return {
        ready: false, waitedMs: now() - t0, error: null,
        lastDetail, aborted: false, stale: sawStale,
      };
    }
    await sleep(pollMs);
  }
}
