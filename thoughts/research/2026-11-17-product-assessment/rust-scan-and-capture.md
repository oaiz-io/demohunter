# Rust for the workspace scan and the capture bundle: measured spike

> The prototype and benchmark code of this spike (paths that start with `spikes/`) is not in the repository. The films and the repository that the measurements used are private.

**Research date:** 2026-11-17

**Base commit:** `3621b09` (branch `research/studio-speed-video-quality`)

**Code:** `spikes/rust-scan/` (Rust crate, Bun scripts, two benchmark runners). Raw results are in `spikes/rust-scan/results/` (git ignores them).

## Scope

The question: does Rust make the Studio library scan and the `capture.dhcapture` handling meaningfully faster than the best cheap fix in TypeScript? This document builds on causes 1, 3 and 5 in [studio-performance.md](studio-performance.md).

Three implementations were compared on the same machine, in the same session, interleaved round by round:

- **(a) Current:** the real `LocalLibrary` and `readCaptureEntry` from `apps/studio`, imported without changes.
- **(b) TypeScript fix:** standalone Bun scripts (`ts/fixed-scan.ts`, the lazy reader in `ts/capture-bench.ts`). App code was not edited.
- **(c) Rust:** `gix` 0.90 for worktrees, index, status and ahead/behind. `notify` 8 (FSEvents) for watching. `memmap2` + `flate2`/`zlib-rs` + `sha2` for the capture file. It is called through a sidecar (JSON lines over stdio) and through `bun:ffi`.

## Decision

