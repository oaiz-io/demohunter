---
status: complete
date: 2026-10-15
---

# Agent-native DemoHunter Studio

Extended the prior isolated replay experiment into a shared human/agent workspace. The normal published CLI/video generator remains unchanged. No chat or built-in language model was added.

## Delivered

- Researched Paper's official MCP documentation and exposed tool contracts. Adopted selection/context → bounded inspection → targeted edits on the same local document. Paper's desktop was unavailable, so no live Paper file was inspected or modified. Sources and decisions are in RESEARCH.md.
- Real stdio MCP server using official v2 SDK packages. Tools cover project/selection/node/HTML/styles, copied references, timeline/narration/comments, element edits and animations, script/speech generation, preview focus, history/undo, and read-only edited frame screenshots. The editor displays exact copyable executable/arguments without changing agent settings.
- Capture-scoped stable element references and a hash-checked registry with document/node identity, hierarchy and readable annotated HTML snippets. New captures create these artifacts immediately; older ones index on open. Links carry capture/element/output time and resolve locally via CLI/MCP. Original source provenance is exposed only when explicitly supplied by the app.
- File-backed element/time comments with replies, resolve/reopen, pins, and agent-readable context. UI and MCP share validated revision-checked mutations and serialized cooperating writers. Last 50 tracked changes support undo; subsequent direct-file edits are protected from undo. Malformed history is rejected before content writes.
- Refreshed Studio UI: neutral light design, searchable element list and hover/selection, reference/context copy, source inspector, comments, focus mode, timeline, animations, agent setup and undo. All project content remains accessible to direct-file agents.
- Autosaving transcript cards with real waveforms, scene preview, title/text/timing/voice edits, explicit global voice save/discard, selective/all audio regeneration and readiness provenance. Drafts survive unrelated reloads; same-field conflicts preserve both versions until explicitly resolved. Selective audio fitting does not change other clips.
- Realistic Northstar invoice workflow captured through DemoHunter's actual runtime: overview, review, calculation and approval. Four scenes, 36.1 seconds source / 37.6 seconds edited output, four audible local flite sample segments, camera/highlight effects and readable approval confirmation. Source app stops before playback; final presentation tweaks were applied to replay files without recapture.
- Updated agent skill and standalone documentation, with explicit captured-source, fixed-viewport, direct-writer concurrency and no-MP4-export boundaries.

## Verification

- Final replay suite: 13 passed, 0 failed, 92 assertions across 5 files. Experiment strict TypeScript check passed; skill validator and git diff --check passed.
- Real capture/browser integration verifies DOM mutation/navigation, bundled assets, backward seek to zero, persistent selection/comments, transcript autosave during unrelated agent changes, same-text conflict/explicit resolution, preview command acknowledgement, and read-only PNG rendering with the source server stopped.
- Official SDK Client over actual stdio verifies tool discovery, HTML inspection, element mutation, revision rejection, comments, reference resolution and preview commands. No custom JSON-RPC mock.
- Cache tests exercise the existing real resolver/cache with valid deterministic audio: offline reuse, corrupt-cache recovery, synthesis-time script changes and selective regeneration/fitting. Hosted speech was not invoked; live provider tests skip without opt-in keys.
- `bun run build` and `bun run typecheck` passed. Initial full suite: 300 passed, 2 skipped, 7 failed. Fixed a root README onboarding-contract violation; remaining failures came from build/CLI test timeouts and a shared tarball promise rejected after timeout. All affected files were rerun in isolation: onboarding/workspace 5 passed; authoring/built CLI/generation 7 passed. No unrelated test timeout limits or core implementation were changed.
- Final visual review used headless browser only after native T3 preview_open explicitly reported no automation host and directed use of a headless browser. Preview had no page errors/error banner. Rendered edited frame PNG at 21.5 seconds with the source app stopped. No screen video was recorded.

## Running sample

- URL: http://100.125.182.36:4315
- Project: `.demohunter/replays/northstar-studio` (ignored generated output, about 3.1 MB)
- Capture: `35705b01882a58d6`; invoice total: `d1-invoice-total-n238`
- Server command: `bun run replay open .demohunter/replays/northstar-studio --host 100.125.182.36 --port 4315`
- Existing prior samples are preserved; obsolete editor processes were stopped. Current server stays running.

## Remaining boundaries

This is a source-workspace experiment rather than a published Studio release. No MP4 export, original JavaScript heap replay, alternate app logic, or universal cross-capture element identity. Canvas/WebGL/media fidelity is limited. The local server is intended for localhost/trusted private development, not unauthenticated public hosting. Direct-file writers remain supported but must coordinate simultaneous writes; they do not participate in advisory lock/history. No PR or commit was created.
