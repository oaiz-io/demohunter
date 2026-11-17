# Studio performance: measured causes and fixes

**Research date:** 2026-11-17

**Base commit:** `3621b09`

**Scope:** Why DemoHunter Studio is slow to open, slow when it scans a workspace, and laggy in use. Server, start path, browser client and desktop shell.

**Decision:** Keep the architecture (Bun service, TypeScript client with manual DOM). Fix the scan, the renderer, the seek path, the per-frame work and the cache headers. A framework does not touch any of these costs.

Paths are relative to `apps/studio/` unless they start with `apps/`. Effort: S is hours, M is days, L is a week or more.

## Summary

The server starts in 0.34 s and the editor is interactive 142–228 ms after navigation. The user-visible slowness comes from six causes:

1. The library poll runs git in every worktree (slow open, constant CPU load).
2. Posters and thumbnails start a new Chromium, and any edit makes all of them stale (slow library, lag after each edit).
3. A backward seek replays the full recording on the live DOM (lag during scrub).
4. `update()` does all its work again on each frame at 120 Hz (lag on slower machines).
5. Nothing is cached in the browser, and the payloads are large (slow open).
6. The capture ZIP is hashed and unzipped on the event loop (slow scan with many demos).

## How this was measured

- **Machine:** 16 cores, Bun 1.4.3, warm disk.
- **Scan data:** a large private repository with 12 worktrees, about 40,000 tracked files, 27 recordings and about 1,500 tour entries. Measured read-only with `studio list` and the same git commands that Studio runs.
- **Editor data:** copies of two real demos.
  - "film B": 1,063 rrweb events, 18 clips, 7 full snapshots.
  - "film A": 1920x1080, 3,036 events, 23 clips, 7 overlays, 6,792 indexed elements, 1 full snapshot, 5.3 MB events and 5.3 MB element index.
- **Browser:** headless Chromium (Playwright 1.61) at 1512x900, device pixel ratio 2, 120 Hz. Headless uses software raster, so GPU compositing cost is not measured. The Electron window is not measured.
- **Marks:** "Measured" is a number from a run. "Inferred" is a conclusion from the code.
- **Scripts:** in the workspace scratch folder `.context/perf/` (git ignores it). They are not in this branch.

## Server and start path

### 1. The library poll scans every worktree with git

- **Where:** `library.ts:113-227` (`run`), `git.ts:301-361` (`listDemoSources`), `git.ts:365-389` (`cachedList`, 10 s), `git.ts:247-263` (`git status`, 15 s), `git.ts:141-191` (`listWorktrees`, no cache), `web/library-app.ts:553-555` (poll every 4 s), `web/new-app.ts:348-349` (polls every 2 s and 3 s).
- **What happens:** Each poll runs 3 git processes for `listWorktrees`. About every 10 s it runs two `git ls-files` for each worktree. Every 15 s it runs `git status` for each worktree. The first `/api/library` request waits for the cold scan (`library-server.ts:189-190`), so the page is empty until the scan is complete.
- **Measured:**
  - Cold scan: 3.0–3.8 s.
  - Warm poll: 104–163 ms. `listWorktrees` is about 100 ms of this.
  - 44 s of polling: 168 git processes, 110 s of total git wall time, 117 CPU-seconds (user 10 s, system 107 s). This is about 2.6 cores for as long as the library page is visible.
  - `git ls-files --cached --others` with pathspecs: 357 ms alone, 941 ms on average with 8 in parallel. The same list with `--cached` only: 35 ms.
  - `git status`: 0.3–0.9 s for each worktree. `core.fsmonitor=false` (`git.ts:34`) prevents fsmonitor acceleration.
- **Fix:**
  - S: List tours with `--cached` only. Find untracked `.demohunter` folders with a probe of known locations, or with a cache of 60 s or more. Cache `listWorktrees` for 10–30 s. Refresh worktrees that are not current much less often.
  - M: Replace timed polling with `fs.watch` on `.git/HEAD`, `.git/worktrees` and the known demo folders. Answer `/api/library` with ETag and 304.
  - M: Write the last scan to disk, show it at once, and check it again in the background.

### 2. Posters and thumbnails start Chromium, and any edit makes them stale

