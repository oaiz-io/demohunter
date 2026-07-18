import { describe, expect, test } from "bun:test";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KokoroWorkerClient } from "./worker-client.js";

const fixture = join(import.meta.dir, "../test/fixtures/jsonl-worker.ts");
function client(mode = "ok", extra = {}) { return new KokoroWorkerClient({ executable: process.execPath, args: [fixture, mode], startupTimeoutMs: 300, requestTimeoutMs: 300, shutdownTimeoutMs: 300, ...extra }); }
async function input(text = "hello 🌍\nnext") { const root = await mkdtemp(join(tmpdir(), "kokoro-worker-")); return { text, voice: "v", language: "en-us", speed: 1, format: "wav" as const, sampleRate: 24000 as const, outputPath: join(root, "out.wav") }; }

describe("JSONL worker client", () => {
  test("preserves Unicode/newlines and serializes concurrent requests FIFO", async () => { const c = client(); const a = await input("一\n🙂"); const b = await input("two"); const results = await Promise.all([c.synthesize(a, new AbortController().signal), c.synthesize(b, new AbortController().signal)]); expect(results.map(x => x.path)).toEqual([a.outputPath, b.outputPath]); await c.close(); });
  test.each(["malformed-startup", "crash", "request-timeout", "malformed", "wrong-id", "wrong-format", "wrong-rate", "stderr-crash"])("rejects hostile worker mode %s", async mode => { const c = client(mode); await expect(c.synthesize(await input(), new AbortController().signal)).rejects.toThrow(); await c.close().catch(() => undefined); });
  test("bounds oversized JSONL output", async () => { const c = client("oversized", { maxLineBytes: 300 }); await expect(c.synthesize(await input(), new AbortController().signal)).rejects.toThrow(/larger/); });
  test("reports executable not found", async () => { const c = new KokoroWorkerClient({ executable: "/definitely/missing/kokoro" }); await expect(c.synthesize(await input(), new AbortController().signal)).rejects.toThrow(/executable not found/); });
  test("rejects an incompatible backend version during startup", async () => { const c = client("ok", { expectedBackendVersion: "other" }); await expect(c.synthesize(await input(), new AbortController().signal)).rejects.toThrow(/backend version/); });
  test("passes metacharacters as literal argv without invoking a shell", async () => { const root = await mkdtemp(join(tmpdir(), "kokoro-shell-")); const marker = join(root, "must-not-exist"); const c = new KokoroWorkerClient({ executable: process.execPath, args: [fixture, `ok;touch ${marker}`], startupTimeoutMs: 500, requestTimeoutMs: 500, shutdownTimeoutMs: 500 }); await c.synthesize(await input(), new AbortController().signal); await c.close(); await expect(access(marker)).rejects.toThrow(); });
  test("runs the production Python worker against its weight-free injectable backend", async () => { const root = await mkdtemp(join(tmpdir(), "kokoro-python-")); const model = join(root, "model.onnx"); const voices = join(root, "voices.bin"); await writeFile(model, "stub"); await writeFile(voices, "stub"); const workerDir = join(import.meta.dir, "../worker"); const c = new KokoroWorkerClient({ executable: "python3", args: [join(workerDir, "demohunter_kokoro_worker.py"), "--model", model, "--voices", voices, "--backend-module", "test_backend_stub"], cwd: workerDir, startupTimeoutMs: 1000, requestTimeoutMs: 1000, shutdownTimeoutMs: 1000 }); const response = await c.synthesize(await input("こんにちは 🌍"), new AbortController().signal); expect(response.sampleRate).toBe(24000); await c.close(); });
  test("cancellation terminates active work and queued cancellation does not synthesize", async () => { const c = client("request-timeout", { requestTimeoutMs: 5000 }); const controller = new AbortController(); const pending = c.synthesize(await input(), controller.signal); setTimeout(() => controller.abort(), 20); await expect(pending).rejects.toThrow(); await c.close().catch(() => undefined); });
});
