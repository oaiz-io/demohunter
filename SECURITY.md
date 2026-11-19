# Security policy

## Supported versions

DemoHunter is in early development. Security fixes are applied to the latest released version.

## Report a vulnerability

Do not open a public issue for a suspected vulnerability.

Request a private reporting channel through the [OAIZ contact page](https://oaiz.io/). Do not include vulnerability details or secrets in the first message. After a maintainer gives you a private channel, include:

- the affected version or commit;
- the impact;
- steps to reproduce the problem; and
- a suggested fix, if you have one.

The maintainers will confirm receipt, assess the report, and coordinate a fix and disclosure with you. Do not include real API keys, customer data, or other secrets in the report.

For normal bugs and support questions, use the public issue tracker.

## Scope

DemoHunter drives a browser against the `baseURL` in your `demohunter.config.ts`, shells out to `ffmpeg` and `ffprobe`, and sends narration text to the configured text-to-speech provider. It runs with the privileges of the user who invokes it. The CLI reads provider credentials from environment variables. DemoHunter Studio can also keep a provider key the user adds: in the macOS Keychain, or elsewhere in a per-user file with mode 0600. Studio sends a key only to its provider's API.

Reports worth sending:

- a TTS credential leaking into the narration cache, `manifest.json`, captions, logs, or any generated artifact;
- a saved Studio speech key leaking into an HTTP response, an error message, a child process environment, an MCP tool result, or a process command line, or being changed by a web page or another computer;
- writing outside the configured `outputDir` and `cacheDir`;
- a crafted tour or configuration causing execution of a program other than the browser and the configured media tools;
- cache poisoning: a narration cache entry being reused for text it was not generated from.
