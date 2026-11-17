# CLI generate pipeline: where the time goes, and does Rust help?

> The prototype and benchmark code of this spike (paths that start with `spikes/`) is not in the repository. The films and the repository that the measurements used are private.

**Research date:** 2026-11-17

**Base commit:** `3621b09` (branch `research/studio-speed-video-quality`)

**Spike code:** `spikes/cli-generate/` (scripts, fixture site, spike tour, Rust hash prototype). Raw run reports were written to `spikes/cli-generate/out/` (git-ignored, local only).

**Marks:** **(M)** = measured on this machine in this spike. **(I)** = inferred from code or from other numbers. **(S)** = measured by the sibling Studio-export agent (`spikes/export-pipeline/`).

## Scope

`demohunter generate` from the CLI down to the manifest: config and tour load, browser launch, pass 1 (timeline collection and narration lookup), pass 2 (replay with Playwright screencast recording), the ffmpeg mux, captions, poster, social variants, checksums and the manifest. The question is where the time goes and whether Rust, or any native path, beats fixes inside the current TypeScript, Playwright and ffmpeg design. Video quality of the recording path is in scope. Studio export is only compared.

Not in scope: paid TTS calls (none were made), Studio internals, Windows and Linux.

## Decision

Keep the pipeline in TypeScript. **Rust: no** for this area. 84% of a warm run is pass 2, and pass 2 is real time by design: the tour plays while Chromium records. The rest is native code already (Chromium, ffmpeg, x264, AAC, BoringSSL for SHA-256). Bun itself used 0.7–0.9 s of CPU in a 70 s run (M). The Rust SHA-256 prototype was no faster than Bun (M). A native ffmpeg binding would save about 33 ms per spawn (M), which is 0.1–0.4 s per run. What to change instead: (1) stop using Playwright's built-in VP8 recorder; take the screencast frames through `page.screencast.start({ onFrame })` and encode H.264 once, live, during pass 2, so the mux becomes a stream copy plus the audio track. This removes 3–5 s of post-processing (M) and gives clearly better frames on motion (M). (2) Cache the pass-1 timeline and fall back on a replay mismatch (−5 s, M). (3) Run variant encodes in parallel and stop re-recording the whole tour serially for each responsive preset (the `mobile` preset doubles the run, M). (4) Resolve uncached narration in parallel (I). For a 59 s video the warm run goes from 70.0 s to about 63 s (M), close to the floor of "video length + 1–2 s". The large wins are for responsive formats and cold narration, not for code speed.

## How it works today (verified in code)

- `packages/cli/src/commands/generate.ts` loads `demohunter.config.ts` and the tour with a TypeScript transpile, then calls `generateTour`.
- `packages/generator-playwright/src/generate.ts` launches one browser. Pass 1 (`execute/collect-timeline.ts`) runs the tour in a fresh context. `narrate` does not wait, but typing pauses, cursor-motion waits and tour-authored waits are real (3.6 s of the 4.9 s pass 1 in the spike tour, M). After the run, each narration is resolved **one after another** (`for … await resolveNarrationSegment`, collect-timeline.ts lines 107–139) through the content-addressed cache in `packages/tts-core/src/cache/cache-store.ts`. A cache hit re-hashes the audio file; 8 hits took 6–9 ms (M).
- Pass 2 (`execute/replay-timeline.ts`) replays the tour in a new context with the cursor, ripple, chapter and highlight overlays injected, and waits `narration duration + holdPaddingMs` after each `narrate`. Recording is `page.screencast.start({ path, size })` (`record/screencast.ts`).
- Playwright 1.61's recorder (`playwright-core/lib/coreBundle.js` lines 36456–36512) takes CDP `Page.startScreencast` JPEG frames (quality 90 by default), puts them on a fixed **25 fps** grid by repeating frames, and pipes them to its own ffmpeg with `-c:v vp8 -qmin 0 -qmax 50 -crf 8 -deadline realtime -speed 8 -b:v 1M -threads 1`. So the bitrate is capped near 1 Mbit/s and the encoder runs on one thread at its fastest setting.
- `record/mux-video.ts` then re-encodes that WebM to H.264 with libx264 defaults (preset medium, CRF 23) and mixes narration (`adelay` per clip, `amix`, `alimiter`, AAC) in one ffmpeg call (`packages/media-ffmpeg/src/renderer.ts`).
- `output/write-generation-output.ts` writes chapters, SRT and VTT, copies audio, makes the poster (ffprobe + ffmpeg), and hashes every file for the manifest (`packages/manifest/src/checksum.ts`, whole file read, then `createHash`).
- Captions are **sidecar files only**. They are not burned in and not muxed into the MP4.
- With `output.formats`, `output/render-output-variants.ts` copies the output dir, re-encodes `standard`/`square`/`mobile` with scale-pad (libx264 medium) one after another, makes a poster per variant (the main poster is made a second time), makes the GIF from the MP4, and probes each file. A `responsive` preset (`mobile` is always responsive) calls `generateTour` again for that viewport: a full second pass 1 + pass 2 in real time, serially (generate.ts lines 311–338).

