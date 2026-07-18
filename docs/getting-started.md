# Getting started

This guide walks through installing DemoHunter, scaffolding a starter tour, and generating your first demo.

## Requirements

- Node.js 20+
- `ffmpeg` and `ffprobe` on your `PATH`
- A Playwright Chromium runtime (installed once: `npx playwright install chromium`)
- `OPENAI_API_KEY` or `ELEVENLABS_API_KEY` only when generating uncached narration
- For local Kokoro only: Python 3, separately installed `kokoro-onnx` and `soundfile`, plus user-provided model and voices files

## Install

```sh
npm install --save-dev demohunter
npx playwright install chromium
```

DemoHunter ships Playwright as a runtime dependency. You install the browser runtime once per machine.

## Scaffold a starter

From your project root:

```sh
npx demohunter init
```

This creates:

```
demohunter.config.ts
demos/sample.tour.ts
demos/sample-site/index.html
```

The first `demohunter generate` run also writes `.demohunter/.gitignore` so generated artifacts stay out of source control without touching your project-level `.gitignore`.

## Generate the starter demo

```sh
npx demohunter generate demos/sample.tour.ts
open .demohunter/sample-smoke/video.mp4
```

The starter tour does not call `narrate(...)`, so it runs without `OPENAI_API_KEY` and produces a silent video.

## Point at your own app

1. Start your app yourself (DemoHunter does not start it for you).
2. Set `baseURL` in `demohunter.config.ts` to wherever your app is reachable.
3. Write a tour under `demos/` that exercises one flow. Use normal Playwright (`page.getByRole`, `page.click`, etc.). Add `narrate(...)` for static states and `narrateWhile(...)` when narration should continue over navigation, clicks, typing, waits, or highlights.

Example:

```ts
import { defineTour } from "demohunter";

export default defineTour({
  id: "billing-overview",
  title: "Billing overview",
  async beforeRecord({ goto, page }) {
    await goto("/");
    await page.getByRole("heading", { name: "Workspace" }).waitFor();
  },
  async run({ page, chapter, click, step, narrate, narrateWhile }) {
    await chapter("Open the workspace");

    await step("Land on the dashboard", async () => {
      await narrate("Welcome to the billing workspace. Invoices, exports, and credits all live here.");
      await narrateWhile("Now we open the invoice form while the overview stays in context.", async ({ sleep }) => {
        await sleep(800);
        await click(page.getByRole("button", { name: "New invoice" }));
      });
    });
  },
});
```

Then:

```sh
export OPENAI_API_KEY=sk-...
npx demohunter generate demos/billing-overview.tour.ts --dry-run
npx demohunter generate demos/billing-overview.tour.ts
```

OpenAI is the default narration provider. To use ElevenLabs, set `tts.provider` and a voice ID in `demohunter.config.ts`, then export `ELEVENLABS_API_KEY` before generating:

```ts
export default {
  baseURL: "http://localhost:3000",
  tts: {
    provider: "elevenlabs",
    voice: "JBFqnCBsd6RMkjVDRZzb",
    model: "eleven_multilingual_v2",
    format: "mp3_44100_128",
    language: "sv",
    voiceSettings: {
      stability: 0.5,
      similarityBoost: 0.75,
      useSpeakerBoost: true,
    },
  },
};
```

Use `tts.language` for the demo's narration language, with ISO 639-1 codes such as `sv` for Swedish. Use `narrate("...", { voice: "other-voice-id", language: "sv" })` or `narrateWhile(...)` options when a single segment should use a different voice, model, format, language, or ElevenLabs voice settings. DemoHunter does not infer narration language from locale environment variables such as `DEMO_LOCALE`.

### Use Kokoro locally

Install the runtime and assets separately; DemoHunter never downloads or bundles them. The recommended configuration uses DemoHunter's weight-free bundled Python worker:

```ts
import { defineConfig, kokoro, kokoroTTS } from "demohunter";

export default defineConfig({
  baseURL: "http://localhost:3000",
  providers: {
    tts: [kokoro({
      pythonCommand: "python3",
      modelPath: "/opt/kokoro/kokoro-v1.0.onnx",
      voicesPath: "/opt/kokoro/voices-v1.0.bin",
      backendVersion: "kokoro-onnx",
    })],
  },
  tts: kokoroTTS({ voice: "af_heart", language: "en-US" }),
});
```

Run `npx demohunter doctor`. It checks only the selected provider, including the Python/executable path, model and voices files, dependency startup, JSONL protocol/version handshake, selected language, and the fixed WAV/24 kHz contract. The worker is sequential, receives Unicode JSON, supports cancellation/timeouts, and is terminated on failures. Custom adapters use `runtime: "command"`, an executable, and literal `args`; no shell parses them.

Exact Kokoro languages are `en-US`, `en-GB`, `es`, `fr`, `hi`, `it`, `ja`, `pt-BR`, and `zh`. Kokoro output is always WAV at 24 kHz so ffmpeg can mux it directly.

On the first asset-backed run, DemoHunter hashes model and voices content and writes a local identity sidecar. Cache keys also include backend and protocol versions. A fully cached rerun can resolve offline from the verified sidecar even when assets are temporarily unavailable; a cache miss still requires both files. With files present, a corrupt sidecar is replaced from verified hashes. Executable and asset paths do not enter portable narration metadata.

## Polish and social outputs

Use DemoHunter's deterministic click helper for visible interactions. It performs the same timing in both passes and completes the configured cursor arc before the trusted Playwright click:

```ts
await click(page.getByRole("button", { name: "Publish" }));
```

Cookie dismissal is opt-in and restricted to recognized vendor-scoped selectors:

```sh
npx demohunter generate demos/billing-overview.tour.ts --cookie-dismiss reject
```

Generate multiple distribution formats in one run:

```sh
npx demohunter generate demos/billing-overview.tour.ts \
  --format standard --format square --format gif --duration 12
```

Or configure them permanently:

```ts
export default {
  baseURL: "http://localhost:3000",
  record: {
    container: "mp4",
    cursor: { mode: "smooth", shape: "pointer", color: "#3b82f6" },
    cookieBanners: { enabled: true, action: "reject" },
  },
  output: {
    formats: [
      { preset: "standard" },
      { preset: "square", layout: "fit" },
      { preset: "mobile" },
      { preset: "gif", durationMs: 12_000 },
    ],
  },
};
```

Square defaults to scale-and-pad. Mobile always runs its own responsive capture at 390×844 and encodes to 1080×1920. GIF is silent, palette-based, and limited to 15 seconds. Requested derivatives live under `variants/<preset>/`; the baseline MP4 remains at the output root.

## Install the agent skill (optional)

```sh
npx demohunter add-skill --target claude
```

Targets: `claude`, `codex`, or `both`. When `--target` is omitted, the skill is installed for both. The skill teaches your coding agent how to author and update DemoHunter tours without inventing wrapper abstractions.

## Repo examples

The `examples/` directory contains two runnable consumer apps you can use as a reference:

```sh
# Terminal 1
npm run --prefix examples/nextjs-demo dev

# Terminal 2
npm run --prefix examples/nextjs-demo generate
```

Same shape for `examples/vite-demo`.

## Next steps

- [Troubleshooting](./troubleshooting.md) — common first-run blockers.
- [Agent skill](../packages/cli/skills/demohunter/) — `.tour.ts` authoring rules for AI agents.
