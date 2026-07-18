import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_TTS_CONFIG, kokoro as kokoroDescriptor, kokoroTTS } from "../../packages/sdk/src/index.js";
import { createNarrationRequest, resolveNarrationFromCache } from "../../packages/tts-core/src/index.js";
import { kokoro } from "../../packages/tts-kokoro/src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Kokoro OSS and no-download boundary", () => {
  test("generates uncached, reuses cache without runtime/assets, rejects stale identity, and recovers corruption", async () => {
    const root = await makeTempRoot();
    const cacheDir = path.join(root, "cache");
    const modelPath = path.join(root, "model.onnx");
    const voicesPath = path.join(root, "voices.bin");
    const workerPath = path.join(root, "no-network-worker.ts");
    const executablePath = path.join(root, "kokoro-runtime");
    const invocationLog = path.join(root, "worker-invocations.jsonl");
    const originalWorker = workerSource();
    await writeFile(modelPath, "model-v1");
    await writeFile(voicesPath, "voices-v1");
    await writeFile(workerPath, originalWorker);
    await symlink(process.execPath, executablePath);

    const firstPlugin = makePlugin({ executablePath, modelPath, voicesPath, workerPath, invocationLog });
    const first = await resolveNarrationFromCache({
      cacheDir,
      provider: firstPlugin,
      request: request("Unicode café 日本語 🌍"),
      measureDurationMs: async () => 25,
    });
    expect(first.source).toBe("provider");
    expect((await readFile(invocationLog, "utf8")).trim().split("\n")).toHaveLength(1);
    await firstPlugin.close?.({});

    const metadataText = await readFile(first.entry.metadataPath, "utf8");
    const sidecars = await readdir(path.join(cacheDir, ".kokoro/identities"));
    expect(sidecars).toHaveLength(1);
    const sidecarText = await readFile(path.join(cacheDir, ".kokoro/identities", sidecars[0]!), "utf8");
    for (const forbidden of [process.execPath, root, workerPath, modelPath, voicesPath]) {
      expect(metadataText).not.toContain(forbidden);
      expect(sidecarText).not.toContain(forbidden);
    }
    expect(metadataText).toContain('"provider": "kokoro"');
    expect(metadataText).toMatch(/[a-f0-9]{64}/);

    await Promise.all([rm(modelPath), rm(voicesPath), rm(workerPath), rm(executablePath)]);
    const offlinePlugin = kokoro({
      runtime: "command",
      executable: executablePath,
      args: [workerPath],
      modelPath,
      voicesPath,
      modelVersion: "fixture-1",
      startupTimeoutMs: 200,
      requestTimeoutMs: 200,
      shutdownTimeoutMs: 200,
    });
    const offline = await resolveNarrationFromCache({
      cacheDir,
      provider: offlinePlugin,
      request: request("Unicode café 日本語 🌍"),
      measureDurationMs: async () => { throw new Error("cache hit must not probe audio"); },
    });
    expect(offline.source).toBe("cache");
    expect(offline.entry.key).toBe(first.entry.key);

    await writeFile(first.entry.audioPath, "corrupt cache audio");
    await expect(resolveNarrationFromCache({
      cacheDir,
      provider: offlinePlugin,
      request: request("Unicode café 日本語 🌍"),
      measureDurationMs: async () => 25,
    })).rejects.toThrow(/(?:executable not found|model or voices file is missing)/);
    await offlinePlugin.close?.({});

    const stalePlugin = kokoro({
      runtime: "command",
      executable: executablePath,
      args: [workerPath],
      modelPath,
      voicesPath,
      modelVersion: "fixture-2",
    });
    await expect(resolveNarrationFromCache({
      cacheDir,
      provider: stalePlugin,
      request: request("Unicode café 日本語 🌍"),
      measureDurationMs: async () => 25,
    })).rejects.toThrow(/sidecar is incompatible/);
    await stalePlugin.close?.({});

    await writeFile(modelPath, "model-v2-replaced-in-place");
    await writeFile(voicesPath, "voices-v1");
    await writeFile(workerPath, originalWorker);
    await symlink(process.execPath, executablePath);
    const replacementPlugin = makePlugin({ executablePath, modelPath, voicesPath, workerPath, invocationLog });
    const replacement = await resolveNarrationFromCache({
      cacheDir,
      provider: replacementPlugin,
      request: request("Unicode café 日本語 🌍"),
      measureDurationMs: async () => 25,
    });
    expect(replacement.source).toBe("provider");
    expect(replacement.entry.key).not.toBe(first.entry.key);
    expect((await readFile(invocationLog, "utf8")).trim().split("\n")).toHaveLength(2);
    await replacementPlugin.close?.({});
  }, 15_000);

  test("ships only a process adapter and preserves the OpenAI default and authored compatibility surface", async () => {
    const sources = await Promise.all([
      readFile(path.join(repoRoot, "packages/tts-kokoro/src/kokoro-provider.ts"), "utf8"),
      readFile(path.join(repoRoot, "packages/tts-kokoro/src/worker-client.ts"), "utf8"),
      readFile(path.join(repoRoot, "packages/tts-kokoro/worker/demohunter_kokoro_worker.py"), "utf8"),
      readFile(path.join(repoRoot, "packages/cli/src/commands/doctor.ts"), "utf8"),
      readFile(path.join(repoRoot, "packages/cli/src/commands/generate.ts"), "utf8"),
    ]);
    const implementation = sources.join("\n");

    expect(implementation).not.toMatch(/(?:pip|pip3|uv|conda|npm|bun)\s+(?:install|add)|curl\s|wget\s|huggingface_hub|snapshot_download/);
    expect(implementation).not.toMatch(/https?:\/\//);
    expect(implementation).toContain("shell: false");
    expect(DEFAULT_TTS_CONFIG.provider).toBe("openai");
    expect(kokoroTTS({ voice: "af_heart", language: "en-US" })).toMatchObject({
      provider: "kokoro",
      format: "wav",
      instructions: "",
    });
    expect(kokoroDescriptor({ runtime: "command", executable: "kokoro" })).toEqual({
      name: "kokoro",
      options: { runtime: "command", executable: "kokoro" },
    });
  });
});

