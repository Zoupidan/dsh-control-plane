#!/usr/bin/env node
/**
 * 红线 ⑤（PRD-v4 E1 + E2）—— 凭据零回显 + 探测不计费。
 *
 * Implements: 01-prd/PRD-v4-cost-routing.md §5.2（凭据零回显）/ §5.1（探测不得产生费用）
 *
 * E1（静态面）：扫 packages 各插件 src + lib（约去反引号）（与 CI ② 同一扫描面 —— 载荷、卡片文案、
 *   lastRun 记录全部产自这两棵树），命中以下形状即 FAIL：
 *     - `sk-` 开头的 key 形状
 *     - `Bearer ` 后跟长 token
 *     - `eyJ` 开头（JWT 三段式的首段固定前缀）
 *     - 40+ 位连续 hex（ sha256/AES 块/API key 的常见落盘形状）
 *   静态扫描**证明不了**数据流（"这行字符串进了 payload"是运行时事实），它钉住的是：
 *   源码里根本不许出现这些字面形状 —— 适配器解析凭据文件时只许取 PRD §4.1 的非敏感字段，
 *   一旦有人把敏感值抄进任何源码字面量/模板/默认值，这道闸当场拦下。
 *   运行时面的同一承诺由各适配器的取字段纪律 + 本文件 E2 段的调用面审计共同兜底。
 *
 * E2（调用面审计）：`modelCatalog()` / 成本读取路径（cost-*.js / model-catalog.js / cli-models.js）
 *   **不得**出现进程出口或网络字样 —— 成本识别是只读动作（PRD §6 能力 2），任何
 *   `subprocess / child_process / spawn / exec / fetch / http` 出现在这些文件里都说明
 *   有人把"读目录"改成了"打请求"，而 B 档探测式（唯一被授权的计费动作）只许住在
 *   显式命名的 costProbe 路径并记入成本账本（§5.1 例外条款的四个条件缺一即违规）。
 *
 * fail-closed：扫不到任何文件 ⇒ FAIL（"没扫到东西"不构成红线自证 —— 本仓铁律）。
 * 豁免：行内令牌 `// check-no-credential-echo: allow`（必须整词，且该行同时命中形状才豁免）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALLOW_TOKEN = 'check-no-credential-echo: allow';

/** E1 形状表：`[名字, 正则, 人话]` —— 全部带长度下界，压掉误报（如 `Bearer` 出现在错误措辞里）。 */
const ECHO_PATTERNS = [
  ['api-key-shape', /sk-[A-Za-z0-9_-]{16,}/, 'sk- 开头的 API key 形状'],
  ['bearer-shape', /Bearer\s+[A-Za-z0-9._-]{16,}/, 'Bearer 长令牌'],
  ['jwt-shape', /eyJ[A-Za-z0-9_-]{16,}/, 'JWT（eyJ 前缀）'],
  ['long-hex', /[a-fA-F0-9]{40,}/, '40+ 位连续 hex（key/摘要的落盘形状）'],
];

/** E2 调用面：成本/目录读取文件里禁止出现的执行通道字样。
 * 审查 MEDIUM#9：纯文件名约定会漏（core 的 cost/ 目录六个文件、路由器的 facts.js 都不叫 cost*.js）
 * ⇒ 目录段（任何名为 cost 的目录之下）与文件名段（cost 前缀 / facts / model-catalog / cli-models / summary-json）双认。
 * 注意：spend-probe（A3 的授权计费路径）**刻意不在此列** —— 它就是被 §5.1 例外条款授权的那个 * "会花钱"的文件，E2 审它的是 modelCatalog 路径，不是它。 */
