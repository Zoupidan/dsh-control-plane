/**
 * @file Track A 追发调度器 + run.js 接线（★ M2 多轮追发；真机校准版）。
 *
 * <p>★ 本文件只碰假 CDP（真实 OS TCP 回环 + 手写 RFC6455 最小帧）+ 内存记性，绝不触真机 ★
 * 套件级护栏（`WORKBUDDY_TEST_HOME_GUARD` + 落点非真库）与 `multi-turn-reuse.test.js` 同款。
 * fake CDP 按 **真机证据固定契约**（00-recon/evidence/CDP-LIVE-20261003/，LIVE-VERIFIED）：
 *   - /json/version 带 User-Agent（含 WorkBuddy/5.6.2 + Electron/…）—— Browser 只是 "Chrome/138…"；
 *   - runPrompt 回执 `{clientRequestId, requestId, state:'completed', content:ContentBlock[],
 *     artifacts:[], responseModel:{id}}`（state 非 status、content[] 非 output、无 turnCount/usage）；
 *   - 跨桥错误以 `{__wbError:true, message, code}` 返回值带回（不 throw）。
 *
 * <p>覆盖面：
 *   - dispatcher 单元面：成功路径（state/content/raw/evaluate 形状 + context 传 {}）、
 *     裸字符串 prompt 拒绝、CDP 关闭、UA/target 双证据判别两侧、超时、桥缺失、
 *     __wbError 三分支（NOT_FOUND/CLOSED/未映射 catch-all）、非 completed state。
 *   - run.js 接线面：开关关 ⇒ followUp 一次都不被调（spy 断言）、成功 ⇒ touch + resumed:true、
 *     失败 ⇒ forget(指纹码) → 点火 顺序正确 + fallback 回执、resume 省略不追发、
 *     resume:true 无记性仍报错。
 *
 * @module test/followup-dispatcher
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { makeRunTool } from '../src/host/tools/run.js';
import { workbuddyDbPath } from '../src/host/gateway/automation.js';
import {
  createFollowUpDispatcher,
  packageContentBlocks,
  FOLLOWUP_CODES,
} from '../src/host/followup/dispatcher.js';

const REAL_DB = join(homedir(), '.workbuddy', 'workbuddy.db');

/** 真机 /json/version 的 User-Agent 形状（EVIDENCE-CDP-LIVE-20261003 §2 逐字）。 */
const LIVE_UA_WORKBUDDY = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) WorkBuddy/5.6.2 Chrome/138.0.7204.251 Electron/37.10.3 Safari/537.36';
/** 外部 Chrome 的 UA（无 WorkBuddy/ 身份）—— UA 侧判别的负样本。 */
const LIVE_UA_PLAIN_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/138.0.7204.251 Safari/537.36';

/* ───────────────────────── fake CDP（真实 TCP 回环 + 最小 6455 帧） ───────────────────────── */

/**
 * 精简版 EphemeralCdpServer（探针同思路重写，回执按**真机形状**）：
 *   - `/json/version` 返回 Browser + User-Agent（均可配）；
 *   - `/json/list` 返回可配的目标表（缺省 = WorkBuddy 指纹 target）；
 *   - `upgrade` 完成 RFC6455 握手，`Runtime.evaluate` 按可配处理器回帧
 *     （缺省 = 桥存在 + runPrompt 回真机形状 completed 回执）。
 * 端口 0 真实绑定 ⇒ 无端口冲突；`evaluations` 记录每次收到的 evaluate（表达式 + params）。
 */
class FakeCdpServer {
  /**
   * @param {object} [opts]
   * @param {string} [opts.browser] /json/version 的 Browser 字段。
   * @param {string} [opts.userAgent] /json/version 的 User-Agent 字段（判别证据①）。
   * @param {Array<object>|((port: number) => Array<object>)} [opts.targets] /json/list 目标表。
   * @param {(expr: string, reply: (value: object) => void) => void} [opts.onEvaluate]
   *        evaluate 处理器；`reply(value)` 以 CDP 形状回帧。缺省 = 桥存在 + runPrompt 回真机形状。
   */
  constructor({
    browser = 'Chrome/138.0.7204.251',
    userAgent = LIVE_UA_WORKBUDDY,
    targets = null,
    onEvaluate = null,
  } = {}) {
    this.browser = browser;
    this.userAgent = userAgent;
    this.targets = targets;
    this.onEvaluate = onEvaluate;
    /** @type {Array<{expression: string, params: object}>} */
    this.evaluations = [];
    this.server = null;
    this.port = 0;
  }

