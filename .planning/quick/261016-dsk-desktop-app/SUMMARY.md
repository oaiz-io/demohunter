---
status: complete
---
# 261016-dsk — DemoHunter Studio desktop app

Electron shell in `apps/desktop` around the local Studio service.

- Icon: dark squircle, paper frame, highlighter, agent dot (`build/icon.svg` → png/icns via `scripts/render-icon.mjs`).
- Welcome window (recent repositories, drop a folder), loading and error pages with Try again; `app://ui` protocol serves only shell pages, icon and Geist fonts.
- Window size/position memory, single instance, Dock drop / `open-file`, Dock menu, About panel, login-shell environment for API keys and ffmpeg, title stays on the repository.
- Library repository name switches repositories in the desktop app.
- `bun run desktop:app` builds `out/DemoHunter Studio.app` (renamed Electron, own icon, ad-hoc signed, linked to the checkout).
- `desktop.test.ts`: 4 Playwright `_electron` tests (welcome, open + remember + reopen + close, saved size without position, service start failure).

## Hands-on pass (same day)

Driven over CDP like a user: library → editor → play → scrub → Script/Agent → export.
- Studio crashed on the first thumbnail: global Bun 1.2.20 cannot spawn Chromium with Playwright pipes. The app now runs Studio on a pinned Bun 1.4.3 (`@oven/bun-darwin-*` optional deps); Studio refuses Bun < 1.3 with an upgrade hint; the service logs uncaught errors instead of exiting.
- Thumbnails reuse one warm renderer (10 cold thumbnails ≈ 3.7 s, was ≥ 11 s); library posters show the first recorded frame instead of a blank title card.
- Export result in the desktop app: Open video / Show in Finder (restricted to the open repository).
- Error page: "Studio stopped working" vs "Could not open", banner stripped, log scrolled to the end.

## Worktrees and steady library (same day)

- Library flicker: the scan embedded `Date.now()` in each tour command, so every 4 s poll rebuilt every card and re-faded posters (also lost hover). Output is now stable and sorted; cards and posters are reused by ID, changed posters swap only after loading. 0 DOM mutations across polls while hovering (desktop e2e). Window background follows the page, so resizing does not flash.
- Repository libraries: opening a git repository top level lists all worktrees (`git worktree list`), scans each (nested worktrees once, missing ones flagged), and shows a worktree sidebar (branch, changes, ahead/behind, opened/main). IDs for the opened folder are unchanged. No automatic repository discovery; subfolders and plain folders scan as before.
- Agents: viewing a demo writes the Studio session to the opened folder and to the demo's worktree; Connect agent uses the demo's worktree; MCP resolves demos in sibling worktrees.
- Tests: `apps/studio/worktrees.test.ts` (4), desktop e2e worktree + no-flicker test.

## Projects sidebar (2026-10-17)

- Sidebar renamed to Projects: the open project with its worktrees nested (only those with demos, others folded), recent projects from the desktop app (switch in place), and an Open… button (also in the empty state).
- New/updated demo badges per worktree and per card. Seen state is server-side runtime state (`.demohunter/studio/seen.json`, git-ignored) because the desktop port — and so browser storage — changes each launch. Updated = re-captured or agent-changed; own edits don't count. Opening a demo (card click, leaving the editor) marks it seen.
- Recent projects are de-duplicated by real path.
- Tests: `apps/studio/seen.test.ts`; desktop e2e updated for the Projects sidebar.

## Compact worktrees and fast scans (2026-10-17)

- Sidebar worktrees are one 28 px line (folder, muted branch, dirty dot, new/updated badges, count); only worktrees with demos show, sorted fresh-first then most recently edited; empty ones (including the opened folder) fold into one toggle line. Git details are in the tooltip.
- Scans of repositories no longer walk the source tree: tours and `.demohunter` folders come from `git ls-files` (cached, refreshed in the background), only those folders are walked, tours are read only when linked to a recording, demo metadata is cached by file stamps, and `git status` per worktree runs in the background (max 2 at a time) so it never blocks. The header uses a light branch/remote lookup. Studio serves before the first scan finishes; the page shows "Looking for demos…".
- oaiz (23 worktrees): scan 4.5 s on every 4 s poll → first 1.6 s, then ~0.2 s. demohunter: ~0.1 s first, ~25 ms after.