const COST_FILES = /[\\/]cost[\\/]|(^|[\\/])(cost|facts|model-catalog|cli-models|summary-json)[A-Za-z0-9.-]*\.js$/;
const EXEC_PATTERNS = [
  ['subprocess', /\bsubprocess\b/],
  ['child_process', /child_process/],
  ['spawn-call', /\bspawn\s*\(/],
  ['exec-call', /(?<!\.)\bexec(?:Sync)?\s*\(|(?<!\.)\bexecFile(?:Sync)?\s*\(/],
  ['network-call', /\bfetch\s*\(|\bhttp\.\b|\bhttps\.\b|XMLHttpRequest/],
];

function* walk(dir) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(p);
    else if (/\.(js|mjs|cjs)$/.test(name)) yield p;
  }
}

function collectSources() {
  const packagesDir = join(ROOT, 'packages');
  const files = [];
  let havePackages = false;
  for (const name of readdirSync(packagesDir)) {
    const pkg = join(packagesDir, name);
    if (!statSync(pkg).isDirectory()) continue;
    havePackages = true;
    for (const sub of ['src', 'lib']) {
      for (const f of walk(join(pkg, sub))) files.push(f);
    }
  }
  return { files, havePackages };
}

/** @returns {{ file: string, line: number, rule: string, why: string }[]} */
function scanEcho(files) {
  const hits = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      for (const [rule, re, why] of ECHO_PATTERNS) {
        if (re.test(line) && !line.includes(ALLOW_TOKEN)) {
          hits.push({ file, line: i + 1, rule, why });
        }
      }
    }
  }
  return hits;
}

/**
 * ★★★ E3（2026-09-27 新增）：凭据**通道**闸。E1 拦的是"源码里写了凭据字面量"，
 * 而真正的泄漏面是**运行时把一个凭据值送到不该去的地方**。三条通道，按危险度排：
 *
 *   ① **argv** —— Windows 上 `Get-CimInstance Win32_Process` 让**本机任何进程**读到完整命令行；
 *      且本插件会把 argv 写进 `lastRun.argvPreview`，那是**模型可见**的状态载荷
 *      （`workbuddy_status` / 作业输出都能读到）。⇒ 凭据进 argv = 同时泄给本机与模型上下文。
 *   ② **显式 env** —— `dsh-subprocess` 在 spawn 前对父环境做 scrub
 *      （`SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i` + 一切 `DSH_`），
 *      所以 `CODEBUDDY_API_KEY` 这类变量**默认到不了子进程**。但 spec 的**显式 `env` 会在 scrub 之后合并**
 *      （该文件注释原文："a deliberately forwarded credential … goes through the spec's explicit `env`"）——
 *      **这正是官方给的出口，也正是最容易被误用的一扇门**。⇒ 一旦有人开始传显式 env，
 *      就必须在这里登记：凭证从哪来、为什么不走 argv、怎么保证不落盘/不进日志。
 *   ③ **状态载荷 / 作业输出** —— 已被 E1 的字面量闸部分覆盖（形状层面），运行时面靠各模块的脱敏纪律。
 *
 * 本闸的取向：**默认全禁 + 显式登记放行**，与 `inert-knobs.js` 同一套纪律（不许"沉默地开着"）。
 */

