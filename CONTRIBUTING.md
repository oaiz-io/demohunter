# Contributing to DemoHunter

Thank you for helping to improve DemoHunter. Bug reports, documentation fixes, tests, and focused features are welcome.

## Before you start

- Search the open issues before you create a new issue.
- For a large change, open an issue first. Explain the problem and the proposed scope.
- Keep the local-first OSS flow independent from hosted OAIZ products.
- Do not add credential storage. TTS credentials must come from environment variables.

## Local development

You need Bun, Node.js 20 or later, `ffmpeg`, `ffprobe`, and the Playwright Chromium runtime.

```sh
bun install
bun x playwright install chromium
bun run verify
```

Useful commands:

```sh
bun run build
bun run typecheck
bun test
```

The repository is a Bun workspace. The public `demohunter` package is in `packages/cli`. Internal packages are private workspace modules.

## Pull requests

1. Make one focused change.
2. Add or update tests for behavior changes.
3. Update public documentation when users must change how they use DemoHunter.
4. Run `bun run verify`.
5. Explain the reason for the change and how you tested it.

Keep generated `.demohunter/` files out of pull requests unless they are intentional project fixtures.

## Conduct

Be respectful and constructive. Focus reviews on the work, give clear reasons for requested changes, and assume good intent. Harassment and discriminatory behavior are not accepted.

## License

By submitting a contribution, you agree that it is licensed under the repository's [MIT License](LICENSE).
