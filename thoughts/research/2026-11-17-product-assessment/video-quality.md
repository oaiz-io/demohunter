# Video quality: what the best tools do, and the gaps in DemoHunter

**Research date:** 2026-11-17

**Base commit:** `3621b09`

**Scope:** Why films that Claude Code or Codex make with DemoHunter do not look professional, and what the best open-source tools do differently. Product films, demos, explainers, and documentary films that replace a typical YouTube video.

**Decision:** Do not rewrite the skill text first. Build commands that measure the film (`studio check`, `studio review`), make screenshots fast, add an automatic camera, raise the export defaults, and add a block library. Then add pipelines for new film types. Integrate Apache-2.0 and MIT parts where they fit. Do not embed Remotion or AGPL code.

**Update:** This plan was tested against published evidence and against two real films. The test changed the order and corrected one error (the films do have a cursor). See [quality-evidence.md](quality-evidence.md) for the revised plan.

Stars and licences are from the GitHub API on the research date. The skill files of each project were read from its repository.

## Summary

Measured gates and written taste rules close most of the gap between an amateur film and a professional film. The renderer is less important. Hyperframes and video-shotcraft publish the most concrete rules.

DemoHunter already has good rules in `demohunter-commercial`. It does not have the tools that enforce them:

- The agent must run shell snippets and judge the result itself.
- Each `get_screenshot` call starts a new Chromium and costs 1.1–1.9 s, so agents check fewer frames.
- The scene kit has 18 helpers, so the agent writes each scene from zero.
- A Studio film has no automatic camera, and its cursor is small with weak click feedback.

## What DemoHunter has now

| Area | State | Source |
| --- | --- | --- |
| Skill | `demohunter-commercial`: a 10-step workflow, 10 hard rules, a claims ledger, and references for storyboard, motion vocabulary, sound design and review. It says that parts are adapted from Hyperframes and brag. | `.agents/skills/demohunter-commercial/` |
| Film types | One: a 60–90 s product film. The skill says that a film with no product to record is "not DemoHunter". | `SKILL.md`, "When to use" |
| Review | Manual. The checklist gives `bun -e` and `ffmpeg` snippets for key times, contact sheets, seam strips, PSNR and loudness. No command runs them and no check is automatic. | `references/review-checklist.md` |
| Validation | `studio inspect` validates the project files. It does not check the film. | `apps/studio/cli.ts:367` |
| Scene kit | `motion.js` (12 exports: `onSeek`, `lift`, `ease`, `easeFn`, `spring`, `animate`, `stagger`, `split`, `typewriter`, `counter`, `random`, `progress`) and `show.js` (6 exports: `byText`, `byColour`, `CURSOR_TIP`, `cursorClick`, `flip`, `liftShow`). | `apps/studio/scene-kit/` |
| Animation model | CSS keyframes and Web Animations, seeked for each frame. No GSAP. | Hard rule 6 |
| Cursor | Present. The recording contains a `demohunter-cursor` element with click rings (found in the two test films). It is an arrow of about 20 px with weak click emphasis. Studio hides the rrweb mouse (`.replayer-mouse`), and the kit `cursorClick` draws a cursor in overlays. An earlier version of this document said that a Studio film has no cursor; that was wrong. | `apps/studio/web/style.css:731`, [quality-evidence.md](quality-evidence.md) |
| Camera | Manual `camera[]` entries (position, scale, ease). No automatic zoom. | `edits.json` |
| Export | Default 24 fps and CRF 18. Frames are JPEG screenshots at device scale factor 1. | `apps/studio/export.ts:44-49`, `apps/studio/render.ts:23-28` |
| Sound | A generated score and sound effects from code (`apps/studio/sound/`), ducking under speech, loudness normalised (−16 LUFS default, −14 for YouTube in the skill). | `apps/studio/sound/`, `export.ts` |
| Speech | OpenAI and ElevenLabs. One file for each segment. No word-level timing. | `apps/studio/narration.ts` |
| Agent tools | An MCP server with about 30 tools (`get_screenshot`, `find_elements`, `lift_element`, `update_timeline_item`, `write_project_file`, `animate_element` and more). | `apps/studio/mcp.ts` |
| Skill install | `npx demohunter add-skill` installs only the tour skill. Studio installs all three skills, but only for a new demo in a trusted folder. | `packages/cli/src/commands/skill.ts`, `apps/studio/create-demo.ts:171-175` |

