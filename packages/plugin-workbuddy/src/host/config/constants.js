/**
 * host 端常量 —— ★ **只放本插件自己的旋钮** ★
 *
 * ★ 与宿主协议词汇表的分工 ★
 *   本文件：探测目标、输出上限、宽限期、spill 阈值……**按 agent 产品不同而不同**的东西。
 *   `./host-protocol.js`：状态载荷用的那几个**协议字面值** —— 改了会直接和宿主对不上。
 *   两者混在一起时，后来的人无从判断"这个键我能改吗"，所以分开。
 *
 * Implements: 02-design/DESIGN-v3.md §7.1（探测来源）/ §7.3（生命周期与限额）
 * 约束：本文件在 src 下（CI ② 进程出口审计扫描范围）——
 *       全文件不得出现裸进程出口字样（唯一出口是 ctx.subprocess）。
 */

import { REGISTRY_STATES, RUN_STATES } from './host-protocol.js';

// 再导出：既有引用面（tools/index.js / run.js / prompts/availability.js 与若干测试的
// `mods.constants.REGISTRY_STATES`）一字不动。协议本体在 host-protocol.js，这里只是门面。
export { REGISTRY_STATES, RUN_STATES };

/** 探测目标标识（ProbeResult.target，§7.2）。 */
export const PROBE_TARGET = 'workbuddy';

/** 单作业输出上限（§3.4.3：outputLimitBytes = 64 KiB）与终止宽限期（§7.3：graceMs）。 */
export const OUTPUT_LIMIT_BYTES = 64 * 1024;
export const GRACE_MS = 5000;

/**
 * stderr 收集上限（T04 新增）。
 *
 * 为什么必须收集：真机失败的**证据只在 stderr**（RECON §4.5 实测：无效 `--model` ⇒ stderr
 * `400 model [xxx] service info not found` + 支持型号清单，而 **exit code = 0**，stdout 为空）。
 * T02 基线的 `stderr: 'ignore'` 下 D-3 无从识别。
 *
 * 取值依据：§4.5 的证据文本 = 一行 400 + "Currently supported models for your account:" + 17 行清单，
 * 量级 1–2 KiB；取 8 KiB 留出 4 倍余量，同时远小于 stdout 的 64 KiB（CI/状态载荷回传的摘录会再截到 2 KiB）。
 */
export const STDERR_LIMIT_BYTES = 8 * 1024;

/**
 * 输出落盘上限（spill；T04 增量⑥ —— 关闭"输出被静默裁剪"这条信道缺口）。
 *
 * 为什么必须有：`stdio.* = { maxBytes }` 只保留**尾部窗口**，更早的输出在收集阶段就被丢掉
 *   （dsh `OutputCollector.push()` 从保留窗口的**头部**丢 chunk），而 `readFrom()` 只回吐保留窗口
 *   ⇒ 64 KiB 之外的一切（含出现在**中段**的关键证据）永久消失。真机实测（2026-09-19）：一次约 209 秒的
 *   下发把 stdout 顶到 65536 字节上限、退出码 1，而作业输出里只剩末尾一截 —— 前段发生的事不可见。
 *
 * 语义（读 `@deepseek-ai/dsh-subprocess-local` 的 `OutputCollector` 所得，非推测）：给了 `spill.maxBytes`
 *   之后，**首次**溢出时把已收集的 chunk 一并写入一个 `wx` 权限 0o600 的临时文件，之后整份流都落盘；
 *   `readFrom()` / `finalize()` 在文件完好时回传 `spillPath`（`tools/run.js` 的 `truncationNote()` 据此
 *   才敢说"完整落到 <路径>"）。累计量超过本值 ⇒ 停写并**删除**该文件（`discardSpill()`，路径随之不再
 *   回传）—— 这是本上限的诚实含义：宁可如实说"前段已丢弃"，也不给一个缺尾巴的"完整副本"。
 *
 * 取值依据（诚实边界）：**本地没有"整份流有多大"的实测数据** —— 可观测到的只有被 64 KiB 窗口裁过的
 *   尾部（真机落到作业输出的尾部约 51–70 KB）。16 MiB = 该窗口的 256 倍，足够覆盖"模型正文 + 多轮
 *   工具调用"的典型下发；超限时按上面的退化语义收敛。
 * ★ 落盘文件由 dsh **保留**（其 `privateSpillDir()` 注释：进程退出时只删"不含落盘文件的空目录"）
 *   ⇒ 会在系统临时目录里累积；路径随作业通知/`job_output` 回传，可人工清理。
 */
export const OUTPUT_SPILL_LIMIT_BYTES = 16 * 1024 * 1024;

/**
 * 从落盘文件回读 `init` 帧时读取的**头部字节上限**（WB-2 —— 长会话下 `initModel`/`initPermissionMode` 丢失的修复）。
 *
 * 为什么必须有：保留窗口只留**尾部**（dsh `OutputCollector.push()` 从窗口头部丢 chunk），
 *   而 `system/init` 帧是 stdout 的**第一行** ⇒ 只要一次下发超过 64 KiB，`init` 帧必然落在窗口之外，
 *   `workbuddy_status` 里的 `initModel`/`initPermissionMode` 就退化成 `null`（真机实测 2026-09-21：
 *   落盘文件第 0 字节逐字写着 `"permissionMode":"default"`，同一次运行的 status 两个字段都是 `null`）。
 *   完整流既然已经被我们自己落盘，就没有"看得见却不去读"的道理。
 *
 * 取值依据：与 `OUTPUT_LIMIT_BYTES` 同量级（64 KiB）—— `init` 帧是**单行 JSONL**，真机观测的 init 帧
 *   在数百字节量级（含 17 行模型清单的是 result 帧，不是 init）。窗口能装下的帧，头部回读也装得下；
 *   再大就是在为一个已知只有几百字节的字段做无界读。**不做整份文件回读**（可达 16 MiB ⇒ 会吃掉状态载荷）。
 *
 * ★ 边界（读 dsh 源码所得，非推测）：`seal()` 在结算时关闭落盘文件，其注释明写"the spawn path seals
 *   both collectors at settlement so reads after exit never point at a still-open file"
 *   （`dsh-subprocess-local/lib/runner-launch-*.js:806-821`）⇒ 在 `settle()` 里读它是安全的；
 *   而 `closeSync` 失败时 dsh 会**停止回传** `spillPath` ⇒ 我们拿到路径就等于"文件写完且完好"。
 *   本上限只界定**读多少**，不改变"文件仍在"这一事实：读完后不删、不移动（禁止删 `%TEMP%\dsh-subprocess-*`）。
 */
export const SPILL_INIT_HEAD_BYTES = 64 * 1024;
