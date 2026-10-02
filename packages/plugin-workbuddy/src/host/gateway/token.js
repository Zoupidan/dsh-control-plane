/**
 * 网关口令的获取。
 *
 * <p>══════════ 先说清楚这是什么、不是什么 ══════════
 *
 * <p><b>是什么</b>：桌面端 spawn `codebuddy --serve` 时注入该子进程环境的一个本机 IPC 密文
 * （真机 43 字符）。`POST /api/v1/auth/login {password}` 换到的 token **就是这个口令本身**。
 *
 * <p><b>不是什么</b>：它**不是** WorkBuddy 账号凭据。账号会话始终在 sidecar 进程内，
 * 拿这个口令**无法**独立调用 WorkBuddy 云端任何接口 —— 它只能对本机那个 Express 网关说话。
 * 因此本模块不违反 `check-no-credential-echo.mjs` E3c 的边界（那条防的是"插件持有**账号**凭据
 * 并替用户发起调用"）；但这属于对既有边界的**实质性触碰**，已在该闸的登记表里显式登记并写明理由，
 * 不靠"检查没扫到"蒙过去。
 *
 * <p>══════════ 代价，必须讲明白 ══════════
 *
 * <p>该口令**只存在于 sidecar 的进程内存**。本机核对过全部落盘位置
 * （`sessions/*.json` / `settings.json` / `keyblob` / `credentials/` / `last-launch.json`）
 * —— <b>都没有</b>。所以只有三条路：
 *
 * <ol>
 *   <li><b>读进程环境</b>（本模块的默认，Windows-only）：PEB 走读，需要 `PROCESS_VM_READ`。
 *       代价：非 Windows 不可用；部分杀软/EDR 会拦跨进程内存读；实现依赖 C#/P/Invoke。</li>
 *   <li><b>用户手工配置</b>（`gatewayToken`，本模块的回退）：跨平台、零特权，但每次桌面端重启
 *       换 sidecar 就得重配 —— 体验差，所以只是回退不是主路。</li>
 *   <li>让桌面端开一条"取口令"的 IPC —— <b>不存在</b>（真机枚举：只有 `wb.request` 一条管道）。</li>
 * </ol>
 *
 * <p>★ 无论哪条路：口令**只在内存里**，不写仓库、不进日志、不进 argv、不落盘（除用户自己配的
 * 配置文件之外）、不进任何返回给模型的载荷。
 *
 * @module host/gateway/token
 */

import { platform } from 'node:os';

/** 环境块里我们唯一关心的那一个键。 */
export const GATEWAY_PASSWORD_ENV = 'CODEBUDDY_GATEWAY_PASSWORD';

/**
 * 候选 shell，按优先级。
 *
 * ★ 为什么两个都要 —— 这不是冗余，是实测踩出来的：
 *   `powershell.exe`（5.1）按 **ANSI** 解码**无 BOM** 的 `.ps1`，脚本里的中文注释会被打乱成
 *   野 token，报 `Unexpected token '}'` 直接解析失败（本机：5.1 退出码 1 / 43 字节拿不到）。
 *   `pwsh`（7.x）默认 UTF-8，同一脚本退出码 0。已给脚本加 UTF-8 BOM 修正 5.1，
 *   但 BOM 可能被编辑器或格式化工具抹掉，所以保留一条不依赖 BOM 的 7.x 通路；
 *   反过来 7.x 并非预装，仍需 5.1 兜底。
 *
 * @type {readonly string[]}
 */
export const POWERSHELL_CANDIDATES = Object.freeze(['pwsh.exe', 'powershell.exe']);

/** 真机实测长度（43），仅记录在案供指纹比对，不参与判定。 */
export const GATEWAY_PASSWORD_LEN = 43;

