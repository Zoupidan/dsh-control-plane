# Dead Ends Log

| Iteration | Approach Tried | Why It Failed | Files Touched |
|-----------|---------------|---------------|---------------|
| Iteration 1 | Assuming port 9222 presence via `/json/version` implies live WorkBuddy CDP | Port 9222 was occupied by an unrelated user Chrome browser browsing Twitter; falsely reported `liveCdpDetected: true` without filtering target identity. Must inspect `/json/list` for WorkBuddy Electron targets or report `ERR_WORKBUDDY_CDP_UNAVAILABLE`. | `00-recon/probe-track-a-daemon-rpc.mjs` |
| Iteration 2 | Treating probe loopback receipt shapes (`status`/`output`/`turnCount`) as canonical for the production dispatcher | Live desktop showed 9 field mismatches: real contract is `state:'completed'`, `content:ContentBlock[]`, no top-level `turnCount`/`usage` (they live in `wb:conversations:requests`), cross-bridge errors return `{__wbError:true,...}` instead of throwing, `sendPrompt` returns `undefined`. Fixed by calibrating the dispatcher against live evidence (`00-recon/evidence/CDP-LIVE-20261003/`) — never ship a contract pinned only to simulator shapes. | `packages/plugin-workbuddy/src/host/followup/dispatcher.js` |
