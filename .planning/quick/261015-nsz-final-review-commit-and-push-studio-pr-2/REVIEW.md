---
status: clean
date: 2026-10-15
depth: standard
base: origin/main
findings:
  critical: 0
  warning: 0
  fixed: 2
---

# Final Studio code review

Reviewed the complete Studio branch plus pending changes against refreshed origin/main. Review executed inline under the GSD quick/code-review workflow.

## Findings fixed

1. **P1: Undo crossed direct-file edits.** If an external edit occurred between tracked changes, undo rewrote the preceding history revision and allowed a whole turn (or consecutive undo requests) to overwrite the external edit. The regression test failed before the fix. Undo now validates the entire revision chain before any write and preserves direct-file boundaries across later requests. The regression test and existing history tests pass.
2. **P2: Historical activity claimed a live connection.** The setup dialog used any persisted MCP activity to say the agent was connected. It now reports working calls or the last observed activity; the header says recent, and the setup dialog refreshes relative times. No agent-control or message-sending feature was added.

Also handled failed cleanup of a renderer that finishes opening after a timeout, and ignored local speech caches, browser snapshots and automatic handoffs. Schema files regenerated from their source and formatted without semantic changes.

## Review coverage

- Local-only startup and full library routing; removal of open/library/replay startup aliases and recording UI.
- Capture cleanup, bundled fonts/resources, stable element references, versioned project schemas and compatibility.
- Shared storage validation, revision conflicts, lock/history behavior, agent attribution and undo.
- Project-bound MCP reads/writes, exact comment links/IDs, no-element/resolved notes and clipboard actions.
- Browser playback transport, buffering, decoder seek protection, failure retries and stale/removed track cleanup.
- Shared screenshot/poster/export renderer, revision cancellation, export destination protection, captions and current speech.
- Simplified Notes/Script/Agent surface and source-only OAIZ tour; example ports and CLI packaging boundaries.

## Validation

- Bun 1.4.3 frozen-lockfile installation passed.
- Workspace build, root typecheck and Studio typecheck passed.
- Next.js and Vite production builds passed.
- Full deterministic suite: **322 passed, 2 optional live-provider tests skipped, 0 failed**; 1,131 assertions across 65 files. Includes actual browser capture/edit/comment/MCP/export, measured audio signal and playback tests, and the undo regression.
- npm publish dry-run passed; the existing npm bin-path normalization warning is outside this change. No package was published.
- git diff --check passed. No unresolved GitHub review threads at review time.

## Limits

Studio is source-distributed and local. Native desktop packaging and authenticated multi-user hosting remain future work. DOM replay does not rerun application logic and retains the documented canvas/media/cross-origin limits. CI for the new pushed head is a separate remote check. The user's Studio service was not started, stopped or restarted during this review.
