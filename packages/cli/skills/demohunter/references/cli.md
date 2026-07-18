# DemoHunter CLI Reference

## Supported Commands

The current CLI surface is:

- `demohunter init`
- `demohunter generate <tour-file>`
- `demohunter generate <tour-file> --dry-run`
- `demohunter generate <tour-file> --flow-only`
- `demohunter generate <tour-file> --cookie-dismiss reject|accept|hide`
- `demohunter generate <tour-file> --no-cookie-dismiss`
- `demohunter generate <tour-file> --cursor none|highlight|smooth|ripple`
- `demohunter generate <tour-file> --format standard|square|mobile|gif` (repeatable)
- `demohunter generate <tour-file> --format gif --duration <seconds>`
- `demohunter doctor`
- `demohunter cache list`
- `demohunter cache prune`
- `demohunter cache clear`
- `demohunter add-skill [--target claude|codex|both]`

Do not reference unimplemented commands or hosted workflows.

## Verification Flow

From the closest repo or consumer root:

1. Confirm the tour path is correct.
2. Ensure the target app is already reachable at the configured `baseURL`.
3. Run the local generate command for the edited tour.

Common command shapes:

```bash
bun x demohunter generate demos/your-tour.tour.ts
```

```bash
bun run build
bun test tests/skills/demohunter-skill-contract.test.ts
bun x tsc -b tsconfig.json --pretty false
```

Use the repo's existing package scripts when they already wrap the CLI. DemoHunter does not start the app for you.

## Output Expectations

A successful generate run writes portable artifacts under `.demohunter/<tour-id>/`, including:

- `video.mp4`
- `poster.jpg`
- `captions.srt`
- `captions.vtt`
- `manifest.json`
- `chapters.json`
- requested variants under `variants/<preset>/`

If narration is used, the output also includes exported audio assets and reuses cached narration when available.
Multi-format output uses manifest v2. Without format requests, the portable v1 layout remains unchanged.
