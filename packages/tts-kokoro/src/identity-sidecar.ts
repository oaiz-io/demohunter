import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const KOKORO_IDENTITY_SIDECAR_SCHEMA = 1;
export const DEFAULT_MAX_KOKORO_ASSET_BYTES = 4 * 1024 * 1024 * 1024;

export type KokoroAssetIdentity = {
  modelSha256: string;
  voicesSha256: string;
  backendVersionSha256: string;
  protocolSha256: string;
  freshlyVerified: boolean;
};

type Sidecar = {
  schema: 1;
  backendVersion: string;
  protocol: string;
  modelSha256: string;
  voicesSha256: string;
  verifiedAt: string;
  writeId: string;
};

type RuntimeSidecar = {
  schema: 1;
  protocol: string;
  backendVersion: string;
  modelSha256: string;
  voicesSha256: string;
  verifiedAt: string;
  writeId: string;
};

export type KokoroRuntimeIdentity = Pick<RuntimeSidecar, "backendVersion" | "modelSha256" | "voicesSha256">;

export type ResolveKokoroIdentityOptions = {
  cacheDir: string;
  modelPath: string;
  voicesPath: string;
  backendVersion: string;
  protocolIdentity: string;
  signal?: AbortSignal;
  maxAssetBytes?: number;
  now?: () => Date;
};

export function kokoroIdentitySidecarPath(options: Pick<ResolveKokoroIdentityOptions, "cacheDir" | "modelPath" | "voicesPath">): string {
  const locator = sha256(`${resolve(options.modelPath)}\0${resolve(options.voicesPath)}`);
  return join(resolve(options.cacheDir), ".kokoro", "identities", `${locator}.json`);
}

export function kokoroRuntimeIdentitySidecarPath(options: { cacheDir: string; runtimeLocator: string }): string {
  return join(resolve(options.cacheDir), ".kokoro", "runtime-identities", `${sha256(options.runtimeLocator)}.json`);
}

export async function resolveKokoroRuntimeIdentity(options: {
  cacheDir: string;
  runtimeLocator: string;
  protocolIdentity: string;
  expectedBackendVersion?: string;
  advertised?: KokoroRuntimeIdentity;
  now?: () => Date;
}): Promise<KokoroRuntimeIdentity> {
  const sidecarPath = kokoroRuntimeIdentitySidecarPath(options);
  if (options.advertised !== undefined) {
    return persistKokoroRuntimeIdentity({ ...options, advertised: options.advertised });
  }

  const sidecar = await readRuntimeSidecar(sidecarPath);
  if (sidecar === null) throw new Error("Kokoro executable not found and no verified offline runtime identity is available.");
  if (sidecar.protocol !== options.protocolIdentity) throw new Error("Kokoro offline runtime identity sidecar is incompatible with the protocol version.");
  if (options.expectedBackendVersion !== undefined && sidecar.backendVersion !== options.expectedBackendVersion) {
    throw new Error("Kokoro offline runtime identity sidecar is incompatible with the configured backend version.");
  }
  return {
    backendVersion: sidecar.backendVersion,
    modelSha256: sidecar.modelSha256,
    voicesSha256: sidecar.voicesSha256,
  };
}

export function validateKokoroRuntimeIdentity(options: {
  expectedBackendVersion?: string;
  advertised: KokoroRuntimeIdentity;
}): KokoroRuntimeIdentity {
  if (options.expectedBackendVersion !== undefined && options.advertised.backendVersion !== options.expectedBackendVersion) {
    throw new Error(`Kokoro worker backend version ${JSON.stringify(options.advertised.backendVersion)} does not match required version ${JSON.stringify(options.expectedBackendVersion)}.`);
  }
  if (options.advertised.backendVersion.trim() === ""
    || !isDigest(options.advertised.modelSha256)
    || !isDigest(options.advertised.voicesSha256)) {
    throw new Error("Kokoro worker advertised an invalid runtime identity.");
  }
  return options.advertised;
}

export async function persistKokoroRuntimeIdentity(options: {
  cacheDir: string;
  runtimeLocator: string;
  protocolIdentity: string;
  expectedBackendVersion?: string;
  advertised: KokoroRuntimeIdentity;
  now?: () => Date;
}): Promise<KokoroRuntimeIdentity> {
  const advertised = validateKokoroRuntimeIdentity(options);
  const record: RuntimeSidecar = {
    schema: 1,
    protocol: options.protocolIdentity,
    backendVersion: advertised.backendVersion,
    modelSha256: advertised.modelSha256,
    voicesSha256: advertised.voicesSha256,
    verifiedAt: (options.now?.() ?? new Date()).toISOString(),
    writeId: randomUUID(),
  };
  await atomicWriteJson(kokoroRuntimeIdentitySidecarPath(options), record);
  return advertised;
}

