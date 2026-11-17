---
status: complete
---
# Quick task 261117-flm: general film tools and the film skill

Direction from the owner: DemoHunter is a general-purpose HTML video tool for agents. Quality comes from the one agent that makes the film, with opinionated skills and plain tools. No reviewer agents, no gates, no agent pipelines. Research: `thoughts/research/2026-11-17-product-assessment/skills-and-tools.md`.

- **`studio new`**: a film with no recording, at any size. It writes a minimal valid capture (one blank page with no elements), so preview, export, the library, MCP and the capture check work with no other change. It adds the scene kit, a starter scene and a `PLAN.md` template. Recording-only features refuse with a clear message.
- **`studio sheet` and MCP `get_film_sheet`**: contact sheets of the film as JPEG files, with the time and the clip on each tile. Default: the start and the middle of each clip and overlay. Options: `--at`, `--every`, `--cuts`, `--phone`. Measured: 2.3 s for a 116.5 s film at 1920x1080; 3.6 s for a recorded 117 s film with 60 tiles.
- **Scene kit helpers**: `fitText`, `readTime`, `kenBurns` in `scenes/kit/motion.js`.
- **Camera** : a window that starts where the one before it ends travels from that framing to its own. Before, each window went back to the full frame. An existing film with ten windows and no adjacent windows renders byte-identical at ten sampled times. Unit tests in `camera.test.ts`.
- **Skill `demohunter-film`**: replaces `demohunter-commercial`. A router of about 1,200 words; guides for story (with the `PLAN.md` template), look, motion, sound, words and look-at-it; one file each for product film, explainer, documentary, data story and short. The lift workflow, the moves with code, the sound procedure and the claims ledger move in from the old skill. The pass/fail review checklist is removed. Studio installs the new skill, and the desktop package includes it.
- Real run: a 116.5 s film with 16 scenes and 4 overlays exported in 29.9 s at 1920x1080 and 18.8 s at 1080x1920.

Tests: Studio 178 pass before, 194 pass after, 0 fail. Typecheck clean. Skill contract tests 3 pass.

To review by hand:

- `fitText` treats a box as fixed-height if its height does not change between `min` and `max`. This can be wrong for some layouts.
- The empty-state text of the editor still says "click anything in the recording" on a film with no recording.
- A recorded project whose recording clips are all deleted now shows as "film" in the library.
- No film was made end to end by an agent with the new skill yet. That is the test that shows if the films are better.

Not built (see the research for the order): a layout query, word timings for narration, licensed media search, music with cue data, brand capture.
