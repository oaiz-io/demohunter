import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

import {
  createNarrationRequest,
  type NarrationProvider,
  type NarrationProviderPlugin,
  type NarrationRequest,
  type NarrationSynthesisFinalizeOutcome,
  type NarrationSynthesisResult,
} from "../contracts.js";
import { prepareNarrationProviderRequest } from "../provider-registry.js";
import {
  createNarrationCacheIdentity,
  createNarrationCacheKey,
  NARRATION_CACHE_SCHEMA_VERSION,
} from "./cache-key.js";

export const NARRATION_CACHE_METADATA_EXTENSION = ".json";

export type NarrationCacheMetadata = {
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

export type NarrationCacheEntry = {
  key: string;
  audioPath: string;
  metadataPath: string;
  byteSize: number;
  durationMs: number;
  metadata: NarrationCacheMetadata;
};

export type NarrationCacheResolveResult = {
  source: "cache" | "provider";
  entry: NarrationCacheEntry;
};

export type ResolveNarrationFromCacheOptions = {
  cacheDir: string;
  request: NarrationRequest;
  provider: NarrationProvider | NarrationProviderPlugin;
  signal?: AbortSignal;
  version?: number;
  measureDurationMs?: (audioPath: string) => Promise<number>;
  now?: () => Date;
};

export type MeasureNarrationAudioDurationOptions = {
  ffprobeCommand?: string;
};

export type InspectNarrationCacheMetadataFileOptions = {
  cacheDir: string;
  metadataPath: string;
  currentVersion?: number;
};

export type NarrationCacheInspection =
  | {
      status: "ready";
      entry: NarrationCacheEntry;
    }
  | {
      status: "invalid" | "obsolete";
      key: string;
      metadataPath: string;
      audioPath: string | null;
      version: number | null;
      issue: string;
    };

export async function resolveNarrationFromCache(
  options: ResolveNarrationFromCacheOptions,
): Promise<NarrationCacheResolveResult> {
  const cacheDir = resolveCacheDir(options.cacheDir);
  const inputRequest = createNarrationRequest(options.request);
  const signal = options.signal ?? new AbortController().signal;
  const context = { cacheDir, signal };

  await mkdir(cacheDir, { recursive: true });

  const request = isNarrationProviderPlugin(options.provider)
    ? await prepareNarrationProviderRequest(options.provider, inputRequest, context)
    : inputRequest;
  const version = options.version ?? NARRATION_CACHE_SCHEMA_VERSION;
  const key = createNarrationCacheKey(request, { version });
  const paths = getNarrationCachePaths({
    cacheDir,
    key,
    format: request.format,
  });

  signal.throwIfAborted();
  const cached = await readNarrationCacheEntry({
    cacheDir,
    key,
    metadataPath: paths.metadataPath,
    currentVersion: version,
  });

  if (cached?.status === "ready") {
    signal.throwIfAborted();
    return {
      source: "cache",
      entry: cached.entry,
    };
  }

  if (cached !== null) {
    await removeCacheArtifacts(cached.metadataPath, cached.audioPath);
  }

  signal.throwIfAborted();
  const synthesized = isNarrationProviderPlugin(options.provider)
    ? await options.provider.synthesize(request, context)
    : await options.provider.synthesize(request);
  let entry: NarrationCacheEntry | undefined;
  let failure: { error: unknown } | undefined;

  try {
    signal.throwIfAborted();
    assertSynthesisMatchesRequest(synthesized, request);

    entry = await persistNarrationCacheEntry({
      cacheDir,
      key,
      request,
      version,
      synthesized,
      measureDurationMs: options.measureDurationMs ?? measureNarrationAudioDuration,
      now: options.now ?? (() => new Date()),
    });
  } catch (error) {
    failure = { error };
  }

  await finalizeSynthesisOutput(synthesized, failure);

  if (failure !== undefined) {
    throw failure.error;
  }

  if (entry === undefined) {
    throw new Error("Narration cache persistence completed without an entry.");
  }

  return {
    source: "provider",
    entry,
  };
}

export async function measureNarrationAudioDuration(
  audioPath: string,
  options: MeasureNarrationAudioDurationOptions = {},
): Promise<number> {
  const ffprobeCommand = options.ffprobeCommand ?? "ffprobe";
  const stdout = await runCommand(ffprobeCommand, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    audioPath,
  ]);
  const parsed = JSON.parse(stdout) as { format?: { duration?: string } };
  const durationSeconds = Number(parsed.format?.duration);

  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    throw new Error(`Unable to measure narration audio duration for ${audioPath}.`);
  }

  return Math.round(durationSeconds * 1_000);
}

