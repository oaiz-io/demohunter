# Skills and tools for single-agent HTML video

- **Research date:** 2026-11-17.
- **Method:** I read the real repository files through the GitHub API and the official docs pages. I did not rely on summaries, except where the text says so. Every claim links to its source. Statements marked **(unverified)** come from secondary pages or could not be opened.
- **Scope:** what the best "make a video" projects give one coding agent, in skill text and in tools, so that it makes a good film without a reviewer. The focus is general film (product, explainer, documentary or essay, data story, social short), not only product demos. Reviewers, gates and multi-agent parts are noted only so they can be left out.

## Decision

The projects that get good films from one agent do three things. First, they make the agent write the story in words before it builds anything. Second, they turn taste into numbers and name the defaults to avoid. Third, they give the agent cheap ways to see and measure its own frames. Hyperframes is the clearest example. Its `story.md` → `SPEC.md` → `snapshot --review` loop runs in one agent, and its own notes say that one agent building about five scenes is faster than splitting them across sub-agents ([HF-film]). The skill evidence points one way. Focused, moderate-length skills beat comprehensive ones ([SkillsBench]). Rule-following drops as the number of instructions grows ([IFScale]). A skill must be short, opinionated and routed by genre. A general-purpose HTML video tool mostly lacks *measurement tools the agent calls itself*. The missing ones are a frame/contact-sheet tool, a layout and safe-area report, text fitting with reading time, word-level timing from TTS, music cue data, licensed media search and brand capture. Leave out critic agents, pass/fail gates, scores and multi-mode pipelines.

---

## 0. What was read

| Project | Files read | Licence | Agent surface |
| --- | --- | --- | --- |
| Hyperframes (heygen-com, 85.8k stars, pushed 2026-11-17) | `skills/hyperframes/SKILL.md`, `references/{story,spec,motion,sound,captions,storyboard,storyboard-format,look,review,film}.md`, `references/types/{explainer,data,vertical}.md`, `skills/media-use/SKILL.md`, `skills/hyperframes-registry/SKILL.md`, `skills/hyperframes-cli/SKILL.md` and `references/{lint-validate-inspect,beats}.md`, `skills/media-use/audio/references/{sfx,tts-to-captions}.md`, the CLI `commands/` folder | Apache-2.0 ([HF-repo]) | CLI (`npx hyperframes …`), skills, registry of about 450 items |
| Remotion agent skills | `skills/remotion-best-practices/SKILL.md`, `remotion-create/REFERENCE.md`, `remotion-create/video-layout.md`, `remotion-markup/{REFERENCE,multi-scene-video,voiceover,measuring-text}.md`; remotion.dev/docs/ai | No LICENSE file in the skills repo ([RM-repo]); Remotion itself uses the Remotion License ([RM-licence]) | Skills, Studio, WebMCP |
| Anthropic skills | `frontend-design`, `algorithmic-art`, `canvas-design`, `slack-gif-creator`, `theme-factory`, `skill-creator` | Apache-2.0 (frontend-design LICENSE.txt) ([AN-fd-lic]) | Skills |
| Anthropic guidance | Skill authoring best practices ([AN-bp]); frontend aesthetics cookbook ([AN-cookbook]); "Improving frontend design through Skills" ([AN-blog]); "Writing effective tools for agents" ([AN-tools]) | n/a | Docs |
| brag (latent-spaces, 21.8k stars) | `skills/brag/SKILL.md`, `skills/brag-slim/SKILL.md`, `assets/music/README.md`, a cue file | MIT; bundled music CC BY 4.0 ([BR-music]) | Skills on top of Hyperframes |
| video-shotcraft (21.0k stars) | `SKILL.md`, `references/aesthetic-rules.md`, `references/pipeline.md` (headings), `references/sfx-sourcing.md`, one shot card | Apache-2.0 ([SC-repo]) | Skill, 125 shot-card files, Remotion TSX demos |
| video-use (browser-use, 31.2k stars) | `SKILL.md`; vendored `skills/manim-video/SKILL.md` and `references/scene-planning.md` | MIT ([VU-repo]) | Skill + Python helpers |
| OpenMontage (81.3k stars) | repo tree; `skills/creative/{storytelling,typography,sound-design,broll-planning,long-form,short-form,data-visualization}.md` | AGPL-3.0 ([OM-repo]) | Skills, 100+ tools, pipelines |
| motionmaxxing (1.6k stars) | `SKILL.md` | Apache-2.0 ([MM-skill]) | Skill + scripts |
| Index | awesome-claude-video-skills, which says it lists 180 skills (description only) ([AW]) | n/a | n/a |

I found no other widely used 2026 "make a video" skill with its own film-craft content beyond these. Most others wrap Hyperframes or Remotion: herk-edit-kit vendors Hyperframes skills ([HERK]), and claude-remotion-skill and remotion-shorts-skill wrap Remotion (search results only) **(unverified beyond GitHub descriptions)**.

---

## 1. Skill design: how a single agent is made to film well

### 1.1 Structural patterns

**P1. Story in words first, three different films, then pick one.** Hyperframes makes the agent write three storylines before any build. Each storyline has its own world, device and form, and each is "words only": "build nothing for any of them before one is picked" ([HF-story]). It gives tables of named devices ("A number lands", "The result first", "The object is the explanation") and forms ("One continuous take", "Match cuts", "Object-to-object chain") to combine ([HF-story]). It also says what to pick for: "the one a stranger would follow and remember … ahead of the most striking picture" ([HF-story]). motionmaxxing asks for "at least two more of different KINDS" of idea and a "cover-the-logo" test ([MM-skill]). Anthropic's art skills first write a named "philosophy" (`.md`), then express it in code ([AN-algo], [AN-canvas]).

**P2. A spec where every adjective becomes a number.** Hyperframes states the reason plainly: "Adjectives are where the default look lives … Every adjective you turn into a number is a decision taken back from those defaults" ([HF-spec]). Its `SPEC.md` template has GOAL, OUTPUT, TIME, LOOK, OBJECTS, MOTION, SHOTS, BANNED and QA lines. It also has a word-to-number table: "playful" becomes "springs at damping 0.45-0.6 … 10-30% exaggerated poses", and "clean" becomes "12 columns, 96 px margins, the accent on one word per shot" ([HF-spec]). OpenMontage has the same idea as an "Anti-Subjective Rule": "describe the **visual cause** of the emotion, not the emotion itself" ([OM-story]). Anthropic's frontend-design asks for a token plan first: "4–6 named hex values", typefaces and roles, and a layout concept with ASCII wireframes ([AN-fd]).

