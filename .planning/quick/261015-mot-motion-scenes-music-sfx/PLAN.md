---
quick_id: 261015-mot
date: 2026-10-15
branch: t3code/research-editable-demo-capture (PR #28) — no commits
---

# Motion scenes, music and sound in Studio

Premium intro/outro and transitions for code-made demos, in the style of the
reference videos (OAIZ 45 s ad, Podidex 30 s / 60 s), authored as HTML and
edited in Studio.

## Model (edits.json, v1-compatible additions)
- `clips[]` may be `{ id, kind: "scene", src, durationMs, title? }`: an HTML
  scene in the sequence (intro, outro, chapter card). Recording clips unchanged.
- `overlays[]`: `{ id, src, startMs, endMs }` transparent HTML over the replay.
- `audio.music[]`: bed with volume, fades, ducking under narration.
- `audio.sfx[]`: `{ id, src, atMs, volume }`; scenes may also declare
  `<audio data-start>` cues inline.

## Runtime (deterministic)
- Scene/overlay HTML runs in an iframe; on every seek Studio pauses all Web
  Animations / CSS animations and sets `currentTime`, then calls optional
  `window.demohunterScene.seek(ms)` for JS-driven parts. Every frame is a pure
  function of time; preview and export share it.

## Audio
- Preview plays music/SFX in sync; export mixes narration + music (ducked) +
  SFX, normalised to −16 LUFS, −1.5 dBTP.
- Built-in procedural score + SFX kit in one key (license-free), with beat cues.

## MCP
- One workspace MCP server targeting the project open in Studio (fixes edits
  landing in the wrong demo); tools for scenes, overlays, music and SFX.

## Demo
- OAIZ docs: intro/outro scenes in the OAIZ ad style, music bed, SFX.

## Verify
- Typecheck, Studio tests, new tests for model/audio/runtime, export MP4 and
  review frames.