## Test setup

- Fixture: a static dashboard app, `spikes/cli-generate/site/index.html` (four views, animated chart, counter, table, form, toast), loaded over `file://`.
- Tour: `spikes/cli-generate/demo/demos/long.tour.ts`. 4 chapters, 8 narrations, 6 smooth-cursor clicks, 3 typed fields, 2 highlights. Output is 58.2–58.7 s.
- Narration: default OpenAI settings, served from a pre-filled cache. A fake provider (in `scripts/profile-generate.ts`) returned the real speech MP3 clips from `.demohunter/demohunter-github/audio/` (4.6–7.8 s each). After the first run every lookup was a cache hit. No paid API was called.
- Instrumentation: `scripts/profile-generate.ts` calls the real package source and wraps each injectable dependency of `generateTour` with a timer. `bin/shim.pl` (symlinked as `ffmpeg` and `ffprobe`, first on `PATH`) logs every ffmpeg/ffprobe spawn with its arguments and duration. No package source was edited.
- Machine: Apple M4 Max, 16 cores, Bun 1.4.3, Playwright 1.61.0 (headless shell), Homebrew ffmpeg 9.0.2. **Load average was 33–168 during the work** because other agents were benchmarking. All ffmpeg timings swing by 2–5×. Pass 2 and pass 1 are wait-bound and were stable to ±1%.

## Stage breakdown

Warm narration cache, no social formats, 3 runs of `scripts/profile-generate.ts` (labels `baseline-1..3`). Median, with min in brackets. All (M).

| Stage | Median (min) | Share | Notes |
| --- | --- | --- | --- |
| Process start + CLI module load | about 0.3–1 s | – | Real CLI wall time 73.2 s median (67.0 min), 3 runs, vs 70.0 s in-process (M); the gap is mostly noise |
| Config load | 43 ms (34) | 0.1% | TypeScript transpile + import |
| Tour load | 20 ms (15) | 0.0% | |
| Browser launch | 215 ms (116) | 0.3% | One launch for both passes |
| Pass 1: timeline | 4,929 ms (4,905) | 7.0% | 3,637 ms of it is explicit waits (41 waits: typing pauses, cursor motion) |
| Narration lookup (inside pass 1) | 6–9 ms | 0.0% | 8 cache hits. Cold: serial provider calls, see below |
| Pass 2: replay + recording | 58,648 ms (58,606) | **83.8%** | Equals the video length (58.7 s). **Irreducible while recording is real time.** 55.6 s of it is waits (narration holds) |
| Screencast stop (VP8 flush) | 517 ms (365) | 0.7% | Was 2,043 ms in a high-load run |
| Mux: VP8 → H.264 + narration mix | 4,850 ms (4,703) | 6.9% | One ffmpeg. 1.9–14.8 s across all runs depending on load |
| Write output (captions, audio copy, ffprobe, poster, checksums, manifest) | 192 ms (163) | 0.3% | ffprobe 38–91 ms, poster 69–79 ms, hashing about 5 ms |
| Other (contexts, staging, browser close) | 541 ms (167) | 0.8% | |
| **Total in-process** | **69,997 ms (69,910)** | 100% | 1.19× the video length |

Every ffmpeg/ffprobe spawn in a warm baseline run (M, `out/spawn-baseline-*.jsonl`):

