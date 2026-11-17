# External evidence for the video-quality plan

## Research date

2026-11-17. Sources were checked through web search and page fetches on that date. Where I read only an abstract or a secondary summary, I say so.

## Scope

This file tests three claims in the plan to raise the quality of videos made by coding agents with DemoHunter, plus four supporting assumptions. For each claim I looked for evidence for it and against it. I keep measured evidence (studies, ablations, benchmarks) apart from industry data, vendor claims and opinion.

There is no published study on agent-made product demo videos specifically. Most evidence comes from nearby tasks: educational video generation, slides, posters, charts, web UI, and code. Treat transfer to DemoHunter as an inference, not a result.

## Verdict table

| Claim | Verdict | Strength of evidence |
|---|---|---|
| 1. Automated gates plus a clean-context visual critic raise quality more than better instructions | Partly supported | Measured study (ablations in nearby tasks), plus one strong first-party vendor report. No study compares "critic" against "better instructions" head to head. In the best ablation, planning mattered more than the critic. |
| 2. Recording polish (smoothed cursor, auto zoom, motion blur, ≥30 fps, sharp text) matters a lot | Weak for "a lot"; partly supported for cueing | Measured study for cueing/signalling (small to medium effect). Only vendor claims and market signals for smoothing, motion blur and auto zoom. One industry test found budget/polish mattered less than story. |
| 3. A library of proven, editable blocks beats blank-page scene design | Partly supported | Measured study (library ablation on slides, few-shot examples for UI critique) plus first-party vendor guidance. Homogenisation risk is also measured. |

## Claim 1: gates plus a clean-context visual critic

### Evidence for

- **Code2Video (Chen, Lin, Shou, arXiv 2510.01174).** Planner, Coder and Critic agents write Manim code for educational videos. Ablation with a GPT-4.1 backbone (Table 4): full system scored 79.0 aesthetics and 82.0 TeachQuiz. Without the Critic: 72.5 (−6.5) and 60.7 (−21.3). Without visual anchor prompts: 69.2 (−9.8) and 55.2 (−26.8). Without the Planner: 38.1 (−40.9) and 40.5 (−41.5). Aesthetics were scored by one VLM judge (Gemini 2.5 Pro). https://arxiv.org/html/2510.01174v1
- **Code2Video human study (same paper, Table 8).** Code2Video with Claude Opus 4.1 scored 81.8 aesthetics and 80.3 TeachQuiz. A plain code LLM (Claude Opus 4.1) scored 51.2 and 56.6. Human-made 3Blue1Brown videos scored 96.5 and 78.8. Small sample: 6 middle-school and 2 undergraduate volunteers per group. https://arxiv.org/html/2510.01174v1
- **MatPlotAgent (arXiv 2402.11453, ACL Findings 2024).** A visual agent looks at the rendered chart and gives feedback. Full system: 72.62 (hard) and 68.35 (easy). Without visual feedback: 66.67 and 65.82. Scores are GPT-4V ratings from 0 to 100 against a ground-truth figure; the authors report strong correlation with human ratings. Numbers from search extracts of the paper; I did not read the table myself. https://arxiv.org/pdf/2402.11453
- **AutoPresent (Ge et al., CVPR 2025, arXiv 2501.00912).** GPT-4o refines a slide after seeing a render of it. Table 6: 58.0 → 59.5, 56.3 → 59.5, 58.5 → 59.8 across three settings. Small but consistent gains. https://arxiv.org/html/2501.00912v1
- **Paper2Poster (arXiv 2505.21497, NeurIPS 2025).** A VLM "commenter" checks text fit, figure clarity and balance. Ablation is qualitative: without the commenter, posters show overflow, blank gaps and weak structure. Commenter with in-context reference examples works best. No numeric ablation found. https://arxiv.org/pdf/2505.21497 and https://neurips.cc/media/neurips-2025/Slides/121461.pdf
- **Anthropic, "Harness design for long-running apps" (Prithvi Rajasekaran, 2026-03-24).** First-party engineering report, not a controlled study. Quotes: "agents tend to respond by confidently praising the work"; "agents reliably skew positive when grading their own work"; "Separating the agent doing the work from the agent judging it proves to be a strong lever"; "tuning a standalone evaluator to be skeptical turns out to be far more tractable". Frontend runs used 5 to 15 iterations. No quantified quality gain is reported. https://www.anthropic.com/engineering/harness-design-long-running-apps
- **Self-preference bias is measured.** Panickssery, Bowman, Feng (NeurIPS 2024): LLM judges rate their own outputs higher than others' when humans rate them equal. Self-recognition and self-preference are linearly correlated. This supports a judge that does not know it wrote the work. https://arxiv.org/html/2404.13076v1
- **Intrinsic self-correction often fails.** Huang et al. (ICLR 2024): without external feedback, LLMs struggle to self-correct reasoning, and performance sometimes drops. The paper notes self-correction does help on style-type tasks. https://arxiv.org/abs/2310.01798
- **Executable feedback helps code agents.** Reflexion (Shinn et al., NeurIPS 2023): 91% pass@1 on HumanEval vs. 80% for GPT-4, using test results as feedback. https://arxiv.org/abs/2303.11366
- **Prose rules degrade as they pile up.** IFScale (Jaroslawicz et al., NeurIPS 2025): 500 keyword-inclusion instructions; the best frontier models reached about 68% accuracy at full density, with a bias toward earlier instructions. This supports moving rules out of the skill and into a checker. https://arxiv.org/html/2507.11538v1
- **Checklists beat direct scores.** TICK (Cook, Rocktäschel, Foerster, 2024): LLM-generated checklists raised exact agreement between LLM judges and human preference from 46.4% to 52.2% versus direct scoring. Vanilla Self-Refine "leads to substantial degradation" in their setting while checklist-guided refinement improved. https://arxiv.org/abs/2410.03608
- **Few-shot examples improve a visual critic.** UICrit (Duan et al., UIST 2024): few-shot examples of similar UIs plus a screenshot with coordinate marks gave a 55% gain in LLM UI feedback over zero-shot, confirmed by design experts. https://arxiv.org/abs/2407.08850
- **Peer tools already ship this pattern (vendor practice, not evidence of effect).** Hyperframes' CLI skill runs "lint after first pass", "`check --json` fix every error", then "read snapshot PNGs"; a film workflow uses `snapshot --review` ending in a REVIEW.md. https://tessl.io/registry/skills/github/heygen-com/hyperframes/hyperframes-cli/review and https://mcpservers.org/agent-skills/heygen-com/hyperframes-cli. video-use "Self-evaluates the rendered output at every cut boundary" with up to 3 fix-and-re-render loops; no measured results. https://github.com/browser-use/video-use. OpenMontage has pre-compose validation and post-render self-review; reviewers note they did not test output quality. https://wavect.io/blog/openmontage-ai-video-production-review/