  wbTarget(port) {
    return {
      id: 'target-wb-renderer-01',
      title: 'WorkBuddy',
      type: 'page',
      url: 'file:///C:/Program%20Files/WorkBuddy/resources/app.asar/renderer/index.html?locale=zh-CN',
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/target-wb-renderer-01`,
    };
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        if (req.url === '/json/version') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            Browser: this.browser,
            'Protocol-Version': '1.3',
            'User-Agent': this.userAgent,
            'V8-Version': '13.8.258.32',
          }));
          return;
        }
        if (req.url === '/json/list') {
          const table = typeof this.targets === 'function' ? this.targets(this.port) : (this.targets ?? [this.wbTarget(this.port)]);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(table));
          return;
        }
        res.writeHead(404);
        res.end();
      });
      this.server.on('upgrade', (req, socket) => this.handleUpgrade(req, socket));
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
      this.server.on('error', reject);
    });
  }

  /** RFC6455 握手 + 最小帧解析（探针 EphemeralCdpServer 同款：只回未掩码 text 帧、处理 close）。 */
  handleUpgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const digest = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${digest}\r\n\r\n`,
    );
    const sendFrame = (payloadStr) => {
      const payload = Buffer.from(payloadStr, 'utf8');
      const len = payload.length;
      let header;
      if (len < 126) {
        header = Buffer.from([0x81, len]);
      } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
      }
      socket.write(Buffer.concat([header, payload]));
    };
    this.sendFrame = sendFrame;

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let payloadLen = buffer[1] & 0x7f;
        let offset = 2;
        if (payloadLen === 126) {
          if (buffer.length < 4) break;
          payloadLen = buffer.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (buffer.length < 10) break;
          payloadLen = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (buffer.length < offset + maskLen + payloadLen) break;
        const mask = masked ? buffer.subarray(offset, offset + 4) : null;
        offset += maskLen;
        let payload = buffer.subarray(offset, offset + payloadLen);
        buffer = buffer.subarray(offset + payloadLen);
        if (opcode === 0x08) { socket.write(Buffer.from([0x88, 0x00])); socket.end(); return; }
        if (opcode === 0x01) {
          if (mask !== null) {
            const decoded = Buffer.alloc(payloadLen);
            for (let i = 0; i < payloadLen; i += 1) decoded[i] = payload[i] ^ mask[i % 4];
            payload = decoded;
          }
          this.handleCdpMessage(payload.toString('utf8'));
        }
      }
    });
    socket.on('error', () => { /* 客户端超时主动断开是超时用例的正常路径 */ });
  }

  handleCdpMessage(rawJson) {
    let msg;
    try { msg = JSON.parse(rawJson); } catch { return; }
    if (msg?.method !== 'Runtime.evaluate') return;
    const expr = String(msg.params?.expression ?? '');
    this.evaluations.push({ expression: expr, params: msg.params ?? {} });
    const reply = (value) => this.sendFrame(JSON.stringify({ id: msg.id, result: { result: { type: 'object', value } } }));
    if (this.onEvaluate !== null) { this.onEvaluate(expr, reply); return; }
    // 缺省处理器（真机形状，EVIDENCE §6/§7）：桥存在；runPrompt 回
    // {clientRequestId, requestId, state, content[], artifacts, responseModel}。
    // ★ 顺序刻意 runPrompt 在前：runPrompt 表达式里也含 "typeof window.__wbInvoke" 子串。
    if (expr.includes('wb:conversations:runPrompt')) {
      const m = expr.match(/runPrompt[\s\S]*?\}\s*,\s*["']([^"']+)["']/);
      const convId = m !== null ? m[1] : 'fake-conv';
      const echo = expr.match(/"clientRequestId":"([^"]+)"/);
      reply({
        clientRequestId: echo !== null ? echo[1] : 'req-fake',
        requestId: '01a1016756b278c29975d0c015c9b12b',
        state: 'completed',
        content: [{ type: 'text', text: `FAKE-REPLY for ${convId}`, messageId: '01a10167-68e5-7b39-89c5-92f07d8ca9e6' }],
        artifacts: [],
        responseModel: { id: 'glm-5.3-flash' },
      });
      return;
    }
    if (expr.includes('typeof window.__wbInvoke')) {
      this.sendFrame(JSON.stringify({ id: msg.id, result: { result: { type: 'string', value: 'function' } } }));
      return;
    }
    reply({ state: 'unknown-expression' });
  }

  async stop() {
    if (this.server === null) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }
}

