---
status: complete
date: 2026-10-15
---

# Editable DOM replay experiment

Implemented an isolated Bun workspace at experiments/replay. Normal CLI video generation and existing packages are unchanged. The experiment directly reuses the existing collection/replay runtime and cached narration resolver.

## Delivered

- `bun run replay demo|capture|open|inspect|narrate`: real rrweb capture of DemoHunter tours, source-independent preview, inspection, and narration regeneration.
- Versioned project.json plus immutable events/assets, editable edits.json/narration.json/overrides.css, and selection.json inspector context. Captures bundle their recorder/player and include agent instructions.
- Local editor with play/pause/seek/speed, clip trimming/rate/end holds, persistent element text/style/visibility overrides, document-scoped selection, zoom/pan/highlight effects, script editing, audio regeneration, and file polling with last-valid-preview recovery.
- Clip-based source/output time mapping; narration follows clip IDs and stale audio stays silent. Regeneration merges results into current scripts, reuses the existing validated cache, and can fit longer speech by extending holds.
- Discoverable `.agents/skills/demohunter-replay/SKILL.md`, detailed usage/limitations, and a self-contained math capture that stops its source app before playback.

## Verification

- Full `bun run build`, `bun run typecheck`, and `bun run test`: 303 pass, 2 skip, 0 fail. Provider live tests skipped without keys.
- Final focused replay suite after fixes/dependency alignment: 8 pass, 45 assertions. Experiment TypeScript check and skill validator pass.
- Capture integration verifies actual DOM text mutations, full document navigation, bundled CSS/image URL rewriting, and absence of video output.
- Narration tests use a deterministic valid WAV and the real TTS cache/resolver to verify offline hits and corrupt-cache recovery. A synthesis-time concurrent edit remains intact and its outdated result is skipped.
- Native T3 preview navigation/evaluation/click verification: source app stopped, playback reaches later DOM states, inspector saves selected node, external edits hide note/change text/add camera and highlight, later recorded mutations do not undo the text override, and invalid JSON retains the last valid page with an error. Missing API key is surfaced without crashing the editor.
- T3 snapshot tool returned a client execution error; browser inspection used the working native evaluate/click tools. No alternate browser automation was substituted.

## Running sample

Project: `.demohunter/replays/fractions-lab` (ignored generated output). Approximately 17.3 seconds of actual captured DOM state; about 628 KB including local rrweb libraries. These sample figures are not a performance benchmark.

## Deliberate limits

This is a source-workspace preview experiment, not a published CLI feature or MP4 exporter. Element overrides are global in time; node edits can be scoped to the captured document. Canvas/WebGL, third-party frames, media, and independent CSS animation fidelity are not guaranteed. Text replacement changes the displayed recording, not application logic or mathematical consistency. Absolute effects do not automatically retime after clip edits. Provider-backed synthesis was not exercised without credentials.
