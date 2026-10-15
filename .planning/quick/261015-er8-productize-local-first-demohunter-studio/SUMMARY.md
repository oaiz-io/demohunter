---
status: complete
date: 2026-10-15
---

# Local-first DemoHunter Studio application

Promoted the replay prototype to apps/studio, a separate private application workspace, while preserving replay CLI and the old experiments/replay/cli.ts MCP entry point. Canonical data remains on disk; no cloud dependency, account or built-in language model was added.

## Delivered

- `bun run studio` starts a recording library. Bounded discovery finds saved captures and source tours within an explicit workspace, skips symlinks/dependencies/cache directories, reports damaged projects independently, and resolves real paths before serving project routes. Search, review/audio filters, sorting, source capture-command handoff and JSON `studio list` discovery are implemented. Cached first-frame posters are generated through a single bounded render queue. Unchanged polling does not rebuild focused library controls.
- Multiple projects share one HTTP process with isolated project-prefixed API/media routes. Browser code uses a small route-aware transport module and has no runtime filesystem/Tauri imports. Static editor assets compile once per process. Project handlers, ReplayWorkspace and storage remain separate from library and transport composition.
- Studio format/protocol v1 is defined in contract.ts / FORMAT.md with committed JSON Schemas. studio.json carries UUID project identity, capture identity and fixed canonical filenames. Legacy captures gain a manifest atomically without content-revision changes; unknown major versions fail before edits. Stable links, time domains, provenance, immutable/derived/runtime boundaries, concurrency and undo semantics are documented. MCP exposes get_contract/get_schema; targeted timeline upsert/removal complements element/narration tools.
- Actual MCP activity is recorded separately from project content and bridged across agent/service processes. It includes caller-reported name, session/operation/tool/target, heartbeat and terminal state. The editor shows activity labels, target pulses, transcript-card emphasis and recent operations with explicit Show element actions. It does not take over the playhead. Reduced motion is supported. Corrupt/unavailable feedback storage cannot break a successful edit or canonical-file status.
- One read-only replay renderer supplies screenshots, posters and MP4 export. Frame capture uses an exact source-sized browser viewport, correcting fractional element screenshot dimensions. Export stages output, checks revisions, refuses existing destinations, mixes only current narration, generates VTT/JSON captions and source-linked checksums, and supports strict-audio. Export is available from CLI/CI and a UI dialog with progress/downloads. It never visits the original app.
- App README, FORMAT.md, ARCHITECTURE.md, CI example and agent skill explain current behavior and the future hosted/Tauri path. The browser/service/storage separation is implemented; tenant authentication, distributed workers, per-platform sidecar packaging, signing/updating and desktop installers are explicitly future work.

## Research

Primary sources consulted: Paper https://paper.design/docs/mcp (shared file/selection, CLI stdio, visual feedback while inspecting); Tauri https://v2.tauri.app/concept/architecture/ and https://v2.tauri.app/develop/sidecar/ (frontend/core boundary, target-specific external binary packaging and scoped permissions); MCP https://modelcontextprotocol.io/specification/latest/basic/utilities/progress (request-scoped progress differs from persistent editor activity). No inference about private agent reasoning or undisclosed Paper internals is presented as fact. No new framework, cloud SDK or desktop shell was added merely for future extensibility.

## Verification

- Full repository suite at the integration checkpoint: 312 pass, 2 optional live-provider skips, 0 fail, 997 assertions across 63 files. Build and root/Studio typechecks passed.
- Final Studio suite after renderer/library/activity refinements: 17 pass, 0 fail, 136 assertions across 7 files. Covers real capture/navigation/assets, source-independent browser editing, narration autosave/conflicts/cache recovery/selective generation, official stdio MCP tools and schemas, revision/history protection, discovery/route isolation/path containment, legacy manifest races/future-version rejection, activity failure/interruption isolation, exact MP4 dimensions/audio/checksums, strict-audio/no-overwrite behavior and UI export/download.
- Final browser integration additionally opens a capture through the project-prefixed library route, verifies bundled background asset URLs and current DOM, then calls get_html through an actual SDK stdio client and checks visible named activity with unchanged playhead.
- Native T3 collaborative browser used for library/editor review (available this turn). Verified four actual thumbnails, library navigation, selected invoice context, observed MCP activity, no error banner, and preserved 14-second playhead. Old 4312 connection errors in browser diagnostics predated this task; current app works at 4315.
- Final narrated sample export: `.demohunter/exports/northstar-publish/`, H.264/AAC, 1120×720, 12 fps, 37.583 seconds. ffprobe verified video/audio/dimensions; every manifest checksum/byte count verified. Captured source app was stopped. Audio is the explicitly labeled local sample voice, not hosted-provider synthesis. Earlier private render attempts are ignored generated output, not release artifacts.
- Legacy CLI contract command, JSON library discovery, frozen-lockfile install, skill validation and git diff --check passed. Formatting was applied to application source/docs.

## Running application

One server remains running at http://100.125.182.36:4315 — the previous editor URL now opens the library. Current workspace includes four prior captures and seven source tours. Opening the Northstar capture uses `/projects/36bf201f5e4dd593/`; old root hash links resolve through the library by capture identity. Earlier obsolete servers were stopped. No PR, commit, publication or deployment to a public host was performed.

## Limits

Source-distributed local application, not a packaged desktop release or authenticated multi-user hosted product. Tauri/hosting reuse the implemented service boundary but still require packaging/auth/deployment work. Library scans are bounded, not a large-scale database index. UI jobs are process-local; CLI is the CI interface. Direct file writers must coordinate concurrent writes. Recorded DOM and text overrides cannot reproduce alternate application logic; rrweb canvas/media fidelity limits remain. Provider regeneration may incur costs only when explicitly invoked with cache misses.