/** 拿一个"此刻无监听"的回环端口（bind 后立即释放 ⇒ 连接它 = ECONNREFUSED，且最快）。 */
async function closedPort() {
  const srv = http.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

/* ───────────────────────── run.js 接线测试的被测环境 ───────────────────────── */

const PROBE_OK = { installed: true, reason: 'ok' };

function makeRuntime() {
  const rt = {
    notes: [],
    detected: () => PROBE_OK,
    awaitDetection: async () => PROBE_OK,
    inFlightCount: () => 0,
    start: () => {}, finish: () => {}, forget: () => {},
    noteRun: (rec) => { rt.notes.push(rec); },
    registry: () => undefined,
    setRegistry: () => {},
  };
  return rt;
}

function makeJobs() {
  const handles = [];
  return { handles, start(spec) { handles.push(spec.run()); return `job-${handles.length}`; } };
}

/**
 * 会话映射假件（带**顺序事件**记录）：`events` 依时间记 `touch:<key>` / `forget:<reason>` /
 * `supersede:<key>` / `ignite` —— 接线测试据此断言"forget 先于点火"。
 */
function makeSessions() {
  const store = new Map();
  const events = [];
  const touched = [];
  const forgotten = [];
  return {
    store, events, touched, forgotten,
    createKey: () => `auto-${store.size + 1}`,
    resumable: (k) => {
      const r = store.get(k);
      if (!r) return null;
      if (r.superseded === true || r.unconfirmed === true) return null;
      if (typeof r.cliSessionId !== 'string' || r.cliSessionId === '') return null;
      return { cliSessionId: r.cliSessionId, cwd: r.cwd ?? null };
    },
    lookup: (k) => store.get(k) ?? null,
    adopt: (k, rec) => {
      store.set(k, { cliSessionId: rec.cliSessionId, cwd: rec.cwd ?? null, own: rec.own === true, superseded: false, unconfirmed: false, createdAt: 1_000 });
      return { ok: true };
    },
    touch: (k, patch) => {
      events.push(`touch:${k}`);
      touched.push({ key: k, patch });
      const prev = store.get(k);
      if (!prev) return { ok: false, persistState: 'no_record' };
      store.set(k, { ...prev, lastUsedAt: Date.now(), ...(patch ?? {}) });
      return { ok: true };
    },
    forget: (k, reason) => {
      events.push(`forget:${reason ?? 'superseded'}`);
      forgotten.push(k);
      const prev = store.get(k);
      if (!prev) return { ok: false };
      store.set(k, { ...prev, superseded: true });
      return { ok: true };
    },
    supersede: (k) => {
      events.push(`supersede:${k}`);
      forgotten.push(k);
      const prev = store.get(k);
      if (!prev) return { ok: false };
      store.set(k, { ...prev, superseded: true });
      return { ok: true };
    },
  };
}

/**
 * 接线被测环境（`multi-turn-reuse.test.js` 同形 + followUp seam）。
 * `followUpOutcome`：null = 默认成功回执；对象 = 原样返回；函数 = 动态决定。
 */
function harness({ flag = false, followUpOutcome = null } = {}) {
  const runtime = makeRuntime();
  const jobs = makeJobs();
  const sessions = makeSessions();
  const automationCalls = [];
  const followUpCalls = [];
  let fireCount = 0;

  const fakeAutomation = (req) => {
    automationCalls.push(req);
    sessions.events.push('ignite');
    fireCount += 1;
    const n = fireCount;
    const cid = `conv-${n}`;
    try { req.sessionStore?.adopt?.(req.sessionKey, { cliSessionId: cid, cwd: req.cwd ?? '', own: true }); } catch { /* 忽略 */ }
    return {
      cancel: () => {},
      done: Promise.resolve({
        status: 'completed', detail: `REPLY-${n}`, exitCode: 0,
        automation: {
          reason: null, automationId: `automation-${n}`, conversationId: cid,
          sessionId: cid, sessionKey: req.sessionKey ?? null, sessionPersist: { ok: true },
          retired: true, transcriptPath: null, reply: `REPLY-${n}`,
          creditsUsed: null, model: null, permission: null,
          usedModelId: null, sessionCwd: req.cwd ?? null,
          tokensUsed: null, phases: ['db-open', 'running'],
        },
      }),
      readOutput: () => `REPLY-${n}`,
    };
  };

  const fakeFollowUp = async (req) => {
    followUpCalls.push(req);
    if (typeof followUpOutcome === 'function') return followUpOutcome(req);
    if (followUpOutcome !== null) return followUpOutcome;
    // 默认成功回执 = dispatcher 真实信封形状（raw + output）。
    return {
      ok: true,
      channel: 'track_a',
      receipt: {
        raw: { state: 'completed', content: [{ type: 'text', text: 'TRACK-A-REPLY' }], requestId: '01a1', clientRequestId: 'dsh-cdp-x' },
        output: 'TRACK-A-REPLY',
        state: 'completed',
        requestId: '01a1',
        clientRequestId: 'dsh-cdp-x',
        responseModel: { id: 'glm-5.3-flash' },
        artifacts: [],
      },
    };
  };

  const CFG = () => ({
    enabled: true, model: '', effort: '', cwdRoot: 'C:/repo',
    transport: 'automation', boundSessionId: '',
    enableMultiTurnFollowUp: flag, followupCdpPort: 9222, followupTimeoutMs: 15000,
  });

  const tool = makeRunTool(
    runtime, sessions, CFG, { jobs, subprocess: {} }, null, null,
    { automationRun: fakeAutomation, followUp: fakeFollowUp },
  );

  return {
    runtime, jobs, sessions, automationCalls, followUpCalls,
    call: (args) => tool.execute(args, { signal: new AbortController().signal }),
  };
}

/* ───────────────────────── 测试 ───────────────────────── */

test('⓪ 套件级护栏生效：WORKBUDDY_HOME 指着一次性 tmp，真库结构上不可达', () => {
  assert.equal(
    process.env.WORKBUDDY_TEST_HOME_GUARD,
    'on',
    '★ 套件级护栏没生效 —— 必须经 npm run test:host（含 --import ./tools/dev/test-home-guard.mjs）运行',
  );
  const home = process.env.WORKBUDDY_HOME ?? '';
  assert.ok(home.startsWith(tmpdir()), `★ WORKBUDDY_HOME 必须落在系统临时目录下，实际：${home}`);
  assert.ok(!REAL_DB.startsWith(home), '★ 真库路径必须不在 WORKBUDDY_HOME 之下');
  assert.notEqual(workbuddyDbPath(), REAL_DB, '★★ 任何落点绝不能是真库');
});

test('D1 ★ 成功路径（真机回执契约）：state/content/raw 解析 + evaluate 形状（context={} + clientRequestId）', async () => {
  const srv = new FakeCdpServer();
  const port = await srv.start();
  // ★ 桌面端预检端口故意给一个**无监听**的口：预检不可达不判死，CDP 实测才是判据。
  const probePort = await closedPort();
  const logs = [];
  try {
    const d = createFollowUpDispatcher({ cdpPort: port, desktopProbePort: probePort, log: (m) => logs.push(m) });
    const r = await d.followUp({ conversationId: 'conv-1', prompt: packageContentBlocks('turn 2 text') });
    assert.equal(r.ok, true, `追发应成功：${JSON.stringify(r)}`);
    assert.equal(r.channel, 'track_a');
    // ★ 真机契约：state（非 status）、content[]（非 output 字符串）、无 turnCount/usage。
    assert.equal(r.receipt.state, 'completed');
    assert.equal(r.receipt.output, 'FAKE-REPLY for conv-1', 'output 必须从 content[] 的 text block 提取');
    assert.equal(r.receipt.requestId, '01a1016756b278c29975d0c015c9b12b');
    assert.ok(typeof r.receipt.clientRequestId === 'string' && r.receipt.clientRequestId.startsWith('dsh-cdp-'),
      'clientRequestId 必须由 dispatcher 生成（真机原样回显）');
    assert.deepEqual(r.receipt.responseModel, { id: 'glm-5.3-flash' });
    assert.deepEqual(r.receipt.artifacts, []);
    assert.equal(r.receipt.raw.state, 'completed', 'raw 必须逐字保留原始回执');
    assert.equal(r.receipt.raw.content[0].text, 'FAKE-REPLY for conv-1');
    assert.equal('turnCount' in r.receipt, false, '★ 回执信封不承诺 turnCount（真机没有；轮次走 requests 通道）');
    assert.equal(srv.evaluations.length, 1, '恰一次 Runtime.evaluate');
    const { expression, params } = srv.evaluations[0];
    assert.ok(expression.includes('"wb:conversations:runPrompt"'), 'evaluate 必须打 runPrompt 通道');
    assert.ok(expression.includes('"conv-1"'), '目标对话 id 必须在表达式里');
    assert.ok(expression.includes('[{"type":"text","text":"turn 2 text"}]'), 'prompt 必须以 ContentBlock 数组进表达式');
    assert.ok(expression.includes('__wbInvoke'), '必须经 window.__wbInvoke 桥');
    // ★ 真机校准：context 第二参传 {}（main 侧 buildTrustedContext 会忽略重派）——绝不自造 subject。
    assert.ok(expression.includes('{},'), 'context 第二参必须是 {}');
    assert.equal(expression.includes('"subject"'), false, '不得再构造 {subject:…}（真机已证实被忽略）');
    assert.ok(expression.includes('"clientRequestId":"dsh-cdp-'), 'options 必须带 clientRequestId（真机回显可作关联键）');
    assert.equal(params.awaitPromise, true, '必须 awaitPromise（等本轮跑完）');
    assert.equal(params.returnByValue, true, '必须 returnByValue（拿纯值回执）');
    assert.ok(logs.some((l) => l.includes('CDP target matched')), 'target 命中应有日志');
  } finally {
    await srv.stop();
  }
});

test('D2 ★ 裸字符串 prompt 直接拒绝（桌面端同样拒收 —— 双保险的第一道）', async () => {
  const srv = new FakeCdpServer();
  const port = await srv.start();
  try {
    const d = createFollowUpDispatcher({ cdpPort: port, desktopProbePort: port });
    for (const bad of ['bare string', '', null, 42, [], [{ nope: 1 }]]) {
      const r = await d.followUp({ conversationId: 'conv-1', prompt: bad });
      assert.equal(r.ok, false, `裸字符串/非块形态必须拒绝：${JSON.stringify(bad)}`);
      assert.equal(r.code, FOLLOWUP_CODES.INVALID_PROMPT);
      assert.match(r.detail, /ContentBlock/);
    }
    assert.equal(srv.evaluations.length, 0, '拒绝发生在任何网络动作之前');
  } finally {
    await srv.stop();
  }
});

test('D3 CDP 关闭 ⇒ ERR_WORKBUDDY_CDP_UNAVAILABLE（桌面没开 / 没带调试口启动）', async () => {
  const port = await closedPort();
  const d = createFollowUpDispatcher({ cdpPort: port, desktopProbePort: port });
  const r = await d.followUp({ conversationId: 'conv-1', prompt: packageContentBlocks('x') });
  assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code: FOLLOWUP_CODES.CDP_UNAVAILABLE });
  assert.ok(r.detail.length > 0, '成因必须可读');
});

