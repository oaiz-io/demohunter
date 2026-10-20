# Studio: preview, comments, agent

Completed the Paper-inspired simplification without changing the saved project format or adding a built-in AI/chat interface. Continued through the initialized GSD quick task in this session; no delegation or commits.

## Experience

- A compact document header and large canvas replace the permanent three-column editor. Comments open first; Script is one click away. Selected elements reveal contextual actions with manual properties and technical identity collapsed.
- The paused canvas is directly selectable. V selects, C anchors/focuses a comment, S opens Script, Escape clears selection. Comment threads copy structured context with stable reference, time, feedback and file locations for an external agent.
- Scenes and element search use a dismissible popover. More options contains timing/effects, detailed timeline, undo, files and shortcut help. Contextual actions exit expanded preview so their panel remains accessible.
- The library has one compact header, recording cards, inline source-tour navigation and optional filters/workspace details. Live thumbnails use the same replay renderer as export.
- Disclosure/focus behavior lives separately in web/shell.ts. Existing portable files, service/storage boundaries, MCP transport, narration draft conflicts and local-only operation remain intact. The README and bundled agent skill describe the current flow.

## Bugs found through review

Visual review revealed that reparenting the render stage reloads its iframe, producing blank posters/exports despite valid media headers. The renderer now positions the existing stage without moving it. Poster cache version 2 invalidates old blank thumbnails. The integration test inspects actual first/last page content in addition to image dimensions, distinct frames and encoded audio/video.

Navigation review also caught an attribute-whitespace dependency in the library back-link rewrite. A dedicated placeholder now resolves the link independently of HTML formatting; an actual click returns to the library in the browser test.

## Validation

- Studio suite: 17 passed, 0 failed, 156 assertions. Covers real capture/source shutdown, canvas selection, anchored comments, copied context, real stdio MCP reference resolution/edit/reply/resolve, visible activity without playhead movement, narration conflicts, project routes, mobile overflow, rendered content, export/download/audio/checksums and library navigation.
- Studio/root typechecks and workspace/CLI build passed. Bundled skill validator passed.
- Full regression suite: 312 passed, 2 optional live-provider tests skipped, 0 failed; 1,022 assertions across 63 files (161 seconds).
- Browser review: desktop 1440×900 and mobile 390×844; no browser errors or horizontal overflow. Verified Scenes/Escape, More options/timing/help, expanded preview → Script, library return and actual thumbnail decode/visibility.
- Exported the existing invoice recording to .demohunter/exports/studio-reviewed. Inspected an actual decoded frame; ffprobe reports H.264 1120×720 and AAC audio, 37.33 seconds. Strict audio exported all current narration. Existing user-edited Northstar project content was preserved.
- Native T3 preview was attempted first. After retries it explicitly reported no available automation host and directed use of headless browser automation; the subsequent visual and interaction checks used Playwright from the shell.
- Final application is running at http://100.125.182.36:4315. Temporary review server 4317 stopped.

## Research and limits

Reviewed [Paper](https://paper.design/) and its [official MCP documentation](https://paper.design/docs/mcp), including the current site in the shared browser. Adapted canvas emphasis, restrained chrome, contextual controls and external-agent collaboration to time-based recordings. No Paper branding/assets copied.

Desktop/Tauri distribution and authenticated multi-user hosting remain future packaging work. Existing DOM replay fidelity and manual-property draft limitations still apply; this task does not expand the capture engine or change the v1 format.
