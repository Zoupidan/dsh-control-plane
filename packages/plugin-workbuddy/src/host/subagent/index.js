/**
 * 子智能体 provider 的**注册态收敛** —— 与 `host/tools/index.js` 同构的第二处收敛点。
 *
 * <p>★ 为什么要自己收敛，而不是"注册一次就完事" ★
 *
 * <p>注册态仍然要收敛，判据是**铁律 U4**：`enabled !== true` ⇒ 一处都不许注册（见下面那个 ★★★ 块）。
 * 收敛器保留下来还有两件实事：一是要跟着探测结论的**三态**走（"未探测 ≠ 未安装"，
 * C 组同一判据：探测在途时先乐观注册，探测一落地再收敛一次）；二是注册失败
 * （`DUPLICATE_PROVIDER` 之类）必须只落日志、不炸掉整个 apply()。
 *
 * <p>★★★ 铁律 U4：`cfg.enabled !== true` ⇒ provider **一处都不许注册** ★★★
 *
 * <p>理由与 `host/tools/index.js` 同款：委派面是**授权面**，不是可用性面。
 * 探测能证明"装没装"，证明不了"允不允许"；把两者折成一条判据，等于让一次
 * 成功的安装探测替用户做了授权决定。
 *
 * <p>★ 2026-09-30 曾尝试推翻这道闸（删掉 `enabled === true &&` 前置，改为只看探测三态），
 *   当天**已回滚**。回滚依据（供后人免得再踩，不要当成新结论）：
 *   - 推翻对当天的实机演示**零收益**——主理人 live profile
 *     `~/.dsh/profiles/desktop/cordis.patch.yml` 静态写着 `enabled: true`，
 *     闸门在演示环境里本来就是开的，推翻与否 live 行为完全相同；
 *   - 推翻后的状态比原状**更差**：schema 默认值仍是 `false`（为过三处同步断言），
 *     而判据不再读它 ⇒ 得到一个"默认关闭、实际被忽略"的**会说谎的配置项**。
 *     要么它是真开关，要么它不是，"默认 false 但不被读"是最差的一种；
 *   - 代价①（`enabled` 不再是 kill switch）在推翻成立时就已与"默认值仍为 false"**互斥**，
 *     回滚即刻消除该问题。
 * 那次分析里**成立且应当保留**的部分：注册是零成本的（provider 构造只返回对象字面量、
 * 第一个真实副作用在 `provider.start()`）——也就是说，将来若真要做这个改动，
 * **执行面才是该收紧的地方，不是注册面**。
 *
 * <p>★ 为什么不并进 `reconcileTools` ★
 * 两个 seam（`tools` / `subagents`）的注册态、失败面、注销时机各不相同：
 * 工具注册失败要落 `runtime.setRegistrationError`（工具面读），而 provider 注册失败
 * 同样是 `DUPLICATE_PROVIDER` 之类，混进同一个 `disposers[]` 会让"注销工具"与"注销 provider"
 * 共享一个失败回滚路径——一个注册失败时把另一个也回滚掉，爆炸半径比现在大得多。
 * 共用的只有 `runtime` 这一个读源。
 *
 * <p>★ 只有 provider，没有 LLM 适配器（2026-10-02 移除）★
 * 这里曾经同时注册一个 `llm` 适配器（路由名 `workbuddy`），好让 dsh 自己的 agent loop
 * 跑在 WorkBuddy 的模型上。**那是反代**：把"WorkBuddy 是一个远端 Agent"偷换成
 * "WorkBuddy 是一个可被选中的模型"，父 Agent 的 provider 一旦能选成 workbuddy，
 * dsh 的模型面板里就会出现一堆来自别家的模型 id。已按铁律删除，且不再有替代品：
 * 本 provider 的全部能力位都是 `false`（见 `provider.js`），执行口只有一个
 * `createTaskExecutor()`，即"dsh 把任务下发到 WorkBuddy → WorkBuddy 自己跑完 → 结果回传"。
 *
 * <p>★ 不 rethrow ★
 * 与 `reconcileTools` 的 C 组同一条纪律：注册期异常只落日志，不炸掉整个 apply()
 * （那会让 ⑤ 状态路由与 ⑥ 提示词 section 都不再装配）。
 *
 * <p>约束：本文件属于 packages 下的 src（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 *
 * @module host/subagent/index
 */

import { createWorkBuddyProvider, PROVIDER_NAME } from './provider.js';
import { createTaskExecutor } from './execute.js';

