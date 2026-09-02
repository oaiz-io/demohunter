# Changelog

All notable changes to DemoHunter are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- The workspace now pins `playwright` at the root, so `bun x playwright install` in CI runs the lockfile's Playwright instead of resolving `playwright@latest`. The two had drifted to different Chromium revisions, and every browser-backed test failed with "Executable doesn't exist at .../chromium_headless_shell-1228".

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

[Unreleased]: https://github.com/oaiz-io/demohunter/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/oaiz-io/demohunter/releases/tag/v0.1.0