/** E3a：argv 构造面。凭据标识符出现在这里 = 它会随 argv 泄给本机与模型。 */
const ARGV_BUILDING_FILE = /[\\/]launch[\\/]argv\.js$/;
/** 凭据标识符（camelCase 拼法；`Bearer` 这类**脱敏规则里的字面量**由"必须同处 argv 位置"这条约束排除）。 */
const CREDENTIAL_IDENT = /\b\w*(?:apiKey|ApiKey|authToken|AuthToken|accessToken|AccessToken|bearerToken|clientSecret|ClientSecret|sessionSecret|password|passwd)\b/;
/** 真正的 argv 位置：只有把值**推进命令行**才算泄漏通道。 */
const ARGV_POSITION = /argv\.push\(|argv\s*=\s*\[|argv\.unshift\(/;
/** 纯注释行（块注释的 `*` 行、行注释）——注释里提到 env/argv 是设计说明，不是通道。 */
const COMMENT_LINE = /^\s*(?:\*|\/\/|\/\*)/;
/** ★ E3c（2026-09-27）：**任务下发面禁止 import 凭据仓**。
 *
 * 主理人定的模块边界：**积分获取 / 任务下发 / 任务验收是三条独立通路。**
 * 曾一度把凭据出口接到 `tools/run.js` 的 spawn env 上（同日撤销）—— 那让插件持有账号凭据并
 * 替用户发起调用，是事实上的**凭据代理**，与"看一眼剩余积分"毫无关系，且一旦外泄不可撤回。
 *
 * 本条把那条边界变成机器强制：`tools/**` 不得 import `auth/credential.js`。
 *
 * ★ 2026-09-27 现状：该模块**已随凭据设施一起删除**（积分余额读不到，且不值得为它把账号凭据
 *   交给插件）。本条因此是一条**前向守卫**——今天不匹配任何真实文件，但自检样本证明它一旦有人
 *   重建那个模块并接进下发面就会响。删掉它 = 放弃这条边界，别删。 */
const CREDENTIAL_MODULE = /[\\/]auth[\\/]credential\.js$/;
const DISPATCH_FACE = /[\\/]tools[\\/]/;
/** 显式 env 覆写的判据。`env:` 之后**不是**字符串/模板字面量（`'env:inline'` / `` `env:path:${p}` ``
 * 是本仓自己的**来源标签**，不是通道；`process.env` 的读法没有冒号，也不会命中）。
 * ★ 单一来源：self-test 也调它 —— 复制一份判据的 self-test 会在判据改动后静默失效。 */
const ENV_OVERRIDE_SHAPE = /(?:^|[^'"`\w])env\s*:\s*(?!['"`])/;
/** 登记表键统一成正斜杠相对路径（扫描出来的是平台原生分隔符，不归一会永远登记不上）。 */
const relKey = (file) => file.replace(ROOT + '\\', '').replace(ROOT + '/', '').replaceAll('\\', '/');

/** E3b：显式 `env` 覆写登记表。**当前为空** —— 没有任何插件需要转发凭据。
 *  真要加时：key = 相对仓库根的文件路径，value = 非空理由（写清凭证来源 / 为何不走 argv / 如何不落盘）。
 *  删登记前请先证明那条通道已经不需要了。 */
/** E3b：显式 `env` 覆写登记表。**当前只有 zcode 一条**（文件路径，非凭据）。
 *  ⚠ 2026-09-27 曾有第二条（workbuddy 的会话凭据转发），**同日撤销**：那让插件持有账号凭据并
 *  替用户发起调用，是事实上的凭据代理，与"只读积分查询"无关。删除即表示该通道已收回。 */
const ENV_OVERRIDE_REGISTER = new Map([
  [
    'packages/plugin-zcode/src/host/tools/run.js',
    '旁路 provider 配置的**文件路径**（ZCODE_BUILTIN_PROVIDER_CONFIG_FILE / '
    + 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE），不是凭据：值来自 statSync 探测到的真实路径，'
    + '缺失的那半个不合并并记 notSent(provider_config_missing)。键名不含 KEY/TOKEN/SECRET，'
    + '本就不被 dsh 的 scrub 拦；此处显式传只是为了让 scrub 后的子进程拿到它们。'
    + '⚠ 若将来要把**任何凭据**加进这个 env，必须先另开一条登记并单独评审 —— 不得 piggyback。',
  ],
]);

/** @returns {{ file: string, line: number, rule: string, why: string }[]} */
function scanCredentialChannels(files) {
  const hits = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const rel = relKey(file);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.includes(ALLOW_TOKEN)) continue;
      if (COMMENT_LINE.test(line)) continue;   // 注释里的 env/argv 是设计说明，不是通道
      if (ARGV_BUILDING_FILE.test(file) && ARGV_POSITION.test(line) && CREDENTIAL_IDENT.test(line)) {
        hits.push({
          file, line: i + 1, rule: 'argv-channel',
          why: '凭据值被推进 argv —— 会同时泄给本机进程列表（Get-CimInstance Win32_Process）与模型可见的 lastRun.argvPreview',
        });
      }
      // 显式 env：判据是 `env:` 后**不是字符串字面量**（`'env:inline'` / `` `env:path:${p}` `` 这类
      // 是本仓自己的来源标签，不是通道；`process.env` 读法没有冒号，也不会命中）。
      if (ENV_OVERRIDE_SHAPE.test(line) && !ENV_OVERRIDE_REGISTER.has(rel)) {
        hits.push({
          file, line: i + 1, rule: 'env-channel',
          why: '出现显式 env 覆写（dsh 的 scrub 之后合并 ⇒ 等于绕过凭据剥离）；要转发必须在 ENV_OVERRIDE_REGISTER 写明理由',
        });
      }
      // E3c：任务下发面（tools/）不得引用凭据仓
      if (DISPATCH_FACE.test(file) && /from\s+['"][^'"]*auth[\\/]credential\.js['"]/.test(line)
        && !line.includes(ALLOW_TOKEN)) {
        hits.push({
          file, line: i + 1, rule: 'dispatch-credential-import',
          why: '★ 任务下发面（tools/）不得 import 凭据仓 —— 积分获取/任务下发/任务验收是三条独立通路；'
            + '在 tools/ 侧引用凭据 = 让插件持有账号凭据并替用户发起调用（凭据代理）',
        });
      }
    }
  }
  return hits;
}

/** @returns {{ file: string, line: number, rule: string, why: string }[]} */
function scanExecInCostPaths(files) {
  const hits = [];
  for (const file of files) {
    if (!COST_FILES.test(file)) continue;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      for (const [rule, re] of EXEC_PATTERNS) {
        if (re.test(lines[i]) && !lines[i].includes(ALLOW_TOKEN)) {
          hits.push({ file, line: i + 1, rule });
        }
      }
    }
  }
  return hits;
}

function fmt(hits) {
  return hits
    .map((h) => `  [${h.rule}] ${h.file.replace(ROOT + '\\', '').replace(ROOT + '/', '')}:${h.line}${h.why ? ` —— ${h.why}` : ''}`)
    .join('\n');
}

function run() {
  if (process.argv.includes('--self-test')) return selfTest();
  const { files, havePackages } = collectSources();
  if (!havePackages || files.length === 0) {
    console.error('FAIL check-no-credential-echo: 扫描面为空（packages/*/src+lib 零文件）—— fail-closed');
    return 1;
  }
  const echoHits = scanEcho(files);
  const execHits = scanExecInCostPaths(files);
  const channelHits = scanCredentialChannels(files);
  if (echoHits.length > 0 || execHits.length > 0 || channelHits.length > 0) {
    console.error(`FAIL check-no-credential-echo: ${echoHits.length} 处凭据形状 + ${execHits.length} 处成本路径执行通道 + ${channelHits.length} 处凭据通道\n${fmt([...echoHits, ...execHits, ...channelHits])}`);
    return 1;
  }
  console.log(`PASS check-no-credential-echo: ${files.length} 个文件零凭据形状；成本路径零执行/网络通道；argv/env 零凭据通道（E1+E2+E3，env 登记表 ${ENV_OVERRIDE_REGISTER.size} 条）`);
  return 0;
}

/** 自检：违规样本必须 FAIL，干净样本必须 PASS（M0 对照 + 正向对照，同 CI②③ 的门禁纪律）。 */
function selfTest() {
  const samples = [
    { name: 'sk-key 样本', text: "const k = 'sk-abc123def456ghij789';", bad: true },
    { name: 'Bearer 样本', text: 'const h = "Bearer abc123def456ghijklmnop";', bad: true },
    { name: 'JWT 样本', text: "const t = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';", bad: true },
    { name: '长 hex 样本', text: "const id = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';", bad: true },
    { name: '豁免令牌样本', text: `const s = 'sk-abc123def456ghij789'; // ${ALLOW_TOKEN}（文档示例）`, bad: false },
    { name: '干净文件样本', text: 'export const factor = 0;', bad: false },
    { name: '短 hex 不误伤', text: 'const rev = "a1b2c3d4";', bad: false },
    // E2：成本路径出现 spawn 必须红；普通文件出现 spawn（如 tools/run.js 不在本扫描）不在本闸语义内
    { name: '成本文件含 spawn', text: 'const h = ctx.subprocess.spawn({})', bad: true, costFile: true },
    { name: '成本文件含 fetch', text: 'const r = await fetch(url)', bad: true, costFile: true },
    { name: '成本文件纯读盘', text: "import { readFileSync } from 'node:fs';", bad: false, costFile: true },
    { name: '正则 .exec 不误伤', text: 'const m = /^x(\\d+)?$/.exec(v);', bad: false, costFile: true },
    // E3：通道闸（凭据**值**的去处，字面量闸看不见的正是这一面）
    { name: 'E3 argv 位置出现凭据值', text: 'argv.push(cfg.apiKey);', bad: true, argvFile: true },
    { name: 'E3 argv 位置出现 accessToken', text: "const v = 'x'; argv.unshift(config.accessToken);", bad: true, argvFile: true },
    { name: 'E3 显式 env 覆写未登记', text: 'const h = ctx.subprocess.spawn({ argv, env: childEnv });', bad: true },
    { name: 'E3 脱敏正则不算通道', text: 'const S = /(api[-_]?key|token|secret|password)/i;', bad: false, argvFile: true },
    { name: 'E3 argv 文件里的非 argv 位引用', text: 'const keyId = entry.keyId; // 非凭据', bad: false, argvFile: true },
    { name: 'E3 来源标签 env:inline 不算通道', text: "tried.push({ label: 'env:inline' });", bad: false },
    { name: 'E3 模板串 env:path 不算通道', text: 'sourceRef = `env:path:${p}`;', bad: false },
    { name: 'E3 注释里提 env 不算通道', text: ' * SubprocessSpawnSpec.env 明确支持', bad: false },
    { name: 'E3 读 process.env 不算通道', text: 'const e = process.env;', bad: false },
    // E3c：任务下发面不得引用凭据仓
    { name: 'E3c tools/ 引用凭据仓', text: "import { credentialEnv } from '../auth/credential.js';", bad: true, dispatch: true },
    { name: 'E3c 非 tools/ 引用凭据仓（余额探测允许）', text: "import { hasCredential } from '../auth/credential.js';", bad: false },
  ];
  let failed = 0;
  for (const s of samples) {
    const echoHits = ECHO_PATTERNS.filter(([, re]) => re.test(s.text) && !s.text.includes(ALLOW_TOKEN));
    const execHits = s.costFile === true ? EXEC_PATTERNS.filter(([, re]) => re.test(s.text)) : [];
    const channelHits = [];
    if (!s.text.includes(ALLOW_TOKEN) && !COMMENT_LINE.test(s.text)) {
      if (s.argvFile === true && ARGV_POSITION.test(s.text) && CREDENTIAL_IDENT.test(s.text)) {
        channelHits.push({ rule: 'argv-channel' });
      }
      if (ENV_OVERRIDE_SHAPE.test(s.text) && !ENV_OVERRIDE_REGISTER.has('samples')) {
        channelHits.push({ rule: 'env-channel' });
      }
      if (s.dispatch === true
        && /from\s+['"][^'"]*auth[\\/]credential\.js['"]/.test(s.text)) {
        channelHits.push({ rule: 'dispatch-credential-import' });
      }
    }
    const hit = echoHits.length > 0 || execHits.length > 0 || channelHits.length > 0;
    if (hit !== s.bad) {
      console.error(`FAIL self-test: ${s.name} —— 期望 ${s.bad ? 'FAIL' : 'PASS'}，实际 ${hit ? 'FAIL' : 'PASS'}`);
      failed += 1;
    }
  }
  if (failed > 0) {
    console.error(`FAIL self-test: ${failed} 例不符`);
    return 1;
  }
  console.log(`PASS self-test: ${samples.length} 例（含哨兵可分辨的正向对照与豁免令牌对照）`);
  return 0;
}

process.exit(run());
