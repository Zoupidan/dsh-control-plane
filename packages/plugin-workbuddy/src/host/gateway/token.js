/**
 * 网关侧令牌的唯一供给：**用户配的 `gatewayToken`**。
 *
 * <p>══════════ 2026-10-10 P0 清理：进程出口全删 ══════════
 *
 * <p>本模块原来是"跨进程读 sidecar 的 PEB 环境块、拿 `CODEBUDDY_GATEWAY_PASSWORD`"：
 * 走 `pwsh.exe` / `powershell.exe` 跑 `assets/read-sidecar-env.ps1`。
 *
 * <p>产品 Owner 的硬约束：插件**任何**路径（正常流、错误回退、探测逻辑）都不许拉起
 * 任何显/隐 Shell、控制台、CLI 进程。PowerShell 属于"任何显隐 Shell 进程"，
 * 因此这条取口令的路**整体删除**，不是"补一个开关"：
 * <ul>
 *   <li>helper 脚本 `assets/read-sidecar-env.ps1` 已删；</li>
 *   <li>`readGatewayPassword` / `normalizeHelperOutput` / `parseGatewayPassword` /
 *       `POWERSHELL_CANDIDATES` / `GATEWAY_PASSWORD_ENV` / `GATEWAY_PASSWORD_LEN`
 *       全部删除，零 importer；</li>
 *   <li>`dispatch.js` 不再接收 `run`（进程出口），`apply.js` 的 `makeSeamRunner` 随之删除。</li>
 * </ul>
 *
 * <p>代价（如实记账，不美化）：口令**只存在于 sidecar 的进程内存里**（真机核对过全部
 * 落盘位置，都没有）。删掉 PowerShell 读取之后，插件**没有第二条纯 JS 路**可以拿到它
 * （Node 无 FFI，`usize`/`ReadProcessMemory` 都得靠外部进程）。所以：
 * <pre>
 *   用户配了 gatewayToken  ⇒ 一切照旧（配置是唯一真源）
 *   没配                    ⇒ 网关侧的探活/握手一律判"取不到口令"，如实降级
 * </pre>
 *
 * <p>★ 这不是"为保功能留下 spawn"，而是本约束下的**唯一诚实解**：要么拉 Shell，
 * 要么让这一节优雅降级。Owner 选的是后者。
 *
 * <p>★ 口令本身仍然只进内存：不写仓库、不进日志、不进 argv、不进任何返回给模型的载荷，
 * 也不进 HTTP 响应体（诊断路由只回 `configuredToken` 存在性布尔）。
 *
 * @module host/gateway/token
 */

/**
 * 跨平台可用性。
 *
 * <p>★ 恒为"不支持"，且**必须给出下一步**：非 Windows 时代码会讲一句"去装 pwsh"，
 * 现在不需要了 —— 任何一个平台上都没有自动读取这回事，唯一出路都是
 * "把 `gatewayToken` 填进插件设置"。
 *
 * @returns {{supported: boolean, reason: string|null}}
 */
export function autoReadSupport() {
  return {
    supported: false,
    reason: 'the sidecar gateway password exists only in the sidecar process memory, and the '
      + 'PowerShell helper that used to read it is gone: this plugin no longer starts any shell '
      + 'or console process on any path. Set gatewayToken in the plugin settings instead.',
  };
}

/**
 * 带缓存的令牌提供器。
 *
 * <p>★ 缓存是必需品不是优化：按 pid+启动时刻缓存后，一次会话内只解析一次配置；
 *   用户改了设置则下一轮立刻生效（配置不进缓存）。
 *
 * @param {{configured?: string|null|(() => string|null), read?: (pid: number) => Promise<string|null>}} deps
 *   `configured` 收函数：`.volatile()` 字段在装配期会把设置值拍死，用户改了不生效。
 *   `read` 是**已废除**的自动读取钩子 —— 2026-10-10 起插件不再提供任何实现，
 *   形参保留只为兼容既有调用形状；真被调用时只会得到"没有实现"这个结论。
 */
export function createTokenProvider({ configured = null, read = null } = {}) {
  /** @type {Map<string, string>} key = `${pid}:${startedAt}` */
  const cache = new Map();
  const configuredNow = () => (typeof configured === 'function' ? configured() : configured);
  return {
    /**
     * @param {{pid: number, startedAt: number|null}} sidecar
     * @returns {Promise<{token: string, source: 'cache'|'read'|'config'}>}
     */
    async get(sidecar) {
      const key = `${sidecar.pid}:${sidecar.startedAt ?? 0}`;
      const hit = cache.get(key);
      if (hit !== undefined) return { token: hit, source: 'cache' };
      const cfg = configuredNow();
      if (typeof cfg === 'string' && cfg !== '') {
        return { token: cfg, source: 'config' };   // 不进缓存：配置可能被改
      }
      // 没有自动读取实现了 ⇒ 直接把"没有实现"当成结论，而不是悄悄地再试一次别的东西。
      if (typeof read !== 'function') {
        throw new Error(
          'cannot obtain the sidecar gateway password: it exists only in the sidecar process '
          + 'memory (not written to any file), and the automatic cross-process reader was removed '
          + 'because this plugin must not start any shell or console process. '
          + 'Set gatewayToken in the plugin settings.',
        );
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
