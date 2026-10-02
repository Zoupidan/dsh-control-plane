// 测试套件的「真库护栏」★ 2026-10-01（被漏了两次之后才补上）
//
// 为什么必须做在套件级，而不是「每个测试各自小心」：
// 事故已经发生过两次，形态不同 ——
//   ① test/hardening.test.js 的 boot() 忘了钉 transport ⇒ 每跑一次 test:host 就往用户
//      真机库里插一行真计划任务（prompt 恰好叫 'ping'）。
//   ② test/subagent-execute.test.js 测执行口时忘了注入点火函数 ⇒ 那几轮直接调了真的
//      startAutomationRun()，在用户的 WorkBuddy 里建了三条真对话。
//
// 两次的共同根因不是「忘了注入」，而是：只要套件进程里 WORKBUDDY_HOME 指着真家目录，
// 任何一处疏漏都等于往用户的 WorkBuddy 里写东西。而「每个测试都记得注入」无法靠自觉保证。
//
// 做法：把整套测试的 WORKBUDDY_HOME 指向一次性临时目录。automation.js 的 workbuddyHome()
// 本来就优先读这个环境变量（它为多 profile 留的缝）。于是任何测试即使漏了注入、
// 即使真的点了火，写进去的也是临时目录 —— 真库结构上不可能被碰。
//
// 与既有守卫的关系（两者都要，不是二选一）：
//   - 本文件：结构上让真库不可能被写（第一道、兜底）。
//   - test/automation-home-guard.test.js：观测真库行数并在被写时立刻红（第二道、能报警）。
//   前者防事故，后者防「防线本身失灵」。
//
// 用法：node --import ./tools/dev/test-home-guard.mjs --test ...（已进 npm run test:host）
// 约束：本文件在 tools/ 下（不在 packages/*/src），不受 C2/C3/进程出口扫描约束；
//       它只设环境变量，不读凭据、不起进程。

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 已经有人设过了（例如某个测试显式指定夹具）⇒ 不覆盖，让那个更具体的设置赢。
if (typeof process.env.WORKBUDDY_HOME !== 'string' || process.env.WORKBUDDY_HOME === '') {
  process.env.WORKBUDDY_HOME = mkdtempSync(join(tmpdir(), 'wb-test-home-'));
}

// 给 test/automation-home-guard.test.js 的自查用：告诉它「套件级护栏已生效」。
process.env.WORKBUDDY_TEST_HOME_GUARD = 'on';

// 只在第一次导入时打一行；--test 给每个测试文件独立进程，各自打一行会刷屏。
if (process.env.WORKBUDDY_TEST_HOME_QUIET !== '1') {
  process.env.WORKBUDDY_TEST_HOME_QUIET = '1';
  console.error('[test-home-guard] WORKBUDDY_HOME=' + process.env.WORKBUDDY_HOME
    + ' (the real ~/.workbuddy is unreachable from this suite)');
}