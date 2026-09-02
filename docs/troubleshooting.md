# Troubleshooting

Common first-run failures and how to fix them.

## `Playwright could not launch the local browser runtime`

The Playwright Chromium runtime is not installed on this machine.

```sh
npx playwright install chromium
```

DemoHunter does not bundle browsers.

## `spawn ffmpeg ENOENT` or `spawn ffprobe ENOENT`

Install `ffmpeg` with your system package manager and confirm both binaries resolve:

```sh
ffmpeg -version
ffprobe -version
```

DemoHunter uses `ffmpeg` to mux audio into video and capture poster frames.

## `OPENAI_API_KEY is not set` or `ELEVENLABS_API_KEY is not set`

DemoHunter only needs a provider API key when generating *uncached* narration.

- If every narration string is already in `.demohunter/cache/`, generation runs offline.
- For new OpenAI strings, export:

```sh
export OPENAI_API_KEY=sk-...
```

- For new ElevenLabs strings, export:

```sh
export ELEVENLABS_API_KEY=...
```

DemoHunter does not store credentials.

## `DemoHunter could not reach baseURL`

The CLI tried to load your app and got `ERR_CONNECTION_REFUSED` or a similar network error.

- Start your app yourself before running `demohunter generate`.
- Open the configured `baseURL` in a browser to confirm it is reachable.
- DemoHunter does not wait for your app to boot or manage preview environments.

## Failed tour debug artifacts

When collection, replay, or dry-run validation fails, DemoHunter writes debug files under:

```text
.demohunter/<tour-id>/debug/<timestamp>-<phase>/
```

The directory includes `failure.json`, `body.txt` when page text is available, and `screenshot.png` when Playwright can capture the current page.

## Validate the flow before narration

Use dry-run mode while authoring selectors or app state:

```sh
npx demohunter generate demos/sample.tour.ts --dry-run
```

`--flow-only` is an alias. Dry runs skip narration resolution, video recording, muxing, and final manifest output.

## Setup checks

Run:

```sh
npx demohunter doctor
```

This checks config loading, `ffmpeg`, `ffprobe`, Playwright browser launchability, `baseURL` reachability, output/cache writability, and whether `OPENAI_API_KEY` is available for uncached narration.

## `Tour file must default export an object with string id/title and a run function`

The tour file is missing one of the required fields. Minimum shape:

```ts
import { defineTour } from "demohunter";

export default defineTour({
  id: "my-tour",
  title: "My tour",
  async run({ page }) {
    // ...
  },
});
```

Use `npx demohunter init` to scaffold a known-good starter.

## `Refusing to overwrite existing file`

`demohunter init` will not silently overwrite files. Pass `--force` to refresh the starter on top of existing ones:

```sh
npx demohunter init --force
```

## Generated files end up in `git status`

`demohunter generate` writes a `.demohunter/.gitignore` file containing `*` so the directory ignores itself. If you accidentally deleted that file, recreate it or add `.demohunter/` to your project-level `.gitignore`.

## Still stuck?

Run a clean smoke test in a fresh directory:

```sh
mkdir /tmp/dh && cd /tmp/dh
npm init -y
npm install --save-dev demohunter
npx playwright install chromium
npx demohunter init
npx demohunter generate demos/sample.tour.ts
```

If that fails, [open an issue](https://github.com/oaiz-io/demohunter/issues). Include the command, the full output, and your operating system, Node.js, and `ffmpeg` versions.