test('D4 ★ 判别证据②侧：UA 是 WorkBuddy 但 target 全是外部页面 ⇒ ERR_NON_WORKBUDDY_CDP_TARGET', async () => {
  const srv = new FakeCdpServer({
    targets: [{
      id: 'target-chrome-01', title: 'Twitter', type: 'page',
      url: 'https://twitter.com/home',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9/devtools/page/target-chrome-01',
    }],
  });
  const port = await srv.start();
  try {
    const d = createFollowUpDispatcher({ cdpPort: port, desktopProbePort: port });
    const r = await d.followUp({ conversationId: 'conv-1', prompt: packageContentBlocks('x') });
    assert.equal(r.ok, false);
    assert.equal(r.code, FOLLOWUP_CODES.NON_WORKBUDDY_TARGET);
    assert.match(r.detail, /no target matches/, '成因必须说明是 target 侧不匹配');
    assert.equal(srv.evaluations.length, 0, '判别不过 ⇒ 一个 evaluate 都不许发');
  } finally {
    await srv.stop();
  }
});

test('D4b ★ 判别证据①侧：target 像 WorkBuddy 但 UA 无 WorkBuddy/（真机 Browser 只写 Chrome/…）⇒ 拒绝', async () => {
  const srv = new FakeCdpServer({ userAgent: LIVE_UA_PLAIN_CHROME });
  const port = await srv.start();
  try {
    const d = createFollowUpDispatcher({ cdpPort: port, desktopProbePort: port });
    const r = await d.followUp({ conversationId: 'conv-1', prompt: packageContentBlocks('x') });
    assert.equal(r.ok, false);
    assert.equal(r.code, FOLLOWUP_CODES.NON_WORKBUDDY_TARGET, 'UA 侧不成立 ⇒ AND 判别整体不成立');
    assert.match(r.detail, /lacks "WorkBuddy\/"/, '成因必须说明是 UA 侧不匹配');
    assert.equal(srv.evaluations.length, 0);
  } finally {
    await srv.stop();
  }
});