**No Rust for this area.** Almost all the scan cost comes from the algorithm, not from the language. The current code runs `git ls-files --others` (a full worktree walk) and `git status` (an `lstat` of every tracked file) on a timer. Most of that time is kernel time. Rust has to make the same system calls: `gix status` took as long as `git status`. The cheap TypeScript fix stops the walks: `--cached` only, a stat probe, caching, and `fs.watch`. It takes the visible cold scan from 2.9–6.9 s to 0.11–0.31 s, and the idle cost from about 1.6 cores to about 0.04 cores. The Rust watcher idles at about the same cost (0.05 cores). The same holds for the capture file. A lazy single-entry read in TypeScript (Bun's native zlib and hashing) takes 3.9–4.1 ms, against 114–120 ms now. Rust takes 3.4 ms, so it saves about 0.5 ms per demo. Native JSON parsing does not help, because the JavaScript side needs JavaScript objects (or only raw bytes). Rust would add per-platform builds, signing and a second toolchain for a gain of a few milliseconds. Do the TypeScript fixes. Look at Rust again only if a later profile shows CPU-bound work in JavaScript that it cannot avoid. Nothing in this spike shows such work.

## Test data and conditions

- **Repository:** a large private monorepo (`<large-repo>` below), opened read-only. It has 13 checkouts (the main one and 12 worktrees), about 40,000 tracked files and a 5.3 MB index. Every tool ran with `--no-optional-locks`, and nothing wrote to it.
- **Demos:** `<film-a>` (1.38 MB archive, 5.3 MB `events.json`, 5.3 MB `elements.json`) and `<film-b>` (1.66 MB archive).
- **Machine:** 16 cores, macOS (Darwin 25.6), Bun 1.4.3, Rust 1.97.1. The disk was warm: the page cache was never dropped, so "cold" means a cold process, not a cold disk.
- **Noise:** Other agents ran Chromium and ffmpeg at the same time. The 1-minute load average was 20–168 during the scan runs and about 60 during the capture runs. Each row is 5 or more runs. I report the min and the median across runs. Medians at high load are unreliable, so compare the minimums first. During one TypeScript-fix poll window, another agent changed 41,399 files in one worktree. That run is the "max" for the fix.
- **Correctness:** `ts/compare.ts` diffed the per-worktree output (branch, head, tours, recordings, changed count, ahead, behind) against the current code. The TypeScript fix matched in 13/13 worktrees. Rust full mode matched in 12/13. The difference: `gix` counts a folder (`temp/`) that holds only empty folders as untracked, and git does not. Rust fast mode matched on tours and recordings, with one exception: it misses one untracked tour, because it does not run the `--others` listing. It reports no status by design.

## Results

All numbers are **measured** unless marked inferred. "Visible" means the first library answer. "Status done" means that the per-worktree dirty and ahead/behind data is also complete.

### Scan of the 13-checkout repository

Command: `spikes/rust-scan/bench-scan.sh <large-repo> 5 40` (5 rounds, 40 s CPU windows after a 15 s settle). Summary: `bun ts/summarize.ts results/scan.jsonl`.

| Metric | (a) Current | (b) TypeScript fix | (c) Rust |
| --- | --- | --- | --- |
| Cold, visible (min / median) | 2,855 / 4,245 ms | 108 / 137 ms | fast (index + probe): 33 / 37 ms; full (with status): 2,112 / 2,336 ms |
| Cold, status done (min / median) | 5,615 / 8,886 ms | 4,196 / 4,825 ms (background, 2 at a time) | full, all parallel: 2,112 / 2,336 ms; 2 at a time: 2,279 / 3,371 ms |
| Warm poll, nothing changed (min / median of run medians) | 59 / 97 ms | 0.006 / 0.008 ms (cache hit) | 0.18 / 0.26 ms (sidecar round trip with watcher) |
| Warm, re-list every worktree (no watcher) | — | 91 / 136 ms | fast: 12 / 17 ms; full: 2,881–3,985 ms |
| Steady state, library open, poll every 4 s (cores, min / median) | 1.0 / 1.6 (sys 38–71 s per 40 s) | 0.021 / 0.044 | watcher + status throttled to 15 s: 0.000 / 0.049; polling fast scan, no watcher: 0.022 / 0.025 |
| Git processes in a 40 s window | about 170 (inferred from the audit rate) | 0–3 | 0 |
| Bun idle baseline, 40 s | — | 0.014–0.024 CPU-s | — |

The cold time for (a) includes the reads of the 27 recordings (cause 3). The same session measured the git discovery of (a) alone with `bun ts/current-scan.ts <root> --discovery` (5 iterations in one process):

| Current step | min / median |
| --- | --- |
| `listWorktrees` (3 git spawns) | 78 / 96 ms |
| `listDemoSources`, all 13 worktrees (8 at a time) | 1,839 / 2,030 ms |
| `worktreeState` (`git status`), all 13 (2 at a time) | 4,138 / 4,559 ms |

What the numbers show:

- **The cost is the walk, not the language.** The `gix` status pass for one worktree took 99–256 ms. `git status` took 139–262 ms (**measured**, same session, not interleaved). A Rust full scan of 13 worktrees used 1.0 s user and 13–16 s system CPU. A shell loop of `git status` over the same 13 worktrees used 0.6 s user and 16 s system CPU (**measured**, one run each). Both are dominated by kernel time for `lstat` and `readdir`.
- **Without the untracked walk, status is cheap in both languages.** `gix` status without untracked files took 40–51 ms per worktree. With untracked files and no ignored files it took 99–125 ms. With ignored folders too it took 118–257 ms (**measured**, one worktree, 5 runs). `git status --untracked-files=no` should behave the same way (**inferred**, not measured).
- **Rust fast vs the TypeScript fix, same algorithm:** 33 ms vs 108 ms cold, and 12 ms vs 91 ms for a full re-list. That is about 80–100 ms saved, mostly 26 git process spawns and their output parsing. With a watcher, neither path runs on a normal poll, so the user sees no difference after the first paint.
- **A Rust watcher is not cheaper at idle.** With the status pass throttled the same way, the Rust sidecar idles at 0.05 cores (median) against 0.04 cores for the TypeScript fix. Both numbers sit inside the noise of other agents' file changes.

### Capture bundle (`events.json` from `capture.dhcapture`)

Command: `spikes/rust-scan/bench-capture.sh ../../<film-a> ../../<film-b>`. Summary: `bun ts/summarize.ts results/capture.jsonl`. "First call" is a fresh process (7 runs). "Loop" is 15 timed repeats in one process after one warm-up (5 processes).

| Metric, film A (film B) | (a) Current `unzipSync` | (b) TypeScript lazy | (c) Rust lazy |
| --- | --- | --- | --- |
| First call in a fresh process (min / median) | 203 / 264 ms (61 / 68) | 6.7 / 8.7 ms (5.0 / 5.6) | 4.0 / 4.8 ms (2.6 / 2.7), binary; FFI first call 5.8 / 10.6 ms (4.5 / 4.9) |
| Read + verify `events.json`, JIT warm (min / median) | 114 / 120 ms (51 / 55), with file hash | 3.9 / 4.1 ms (2.8 / 2.8) | 3.4 / 3.4 ms (2.3 / 2.3) |
| Same, plus whole-file SHA-256 | (included above) | 4.4 / 4.6 ms (3.4 / 3.4) | 4.0 / 4.1 ms (3.0 / 3.0); through FFI with copy: 4.2 / 4.3 ms (3.3 / 3.3) |
| Memory growth on first call (RSS) | 60–64 MB (25–28 MB) | 12 MB (8 MB) | not measured |
| Inflate `events.json` only | — | about 1.8–2.0 ms (lazy, no hash) | 1.1–1.3 ms |
| SHA-256 of the 1.4 MB file | 0.46 ms (`node:crypto` and `Bun.CryptoHasher` are equal) | 0.46 ms | 0.54 ms |
| Lazy read with fflate's JS `inflateSync` instead of `node:zlib` | — | 36–46 ms | — |

What the numbers show:

- **The current cost comes from decoding everything.** The current path inflates all entries in JavaScript (fflate) and parses the 5.3 MB `elements.json` two times, only to validate. A lazy read inflates one entry with Bun's native zlib (`node:zlib.inflateRawSync`) and checks `events.json` against `capture.json`. That is 30x faster in TypeScript. Rust saves another 0.5 ms (about 12%).
- **Keep the inflate native.** fflate's JavaScript inflate is the slow part: 36–46 ms against about 2 ms with `node:zlib` for the same entry. Hashing was never the problem (0.46 ms).
- **Rust's default `sha2` is slow.** The default build of the `sha2` crate is software-only on ARM: 9.5–9.9 ms for 5.3 MB. Bun took about 2 ms. Rust matched Bun only after I enabled the `asm` feature (2.1 ms). A native port can be slower than the TypeScript version if nobody checks this.
- The elements identity check (`captureId`) can wait until something reads `elements.json` (**inferred** from the code: `library.ts:376` reads it only to get `captureId`, which `studio.json` also stores).

### JSON parse of `events.json` (5.3 MB for film A, 1.9 MB for film B)

The same command as above, 5 processes × 15 repeats.

| Operation, film A (film B) | Bun (min / median) | Rust (min / median) |
| --- | --- | --- |
| Parse to a generic value | `JSON.parse`: 4.0 / 4.2 ms (1.8 / 1.9) | `serde_json::Value`: 7.5 / 7.7 ms (2.8 / 2.8); `simd-json` borrowed: 3.4 / 3.4 ms (1.6 / 1.6) |
| Parse + serialize | 9.4 / 9.7 ms (4.3 / 4.4) | `serde_json`: 10.5 / 11.2 ms (4.5 / 4.5) |
| `/api/events` asset URL rewrite (`server.ts:239-247`) | 1.2 / 1.4 ms (0.41 / 0.52) | — |
| `elements.json` parse | 5.1 / 5.3 ms (0.83 / 0.86) | not measured |

- `JSON.parse` in Bun is faster than `serde_json::Value`. It is within about 20% of `simd-json`.
- The server never parses `events.json` for `/api/events`. It does a 1.2 ms regex replace and sends the string. The browser parses it (**inferred** from `server.ts:239-247`). Native parsing in the server process has nothing to speed up. A value parsed in Rust would also have to cross into JavaScript as a string or as bytes, and then be parsed again (**inferred**).

### Call overhead (end to end, both cheap options were built)

| Measurement | Value |
| --- | --- |
| `bun:ffi` `dlopen` of the 4.9 MB dylib (5 symbols) | 0.9–4.1 ms typical; 392–427 ms for the first load after each rebuild (macOS checks the new binary; **inferred** cause) |
| `bun:ffi` call to a no-op function | 3.8–8.1 ns per call |
| `bun:ffi` read + verify + copy of 5.3 MB into a JS `Buffer` | 3.6 / 3.7 ms (film A), 2.6 / 2.6 ms (film B). The copy adds about 0.2–0.3 ms over the Rust binary. |
| Sidecar spawn to first answer (includes one fast scan) | 28–143 ms (median 59 ms) |
| Sidecar `ping` round trip | 0.005–0.050 ms |
| Sidecar `scan` round trip, cached result, 100–110 KB JSON, parsed in Bun | 0.17–0.32 ms |
| Process start: `bun -e ''` / Rust binary (timer overhead included) | 14–25 ms / 12.5–18 ms |

## Integration options and costs

The Studio service always runs on Bun. That includes the desktop app: Electron spawns the Bun binary that it bundles (`apps/desktop/main.cjs:101-116`, `scripts/package.mjs:94-103`). `@demohunter/studio` is private today. The `demohunter` CLI package declares Node >= 20.

| Option | Runtime fit | Per-call cost | Build and release burden |
| --- | --- | --- | --- |
| **Sidecar binary, JSON over stdio** (prototyped: `src/bin/scan.rs --serve`, `ts/sidecar.ts`) | Any runtime (Bun, Node, Electron). A crash does not take down the service. The watcher lives in its own process. | 0.2–0.3 ms per scan round trip; about 60 ms to start | One binary per target. For npm, use the esbuild pattern: one package per platform as optional dependencies, plus a resolver. For the desktop, copy the binary like `bin/bun`; the existing `codesign --deep` covers it. Notarization later needs a hardened-runtime signature on the binary. |
| **`bun:ffi` cdylib** (prototyped: `src/lib.rs`, `ts/ffi-bench.ts`) | Bun only. Node or Electron's main process cannot load it. Bun documents `bun:ffi` as experimental. Memory is managed by hand (`dh_free`). | About 5 ns per call; the data copy dominates | The same per-platform packages as the sidecar. The dylib loads into the Bun process. Under a hardened runtime, library validation can refuse a dylib that a different team signed (Bun's binary comes from Oven) (**inferred**, not tested). |
| **napi-rs addon** (not prototyped) | Bun, Node and Electron (N-API is ABI-stable, so no `electron-rebuild`) | Close to FFI, plus N-API conversion (**inferred**) | napi-rs CLI and a GitHub Actions matrix. Targets: darwin-arm64, darwin-x64, linux-x64-gnu, linux-arm64-gnu, linux-x64-musl and win32-x64 if Windows matters. There is one `.node` package per target. CI today runs one ubuntu job and one macos-latest job. This adds about 5–6 build jobs (**inferred**). Library validation applies as for FFI. |

