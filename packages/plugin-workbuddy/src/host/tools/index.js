/**
 * 工具注册收敛 + 开关心脏 reconcile() —— ★ U4 的唯一状态收敛点。
 *
 * Implements: 02-design/DESIGN-v3.md §3.4.2（全文）/ §4.4.1（三态）/ §4.4.2（最外层短路 A1/A2）/
 *             §8（① 注册态：UNKNOWN/NOT_INSTALLED/UNREGISTERED/REGISTERED）
 *
 * 铁律：工具注册态**只能**从 `reconcileTools()` 流出。探测完成、开关变更、插件卸载 ——
 *       三条路径全汇入此函数（H-ORTHOGONAL：注销工具**不杀在途作业**——这里根本不持有作业句柄）。
 *
 * 实测对照（子代理 t02-api-recon 逐字取证）：
 *   - `ctx.inject(deps, cb)` 返回 **fiber**（可 `.dispose()`）；`ctx.effect(fn, label)` 返回 disposer；
 *   - `ctx.tools.register(definition)` 返回精确 disposer（fiber 归属）。
 *
 * ★ 0.1.7 变更（两处，均已实测 0.1.7 全树）：
 *   - `settings.installSection(owner, ns, schema, entry, hooks)` **已移除**（0.1.5 在
 *     `dsh-settings/lib/index.js:327`）。替代：`settings.configure({auto:false}, ctx.fiber)`
 *     + `ctx.on('loader/volatile-update')`（样板 `dsh-llm-deepseek/lib/index.js:2242-2264`）。
 *   - settings namespace 不再由插件自选，改取 loader 行 id（`dsh-settings/lib/index.js:432,443`），
 *     且**只投影 `.volatile()` 字段**（`lib/types/schema.js:43-53`）——见 `config/schema.js` 头注。
 *
 * 约束：本文件属于 packages/*​/src（CI ② 扫描范围）—— 不得出现裸进程出口字样。
 */
import { REGISTRY_STATES } from '../config/constants.js';
import { disabledSnapshot, readCostCatalog } from '../launch/cost-catalog.js';
// ★ 2026-10-02：原先在这里发布"成本快照"给共享目录里的成本路由器读（`publishCostSnapshot`）。
//   那个路由器（plugin-cost-router）与 cli-core 已随 CLI 方向一并退役 ⇒ 这条旁路**没有消费者**。
//   成本数据现在的真实来源是桌面端：`launch/desktop-models.js`（倍率）与 `launch/live-credits.js`（积分），
//   都在状态路由里直接回传，不再需要往磁盘上发快照。
import { makeRunTool } from './run.js';
import { makeStatusTool } from './status.js';

/**
 * @param {object} ctx 宿主 ctx（插件级）
 * @param {{ runtime: object, sessions: object, config: unknown, Config: object, NS: string, detect: Function }} deps
 *   ★ PRD-v4 B1 新增 `detect`：探测函数由 apply 注入——apply ③ 只在 enabled 时探测，
 *     "OFF 翻 ON"的首次探测补跑发生在本文件的 reconcile 里（探测函数不能再从本文件裸 import 一份，
 *     否则探测函数就有了两个来源，将来必然漂移）。
 * @returns {() => void} 卸载收敛器（注销工具 + 退订探测订阅 + dispose settings fiber）
 */