export async function inspectNarrationCacheMetadataFile(
  options: InspectNarrationCacheMetadataFileOptions,
): Promise<NarrationCacheInspection> {
  const cacheDir = resolveCacheDir(options.cacheDir);
  const metadataPath = resolve(options.metadataPath);
  const currentVersion = options.currentVersion ?? NARRATION_CACHE_SCHEMA_VERSION;
  const metadataText = await readFile(metadataPath, "utf8").catch((error: unknown) => {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  });

  if (metadataText === null) {
    return {
      status: "invalid",
      key: basename(metadataPath, NARRATION_CACHE_METADATA_EXTENSION),
      metadataPath,
      audioPath: null,
      version: null,
      issue: "Metadata file is missing.",
    };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(metadataText);
  } catch {
    return {
      status: "invalid",
      key: basename(metadataPath, NARRATION_CACHE_METADATA_EXTENSION),
      metadataPath,
      audioPath: null,
      version: null,
      issue: "Metadata file is not valid JSON.",
    };
  }

  if (!isNarrationCacheMetadata(parsed)) {
    return {
      status: "invalid",
      key: basename(metadataPath, NARRATION_CACHE_METADATA_EXTENSION),
      metadataPath,
      audioPath: null,
      version: null,
      issue: "Metadata file does not match the narration cache schema.",
    };
  }

  if (parsed.version !== currentVersion) {
    return {
      status: "obsolete",
      key: parsed.key,
      metadataPath,
      audioPath: resolveCacheArtifactPath(cacheDir, parsed.output.audioPath),
      version: parsed.version,
      issue: `Cache entry uses version ${parsed.version} instead of ${currentVersion}.`,
    };
  }

  if (parsed.output.format !== parsed.request.format) {
    return {
      status: "invalid",
      key: parsed.key,
      metadataPath,
      audioPath: resolveCacheArtifactPath(cacheDir, parsed.output.audioPath),
      version: parsed.version,
      issue: "Metadata format does not match the cached request format.",
    };
  }

  const recomputedKey = createNarrationCacheKey(parsed.request, {
    version: parsed.version,
  });

  if (recomputedKey !== parsed.key) {
    return {
      status: "invalid",
      key: parsed.key,
      metadataPath,
      audioPath: resolveCacheArtifactPath(cacheDir, parsed.output.audioPath),
      version: parsed.version,
      issue: "Metadata key does not match the canonical narration identity.",
    };
  }

  const expectedAudioFileName = `${parsed.key}.${parsed.output.format}`;

  if (parsed.output.audioPath !== expectedAudioFileName) {
    return {
      status: "invalid",
      key: parsed.key,
      metadataPath,
      audioPath: resolveCacheArtifactPath(cacheDir, parsed.output.audioPath),
      version: parsed.version,
      issue: "Metadata audio path does not match the local cache naming convention.",
    };
  }

  const audioPath = resolveCacheArtifactPath(cacheDir, parsed.output.audioPath);

  if (!isWithinDirectory(cacheDir, audioPath)) {
    return {
      status: "invalid",
      key: parsed.key,
      metadataPath,
      audioPath,
      version: parsed.version,
      issue: "Metadata audio path escapes the local cache root.",
    };
  }

  const fileStats = await stat(audioPath).catch((error: unknown) => {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  });

  if (fileStats === null) {
    return {
      status: "invalid",
      key: parsed.key,
      metadataPath,
      audioPath,
      version: parsed.version,
      issue: "Cached audio file is missing.",
    };
  }

  if (fileStats.size !== parsed.output.byteSize) {
    return {
      status: "invalid",
      key: parsed.key,
      metadataPath,
      audioPath,
      version: parsed.version,
      issue: "Cached audio byte size does not match metadata.",
    };
  }

  if (!Number.isFinite(parsed.output.durationMs) || parsed.output.durationMs < 0) {
    return {
      status: "invalid",
      key: parsed.key,
      metadataPath,
      audioPath,
      version: parsed.version,
      issue: "Cached audio duration is invalid.",
    };
  }

  const checksum = await hashFile(audioPath);

  if (checksum !== parsed.output.sha256) {
    return {
      status: "invalid",
      key: parsed.key,
      metadataPath,
      audioPath,
      version: parsed.version,
      issue: "Cached audio checksum does not match metadata.",
    };
  }

  return {
    status: "ready",
    entry: toNarrationCacheEntry({
      metadata: parsed,
      metadataPath,
      audioPath,
    }),
  };
}

