---
quick_id: 261015-hrx
status: complete
date: 2026-10-15
branch: t3code/research-editable-demo-capture (PR #28)
---

# Implement the proof-desk Studio design

Implemented the Paper design (file 01M4ZGNA5M02MT23H0VQJP216J, page "Studio — Design system & screens") in apps/studio on PR #28's branch. Studio is the visual layer for external agents: people point and note, agents edit through MCP, people watch and review.

## Service

- History entries name the agent session (AsyncLocalStorage set by the MCP tool wrapper) and carry a short readable change list. Agent replies default to the client name.
- `/api/undo` accepts `steps` to undo a whole agent turn in one locked operation; partial failure keeps history consistent.
- Git status (branch, repository from the remote, changed files, ignored folder) for projects and the library, cached briefly; no git means nothing to show.
- Local Geist, Geist Mono and Literata fonts; cached scene thumbnails (`/api/frame`) on the shared render queue, retried when an agent changes the project mid-render.
- Library links recordings to tours, shows tours changed after capture (optional `source.tourSha256`), checks the machine and records tours with coarse step progress (`studio:step` lines from `capture`).
- Fixed: servers now close idle keep-alive sockets (the library test timed out on this machine before); text that rrweb adds after an element is now indexed; a failed capture removes its new folder.

## Editor and library

- Header with repo, Demos, title, branch and git state; agent presence pill; Review changes; Export.
- Canvas bar, constant-size marks (pins, selection label, agent pill), selection toolbar (Note, Copy for agent, Edit, Inspect), tool palette, find and replace.
- Timeline: ruler, scene clips with thumbnails, stacked camera effects, voice waveforms (current, stale, draft), note pins and agent change marks, drag to seek.
- Notes with derived status (open, agent working with live tool steps, replied with changes, resolved); Script with audio status, compact excerpts, fit meter; Agent panel with connection, now, follow agent, review queue by turn (Keep, Undo turn), git footer; Element panel with hand-off first.
- Motion from real activity records: scan, march, settle, failed; stripes on the scene being changed; reduced motion respected.
- Dialogs: Connect agent (Claude Code, Codex, other MCP client), Export readiness, Record a tour, shortcuts.
- Repo library: repo switcher, branch, filters, folders, recorded cards with badges, not-recorded rows with Record, machine check.

## Verification

- Compared each screen with Paper S2–S5 and 03 in Chromium at 1440×900; checked 390×844 for horizontal overflow. No console errors on a fresh load.
- New tests: review.test.ts (attribution and undo steps, tour links and changed tours, git status, failed capture cleanup).
- Gate: build and typecheck passed; full suite 317 passed, 1 skipped on Bun 1.4.3 (CI uses the latest Bun). Local Bun 1.2.20 intermittently fails to spawn Chromium (`ENOENT` in its child_process) and hangs.

## Not done

- Tauri desktop shell (Welcome screen, native Open repository, menus) remains future work; the UI already reserves the title-bar inset (`body.desktop`).
- Keep is a local acknowledgement in the browser, not a file change; per-change undo inside a turn is not supported.