## Tools

### Hyperframes

`github.com/heygen-com/hyperframes` · Apache-2.0 · 85.7k stars · v0.9.61 · Bun monorepo

- **Architecture:** HTML clips carry `data-start` and `data-duration`, with one paused GSAP timeline for each composition. Frames are seeked through Chrome `HeadlessExperimental.beginFrame` and encoded with FFmpeg. `@hyperframes/engine` does not depend on a framework.
- **Registry:** 456 items (210 blocks, 238 components, 8 examples), installed as editable source.
- **One gate:** `check --json` covers lint, runtime, layout overflow, WCAG AA contrast (with a suggested colour) and craft warnings. Each finding has a `Fix:` line. Limits:
  - `line_unread`: 0.5 s plus 0.3 s for each word.
  - `dead_stretch`: more than 3 s with no change.
  - `text_below_floor`: less than 2.6% of the short side (28 px at 1080).
  - `first_frame_empty`, and `film_silent` for films longer than 15 s.
- **Review sheets:** `snapshot --review` writes three sheets: scene start, middle and beats; a strip across each cut (±0.2 s); beat frames at 360 px phone width.
- **Motion assertions:** `*.motion.json` supports `appearsBy`, `before`, `staysInFrame` and `keepsMoving`.
- **Spec:** `SPEC.md` demands "every adjective as a number", and a BANNED list (dark void, glow, purple gradients, glass cards, everything fades and slides up, three cards in a row, docked logo) that grows with each film.
- **Review notes:** The format is `t=4.2s · where · problem → exact change`, ranked P0, P1 or P2. "Never score the film out of 10." A new sub-agent sees only the storyboard and the sheets.
- **Limits:** The music catalogue and the asset search need a HeyGen sign-in. `reverse-any-video` and `style-sampling` are paid features. The skills send a telemetry beacon.

### video-shotcraft

`github.com/Vincentwei1021/video-shotcraft` · Apache-2.0 · 20.9k stars · built on Remotion

- The nearest project to DemoHunter. It captures real pages (2x screenshots, element cut-outs, `layout.json`) and has 124 shot recipe cards with demo source.
- Brand tokens come from the computed styles of the product. Templates get a new skin; they are not used as they are.
- A reviewer with a clean context runs a coded checklist with frame numbers as evidence. "Cannot verify" is a permitted verdict.
- Rules that came from user feedback:
  - The wordmark holds for a minimum of 1 s. A rest of 0.5 s follows batch motion.
  - First drafts are always too fast. Interactions run at human speed.
  - Full-frame beat hits: a maximum of 3 in one film.
  - Captions have a minimum effective height of 56 px at 1080p, checked at 480 px width.
- The beat grid is a least-squares fit over librosa beats. The cut error is within 3 frames and is measured again after the render.
- Sound effects are in a table pinned to frames. The table is pinned again after each timeline change.

### Remotion

`github.com/remotion-dev/remotion` · 73.8k stars · source-available, not open source

- **Licence:** Free for individuals, for-profit organisations with a maximum of 3 employees, and non-profit organisations. Other users need a Company Licence: $25 for each seat each month, or $0.01 for each render with a minimum of $100 each month. The licence prohibits a copy or change of Remotion code "for the purpose of selling, renting, licensing, relicensing, or sublicensing your own derivate".
- **Skills:** `github.com/remotion-dev/skills` (7.4k stars, no licence file). Documentation at `remotion.dev/docs/ai` (skills, plugins, WebMCP, a prompt-to-video template, a `.md` version of each page).
- **Guidance:** Mostly correct API use and Studio editability. Few taste rules: headline minimum 84 px, supporting text minimum 44 px, safe area 80/100 px.
- **Ideas to copy:** Preview first and do not render without a request. Keep the edits of the user.