| # | Command | Duration (3 runs) |
| --- | --- | --- |
| 1 | `ffmpeg -y -i <tour>.recording.webm -i <8 cached mp3> -filter_complex "[1:a]aresample=48000,aformat=…,adelay=…[a0];…amix=inputs=8:duration=longest:normalize=0[amixout];[amixout]alimiter=limit=0.9…[aout]" -map 0:v:0 -map [aout] -c:v libx264 -pix_fmt yuv420p -c:a aac video.mp4` | 4,661 / 4,802 / 6,736 ms |
| 2 | `ffprobe -v error -show_entries format=duration -of json video.mp4` | 38–91 ms |
| 3 | `ffmpeg -y -i video.mp4 -ss 1.000 -frames:v 1 -pix_fmt yuvj420p poster.jpg` | 69–79 ms |

On a cold cache, add one `ffprobe … format=duration` per new clip (19–21 ms each, M). Playwright's own VP8 ffmpeg runs during pass 2 and is not in this list.

With `formats: [square, gif]` (fit layout, 3 runs `fmt-*`): total 74.6 s median (74.5 min). `render-output-variants` took 6.5 s median (4.7 min) (M). Its spawns, in order: ffprobe + poster for the main video (again), square scale-pad x264 medium 2.7–3.2 s, ffprobe ×2, square poster, GIF 1.5–5.7 s, ffprobe ×3 (M).

With `formats: [square, mobile, gif]` (2 runs `resp-*`): **146.5 s** (M). The mobile preset re-runs pass 1 (4.8 s) and pass 2 (58.7 s) at 390×844, then the variant step takes 11.4–12.1 s because it also upscales mobile to 1080×1920 (M).

## Experiment table

Post-processing experiments ran on a kept 58.7 s recording, 3 runs each: `bun scripts/ffmpeg-bench.ts --webm out/keep/baseline-1.webm --spawnlog out/spawn-prime.jsonl --runs 3`. Load average was up to 168 during this bench, so compare rows to each other, not to the stage table. End-to-end prototypes ran through `scripts/profile-generate.ts` (3 runs each).

| Experiment | How | Min / median | vs baseline | Mark |
| --- | --- | --- | --- | --- |
| Mux, today | exact args from the spawn log | 1,876 / 1,906 ms | – | M |
| Mux, `-preset veryfast` | same graph | 1,246 / 1,383 ms | −27% | M |
| Mux, `-preset ultrafast` | same graph | 1,052 / 1,071 ms | −44%, but file 2.4× larger | M |
| Mux, `h264_videotoolbox -q:v 65` | same graph | 2,241 / 2,381 ms | slower under this load, file 2.2× larger | M |
| Mux, `h264_videotoolbox -b:v 6M` | same graph | 4,173 / 4,265 ms | slower | M |
| Audio track only (mix + AAC) | `audio-only-mix` | 876 / 1,032 ms | the floor of any mux | M |
| Mux with `-c:v copy` from an H.264 source | `mux-copy-h264-source` | 838 / 916 ms | −52%; cost is the audio | M |
| Audio: mix only to WAV (no AAC) | `scripts/audio-bench.ts` | 156–270 ms | mixing is cheap; AAC encode is 0.7–1.2 s | M |
| Audio: `-aac_coder fast` / `aac_at` | `scripts/audio-bench.ts` | 686 / 880 ms, 637 / 886 ms | −30% vs 856 / 1,333 ms | M |
| Audio: concat graph instead of `amix` | `scripts/audio-bench.ts` | 1,247–1,377 ms | no gain; same output (PSNR 166 dB) | M |
| Variants square + 2 posters + GIF, sequential (today) | `variants-sequential` | 3,367 / 3,519 ms | – | M |
| Same, in parallel | `variants-parallel` | 2,262 / 2,267 ms | −35% | M |
| Square variant at `veryfast` | `variants-square-veryfast` | 1,353 / 1,441 ms | about −50% of the square encode (I, from the fmt runs: 2.7–3.2 s) | M |
| Everything in one filter graph (split to main, square, GIF, poster) | `one-graph-all` | 11,560 / 22,715 ms | **3–6× slower**: `palettegen` holds the split, the graph stalls | M |
| Same with VideoToolbox | `one-graph-all-videotoolbox` | 5,248 / 8,106 ms | still slower than sequential | M |
| GIF with input `-t 15` | `gif-input-t15` | 1,284 / 2,144 ms | no gain vs 1,320 / 1,461 ms | M |
| ffmpeg spawn cost | `ffmpeg -version` ×10 | 33 / 43 ms per spawn | ceiling for a native binding | M |
| ffprobe spawn cost | ×10 | 29 / 80 ms per spawn | | M |
| **E2E: live H.264 (x264) during pass 2** | `--pipeline live-x264` | total 64.9 / 66.1 s; stop 19–39 ms; mux 0.9–1.8 s | **−4 s** (stop + mux 5.4 s → 1.2 s) | M |
| E2E: live H.264 (VideoToolbox) | `--pipeline live-vt` | total 67.8 / 67.9 s; mux 2.8–5.1 s | −2 s; the mux spread is load noise (it is a copy) | M |
| **E2E: live x264 + cached pass-1 timeline** | `--pipeline live-x264 --load-timeline out/timeline.json` | total 62.8 / 63.0 s | **−7.0 s (−10%)**; pass 1 4.9 s → 1 ms | M |
| Cold narration, serial vs parallel | not run (no paid calls) | N clips × provider latency → about 1 × latency | for 8 clips at 1–3 s each: 8–24 s → 2–4 s | I |
| Responsive presets in parallel contexts | not prototyped | 146.5 s → about 75 s | −70 s for `mobile` | I |
| SHA-256 of 41 output files (10.1 MB) | `scripts/hash-bench.ts` | TS sequential 7 / 10 ms; TS `Promise.all` 4.3 / 4.7 ms; Rust process 7.5 / 7.9 ms | Rust no gain | M |
| SHA-256 of a 200 MB file | same | TS 100 / 132 ms; Rust 103 / 109 ms | equal (both use ARM SHA instructions) | M |

