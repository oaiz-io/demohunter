# Editable replay experiment

Started through `gsd-sdk query init.quick` on 2026-10-15. The runtime does not have GSD agent types installed; execute and verify this bounded experiment in the current session.

## Goal

Capture an existing DemoHunter tour as rrweb events and bundled assets, preview and scrub without video export, and let external agents edit plain files that update the preview live. Include narration editing/regeneration through existing providers/cache and a reusable editing skill. No chat UI and no change to default video generation.

## Plan

1. Research rrweb capture/replay APIs and reuse the existing tour runtime and narration cache. Define a small versioned project plus separate edits/narration files.
2. Add an isolated `experiments/replay` workspace and CLI for a self-contained math demo, arbitrary tour capture, preview, narration regeneration, and inspection. Bundle playback dependencies locally.
3. Build a local editor/player with play/pause, seeking, trim clips, element selection, file-change reload, narration controls, and visible validation errors. Preserve original captured events; apply persistent edits on top of the reconstructed DOM without detaching mirrored nodes.
4. Add agent instructions, usage docs, focused model/server/capture tests, and verify the real browser workflow including live edits and offline playback. Keep the sample running for the user.

## Acceptance

- Actual DOM mutations are captured from a real tour; preview does not require the original app or FFmpeg.
- An agent can edit a selected node's text/style/visibility, camera/highlights, clip timing, and narration files; changes appear without losing playback position.
- Narration regeneration reuses the existing validated cache, does not persist credentials, and exposes stale/missing audio instead of playing old speech.
- Invalid intermediate file writes do not crash the server or silently replace the last valid project.
- Prototype limitations and deferred video export are explicit.
