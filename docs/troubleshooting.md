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

## `kokoro executable not found`

Kokoro is selected, but the configured command or Python runtime cannot be resolved. Install the runtime yourself and correct `providers.tts[].options.executable` or `pythonCommand`. DemoHunter does not install Python packages or download anything. Arguments are passed literally with no shell.

## `model file missing` or `voices file missing`

For the bundled worker, set absolute or project-resolvable `modelPath` and `voicesPath` values in the `kokoro(...)` descriptor. DemoHunter contains neither asset. A compatible `runtime: "command"` adapter may omit both paths only when its ready message supplies stable model/voices SHA-256 digests and a backend version. If the runtime or both assets are temporarily unavailable, only narration covered by a previously verified local identity sidecar and audio cache can resolve offline; a partial or uncached setup fails deliberately.

## Kokoro protocol, version, language, or WAV failure

Run `npx demohunter doctor`. The bundled worker expects separately installed `kokoro-onnx` and `soundfile`, protocol v1, one of `en-US`, `en-GB`, `es`, `fr`, `hi`, `it`, `ja`, `pt-BR`, or `zh`, and WAV at 24 kHz. A configured `backendVersion` must match the worker handshake. For command mode, the executable must implement DemoHunter's JSONL worker protocol; the upstream Kokoro CLI is not automatically adapted.

Worker crashes, malformed/oversized JSON, corrupt WAV, timeouts, and cancellation terminate the process and discard staging output. Retry after fixing the reported runtime error. Corrupt cache audio is regenerated when local assets are available; executable paths are never part of cache metadata.

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

This checks config loading, `ffmpeg`, `ffprobe`, Playwright browser launchability, `baseURL` reachability, output/cache writability, and prerequisites for only the selected narration provider. Kokoro checks do not install, download, or synthesize narration.

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

If that fails, [open an issue](https://github.com/emilwareus/demohunter/issues) with the command, the full output, and your OS / Node / `ffmpeg` versions.
