import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  createNarrationCacheKey,
  createNarrationRequest,
  type NarrationProvider,
  type NarrationProviderPlugin,
  type NarrationRequest,
  type NarrationSynthesisFinalizeOutcome,
  type NarrationSynthesisResult,
} from "../index.js";
import { NARRATION_CACHE_SCHEMA_VERSION } from "./cache-key.js";
import { resolveNarrationFromCache } from "./cache-store.js";

describe("resolveNarrationFromCache", () => {
  test("returns persisted audio path and metadata on cache hit without invoking the provider again", async () => {
    const fixture = await createFixture();

    try {
      const provider = createProvider([
        new Uint8Array([1, 2, 3, 4]),
      ]);
      const first = await resolveNarrationFromCache({
        cacheDir: fixture.cacheDir,
        request: fixture.request,
        provider: provider.provider,
        measureDurationMs: async () => 1_250,
      });

      const second = await resolveNarrationFromCache({
        cacheDir: fixture.cacheDir,
        request: fixture.request,
        provider: provider.provider,
        measureDurationMs: async () => {
          throw new Error("cache hits must not remeasure audio");
        },
      });

      assert.equal(first.source, "provider");
      assert.equal(second.source, "cache");
      assert.equal(provider.callCount, 1);
      assert.equal(second.entry.audioPath, first.entry.audioPath);
      assert.equal(second.entry.metadataPath, first.entry.metadataPath);
      assert.equal(second.entry.byteSize, 4);
      assert.equal(second.entry.durationMs, 1_250);
      assert.deepEqual(second.entry.metadata.request, fixture.request);
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test("persists audio and integrity metadata under the configured cache root on misses", async () => {
    const fixture = await createFixture();

    try {
      const expectedBytes = new Uint8Array([7, 8, 9, 10]);
      const provider = createProvider([expectedBytes]);
      const measuredPaths: string[] = [];
      const result = await resolveNarrationFromCache({
        cacheDir: fixture.cacheDir,
        request: fixture.request,
        provider: provider.provider,
        measureDurationMs: async (audioPath) => {
          measuredPaths.push(audioPath);
          const audioBytes = await readFile(audioPath);

          assert.deepEqual([...audioBytes], [...expectedBytes]);

          return 987;
        },
        now: () => new Date("2026-04-11T09:15:00.000Z"),
      });

      const metadataText = await readFile(result.entry.metadataPath, "utf8");
      const metadata = JSON.parse(metadataText) as {
        key: string;
        version: number;
        createdAt: string;
        request: NarrationRequest;
        output: {
          format: string;
          audioPath: string;
          byteSize: number;
          durationMs: number;
          sha256: string;
        };
      };

      assert.equal(result.source, "provider");
      assert.equal(provider.callCount, 1);
      assert.equal(measuredPaths[0], result.entry.audioPath);
      assert.equal(metadata.key, result.entry.key);
      assert.equal(metadata.version, NARRATION_CACHE_SCHEMA_VERSION);
      assert.equal(metadata.createdAt, "2026-04-11T09:15:00.000Z");
      assert.deepEqual(metadata.request, fixture.request);
      assert.deepEqual(metadata.output, {
        format: fixture.request.format,
        audioPath: `${result.entry.key}.${fixture.request.format}`,
        byteSize: expectedBytes.byteLength,
        durationMs: 987,
        sha256: createHash("sha256").update(expectedBytes).digest("hex"),
      });
      assert.ok(result.entry.audioPath.startsWith(fixture.cacheDir));
      assert.ok(result.entry.metadataPath.startsWith(fixture.cacheDir));
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test("treats missing audio files as recoverable misses that can be regenerated", async () => {
    const fixture = await createFixture();

    try {
      const provider = createProvider([
        new Uint8Array([1, 1, 1]),
        new Uint8Array([2, 2, 2, 2]),
      ]);
      const initial = await resolveNarrationFromCache({
        cacheDir: fixture.cacheDir,
        request: fixture.request,
        provider: provider.provider,
        measureDurationMs: async () => 400,
      });

      await unlink(initial.entry.audioPath);

      const regenerated = await resolveNarrationFromCache({
        cacheDir: fixture.cacheDir,
        request: fixture.request,
        provider: provider.provider,
        measureDurationMs: async (audioPath) => {
          const bytes = await readFile(audioPath);

          assert.deepEqual([...bytes], [2, 2, 2, 2]);

          return 900;
        },
      });

      assert.equal(regenerated.source, "provider");
      assert.equal(provider.callCount, 2);
      assert.equal(regenerated.entry.byteSize, 4);
      assert.equal(regenerated.entry.durationMs, 900);
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test("treats unreadable metadata as a recoverable miss", async () => {
    const fixture = await createFixture();

    try {
      const provider = createProvider([
        new Uint8Array([3, 3, 3]),
        new Uint8Array([4, 4, 4]),
      ]);
      const initial = await resolveNarrationFromCache({
        cacheDir: fixture.cacheDir,
        request: fixture.request,
        provider: provider.provider,
        measureDurationMs: async () => 500,
      });

      await writeFile(initial.entry.metadataPath, "{bad json", "utf8");

      const regenerated = await resolveNarrationFromCache({
        cacheDir: fixture.cacheDir,
        request: fixture.request,
        provider: provider.provider,
        measureDurationMs: async (audioPath) => {
          const bytes = await readFile(audioPath);

          assert.deepEqual([...bytes], [4, 4, 4]);

          return 750;
        },
      });

      assert.equal(regenerated.source, "provider");
      assert.equal(provider.callCount, 2);
      assert.equal(regenerated.entry.durationMs, 750);
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test("treats integrity mismatches as recoverable misses", async () => {
    const fixture = await createFixture();

    try {
      const provider = createProvider([
        new Uint8Array([5, 5, 5, 5]),
        new Uint8Array([6, 6, 6, 6]),
      ]);
      const initial = await resolveNarrationFromCache({
        cacheDir: fixture.cacheDir,
        request: fixture.request,
        provider: provider.provider,
        measureDurationMs: async () => 640,
      });

      await writeFile(initial.entry.audioPath, new Uint8Array([9, 9, 9, 9]));

      const regenerated = await resolveNarrationFromCache({
        cacheDir: fixture.cacheDir,
        request: fixture.request,
        provider: provider.provider,
        measureDurationMs: async (audioPath) => {
          const bytes = await readFile(audioPath);

          assert.deepEqual([...bytes], [6, 6, 6, 6]);

          return 880;
        },
      });

      assert.equal(regenerated.source, "provider");
      assert.equal(provider.callCount, 2);
      assert.equal(regenerated.entry.durationMs, 880);
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test("prepares the exact request before key lookup and uses it for synthesis and portable metadata", async () => {
    const fixture = await createFixture();
    const preparedRequests: NarrationRequest[] = [];
    const synthesisRequests: NarrationRequest[] = [];
    const plugin = createPlugin({
      prepareRequest(request, context) {
        assert.equal(context.cacheDir, fixture.cacheDir);
        preparedRequests.push(request);
        return {
          ...request,
          model: "model-content-sha256:abc123",
          providerOptions: {
            backendVersion: "1.2.3",
            modelSha256: "abc123",
          },
        };
      },
      async synthesize(request) {
        synthesisRequests.push(request);
        return createBytesResult(request, new Uint8Array([1, 2, 3]));
      },
    });

    try {
      const result = await resolveNarrationFromCache({
        cacheDir: fixture.cacheDir,
        request: fixture.request,
        provider: plugin,
        measureDurationMs: async () => 300,
      });
      const prepared = synthesisRequests[0] as NarrationRequest;

      assert.equal(preparedRequests.length, 1);
      assert.equal(synthesisRequests.length, 1);
      assert.equal(result.entry.key, createNarrationCacheKey(prepared));
      assert.deepEqual(result.entry.metadata.request, prepared);
      assert.deepEqual(result.entry.metadata.request.providerOptions, {
        backendVersion: "1.2.3",
        modelSha256: "abc123",
      });
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test("resolves a valid cache hit without synthesis even when an online provider is unavailable", async () => {
    const fixture = await createFixture();
    let synthesisCalls = 0;
    let runtimeAvailable = true;
    const plugin = createPlugin({
      capabilities: { offlineSynthesis: false },
      async synthesize(request) {
        synthesisCalls += 1;

        if (!runtimeAvailable) {
          throw new Error("provider runtime unavailable");
        }

        return createBytesResult(request, new Uint8Array([4, 5, 6]));
      },
    });

    try {
      await resolveNarrationFromCache({
        cacheDir: fixture.cacheDir,
        request: fixture.request,
        provider: plugin,
        measureDurationMs: async () => 300,
      });
      runtimeAvailable = false;

      const cached = await resolveNarrationFromCache({
        cacheDir: fixture.cacheDir,
        request: fixture.request,
        provider: plugin,
        measureDurationMs: async () => {
          throw new Error("cache hit must not measure");
        },
      });

      assert.equal(cached.source, "cache");
      assert.equal(synthesisCalls, 1);
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test("forwards the same AbortSignal through preparation and synthesis", async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    const receivedSignals: AbortSignal[] = [];
    const plugin = createPlugin({
      prepareRequest(request, context) {
        receivedSignals.push(context.signal);
        return request;
      },
      async synthesize(request, context) {
        receivedSignals.push(context.signal);
        return createBytesResult(request, new Uint8Array([7, 8, 9]));
      },
    });

    try {
      await resolveNarrationFromCache({
        cacheDir: fixture.cacheDir,
        request: fixture.request,
        provider: plugin,
        signal: controller.signal,
        measureDurationMs: async () => 300,
      });

      assert.deepEqual(receivedSignals, [controller.signal, controller.signal]);
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test("marks file output failed and finalizes it when cancellation arrives after synthesis", async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    const sourcePath = join(fixture.tempRoot, "cancelled.wav");
    const outcomes: NarrationSynthesisFinalizeOutcome[] = [];
    await writeFile(sourcePath, new Uint8Array([7, 8, 9]));
    const plugin = createPlugin({
      async synthesize(request) {
        controller.abort(new Error("cancelled after synthesis"));
        return {
          request,
          output: {
            kind: "file",
            path: sourcePath,
            async finalize(outcome) {
              outcomes.push(outcome);
            },
          },
          metadata: createMetadata(request),
        };
      },
    });

    try {
      await assert.rejects(
        resolveNarrationFromCache({
          cacheDir: fixture.cacheDir,
          request: fixture.request,
          provider: plugin,
          signal: controller.signal,
          measureDurationMs: async () => 300,
        }),
        /cancelled after synthesis/,
      );
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0]?.status, "failed");
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test("finalizes file output once after successful copy, measurement, and metadata persistence", async () => {
    const fixture = await createFixture();
    const sourcePath = join(fixture.tempRoot, "provider.wav");
    const outcomes: NarrationSynthesisFinalizeOutcome[] = [];
    await writeFile(sourcePath, new Uint8Array([1, 2, 3, 4]));

    try {
      const result = await resolveNarrationFromCache({
        cacheDir: fixture.cacheDir,
        request: fixture.request,
        provider: createFilePlugin(sourcePath, async (outcome) => {
          outcomes.push(outcome);
        }),
        measureDurationMs: async () => 400,
      });

      assert.equal(result.source, "provider");
      assert.deepEqual(outcomes, [{ status: "persisted" }]);
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test("finalizes file output after copy, duration, and persistence failures", async () => {
    const cases: Array<{
      name: string;
      source: "missing" | "present";
      measureDurationMs: () => Promise<number>;
      now?: () => Date;
      message: RegExp;
    }> = [
      {
        name: "copy",
        source: "missing",
        measureDurationMs: async () => 100,
        message: /ENOENT/,
      },
      {
        name: "duration",
        source: "present",
        measureDurationMs: async () => {
          throw new Error("ffprobe failed");
        },
        message: /ffprobe failed/,
      },
      {
        name: "metadata persistence",
        source: "present",
        measureDurationMs: async () => 100,
        now: () => {
          throw new Error("metadata persistence failed");
        },
        message: /metadata persistence failed/,
      },
    ];

    for (const testCase of cases) {
      const fixture = await createFixture();
      const sourcePath = join(fixture.tempRoot, `${testCase.name}.wav`);
      const outcomes: NarrationSynthesisFinalizeOutcome[] = [];

      if (testCase.source === "present") {
        await writeFile(sourcePath, new Uint8Array([1, 2, 3]));
      }

      try {
        await assert.rejects(
          resolveNarrationFromCache({
            cacheDir: fixture.cacheDir,
            request: fixture.request,
            provider: createFilePlugin(sourcePath, async (outcome) => {
              outcomes.push(outcome);
            }),
            measureDurationMs: testCase.measureDurationMs,
            now: testCase.now,
          }),
          testCase.message,
        );
        assert.equal(outcomes.length, 1);
        assert.equal(outcomes[0]?.status, "failed");
        assert.ok(outcomes[0]?.status === "failed" && outcomes[0].error instanceof Error);
      } finally {
        await rm(fixture.tempRoot, { recursive: true, force: true });
      }
    }
  });

  test("preserves a persistence error first when file finalization also fails", async () => {
    const fixture = await createFixture();
    const sourcePath = join(fixture.tempRoot, "missing.wav");
    const finalizeError = new Error("staging cleanup failed");
    let finalizeCalls = 0;

    try {
      await assert.rejects(
        resolveNarrationFromCache({
          cacheDir: fixture.cacheDir,
          request: fixture.request,
          provider: createFilePlugin(sourcePath, async () => {
            finalizeCalls += 1;
            throw finalizeError;
          }),
          measureDurationMs: async () => 100,
        }),
        (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.errors.length, 2);
          assert.match(String(error.errors[0]), /ENOENT/);
          assert.equal(error.errors[1], finalizeError);
          assert.equal(error.cause, error.errors[0]);
          return true;
        },
      );
      assert.equal(finalizeCalls, 1);
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test("rejects empty file output and still finalizes it as failed", async () => {
    const fixture = await createFixture();
    const sourcePath = join(fixture.tempRoot, "empty.wav");
    const outcomes: NarrationSynthesisFinalizeOutcome[] = [];
    await writeFile(sourcePath, new Uint8Array());

    try {
      await assert.rejects(
        resolveNarrationFromCache({
          cacheDir: fixture.cacheDir,
          request: fixture.request,
          provider: createFilePlugin(sourcePath, async (outcome) => {
            outcomes.push(outcome);
          }),
          measureDurationMs: async () => 100,
        }),
        /non-empty audio file/,
      );
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0]?.status, "failed");
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });
});

async function createFixture(): Promise<{
  tempRoot: string;
  cacheDir: string;
  request: NarrationRequest;
}> {
  const tempRoot = await mkdtemp(join(tmpdir(), "demohunter-cache-store-"));

  return {
    tempRoot,
    cacheDir: join(tempRoot, ".demohunter", "cache"),
    request: createNarrationRequest({
      provider: "openai",
      model: "gpt-4o-mini-tts",
      voice: "marin",
      format: "mp3",
      sampleRate: 24_000,
      instructions: "Speak clearly, calm, concise, product-demo style.",
      text: "Narrate the billing dashboard.",
    }),
  };
}

function createProvider(outputs: Uint8Array[]): {
  provider: NarrationProvider;
  callCount: number;
} {
  let callCount = 0;

  return {
    provider: {
      async synthesize(request) {
        const bytes = outputs[callCount] ?? outputs[outputs.length - 1];

        callCount += 1;

        return {
          request,
          output: {
            kind: "bytes",
            bytes,
          },
          metadata: {
            provider: request.provider,
            model: request.model,
            voice: request.voice,
            format: request.format,
            sampleRate: request.sampleRate,
          },
        };
      },
    },
    get callCount() {
      return callCount;
    },
  };
}

function createPlugin(options: {
  capabilities?: Partial<NarrationProviderPlugin["capabilities"]>;
  prepareRequest?: NarrationProviderPlugin["prepareRequest"];
  synthesize?: NarrationProviderPlugin["synthesize"];
} = {}): NarrationProviderPlugin {
  return {
    name: "openai",
    capabilities: {
      offlineSynthesis: false,
      languages: "provider-defined",
      outputFormats: "provider-defined",
      sampleRates: "provider-defined",
      instructions: "supported",
      ...options.capabilities,
    },
    prepareRequest: options.prepareRequest ?? ((request) => request),
    synthesize: options.synthesize ?? (async (request) => createBytesResult(request, new Uint8Array([1]))),
  };
}

function createFilePlugin(
  sourcePath: string,
  finalize: (outcome: NarrationSynthesisFinalizeOutcome) => Promise<void>,
): NarrationProviderPlugin {
  return createPlugin({
    async synthesize(request) {
      return {
        request,
        output: {
          kind: "file",
          path: sourcePath,
          finalize,
        },
        metadata: createMetadata(request),
      };
    },
  });
}

function createBytesResult(
  request: NarrationRequest,
  bytes: Uint8Array,
): NarrationSynthesisResult {
  return {
    request,
    output: { kind: "bytes", bytes },
    metadata: createMetadata(request),
  };
}

function createMetadata(request: NarrationRequest) {
  return {
    provider: request.provider,
    model: request.model,
    voice: request.voice,
    format: request.format,
    sampleRate: request.sampleRate,
    language: request.language,
    providerOptions: request.providerOptions,
  };
}
