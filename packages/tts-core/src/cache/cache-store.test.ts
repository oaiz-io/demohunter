import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { createNarrationRequest, type NarrationProvider, type NarrationRequest } from "../index.js";
import { NARRATION_CACHE_SCHEMA_VERSION } from "./cache-key.js";
import { resolveNarrationFromCache } from "./cache-store.js";

describe("resolveNarrationFromCache", () => {
  test("never deletes a file outside the cache named by obsolete or invalid metadata", async () => {
    const fixture = await createFixture();

    try {
      const provider = createProvider([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
      const first = await resolveNarrationFromCache({
        cacheDir: fixture.cacheDir,
        request: fixture.request,
        provider: provider.provider,
        measureDurationMs: async () => 500,
      });
      // A committed cache folder can carry crafted metadata.
      const outside = join(fixture.tempRoot, "keep.txt");
      await writeFile(outside, "keep");
      const metadata = JSON.parse(await readFile(first.entry.metadataPath, "utf8"));
      metadata.version = 0;
      metadata.output.audioPath = "../../keep.txt";
      await writeFile(first.entry.metadataPath, JSON.stringify(metadata));

      const second = await resolveNarrationFromCache({
        cacheDir: fixture.cacheDir,
        request: fixture.request,
        provider: provider.provider,
        measureDurationMs: async () => 500,
      });

      assert.equal(second.source, "provider");
      assert.equal(await readFile(outside, "utf8"), "keep");
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

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
