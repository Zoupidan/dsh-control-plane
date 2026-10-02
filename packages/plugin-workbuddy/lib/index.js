/**
 * host 入口（官方物理契约：`main = lib/index.js`；§3.1）。
 * 单一事实源在 `src/host/apply.js` —— 本文件只做转发，不复制逻辑（避免双份装配漂移）。
 *
 * 约束：本文件属于 packages/*​/lib（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 */
export { name, inject, apply, Config } from '../src/host/apply.js';