The common burden is the same for every option (**inferred**): a Rust toolchain in CI, cross-compilation or one runner per target, release coordination between the JavaScript package and the native packages, and a fallback when no native package matches the platform. The current scan must stay as that fallback, so both code paths need maintenance. The release build of the spike took about 33 s with a warm crate cache and used 290–325 MB of `target/`. The binaries are 5.3 MB (scan, includes gix) and 0.6 MB (capture only).

## Risks

- **Git parity.** `gix` status differs from git at the edges (the `temp/` case above). LFS filters, `core.untrackedCache`, sparse checkout, split index and submodules need separate checks. Today the code relies on git's exact behaviour.
- **Untrusted repositories.** `git.ts` disables fsmonitor and hooks, because repositories are untrusted input. `gix` has its own trust model and can run filter drivers from the repository config. Studio would need a second security review.
- **Watchers on Linux.** FSEvents makes recursive watching cheap on macOS. On Linux, recursive `fs.watch` or `notify` uses one inotify watch per folder. 13 worktrees × tens of thousands of folders can reach the `max_user_watches` limit. This applies to both the TypeScript fix and Rust (**inferred**). A fallback poll on the cheap paths (`--cached` only, 91–136 ms for all worktrees) is acceptable.
- **Bursts of watch events.** Another agent changed 41,399 files in one 40 s window. The TypeScript fix handled the burst with 3 git processes and 0.096 cores, because it throttles `git status` to once per 15 s per worktree. Any watcher must throttle, in any language.
- **Native port mistakes.** The `sha2` default build and the `serde_json::Value` parse were both slower than Bun. A port needs benchmarks at each step.

