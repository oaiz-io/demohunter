# Export pipeline: where the time goes, and does Rust help?

> The prototype and benchmark code of this spike (paths that start with `spikes/`) is not in the repository. The films and the repository that the measurements used are private.

**Research date:** 2026-11-17

**Base commit:** `3621b09`

**Spike code:** `spikes/export-pipeline/` (outputs in `out/`, ignored by git). Paths below are relative to that folder unless they start with `apps/`.

## Scope

The Studio video export (`apps/studio/export.ts`, `apps/studio/render.ts`), the single-frame renders that share it (`apps/studio/poster.ts`, MCP `get_screenshot`), and the audio mix. Questions: where does export time go, which fixes inside the Chromium + ffmpeg design are worth it, what do higher quality settings cost, and would Rust (or another native or GPU path) give a real gain.

## Decision

Keep the Chromium + ffmpeg design and keep it in TypeScript. **Rust: no for this area today.** The screenshot is 83% of worker time, and Rust cannot make Chromium paint faster. The two large gains are both TypeScript changes: skip screenshots of frames that cannot have changed (measured: 18% fewer captures on "film A", 53% fewer on "film B", output equal to the noise floor), and keep one warm browser for posters, thumbnails and MCP screenshots (measured: 110–190 ms median per poster and 64–76 ms per thumbnail, against 1.1–1.9 s cold). Also call CDP directly, encode audio during the render, and offer VideoToolbox. The native compositor idea (capture once per DOM change, do camera and blur natively) saves at most 17% more captures on "film A", and it needs larger source captures to keep zoomed text sharp, so the net gain is small. ffmpeg's own filters already do that zoom at about 230 frames per second, so it would not need Rust either. Revisit Rust only if DemoHunter adds a cursor and camera layer that must render outside the browser (as Cap does) or a desktop-native preview. In that case Rust would buy capability. It would not buy export speed.

## How this was measured

- **Machine:** Apple M4 Max, 16 cores, macOS 25.6, Bun 1.4.3, Playwright 1.61, Chromium 1248 (new headless, `channel: "chromium"`, as in the app), ffmpeg 9.0.2.
- **Load:** other agents ran benchmarks at the same time. The 1-minute load average was 11–80 during the runs. Every result shows min and median of 3 runs or more. Spreads of ±20% are noise. A difference smaller than that is marked unreliable.
- **Data:** `<film-a>` (1920x1080, 23 clips, 2 HTML scenes, 7 overlays, 10 camera moves, 4 element animations). Its edited timeline is **116.6 s** today, so 3,498 frames at 30 fps (not the 73–85 s in older notes). `<film-b>` (2,423 frames at 30 fps) was the second check.
- **Harness:** `rig.ts` is a copy of `openReplayRenderer` with switches. `bench.ts` is an instrumented copy of the `export.ts` frame loop: the same `still()` rule, the same chunk queue, the same ffmpeg arguments and the same concat join. `repeat.sh`, `matrix.sh` and `matrix2.sh` run it. `summarize.py` prints the tables. No app file was changed.
- **Marks:** **M** = measured in this spike. **I** = inferred from measurements or code.

## How export works (checked against the code)

- One Chromium per worker loads `/?render=1` from a local replay server (`render.ts:14-52`). Default workers: `min(4, cores/4)`, so 4 here (`export.ts:535`).
- Frames are split into chunks of at least `fps` frames on a shared queue (`export.ts:254-287`). Each chunk goes to its own ffmpeg process (`image2pipe` MJPEG in, libx264 `veryfast` CRF 18 out). The parts are joined with `-c copy` (`export.ts:289-315`).
- For each frame: `page.evaluate(seek)`, then Playwright `page.screenshot` JPEG q90 (q95 when CRF < 18) at device scale factor 1 (`render.ts:68-84`, `export.ts:230`).
- `still()` reuses the previous JPEG only when no scene, overlay, camera, highlight or animation is active and the source time does not move (`export.ts:321-336`).
- Every `fps` frames, `checkRevision()` runs `loadBundle()` again (`export.ts:386`).
- Audio is decoded with ffmpeg, mixed in JS, measured with `ebur128`, gained, optionally limited, and muxed after the video (`export.ts:107-216`, `412-443`).
- The render page keeps its `requestAnimationFrame(tick)` loop alive (`web/app.ts:1912`), and the full `update()` runs once more inside each `seek()` (`web/app.ts:370-377`).