**P3. Name the banned defaults, and let the list grow.** Hyperframes keeps a "BANNED by default" list: "a black or dark navy void … glow, bloom, neon … three cards in a row, KPI grids … the logo docked in a corner". Then: "After the first render, name every default it used anyway … The list grows with every film" ([HF-spec]). frontend-design lists five clusters that AI design "clusters around" (cream plus serif plus terracotta, near-black plus acid green, broadsheet, the SaaS-card kit, template chrome) and calls them "defaults rather than choices" ([AN-fd]). The cookbook names fonts to avoid ("Inter, Roboto, Arial, system fonts") and warns "You still tend to converge on common choices (Space Grotesk, for example)" ([AN-cookbook]). motionmaxxing has a 12-item "Never ship" list ([MM-skill]). One caveat is backed by evidence. Banning alone moves the model to the next default. Anthropic: "Even with explicit instructions to avoid certain patterns, the model can default to other common choices" ([AN-blog]). Hyperframes: "banning that look only moves it to the next default. Outside input breaks it", in this order: design spec, real brand, reference, "the subject's own world" ([HF-look]). So pair every ban list with a *source* for the replacement.

**P4. A look built from a medium, not a palette.** Hyperframes: "A look holds together when it is the rules of one medium". Its example is risograph: paper, ink A, ink B, overprint and halftone, each with a job, and the motion comes from the medium ("printed, plate by plate, not faded in") ([HF-spec]). frontend-design: "The subject's industry, subject matter, materials, and vernacular are where distinctive visual choices come from" ([AN-fd]).

**P5. Named moves with parameters.** Hyperframes' transitions table gives each move a build recipe with numbers. For example, "Zoom through a button … scales from ~8% to ~250% of the frame in 0.35 s, strong ease-in". It also says: "Use 3–5 kinds in a film, each caused by something on screen" ([HF-motion]). video-shotcraft has 125 shot-card files ([SC-tree]). Each card has intent, core motion, a parameter table with a "how it feels" column, known pitfalls and a pointer to tuned demo code ([SC-card]). The card format is portable to any engine.

**P6. Numbers measured from real films.** Hyperframes' motion rules are "Measured frame by frame from the official HyperFrames launch films". Examples: exits "40-50% shorter than their entrances", word staggers "60-120 ms", shots averaging "1.8–3 s" ([HF-motion]). motionmaxxing cites "~4,300 measured moves from 53 frame-accurate pro moments" ([MM-skill]). video-shotcraft writes "case-law" rules: rule + the user's actual words + a self-check question. One rule notes that six rounds of feedback all said "slow down", and none said "too slow" ([SC-rules]).

**P7. Per-genre playbooks behind a router.** Hyperframes' SKILL.md is a "What to read" table that sends the agent to `types/launch|explainer|music|data|vertical|3d|character.md` ([HF-skill]). Each type file is short: data is 236 words, explainer 561 (word counts from the files). manim-video has a modes table: concept explainer, equation derivation, algorithm, data story and so on ([MANIM]). OpenMontage has 12 pipeline folders ([OM-repo]).

**P8. Worked examples labelled as examples, not mandates; hard rules only for correctness.** video-use: "Every specific value, preset, font … is a *worked example* from one proven video — not a mandate … The only things you MUST do are in the Hard Rules section". Its 12 hard rules are about correctness, such as "Subtitles are applied LAST", "Never cut inside a word" and "30ms audio fades" ([VU-skill]). Anthropic: "Examples convey the desired style and level of detail to Claude more clearly than descriptions alone" ([AN-bp]). SkillsBench found that concise, stepwise guidance with at least one working example works better than exhaustive docs ([SkillsBench]).

**P9. A "look at your frames" habit, backed by a tool.** Hyperframes: "`npx hyperframes snapshot` and read the PNGs … that is how you see the video" ([HF-cli]). `snapshot --review` writes three sheets: each scene's start and middle, a strip across every cut (−0.2 s to +0.2 s), and the beat frames at phone width (360 px) ([HF-review]). The self-check questions run in one agent. "Describe each beat frame in one sentence as a stranger would"; "With the words covered, do the beat frames still tell the storyline?"; "Trust the numbers over your eye where they disagree" ([HF-review]). brag-slim asks for stills "from every scene *and* from mid-transition", with times taken "from the timeline … rather than picking them by eye" ([BR-slim]). frontend-design: "taking screenshots to review … a picture is worth 1000 tokens" ([AN-fd]). Anthropic's best practices recommend visual analysis of rendered output ([AN-bp]). video-use renders a filmstrip plus waveform at every cut ([VU-skill]).

**P10. A point of view and a persona.** frontend-design opens as "the design lead at a design studio … This client has already rejected proposals that felt cliché or templated" ([AN-fd]). manim-video: "This is educational cinema. Every frame teaches" ([MANIM]). Hyperframes review: "as a harsh motion director, not a proud author" ([HF-review]). Restraint is part of that view. "Spend your boldness in one place" ([AN-fd]); "One hero move per shot" ([HF-spec]); "Emphasis is spent, not spread" ([MM-skill]).

**P11. Explain why; avoid shouted MUSTs.** skill-creator: "If you find yourself writing ALWAYS or NEVER in all caps … that's a yellow flag … explain the reasoning" ([AN-sc]). Vercel found that a "MUST invoke the skill" instruction made the agent anchor on docs and miss project context ([VERCEL]).

**P12. Honest delivery notes.** Hyperframes asks for a `REVIEW.md` note covering what was measured, what was only looked at, and "the sound was measured, not heard" ([HF-review]). video-use: "You cannot listen: say so, and report the numbers" ([VU-skill]). This replaces a reviewer with transparency to the human.

**P13. Strong models need less scaffolding.** brag ships a full multi-step workflow. On Opus 5.5, Sonnet 5.5 and Fable 5.2 it hands off to `brag-slim`: "One file, no bundled assets — built entirely by the model". brag-slim is 1,906 words ([BR-skill], [BR-slim]). This is direct evidence for the owner's position: with a capable model, one opinionated file plus tools can replace a staged pipeline.

### 1.2 Sizes of the skills read (word counts from the files)

| Skill entry file | Words | Notes |
| --- | --- | --- |
| Hyperframes `SKILL.md` | 1,157 | Router; references load on demand (story 1,957, motion 1,767, spec 1,019) |
| Remotion `SKILL.md` | short router | Markup reference 1,553; rule files mostly 120–1,100 words |
| frontend-design | 1,516 | One file |
| brag-slim | 1,906 | One file |
| video-shotcraft `SKILL.md` | 1,002 | Plus 125 cards |
| manim-video | 1,593 | Plus 13 references |
| motionmaxxing | 3,198 | Plus references and scripts |
| video-use | 3,754 | One large file |

Anthropic's limit is "Keep the `SKILL.md` body under 500 lines", with references "one level deep from `SKILL.md`" and a table of contents for files over 100 lines ([AN-bp]).

### 1.3 Common failures of skills, with evidence

