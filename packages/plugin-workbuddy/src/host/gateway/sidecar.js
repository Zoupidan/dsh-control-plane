/**
 * Sidecar 发现：找到**一个可以安全接手**的 WorkBuddy 桌面端 sidecar。
 *
 * <p>背景：WorkBuddy 桌面端会为每个会话拉起一个 `codebuddy --serve --port 0` 的本机网关。
 * 真机上同时存在多个（本机实测 22620/65252 与 16080/63393），**其中可能有用户正在用的那个**。
 *
 * <p>★ 安全约束（真机踩过）：用户活会话的 `cwd` 是他的真实工程目录（本机 `D:\Box\交易知识库`）。
 * 往那个 sidecar 下发任务 = 抢占用户正在跑的会话、把结果混进他的对话。
 * 因此本模块**默认只认桌面端为宿主分配的 sidecar**（`cwd` 落在 `workbuddy-host-cli` 下的那些），
 * 且必须 `busy === false`。找不到就报"没有空闲 sidecar"，**绝不退而求其次去碰用户的会话**。
 *
 * <p>★ session 文件里**没有口令**（真机核对：只有 pid/url/sessionId/cwd/heartbeat），
 * 所以发现与取口令是两件事，见 `token.js`。
 *
 * @module host/gateway/sidecar
 */

import { readdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** 桌面端为宿主分配的 sidecar 目录名。真机 cwd 形如
 *  `C:\Users\<u>\AppData\Local\Temp\workbuddy-host-cli\__workbuddy_cli_host__-0-<hash>`。 */
const HOST_SESSION_DIR = 'workbuddy-host-cli';
/** ★ 这里**曾经**有个 120s 的心跳过期阈值，2026-09-28 删掉了。
 *
 * <p>删它的理由不是"阈值太大"，是**桌面端不再更新心跳**：5.6.2 拉起的条目，
 *   `lastHeartbeat` 只在 spawn 那一刻写一次就停住，而进程活着、网关正常应答。
 *   拿它当过滤条件，等于用一条**恒为真**的判据去否决唯一可用的目标。
 *   心跳年龄现在只作为诊断信息随条目带出（`heartbeatAgeMs`），不参与选择。 */
/** 探活超时。sidecar 是本机进程，1.5s 足够；慢吞吞只会让失败拖长每一次下发。 */
const PROBE_TIMEOUT_MS = 1500;

/**
 * 会话文件目录，**按优先级**排列。
 *
 * <p>★★ 2026-09-30 真机：CLI 2.147.0 把 session 文件搬到了 `~/.codebuddy/sessions`，
 *   且**带 `url`**；旧版桌面端写在 `~/.workbuddy/sessions`。两个目录都要扫，理由：
 *
 * <pre>
 * C:\Users\demo\.codebuddy\sessions\40076.json   ← 唯一活着的 sidecar 在这里
 *   { pid: 40076, kind: "daemon", url: "http://127.0.0.1:9527",
 *     configuredPort: 9527, version: "2.147.0", cwd: "…\dsh-control-plane" }
 *   进程活着、9527 在 LISTEN、`GET /` ⇒ 200。
 *
 * C:\Users\demo\.workbuddy\sessions\4304.json    ← 只扫旧目录时能看到的**唯一**一条
 *   { pid: 4304, kind: "interactive", lastHeartbeat: 1789772812335 }   （无 url，写于 09-19）
 *   pid 已被 Windows 回收给 TextInputHost.exe。
 * </pre>
 *
 * <p>旧逻辑只扫 `.workbuddy` ⇒ 真机上"唯一可用的目标"从未被看见，拿到的只有那条陈旧记录，
 *   于是报 `no_endpoint`（"重启桌面端会重新拉起带端点的 sidecar"）——
 *   而重启既不会删掉陈旧文件，也不会把 sidecar 搬回旧目录，**实测无效**。
 *
 * @param {string} [home]
 * @returns {string[]} `[~/.codebuddy/sessions, ~/.workbuddy/sessions]`
 */
export function sessionsDirs(home = homedir()) {
  return [
    join(home, '.codebuddy', 'sessions'),   // 当前（CLI 2.147.0+）
    join(home, '.workbuddy', 'sessions'),   // 旧版桌面端（保留兼容）
  ];
}

/**
 * @deprecated 用 {@link sessionsDirs}。保留此名只为不打断既有调用；它返回**首选**目录。
 * @returns {string} `~/.codebuddy/sessions`
 */
export function sessionsDir(home = homedir()) {
  return sessionsDirs(home)[0];
}

/**
 * 进程是否还活着。
 *
 * <p>★ **必须有**：session 文件是桌面端留下的**持久文件**，进程退出后不会删。真机核对
 *   （2026-09-28）：磁盘上 21 个 hostManaged 条目，**只有 1 个进程还活着**，其余 20 个
 *   是几天前就死掉的残留。不做活性过滤，后果是每一次下发现场都在对着 20 个不存在的进程
 *   各做一次"读进程内存" —— 每次都失败（口令取不到），而且那类系统调用最容易惊动杀软。
 *
 * <p>★ **EPERM 必须算"活着"**：`process.kill(pid, 0)` 在进程存在但我们无权打开时抛 EPERM。
 *   把 EPERM 当成"死了"，会静默丢掉用户**提权运行**的 sidecar —— 那恰恰是最不该被丢的那个。
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM/EACCES = 存在但没权限 ⇒ 仍然活着；ESCRH/ESRCH 之类才是真没了。
    const code = err?.code;
    return code === 'EPERM' || code === 'EACCES';
  }
}

/**
 * 纯解析：session 文件 → 候选条目。
 *
 * <p>★ 只认本机 loopback 的 http URL。`file:` / `ws:` / 非 127.0.0.1 的 host 一律丢弃：
 * 这份文件是**磁盘上的可写数据**，拿它去连非本机地址等于开了一条任人指路的后门。
 *
 * @param {unknown} raw `JSON.parse` 后的对象
 * @param {number} now 当前时间戳（注入以便测试）
 * @returns {null|{pid: number, url: string, sessionId: string|null, cwd: string,
 *   startedAt: number|null, heartbeatAgeMs: number|null, hostManaged: boolean, kind: string|null}}
 */
export function parseSessionEntry(raw, now) {
  if (raw === null || typeof raw !== 'object') return null;
  const { pid, url, startedAt, lastHeartbeat, cwd, sessionId, kind } = raw;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  // ★ 5.6.2 起 url 字段可能整个不存在（见 portmap.js 的实测），所以缺 url **不再丢弃条目**：
  //   老逻辑在这里就把它扔了，于是"桌面端明明活着、网关明明在监听"却报"一个可用 sidecar 都没有"。
  //   有 url 时仍按老规矩严查本机 loopback —— 那份文件是磁盘上的可写数据。
  let normalized = null;
  if (typeof url === 'string') {
    let u;
    try { u = new URL(url); } catch { return null; }
    if (u.protocol !== 'http:') return null;
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost' && u.hostname !== '[::1]') return null;
    normalized = `${u.protocol}//${u.host}`;
  }
  const dir = typeof cwd === 'string' ? cwd : '';
  return {
    pid,
    url: normalized,
    altUrls: [],
    sessionId: typeof sessionId === 'string' ? sessionId : null,
    cwd: dir,
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    heartbeatAgeMs: Number.isFinite(lastHeartbeat) ? Math.max(0, now - lastHeartbeat) : null,
    // 判定这条是不是给宿主用的：cwd 落在桌面端的 host-cli 目录下。
    // ★ 5.6.2 起这条命中不了新条目（真机：cwd 是安装目录或用户工程目录），所以它降级为
    //   排序偏好而非准入门槛，见 selectSidecar 的分层。
    hostManaged: dir.toLowerCase().includes(HOST_SESSION_DIR),
    kind: typeof kind === 'string' ? kind : null,
  };
}

/**
 * 端点反查：给缺 `url` 的条目按 pid 补上 HTTP 端点。
 *
 * <p>★ 一个 pid 可能同时监听多个本机端口，所以第一个进 `url`、其余进 `altUrls`，
 *   探活时逐个试（`probeEntry`）而不是随便挑一个。挑错端口会探到别人的服务上，
 *   症状还长得极像"桌面端没启动"。
 *
 * @param {ReturnType<typeof parseSessionEntry>[]} entries
 * @param {{resolvePorts: (pid: number) => Promise<number[]>}} deps
 * @returns {Promise<ReturnType<typeof parseSessionEntry>[]>}
 */
export async function resolveSidecarEndpoints(entries, { resolvePorts }) {
  const out = [];
  for (const e of entries) {
    if (e === null) continue;
    if (typeof e.url === 'string' && e.url !== '') { out.push(e); continue; }
    let ports = [];
    try { ports = await resolvePorts(e.pid); } catch { ports = []; }
    const urls = (Array.isArray(ports) ? ports : []).map((p) => `http://127.0.0.1:${p}`);
    out.push(urls.length === 0 ? { ...e, url: null, altUrls: [] } : { ...e, url: urls[0], altUrls: urls.slice(1) });
  }
  return out;
}

/**
 * "被拒选"这一类的不可用原因。**两处调用点共用**，免得文案与 code 各自漂移。
 *
 * <p>★ 单开一个 code，不并进 `no_endpoint`：并进去会让人去"重启桌面端"，
 *   而真相是"你把它拒了"。两种成因的处置完全不同，必须能分开报。
 *
 * @param {object[]} rejected 被拒的用户活会话条目
 * @returns {{code: 'interactive_blocked', detail: string}}
 */
const blockedByInteractive = (rejected) => ({
  code: 'interactive_blocked',
  detail: `发现了 ${rejected.length} 个用户活会话的 sidecar，按默认设置已拒选——`
    + '因为在没绑定对话之前，发给它的 ACP 指令只能落到你当前打开的那条上（见 RECON §6.5），'
    + '而 `session/new` 自己 new 出来的对话工作区又不受控（`cwd` 不生效）。'
    + '要下发，就在桌面端**新建**一条对话、选好工作区、保持打开，'
    + '再把它的 id 填进插件设置里的 boundSessionId。',
});

/**
 * 纯选择：从候选里挑一个**可以下发**的 sidecar。
 *
 * <p>★ 排序即优先级，理由写在注释里（这类"为什么是它"的判据不能只活在脑子里）：
 *   1. 用户活会话（`cwd` 是他的工程目录）**默认被拒**，理由见下方 `isUserSession`；
 *   2. 探过活且 `busy === false` 的最优先 —— `busy` 未知**不等于空闲**，
 *      未探到就当不可用，宁可少一次下发，也不能把任务塞进一个正在跑的会话里；
 *
 * @param {ReturnType<typeof parseSessionEntry>[]} entries
 * @param {{status?: (e: object) => Promise<{busy: boolean}|null>,
 *          allowInteractive?: boolean,
 *          recycled?: {pid: number, name: string}[],
 *          gone?: {pid: number}[]}} [opts]
 *   省略 `status` 时不探活，所有条目的 `busy` 均为 `null`（= 不可用），
 *   此时只在 `hostManaged` 且心跳新鲜的条目里按 pid 取最大（更新的那个）。
 *   ★ `allowInteractive` **缺省即拒**（见下方 `interactiveRejected`）。
 *   ★ `recycled` 是被身份核验滤掉的假 sidecar（见 identity.js），只为让结论说得准。
 * @returns {Promise<null|{entry: object, status: object|null}>} 选中的条目；无可用者 null
 */
export async function selectSidecar(entries, opts = {}) {
  const { status, onUnavailable } = opts;
  const poolOpts = { recycled: opts.recycled ?? [], gone: opts.gone ?? [] };
  // ★ 心跳**不再**当硬过滤。2026-09-28 实测：5.6.2 拉起的 sidecar，其 session 文件的
  //   `lastHeartbeat` 只在 spawn 那一刻写一次就再也不动（4 秒后文件 mtime 纹丝不动），
  //   而进程活着、`/api/v1/status` 正常应答。拿 120s 的心跳去否决它 = 把唯一能用的那条判死，
  //   症状还长得像"桌面端没启动"——把用户送去重启一个根本没坏的东西。
  //   活性交给 discoverSidecars 的 isPidAlive（进程在不在）和下面的 HTTP 探活（能不能用）。
  const alive = entries.filter((e) => e !== null);
  // ★ 端点已知的才算候选（端点由 resolveSidecarEndpoints 补齐）。
  const pool = alive.filter((e) => typeof e.url === 'string' && e.url !== '');
  if (pool.length === 0) {
    if (typeof onUnavailable === 'function') onUnavailable(summarizePool([], entries, poolOpts));
    return null;
  }

  // ═══ 拒选用户活会话（★ 2026-09-28，默认行为）══════════════════════════════
  // 实测：ACP 的 `session/new` 不新建会话，`cwd` 被忽略，任务落在
  // `/api/v1/status` 的 `activeSessionId` 上——而用户活会话的 activeSessionId
  // **就是用户打开着的那条会话**。⇒ 每次下发都把一条外来 prompt 插进他的对话，
  // 他的 agent 继续接手头的活。证据：RECON §6.5。
  //
  // ★ 判据是 `kind === 'interactive' && hostManaged !== true`，**不是**只看 kind：
  //   本机真机 fixture（version 2.147.0）里，那条**宿主分配**的 sidecar 写的也是
  //   `kind: "interactive"`，但它的 cwd 落在 workbuddy-host-cli 下 ⇒ hostManaged=true。
  //   只看 kind 会把宿主分配的那条一起杀掉（实测：会误杀，测试当场变红）。
  //   真正的分界是"这是不是某个**用户可见的活会话**"，而 cwd 已经判过这件事。
  //
  // ★ 为什么是**硬过滤**而不是降权（tier）：降权仍会在只剩它可选时选中，
  //   而"会污染别人的活会话"这件事不该在只剩一个候选时被自动决定。
  //   宁可报"不可用"，由人开开关。
  const allowInteractive = opts.allowInteractive === true;
  const isUserSession = (e) => e.kind === 'interactive' && e.hostManaged !== true;
  const rejected = pool.filter(isUserSession);
  const candidates = allowInteractive ? pool : pool.filter((e) => !isUserSession(e));
  if (candidates.length === 0) {
    if (typeof onUnavailable === 'function') onUnavailable(blockedByInteractive(rejected));
    return null;
  }

  const probed = [];
  for (const e of candidates) {
    if (status === undefined) break;
    // eslint-disable-next-line no-await-in-loop
    const st = await status(e);
    probed.push({ entry: e, status: st });
  }
  // ★ 判据是 `busy === false`（**不是** `busy !== true`）：后者会把 `{ busy: undefined }`
  //   这种"探到了但没读到字段"的响应算成空闲，正是上面那条"未知≠空闲"要防的反面。
  const ready = probed.filter((p) => p.status?.busy === false);
  if (ready.length > 0) {
    // ★ 排序即优先级：prewarm（预热池，没人在用）→ 老的 hostManaged → interactive
    //   （真机 5.6.2 只有这一类有 HTTP 端点，见 portmap.js）。同层再按 pid 取大（更新的那个）。
    ready.sort((a, b) => tierOf(a.entry) - tierOf(b.entry) || b.entry.pid - a.entry.pid);
    return ready[0];
  }
  if (probed.length > 0) {
    // ★ 选不出来时**说清是哪种选不出来**。几种成因的处置完全不同：
    //   等授权（去点对话框）/ 真在跑（等它完）/ 探活拿不到（重启桌面端）/ 被拒（开开关）。
    //   只报一句"没有空闲 sidecar"会把用户导向错误的那一个。
    //
    // ★ 顺序有讲究：**被拒要压过探不通**。真机（2026-09-28）——唯一带端点的
    //   三条全是用户活会话（全被拒），剩下两条宿主分配的是死进程（探不通）。
    //   此时若报"探不通 → 去重启桌面端"，会让人去重启一个没坏的东西，
    //   而真正能推进的只有"绑一条对话"。只要 `rejected` 非空，
    //   绑上就至少多一条可试的 ⇒ 它是更靠前的瓶颈。
    // ★ `!allowInteractive` 不可省，否则这条优先级会**反向咬人**（真机踩中，2026-09-28）：
    //   绑了对话（allowInteractive=true）时 `candidates === pool`，`rejected` 退化成 pool 的
    //   一个无关子集，而"探不通"是**完全独立**的故障。此时若仍按"被拒"归因，给出的处置
    //   是"去绑一条对话"——而对话早就绑好了，等于把人指向一个已经做完的动作，
    //   真正的故障（探不通）一个字都不提。
    if (!allowInteractive && rejected.length > 0 && probed.every((p) => p.status === null)) {
      if (typeof onUnavailable === 'function') onUnavailable(blockedByInteractive(rejected));
      return null;
    }
    if (typeof onUnavailable === 'function') onUnavailable(summarizePool(probed, entries, poolOpts));
    return null;   // 探过活但都不空闲 ⇒ 明确不可用
  }
  // 未探活（调用方没给 status）：退回分层最优的那条
  const sorted = [...pool].sort((a, b) => tierOf(a) - tierOf(b) || b.pid - a.pid);
  return { entry: sorted[0], status: null };
}

/**
 * 候选分层：数字越小越优先被选中。
 *
 * @param {{kind: string|null, hostManaged: boolean}} e
 * @returns {0|1|2|3}
 */
export function tierOf(e) {
  if (e?.kind === 'prewarm') return 0;      // 桌面端的预热池，不属于任何会话
  if (e?.hostManaged === true) return 1;     // 老版本的宿主托管 sidecar
  if (e?.kind === 'interactive') return 2;  // 用户打开着的会话（真机 5.6.2 只有这一类可用）
  return 3;
}

/**
 * 把"选不出 sidecar"归成可执行的一类原因。
 *
 * <p>★ 纯函数、零 IO —— 可直接单测。优先级**有讲究**：`waiting_for_permission`
 *   压在最前，因为它最容易被误判成"在跑，等一会儿就好"，而实际上**等多久都不动**。
 *
 * @param {{entry: object, status: object|null}[]} probed
 * @param {object[]} [all] 全部候选，用于回答"一个都没探到"的情形
 * @param {{recycled?: {pid: number, name: string}[], gone?: {pid: number}[]}} [opts]
 *   `recycled`：pid 仍被占用、但占着它的**不是** WorkBuddy 进程的条目（见 identity.js）。
 *   `gone`：pid **根本不存在**的条目（枚举成功且不在表里）。与 `recycled` 是两回事，
 *   处置文案也必须分开：前者是"那个号现在归别人"，后者是"什么都没有了，只剩文件"。
 * @returns {{code: 'no_desktop'|'no_endpoint'|'pid_recycled'|'pid_gone'|'waiting_permission'
 *            |'busy_running'|'probe_unreachable'|'token_unavailable', detail: string}}
 */
export function summarizePool(probed, all = [], opts = {}) {
  const recycled = Array.isArray(opts.recycled) ? opts.recycled : [];
  const gone = Array.isArray(opts.gone) ? opts.gone : [];
  const statuses = probed.map((p) => p.status);
  // ★ 构成必须**跟着结论一起说**。只报"某个成因"会掩盖池子的真实构成：
  //   2026-09-28 真机 —— 21 个 hostManaged 里 20 个是死进程留下的残留，
  //   结论却是 waiting_permission，于是把人送去点一个无关的对话框。
  //   成因只解释它**解释不了的那些条目**时，才加这句。
  const unreachable = statuses.filter((s) => s === null).length;
  const tail = unreachable === 0
    ? ''
    : `（另有 ${unreachable} 个探不通，多半是进程已退但 session 文件还在；它们不解释成因）。`;
  const waiting = statuses.filter((s) => s?.busy === true
    && String(s.runStatus ?? '').includes('permission'));
  if (waiting.length > 0) {
    return {
      code: 'waiting_permission',
      detail: `${waiting.length} 个 sidecar 卡在等待授权的对话框上（runStatus=waiting_for_permission）。`
        + '它不会自己恢复——去 WorkBuddy 桌面端把那个授权应答掉。' + tail,
    };
  }
  const busy = statuses.filter((s) => s?.busy === true);
  if (busy.length > 0) {
    const rs = [...new Set(busy.map((s) => String(s.runStatus ?? 'unknown')))].join('/');
    return { code: 'busy_running', detail: `${busy.length} 个 sidecar 正在跑（runStatus=${rs}），等它跑完即可。` };
  }
  // ★★ `token_unavailable` 的处置与上面**每一支都相反**（别去重启桌面端，别去点对话框），
  //   而它在真机上偏偏长得和 `probe_unreachable` 一模一样 —— 因为 status 的 catch 把它压成了 null
  //   （dispatch.js 已修）。所以这里按"探到的候选全都要不到口令"这一形态单独认领。
  //   判据用"占满全部非 null 候选"而不是"非空"：只要还有一条给出了**具体**成因
  //   （等授权/在跑），那条的处置更可执行，就该先说它。
  const noToken = statuses.filter((s) => s?.unavailable === 'token_unavailable').length;
  const reachable = statuses.filter((s) => s !== null).length;
  if (noToken > 0 && noToken === reachable) {
    return {
      code: 'token_unavailable',
      detail: `取不到网关口令（${noToken} 个 sidecar 全部失败），所以一条都没探活、也没下发。`
        + '口令只存在于 sidecar 进程的环境块里，插件靠只读助手进程去读。'
        + '读失败有**两种成因**，助手按各自的 stderr 区分，不要混为一谈：'
        + '「environment block unavailable（进程已退出或环境块读不到）」'
        + '对「<键名> is not set in pid N（读到了，只是这个 sidecar 没被注入口令）」。'
        + '★ 此前这条一律写成"需要与桌面端同等或更高的权限"，那是**没验证过的归因**：'
        + '本机非提权 shell 对 WorkBuddy 各进程的环境块读取是成功的，返回的是第二种（键不存在）。'
        + '另外——此刻这些 sidecar 确实是活着的（否则上面会先报 pid_gone / pid_recycled），'
        + '所以把 gatewayToken 填进插件设置**在这台机器上帮不上忙**：'
        + '要下发就得先有 sidecar，而不是先有口令。' + tail,
    };
  }
  // ★ 顺序有讲究：**先**判"一个都没探到"，**后**判"探到了但都拿不到"。

  //   反过来写时，`probed` 为空会掉进后者，被误报成"桌面端没就绪"，
  //   而真相是"压根没有可用的托管 sidecar"——两者的处置不同。
  if (probed.length === 0) {
    // ★ "一个都没探到"有两种**处置完全不同**的成因，必须分开报：
    //   连 sidecar 都没了 ⇒ 去启动桌面端；sidecar 在、只是解析不出端点 ⇒ 重启桌面端重新拉起。
    //   合成一句"桌面端没就绪"会把第二种情形里明明活着的进程说成没启动。
    const live = all.filter((e) => e !== null);
    if (live.length === 0) {
      // ★★ 单独认领"pid 被回收"。**别把它并进 no_desktop / no_endpoint**：
      //   这两种都让用户去重启桌面端，而回收来的 pid 重启**根本治不好** ——
      //   陈旧的 session 文件还在，pid 还会被别的系统进程占着。
      //   2026-09-29 真机：pid 4304 记着 interactive，实际是 TextInputHost.exe。
      // ★★ 2026-09-30 新增：进程**根本不存在**（枚举成功、不在 Win32_Process 表里）的残留条目。
      //   单独认领，不并进 `pid_recycled`，也不并进下面的 `no_desktop` ——
      //   因为真相是"这些记录指向的东西已经没了"，而 `no_desktop` 那句
      //   "没启动，或它拉起的进程都已退出"会让人以为是**桌面端**没开，从而去重启一个
      //   明明开着（7 个进程在跑）的桌面端。
      //   ★ 它过去根本没有机会走到这里：这些条目在 `isPidAlive` 与身份核验两层都被
      //   fail-open 放进了候选池，于是被当成"活着的 sidecar"去读进程环境，读不到，
      //   最终报成 `token_unavailable` + 一句"权限不够"（本机 2026-09-30 22:0x 实测）。
      //
      //   ★ 判在 `pid_recycled` **之前**：两种痕迹常常同时存在（本机就是 20868/31284 已死
      //   + 4304 被回收）。先报回收会只说其中一半，把"桌面端开着却没拉起任何 sidecar"
      //   这个真正的原因整个盖掉——那正是明天演示要看的那句话。
      if (gone.length > 0) {
        const pids = gone.map((g) => g.pid).join('、');
        const alsoRecycled = recycled.length > 0
          ? `（另有 ${recycled.length} 条记录的 pid 被 Windows 回收给了别的程序：`
            + `${recycled.map((r) => `${r.pid}→${r.name || '未知程序'}`).join('、')}——它们同样不是 sidecar。）`
          : '';
        return {
          code: 'pid_gone',
          detail: `sessions 目录里有 ${gone.length} 条记录，其进程已经不在了（pid ${pids}）——`
            + '它们是 sidecar 退出后残留的文件，不代表桌面端有问题。'
            + '★ 关键：此刻**没有任何存活的 sidecar**，所以取不到网关口令只是结果，不是原因'
            + '（真正的原因就是这个，而它过去一直被误报成一种权限问题）。'
            + '桌面端进程是在的，但**它现在没有拉起任何 sidecar**：'
            + 'sidecar 由桌面端按对话拉起，且它自己的预热池在引导凭据时失败过'
            + '（见桌面端日志 CredentialBootstrap transport-error）。'
            + '在桌面端里打开一次对话，桌面端就会拉起一个 sidecar，本插件即可下发。'
            + '注意：这一步**与插件设置里的 gatewayToken 无关**——现在压根没有 sidecar 可用。'
            + alsoRecycled,
        };
      }
      if (recycled.length > 0) {
        const who = recycled.map((r) => `${r.pid}→${r.name || '未知程序'}`).join('、');
        return {
          code: 'pid_recycled',
          detail: `sessions 目录里有 ${recycled.length} 条陈旧记录，它们的 pid 已被 Windows 回收给了别的程序`
            + `（${who}），所以它们不再是 sidecar。`
            + '这不影响使用，重启桌面端也解决不了——重启不会删掉这些文件。'
            + '真正的 sidecar 要等桌面端自己拉起（打开一次对话即可）。',
        };
      }
      return {
        code: 'no_desktop',
        detail: '没有存活的 sidecar：WorkBuddy 桌面端没启动，或它拉起的进程都已退出。',
      };
    }
    const noEndpoint = live.filter((e) => typeof e.url !== 'string' || e.url === '');
    if (noEndpoint.length === live.length) {
      return {
        code: 'no_endpoint',
        detail: `${live.length} 个 sidecar 进程还活着，但都解析不出 HTTP 端点：`
          + 'session 文件里没有 url，OS 端口表里也查不到它们的监听端口。'
          + '重启 WorkBuddy 桌面端会重新拉起带端点的 sidecar。',
      };
    }
    return {
      code: 'probe_unreachable',
      detail: 'sidecar 端点已知但状态接口探不通（多半是桌面端刚启动还没就绪）。稍后重试；'
        + '若持续不恢复，重启 WorkBuddy 桌面端。',
    };
  }
  const probedOk = statuses.filter((s) => s !== null);
  if (probedOk.length === 0) {
    return {
      code: 'probe_unreachable',
      detail: 'sidecar 心跳新鲜但状态接口探不通（多半是桌面端刚启动还没就绪）。稍后重试；'
        + '若持续不恢复，重启 WorkBuddy 桌面端。',
    };
  }
  return { code: 'probe_unreachable', detail: 'sidecar 均不满足可用条件。' };
}

/**
 * 读 `~/.codebuddy/sessions/*.json` 与 `~/.workbuddy/sessions/*.json`，解析成候选数组。
 *
 * <p>★ 单个文件坏了（写到一半、被占用、乱码）**跳过**而不是整轮失败——目录里可能有上百个
 * 历史条目，一个坏了不该让整次发现归零。
 *
 * <p>★ 单目录不存在也**跳过**（`continue`）而不是整轮返回空：新旧目录只会有一个存在，
 * 拿"旧目录没了"去否决"新目录里的活 sidecar"是同一个错的反面。
 *
 * @param {{dir?: string, dirs?: string[], now?: number, isPidAlive?: (pid: number) => boolean}} [opts]
 *   `dir` = **只扫这一个目录**（测试与注入用，保持既有语义）；给了它就忽略 `dirs`。
 *   `dirs` = 显式给多目录；缺省走 {@link sessionsDirs}（新旧两个目录都扫）。
 * @returns {ReturnType<typeof parseSessionEntry>[]}
 */
export function discoverSidecars(opts = {}) {
  // ★ `dir` 优先且独占：既有测试与 dispatch 的注入点都靠它，语义不能漂。
  const dirs = opts.dir !== undefined ? [opts.dir] : (opts.dirs ?? sessionsDirs());
  const now = opts.now ?? Date.now();
  const isPidAliveFn = opts.isPidAlive ?? isPidAlive;
  // ★ 按 pid 去重：同一条 sidecar 可能在新旧目录各留一份文件。
  const byPid = new Map();
  for (const dir of dirs) {
    let names;
    try { names = readdirSync(dir); } catch { continue; }   // 目录不存在 ⇒ 跳过，不抛
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      let raw;
      try { raw = JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch { continue; }
      const e = parseSessionEntry(raw, now);
      if (e === null || !isPidAliveFn(e.pid)) continue;
      const prev = byPid.get(e.pid);
      // ★ 同一 pid 两份文件时：**带 url 的胜出**，其次 startAt 更新的。
      //   反过来（让无 url 的旧残影盖掉新的）会把端点丢掉，症状与"桌面端没启动"一模一样。
      if (prev === undefined || prefersEntry(e, prev)) byPid.set(e.pid, e);
    }
  }
  return [...byPid.values()];
}

/**
 * 同一 pid 有两份 session 文件时谁胜出。
 *
 * <p>判据顺序：① 有 url（端点已知）> 无 url；② `startedAt` 新的 > 旧的。
 *
 * @param {ReturnType<typeof parseSessionEntry>} a
 * @param {ReturnType<typeof parseSessionEntry>} b
 * @returns {boolean} a 是否胜出
 */
function prefersEntry(a, b) {
  const hasUrl = (e) => (typeof e.url === 'string' && e.url !== '' ? 1 : 0);
  if (hasUrl(a) !== hasUrl(b)) return hasUrl(a) > hasUrl(b);
  return (a.startedAt ?? 0) > (b.startedAt ?? 0);
}

/**
 * 探一次 sidecar 状态。失败一律返回 null（不可用），不抛。
 *
 * <p>★ **必须带口令**：真机核对 —— `/api/v1/status` 在无 `Authorization` 时返回 **401**
 *   （它并不像 `/api/v1/auth/status` 那样免密）。踩过一次：无 token 探活恒得 null，
 *   于是"只有一个 sidecar 心跳新鲜"的机器上，选择器会把唯一的可用目标也筛掉，
 *   表现为"发现 21 个候选却一个都选不出来"。
 *
 * @param {string} url
 * @param {typeof fetch} [fetchImpl]
 * @param {string|null} [token] 网关口令。缺省时多数部署会 401 ⇒ 返回 null
 * @returns {Promise<{busy: boolean, runStatus: string|null}|null>}
 *   `runStatus` 透出 sidecar 自报的忙法（真机见过 `waiting_for_permission`）。
 *   ★ 不是装饰：`busy: true` 有两种**处置完全不同**的成因 ——
 *     正在跑（等它跑完即可）vs 卡在等授权（**去点那个授权**，等多久都不动）。
 *     丢了 runStatus，这两种在 UI 上会显示成同一句"没有空闲 sidecar"，
 *     用户只能去重启桌面端 —— 而那**修不好**一个没人应答的对话框。
 */
export async function probeStatus(url, fetchImpl = fetch, token = null) {
  try {
    const headers = { 'x-codebuddy-request': '1', accept: 'application/json' };
    if (typeof token === 'string' && token !== '') headers.authorization = `Bearer ${token}`;
    const r = await fetchImpl(`${url}/api/v1/status`, {
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const busy = j?.data?.busy ?? j?.busy;
    if (typeof busy !== 'boolean') return null;
    const runStatus = j?.data?.runStatus ?? j?.runStatus;
    return { busy, runStatus: typeof runStatus === 'string' ? runStatus : null };
  } catch {
    return null;
  }
}

/**
 * 探一个候选：**逐个端点试**，第一个答得上来的算它。
 *
 * <p>★ 为什么不能只探 `entry.url`：端点是从 OS 端口表反查的，而一个进程可能同时监听多个
 *   本机端口（网关 + 其它本地服务）。真机实测 26080 同时开着自己的管道与 HTTP 网关。
 *   只探第一个端口、探不通就判死，会把"选错端口"误报成"桌面端没启动"。
 *
 * @param {{url: string|null, altUrls?: string[]}} entry
 * @param {typeof fetch} [fetchImpl]
 * @param {string|null} [token]
 * @returns {Promise<{busy: boolean, runStatus: string|null}|null>}
 */
export async function probeEntry(entry, fetchImpl = fetch, token = null) {
  const urls = [entry?.url, ...(Array.isArray(entry?.altUrls) ? entry.altUrls : [])];
  for (const url of urls) {
    if (typeof url !== 'string' || url === '') continue;
    // eslint-disable-next-line no-await-in-loop
    const st = await probeStatus(url, fetchImpl, token);
    if (st !== null) return st;
  }
  return null;
}

/**
 * 探活用的 status 回调。
 *
 * @param {(e: object) => Promise<string|null>} [getToken] 逐候选取口令。
 *   ★ 这是"鸡生蛋"的解法：探活要口令，所以**按候选逐个取**（而不是先随便挑一个再探）。
 *   死候选的 `pid` 在心跳那一步已经被筛掉，不会白付一次跨进程读内存的代价。
 * @param {typeof fetch} [fetchImpl]
 */
export const statusProbe = (getToken, fetchImpl = fetch) => async (e) => {
  let token = null;
  if (typeof getToken === 'function') {
    try { token = await getToken(e); } catch { return null; }   // 取不到口令 ⇒ 不可用
  }
  return probeEntry(e, fetchImpl, token);
};

export { tmpdir };
