/**
 * **宿主协议词汇表** —— 插件与 dsh 宿主之间约定死的字面值。
 *
 * <p>★ 为什么单独一个文件 ★
 * 这两套取值域既不是 WorkBuddy 的旋钮，也不是任何一家 agent 产品的属性 ——
 * 状态载荷、设置卡片、系统提示词全都按**字面值**判定它。它是"插件 ⇄ 宿主"之间那份约定。
 * 把它和 `PROBE_TARGET`、输出上限那些**本插件自己**的旋钮混在一个 `constants.js` 里，
 * 后果是后来的人分不清"哪些能按 agent 改、哪些改了会直接和宿主对不上"。
 * 所以：**协议归协议，旋钮归旋钮，各在一个文件。**
 *
 * <p>★ 为什么不再抽成跨插件的公共包 ★
 * 一个 agent 产品一个文件夹，是有意为之：每个程序的行为本来就不一样
 * （WorkBuddy 有它的目录接口和积分接口，别的产品各有各的），硬抽一层"通用底层"
 * 只会得到一个谁都不完全合身的中间层。
 * 这里的取值域是**协议**，协议就该跟着插件走 —— 真到第二个产品接入、两边真的要共用同一份
 * 约定时，再把它放进共享位置也不迟；在那之前，先让每个产品文件夹**自己读得懂**。
 *
 * <p>★ 冻结的理由 ★
 * 运行时会往载荷里写这些字符串。若运行期能改写取值域，已发出的载荷与后续判读就会对不上，
 * 且这种错**不会让任何测试变红**。
 *
 * @module host/config/host-protocol
 */

/** ① 工具注册态。 */
export const REGISTRY_STATES = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  NOT_INSTALLED: 'NOT_INSTALLED',
  UNREGISTERED: 'UNREGISTERED',
  REGISTERED: 'REGISTERED',
  DEGRADED: 'DEGRADED',
});

/** ② Job 执行态（与 ① 正交：两套状态互不推导）。 */
export const RUN_STATES = Object.freeze({
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
});