- **Too many instructions at once.** IFScale tested 20 models on up to 500 simultaneous instructions. The best frontier models reached about 68% accuracy at the maximum density, and models "favor earlier instructions" ([IFScale]). A 3,000-word skill full of rules is in that regime.
- **Comprehensive docs instead of focused skills.** SkillsBench (7,308 trajectories) found that curated skills add +16.2 pp on average. "Comprehensive" skills averaged −2.9 pp, while "detailed" (+18.8) and "compact" (+17.1) skills helped. Two or three skills per task gave +18.6 pp; four or more gave +5.9 ([SkillsBench]).
- **Self-written skills.** SkillsBench: "Self-generated Skills provide no benefit on average" (−1.3 pp) ([SkillsBench]). Skill content must hold human-curated craft, as in shotcraft's verdict-based rules ([SC-rules]).
- **The skill is never loaded.** Vercel saw a skill go uninvoked in 56% of eval cases. An always-loaded 8 KB index reached 100%, against 79% for a skill with explicit instructions ([VERCEL]). So the trigger description must be pushy ([AN-sc]), and the router should be in the always-loaded context when possible.
- **Generic advice that restates the defaults.** OpenMontage's typography skill recommends "Inter, Open Sans, Roboto … Montserrat Bold, Bebas Neue … Poppins Bold" ([OM-type]). These are the families Anthropic's cookbook names as the generic defaults ([AN-cookbook]). Advice that a model would produce anyway does not move the output.
- **Wrong altitude.** Anthropic warns against "low-altitude hardcoded logic like specifying exact hex codes" and "vague high-altitude guidance that assumes shared context" ([AN-blog]).
- **Too many options.** "Don't present multiple approaches unless necessary … Provide a default" ([AN-bp]). video-shotcraft makes the user choose among three modes before any work ([SC-skill]). OpenMontage has 12 pipelines and more than 1,400 files under its skill folders (tree counts) ([OM-repo]).
- **Preset libraries as a fallback.** Hyperframes keeps 13 presets but says "never as the fallback for a film without a brand" ([HF-look]). theme-factory offers 10 fixed themes ([AN-theme]). Presets bring back sameness.

### 1.4 Reviewer and gate parts (noted, not recommended)

- Hyperframes: `check` is "the required final gate" ([HF-lint]); `*.motion.json` assertions ([HF-motion]); an optional "fresh pair of eyes" sub-agent ([HF-review]).
- video-shotcraft: a mandatory independent sub-agent final review ([SC-skill]).
- video-use: a "critic sub-agent" and "Parallel sub-agents for multiple animations" ([VU-skill]).
- motionmaxxing: gates G0–G5 computed by `look.py` and `lint.mjs` ([MM-skill]).
- OpenMontage: `skills/meta/reviewer.md`, `checkpoint-protocol.md`, and 21 artifact JSON schemas ([OM-repo]).

The useful part of each gate is its *measurement*. `line_unread`, `dead_stretch`, `text_below_floor`, `first_frame_empty` and `film_silent` are good numbers ([HF-lint]). Expose them as plain queries, not as pass/fail.

---

## 2. The plan and story step

### 2.1 Planning artifacts compared

| Project | Artifact | What it holds | Source |
| --- | --- | --- | --- |
| Hyperframes | `STORYLINES.md` → `SPEC.md` (+ optional `STORYBOARD.md`) | 3 storylines (name, device and form, first 2 s, beats in one line, look line, sound line); spec lines GOAL…QA; storyboard frontmatter `message`, `arc`, `audience`; per frame `reads` (what the viewer must understand, with time windows) and `sound` | [HF-story], [HF-spec], [HF-sbfmt] |
| brag / brag-slim | `brag-plan.md` | answers to 8–9 questions; angle, hook, 2–3 highlights, punchline, tone, identity; scene storyboard with durations; music tempo, "every cut on a beat" | [BR-skill], [BR-slim] |
| video-shotcraft | product brief → decision table → styleframe → feature-to-shot map → storyboard | eight stages; the mapping "is not a complete storyboard" | [SC-skill], [SC-pipeline] |
| video-use | 4–8 sentence strategy, then `edl.json` | shape, take choices, cut direction, animation, grade, subtitles, length | [VU-skill] |
| manim-video | `plan.md` | narrative arc, scene list, visual elements, palette, voiceover script; arc types Discovery, Problem-Solution, Comparison, Build-Up | [MANIM], [MANIM-plan] |
| motionmaxxing | `STORYBOARD.md` | PAGE (problem, audience, goal, emotion), the idea, per-act ground/light/texture/sound, a beat table with "buys" ("Buys ___: the viewer ___"), handoff, "the picture with the text covered" | [MM-skill] |
| OpenMontage | JSON artifacts (`brief`, `script`, `scene_plan` …) | schema-validated stage outputs | [OM-repo] |

Common core: one message, the audience, a hook, beats with timing, what is read when, sound per beat, and the handoff between shots. The parts that turn a product ad into a *story* are Hyperframes' "one viewer doing one real task … one real piece of data … travels through it" ([HF-story]), motionmaxxing's "Every beat buys one belief" ([MM-skill]), and the causal link between beats ("so…", "which means…") ([HF-spec]). That last one is the Parker/Stone "but/therefore" rule: replace "and then" between beats with "but" or "therefore" ([PS-ragan] **(secondary account of the 2011 NYU class)**; OpenMontage restates it with an explainer example, [OM-story]).

### 2.2 Recommended minimal template (`PLAN.md`, one page)

```text
FILM:      the one thing the viewer must take away, in their words (not a slogan)
FOR:       who watches, where (feed, YouTube, a talk, a site), sound on or off
SHAPE:     length as a range · aspect · fps · narrated / music only / silent
SPINE:     the one concrete case that runs from first frame to last
           (a user and a task; a worked example; a person or place; one dataset)
QUESTION:  what the opening makes the viewer want to know
ANSWER:    the payoff, and when it lands (usually 60–80% in)
STORYLINES: three one-liners (device × form), the pick, and why in one clause
BEATS:     # | in–out s | job (hook/turn/proof/payoff/close) | what happens
           | link to previous beat ("but…" / "therefore…") | what is read, with window
           | voice line | sound | handoff into the next beat
LOOK:      ground, ink, one accent and where it may appear (hex);
           display and body face, px, tracking; the medium and its rules
MOTION:    eases by role (enter, move, exit, camera); hold rule; 3–5 transition kinds
BANNED:    the shared defaults + anything this film must not become
FACTS:     every claim → its source; illustrative numbers marked; media licences
LOOK AT:   the times to snapshot (each beat, each cut, the payoff, frame 0)
```

Why each line is there: the one thing, the spine and the hook come from [HF-story]. The numbers in LOOK and MOTION come from [HF-spec]. The link column is but/therefore ([PS-ragan], [OM-story]). FACTS comes from Hyperframes ("Every claim on screen traces to the source", [HF-story]) and from Kurzgesagt's "sourcesheet" for each video ([KZ]). LOOK AT covers the frames to check ([HF-spec] QA line, [HF-review]).

### 2.3 Genre additions

**Product film.**
- One viewer, one real task, from need to result; the real UI, not a redraw. "Show the thing … Prefer the working app doing its job over a landing page" ([BR-slim]). Shotcraft: real page captures for any existing page ([SC-rules] Q1).
- Proof as 3–6 verbs, one per beat ([HF-story]).
- The brand lands once, on a built end card held 2–3 s ([HF-story]). motionmaxxing caps the end hold at 1.4 s ([MM-skill]), so the sources disagree on the number.
- Add: `PRODUCT`, `TASK`, `REAL SCREENS` (which captures), `CLAIMS` (verbatim from the source), `CTA`.

