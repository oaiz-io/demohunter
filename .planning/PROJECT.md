# DemoHunter

## Ownership

DemoHunter is an OAIZ Labs open-source project maintained by OAIZ AB. It is licensed under the MIT License.

## Current state

DemoHunter `v0.1.5` was released on 2026-08-10. The OSS core includes two-pass generation, OpenAI and ElevenLabs TTS with local caching, a portable manifest and output contract, visual effects, natural text entry, language configuration, and social output formats.

## Core value

Developers can turn Playwright automation into portable narrated demo assets locally, without a hosted backend.

## Product boundary

The open-source CLI and SDK are self-sufficient. They run against local, preview, or public applications and write generated files under `.demohunter/`. A future hosted product can ingest this output, but the default OSS flow cannot depend on an OAIZ service.

### Out of scope for the OSS core

- Cloud hosting and analytics
- GitHub pull request automation
- Enterprise identity and support features
- General-purpose screen recording
- Application-specific authentication abstractions

## Constraints

- **Tech stack:** Bun workspace, TypeScript 5+, ESM-first, Playwright `>=1.61`, and ffmpeg-backed media generation.
- **Credentials:** OpenAI and ElevenLabs keys come from environment variables only. DemoHunter does not store them.
- **Output contract:** `.demohunter/` must remain portable and versioned.
- **Reliability:** Narration caching must support offline regeneration and corrupt-cache recovery.
- **Compatibility:** Existing config, CLI flags, and output structures must remain compatible unless a documented version boundary permits a change.