## Stage breakdown (film A, 1080p30, 4 workers, current settings)

End-to-end CLI (`bun apps/studio/cli.ts export ... --fps 30`): **36.5 s min, 47.5 s median** over 4 runs (M; load 30–53, so the median is noisy). Instrumented copy, video only: **26.4 s min, 30.0 s median** over 6 runs (M).

| Stage | Time | Share | Mark |
| --- | --- | --- | --- |
| Server, browser launch, page ready (per worker, in parallel) | 1.55–1.93 s (launch 0.49–0.56 s, page ready about 1.0 s) | about 6% of wall | M |
| Seek (`page.evaluate` round trip) | 2.6–5.3 ms per capture. Work inside the page: 1.3–1.4 ms | 8% of worker time | M |
| Screenshot (Playwright JPEG q90) | 27.5–43.1 ms per capture with 4 workers (20 ms with 1 worker) | **83% of worker time** | M |
| … raster, composite and readback (screenshot with a 2% clip, so encode and transfer are almost zero) | 20–25 ms median, 14–15 ms p10 | most of the screenshot | M |
| … JPEG encode in Chromium (proxy: `OffscreenCanvas.convertToBlob` on a 1080p frame) | 12–14 ms (PNG 42 ms, WebP 104 ms) | overlaps with the next item | M |
| … transfer over CDP (round trip of a 170 KB string) | 1.0–1.7 ms | about 4% | M |
| … Playwright wrapper over raw `Page.captureScreenshot` | 3–6 ms | 10–15% of the screenshot | M |
| `checkRevision()` (`loadBundle` once per second of video) | 2.0–3.7 s summed over workers | about 2% | M |
| Write to ffmpeg stdin (back-pressure) | 0.3–0.6 s summed | < 1% | M |
| x264 encode | Never blocks the pipe. It takes CPU from Chromium: removing the encoder cuts wall time from 30–32 s to 20–24 s | about 25–30% of wall through CPU contention | M |
| Segment join (`concat -c copy`) | 0.28–0.75 s | 1–2% | M |
| Audio: decode 23 files | 0.08–0.17 s, in parallel with the render | 0 on the critical path | M |
| Audio: JS mix 48 ms, `ebur128` 0.42 s, limiter pass 0.11–0.26 s | about 0.7 s, in parallel with the render | 0 on the critical path | M |
| Audio: final mux (limiter, AAC, copy video, faststart) | **1.07–1.39 s** after the render | 3–4% of wall | M |

- **Frames per second per worker:** 28–35 at 4 workers (median of medians), 40 at 2 workers, 16–24 at 6–8 workers (M).
- **Stills:** `still()` skips 233 of 3,498 frames (**6.7%**) at 30 fps and 182 of 2,798 (6.5%) at 24 fps (M). The rule is narrow. It never skips when the camera, an overlay or a scene is active, and those cover most of the film.

## How many frames really change (film A, 30 fps)

Each frame was captured, with and without the camera transform and the backdrop blur (`--css '#camera{transform:none!important}#replay{filter:none!important}'`). Changes were counted with ffmpeg `mpdecimate` against the last kept frame (`classify.ts`, `out/classify-64x2.json`, `out/classify-64x1.json`). Strict threshold, M:

| Frame class | Frames | Visibly changed | Changed without camera and blur |
| --- | --- | --- | --- |
| HTML scene (intro, outro) | 480 | 467 | 444 |
| Overlay on the recording | 1,029 | 778 | 773 |
| Recording plays, camera active | 896 | 736 | 288 |
| Recording held, camera active | 144 | 130 | 0 |
| Recording plays, no effect | 709 | 270 | 267 |
| Recording held, no effect | 240 | 12 | 12 |
| **Total** | **3,498** | **2,393 (68%)** | **1,784 (51%)** |

