---
quick_id: 261015-mot
status: complete
date: 2026-10-15
branch: t3code/research-editable-demo-capture (PR #28) — not committed
---

# Motion scenes, music and sound in Studio

Research: Brag/Hyperframes (seek-every-animation, pure function of time),
Remotion/GSAP licences (not bundleable), anime.js/Lottie/WAAPI, audio practice
(ducking, −16 LUFS), and the three reference films (OAIZ 45 s, Podidex 30/60 s).
Report: .context/research-video-libraries.md.

## Built
- Model: scene clips (`kind: "scene"`, HTML page, duration) in the sequence;
  `overlays[]`; `audio.music[]` (volume, fades, duck) and `audio.sfx[]`.
  Scenes hold the recording; narration can anchor to scenes. Scene and audio
  files are part of the revision (`assetsRevision`).
- Runtime: SceneLayer seeks every CSS/Web Animation and media element of each
  page per frame, plus `demohunterScene.seek(ms)`; inline `<audio data-start>`
  cues. Export screenshots keep scene animations (no Playwright fast-forward).
- Audio: shared `musicGain` envelope in preview and export; export mixes
  narration + ducked music + SFX in memory, two-pass loudnorm −16 LUFS /
  −1.5 dBTP.
- Scene kit `scenes/kit/motion.js` (MIT): easings, spring → CSS linear(),
  animate/stagger/split/typewriter/counter, seeded random, standalone preview.
- Procedural score + SFX kit (apps/studio/sound, calm/bright/cinematic, one key,
  shared reverb, cues) and `bun run studio kit <project>`.
- Timeline: scene clips, overlays, Sound track (music bed + SFX marks).
- MCP (agent): workspace server follows the demo open in Studio
  (.demohunter/studio/session.json), `project` argument, list_projects,
  scene/overlay/music/sfx timeline kinds, write_project_file (scenes/ only).
- Fixes: thumbnails no longer starve scene loads (render mode skips them,
  editor loads 2 at a time); safe file listing for fingerprints; history rows
  for overlay/music/sound/scene changes.
- Docs: skill "Motion, music and sound" craft guide, FORMAT, README.

## Demo
- `.demohunter/replays/oaiz-docs-film` (copy of oaiz-docs; Codex's version
  untouched): intro and outro scenes in the OAIZ ad style with a match cut onto
  the docs H1, calm score, 18 SFX cues. Export:
  `.demohunter/exports/oaiz-docs-film-v1/video.mp4` — 66.2 s, 1440×900, 30 fps,
  −16.0 LUFS, LRA 4.7, −1.5 dBTP.

## Verification
- Typecheck clean; Studio tests 63 passed (Bun 1.4.3), incl. new motion,
  sound and MCP tests. Frames reviewed in Studio and in the exported MP4.
