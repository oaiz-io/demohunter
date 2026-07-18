import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KOKORO_PROTOCOL_IDENTITY } from "./protocol.js";
import { kokoroIdentitySidecarPath, resolveKokoroAssetIdentity, verifyKokoroAssets } from "./identity-sidecar.js";

async function fixture() { const root = await mkdtemp(join(tmpdir(), "kokoro-id-")); const modelPath = join(root, "model.onnx"); const voicesPath = join(root, "voices.bin"); await writeFile(modelPath, "model-a"); await writeFile(voicesPath, "voices-a"); return { root, cacheDir: join(root, "cache"), modelPath, voicesPath, backendVersion: "v1", protocolIdentity: KOKORO_PROTOCOL_IDENTITY }; }

describe("Kokoro asset identity", () => {
  test("hashes bytes, writes path-free sidecar, and changes on replacement", async () => { const options = await fixture(); const first = await resolveKokoroAssetIdentity(options); const text = await readFile(kokoroIdentitySidecarPath(options), "utf8"); expect(text).not.toContain(options.modelPath); await writeFile(options.modelPath, "model-b"); const second = await resolveKokoroAssetIdentity(options); expect(second.modelSha256).not.toBe(first.modelSha256); });
  test("uses compatible sidecar only when both assets are absent", async () => { const options = await fixture(); const fresh = await resolveKokoroAssetIdentity(options); await rm(options.modelPath); await rm(options.voicesPath); expect(await resolveKokoroAssetIdentity(options)).toEqual({ ...fresh, freshlyVerified: false }); await expect(verifyKokoroAssets(options, fresh)).rejects.toThrow(/missing/); });
  test("fails closed for partial assets, corrupt and incompatible sidecars", async () => { const options = await fixture(); await resolveKokoroAssetIdentity(options); await rm(options.modelPath); await expect(resolveKokoroAssetIdentity(options)).rejects.toThrow(/partial assets/); await rm(options.voicesPath); await writeFile(kokoroIdentitySidecarPath(options), "bad"); await expect(resolveKokoroAssetIdentity(options)).rejects.toThrow(/corrupt/); });
  test("detects TOCTOU asset changes before synthesis", async () => { const options = await fixture(); const identity = await resolveKokoroAssetIdentity(options); await writeFile(options.voicesPath, "changed"); await expect(verifyKokoroAssets(options, identity)).rejects.toThrow(/changed/); });
});