test('D5 ★ 超时 ⇒ ERR_DISPATCH_TIMEOUT（WS 连上但 runPrompt 不回话，绝不挂死整轮）', async () => {
  const srv = new FakeCdpServer({ onEvaluate: () => { /* 永不回帧 */ } });
  const port = await srv.start();
  try {
    const d = createFollowUpDispatcher({ cdpPort: port, desktopProbePort: port });
    const t0 = Date.now();
    const r = await d.followUp({ conversationId: 'conv-1', prompt: packageContentBlocks('x'), timeoutMs: 300 });
    const elapsed = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.equal(r.code, FOLLOWUP_CODES.DISPATCH_TIMEOUT);
    assert.ok(elapsed >= 250, `超时必须等满预算才收敛（实际 ${elapsed}ms）`);
    assert.ok(elapsed < 5000, `超时必须被预算掐断，不能无限等（实际 ${elapsed}ms）`);
  } finally {
    await srv.stop();
  }
});

test('D6 桥缺失（window.__wbInvoke 不存在）⇒ ERR_PERMISSION_DENIED（上下文非法面）', async () => {
  const srv = new FakeCdpServer({
    onEvaluate: (expr, reply) => {
      if (expr.includes('wb:conversations:runPrompt')) {
        reply({ __error: true, message: 'window.__wbInvoke is not defined' });
      }
    },
  });
  const port = await srv.start();
  try {
    const d = createFollowUpDispatcher({ cdpPort: port, desktopProbePort: port });
    const r = await d.followUp({ conversationId: 'conv-1', prompt: packageContentBlocks('x') });
    assert.equal(r.ok, false);
    assert.equal(r.code, FOLLOWUP_CODES.PERMISSION_DENIED);
  } finally {
    await srv.stop();
  }
});

