import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
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

const NARRATION_CACHE_LOCK_DIRECTORY = ".locks";
const DEFAULT_CACHE_LOCK_WAIT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_CACHE_LOCK_STALE_MS = 10 * 60_000;
const DEFAULT_CACHE_LOCK_POLL_INTERVAL_MS = 50;

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
  /** Maximum time spent waiting for another process writing the same cache key. */
  lockWaitTimeoutMs?: number;
  /** Lease age after which a lock whose owner is no longer alive may be recovered. */
  lockStaleMs?: number;
  /** Poll interval used while another process owns the same cache key. */
  lockPollIntervalMs?: number;
};

export type MeasureNarrationAudioDurationOptions = {
  ffprobeCommand?: string;
  signal?: AbortSignal;
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

type CacheKeyLockWaiter = {
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  onAbort: () => void;
};

type CacheKeyLockState = {
  held: boolean;
  waiters: CacheKeyLockWaiter[];
};

type FilesystemCacheLockOwner = {
  schema: 1;
  token: string;
  pid: number;
  hostname: string;
  createdAt: string;
};

type FilesystemCacheLock = {
  release(): Promise<void>;
};

const cacheKeyLocks = new Map<string, CacheKeyLockState>();

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
  const releaseCacheKey = await acquireCacheKeyLock(`${cacheDir}\0${key}`, signal);
  let filesystemLock: FilesystemCacheLock | undefined;
  let operationError: unknown;
  try {
    filesystemLock = await acquireFilesystemCacheLock({
      cacheDir,
      key,
      signal,
      waitTimeoutMs: positiveLockOption(
        options.lockWaitTimeoutMs,
        DEFAULT_CACHE_LOCK_WAIT_TIMEOUT_MS,
        "lockWaitTimeoutMs",
      ),
      staleMs: positiveLockOption(
        options.lockStaleMs,
        DEFAULT_CACHE_LOCK_STALE_MS,
        "lockStaleMs",
      ),
      pollIntervalMs: positiveLockOption(
        options.lockPollIntervalMs,
        DEFAULT_CACHE_LOCK_POLL_INTERVAL_MS,
        "lockPollIntervalMs",
      ),
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
      await removeCacheArtifacts(cacheDir, cached.metadataPath, cached.audioPath);
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
        signal,
        measureDurationMs: options.measureDurationMs,
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

    signal.throwIfAborted();
    return {
      source: "provider",
      entry,
    };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let releaseError: unknown;

    try {
      await filesystemLock?.release();
    } catch (error) {
      releaseError = error;
    } finally {
      releaseCacheKey();
    }

    if (releaseError !== undefined) {
      if (operationError !== undefined) {
        throw new AggregateError(
          [operationError, releaseError],
          "Narration cache operation failed and its filesystem lock could not be released.",
          { cause: operationError },
        );
      }

      throw releaseError;
    }
  }
}

async function acquireFilesystemCacheLock(options: {
  cacheDir: string;
  key: string;
  signal: AbortSignal;
  waitTimeoutMs: number;
  staleMs: number;
  pollIntervalMs: number;
}): Promise<FilesystemCacheLock> {
  const lockRoot = join(options.cacheDir, NARRATION_CACHE_LOCK_DIRECTORY);
  const lockPath = join(lockRoot, `${options.key}.lock`);
  const startedAt = Date.now();

  await mkdir(lockRoot, { recursive: true });

  while (true) {
    options.signal.throwIfAborted();
    const token = randomUUID();

    try {
      await mkdir(lockPath);
      const owner: FilesystemCacheLockOwner = {
        schema: 1,
        token,
        pid: process.pid,
        hostname: hostname(),
        createdAt: new Date().toISOString(),
      };

      try {
        await writeFile(join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }

      return createFilesystemCacheLock(lockPath, owner, options.staleMs);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }

    if (await recoverStaleFilesystemCacheLock(lockPath, options.staleMs)) {
      continue;
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= options.waitTimeoutMs) {
      throw new Error(
        `Timed out after ${options.waitTimeoutMs}ms waiting for narration cache key ${options.key} to be released by another process.`,
      );
    }

    await abortableDelay(
      Math.min(options.pollIntervalMs, options.waitTimeoutMs - elapsedMs),
      options.signal,
    );
  }
}

function createFilesystemCacheLock(
  lockPath: string,
  owner: FilesystemCacheLockOwner,
  staleMs: number,
): FilesystemCacheLock {
  const heartbeatIntervalMs = Math.max(1, Math.min(30_000, Math.floor(staleMs / 3)));
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(lockPath, now, now).catch(() => undefined);
  }, heartbeatIntervalMs);
  heartbeat.unref();
  let released = false;

  return {
    async release() {
      if (released) return;
      released = true;
      clearInterval(heartbeat);

      const currentOwner = await readFilesystemCacheLockOwner(lockPath);
      if (currentOwner === null) return;
      if (currentOwner.token !== owner.token) {
        throw new Error("Refusing to release a narration cache filesystem lock owned by another process.");
      }

      const releasePath = `${lockPath}.release-${owner.token}`;
      try {
        await rename(lockPath, releasePath);
      } catch (error) {
        if (isMissingFileError(error)) return;
        throw error;
      }
      await rm(releasePath, { recursive: true, force: true });
    },
  };
}

async function recoverStaleFilesystemCacheLock(lockPath: string, staleMs: number): Promise<boolean> {
  const firstStats = await stat(lockPath).catch((error: unknown) => {
    if (isMissingFileError(error)) return null;
    throw error;
  });
  if (firstStats === null) return true;
  if (Date.now() - firstStats.mtimeMs < staleMs) return false;

  const firstOwnerText = await readFile(join(lockPath, "owner.json"), "utf8").catch((error: unknown) => {
    if (isMissingFileError(error)) return null;
    throw error;
  });
  const firstOwner = parseFilesystemCacheLockOwner(firstOwnerText);

  if (
    firstOwner !== null
    && firstOwner.hostname === hostname()
    && isProcessAlive(firstOwner.pid)
  ) {
    return false;
  }

  const secondStats = await stat(lockPath).catch((error: unknown) => {
    if (isMissingFileError(error)) return null;
    throw error;
  });
  if (secondStats === null) return true;
  if (secondStats.mtimeMs !== firstStats.mtimeMs || Date.now() - secondStats.mtimeMs < staleMs) {
    return false;
  }

  const secondOwnerText = await readFile(join(lockPath, "owner.json"), "utf8").catch((error: unknown) => {
    if (isMissingFileError(error)) return null;
    throw error;
  });
  if (secondOwnerText !== firstOwnerText) return false;

  const quarantinePath = `${lockPath}.stale-${randomUUID()}`;
  try {
    await rename(lockPath, quarantinePath);
  } catch (error) {
    if (isMissingFileError(error)) return true;
    throw error;
  }

  await rm(quarantinePath, { recursive: true, force: true });
  return true;
}

async function readFilesystemCacheLockOwner(lockPath: string): Promise<FilesystemCacheLockOwner | null> {
  const text = await readFile(join(lockPath, "owner.json"), "utf8").catch((error: unknown) => {
    if (isMissingFileError(error)) return null;
    throw error;
  });

  return parseFilesystemCacheLockOwner(text);
}

function parseFilesystemCacheLockOwner(text: string | null): FilesystemCacheLockOwner | null {
  if (text === null) return null;

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<FilesystemCacheLockOwner>;

  return candidate.schema === 1
    && typeof candidate.token === "string"
    && candidate.token.length > 0
    && Number.isInteger(candidate.pid)
    && (candidate.pid ?? 0) > 0
    && typeof candidate.hostname === "string"
    && candidate.hostname.length > 0
    && typeof candidate.createdAt === "string"
    ? candidate as FilesystemCacheLockOwner
    : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ESRCH"
    );
  }
}