- **Where:** `poster.ts:149-187` (poster), `poster.ts:190-245` (frames), `poster.ts:86-90` (the warm renderer closes when the revision changes), `poster.ts:222-230` (deletes frames of other revisions), `render.ts:14-21` and `render.ts:79-84` (new server and `chromium.launch`, full-viewport PNG), `web/app.ts:1039`, `web/library-app.ts:270`.
- **What happens:** Each poster starts its own replay server and its own Chromium, in one serial queue. The cache keys use the full `bundle.revision`. The revision changes on any edit, including a comment or a narration text change. A revision change also closes the warm thumbnail renderer and deletes all older frames.
- **Measured:**
  - Poster, cold: 1.1–1.9 s each. 13 posters without a cache took 13.3 s.
  - First thumbnail after a revision change: 1.1 s. Subsequent thumbnails: 130–280 ms each.
  - One saved change re-renders the 23 clip thumbnails: 2.8–3.5 s wall time, about 3.8 CPU-seconds in Chromium, about 1.25 GB of memory, and a 1.1 s poster re-render.
  - In the browser, the last thumbnail response arrived 3.6 s after the end of one element drag.
  - Thumbnails are full 1920x1080 PNG files (79 KB to 1.16 MB each, 4.4 MB for 23). The timeline shows them in a 52x34 px box.
- **Inferred:** Element edits save every 350 ms, so one drag makes several revisions. Each revision starts Chromium again while the user continues to edit.
- **Fix:**
  - S: Use a visual key for the poster and frame caches (viewport, CSS, edits without audio, `scenesRevision`). The client already calculates such a key in `web/timeline.ts:427-449`. Make it a key for each clip, so that one edit does not make every clip stale.
  - S: Render thumbnails small (about 320 px, JPEG or WebP).
  - S: Stop the delete on each write and use a size limit with least-recently-used removal. Wait until edits stop for about 2 s before a re-render. Cancel requests that a newer revision replaces.
  - M: Keep one browser alive for posters, thumbnails and screenshots. Reload the page on a change. Do not start a new process.

### 3. The capture ZIP is hashed and unzipped on the event loop

- **Where:** `storage.ts:130-132`, `capture-bundle.ts:83-141` (SHA-256 at line 116, `unzipSync` at line 47, 128 MB cache limit at lines 126-133), `library.ts:372-379`.
- **What happens:** `loadBundle` calls `readCaptureEntry(..., "events.json")` only to validate, and then discards the result. On a cache miss, this reads, hashes and fully unzips the archive on the event loop. One decoded demo is about 11.8 MB, so the cache holds about 10 demos.
- **Measured:**
  - `loadBundle`: 108 ms cold, 3.6 ms warm.
  - With 13 recordings, the time until the server listens increased from 0.34 s to 1.5 s, because the cold scan blocks the event loop.
  - With 13 demos, posters that were already on disk took 0.9 s for each library load (about 70 ms each, not 4.5 ms).
- **Inferred:** 27 recordings cost about 2–3 s of blocked event loop on a cold scan, and about 2 s on each library visit.
- **Fix:**
  - S: Remove the capture read from `loadBundle` (a `stat` is sufficient). Verify only when events or assets are served. Read `captureId` from `studio.json`, not from `elements.json`.
  - M: Read ZIP entries only when necessary, trust a size and modification-time key, and move the decompression off the main thread.

### 4. Large payloads that the browser cannot cache

- **Where:** `server.ts:136` and `library-server.ts:135` (`no-store` on all responses), `server.ts:197` (element index inside `/api/workspace`), `server.ts:239-247` (`/api/events`), `library.ts:160-167` (a `command` string for each tour), `server.ts:83-91` (no minify), `server.ts:565-567` (a full file read for each request, including Range requests).
- **Measured:**
  - `/api/library`: 751 KB every 4 s. 746 KB of this is the about 1,500 tours, each with a 309-character command. Only 27 tours have recordings.
  - `/api/workspace`: 3.9 MB. `/api/events`: 5.3 MB. `app.js`: 843 KB (481 KB if minified).
  - Editor open, "film B": 86 requests and 10.9 MB; the network is quiet after 3,981 ms because of thumbnails.
  - Editor open, "film A": 188 requests; the network is quiet after 4,172 ms.
  - Server time for these requests is small (4–11 ms). The cost is transfer and parse on each load.
