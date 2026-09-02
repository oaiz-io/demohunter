# Phase 1 - OSS Core

> Historical design document. It records the initial implementation plan and can contain old names or examples. For current behavior, use the [documentation index](README.md) and `demohunter --help`.

## Summary

Build a simple open-source TypeScript toolkit that lets developers write playwright-like narrated demo scripts in `.tour.ts` files and generate local demo assets into a `.demohunter/` directory in the current working directory.

The OSS core is intentionally narrow:

* it is a thin wrapper on top of Playwright
* users keep writing normal Playwright-style browser automation
* auth, session handling, and app-specific setup stay in user Playwright code
* the OSS tool generates local files only
* there is no built-in player, no plugin system, and no cloud dependency

## Shared decisions

1. All app code is TypeScript.
   Bun, TypeScript 5+, Bun workspace, ESM-first.
2. OSS and Cloud share one generated-output contract.
   OSS writes generated files into `.demohunter/`. Cloud can ingest those files later without needing the repo.
3. Use Playwright directly, not `@playwright/test`, for browser automation.
   `demohunter` is not a test runner.
4. Generation is two-pass.
   Pass 1 synthesizes narration and builds timing data. Pass 2 records video and writes final outputs.
5. Narration caching is mandatory.
   Identical narration should not trigger repeated TTS calls.
6. AI editor support is just a companion skill.
   It teaches Claude/Codex/etc. how to use the library and CLI. It is not product infrastructure.
7. Default TTS choice is `gpt-4o-mini-tts`.
8. The initial minimum Playwright version was `>=1.59`. The current package requirement is `>=1.61`.

## Primary users

* Dev teams making feature demos from local or preview environments
* OSS users who want generated local assets without needing a paid backend
* AI coding users who want Claude/Codex/etc. to help author `.tour.ts` files
* Coding agents running autonomously in remote environments that need to demo their work back to developers
* Teams that want to programmatically generate demos for documentation, release notes, and developer education

## Non-goals

* Hosting, analytics, and team permissions
* Browser-based video editing
* Full cloud generation of private local apps
* General-purpose screen recording outside scripted tours
* Auth/session/bootstrap abstractions on top of Playwright

## Core user stories

1. As a developer, I can run `demohunter init`, get a working sample, and generate a narrated demo from my local app.
2. As a user with an OpenAI key, I can generate narrated demos with OpenAI TTS.
3. As a repeat user, identical narration strings reuse cached audio automatically.
4. As a user without network access, I can still generate if all required narration is already cached.
5. As a Claude/Codex/etc. user, I can install a skill so my coding agent can generate or update `.tour.ts` files for me.

## Deliverables

### Monorepo layout

```text
demohunter/
  packages/
    sdk/                  # defineTour, step, narrate, chapter, helpers
    cli/                  # demohunter CLI
    generator-playwright/ # browser execution + screencast generation
    tts-core/             # provider interface + cache layer
    tts-openai/           # OpenAI speech provider
    manifest/             # generated output manifest schema
    create-demohunter/    # scaffold tool
  skills/
    demohunter/           # optional agent skill docs
  examples/
    nextjs-demo/
    vite-demo/
```

### `@demohunter/sdk`

Exports the authoring DSL.

```ts
export default defineTour({
  id: "billing-overview",
  title: "New billing flow",
  async setup(ctx) {},
  async run({ page, chapter, step, narrate }) {
    await chapter("Billing");

    await step("Open billing", async () => {
      await page.goto("/billing");
      await narrate("This is the new billing dashboard. Everything is now in one place.");
    });

    await step("Create invoice", async () => {
      await page.getByRole("button", { name: "Create invoice" }).click();
      await narrate("Creating an invoice now takes one step instead of three.");
    });
  },
});
```

Required exports:

* `defineTour`
* `chapter(title, opts?)`
* `step(title, fn)`
* `narrate(text, opts?)`
* `waitForStable()`
* `highlight(locator, opts?)`
* `snapshot(name?)`
* `assertVisible(locator)`
* `setup` / `teardown`

