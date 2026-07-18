export {
  DEFAULT_ELEVENLABS_NARRATION_MODEL,
  DEFAULT_OPENAI_NARRATION_MODEL,
  OPENAI_NARRATION_MODELS,
  createNarrationRequest,
  normalizeNarrationText,
  normalizeNarrationProviderOptions,
  assertNarrationProviderName,
} from "./contracts.js";
export {
  createNarrationProviderRegistry,
  prepareNarrationProviderRequest,
  validateNarrationProviderCapabilities,
} from "./provider-registry.js";
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
  NarrationProvider,
  NarrationProviderCapabilities,
  NarrationProviderCloseContext,
  NarrationProviderInstructions,
  NarrationProviderLanguages,
  NarrationProviderName,
  NarrationProviderOptions,
  NarrationProviderOutputFormats,
  NarrationProviderPlugin,
  NarrationProviderPrepareContext,
  NarrationProviderSampleRates,
  NarrationProviderSynthesisContext,
  NarrationRequest,
  NarrationRequestInput,
  NarrationSynthesisMetadata,
  NarrationSynthesisOutput,
  NarrationSynthesisFinalizeOutcome,
  NarrationSynthesisResult,
} from "./contracts.js";
export type { NarrationProviderRegistry } from "./provider-registry.js";
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