test('D7 ★ __wbError code=CONVERSATION_NOT_FOUND ⇒ ERR_CONVERSATION_NOT_FOUND（跨桥错误不 throw）', async () => {
  const srv = new FakeCdpServer({
    onEvaluate: (expr, reply) => {
      if (expr.includes('wb:conversations:runPrompt')) {
        // ★ 真机契约：错误以返回值 {__wbError:true, message, code} 回来（Runtime.evaluate 当普通值带回）。
        reply({ __wbError: true, message: 'conversation conv-gone does not exist', code: 'CONVERSATION_NOT_FOUND' });
      }
    },
  });
  const port = await srv.start();
  try {
    const d = createFollowUpDispatcher({ cdpPort: port, desktopProbePort: port });
    const r = await d.followUp({ conversationId: 'conv-gone', prompt: packageContentBlocks('x') });
    assert.equal(r.ok, false);
    assert.equal(r.code, FOLLOWUP_CODES.CONVERSATION_NOT_FOUND);
    assert.match(r.detail, /CONVERSATION_NOT_FOUND/, '成因必须带上 daemon 的 code');
  } finally {
    await srv.stop();
  }
});

test('D8 ★ __wbError code=CONVERSATION_CLOSED ⇒ ERR_CONVERSATION_CLOSED', async () => {
  const srv = new FakeCdpServer({
    onEvaluate: (expr, reply) => {
      if (expr.includes('wb:conversations:runPrompt')) {
        reply({ __wbError: true, message: 'the conversation has been closed', code: 'CONVERSATION_CLOSED' });
      }
    },
  });
  const port = await srv.start();
  try {
    const d = createFollowUpDispatcher({ cdpPort: port, desktopProbePort: port });
    const r = await d.followUp({ conversationId: 'conv-1', prompt: packageContentBlocks('x') });
    assert.equal(r.ok, false);
    assert.equal(r.code, FOLLOWUP_CODES.CONVERSATION_CLOSED);
  } finally {
    await srv.stop();
  }
});

test('D9 ★ __wbError 未映射 code ⇒ ERR_FOLLOWUP_FAILED（catch-all，不硬塞七指纹）', async () => {
  const srv = new FakeCdpServer({
    onEvaluate: (expr, reply) => {
      if (expr.includes('wb:conversations:runPrompt')) {
        reply({ __wbError: true, message: 'something unprecedented went wrong', code: 'SINGULARITY_IMMINENT' });
      }
    },
  });
  const port = await srv.start();
  try {
    const d = createFollowUpDispatcher({ cdpPort: port, desktopProbePort: port });
    const r = await d.followUp({ conversationId: 'conv-1', prompt: packageContentBlocks('x') });
    assert.equal(r.ok, false);
    assert.equal(r.code, FOLLOWUP_CODES.FOLLOWUP_FAILED, '映射不到就落 catch-all');
    assert.match(r.detail, /SINGULARITY_IMMINENT/);
  } finally {
    await srv.stop();
  }
});

