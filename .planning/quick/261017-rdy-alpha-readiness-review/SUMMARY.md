---
status: complete
---
# 261017-rdy — Alpha readiness review of PR #28

PR labelled `alpha`, retitled, description rewritten; downloadable macOS app published as the rolling `studio-desktop-alpha` pre-release by `.github/workflows/desktop-alpha.yml` (Electron e2e tests hidden, packaging, smoke test outside the checkout, checksums).

Review → fix loops:
1. Round 1 (core, UI, security, hygiene): DNS-rebinding guard, inert assets, vendored rrweb, symlink refusal, lift sanitising, folder trust/restricted mode, IPC sender checks; undo chain, stale locks, partial MCP updates, export/capture fixes; reload coalescing, idle-frame skipping, stable thumbnails/scenes; customer-specific notes and the experiments shim removed; CI pins Bun and skips Electron on Linux.
2. Round 2 (security + regressions): caches moved out of projects, link-safe folders, reap-locked takeover, worktree back-link validation, no git status when restricted, mutation-XSS-proof lift, restricted MCP renders, CSP sandbox, cross-site blocking; paused reframe, keepalive bytes, hidden heartbeat, per-file asset stamps.
3. Round 3 (final): no blockers; close/quit never vetoed, agent guide packaged, export trust warning, restricted cache split, ignored runtime folders.

Verification: `bun run verify` 426 pass / 1 skip / 0 fail (Bun 1.4.3); final Studio 123 and packages/e2e 296 pass; Linux CI and macOS desktop workflow green.