## What I could not measure

- **Cold disk.** `purge` needs sudo, so every run used a warm page cache. A cold disk would add I/O time equally to all three versions (**inferred**).
- **A quiet machine.** The load average was 20–168. The rankings were stable across rounds, but the absolute medians are inflated, most for (a).
- **napi-rs.** I did not build it; its numbers are inferred from the FFI results.
- **Notarized or hardened-runtime signing** of the dylib or the sidecar in the Electron app. The desktop build today is signed ad hoc.
- **Linux and Windows** behaviour of the watchers and the native builds.
- **`git status --untracked-files=no`** and git's built-in fsmonitor daemon (`-c core.fsmonitor=true`). The daemon writes an IPC socket into `.git`, and that repository was read-only for this spike. Both are possible TypeScript-level options to measure next.
- **Recording reads (cause 3) inside the full library scan** with the lazy reader in place. Inferred: 27 recordings × about 4 ms is about 0.1 s, against about 2–3 s today.

## Recommended TypeScript changes (from the measured prototypes)

1. `listDemoSources`: use `--cached` only. Probe `.demohunter` next to tours. Run `--others -- '*.tour.ts'` once in the background, and again only when a `.tour.ts` changes.
2. Cache the worktree list and the sources. Use one recursive `fs.watch` per worktree (the main one also covers `.git/worktrees/*`). A poll with nothing dirty returns the cached object.
3. Run `git status` in the background only for worktrees that changed, at most every 15 s.
4. Read capture entries lazily: parse the central directory, validate the names and sizes, inflate one entry with `node:zlib`, and check `events.json` against `capture.json`. Remove the capture read from `loadBundle`.
