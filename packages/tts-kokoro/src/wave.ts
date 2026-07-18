import { constants } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";

export type WaveInfo = { format: "wav"; sampleRate: number; channels: number; bitsPerSample: number; encoding: 1 | 3; dataBytes: number };

export function validateWaveBytes(bytes: Uint8Array, expectedSampleRate = 24000): WaveInfo {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.length < 12 || view.toString("ascii", 0, 4) !== "RIFF" || view.toString("ascii", 8, 12) !== "WAVE") throw new Error("Kokoro output is not a RIFF/WAVE file.");
  const riffSize = view.readUInt32LE(4);
  if (riffSize + 8 !== view.length) throw new Error("Kokoro WAV is truncated or has an inconsistent RIFF size.");
  let offset = 12;
  let format: Omit<WaveInfo, "format" | "dataBytes"> | undefined;
  let dataBytes: number | undefined;
  while (offset < view.length) {
    if (offset + 8 > view.length) throw new Error("Kokoro WAV has a truncated chunk header.");
    const id = view.toString("ascii", offset, offset + 4);
    const size = view.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > view.length) throw new Error(`Kokoro WAV chunk ${JSON.stringify(id)} is truncated.`);
    if (id === "fmt ") {
      if (format !== undefined) throw new Error("Kokoro WAV contains duplicate format chunks.");
      if (size < 16) throw new Error("Kokoro WAV format chunk is too short.");
      const encoding = view.readUInt16LE(start);
      const channels = view.readUInt16LE(start + 2);
      const sampleRate = view.readUInt32LE(start + 4);
      const byteRate = view.readUInt32LE(start + 8);
      const blockAlign = view.readUInt16LE(start + 12);
      const bitsPerSample = view.readUInt16LE(start + 14);
      if (encoding !== 1 && encoding !== 3) throw new Error("Kokoro WAV encoding is not PCM or IEEE float.");
      if (channels < 1 || channels > 32 || bitsPerSample < 8 || bitsPerSample > 64 || bitsPerSample % 8 !== 0) throw new Error("Kokoro WAV channel or bit depth is invalid.");
      if (encoding === 3 && bitsPerSample !== 32 && bitsPerSample !== 64) throw new Error("Kokoro IEEE-float WAV bit depth is invalid.");
      const expectedAlign = channels * (bitsPerSample / 8);
      if (blockAlign !== expectedAlign || byteRate !== sampleRate * blockAlign) throw new Error("Kokoro WAV byte rate or block alignment is inconsistent.");
      if (sampleRate !== expectedSampleRate) throw new Error(`Kokoro WAV sample rate must be ${expectedSampleRate} Hz.`);
      format = { encoding: encoding as 1 | 3, channels, sampleRate, bitsPerSample };
    } else if (id === "data") {
      if (dataBytes !== undefined) throw new Error("Kokoro WAV contains duplicate data chunks.");
      if (size === 0) throw new Error("Kokoro WAV contains no audio samples.");
      dataBytes = size;
    }
    offset = end + (size % 2);
    if (offset > view.length) throw new Error("Kokoro WAV chunk padding is truncated.");
  }
  if (format === undefined || dataBytes === undefined) throw new Error("Kokoro WAV requires exactly one format chunk and one non-empty data chunk.");
  if (dataBytes % (format.channels * (format.bitsPerSample / 8)) !== 0) throw new Error("Kokoro WAV data is not aligned to complete samples.");
  return { format: "wav", ...format, dataBytes };
}

export async function sealWaveFile(sourcePath: string, sealedPath: string, options: { forceFallback?: boolean } = {}): Promise<WaveInfo> {
  const noFollow = (constants as Record<string, number>).O_NOFOLLOW;
  const pre = options.forceFallback || noFollow === undefined ? await lstat(sourcePath) : undefined;
  if (pre !== undefined && !pre.isFile()) throw new Error("Kokoro staging output is not a regular file.");
  const flags = constants.O_RDONLY | (pre === undefined ? noFollow : 0);
  const source = await open(sourcePath, flags).catch((error: unknown) => { throw new Error("Unable to safely open Kokoro staging output.", { cause: error }); });
  let destination: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const actual = await source.stat();
    if (!actual.isFile() || (pre !== undefined && (pre.dev !== actual.dev || pre.ino !== actual.ino))) throw new Error("Kokoro staging output identity changed while opening it.");
    if (actual.size <= 44 || actual.size > 512 * 1024 * 1024) throw new Error("Kokoro staging output is empty or unreasonably large.");
    const bytes = Buffer.alloc(Number(actual.size));
    const { bytesRead } = await source.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== bytes.length) throw new Error("Kokoro staging output changed or was truncated while reading.");
    const info = validateWaveBytes(bytes);
    destination = await open(sealedPath, "wx", 0o600);
    await destination.writeFile(bytes);
    await destination.sync();
    return info;
  } catch (error) {
    await rm(sealedPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await destination?.close();
    await source.close();
  }
}