function makePlugin(input: { executablePath: string; modelPath: string; voicesPath: string; workerPath: string; invocationLog: string }) {
  return kokoro({
    runtime: "command",
    executable: input.executablePath,
    args: [input.workerPath],
    env: {
      KOKORO_INVOCATION_LOG: input.invocationLog,
      KOKORO_MODEL_PATH: input.modelPath,
      KOKORO_VOICES_PATH: input.voicesPath,
    },
    modelPath: input.modelPath,
    voicesPath: input.voicesPath,
    modelVersion: "fixture-1",
    startupTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000,
  });
}

function request(text: string) {
  return createNarrationRequest({
    provider: "kokoro",
    model: "kokoro-82m",
    voice: "af_heart",
    language: "en-US",
    format: "wav",
    sampleRate: 24_000,
    instructions: "",
    providerOptions: { speed: 1 },
    text,
  });
}

function workerSource(): string {
  return `import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
const encoder = new TextEncoder();
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function wave(text) {
  const data = encoder.encode(text || "x");
  const padded = data.length + (data.length % 2);
  const out = new Uint8Array(44 + padded);
  const view = new DataView(out.buffer);
  out.set(encoder.encode("RIFF"), 0); view.setUint32(4, 36 + padded, true); out.set(encoder.encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 24000, true);
  view.setUint32(28, 48000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); out.set(encoder.encode("data"), 36); view.setUint32(40, padded, true); out.set(data, 44);
  return out;
}
send({ protocol: 1, op: "ready", backendVersion: "fixture-1", modelSha256: createHash("sha256").update(await readFile(process.env.KOKORO_MODEL_PATH)).digest("hex"), voicesSha256: createHash("sha256").update(await readFile(process.env.KOKORO_VOICES_PATH)).digest("hex") });
for await (const line of console) {
  const request = JSON.parse(line);
  if (request.op === "shutdown") { send({ protocol: 1, id: request.id, ok: true }); process.exit(0); }
  await appendFile(process.env.KOKORO_INVOCATION_LOG, JSON.stringify({ text: request.text }) + "\\n");
  await Bun.write(request.outputPath, wave(request.text));
  send({ protocol: 1, id: request.id, ok: true, path: request.outputPath, format: "wav", sampleRate: 24000 });
}
`;
}

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "demohunter-kokoro-oss-"));
  tempRoots.push(root);
  return root;
}
