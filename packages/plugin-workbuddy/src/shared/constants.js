/**
 * ★ 唯一跨 host / client 的常量文件（两插件同构；本文件为 plugin-workbuddy 版）。
 *
 * Implements: 02-design/DESIGN-v3.md §3.1（shared/constants.js）/ §3.4.2（NS/PLUGIN_ID 用法）/ §4.2（7 档）
 * 约束：本文件属于 packages/*​/src —— CI ② 扫描范围内，不得出现裸进程出口字样。
 */

/**
 * cordis 行 id（短名）—— 与 `cordis.patch.yml` 的 `id:` 保持一致（**惯例**，非框架要求）。
 * 实证（本机只读）：loader 只用 patch 行的 `name:` 作为 **import specifier**（`cordis-plugin-loader/lib/index.js:522`），
 * 行 `id` 是行标识（可省略、自动生成、同树唯一），模块导出的 `name` 仅作 cordis 运行时显示名（fiber 名）。
 * ⇒ **真正必须成立的是**：patch 行 `name:` 能在 dsh 的可解析路径下 import 到本包（部署问题，见 RECON-T02 §6）。
 * 惯例示例：`dsh-tool-bash` 行 `- id: tool-bash` / `name: '@deepseek-ai/dsh-tool-bash'`，模块导出 `name = "tool-bash"`。
 */
export const PLUGIN_ID = 'plugin-workbuddy';

/** npm 包名（= client 模块 id / slot id；行 `name:` 字段用它加载）。 */
export const PACKAGE_NAME = 'dsh-plugin-workbuddy';

/**
 * settings namespace（§3.6：必须匹配 `/^[a-z][a-z0-9-]*$/` 形态的 lowercase hyphenated identifier）。
 * 实证：`dsh-settings/lib/index.js:84` 的 NAMESPACE_PATTERN 校验；用包名即合法。
 */
export const NS = PACKAGE_NAME;

/** 模型可见工具名（§3.4.2：注册/注销以这一对为准）。 */
export const TOOL_RUN = 'workbuddy_run';
export const TOOL_STATUS = 'workbuddy_status';

/**
 * canonical 推理强度 7 档（§4.2 映射矩阵左列；v1 为 UPPERCASE，v3 canonical 用 lowercase）。
 * 抽取源：`_legacy/contracts-v1/dcp-messages.ts:32`（`'OFF'|'MINIMAL'|…|'MAX'`，7 档）。
 * ⚠️ 平台的"支持子集"由 `config.launch.effortValues` 的数据表决定（WorkBuddy 无 `off` ⇒ 置灰）；
 *    `DEFAULT_EFFORT` 不在抽取之列 —— §4.3 H-NO-FABRICATED-DEFAULT 禁止发明默认值。
 */
export const EFFORT_LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** 状态 bridge 路由前缀（host 注册 · client 消费；§3.5.1 的 `${ROUTE_PREFIX}/status`）。 */
export const ROUTE_PREFIX = '/plugin-workbuddy';
export const ROUTE_STATUS = `${ROUTE_PREFIX}/status`;