test('D10 ★ state 非 completed（非 __wbError）⇒ ERR_FOLLOWUP_FAILED，detail 带 state', async () => {
  const srv = new FakeCdpServer({
    onEvaluate: (expr, reply) => {
      if (expr.includes('wb:conversations:runPrompt')) {
        reply({ clientRequestId: 'req-x', requestId: '01a1', state: 'failed', content: [], artifacts: [] });
      }
    },
  });
  const port = await srv.start();
  try {
    const d = createFollowUpDispatcher({ cdpPort: port, desktopProbePort: port });
    const r = await d.followUp({ conversationId: 'conv-1', prompt: packageContentBlocks('x') });
    assert.equal(r.ok, false, 'state 非 completed 绝不能当成功（真机字段名是 state）');
    assert.equal(r.code, FOLLOWUP_CODES.FOLLOWUP_FAILED);
    assert.match(r.detail, /state="failed"/);
  } finally {
    await srv.stop();
  }
});

test('W1 ★★★ 开关关闭（默认）⇒ followUp 一次都不被调，回执键集与既有逐字一致', async () => {
  const h = harness({ flag: false });
  await h.call({ prompt: 'round one', session_key: 'K' });
  await h.jobs.handles[0].done;
  assert.equal(h.sessions.resumable('K')?.cliSessionId, 'conv-1', '前置：首轮 adopt 记住 conv-1');

  const second = await h.call({ prompt: 'round two', session_key: 'K', resume: true });
  await h.jobs.handles[1].done;
  assert.equal(h.followUpCalls.length, 0, '★ 开关关闭 ⇒ 追发面零调用（spy 断言）');
  assert.equal(h.automationCalls.length, 2, '★ 开关关闭 ⇒ 每轮照旧点火（零回归）');
  assert.equal(second.resumed, false);
  assert.equal(second.resumed_session_id, '');
  assert.equal(Object.prototype.hasOwnProperty.call(second, 'follow_up'), false, '回执不得带追发键');
  assert.equal(Object.prototype.hasOwnProperty.call(second, 'fallback'), false, '回执不得带回退键');
  assert.deepEqual(
    Object.keys(second).sort(),
    ['argv_preview', 'job_id', 'not_sent', 'resumed', 'resumed_session_id', 'session_key'],
    '★ 键集 = 既有 6 键（hardening 契约）',
  );
});

test('W2 ★★★ 开关开 + resume:true + 追发成功 ⇒ 不点火、touch、resumed:true + follow_up 元数据', async () => {
  const h = harness({ flag: true });
  await h.call({ prompt: 'round one', session_key: 'K' });
  await h.jobs.handles[0].done;
  assert.equal(h.automationCalls.length, 1, '前置：首轮点火');

  const second = await h.call({ prompt: 'round two', session_key: 'K', resume: true });
  assert.equal(h.followUpCalls.length, 1, '★ 恰一次追发');
  const req = h.followUpCalls[0];
  assert.equal(req.conversationId, 'conv-1', '目标 = 记性命中的那条对话');
  assert.deepEqual(req.prompt, [{ type: 'text', text: 'round two' }], '★ prompt 必须以 ContentBlock 数组打包（裸字符串不出接线层）');
  assert.equal(req.timeoutMs, 15000, '超时旋钮必须真消费（followupTimeoutMs；测试注入短值）');
  assert.equal(h.automationCalls.length, 1, '★ 追发成功 ⇒ 不点火（零 INSERT）');
  assert.ok(h.sessions.events.includes('touch:K'), '★ 成功必须 touch（保鲜 sweepOwnSessions 判据）');
  assert.equal(h.sessions.touched[0].key, 'K');

  // 回执：resumed:true + 追发元数据；其余既有字段全部保留；无 fallback 键。
  assert.equal(second.resumed, true);
  assert.equal(second.resumed_session_id, 'conv-1');
  assert.deepEqual(second.follow_up, { channel: 'track_a', elapsedMs: second.follow_up.elapsedMs });
  assert.ok(Number.isFinite(second.follow_up.elapsedMs) && second.follow_up.elapsedMs >= 0);
  assert.equal(Object.prototype.hasOwnProperty.call(second, 'fallback'), false);
  assert.equal(second.job_id, 'job-2', '★ 作业句柄照发（回执字段全保留）');
  assert.equal(typeof second.argv_preview, 'string');
  assert.deepEqual(second.not_sent, []);

  // 作业收口：合成产物走既有 settle 路径（completed + 产物可见）。
  const done = await h.jobs.handles[1].done;
  assert.equal(done.status, 'completed');
  assert.equal(done.detail, 'TRACK-A-REPLY');
  const last = h.runtime.notes[1];
  assert.equal(last?.transport, 'followup', '★ lastRun transport 如实记 followup');
  assert.equal(last?.sessionOrigin, 'resumed', '★ origin 为 resumed（同一条对话续用）');
  assert.equal(last?.resumed, true);
  assert.deepEqual(last?.followUp, { channel: 'track_a', elapsedMs: last.followUp.elapsedMs });
  assert.equal(last?.sessionId, 'conv-1');
  assert.equal(last?.automationId, null, '★ Track A 不建行 ⇒ automationId 如实为 null');
  assert.equal(last?.retired, false, '★ 无行可退 ⇒ retired false（不谎报）');
  // 记性：id 没变（touch 只推进热度，不换 id）。
  assert.equal(h.sessions.resumable('K')?.cliSessionId, 'conv-1');
});

