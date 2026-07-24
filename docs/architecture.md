# Architecture: Video Generation Agent

## Overview

The video generation agent is a CLI/library that turns a natural-language teaching prompt into a narrated MP4 video. It sits as an authoring layer on top of DemoHunter and follows a deterministic pipeline: **plan → render → compile → record**.

```
┌──────────────────────────────────────────────────────────────┐
│                    video-gen package                         │
│                                                              │
│  ┌──────────┐   ┌──────────┐   ┌───────────┐   ┌─────────┐ │
│  │   CLI    │   │  Program │   │  Content  │   │  Style  │ │
│  │ (args)   │   │  API     │   │ Generator │   │ System  │ │
│  └────┬─────┘   └────┬─────┘   └─────┬─────┘   └────┬────┘ │
│       └──────┬───────┘               │               │      │
│              ▼                       ▼               │      │
│       ┌──────────────┐     ┌──────────────────┐      │      │
│       │   Pipeline   │────▶│  Template Engine │◄─────┘      │
│       │  Orchestrator│     └────────┬─────────┘             │
│       └──────┬───────┘              ▼                       │
│              │              ┌──────────────┐                │
│              │              │ HTML/CSS/JS  │                │
│              │              │   Output     │                │
│              │              └──────┬───────┘                │
│              ▼                     ▼                        │
│       ┌──────────────────────────────────┐                  │
│       │        Tour Compiler             │                  │
│       │  (content-spec → .tour.ts)       │                  │
│       └──────────────┬───────────────────┘                  │
│                      ▼                                      │
│       ┌──────────────────────────────────┐                  │
│       │      DemoHunter Bridge           │                  │
│       │  (invoke demohunter generate)    │                  │
│       └──────────────┬───────────────────┘                  │
└──────────────────────┼──────────────────────────────────────┘
                       ▼
              ┌─────────────────┐
              │   DemoHunter    │
              │  (existing)     │
              │ Pass 1: timeline│
              │ Pass 2: record  │
              │ ffmpeg compose  │
              └────────┬────────┘
                       ▼
              .demohunter/<id>/video.mp4
```

## Pipeline Stages

### Stage 1: Structured Teaching Plan (LLM)

**Input:** User prompt (e.g. "Explain how HTTPS works in 3 minutes")
**Output:** `content-spec.json` — a typed JSON document

The LLM is called with a system prompt that constrains output to a strict JSON schema. The content spec describes _what_ to teach, not how to render it.

```jsonc
// content-spec.json
{
  "version": 1,
  "title": "How HTTPS Works",
  "duration": "3m",
  "slides": [
    {
      "id": "intro",
      "heading": "What is HTTPS?",
      "body": [
        { "type": "paragraph", "text": "HTTPS is HTTP inside a TLS tunnel..." },
        { "type": "bullet_list", "items": ["Encryption", "Authentication", "Integrity"] },
        { "type": "code_block", "language": "text", "code": "https://example.com" }
      ],
      "narration": "HTTPS stands for Hypertext Transfer Protocol Secure. It wraps regular HTTP inside an encrypted TLS tunnel, providing three guarantees: encryption, authentication, and integrity.",
      "transition": "slide-left"
    }
  ]
}
```

**Why structured JSON, not free-form HTML generation:**
- Deterministic rendering — same spec always produces the same page
- Content and presentation are separated
- The spec is inspectable, diffable, and cacheable
- LLMs are better at structured data than pixel-perfect CSS

### Stage 2: HTML/CSS/JS Rendering (Template Engine)

**Input:** `content-spec.json` + selected style preset
**Output:** Static HTML site under `site/`

The template engine is deterministic — no random values, no timestamps, no dynamic imports. It takes the content spec and a style preset, and renders:

- `index.html` — single-page app with slide containers
- `styles.css` — CSS from the selected preset theme
- `app.js` — minimal JS for slide transitions and code highlighting

Each slide renders to a `<section>` with stable, accessible selectors:

```html
<section id="slide-intro" class="slide" data-slide-index="0">
  <div class="slide-content">
    <h2>What is HTTPS?</h2>
    <p>HTTPS is HTTP inside a TLS tunnel...</p>
    <ul>
      <li>Encryption</li>
      <li>Authentication</li>
      <li>Integrity</li>
    </ul>
  </div>
</section>
```