### brag

`github.com/latent-spaces/brag` · MIT · 21.8k stars

- A narrow skill on top of Hyperframes with step gates and a rubric of 9 questions.
- It includes music with cue sheets calculated in advance (beat grid, strong cues, reveal candidates). Reveals snap within 0.15 s.

### OpenMontage

`github.com/OpenMontageInc/OpenMontage` · AGPL-3.0 · 81.2k stars · Python

- 12 YAML pipelines. Each stage has a `review_focus` and JSON-schema artifacts.
- A slideshow-risk scorer rates six dimensions from 0 to 5. An average of 4 or more blocks the compose step.
- Each critical finding must have a concrete fix, or it is downgraded.
- A contact-sheet approval gate is before the render.

### video-use

`github.com/browser-use/video-use` · MIT · 31.2k stars

- Edits real footage from a packed transcript at phrase level.
- Hard rules: subtitles last in the chain, 30 ms audio fades at cuts, no cut inside a word.
- Self-evaluation on the rendered output: a filmstrip and a waveform at each cut, an `ebur128` measurement, and a critic sub-agent with the brief "to roast, not to praise". A maximum of 3 passes.

### Explainers

- Manim: `ManimCommunity/manim` (MIT, 42.6k stars) and `3b1b/manim` (MIT, 96.6k stars).
- The `manim-video` skill (included in video-use) sets opacity layers at 1.0, 0.4 and 0.15, and a wait after each animation.
- Code2Video (`github.com/showlab/Code2Video`, MIT, 2.4k stars, arXiv 2510.01174) uses a Planner, a Coder and a vision-model Critic with "visual anchor prompts".
- Motion Canvas (MIT, 20k stars) had its last release in December 2024. Revideo (MIT, 4.2k stars) is now `midrender/revideo`. No quality guidance was found in these two.

### Screen recording polish

| Tool | Licence | Stars | Status |
| --- | --- | --- | --- |
| Cap | AGPL-3.0 (capture crates MIT) | 25.2k | Active |
| Recordly | AGPL-3.0 | 37k | Active |
| OpenScreen | MIT | 40k | Archived; the successor is `getopenscreen/openscreen` (7.5k) |
| Screenize | Apache-2.0 | 621 | Paused in May 2026 |
| Kap | MIT | 19.4k | No activity since 2024; no zoom or cursor polish |

- **Cap:** The zoom amount and the zoom centre are spring-mass-damper channels that follow step targets and keep their velocity. They are calculated in advance at 125 Hz as a pure function of the events, so seek, playback and export agree. Clicks are grouped when they are within 50% × 70% of the zoomed viewport. The centre aims before the zoom starts.
- **Screenize:** Plans the zoom for each activity (typing, clicking, scrolling, dragging).
- **screenstudio-alt-skill** (MIT, 11 stars): Samples the original frames again so that zooms stay sharp. It speeds up idle time only when there is no input and the pixels do not change.
- **Recordly:** Motion blur on the cursor and a bounce on clicks.

### Assets

- **Speech:** Kokoro-82M (Apache-2.0; `kokoro-js` is English only, according to short-video-maker). Chatterbox (MIT, 27.9k stars; its README now calls it an archive without support). F5-TTS (code MIT, weights CC-BY-NC).
- **Alignment:** WhisperX (BSD-2, 25.4k stars). whisper.cpp (MIT).
- **Music:** ACE-Step 1.5 (MIT, 14.9k stars). MusicGen weights are CC-BY-NC.
- **Video models:** The Wan2.2 and LTX-2 repositories are Apache-2.0.
- **Stock footage:** Pexels and Pixabay, as used by MoneyPrinterTurbo (MIT, 144k stars).
- **Timeline interchange:** OpenTimelineIO (Apache-2.0, 2.1k stars).
- The Anthropic skills repository has no video skill.