type PersistNarrationCacheEntryOptions = {
  cacheDir: string;
  key: string;
  request: NarrationRequest;
  version: number;
  synthesized: NarrationSynthesisResult;
  measureDurationMs: (audioPath: string) => Promise<number>;
  now: () => Date;
};

async function persistNarrationCacheEntry(
  options: PersistNarrationCacheEntryOptions,
): Promise<NarrationCacheEntry> {
  const paths = getNarrationCachePaths({
    cacheDir: options.cacheDir,
    key: options.key,
    format: options.request.format,
  });

  await removeCacheArtifacts(paths.metadataPath, paths.audioPath);

  try {
    await writeAudioArtifact(paths.audioPath, options.synthesized);

    const durationMs = await options.measureDurationMs(paths.audioPath);

    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new Error(`Narration duration must be a non-negative finite value: ${durationMs}`);
    }

    const audioBytes = await readFile(paths.audioPath);
    const metadata: NarrationCacheMetadata = {
      key: options.key,
      version: options.version,
      createdAt: options.now().toISOString(),
      request: options.request,
      output: {
        format: options.request.format,
        audioPath: basename(paths.audioPath),
        byteSize: audioBytes.byteLength,
        durationMs,
        sha256: hashBytes(audioBytes),
      },
    };

    await writeJsonAtomically(paths.metadataPath, metadata);

    return toNarrationCacheEntry({
      metadata,
      metadataPath: paths.metadataPath,
      audioPath: paths.audioPath,
    });
  } catch (error) {
    await removeCacheArtifacts(paths.metadataPath, paths.audioPath);
    throw error;
  }
}

