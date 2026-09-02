---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: milestone_complete
stopped_at: v1.0 archived; no active milestone
last_updated: "2026-09-02T16:10:00+02:00"
last_activity: 2026-09-02 -- Quick task 260902-m9p aligned public documentation and licensing with OAIZ Labs
progress:
  total_phases: 6
  completed_phases: 6
  total_plans: 24
  completed_plans: 24
  percent: 100
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-14)

**Core value:** Developers can turn normal Playwright automation into portable narrated demo assets locally, without depending on a hosted backend.
**Current focus:** No active milestone

## Current Position

Phase: none — milestone archived
Plan: none
Status: v1.0 complete
Last activity: 2026-09-02 -- Quick task 260902-m9p aligned public documentation and licensing with OAIZ Labs
Progress: [██████████] 100%

## Performance Metrics

**Velocity:**

- Total plans completed: 24
- Milestone plans completed: 24/24
- Total execution time: approximately 6 days from kickoff to archive

## Quick Tasks Completed

| Date | ID | Task | Summary |
| --- | --- | --- | --- |
| 2026-09-02 | 260902-m9p | Align documentation and licensing with OAIZ Labs | Named OAIZ AB in license and package metadata, moved public links to `oaiz-io`, shortened the README, separated current docs from historical plans, and added contribution and security guidance. |
| 2026-06-12 | 260612-jackson | Generate DemoHunter GitHub demo | Added a root DemoHunter tour for the GitHub README and example source flow, regenerated it with ElevenLabs Bella narration, and exported a 1.10x `video-1.10x.mp4` at 25.08 seconds. |
| 2026-06-12 | 260612-frj | Implement automatic ElevenLabs narration continuity | Added automatic adjacent narration context for compatible ElevenLabs clips, serialized `previous_text` and `next_text`, skipped unsupported `eleven_v3` stitching, and verified with focused tests, typecheck, and full verification. |
| 2026-06-11 | 260611-lsi | Review and fix natural text entry implementation until clean | Ran full verification and iterative subagent review, added strict type-text replay events, hardened runtime validation, preserved sleep-only type compatibility, and added SDK/CLI consumer declaration fixtures. |
| 2026-06-11 | 260611-l8l | Add natural text entry API for narrated typing | Added `typeText` inside `narrateWhile` with deterministic paced Playwright typing, replay timing support, public types, docs, and focused runtime/replay/type tests. |
| 2026-06-11 | 260611-kc0 | Fix TTS language review findings | Normalized narration language in core/provider requests, added config-level language fallback coverage, clarified ISO 639-1 docs, and reran review plus full verification. |
| 2026-06-11 | 260611-jyk | Make narration language explicit and not env-driven | Updated starter/getting-started guidance to use explicit `tts.language` or per-call `language`, and added regression coverage proving `DEMO_LOCALE` does not influence TTS language. |
| 2026-06-11 | 260611-j3z | Add configurable narration language for OpenAI and ElevenLabs TTS | Added `tts.language` and per-call `language` overrides, mapped ElevenLabs to `language_code`, steered OpenAI through voice instructions, included language in cache identity, and updated docs/tests. |
| 2026-05-26 | 260526-jmt | Add ElevenLabs live integration test | Added a gated real ElevenLabs synthesis test that verifies cache persistence and offline cache reuse after removing `ELEVENLABS_API_KEY`. |
| 2026-05-26 | 260526-hky | Add ElevenLabs TTS provider support | Added configurable ElevenLabs narration with provider defaults, per-call voice/model/format/settings overrides, cache-keyed provider options, docs, and tests. |
| 2026-05-20 | 260520-hgz | Add npm propagation retry to release traceability verification | Added a bounded retry around `npm view demohunter@$VERSION version` so final release verification tolerates brief npm propagation lag after publish. |
| 2026-05-20 | 260520-h5r | Fix release workflow for npm trusted publishing | Switched the release workflow to Node 24 tokenless npm trusted publishing and added existing-tag recovery so `bump=current` can publish the already-tagged `v0.1.1`. |
| 2026-05-20 | 260520-ggc | Fix release version bump workspace protocol failure | Added `--workspaces=false` to the release workflow `npm version` step so npm bumps only `packages/cli` instead of failing on Bun `workspace:*` dependencies. |
| 2026-05-20 | 260520-c80 | Fix GitHub/npm release traceability | Made the release workflow idempotently validate and create matching npm versions, git tags, GitHub releases, and release-body traceability links. |
| 2026-05-19 | 260519-ql8 | Implement GitHub issue #5 | Added `narrateWhile` timed narration choreography, replay timing support, caption span timing, docs, and skill guidance. |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.

### Pending Todos

None yet.

### Blockers/Concerns

None yet.

## Session Continuity

Last session: 2026-04-14T10:14:45+02:00
Stopped at: v1.0 archived; define next milestone when ready
Resume file: .planning/PROJECT.md