## The ten techniques that matter most

Ranked by effect, with the tool that shows each one.

1. **A numeric craft gate before the render.** Read time, dead stretch, text floor, contrast, empty first frame. (Hyperframes `check`)
2. **Contact sheets reviewed by a critic with a clean context.** Include cut strips and phone width. Demand evidence, not scores. (Hyperframes, video-shotcraft, video-use)
3. **A spec with numbers and a list of banned defaults.** (Hyperframes `spec.md`)
4. **Story before motion.** Three storylines in words, one real task as the spine, the hook in the first 2 s, frame 0 as the thumbnail. (Hyperframes `story.md`)
5. **Real product pixels and brand tokens from computed styles.** (video-shotcraft)
6. **A motion vocabulary by role.** (Hyperframes `motion.md`, video-shotcraft cards)
   - Arrivals on `expo.out`; exits 40–50% shorter.
   - Overlap of 30–50%.
   - Titles that have landed do not move.
   - 3–5 transition types, each caused by an object on screen.
7. **Slower pacing.** Holds, something new every 2–4 s, one hero move in each shot. (video-shotcraft, Hyperframes)
8. **Measured sound.** (Hyperframes `sound.md`, video-shotcraft)
   - −16 to −14 LUFS, −1 dBTP.
   - Music at about 0.12–0.14 under the voice.
   - Sound effects only with a cause on screen, with the peak one frame after the picture.
   - Cuts on a fitted beat grid.
9. **A deterministic spring camera on click clusters, with a smoothed cursor.** (Cap, Screenize)
10. **Word-level timestamps.** The voice is the clock. Captions in groups of 2–6 words. (Hyperframes `captions.md`, WhisperX)

One finding disagrees with the DemoHunter design. Hyperframes tells agents not to write music in code ("nobody can hear whether it is good") and prohibits synthesised tones. video-shotcraft demands a narrative reason for synthesised interface sounds. DemoHunter generates its score in code.

## Gaps in DemoHunter

| # | Gap | Evidence | Proposal |
| --- | --- | --- | --- |
| 1 | No automatic quality gate | Review is snippets in `review-checklist.md`; `studio inspect` checks files only | `studio check --json`: read time, dead stretch above 3 s, text below the size floor, contrast, overflow and clipping, empty first frame, silent film, a put-back that does not match its pick-up (PSNR). One fix line for each finding. Also an MCP tool. |
| 2 | No review command | The agent must build contact sheets with `ffmpeg` by hand | `studio review`: key-time stills, a strip across each cut, a phone-width sheet, and the loudness report, in one folder. |
| 3 | The agent judges its own work | The skill has no critic step | A sub-agent with a clean context that sees only the storyboard and the sheets. Report format: `time · where · problem → exact change`, ranked P0 to P2. A maximum of 3 passes. |
| 4 | Slow screenshots | `get_screenshot` starts a new Chromium: 1.1–1.9 s (see `studio-performance.md`, cause 7) | One warm renderer in the Studio service. Target: less than 0.3 s. |
| 5 | Small scene kit | 18 exports against 456 registry items in Hyperframes | A block library as editable source: hooks, title cards, lower thirds, lift moves, proof frames, outro lockups. Each block passes `check`. Evaluate the Hyperframes registry first. |
| 6 | The cursor is small and hard to find | An arrow of about 20 px with weak click emphasis; the critic could not find it at 26 s, 34 s and 88 s of "film A" | A larger cursor with a click pulse, and a spotlight on the target row or control. |
| 7 | Manual camera | The agent writes each `camera[]` entry | An automatic spring camera from click clusters and the recorded element boxes. DemoHunter knows the boxes; screen recorders must infer them. Calculate it as a pure function of the events, so that seek and export agree. |
| 8 | Low export defaults | 24 fps, scale factor 1, JPEG quality 90 frames. The CLI records VP8 at about 1 Mbit/s and encodes it again. | 30 fps default (no measurable cost). JPEG quality 95 (+5 dB at capture for 1–2 ms each frame). Supersampling only for 4K (2.1–2.6 times the cost). In the CLI, one H.264 encode from screencast frames (about 5 dB better). See [rust-export-pipeline.md](rust-export-pipeline.md) and [rust-cli-generate.md](rust-cli-generate.md). |
| 9 | Music from code | `apps/studio/sound/score.ts` | Curated tracks with a clear licence and cue sheets calculated in advance (beat grid, strong cues). Keep the generated score as a fallback. |
| 10 | No word timing | One audio file for each segment, no alignment | Word-level timestamps from the speech provider or from whisper.cpp. Use them for captions in groups of 2–6 words and for beat locks. |
| 11 | No brand step in the tool | The skill tells the agent to copy colours and fonts by hand | A command that writes `scenes/brand.css` from the computed styles of the capture. |
| 12 | One film type | The skill refuses films with no product to record | New skills and pipelines: explainer and documentary (see the next section). |
| 13 | Skills do not reach all users | `add-skill` installs one skill | One installer for all skills, in the npm package. |

