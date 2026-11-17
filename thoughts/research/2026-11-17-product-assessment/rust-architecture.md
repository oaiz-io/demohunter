# Rust in DemoHunter: architecture, precedents and the desktop shell

> The prototype and benchmark code of this spike (paths that start with `spikes/`) is not in the repository. The films and the repository that the measurements used are private.

**Research date:** 2026-11-17

**Base commit:** `3621b09` (branch `research/studio-speed-video-quality`)

**Scope:** Where Rust can pay off in DemoHunter (CLI, SDK, Studio service, Studio browser client, desktop shell), how comparable tools ship native code, what each integration model costs, and Electron versus Tauri 2. Three other agents build Rust prototypes for the workspace scan and capture ZIP, the Studio export pipeline and the CLI generate pipeline. This document does not repeat that work. It gives the frame for their results.

**Marks:** "Verified" has a URL or a measurement from this machine. "Inferred" is a conclusion from code or from several sources.

## Decision

Do not rewrite DemoHunter in Rust, and do not change the desktop shell. The measured slowness is in process spawns, Chromium launches, rrweb replay on the live DOM, per-frame DOM work and missing HTTP caching. Rust does not remove any of these costs. Fix them in TypeScript first (see [studio-performance.md](studio-performance.md)). After that, if a prototype from the other agents shows a large gain on a pure compute or I/O path (ZIP decode and hash, frame encode, image work), ship it as **one optional napi-rs addon with prebuilt per-platform npm packages and a TypeScript fallback**. The addon must not be required to install or run. Keep the editor, the rrweb engine, the HTTP service, MCP and all orchestration in TypeScript for good. Keep Electron: the editor depends on Chromium behaviour, and the export uses Chromium. A larger Rust move is justified only for a native GPU compositor (camera, cursor, motion blur, zoom on decoded video frames), and only when that feature exists and measures slow in Chromium plus ffmpeg.

## Measurements on this machine

16-core Mac, Bun 1.4.3, Node 22.22.3, Electron 44.8.0. Other agents were benchmarking at the same time, so the numbers are noisy. I report min and median.

### Electron shell, cold start and memory (verified)

Script: `spikes/rust-architecture/electron-start.ts`. It uses the hidden test mode from `apps/desktop/desktop.test.ts` (`DEMOHUNTER_DESKTOP_HIDDEN=1`, `DEMOHUNTER_DESKTOP_DRY_SHELL=1`, a private user-data folder, which also skips the login-shell probe). It opens an empty temporary folder. 7 runs; everything was closed and the temporary folders were removed.

| Metric | Min | Median | Max |
| --- | --- | --- | --- |
| Launch to first window | 289 ms | 301 ms | 787 ms (first run, cold disk) |
| Launch to Studio page loaded | 812 ms | 848 ms | 1,751 ms (first run) |
| Electron processes, summed RSS | 518 MB | 520 MB | 521 MB |
| Bun Studio service, RSS | 162 MB | 165 MB | 172 MB |
| Processes in the tree | 6 | 6 | 6 |

Notes:

- Summed RSS counts shared pages more than once, so the real footprint is lower. Treat 520 MB as an upper bound for the Electron part.
- The 0.85 s to a loaded page agrees with the audit (0.92 s to "server listening"). About 0.3 s is Electron to the first window. The rest is the Chromium check (a Bun spawn) and the Studio service start, which run in sequence (`main.cjs:257-260`).
- On disk: `Electron.app` is 289 MB unpacked (verified, `du`). The bundled Bun is 70 MB. Playwright Chromium (about 270 MB, per the status message in `main.cjs:171`) is needed for export in any shell.

### Boundary costs (verified)

Script: `spikes/rust-architecture/boundary-bench.mjs`. It uses an existing napi-rs addon from `node_modules` (lightningcss 1.32.0), so no Rust build was needed. 3 runs for each runtime; the table shows the median run.