**Selectors used by the tour compiler:**
- `section[data-slide-index="0"]` — target specific slides
- `#slide-intro h2` — verify heading visibility
- `#slide-intro ul li:nth-child(1)` — target specific elements

### Stage 3: Tour Compilation

**Input:** `content-spec.json` + rendered HTML site + style preset config
**Output:** `.tour.ts` file valid for DemoHunter

The tour compiler generates a valid `defineTour()` module that DemoHunter can execute. It translates the content spec into a sequence of DemoHunter steps.

Key compilation rules:
- Each slide becomes a `step()` or `chapter()` depending on heading level
- `narration` fields map to `narrate()` calls with exact text
- Slide transitions map to `click()` on navigation elements
- Code blocks get `narrateWhile()` with the code visible during narration
- All selectors use data attributes or IDs — no nth-child or fragile selectors

### Stage 4: DemoHunter Invocation (Bridge)

**Input:** Generated `.tour.ts` + `demohunter.config.ts` + rendered HTML site
**Output:** `.demohunter/<tour-id>/video.mp4` + manifest + captions + chapters

The bridge:
1. Writes the generated tour and config to a generation workspace
2. Serves the rendered HTML site on a local port (or uses `file://` baseURL)
3. Invokes `demohunter generate` with the tour file
4. Waits for completion, captures output path
5. Returns the path to the generated video

DemoHunter's two-pass architecture handles the rest:
- **Pass 1:** Execute tour, render TTS audio, build deterministic timeline
- **Pass 2:** Replay tour events using the timeline, record browser to video
- **Post:** ffmpeg compose video + audio, generate captions, chapters, poster

## Package Layout

```
packages/video-gen/
├── src/
│   ├── cli/
│   │   └── index.ts              # CLI entry: parse args, run pipeline
│   ├── api/
│   │   └── index.ts              # Programmatic API: generateVideo()
│   ├── pipeline/
│   │   ├── orchestrator.ts       # Runs the full pipeline
│   │   └── types.ts              # Pipeline config types
│   ├── content/
│   │   ├── generator.ts          # LLM call: prompt → content-spec
│   │   ├── schema.ts             # Zod schema for content-spec.json
│   │   └── prompts/
│   │       └── system.txt        # System prompt for content generation
│   ├── compiler/
│   │   ├── tour-compiler.ts      # content-spec → .tour.ts string
│   │   ├── selectors.ts          # Selector generation utilities
│   │   └── templates/
│   │       └── tour.template.ts  # Tour template with placeholders
│   ├── templates/
│   │   ├── engine.ts             # Template engine: spec + preset → HTML
│   │   ├── base/
│   │   │   ├── layout.html       # Base HTML layout
│   │   │   ├── slide.html        # Slide template
│   │   │   └── app.js            # Slide transitions, navigation
│   │   └── presets/
│   │       ├── minimal/
│   │       │   └── styles.css
│   │       ├── terminal/
│   │       │   └── styles.css
│   │       └── notebook/
│   │           └── styles.css
│   ├── bridge/
│   │   ├── demohunter.ts         # Invoke demohunter generate
│   │   ├── server.ts             # Serve generated HTML for recording
│   │   └── workspace.ts          # Create/manage generation workspace
│   └── util/
│       ├── fs.ts                 # File system helpers
│       ├── slug.ts               # Title → URL-safe slug
│       └── validate.ts           # Validate content-spec before rendering
├── package.json
├── tsconfig.json
└── README.md
```

## Data Flow

```
User input: "Explain how HTTPS works in 3 minutes"
    │
    ▼
┌──────────────────────────────────────────┐
│ Content Generator (LLM)                  │
│ System prompt + user prompt              │
│ → structured JSON response              │
│ → validated against Zod schema          │
│ → written to content-spec.json          │
└──────────────────┬───────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────┐
│ Template Engine                          │
│ Reads: content-spec.json + preset CSS    │
│ Renders: index.html, styles.css, app.js  │
│ Writes to: site/                         │
└──────────────────┬───────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────┐
│ Tour Compiler                            │
│ Reads: content-spec.json + site/         │
│ Generates: <tour-id>.tour.ts            │
│ Generates: demohunter.config.ts          │
│ Writes to: generation workspace          │
└──────────────────┬───────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────┐
│ DemoHunter Bridge                        │
│ Serves site/ on localhost                │
│ Runs: demohunter generate <tour>.tour.ts │
│ Pass 1: timeline + TTS                   │
│ Pass 2: record + compose                 │
│ Output: .demohunter/<tour-id>/video.mp4  │
└──────────────────┬───────────────────────┘
                   │
                   ▼
              video.mp4 ✓
```

