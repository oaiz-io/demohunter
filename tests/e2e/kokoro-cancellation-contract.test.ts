import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { generateCommand } from "../../packages/cli/src/commands/generate.js";
import {
  createNarrationProviderRegistry,
  createNarrationRequest,
  resolveNarrationFromCache,
  type NarrationProviderPlugin,
  type NarrationProviderRegistry,
} from "../../packages/tts-core/src/index.js";
import { kokoro } from "../../packages/tts-kokoro/src/index.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Kokoro cancellation and lifecycle contract", () => {
  test("aborts an active child, rejects queued work before start, and removes staging", async () => {
    const fixture = await setupWorker("hang");
    const plugin = fixture.plugin;
    const activeController = new AbortController();
    const queuedController = new AbortController();
    const active = resolveNarrationFromCache({
      cacheDir: fixture.cacheDir,
      provider: plugin,
      request: request("active request"),
      signal: activeController.signal,
      measureDurationMs: async () => 1,
    });

    await waitFor(async () => (await readLog(fixture.logPath)).filter((entry) => entry.event === "start").length === 1);
    const preAbortLog = await readLog(fixture.logPath);
    const queued = resolveNarrationFromCache({
      cacheDir: fixture.cacheDir,
      provider: plugin,
      request: request("queued request"),
      signal: queuedController.signal,
      measureDurationMs: async () => 1,
    });
    const activeResult = active.then(() => undefined, (error: unknown) => error);
    const queuedResult = queued.then(() => undefined, (error: unknown) => error);
    queuedController.abort(new DOMException("queued cancelled", "AbortError"));
    activeController.abort(new DOMException("active cancelled", "AbortError"));

    const [activeError, queuedError] = await Promise.all([activeResult, queuedResult]);
    expect(activeError).toBeInstanceOf(DOMException);
    expect((activeError as Error).message).toBe("active cancelled");
    expect(queuedError).toBeInstanceOf(DOMException);
    expect((queuedError as Error).message).toBe("queued cancelled");
    await plugin.close?.({});

    expect(preAbortLog.filter((entry) => entry.event === "start")).toEqual([
      { event: "start", text: "active request" },
    ]);
    const postAbortLog = await readLog(fixture.logPath);
    expect(postAbortLog.filter((entry) => entry.event === "start" && entry.text === "queued request")).toEqual([]);
    const pid = Number(preAbortLog.find((entry) => entry.event === "pid")?.pid);
    expect(pid).toBeGreaterThan(0);
    await waitFor(async () => !isProcessAlive(pid));
    expect(await listOrEmpty(path.join(fixture.cacheDir, ".kokoro/staging"))).toEqual([]);
  }, 10_000);

  test("finalizes a sealed output once when cancellation arrives before cache persistence", async () => {
    const fixture = await setupWorker("complete");
    const controller = new AbortController();
    let finalizeCalls = 0;
    let closeCalls = 0;
    const wrapped: NarrationProviderPlugin = {
      name: fixture.plugin.name,
      capabilities: fixture.plugin.capabilities,
      prepareRequest: (input, context) => fixture.plugin.prepareRequest(input, context),
      async synthesize(input, context) {
        const result = await fixture.plugin.synthesize(input, context);
        if (result.output.kind === "file") {
          const finalize = result.output.finalize;
          result.output.finalize = async (outcome) => {
            finalizeCalls += 1;
            await finalize?.(outcome);
          };
        }
        controller.abort(new DOMException("cancel before persistence", "AbortError"));
        return result;
      },
      async close(context) {
        closeCalls += 1;
        await fixture.plugin.close?.(context);
      },
    };

    await expect(resolveNarrationFromCache({
      cacheDir: fixture.cacheDir,
      provider: wrapped,
      request: request("finished but cancelled"),
      signal: controller.signal,
      measureDurationMs: async () => 1,
    })).rejects.toThrow("cancel before persistence");
    await wrapped.close?.({});

    expect(finalizeCalls).toBe(1);
    expect(closeCalls).toBe(1);
    expect(await listOrEmpty(path.join(fixture.cacheDir, ".kokoro/staging"))).toEqual([]);
    expect((await listOrEmpty(fixture.cacheDir)).filter((name) => /\.(?:wav|json)$/.test(name))).toEqual([]);
  }, 10_000);

  test("the CLI closes its registry exactly once and preserves generation as the primary error", async () => {
    const root = await makeTempRoot();
    const primary = new Error("primary generation failure");
    const cleanup = new Error("provider cleanup failure");
    let registryCloseCalls = 0;
    let observedPrimary: unknown;
    const registry = createNarrationProviderRegistry();
    const wrappedRegistry: NarrationProviderRegistry = {
      register(plugin) { registry.register(plugin); return wrappedRegistry; },
      resolve: (name) => registry.resolve(name),
      has: (name) => registry.has(name),
      names: () => registry.names(),
      async close(error) {
        registryCloseCalls += 1;
        observedPrimary = error;
        await registry.close(error);
      },
    };
    const builtIn = (name: string, failClose = false): NarrationProviderPlugin => ({
      name,
      capabilities: {
        offlineSynthesis: false,
        languages: "provider-defined",
        outputFormats: "provider-defined",
        sampleRates: "provider-defined",
        instructions: "provider-defined",
      },
      prepareRequest: (input) => input,
      async synthesize() { throw new Error("not reached"); },
      async close() { if (failClose) throw cleanup; },
    });

    let thrown: unknown;
    try {
      await generateCommand(root, "demos/never-loaded.tour.ts", {
        createRegistry: () => wrappedRegistry,
        createOpenAIPlugin: () => builtIn("openai", true),
        createElevenLabsPlugin: () => builtIn("elevenlabs"),
        loadConfig: async () => { throw primary; },
        log: () => {},
      });
    } catch (error) {
      thrown = error;
    }

    expect(registryCloseCalls).toBe(1);
    expect(observedPrimary).toBe(primary);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors[0]).toBe(primary);
    expect((thrown as AggregateError).errors[1]).toBe(cleanup);
  });
});