/**
 * 收敛 `workbuddy` 子智能体 provider 的注册态。
 *
 * @param {object} ctx 宿主 ctx（插件级）
 * @param {object} deps
 * @param {object} deps.runtime `plugin-cli-core/src/runtime.js` 的运行时（`currentConfig()` / `detected()` / `onDetected()`）
 * @param {string} deps.NS settings namespace（fiber 标签用）
 * @param {object} [deps.dispatch] 未使用（网关已下线，保留参数仅为兼容旧调用方，不再走 `dispatch.run`）
 * @param {object} [deps.sessions] 会话记性（`session/map.js` 的映射，与工具面同一份）
 * @param {(message: string) => void} [deps.log]
 * @returns {() => void} 卸载收敛器（注销 provider + 退订探测订阅 + dispose fiber）
 */
export function reconcileSubagentProvider(ctx, { runtime, NS, dispatch, sessions = null, log = null }) {
  const read = () => {
    const src = runtime.current();
    return typeof src === 'function' ? runtime.currentConfig() : src;
  };

  /**
   * 实例**只造一次**并在注册/注销之间复用。
   * 理由：`dsh-tool-subagent` 在挂载时把 provider 对象**按引用**存进闭包，
   * 执行前还会复核 `getProvider(name) === 那个对象`（`dsh-tool-subagent/lib/index.js:505`）；
   * 每次收敛都造新实例 ⇒ 开关每拨一次，正在途的委派就会撞上"provider 换了"而失败。
   */
  let provider = null;

  /**
   * 执行口，同样只造一次（它持有 `sessions` 记性，换了引用会让
   * 后一轮委派读到另一份重放前情，`sessionKey` 也就串不到同一组上）。
   *
   * <p>传输面只有 `automation`（与 `tools/run.js` 同一路）：点火 `startAutomationRun`，
   * 不再走 `dispatch.run`。`dispatch` 参数仅为兼容旧调用方保留，不再被读取。
   *
 * <p>多轮靠 `transcript` 重放前情（每轮都是新对话，该表无对话列），
 * 点火在 `sessions.id` 一确认就 `retireRow` + `adopt(sessionKey)`，后续走复用不再建行。
 * <p>★ 2026-10-03 起另有 Track A 追发支（会话复用）：总闸 `enableMultiTurnFollowUp` 开着且
 * 记性命中时本轮不点火，直接追加进既有对话 —— 语义与接线见 `execute.js` 的追发块；
 * 开关默认 false，关闭时执行口行为与未接线版本逐字节一致。
 */
  let runTask = null;
  const ensureRunTask = () => {
    if (runTask === null) {
      // ★ 追发接线（Track A）：`setting` 让执行口现取 `enableMultiTurnFollowUp` /
      //   `followupCdpPort` / `followupTimeoutMs`（.volatile() 字段必须现取，不能装配期拍死）；
      //   `log` 透给追发调度器（CDP 判别/耗时日志，与工具面同一出口风格）。
      runTask = createTaskExecutor({ setting: (key) => read()?.[key], sessions, log });
    }
    return runTask;
  };

  const ensureProvider = () => {
    if (provider === null) {
      provider = createWorkBuddyProvider({
        readConfig: () => read(),
        runTask: ensureRunTask(),
        log,
      });
    }
    return provider;
  };

  /** @type {(() => void)|null} */
  let dispose = null;

  const reconcile = () => {
    const cfg = read();
    const probe = runtime.detected();
    // ★ 铁律 U4：`enabled` 是**硬前置**（授权面），探测三态只决定"装了没有"（可用性面）。
    //   未探测 ⇒ 乐观注册；探测落地 ⇒ 按 `installed` 收敛。
    const want = cfg?.enabled === true && (probe === null ? true : probe.installed === true);

    if (want && dispose === null) {
      try {
        dispose = ctx.subagents.registerProvider(ensureProvider());
      } catch (err) {
        // ★ 不 rethrow（见文件头）。`dispose` 保持 null ⇒ 下一次收敛还会重试，
        //   与 `reconcileTools` 的"注册失败 ⇒ 下次 want 时重试"同一条纪律。
        log?.(`failed to register the "${PROVIDER_NAME}" subagent provider: ${err?.message ?? String(err)}`);
      }
    } else if (!want && dispose !== null) {
      dispose();
      dispose = null;
    }
  };

  // 响应式重收敛的触发点与 `reconcileTools` 同款：
  //   ① `loader/volatile-update`（0.1.7 起 volatile 字段就地更新并广播）
  //   ② 探测落地（`onDetected`）
  const settingsFiber = ctx.inject(['subagents'], (sctx) => {
    sctx.effect(() => {
      reconcile();
      return sctx.on('loader/volatile-update', () => {
        reconcile();
      });
    }, `${NS}: subagent provider`);
  });

  const offDetected = runtime.onDetected(reconcile);

  return () => {
    offDetected();
    dispose?.();
    dispose = null;
    void settingsFiber?.dispose?.();
  };
}

export { createWorkBuddyProvider, PROVIDER_NAME };
