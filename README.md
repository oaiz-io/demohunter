# DemoHunter

**Narrated product demos as code**

DemoHunter turns Playwright-style automation into narrated product demos. You write a `.tour.ts` file, run the CLI locally, and get portable demo assets under `.demohunter/`: video, captions, chapters, poster, narration audio, and a checksummed manifest.

Two workflows are especially useful:

- **Product, docs, and DevRel**: keep marketing pages, release notes, and onboarding videos in sync with the product by generating demos from repeatable scripts.
- **AI coding agents**: let an agent attach a narrated demo of its work to a pull request so reviewers can see the changed flow in motion.

DemoHunter is local-first. It does not require a hosted backend. Narration can use OpenAI, ElevenLabs, or a separately installed local Kokoro runtime.

<video src=".demohunter/demohunter-github/video-1.10x.mp4" controls width="100%"></video>

## Features

- [x] Cached narration. Same text never hits the TTS API twice.
- [x] MP4 by default, WebM optional.
- [x] SRT and VTT captions generated from narration.
- [x] Chapter markers and overlays.
- [x] Action overlays (mouse clicks visible on the recording).
- [x] Smooth SVG cursor motion with deterministic `click(locator)` choreography.
- [x] Opt-in dismissal for recognized cookie-consent vendors.
- [x] Standard, square, responsive mobile, and GIF social outputs.
- [x] All three Playwright browsers: Chromium, Firefox, WebKit.
- [x] Per-call voice and tone overrides on `narrate()`.
- [x] OpenAI TTS (`gpt-4o-mini-tts`, `tts-1`, `tts-1-hd`).
- [x] ElevenLabs TTS with configurable voice IDs and voice settings.
- [x] Local Kokoro TTS through a safe external JSONL worker (no bundled weights or downloads).
- [x] Portable `manifest.json` with sha256 checksums.
- [x] Offline regeneration when narration is fully cached.
- [x] Agent skill for Claude and Codex.
- [ ] Other AI voice providers (Cartesia, local Piper).
- [ ] Background music and sound effects.
- [ ] Hosted / cloud generation.
- [ ] Cursor agent skill.
- [ ] GitHub PR comment / webhook automation / GitHub Action.

PRs welcome on anything unchecked.

## Install

```sh
npm install --save-dev demohunter
npx playwright install chromium
export OPENAI_API_KEY=sk-...
# or, with tts.provider: "elevenlabs"
export ELEVENLABS_API_KEY=...
```

You also need `ffmpeg` and `ffprobe` on your `PATH`. A provider API key is only required when generating narration that is not already cached.

## Quick start

Start your app on `http://localhost:3000`. In another terminal:

```sh
npx demohunter init
# edit demohunter.config.ts and point baseURL at your app
npx demohunter generate demos/sample.tour.ts
open .demohunter/sample-smoke/video.mp4
```

That's the full loop: scaffold, write the tour, render the video.

## What a tour looks like

```ts
// demos/billing-overview.tour.ts
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
      await narrate("This is the billing workspace. Invoices, exports, and credits all live in one place.");
    });

    await step("Create a new invoice", async () => {
      await narrateWhile("Creating an invoice is one step now. The customer field has type-ahead search built in.", async ({ sleep, typeText }) => {
        await click(page.getByRole("button", { name: "New invoice" }));
        await sleep(700);
        await typeText(page.getByLabel("Customer"), "Acme", { replace: true });
      });
    });
  },
});
```

```sh
npx demohunter generate demos/billing-overview.tour.ts
```

You get `.demohunter/billing-overview/video.mp4` with narration timed to each step or choreographed over visible motion, plus captions and a manifest.

Use Playwright's `.fill()` for setup or hidden prep. When text entry should be visible in the final recording, use `typeText(...)` inside `narrateWhile(...)` so the field is typed incrementally with deterministic natural pacing.

## Config

```ts
// demohunter.config.ts
import { defineConfig } from "demohunter";

export default defineConfig({
  baseURL: "http://localhost:3000",
  // tts: { voice: "marin", model: "gpt-4o-mini-tts", language: "sv" },
  // viewport: { width: 1440, height: 900 },
  // record: { container: "mp4", cursor: { color: "#3b82f6" } },
  // output: { formats: [{ preset: "square" }, { preset: "gif", durationMs: 12_000 }] },
});
```

Cookie automation ships disabled. Enable it for known OneTrust, Cookiebot, Didomi, TrustArc, or Quantcast banners with `record.cookieBanners.enabled`, or for one run with `--cookie-dismiss reject`. Custom `beforeRecord` logic runs after the built-in dismissal step.

`record.container` selects MP4/WebM recording output. The older `record.format` spelling remains accepted during migration; `--format` refers only to distribution presets.