### Evidence against or limits

- **Planning beat critique.** In Code2Video, removing the Planner cost ~41 points; removing the Critic cost 6.5 aesthetics points. Visual anchors (structured layout positions) also mattered more than the critic. The critic is a secondary lever. https://arxiv.org/html/2510.01174v1
- **VLM critics miss brief, small things.** Code2Video's authors say VideoLLMs often miss brief frame-level occlusions that humans notice. https://arxiv.org/html/2510.01174v1
- **VLMs are weak at fine spatial detail.** BlindTest (Rahmanzadehgervi et al., ACCV 2024): leading VLMs averaged about 56–59% on trivial tasks like overlapping circles; best model (Claude 3.5 Sonnet) about 74%. https://arxiv.org/abs/2407.06581
- **VLMs are weak at timing and motion.** TemporalBench (Cai et al., 2024): GPT-4o reached 38.5% on fine-grained temporal questions, about 30 points below humans. A contact-sheet critic cannot judge pacing or motion quality well. https://arxiv.org/abs/2410.10818
- **Numeric scores from VLM judges are unreliable.** MLLM-as-a-Judge (Chen et al., ICML 2024): GPT-4V aligned with humans on pairwise comparison (0.773 without ties) but showed "notable discrepancies" on scoring and batch ranking. https://arxiv.org/abs/2402.04788
- **Self-revision often does not help.** Design2Code (Si et al., NAACL 2025): text-augmented prompting helped most models, but "few can self-revise their generation" from rendered screenshots. Gains on the hard subset were limited and inconsistent (secondary summary). https://arxiv.org/abs/2403.03163
- **Critic tuning is real work, and it still rubber-stamps.** Anthropic: "Out of the box, Claude is a poor QA agent"; the evaluator would "talk itself into deciding they weren't a big deal and approve the work anyway"; "still an LLM that is inclined to be generous towards LLM-generated outputs"; scores "improved over iterations before plateauing". The full harness cost over 20x a solo run ($200 vs $9 in one example). https://www.anthropic.com/engineering/harness-design-long-running-apps
- **Bad gates mislead.** Reflexion fell below baseline on MBPP when its self-written tests produced false positives (secondary summary). A `check` with wrong thresholds can push the agent the wrong way. https://arxiv.org/abs/2303.11366
- **Gains are often small.** AutoPresent refinement added 1.3 to 3.2 points. https://arxiv.org/html/2501.00912v1
- **A clean-context reviewer is not proven to beat a same-context reviewer on visual work.** The self-preference result is on text. The Anthropic report is qualitative. I found no ablation of "same model, fresh context" vs. "same context" on visual output.

