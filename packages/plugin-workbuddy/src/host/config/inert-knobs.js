/**
 * 惰性旗标登记册（★ WB-7 的显式表态面；由 `tools/ci/check-consumed-knobs.mjs` 强制校验）。
 *
 * Implements: 02-design/DESIGN-v3.md §4.6（flag 表是**数据**）/ §9 R3-7（红线自证）
 * Related:    04-docs/LLM-GUIDE-workbuddy-plugin.md §5-22（本文件即其处置）
 *             · 04-docs/ISSUE-workbuddy-open-issues.md WB-7
 *             · 04-docs/RECON-WINDOW-RESULT.md §3 旗标对照表 + D-1（行 199-204 / 255）
 *
 * ★★★ CLI 线整体删除后本表为空（2026-10-02）★★★
 * 原先登记的 5 个惰性旗标（`sessionIdFlag` / `inputFormatFlag` /
 * `permissionPromptToolFlag` / `includePartialMessagesFlag` /
 * `noSessionPersistenceFlag`）全部随 `launch/argv.js` 与 schema 的 `launch`
 * 旗标表一起删除 —— 它们没有任何代码读，留着比删掉更坏：
 * 用户在设置里改一个不存在的旗标名，看不到任何效果，也没有任何报错
 * （schemastery 对未知键是**静默丢弃**）。一张永远不发出去的表 = 一个永远不生效的承诺。
 * 唯一留下的是 `launch.effortValues`：**它不是旗标**，是"这个平台支持哪几档推理强度"的能力表，
 * 由状态路由的 `effortCapability(config)` 真实消费（红线行为探针按包指名验证，见
 * `tools/ci/check-consumed-knobs.mjs` 的 `PROBE_TARGETS`），不需要惰性登记。
 *
 * 契约不变：将来若新增 `launch.*` 键，其状态只有两种合法形态 ——
 * ① 被真实下发（探针可验证）；② 在本文件登记惰性并写明**为什么不下发**。
 * 键 = `'launch.<key>'`（层级参与键名 —— 与 schema.js 的 `launch` 子键一一对应）；
 * 值 = 非空理由（理由为空 = FAIL）。删一个旗标时**必须同时删这里的登记**，否则 orphan-register 变红。
 *
 * 约束：本文件属于 packages/*/src（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 */
export default {};
