import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { POWERSHELL_CANDIDATES } from './token.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 进程清单查询助手的绝对路径（与 dispatch.js 的 HELPER_PATH 同一套定位方式）。 */
export const QUERY_PS1 = join(HERE, '..', '..', '..', 'assets', 'query-process-list.ps1');

/**
 * 进程身份核验：**session 文件里记的那个 pid，现在还是不是 WorkBuddy 自己的进程？**
 *
 * <p>★ 为什么要问这个问题（2026-09-29 真机实测，不是推断）：
 *   `~/.workbuddy/sessions/4304.json` 记着 `pid: 4304, kind: "interactive"`，
 *   该文件写于 2026-09-18。而 2026-09-29 查 pid 4304 拿到的是
 *   **`TextInputHost.exe`**（Windows 触摸键盘，创建于 2026-09-22）——
 *   **Windows 回收了这个进程号，并发给了别的程序**。
 *
 * <p>★ 危害不在"多探一次"，在**它把结论带歪**：旧发现逻辑只做 `isPidAlive(pid)`，
 *   那个回收来的 pid **确实活着**，于是被当成一个 sidecar 候选；它没有监听端口，
 *   于是报 `no_endpoint`，而那条文案让用户**去重启桌面端** ——
 *   但重启既不会删掉那个陈旧文件，也拦不住 pid 4304 被系统进程占着，
 *   **用户会被这条文案送进无限重启循环**。已实测：上一轮重启桌面端 ≥3 次，
 *   每次都回到同一个 `no_endpoint`。
 *
 * <p>★ 结论：`isPidAlive` 只能回答"这个进程号有没有人占着"，回答不了"占着的是不是它"。
 *   两者必须一起问。
 */

/**
 * 判定"这个进程像不像 WorkBuddy 自己拉起的 sidecar"。
 *
 * <p>★ 只认**命令行里带 workbuddy / codebuddy**的进程。理由见实测：
 *   桌面的常驻 worker（`daemon-app-server-entry.js`）与对话 sidecar 的命令行里
 *   都带 `codebuddy` / `WorkBuddy` 路径；而被回收给系统程序的那些
 *   （`TextInputHost.exe` 之类）不可能带这种串。
 *
 * <p>★ 不用可执行文件名判：sidecar 可能跑在 `node.exe` 上（带 codebuddy 的 .js 入口），
 *   而 `node.exe` 满机器都是，认它等于没认。
 *
 * @param {{name?: string|null, commandLine?: string|null}} proc
 * @returns {boolean}
 */
export function isSidecarProcess(proc) {
  const hay = `${proc?.name ?? ''} ${proc?.commandLine ?? ''}`.toLowerCase();
  if (hay === '') return false;
  return hay.includes('workbuddy') || hay.includes('codebuddy');
}

/**
 * 解析进程清单查询的输出，取指定 pid 的 `{name, commandLine}`。
 *
 * <p>★ 行格式固定为 `pid<TAB>name<TAB>commandLine`（由 queryProcessListPs1 产生）。
 *   命令行里可能本来就有 tab，所以**只按前两个 tab 切**，其余整段当命令行。
 *
 * @param {string} text
 * @param {number} pid
 * @returns {{name: string, commandLine: string}|null} 查不到返回 null
 */
export function parseProcessList(text, pid) {
  if (typeof text !== 'string') return null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const first = trimmed.indexOf('\t');
    if (first < 0) continue;
    if (Number(trimmed.slice(0, first)) !== pid) continue;
    const second = trimmed.indexOf('\t', first + 1);
    const name = (second < 0 ? trimmed.slice(first + 1) : trimmed.slice(first + 1, second)).trim();
    const commandLine = (second < 0 ? '' : trimmed.slice(second + 1)).trim();
    return { name, commandLine };
  }
  return null;
}