### `@demohunter/cli`

Commands:

```bash
demohunter init
demohunter generate demos/billing.tour.ts
demohunter cache list
demohunter cache prune
demohunter cache clear
```

Command behavior:

* `demohunter init`
  Create a starter setup in the current repo with a sample `demohunter.config.ts`, example `.tour.ts` file, and the minimum scaffolding needed to generate the first demo.
* `demohunter generate demos/billing.tour.ts`
  Run the full generation flow for a tour file. This resolves narration, records the video pass, generates subtitles, and writes the final output into `.demohunter/<tour-id>/`.
* `demohunter cache list`
  Show the narration cache entries currently stored on disk so users can inspect what audio has already been synthesized.
* `demohunter cache prune`
  Remove cache entries that are no longer needed according to the tool's pruning rules, so the local cache does not grow forever.
* `demohunter cache clear`
  Delete the local narration cache so the next generate run starts from a clean slate.

### `@demohunter/generator-playwright`

Responsibilities:

* launch browser/context
* run pass 1 and pass 2
* use `page.screencast.start()` / `stop()`
* generate local demo files into `.demohunter/`
* optionally enable `showActions()` and `showChapter()` overlays during generation

### `@demohunter/tts-core`

Responsibilities:

* common provider interface
* cache key generation
* cache read/write/integrity checks
* duration measurement
* subtitle segment construction

### `@demohunter/tts-openai`

Responsibilities:

* call OpenAI `audio/speech`
* support `gpt-4o-mini-tts`, `tts-1`, `tts-1-hd`
* accept `voice`, `instructions`, `format`
* read `OPENAI_API_KEY` from env only

### `@demohunter/manifest`

Responsibilities:

* define generated-output manifest schema with Zod
* describe files written into `.demohunter/`
* compute checksums
* version the generated-output format

### `skills/demohunter`

Optional skill docs containing:

* a `SKILL.md` for create/update demo script
* CLI usage guidance
* a template `.tour.ts`
* examples for common workflows

## Functional requirements

### Generation

* Must generate from a local dev server, preview URL, or arbitrary base URL.
* Must output `mp4` by default, optionally `webm`.
* Must generate subtitles from narration timeline.
* Must pause after standalone narration for `durationMs + holdPaddingMs`.
* Must support timed action choreography during narration via `narrateWhile(text, fn, options?)`.
* Must expose `holdPaddingMs` in config, default around `300`.
* Must write generated files into a `.demohunter/` directory relative to the current working directory.
* Must not require or provide a built-in playback UI in OSS.
* Must not provide auth/session/bootstrap abstractions; users should do that directly with Playwright.

### Narration

* `narrate()` is declarative for static narration beats. Script authors do not manually calculate audio duration.
* `narrateWhile()` starts narration, runs wrapped Playwright actions during that narration, and exposes `sleep(ms)` for timed choreography.
* Narration duration comes from the real audio file, not heuristic text length.
* Support provider-specific voice instructions.
* Support local cache reuse with zero API calls on cache hit.

### Cache

Mandatory behavior:

* cache is local by default
* cache miss triggers TTS
* cache hit returns audio path + metadata instantly
* corrupt cache entry regenerates
* identical narration text with different voice/model/instructions must not collide

Recommended cache key:

```ts
sha256(JSON.stringify({
  provider: "openai",
  model,
  voice,
  instructions,
  format,
  sampleRate,
  text: text.normalize("NFC"),
  version: 1
}))
```

### Offline behavior

* `demohunter generate` must succeed without `OPENAI_API_KEY` when every narration segment already exists in cache.
* `demohunter generate` must fail clearly when uncached narration is required and `OPENAI_API_KEY` is missing.

### Generated output

Every generate run creates:

```text
.demohunter/billing-overview/
  video.mp4
  video.webm            # optional
  poster.jpg
  captions.srt
  captions.vtt
  manifest.json
  chapters.json
  audio/
    <hash>.mp3
```

Subtitles are part of the OSS core output.

## Config spec

`demohunter.config.ts`

```ts
export default defineConfig({
  baseURL: "http://localhost:3000",
  outputDir: ".demohunter",
  cacheDir: ".demohunter/cache",
  browser: "chromium",
  viewport: { width: 1440, height: 900 },
  holdPaddingMs: 300,
  record: {
    showActions: true,
    showChapters: true
  },
  tts: {
    provider: "openai",
    model: "gpt-4o-mini-tts",
    voice: "marin",
    format: "mp3",
    instructions: "Speak clearly, calm, concise, product-demo style."
  }
});
```

## Technical design

### Why two-pass generation

Do not generate TTS in the middle of the recorded pass. That would add dead silent time caused by API latency, not narration timing.

Pass 1 - plan/synthesis pass:

* launch fresh browser context
* run the tour
* each `narrate()` or `narrateWhile()` ensures audio exists in cache
* measure actual duration
* build timeline manifest
* no video output

Pass 2 - generation pass:

* launch a second fresh browser context
* start screencast
* replay the same tour
* after each `narrate()`, wait the exact cached duration
* for `narrateWhile()`, run wrapped actions during the narration window, then wait only the remaining cached duration plus hold padding
* stop screencast
* write video + narration audio + subtitles + manifest into `.demohunter/`

### Muxing

Use ffmpeg via Bun-compatible wrappers or static binaries.

### Timing model

Timeline segments:

* action
* narration
* chapter
* explicit pause
* transition overlay

Narration segment timing:

* `startMs`
* `endMs`
* `durationMs`
* `audioFile`
* `text`

Subtitles are generated from narration segments only.

## Acceptance criteria

The OSS core is done when all of the following are true:

* `demohunter init` creates a working sample project and sample tour.
* `demohunter generate demos/sample.tour.ts` produces generated local demo files under `.demohunter/`.
* Identical narration segments do not re-hit OpenAI on rerun.
* Removing `OPENAI_API_KEY` still allows regeneration when all narration is cached.
* The generated output directory contains video, chapters, transcript files, and manifest metadata.
* The companion skill can generate a valid `.tour.ts` file from a prompt inside Claude/Codex/etc.

## Roadmap

### Phase A0 - repository + scaffolding

Build:

* Bun workspace
* base packages
* config loader
* sample app + sample tour
* `demohunter init`

Exit:

* new user can scaffold and run a no-audio sample generation

### Phase A1 - Playwright generator

Build:

* `defineTour` runtime
* two-pass execution engine
* screencast recording
* chapter overlays
* action annotations toggle
* `.demohunter/` output writing

Exit:

* silent video generation works from scripted steps
* chapter overlay appears in output

### Phase A2 - OpenAI TTS + cache

Build:

* OpenAI provider
* local narration cache
* duration measurement
* subtitle generation
* offline regeneration support

Exit:

* same narration does not trigger repeat API calls
* missing key only fails on uncached narration

### Phase A3 - output manifest + local output layout

Build:

* manifest schema
* `.demohunter/` output layout
* poster/thumbnail generation
* checksums

Exit:

* generated output format is versioned and portable

### Phase A4 - AI companion skill

Build:

* `SKILL.md`
* script template
* install docs
* CLI usage examples

Exit:

* Claude/Codex/etc. can create/update a tour script in-repo
* the skill is installable as plain markdown instructions

### Phase A5 - polish + OSS launch

Build:

* docs
* examples for Next/Vite
* cache pruning
* better errors
* CI
* MIT license

Exit:

* public repo is usable without maintainer hand-holding

## References

* [OpenAI text-to-speech docs](https://developers.openai.com/api/docs/guides/text-to-speech)
* [Playwright screencast docs](https://playwright.dev/docs/api/class-screencast)
