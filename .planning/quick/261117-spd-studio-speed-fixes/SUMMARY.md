---
status: complete
---
# Quick task 261117-spd: Studio speed fixes

All numbers are measured, with a minimum of 5 runs each.

- **Library scan**: cold scan on a large private repository 2,341 → 271 ms. Idle CPU during polls about 2 → 0.01 cores. Payload 651 → 209 KB. A plain folder above the walk budget: 1 of 40 scans was different → 0 of 40. Library tours no longer have a `command` field; no client used it.
- **Posters, thumbnails, MCP screenshots**: thumbnails after a comment edit 3,087 → 48 ms. 23 thumbnails 4.45 MB → 128 KB. MCP screenshot 1,262 → 242 ms.
- **Capture file**: cold project load 105.6 → 8.5 ms.
- **HTTP caching and payload**: `app.js` 843 → 148 KB. Repeat editor open 5.98 → 0.94 MB.
- **Scrub and seek**: timeline click 105.7 → 84.7 ms (median). A pointer drag is not faster, because Chromium already sends one pointer move for each frame.
- **Per-frame `update()`**: paused for 5 s 154 → 21 ms of task time. 120 hover moves 144 → 80 ms. 3 s of playback 563 → 365 ms. Rendered frames are pixel-identical to the baseline.
- **Polls**: status bytes in 10 s while visible 197 KB → 0 (all 304). Polls in 10 s while hidden 12 → 0. A hidden editor polls every 15 s, so agents still see it, and it polls immediately when shown again.
- **Desktop**: app launch to the Studio page 1,120 → 930 ms (median).

Tests: Studio 167 pass before, 178 pass after, 0 fail. Typecheck clean. Desktop suite 7 pass.

Decided not to do:

- `useVirtualDom` stays off. It made a backward drag much smoother (long tasks 2,942 → 63 ms), but seeked frames, thumbnails and exports then lose focus rings and hover states. A comment in `web/app.ts` gives the reason.
- `checkoutEveryNms` is not set. The element index starts a new document at each Meta event, so element references would change every 5 s and element edits would stop applying.

Risks to review by hand:

- File watching in a real repository with many worktrees.
- The paused frame loop sleeps. A canvas change with no input and no status change shows in the 250 ms heartbeat, not on the next frame.
- During playback, overrides other than scene edits are applied again only through the rrweb event handler.

Left for later: keyframes for backward seek need capture, index and replay changes. A faster backward seek with the virtual DOM needs a way to keep focus and hover after the diff.
