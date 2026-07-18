import {
  createNarrationRequest,
  resolveNarrationFromCache,
  type NarrationProviderRegistry,
} from "@demohunter/tts-core";

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
  registry: NarrationProviderRegistry;
  signal?: AbortSignal;
};

type ResolveNarrationSegmentDependencies = {
  resolveNarrationFromCache: typeof resolveNarrationFromCache;
};

const defaultDependencies: ResolveNarrationSegmentDependencies = {
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
  const signal = input.signal ?? input.context?.signal;
  signal?.throwIfAborted();
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
      provider: input.registry.resolve(config.tts.provider),
      request,
      signal,
    });

    return {
      audioPath: entry.audioPath,
      cacheKey: entry.key,
      chapterTitle: input.event.chapterTitle,
      durationMs: entry.durationMs,
      text: request.text,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    if (error instanceof Error) {
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
  const configuredProviderOptions = "providerOptions" in tts ? tts.providerOptions : undefined;
  const configuredVoiceSettings = "voiceSettings" in tts ? tts.voiceSettings : undefined;
  const configuredSpeed = "speed" in tts ? tts.speed : undefined;
  const providerOptions: Record<string, unknown> = {
    ...configuredProviderOptions,
  };
  const voiceSettings = event.voiceSettings ?? configuredVoiceSettings;
  const previousText = context?.previousText;
  const nextText = context?.nextText;

  if (configuredSpeed !== undefined && providerOptions.speed === undefined) {
    providerOptions.speed = configuredSpeed;
  }

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