- Export captures 3,265 frames today. **872 captured frames (25% of the film) are identical to the previous frame** (M).
- **Camera-only or blur-only frames: 609 (17%)** (M). Only a native compositor could skip these.
- With ffmpeg's default (looser) thresholds the totals are 1,970 and 1,390 (M).
- Two identical runs differ in 1,204 of 3,498 frame hashes, but by little (PSNR ≥ 68.7 dB on PNG samples) (M). Raster output is close to deterministic, not bit-exact, so dedupe must use the timeline and must not compare hashes.

## Experiments

All full-film runs: film A, 1080p30, the whole timeline. Wall time covers launch, render and join, without audio (add about 1.2 s of mux). Commands: `./repeat.sh <label> <n> --demo <film A> <flags>`. The matrix is in `matrix.sh` and `matrix2.sh`. Raw lines are in `out/results.jsonl`.

| # | Variant | Flags | Wall min / median (s) | Capture ms per frame (median) | vs baseline | Mark |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | Baseline (Playwright JPEG q90, x264 veryfast, 4 workers) | `--capture pw-jpeg` | 26.4 / 30.0 (6 runs, two sessions) | 26.6–32.5 | – | M |
| 1 | Raw CDP `Page.captureScreenshot` JPEG | `--capture cdp-jpeg` | 30.5 / 32.5 | 28.0 | Within noise in full runs. Single page: **24.8–27.8 ms vs 28.7–32.5 ms (−14%)** | M |
| 2 | `optimizeForSpeed` on JPEG | micro `cdp-jpeg90-fast` | – | 24.4–30.2 vs 24.8–32.8 | **No effect.** Chromium ignores it for JPEG (it only changes PNG and WebP; see sources) | M |
| 3 | PNG with `optimizeForSpeed` (lossless) | `--capture cdp-png-fast` | 32.4 / 40.5 | 36.9 | **+25% slower** wall time. Frames are 520 KB, against 128 KB for JPEG | M |
| 4 | PNG, default | micro `cdp-png` | – | 46–70 | 1.7–2.1x JPEG | M |
| 5 | WebP q90 / lossless | micro `cdp-webp90/100` | – | 84–148 | 3–5x slower | M |
| 6 | `Page.startScreencast` | `--capture sc-jpeg`, 600 frames | 37.4 s vs 18.0 s (CDP) | 39.5 | **2x slower**, and it gives stale frames (no frame comes when nothing was damaged) | M |
| 7 | `HeadlessExperimental.beginFrame` | `--capture bf-jpeg` | – | – | **Not available on macOS.** Chromium returns "BeginFrameControl is not supported on MacOS yet" | M |
| 8 | chrome-headless-shell, CDP JPEG | micro `--browser shell` | – | 30.6–32.6 (full Chromium: 26.7–27.8) | No gain | M |
| 9 | Encoder off (capture only) | `--encoder null` | 20.3 / 24.0 | 22.9 | Lower bound on capture: −24% | M |
| 10 | `h264_videotoolbox` q65 | `--encoder vt` | 23.2 / 26.9 | 22.3 | **−16% to −23%**. q65 loses about 3 dB of quality; see the quality section | M |
| 11 | 2 workers | `--workers 2` | 41.4 / 45.8 | 22.7 | +50% | M |
| 12 | 6 workers | `--workers 6` | 21.3 / 29.1 | 35.3 | −10% median, best min. Unreliable under this load | M |
| 13 | 8 workers | `--workers 8` | 30.4 / 31.7 | 49.3 | No gain. Captures slow down as cores fill | M |
| 14 | **Timeline dedupe** (skip a capture when no scene, overlay, highlight or animation is active, the camera state is the same, and no visual rrweb event falls in between, with a live-page guard) | `--capture cdp-jpeg --dedupe` | 21.7 / 23.2 (baseline in the same session: 26.4 / 28.0) | 24.6 | **−17% wall, 2,684 captures instead of 3,265.** film B: 1,143 captures instead of 2,417 (−53%), render 10.7 s vs 24.9 s (1 run each) | M |
| 15 | Dedupe + VideoToolbox q75 | `--dedupe --encoder vt --vtq 75` | 22.2 / 22.6 | 21.7 | **−19% median** vs the same-session baseline | M |
| 16 | Dedupe + VideoToolbox q75 + 6 workers | `... --workers 6` | 21.6 / 22.7 | 27.0 | Same as 15 | M |
| 17 | 30 fps → 60 fps | `--fps 60` | 55.2 / 62.7 | 28.3 | **2.0x** (6,519 captures) | M |
| 18 | Device scale factor 2, Lanczos down to 1080p | `--dsf 2` | 56.5 / 78.6 | 58–83 | **2.1–2.6x** | M |
| 19 | 24 fps (current default) | `--fps 24 --capture pw-jpeg` | 26.6 / 34.0 | 39.2 | Same as 30 fps within noise. 20% fewer frames | M |

