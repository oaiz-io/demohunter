---
quick_id: 261015-hrx
title: Implement the proof-desk Studio design
date: 2026-10-15
source_design: Paper file 01M4ZGNA5M02MT23H0VQJP216J, page p-1-0
---

Implement the Paper "proof desk" design in apps/studio. Studio is the visual layer for external agents (Claude Code, Codex, MCP clients): people point and note, agents edit, people watch and review. Projects are repo files.

Execution note: run in the main session, not delegated executors, because each screen must be compared with the Paper artboards and the running app in a browser.

## Task 1 — Service and data (no format break)

- files: storage.ts, mcp.ts, workspace.ts, server.ts, git.ts (new), frames.ts (new), library.ts, library-server.ts, capture.ts, contract.ts, schemas/studio.v1.schema.json, cli.ts
- action:
  - Attribute history entries (actor, sessionId, tool, elementRef, threadId, segmentId) through AsyncLocalStorage set by the MCP tool wrapper; UI writes are "You". Store a short change list per entry (text/style/hidden edits, effects, narration text, replies, status).
  - /api/undo accepts `steps` (undo a whole agent turn); /api/status returns history summary and git status.
  - Git status (branch, repository name, changed files under the project) with a short cache; no git → empty.
  - Scene thumbnails: /api/frame?t= renders a cached PNG through the shared renderer on the global poster queue.
  - Library: branch and repo name, tour ↔ recording links, "tour changed after recording" (optional `source.tourSha256` in studio.json), environment check (Chromium, FFmpeg, flite, speech key presence only), record jobs that run `capture` with step progress.
- verify: bun run typecheck:studio; unit tests for attribution, undo steps, git, library links.
- done: endpoints return the data the new UI needs; existing tests pass.

## Task 2 — Editor UI

- files: web/index.html, web/style.css, web/app.ts, web/workbench.ts, web/transcript.ts, web/feedback.ts, web/shell.ts, web/agent.ts (new), web/timeline.ts (new), server.ts (fonts)
- action: design tokens and local fonts (Geist, Geist Mono, Literata); header with repo/branch/git state, agent presence, review button; canvas bar, tool palette, selection toolbar; timeline with ruler, scene/camera/voice/notes tracks and playhead; Notes (status lifecycle, agent replies, live tool checklist, composer), Script (audio state card, Literata segments, fit meter), Agent (connection, now, follow agent, review queue by turn with Keep/Undo turn, git footer), contextual Element panel (hand-off first); presence motion (scan, march, breathe, settle, stripes) with reduced motion; dialogs (Connect agent with Claude Code/Codex/Other, Export readiness, shortcuts); find & replace.
- verify: browser tests still pass (ids preserved); screenshot at 1440×900 and 390×844 compared to Paper S3/S4/S5/03.
- done: editor matches the artboards; no horizontal overflow; no console errors.

## Task 3 — Library UI, docs, full gate

- files: web/library.html, web/library.css, web/library-app.ts, README.md, FORMAT.md, ARCHITECTURE.md, .agents/skills/demohunter-replay/SKILL.md
- action: repo library per Paper S2 (repo switcher, branch, nav, folders, recorded cards with badges, not-recorded rows with Record, machine check); record dialog per S5; document new optional fields and endpoints.
- verify: bun run build, typecheck, typecheck:studio, bun test; visual comparison with S2/S5.
- done: full gate green; SUMMARY.md written; STATE.md updated.