- **Inferred:** The move from the library to the editor is a full page navigation, so about 11 MB is fetched and parsed again each time. `no-store` also forces a new request for each poster on each library visit.
- **Fix:**
  - S: ETag and 304 on `/api/library`. Remove `command` from tours (build it in the client) and send only the tours that matter.
  - S: `immutable` cache headers for URLs that contain a revision or a content hash (`poster.png?revision=`, `/api/frame?r=`, `/files/assets/*`, keyed audio). ETag on `app.js` and CSS. Minify.
  - M: Serve the element index as a separate resource, cached by `captureId`, or load it only when necessary.

### 5. Plain folders are walked on each poll, and the result is not stable

- **Where:** `library.ts:176-208`, `library.ts:221`.
- **What happens:** For a folder that is not a git repository, the walk is parallel with a shared counter and a limit of 20,000 entries. Which directories the limit cuts off is a race. There is no cache, so each poll walks again.
- **Measured:** Four scans of the same large folder gave 3, 4, 2 and 3 recordings and 275, 171, 246 and 243 tours, at 65–184 ms each.
- **Inferred:** The JSON is different on each poll, so the client renders again and the cards flicker every 4 s. This also applies to a subfolder of a repository.
- **Fix:** S: A breadth-first walk with a sequential budget, and a cached result. M: File watching.

### 6. The editor status poll reads everything every 800 ms

- **Where:** `web/app.ts:1742`, `server.ts:248-270`, `storage.ts:190-217`, `activity.ts:83-117`.
- **What happens:** Each poll runs `loadBundle` (which hashes each scene file up to 5 MB), parses the full history file, and reads up to 80 activity files. It does not stop when the page is hidden, and it always returns 50 history entries.
- **Measured:** 5.3–6.7 ms and 16 KB for each poll on "film A" (58 scene and audio files, 323 KB of history). This is not a cause of the lag at this size, but it grows with the project.
- **Fix:** S: Cache by `stat`, return 304 or only the revision when nothing changed, and send history only on a change.

### 7. MCP

- **Where:** `mcp.ts:313-345` (`get_screenshot` calls `renderReplayFrame`), `workspace.ts:496-502` and `workspace.ts:588-593` (each MCP process builds its own library).
- **What happens:** Each screenshot starts a new Chromium. `list_projects` does a full scan in each MCP process with its own git caches.
- **Measured:** 1.1–1.9 s for each screenshot (the same path as the poster).
- **Inferred:** The first `list_projects` on a large repository costs the 3–4 s cold scan.
- **Why this matters for video quality:** The agent's review loop uses `get_screenshot`. Slow screenshots mean fewer checks. See [video-quality.md](video-quality.md).
- **Fix:** M: Send screenshots through the warm renderer of the Studio service. S: Answer `list_projects` from the Studio service when one runs.

### 8. Desktop shell

- **Where:** `apps/desktop/main.cjs:244-269` (status page, browser check and server start in sequence), `main.cjs:122-137` (`execFileSync` of a login shell with a 5 s timeout, which blocks the main process), `main.cjs:160-164` (starts Bun to check for Chromium), `main.cjs:187-222` (stops and starts the server on each project change), `main.cjs:541` (always opens the last project).
- **Measured:** Electron start to Bun start: 0.55 s. To server listening: 0.92 s (in the hidden test mode, which skips the login-shell probe). The probe is 92 ms and the Chromium check is 0.12–0.17 s.
- **Inferred:** The shell is not the problem. The wait is the cold scan (cause 1) and the posters (cause 2). The user pays for them again on each project change, because all memory caches end with the server process.
- **Fix:** S: Start the server in parallel with the status page and the browser check (about 0.2 s). M: The scan cache on disk from cause 1.

## Browser client

### 9. A backward seek replays the full recording on the live DOM

