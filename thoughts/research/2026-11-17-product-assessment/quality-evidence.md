# Quality plan: evidence test and revised plan

**Research date:** 2026-11-17

**Scope:** Is the plan in [video-quality.md](video-quality.md) the correct path to better films? The plan made three claims: (1) automatic gates and a clean-context critic raise quality more than better instructions, (2) recording polish matters a lot, (3) a block library is better than scene design from a blank page.

**Decision:** The path is correct in its direction, but the order changes. Put a storyboard gate first. Build a narrow, tuned `check`, not a broad one. Keep the critic for what a check cannot see, with a clean context and no scores. Make readable product footage (camera and crop) the main polish item. Move the block library down. One statement in the first report was wrong and is corrected: the films do have a cursor.

## Owner direction (2026-11-17), which replaces parts of this plan

After this evidence test, the owner set the direction for quality work:

- DemoHunter is a general-purpose, HTML-based video tool for agents. It is not only a product-demo tool.
- Quality comes from the agent that makes the film, with good, opinionated skills and good tools.
- A plan and story step is wanted. The agent writes the plan and derives the story before it builds.
- Not wanted: reviewer or critic agents, pass/fail gates or test systems for films, multi-agent pipelines, and agents that build agents.
- New tools are welcome where a tool is truly missing.

So items 2 and 3 of the "Revised plan" below change. The measurements stay useful as plain tools that the one agent calls (frame sheets, a layout query). The verdicts, the gate and the critic agent are dropped. The plan for this direction is in [skills-and-tools.md](skills-and-tools.md).

## Three tests

| Test | Method | Detail document |
| --- | --- | --- |
| Published evidence | Web research for and against each claim, with sources | [quality-evidence-external.md](quality-evidence-external.md) |
| Blind critic | An agent with a clean context reviewed two real agent-made films from frames, captions and audio measurements only | Not in the repository (it describes private product screens) |
| Prototype gate | A prototype of numeric checks ran on the same films; each finding was checked against its evidence image | Not in the repository (it describes private product screens) |

The two films are private product films: "film A" (116.6 s, a web application) and "film B" (80.8 s, a command-line tool). An agent made them with the `demohunter-commercial` skill and declared them complete. The evidence images are not in the repository, because they show product screens.

## Result 1: published evidence

| Claim | Verdict | Strength |
| --- | --- | --- |
| Gates and a clean-context critic | Partly supported | Measured studies in adjacent tasks; no study compares a critic with better instructions |
| Recording polish "matters a lot" | Weak | Cues that point attention have a small to medium measured effect; cursor smoothing, motion blur and automatic zoom have market and vendor signals only |
| Block library | Partly supported | The measured gains are mostly fewer broken outputs, not more distinctive design |

For the plan:

- Code2Video (arXiv 2510.01174): without the Critic, aesthetics fell 6.5 points and quiz results fell 21.3 points.
- The Anthropic harness report (March 2026): "agents reliably skew positive when grading their own work". A separate judge is "a strong lever". A NeurIPS 2024 study measured the same self-preference.
- AutoPresent: a helper library took GPT-4o from 28.7 to 56.3 on slides.
- IFScale: accuracy falls to about 68% at 500 instructions. This supports the move of rules from skill text into a checker.

Against the plan:

- In Code2Video, removal of the Planner cost about 41 points, against 6.5 for the Critic.
- Vision models are weak at fine detail (about 56–59% on trivial visual tests) and at timing (GPT-4o 38.5% on TemporalBench, about 30 points below humans). Their numeric scores do not agree with humans.
- The Anthropic evaluator would "talk itself" into approval of mediocre work.
- Wistia made ads for $1K, $10K and $100K. The $10K ad won on cost for each install. Their conclusion: story is more important than budget.

## Result 2: blind critic on the two films

The critic found 44 defects: 26 in "film A" and 18 in "film B".

| Root cause | film A (P0/P1/P2) | film B (P0/P1/P2) | Serious (P0 + P1), both films |
| --- | --- | --- | --- |
| A. Text and layout that a numeric check can find | 6 (1/3/2) | 5 (0/3/2) | 7 |
| B. Raw-recording look | 3 (0/1/2) | 4 (0/1/3) | 2 |
| C. Scene design and brand | 6 (0/1/5) | 1 (0/0/1) | 1 |
| D. Story, pacing, script | 3 (0/2/1) | 5 (0/3/2) | 5 |
| E. Audio and music | 2 (0/0/2) | 1 (0/0/1) | 0 |
| F. Transitions and seams | 5 (0/0/5) | 2 (0/0/2) | 0 |
| G. Other | 1 (0/1/0) | 0 | 1 |
| **Total** | **26 (1/8/17)** | **18 (0/7/11)** | **16** |

The most serious findings:

- **"film A", 0 s:** the first frame is an empty gradient. Only slogan cards show until 9.2 s.
- **"film A", 22–110 s:** the application is recorded at full desktop width with no zoom. The text is about 2–3 px at phone width. This is most of the film.
- **"film A", 59–69 s and 88 s:** the demo account shows the name of a test fixture user in a greeting and in a list.
- **"film A", 84–91 s and 104–111 s:** 7.1 s and 6.4 s with no narration on static screens.
- **"film B", 0–29 s:** setup steps before any result. The payoff comes at 49–62 s.
- **"film B", 15 s and 29–34 s:** the narration does not agree with the screen: one line names a window 5 s before it shows, and one line names output that is not on screen.
- **"film B":** the terminal is about 85% empty, the camera does not move, and the text is about 7 px at phone width.

Other observations:

- The added scenes (intro, lifted cards) are the best part of "film A". Scene design has 1 serious defect in the two films.
- Loudness is −16.0 LUFS and −2.0 dBTP in the two films. This is in the target.
- The spectrograms of the music look like generated tones (sustained notes in blocks, no percussion). The critic could not listen, so this is a suspicion only.
- The cursor is present, but it is an arrow of about 20 px with weak click emphasis, and it is hard to find in the table beats.

The author of this report looked at the contact sheets and agrees with the main findings.

## Result 3: prototype gate on the two films

| Film | Run time | Findings | True | False | Unclear | Precision |
| --- | --- | --- | --- | --- | --- | --- |
| film A | 41.7 s | 51 | 12 | 30 | 6 | 25% |
| film B | 13.2 s | 10 | 1 | 4 | 3 | 20% |

Real defects that the gate found in "film A" and that the agent missed:

- 79.1 s: a lifted card goes to full size in one frame, and the original card stays visible adjacent to it for about 2 frames.
- 17.1 s: a lifted card jumps to about 1.9 times its size in one frame.
- 85.6 s: a 16 px label.
- 19.0 s: a kicker label at 2.8:1 contrast. 7.4 s: a grey sub line on orange at 3.4:1 and 27 px.
- Two headlines are fully settled for about 1.55 s against a floor of 1.8 s.
- The lift overlays use Georgia and system-ui, not the brand fonts.
- Loudness is −16 LUFS; the skill asks for −14 ± 1 for YouTube.

Sources of false findings:

| Check | False | Cause |
| --- | --- | --- |
| Font floor of 28 px | 15 | It flags labels, pills and badge numbers of 22–25 px that agree with the 22 px floor of the skill |
| No cursor | 12 | The check assumed that no cursor is drawn. The recording has a `demohunter-cursor` element with click rings. |
| Extra font family | 2 | Monospace for shell commands counted as a third family |
| Seam mismatch | 2 | The normal blur fade at the end of an overlay |
| Others | 3 | A nested word count, a mask frame in the middle of an animation, an ignored spotlight overlay |

With these five corrections, the estimate for "film A" is 12 real findings and about 2 false findings. The gate was not run again after the corrections, so this is an estimate.

What the gate cannot see: composition, story, pacing and music. It called a 5 s still of a dense page "deliberate" because narration covered it. It did not name the best design defect in the sample, a label that wraps to two lines with an orphaned character.

## What the three tests show together

1. **The agent does not see its own defects.** It declared the films complete with 16 serious defects. This agrees with the published self-grading bias. A separate check and a separate critic are necessary.
2. **A numeric check finds about half of the serious defects** (7 of 16), in less than a minute. But only a narrow, tuned check is useful. At 25% precision the agent would work on false alarms.
3. **Story is the second cause** (5 of 16 serious defects), and no check on pixels sees it. Published evidence says the same: the plan step matters more than the critic. The storyboard must be a gate before the render.
4. **Readable product footage is the largest visible gap.** This is the concrete form of "recording polish" on these films: crop and zoom to the active area. Cursor smoothing, motion blur and 60 fps have weak evidence and go last.
5. **Scene design is not the weak point.** The skill already gives good scenes. A large block library does not solve the defects that these films have.
6. **Demo data matters.** One serious defect is a test account name on screen. No tool checks this now.

## Revised plan

| Order | Item | Why | Evidence |
| --- | --- | --- | --- |
| 1 | **Storyboard gate.** A storyboard file with a fixed structure, validated by a command before any render: product on screen in the first seconds, payoff early, one idea for each beat, each narration line matched to the screen at that time, runtime budget, realistic demo account. | Story caused 5 of 16 serious defects; the planner matters most in Code2Video | Critic, external |
| 2 | **Narrow `check`** with an evidence crop and a fix line: seam pops at lift hand-overs, read time, font size by text role, contrast below 3:1, phone-width legibility of product footage, empty first frame, dead stretches (stricter than "narration covers it"), loudness. | Finds real defects in less than a minute; must be tuned to stay useful | Gate prototype |
| 3 | **`review` and a clean-context critic.** Contact sheets, cut strips, a phone-width sheet and full-size text crops. The critic gets a checklist and reports `time · where · problem → exact change`. No scores. A maximum of 3 rounds. | Agents grade their own work too high; vision models are weak at fine detail, so they need crops | Critic, external |
| 4 | **Camera and crop for readable footage.** An automatic camera on the active area, as a cue that follows the narration. A larger cursor with a click pulse, and a spotlight on the target. | The largest visible gap in the two films | Critic |
| 5 | **Demo data check.** Flag test names and placeholder data on screen, in the storyboard gate and in `check`. | One serious defect in the sample | Critic |
| 6 | **Blocks as structure and motion parts** that take brand tokens as input. Add a check for default "AI look" choices. | Lower priority: scene design had 1 serious defect | Critic, external |
| 7 | **Music.** Listen to the generated score against a curated track before a decision. | Suspicion only; not measured | Critic |
| Last | Motion blur, 60 fps, supersampling | Weak evidence and a cost of 2 times or more | External, export spike |

## Regression set

Use the two films as the test set for the gate. The critic report is the list of known defects. A release of `check` must find the defects in category A with few false findings on these films. Add each new film and its human-confirmed defects to the set.

## Limits

- Two films from one product and one skill. The distribution of root causes can be different for other products.
- The critic and the prototype gate are AI agents. A person did not review each finding. The author of this report checked the contact sheets and a sample of the evidence frames.
- The critic could not listen to the audio.
- The precision estimate after the corrections is not measured.
- No test compared a film made with the gate against a film made without it. This A/B test is the next evidence step: make the same film two times, and let a blind critic compare the results.
