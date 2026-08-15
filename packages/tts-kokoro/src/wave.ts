import { constants, type Stats } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";

export const DEFAULT_MAX_KOKORO_WAVE_BYTES = 256 * 1024 * 1024;
const MAX_WAVE_CHUNKS = 4096;

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

export async function sealWaveFile(
  sourcePath: string,
  sealedPath: string,
  options: { forceFallback?: boolean; maxOutputBytes?: number; signal?: AbortSignal } = {},
): Promise<WaveInfo> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_KOKORO_WAVE_BYTES;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 44) {
    throw new Error("Kokoro maximum WAV output size must be a safe integer greater than 44 bytes.");
  }
  options.signal?.throwIfAborted();
  const noFollow = (constants as Record<string, number>).O_NOFOLLOW;
  const nonBlock = (constants as Record<string, number>).O_NONBLOCK ?? 0;
  const pre = await lstat(sourcePath);
  if (!pre.isFile()) throw new Error("Kokoro staging output is not a regular file.");
  const flags = constants.O_RDONLY | nonBlock | (options.forceFallback || noFollow === undefined ? 0 : noFollow);
  const source = await open(sourcePath, flags).catch((error: unknown) => { throw new Error("Unable to safely open Kokoro staging output.", { cause: error }); });
  let destination: Awaited<ReturnType<typeof open>> | undefined;
  let completed = false;
  try {
    const actual = await source.stat();
    if (!actual.isFile() || pre.dev !== actual.dev || pre.ino !== actual.ino) throw new Error("Kokoro staging output identity changed while opening it.");
    if (actual.size <= 44 || actual.size > maxOutputBytes) throw new Error(`Kokoro staging output is empty or exceeds the ${maxOutputBytes}-byte safety limit.`);
    const info = await validateWaveHandle(source, actual.size, options.signal);
    destination = await open(sealedPath, "wx", 0o600);
    await copyHandle(source, destination, actual.size, options.signal);
    const after = await source.stat();
    if (!sameStableFile(actual, after)) throw new Error("Kokoro staging output changed while it was being sealed.");
    await destination.sync();
    options.signal?.throwIfAborted();
    completed = true;
    return info;
  } finally {
    await destination?.close();
    await source.close();
    if (!completed) await rm(sealedPath, { force: true }).catch(() => undefined);
  }
}

async function validateWaveHandle(
  handle: Awaited<ReturnType<typeof open>>,
  fileSize: number,
  signal?: AbortSignal,
): Promise<WaveInfo> {
  const header = Buffer.allocUnsafe(12);
  await readExactly(handle, header, 0, signal);
  if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") throw new Error("Kokoro output is not a RIFF/WAVE file.");
  if (header.readUInt32LE(4) + 8 !== fileSize) throw new Error("Kokoro WAV is truncated or has an inconsistent RIFF size.");

  let offset = 12;
  let format: Omit<WaveInfo, "format" | "dataBytes"> | undefined;
  let dataBytes: number | undefined;
  let chunkCount = 0;
  while (offset < fileSize) {
    signal?.throwIfAborted();
    if (++chunkCount > MAX_WAVE_CHUNKS) throw new Error("Kokoro WAV contains too many chunks.");
    if (offset + 8 > fileSize) throw new Error("Kokoro WAV has a truncated chunk header.");
    const chunkHeader = Buffer.allocUnsafe(8);
    await readExactly(handle, chunkHeader, offset, signal);
    const id = chunkHeader.toString("ascii", 0, 4);
    const size = chunkHeader.readUInt32LE(4);
    const start = offset + 8;
    const end = start + size;
    if (end > fileSize) throw new Error(`Kokoro WAV chunk ${JSON.stringify(id)} is truncated.`);
    if (id === "fmt ") {
      if (format !== undefined) throw new Error("Kokoro WAV contains duplicate format chunks.");
      if (size < 16) throw new Error("Kokoro WAV format chunk is too short.");
      const bytes = Buffer.allocUnsafe(16);
      await readExactly(handle, bytes, start, signal);
      const encoding = bytes.readUInt16LE(0);
      const channels = bytes.readUInt16LE(2);
      const sampleRate = bytes.readUInt32LE(4);
      const byteRate = bytes.readUInt32LE(8);
      const blockAlign = bytes.readUInt16LE(12);
      const bitsPerSample = bytes.readUInt16LE(14);
      if (encoding !== 1 && encoding !== 3) throw new Error("Kokoro WAV encoding is not PCM or IEEE float.");
      if (channels < 1 || channels > 32 || bitsPerSample < 8 || bitsPerSample > 64 || bitsPerSample % 8 !== 0) throw new Error("Kokoro WAV channel or bit depth is invalid.");
      if (encoding === 3 && bitsPerSample !== 32 && bitsPerSample !== 64) throw new Error("Kokoro IEEE-float WAV bit depth is invalid.");
      const expectedAlign = channels * (bitsPerSample / 8);
      if (blockAlign !== expectedAlign || byteRate !== sampleRate * blockAlign) throw new Error("Kokoro WAV byte rate or block alignment is inconsistent.");
      if (sampleRate !== 24000) throw new Error("Kokoro WAV sample rate must be 24000 Hz.");
      format = { encoding: encoding as 1 | 3, channels, sampleRate, bitsPerSample };
    } else if (id === "data") {
      if (dataBytes !== undefined) throw new Error("Kokoro WAV contains duplicate data chunks.");
      if (size === 0) throw new Error("Kokoro WAV contains no audio samples.");
      dataBytes = size;
    }
    offset = end + (size % 2);
    if (offset > fileSize) throw new Error("Kokoro WAV chunk padding is truncated.");
  }
  if (format === undefined || dataBytes === undefined) throw new Error("Kokoro WAV requires exactly one format chunk and one non-empty data chunk.");
  if (dataBytes % (format.channels * (format.bitsPerSample / 8)) !== 0) throw new Error("Kokoro WAV data is not aligned to complete samples.");
  return { format: "wav", ...format, dataBytes };
}

async function copyHandle(
  source: Awaited<ReturnType<typeof open>>,
  destination: Awaited<ReturnType<typeof open>>,
  size: number,
  signal?: AbortSignal,
): Promise<void> {
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, size));
  let position = 0;
  while (position < size) {
    signal?.throwIfAborted();
    const length = Math.min(buffer.length, size - position);
    const { bytesRead } = await source.read(buffer, 0, length, position);
    if (bytesRead === 0) throw new Error("Kokoro staging output changed or was truncated while reading.");
    let written = 0;
    while (written < bytesRead) {
      const result = await destination.write(buffer, written, bytesRead - written, position + written);
      if (result.bytesWritten === 0) throw new Error("Kokoro sealed output could not be written completely.");
      written += result.bytesWritten;
    }
    position += bytesRead;
  }
}

async function readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  buffer: Buffer,
  position: number,
  signal?: AbortSignal,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    if (bytesRead === 0) throw new Error("Kokoro WAV changed or was truncated while reading.");
    offset += bytesRead;
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