Live-encode prototype details (`scripts/profile-generate.ts`, `startScreencast` override): `page.screencast.start({ size, quality: 90, onFrame })`; each frame goes on the same 25 fps grid as Playwright's recorder and is written to `ffmpeg -f image2pipe -c:v mjpeg -framerate 25 -i pipe:0 -c:v libx264 -preset veryfast -crf 18 -tune stillimage -pix_fmt yuv420p -movflags +faststart`. Then `createFFmpegMediaRenderer().render({ …, videoCodec: "copy", audioCodec: "aac" })`. The encoder kept up in real time at a load average above 60: 545 of 545 grid frames written, flush 17–114 ms after stop (M). Bun CPU for the whole run stayed at 0.7–0.9 s user (M).

## Quality results

Method (`scripts/capture-quality.ts`, `scripts/replay-vp8.ts`, `scripts/quality-metrics.ts`): one CDP screencast stream feeds both Playwright's recorder and an `onFrame` callback, so every path sees the same JPEG frames. The reference is those JPEG frames (quality 100) on Playwright's 25 fps grid: 545 frames, 21.8 s of navigation, typing, chart animation and scrolling. To score Playwright's VP8 fairly, I re-ran its exact recorder command (Playwright's own ffmpeg-1011, args copied from `coreBundle.js:36512`) on the same frames offline. Its output starts one frame late, so it is scored with a one-frame offset. Without that offset the VP8 score looks far worse (VMAF min 0, PSNR min 16 dB); that was an alignment error, not encoder loss.

| Path | Per-frame PSNR median / 10th pct / min | SSIM | VMAF mean | Bitrate | Mark |
| --- | --- | --- | --- | --- | --- |
| Playwright VP8 (recorder output) | 51.1 / 44.7 / 33.3 dB | 0.9965 | 95.8 | 584 kbit/s | M |
| **DemoHunter final today** (VP8 → x264 medium CRF 23) | 49.8 / 45.9 / 33.3 dB | 0.9964 | 95.4 | 295 kbit/s | M |
| One encode: x264 medium CRF 23 from the frames | 53.8 / 50.4 / 45.9 dB | 0.9987 | 96.6 | 179 kbit/s | M |
| **One encode: x264 veryfast CRF 18 stillimage** (= the live prototype; byte-identical output) | 54.6 / 50.6 / 46.8 dB | 0.9988 | 96.2 | 250 kbit/s | M |
| One encode: VideoToolbox `-q:v 65` | 47.8 / 46.6 / 45.9 dB | 0.9976 | 95.4 | 546 kbit/s | M |
| One encode: VideoToolbox `-b:v 6M` | 58.9 dB (mean of frames) | 0.9997 | 97.3 | 1,774 kbit/s | M |

What this means:

- Today's chain loses about 5 dB median against a single x264 encode, and the worst frames (motion, view changes, scrolling) lose 12–13 dB (min 33 dB vs 46 dB). The cause is the 1 Mbit/s cap with `-deadline realtime -speed 8` in VP8, then a second lossy generation. The single encode is better **and** smaller (250 vs 295 kbit/s).
- VMAF hardly moves (95–97). VMAF is tuned for camera video and does not punish blurred UI text much. PSNR on motion frames and SSIM show the difference better here.
- VideoToolbox at `-q:v 65` is worse than x264 at a similar or larger size. At 6 Mbit/s it is the best, but at 7× the size. On this machine and load it was not faster than x264 veryfast. Use x264 by default.
- The JPEG step is a loss of its own. On a still frame, Chromium JPEG q90 vs PNG: PSNR 45.5 dB, SSIM 0.9894; q100: 47.5 dB, 0.9937 (M, `scripts/jpeg-still.ts`). q100 frames are 2.2× larger (144 KB vs 64 KB average) and were delivered at the same rate (M). Use quality 95–100 when we own the encoder.
- **Frame rate:** Chromium delivered 36–41 frames per second during motion (M), but the 25 fps grid keeps at most 25. An own encoder can use a 30 fps grid (I: smoother cursor and scroll; not scored).
- **HiDPI is not available from the screencast.** With `deviceScaleFactor: 2` and `size` 2880×1800, Chromium still sent 1440×900 frames and Playwright padded the rest grey (M, inspected frame). Sharper text needs screenshot capture (a DPR-2 JPEG screenshot takes 39–49 ms, M), which is not real-time friendly. That is the Studio export path.

## Two pipelines: CLI vs Studio

| | CLI (`generate`) | Studio export (`apps/studio/export.ts`) |
| --- | --- | --- |
| Capture | Pixels from the live page, CDP screencast JPEG q90 | rrweb DOM events; frames rendered later by seeking a replay |
| Time | Real time: 1.19× video length today (M), about 1.07× with the fixes (M) | 116.6 s film at 30 fps with 4 workers in 30.0–44.5 s, 0.26–0.38× video length (S, `spikes/export-pipeline/out/base-*`) |
| Frame timing | Wall clock; frames repeat on a 25 fps grid; load can drop frames | Frame-exact, any fps |
| Encodes | JPEG → VP8 (1 Mbit/s) → x264 CRF 23: two lossy video generations (M) | JPEG q90 → x264 veryfast CRF 18: one generation |
| Resolution | 1× only from the screencast (M) | Device scale factor can go up (screenshots support DPR 2) |
| Fidelity | Exactly what the browser drew: canvas, WebGL, video, cross-origin iframes | Limited to what rrweb records and replays (canvas, video and cross-origin content are weak spots, I) |
| Determinism | Needs pass 1 + strict replay | Capture once, render many times |

Recommendation: keep both capture modes for now, because pixel recording is the only path for canvas-, WebGL- and video-heavy apps. Do not keep two media back ends. Move the CLI to the same "frames → one x264 encode → copy mux" model that Studio uses, share one encoder preset and one narration mixer in `@demohunter/media-ffmpeg`, and long term let the CLI write a capture that the Studio exporter renders when rrweb fidelity is enough. That would make CLI output faster than real time and frame-exact. (I)

## Recommended design

1. **Own the encoder.** Replace `page.screencast.start({ path })` with `{ onFrame, quality: 95 }` and one long-lived ffmpeg: `-f image2pipe -c:v mjpeg -i pipe:0 -c:v libx264 -preset veryfast -crf 18 -tune stillimage -pix_fmt yuv420p -movflags +faststart`, fed on a 25 or 30 fps grid. The mux becomes `-c:v copy` plus the narration track. Expected: −4 s per run and a single lossy generation (M). If WebM output is requested, encode VP9 or VP8 from the H.264 file only for that container.
2. **Cache the pass-1 timeline.** Key it on the tour file hash, the resolved config (viewport, cursor, TTS identity) and the narration cache keys. On a `ReplayTimelineError`, run pass 1 again and record again. Expected: −5 s on unchanged tours (M). Optional: in pass 1, skip waits that only exist for cursor animation (part of the 3.6 s, I); keep typing pauses because apps debounce input.
3. **Resolve uncached narration in parallel** (with a small concurrency limit for provider rate limits). Expected: cold runs save (N − 1) × provider latency (I).
4. **Variants:** run independent encodes in parallel, use `veryfast` for scale-pad variants, reuse the main poster and probe results instead of making them again. Do not merge everything into one filter graph (3–6× slower, M). Expected: 6.5 s → about 3 s for square + GIF (I, from the −35% and veryfast rows).
5. **Responsive presets:** record them in parallel browser contexts from the same cached narration, or render them from one capture. Expected: 146.5 s → about 75 s with `mobile` (I).
6. **Audio:** cache the mixed narration track, or use `aac_at` on macOS / `-aac_coder fast`. Expected: −0.3 to −0.5 s (M, noisy). Low priority.
7. **Do not** add Rust for hashing, captions, audio stitching or an ffmpeg binding. Revisit native code only if DemoHunter adds per-frame compositing (camera, zoom, motion blur) on decoded video, as the Rust architecture note says.