/**
 * 纯解析：从进程环境块文本里取出网关口令。
 *
 * <p>★ 必须按 `\0` 切而不是按行切：PEB 里的环境块是**双 NUL 结尾的一整块**，
 * 换行是键值内容的一部分（虽然本键的值不含换行，但按行解析会在别的键上出错）。
 * 同时**只认完整键** —— 用 `CODEBUDDY_GATEWAY_PASSWORD` 精确匹配，避免
 * `MY_CODEBUDDY_GATEWAY_PASSWORD` 这类含子串的键被误取。
 *
 * @param {string} block 环境块全文（NUL 分隔）
 * @returns {string|null} 口令；没有 / 形态不对 ⇒ null
 */
export function parseGatewayPassword(block) {
  if (typeof block !== 'string' || block === '') return null;
  for (const entry of block.split('\0')) {
    if (entry === '' || entry.startsWith('=')) continue;   // `=C:=C:\...` 形式的盘符变量
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    if (entry.slice(0, eq) !== GATEWAY_PASSWORD_ENV) continue;
    const value = entry.slice(eq + 1);
    if (value === '') continue;
    // ★ 真机长度 43（`EXPECTED_LEN`）只作**观测**用，不当通过条件：
    //   口令格式将来变了也不该让整条路无声死掉，由调用方在别处记指纹。
    return value;
  }
  return null;
}

/**
 * 跨平台可用性。
 *
 * <p>★ 非 Windows 直接判不可用并给出可执行的下一步，而不是在 P/Invoke 上抛一个
 * "DWORD 是什么"给用户看。
 *
 * @returns {{supported: boolean, reason: string|null}}
 */
export function autoReadSupport() {
  if (platform() !== 'win32') {
    return {
      supported: false,
      reason: `read-sidecar-env is Windows-only (this host is ${platform()}); `
        + 'set the gatewayToken in the plugin settings instead',
    };
  }
  return { supported: true, reason: null };
}

/**
 * 归一化助手 stdout。
 *
 * <p>★ 助手已经**只吐目标键的值**了，所以这里**不能**再拿 `parseGatewayPassword` 去当环境块解析
 * —— 那会永远返回 null（裸值里没有 `KEY=` 的 `=`）。这层曾经真的这么写过一个版本，
 * 被 `gateway-token.test.js` 的负对照当场抓住。
 *
 * <p>★ 顺带挡住诊断串：助手的错误信息走 stderr 且带空格，口令是 43 字符无空白的不透明串。
 * 于是"含空白"既排掉噪声，也排掉"有人把整个环境块打印出来"这种更糟的情况。
 *
 * <p>★★ **两种入参形状都要收**：`string`，以及 `promisify(execFile)` 实际解析出来的
 * `{stdout, stderr}`。只收其中一种会造成一个极难发现的故障：单测里注入
 * `async () => '口令'` 全绿，真机上注入 promisify 的 execFile 时却**每一次**都返回 null
 * （对象过不了 `typeof === 'string'`），表现是"口令永远读不到，去配置 gatewayToken 吧"
 * —— 把一处接线错误伪装成了权限问题。真机上就是这么栽的（见 wb-token-diag2）。
 *
 * @param {string|{stdout?: string, stderr?: string}} out
 * @returns {string|null}
 */
export function normalizeHelperOutput(out) {
  // ★ 先解包：promisify(execFile) 给的是 {stdout, stderr}，不是字符串。
  const raw = typeof out === 'string' ? out : (out === null || typeof out !== 'object' ? null : out.stdout);
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (v === '' || v.length > 512) return null;
  if (/\s/.test(v)) return null;                 // 口令不含空白；诊断串一定含
  if (v.includes('=')) return null;              // 有人把 KEY=VALUE 整行吐出来了
  return v;
}