### What this means for the design

1. Keep `check`, but make storyboard and layout structure the first lever. The best ablation says planning and anchored layout matter more than critique. Enforce a storyboard with beats, durations and fixed layout slots before any scene code.
2. Put everything measurable in `check`, not in the critic: text read time, dead stretches, text size, contrast, overflow, safe areas, empty first frame, loudness, scene durations. VLMs are weakest at exactly these (small detail, timing).
3. Keep the critic's report as specific defects (`time · where · problem → exact change`). Do not ask for numeric scores. Evidence favours checklists and pairwise comparison over scores.
4. Give the critic a checklist and a few reference examples (good and bad frames). UICrit and Paper2Poster both show reference examples help critics.
5. Feed the critic dense frames around transitions and clicks, plus crops at full resolution for text. Do not rely on a downscaled contact sheet for fine text.
6. Do not ask the critic to judge motion smoothness or pacing from stills. Measure pacing in `check`; leave motion to a short human preview or to deterministic rules.
7. Cap loops (2–3 rounds, like video-use) and stop when the defect list stops shrinking. Track cost.
8. Where possible, use pairwise review ("A or B, why") between two variants instead of an absolute verdict.

## Claim 2: recording polish

### Evidence for

- **Signalling works, with a small-to-medium effect.** Richter, Scheiter, Eitel (2016) meta-analysis: 27 studies, 2,464 participants, r = 0.17 (95% CI .11–.22) for signalled multimedia material; stronger for low prior knowledge learners. https://psycharchives.org/handle/20.500.12034/2018 (data/code record) and summary at https://inspire.acu.edu.au/articles/signalling
- Alpizar, Adesope, Wong (2020) meta-analysis: 29 studies, 2,726 participants, d = 0.38. https://link.springer.com/article/10.1007/s10339-020-01002-5 (record found via search; I did not read the full text)
- Schneider et al. (2018) meta-analysis: 103 studies, g+ = 0.53 retention, 0.33 transfer. Secondary summary only; not verified against the paper. https://inspire.acu.edu.au/articles/signalling
- **Cues on screencasts can help task performance.** AutoCue (Graphics Interface 2026 paper): visual cues added to screencast tutorials reduced task completion time and breakdowns relative to baseline. Snippet only. https://cs.uwaterloo.ca/~dvogel/gi2026/papers/1020b.pdf
- **Market signal (vendor/industry, not effect data).** Screen Studio, a paid macOS recorder built around auto zoom on clicks, cursor smoothing and motion blur, was a solo-founder product from 2023 and is widely reviewed. Revenue is not public; the founder reportedly said "400 licenses in the first month". https://saasbrowser.com/hi/saas/343743/screen-studio and https://dev.to/pickuma/screen-studio-review-the-macos-screen-recorder-that-makes-every-recording-look-produced-3a02. Cap (open source) has 25.2k GitHub stars and lists zooms in Studio mode. https://github.com/CapSoftware/Cap. Several open-source clones copy auto zoom (Recordly, Screenize). https://alternativeto.net/software/screenize/about

### Evidence against or limits

- **No study isolates cursor smoothing, motion blur or auto zoom.** I found no controlled experiment on these in screen recordings. The research supports cueing (pointing attention), not "cinematic" smoothness.
- **Attention is not performance.** A 2024 eye-tracking study (SAGE) found visual emphasis on tutorial screenshots drew attention but did not improve user performance over unedited screenshots. https://journals.sagepub.com/doi/10.1177/00472816241262221 (access via the indexed record found in search)
- **Polish vs. story (industry data).** Wistia's "One, Ten, One Hundred" (2018): three ads at $1K, $10K and $100K for the same product. The $10K ad won on cost per install ($6.66 on YouTube); the $1K and $100K ads were both above $10. Wistia concluded story matters more than production quality. One product, one campaign, $60,000 spend. https://wistia.com/blog/does-budget-matter-in-video-advertising
- **Auto zoom misfires (user reports).** Screen Studio users ask for "remove all zooms", report zooms starting too late before clicks, and reviewers report zooms on the wrong area on fast cursor moves. https://hub.screen.studio/p/remove-all-zooms-button and https://hub.screen.studio/p/custom-settings-for-default-automatic-zoom-range
- **Camera motion can cause discomfort.** Virtual camera movement without physical motion is a known source of vection and cybersickness; faster camera motion increased visual-vestibular conflict (r² = 0.50) in one AR poster. These are VR/AR sources, not flat-screen demos. https://www.pdf.inf.usi.ch/projects/CybersicknessDeformed/CybersicknessDeformed.pdf and https://www.visionsciences.org/presentation/?id=3136
- **Frame rate effects are content-dependent and studied on camera video.** LIVE-YT-HFR (85 subjects, 19,000 ratings) and the HFR-LS follow-up found frame rate effects are significant but "complex and interactive" with bitrate. Nothing specific to UI recordings. https://arxiv.org/abs/2007.11634

