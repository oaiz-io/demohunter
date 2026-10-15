---
quick_id: 261015-smp
date: 2026-10-15
branch: t3code/research-editable-demo-capture (PR #28)
---

# Simplify the Studio surface

Studio is a window onto demos that are made in code: review, point and note,
hand off to the agent, export. It is not a recorder or a video editor.

## Remove — Demos library
- Record a tour, record dialog, machine check, "Not recorded yet" list (and
  `/api/record`, `/api/machine`, `machine.ts`). Recording stays in the CLI.
- Sidebar: All / Needs attention / Agent changes filters, folders, tests toggle.
- Repo switcher and scan time. Keep repo name and branch.
- Card chips except one status: open notes, or tour changed since capture.

## Remove — Editor
- Header: Review changes button, git state. Keep save state, Connect agent,
  Export, menu.
- Canvas: hint text, viewport size, Find & replace. Tools: Select and Note.
- Selection toolbar: Note and Copy for agent only (no Edit menu, no Inspect).
- Panels: Notes, Script, Agent (no Element, no Timing).
- Agent panel: now + changes by turn with Undo turn (no Keep, Follow agent,
  raw activity log, git footer).
- Timeline: no speed picker; hide empty tracks.
- Export dialog: no FPS or strict options.

## Verify
- `bun x tsc -p apps/studio/tsconfig.json`, `bun test apps`, screenshots.