async function setupWorker(mode: "hang" | "complete") {
  const root = await makeTempRoot();
  const modelPath = path.join(root, "model.onnx");
  const voicesPath = path.join(root, "voices.bin");
  const workerPath = path.join(root, "cancellable-worker.ts");
  const logPath = path.join(root, "worker-log.jsonl");
  const cacheDir = path.join(root, "cache");
  await writeFile(modelPath, "model");
  await writeFile(voicesPath, "voices");
  await writeFile(workerPath, cancellationWorkerSource());
  const plugin = kokoro({
    runtime: "command",
    executable: process.execPath,
    args: [workerPath, mode],
    env: {
      KOKORO_CANCELLATION_LOG: logPath,
      KOKORO_MODEL_PATH: modelPath,
      KOKORO_VOICES_PATH: voicesPath,
    },
    modelPath,
    voicesPath,
    modelVersion: "fixture-1",
    startupTimeoutMs: 1_000,
    requestTimeoutMs: 5_000,
    shutdownTimeoutMs: 1_000,
  });
  return { cacheDir, logPath, plugin };
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
    text,
  });
}

function cancellationWorkerSource(): string {
  return `import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
const mode = process.argv[2];
const logPath = process.env.KOKORO_CANCELLATION_LOG;
const encoder = new TextEncoder();
const log = (value) => appendFile(logPath, JSON.stringify(value) + "\\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
function wave(text) {
  const data = encoder.encode(text || "x"); const padded = data.length + (data.length % 2); const out = new Uint8Array(44 + padded); const view = new DataView(out.buffer);
  out.set(encoder.encode("RIFF"), 0); view.setUint32(4, 36 + padded, true); out.set(encoder.encode("WAVEfmt "), 8); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 24000, true); view.setUint32(28, 48000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); out.set(encoder.encode("data"), 36); view.setUint32(40, padded, true); out.set(data, 44); return out;
}
await log({ event: "pid", pid: process.pid }); send({ protocol: 1, op: "ready", backendVersion: "fixture-1", modelSha256: createHash("sha256").update(await readFile(process.env.KOKORO_MODEL_PATH)).digest("hex"), voicesSha256: createHash("sha256").update(await readFile(process.env.KOKORO_VOICES_PATH)).digest("hex") });
for await (const line of console) {
  const request = JSON.parse(line);
  if (request.op === "shutdown") { send({ protocol: 1, id: request.id, ok: true }); process.exit(0); }
  await log({ event: "start", text: request.text });
  if (mode === "hang") continue;
  await Bun.write(request.outputPath, wave(request.text)); send({ protocol: 1, id: request.id, ok: true, path: request.outputPath, format: "wav", sampleRate: 24000 });
}
`;
}

async function readLog(logPath: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(logPath, "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? "" : Promise.reject(error));
  return text.trim() === "" ? [] : text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms.`);
    await Bun.sleep(10);
  }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function listOrEmpty(directory: string): Promise<string[]> {
  return readdir(directory).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
}

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "demohunter-kokoro-cancel-"));
  tempRoots.push(root);
  return root;
}