function positiveLockOption(value: number | undefined, fallback: number, name: string): number {
  const resolvedValue = value ?? fallback;
  if (!Number.isInteger(resolvedValue) || resolvedValue <= 0) {
    throw new Error(`Narration cache ${name} must be a positive integer.`);
  }
  return resolvedValue;
}

async function abortableDelay(durationMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();

  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise();
    }, durationMs);
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "EEXIST"
  );
}

function acquireCacheKeyLock(key: string, signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  const state = cacheKeyLocks.get(key) ?? { held: false, waiters: [] };
  cacheKeyLocks.set(key, state);

  return new Promise((resolveLock, reject) => {
    const waiter: CacheKeyLockWaiter = {
      signal,
      resolve: resolveLock,
      reject,
      onAbort: () => {
        const index = state.waiters.indexOf(waiter);

        if (index !== -1) {
          state.waiters.splice(index, 1);
          signal.removeEventListener("abort", waiter.onAbort);
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        }
      },
    };

    if (!state.held) {
      state.held = true;
      resolveLock(createCacheKeyRelease(key, state));
      return;
    }

    state.waiters.push(waiter);
    signal.addEventListener("abort", waiter.onAbort, { once: true });

    if (signal.aborted) {
      waiter.onAbort();
    }
  });
}