test('W3 ★★★ 追发失败 ⇒ forget(指纹码) 先于点火，回执带 fallback + resumed:false', async () => {
  const h = harness({
    flag: true,
    followUpOutcome: { ok: false, code: FOLLOWUP_CODES.CDP_UNAVAILABLE, detail: 'port 9222 refused' },
  });
  await h.call({ prompt: 'round one', session_key: 'K' });
  await h.jobs.handles[0].done;
  assert.equal(h.sessions.resumable('K')?.cliSessionId, 'conv-1', '前置：首轮记住 conv-1');
  const mark = h.sessions.events.length; // 第二轮的事件从这之后算（第一轮的 ignite 不掺和）

  const second = await h.call({ prompt: 'round two', session_key: 'K', resume: true });
  assert.equal(h.followUpCalls.length, 1);
  assert.equal(h.automationCalls.length, 2, '★ 失败 ⇒ 照旧点火（优雅回退，任务不丢）');
  // ★ 顺序：先 forget(指纹码) 再 ignite —— 死 id 不得留在记性里，且回收必须发生在点火之前。
  assert.deepEqual(
    h.sessions.events.slice(mark),
    ['forget:ERR_WORKBUDDY_CDP_UNAVAILABLE', 'ignite'],
    `第二轮实际事件序列：${JSON.stringify(h.sessions.events.slice(mark))}`,
  );
  // 回执：resumed 仍 false + fallback 两键；其余字段保留。
  assert.equal(second.resumed, false);
  assert.equal(second.resumed_session_id, '');
  assert.equal(second.fallback, true);
  assert.equal(second.fallbackReason, 'ERR_WORKBUDDY_CDP_UNAVAILABLE');
  assert.equal(Object.prototype.hasOwnProperty.call(second, 'follow_up'), false);
  // 作业收口走既有路径：新对话 conv-2、completed。
  const done = await h.jobs.handles[1].done;
  assert.equal(done.status, 'completed');
  assert.equal(done.detail, 'REPLY-2');
  const last = h.runtime.notes[1];
  assert.equal(last?.transport, 'automation', '回退轮 transport 仍是 automation');
  assert.equal(last?.sessionOrigin, 'new');
  assert.equal(last?.resumed, false);
  // 回退成功后记性滚动到新 id（点火侧 adopt 覆盖）。
  assert.equal(h.sessions.resumable('K')?.cliSessionId, 'conv-2');
});

test('W4 开关开但 resume 省略 ⇒ 不追发（照旧点火新对话）', async () => {
  const h = harness({ flag: true });
  await h.call({ prompt: 'round one', session_key: 'K' });
  await h.jobs.handles[0].done;
  const second = await h.call({ prompt: 'round two', session_key: 'K' });
  await h.jobs.handles[1].done;
  assert.equal(h.followUpCalls.length, 0, '★ 只有 resume:true 才追发；省略 = auto = 每轮新开');
  assert.equal(h.automationCalls.length, 2);
  assert.equal(second.resumed, false);
});

test('W5 开关开 + resume:true + 无记性 ⇒ 仍明确报错（追发面不改变这条既有契约）', async () => {
  const h = harness({ flag: true });
  await assert.rejects(
    () => h.call({ prompt: 'x', session_key: 'never-used', resume: true }),
    /no resumable session is recorded/,
  );
  assert.equal(h.followUpCalls.length, 0);
  assert.equal(h.automationCalls.length, 0);
});
