/**
 * ★★ `ensure()` 的失败码 → 插件 reason code 的映射，别再压成一个兜底桶 ★★
 *
 * <p>★ 这条映射以前根本不存在 ★★
 * 2026-09-30 之前，`dispatch.js` 里 `ensure()` 失败只有一条路：
 * `fail(GATEWAY_REASON.no_sidecar, …)`，而 `GATEWAY_REASON.no_sidecar` 就是
 * `REASON_CODES.TRANSPORT_UNREACHABLE`。于是**四种处置完全不同的失败**长得一模一样：
 *
 * <pre>
 *   用户自己点了取消            → 报「传输不可达」：把自己的取消写成环境故障
 *   桌面端没装 / 拉不起 / 没就绪 → 报「传输不可达」：让他去查网络
 *   读不到本机 IPC 口令          → 报「传输不可达」：该去登录或重启桌面端
 *   真的没有可用 sidecar         → 报「传输不可达」：唯一报对的一种
 * </pre>
 *
 * <p>★ 为什么不新造 reason code ★★
 * `REASON_CODES` 是既有枚举，状态区与 availability 都按它渲染；新增一个码要连带改渲染，
 * 比"从已有码里挑对的那个"贵得多。而 `ABORTED` / `START_FAILED` / `AUTH_FAILED`
 * **本来就在枚举里**，只是从来没被用上。
 *
 * <p>★ 判据能读到什么，取决于上游修没修 ★★
 * 这条映射读 `instance.sidecar.refused`。`projectInstance` 此前只认 `{code}` 对象，
 * 而 `runOnce` 写的是**字符串**，于是真机上这个字段**恒为 `'unknown'`** ——
 * 映射写得再对也认不出 `token_unavailable`。那个形状修复是本测试能成立的前提。
 *
 * @module test/gateway-reason-mapping
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { gatewayReasonForInstance } from '../src/host/gateway/dispatch.js';
import { REASON_CODES } from '../src/host/launch/reason-codes.js';

/** `ensure()` 的 `projectInstance()` 产物。字段只留映射真正读到的那些。 */
function instance(overrides = {}) {
  return {
    code: 'no_usable_sidecar',
    waitedMs: 0,
    wait: null,
    sidecar: { scanned: 0, picked: 0, refused: null },
    ...overrides,
  };
}

test('★★ 用户自己取消 ⇒ aborted（此前报 transport_unreachable，把取消写成环境故障）', () => {
  assert.equal(
    gatewayReasonForInstance(instance({ code: 'aborted' })),
    REASON_CODES.ABORTED,
  );
});

test('★★ 取消优先于一切：即使同时报了 sidecar 不可用，也必须是 aborted', () => {
  // ★ 顺序不能反。这两个字段在真机上**同时**为真是可能的（取消时那一轮恰好没扫到 sidecar）。
  //   谁先判谁赢：用户说"我取消了"，界面就该说"已取消"，不该说"你的环境有问题"。
  assert.equal(
    gatewayReasonForInstance(instance({ code: 'aborted', sidecar: { refused: 'token_unavailable' } })),
    REASON_CODES.ABORTED,
  );
});

test('★★ 读不到本机 IPC 口令 ⇒ auth_failed（该去登录/重启桌面端，不是查网络）', () => {
  assert.equal(
    gatewayReasonForInstance(instance({ code: 'no_usable_sidecar', sidecar: { refused: 'token_unavailable' } })),
    REASON_CODES.AUTH_FAILED,
  );
});

test('★★ 桌面端起不来 ⇒ start_failed', () => {
  // ★ 2026-10-10：`desktop_probe_failed` 已随 tasklist 进程出口清理删除 —— 没有进程枚举
  //   就没有"枚举失败"这一态了。剩下的三个仍然成立。
  for (const code of ['desktop_not_ready', 'desktop_launch_failed', 'desktop_not_installed']) {
    assert.equal(
      gatewayReasonForInstance(instance({ code })),
      REASON_CODES.START_FAILED,
      `${code} 必须报 start_failed`,
    );
  }
});