export function reconcileTools(ctx, { runtime, sessions, config, Config, NS, detect, credits = null, dispatch = null }) {
  // ★ H-REACTIVE：读响应式源，不是快照。若读快照，用户拨开关不会触发注销 ⇒ 假开关。
  // 走 runtime.currentConfig()（内含 0.1.7 volatile 包装器解包，见 plugin-cli-core/src/runtime.js）。
  const read = () => {
    const src = runtime.current();
    return typeof src === 'function' ? runtime.currentConfig() : src;
  };

  /** @type {Array<() => void>} */
  let disposers = [];

  const reconcile = () => {
    const cfg = read(); // 快照值：仅用于本次 want 判定

    const probe = runtime.detected();
    const installed = probe?.installed === true;
    // ★ PRD-v4 B1 补跑点：apply ③ 只在 enabled 时探测 ⇒ "OFF 翻 ON"后探测从未启动
    //   （probeArgs()===null 是"从未启动"的机器证据）。本回合补跑是异步的 ⇒ 仍走
    //   "未知乐观注册"，探测落地 onDetected 再次收敛 ⇒ 语义与 v3 的首轮竞态完全一致。
    if (cfg?.enabled === true && probe === null && runtime.probeArgs() === null && typeof detect === 'function') {
      void runtime.probe(detect, ctx, cfg);
    }
    // ★ 下发健康 C 组（关 LLM-GUIDE §5-21 的首轮竞态）：**未结论 ≠ 未安装**。
    //   旧判据 `enabled && installed` 把三态（未知 / 已装 / 未装）折成布尔 ⇒ 探测尚未落地时
    //   `installed` 读作 false ⇒ 这一回合**一个工具都不注册**，主控模型连"这里有个 WorkBuddy"都看不见
    //   （一次性/无头实例必现；长寿命 GUI 会话只是被"用户第一句话总在几秒之后"掩盖）。
    //   现在只在**真的未知**时乐观注册；探测一落地 `onDetected` 会再次收敛到这里 ⇒ 未装即注销。
    //   U4 未被放宽：**开关仍是硬闸**（`enabled !== true` ⇒ 永不注册），且 execute 侧另有 A4 短路。
    const want = cfg?.enabled === true && (probe === null ? true : installed);
    if (want && disposers.length === 0) {
      // 已装 + 开 ⇒ 注册两个模型工具（effect-scoped，随插件卸载自动移除）。
      // ★ P1-2：传入【读取器 read】（不是快照 cfg）——execute() 内以 cfg() 取【最新】配置。
      // ★ 原子性：注册非原子（第二次 register 可能抛：重名/ schema 非法）⇒ 半注册会让
      //   `disposers` 停留在 [] 而工具已挂上 ⇒ 之后 OFF 永远注销不掉（U4 被击穿）。
      //   故先收集到局部数组，任一失败即回滚已成功的注册，并落 DEGRADED 供 UI 看见。
      // ★ C 组（爆炸半径）：这里**不再 rethrow**。实测 `ctx.effect` 会把工厂内的同步异常原样上抛
      //   （cordis `lib/index.js:1248-1261`），而本函数的首次调用发生在 apply() 的同步回合内
      //   ⇒ 一句 throw 会让 ⑤ 状态路由与 ⑥ 提示词 section 都不再装配：别的插件只要占走
      //   `workbuddy_run` 这个名字，就能把本插件的状态卡片整个抹掉（用户从此无从得知为什么）。
      //   原因改由 `runtime.setRegistrationError()` 承载 ⇒ 四处可读（状态路由 / workbuddy_status / 系统提示 / GUI 卡片），
      //   且"不静默"由 DEGRADED + 该字段共同保证（旧写法的 throw 其实一次也没被任何人看见）。
      const next = [];
      try {
        next.push(ctx.tools.register(makeRunTool(runtime, sessions, read, ctx, credits ?? null, dispatch)));
        // sessions：状态工具要回传"可续接会话"（与状态路由同源）。
        next.push(ctx.tools.register(makeStatusTool(runtime, read, ctx, sessions, dispatch)));
      } catch (err) {
        for (const d of next) d();
        runtime.setRegistrationError(err instanceof Error ? err.message : String(err));
        runtime.setRegistry(REGISTRY_STATES.DEGRADED);
        publishCost(runtime, cfg); // DEGRADED 早退也要如实发布（不发布会让磁盘残留上一份 available:true 快照，硬闸位失真）
        return;
      }
      disposers = next;
      runtime.setRegistrationError(null);
      runtime.setRegistry(REGISTRY_STATES.REGISTERED);
    } else if (!want && disposers.length > 0) {
      // 关 / 未装 ⇒ 注销。★ 不 kill 在途作业（作业归 ctx.jobs 管；本函数不持有其句柄）。
      for (const d of disposers) d();
      disposers = [];
      runtime.setRegistrationError(null); // 注册期故障随注销一并作废（下次 want 会重试）
      runtime.setRegistry(afterUnregister(probe, installed));
    } else if (!want && disposers.length === 0 && probe !== null) {
      // 未注册的稳态收敛（设计原稿缺此分支 ⇒ S2「已装但 OFF」会永远停在 UNKNOWN，
      // 与 §4.4.1 的三态 UI 矛盾）。探测未完成时（probe === null）不落态 —— 不撒谎。
      runtime.setRegistrationError(null);
      runtime.setRegistry(afterUnregister(probe, installed));
    }
    publishCost(runtime, cfg);
  };

  /**
   * 成本快照发布（PRD-v4 A2：适配器 → 成本路由器的跨插件数据面）。
   * 每次收敛都重发（读取器无缓存、每次真读盘——量级是一次 statSync+小 JSON；小 JSON 原子写）——路由器读到的是**本次收敛的真相**。
   * `available` = 注册态是 REGISTERED（① 硬闸：关着/降级/未装的端再便宜也不进路由候选）。
   * ★ ①硬闸（对抗审查 BLOCKER#1 修复）：enabled!==true ⇒ **不读成本目录**，直接发关断快照
   *   （`disabledSnapshot()`）——"关了就是关了"包括目录读取本身，不是"读了但不用"。
   * 发布失败**必须**吞掉：它是旁路面，写不出快照 ⇒ 路由器按"无数据"处理（诚实未知），
   * 绝不能反过来炸掉工具注册。
   * @param {object} runtime
   * @param {unknown} cfg 本次收敛的生效配置（快照值，仅用于开关判定）
   */
  // ★ 已退役（原：把成本快照发布给共享目录供成本路由器读取）。那个消费者不存在了，
  //   保留它只会往用户磁盘上写一份没人读的文件 —— 那是"看起来在做事"，不是做事。
  function publishCost() { /* no-op：成本随状态路由直出，无旁路 */ }

  /**
   * 注销后的注册态：**未结论 ≠ 未安装**（★ C 组同一判据的落态侧）。
   * 旧表达式 `installed ? UNREGISTERED : NOT_INSTALLED` 在 C 组之前不可达出假（那时 want 只有在
   * 探测已落地后才可能为 true）；现在"探测在途期间被拨 OFF"同样会走到这里，而彼时 `installed`
   * 为 false 只是因为**还不知道** ⇒ 那一句"未安装"是假归因（用户会去查一个装得好好的 CLI）。
   */
  function afterUnregister(probe, installed) {
    if (probe === null) return REGISTRY_STATES.UNREGISTERED; // 只因开关/未知而注销，不冒充"查过且没有"
    return installed ? REGISTRY_STATES.UNREGISTERED : REGISTRY_STATES.NOT_INSTALLED;
  }

  // ★ 0.1.7 迁移（B1）：`settings.installSection()` 已从 dsh-settings 整体移除
  //   （0.1.7 全树零命中；0.1.5 在 `dsh-settings/lib/index.js:327`，有 14 个调用点）。
  //   0.1.7 改为**隐式发现**：namespace 取 loader 行 id（`lib/index.js:432,443` `ns: entry.options.id`），
  //   schema 取 `entry.fiber.runtime.Config`（`:539`）——插件导出 `Config` 即自动成为设置条目。
  //   官方迁移样板：`dsh-llm-deepseek/lib/index.js:2242-2244`。
  //   `auto:false` = 不自动生成设置页（本插件的页面由自己的 client 半边提供）。
  const settingsFiber = ctx.inject(['settings'], (sctx) => {
    sctx.effect(() => {
      sctx.settings.configure({ auto: false }, ctx.fiber);
      credits?.attach(sctx.settings);
    });
    // 响应式读源：0.1.7 里 volatile 字段就地更新并广播 `loader/volatile-update`
    // （cordis-plugin-loader/lib/index.js:380,400,612），据此喂给 runtime 并重新收敛。
    // 旧实现的 `setSource`/`onChange` 钩子已随 installSection 一并消失。
    sctx.effect(() => {
      // ★ 2026-09-27 真机修复（dsh-tauri / profile core-017，:3080）：
      //   读**本插件自己的** fiber，不是 `inject(['settings'])` 出来的子 fiber。
      //   真机读数（把观测字段临时挂进状态载荷读到，事后已撤）：`sctx.fiber.config` 的键集是
      //   **空的** `[]`，而 `ctx.fiber.config === apply` 收到的 config（sameObject=true）、
      //   9 个键齐全、且 `setSource` 执行**之前** `currentConfig()` 读到 `enabled=true` 与
      //   6 档 effortValues。⇒ 这行把一个本来正确的响应式源换成了 `{}`。
      //   后果链：源变 `{}` ⇒ reconcile 判 `enabled !== true` ⇒ U4 注销工具 ⇒ registry 落
      //   UNREGISTERED，界面读数 `models:[] / modelsSource:'disabled'`。**重启无效**（config 是
      //   开机时定的），所以表现为"开关明明是开的，后台就是没跑"。
      //   官方样板同款：`dsh-llm-deepseek/lib/index.js:2243` 传的是外层 `ctx.fiber`；
      //   本文件上一行 `settings.configure({auto:false}, ctx.fiber` 也是外层 —— 原本的不一致即缺陷。
      //   ★ 有效对照必须**在会复现的 profile 上做**：早先在正常 profile 上做的反向对照"没变红"，
      //   那是无效对照（症状在那儿不出现），据此险些把本修复当成无效而撤回。
      runtime.setSource(() => ctx.fiber?.config);
      reconcile();
      // ★ 2026-09-28：原来这里是"积分锚点锁定"（`credits.checkLock()`，改总额就回退）。
      //   手填锚点已退役 —— 余额现在真值直读（launch/live-credits.js），没有可被改错的锚点。
      return sctx.on('loader/volatile-update', () => {
        reconcile();
      });
    }, `${NS}: config source`);
  });
  // 退订句柄必须保留：若插件卸载后仍有在途探测完成，无退订会向已卸载的 ctx 注册工具。
  const offDetected = runtime.onDetected(reconcile);

  return () => {
    offDetected();
    for (const d of disposers) d();
    disposers = [];
    void settingsFiber?.dispose?.();
  };
}
