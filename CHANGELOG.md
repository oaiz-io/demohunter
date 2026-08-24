# Changelog

All notable changes to DemoHunter are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **DemoHunter Review** — turn a pull request into a local, narrated review artifact.
  - `demohunter review init [path] --base <ref>` scaffolds a `*.review.ts` grounded in the real `merge-base(base, HEAD)..HEAD` diff, with the true changed-file inventory and an explicit TODO for every authored field.
  - `demohunter review generate <review-file> --base <ref> [--head <ref>] [--run-verification] [--allow-dirty] [--no-video]` renders a static review website and records a narrated walkthrough through the existing Playwright, narration, caption, chapter, and FFmpeg pipeline, then writes `review.lock.json`.
  - `demohunter review serve <dir|id> [--port <n>] [--open]` serves one artifact on `127.0.0.1` only: GET/HEAD, no directory listing, `Host` pinned to loopback, `..` and escaping symlinks blocked by a realpath containment check, strict CSP, and range support.
  - `demohunter review verify <dir|id> [--strict]` re-derives the artifact from Git: lock schema, staleness, artifact checksums, video/audio streams, captions, chapters, portable manifest, changed-file set, coverage, and evidence anchors.
- Typed `defineReview()` authoring surface exported from `demohunter`, with `changeSet`, `componentDiagram`, `dataFlowDiagram`, `sequenceDiagram`, `diffEvidence`, `codeEvidence`, `verificationCommand`, `risk`, `compatibilityNote`, `securityNote`, `reviewerQuestion`, and `coverageGroup`.
- 100% changed-file accounting: generation fails when a changed path is unaccounted for, and when an authored path is not in the reviewed range.
- `demohunter-review` agent skill, installed alongside `demohunter` by `demohunter add-skill`.
- `demohunter review generate` writes a self-covering `.gitignore` into both the review artifacts root and the narration cache directory, so generating a review never dirties the work tree it describes.

### Fixed

- Changed-file collection now passes `--no-abbrev` to `git diff --raw`, so recorded blob shas are full object ids rather than Git's abbreviated form.
- Diff evidence is narrowed to the authored post-image range instead of only selecting whole overlapping hunks, so a focused diff on a newly added file no longer renders the entire file.
- The narrated walkthrough now includes the architecture chapter. The section list was gated on pre-rendered diagrams, which the viewer computes for itself but the recording pass never populated, so the video skipped the architecture narration and the website navigation had no link to the section that was rendered right below it.
- Regenerating a review with `--no-video` now removes the walkthrough a previous run recorded. The lock correctly recorded no video, but the playable `video.mp4`, captions, chapters, poster, manifest, and per-segment audio were left in the served directory, so a reviewer could watch a walkthrough the artifact did not vouch for.
- Generated narration pluralizes counted nouns correctly and keeps subject and verb in agreement, so the walkthrough says "security boundaries" rather than "security boundarys" and "5 coverage groups account for" rather than "accounts for".
- Generated narration no longer speaks how long a verification command took. The measured duration changed the narration text on every regeneration, which invalidated the narration cache and forced a paid re-synthesis of lines whose review content had not moved. Durations are still recorded in `review.lock.json` and shown in the viewer.
- `demohunter review generate` now explains a recording failure it cannot fix for you: a missing narration credential or a missing ffmpeg is reported with the variable to export and with `--no-video`, which still produces a complete, verifiable review website.
- A step that fails during the recording pass now reports the failure that actually happened. Pass 2 throws as soon as the replayed event stream diverges, and the `step-end` emitted while unwinding a failed step always diverges, so the real error was being replaced by a confusing timeline mismatch.

## [0.1.0]

Initial public release.

### Added

- `demohunter init` — scaffolds `demohunter.config.ts`, `demos/sample.tour.ts`, and a sample site.
- `demohunter generate` writes a self-contained `.demohunter/.gitignore` so output stays out of source control without mutating the project-level `.gitignore`.
- `demohunter generate <tour>` — two-pass run that resolves narration, records video, and writes `.demohunter/<id>/{video.mp4,poster.jpg,captions.srt,captions.vtt,chapters.json,manifest.json,audio/}`.
- `demohunter cache list|prune|clear` — narration cache maintenance.
- `demohunter add-skill [--target claude|codex|both]` — installs the AI authoring skill into the selected agent directory.
- `demohunter --help` / `demohunter --version` — standard CLI flags.
- Single import surface: `import { defineTour, defineConfig } from "demohunter"`.
- OpenAI narration with deterministic local cache, atomic writes, sha256 integrity, and offline reuse.
- Portable Zod-validated `manifest.json` for downstream consumers.

[Unreleased]: https://github.com/emilwareus/demohunter/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/emilwareus/demohunter/releases/tag/v0.1.0
