---
status: complete
---
# Quick task 261020-jl7: restricted library never runs git status

- `LocalLibrary.open(root, { restricted })`: the root is restricted at construction. Each scan restricts every listed worktree, including the main checkout outside the opened folder and sibling worktrees, before any work runs there. A restricted library never runs `git status`.
- `serveLibrary` passes `restricted` into the library.
- Regression test (`worktrees.test.ts`): a clean filter in the shared `.git/config` and a stat-dirty file in the main checkout; the linked worktree is opened restricted. Before the fix the filter ran (the test failed); after the fix it does not run.
- Verify: `worktrees.test.ts` 6/6 pass; Studio typecheck clean. 6 failures in `security`/`workspace`/`agents`/`agent-chat` tests also occur on the base commit without this change (seen-request size check, MCP stdio "Connection closed"); this change does not cause them.