Expected numbers for the 58.7 s spike tour, warm cache:

| Scenario | Today | With 1–2 | With 1–5 | Mark |
| --- | --- | --- | --- | --- |
| No formats | 70.0 s | 63.0 s | 63 s | M / M / I |
| square + gif | 74.6 s | about 68 s | about 66 s | M / I / I |
| square + mobile + gif | 146.5 s | about 140 s | about 75 s | M / I / I |
| Floor (video length) | 58.7 s | | | M |

## Risks

- A live encoder shares CPU with Chromium during recording. Under load the encoder kept up here (M), but on a 2-core CI runner x264 veryfast at 1440×900 may not (I). Keep a fallback: write the JPEG frames or let Playwright record, and encode after.
- `onFrame` keeps the frame grid logic in our code. It must match Playwright's rule (repeat the last frame, drop frames that share a slot) or narration offsets drift. The prototype output was 58.2 s vs 58.7 s for Playwright's file, because Playwright pads the tail until stop (M). Narration start times are measured from the recording start in both cases, but this needs a test.
- A cached timeline can hide app changes until pass 2 diverges. The replay already detects divergence, so the cost is one wasted recording, not a wrong video.
- Parallel responsive recording can collide on shared server state (logged-in sessions, created records) in the user's app (I).
- Spike numbers are noisy: load average 33–168. Pass 1 and pass 2 are wait-bound and stable; every ffmpeg number can be 2–5× off on a quiet machine.

## What I could not measure

- Real TTS latency for OpenAI or ElevenLabs (no paid calls). The serial-vs-parallel gain is inferred.
- Behaviour on Linux CI or Intel Macs, and with Firefox or WebKit.
- A quiet-machine baseline. ffmpeg numbers are relative only.
- Parallel responsive recording end to end (not prototyped).
- Chromium's own CPU use during recording, and frame drops in pass 2 on a weak machine.
- HiDPI capture through a headful window or ScreenCaptureKit; not tried because it needs a visible window and OS permissions, which the CLI cannot assume.
- Subjective review of the videos by a person. Scores are PSNR, SSIM and VMAF only.

## Reproduce

From `spikes/cli-generate/` (run `bun run build` at the repo root first; the tour imports `demohunter`):

```sh
export PATH="$PWD/bin:$PATH"
DH_SPAWN_LOG=$PWD/out/spawn.jsonl bun scripts/profile-generate.ts --label baseline --keep-webm out/keep/x.webm
DH_FORMATS='[{"preset":"square"},{"preset":"gif"}]' bun scripts/profile-generate.ts --label fmt
bun scripts/profile-generate.ts --label livex --pipeline live-x264 --save-timeline out/timeline.json
bun scripts/profile-generate.ts --label reuse --pipeline live-x264 --load-timeline out/timeline.json
bun scripts/ffmpeg-bench.ts --webm out/keep/x.webm --spawnlog out/spawn.jsonl --runs 3
bun scripts/capture-quality.ts --label q100 --quality 100 --live x264 && bun scripts/replay-vp8.ts out/quality/q100 && bun scripts/quality-metrics.ts --label q100
bun scripts/hash-bench.ts out/.demohunter/spike-long   # needs: (cd rust-hash && cargo build --release)
bun scripts/jpeg-still.ts; bun scripts/audio-bench.ts out/spawn-livex-1.jsonl
python3 scripts/summarize.py baseline-1 baseline-2 baseline-3
```
