import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createNarrationProviderRegistry, createNarrationRequest, resolveNarrationFromCache } from "@demohunter/tts-core";
import type { NarrationProviderPlugin, ResolveNarrationFromCacheOptions } from "@demohunter/tts-core";

import { resolveNarrationSegment } from "./resolve-narration.js";

const originalApiKey = process.env.OPENAI_API_KEY;
const originalElevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
const tempRoots: string[] = [];

afterEach(async () => {
  if (originalApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalApiKey;
  }

  if (originalElevenLabsApiKey === undefined) {
    delete process.env.ELEVENLABS_API_KEY;
  } else {
    process.env.ELEVENLABS_API_KEY = originalElevenLabsApiKey;
  }

  await Promise.all(tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { force: true, recursive: true })));
});

describe("resolveNarrationSegment", () => {
  test("reuses cached narration without OPENAI_API_KEY when the segment already exists locally", async () => {
    const projectRoot = await makeTempProject();
    const request = createNarrationRequest({
      provider: "openai",
      model: "gpt-4o-mini-tts",
      voice: "marin",
      format: "mp3",
      sampleRate: 24_000,
      instructions: "Speak clearly.",
      text: "Explain the billing dashboard",
    });
    const primed = await resolveNarrationFromCache({
      cacheDir: path.join(projectRoot, ".demohunter", "cache"),
      request,
      provider: {
        async synthesize(input) {
          return {
            request: input,
            output: {
              kind: "bytes",
              bytes: new Uint8Array([1, 2, 3, 4]),
            },
            metadata: {
              provider: input.provider,
              model: input.model,
              voice: input.voice,
              format: input.format,
              sampleRate: input.sampleRate,
            },
          };
        },
      },
      measureDurationMs: async () => 987,
      now: () => new Date("2026-04-11T00:00:00.000Z"),
    });

    delete process.env.OPENAI_API_KEY;

    const segment = await resolveNarrationSegment({
      event: {
        chapterTitle: "Billing",
        kind: "narrate",
        text: "Explain the billing dashboard",
      },
      loadedConfig: createLoadedConfig(projectRoot),
      registry: createTestRegistry("openai"),
    });

    expect(segment).toEqual({
      audioPath: primed.entry.audioPath,
      cacheKey: primed.entry.key,
      chapterTitle: "Billing",
      durationMs: 987,
      text: "Explain the billing dashboard",
    });
  });

  test("fails clearly when uncached narration requires OPENAI_API_KEY", async () => {
    const projectRoot = await makeTempProject();
    delete process.env.OPENAI_API_KEY;

    await expect(
      resolveNarrationSegment({
        event: {
          chapterTitle: "Billing",
          kind: "narrate",
          text: "Explain the billing dashboard",
        },
        loadedConfig: createLoadedConfig(projectRoot),
        registry: createTestRegistry("openai", "OPENAI_API_KEY is required"),
      }),
    ).rejects.toThrow(/OPENAI_API_KEY/);
  });

  test("builds ElevenLabs requests from config and per-call narration overrides", async () => {
    const projectRoot = await makeTempProject();
    let capturedRequest: ResolveNarrationFromCacheOptions["request"] | undefined;

    const segment = await resolveNarrationSegment(
      {
        event: {
          chapterTitle: "Billing",
          format: "mp3_22050_32",
          kind: "narrate",
          language: "sv",
          model: "eleven_flash_v2_5",
          text: "Explain the billing dashboard",
          voice: "per-segment-voice",
          voiceSettings: {
            stability: 0.21,
            similarityBoost: 0.92,
          },
        },
        loadedConfig: createLoadedConfig(projectRoot, {
          provider: "elevenlabs",
          model: "eleven_multilingual_v2",
          voice: "default-voice",
          format: "mp3_44100_128",
          instructions: "",
          language: "en",
          voiceSettings: {
            stability: 0.5,
            similarityBoost: 0.75,
            useSpeakerBoost: true,
          },
        }),
        context: {
          previousText: "  First, open billing.\r\n",
          nextText: "Next, export the report.",
        },
        registry: createTestRegistry("elevenlabs"),
      },
      {
        resolveNarrationFromCache: async (options) => {
          capturedRequest = options.request;

          return {
            source: "provider",
            entry: {
              audioPath: path.join(projectRoot, ".demohunter", "cache", "elevenlabs.mp3"),
              byteSize: 3,
              durationMs: 654,
              key: "elevenlabs-cache-key",
              metadataPath: path.join(projectRoot, ".demohunter", "cache", "elevenlabs.json"),
              metadata: {
                createdAt: "2026-05-26T00:00:00.000Z",
                key: "elevenlabs-cache-key",
                output: {
                  audioPath: path.join(projectRoot, ".demohunter", "cache", "elevenlabs.mp3"),
                  byteSize: 3,
                  durationMs: 654,
                  format: "mp3_22050_32",
                  sha256: "abc",
                },
                request: options.request,
                version: 1,
              },
            },
          };
        },
      },
    );

    expect(capturedRequest).toEqual({
      provider: "elevenlabs",
      model: "eleven_flash_v2_5",
      voice: "per-segment-voice",
      format: "mp3_22050_32",
      sampleRate: 22_050,
      instructions: "",
      language: "sv",
      providerOptions: {
        nextText: "Next, export the report.",
        previousText: "  First, open billing.\r\n",
        voiceSettings: {
          stability: 0.21,
          similarityBoost: 0.92,
        },
      },
      text: "Explain the billing dashboard",
    });
    expect(segment).toEqual({
      audioPath: path.join(projectRoot, ".demohunter", "cache", "elevenlabs.mp3"),
      cacheKey: "elevenlabs-cache-key",
      chapterTitle: "Billing",
      durationMs: 654,
      text: "Explain the billing dashboard",
    });
  });

  test("uses config-level narration language when an event does not override it", async () => {
    const projectRoot = await makeTempProject();
    let capturedRequest: ResolveNarrationFromCacheOptions["request"] | undefined;

    await resolveNarrationSegment(
      {
        event: {
          chapterTitle: "Billing",
          kind: "narrate",
          text: "Explain the billing dashboard",
        },
        loadedConfig: createLoadedConfig(projectRoot, {
          provider: "elevenlabs",
          model: "eleven_multilingual_v2",
          voice: "default-voice",
          format: "mp3_44100_128",
          instructions: "",
          language: " sv ",
        }),
        registry: createTestRegistry("elevenlabs"),
      },
      {
        resolveNarrationFromCache: async (options) => {
          capturedRequest = options.request;

          return {
            source: "provider",
            entry: {
              audioPath: path.join(projectRoot, ".demohunter", "cache", "elevenlabs.mp3"),
              byteSize: 3,
              durationMs: 654,
              key: "elevenlabs-cache-key",
              metadataPath: path.join(projectRoot, ".demohunter", "cache", "elevenlabs.json"),
              metadata: {
                createdAt: "2026-05-26T00:00:00.000Z",
                key: "elevenlabs-cache-key",
                output: {
                  audioPath: path.join(projectRoot, ".demohunter", "cache", "elevenlabs.mp3"),
                  byteSize: 3,
                  durationMs: 654,
                  format: "mp3_44100_128",
                  sha256: "abc",
                },
                request: options.request,
                version: 1,
              },
            },
          };
        },
      },
    );

    expect(capturedRequest?.language).toBe("sv");
  });

  test("passes continuity as generic preparation input without resolving by provider name", async () => {
    const projectRoot = await makeTempProject();
    let capturedRequest: ResolveNarrationFromCacheOptions["request"] | undefined;

    await resolveNarrationSegment(
      {
        event: {
          chapterTitle: "Billing",
          kind: "narrate",
          text: "Explain the billing dashboard",
        },
        loadedConfig: createLoadedConfig(projectRoot),
        context: {
          previousText: "First, open billing.",
          nextText: "Next, export the report.",
        },
        registry: createTestRegistry("openai"),
      },
      {
        resolveNarrationFromCache: async (options) => {
          capturedRequest = options.request;

          return {
            source: "provider",
            entry: {
              audioPath: path.join(projectRoot, ".demohunter", "cache", "openai.mp3"),
              byteSize: 3,
              durationMs: 654,
              key: "openai-cache-key",
              metadataPath: path.join(projectRoot, ".demohunter", "cache", "openai.json"),
              metadata: {
                createdAt: "2026-05-26T00:00:00.000Z",
                key: "openai-cache-key",
                output: {
                  audioPath: path.join(projectRoot, ".demohunter", "cache", "openai.mp3"),
                  byteSize: 3,
                  durationMs: 654,
                  format: "mp3",
                  sha256: "abc",
                },
                request: options.request,
                version: 1,
              },
            },
          };
        },
      },
    );

    expect(capturedRequest?.providerOptions).toEqual({
      nextText: "Next, export the report.",
      previousText: "First, open billing.",
    });
  });

  test("fails clearly when uncached narration requires ELEVENLABS_API_KEY", async () => {
    const projectRoot = await makeTempProject();
    delete process.env.ELEVENLABS_API_KEY;

    await expect(
      resolveNarrationSegment({
        event: {
          chapterTitle: "Billing",
          kind: "narrate",
          text: "Explain the billing dashboard",
        },
        loadedConfig: createLoadedConfig(projectRoot, {
          provider: "elevenlabs",
          model: "eleven_multilingual_v2",
          voice: "JBFqnCBsd6RMkjVDRZzb",
          format: "mp3_44100_128",
          instructions: "",
        }),
        registry: createTestRegistry("elevenlabs", "ELEVENLABS_API_KEY is required"),
      }),
    ).rejects.toThrow(/ELEVENLABS_API_KEY/);
  });

  test("resolves arbitrary plugins and reports unknown names without fallback", async () => {
    const projectRoot = await makeTempProject();
    const loadedConfig = createLoadedConfig(projectRoot, {
      provider: "acme-local",
      model: "v1",
      voice: "demo",
      format: "wav",
      instructions: "",
    });
    const registry = createTestRegistry("different-provider");

    await expect(resolveNarrationSegment({
      event: { kind: "narrate", text: "Hello" },
      loadedConfig,
      registry,
    })).rejects.toThrow('Narration provider "acme-local" is not registered');
  });

  test("forwards cancellation before cache or provider work", async () => {
    const projectRoot = await makeTempProject();
    const controller = new AbortController();
    controller.abort(new DOMException("cancel narration", "AbortError"));

    await expect(resolveNarrationSegment({
      event: { kind: "narrate", text: "Hello" },
      loadedConfig: createLoadedConfig(projectRoot),
      registry: createTestRegistry("openai"),
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
  });
});

function createTestRegistry(name: string, synthesisError = "provider should not synthesize") {
  const plugin: NarrationProviderPlugin = {
    name,
    capabilities: {
      offlineSynthesis: name !== "openai" && name !== "elevenlabs",
      languages: "provider-defined",
      outputFormats: "provider-defined",
      sampleRates: "provider-defined",
      instructions: "provider-defined",
    },
    prepareRequest: (request) => request,
    async synthesize() {
      throw new Error(synthesisError);
    },
  };
  return createNarrationProviderRegistry([plugin]);
}

async function makeTempProject(): Promise<string> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "demohunter-resolve-narration-"));
  tempRoots.push(tempRoot);
  return tempRoot;
}

function createLoadedConfig(
  projectRoot: string,
  tts: {
    provider: string;
    model: string;
    voice: string;
    format: string;
    instructions: string;
    language?: string;
  } | {
    provider: string;
    model: string;
    voice: string;
    format: string;
    instructions: string;
    language?: string;
    voiceSettings?: {
      stability?: number;
      similarityBoost?: number;
      style?: number;
      useSpeakerBoost?: boolean;
      speed?: number;
    };
  } = {
    provider: "openai" as const,
    model: "gpt-4o-mini-tts",
    voice: "marin",
    format: "mp3",
    instructions: "Speak clearly.",
  },
) {
  return {
    config: {
      baseURL: "http://localhost:3000",
      outputDir: path.join(projectRoot, ".demohunter"),
      cacheDir: path.join(projectRoot, ".demohunter", "cache"),
      browser: "chromium" as const,
      viewport: { width: 1280, height: 720 },
      holdPaddingMs: 300,
      record: { format: "mp4" as const, showActions: true, showChapters: true },
      tts,
    },
    configPath: path.join(projectRoot, "demohunter.config.ts"),
    projectRoot,
  };
}
