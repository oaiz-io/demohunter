# DemoHunter Video Generation Agent

Research and architecture scaffold for an AI-powered teaching-video generator built on top of DemoHunter.

> Status: design only. This branch documents the proposed `packages/video-gen/` package; it does not implement the generator or add a new CLI command yet.

## What it is

The video generation agent turns a natural-language teaching request into a local, narrated MP4:

```text
"Explain how HTTPS works in 3 minutes"
                 |
                 v
       structured teaching plan (LLM)
                 |
                 v
        static HTML/CSS/JS lesson
                 |
                 v
       deterministic .tour.ts compiler
                 |
                 v
             DemoHunter
     Playwright + cached TTS + ffmpeg
                 |
                 v
 .demohunter/https-works/video.mp4
```

The intended package is local-first. It writes the generated lesson and tour to a local generation workspace, then delegates browser recording, narration timing, captions, and portable output to DemoHunter. A hosted backend is not part of the default path.

## The Primer connection

The idea is inspired by Neal Stephenson's *The Diamond Age*: an illustrated primer that can teach through a rich, responsive presentation rather than a static document. This project is the first, deliberately modest slice of that idea:

- Today: generate a finite lesson and record it as a narrated video.
- Later: let the lesson react to a learner, ask questions, adapt explanations, and continue as an interactive teacher.

The Primer vision is a direction for the product, not a reason to put cloud state, learner accounts, or adaptive runtime behavior into the OSS MVP.

## How it relates to DemoHunter

DemoHunter already provides the hard, deterministic recording engine:

- Playwright-style `.tour.ts` authoring with `defineTour`, chapters, steps, and visible actions.
- Two-pass generation: resolve narration and build a timeline, then replay the same events while recording.
- OpenAI or ElevenLabs TTS with a validated local cache and offline regeneration when audio is available.
- ffmpeg-backed MP4/WebM output, captions, chapter markers, posters, variants, and a checksummed manifest.

The video generator is an authoring layer above that engine. It should not fork or reimplement the browser recorder. It generates content with stable selectors, compiles a tour that uses the existing DSL, and invokes the normal DemoHunter generation flow.

## Proposed usage

The following is the target CLI shape, not an implemented command in this branch:

```sh
export OPENAI_API_KEY=sk-...

demohunter-video generate \
  "Explain how HTTPS works in 3 minutes" \
  --style minimal \
  --output .demohunter

open .demohunter/https-works/video.mp4
```

The corresponding programmatic API is intended to be small:

```ts
import { generateVideo } from "@demohunter/video-gen";

await generateVideo({
  prompt: "Explain how HTTPS works in 3 minutes",
  style: "minimal",
  outputDir: ".demohunter",
});
```

Both examples are proposed interfaces. The first MVP should also expose the intermediate lesson and generated tour so a developer can inspect, edit, or rerun them when the model gets a fact or interaction wrong.

## Output shape

The final video should preserve DemoHunter's existing portable output contract:

```text
.demohunter/
  video-gen/
    https-works/
      content-spec.json
      site/index.html
      site/styles.css
      site/app.js
      https-works.tour.ts
      demohunter.config.ts
  https-works/
    video.mp4
    poster.jpg
    captions.srt
    captions.vtt
    chapters.json
    manifest.json
    audio/
```

The `video-gen/` directory is a proposed inspectable source bundle. The `https-works/` directory is the current DemoHunter artifact directory and remains the integration boundary for later tooling or Cloud ingestion.

## Design principles

1. Generate a typed teaching plan, not unrestricted HTML and TypeScript in one model response.
2. Render HTML, CSS, diagrams, and browser actions deterministically from that plan.
3. Put narration text in the lesson plan and let DemoHunter measure the real TTS duration.
4. Use stable, accessible selectors and deterministic state transitions so Pass 1 and Pass 2 emit the same event sequence.
5. Reuse `OPENAI_API_KEY` from the environment only; do not add credential storage or a hosted dependency.
6. Keep source generation and final media output inspectable, cacheable, and reproducible.

## Documentation

- [Architecture](docs/architecture.md) — pipeline, components, templates, LLM boundary, package layout, and failure handling.
- [Roadmap](docs/roadmap.md) — MVP through the adaptive Primer vision.
- [Research findings](docs/research.md) — observations from the current DemoHunter source and the design trade-offs they imply.

## Roadmap at a glance

- **Phase 1:** one prompt to one self-contained narrated slide lesson and video.
- **Phase 2:** multiple pages, chapters, controlled interactivity, diagrams, and repair loops.
- **Phase 3:** personalization, style presets, languages, and connected lesson series.
- **Phase 4:** the adaptive, interactive AI teacher suggested by the Primer concept.

The detailed milestones and explicit non-goals are in [docs/roadmap.md](docs/roadmap.md).
