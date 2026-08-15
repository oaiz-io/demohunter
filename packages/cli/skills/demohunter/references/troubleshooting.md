# DemoHunter Troubleshooting

## Missing `OPENAI_API_KEY`

DemoHunter only needs `OPENAI_API_KEY` when a generate run requires uncached narration.

- If the narration is already cached, generation can run offline.
- If a new narration segment is needed, set `OPENAI_API_KEY` in the environment and rerun the command.

## Kokoro Setup

For `kokoro executable not found`, install or correct the configured Python/worker command yourself. The bundled worker requires both `modelPath` and `voicesPath`; a compatible command adapter may omit both only when its ready message reports model/voices SHA-256 digests and backend version. DemoHunter never installs `kokoro-onnx`/`soundfile`, downloads assets, or bundles weights.

Protocol/version, unsupported-language, WAV/24 kHz, crash, timeout, cancellation, corrupt-output, and corrupt-cache errors are deliberate safety boundaries. Run `demohunter doctor`, confirm a DemoHunter-compatible JSONL worker and supported language (`en-US`, `en-GB`, `es`, `fr`, `hi`, `it`, `ja`, `pt-BR`, `zh`), then retry. A fully cached offline run needs a previously verified identity sidecar; a cache miss needs local model and voices files.

## App Not Reachable

DemoHunter expects the app at `demohunter.config.ts` `baseURL` to already be running.

- Start the local app yourself.
- Verify the configured URL in a browser or with `curl`.
- Fix the route or server port instead of adding bootstrap logic to the tour.

## Missing Playwright Browser

If browser launch fails, install the required Playwright browser runtime for the project environment:

```bash
bun x playwright install chromium
```

Use the repo's documented browser install variant if it differs.

## Missing `ffmpeg`

Video muxing and poster generation depend on `ffmpeg`. Install it on the machine and rerun generation.

## Flow Validation

Use `demohunter generate <tour-file> --dry-run` while fixing selectors or app state. `--flow-only` is an alias. Dry runs skip narration and video work.

## Debug Artifacts

Failed collection, replay, and dry-run validation write debug artifacts under `.demohunter/<tour-id>/debug/`, including failure metadata, current page text when available, and a screenshot when Playwright can capture one.

## Doctor

Run `demohunter doctor` to check config loading, local media tools, Playwright browser availability, `baseURL`, writable output/cache directories, and only the selected narration provider's prerequisites.

## Invalid Tour Module

The tour file must default export an object with:

- string `id`
- string `title`
- function `run`

If the CLI reports an invalid export, compare the file against [../assets/tour.template.ts](../assets/tour.template.ts) and remove invented helper layers.

## Drift Between Docs And Code

When in doubt:

- inspect the current SDK surface in `packages/sdk/src/tour.ts` and `packages/sdk/src/runtime-types.ts`
- inspect the current CLI surface in `packages/cli/src/bin/demohunter.ts`
- re-run the repo checks from [cli.md](cli.md)