OpenAI remains the default TTS provider and reads `OPENAI_API_KEY` only when uncached narration is needed. To use ElevenLabs instead:

```ts
export default defineConfig({
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
});
```

Export `ELEVENLABS_API_KEY` for uncached ElevenLabs narration. Individual calls can override voice, model, format, language, and voice settings: `narrate("...", { voice: "other-voice-id", language: "sv" })`.
Use ISO 639-1 language codes such as `sv` for Swedish. ElevenLabs receives `language` as the API's `language_code`. OpenAI does not expose a general language parameter for built-in TTS voices, so DemoHunter folds `language` into the voice instructions to steer language and accent.

### Local Kokoro

DemoHunter ships a small, weight-free Python worker, not Kokoro, Python packages, model weights, or voices. Install Python `>=3.10,<3.14` and `kokoro-onnx`/`soundfile` yourself, and provide local model and voices files:

```ts
import { defineConfig, kokoro, kokoroTTS } from "demohunter";

export default defineConfig({
  baseURL: "http://localhost:3000",
  providers: {
    tts: [kokoro({
      modelPath: "/opt/kokoro/kokoro-v1.0.onnx",
      voicesPath: "/opt/kokoro/voices-v1.0.bin",
    })],
  },
  tts: kokoroTTS({ voice: "af_heart", language: "en-US" }),
});
```

The bundled worker is the default and launches `python3` with literal arguments and no shell. A compatible external DemoHunter JSONL adapter can instead use the exact command-mode configuration:

```ts
import { defineConfig, kokoro } from "demohunter";

export default defineConfig({
  baseURL: "http://localhost:3000",
  providers: { tts: [kokoro({ runtime: "command", executable: "kokoro" })] },
  tts: { provider: "kokoro", voice: "en_us_male_1", language: "en-US" },
});
```

The executable must implement DemoHunter's JSONL protocol; it is not assumed to be an upstream Kokoro CLI. Its protocol-v1 ready message must report stable model and voices SHA-256 digests plus the backend version, so cache identity remains portable without host asset paths. Full command configuration keeps paths separate from argv:

```ts
kokoro({
  runtime: "command",
  executable: "/usr/local/bin/demohunter-kokoro-worker",
  args: ["--profile", "local"],
  modelPath: "/opt/kokoro/kokoro-v1.0.onnx",
  voicesPath: "/opt/kokoro/voices-v1.0.bin",
})
```

Kokoro produces ffmpeg-compatible WAV at 24 kHz. Supported language settings are `en-US`, `en-GB`, `es`, `fr`, `hi`, `it`, `ja`, `pt-BR`, and `zh`. Run `npx demohunter doctor` before generating. DemoHunter hashes the model, voices, backend version, and worker protocol into cache identity; executable paths are never written into portable cache metadata.
If `backendVersion` is configured, it must exactly match the version string in the worker's ready message. Leave it unset unless you deliberately want version pinning.

## Output

Every run writes to `.demohunter/<tour-id>/`:

```
video.mp4       narrated demo
poster.jpg      cover frame
captions.srt    SRT subtitles
captions.vtt    WebVTT subtitles
chapters.json   chapter timeline
manifest.json   portable, checksummed index
audio/          per-segment narration clips
variants/       requested square, mobile, or GIF derivatives
```

With no `output.formats` or `--format` flags, DemoHunter keeps the original manifest v1 layout unchanged. Multi-format runs publish a checksummed manifest v2 atomically. Mobile uses its own 390×844 two-pass browser capture so responsive navigation and selectors are validated rather than stretched from desktop.

Identical narration text is cached locally. Reruns don't re-pay for TTS.

## Agent skill

Teach Claude or Codex to write tours for you:

```sh
npx demohunter add-skill                  # installs to both .claude/ and .codex/
npx demohunter add-skill --target claude  # or just one
```

## Docs

- [Getting started](https://github.com/emilwareus/demohunter/blob/main/docs/getting-started.md)
- [Troubleshooting](https://github.com/emilwareus/demohunter/blob/main/docs/troubleshooting.md)

## CLI

```sh
npx demohunter init                       # scaffold starter tour + config
npx demohunter generate <tour-file>       # run a tour, write output
npx demohunter generate <tour-file> --dry-run
                                           # validate browser flow without TTS/video
npx demohunter generate <tour-file> --cursor smooth --cookie-dismiss reject
npx demohunter generate <tour-file> --format standard --format square
npx demohunter generate <tour-file> --format gif --duration 12
npx demohunter doctor                     # check local prerequisites
npx demohunter cache list|prune|clear     # manage narration cache
npx demohunter add-skill [--target ...]   # install agent skill (claude | codex | both)
npx demohunter --help
```

## License

[MIT](LICENSE)
