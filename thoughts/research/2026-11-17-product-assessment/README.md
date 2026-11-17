# Product assessment: Studio speed and video quality

**Research date:** 2026-11-17

**Base commit:** `3621b09` (`main`, after "[alpha] DemoHunter Studio", #28)

**Scope:** The DemoHunter CLI and SDK, DemoHunter Studio (`apps/studio`), the desktop shell (`apps/desktop`), the MCP server and the agent skills. Three questions: why is Studio slow, why are agent-made films not good enough, and what else must change.

**Decision:** Do the speed work first, then build quality tools that make the agent check its own film, then add recording polish and a block library, then add new film types and a real install path. Do not rewrite the editor. Do not move code to Rust now: four spikes with prototypes found no area where Rust is faster than the fixed TypeScript path by a margin that a user sees.

**Not in the repository:** the prototype and benchmark code of the spikes (paths that start with `spikes/` in these documents), and the two detailed film reports. The films and the large repository that the measurements used are private, so these documents call them "film A", "film B" and "a large private repository".

## Status of the work on this branch

| Part | State |
| --- | --- |
| Research | Complete. The documents in this folder. |
| Studio speed (work plan step 1) | Built, items 1 to 10. Results in `.planning/quick/261117-spd-studio-speed-fixes/SUMMARY.md`. Not done: keyframes and the virtual DOM for backward seek (both broke replay), the CI timing budget, and the export and CLI speed items 12 and 13. |
| Rust | Not used. See Finding 4. |
| Video quality | Built in the direction that the owner set: one general film skill (`demohunter-film`), `studio new`, `studio sheet`, scene kit helpers, and camera windows that chain. Summary in `.planning/quick/261117-flm-general-film-tools/SUMMARY.md`. The gate, the critic agent and the storyboard validator from the earlier plan are not built, by decision. |
| Next | Make films end to end with the new skill and look at the result. Then the tools that are not built: a layout query, word timings for narration, licensed media search, music with cue data, brand capture. |

| Document | Contents |
| --- | --- |
| [studio-performance.md](studio-performance.md) | Measured causes of slowness on the server and in the browser client, with file references, numbers and fixes |
| [video-quality.md](video-quality.md) | What the best open-source tools do, the gaps in DemoHunter, and build-or-integrate advice |
| [skills-and-tools.md](skills-and-tools.md) | **Current direction for quality:** how one agent makes a good film with opinionated skills and tools; the plan template; the missing tools |
| [quality-evidence.md](quality-evidence.md) | Evidence test of the quality plan, and the revised plan |
| [quality-evidence-external.md](quality-evidence-external.md) | Published evidence for and against the three claims of the plan |
| [rust-scan-and-capture.md](rust-scan-and-capture.md) | Rust spike: workspace scan and capture file, with a TypeScript fix and a Rust prototype measured together |
| [rust-export-pipeline.md](rust-export-pipeline.md) | Rust spike: Studio export and frame render, with a stage profile, capture experiments and a compositor estimate |
| [rust-cli-generate.md](rust-cli-generate.md) | Rust spike: CLI `generate` pipeline, with a stage profile, encoder experiments and quality measurements |
| [rust-architecture.md](rust-architecture.md) | How to add Rust: precedents, integration options, desktop shell, WASM in the client |

## Where we are

| Area | State |
| --- | --- |
| CLI and SDK | Stable. npm `demohunter` v0.1.6 (2026-09-02). A `.tour.ts` file becomes MP4, captions, chapters, a poster and a checksummed manifest. OpenAI and ElevenLabs speech with a local cache. |
| Studio | Alpha, merged in #28. rrweb DOM capture into one `capture.dhcapture` file, a browser editor, HTML scenes and overlays, element lifts, a generated score and sound effects, parallel export, an MCP server with about 30 tools, and Claude Code or Codex inside the app over ACP. It runs only from a source clone with Bun. |
| Desktop app | Alpha. An Electron shell, unsigned, Apple silicon, published by hand as a GitHub pre-release. |
| Skills | `demohunter` (write tours, shipped in the npm package), `demohunter-replay` (edit a capture) and `demohunter-commercial` (60–90 s product film). The last two are in `.agents/skills/` and Studio installs them. |
| Planning | No active milestone. `.planning/ROADMAP.md` still shows "v1.1 Output Quality" as active, but `STATE.md` says that no milestone is active. |
| Open pull requests | #19 Kokoro local TTS (July), #20 video generation agent concept (July), #23 DemoHunter Review (August), #27 SaaS app demo research (September), #29 esbuild update (October). |

## Finding 1: Studio speed

The server starts in about 0.3 s and the editor is interactive about 0.2 s after navigation. The slowness has specific causes, and most fixes are small. A framework or a rewrite does not help, because the costs are in the scan, the renderer, the playback engine and the request patterns.

| # | Cause | Measured | Effort |
| --- | --- | --- | --- |
| 1 | The library poll runs git in every worktree | 3.0–3.8 s cold scan; about 2.6 cores busy while the library page is open | S, then M |
| 2 | Each poster starts a new Chromium, and each edit makes all thumbnails stale | 1.1–1.9 s for each poster; one drag re-renders 23 full 1080p PNG files in about 3.5 s | S, then M |
| 3 | A backward seek replays the full recording on the live DOM | 50 ms for each pointer move, long tasks to 161 ms; 2.1 s at 4x CPU throttle | S, then M |
| 4 | `update()` does all work again on each frame at 120 Hz | 17–46% of the main thread during playback | M |
| 5 | All responses are `no-store`, and payloads are large | About 11 MB downloaded again on each open; 751 KB of library JSON every 4 s | S |
| 6 | The capture ZIP is hashed and unzipped on the event loop | 108 ms for each demo cold; the cache holds about 10 demos | S, then M |

Details, more causes and the list of things that are not a problem: [studio-performance.md](studio-performance.md).

## Finding 2: Video quality

The commercial skill is already detailed, and it already borrows from Hyperframes and brag. The gap is in the tools. The best projects enforce quality with commands that measure the film. DemoHunter asks the agent to do the same checks by hand with shell snippets, and each screenshot costs 1.1–1.9 s, so agents do fewer checks.

| # | Gap | What the best tools do |
| --- | --- | --- |
| 1 | No automatic quality gate | Hyperframes `check --json`: numeric limits for read time, dead stretches, text size, contrast and overflow, each with a fix line |
| 2 | Review is manual | Hyperframes `snapshot --review` writes contact sheets and cut strips; a critic with a clean context reports exact changes |
| 3 | Slow screenshots | One warm renderer (the same fix as speed cause 2) |
| 4 | Small scene kit (18 helpers) | Hyperframes has 456 registry items; video-shotcraft has 124 shot recipes |
| 5 | No automatic camera in a Studio film; the cursor is small | Cap and Screenize: a spring camera on click clusters and a smoothed cursor |
| 6 | Low export defaults (24 fps, scale factor 1, JPEG frames) | Supersampled frames and 30 fps |
| 7 | Music is written in code; captions have no word timing | Curated tracks with cue sheets; word-level timestamps |
| 8 | One film type only | Pipelines for explainers and documentaries with sourced assets |

Details, sources and licences: [video-quality.md](video-quality.md).

### Evidence test of the quality plan

The plan was tested in three ways: published evidence, a blind critic on two real agent-made films, and a prototype gate on the same films. Details: [quality-evidence.md](quality-evidence.md).

- **The films that the agent declared complete have 44 defects** (blind critic; 1 P0, 15 P1, 28 P2).
- **A numeric check can find 7 of the 16 serious defects.** Story and pacing cause 5. The raw-recording look causes 2, scene design 1, and the name of a test fixture user on screen 1.
- **The largest visible gap is unreadable product footage:** full-width tables with no zoom, text of about 2–3 px at phone width, for most of the film.
- **Scene design is not the weak point.** The added scenes are the best part of the films. The block library moves down in priority.
- **The prototype gate found 12 real defects in "film A" that the agent missed, in 42 s.** Without tuning, only 25% of its findings were real. A narrow, tuned gate is worth it; a broad one sends the agent after false alarms.
- **Published evidence:** a critic helps (Code2Video: −6.5 aesthetics points without it), but the plan step matters more (about −41 points without the planner). Agents grade their own work too high. Vision models are weak at fine detail and timing.

The revised order after the evidence test was: storyboard gate → narrow `check` → `review` with a clean-context critic → camera and crop for readable footage → blocks as structure parts.

### Owner direction: skills and tools for one agent

The owner then set the direction (2026-11-17): DemoHunter is a general-purpose HTML video tool for agents; quality comes from the agent with opinionated skills and good tools; a plan and story step is wanted; reviewer agents, gates, test systems for films and agent pipelines are not wanted. Details: [skills-and-tools.md](skills-and-tools.md).

What the research for this direction found:

- **The best skills-only projects do three things.** The agent writes the story in words first. Taste becomes numbers, with the default looks named and banned. The agent gets cheap ways to see and measure its own frames.
- **Short, focused skills work; long ones do not.** SkillsBench: curated skills add 16.2 points on average, "comprehensive" skills lose 2.9. A router skill with genre files is the pattern.
- **Strong models need less scaffolding.** brag changes to a one-file skill on the newest models.
- **One agent is faster than a split.** Hyperframes measured about 9 minutes with one agent against about 21 minutes with sub-agents for the same five scenes.
- **DemoHunter cannot make a film with no recording now.** A project with HTML scenes only fails at export, because the project format requires a capture. The film skill is only for product ads.
- **The camera is not the missing tool.** It can zoom to 4 times on an element. The test film used 1.14 to 1.23, because the skill asks for small zooms. Readable footage is a skill fix.

What to build:

1. One general film skill: a short router, references for story, look, motion, sound and words, and genre files for product film, explainer, documentary or essay, data story and social short. The plan file (`PLAN.md`) is the first step of each film.
2. `studio new`: a film project with no recording, at any size.
3. `studio sheet`: contact sheets of the film that the agent looks at itself.
4. Scene kit helpers: text fit, read time, pan and zoom on stills.
5. Later: a layout query, word timings for narration, licensed media search, music with cue data, brand capture.

## Finding 3: Other things

- **Install path.** Studio is a private workspace package. A user cannot run it with `npx`. The desktop app is unsigned.
- **Skills are in two places.** `npx demohunter add-skill` installs only the tour skill, and it writes the Codex copy to `.codex/skills`. Studio installs three skills and writes to `.agents/skills`.
- **Two capture pipelines.** The CLI records pixels with Playwright. Studio records the DOM with rrweb. Each has its own output format, and effects such as the smooth cursor exist only in the CLI.
- **No speed tests.** CI runs build, typecheck and tests, but no timing budget. The speed problems arrived without a signal.
- **Unstable scan of plain folders.** A folder that is not a git repository gives a different result on each poll (see speed cause 7 in the details). This is a correctness bug.
- **Planning hygiene.** Close or merge the five old pull requests, and make `ROADMAP.md` agree with `STATE.md`.

## Finding 4: Rust

The owner accepts a move of parts of the codebase to Rust if it gives a real speed gain. Four spikes tested this with prototypes and measurements. Each spike compared three things: the current code, the best fix in TypeScript, and Rust.

**Verdict: no Rust now, in all four areas.** The slow parts are git work in the kernel, Chromium paint, DOM calls in the browser, real-time recording and missing HTTP caches. Rust makes the same system calls and cannot make Chromium paint faster. The TypeScript fixes give gains of 10 to 30 times where it matters; Rust adds a few milliseconds more. Rust is the correct tool for one future feature: a native compositor for cursor and camera that renders outside the browser. That is a capability decision, not a speed fix.

| Spike | Question | Code | Status |
| --- | --- | --- | --- |
| Scan and capture | Is a Rust scanner (no git processes, file watch) and a lazy ZIP reader faster than the TypeScript fix? | `spikes/rust-scan/` | Complete |
| Studio export | Where does export time go, and does a native compositor or encoder help? | `spikes/export-pipeline/` | Complete |
| CLI generate | Where does `demohunter generate` time go, and does native code help? | `spikes/cli-generate/` | Complete |
| Architecture | napi-rs, `bun:ffi`, sidecar or WASM; Electron or Tauri; what comparable tools do | `spikes/rust-architecture/` | Complete |

### Result: architecture

Details: [rust-architecture.md](rust-architecture.md).

- **No rewrite in Rust, and keep Electron.** Do the TypeScript fixes first.
- **Entry rule for Rust:** a prototype must be a minimum of 2 times faster than the fixed TypeScript path, on a delay that the user sees, on real data, in Node and in Bun.
- **Integration model, if a prototype passes:** one optional napi-rs addon with a package for each platform and a TypeScript fallback. A sidecar binary for long jobs (export, generate). `bun:ffi` is rejected (experimental, and Node cannot use it). A full service rewrite is rejected.
- **Boundary costs are small (measured):** an addon loads in about 1.5 ms in Node 22 and in Bun 1.4.3, a small call costs about 2 µs, and a process start costs about 1 ms. The 168 git processes in the 44 s poll window cost about 0.2 s in starts; the other 117 CPU-seconds are the work in git.
- **The browser hot paths have no WASM solution.** The cost of a backward seek is `focus`, `blur` and `scrollTo` calls on the live DOM. rrweb has the fix built in: `checkoutEveryNms` at capture (keyframes), and `useVirtualDom`, which is `true` by default and which Studio sets to `false` (`apps/studio/web/app.ts:946`) with no recorded reason.
- **Precedents:** Hyperframes has no native code and gets its speed from the capture method. Remotion adds no new Rust code and moves frame work into the browser with WebCodecs. Cap is all Rust because it composes recorded pixels on the GPU.
- **Shell (measured):** Electron shows its first window in 0.30 s and the Studio page in 0.85 s. Tauri uses WebKit on macOS, so the editor preview would not agree with the Chromium export. OpenCode moved from Tauri to Electron in 2026 for this reason.
- **A larger Rust move has one good reason:** a native GPU compositor for camera, cursor and motion blur, when that feature exists and Chromium with ffmpeg is too slow for it.

### Result: scan and capture

Details: [rust-scan-and-capture.md](rust-scan-and-capture.md). Verdict: **no Rust for this area.** The TypeScript fix gets about 95% of the gain. The cost is in the algorithm (a full worktree walk and a `git status` on a timer), and most of it is kernel time. Rust makes the same system calls: `gix status` took as long as `git status` (99–256 ms against 139–262 ms for each worktree).

Measured on the large repository with 13 checkouts, minimum / median. The machine load was high (load average 20–168), so compare the minimums; the order was the same in each of 5 rounds.

| | Current | TypeScript fix | Rust |
| --- | --- | --- | --- |
| Cold scan, library visible | 2,855 / 4,245 ms | 108 / 137 ms | 33 / 37 ms without status; 2,112 / 2,336 ms with status |
| Poll with no change | 59 / 97 ms | < 0.01 ms (cached) | 0.18 / 0.26 ms (sidecar) |
| CPU while the library is open | 1.0 / 1.6 cores | 0.021 / 0.044 cores | 0.000 / 0.049 cores (watcher) |
| Read and verify `events.json` ("film A") | 114 / 120 ms | 3.9 / 4.1 ms | 3.4 / 3.4 ms |

- **The TypeScript fix is a working prototype** (`spikes/rust-scan/ts/fixed-scan.ts`): `git ls-files --cached` only, a check for `.demohunter` folders adjacent to tours, a cache, `fs.watch`, and `git status` a maximum of one time each 15 s for a changed worktree. Its output agreed with the current code in 13 of 13 worktrees.
- **Capture file:** the gain comes from the decompression of one entry with the native zlib of Bun, not the JavaScript inflate of fflate. The hash was not the cost (0.46 ms).
- **JSON:** `JSON.parse` in Bun (4.0 ms) was faster than `serde_json` (7.5 ms) and near `simd-json` (3.4 ms). The server does not parse `events.json`, so a native parser has no work to do.
- **Integration (built and measured):** a sidecar binary over stdio costs about 0.2 ms for each call and about 60 ms to start. `bun:ffi` costs about 5 ns for each call, but only Bun can use it and it is experimental.

### Result: CLI generate

Details: [rust-cli-generate.md](rust-cli-generate.md). Verdict: **no Rust for this area.** Pass 2 records in real time, so it is as long as the video: 58.6 s of a 70.0 s warm run (84%, measured). Most of the remaining time is already native code (ffmpeg, x264, the AAC encoder, Chromium). Bun used 0.7–0.9 s of CPU in the 70 s run. A Rust SHA-256 prototype was slower than TypeScript for the output folder (7.5 ms against 4.3 ms). A native ffmpeg binding would save about 33 ms for each process start, 0.1–0.4 s for each run.

What to change in TypeScript:

- **Own the video encoder.** Take frames from `page.screencast.start({ onFrame })` and encode H.264 one time during pass 2. The mux step then copies the video stream. Measured: post-processing 5.4 s → 1.2 s.
- **Cache the pass-1 timeline**, and run pass 1 again only if the replay diverges. Measured: 4.9 s saved. With both fixes, a 58.7 s video took 63.0 s, not 70.0 s.
- **Encode variants in parallel.** Measured on the encode step: 35% faster. One ffmpeg filter graph for all variants was 3–6 times slower.
- **Resolve narration that is not in the cache in parallel.** Estimated, not measured (no paid API calls).

Quality findings (measured):

- The Playwright recorder encodes VP8 at a limit of about 1 Mbit/s, and DemoHunter then encodes the result again to H.264. One H.264 encode of the same frames was about 5 dB better on the median frame and 12–13 dB better on the worst motion frames, and the file was smaller (250 against 295 kbit/s).
- The screencast does not send retina frames. At device scale factor 2, Chromium sent 1440×900 frames.
- The `mobile` preset records the full tour again in real time, so a run takes two times as long (146.5 s against 74.6 s).

The two pipelines: a Studio export completes in 0.26–0.38 times the video length and is frame-exact; the CLI cannot be faster than real time. Keep the two capture modes, but share one encoder back end.

The machine load was high (load average 33–168), so the ffmpeg times can be 2–5 times too high. The pass-1 and pass-2 times were stable.

### Result: Studio export

Details: [rust-export-pipeline.md](rust-export-pipeline.md). Verdict: **no Rust for this area.** The screenshot is 83% of the time of each worker, and 20–25 ms of each screenshot is Chromium paint. JPEG encode, transfer (1–1.7 ms) and the Playwright wrapper (3–6 ms) are small.

Measured on "film A" at 1080p30 with 4 workers. The machine load was high (load average 11–80), so differences of less than about 20% are not reliable.

| Item | Result |
| --- | --- |
| Export now | 36.5 s minimum for a 116.6 s film (3,498 frames); 28–35 frames each second for each worker; the still-frame rule skips only 6.7% of frames |
| Skip of frames that cannot change (timeline key) | 18% fewer captures on "film A", 53% fewer on "film B"; wall time −17% on "film A" |
| One warm browser | Poster 110–190 ms, thumbnail 64–76 ms, against 1.1–1.9 s cold |
| VideoToolbox encoder | 16–23% faster, but about 2 times the bitrate for the same quality; keep x264 as the default |
| 30 fps against 24 fps | No measurable cost |
| 60 fps; supersampling | 2.0 times; 2.1–2.6 times, for a gain that is hard to see at 1080p |
| JPEG frames | −2.3 dB and +37% bitrate compared with PNG input; JPEG quality 95 recovers most of this for 1–2 ms each frame; PNG costs +25% wall time |
| Expected export after the TypeScript changes (inferred) | 23–25 s, −30 to −35% |

Rust options that the spike evaluated:

- **Native compositor:** frames that change only because of the camera or blur are 17% of the film. Zoomed text needs captures at 2 times the size, so the net gain is 6–18%. The ffmpeg filters already do this zoom at about 230 frames each second.
- **Native encoder pipe:** the pipe is less than 1% of the time.
- **Audio in Rust:** no gain. Audio runs in parallel with the render; only the last mux (1.1–1.4 s) is on the critical path.

Notes:

- `HeadlessExperimental.beginFrame` is not supported on macOS, and `optimizeForSpeed` does nothing for JPEG.
- The frame-skip prototype needs a regression check before release. One sampled frame of 700 on "film A" still differs (32.9 dB, cause not found).
- A raw CDP session must set its own device metrics, or it returns 1x pixels at scale factor 2.

## Work plan

Each step is a candidate phase for the next milestone. The order matters: the warm renderer in step 1 also makes the review loop in step 2 fast.

### Step 1: Make Studio fast

Small fixes first:

1. List tours with `git ls-files --cached` only, cache the worktree list, and refresh worktrees that are not current less often. Port the prototype `spikes/rust-scan/ts/fixed-scan.ts` (cold scan 2.9 s → 0.11 s, idle CPU 1.0 → 0.02 cores, same output in 13 of 13 worktrees).
2. Use a cache key from visual data only for posters and thumbnails, render thumbnails small (about 320 px JPEG or WebP), stop the delete of old frames on each write, and wait until edits stop before a re-render.
3. Remove the capture read from `loadBundle`. Where an entry is necessary, read one entry with the native zlib of Bun (114 ms → 4 ms; `spikes/rust-scan/ts/capture-bench.ts`).
4. Send ETag and immutable cache headers, minify the bundles, and move the pure helpers out of the zod module.
5. Do one seek for each animation frame during a scrub.
6. Make the scan of plain folders deterministic and cached.

Then the medium fixes:

7. Keep one warm browser for posters, thumbnails and MCP screenshots (measured: 64–190 ms for each image; `spikes/export-pipeline/rig.ts`). Give it an idle timeout.
8. Write a keyframe about every 5 s at capture (rrweb `checkoutEveryNms`), make checkpoints for existing captures, and test `useVirtualDom: true`.
9. Split `update()` so that work runs only for what changed, and limit it to 60 Hz.
10. Watch files instead of polling, and keep the last scan on disk so that the library shows at once.
11. Add a timing budget to CI from the benchmark scripts.

Export and CLI speed (from the spikes):

12. Studio export: skip frames that cannot change (with a regression check), call CDP directly, JPEG quality 95, encode audio during the render, and add a VideoToolbox option for drafts. Expected: 36.5 s → 23–25 s on "film A".
13. CLI `generate`: encode H.264 one time from screencast frames (also about 5 dB better video), cache the pass-1 timeline, encode variants in parallel, and do not record the tour again for the `mobile` preset where a crop is sufficient.

Exit criteria: library visible in less than 0.5 s on a large repository, near-zero CPU while the library is idle, backward scrub with no long task above 50 ms, thumbnails updated in less than 1 s after an edit.

### Step 2: Make the agent check its film

Revised after the evidence test ([quality-evidence.md](quality-evidence.md)).

1. **Storyboard gate, before any render.** A storyboard file with a fixed structure that a command validates: the hook and the product on screen in the first seconds, the payoff early, one idea for each beat, each narration line matched to what the screen shows at that time, a realistic demo account, a runtime budget.
2. `studio check`: a narrow, tuned gate with an evidence crop and a fix line for each finding. Start with the checks that were correct in the prototype: seam pops at lift hand-overs, read time, font size by text role, contrast below 3:1, phone-width legibility of product footage, empty first frame, dead stretches, loudness.
3. `studio review`: contact sheets, a strip across each cut, a phone-width sheet and full-size crops of text.
4. A critic step in the skill: a sub-agent with a clean context that sees only the storyboard and the sheets and reports `time · where · problem → exact change`. No scores. A maximum of 3 rounds.
5. MCP tools for these commands, so that agents inside Studio use them.

Exit criteria: the commercial skill cannot reach "done" without a valid storyboard, a clean `check` result and one reviewed set of sheets. The two test films are the regression set: the gate must find their known defects with few false alarms.

### Step 3: Recording polish and blocks

1. An automatic camera and crop that keep the active part of the product readable, also at phone width. The camera is a cue that follows the narration, not decoration. This is the largest visible gap in the test films.
2. A larger cursor with a click pulse, and a spotlight on the target.
3. Better export defaults: 30 fps (no measurable cost) and JPEG quality 95 frames. Supersampling only for a 4K export (2.1–2.6 times the cost).
4. A block library of structure and motion parts that take the brand tokens as input, as editable source. This has a lower priority than before: scene design was not the weak point in the test films. Evaluate the Hyperframes engine, lint and registry first (Apache-2.0, the same seek model).
5. Curated music with cue sheets, and word-level timestamps for captions.

### Step 4: New film types and distribution

1. An explainer and documentary pipeline: script, shot list, sourced assets with a licence record, edit, review and a fact check.
2. An install path for Studio that does not need a source clone, and a signed desktop app.
3. One home and one installer for all skills.

### Rust: when to look again

- A cursor and camera layer that must render outside the browser, or a native desktop preview. Use a sidecar binary with `wgpu`, as Cap does.
- A profile after the TypeScript fixes that shows CPU-bound work in JavaScript that the design cannot avoid.
- The entry rule: a prototype is a minimum of 2 times faster than the fixed TypeScript path, on a delay that the user sees.

## Method and limits

- Three audits ran in parallel: Studio server and start, Studio browser client, and web research on open-source video tools. Four Rust spikes followed, with prototype code that is not in the repository.
- The Rust spikes ran at the same time on a machine with a high load from other work (load average to 168). They report minimum and median values. The order of the results was stable; small differences are not reliable.
- The speed numbers are from a 16-core Mac with Bun 1.4.3 and a warm disk. The scan numbers are from a large private repository with 12 worktrees, about 40,000 tracked files and 27 recordings. The editor numbers are from copies of two real demos ("film B" and "film A").
- The browser numbers are from headless Chromium, which uses software raster. GPU cost and the Electron shell were not measured.
- Each number in the detail documents is marked as measured or inferred.
- The benchmark scripts are in the workspace scratch folder `.context/perf/`, which git ignores. Move them into the repository in step 1, item 11.
- Stars and licences of external projects are from the GitHub API on the research date. Items that were not verified are listed in `video-quality.md`.
