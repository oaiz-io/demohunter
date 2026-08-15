import { createHash } from "node:crypto";

import {
  normalizeNarrationProviderOptions,
  normalizeNarrationText,
  type NarrationRequest,
} from "../contracts.js";

export const NARRATION_CACHE_SCHEMA_VERSION = 1;

export type NarrationCacheIdentity = {
  provider: string;
  model: string;
  voice: string;
  instructions: string;
  language?: string;
  format: string;
  sampleRate: number;
  providerOptions?: Record<string, unknown>;
  text: string;
  version: number;
};

export type NarrationCacheKeyOptions = {
  version?: number;
};

export function createNarrationCacheIdentity(
  request: NarrationRequest,
  options: NarrationCacheKeyOptions = {},
): NarrationCacheIdentity {
  return {
    provider: request.provider,
    model: request.model,
    voice: request.voice,
    instructions: request.instructions,
    language: request.language,
    format: request.format,
    sampleRate: request.sampleRate,
    providerOptions: normalizeNarrationProviderOptions(request.providerOptions),
    text: normalizeNarrationText(request.text),
    version: options.version ?? NARRATION_CACHE_SCHEMA_VERSION,
  };
}

export function createNarrationCacheKey(
  request: NarrationRequest,
  options: NarrationCacheKeyOptions = {},
): string {
  return createHash("sha256")
    .update(JSON.stringify(createNarrationCacheIdentity(request, options)))
    .digest("hex");
}
