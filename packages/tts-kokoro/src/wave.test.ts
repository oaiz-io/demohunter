import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateWaveBytes, sealWaveFile } from "./wave.js";

function wav(sampleRate = 24000, data = Buffer.from([0, 0])): Buffer {
  const out = Buffer.alloc(44 + data.length); out.write("RIFF"); out.writeUInt32LE(36 + data.length, 4); out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(sampleRate, 24); out.writeUInt32LE(sampleRate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write("data", 36); out.writeUInt32LE(data.length, 40); data.copy(out, 44); return out;
}

describe("WAV validation and sealing", () => {
  test("accepts valid PCM at 24 kHz", () => expect(validateWaveBytes(wav())).toMatchObject({ sampleRate: 24000, encoding: 1, dataBytes: 2 }));
  test.each([
    ["empty", Buffer.alloc(0)], ["header only", wav(24000, Buffer.alloc(0))], ["wrong rate", wav(22050)], ["truncated", wav().subarray(0, 43)],
  ])("rejects %s", (_name, bytes) => expect(() => validateWaveBytes(bytes)).toThrow());
  test("rejects duplicate chunks", () => { const value = wav(); value.write("fmt ", 36); expect(() => validateWaveBytes(value)).toThrow(); });
  test("seals from one handle with mode 0600 using native and fallback paths", async () => {
    for (const forceFallback of [false, true]) { const root = await mkdtemp(join(tmpdir(), "kokoro-wave-")); const source = join(root, "in.wav"); const target = join(root, "out.wav"); await writeFile(source, wav()); await sealWaveFile(source, target, { forceFallback }); expect(await readFile(target)).toEqual(wav()); }
  });
  test("rejects symlink staging output", async () => { const root = await mkdtemp(join(tmpdir(), "kokoro-link-")); const real = join(root, "real.wav"); const link = join(root, "link.wav"); await writeFile(real, wav()); await symlink(real, link); await expect(sealWaveFile(link, join(root, "sealed.wav"))).rejects.toThrow(/safely open|regular file/); });
});
