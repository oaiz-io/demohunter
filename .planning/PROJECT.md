# DemoHunter

## Current State

DemoHunter `v0.1.4` shipped on 2026-07-15. OSS core complete with two-pass generation, OpenAI + ElevenLabs TTS with local caching, portable manifest/output contract, visual effects, natural text entry, and TTS language configuration.

## Active Milestone: v1.1 Output Quality

Three features that make generated demos visibly more professional and more shareable:

1. **Cookie banner dismissal automation** — Reusable, deterministic middleware that handles consent banners from OneTrust, Cookiebot, and other vendors before recording. Ships disabled by default; `--cookie-dismiss reject` to enable.

2. **Smooth cursor animations** — Upgrade the existing blue cursor + click ripple from 50ms linear CSS transitions to SVG bezier arcs animated via `requestAnimationFrame`. Adds `runtime.click(locator)` helper for fully synchronized motion. `--cursor none|highlight|smooth|ripple`.

3. **Social media output formats** — Multi-variant output: `--format standard|square|mobile|gif`. Creates `@demohunter/media-ffmpeg` package with typed render plans and manifest v2 with variant support. GIF via ffmpeg palettegen/paletteuse.

### Out of Scope

- Cloud hosting, analytics, GitHub Action — those are the Cloud product
- Local TTS, pause removal, multi-language, music — Phase 2
- Enterprise features, SSO, support contracts — never

## Constraints

- **Tech stack**: Bun workspace, TypeScript 5+, ESM-first, Playwright >=1.59, ffmpeg-backed media generation
- **Product boundary**: OSS must stand on its own and work entirely locally
- **Provider boundary**: TTS reads OPENAI_API_KEY from environment only
- **Output contract**: .demohunter/ must stay portable and versioned
- **Reliability**: Narration caching remains mandatory
- **Backward compatibility**: Existing config, CLI flags, and output structure must continue to work
