import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

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

const multiprocessWorkerPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/cache-process-worker.ts",
);

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

  test("recovers from hostile metadata without deleting an out-of-cache target", async () => {
    const fixture = await createFixture();
    const victimPath = join(fixture.tempRoot, "must-survive.txt");
    const victimContents = "do not delete\n";
    const key = createNarrationCacheKey(fixture.request);
    const metadataPath = join(fixture.cacheDir, `${key}.json`);
    const provider = createProvider([new Uint8Array([8, 8, 8])]);

    try {
      await mkdir(fixture.cacheDir, { recursive: true });
      await writeFile(victimPath, victimContents, "utf8");
      await writeFile(metadataPath, JSON.stringify({
        key,
        version: NARRATION_CACHE_SCHEMA_VERSION,
        createdAt: "2026-04-11T09:15:00.000Z",
        request: fixture.request,
        output: {
          format: fixture.request.format,
          audioPath: "../../../must-survive.txt",
          byteSize: victimContents.length,
          durationMs: 100,
          sha256: createHash("sha256").update(victimContents).digest("hex"),
        },
      }), "utf8");

      const result = await resolveNarrationFromCache({
        cacheDir: fixture.cacheDir,
        request: fixture.request,
        provider: provider.provider,
        measureDurationMs: async () => 300,
      });

      assert.equal(result.source, "provider");
      assert.equal(provider.callCount, 1);
      assert.equal(await readFile(victimPath, "utf8"), victimContents);
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test("single-flights concurrent misses for the same cache key", async () => {
    const fixture = await createFixture();
    const synthesisStarted = createDeferred();
    const finishSynthesis = createDeferred();
    let synthesisCalls = 0;
    const provider: NarrationProvider = {
      async synthesize(request) {
        synthesisCalls += 1;
        synthesisStarted.resolve();
        await finishSynthesis.promise;
        return createBytesResult(request, new Uint8Array([4, 3, 2, 1]));
      },
    };

    try {
      const first = resolveNarrationFromCache({
        cacheDir: fixture.cacheDir,
        request: fixture.request,
        provider,
        measureDurationMs: async () => 400,
      });
      await synthesisStarted.promise;
      const second = resolveNarrationFromCache({
        cacheDir: fixture.cacheDir,
        request: fixture.request,
        provider,
        measureDurationMs: async () => {
          throw new Error("the queued request must consume the winner's cache entry");
        },
      });

      finishSynthesis.resolve();
      const [firstResult, secondResult] = await Promise.all([first, second]);

      assert.equal(synthesisCalls, 1);
      assert.equal(firstResult.source, "provider");
      assert.equal(secondResult.source, "cache");
      assert.equal(secondResult.entry.audioPath, firstResult.entry.audioPath);
      assert.deepEqual(await readFile(firstResult.entry.audioPath), Buffer.from([4, 3, 2, 1]));
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test("coordinates one committed cache entry across separate processes", async () => {
    const fixture = await createFixture();
    const invocationLog = join(fixture.tempRoot, "synthesis.log");

    try {
      const [first, second] = await Promise.all([
        runCacheProcess(fixture.cacheDir, invocationLog, "first"),
        runCacheProcess(fixture.cacheDir, invocationLog, "second"),
      ]);
      const results = [first, second];
      const invocationLines = (await readFile(invocationLog, "utf8")).trim().split("\n");

      assert.equal(invocationLines.length, 1);
      assert.equal(first.key, second.key);
      assert.deepEqual(results.map((result) => result.source).sort(), ["cache", "provider"]);
      assert.equal(first.metadataPath, second.metadataPath);

      const metadata = JSON.parse(await readFile(first.metadataPath, "utf8")) as {
        key: string;
        output: { audioPath: string; byteSize: number; sha256: string };
      };
      const audioBytes = await readFile(join(fixture.cacheDir, metadata.output.audioPath));

      assert.equal(metadata.key, first.key);
      assert.equal(metadata.output.byteSize, audioBytes.byteLength);
      assert.equal(metadata.output.sha256, createHash("sha256").update(audioBytes).digest("hex"));
      assert.deepEqual(await readdir(join(fixture.cacheDir, ".locks")), []);
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test("recovers a stale dead-owner lock but never reclaims a stale-looking live-owner lock", async () => {
    const fixture = await createFixture();
    const key = createNarrationCacheKey(fixture.request);
    const lockPath = join(fixture.cacheDir, ".locks", `${key}.lock`);
    const staleTime = new Date(Date.now() - 60_000);

    try {
      await writeCacheLock(lockPath, {
        token: "dead-owner",
        pid: 999_999_999,
      });
      await utimes(lockPath, staleTime, staleTime);

      const provider = createProvider([new Uint8Array([8, 6, 7, 5])]);
      const recovered = await resolveNarrationFromCache({
        cacheDir: fixture.cacheDir,
        request: fixture.request,
        provider: provider.provider,
        measureDurationMs: async () => 400,
        lockStaleMs: 10,
        lockPollIntervalMs: 5,
        lockWaitTimeoutMs: 200,
      });

      assert.equal(recovered.source, "provider");
      assert.equal(provider.callCount, 1);
      await assert.rejects(access(lockPath), /ENOENT/);

      await writeCacheLock(lockPath, {
        token: "live-owner",
        pid: process.pid,
      });
      await utimes(lockPath, staleTime, staleTime);

      await assert.rejects(
        resolveNarrationFromCache({
          cacheDir: fixture.cacheDir,
          request: fixture.request,
          provider: createProvider([new Uint8Array([1])]).provider,
          measureDurationMs: async () => 100,
          lockStaleMs: 10,
          lockPollIntervalMs: 5,
          lockWaitTimeoutMs: 40,
        }),
        /Timed out after 40ms waiting for narration cache key/,
      );
      await access(lockPath);
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test("cancels a filesystem-lock waiter without deleting the current owner's lock", async () => {
    const fixture = await createFixture();
    const key = createNarrationCacheKey(fixture.request);
    const lockPath = join(fixture.cacheDir, ".locks", `${key}.lock`);
    const controller = new AbortController();
    const cancellation = new Error("filesystem cache wait cancelled");
    const provider = createProvider([new Uint8Array([1, 2, 3])]);

    try {
      await writeCacheLock(lockPath, { token: "active-owner", pid: process.pid });
      const pending = resolveNarrationFromCache({
        cacheDir: fixture.cacheDir,
        request: fixture.request,
        provider: provider.provider,
        signal: controller.signal,
        measureDurationMs: async () => 100,
        lockStaleMs: 60_000,
        lockPollIntervalMs: 100,
        lockWaitTimeoutMs: 5_000,
      });
      setTimeout(() => controller.abort(cancellation), 20);

      await assert.rejects(pending, (error: unknown) => error === cancellation);
      assert.equal(provider.callCount, 0);
      await access(lockPath);
      const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as { token: string };
      assert.equal(owner.token, "active-owner");
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test("cancels a same-key waiter without disrupting the active cache fill", async () => {
    const fixture = await createFixture();
    const measurementStarted = createDeferred();
    const finishMeasurement = createDeferred();
    const queuedController = new AbortController();
    const queuedReason = new Error("queued narration cancelled");
    const provider = createProvider([new Uint8Array([5, 6, 7])]);

    try {
      const active = resolveNarrationFromCache({
        cacheDir: fixture.cacheDir,
        request: fixture.request,
        provider: provider.provider,
        measureDurationMs: async () => {
          measurementStarted.resolve();
          await finishMeasurement.promise;
          return 300;
        },
      });
      await measurementStarted.promise;
      const queued = resolveNarrationFromCache({
        cacheDir: fixture.cacheDir,
        request: fixture.request,
        provider: provider.provider,
        signal: queuedController.signal,
        measureDurationMs: async () => 300,
      });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
      queuedController.abort(queuedReason);

      await assert.rejects(queued, (error: unknown) => error === queuedReason);
      finishMeasurement.resolve();
      assert.equal((await active).source, "provider");
      assert.equal(provider.callCount, 1);
    } finally {
      finishMeasurement.resolve();
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test("aborts during custom duration measurement and removes partial cache artifacts", async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    const cancellation = new Error("cancel during measurement");
    const measurementStarted = createDeferred();

    try {
      const pending = resolveNarrationFromCache({
        cacheDir: fixture.cacheDir,
        request: fixture.request,
        provider: createProvider([new Uint8Array([1, 3, 5])]).provider,
        signal: controller.signal,
        measureDurationMs: async () => {
          measurementStarted.resolve();
          return await new Promise<number>(() => undefined);
        },
      });
      await measurementStarted.promise;
      controller.abort(cancellation);

      await assert.rejects(pending, (error: unknown) => error === cancellation);
      const key = createNarrationCacheKey(fixture.request);
      await assert.rejects(readFile(join(fixture.cacheDir, `${key}.json`)), /ENOENT/);
      await assert.rejects(readFile(join(fixture.cacheDir, `${key}.${fixture.request.format}`)), /ENOENT/);
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

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return { promise, resolve: resolvePromise };
}

async function writeCacheLock(
  lockPath: string,
  owner: { token: string; pid: number },
): Promise<void> {
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, "owner.json"), JSON.stringify({
    schema: 1,
    token: owner.token,
    pid: owner.pid,
    hostname: hostname(),
    createdAt: new Date(0).toISOString(),
  }), "utf8");
}

async function runCacheProcess(
  cacheDir: string,
  invocationLog: string,
  label: string,
): Promise<{ source: "cache" | "provider"; key: string; metadataPath: string }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [multiprocessWorkerPath, cacheDir, invocationLog, label], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Cache process ${label} exited with code ${code}: ${stderr}`));
        return;
      }

      try {
        resolvePromise(JSON.parse(stdout) as {
          source: "cache" | "provider";
          key: string;
          metadataPath: string;
        });
      } catch (error) {
        reject(new Error(`Cache process ${label} returned invalid JSON: ${stdout}`, { cause: error }));
      }
    });
  });
}
