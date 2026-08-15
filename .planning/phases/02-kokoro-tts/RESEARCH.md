# Phase 2: Kokoro TTS Research

**Completed:** 2026-07-18  
**Status:** Implemented

## Recommendation

Kokoro-82M is an Apache-2.0 open-weight model with 82 million parameters, nine supported language settings, and a reported TTS Arena Elo of 1424. Add it as an opt-in local provider behind a small TypeScript adapter and a user-provisioned external worker. Use a long-lived, line-delimited JSON (JSONL) protocol over stdin/stdout; let the worker write a 24 kHz WAV to a caller-controlled staging path; return the file through the existing `NarrationSynthesisOutput` `{ kind: "file" }` seam. DemoHunter must not install Python, download models or voices, or bundle weights. Missing runtime dependencies or assets should fail with actionable setup diagnostics.

The implemented reference worker uses `kokoro-onnx` because its explicit ONNX model and voices files fit DemoHunter's no-download generation boundary. The official Python `kokoro` package and `KPipeline` remain a valid user-owned adapter option, but they are not invoked by the bundled worker. The wire protocol stays backend-neutral so either runtime can be substituted without changing `tts-core` or generator orchestration.

## Execution Choice

Use an external process rather than Bun FFI or an in-process Python bridge:

- Spawn an argv array without a shell and keep one worker alive for a generation run so model initialization is amortized.
- Reserve stdout for one JSON response per request; send logs only to stderr.
- Assign every request an ID and require the response ID to match. Process one request at a time initially; concurrency can be added only after the worker contract supports it explicitly.
- Apply startup, request, and shutdown timeouts; cap JSONL line size; treat malformed output, early exit, or duplicate responses as provider errors.
- Create the destination under a DemoHunter-owned temporary/staging directory. Reject returned paths outside that directory, symlinks that escape it, empty files, non-WAV output, and any reported format/sample rate other than WAV/24,000 Hz.
- Remove partial staging files on failure and terminate the worker on cancellation. Do not pass secrets or the whole environment/config in the JSON message.

This boundary contains Python crashes and dependency conflicts while preserving the Bun/TypeScript OSS core.

## Worker I/O Contract

The transport should be versioned independently from the narration cache. A minimal request is:

```json
{"protocol":1,"id":"segment-id","op":"synthesize","text":"Welcome","model":"kokoro-82m-v1","voice":"voice-id","language":"language-code","speed":1,"format":"wav","sampleRate":24000,"outputPath":"/absolute/staging/segment.wav"}
```

Success and failure responses are respectively:

```json
{"protocol":1,"id":"segment-id","ok":true,"path":"/absolute/staging/segment.wav","format":"wav","sampleRate":24000}
{"protocol":1,"id":"segment-id","ok":false,"error":{"code":"MISSING_ASSET","message":"Configured Kokoro asset is unavailable"}}
```

Treat `model`, `voice`, language, speed, and the local asset/version fingerprint as cache identity inputs. The configured model name or `providerOptions` must identify the actual local model and voice assets before cache lookup; otherwise replacing weights in place could incorrectly reuse old audio. Worker-command paths and temporary output paths are runtime details and must not enter cache identity.

Kokoro's supported output is WAV at 24 kHz, so the provider should reject other requested formats/sample rates rather than write WAV bytes under another extension. The official pipeline does not establish an instruction-following contract in the reviewed material; use an empty Kokoro default and reject unsupported non-empty `instructions` instead of silently claiming they were honored.

## Integration With Current Code

The current architecture already provides most of the required boundary:

- `tts-core` normalizes requests and keys the cache by provider, model, voice, instructions, language, format, sample rate, provider options, and text.
- `NarrationSynthesisOutput` already supports a local file path.
- The cache copies provider files atomically, measures duration with ffprobe, records byte size and SHA-256, detects corrupt entries, and permits offline regeneration on cache hits.
- `resolve-narration.ts` already defaults unknown audio formats to 24 kHz, but Kokoro should make the fixed WAV/24 kHz constraint explicit rather than rely on that fallback.

Planning therefore needs a `kokoro` provider/config branch, a worker lifecycle adapter, strict protocol validation, provider-specific defaults, dependency diagnostics, and tests. It should not add a second cache or audio-duration implementation.

## Installation and Ownership

For DemoHunter's bundled reference worker, document these user-owned prerequisites:

- Python `>=3.10,<3.14` (the current `kokoro-onnx` package constraint).
- Separately installed `kokoro-onnx` and `soundfile` Python packages.
- Locally available ONNX model and voices assets appropriate to the selected backend.

DemoHunter should only validate these prerequisites (for example through `doctor`/worker preflight). It must never run `pip`, a package manager, Hugging Face download, or an asset installer during `generate`. No weights or voices should be committed to or published with the npm workspace.

The official `kokoro` 0.9.4 backend instead requires Python `>=3.10,<3.13`, the `kokoro` and `soundfile` packages, and platform `espeak-ng` support. It can be exposed through a compatible external DemoHunter worker, but any package or asset acquisition must happen before `generate` and remain under user control.

## Piper Comparison

| Area | Kokoro | Piper |
|---|---|---|
| License | Kokoro-82M is Apache-2.0 | Current `OHF-Voice/piper1-gpl` is GPL-3.0 |
| Runtime | Official Python `KPipeline`; 82M parameters | CLI, web server, Python, and C++ surfaces via `piper-tts` |
| System/assets | Python, `soundfile`, `espeak-ng`; local model/voice availability remains the user's responsibility | ONNX voice plus JSON config; legacy CLI accepts text or JSON on stdin and writes WAV |
| Adapter fit | Needs a small JSONL worker contract | Legacy stdin/WAV behavior demonstrates the subprocess pattern directly |
| Phase choice | Preferred: matches the requested model and permissive model license | Do not make it the default in this phase; GPL distribution implications require a separate deliberate decision |

Piper is useful precedent for process isolation and streaming requests, not a reason to couple DemoHunter to its CLI contract. The DemoHunter JSONL protocol should remain owned and versioned by DemoHunter so either engine can implement it.

## Planning/Test Requirements

1. Extend SDK and `tts-core` provider unions/config resolution without changing OpenAI or ElevenLabs defaults.
2. Implement worker startup/preflight, sequential request correlation, timeout/cancellation, stderr capture, and graceful/forced shutdown.
3. Validate staging-path confinement and WAV/24 kHz output before returning `{ kind: "file" }` to the existing cache.
4. Cover cached offline regeneration with the worker unavailable, cache miss with missing dependencies/assets, corrupt output recovery, malformed JSONL, wrong IDs, worker crashes, timeouts, and paths outside staging.
5. Prove generation performs no package/model/voice downloads and does not publish weights in npm artifacts.

## Sources

- [Official Kokoro-82M model card](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/README.md)
- [kokoro 0.9.4 on PyPI](https://pypi.org/project/kokoro/0.9.4/)
- [Official hexgrad/kokoro repository](https://github.com/hexgrad/kokoro)
- [kokoro-onnx repository](https://github.com/thewh1teagle/kokoro-onnx)
- [Current OHF-Voice Piper repository](https://github.com/OHF-Voice/piper1-gpl)

Project contracts inspected: `packages/tts-core/src/contracts.ts`, `packages/tts-core/src/cache/cache-store.ts`, `packages/tts-core/src/cache/cache-key.ts`, `packages/sdk/src/config.ts`, `packages/cli/src/config/load-config.ts`, and `packages/generator-playwright/src/narration/resolve-narration.ts`.