- **Where:** `web/app.ts:940-947` (`useVirtualDom: false`), `web/app.ts:352-377`, `web/app.ts:1031-1034`, `web/timeline.ts:69-90`, `capture.ts:197-209`.
- **What happens:** rrweb goes backward only by a rebuild from the last full snapshot, followed by every event, applied to the real DOM in one synchronous task. Capture does not set `checkoutEveryNms`, so a recording of one page has one snapshot ("film A": one snapshot for 73 s and 3,034 events).
- **Two seeks for each pointer event:** The timeline calls `setPlaying(false)` (an rrweb seek at the old position and a full `update()`), then `seek()` (a second rrweb seek and a second `update()`). Pointer moves are not combined into one for each frame.
- **Measured ("film A", no throttle):**
  - Drag from right to left: 50.5 ms for each pointer move. Left to right: 14 ms.
  - 29 long tasks in 81 moves, maximum 161 ms, 2,652 ms in total.
  - 39 full rebuilds and 326 rrweb seeks for 162 moves.
  - Most CPU time is in recorded events that are applied again: `focus` 1,085 ms, `blur` 587 ms, `scrollTo` 180 ms, of 5.2 s.
  - One step of 1 s backward: 284 ms at 55% of the film and 350 ms at 85%. Forward: 1–7 ms.
- **Measured at 4x CPU throttle:** 627 ms for each backward move, 58 long tasks, maximum 2,119 ms.
- **Counter-example:** "film B" has 7 snapshots from page navigations. It scrubs at 10 ms for each move in both directions with no long task. The problem applies to long recordings with one snapshot.
- **Also affected:** the left arrow key, a click on an earlier scene or note, agent seek commands, and Play at the end of the film (`web/app.ts:354` goes back to 0).
- **Assets:** Each rebuild requests the captured fonts and images again, because `/files/*` is `no-store` (`server.ts:136`). 56 requests during the scrub.
- **Fix:**
  - S: One seek for each animation frame. Remove the `pause` in `setPlaying(false)` when a seek follows.
  - M: Keyframes. Set the rrweb recorder option `checkoutEveryNms` to about 5,000 at capture (`capture.ts:197-209`, `228-240`). For existing captures, replay one time in Chromium, take a full snapshot every 5 s, and insert the Meta and full-snapshot events. See [rust-architecture.md](rust-architecture.md), "rrweb backward seek".
  - M: Evaluate `useVirtualDom: true` for the synchronous fast-forward. This is the rrweb default; Studio sets it to `false` (`web/app.ts:946`) and the reason is not recorded. If an override hook needs the real DOM, run it one time after the final patch.
  - S: During a fast-forward, skip `focus`, `blur` and scroll events that a later event replaces. Build this index one time for each capture.
  - M: During a drag, show the nearest cached frame and do the real seek when the pointer stops.
  - S: `Cache-Control: immutable` for assets with a hash in the name.

### 10. `update()` does all work again on each frame

- **Where:** `web/app.ts:782-842` (`update`), `web/app.ts:1637-1656` (`tick`), `web/app.ts:760-781` (`frameKey`), `web/app.ts:1319-1327` (mouse move).
- **Measured cost of one update ("film A"):** 1.4 ms with no edits, 2.6 ms with one edit and a selection, 3.9 ms with 26 edits, 4.4 ms with hover and edits.
- **Measured main-thread load during playback:** 17%, 31% and 46% for the first three cases. At 4x CPU throttle, playback drops to 70 frames per second (median 16 ms, 95th percentile 25 ms).
- **Hover while paused:** The pointer position is part of `frameKey` (`web/app.ts:775`), so the full update runs 120 times each second.
- **What the loop does (CPU profile):**
  - It removes and applies the overrides on each frame: `restore()` two times and `apply()` (`web/app.ts:806-810`, `472-488`; `web/element-overrides.ts:172-203`, `267-319`). `apply` alone is 681 ms of 6 s with 26 edits, and it calls `getComputedStyle` between writes (`web/element-overrides.ts:308-311`).
  - `getBoundingClientRect` on recorded elements immediately after these writes forces layout of the 1920x1080 replay document (`web/app.ts:469-471`, `543`, `564`, `588`, `612`): about 150 ms in 6 s.
  - `frameKey` reads `stage.clientWidth` after the write of the playhead `left` (`web/timeline.ts:308`). This forces layout of the Studio document: 164 ms in 15 s.
  - Audio sync allocates for each segment on each frame: `new URL()` (`web/audio.ts:60-63`) and a `JSON.stringify` in `audioIsCurrent` (`model.ts:464-482`).
  - `sceneLayer.cues()` runs `querySelectorAll` in each scene iframe, parses URLs and sorts, on each frame (`web/scenes.ts:332-352`, `web/app.ts:743`).
  - `workbench.updateTime` does a linear `index.elements.find` over 6,792 elements (`web/workbench.ts:325-350`). `timeline.update` runs two `querySelectorAll` calls (`web/timeline.ts:315-331`).
  - `elementEditor.draw()` calls `refresh()` on each frame, also when the Edit panel is hidden, and it always writes `textContent` (`web/element-editor.ts:625-626`, `473`, `495`).
  - `applyAnimations` calls `getComputedStyle` for each target on each frame (`web/app.ts:720`).