/**
 * 一次查清所有候选 pid 的身份。
 *
 * <p>★ **一次查询，不是一个 pid 一次**：一次 PowerShell 往返约 200–400ms，
 *   逐个查在几十个候选上就是十几秒 —— 而发现过程在每次下发前都要跑一遍。
 *
 * <p>★ 查不到的 pid 记为 `null`（**存疑**）而不是 `false`：查不到可能只是没权限，
 *   而把"没权限"当成"不是我们的进程"，会静默丢掉用户提权运行的 sidecar ——
 *   那恰恰是最不该被丢的那个（同 `isPidAlive` 对 EPERM 的处理）。
 *
 * @param {{run: (spec: {argv: string[]}) => Promise<string>, helper?: string}} deps
 * @returns {(pids: number[]) => Promise<Map<number, {isSidecar: boolean|null, name: string, exists: boolean|null}>>}
 *   `isSidecar === null` = 身份判不了 ⇒ 调用方必须 fail-open（`exists` 同样为 `null`）。
 *
 * <p>★★ 2026-09-30：`exists` 是与 `isSidecar` **正交**的第三个维度，别把两件事并成一件事。
 * <pre>
 *   exists=true , isSidecar=true  → 真的是 sidecar
 *   exists=true , isSidecar=false → pid 还在，但占着它的是别的程序（**pid 被回收**）
 *   exists=false, isSidecar=null  → **那个进程根本不存在**（session 文件是残留）
 *   exists=null , isSidecar=null  → 枚举本身失败，什么都判不了 ⇒ fail-open
 * </pre>
 * <p>★ 为什么要把第三行从"存疑"里拆出来（本机实测，这是 `token_unavailable` 假归因的源头）：
 *   `query-process-list.ps1` 枚举的是**整张** `Win32_Process` 表（`Get-CimInstance` 无过滤）。
 *   既然查询**成功**了，这个 pid 不在表里就是一个**确定的否定答案**——进程没了，
 *   而不是"没权限所以查不到"。两者混成"存疑"时，一条已经死掉两小时的 session 文件
 *   会被 fail-open 放进候选池，接着去读它的进程环境（必然失败），
 *   最终报成 `token_unavailable` + 一句"权限不够"——真机读数里那个"1 个 sidecar"
 *   就是 pid 20868，一个 tasklist / CIM / GetProcessById 都不承认的进程。
 *   ⇒ 正确的归因是"没有存活的 sidecar"，处置完全不同。
 */
export function createIdentityResolver({ run, helper = QUERY_PS1 }) {
  return async function resolveIdentities(pids) {
    const out = new Map();
    const wanted = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
    if (wanted.length === 0) return out;
    const unknown = { isSidecar: null, name: '', exists: null };
    /** ★ 枚举**成功**了但这个 pid 不在表里 ⇒ 进程不存在（不是"没权限"，见上方三态表）。 */
    const gone = { isSidecar: null, name: '', exists: false };
    /**
     * ★★ `argv[0]` 必须是**可执行程序**，开关只能跟在它后面。
     *
     * <p>2026-09-30 真机（本仓库 139 处 argv 里，**只有本模块**写反了）：
     *   本行原写作 `['-NoProfile', '-NonInteractive', …]` —— 把开关当成了程序名。
     *   而 seam `ctx.subprocess.spawn`（apply.js `makeSeamRunner`）按 `argv[0]` 找程序：
     *     `token.js`   → `['pwsh.exe', '-NoProfile', …]`
     *     `portmap.js` → `['netstat', '-ano', …]`
     *     `hardening.test.js` 的 seam 测试 → `['pwsh.exe', '-NoProfile']`
     *   ⇒ 原写法等于去执行一个名叫 `-NoProfile` 的程序，**必然 ENOENT**。
     *
     * <p>★★ 危害不是"少一条候选"，是**结论被带歪**：异常落进下面 catch 的 fail-open，
     *   于是**每个 pid 都判成"存疑"**，而 `summarizePool` 的 pid 回收防线（本模块存在的
     *   唯一理由）**在真机上从未生效过**。症状：本该报 `pid_recycled`（"重启解决不了"），
     *   实际报 `no_endpoint`（"去重启 WorkBuddy 桌面端"）—— 用户被送进重启循环，
     *   而那正是本模块注释里声称已经修好的故障。
     *
     * <p>★ 这条为什么没被测出来：`test/gateway-identity.test.js` 的旧用例全部注入
     *   `run: async () => REAL_OUTPUT`，**假 runner 不看 argv** —— 接线错在测试里不可见。
     *   现已补上钉住 argv 契约的用例（见该文件"接线契约"一节）。
     */
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
      '-ProcessIds', wanted.join(',')];
    let text = null;
    // ★ 与 token.js 同一套候选与回落顺序：pwsh(7.x) 优先，powershell.exe(5.1) 兜底。
    for (const shell of POWERSHELL_CANDIDATES) {
      try {
        // eslint-disable-next-line no-await-in-loop
        text = await run({ argv: [shell, ...args] });
        break;
      } catch {
        continue;   // 这个 shell 不可用 ⇒ 试下一个；两个都不行才退化成"全部存疑"
      }
    }
    if (text === null) {
      // 整个查询失败 ⇒ 全部存疑，交给调用方 fail-open。
      for (const p of wanted) out.set(p, unknown);
      return out;
    }
    for (const p of wanted) {
      const proc = parseProcessList(text, p);
      out.set(p, proc === null
        ? gone
        : { isSidecar: isSidecarProcess(proc), name: proc.name, exists: true });
    }
    return out;
  };
}
