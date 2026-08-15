# Research: DemoHunter Internals

## How DemoHunter Works Internally

### Two-Pass Architecture

DemoHunter uses a two-pass approach:
1. Pass 1: Execute tour, collect events into timeline, generate TTS audio, cache it
2. Pass 2: Replay events from timeline, record browser, compose with ffmpeg
3. Post: captions, chapters, poster, checksummed manifest

Key insight: Pass 1 and Pass 2 must produce identical browser states.

### Tour DSL

defineTour() wraps: chapter(), step(), narrate(), narrateWhile(), click(), typeText(), sleep()
narrateWhile() is the key primitive - timing from actual TTS audio duration, not text estimate.

### TTS System

Providers: OpenAI (gpt-4o-mini-tts, tts-1, tts-1-hd) and ElevenLabs. Cached by content hash.

### Package Structure

Bun workspace monorepo: cli, sdk, generator-playwright, tts-core, tts-openai, tts-elevenlabs, media-ffmpeg, manifest.

---

## Design Decisions

### 1. Structured Content Spec vs Free-Form HTML
Decision: JSON content spec, rendered deterministically by template engine.
Why: Determinism, separation of concerns, debuggability, caching, LLM reliability.
Trade-off: Less visual flexibility. Mitigated by style presets and marketplace.

### 2. Separate Compilation vs Direct Tour.ts Generation
Decision: Two-step pipeline. Never let LLM generate .tour.ts directly.
Why: Tour compiler guarantees valid syntax, correct selectors, proper narrateWhile wrapping.
Trade-off: More code to maintain. Worth it for reliability.

### 3. Template-Based Rendering vs LLM-Generated CSS
Decision: Pre-built style presets. LLM never writes CSS.
Why: Visual consistency, determinism, marketplace ecosystem, cost savings.
Trade-off: No one-off custom styles. Mitigated by style marketplace.

### 4. Narration Embedded in Content Spec
Decision: Narration text is a field in each slide, generated alongside content.
Why: Timing alignment, single LLM call, no separate sync step.

### 5. Determinism Over Flexibility
Decision: Prioritize reliable recording over rich interactivity in Phase 1.
Why: Two-pass architecture is the foundation. Interactive elements added in Phase 2.
Trade-off: Phase 1 lessons are simpler (slide-based). Acceptable for MVP.

### 6. Pipeline Over Single LLM Call
Decision: Multi-stage pipeline (generate, render, compile, record).
Why: Debuggability, partial re-execution, caching, reliability.

### 7. Monorepo vs Separate Repository
Decision: Add packages/video-gen/ to the DemoHunter monorepo.
Why: Shared infrastructure, tight coupling, version alignment.

## Key Constraints

1. Pass 1/Pass 2 determinism is non-negotiable
2. Selectors must be stable: data- attributes and IDs only
3. Narration timing from TTS audio, not text length
4. TTS cache is content-addressed: validate before generating
5. No external resources in generated HTML: all assets inlined
6. File-based baseURL is supported
7. Bun is the package manager and runtime