## LLM Integration Design

### API Usage

Reuses the existing `OPENAI_API_KEY` from environment. Uses GPT-4.6 or equivalent for content generation with structured JSON output.

### System Prompt Structure

```
You are a lesson designer. Given a topic, produce a structured teaching plan
as JSON. Follow these rules:

1. Break the topic into 3-8 slides
2. Each slide has: heading, body content, narration text
3. Narration should be natural spoken English, not written prose
4. Use concrete examples, not abstract descriptions
5. Include code blocks when relevant (with language identifiers)
6. Target the requested duration — fewer slides for shorter videos

Output ONLY valid JSON matching this schema.
```

### Response Handling

- **Success:** Parse JSON, validate against Zod schema, proceed to rendering
- **Invalid JSON:** Retry once with stronger formatting instructions
- **Schema mismatch:** Retry with specific validation errors injected into prompt
- **Too many slides (>20):** Truncate or ask user to narrow topic
- **Empty narration:** Retry — narration is mandatory for video

### Retry Strategy

| Failure | Retry? | Max attempts | Notes |
|---------|--------|-------------|-------|
| Invalid JSON | Yes | 2 | Inject formatting hints |
| Schema mismatch | Yes | 2 | Inject validation errors |
| Timeout | Yes | 2 | 30s timeout per call |
| Rate limit | Yes | 3 | Exponential backoff |
| Content policy | No | 1 | Return error to user |

## Template System

### HTML Template Structure

The base layout provides the shell; individual slide templates fill content. Uses a simple {{mustache}}-style substitution system (no runtime dependency on Handlebars — the template engine does string replacement).

### CSS Theme Variables

Each preset defines CSS custom properties:

```css
/* presets/minimal/styles.css */
:root {
  --bg: #ffffff;
  --fg: #1a1a1a;
  --accent: #2563eb;
  --font-sans: 'Inter', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
  --slide-width: 960px;
  --slide-height: 540px;
  --radius: 8px;
}
```

### JS for Transitions

Minimal, deterministic JS — no random, no setTimeout with variable delays. Each slide gets `active`/`exit-left` classes. Navigation is via `data-nav` buttons with stable selectors.

## Error Handling

### Categories and Responses

| Error | Action | User sees |
|-------|--------|-----------|
| LLM returns invalid JSON | Retry once, then fail | "Content generation failed. The model returned an unexpected response." |
| LLM timeout | Retry with backoff | "Content generation timed out. Check your network and API key." |
| Template rendering fails | Fail (no retry) | "Failed to render lesson. The content spec may be invalid." |
| Tour compilation fails | Fail (no retry) | "Failed to generate tour script." |
| DemoHunter Pass 1 fails | Fail (no retry) | "DemoHunter failed during narration generation." |
| DemoHunter Pass 2 fails | Fail (no retry) | "DemoHunter failed during recording." |
| Browser crash | Fail (no retry) | "Browser crashed during recording. Try again." |
| ffmpeg missing | Pre-flight check | "ffmpeg is not installed. Install it to continue." |
| Port in use | Try next port | Transparent to user |

### Cleanup Contract

On failure, the generation workspace is preserved so the user can inspect intermediate artifacts. On success, only the final `.demohunter/` output is kept. Pass `--cleanup` to remove the workspace on success too.

## Determinism Guarantees

For DemoHunter's two-pass architecture to work, Pass 1 and Pass 2 must produce identical event sequences. The video-gen package ensures this by:

1. **No random content:** Templates use deterministic rendering — no `Math.random()`, no `Date.now()`, no randomized IDs
2. **Stable selectors:** All interactive elements use `data-*` attributes or unique IDs, never nth-child or positional selectors
3. **Deterministic animations:** CSS transitions are time-based, not frame-based. JS animations use fixed durations.
4. **No external resources:** Generated HTML is self-contained — no CDN fonts, no third-party JS that could change between passes
5. **Static TTS cache:** DemoHunter caches narration audio — Pass 1 generates it, Pass 2 reuses it from cache
6. **Immutable content spec:** Once generated, the content spec is never modified between passes