### What this means for the design

1. Treat zoom as a signalling cue, not decoration. One purposeful zoom per beat, tied to the narrated object. Return to context after it.
2. Add `check` rules: minimum hold time after each zoom; maximum zoom/pan velocity; a cap on zooms per minute; zoom must start before the click, not after.
3. Prioritise sharp text and correct crop over motion blur. Blur has no evidence; legibility does (it is what signalling needs).
4. Cursor smoothing is cheap and expected by the market, so do it, but do not count it as a quality lever. Do not let it hide the real click target.
5. 30 fps is a sound floor for UI; I found no evidence that 60 fps matters for demos. Do not spend effort here first.
6. Story and script beat polish in the only budget test found. Spend critic attention on the script and the first 10 seconds before camera work.

## Claim 3: a library of proven blocks beats blank-page design

### Evidence for

- **Library ablation on slides.** AutoPresent's SlidesLib (high-level helper functions): GPT-4o detailed-only 28.7 → 56.3; high-level 39.7 → 58.5; LLaMA 8B high-level 4.8 → 43.7. One case got worse (LLaVA 7B detailed-only 9.3 → 8.0). Note: this is a code-API library, which mainly cuts errors; it is not a visual template library. https://arxiv.org/html/2501.00912v1
- **Blank-page convergence is acknowledged by a model vendor.** Anthropic, "Improving frontend design through Skills" (2025-11-12): without guidance, models default to Inter fonts, purple gradients on white and minimal animation, called "distributional convergence". Even with explicit instructions the model drifts to other common choices (e.g. Space Grotesk). First-party guidance, no metrics. https://claude.com/blog/improving-frontend-design-through-skills
- **Reference examples help design critique.** UICrit: 55% gain with few-shot examples of similar UIs. https://arxiv.org/abs/2407.08850
- **In-context reference examples help the poster critic.** Paper2Poster: commenter with in-context examples gave the best variant (qualitative). https://arxiv.org/pdf/2505.21497
- **Retrieval of components in GUI generation.** GUIDE (Kolthoff et al., ICSE 2025 demo): RAG over Material Design components; preliminary study with 28 UI/UX crowd workers showed significant Likert improvements over a Figma-only baseline. https://arxiv.org/abs/2502.21068
- **Peer tools converge on libraries (vendor practice).** Hyperframes' registry: "About 450 ready-made blocks and components installed as editable source"; the repo has 85.8k stars. https://github.com/heygen-com/hyperframes. video-shotcraft: 124 recipe cards (timing, parameters, pitfalls) distilled from product films by ClickUp, Figma, Notion; no before/after data. https://raw.githubusercontent.com/Vincentwei1021/video-shotcraft/main/README.md

### Evidence against or limits

- **Homogenisation is measured.** Doshi and Hauser (Science Advances, 2024): AI ideas made individual stories rated more creative, but AI-assisted stories were more similar to each other (about 10.7% more similar per press coverage; not checked against the paper). https://pmc.ncbi.nlm.nih.gov/articles/PMC11244532
- **Vibe-coded web design homogenisation (risk analysis, not measurement).** Shin et al. (arXiv 2603.13036, 2026) argue frictionless generation narrows design diversity and propose "productive friction". https://arxiv.org/abs/2603.13036
- **Retrieval is not always the best lever.** A GUI-generation comparison (arXiv 2412.11328) found self-critique generation more effective than retrieval-augmented generation. https://arxiv.org/abs/2412.11328
- **No direct test of template libraries for video.** I found no study comparing template-based vs. from-scratch motion scenes for video quality. Hyperframes and video-shotcraft publish no before/after numbers.
- **Templates shown here mostly reduce errors.** SlidesLib's biggest gains are on weak models and on syntactically hard tasks. That supports "fewer broken scenes", not "more distinctive scenes".