## Documentary and YouTube-replacement films

The best published pipeline is `documentary-montage` in OpenMontage:

1. **Brief:** A thematic question in one sentence, the tone, the music plan and the end tag.
2. **Scene plan:** Slots with 2–3 queries each, and a minimum of 2 hero slots.
3. **Assets:** CLIP retrieval over Pexels, Archive.org, NASA, Wikimedia and Unsplash. The corpus is a minimum of 8 times the slot count. Each asset has a provenance and licence record.
4. **Edit decisions:** Each cut has a reason. A maximum of 4 transition types. No adjacent cuts with the same subject and scale.
5. **Compose, then a final review.**

Its rules for long films: a pattern interrupt every 60–90 s, 150–160 words each minute, music 18–20 dB below speech.

Where it is weak:

- The review is mostly a language model that reviews its own JSON. Its `visual_qa` tool is marked experimental.
- The loop passes with warnings after two rounds.
- No fact check of the narration was found.
- The MoneyPrinterTurbo README describes script, speech, stock footage and subtitles, with no review step.

What this means for DemoHunter: the capture, scene, sound and export parts apply to these films too. The missing parts are the asset stage (search, licence record, Ken Burns and parallax moves on stills), a fact-check stage with sources, and long-form pacing rules. The claims ledger in the commercial skill is a good base for the fact check.

## Build or integrate

- **Integrate:**
  - `@hyperframes/engine`, `@hyperframes/lint` and registry blocks: Apache-2.0, Bun and TypeScript, the same seek model. Keep the NOTICE file and the attribution.
  - `kokoro-js` as an offline speech fallback (pull request #19 already starts this).
  - whisper.cpp or WhisperX for alignment.
  - ffmpeg `ebur128` and `loudnorm` (already used).
  - Lottie, Rive and Three.js (all MIT) in scenes.
- **Build:**
  - The spring camera from Playwright and rrweb events.
  - The review sheets and the craft checks.
  - Music cue sheets.
- **Do not embed:**
  - Remotion: its licence passes to the users of DemoHunter.
  - OpenMontage, Cap, Recordly: AGPL. Use the ideas, not the code.
  - MusicGen and F5-TTS weights: non-commercial.

## Not verified

- If OpenTimelineIO has a TypeScript binding.
- The licences of the LTX-2 and Wan2.2 model weights (only the repository licences were checked).
- The Parakeet licence.
- If ElevenLabs and OpenAI speech return word timestamps.
- The retention statistics of OpenMontage (secondary sources) and its CHAI citation (arXiv 2604.21718; only the abstract was checked).
- The Hyperframes claim "measured from launch films".
- The skill files of Motion Canvas and Revideo were not read.
- The cost of a GSAP adapter in DemoHunter scenes. Hyperframes blocks use GSAP; DemoHunter prohibits it in hard rule 6.
