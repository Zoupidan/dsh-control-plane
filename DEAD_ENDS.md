# Dead Ends Log

| Iteration | Approach Tried | Why It Failed | Files Touched |
|-----------|---------------|---------------|---------------|
| Iteration 1 | Assuming port 9222 presence via `/json/version` implies live WorkBuddy CDP | Port 9222 was occupied by an unrelated user Chrome browser browsing Twitter; falsely reported `liveCdpDetected: true` without filtering target identity. Must inspect `/json/list` for WorkBuddy Electron targets or report `ERR_WORKBUDDY_CDP_UNAVAILABLE`. | `00-recon/probe-track-a-daemon-rpc.mjs` |