### Single frames (posters, thumbnails, MCP `get_screenshot`)

`micro.ts`, one warm page, 30 random times (forward and backward seeks), 5 runs (M):

| What | Median | p90 | Max |
| --- | --- | --- | --- |
| Cold: new server, Chromium and page ready | 1.6–5.4 s | – | – |
| Warm random seek (includes rrweb rebuilds) | 33–59 ms | 102–124 ms | 137 ms |
| Warm poster: seek + full 1080p PNG (`page.screenshot`) | **110–191 ms** | 317–571 ms | 739 ms |
| Warm thumbnail: seek + 320 px JPEG via CDP `clip.scale` | **64–76 ms** | 130–146 ms | 194 ms |
| Thumbnail capture alone | 22–23 ms, 5.9 KB (a full PNG is 300 KB to 1.16 MB) | – | – |

The 300 ms target holds for the median with a warm browser, at full load. The p90 for a full PNG poster reached 317–571 ms only when the load average was above 40.

## Quality

Same DOM state, captured back to back after one seek (`quality.ts`). 180 frames in 6 ranges: intro scene, camera entry, overlay blur, logic overlay, camera at 90 s, budget at 103 s. Compared with ffmpeg PSNR (Y) and SSIM against the PNG capture (`cmp.py`) (M):

| Comparison | PSNR Y median (min) | SSIM median (min) | Notes |
| --- | --- | --- | --- |
| PNG, run A vs run B (noise floor) | identical in 153 of 180 (68.7 dB) | 1.0 (0.99997) | Near deterministic |
| JPEG q90 vs PNG | 50.3 (46.3) dB | 0.9978 (0.9934) | Capture loss today |
| JPEG q95 vs PNG | 55.6 (50.3) dB | 0.9983 (0.9952) | Capture time +1–2 ms |
| WebP q90 vs PNG | 52.5 (47.3) dB | 0.9984 (0.9959) | 3–5x slower |
| PNG → x264 veryfast CRF 18 | 52.2 (44.0) dB, 1.25 Mb/s | 0.9981 | Encode loss only |
| **JPEG q90 → x264 veryfast CRF 18 (today)** | **50.0 (44.2) dB, 1.72 Mb/s** | 0.9975 | **−2.3 dB and +37% bitrate** compared with PNG input: x264 spends bits on JPEG artefacts |
| PNG → x264 fast CRF 16 (current "publish" setting) | 56.9 (45.8) dB, 1.76 Mb/s | 0.9986 | |
| PNG → x264 veryfast CRF 14 | 55.7 (46.4) dB, 2.15 Mb/s | 0.9985 | |
| PNG → VideoToolbox H.264 q65 | 48.9 (43.4) dB, 1.73 Mb/s | 0.9973 | 3 dB below x264 at the same bitrate |
| PNG → VideoToolbox H.264 q75 | 52.9 (47.2) dB, 2.61 Mb/s | 0.9980 | Same quality as x264 CRF 18 at about 2x the bitrate |
| PNG → VideoToolbox HEVC q65 | 49.2 (44.0) dB, 1.43 Mb/s | 0.9975 | |
| Device scale factor 2 downscaled vs factor 1 | 39.2 (30.0) dB | 0.9980 (0.9909) | Different pixels, but in a side-by-side crop of 1080p text the gain is hard to see |