### What this means for the design

1. Build blocks as structure and motion primitives (layout slots, timing, easing, transitions), not as finished looks. That is where the evidence (error reduction, anchors) is strongest.
2. Make brand tokens (fonts, colours, radii) an input to every block. This addresses template sameness and brand mismatch.
3. Use retrieval of a few reference examples per scene type, for both the author and the critic. Few-shot examples have the best measured effect.
4. Add a `check` that flags known default looks (e.g. default fonts, purple-on-white gradients) unless the brand asks for them.
5. Keep blocks editable source, and allow the agent to write a custom scene when no block fits. Track how often blocks are used without edits; high unedited reuse is a sameness warning.

## Supporting assumptions

- **(a) Audio quality affects perceived credibility.** Supported, measured. Newman and Schwarz (Science Communication, 2018): same content in high vs. low audio quality; with poor audio, participants rated the research as less important and the researcher as less intelligent and less likable. About 97 and 99 participants in two experiments (press figures). https://dornsife.usc.edu/news/stories/norbert-schwarz-research-links-sound-quality-belief/ . Loudness targets: −14 LUFS integrated is widely cited for YouTube and Spotify, −16 LUFS for Apple; −1 dBTP true peak is common. I found only secondary sources, not a YouTube spec. These targets matter mainly because platforms normalise; I found no study showing that hitting them raises perceived quality. https://en.wikipedia.org/wiki/Audio_normalization
- **(b) The first seconds decide retention.** Supported by industry data, not controlled studies. Wistia: average drop in the opening ("nose") is 4.9% for 1–2 minute videos and 17.3% for 5–10 minute videos, from a large sample of Wistia-hosted videos. https://wistia.com/library/understanding-audience-retention . YouTube Analytics treats the first 30 seconds as the "Intro" metric and advises changing them to keep viewers. https://support.google.com/youtube/answer/9314415 . TikTok says over 63% of its highest-CTR ads show the key message in the first 3 seconds; no method given. https://ads.tiktok.com/business/library/Auction_Ads_Creative_Tips.pdf
- **(c) Captions raise watch time and comprehension.** Partly supported. Facebook internal tests: captions raised video ad view time by 12% on average (vendor claim, no public method). https://martech.org/facebook-releases-new-video-ad-features-including-automated-captions . Gernsbacher (2015) reviews over 100 studies on caption benefits. https://successforkidswithhearingloss.com/wp-content/uploads/2020/04/Video-Captions-Benefit-Everyone_2015.pdf . A critique notes the evidence is strongest for second-language learners and deaf/hard-of-hearing viewers, and thin for same-language captions for typical viewers. https://www.learningandthebrain.com/blog/video-captions-benefit-everyone-an-investigation/
- **(d) An agent should not compose music in code.** No direct evidence. I found no study of code-generated or procedural music in video. The nearest facts: Anthropic notes "Claude can't actually hear", which weakened its QA for musical taste. https://www.anthropic.com/engineering/harness-design-long-running-apps . Listeners like music less when told it is AI-composed (Shank et al., 2022), though a 2025 study found the opposite for pop. https://pubmed.ncbi.nlm.nih.gov/36006713/ and https://doaj.org/article/4f7bfa2467f84344b6f5e94a3b305cc2 . The rule is reasonable as an engineering choice (the agent cannot listen to verify), not as a proven quality finding.

## What I could not verify

- Exact MatPlotAgent ablation table layout (numbers came from extracts).
- Schneider et al. (2018) effect sizes against the original paper.
- Any number for Screen Studio revenue or user count.
- Cap's auto zoom: README mentions zooms but not auto zoom or cursor smoothing.
- Hyperframes registry size of 456 items: the README says "about 450". No official doc of `snapshot --review` output was found; only skill catalogue pages.
- Any before/after quality data from Hyperframes, video-shotcraft, OpenMontage, video-use or brag. None publish measured results; brag was not checked in depth.
- Navattic/Arcade data comparing polished vs. plain demo videos. Navattic reports interactive demos beating videos (top 25% by 2.5x, 2024 report), which is not about polish. https://navattic.com/blog/product-demo-videos
- Any study of 60 fps vs. 30 fps for UI screen recordings.
- Any ablation of a fresh-context reviewer vs. a same-context reviewer on visual output.
- The 10.7% homogenisation figure in Doshi and Hauser (taken from press coverage).
- A primary YouTube document for the −14 LUFS figure, or AES TD1008.