async function writeAudioArtifact(
  audioPath: string,
  synthesized: NarrationSynthesisResult,
): Promise<void> {
  const temporaryPath = createTemporaryPath(audioPath);

  try {
    if (synthesized.output.kind === "bytes") {
      if (synthesized.output.bytes.byteLength === 0) {
        throw new Error("Narration providers must return non-empty audio bytes.");
      }

      await writeFile(temporaryPath, synthesized.output.bytes);
    } else {
      await copyFile(synthesized.output.path, temporaryPath);

      const copied = await stat(temporaryPath);

      if (copied.size === 0) {
        throw new Error("Narration providers must return a non-empty audio file.");
      }
    }

    await rename(temporaryPath, audioPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function writeJsonAtomically(path: string, payload: NarrationCacheMetadata): Promise<void> {
  const temporaryPath = createTemporaryPath(path);

  try {
    await writeFile(temporaryPath, JSON.stringify(payload, null, 2), "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function readNarrationCacheEntry(options: {
  cacheDir: string;
  key: string;
  metadataPath: string;
  currentVersion: number;
}): Promise<NarrationCacheInspection | null> {
  const inspection = await inspectNarrationCacheMetadataFile({
    cacheDir: options.cacheDir,
    metadataPath: options.metadataPath,
    currentVersion: options.currentVersion,
  });

  if (inspection.status !== "ready" || inspection.entry.key === options.key) {
    return inspection;
  }

  return {
    status: "invalid",
    key: inspection.entry.key,
    metadataPath: inspection.entry.metadataPath,
    audioPath: inspection.entry.audioPath,
    version: inspection.entry.metadata.version,
    issue: "Metadata key does not match the requested cache entry.",
  };
}

function getNarrationCachePaths(options: {
  cacheDir: string;
  key: string;
  format: string;
}): {
  metadataPath: string;
  audioPath: string;
} {
  return {
    metadataPath: join(options.cacheDir, `${options.key}${NARRATION_CACHE_METADATA_EXTENSION}`),
    audioPath: join(options.cacheDir, `${options.key}.${options.format}`),
  };
}

function resolveCacheDir(cacheDir: string): string {
  if (cacheDir.trim().length === 0) {
    throw new Error("Narration cache directory must not be empty.");
  }

  return resolve(cacheDir);
}

function resolveCacheArtifactPath(cacheDir: string, relativeArtifactPath: string): string {
  return resolve(cacheDir, relativeArtifactPath);
}

function toNarrationCacheEntry(options: {
  metadata: NarrationCacheMetadata;
  metadataPath: string;
  audioPath: string;
}): NarrationCacheEntry {
  return {
    key: options.metadata.key,
    audioPath: options.audioPath,
    metadataPath: options.metadataPath,
    byteSize: options.metadata.output.byteSize,
    durationMs: options.metadata.output.durationMs,
    metadata: options.metadata,
  };
}

function assertSynthesisMatchesRequest(
  synthesized: NarrationSynthesisResult,
  request: NarrationRequest,
): void {
  const requestIdentity = createNarrationCacheIdentity(request, {
    version: NARRATION_CACHE_SCHEMA_VERSION,
  });
  const synthesizedIdentity = createNarrationCacheIdentity(synthesized.request, {
    version: NARRATION_CACHE_SCHEMA_VERSION,
  });

  if (JSON.stringify(requestIdentity) !== JSON.stringify(synthesizedIdentity)) {
    throw new Error("Narration provider returned a request that does not match the requested cache identity.");
  }

  if (
    synthesized.metadata.provider !== request.provider
    || synthesized.metadata.model !== request.model
    || synthesized.metadata.voice !== request.voice
    || synthesized.metadata.format !== request.format
    || synthesized.metadata.sampleRate !== request.sampleRate
    || synthesized.metadata.language !== request.language
    || JSON.stringify(createNarrationCacheIdentity({
      ...request,
      providerOptions: synthesized.metadata.providerOptions,
    }).providerOptions) !== JSON.stringify(requestIdentity.providerOptions)
  ) {
    throw new Error("Narration provider returned metadata that does not match the requested cache identity.");
  }
}

async function finalizeSynthesisOutput(
  synthesized: NarrationSynthesisResult,
  failure: { error: unknown } | undefined,
): Promise<void> {
  if (synthesized.output.kind !== "file" || synthesized.output.finalize === undefined) {
    return;
  }

  const outcome: NarrationSynthesisFinalizeOutcome = failure === undefined
    ? { status: "persisted" }
    : { status: "failed", error: failure.error };

  try {
    await synthesized.output.finalize(outcome);
  } catch (finalizeError) {
    if (failure === undefined) {
      throw finalizeError;
    }

    throw new AggregateError(
      [failure.error, finalizeError],
      "Narration persistence failed and provider output cleanup also failed.",
      { cause: failure.error },
    );
  }
}

function isNarrationProviderPlugin(
  provider: NarrationProvider | NarrationProviderPlugin,
): provider is NarrationProviderPlugin {
  return "name" in provider && "capabilities" in provider && "prepareRequest" in provider;
}

async function hashFile(path: string): Promise<string> {
  const bytes = await readFile(path);

  return hashBytes(bytes);
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function removeCacheArtifacts(metadataPath: string, audioPath: string | null): Promise<void> {
  await rm(metadataPath, { force: true });

  if (audioPath !== null) {
    await rm(audioPath, { force: true });
  }
}

function createTemporaryPath(path: string): string {
  return `${path}.${randomUUID()}.tmp`;
}

function isNarrationCacheMetadata(value: unknown): value is NarrationCacheMetadata {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<NarrationCacheMetadata>;

  return (
    typeof candidate.key === "string"
    && typeof candidate.version === "number"
    && typeof candidate.createdAt === "string"
    && isNarrationRequest(candidate.request)
    && typeof candidate.output === "object"
    && candidate.output !== null
    && typeof candidate.output.format === "string"
    && typeof candidate.output.audioPath === "string"
    && typeof candidate.output.byteSize === "number"
    && typeof candidate.output.durationMs === "number"
    && typeof candidate.output.sha256 === "string"
  );
}

function isNarrationRequest(value: unknown): value is NarrationRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<NarrationRequest>;

  return (
    typeof candidate.provider === "string"
    && typeof candidate.model === "string"
    && typeof candidate.voice === "string"
    && typeof candidate.format === "string"
    && typeof candidate.sampleRate === "number"
    && typeof candidate.instructions === "string"
    && typeof candidate.text === "string"
  );
}

function isWithinDirectory(directory: string, target: string): boolean {
  if (directory === target) {
    return true;
  }

  const prefix = directory.endsWith(sep) ? directory : `${directory}${sep}`;

  return target.startsWith(prefix);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT"
  );
}

async function runCommand(command: string, args: string[]): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr.trim() || error.message;

        reject(new Error(`Failed to measure narration audio with ${command}: ${detail}`));
        return;
      }

      resolvePromise(stdout);
    });
  });
}
