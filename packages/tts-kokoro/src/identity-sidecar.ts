import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const KOKORO_IDENTITY_SIDECAR_SCHEMA = 1;

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

export type ResolveKokoroIdentityOptions = {
  cacheDir: string;
  modelPath: string;
  voicesPath: string;
  backendVersion: string;
  protocolIdentity: string;
  now?: () => Date;
};

export function kokoroIdentitySidecarPath(options: Pick<ResolveKokoroIdentityOptions, "cacheDir" | "modelPath" | "voicesPath">): string {
  const locator = sha256(`${resolve(options.modelPath)}\0${resolve(options.voicesPath)}`);
  return join(resolve(options.cacheDir), ".kokoro", "identities", `${locator}.json`);
}

export async function resolveKokoroAssetIdentity(options: ResolveKokoroIdentityOptions): Promise<KokoroAssetIdentity> {
  const model = await regularFileState(options.modelPath);
  const voices = await regularFileState(options.voicesPath);
  const sidecarPath = kokoroIdentitySidecarPath(options);
  const common = {
    backendVersionSha256: sha256(options.backendVersion),
    protocolSha256: sha256(options.protocolIdentity),
  };

  if ((model === null) !== (voices === null)) {
    throw new Error("Kokoro model and voices assets must either both exist or both be unavailable; partial assets are ambiguous.");
  }

  if (model !== null && voices !== null) {
    const [modelSha256, voicesSha256] = await Promise.all([hashFile(options.modelPath), hashFile(options.voicesPath)]);
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
  const [modelSha256, voicesSha256] = await Promise.all([hashFile(options.modelPath), hashFile(options.voicesPath)]).catch((error: unknown) => {
    throw new Error("Kokoro model or voices file is missing; synthesis requires both local assets.", { cause: error });
  });
  if (modelSha256 !== identity.modelSha256 || voicesSha256 !== identity.voicesSha256) {
    throw new Error("Kokoro model or voices file changed after narration preparation; retry to refresh cache identity.");
  }
}

async function regularFileState(path: string): Promise<true | null> {
  const value = await stat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (value === null) return null;
  if (!value.isFile()) throw new Error(`Kokoro asset is not a regular file: ${resolve(path)}`);
  return true;
}

async function hashFile(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
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

function isSidecar(value: unknown): value is Sidecar {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.schema === 1 && typeof v.backendVersion === "string" && typeof v.protocol === "string"
    && isDigest(v.modelSha256) && isDigest(v.voicesSha256) && typeof v.verifiedAt === "string" && typeof v.writeId === "string";
}

function isDigest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }

async function atomicWriteJson(path: string, value: Sidecar): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
}
