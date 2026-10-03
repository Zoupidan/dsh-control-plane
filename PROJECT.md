# Project: WorkBuddy Multi-Turn Follow-Up (Same-Session Continuation) Research & RFC

## Architecture
- **Goal**: Research, prototype, and specify the minimally disruptive path to send follow-up prompts into an existing `conversationId` (true resume / multi-turn continuation) in WorkBuddy desktop, without altering production `packages/plugin-workbuddy` code.
- **Integration Target**: The 6 foundational session pillars (`session/map.js`, cwd/hex key rules, `automation.js` once ignition, `apply.js` startup sweeps, observability four-corner metrics, code freeze invariants).
- **Channels Explored**:
  - Track A: Native Electron IPC / Daemon RPC channel (`wb:invoke` -> `wb:conversations:sendPrompt` / `wb:conversations:runPrompt`).
  - Track B: Low-intrusion HTTP patch (`evalModeEnabled=true` -> `EvalProxyServer` `POST /chat/:sessionId`).
  - Track C: Underlying Sidecar / CBC dynamic loopback endpoint (`session.acpEndpoint`).
  - Baseline 1: Single-shot `automation.js` ignition via SQLite `automations` table.
  - Baseline 2: ACP `session/load` via existing process ports.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Track A Probe | Prototype script sending follow-up prompts via Native Daemon RPC / IPC (`wb:conversations:sendPrompt` / `runPrompt`) with ContentBlock payload | M1 | ORIGINAL_REQUEST §R1.1 |
| 2 | Track B Probe | Prototype script verifying EvalProxyServer `POST /chat/:sessionId` behavior and evaluating `evalModeEnabled` patch feasibility | M1 | ORIGINAL_REQUEST §R1.2 |
| 3 | Track C Probe | Prototype probe capturing Sidecar dynamic `acpEndpoint`, token entropy, and demonstrating process lifecycle termination on turn completion | M1 | ORIGINAL_REQUEST §R1.3 |
| 4 | Reverse-Engineering Dossier | Documented archive of decompiled desktop internals (Claw `/claw` space special case vs normal workspace restrictions, PID lifecycle, security ACL) | M1 | ORIGINAL_REQUEST §Acceptance Criteria |
| 5 | Panoramic Evaluation Matrix | 5-dimension cross-comparison matrix (Track A, B, C vs Baseline 1 & Baseline 2 across intrusiveness, hit rate, auth, latency, complexity) | M1 | ORIGINAL_REQUEST §Acceptance Criteria |
| 6 | Architecture RFC Document | Non-destructive RFC document detailing 6-pillar integration, Mermaid sequence diagrams, data flows, and lifecycle coordination | M1 | ORIGINAL_REQUEST §R2 |
| 7 | Graceful Fallback State Machine | Detailed state machine specification for transparent fallback to `automation.js` when conversationId is invalid or closed | M1 | ORIGINAL_REQUEST §R2.2 |
| 8 | Master Verification Harness | Standalone runnable script in `tmp/` or `00-recon/` executing follow-up attempts, emitting structured reports & error fingerprints | M1 | ORIGINAL_REQUEST §R3 |
| 9 | 100% Zero-Regression Verification | Verify `npm run test:host`, `npm run test:client`, `npm run ci:redlines`, and `tmp/probe-automation-main.mjs` pass with 100% regression freedom | M1 | ORIGINAL_REQUEST §Acceptance Criteria |
| 10 | Forensic Integrity Audit | Independent Forensic Auditor verification ensuring genuine implementations, zero cheating, zero production tampering | M1 | Audit Protocol |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Prototype Spikes, Reverse-Engineering Dossier, Architecture RFC & Verification Harness | Implement runnable spike probes for Tracks A, B, C, compile reverse-engineering dossier, draft comprehensive Architecture RFC with evaluation matrix and fallback state machine, build master verification harness, and verify 100% zero-regression baseline | Survey | DONE |
| M2 | Live-Desktop Closure & Flag-Off Production Integration | Real-desktop CDP follow-up closure (LIVE-VERIFIED), `followup/dispatcher.js` calibrated to live receipt contract, `enableMultiTurnFollowUp` knob (default false) wired into `run.js` with graceful fallback, hardened verification suites | M1 | DONE |

## Interface Contracts
### Follow-Up Channel Probe Contract
- **Input**: `{ conversationId: string, prompt: string, cwd?: string, timeoutMs?: number }`
- **Output**:
  ```json
  {
    "ok": true,
    "resumed": true,
    "channel": "track_a" | "track_b" | "track_c",
    "conversationId": "...",
    "turns": 2,
    "output": "...",
    "elapsedMs": 450
  }
  ```
- **Error**: `{ ok: false, error: string, code: "CONVERSATION_NOT_FOUND" | "ENDPOINT_DEAD" | "TIMEOUT" }`

### Graceful Fallback Contract
- When `ok: false`: System invokes `sessionStore.forget(sessionKey)` -> calls `startAutomationRun` -> returns `{ ok: true, resumed: false, fallback: true, newSessionId: "..." }`.

## Code Layout
- `00-recon/`: Reverse-engineering evidence archives, spike probes, and Architecture RFC documents.
- `tmp/`: Experimental probes, mock servers, and execution logs.
- `packages/plugin-workbuddy/`: modifications permitted only behind the zero-regression gates (M2+); the M1 research phase was strictly read-only.
- `test/`: Existing test suites, must pass 100% with zero regressions.

## M2 Addenda (2026-10-03)
- **Live closure**: Track A verified on the real desktop (`WORKBUDDY_REMOTE_DEBUGGING_PORT=9222` env-var route, CDP ready in 2s). Two turns into one conversationId; turn 2 reproduced the turn-1 agreed word ("收到"). Evidence: `00-recon/evidence/CDP-LIVE-20261003/` (also mirrored in local-only branch `research-evidence-local`, worktree `D:\cheng\Documents\Code\dsh-evidence-vault` — never push).
- **Real receipt contract** (differs from probe assumption): `state:'completed'` (not `status`), `content: ContentBlock[]` (not `output`), no top-level `turnCount`/`usage` (use `wb:conversations:requests`), cross-bridge errors return `{__wbError:true,...}` instead of throwing, `sendPrompt` normally returns `undefined`.
- **Production knobs** (flat top-level, default off): `enableMultiTurnFollowUp=false`, `followupCdpPort=9222`, `followupTimeoutMs=180000` (live first-turn cold start measured 13.4s; budget 180s).
- **Gates at M2 close**: `test:host` 560/560 · `test:client` 79/79 · `ci:redlines` 4/4 · harness 10/10 · challenger 19 PASS · `probe-automation-main` PASS · live e2e (through production dispatcher) PASS.
- **Leftovers**: credit accounting for follow-up turns (0.01–0.4 credit/turn observed); second wiring point `subagent/execute.js`; multi-window /json/list target picking; client settings UI for new knobs; offline-mode challenger SKIP validation on next natural desktop downtime.
