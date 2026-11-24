export {
  DEFAULT_ELEVENLABS_NARRATION_MODEL,
  DEFAULT_OPENAI_NARRATION_MODEL,
  NARRATION_PROVIDER_API_KEY_ENV,
  OPENAI_NARRATION_MODELS,
  createNarrationRequest,
  normalizeNarrationText,
} from "./contracts.js";
export {
  NARRATION_CACHE_SCHEMA_VERSION,
  createNarrationCacheIdentity,
  createNarrationCacheKey,
} from "./cache/cache-key.js";
export {
  inspectNarrationCacheMetadataFile,
  measureNarrationAudioDuration,
  resolveNarrationFromCache,
} from "./cache/cache-store.js";
export {
  clearNarrationCache,
  listNarrationCacheEntries,
  pruneNarrationCache,
} from "./cache/cache-maintenance.js";
export type {
  ApiKeyNarrationProviderName,
  NarrationApiKeyResolver,
  NarrationProvider,
  NarrationProviderName,
  NarrationProviderOptions,
  NarrationRequest,
  NarrationRequestInput,
  NarrationSynthesisMetadata,
  NarrationSynthesisOutput,
  NarrationSynthesisResult,
} from "./contracts.js";
export type {
  NarrationCacheIdentity,
  NarrationCacheKeyOptions,
} from "./cache/cache-key.js";
export type {
  MeasureNarrationAudioDurationOptions,
  NarrationCacheEntry,
  NarrationCacheInspection,
  NarrationCacheMetadata,
  NarrationCacheResolveResult,
  ResolveNarrationFromCacheOptions,
} from "./cache/cache-store.js";
export type {
  ClearNarrationCacheOptions,
  ListNarrationCacheEntriesOptions,
  NarrationCacheListEntry,
  PrunedNarrationCacheArtifact,
  PruneNarrationCacheOptions,
  PruneNarrationCacheResult,
} from "./cache/cache-maintenance.js";
