# DemoHunter

**Create narrated product demos from Playwright-style TypeScript.**

DemoHunter is a CLI and SDK for repeatable product demos. Write a `.tour.ts` file, run one command, and get a video, captions, chapters, narration audio, a poster, and a checksummed manifest.

DemoHunter runs locally and does not need a hosted backend. It only sends narration text to your selected text-to-speech provider when the audio is not in the local cache.

DemoHunter is an [OAIZ Labs](https://oaiz.io/) open-source project maintained by OAIZ.

<video src=".demohunter/demohunter-github/video-1.10x.mp4" controls width="100%"></video>

## Why DemoHunter?

- **Playwright-native:** use familiar locators and browser actions.
- **Local-first:** run against local, preview, or public applications.
- **Repeatable:** keep demos in source control with the product code.
- **Portable:** get standard media files and a versioned manifest under `.demohunter/`.
- **Efficient:** reuse cached narration and regenerate offline when the cache is complete.
- **Agent-friendly:** install the included skill for Claude or Codex.

DemoHunter supports Chromium, Firefox, and WebKit; OpenAI and ElevenLabs narration; MP4 and WebM recording; SRT and VTT captions; cursor and chapter overlays; and standard, square, mobile, and GIF outputs.

## Quick start

Requirements: Node.js 20 or later, `ffmpeg`, `ffprobe`, and a Playwright browser.

```sh
npm install --save-dev demohunter
npx playwright install chromium
npx demohunter init
```

Start your application. Then set its URL in `demohunter.config.ts` and generate the starter tour:

```sh
npx demohunter generate demos/sample.tour.ts
open .demohunter/sample-smoke/video.mp4
```

Set `OPENAI_API_KEY` before you generate uncached OpenAI narration. For ElevenLabs, select that provider in the config and set `ELEVENLABS_API_KEY`. DemoHunter does not store these keys.

```sh
export OPENAI_API_KEY=sk-...
```

## Write a tour

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
    await chapter("Create an invoice");

    await step("Open the invoice form", async () => {
      await narrate("This workspace keeps invoices, exports, and credits in one place.");
      await narrateWhile("Create a new invoice from here.", async () => {
        await click(page.getByRole("button", { name: "New invoice" }));
      });
    });
  },
});
```

```sh
npx demohunter generate demos/billing-overview.tour.ts
```

Use `narrate()` for a static screen. Use `narrateWhile()` when visible actions must occur during the narration. Use Playwright directly for application setup, authentication, and assertions.

## Output

Each run writes portable assets to `.demohunter/<tour-id>/`:

```text
video.mp4       narrated demo
poster.jpg      cover frame
captions.srt    SRT captions
captions.vtt    WebVTT captions
chapters.json   chapter timeline
manifest.json   versioned file index with SHA-256 checksums
audio/          narration segments
variants/       optional square, mobile, or GIF outputs
```

## Useful commands

```sh
npx demohunter init
npx demohunter generate <tour-file>
npx demohunter generate <tour-file> --dry-run
npx demohunter generate <tour-file> --format standard --format square
npx demohunter doctor
npx demohunter cache list|prune|clear
npx demohunter add-skill [--target claude|codex|both]
```

Cookie-banner automation is off by default. Enable it for a supported vendor with `--cookie-dismiss reject` or in `demohunter.config.ts`.

## Documentation

- [Documentation index](https://github.com/oaiz-io/demohunter/blob/main/docs/README.md)
- [Getting started](https://github.com/oaiz-io/demohunter/blob/main/docs/getting-started.md)
- [Troubleshooting](https://github.com/oaiz-io/demohunter/blob/main/docs/troubleshooting.md)
- [DemoHunter agent skill](https://github.com/oaiz-io/demohunter/tree/main/packages/cli/skills/demohunter)

## Contributing and support

DemoHunter is under active development. Issues and pull requests are welcome. Read the [contribution guide](https://github.com/oaiz-io/demohunter/blob/main/CONTRIBUTING.md) before you submit a change. Report security problems as described in the [security policy](https://github.com/oaiz-io/demohunter/blob/main/SECURITY.md).

## License

DemoHunter is available under the [MIT License](LICENSE). Copyright is held by OAIZ AB and DemoHunter contributors.
