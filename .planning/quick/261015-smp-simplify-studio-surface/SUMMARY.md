---
quick_id: 261015-smp
status: complete
date: 2026-10-15
branch: t3code/research-editable-demo-capture (PR #28)
---

# Simplify the Studio surface

Studio is now a window onto demos made in code: review, point and note, hand
off to the agent, undo a turn, fix script text, export. About 2,750 lines net
removed.

## Removed
- Library: Record a tour, record dialog, machine check, "Not recorded yet";
  `machine.ts`, `/api/machine`, `/api/record*`, capture `onProgress`. Sidebar
  filters (Needs attention, Agent changes), folders, tests toggle, repo
  switcher, scan time. Cards show one status: open notes, else Tour changed.
- Editor: Review changes, git state, canvas hint and viewport size, Find &
  replace, Edit menu and Inspect, Element and Timing panels (`/api/source`),
  Keep / Follow agent / raw activity log / git footer, speed picker, per-card
  Preview / Voice / fit meter and the voice form, export FPS and strict
  options. Empty Camera/Notes tracks are hidden.

## Also fixed
- Capture bundles declared-but-unused fonts and drops unfetched remote head
  links (offline replay of oaiz.io had 25 errors, now 0).
- Frame renders time out after 60 s so one stuck render cannot block the
  shared thumbnail/poster queue.
- Example apps and their e2e test use any free port (`PORT`).

## Verification
- Typecheck and build passed. Full suite 317 passed, 1 skipped (Bun 1.4.3).
- Screenshots at 1440×900 and 390×844; no console errors.