Bitrates are for the 180-frame sample, which jumps between 6 ranges. They are useful for comparison only.

What this means:

- All variants are above 0.99 SSIM. JPEG q90 is "visually equivalent" by the usual standard. The real cost of JPEG frames is 37% more bitrate at the same CRF, and a 2.3 dB loss compared with lossless input. JPEG q95 removes most of the loss for about 1–2 ms per frame (M). PNG input costs +25% wall time (M).
- Supersampling at factor 2 costs 2.1–2.6x export time (M) for a change that is hard to see at 1080p output (judged by eye on one crop, so this is subjective). The camera zoom is already sharp, because Chromium rasterises the CSS `scale()` at the final size. Use factor 2 for a real 4K export, not for 1080p.
- 60 fps costs 2.0x (M). With dedupe, held and static frames are free, so the extra cost falls to the frames that move (I).

## Where could Rust help?

### (a) Native compositor: one capture per DOM change; camera, cursor, blur and frame done natively

- **Upper bound on savings (M):** 609 camera-only or blur-only frames, 17% of film A. Dedupe in TypeScript already gets the 25% that are fully static. Together they would bring captures from 3,265 to 1,784 (−45%).
- **Prototype (M):** `compositor/` (Rust, `fast_image_resize` + `image`, single thread, release build). From one 3840x2160 capture:

  | Step | Time |
  | --- | --- |
  | Camera crop and Lanczos3 to 1080p | 14.8–15.4 ms |
  | Same with bilinear | 7.4–7.6 ms |
  | 3-pass box blur, 1080p | 9.6 ms |
  | Full-frame alpha composite | 0.7 ms |
  | RGBA → I420 | 2.8 ms |
  | Decode the PNG | 12.5–17.8 ms |

  Camera frame plus I420 is 17.7–18.2 ms on one core. Piped as raw I420 into x264, it ran at 50–52 frames per second.
- **The same zoom in ffmpeg (M):** `crop` with per-frame expressions plus `scale=...:flags=lanczos:eval=frame`, from the 4K PNG, with x264: 300 frames in 1.21–1.40 s (about 230 frames per second). ffmpeg is already native and multithreaded. Rust adds no speed here.
- **The catch (I):** to zoom without blur, the source of a camera frame must be captured at the zoom scale (film A uses 1.1–1.27x) or at 2x. A 2x capture costs 2.1–2.9x a 1x capture (M: 58–83 ms against 22–28 ms). Each of the 288 DOM changes under a camera would cost about 1.6–2.9 capture units. That saves about 200–580 capture units of 3,265, which is **6–18% of export time**, and it brings a second rendering path that must match the CSS path pixel for pixel (I).
- **Cursor:** Studio exports have no cursor today (`.replayer-mouse` is hidden in render mode, `render.ts:39`). A smooth cursor with motion blur, as Cap renders it, is a new feature. It is cheap in any compositor. It can also be a DOM overlay in the replay page, which costs nothing extra because that frame is captured anyway.
- **Verdict:** a small speed gain at a large cost in complexity. It is worth building only together with a native preview or a cursor and camera engine that must render outside the browser.

### (b) Native frame pipe and encoder (`ffmpeg-next`, VideoToolbox) instead of spawning ffmpeg

- The pipe is not a bottleneck. Write back-pressure is under 1% of worker time (M), and the Rust prototype waited 1.0–1.9 ms per raw 3 MB frame (M).
- Starting about 32 ffmpeg processes per export costs little next to 25–30 s (I).
- The encoder choice matters, not the binding. VideoToolbox through the ffmpeg CLI already gives the −16% to −23% (M).
- **Verdict:** complexity only. Cap links ffmpeg through an ffmpeg-next fork because it is a native app with no browser. DemoHunter would gain nothing.

### (c) Audio mix and loudness in Rust

- Audio preparation takes about 0.7 s and overlaps with the render (M). The only audio cost on the critical path is the final mux (1.07–1.39 s, M), and most of that is the limiter plus AAC encode, done after the video.
- **Verdict:** no gain from Rust. Encode the AAC track during the render, then mux with `-c copy`. The mux should drop to about 0.1–0.2 s (I).