/**
 * 读取指定进程环境块里的网关口令（需要进程读取权限）。
 *
 * <p>★ 走 PowerShell + 内联 C#：Node 没有内建 FFI，PEB 走读没有别的纯 JS 路径。
 * 助手脚本是**只读**的（`OpenProcess` 带 `PROCESS_QUERY_INFORMATION|PROCESS_VM_READ`），
 * 它只把**指定键的值**打到 stdout，不 dump 整个环境块 —— 别的键（可能含别的密钥）
 * 一概不落日志、不进内存。
 *
 * @param {number} pid sidecar 进程号
 * @param {{run: (spec: {argv: string[]}) => Promise<string>, helper: string}} deps
 *   `run` 注入以便测试；它必须走官方 seam `ctx.subprocess.spawn`（R3-7 ②：
 *   **唯一合法的进程出口**）。`helper` 是 `read-sidecar-env.ps1` 的绝对路径
 * @returns {Promise<string|null>} 口令；读不到返回 null（**不抛**，让调用方降级）
 */
export async function readGatewayPassword(pid, deps) {
  const { run, helper } = deps;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-ProcessId', String(pid)];
  // ★ 口令**绝不作为参数**：argv 在 Windows 上对本机任何进程可读（见 E3a）。
  //   这里只传进程号，值由助手从被读进程的环境里取，直接进 stdout（停在内存里）。
  //
  // ★ 先试 pwsh(7.x) 再回落 powershell.exe(5.1)。两个都要，不是冗余：
  //   5.1 按 **ANSI** 解码无 BOM 的 .ps1，脚本里的中文注释会被打乱成野 token，
  //   直接 `Unexpected token '}'` 解析失败（实测本机：5.1 退出码 1，7.x 退出码 0）。
  //   脚本已加 UTF-8 BOM 规避，但 BOM 可能被编辑器/格式化工具抹掉，
  //   所以留一条不依赖 BOM 的 7.x 通路；反过来 7.x 未必装得上，仍保留 5.1 兜底。
  for (const shell of POWERSHELL_CANDIDATES) {
    let out;
    try {
      out = await run({ argv: [shell, ...args] });
    } catch {
      continue;   // 这个 shell 不可用/读不到 ⇒ 试下一个
    }
    const value = normalizeHelperOutput(out);
    if (value !== null) return value;
  }
  return null;
}

/**
 * 带缓存的令牌提供器。
 *
 * <p>★ 缓存是必需品不是优化：口令每次 sidecar 重启就变，而按 pid+启动时刻缓存后，
 * 一次会话内只付一次"读进程内存"的代价（≈ 200–800ms + 一次杀软扫描），
 * 之后的下发全是纯 HTTP。
 *
 * @param {{read: (pid: number) => Promise<string|null>, configured?: string|null}} deps
 */
export function createTokenProvider({ read, configured = null }) {
  /** @type {Map<string, string>} key = `${pid}:${startedAt}` */
  const cache = new Map();
  return {
    /**
     * @param {{pid: number, startedAt: number|null}} sidecar
     * @returns {Promise<{token: string, source: 'cache'|'read'|'config'}>}
     */
    async get(sidecar) {
      const key = `${sidecar.pid}:${sidecar.startedAt ?? 0}`;
      const hit = cache.get(key);
      if (hit !== undefined) return { token: hit, source: 'cache' };
      if (typeof configured === 'string' && configured !== '') {
        return { token: configured, source: 'config' };   // 不进缓存：配置可能被改
      }
      const got = await read(sidecar.pid);
      if (typeof got !== 'string' || got === '') {
        throw new Error(
          'cannot read the sidecar gateway password: it exists only in the sidecar process memory '
          + '(not written to any file). Start the WorkBuddy desktop and sign in, or set gatewayToken '
          + 'in the plugin settings.',
        );
      }
      cache.set(key, got);
      return { token: got, source: 'read' };
    },
    /** 忘掉某个 sidecar 的口令（它重启后必然失效）。 */
    forget(sidecar) {
      cache.delete(`${sidecar.pid}:${sidecar.startedAt ?? 0}`);
    },
    get size() { return cache.size; },
  };
}
