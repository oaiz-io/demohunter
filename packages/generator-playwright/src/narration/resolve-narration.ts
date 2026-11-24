import {
  createNarrationRequest,
  normalizeNarrationText,
  resolveNarrationFromCache,
  type NarrationApiKeyResolver,
  type NarrationProvider,
} from "@demohunter/tts-core";
import { createElevenLabsNarrationProvider } from "@demohunter/tts-elevenlabs";
import { createKokoroNarrationProvider } from "@demohunter/tts-kokoro";
import { createOpenAINarrationProvider } from "@demohunter/tts-openai";

import type {
  NarrationResolverContext,
  NarrationRuntimeEvent,
  NarrationSegment,
} from "../execute/generator-types.js";
import type { SmokeGenerateInput } from "../smoke-generate.js";

const DEFAULT_NARRATION_SAMPLE_RATE = 24_000;

export type ResolveNarrationSegmentInput = {
  event: NarrationRuntimeEvent;
  loadedConfig: SmokeGenerateInput["loadedConfig"];
  context?: NarrationResolverContext;
  /** Supplies the provider API key on a cache miss (Studio's saved key). The
   * provider's environment variable is the fallback. */
  resolveApiKey?: NarrationApiKeyResolver;
};

type ResolveNarrationSegmentDependencies = {
  createProvider: (
    loadedConfig: SmokeGenerateInput["loadedConfig"],
    resolveApiKey?: NarrationApiKeyResolver,
  ) => NarrationProvider;
  resolveNarrationFromCache: typeof resolveNarrationFromCache;
};

const defaultDependencies: ResolveNarrationSegmentDependencies = {
  createProvider: (loadedConfig, resolveApiKey) => {
    const providerName = loadedConfig.config.tts.provider;

    switch (providerName) {
      case "openai":
        return createOpenAINarrationProvider({ resolveApiKey });
      case "elevenlabs":
        return createElevenLabsNarrationProvider({ resolveApiKey });
      case "kokoro":
        return createKokoroNarrationProvider({ projectRoot: loadedConfig.projectRoot });
      default:
        throw new Error(`Unsupported narration provider: ${String(providerName)}`);
    }
  },
  resolveNarrationFromCache,
};

export async function resolveNarrationSegment(
  input: ResolveNarrationSegmentInput,
  dependencies: Partial<ResolveNarrationSegmentDependencies> = {},
): Promise<NarrationSegment> {
  const resolvedDependencies = {
    ...defaultDependencies,
    ...dependencies,
  };
  const { config } = input.loadedConfig;
  const request = createNarrationRequest({
    provider: config.tts.provider,
    model: input.event.model ?? config.tts.model,
    voice: input.event.voice ?? config.tts.voice,
    format: input.event.format ?? config.tts.format,
    sampleRate: resolveNarrationSampleRate(input.event.format ?? config.tts.format),
    instructions: input.event.instructions ?? config.tts.instructions,
    language: input.event.language ?? config.tts.language,
    providerOptions: resolveProviderOptions(config.tts, input.event, input.context),
    text: input.event.text,
  });

  try {
    const { entry } = await resolvedDependencies.resolveNarrationFromCache({
      cacheDir: config.cacheDir,
      provider: resolvedDependencies.createProvider(input.loadedConfig, input.resolveApiKey),
      request,
    });

    return {
      audioPath: entry.audioPath,
      cacheKey: entry.key,
      chapterTitle: input.event.chapterTitle,
      durationMs: entry.durationMs,
      text: request.text,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("OPENAI_API_KEY") || error.message.includes("ELEVENLABS_API_KEY"))
    ) {
      throw new Error(
        `Unable to resolve narration segment ${JSON.stringify(request.text)} because ${error.message}`,
        { cause: error },
      );
    }

    throw error;
  }
}

function resolveProviderOptions(
  tts: SmokeGenerateInput["loadedConfig"]["config"]["tts"],
  event: NarrationRuntimeEvent,
  context: NarrationResolverContext | undefined,
): Record<string, unknown> | undefined {
  if (tts.provider !== "elevenlabs") {
    return undefined;
  }

  const providerOptions: Record<string, unknown> = {};
  const voiceSettings = event.voiceSettings ?? tts.voiceSettings;
  const supportsRequestStitching = (event.model ?? tts.model) !== "eleven_v3";
  const previousText = supportsRequestStitching ? normalizeContextText(context?.previousText) : undefined;
  const nextText = supportsRequestStitching ? normalizeContextText(context?.nextText) : undefined;

  if (voiceSettings !== undefined) {
    providerOptions.voiceSettings = voiceSettings;
  }

  if (previousText !== undefined) {
    providerOptions.previousText = previousText;
  }

  if (nextText !== undefined) {
    providerOptions.nextText = nextText;
  }

  return Object.keys(providerOptions).length === 0 ? undefined : providerOptions;
}

function resolveNarrationSampleRate(format: string): number {
  const match = /_(\d+)(?:_|$)/.exec(format);

  if (match === null) {
    return DEFAULT_NARRATION_SAMPLE_RATE;
  }

  return Number.parseInt(match[1], 10);
}

function normalizeContextText(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }

  const normalized = normalizeNarrationText(text);

  return normalized === "" ? undefined : normalized;
}