| Boundary | Node 22.22.3 | Bun 1.4.3 |
| --- | --- | --- |
| Load a napi-rs `.node` addon (warm disk) | 1.5–1.8 ms (588 ms on the first cold load) | 1.2–1.6 ms |
| One tiny call into the addon (`transform` of 14 bytes of CSS, includes the work) | 2.6 µs | 2.0 µs |
| One-shot spawn of `/usr/bin/true` | 1.2–1.5 ms | 1.1–1.3 ms |
| Round trip to a warm child over stdio | 6–10 µs | 6–10 µs |
| Call into a tiny WASM function | 1.8 ns | 2.5 ns |

What this shows:

- A napi-rs addon built for Node loads and runs under Bun 1.4.3 without changes.
- A process spawn costs about 1 ms. The audit measured 168 git processes in 44 s, so spawns cost about 0.2 s of that window. The 117 CPU-seconds are the work git does inside each process (mostly system time for `stat` across about 40,000 files). A Rust library that reads the git index (for example gix) does the same `stat` work if it answers the same question. The fix is to ask fewer questions (`--cached`, caches, file watching), not a faster language. (Inferred from the audit numbers and this measurement.)
- Every boundary is cheap compared with the costs in the audit (50–2,000 ms). The integration model matters for distribution, not for speed, unless the code crosses the boundary millions of times.

## Precedents

