---
status: resolved
trigger: "Audio was audible, became choppy, then silent during timeline playback"
created: 2026-10-15
updated: 2026-10-15
---

# Studio audio playback

## Symptoms
- Expected: continuous narration synchronized with the timeline.
- Actual: initially audible, then choppy, then silent during playback.
- Reproduction: play the timeline in Studio. The active Zen tab is OAIZ documentation tour.
- Error messages: none reported.

## Current Focus
- Hypothesis: media seek/retry behavior or playback failure, rather than missing generated audio.
- Next action: inspect real media playback events and decoded audio from an isolated copy.
- Execute inline; preserve the current branch, user demo files and existing local changes.

## Evidence
- OAIZ recording has seven audio files with matching script/settings and no server narration error.
- Native browser inspection shows the OAIZ recording open at 21.2 seconds, paused, with all seven waveform segments.
- syncAudio runs every animation frame and applies a hard seek whenever media drifts more than 180 ms; play failures are retried every frame.

## Resolution
- Root cause: syncAudio hard-seeked whenever media lag exceeded 180 ms. Normal startup/decoder latency caused approximately 29 seeks and repeated waiting events in six seconds on the actual OAIZ recording. The source MP3 decodes correctly and has mean volume -22.6 dB and peak -6.8 dB.
- Fix: separate NarrationPlayback transport. Align once on explicit seek/scene entry/timing change, gently correct small drift, prevent concurrent play/retry loops, wait for active audio during buffering, and release stale/removed tracks.
- Verification: same OAIZ recording copy had zero seeks/waiting events during six seconds of normal playback and one intentional seek into scene 3. Browser signal test measures nonzero audio through an analyser and validates pause/resume, seek counts and synchronization under delayed media loading.
- Studio typecheck passed. Full Studio suite: 26 passed, 0 failed, 258 assertions in 9 files (Bun 1.4.3). Existing capture/export and comment/MCP tests pass.
- No source app was recaptured, no speech was regenerated, and user demo files were not edited. Changes remain uncommitted with prior local work.
