---
phase: 02-kokoro-tts
plan: master
type: implementation
wave: 1
depends_on: []
autonomous: true
requirements:
  - USER-1
  - USER-2
  - USER-3
  - USER-4
  - USER-5
---

<objective>
Add Kokoro as an opt-in, local-only narration provider while preserving OpenAI as the default, ElevenLabs compatibility, portable cache metadata, and fully offline cache hits. The implementation uses a generic provider registry, a private TypeScript Kokoro adapter, and a bundled weight-free Python JSONL reference worker that uses user-provided `kokoro-onnx` model and voices files.

This plan follows the external-process recommendation and fixed WAV/24 kHz contract in [RESEARCH.md §Recommendation](./RESEARCH.md#recommendation) and [§Worker I/O Contract](./RESEARCH.md#worker-io-contract), reuses the existing atomic cache/file-output seam from [§Integration With Current Code](./RESEARCH.md#integration-with-current-code), and enforces the no-install/no-download boundary from [§Installation and Ownership](./RESEARCH.md#installation-and-ownership).
</objective>

<master_plan_contract>
The user explicitly requires one master artifact at `.planning/phases/02-kokoro-tts/PLAN.md`; therefore this file intentionally contains five independently executable subplans instead of separate `*-PLAN.md` files. Each subplan has its own files, must-haves, key links, tests, commit, and push gate. Execute them in order and never combine their commits.
</master_plan_contract>

<requirement_mapping>
- `USER-1` → the user's numbered unit 1: arbitrary-string TTS plugin interface, registry, capabilities, cache-safe preparation, and backward-compatible OpenAI/ElevenLabs plugins with OpenAI default.
- `USER-2` → unit 2: private Kokoro JSONL worker adapter/reference worker, fixed WAV/24 kHz, asset/version identity, safe process lifecycle, cleanup, and hostile-boundary tests.
- `USER-3` → unit 3: provider-neutral generator registry resolution, SDK `kokoroTTS`, config compatibility, ownership, and cancellation plumbing.
- `USER-4` → unit 4: CLI registration/bundling, actionable doctor checks, published reference-worker asset, and real documentation/config paths.
- `USER-5` → unit 5: full verification, packed-CLI installation audit, and deep zero-findings review loop.

These are standalone plan-local requirement identifiers because no roadmap requirement IDs were provided. Do not invent or edit roadmap requirements.
</requirement_mapping>

<execution_rules>
- Before a subplan, read every path in its `<read_first>` and preserve unrelated user changes.
- After every subplan run `bun run typecheck && bun test`, then `git diff --check`.
- Stage only the explicit paths listed by that subplan; never use update-all, repository-wide, or broad-glob staging.
- Before committing, run `git diff --cached --name-only` and confirm every staged path belongs to the current subplan; unstage anything else without discarding it.
- Commit with the exact subplan message and `git push` before continuing.
- Never run a shell for a worker, package manager/downloader for Kokoro, or place runtime paths/secrets in portable narration metadata.
</execution_rules>

<subplans>

<subplan id="02-01" requirement="USER-1" commit="feat(tts-core): add provider plugin registry">
  <name>Provider plugin contract, capabilities, offline identity seam, and legacy conversions</name>
  <files>
    packages/tts-core/src/contracts.ts
    packages/tts-core/src/contracts.test.ts
    packages/tts-core/src/provider-registry.ts
    packages/tts-core/src/provider-registry.test.ts
    packages/tts-core/src/cache/cache-key.ts
    packages/tts-core/src/cache/cache-key.test.ts
    packages/tts-core/src/cache/cache-store.ts
    packages/tts-core/src/cache/cache-store.test.ts
    packages/tts-core/src/index.ts
    packages/tts-openai/src/openai-provider.ts
    packages/tts-openai/src/openai-provider.test.ts
    packages/tts-openai/src/index.ts
    packages/tts-elevenlabs/src/elevenlabs-provider.ts
    packages/tts-elevenlabs/src/elevenlabs-provider.test.ts
    packages/tts-elevenlabs/src/index.ts
  </files>
  <read_first>
    AGENTS.md
    .planning/phases/02-kokoro-tts/RESEARCH.md
    packages/tts-core/src/contracts.ts
    packages/tts-core/src/cache/cache-key.ts
    packages/tts-core/src/cache/cache-store.ts
    packages/tts-openai/src/openai-provider.ts
    packages/tts-elevenlabs/src/elevenlabs-provider.ts
  </read_first>
  <key_links>
    - `resolveNarrationFromCache` → registry `resolve(provider)` → plugin `prepareRequest(context)` → capability validation → cache key/read → plugin `synthesize` only on miss.
    - `NarrationSynthesisOutput.kind === "file"` → cache-store copy/ffprobe/persist → output `finalize(outcome)` in `finally` on success or every failure.
    - OpenAI/ElevenLabs plugin exports → legacy `createOpenAINarrationProvider` / `createElevenLabsNarrationProvider` wrappers.
  </key_links>
  <must_haves>
    - Core provider names are arbitrary non-empty strings; duplicate and unknown provider errors are deterministic/actionable.
    - Every plugin declares capabilities with mandatory fields: `offlineSynthesis: boolean`, `languages`, `outputFormats`, `sampleRates`, and `instructions`. `offlineSynthesis` describes whether the provider can synthesize without network access; cache-hit availability is separate core cache behavior and is never encoded as a provider capability.
    - OpenAI and ElevenLabs declare `offlineSynthesis: false` and `languages: "provider-defined"`; their preparation and request tests prove arbitrary authored language strings pass through exactly as before. Only providers with a finite documented allowlist validate exact language codes.
    - `prepareRequest` receives cache-directory and AbortSignal context, runs before key lookup, cannot change provider identity, and produces the exact semantic request used for keying, synthesis, and portable metadata.
    - A cache hit may resolve while any provider is unavailable, regardless of `offlineSynthesis`; a cache miss invokes provider synthesis and follows that provider's capability/runtime requirements.
    - File synthesis outputs support an idempotent async `finalize({ status: "persisted" | "failed", error? })`; cache-store invokes it exactly once in `finally` after copy, ffprobe, and metadata persistence on both success and failure, while preserving the primary error and aggregating a finalize error without replacing it.
    - OpenAI remains the SDK/CLI default; existing public factories and OpenAI/ElevenLabs payload semantics remain compatible.
  </must_haves>
  <action>
    Implement `NarrationProviderPlugin`, explicit capabilities, prepare/synthesize/lifecycle contexts, arbitrary provider strings, and the non-global `createNarrationProviderRegistry` API. Make registry close idempotent and aggregate close failures while preserving a caller's primary error. Refactor cache resolution so preparation precedes identity lookup and add the file-finalize `finally` contract. Convert OpenAI/ElevenLabs to plugins and keep their old factories as wrappers. Add tests for arbitrary/blank/duplicate/unknown names, every capability dimension, preparation-before-keying, deterministic provider options, cache hit without synthesis, AbortSignal forwarding, finalize after success/copy/ffprobe/persist failure, primary+finalize error aggregation, idempotent close, and legacy factory behavior.
  </action>
  <verify>
    bun test packages/tts-core packages/tts-openai packages/tts-elevenlabs
    bun run typecheck && bun test
    git diff --check
    git diff --cached --name-only
  </verify>
  <commit_and_push>
    Stage only the 15 paths in this subplan's `<files>` list, inspect staged names, then:
    `git commit -m "feat(tts-core): add provider plugin registry" && git push`
  </commit_and_push>
</subplan>

<subplan id="02-02" requirement="USER-2" commit="feat(tts-kokoro): add isolated JSONL worker provider">
  <name>Private Kokoro adapter, production weight-free worker, offline identity sidecar, and media validation</name>
  <files>
    package.json
    tsconfig.json
    packages/tts-kokoro/package.json
    packages/tts-kokoro/tsconfig.json
    packages/tts-kokoro/src/protocol.ts
    packages/tts-kokoro/src/identity-sidecar.ts
    packages/tts-kokoro/src/wave.ts
    packages/tts-kokoro/src/worker-client.ts
    packages/tts-kokoro/src/kokoro-provider.ts
    packages/tts-kokoro/src/index.ts
    packages/tts-kokoro/src/identity-sidecar.test.ts
    packages/tts-kokoro/src/wave.test.ts
    packages/tts-kokoro/src/worker-client.test.ts
    packages/tts-kokoro/src/kokoro-provider.test.ts
    packages/tts-kokoro/worker/demohunter_kokoro_worker.py
    packages/tts-kokoro/worker/test_backend_stub.py
    packages/tts-kokoro/test/fixtures/jsonl-worker.ts
  </files>
  <read_first>
    .planning/phases/02-kokoro-tts/RESEARCH.md
    package.json
    tsconfig.json
    packages/tts-core/src/contracts.ts
    packages/tts-core/src/provider-registry.ts
    packages/tts-core/src/cache/cache-store.ts
    packages/tts-openai/package.json
  </read_first>
  <key_links>
    - Normalized model/voices path tuple → SHA-256 locator → local cache sidecar → last verified content digests → prepared portable request → narration cache key.
    - Kokoro plugin → no-shell FIFO worker client → versioned JSONL request → untrusted staging output → `O_NOFOLLOW` handle validation → trusted sealed provider-owned WAV → cache-store file output/finalize cleanup.
    - Bundled Python reference worker → explicit `--model` and `--voices` local paths → separately installed `kokoro-onnx` runtime → JSONL only on stdout/logging only on stderr.
  </key_links>
  <must_haves>
    - `packages/tts-kokoro` is `private: true`; it contains adapter/worker code but no weights, voices, environment, downloader, or audio artifact.
    - Kokoro capabilities are exactly `offlineSynthesis: true`, `languages: ["en-us","en-gb","es","fr","hi","it","ja","pt-br","zh"]`, `outputFormats: ["wav"]`, `sampleRates: [24000]`, and `instructions: "unsupported"`. Its local synthesis capability is independent from the core behavior that any valid cache hit can resolve with the provider unavailable.
    - Unsupported/blank language, non-empty instructions, non-WAV, non-24kHz, invalid speed, missing assets, and incompatible versions fail before unsafe synthesis; every supported language is covered.
    - Portable cache metadata contains content SHA-256 values for model, voices, backend version, and protocol only; it never contains plain executable, argv, cwd, environment, asset, staging, or output paths.
    - Offline identity uses a local, non-portable sidecar under the cache root keyed by SHA-256 of the normalized absolute model/voices path tuple. Sidecars contain schema/backend/protocol plus last verified digests and atomic-write metadata, but no path is copied into narration metadata.
    - If both assets exist, recompute bytes every preparation and atomically replace the sidecar before key lookup. Replacement in place changes digest and cache key. Synthesis re-verifies current bytes against the prepared digests immediately before spawning.
    - If assets are absent, a single valid sidecar for the exact locator may supply last verified digests only to locate a valid existing cache hit. This identity is explicitly stale/unverified and must never authorize synthesis. Missing/invalid/schema-version-mismatched/backend-mismatched sidecar is unusable; conflicting records or partial asset presence are ambiguous and fail closed. Cache miss/corruption always requires present, freshly verified assets.
    - Worker output validation closes TOCTOU: after the worker response has completed and its writer is closed, use `O_RDONLY|O_NOFOLLOW` where the platform supports it, `fstat` the opened handle, keep all reads on that handle, validate it, copy bytes from that handle into a newly created `O_CREAT|O_EXCL` mode-0600 provider-owned sealed file, fsync/close it, and return only the sealed file with an idempotent finalize hook that removes the entire staging root. Where `O_NOFOLLOW` is unavailable, perform `lstat` before open and compare the opened handle's `fstat` device/inode/type to the pre-open record; require the same regular file and fail closed when stable identity cannot be established.
    - RIFF parsing walks actual chunks with padding/bounds checks and requires `RIFF`/`WAVE`, exactly one valid `fmt ` and non-empty `data`, 24,000 Hz, positive/sane channels, internally consistent byte rate/block alignment/bits, and PCM or IEEE-float encoding supported by ffmpeg. Header-only, truncated, duplicate/conflicting chunks and a worker lying about sample rate/format fail.
  </must_haves>
  <action>
    Create the private package and TypeScript project reference. Implement strict protocol-v1 validators, bounded JSONL lines/stderr, separate startup/request/shutdown timeouts, request IDs, FIFO concurrency one, cancellation, crash/duplicate/wrong-ID handling, graceful then forced close, and shell-free `spawn(executable, argv, { shell: false })`. Implement the sidecar rules and atomic refresh. Implement robust RIFF/WAVE parsing plus handle-based sealing/finalization.

    Ship `worker/demohunter_kokoro_worker.py` as the production weight-free reference artifact. It accepts explicit local `--model` and `--voices` paths, imports the separately user-installed `kokoro-onnx` Python package, never downloads, emits protocol JSON only to stdout, and logs to stderr. Structure its backend behind a small injectable module/class so `worker/test_backend_stub.py` can test protocol, Unicode, fixed 24 kHz output, errors, and shutdown without Kokoro or weights.

    Test all supported/unsupported languages, Unicode/newlines, FIFO, cancellation, each timeout, crash/stderr, malformed/oversized/version/duplicate/wrong-ID protocol, missing runtime/assets, sidecar valid/stale/ambiguous/corrupt/version cases, absent-assets cache hit, absent-assets miss, replacement-in-place, portable metadata redaction, symlink/path escape, TOCTOU swap attempts, empty/truncated/lying/malformed WAV, finalize cleanup, and corrupt-cache recovery. Add platform-guarded tests for both native `O_NOFOLLOW` and the lstat/open/fstat fallback, including inode replacement and platforms that cannot establish identity.
  </action>
  <verify>
    bun test packages/tts-kokoro
    bun run typecheck && bun test
    git diff --check
    git diff --cached --name-only
  </verify>
  <commit_and_push>
    Stage only the 17 paths in this subplan's `<files>` list, inspect staged names, then:
    `git commit -m "feat(tts-kokoro): add isolated JSONL worker provider" && git push`
  </commit_and_push>
</subplan>

<subplan id="02-03" requirement="USER-3" commit="feat(generator): resolve narration through provider registry">
  <name>Provider-neutral generator, SDK helper, config compatibility, ownership, and cancellation</name>
  <files>
    packages/sdk/src/config.ts
    packages/sdk/src/config.test.ts
    packages/sdk/src/index.ts
    packages/cli/src/config/load-config.ts
    packages/cli/src/config/load-config.test.ts
    packages/generator-playwright/package.json
    packages/generator-playwright/tsconfig.json
    packages/generator-playwright/src/narration/resolve-narration.ts
    packages/generator-playwright/src/narration/resolve-narration.test.ts
    packages/generator-playwright/src/execute/generator-types.ts
    packages/generator-playwright/src/execute/collect-timeline.ts
    packages/generator-playwright/src/execute/collect-timeline.test.ts
    packages/generator-playwright/src/execute/replay-timeline.ts
    packages/generator-playwright/src/generate.ts
    packages/generator-playwright/src/generate.test.ts
    packages/generator-playwright/src/smoke-generate.ts
    packages/generator-playwright/src/smoke-generate.test.ts
  </files>
  <read_first>
    packages/sdk/src/config.ts
    packages/cli/src/config/load-config.ts
    packages/generator-playwright/package.json
    packages/generator-playwright/tsconfig.json
    packages/generator-playwright/src/narration/resolve-narration.ts
    packages/generator-playwright/src/execute/collect-timeline.ts
    packages/generator-playwright/src/generate.ts
    packages/generator-playwright/src/smoke-generate.ts
    packages/tts-core/src/provider-registry.ts
  </read_first>
  <key_links>
    - SDK `kokoroTTS(options)` defaults `worker: "bundled"` → authored provider-neutral config → backward-compatible CLI loader → CLI resolves the bundled worker and creates the CLI-owned plugin registry (unit 4).
    - Generate input `signal` → collect timeline → narration resolver → cache preparation/synthesis context → Kokoro queue/worker.
    - Caller-provided registry ownership remains with caller; optional legacy factory creates an internal compatibility registry owned/closed only by generator.
  </key_links>
  <must_haves>
    - `kokoroTTS` is an SDK-only typed config helper and imports no process/provider implementation.
    - Missing `tts`/provider and legacy OpenAI configs resolve exactly to OpenAI defaults; ElevenLabs retains its default merge; unknown providers are not silently coerced to OpenAI.
    - `generator-playwright` has no concrete OpenAI, ElevenLabs, or Kokoro dependency/import in `package.json`, `tsconfig.json`, source, or built declarations. It resolves only through `@demohunter/tts-core` registry contracts supplied by its caller.
    - Generator never closes a caller-owned registry. It closes only a registry it created via the documented legacy compatibility factory, and that close is idempotent.
    - On generation failure plus close failure, the generation failure remains primary and the close failure is attached/aggregated; success plus close failure reports the close failure. Tests cover all ownership/error combinations.
    - AbortSignal is threaded end-to-end through full and smoke generation, collect/replay/narration/cache/worker. Cancellation removes queued requests, terminates the active worker safely, finalizes staging, closes only owned resources, and surfaces an abort error rather than continuing browser/media work.
  </must_haves>
  <action>
    Generalize SDK TTS typing while preserving typed OpenAI/ElevenLabs shapes and arbitrary language pass-through for both cloud providers. Add `KokoroTTSConfig` and `kokoroTTS` with provider `kokoro`, WAV/24 kHz, empty instructions, exact language typing, model/voices paths, backend version, speed, and optional timeouts. Its default is `worker: "bundled"`; accept a separate `pythonCommand: string` and literal `pythonArgs: string[]`, plus an explicit custom worker file path only as an opt-in alternative. Never accept one combined shell command. Keep all runtime paths outside request `providerOptions`.

    Update config loading for Kokoro and arbitrary providers without changing old defaults. Remove concrete provider imports and dependencies from generator package config/source. Require a caller registry in the normal path; retain compatibility only through an injected legacy factory that creates a clearly internally-owned registry. Thread registry and AbortSignal across generator types and both generation paths. Move ElevenLabs request-option semantics into its plugin so narration resolution is provider-neutral. Test custom provider resolution, no concrete deps, lifecycle ownership, close aggregation, fixed Kokoro capabilities, old fixtures, and cancellation during queued/active narration.
  </action>
  <verify>
    bun test packages/sdk packages/cli/src/config packages/generator-playwright
    bun run typecheck && bun test
    git diff --check
    git diff --cached --name-only
  </verify>
  <commit_and_push>
    Stage only the 17 paths in this subplan's `<files>` list, inspect staged names, then:
    `git commit -m "feat(generator): resolve narration through provider registry" && git push`
  </commit_and_push>
</subplan>

<subplan id="02-04" requirement="USER-4" commit="feat(cli): register and diagnose Kokoro TTS">
  <name>CLI-owned registry, private-package bundling, doctor, reference-worker publishing, and docs</name>
  <files>
    packages/cli/package.json
    packages/cli/tsup.config.ts
    packages/cli/scripts/sync-kokoro-worker.mjs
    packages/cli/src/commands/generate.ts
    packages/cli/src/commands/generate.test.ts
    packages/cli/src/commands/doctor.ts
    packages/cli/src/commands/doctor.test.ts
    packages/cli/templates/starter/demohunter.config.ts
    packages/cli/skills/demohunter/SKILL.md
    packages/cli/skills/demohunter/references/authoring.md
    packages/cli/skills/demohunter/references/cli.md
    packages/cli/skills/demohunter/references/troubleshooting.md
    README.md
    docs/getting-started.md
    docs/troubleshooting.md
    examples/vite-demo/demohunter.config.ts
  </files>
  <read_first>
    packages/cli/package.json
    packages/cli/tsup.config.ts
    packages/cli/src/commands/generate.ts
    packages/cli/src/commands/doctor.ts
    packages/cli/templates/starter/demohunter.config.ts
    packages/cli/skills/demohunter/SKILL.md
    packages/cli/skills/demohunter/references/authoring.md
    packages/cli/skills/demohunter/references/cli.md
    packages/cli/skills/demohunter/references/troubleshooting.md
    README.md
    docs/getting-started.md
    docs/troubleshooting.md
    packages/tts-kokoro/package.json
    packages/tts-kokoro/src/index.ts
    packages/tts-kokoro/worker/demohunter_kokoro_worker.py
  </read_first>
  <key_links>
    - CLI generate invocation → fresh CLI-owned registry → register OpenAI/ElevenLabs/Kokoro → provider-neutral generator → CLI `finally` closes its registry exactly once.
    - Private `@demohunter/tts-kokoro` source → tsup `noExternal`/bundle configuration → CLI dist with no runtime workspace dependency.
    - Canonical production Python worker in `packages/tts-kokoro/worker/` → deterministic build/prepack copy script → ignored `packages/cli/dist/workers/demohunter_kokoro_worker.py` → CLI tarball's existing `dist` file surface.
    - CLI module/bin `import.meta.url` → ordered bundled-worker candidates valid from both `dist/index.js` and `dist/bin/demohunter.js` → separate Python command and literal argv.
    - Resolved Kokoro config → provider-aware doctor preflight → actionable JSON checks.
  </key_links>
  <must_haves>
    - CLI owns and closes every registry it creates; generator treats it as caller-owned and does not close it. Primary generation errors survive registry-close errors, which are aggregated and tested.
    - `@demohunter/tts-kokoro` stays private/dev-time and is bundled into CLI output. Packed CLI `package.json` has no `workspace:*` or runtime `@demohunter/tts-kokoro` dependency.
    - The canonical worker remains only in `packages/tts-kokoro/worker/demohunter_kokoro_worker.py`. A deterministic CLI build/prepack script overwrites the ignored generated copy at `packages/cli/dist/workers/demohunter_kokoro_worker.py`; do not list that generated output as a committed file. `packages/cli/files` already publishes `dist`, and CLI clean removes the generated copy by removing `dist`.
    - Build/pack tests compare source and generated-worker hashes, prove a second copy overwrites stale output deterministically, and prove build/pack leaves clean git status because the generated destination is ignored.
    - `kokoroTTS` defaults to `worker: "bundled"`. CLI resolves candidates relative to its own `import.meta.url` for both library entry (`dist/index.js`) and executable entry (`dist/bin/demohunter.js`), then spawns `pythonCommand` with the literal argv `[...pythonArgs, workerPath, "--model", modelPath, "--voices", voicesPath, ...providerArgs]`. No shell participates. An explicit custom worker file remains an opt-in setting and follows the same separate-command/argv rule.
    - Doctor checks only the selected provider. Kokoro reports executable, Python/backend protocol version, separately installed `kokoro-onnx`, model, voices, dependencies, WAV/24 kHz, supported language, and staging status with no OpenAI warning.
    - Doctor/init/generate never install or download anything; messages explain exact user-owned setup. Worker executable and argv remain separate, and a metacharacter argument test proves no shell parsing.
    - Canonical user documentation is updated consistently across `README.md`, `docs/getting-started.md`, `docs/troubleshooting.md`, and the packaged CLI skill `SKILL.md` plus its authoring/CLI/troubleshooting references. These paths document `kokoroTTS`, exact languages, WAV/24 kHz, sidecar/offline/cache-corruption semantics, Python/runtime/assets, bundled/custom worker selection, doctor, error codes, cancellation/timeouts, no downloads, and no bundled weights.
  </must_haves>
  <action>
    Register built-in plugins in a fresh CLI-owned registry and pass it into smoke/full generation with correct error/close aggregation. Bundle the private TS adapter through tsup. Add a deterministic build/prepack copy script that takes the canonical production Python worker from `packages/tts-kokoro/worker`, overwrites `packages/cli/dist/workers/demohunter_kokoro_worker.py`, and verifies byte/hash equality. Keep the generated destination ignored and rely on the existing published `dist` surface; clean removes `dist`. Do not expose or pack `packages/tts-kokoro` separately.

    Implement bundled worker discovery from candidates relative to the executing CLI module's `import.meta.url`, covering both `dist/index.js` and `dist/bin/demohunter.js`. Construct the process call from separate `pythonCommand`, literal `pythonArgs`, discovered/custom worker file, explicit `--model`/`--voices` values, and provider args. Test source-tree execution, built output, packed tarball, clean temporary installation, and global-style invocation through the installed `demohunter` bin.

    Make doctor provider-aware with strict Kokoro preflight and actionable missing-runtime/dependency/asset/protocol/version/format/language messages. Update only the existing documentation paths listed above and keep examples opt-in/default OpenAI. Add CLI tests for registration, ownership, close failures, malicious argv, every doctor failure, worker discovery/copy/hash/clean-status behavior, source/built/packed/installed/global-bin execution, and no unrelated credential warning.
  </action>
  <verify>
    bun test packages/cli
    bun run typecheck && bun test
    bun run build
    git diff --check
    git diff --cached --name-only
  </verify>
  <commit_and_push>
    Stage only the 16 unique paths in this subplan's `<files>` list, inspect staged names, then:
    `git commit -m "feat(cli): register and diagnose Kokoro TTS" && git push`
  </commit_and_push>
</subplan>

<subplan id="02-05" requirement="USER-5" commit="test(kokoro): enforce OSS packaging and runtime boundaries">
  <name>Packed CLI install contract, OSS/no-download audit, full verification, and zero-findings review</name>
  <files>
    tests/e2e/kokoro-package-contract.test.ts
    tests/e2e/kokoro-oss-boundary.test.ts
    tests/e2e/kokoro-cancellation-contract.test.ts
  </files>
  <read_first>
    package.json
    packages/cli/package.json
    packages/cli/tsup.config.ts
    packages/cli/scripts/sync-kokoro-worker.mjs
    packages/tts-core/src/provider-registry.ts
    packages/tts-core/src/cache/cache-store.ts
    packages/tts-kokoro/src/identity-sidecar.ts
    packages/tts-kokoro/src/wave.ts
    packages/tts-kokoro/src/worker-client.ts
    packages/tts-kokoro/src/kokoro-provider.ts
    packages/tts-kokoro/worker/demohunter_kokoro_worker.py
    packages/generator-playwright/src/generate.ts
    packages/cli/src/commands/generate.ts
    packages/cli/src/commands/doctor.ts
    README.md
  </read_first>
  <key_links>
    - Source-tree CLI, built `dist/index.js`, built `dist/bin/demohunter.js`, CLI tarball, clean temporary npm install, and global-style installed bin → identical bundled-worker discovery with no workspace present.
    - No-network fake worker → uncached generate → cache metadata/sidecar inspection → remove runtime/assets → cached generate → corrupt cache → actionable miss failure.
    - Generation AbortSignal → narration queue/active worker → process termination → output finalize → registry ownership cleanup → no orphan/staging artifact.
  </key_links>
  <must_haves>
    - Only the packed CLI is audited; do not npm-pack the private `tts-kokoro` package.
    - Test bundled-worker discovery from source, built library entry, built bin entry, packed tarball, clean temporary install without workspace links, and a global-style invocation of the installed `demohunter` bin. Every path locates the same hashed worker bytes and proves no unresolved `@demohunter/tts-kokoro` runtime dependency.
    - Tarball manifest contains code/docs/weight-free worker only: no model, voices, WAV, sidecar, cache, virtualenv, secrets, or absolute local paths.
    - E2E guards fail on package-manager/downloader/network attempts for Kokoro assets and prove cached offline use, corrupt-cache recovery, sidecar staleness, replacement-in-place identity, metadata redaction, and no downloads.
    - Cancellation E2E proves abort reaches the worker, queued requests never start, active process terminates, finalize runs, caller-owned registry closes only in CLI, primary error remains visible, and no process/staging files remain.
    - Three deep-review passes—API/cache/backward compatibility; worker/protocol/WAV/path/cancellation security; packaging/docs/OSS boundary—repeat fixes/tests until each has zero findings. No blocker/warning is deferred.
  </must_haves>
  <action>
    Add the three e2e contracts. Exercise worker discovery in the source tree and both built entry layouts. Build and pack only `packages/cli`, install its tarball into a `mktemp` project with the workspace unavailable, and exercise both exported CLI and global-style installed-bin worker discovery. Assert the ignored generated worker equals the canonical source hash and build/pack leaves clean git status. Instrument process/network calls to reject forbidden installers/downloaders. Exercise offline sidecar/cache, corrupt recovery, metadata redaction, and end-to-end cancellation.

    Perform the three line-by-line review passes, fix every finding in its owning explicit path, and rerun focused tests until zero findings. If fixes touch earlier subplan files, stage those individual named files explicitly along with the three e2e files; list and inspect all staged names before commit. Do not use update-all staging.
  </action>
  <verify>
    bun test packages/tts-kokoro packages/tts-core packages/generator-playwright packages/cli
    bun test tests/e2e/kokoro-package-contract.test.ts tests/e2e/kokoro-oss-boundary.test.ts tests/e2e/kokoro-cancellation-contract.test.ts
    bun run typecheck && bun test
    bun run build
    npm pack --dry-run --json --workspace packages/cli
    git diff --check
    git diff --cached --name-only
  </verify>
  <commit_and_push>
    Stage the three listed e2e files plus only individually named review-fix files, inspect `git diff --cached --name-only`, confirm no unrelated path, then:
    `git commit -m "test(kokoro): enforce OSS packaging and runtime boundaries" && git push`
  </commit_and_push>
</subplan>

</subplans>

<artifacts_this_phase_produces>
- Generic `NarrationProviderPlugin`, exact capabilities, registry, lifecycle/cancellation contracts, and file-output finalize hook.
- Backward-compatible OpenAI/ElevenLabs plugins and factories.
- Private `@demohunter/tts-kokoro` adapter with protocol, local identity sidecar, RIFF parser, FIFO worker client, provider, and hostile-boundary tests.
- Weight-free production `demohunter_kokoro_worker.py` using explicit local `kokoro-onnx` assets plus a stubbed test backend.
- SDK `kokoroTTS`, provider-neutral generator registry input, and end-to-end AbortSignal plumbing.
- CLI-owned built-in registry, provider-aware doctor, bundled private adapter, and published weight-free worker asset.
- Packed-CLI installation, OSS-boundary, and cancellation e2e contracts.
</artifacts_this_phase_produces>

<verification>
Phase completion requires five separate pushed commits; every subplan's typecheck/full-test gate must pass before its commit. Final verification must prove exact Kokoro language/capability enforcement, safe offline sidecar identity, real WAV parsing and TOCTOU sealing, finalize/lifecycle ownership, end-to-end cancellation, provider-neutral generator dependencies, clean packed-CLI installation without workspace packages, no assets/downloads, and three review passes ending with zero findings.
</verification>

<success_criteria>
- A developer opts into Kokoro via `kokoroTTS`, supplies a Python runtime plus explicit local `kokoro-onnx` model/voices, passes doctor, and generates fixed WAV/24 kHz narration through one safe sequential worker.
- A valid cache hit works when worker/assets are absent through the local identity sidecar, while absent/corrupt/stale/ambiguous identity cannot authorize synthesis and replacement-in-place changes the key.
- Portable narration metadata contains stable semantic content digests only; runtime paths remain local and unportable.
- Malformed/lying/crashed/cancelled workers and hostile filesystem outputs fail closed, clean resources, and preserve primary errors.
- Existing OpenAI/ElevenLabs behavior remains compatible, OpenAI remains default, generator has no concrete provider dependency, and the packed CLI works outside the workspace.
- DemoHunter ships only a weight-free reference worker and never installs or downloads runtime packages, models, or voices.
</success_criteria>