| Project | Licence | What is in Rust or native code | What stayed in TypeScript or JavaScript | How the binary ships | Published speed numbers |
| --- | --- | --- | --- | --- | --- |
| **Remotion** ([repo](https://github.com/remotion-dev/remotion/tree/main/packages/compositor)) | Remotion licence (source-available, company licence for larger teams) | One Rust binary `remotion` ("compositor"). Its modules (verified in [`rust/main.rs`](https://github.com/remotion-dev/remotion/blob/main/packages/compositor/rust/main.rs)): a long-running process, opened-video manager, frame cache, frame extraction, audio extraction, silent-part detection, video metadata, tone mapping. It links FFmpeg through the C API (`ffmpeg-next`). It powers `<OffthreadVideo>` ([docs](https://www.remotion.dev/docs/video-tags)). | Everything else: React compositions, the bundler, the Puppeteer/Chromium frame capture, the CLI, Studio. | 7 optional dependencies of `@remotion/renderer` 4.0.544: darwin arm64/x64, linux x64/arm64 gnu and musl, win32 x64 (verified, npm registry). Each package carries the binary and shared FFmpeg libraries, about 18 MB unpacked for darwin-arm64. Binaries are built for all platforms on macOS and committed to git, so TypeScript contributors need no Rust ([contributing/rust](https://www.remotion.dev/docs/contributing/rust)). No npm provenance on the compositor package (verified). | No number. Remotion 4 says keeping the video open between extractions through the FFmpeg C API is "much faster" than calling the FFmpeg CLI ([offthreadvideo](https://www.remotion.dev/docs/offthreadvideo)). **Important:** the contributor docs now say: "As we migrate to the new media tags, we will not add any new Rust code, only maintain the existing code." The new `<Video>` from `@remotion/media` uses Mediabunny and WebCodecs in the browser (verified). |
| **Cap** ([repo](https://github.com/CapSoftware/Cap)) | AGPL-3.0 for most code; `cap-camera*` and `scap-*` crates MIT (verified, README) | Almost all of the desktop product: screen capture (ScreenCaptureKit, Direct3D), camera, audio, encoders (AVFoundation, Media Foundation, FFmpeg), muxer, cursor capture, the editor, the renderer and export. `crates/rendering` uses `wgpu` with Metal, Vulkan and DX12 back ends (verified, `Cargo.toml`). There is also a `rendering-skia` crate. | The web app (Next.js), API, dashboard, docs. | Native desktop downloads from cap.so. **Change:** Cap removed its Tauri app on 2026-10-28 ("chore: remove the Tauri app and its build tooling") and now ships `apps/desktop-gpui`, a native GPUI user interface (verified, commit history). | No headline number found. PR #3886 adds GPUI frame benchmarks (A/B per platform). Not verified further. |
| **Hyperframes** (HeyGen) ([repo](https://github.com/heygen-com/hyperframes)) | Apache-2.0 | None. GitHub reports TypeScript and JavaScript only (verified, languages API). | Everything: CLI, core, the engine ("Seekable page-to-video capture engine using Puppeteer and FFmpeg"), producer, Studio editor, player. | npm packages, no native addon. | No speed numbers in the README. The engine gets speed from capture technique, not from native code: Chrome `BeginFrame` capture on Linux, screenshot capture elsewhere, an experimental `drawElement` fast-capture path on macOS with a hardware GPU and a worker that JPEG-encodes frame N while frame N+1 paints ("~1.65–1.96× wall-time speedup"), and static-frame dedup (verified, [`packages/engine/src/config.ts`](https://github.com/heygen-com/hyperframes/blob/main/packages/engine/src/config.ts)). It notes software rendering is "~5-50× slower than GPU". |
| **Rspack** ([site](https://rspack.rs/)) | MIT | The bundler core (with SWC). | Plugin and loader API (webpack compatible), config. | napi-rs: `@rspack/binding` with 14 optional platform packages including `wasm32-wasi`; npm provenance attestations present; darwin-arm64 package 42.7 MB unpacked (verified, npm registry). | Its own table: dev 1.36 s versus webpack 21.40 s; build 3.35 s versus 28.10 s (no method given). |
| **Biome** ([site](https://biomejs.dev/)) | MIT OR Apache-2.0 | The whole tool. | Only a small JS launcher. | A standalone CLI binary, not N-API: `@biomejs/biome` has 10 optional `@biomejs/cli-*` packages, provenance present, 87.4 MB unpacked for darwin-arm64 (verified). | "~35x" faster than Prettier on 171,127 lines (own claim). |
| **oxc / oxlint**, **Rolldown**, **SWC**, **Lightning CSS**, **Tailwind oxide** | MIT; SWC Apache-2.0; Lightning CSS MPL-2.0 | Parsers, linters, bundler, CSS engine. | JS API wrappers, plugins. | All napi-rs with per-platform optional packages: oxlint 19, oxc-parser 19, Rolldown 16 (with `wasm32-wasi`), `@swc/core` 12, Lightning CSS 11 (it uses `detect-libc` to pick gnu or musl), `@tailwindcss/oxide` 12 (with `wasm32-wasi`). Provenance present on the Rolldown and SWC platform packages (verified, npm registry). | Not collected; these are compute-bound tools where Rust wins by large factors. |
| **esbuild** (Go, for contrast) | MIT | The whole tool. | A JS API that talks to the binary over stdio. | 26 optional `@esbuild/*` packages. A long-lived child over stdio. DemoHunter already depends on this model. | Not collected. |
| **OpenCode desktop** ([write-up](https://dev.to/brendonovich/moving-opencode-desktop-to-electron-4hip), [PR #25822](https://github.com/anomalyco/opencode/pull/25822)) | MIT | (Was: a Tauri shell with the `opencode serve` CLI started at launch.) | Server and UI in TypeScript. | Moved from Tauri to Electron 44 in 2026 and deleted `src-tauri/` (verified). Reasons given: "Tauri uses WebKit on macOS and Linux, which not only has worse performance than Chromium when rendering our app, but also has minor inconsistencies with it, especially around styles", and the bundled CLI started at launch "impacted startup time, and occasionally just failed". | No numbers. |
| **Zed / Warp** | — | Native GPU user interfaces. | — | Native apps. | Not relevant: their editors draw text, not recorded web pages. Not researched further. |

### What the precedents show (inferred)

1. **Rust wins where the work is CPU or media bound and does not touch a browser**: parsers, bundlers, linters, video decode and frame caches, native capture and GPU compositing. DemoHunter's slow paths touch git, Chromium or the DOM.
2. **The closest peers stay in TypeScript for the browser-driven part.** Hyperframes (same seek model as DemoHunter Studio) has no native code and gets speed from capture technique. Remotion is freezing its Rust code and moving frame work into the browser with WebCodecs.
3. **Cap is not a model for DemoHunter's editor.** Cap records pixels and composes decoded video frames on the GPU, so native code is the product. DemoHunter records the DOM and replays it in a browser engine. Cap's camera, cursor and zoom renderer is the right model only for a future pixel compositor.
4. **The napi-rs plus optional-dependency layout is the de-facto standard** for Rust in npm, with provenance on each platform package. DemoHunter already publishes `demohunter` with provenance (verified), so the release workflow can extend to platform packages.
5. **Two apps moved away from Tauri in 2026**, in opposite directions: OpenCode to Electron (WebKit rendering), Cap to a fully native UI. Neither result argues for Tauri plus a web editor that needs Chromium.

## Integration options

| Option | Call overhead | Start cost | Bun | Node 20+ | Build matrix | CI and release burden | macOS signing | npm provenance | Contributor friction |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **napi-rs addon, prebuilt per-platform packages** | About 2 µs for a tiny call (verified above). Zero-copy `Buffer` arguments. | About 1.5 ms to load (verified). | Works for the tested addon (verified). Bun says it implements Node-API "from scratch, so most existing Node-API extensions work" ([Bun docs](https://bun.com/docs/runtime/node-api.md)). napi-rs calls Bun support "best effort"; its Bun CI job is `continue-on-error` ([napi-rs compatibility](https://napi.rs/docs/more/support-compatibility)). Open report of abrupt termination during native async work in Bun ([napi-rs troubleshooting](https://napi.rs/docs/more/troubleshooting), issue #2938, not read). | Yes. napi-rs CI tests Node 22, 24 and 26. | napi-rs templates cover darwin arm64/x64, linux gnu x64/arm64, linux musl x64/arm64, win32 x64/arm64, plus a WASI fallback (verified). 7–8 targets for DemoHunter. | A matrix job per target (cross-compile with `zig`/`cross` or native runners), N extra npm packages per release, versions kept in lockstep. Medium. | Not needed for npm. The arm64 linker adds an ad-hoc signature automatically ([summary of Xcode 12 notes](https://mjtsai.com/blog/2020/08/19/apple-silicon-macs-to-require-signed-code/)). npm does not set the quarantine flag, so Gatekeeper does not check it (inferred). For the desktop app, the addon is signed with the app. | Yes, per platform package, as Rspack, Rolldown and SWC do (verified). | Medium. Contributors need Rust only to change the addon if a JS fallback exists; otherwise every contributor needs a Rust toolchain or a published prebuild. |
| **`bun:ffi` with a `cdylib`** | Lower than N-API under Bun (Bun claims 2–6x faster than Node FFI through Node-API). | Small. | Bun docs: "`bun:ffi` is experimental, with known bugs and limitations. Do not rely on it in production." ([Bun FFI docs](https://bun.com/docs/runtime/ffi)) | **No.** Node has no `bun:ffi`. The CLI must run under Node 20+ (README). | Same targets as napi-rs. | Same as napi-rs plus a second binding for Node. | Same as napi-rs. | Same. | High: two bindings, one of them experimental. **Rejected.** |
| **Sidecar binary over stdio or a socket** | 6–10 µs per round trip to a warm child (verified); about 1 ms per one-shot spawn (verified). | One spawn at first use. | Yes (`child_process`). | Yes. | Same targets, but a plain executable is simpler: no Node-API ABI, any Rust version, no libc tie for a static musl build. | Same package layout as esbuild and Biome. Medium. Crash isolation is free: a panic does not kill the Studio service. | Same as napi-rs for npm. Inside the desktop app, sign each extra executable with the hardened runtime for notarisation (inferred). | Yes. | Medium. A JSON protocol to version. Fits long jobs (export, generate) where a separate process is a plus. |
| **WASM (wasm-bindgen, wasm-pack)** | About 2 ns per scalar call (verified). Copies for large data in and out of linear memory. | Compile and instantiate per process or page. | Yes. | Yes. | One artifact for all platforms. | Low: one `.wasm` in the main package; no platform packages. | None. | Yes (part of the main package). | Low to medium. Both tools are alive under the new `wasm-bindgen` GitHub org after the rustwasm org was sunset ([Rust blog](https://blog.rust-lang.org/inside-rust/2025/07/21/sunsetting-the-rustwasm-github-org); verified both repos are active). No threads or SIMD by default without extra flags (inferred). Wasm cannot touch the DOM: "it can only call JavaScript, which then makes the Web API call" ([MDN](https://developer.mozilla.org/en-US/docs/WebAssembly/Guides/Concepts)). |
| **Whole-service rewrite (axum), TypeScript only in the browser** | None inside the service. | Fast native start (Studio already starts in 0.34 s). | Bun is no longer needed for the service. | The npm CLI would become a launcher for a binary. | Full matrix for the whole product. | High: rewrite of the HTTP API, MCP server (about 30 tools), ACP agent bridge, storage, export orchestration and tests. Playwright control from Rust is weak (no official Playwright for Rust; inferred). | The whole service must be signed. | Yes. | Very high. The project's contributors and the `.tour.ts` SDK are TypeScript. **Rejected.** |

### Notes on the options

- **Node 20 is past end of life** (April 2026; inferred from the Node release schedule, not re-checked today). The README still says "Node.js 20 or later". napi-rs CI starts at Node 22. Raise the floor to Node 22 before or with any native addon.
- **Optional dependencies fail quietly.** An install with `--no-optional`, a wrong libc or an unknown platform leaves the platform package out. Every addon needs a clear load error or a TypeScript fallback (inferred; this is why Lightning CSS uses `detect-libc`).
- **The desktop app is simpler than npm.** It bundles one Bun for one architecture (`apps/desktop/scripts/package.mjs`). An addon or sidecar for that architecture goes into the bundle and is signed with it.

## Desktop shell: Electron versus Tauri 2

| Aspect | Electron 44 (now) | Tauri 2 (system webview) | Weight for DemoHunter |
| --- | --- | --- | --- |
| Start to first window | 0.29–0.30 s (verified, median 0.30 s) | Lower is likely (no bundled Chromium), but not measured here | Low. The user waits for the Studio service (0.5 s) and, on a real repository, for the 3–4 s cold scan. |
| Start to Studio loaded | 0.81–0.85 s, empty folder (verified) | The Bun service start (0.34 s or more) stays the same as a sidecar | Low. A Tauri shell saves at most part of the 0.3 s. Starting the service in parallel with the Chromium check saves about 0.2 s in Electron today (audit). |
| Memory | About 520 MB RSS (upper bound, shared pages counted more than once) plus 165 MB for Bun (verified) | Third-party tests disagree widely: 172 MB versus 409 MB ([Hopp](https://dev.to/gethopp/tauri-vs-electron-performance-bundle-size-and-the-real-trade-offs-1el4)), and 142 MB versus 149 MB on Windows (via search summary, not verified) | Medium. The editor holds 10–30 MB of events and audio and an rrweb replay document. The export starts Playwright Chromium anyway, which costs 1.25 GB during thumbnail work (audit). The shell is a small part of peak memory. |
| Download size | `Electron.app` 289 MB unpacked (verified), plus Bun 70 MB, plus Studio dependencies | Third-party figures: 57 MB versus 323 MB ([Better Stack](https://betterstack.com/community/guides/scaling-nodejs/tauri-vs-electron-vs-deno-vs-electrobun/)) | Medium. But DemoHunter needs Bun (70 MB) and downloads Playwright Chromium (about 270 MB) on first run in either shell. The saving is about 290 MB of 630 MB, not 10x. |
| Rendering engine | Chromium, the same engine family as the recording browser and the export browser | WKWebView on macOS (tied to the OS version), WebKitGTK on Linux (tied to the distribution), WebView2 (Chromium) on Windows ([Tauri webview versions](https://v2.tauri.app/reference/webview-versions/)) | **High.** See below. |
| Chromium inside Tauri | — | `tauri-runtime-cef` is `3.0.0-alpha.7` (crates.io, 2026-11-06, verified). Open CEF bugs include a Linux idle main thread at 100% CPU (#16189) and custom-protocol mismatches (#15748) (verified, GitHub). It also brings back the Chromium download size. | Not ready, and it removes most of Tauri's size gain. |
| Auto-update | `autoUpdater` (Squirrel.Mac): "Your application must be signed for automatic updates on macOS" ([Electron docs](https://www.electronjs.org/docs/latest/api/auto-updater)) | Updater plugin: a signature on each update "cannot be disabled" ([Tauri updater](https://v2.tauri.app/plugin/updater/)), plus Apple signing | Equal. Both need an Apple Developer ID and notarisation. The app is ad-hoc signed today (`package.mjs:141-142`). |
| Signing and notarisation | One app bundle with Electron helpers, Bun, Chromium for Playwright (downloaded later, outside the bundle) | One app bundle plus Bun as a sidecar (`externalBin` with a target-triple suffix, [Tauri sidecar](https://v2.tauri.app/develop/sidecar/)) | Equal. Bun must be signed with the hardened runtime and JIT entitlements in both (inferred). |
| Shell code | `main.cjs` is 557 lines of JavaScript | A Rust rewrite of the same shell: window state, menus, the `app://` protocol, the IPC bridge with sender checks, trust prompts, the service life cycle | Rewrite cost for no measured gain. |

### Why the rendering engine matters most (inferred, from the code and the audit)

- The editor replays a recording made in Chromium. Fonts, layout, scrollbars, `focus` and `blur` behaviour and CSS features can differ in WebKit. The person would edit a picture that differs from the exported MP4, which Playwright Chromium renders. That breaks what-you-see-is-what-you-get, which is the point of the editor.
- The audit profiled the hot paths (rrweb seek, `update()`, forced layout) in Chromium. WebKit has different costs for the same DOM work, so the fixes would need a second profile.
- OpenCode left Tauri for this reason with a much simpler UI than a DOM replay editor.

**Verdict:** Keep Electron. Move to Electron 45 (current stable is 45.3.3; verified, GitHub releases) on the normal schedule. The shell work that pays is: start the service in parallel with the Chromium check, keep the scan cache on disk across project changes, and get an Apple Developer ID for signing, notarisation and auto-update. Revisit Tauri only if its CEF runtime is stable and the download size becomes a real complaint.

## Browser client: is there a Rust or WASM angle?

### rrweb backward seek

What rrweb 2.1.7 does (verified, `node_modules/.bun/rrweb@2.1.7/.../dist/rrweb.js`):

- `play(timeOffset)` calls `discardPriorSnapshots`, which keeps events from the last **Meta** event at or before the target time. All events before the target are then applied synchronously (`applyEventsSynchronously`). A forward seek skips the events already played; a backward seek rebuilds from that Meta event.
- `checkoutEveryNms` and `checkoutEveryNth` are recorder options: "take a full snapshot after every N ms" and "after every N events" ([rrweb guide](https://github.com/rrweb-io/rrweb/blob/master/guide.md)). A checkout emits a new Meta and full snapshot, so it becomes a new start point for `discardPriorSnapshots`. This is the built-in keyframe mechanism. Studio does not set it (`apps/studio/capture.ts:197-209`, `228-240`).
- `useVirtualDom` is a replayer option. Its default is `true` (verified, `dist/rrweb.js:16013`). During a synchronous fast-forward, the replayer builds an rrdom tree from the live document and applies mutations to it, then patches the real DOM once ([rrdom README](https://github.com/rrweb-io/rrweb/blob/master/packages/rrdom/README.md): "used in rrweb to optimize replay performance especially when seeking"). Studio turns it off (`apps/studio/web/app.ts:946`, `useVirtualDom: false`). The reason is not in the code or the commit history.

Where the time goes: the audit found most CPU in recorded `focus` (1,085 ms), `blur` (587 ms) and `scrollTo` (180 ms) events applied to the real DOM, plus style and layout. These are browser engine calls. WASM cannot call the DOM directly; it calls JavaScript, which makes the Web API call ([MDN](https://developer.mozilla.org/en-US/docs/WebAssembly/Guides/Concepts)). A Rust rrdom would add a copy across the boundary and still end in the same DOM calls.

**Verdict:** algorithmic, in TypeScript and in capture settings.

1. Set `checkoutEveryNms` to about 5,000 at capture. For existing captures, make keyframes offline: replay once in Playwright Chromium, take a full snapshot with `rrweb-snapshot` every 5 s, and insert Meta plus full-snapshot events (inferred approach; test that the mirror ids stay consistent).
2. Test `useVirtualDom: true` and measure the scrub again. If an override hook needs the real DOM during fast-forward, run it once after `fullsnapshot-rebuilded` and after the final patch.
3. During a fast-forward, skip `focus`, `blur` and intermediate scroll and input events that a later event replaces, and apply only the last state. This is a small event index (last value per node per kind), built once per capture.
4. One seek per animation frame, and no extra seek from `setPlaying(false)` (audit fix S).

The event index in item 3 is the only "index" work, and it is a one-time pass over 3,000 events. JavaScript does this in milliseconds (inferred). WASM gives nothing here.

### Per-frame `update()`

The cost is in `restore()`/`apply()` writes, `getComputedStyle` between writes, `getBoundingClientRect` after writes, `querySelectorAll` per frame and allocations (audit). All are DOM and layout calls or allocation in JavaScript. **Verdict:** algorithmic. Split the update by what changed, read layout before writes, cache, and limit to 60 Hz. No WASM angle.

### Waveform peaks

Peak computation is a loop over a `Float32Array`. It is not the cost; the cost is downloading each narration file twice and keeping decoded audio in memory (audit). **Verdict:** compute peaks once on the server (ffmpeg is already a dependency, or a few lines of TypeScript), cache them by audio hash, and send a small JSON or binary array. A Rust or WASM peak kernel would save microseconds on a job that should run once.

### Where WASM could matter later (inferred)

Only for heavy pixel or media work in the browser: for example a client-side preview of camera zoom with motion blur on video frames, or encoding in the browser. WebCodecs and WebGL or WebGPU already cover most of this without Rust, which is the path Remotion chose with Mediabunny.

## Staged recommendation

### Stage 0: TypeScript fixes (now)

Do the audit's step 1 ([README.md](README.md), "Work plan"). Add the timing budgets to CI. These change the measured numbers by 10–100x where Rust cannot.

### Stage 1: one optional native addon (only if a prototype earns it)

Entry rule: a Rust prototype from the other agents must beat the **fixed** TypeScript path by at least 2x on a cost the user sees (for example more than 200 ms), on real data, under both Node and Bun.

- Model: **one** napi-rs crate, `@demohunter/native`, with prebuilt packages for darwin-arm64, darwin-x64, linux-x64-gnu, linux-x64-musl, linux-arm64-gnu, linux-arm64-musl and win32-x64-msvc. Optional dependency of `demohunter` and of Studio. Provenance on each package.
- Every function has a TypeScript fallback, and a test runs both paths against the same fixtures. If the addon does not load, DemoHunter logs once and continues.
- Use a sidecar binary instead of N-API only for long jobs that should not share the service process (export, generate), or if the Bun N-API async-termination issue shows up in tests.
- Likely candidates (inferred, to be decided by the prototypes): capture ZIP read with a streaming hash and decode off the event loop; frame pipe work in export (JPEG/PNG decode, colour conversion, piping to ffmpeg); image resizing for thumbnails.
- Cost: about 2–4 days to set up the napi-rs project, the cross-build matrix (GitHub runners for macOS, Linux arm64 and Windows, or `zig` cross-compile), the release workflow (manual dispatch, per the project rule) and the fallback tests. Then about 7 extra npm packages per release, Rust in CI on every pull request that touches the crate, and a Rust reviewer for that code.

### Stage 2: a native GPU compositor (only for a new feature)

Trigger: DemoHunter adds a pixel pipeline that Chromium plus ffmpeg cannot do at export speed, for example an automatic camera with motion blur on recorded video, a smoothed cursor with motion blur, or camera-bubble compositing on 4K frames. Measure the Chromium (WebGL or WebGPU in the export page) and ffmpeg-filter versions first; Hyperframes shows how far capture technique alone goes.

- Model: a sidecar binary (like Remotion's compositor), using `wgpu` (like Cap's `crates/rendering`) and FFmpeg through its C API. Frames come in from Chromium capture or from decoded video, effects are applied on the GPU, and frames go out to the encoder.
- Cost: weeks, not days. FFmpeg licence work (LGPL build, as Remotion ships it), GPU back ends per platform, a software fallback for CI and Linux servers, and determinism tests.

### Stage 3: not planned

A whole-service rewrite, a Rust editor UI (Cap's GPUI path) or a Tauri shell. Each would need a new reason, not the current measurements.

### Decision table

| Component | Current cost (audit or this study) | Best TypeScript fix | Rust gain after the TS fix | Integration model | Verdict |
| --- | --- | --- | --- | --- | --- |
| Library scan (git per worktree) | 3.0–3.8 s cold; 2.6 cores while open | `ls-files --cached`, cache worktrees, file watching, scan cache on disk | Small. Spawns cost about 1 ms each; the cost is git's `stat` work, which a Rust index reader also does (inferred) | — | **TypeScript.** Rust only if the scan prototype shows a large gain on the fixed path. |
| Posters, thumbnails, MCP screenshots | 1.1–1.9 s per poster; 3.5 s for 23 thumbnails | One warm Chromium, a visual cache key per clip, small JPEG or WebP, debounce | None. The cost is the Chromium launch and paint | — | **TypeScript.** |
| Capture ZIP hash and unzip | 108 ms cold per demo; event loop blocked | Do not read it in `loadBundle`; stat-based keys; decode in a worker | Medium for the remaining decode and hash (inferred) | napi-rs with fallback | **Candidate for stage 1**, after the TS fix, if the prototype measures a 2x gain. |
| rrweb backward seek | 50 ms per move; long tasks to 161 ms (2.1 s at 4x throttle) | `checkoutEveryNms` keyframes, offline keyframes for old captures, `useVirtualDom: true`, skip replaced focus/blur/scroll, one seek per frame | None. The cost is DOM calls; WASM cannot call the DOM | — | **TypeScript and capture settings.** |
| Per-frame `update()` | 17–46% of the main thread | Split by change, read before write, cache, 60 Hz | None | — | **TypeScript.** |
| HTTP caching and payloads | About 11 MB per editor open; 751 KB every 4 s | ETag, `immutable`, minify, split the element index | None | — | **TypeScript.** |
| Waveform peaks | Double audio download; 16–33 MB decoded in memory | Peaks on the server, cached by hash | None | — | **TypeScript.** |
| Studio export pipeline | Measured by another agent | Warm browser, better capture mode (BeginFrame or screenshot), parallel workers | Possible for frame decode, convert and pipe (inferred) | Sidecar or napi-rs | **Decide from the export prototype.** |
| CLI generate pipeline | Measured by another agent | Same as export; narration cache already exists | Possible for media steps only (inferred) | Sidecar or napi-rs | **Decide from the generate prototype.** |
| Desktop shell | 0.30 s to window, 0.85 s to Studio, about 520 MB RSS (measured) | Start the service in parallel with the browser check; scan cache on disk; sign and notarise | Little start time; size saving about 290 MB of about 630 MB; WebKit risk | Tauri 2 | **Keep Electron.** |
| Future camera, cursor and motion-blur compositor | Does not exist yet | Chromium WebGL or WebGPU in the export page, ffmpeg filters | Large if the feature is GPU-heavy on video frames (Cap, Remotion precedent) | Sidecar with `wgpu` and FFmpeg | **Stage 2, only with the feature.** |

## What I could not verify

- **Tauri numbers on this machine.** I did not build a Tauri app (per the brief). Size and memory numbers for Tauri come from third-party posts with unclear methods.
- **Real Electron memory.** Summed RSS overcounts shared memory. I did not measure with `footprint` or Activity Monitor, and I did not measure the editor with a real demo open.
- **A Rust addon of our own under Bun.** I tested an existing napi-rs addon (lightningcss) only. Async work, threads and shutdown under Bun (napi-rs issue #2938) are untested.
- **Why Studio sets `useVirtualDom: false`.** There is no comment or commit message. It may protect the element overrides or animation hooks during fast-forward. Test before changing it.
- **Offline keyframes for existing captures.** The approach (replay, snapshot, insert Meta plus full snapshot) is inferred and needs a spike to confirm the node ids stay consistent with later incremental events.
- **Cap's published speed numbers** and the reasons for its move from Tauri to GPUI. I found the commits, not a write-up.
- **Remotion compositor gains.** Remotion publishes "much faster", not a number.
- **Node 20 end-of-life date** is from memory of the Node schedule (April 2026), not re-checked today.
- **macOS quarantine on npm installs** (no Gatekeeper check on binaries installed by npm) is inferred from common practice, not from an Apple source.
- **WebKit differences for rrweb replays** are inferred from the engine split and from OpenCode's report, not measured with a DemoHunter capture in WKWebView.
