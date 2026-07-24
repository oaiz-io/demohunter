# Phase 1 Implementation Plan — Single Topic to Single Video

## Objective

Implement the Phase 1 MVP described in the existing design documents: one natural-language teaching prompt produces one inspectable, self-contained slide lesson and one narrated DemoHunter video through a local-only pipeline.

This plan is subordinate to, and should be read with:

- [Concept overview and design principles](../../README.md)
- [Architecture and proposed package layout](../../docs/architecture.md)
- [Phase 1 deliverables, success criteria, and non-goals](../../docs/roadmap.md#phase-1--mvp-single-topic--single-video)
- [Research findings and locked design decisions](../../docs/research.md)

Do not expand this phase into the rich-content, personalization, or adaptive-teacher work assigned to later roadmap phases.

## Outcome and Acceptance Contract

Phase 1 is complete when:

- [ ] `demohunter-video generate "What is a binary tree?" --style minimal --output .demohunter` completes without manual intervention when prerequisites are present.
- [ ] The final video and portable DemoHunter assets exist under `.demohunter/binary-tree/`, including `video.mp4`, captions, chapter metadata, poster, audio, and `manifest.json`.
- [ ] The generated source bundle remains inspectable by default under `.demohunter/video-gen/binary-tree/`, including `content-spec.json`, `site/`, `binary-tree.tour.ts`, and `demohunter.config.ts`.
- [ ] `generateVideo()` provides the same behavior and artifacts through the `@demohunter/video-gen` package.
- [ ] The generated site has no network-loaded assets, random values, timestamps, or unstable selectors.
- [ ] The generated tour produces the same ordered actions and narration calls in DemoHunter Pass 1 and Pass 2.
- [ ] Existing DemoHunter package tests, type checking, and build remain green.

## Scope Boundaries

In scope:

- One prompt, one content spec, one single-page slide deck, one tour, and one video.
- Paragraphs, bullet lists, and code blocks as static slide content.
- `fade` and `slide-left` transitions.
- Three built-in CSS presets: `minimal`, `terminal`, and `notebook`.
- Basic chapter markers derived from slides so the existing DemoHunter output contains useful `chapters.json`; this is not the multi-page or lesson-series chapter model deferred by the roadmap.
- OpenAI only for lesson-plan generation, with DemoHunter retaining ownership of narration/TTS generation and caching.

Explicitly out of scope:

- Multi-page lessons, reveal controls, tabs, accordions, quizzes, or other learner interactions.
- Mermaid, generated diagrams, syntax-highlighting libraries, CDN assets, background music, custom themes, or theme installation.
- Audience targeting, a separate duration flag, language selection, course series, repair loops, or model-generated HTML/CSS/TypeScript.
- Cloud state, hosted generation, credential storage, OAuth, accounts, or any backend dependency.

## Current Repository Integration Facts

The executor must preserve these current APIs and conventions rather than inventing parallel ones:

- The workspace already includes every `packages/*` directory through the root Bun workspace declaration.
- Internal TypeScript packages use ESM, `@demohunter/*` names, `workspace:*` dependencies, a package-local `tsconfig.json` extending `../../tsconfig.base.json`, and a Bun source export plus compiled default export.
- The current Playwright compatibility floor in package manifests is `>=1.61`; use the checkout’s current value rather than the older aspirational constraint.
- `@demohunter/sdk` exports `defineTour`, `defineConfig`, configuration defaults, and the authored/runtime types.
- `@demohunter/generator-playwright` exports `generateTour()`, its progress events, and `GenerateTourResult`.
- `generateTour()` accepts an already-resolved config and a loaded `DemoHunterTour`; the package must call this public API directly. Do not import private CLI helpers such as `loadConfig()` or `loadAuthoredModule()`, and do not shell out to the `demohunter` binary.
- `generateTour()` returns the final video/output paths and already owns browser execution, two-pass narration timing, cache recovery, media composition, captions, chapters, poster generation, and manifest writing. Do not duplicate those responsibilities.

## Public Contracts to Lock Before Implementation

### Content spec

Export `CONTENT_SPEC_VERSION`, `ContentSpecSchema`, `ContentSpec`, `SlideSpec`, and `BodyElement` from `src/content/schema.ts`, then re-export the public schema and types from the package root.

The Zod contract must be strict:

- `version`: literal `1`.
- `title`: trimmed, non-empty, bounded display text.
- `duration`: a normalized requested-duration string such as `90s` or `3m`; reject arbitrary prose. Phase 1 infers this from the prompt or uses the system-prompt default rather than adding a CLI duration flag.
- `slides`: non-empty and capped at 20 as a defensive schema limit. The lesson-generation prompt requests 3–8 slides.
- Each slide:
  - `id`: lowercase slug matching the same filesystem-safe shape already accepted for DemoHunter tour IDs.
  - `heading`: trimmed, non-empty, bounded display text.
  - `body`: non-empty array of a strict discriminated union.
  - `narration`: trimmed, non-empty spoken text with a defensive length bound.
  - `transition`: enum `fade | slide-left`.
- Body union:
  - `paragraph`: `{ type, text }`.
  - `bullet_list`: `{ type, items }`, with at least one non-empty item and a reasonable item cap.
  - `code_block`: `{ type, language, code }`, with non-empty language and code fields.
- Application validation additionally rejects duplicate slide IDs and any unsafe or ambiguous selector input. Keep these semantic checks in `src/util/validate.ts` if they cannot be represented faithfully in the JSON Schema supplied to OpenAI Structured Outputs.

All generation, rendering, compilation, and bridge entry points accept a parsed `ContentSpec`, never unvalidated `unknown`.

### Programmatic API

Lock the following public names and meanings:

- `StylePresetName`: `minimal | terminal | notebook`.
- `GenerateVideoOptions`:
  - `prompt: string` — required and non-empty after trimming.
  - `style?: StylePresetName` — defaults to `minimal`.
  - `outputDir?: string` — resolved against the caller’s current directory; defaults to `.demohunter`.
  - `model?: string` — optional content-generation model override.
  - `cleanup?: boolean` — remove the inspectable source workspace after success; default `false`.
  - `signal?: AbortSignal` — cancellation for preflight, content generation, and stage boundaries.
  - `onProgress?: (event: VideoGenerationProgressEvent) => void` — typed progress callback.
- `VideoGenerationProgressEvent`: a stable phase enum plus a human-readable message; phases are `preflight`, `content`, `render`, `compile`, `serve`, `record`, `cleanup`, and `complete`. Forward DemoHunter’s more granular progress as nested detail during `record`.
- `GenerateVideoResult`:
  - `id`, `title`, and `style`.
  - `workspaceDir`, `contentSpecPath`, `siteDir`, `tourPath`, and `configPath`.
  - `outputDir`, `videoPath`, `captionsSrtPath`, `captionsVttPath`, and `chaptersPath`.
  - If `cleanup` is true, retain the source path values for reporting but also expose `workspacePreserved: false`; otherwise it is `true`.
- `generateVideo(options): Promise<GenerateVideoResult>`.

Use a configurable internal `DEFAULT_CONTENT_MODEL` and the `model` option. Do not make the public contract depend on the undocumented “GPT-4.6” label in the concept draft. Select a currently documented Structured Outputs-capable default when implementing and cover the override in tests.

### Internal stage contracts

Use explicit, typed boundaries so each stage can be tested without running the next:

- `generateContentSpec(input) -> Promise<ContentSpec>`.
- `renderLesson({ spec, style }) -> RenderedSite`, containing deterministic `html`, `css`, and `javascript` strings.
- `compileTour({ spec, tourId }) -> CompiledTour`, containing both valid module source and the in-memory `DemoHunterTour` generated from the same normalized instruction list.
- `createGenerationWorkspace(input) -> GenerationWorkspace`.
- `startStaticServer(siteDir) -> Promise<{ baseURL, close }>`.
- `runDemoHunterBridge(input) -> Promise<GenerateTourResult>`.
- `runPreflight(input) -> Promise<PreflightResult>`.

The emitted module and in-memory tour must share one compiler representation. The bridge passes the in-memory tour to `generateTour()` and writes the module source for inspection; it must not maintain two independently authored action sequences.

## Execution Order and Estimated Effort

Estimated implementation effort: **18–24 engineer-days (approximately 4–6 calendar weeks including review and hardening)**, consistent with the roadmap estimate.

| Wave | Work | Estimate | Depends on |
|---|---|---:|---|
| 1 | Package, types, schema, filesystem primitives | 2–3 days | None |
| 2A | OpenAI content generation | 2–3 days | Wave 1 |
| 2B | Deterministic template engine and presets | 3–4 days | Wave 1 |
| 2C | Deterministic tour compiler | 2–3 days | Wave 1 |
| 3 | Workspace, preflight, server, DemoHunter bridge | 3–4 days | Waves 2B–2C |
| 4 | Orchestrator, programmatic API, CLI, cancellation/cleanup | 3–4 days | Waves 2A–3 |
| 5 | Integration/E2E coverage, documentation, release checks | 3–4 days | Wave 4 |

Waves 2A, 2B, and 2C may be implemented in parallel after the schema contract is committed. All other work should follow the dependency order above.

## Wave 1 — Package Setup and Content Contract

### 1. Package setup

- [ ] Create `packages/video-gen/package.json` as `@demohunter/video-gen`, ESM-first, initially private/version `0.0.0` like the repository’s internal packages, with:
  - Bun source and compiled ESM exports for the package root.
  - `demohunter-video` mapped to the compiled CLI entry.
  - `build`, `copy:assets`, `typecheck`, and package-scoped `test` scripts.
  - A build step that copies runtime template/prompt assets to `dist` without transforming their contents.
  - Runtime workspace dependencies on `@demohunter/generator-playwright` and `@demohunter/sdk`.
  - Runtime dependencies on the official `openai` SDK and `zod`; use the repository’s existing Zod major/range.
  - `playwright >=1.61` as both a peer and development dependency, matching the SDK/CLI convention for a directly imported host runtime; Node types and TypeScript remain development dependencies.
- [ ] Create `packages/video-gen/tsconfig.json` extending `../../tsconfig.base.json`, with composite build output under `dist`, `rootDir` set to `src`, declarations/source maps enabled, and test files excluded from emit.
- [ ] Add `packages/video-gen` to the root TypeScript project references in `tsconfig.json`; the root workspace glob already covers it, so do not add a redundant workspace entry.
- [ ] Update the root `package.json` build sequence to run the video-gen asset-copy step after the composite TypeScript build, so `bun run build` produces a runnable `dist` package rather than JavaScript that references missing templates.
- [ ] Run `bun install` only after the manifest is final, and commit the resulting `bun.lock` update. Do not introduce a second lockfile.
- [ ] Add an asset-copy build script that copies `system.txt`, base HTML/JS, and the three CSS preset files into matching `dist` paths and fails if a declared asset is missing.
- [ ] Add a package README documenting the public API, CLI, local-only credential rule, output layout, and the distinction between generated source and final portable DemoHunter output.

Estimated effort: **1 day**.

### 2. Content spec schema

- [ ] Implement the strict Zod structures defined in “Public Contracts to Lock Before Implementation.”
- [ ] Export TypeScript types using Zod inference so schema and compile-time contracts cannot drift.
- [ ] Add application-level validation in `src/util/validate.ts` for unique slide IDs, safe slug/selector construction, supported schema version, body-size limits, and actionable path-based validation messages.
- [ ] Add a stable serializer that writes two-space-indented JSON with a trailing newline and never mutates the parsed object.
- [ ] Unit-test each body variant, strict unknown-key rejection, malformed duration, empty narration/body, duplicate/unsafe IDs, slide count bounds, and a valid mixed-content lesson.

Estimated effort: **1–2 days**.

### 3. Shared deterministic utilities

- [ ] Implement one slug utility used for tour IDs, workspace names, and selectors; normalize Unicode, lowercase, collapse separators, enforce the DemoHunter slug pattern, and provide a deterministic fallback when a title cannot yield a slug.
- [ ] Implement filesystem helpers for atomic file writes, explicit UTF-8 reads, directory creation, existence checks, and safe removal restricted to a resolved generation workspace.
- [ ] Prohibit cleanup helpers from accepting the filesystem root, current working directory, output root, unresolved relative paths, or a path outside the expected `outputDir/video-gen/` boundary.
- [ ] Unit-test slug stability and cleanup path containment, including traversal attempts and empty/non-ASCII titles.

Estimated effort: **0.5 day**.

## Wave 2A — Content Generator

### 4. OpenAI client boundary and prompt

- [ ] Implement content generation with the official OpenAI JavaScript SDK’s Responses API and Structured Outputs Zod helper.
- [ ] Read `OPENAI_API_KEY` from the environment when constructing the default client. Do not accept, persist, log, or write an API key anywhere else.
- [ ] Allow an injected client/fetch/sleep/random dependency internally for deterministic tests without exposing credential storage in the public API.
- [ ] Write the system prompt as a versioned text asset. It must:
  - Define the model as a lesson designer, not an HTML/CSS/tour generator.
  - Require 3–8 concise slides, natural spoken narration, concrete examples, and code only where useful.
  - Constrain output to Phase 1 body and transition types.
  - Explain how to infer the duration from the user prompt and choose the Phase 1 default when absent.
  - Prohibit external-resource instructions, interactive controls, diagrams, unsupported claims of live execution, and later-phase features.
  - Keep narration aligned with exactly what is visible on its slide.
- [ ] Pass the user prompt as user input without interpolating it into the system instructions.
- [ ] Use the configured model/default model internally, a finite request timeout, and no implicit second content-generation call after a valid response.

### 5. Response validation, refusal handling, and retry policy

- [ ] Treat the OpenAI Structured Outputs parse as the first structural gate, then run the returned object through application-side `ContentSpecSchema.safeParse()` and semantic validation before writing it.
- [ ] Detect explicit model refusal separately and return a non-retryable content-refusal error without trying to parse refusal text as JSON.
- [ ] Treat authentication/authorization, invalid request, unsupported model/schema, and content-policy failures as non-retryable.
- [ ] Retry transient network failures, timeouts, HTTP 408/409/429, and 5xx responses with bounded exponential backoff plus jitter. Cap at three total attempts, cap the delay, honor a bounded `Retry-After` when available, and abort immediately when `signal` is cancelled.
- [ ] Permit one corrective retry for a structurally parsed response that fails application validation; include only concise, non-sensitive validation paths/messages in the correction input.
- [ ] When retry budget is exhausted, throw a typed error that retains the root cause and attempt count but does not include secrets or the full provider response.
- [ ] Write `content-spec.json` only after all validation passes; never leave a partially written spec.
- [ ] Unit-test success, configurable model selection, missing key, refusal, malformed/absent parsed output, semantic schema mismatch and corrective retry, transient retries/backoff bounds, non-retryable errors, timeout, and cancellation.

Estimated effort for Wave 2A: **2–3 days**.

## Wave 2B — Deterministic Template Engine

### 6. Base templates and rendering rules

- [ ] Implement a small explicit template renderer; do not add Handlebars, a client framework, or model-generated markup.
- [ ] Render every slide as a semantic `<section>` with:
  - A unique `id="slide-<slide-id>"`.
  - Stable `data-slide-id`, `data-slide-index`, and `data-transition` attributes.
  - An accessible heading and body markup.
  - Deterministic `active`/hidden state and `aria-hidden`.
- [ ] Render paragraphs, lists, and code blocks through separate exhaustive body-element branches; fail on an unrecognized variant.
- [ ] HTML-escape all model-controlled text and attribute values. Code contents must remain literal text inside `<code>` and must never become executable HTML.
- [ ] Include stable previous/next navigation controls with `data-nav` selectors and accessible labels. Hide/disable impossible navigation at the ends without removing controls between passes.
- [ ] Keep generated HTML self-contained: no external fonts, scripts, styles, images, imports, analytics, or network requests.
- [ ] Produce exactly `index.html`, `styles.css`, and `app.js` for the site.

### 7. Deterministic transition runtime

- [ ] Implement synchronous slide-state changes in `app.js`: a click calculates the next fixed index, updates attributes/classes, and exposes no random/time-dependent branching.
- [ ] Support only `fade` and `slide-left`, with fixed CSS durations and no variable `setTimeout`, `Date.now`, `Math.random`, animation libraries, or URL-dependent state.
- [ ] Keep the first slide active on every fresh page load so DemoHunter Pass 1 and Pass 2 begin in the same state.
- [ ] Ensure repeated or out-of-range navigation is a deterministic no-op and cannot create two active slides.
- [ ] Provide a stable active-state selector that the generated tour can wait for after navigation.

### 8. Style presets

- [ ] Implement `minimal` as one CSS file with a clean white system-font presentation.
- [ ] Implement `terminal` as one CSS file with a dark, high-contrast monospace presentation.
- [ ] Implement `notebook` as one CSS file with a warm paper-like palette and system serif presentation.
- [ ] Keep markup and JavaScript identical across presets; each preset only supplies CSS and the same required custom-property contract.
- [ ] Use system font stacks and local CSS only. Do not add font files or CDN references.
- [ ] Ensure all presets fit the configured DemoHunter viewport without scrolling for schema-valid content bounds, and provide overflow behavior that fails visibly in tests rather than silently clipping narration-relevant content.
- [ ] Unit-test exact escaping, stable selectors/order, each body variant, initial state, both transitions, navigation boundaries, deterministic repeat rendering, and all preset names.

Estimated effort for Wave 2B: **3–4 days**.

## Wave 2C — Tour Compiler

### 9. Selector and instruction compilation

- [ ] Derive selectors only from schema-validated slide IDs and fixed `data-*` attributes; never emit `nth-child`, text-only, generated class, or positional selectors.
- [ ] Compile the spec into a normalized instruction list before producing either executable behavior or module text. Each instruction records the slide ID, heading, selector, transition action, and exact narration text.
- [ ] For each slide, emit one deterministic step that:
  - Navigates with the fixed next control when it is not the first slide.
  - Waits/asserts that the target slide and heading are visible and active.
  - Emits a chapter marker using the slide heading and stable slide ID.
  - Maps narration exactly once to the DemoHunter narration runtime.
- [ ] Use `narrate()` for ordinary static slides. Where the architecture requires a code block to remain explicitly asserted during speech, use one `narrateWhile()` with a fixed visibility assertion and no variable-time behavior.
- [ ] Never estimate speech duration, insert narration-length sleeps, or generate TTS options in this compiler; DemoHunter owns actual audio duration and cache behavior.
- [ ] Escape all generated TypeScript string literals safely and deterministically. Model text must never be interpolated as source code.

### 10. Valid module output and parity

- [ ] Generate a default-exported `defineTour()` module that imports only public `@demohunter/sdk` APIs.
- [ ] Set tour `id` to the validated lesson slug and `title` to the spec title.
- [ ] Generate the in-memory `DemoHunterTour` from the same instruction list used by the source template.
- [ ] Add a parity test that imports/transpiles the generated module in a temporary fixture, records its runtime events with a fake runtime, and compares them to the in-memory tour’s events.
- [ ] Add golden tests for a multi-slide spec containing every body type, string escaping, transition mapping, chapter IDs, narration order, and selector stability.
- [ ] Verify the generated module type-checks against the current SDK and does not import package-private paths.

Estimated effort for Wave 2C: **2–3 days**.

## Wave 3 — Workspace, Preflight, Server, and DemoHunter Bridge

### 11. Generation workspace and output policy

- [ ] Resolve `outputDir` to an absolute path once and derive:
  - Source workspace: `<outputDir>/video-gen/<tour-id>/`.
  - Site directory: `<workspace>/site/`.
  - Final DemoHunter artifact: `<outputDir>/<tour-id>/`.
  - Narration cache: `<outputDir>/cache/`, preserving DemoHunter’s existing cache behavior.
- [ ] Create source files in a contained staging directory, then publish the complete inspectable workspace atomically. Never expose half-written HTML/tour/config files as a valid workspace.
- [ ] Before any paid API call, detect an existing source or final target and fail with a clear non-destructive collision error. Phase 1 has no `--force`; do not silently merge, overwrite, or delete a previous generation.
- [ ] Preserve a published source workspace on generation failure for diagnosis.
- [ ] Preserve the source workspace after success by default. When `cleanup` is true, remove it only after DemoHunter reports a successful final output and path containment is revalidated.
- [ ] On cancellation/SIGINT, remove only unpublished staging and ephemeral server resources; preserve any already-published inspectable workspace and DemoHunter debug output.

### 12. Preflight checks

- [ ] Run all cheap local preflight checks before calling OpenAI:
  - Prompt/style/options validation.
  - `OPENAI_API_KEY` is present because Phase 1 always needs content generation, even if narration audio is cached.
  - `ffmpeg -version` and `ffprobe -version` succeed.
  - The configured Playwright Chromium executable can launch and close.
  - The output root is creatable/writable without deleting user files.
  - Target workspace/final-output collision checks pass.
- [ ] Return structured check results internally and collapse them into one actionable preflight error listing every failure.
- [ ] Reuse the intent and messages of the existing DemoHunter doctor checks where practical, but do not import its private CLI module.
- [ ] Unit-test missing commands, browser-launch failure, missing key, unwritable output, collisions, cancellation, and the all-pass case with injected process/browser dependencies.

### 13. Local static server

- [ ] Serve only the generated site directory over `http://127.0.0.1`.
- [ ] Ask the operating system for an available port (`port: 0`) to avoid race-prone fixed-port probing, then return the actual base URL.
- [ ] Serve `/` and `/index.html`, `styles.css`, and `app.js` with correct content types; return deterministic 404/405 responses for unsupported paths/methods.
- [ ] Resolve and contain request paths to prevent traversal, encoded traversal, symlink escape, or reading outside the generated site.
- [ ] Expose an idempotent asynchronous `close()` and ensure the orchestrator calls it in `finally` on success, failure, and cancellation.
- [ ] Test successful serving, MIME types, unknown paths, traversal attempts, port allocation, and repeated close.

### 14. Config generation and programmatic invocation

- [ ] Generate an inspectable `demohunter.config.ts` using public SDK configuration concepts, with:
  - `baseURL` set to the local server URL used for that run.
  - `outputDir` and `cacheDir` set to the resolved output locations.
  - Chromium/default viewport and the repository’s current default OpenAI narration settings unless explicitly required otherwise.
  - Chapter events enabled for output metadata and `record.showChapters: false` so the existing 900 ms chapter overlay does not cover the teaching slide at every transition.
- [ ] Build the equivalent `ResolvedDemoHunterConfig` in memory from SDK defaults and the same normalized config data; add a test that emitted and in-memory values do not drift.
- [ ] Call exported `generateTour({ loadedConfig, tourFile, onProgress })` directly.
- [ ] Pass the written tour path as `tourFile.path` and the compiler’s in-memory tour as `tourFile.tour`.
- [ ] Forward generator progress to the video-generation progress callback without parsing console output.
- [ ] Verify the returned output directory is the expected contained `<outputDir>/<tour-id>` and the returned video path exists before reporting success.
- [ ] Classify DemoHunter failures by the existing progress phase where possible (`collecting-timeline`, `resolving-narration`, `recording-replay`, `muxing-video`, or artifact writing) and retain the original cause.
- [ ] Unit-test bridge config, progress forwarding, returned paths, server teardown, and failures with an injected `generateTour`.

Estimated effort for Wave 3: **3–4 days**.

## Wave 4 — Orchestrator, API, and CLI

### 15. Pipeline orchestrator

- [ ] Implement the only end-to-end order as: validate options → preflight → generate/validate content → derive ID/check collisions → stage workspace → render site → compile/write tour and config → publish workspace → start server → invoke DemoHunter → close server → optional successful cleanup → return result.
- [ ] Adjust the preflight into two passes because the final title-derived ID is unavailable before content generation: run machine/key/output-root checks before the API call and ID/collision checks immediately after schema validation.
- [ ] Emit progress once at every stage boundary and forward record sub-events without exposing provider payloads.
- [ ] Check `AbortSignal` before and after every stage and pass it to the OpenAI request/backoff. While the current `generateTour()` API is not signal-aware, treat cancellation during recording as a requested cancellation, wait for the generator to unwind safely, then return an interrupted error and run cleanup instead of reporting success.
- [ ] Use `try/finally` to close the server and remove unpublished staging under every failure path.
- [ ] Define typed error codes for `INVALID_INPUT`, `PREFLIGHT_FAILED`, `CONTENT_REFUSED`, `CONTENT_FAILED`, `SPEC_INVALID`, `WORKSPACE_COLLISION`, `RENDER_FAILED`, `COMPILE_FAILED`, `SERVER_FAILED`, `DEMOHUNTER_FAILED`, and `INTERRUPTED`.
- [ ] Preserve causal errors for programmatic callers while providing safe, concise messages for the CLI.
- [ ] Add an integration test with a fake OpenAI response and fake `generateTour()` that runs the complete pipeline and inspects every generated source file and returned path.

### 16. Programmatic API

- [ ] Implement `generateVideo()` as a thin validated entry to the orchestrator; do not duplicate orchestration in the CLI.
- [ ] Re-export only the intended public API, content schema/types, style type, result/options/progress types, and stable error type from `src/index.ts`.
- [ ] Keep test seams/dependency injection internal and prevent imports of internal package paths through the package `exports` map.
- [ ] Add API-level type and behavior tests for defaults, relative output resolution, style/model overrides, progress ordering, cleanup result semantics, errors, and cancellation.

### 17. CLI

- [ ] Implement the exact command family `demohunter-video generate "<prompt>"`.
- [ ] Parse `--style <minimal|terminal|notebook>`, `--output <dir>`, and `--cleanup`, supporting the repository’s usual `--flag value` style and rejecting duplicates, missing values, unknown flags, extra positional prompts, and an empty prompt.
- [ ] Default style to `minimal` and output to `.demohunter`.
- [ ] Add `--help`/`-h` and `--version`/`-v`; ensure help examples match the package API and actual output layout.
- [ ] Print concise progress for content generation, rendering, compilation, server start, DemoHunter stages, and final path. Do not print request bodies, narration text, API errors containing secrets, or the key.
- [ ] On success, print the video path and either the preserved workspace path or the fact that `--cleanup` removed it.
- [ ] On error, set a non-zero exit code and print the typed actionable message. Include install guidance for ffmpeg/ffprobe, Playwright browser installation guidance, key setup guidance, collision paths, and the preserved workspace path when available.
- [ ] Register one SIGINT handler backed by an `AbortController`; a first SIGINT requests orderly cancellation/cleanup and a second may terminate immediately with the standard interrupt exit status.
- [ ] Remove signal handlers after completion so programmatic imports and repeated test invocations do not leak listeners.
- [ ] Unit-test command parsing, help/version, progress formatting, exit behavior, secret redaction, cleanup flag mapping, and SIGINT handling with injected dependencies.

Estimated effort for Wave 4: **3–4 days**.

## Wave 5 — Testing, Verification, and Documentation

### 18. Unit test strategy

- [ ] Keep tests beside the modules, matching existing repository convention.
- [ ] Mock OpenAI, time, jitter, process execution, Playwright launch, filesystem roots, HTTP serving, and `generateTour()` at module boundaries; unit tests must not use the network or paid APIs.
- [ ] Use fixed content fixtures and compare deterministic output byte-for-byte where useful.
- [ ] Cover schema validation, prompt request shape, retry/refusal behavior, escaping, template determinism, transitions, selector construction, generated-tour parity, path containment, collision behavior, preflight, server security, progress ordering, cleanup, and CLI parsing.

### 19. Integration test strategy

- [ ] Add a package integration test that runs the full pipeline with a structured fake OpenAI response and fake DemoHunter result in a temporary directory.
- [ ] Assert the exact source/output directory contract, valid JSON round trip, no external asset URLs, stable rendered bytes across two runs, valid generated module, config/runtime parity, and server closure.
- [ ] Add a compiler-to-DemoHunter smoke integration using `smokeGenerate()` or the least expensive current generator path, with content/TTS mocked so it verifies actual Playwright selectors and tour flow without producing paid narration.
- [ ] Ensure all temporary test directories and servers are removed in `finally`.

### 20. Optional real E2E strategy

- [ ] Add an opt-in E2E test guarded by `DEMOHUNTER_VIDEO_E2E=1`; skip by default in unit CI.
- [ ] Require an explicit API key, ffmpeg/ffprobe, and installed Chromium before it runs.
- [ ] Generate a short fixed topic, then verify `video.mp4`, captions, chapters, poster, audio, and manifest paths plus manifest validity/checksums using existing DemoHunter behavior.
- [ ] Use an isolated temporary output root and remove it after success; preserve it and print the path on failure.

### 21. Required verification commands

- [ ] `bun install` completes with only the repository lockfile updated.
- [ ] `bun run --cwd packages/video-gen typecheck` passes.
- [ ] `bun test packages/video-gen` passes without network access.
- [ ] `bun run build` builds the new project reference and existing CLI.
- [ ] `bun run typecheck` passes across the workspace.
- [ ] `bun test` passes across the workspace.
- [ ] `bun run verify` passes.
- [ ] The opt-in E2E passes in a prepared local environment before Phase 1 release, but is not a default CI requirement until secrets and media prerequisites are provisioned.

Estimated effort for Wave 5: **3–4 days**.

## Failure, Cleanup, and Recovery Matrix

| Failure point | Retry | Files retained | User/programmatic action |
|---|---|---|---|
| Preflight | No | No new workspace | Fix all reported local prerequisites |
| OpenAI transient/rate error | Up to bounded three-attempt policy | No published workspace | Automatic backoff, then actionable failure |
| OpenAI refusal/auth/policy | No | No published workspace | Report refusal or credential/request issue |
| Invalid structured content | One corrective retry | No published workspace | Report validation paths after retry |
| Render/compile | No repair loop | Published workspace only if staging completed | Preserve inputs/staging diagnostics safely |
| Port/server startup | No content regeneration | Published source workspace | Report server failure; close all handles |
| DemoHunter Pass 1/2/media | No repair loop | Source workspace and DemoHunter debug/partial output | Report failing record phase and retained paths |
| SIGINT | No retry | Published inspectable/debug files; remove unpublished temp files | Return/exit as interrupted |
| Success, default | N/A | Source workspace and final artifact | Return both path groups |
| Success, `--cleanup` | N/A | Final artifact only | Return final paths and `workspacePreserved: false` |

## Complete File List

The following files are to be created. Tests are included because they are part of the Phase 1 deliverable, not deferred follow-up work.

| File to create | Purpose |
|---|---|
| `packages/video-gen/package.json` | ESM package, workspace dependencies, scripts, exports, and `demohunter-video` bin. |
| `packages/video-gen/tsconfig.json` | Package TypeScript build configuration extending the repository base config. |
| `packages/video-gen/README.md` | Package API, CLI, output, credential, and troubleshooting guide. |
| `packages/video-gen/scripts/copy-assets.mjs` | Deterministically copy prompt/template/style assets into `dist`. |
| `packages/video-gen/src/index.ts` | Supported package-root exports. |
| `packages/video-gen/src/api/index.ts` | `generateVideo()` public entry point. |
| `packages/video-gen/src/api/index.test.ts` | Programmatic API defaults, result, progress, errors, cleanup, and cancellation tests. |
| `packages/video-gen/src/pipeline/types.ts` | Options, result, style, progress, workspace, and internal stage types. |
| `packages/video-gen/src/pipeline/errors.ts` | Typed error codes, causal errors, and CLI-safe formatting/redaction. |
| `packages/video-gen/src/pipeline/preflight.ts` | Environment, executable, browser, output, and collision checks. |
| `packages/video-gen/src/pipeline/preflight.test.ts` | Preflight success/failure/cancellation tests. |
| `packages/video-gen/src/pipeline/orchestrator.ts` | Ordered end-to-end pipeline, progress, cancellation, and cleanup ownership. |
| `packages/video-gen/src/pipeline/orchestrator.test.ts` | Full mocked-pipeline integration and failure-boundary tests. |
| `packages/video-gen/src/content/schema.ts` | Strict Zod content-spec schema and inferred TypeScript types. |
| `packages/video-gen/src/content/schema.test.ts` | Valid/invalid content contract and serialization tests. |
| `packages/video-gen/src/content/generator.ts` | Responses API Structured Outputs call, validation, refusal handling, retries, and timeout. |
| `packages/video-gen/src/content/generator.test.ts` | Mocked OpenAI success/error/refusal/retry/model/cancellation tests. |
| `packages/video-gen/src/content/prompts/system.txt` | Version-controlled Phase 1 lesson-generation system prompt. |
| `packages/video-gen/src/templates/engine.ts` | Deterministic content-spec-to-site renderer and HTML escaping. |
| `packages/video-gen/src/templates/engine.test.ts` | Rendering, escaping, determinism, transition, and preset tests. |
| `packages/video-gen/src/templates/base/layout.html` | Self-contained page shell and slide/navigation insertion points. |
| `packages/video-gen/src/templates/base/slide.html` | Semantic stable-selector slide markup template. |
| `packages/video-gen/src/templates/base/app.js` | Fixed slide state and previous/next transition runtime. |
| `packages/video-gen/src/templates/presets/minimal/styles.css` | Minimal preset; the preset’s only CSS file. |
| `packages/video-gen/src/templates/presets/terminal/styles.css` | Terminal preset; the preset’s only CSS file. |
| `packages/video-gen/src/templates/presets/notebook/styles.css` | Notebook preset; the preset’s only CSS file. |
| `packages/video-gen/src/compiler/selectors.ts` | Stable ID/data-attribute selector construction. |
| `packages/video-gen/src/compiler/selectors.test.ts` | Selector validity, stability, and unsafe-input tests. |
| `packages/video-gen/src/compiler/templates/tour.template.ts` | Deterministic `defineTour()` source template helpers. |
| `packages/video-gen/src/compiler/tour-compiler.ts` | Shared instruction IR, emitted module, and in-memory tour compilation. |
| `packages/video-gen/src/compiler/tour-compiler.test.ts` | Golden source, type/import, event parity, narration, chapter, and transition tests. |
| `packages/video-gen/src/bridge/workspace.ts` | Staging, atomic publication, path layout, collision, and safe cleanup management. |
| `packages/video-gen/src/bridge/workspace.test.ts` | Workspace lifecycle, collisions, atomicity, and containment tests. |
| `packages/video-gen/src/bridge/server.ts` | Contained localhost static server with idempotent teardown. |
| `packages/video-gen/src/bridge/server.test.ts` | Serving, MIME, traversal, allocation, and close tests. |
| `packages/video-gen/src/bridge/demohunter.ts` | Config source/runtime construction and direct `generateTour()` invocation. |
| `packages/video-gen/src/bridge/demohunter.test.ts` | Config parity, progress, result, failure, and teardown tests. |
| `packages/video-gen/src/cli/index.ts` | Executable argument parser, help/version, progress, errors, and SIGINT handling. |
| `packages/video-gen/src/cli/index.test.ts` | CLI parsing, output, exit status, redaction, and signal tests. |
| `packages/video-gen/src/util/fs.ts` | Atomic UTF-8 file operations and guarded removal helpers. |
| `packages/video-gen/src/util/fs.test.ts` | Atomic-write and guarded-removal tests. |
| `packages/video-gen/src/util/slug.ts` | Deterministic title/ID slug normalization. |
| `packages/video-gen/src/util/slug.test.ts` | Slug edge-case and stability tests. |
| `packages/video-gen/src/util/validate.ts` | Semantic content validation and actionable validation error formatting. |
| `packages/video-gen/src/util/validate.test.ts` | Duplicate ID, selector safety, bounds, and error-path tests. |
| `packages/video-gen/tests/e2e/video-gen.test.ts` | Opt-in real OpenAI/DemoHunter end-to-end verification. |

The following existing files are modified, not created:

| Existing file to modify | Change |
|---|---|
| `package.json` | Add the video-gen asset-copy step to the root build sequence. |
| `tsconfig.json` | Add the `packages/video-gen` project reference. |
| `bun.lock` | Record the OpenAI SDK/Zod/package workspace dependency resolution produced by Bun. |

No other package, source, planning, or documentation files are required for Phase 1. If implementation reveals a need for an additional file, update this plan before creating it so the file boundary remains reviewable.

## Final Review Checklist

- [ ] Every implementation file maps to a planned responsibility above.
- [ ] The model generates only typed lesson content; all HTML, CSS, JS, selectors, tour code, and config are deterministic.
- [ ] The package calls public SDK/generator APIs and does not reach into another package’s private source tree.
- [ ] Content generation and DemoHunter TTS both use `OPENAI_API_KEY` from the environment only.
- [ ] Intermediate source and final portable output match the documented output contract.
- [ ] Phase 1 non-goals remain absent from schema, CLI, public API, dependencies, and templates.
- [ ] Unit, integration, build, workspace regression, and opt-in E2E verification are complete.