- **Fix (M):**
  - Split the update into three paths: time moved, edits changed, selection or hover changed.
  - Apply overrides again only on a revision change or on the rrweb hooks that exist (`event-cast`, `fullsnapshot-rebuilded`, `web/app.ts:948-955`).
  - Cache the cues, the URLs, the segment-start map and the selected record (`recordsByRef` exists).
  - Read layout before writes. Make hover move only the hover box.
  - Limit the loop to 60 Hz. Position the playhead with `transform`.

### 11. Each save reloads everything

- **Where:** `web/app.ts:891-1081` (`runReload`, `renderPanels`), `web/timeline.ts:338-357`, `web/timeline.ts:431-447` (`visualKey` hashes all edits), `web/app.ts:1036-1039`.
- **Measured:** One element drag causes `POST /api/element-edit`, `GET /api/project` and a new request for all 23 clip thumbnails. The page stayed at 120 frames per second during this; the cost is in the server renderer (cause 2).
- **More repeated work:** `timeline.render` runs two times for each reload (`web/app.ts:931-933` and `1079`) and again on each agent activity change (`web/workbench.ts:290-292`, `web/app.ts:1025-1028`). Each run builds all lanes and waveform canvases again.
- **Fix (S–M):** A visual key for each clip, a wait of 1–2 s after the last revision, cancel of replaced requests, a small image size, and no second `timeline.render` when the cues did not change.

### 12. Load: bundles and audio

- **Measured:**
  - "film B" editor: DOMContentLoaded 53 ms, replay ready 142 ms, scenes ready 332 ms, one long task of 64 ms.
  - "film A" editor: ready at 228 ms.
  - Library: cards at 63 ms, posters at 1,827 ms.
  - `app.js` is 843 KB without minify. 567 KB (67%) is zod, because `web/app.ts:14-26` imports helpers from `model.ts`, which builds schemas at import. `new.js` is 636 KB for the same reason.
  - Each narration file is fetched two times: `fetch` and `decodeAudioData` for the waveform (`web/transcript.ts:326-344`), and `new Audio(url)` with `preload=auto` for each segment (`web/audio.ts:67-68`). 28 audio requests for 15 files.
- **Inferred:** The decoded audio stays in memory for the life of the page (16–33 MB for 85 s of speech) and is not removed when audio is generated again.
- **Fix:**
  - S: Move the pure helpers out of the zod module, and minify.
  - M: Calculate waveform peaks on the server, and use `preload=metadata` for segments that are not near the playhead.

### 13. Polls and a loop that does not stop

- **Where:** `web/app.ts:1658-1743` (status every 800 ms, also when hidden, always `markDirty()`), `web/app.ts:1774-1835` and `1916` (preview state every 1.2 s with `outerHTML` and computed style), `web/agent-chat.ts:156-163` (`/api/agents` every 5 s, context every 700 ms), `web/library-app.ts:553` (`/api/library` every 4 s).
- **Measured:** 10 requests in 6 s of idle time. 13 preview-state posts in 15 s of playback. `tick` schedules itself without end (`web/app.ts:1655`): 120 commits each second and 5 full updates each second while paused, about 2% of the main thread.
- **Fix (S–M):** Stop the loop when the player is paused and nothing changed. Use server-sent events or a revision ETag for status. Stop polls when the page is hidden.