### What others do (sources)

- **Remotion** captures with `Page.captureScreenshot` (JPEG q80 default, `optimizeForSpeed: true`). It runs parallel tabs (concurrency = pages), by default in chrome-headless-shell, and does not use BeginFrame. Its Rust "compositor" is a sidecar for video frame extraction (`<OffthreadVideo>`), metadata and audio. It is not in the per-frame screenshot path. Since v4.0.534, Remotion ships a patched Chromium that passes raw bitmaps to ffmpeg through shared memory (Apple silicon, Linux). This is the only real step beyond the screenshot API, and it is a browser patch, not a Rust compositor. Sources:
  - https://github.com/remotion-dev/remotion/blob/47fa0af4d8a89c7e442e3ab4fe6ff67eb7fe16cd/packages/renderer/src/screenshot-task.ts
  - https://github.com/remotion-dev/remotion/blob/47fa0af4d8a89c7e442e3ab4fe6ff67eb7fe16cd/packages/renderer/src/get-concurrency.ts
  - https://github.com/remotion-dev/remotion/blob/47fa0af4d8a89c7e442e3ab4fe6ff67eb7fe16cd/packages/compositor/rust/payloads.rs
  - https://github.com/remotion-dev/remotion/blob/main/packages/docs/docs/shared-memory-capture.mdx
- **Cap** renders zoom (a deterministic spring timeline), a spring-smoothed cursor with velocity motion blur, and background, padding, corners and shadow in wgpu shaders. It encodes through an ffmpeg-next fork, preferring `h264_videotoolbox` on macOS. Its input is screen video, not a DOM, so it has no browser to replace. Sources:
  - https://github.com/CapSoftware/Cap/blob/5fbc709bbfa46d36c782d103e35aaf1b7e83ae46/crates/rendering/src/zoom_spring.rs
  - https://github.com/CapSoftware/Cap/blob/5fbc709bbfa46d36c782d103e35aaf1b7e83ae46/crates/rendering/src/cursor_interpolation.rs
  - https://github.com/CapSoftware/Cap/blob/5fbc709bbfa46d36c782d103e35aaf1b7e83ae46/crates/enc-ffmpeg/src/video/h264.rs
- **Hyperframes** uses BeginFrame only on Linux with chrome-headless-shell. It falls back to `Page.captureScreenshot` on macOS and Windows. Chromium developers state that BeginFrame and virtual time exist only in headless_shell, not in new headless. `optimizeForSpeed` changes PNG and WebP encoding only, not JPEG. Sources:
  - https://github.com/heygen-com/hyperframes/blob/5f8b7a6eeee2241473b4d6fca7485301176987a6/packages/engine/src/services/browserManager.ts
  - https://github.com/heygen-com/hyperframes/blob/5f8b7a6eeee2241473b4d6fca7485301176987a6/packages/engine/src/services/screenshotService.ts
  - https://groups.google.com/a/chromium.org/g/headless-dev/c/WgNE0CAlx-8
  - https://chromium.googlesource.com/chromium/src.git/+/HEAD/content/browser/devtools/protocol/page_handler.cc

## Recommended design

Do these in TypeScript, in this order:

1. **Warm renderer service** for posters, thumbnails and MCP `get_screenshot`. Keep one browser and one page per open project. Reload the page on a revision change and do not relaunch. Capture thumbnails at 320 px with CDP `clip.scale`.
   - Expected: poster 110–190 ms median, thumbnail 64–76 ms, screenshot under 300 ms median (M, at load 30–60), against 1.1–1.9 s. This is the largest user-visible gain.
2. **Timeline dedupe in export.** Replace `still()` with a key built from:
   - the scene, overlay, highlight and animation activity;
   - the sampled camera state (any `target` camera counts as changing);
   - the number of rrweb events before the source time, without mouse moves, touch moves and logs, with a strict `<` boundary.

   Before each skip, seek and check in the page that the replay document has no running animations, no loading fonts and no incomplete images. Prototype: `bench.ts --dedupe`.
   - Expected: −18% captures and −17% wall on film A, −53% captures on film B (M). Larger at 60 fps (I).