export async function resolveKokoroAssetIdentity(options: ResolveKokoroIdentityOptions): Promise<KokoroAssetIdentity> {
  const [modelSha256, voicesSha256] = await Promise.all([
    hashKokoroAssetIfPresent(options.modelPath, options),
    hashKokoroAssetIfPresent(options.voicesPath, options),
  ]);
  const sidecarPath = kokoroIdentitySidecarPath(options);
  const common = {
    backendVersionSha256: sha256(options.backendVersion),
    protocolSha256: sha256(options.protocolIdentity),
  };

  if ((modelSha256 === null) !== (voicesSha256 === null)) {
    throw new Error("Kokoro model and voices assets must either both exist or both be unavailable; partial assets are ambiguous.");
  }

  if (modelSha256 !== null && voicesSha256 !== null) {
    const record: Sidecar = {
      schema: 1,
      backendVersion: options.backendVersion,
      protocol: options.protocolIdentity,
      modelSha256,
      voicesSha256,
      verifiedAt: (options.now?.() ?? new Date()).toISOString(),
      writeId: randomUUID(),
    };
    await atomicWriteJson(sidecarPath, record);
    return { ...common, modelSha256, voicesSha256, freshlyVerified: true };
  }

  const sidecar = await readSidecar(sidecarPath);
  if (sidecar === null) {
    throw new Error(`Kokoro model file missing: ${resolve(options.modelPath)}; voices file missing: ${resolve(options.voicesPath)}; no verified offline identity is available.`);
  }
  if (sidecar.backendVersion !== options.backendVersion || sidecar.protocol !== options.protocolIdentity) {
    throw new Error("Kokoro offline identity sidecar is incompatible with the configured backend or protocol version.");
  }
  return { ...common, modelSha256: sidecar.modelSha256, voicesSha256: sidecar.voicesSha256, freshlyVerified: false };
}

export async function verifyKokoroAssets(options: ResolveKokoroIdentityOptions, identity: KokoroAssetIdentity): Promise<void> {
  const [modelSha256, voicesSha256] = await Promise.all([
    hashKokoroAssetFile(options.modelPath, options),
    hashKokoroAssetFile(options.voicesPath, options),
  ]).catch((error: unknown) => {
    if (isAbortError(error)) throw error;
    throw new Error("Kokoro model or voices file is missing; synthesis requires both local assets.", { cause: error });
  });
  if (modelSha256 !== identity.modelSha256 || voicesSha256 !== identity.voicesSha256) {
    throw new Error("Kokoro model or voices file changed after narration preparation; retry to refresh cache identity.");
  }
}

async function hashKokoroAssetIfPresent(
  path: string,
  options: Pick<ResolveKokoroIdentityOptions, "signal" | "maxAssetBytes">,
): Promise<string | null> {
  const state = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (state === null) return null;
  return hashKokoroAssetFile(path, options);
}

export async function hashKokoroAssetFile(
  path: string,
  options: { signal?: AbortSignal; maxAssetBytes?: number } = {},
): Promise<string> {
  const maxAssetBytes = options.maxAssetBytes ?? DEFAULT_MAX_KOKORO_ASSET_BYTES;
  if (!Number.isSafeInteger(maxAssetBytes) || maxAssetBytes <= 0) {
    throw new Error("Kokoro maximum asset size must be a positive safe integer.");
  }
  options.signal?.throwIfAborted();
  const before = await lstat(path);
  if (!before.isFile()) throw new Error(`Kokoro asset is not a regular file: ${resolve(path)}`);
  const noFollow = (constants as Record<string, number>).O_NOFOLLOW ?? 0;
  const nonBlock = (constants as Record<string, number>).O_NONBLOCK ?? 0;
  const handle = await open(path, constants.O_RDONLY | noFollow | nonBlock).catch((error: unknown) => {
    throw new Error(`Unable to safely open Kokoro asset: ${resolve(path)}`, { cause: error });
  });
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) {
      throw new Error(`Kokoro asset identity changed while opening it: ${resolve(path)}`);
    }
    if (opened.size <= 0 || opened.size > maxAssetBytes) {
      throw new Error(`Kokoro asset is empty or exceeds the ${maxAssetBytes}-byte safety limit: ${resolve(path)}`);
    }
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, opened.size));
    let position = 0;
    while (position < opened.size) {
      options.signal?.throwIfAborted();
      const length = Math.min(chunk.length, opened.size - position);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead === 0) throw new Error(`Kokoro asset changed or was truncated while hashing: ${resolve(path)}`);
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    options.signal?.throwIfAborted();
    const after = await handle.stat();
    if (!sameStableFile(opened, after)) {
      throw new Error(`Kokoro asset changed while hashing: ${resolve(path)}`);
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

function sameStableFile(left: Stats, right: Stats): boolean {
  return left.isFile() && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readSidecar(path: string): Promise<Sidecar | null> {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (text === null) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Kokoro offline identity sidecar is corrupt."); }
  if (!isSidecar(value)) throw new Error("Kokoro offline identity sidecar has an unsupported schema or invalid content.");
  return value;
}

async function readRuntimeSidecar(path: string): Promise<RuntimeSidecar | null> {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (text === null) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Kokoro offline runtime identity sidecar is corrupt."); }
  if (!isRuntimeSidecar(value)) throw new Error("Kokoro offline runtime identity sidecar has an unsupported schema or invalid content.");
  return value;
}

function isSidecar(value: unknown): value is Sidecar {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.schema === 1 && typeof v.backendVersion === "string" && typeof v.protocol === "string"
    && isDigest(v.modelSha256) && isDigest(v.voicesSha256) && typeof v.verifiedAt === "string" && typeof v.writeId === "string";
}

function isRuntimeSidecar(value: unknown): value is RuntimeSidecar {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.schema === 1 && typeof v.backendVersion === "string" && typeof v.protocol === "string"
    && isDigest(v.modelSha256) && isDigest(v.voicesSha256) && typeof v.verifiedAt === "string" && typeof v.writeId === "string";
}

function isDigest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }

async function atomicWriteJson(path: string, value: Sidecar | RuntimeSidecar): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
}
