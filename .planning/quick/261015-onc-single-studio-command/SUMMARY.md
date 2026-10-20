---
quick_id: 261015-onc
status: complete
date: 2026-10-15
branch: t3code/research-editable-demo-capture (PR #28)
---

# One Studio command

`bun run studio [workspace]` is the only way to open Studio; it always serves
the full library. Removed the `open` and `library` commands and the `replay` /
`test:replay` scripts. `demo` and `capture` now point to `bun run studio`.
README, skill and experiments note updated. The experiments/replay/cli.ts
entry point stays for existing MCP configurations.

Verification: typecheck passed; Studio tests 21 passed (Bun 1.4.3); `--help`,
`bun run studio --port <n>` and the rejected `open` form checked by hand.