3. **Raw CDP capture** in place of `page.screenshot`. Keep `animations` handling equal. Playwright's "disabled" mode is only for projects without scenes.
   - Expected: −3 to −6 ms per frame, about −10% (M on a single page; within noise in full runs).
4. **JPEG q95 by default.** It costs about +1–2 ms per frame and gains +5 dB at capture (M). Do not switch to PNG, which is +25% wall time (M).
5. **Encode the AAC track during the render** and mux with `-c copy` at the end.
   - Expected: about −1 s (I).
6. **Encoder option:** keep libx264 as the default for size and quality. Add `--encoder videotoolbox` (q75) for fast drafts and previews.
   - Expected: −16% to −23% wall on a loaded machine (M), at about 2x the bitrate for the same quality (M).
7. **Workers:** keep 4. 6 was not reliably better, and 8 was not better under this load (M). Use a "check revision" based on `stat` and not a full `loadBundle` once per second.
   - Expected: about −2% (M share).
8. **Quality presets:** 30 fps default (no measurable cost compared with 24 fps, M). 60 fps as an option (2.0x, M; less with dedupe). Device scale factor 2 only for a 4K export (2.1–2.6x, M).

**Expected result for film A at 1080p30 (I, from the measured parts):** about 21–23 s of render, about 0.2 s of mux and about 1.8 s of launch, so about 23–25 s end to end on a quiet machine, against 36.5 s min today (−30 to −35%). The capture cost stays the floor: 2,684 captures at about 22 ms each, over 4 workers, plus encode contention.

**When to revisit Rust:** if Studio needs a native cursor and camera engine shared with a desktop preview, or if Chromium ships a raw-frame path that we can feed into a native encoder (Remotion's shared-memory patch shows the size of that gain, but it means maintaining a Chromium fork). Neither is an export-speed project.

## Risks

- **Dedupe correctness.** The first prototype had an off-by-one at event boundaries: it froze 10 frames of a terminal command on film B at 26 dB. The strict `<` fixed it, and film B then matched within the noise floor (min 56.7 dB vs a floor of 49.5 dB). On film A, one sampled frame of 700 (frame 2200, a dialog under the "cam-wf" camera) still differs at 32.9 dB, SSIM 0.998. The cause is not found. Dedupe must ship with a regression check that compares sampled frames with and without dedupe on real demos.
- **Recorded pages with real-time motion** (spinners, CSS transitions, video, canvas) are not deterministic today either. The page guard catches running Web Animations and CSS animations and transitions, but not JS-driven motion (I).
- **Raw CDP sessions need their own `Emulation.setDeviceMetricsOverride`.** Without it, a raw `Page.captureScreenshot` returned 1x pixels at device scale factor 2, while `page.screenshot` returned 2x (M). The fix is in `rig.ts`.
- **VideoToolbox** quality per bit is lower, and it varies by chip (I). Keep x264 for the final export.
- **A warm browser holds memory** (about 1.25 GB was measured earlier for one thumbnail renderer). It needs an idle timeout and one instance per project (I).

## What could not be measured

- **BeginFrame:** it is not supported on macOS (M). The Linux comparison would need a Docker image of about 2 GB, and the disk was too full.
- **GPU raster:** headless Chromium on this machine uses software raster, so a GPU-composited capture path was not tested. A wgpu or Metal compositor was not built (deps too heavy for the disk budget). From Cap's design, its per-frame cost would be well under 1 ms plus readback (I).
- **Remotion shared-memory capture:** needs Remotion's patched Chromium. Not tried.
- **Clean timings:** the load average was 11–80 throughout. Full-run differences under about 20% (variants 1, 12, 13 and 19) are unreliable. Single-page micro numbers are more stable.
- **Perceived quality:** PSNR and SSIM say nothing about how sharp text looks. The supersampling verdict is from one crop, judged by eye.
- **The cause of the remaining film A dedupe mismatch** at frame 2200.
- **The Electron desktop export path** (it uses the same code; not run).