test('★★ 真的没有可用 sidecar ⇒ 维持 transport_unreachable（零回归）', () => {
  for (const code of ['no_usable_sidecar', 'no_sidecar_appeared']) {
    assert.equal(
      gatewayReasonForInstance(instance({ code })),
      REASON_CODES.TRANSPORT_UNREACHABLE,
      `${code} 必须维持旧行为`,
    );
  }
});

test('★★ 全被占用（all_busy）不是认证问题 ⇒ 维持 transport_unreachable', () => {
  // ★ 负控：`auth_failed` 只对 `token_unavailable` 成立。`all_busy` 的处置是"关掉占用中的会话"，
  //   报成"去登录"会把人指向完全错误的动作。
  for (const refused of ['all_busy', 'busy_running', 'probe_unreachable', null, undefined]) {
    assert.equal(
      gatewayReasonForInstance(instance({ code: 'no_usable_sidecar', sidecar: { refused } })),
      REASON_CODES.TRANSPORT_UNREACHABLE,
      `refused=${String(refused)} 不得被当成认证问题`,
    );
  }
});

test('★★ instance 缺席或形状不对时不得抛错，退回兜底码', () => {
  // ★ 投影链路任何一环缺席都可能给出 undefined。让它抛，等于把一个"读数缺失"升级成崩溃。
  for (const bad of [undefined, null, {}, { code: null }, { code: 'no_sidecar_appeared' }]) {
    assert.equal(gatewayReasonForInstance(bad), REASON_CODES.TRANSPORT_UNREACHABLE);
  }
  // ★ 2026-10-10：已删除的 `desktop_probe_failed` **不再是** start_failed ——
  //   它现在落进兜底桶而不是静悄悄地继续映射到一个不存在的处置上。
  //   这防止"删了码但映射留着"这种漂移：映射与 ENSURE_CODE 必须同步。
  assert.equal(
    gatewayReasonForInstance(instance({ code: 'desktop_probe_failed' })),
    REASON_CODES.TRANSPORT_UNREACHABLE,
  );
});

test('★★ 映射结果必须**全部**是既有枚举里的值（防止有人新造码）', () => {
  // ★ 这条是整份测试的"不许跑偏"锁：`REASON_CODES` 的形态一旦变了（改成对象、
  //   改成集合），Object.values 就不再是码表，测试会**真的红**，而不是静默通过。
  const known = new Set(Object.values(REASON_CODES));
  for (const code of ['aborted', 'no_usable_sidecar', 'no_sidecar_appeared', 'desktop_not_ready', undefined]) {
    const got = gatewayReasonForInstance(instance({ code, sidecar: { refused: 'token_unavailable' } }));
    assert.ok(known.has(got), `映射产出了枚举外的码：${String(got)}`);
  }
});

test('★★ 续等账（waitedMs / continuedWait / waitWindowMs）走顶层，不塞进 sidecar', () => {
  // ★ 投影形状断言：这三个是**新增的顶层键**。
  //   塞进 `sidecar` 里会污染"扫到了什么"的语义 —— waitedMs 跟扫了几台机器毫无关系。
  const projected = instance({
    code: 'no_sidecar_appeared',
    waitedMs: 600_000,
    wait: { firstWindowMs: 30_000, totalWaitMs: 600_000, continued: true, polls: 144 },
  });
  assert.equal(projected.waitedMs, 600_000);
  assert.equal(projected.wait.continued, true);
  assert.equal(projected.wait.totalWaitMs, 600_000);
  // ★ 负控要打在**没走等待段**的那个投影上，不是打在上面那个 —— 拿 populated 对象去断言
  //   "waitedMs 是 undefined" 只会自相矛盾。首次写这条就是这么栽的，测试当场把自己抓住。
  const bare = instance({ code: 'no_usable_sidecar' });
  assert.equal(bare.wait, null, '没走等待段时 wait 应为 null');
  assert.equal(bare.wait?.continued, undefined, '没走等待段时不得声称走过续等');
});