### 14. Smaller items

These did not show as lag in the measurements.

- **Scene iframes:** Each scene and overlay page loads at start and stays alive at viewport size (`web/scenes.ts:89-264`). "film A" has 10 documents. Fix (M): create them near the playhead.
- **Edit panel list:** `renderList` and `editableEntries()` run on a selection, revision or visible-scene change, also during playback with the panel hidden (`web/element-editor.ts:551-592`, `web/app.ts:1170-1188`). 24–41 ms for each selection click on "film A" with 26 edits. Fix (S): run only when the panel is visible.
- **CSS:** `.highlight` uses a 3000 px box-shadow (`web/style.css:746-751`). Agent indicators animate `box-shadow` without end (`web/style.css:2448-2463`). `#replay` gets `filter: blur()` on the full recording during overlay backdrops (`web/app.ts:811-816`). The GPU cost is inferred only.

## Not a problem

- **Bundling:** esbuild runs one time for each server start (`library-server.ts:44-61`) and one time for `app.ts` on first use (`server.ts:77-101`). It does not run for each request. 10–15 ms for each bundle.
- **Start:** CLI module load 0.26 s. Listening after 0.34 s warm (0.77 s on the first run) with no recordings.
- **Start work:** No ffmpeg, ffprobe or Playwright on the start, scan or open path. ffmpeg is only in `export.ts` and `invoice-demo.ts`. Chromium is only for posters, thumbnails, screenshots, lifts and exports.
- **Endpoints for one demo:** first editor open 40 ms, `/api/project` 4 ms, `/api/events` 6 ms, `/api/workspace` 7–11 ms, a tracked change (add comment) 14 ms.
- **Walk rules:** The plain-folder walk skips `node_modules`, `.git`, `dist`, `build` and similar folders, and does not follow symlinks (`library.ts:134-157`, `library.ts:200`).
- **Caches that work:** Warm scans use a cache for each recording keyed by `stat`, and tour hashes keyed by modification time. Parallel scans share one run (`library.ts:103-106`).
- **`git status`:** Runs in the background, 2 at a time, and did not reach the 3 s timeout.
- **Agent chat:** Uses server-sent events. Streaming is combined for each frame (from the code; not measured). The `/api/agents` poll costs less than 1 ms warm.
- **Electron:** Process start and the wait for the server (a match on stdout, no sleep loop) are good.
- **Client load:** One esbuild bundle, 4 blocking resources. The project, workspace and events requests take 15 ms in sequence on localhost.
- **Playback:** No full rebuild on Pause or from drift correction, also at 3x–4x throttle. No raster when paused. About 2 tiles repaint for each frame in playback of the recording only.
- **DOM size:** 1,660–2,081 nodes in the main document, 170 in the timeline. The library page has 63 nodes, reuses cards, and compares the response before a render.
- **Panels:** Typing costs 0.8 ms for each key and a drag costs 9 ms for each move, with no long task.
- **CSS:** No `backdrop-filter`. No transitions on layout properties, apart from one progress bar. `font-display: swap` is set.

## Architecture verdict

Manual DOM in TypeScript can be fast with these fixes. The panel code already reuses keyed nodes and compares text, and it measured cheap. The structural work that matters is in the engine: keyframes for seek, and an `update()` that reacts to changes and does not redo all work on each frame.

## Proposed budgets

Use these as exit criteria and as CI checks after the fixes.

| Metric | Now | Target |
| --- | --- | --- |
| Library visible on a large repository, cold | 3.0–3.8 s | < 0.5 s (from the disk cache) |
| CPU while the library is idle | About 2.6 cores | Near zero |
| Thumbnails updated after one edit | 3.5 s | < 1 s |
| MCP `get_screenshot` | 1.1–1.9 s | < 0.3 s warm |
| Backward scrub, longest task | 161 ms (2,119 ms at 4x throttle) | < 50 ms |
| Main-thread load in playback with 26 edits | 46% | < 15% |
| Bytes on a repeat editor open | About 11 MB | < 0.5 MB |