**Explainer.**
- Start in the viewer's world with a question, then bring in the device. "A film that opens on the device alone is a diagram, not an explainer" ([HF-explainer]).
- Concrete before abstract ([3B1B-faq]; Sanderson quoted in [DBX]).
- Misconception first. Muller's thesis tested multimedia that addresses misconceptions ([MULLER] catalogue; the learning-gain claim is from secondary coverage, [OM-story] **(not read in the thesis itself)**).
- One diagram that grows: "add one part per beat" ([HF-explainer]).
- Scene word budget: about 19 spoken words (≈9 s) at about 2.2 words/s for TTS ([HF-film]).
- Add: `MISCONCEPTION`, `WORKED EXAMPLE`, `DIAGRAM STATES` (the build order), `CHECK THE LOGIC` (each step verified).

**Documentary or essay.**
- Hyperframes has no documentary or essay type file. Its types are 3d, character, data, explainer, launch, music and vertical ([HF-tree]). This is a real gap in the best skill set.
- What to add, from human craft:
  - a thesis line and a but/therefore chain of argument ([PS-ragan]);
  - an evidence list, each beat tied to a source and licence ([KZ]);
  - a b-roll plan that maps each narration phrase to a picture (stock vs generated matrix in [OM-broll]);
  - J/L cuts for sound leading or trailing picture (Hyperframes supports them as separate `<audio>`, [HF-skill]);
  - Murch's ranking for cuts, emotion first, then story, then rhythm ([MURCH] **(secondary sources; book not read)**);
  - pattern interrupts every 30–60 s of talking head ([OM-long] **(OpenMontage's claim; its retention numbers are unverified)**).
- Add: `THESIS`, `ARGUMENT CHAIN`, `EVIDENCE` (source, licence), `B-ROLL MAP`, `VOICE IS THE CLOCK`, `CHAPTERS` if over about 3 min.

**Data story.**
- "A number is earned by the scene before it, then made physical" ([HF-data]).
- One data module drives every figure, with a small source line on screen.
- Build a chart in reading order: frame and axis, reference line, data, one annotation.
- Highlight one series and grey the rest. Banned: KPI grids, dashboards, pie charts ([HF-data]).
- Add: `DATASET` (file, source, date, rounding rule), `THE ONE NUMBER`, `CHART STATES`, `ANNOTATION`.

**Social short.**
- Frame 0 is the thumbnail and the hook ([HF-vertical]).
- The viewer decides in about a second. Captions serve muted viewing.
- Shots of 1–2 s and a new beat every 2–4 s ([HF-vertical]).
- Safe bands differ by source:
  - Hyperframes: text between 168 and 1330 px on 1080×1920, nothing under the right rail ([HF-vertical]);
  - brag-slim: y 250–1536, and out of the right 140 px in the lower half ([BR-slim]);
  - OpenMontage gives per-platform tables **(unverified)** ([OM-short]).
- Add: `PLATFORM`, `SAFE BAND`, `SOUND-OFF READ`, `LOOP?`.

---

## 3. Tool gaps for general-purpose HTML video

Legend: ✅ provided, ◐ partial, — absent. "Use in MIT Bun/TS": whether the code or approach can be used in an MIT, local-first Bun/TypeScript tool.

### 3.1 Seeing and measuring (the agent's own eyes)

| Capability | Who has it, how exposed | Licence | Use in MIT Bun/TS |
| --- | --- | --- | --- |
| Frame sheets: scene start and middle, cut strips, phone-width sheet, exact times | ✅ Hyperframes `snapshot --review`, `--at`, `--range`, `--zoom`, `--against ref.mp4` (CLI) ([HF-review], [HF-motion]); ◐ video-use `timeline_view.py` filmstrip + waveform ([VU-skill]); ◐ motionmaxxing `look.py` sheet ([MM-skill]); ◐ Remotion `npx remotion still` (used by shotcraft, [SC-skill]) | Apache-2.0 / MIT / Remotion License | Yes; easy with Playwright plus ffmpeg. Missing in a generic tool. |
| Motion-path plot of one element | ✅ Hyperframes `keyframes --shot motion.png --selector` (CLI) ([HF-motion]) | Apache-2.0 | Yes |
| Layout report: text off canvas, clipped, overlapping, occluded, contrast, size floor | ✅ inside Hyperframes `check` (gate) ([HF-lint]) | Apache-2.0 | Yes; expose as a plain query that returns boxes and numbers |
| Safe-area query per aspect and platform | ◐ Hyperframes Studio guides and 90/80% boxes ([HF-skill]); ◐ brag-slim asks for drawn bands on a still ([BR-slim]) | — | Yes; small data table |
| Reading-time query ("is this line on long enough?") | ◐ Hyperframes rule 0.5 s + 0.3 s/word, and `line_unread` in `check` ([HF-spec], [HF-lint]); the Netflix English limit is 20 chars/s for adult programmes ([NETFLIX]) | — | Yes; trivial pure function |
| Audio report: present, hit times, loudness, sections and onsets | ✅ Hyperframes `audio <file> --json`, `--only sections,onsets,moments` ([HF-sound], [HF-film]); ◐ video-use runs ffmpeg `ebur128` ([VU-skill]) | Apache-2.0; ffmpeg external | Yes |
| Compare with a reference video | ✅ Hyperframes `snapshot --against`; `/reverse-any-video` skill ([HF-look], [HF-skill]) | Apache-2.0 | Yes |

### 3.2 Layout, type and brand

| Capability | Who has it, how exposed | Licence | Use in MIT Bun/TS |
| --- | --- | --- | --- |
| Text fitting | ✅ Hyperframes `window.__hyperframes.fitTextFontSize(text, {fontFamily, fontWeight, maxWidth})` (runtime function) ([HF-captions]); ✅ Remotion `measureText()`, `fitText()` in `@remotion/layout-utils` ([RM-measure]); Pretext `prepare()` / `layout()` without DOM ([PRETEXT]) | Apache-2.0 / Remotion License / MIT | Pretext or own code: yes. Remotion's package: avoid (licence) |
| Brand capture from a URL or project | ✅ Hyperframes `capture <url> --json` → screenshots, copy, `tokens.json`, `design-styles.json`, logos ([HF-look], [HF-film]); ◐ motionmaxxing `brand.mjs`, `fetch_logo.mjs` (SVGL, Simple Icons) ([MM-skill]); ◐ shotcraft 2x full page + element crops + `layout.json` ([SC-skill]) | Apache-2.0 | Yes; fits a Playwright tool directly |
| Typography and brand variables | ✅ Hyperframes root `data-composition-variables` and `frame.md` / `DESIGN.md` read rules ([HF-look]) | Apache-2.0 | Yes |
| Font source | ◐ Hyperframes bundled fonts + `@font-face` ([HF-skill]); Fontsource ships fonts as npm packages ([FONTSOURCE]) | MIT (fonts mostly OFL) | Yes |
| Icons and logos | ◐ Hyperframes logos via theSVG, GitHub avatar, favicon, "never redrawn" ([HF-media]); Iconify ([ICONIFY]), Tabler ([TABLER]), Lucide ([LUCIDE]) | MIT / MIT / ISC | Yes; record each icon set's licence |

### 3.3 Motion, scenes and visual primitives

| Capability | Who has it, how exposed | Licence | Use in MIT Bun/TS |
| --- | --- | --- | --- |
| Named transitions, camera moves, kinetic type | ✅ Hyperframes registry, "About 450 ready-made … blocks and components", `catalog --query`, `add <name>` ([HF-reg]); ✅ shotcraft 125 cards + TSX demos ([SC-tree]); ◐ Remotion `TransitionSeries` ([RM-multi]) | Apache-2.0 / Apache-2.0 / Remotion License | Hyperframes and shotcraft code: yes, with Apache NOTICE. Card *format*: yes |
| Animation engine | Hyperframes builds on GSAP timelines ([HF-skill]) | GSAP "standard no-charge" licence; it forbids use "in tools that allow users to build visual animations without code" ([GSAP]) | **Risk** for a tool with a visual timeline editor. Prefer own easing/spring functions or an MIT engine |
| Captions with word timing | ✅ Hyperframes captions rules + `caption-style` registry ([HF-captions]); ✅ Remotion captions skill ([RM-skill]) | Apache-2.0 / Remotion License | Yes (own code) |
| Charts | ✅ Hyperframes registry charts; drive any chart library "from a GSAP tween's `onUpdate`" ([HF-data]); D3 ([D3]), Vega-Lite ([VEGA]) | ISC / BSD-3 | Yes |
| Diagrams | ◐ OpenMontage `diagram_gen` (Mermaid or D3) ([OM-data]); manim ([MANIM]); Mermaid ([MERMAID]), Excalidraw ([EXCALIDRAW]) | MIT | Yes; the gap is a *stepwise* reveal ("one part per beat", [HF-explainer]) |
| Code animation | ✅ Hyperframes `code-*` blocks driven by Shiki tokens ([HF-film]); Shiki ([SHIKI]), shiki-magic-move ([MAGICMOVE]), Code Hike ([CODEHIKE]) | MIT | Yes |
| Maps | ✅ Hyperframes `scripts/bake-basemap.mjs` (MapLibre over Esri or Carto tiles, bakes to MP4, needs network) ([HF-film]); ✅ Remotion maps skill (Mapbox, MapLibre, MapTiler, Cesium, static) ([RM-tree]); MapLibre ([MAPLIBRE]) | Apache-2.0; BSD-3; tile terms vary | Engine: yes. Tiles: need network and attribution; local-first means baking once |
| 3D | ◐ Hyperframes `types/3d.md` and runtimes ([HF-skill]); Remotion `3d.md` ([RM-tree]); three.js ([THREE]) | MIT | Yes |
| Lottie / Rive | ◐ Hyperframes runtimes mention Lottie ([HF-skill]); Remotion `lottie.md` ([RM-tree]); lottie-web ([LOTTIE]), dotlottie-web ([DOTLOTTIE]), rive-wasm ([RIVE]) | MIT | Yes; needs a seek-by-time adapter |
| Ken Burns and parallax on stills | ✅ Hyperframes: tween scale and x/y "on a wrapper inside the clip" ([HF-motion]); depth for parallax: Depth-Anything-V2 Small is Apache-2.0, Base/Large/Giant are CC-BY-NC-4.0 ([DEPTH]) | Apache-2.0 (Small only) | Pan/zoom: yes. Depth parallax: Small model only |
| Footage looks (grade, grain, vignette) | ✅ Hyperframes `media-treatment`, never CSS filters ([HF-skill]) | Apache-2.0 | Optional |
| Background removal / cutout | ✅ Hyperframes `remove-background` (168 MB model, about 2 fps at 1080p on CPU) ([HF-captions]); rembg ([REMBG]); imgly background-removal-js ([IMGLY]) | MIT / AGPL-3.0 | rembg approach: yes; imgly: no |

### 3.4 Assets and audio

| Capability | Who has it, how exposed | Licence | Use in MIT Bun/TS |
| --- | --- | --- | --- |
| Stock images and audio **with licence metadata** | ◐ Hyperframes SFX via Openverse, "Only CC0 and CC BY", credits to `CREDITS.md` ([HF-sfx]); images need a HeyGen sign-in ([HF-media]); ◐ shotcraft Freesound script with `--license cc0\|by` ([SC-sfx]). The Openverse API answered an anonymous query with `license`, `license_version`, `license_url`, `creator`, `source` and a ready `attribution` string, for images and for Freesound audio (my test, 2026-11-17) ([OPENVERSE]) | API terms; content CC | Yes; a missing tool in a local-first product |
| Generated images or video | ✅ Hyperframes HeyGen credits, local FLUX, local LTX ([HF-media]); motionmaxxing `imagegen.py` ([MM-skill]); OpenMontage many providers ([OM-repo]) | Varies | Optional adapter; never default |
| Screen and UI footage | ✅ DemoHunter's own Playwright tours (this repo); Hyperframes `capture` stills ([HF-film]); shotcraft captures ([SC-skill]) | — | Already the core strength |
| TTS with word timestamps | ✅ Hyperframes: HeyGen returns words with the audio; Kokoro (`hyperframes tts`) needs `transcribe` afterwards ([HF-tts]); Kokoro's Python pipeline sets token `start_ts` / `end_ts` ([KOKORO-pipe]); forced alignment via whisper.cpp ([WHISPERCPP]) or WhisperX ([WHISPERX]) | Apache-2.0 / MIT / BSD-2 | Yes. Warning from Hyperframes: whisper `small.en` "**translates** non-English speech", and it invents "Thank you." over silence ([HF-captions]) |
| Music library with beat and cue data | ✅ brag ships five tracks plus `*.music-cues.json/md`: tempo, beat grid, strong cues, reveal candidates ([BR-music], [BR-cue]); ✅ Hyperframes `beats` → `{bpm, beatTimes}` and `bpmConfidence` ([HF-beats], [HF-film]); ◐ shotcraft librosa grid fitting ([SC-skill]); web-audio-beat-detector ([WABD]), librosa ([LIBROSA]), Essentia ([ESSENTIA]) | CC BY 4.0 music; MIT / ISC / AGPL-3.0 | Yes, except Essentia. A small bundled CC0/CC BY library with precomputed cues is a strong pattern |
| SFX library | ✅ Hyperframes Openverse plus a 21-file bundled fallback ([HF-sfx]); brag bundled SFX ([BR-tree]) | CC0 / CC BY | Yes |
| Ducking, levels, loudness | ✅ Hyperframes `normalize-audio`, mixing reference; targets "−1 dBTP … −16 to −14 LUFS for social", music under voice about 0.14 volume ([HF-sound]); Spotify normalises to −14 LUFS ([SPOTIFY]) | ffmpeg external | Yes |

### 3.5 Format and structure

| Capability | Who has it | Note |
| --- | --- | --- |
| Aspect ratios, recomposition for vertical | ✅ Hyperframes: vertical "is not squeezed into it but recomposed" ([HF-vertical]); brag `--format` ([BR-skill]) | Needs a safe-band data table (3.1) |
| Long-form chapters | — Hyperframes (no type file) ([HF-tree]); ◐ OpenMontage `long-form.md` ([OM-long]); ◐ Remotion connected compositions ([RM-tree]) | Gap: chapter list → markers, YouTube chapter text, a chapter card move |
| Deterministic time | ✅ all engines: "Everything visible is a function of timeline time" ([HF-skill]); brag-slim "every frame a pure function of time" ([BR-slim]) | Already standard in seek-based HTML video |

### 3.6 Tool design rules that apply

Anthropic: "More tools don't always lead to better outcomes"; consolidate; namespace; return "high signal information"; limit tokens; make errors actionable ([AN-tools]). Hyperframes follows this: one command per job, `--json` on most commands, and "a failure prints `✗ …`, a `Fix:` line and exits non-zero" ([HF-cli]). The measurement tools above should return numbers and boxes, not verdicts. The agent decides what to fix.

---

## 4. What to leave out

1. **Critic and reviewer sub-agents.** These include shotcraft's mandatory final review ([SC-skill]), video-use's critic ([VU-skill]) and Hyperframes' optional fresh eyes ([HF-review]). The self-review questions in [HF-review] work in the same agent.
2. **Parallel scene workers.** Hyperframes measured "about 9 min for five, against about 21 min split across sub-agents" ([HF-film]). video-use's rule 10 (parallel animation sub-agents, [VU-skill]) is the opposite advice. Do not adopt it.
3. **Pass/fail gates and test suites for films.** Examples are motionmaxxing G0–G5 ([MM-skill]), `check` as a required gate and `motion.json` assertions ([HF-lint], [HF-motion]), and brag's step gates ([BR-skill]). Keep the measurements and drop the verdicts.
4. **Scores.** Hyperframes: "Never score the film out of 10: a score finds nothing to fix" ([HF-review]).
5. **Multi-mode and multi-pipeline structures.** Examples are shotcraft's three modes plus a mode question before work ([SC-skill]), OpenMontage's 12 pipelines, 21 artifact schemas and checkpoint protocol ([OM-repo]), and an eight-stage pipeline ([SC-pipeline]). One loop with genre references is enough ([AN-bp] "Provide a default").
6. **Accounts, credits and telemetry in the skill.** Hyperframes skills start with a usage beacon and route media through a sign-in, with local tools "only when the person asks, not as a fallback" ([HF-skill], [HF-media]). A local-first OSS core should default to local and free sources.
7. **Generated video and avatar providers as core.** OpenMontage ships prompting guides for six video models ([OM-repo]). Keep these as optional adapters only.
8. **Writing music in code.** Hyperframes: "Do not spend the run building an audio chain or writing music in code: nobody can hear whether it is good" ([HF-sound]). brag-slim asks the model to write and mix music itself ([BR-slim]), so the sources disagree. For a general tool, a curated library with cue data is safer.
9. **Preset theme libraries as the default look** ([HF-look], [AN-theme]).
10. **A large component marketplace as a first step.** Hyperframes' 450-item registry and its search tiers ([HF-reg]) are a big upkeep burden. Twenty to thirty named moves with parameters in a skill reference, plus a few seekable runtime adapters, cover most needs (shotcraft's card format, [SC-card]).
11. **Beat-locking everything.** shotcraft found per-beat full-frame pulses read as shake, and capped them at 3 per film ([SC-rules] R4).

---

## 5. Recommendation

### 5.1 Skill set to write

Write one router skill with references one level deep ([AN-bp]). Keep the router under about 1,200 words, like Hyperframes' 1,157 ([HF-skill]), and load the rest on demand. Total loaded per film: router + story + look + motion + one genre file ≈ 5–6k words. That is below the size at which SkillsBench's "comprehensive" skills hurt ([SkillsBench]).

| # | File | Purpose | Size | Contents |
| --- | --- | --- | --- | --- |
| 1 | `film/SKILL.md` (router) | Contract and loop | 800–1,200 words | Render contract (time-pure frames, assets local); loop: PLAN.md → build → look (sheet, layout report) → fix → delivery note; "what to read" table; the pushy trigger description ([AN-sc]) |
| 2 | `story.md` | Real story for any genre | 1,200–1,600 | The one thing, spine, three storylines from device × form tables, but/therefore links, hook rules (frame 0 never black), beat shares, copy rules (6 words a line, banned words), the PLAN.md template from §2.2 |
| 3 | `look.md` | Taste as numbers | 900–1,200 | Adjective → number table; look from a medium; outside-input order (brand, reference, subject); banned defaults, about 15 items by name, with the instruction to grow the list; type-for-video numbers (28 px floor at 1080, 4–9% title height, one accent word) ([HF-spec], [HF-motion]) |
| 4 | `motion.md` | Named moves | 1,200–1,600 | Eases by role; springs by damping; exits 40–50% shorter; staggers; holds 0.5 s + 0.3 s/word; 8–10 named transitions with parameters and "caused by"; cut on motion; J/L cuts; generated-looking defaults ([HF-motion], [MM-skill]) |
| 5 | `sound.md` | Sound as half the film | 700–900 | Voice or music is the clock; music choice by feel and tempo; SFX only on visible actions; peak one frame after picture; rotate takes; levels and LUFS; "measured, not heard" ([HF-sound]) |
| 6 | `words.md` | Voice and captions | 600–800 | VO pacing (about 2.2 words/s TTS, about 19 words a scene); never repeat the screen word for word; caption groups 2–6 words, one group at a time; reading speed ([HF-film], [HF-captions], [NETFLIX]) |
| 7–11 | `genres/product.md`, `explainer.md`, `documentary.md`, `data.md`, `short.md` | Playbooks | 300–600 each | The §2.3 additions, the shape of the type, its tells. `documentary.md` is new ground: no top project has it ([HF-tree]) |
| 12 | `look-at-it.md` | Self-inspection habit, not a gate | 400–600 | Which sheets to take; describe each beat frame as a stranger; words-covered and pictures-covered tests; phone sheet; note format `t · where · problem → change`; when to stop ([HF-review]) |

Writing rules for all files: give the why ([AN-sc]); mark values as measured defaults, not laws ([VU-skill]); keep hard rules for correctness only; include one worked mini-example per file ([SkillsBench], [AN-bp]); and collect new rules from real verdicts, in shotcraft's "rule + verdict + self-check" format ([SC-rules]).

### 5.2 Missing tools, in order

These are plain tools the agent calls, through MCP or the CLI with `--json`. Each returns data, not a pass or fail. The DemoHunter Studio MCP already has `get_screenshot`, `seek_preview`, `get_timeline` and narration tools (`apps/studio/mcp.ts` in this repo). The list below is what a general-purpose HTML film tool still needs.

1. **`film_sheet`**: contact sheets at chosen times. Modes: per beat (start and middle), a cut strip (−0.2/+0.2 s), phone width (360 px), a zoom crop, side by side with a reference. *Reason:* the agent cannot judge a film it cannot see; every top project has some form of this. *Precedent:* Hyperframes `snapshot --review` and `--against` ([HF-review]), video-use `timeline_view` ([VU-skill]), brag-slim mid-transition stills ([BR-slim]).
2. **`layout_report(t | range, aspect, platform)`**: for each text and media box: in frame, inside the safe band for that platform, overlap or occlusion, rendered px against the floor, contrast ratio. *Reason:* "a clipped label or a 0.6 s line looks fine on a contact sheet" ([HF-review]). *Precedent:* Hyperframes `check` layout and contrast findings, used here as a query ([HF-lint]); brag-slim bands ([BR-slim]).
3. **`fit_text` + `read_time`**: largest size that fits a box in a given font, line breaks, and how long a line must stay to be read (0.5 s + 0.3 s/word; ≤ 20 chars/s). *Reason:* "Too many words: cut words, never shrink type" ([HF-spec]) needs a measurement. *Precedent:* Hyperframes `fitTextFontSize` ([HF-captions]), Remotion `fitText` ([RM-measure]); build on Pretext (MIT) ([PRETEXT]).
4. **`narrate` with word timings**: TTS that writes audio plus `[{text, start, end}]`, using the provider's timestamps when they exist and local alignment otherwise. *Reason:* captions, "text lands on the word that says it" ([HF-sound]) and cue points all need words. *Precedent:* Hyperframes HeyGen words or Kokoro + transcribe ([HF-tts]); Kokoro token timestamps ([KOKORO-pipe]).
5. **`music_cues` + `audio_report`**: for a track: tempo, confidence, beat grid, sections and strong cues. For a render: sound present, hit times, LUFS and true peak. Ship a small bundled CC0/CC BY music and SFX set with precomputed cues. *Reason:* sound is "half of how a film feels" and cannot be heard by the agent ([HF-sound]). *Precedent:* brag cue files ([BR-cue]), Hyperframes `beats` and `audio` ([HF-beats], [HF-film]).
6. **`find_media`** for images, audio and SFX, with licence metadata. It filters to CC0 and CC BY (or commercial-safe), downloads locally and appends to `CREDITS.md`. *Reason:* documentaries, essays and explainers need b-roll and stills; the agent must not guess licences. *Precedent:* Hyperframes SFX via Openverse with credits ([HF-sfx]); shotcraft Freesound filter ([SC-sfx]); the Openverse API returns an attribution string without a key ([OPENVERSE]).
7. **`capture_brand(url | project)`**: screenshots, copy, colour and font tokens, logo files and font files. *Reason:* outside input is what breaks the default look ([HF-look]). *Precedent:* Hyperframes `capture` ([HF-film]), motionmaxxing `brand.mjs` ([MM-skill]). It fits DemoHunter's Playwright base.
8. **`motion_trace(selector, range)`**: samples one element's position, scale and opacity over time and draws its path. *Reason:* lets the agent check "arrive slow, leave clean" and handoffs at seams without a reviewer. *Precedent:* Hyperframes `keyframes --shot` ([HF-motion]).
9. **Seekable runtime adapters** for Lottie, Rive, three.js, chart and diagram libraries, driven by timeline time, plus a stepwise diagram reveal. *Reason:* explainers and data stories need diagrams and charts that build "one part per beat" ([HF-explainer]). *Precedent:* Hyperframes runtimes and registry charts ([HF-data]), Remotion `lottie.md` and `3d.md` ([RM-tree]). Use MIT libraries ([LOTTIE], [RIVE], [THREE], [D3], [MERMAID]) and avoid GSAP's licence risk for a visual editor ([GSAP]).
10. **`bake_map`** (lower priority): bakes a map camera move to video once, with coordinates for labels and an attribution line. *Reason:* documentaries and data stories about places. *Precedent:* Hyperframes `bake-basemap.mjs` ([HF-film]).

Not yet needed as tools: generation providers, cloud render, critics and gates (§4).

---

## Could not verify

- The Parker/Stone quotes come from secondary accounts ([PS-ragan]), not a transcript.
- Muller's learning-gain result: I read only the catalogue entry ([MULLER]), not the thesis.
- Murch's Rule of Six percentages come from secondary sites ([MURCH]); I did not read the book.
- The BBC subtitle guidelines would not load (bbc.co.uk blocked; the GitHub Pages copy returned 404). I used Netflix's English guide instead ([NETFLIX]).
- I did not read Vox process write-ups or a MrBeast production guide.
- 3Blue1Brown's "concrete before abstract" is from the FAQ summary and a Dropbox profile ([3B1B-faq], [DBX]), not the SoME video.
- OpenMontage's retention and safe-zone numbers are its own claims ([OM-long], [OM-short]).
- I did not open Material Design and Apple motion specs; the search results conflicted.
- ElevenLabs and OpenAI TTS timestamp support was not checked in this pass.

## Sources

[HF-repo]: https://github.com/heygen-com/hyperframes
[HF-tree]: https://github.com/heygen-com/hyperframes/tree/main/skills/hyperframes/references/types
[HF-skill]: https://github.com/heygen-com/hyperframes/blob/main/skills/hyperframes/SKILL.md
[HF-story]: https://github.com/heygen-com/hyperframes/blob/main/skills/hyperframes/references/story.md
[HF-spec]: https://github.com/heygen-com/hyperframes/blob/main/skills/hyperframes/references/spec.md
[HF-motion]: https://github.com/heygen-com/hyperframes/blob/main/skills/hyperframes/references/motion.md
[HF-sound]: https://github.com/heygen-com/hyperframes/blob/main/skills/hyperframes/references/sound.md
[HF-captions]: https://github.com/heygen-com/hyperframes/blob/main/skills/hyperframes/references/captions.md
[HF-review]: https://github.com/heygen-com/hyperframes/blob/main/skills/hyperframes/references/review.md
[HF-look]: https://github.com/heygen-com/hyperframes/blob/main/skills/hyperframes/references/look.md
[HF-film]: https://github.com/heygen-com/hyperframes/blob/main/skills/hyperframes/references/film.md
[HF-sbfmt]: https://github.com/heygen-com/hyperframes/blob/main/skills/hyperframes/references/storyboard-format.md
[HF-explainer]: https://github.com/heygen-com/hyperframes/blob/main/skills/hyperframes/references/types/explainer.md
[HF-data]: https://github.com/heygen-com/hyperframes/blob/main/skills/hyperframes/references/types/data.md
[HF-vertical]: https://github.com/heygen-com/hyperframes/blob/main/skills/hyperframes/references/types/vertical.md
[HF-media]: https://github.com/heygen-com/hyperframes/blob/main/skills/media-use/SKILL.md
[HF-sfx]: https://github.com/heygen-com/hyperframes/blob/main/skills/media-use/audio/references/sfx.md
[HF-tts]: https://github.com/heygen-com/hyperframes/blob/main/skills/media-use/audio/references/tts-to-captions.md
[HF-reg]: https://github.com/heygen-com/hyperframes/blob/main/skills/hyperframes-registry/SKILL.md
[HF-cli]: https://github.com/heygen-com/hyperframes/blob/main/skills/hyperframes-cli/SKILL.md
[HF-lint]: https://github.com/heygen-com/hyperframes/blob/main/skills/hyperframes-cli/references/lint-validate-inspect.md
[HF-beats]: https://github.com/heygen-com/hyperframes/blob/main/skills/hyperframes-cli/references/beats.md
[RM-repo]: https://github.com/remotion-dev/skills
[RM-skill]: https://github.com/remotion-dev/skills/blob/main/skills/remotion-best-practices/SKILL.md
[RM-tree]: https://github.com/remotion-dev/skills/tree/main/skills/remotion-best-practices/remotion-markup
[RM-multi]: https://github.com/remotion-dev/skills/blob/main/skills/remotion-best-practices/remotion-markup/multi-scene-video.md
[RM-measure]: https://github.com/remotion-dev/skills/blob/main/skills/remotion-best-practices/remotion-markup/measuring-text.md
[RM-licence]: https://github.com/remotion-dev/remotion/blob/main/LICENSE.md
[AN-fd]: https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md
[AN-fd-lic]: https://github.com/anthropics/skills/blob/main/skills/frontend-design/LICENSE.txt
[AN-algo]: https://github.com/anthropics/skills/blob/main/skills/algorithmic-art/SKILL.md
[AN-canvas]: https://github.com/anthropics/skills/blob/main/skills/canvas-design/SKILL.md
[AN-theme]: https://github.com/anthropics/skills/blob/main/skills/theme-factory/SKILL.md
[AN-sc]: https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md
[AN-bp]: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
[AN-cookbook]: https://github.com/anthropics/claude-cookbooks/blob/main/coding/prompting_for_frontend_aesthetics.ipynb
[AN-blog]: https://claude.com/blog/improving-frontend-design-through-skills
[AN-tools]: https://www.anthropic.com/engineering/writing-tools-for-agents
[BR-skill]: https://github.com/latent-spaces/brag/blob/main/skills/brag/SKILL.md
[BR-slim]: https://github.com/latent-spaces/brag/blob/main/skills/brag-slim/SKILL.md
[BR-music]: https://github.com/latent-spaces/brag/blob/main/skills/brag/assets/music/README.md
[BR-cue]: https://github.com/latent-spaces/brag/blob/main/skills/brag/assets/music/cues/happy-beats-business-moves-vol-1-by-ende-dot-app.music-cues.md
[BR-tree]: https://github.com/latent-spaces/brag/tree/main/skills/brag/assets/sfx
[SC-repo]: https://github.com/Vincentwei1021/video-shotcraft
[SC-skill]: https://github.com/Vincentwei1021/video-shotcraft/blob/main/SKILL.md
[SC-tree]: https://github.com/Vincentwei1021/video-shotcraft/tree/main/references/shots
[SC-card]: https://github.com/Vincentwei1021/video-shotcraft/blob/main/references/shots/camera/crash-zoom-punch.md
[SC-rules]: https://github.com/Vincentwei1021/video-shotcraft/blob/main/references/aesthetic-rules.md
[SC-pipeline]: https://github.com/Vincentwei1021/video-shotcraft/blob/main/references/pipeline.md
[SC-sfx]: https://github.com/Vincentwei1021/video-shotcraft/blob/main/references/sfx-sourcing.md
[VU-repo]: https://github.com/browser-use/video-use
[VU-skill]: https://github.com/browser-use/video-use/blob/main/SKILL.md
[MANIM]: https://github.com/browser-use/video-use/blob/main/skills/manim-video/SKILL.md
[MANIM-plan]: https://github.com/browser-use/video-use/blob/main/skills/manim-video/references/scene-planning.md
[OM-repo]: https://github.com/OpenMontageInc/OpenMontage
[OM-story]: https://github.com/OpenMontageInc/OpenMontage/blob/main/skills/creative/storytelling.md
[OM-type]: https://github.com/OpenMontageInc/OpenMontage/blob/main/skills/creative/typography.md
[OM-broll]: https://github.com/OpenMontageInc/OpenMontage/blob/main/skills/creative/broll-planning.md
[OM-long]: https://github.com/OpenMontageInc/OpenMontage/blob/main/skills/creative/long-form.md
[OM-short]: https://github.com/OpenMontageInc/OpenMontage/blob/main/skills/creative/short-form.md
[OM-data]: https://github.com/OpenMontageInc/OpenMontage/blob/main/skills/creative/data-visualization.md
[MM-skill]: https://github.com/Tejashmakwana/motionmaxxing/blob/main/SKILL.md
[AW]: https://github.com/zhuyansen/awesome-claude-video-skills
[HERK]: https://github.com/nateherkai/herk-edit-kit
[IFScale]: https://arxiv.org/abs/2507.11538
[SkillsBench]: https://arxiv.org/html/2602.12670v1
[VERCEL]: https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals
[PS-ragan]: https://ragan.com/?p=304037
[MULLER]: https://www.compadre.org/portal/items/detail.cfm?ID=11344
[KZ]: https://kurzgesagt.org/youtube/
[3B1B-faq]: https://www.3blue1brown.com/faq/
[DBX]: https://blog.dropbox.com/topics/work-culture/grant-sanderson-channels-his-passion-for-math-into-marvelously-i
[MURCH]: https://nofilmschool.com/2016/11/6-rules-good-cutting-according-oscar-winning-editor-walter-murch
[NETFLIX]: https://partnerhelp.netflixstudios.com/hc/en-us/articles/217350977-English-USA-Timed-Text-Style-Guide
[SPOTIFY]: https://support.spotify.com/artists/article/loudness-normalization/
[GSAP]: https://gsap.com/standard-license
[PRETEXT]: https://github.com/chenglou/pretext
[FONTSOURCE]: https://github.com/fontsource/fontsource
[ICONIFY]: https://github.com/iconify/iconify
[TABLER]: https://github.com/tabler/tabler-icons
[LUCIDE]: https://github.com/lucide-icons/lucide/blob/main/LICENSE
[D3]: https://github.com/d3/d3
[VEGA]: https://github.com/vega/vega-lite
[MERMAID]: https://github.com/mermaid-js/mermaid
[EXCALIDRAW]: https://github.com/excalidraw/excalidraw
[SHIKI]: https://github.com/shikijs/shiki
[MAGICMOVE]: https://github.com/shikijs/shiki-magic-move
[CODEHIKE]: https://github.com/code-hike/codehike
[MAPLIBRE]: https://github.com/maplibre/maplibre-gl-js/blob/main/LICENSE.txt
[THREE]: https://github.com/mrdoob/three.js
[LOTTIE]: https://github.com/airbnb/lottie-web
[DOTLOTTIE]: https://github.com/LottieFiles/dotlottie-web
[RIVE]: https://github.com/rive-app/rive-wasm
[DEPTH]: https://github.com/DepthAnything/Depth-Anything-V2
[REMBG]: https://github.com/danielgatis/rembg
[IMGLY]: https://github.com/imgly/background-removal-js
[OPENVERSE]: https://api.openverse.org/v1/images/?q=lighthouse&license_type=commercial,modification
[KOKORO-pipe]: https://github.com/hexgrad/kokoro/blob/main/kokoro/pipeline.py
[WHISPERCPP]: https://github.com/ggml-org/whisper.cpp
[WHISPERX]: https://github.com/m-bain/whisperX
[WABD]: https://github.com/chrisguttandin/web-audio-beat-detector
[LIBROSA]: https://github.com/librosa/librosa
[ESSENTIA]: https://github.com/MTG/essentia
