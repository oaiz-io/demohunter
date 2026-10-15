---
quick_id: 261015-onc
date: 2026-10-15
branch: t3code/research-editable-demo-capture (PR #28)
---

# One Studio command

Studio opens one way: `bun run studio [workspace]` serves the full library;
people navigate to a demo from there (desktop-app model).

- Remove the `open` and `library` commands and the `replay` script alias.
- `demo` and `capture` create projects and point to `bun run studio`.
- Keep non-UI commands: capture, demo, narrate, inspect, export, list,
  contract, mcp, resolve.
- Update README, skill and experiments note.
