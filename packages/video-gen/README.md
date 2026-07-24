# @demohunter/video-gen

Turn a natural-language teaching prompt into a narrated DemoHunter MP4 video.

Phase 1 produces one inspectable slide lesson and one portable DemoHunter output from a single prompt. Content is planned by an LLM into a typed JSON content spec; HTML, CSS, JavaScript, selectors, and `.tour.ts` are generated deterministically by this package.

## Prerequisites

- Bun workspace install
- `ffmpeg` and `ffprobe` on `PATH`
- Playwright Chromium installed (`bunx playwright install chromium`)
- `OPENAI_API_KEY` in the environment (content generation and DemoHunter TTS)

No API keys are accepted via flags, config files, or the public API. Credentials are read from `process.env` only.

## CLI

```bash
demohunter-video generate "What is a binary tree?" --style minimal --output .demohunter
```

Flags:

- `--style <minimal|terminal|notebook>` — CSS preset (default `minimal`)
- `--output <dir>` — output root (default `.demohunter`)
- `--cleanup` — remove the inspectable source workspace after success
- `-h, --help` / `-v, --version`

## Programmatic API

```ts
import { generateVideo } from "@demohunter/video-gen";

const result = await generateVideo({
  prompt: "What is a binary tree?",
  style: "minimal",
  outputDir: ".demohunter",
});

console.log(result.videoPath);
```

## Output layout

For tour id `binary-tree` and `--output .demohunter`:

```
.demohunter/
  binary-tree/                 # portable DemoHunter artifacts
    video.mp4
    captions.srt
    captions.vtt
    chapters.json
    poster.jpg
    audio/
    manifest.json
  video-gen/
    binary-tree/               # inspectable generation source (kept by default)
      content-spec.json
      site/
        index.html
        styles.css
        app.js
      binary-tree.tour.ts
      demohunter.config.ts
  cache/                       # DemoHunter narration cache
```

Pass `--cleanup` (or `cleanup: true`) to delete `video-gen/<id>/` after a successful recording. Final portable output is always retained.

## Pipeline

1. Preflight — key, ffmpeg/ffprobe, Chromium, writable output
2. Content — OpenAI Structured Outputs → validated `content-spec.json`
3. Render — template engine + style preset → `site/`
4. Compile — content-spec → `.tour.ts` + in-memory tour
5. Bridge — local static server + `generateTour()` from `@demohunter/generator-playwright`

The model never authors HTML, CSS, or TypeScript. Selectors use only `id` and `data-*` attributes.

## Styles

| Preset | Look |
|---|---|
| `minimal` | Clean white, system sans |
| `terminal` | Dark high-contrast monospace |
| `notebook` | Warm paper-like system serif |