function createCacheKeyRelease(key: string, state: CacheKeyLockState): () => void {
  let released = false;

  return () => {
    if (released) return;
    released = true;

    while (state.waiters.length > 0) {
      const waiter = state.waiters.shift()!;
      waiter.signal.removeEventListener("abort", waiter.onAbort);

      if (waiter.signal.aborted) {
        waiter.reject(waiter.signal.reason ?? new DOMException("Aborted", "AbortError"));
        continue;
      }

      waiter.resolve(createCacheKeyRelease(key, state));
      return;
    }

    state.held = false;
    if (cacheKeyLocks.get(key) === state) cacheKeyLocks.delete(key);
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
  ], options.signal);
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
      audioPath: resolveCacheArtifactPathForRemoval(cacheDir, parsed.output.audioPath),
      version: parsed.version,
      issue: `Cache entry uses version ${parsed.version} instead of ${currentVersion}.`,
    };
  }

  if (parsed.output.format !== parsed.request.format) {
    return {
      status: "invalid",
      key: parsed.key,
      metadataPath,
      audioPath: resolveCacheArtifactPathForRemoval(cacheDir, parsed.output.audioPath),
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
      audioPath: resolveCacheArtifactPathForRemoval(cacheDir, parsed.output.audioPath),
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
      audioPath: resolveCacheArtifactPathForRemoval(cacheDir, parsed.output.audioPath),
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
  signal: AbortSignal;
  measureDurationMs?: (audioPath: string) => Promise<number>;
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

  options.signal.throwIfAborted();
  await removeCacheArtifacts(options.cacheDir, paths.metadataPath, paths.audioPath);

  try {
    options.signal.throwIfAborted();
    await writeAudioArtifact(paths.audioPath, options.synthesized, options.signal);
    options.signal.throwIfAborted();

    const durationMs = options.measureDurationMs === undefined
      ? await measureNarrationAudioDuration(paths.audioPath, { signal: options.signal })
      : await waitForAbortable(options.measureDurationMs(paths.audioPath), options.signal);
    options.signal.throwIfAborted();

    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new Error(`Narration duration must be a non-negative finite value: ${durationMs}`);
    }

    const audioBytes = await readFile(paths.audioPath);
    options.signal.throwIfAborted();
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
    options.signal.throwIfAborted();

    return toNarrationCacheEntry({
      metadata,
      metadataPath: paths.metadataPath,
      audioPath: paths.audioPath,
    });
  } catch (error) {
    await removeCacheArtifacts(options.cacheDir, paths.metadataPath, paths.audioPath);
    throw error;
  }
}

async function writeAudioArtifact(
  audioPath: string,
  synthesized: NarrationSynthesisResult,
  signal: AbortSignal,
): Promise<void> {
  const temporaryPath = createTemporaryPath(audioPath);

  try {
    signal.throwIfAborted();
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

    signal.throwIfAborted();
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
  const metadataPath = join(options.cacheDir, `${options.key}${NARRATION_CACHE_METADATA_EXTENSION}`);
  const audioPath = join(options.cacheDir, `${options.key}.${options.format}`);

  if (!isDirectCacheArtifact(options.cacheDir, metadataPath) || !isDirectCacheArtifact(options.cacheDir, audioPath)) {
    throw new Error(`Narration output format ${JSON.stringify(options.format)} cannot be used as a cache file extension.`);
  }

  return { metadataPath, audioPath };
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

function resolveCacheArtifactPathForRemoval(cacheDir: string, relativeArtifactPath: string): string | null {
  const artifactPath = resolveCacheArtifactPath(cacheDir, relativeArtifactPath);

  return isDirectCacheArtifact(cacheDir, artifactPath) ? artifactPath : null;
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

async function removeCacheArtifacts(
  cacheDir: string,
  metadataPath: string,
  audioPath: string | null,
): Promise<void> {
  if (!isDirectCacheArtifact(cacheDir, metadataPath)) {
    throw new Error("Refusing to remove narration cache metadata outside the cache root.");
  }

  await rm(metadataPath, { force: true });

  if (audioPath !== null && isDirectCacheArtifact(cacheDir, audioPath)) {
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

function isDirectCacheArtifact(cacheDir: string, target: string): boolean {
  const root = resolve(cacheDir);
  const artifact = resolve(target);

  return artifact !== root
    && isWithinDirectory(root, artifact)
    && resolve(root, basename(artifact)) === artifact;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT"
  );
}

async function waitForAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();

  return await new Promise<T>((resolvePromise, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolvePromise(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );

    if (signal.aborted) onAbort();
  });
}

async function runCommand(command: string, args: string[], signal?: AbortSignal): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    execFile(command, args, { encoding: "utf8", signal }, (error, stdout, stderr) => {
      if (error) {
        if (signal?.aborted) {
          reject(signal.reason ?? error);
          return;
        }

        const detail = stderr.trim() || error.message;

        reject(new Error(`Failed to measure narration audio with ${command}: ${detail}`));
        return;
      }

      resolvePromise(stdout);
    });
  });
}
