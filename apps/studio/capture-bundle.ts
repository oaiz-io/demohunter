import { createHash } from "node:crypto";
import { lstat, readdir, rm } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import path from "node:path";
import { unzipSync, zipSync } from "fflate";
import type { StudioFormat } from "./contract.js";
import { ensureElementIndex } from "./elements.js";
import { ensureFormat } from "./format.js";
import {
  atomicWrite,
  loadBundle,
  readProjectFile,
  withProjectLock,
  writeJson,
} from "./storage.js";

export const CAPTURE_FILE = "capture.dhcapture";
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 10000;
const hash = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const capturePath = (name: string) =>
  name === "capture.json" ||
  name === "events.json" ||
  name === "elements.json" ||
  (/^assets\//.test(name) &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    name
      .split("/")
      .every((part) => part !== ".." && part !== "." && part !== ""));

/** Read in memory: archive entries are never extracted into project folders. */
function decode(bytes: Buffer): Record<string, Buffer> {
  if (
    bytes
      .subarray(0, 80)
      .toString()
      .startsWith("version https://git-lfs.github.com/spec/v1")
  )
    throw new Error(
      "Capture is a Git LFS pointer. Run git lfs pull in this repository.",
    );
  if (bytes.length > MAX_BYTES)
    throw new Error("Capture bundle exceeds 256 MiB.");
  let total = 0;
  const names = new Set<string>();
  const files = unzipSync(bytes, {
    filter(entry) {
      if (!capturePath(entry.name) || names.has(entry.name))
        throw new Error(`Invalid or duplicate capture entry: ${entry.name}`);
      names.add(entry.name);
      total += entry.originalSize;
      if (names.size > MAX_FILES || total > MAX_BYTES)
        throw new Error(
          "Capture bundle expands beyond its size or file limit.",
        );
      return true;
    },
  });
  for (const name of ["capture.json", "events.json", "elements.json"])
    if (!files[name]) throw new Error(`Capture bundle is missing ${name}.`);
  const metadata = JSON.parse(Buffer.from(files["capture.json"]!).toString());
  const index = JSON.parse(Buffer.from(files["elements.json"]!).toString());
  const captureHash = hash(files["events.json"]!);
  if (
    metadata.format !== "demohunter.capture" ||
    metadata.formatVersion !== 1 ||
    metadata.captureHash !== captureHash ||
    index.schemaVersion !== 1 ||
    index.captureHash !== captureHash ||
    index.captureId !== captureHash.slice(0, 16) ||
    !Array.isArray(index.elements)
  )
    throw new Error("Capture identity does not match its recording.");
  return Object.fromEntries(
    Object.entries(files).map(([name, data]) => [name, Buffer.from(data)]),
  );
}

const LFS_POINTER = "version https://git-lfs.github.com/spec/v1";
const lfsPointer = (bytes: Buffer) =>
  bytes.subarray(0, 80).toString().startsWith(LFS_POINTER);

type Entry = { method: number; compressed: number; size: number; offset: number };
/** The ZIP central directory, with every entry name and size checked before
 * anything is decompressed. */
function centralDirectory(bytes: Buffer): Map<string, Entry> {
  const corrupt = () => new Error("Capture bundle is not a valid archive.");
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--)
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw corrupt();
  const count = bytes.readUInt16LE(end + 10);
  let p = bytes.readUInt32LE(end + 16);
  if (count > MAX_FILES)
    throw new Error("Capture bundle expands beyond its size or file limit.");
  const entries = new Map<string, Entry>();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || bytes.readUInt32LE(p) !== 0x02014b50) throw corrupt();
    const nameLength = bytes.readUInt16LE(p + 28),
      extra = bytes.readUInt16LE(p + 30),
      comment = bytes.readUInt16LE(p + 32);
    const name = bytes.toString("utf8", p + 46, p + 46 + nameLength);
    if (!capturePath(name) || entries.has(name))
      throw new Error(`Invalid or duplicate capture entry: ${name}`);
    const size = bytes.readUInt32LE(p + 24);
    total += size;
    if (total > MAX_BYTES)
      throw new Error("Capture bundle expands beyond its size or file limit.");
    entries.set(name, {
      method: bytes.readUInt16LE(p + 10),
      compressed: bytes.readUInt32LE(p + 20),
      size,
      offset: bytes.readUInt32LE(p + 42),
    });
    p += 46 + nameLength + extra + comment;
  }
  for (const name of ["capture.json", "events.json", "elements.json"])
    if (!entries.has(name)) throw new Error(`Capture bundle is missing ${name}.`);
  return entries;
}
/** One entry, decompressed with the native zlib (not the JS inflate). */
function inflateEntry(bytes: Buffer, entry: Entry): Buffer {
  const corrupt = () => new Error("Capture bundle is not a valid archive.");
  const at = entry.offset;
  if (at + 30 > bytes.length || bytes.readUInt32LE(at) !== 0x04034b50) throw corrupt();
  const start = at + 30 + bytes.readUInt16LE(at + 26) + bytes.readUInt16LE(at + 28);
  const raw = bytes.subarray(start, start + entry.compressed);
  if (raw.length !== entry.compressed) throw corrupt();
  const data =
    entry.method === 0
      ? Buffer.from(raw)
      : entry.method === 8
        ? inflateRawSync(raw, { maxOutputLength: entry.size + 1 })
        : (() => {
            throw corrupt();
          })();
  if (data.length !== entry.size) throw corrupt();
  return data;
}
type Archive = {
  bytes: Buffer;
  entries: Map<string, Entry>;
  files: Map<string, Buffer>;
  size: number;
  /** elements.json was checked against the recording. */
  indexChecked?: boolean;
};
/** Open, check and remember one archive: the whole-file checksum, every
 * entry name and size, and the recording identity (events.json against
 * capture.json and studio.json). Other entries are decompressed when read. */
function openArchive(
  bytes: Buffer,
  format: Extract<StudioFormat, { formatVersion: 2 }>,
): Archive {
  if (lfsPointer(bytes))
    throw new Error(
      "Capture is a Git LFS pointer. Run git lfs pull in this repository.",
    );
  if (hash(bytes) !== format.capture.sha256)
    throw new Error("Capture bundle checksum does not match studio.json.");
  const entries = centralDirectory(bytes);
  const archive: Archive = { bytes, entries, files: new Map(), size: bytes.length };
  const metadata = JSON.parse(entryOf(archive, "capture.json").toString());
  const captureHash = hash(entryOf(archive, "events.json"));
  if (
    metadata.format !== "demohunter.capture" ||
    metadata.formatVersion !== 1 ||
    metadata.captureHash !== captureHash
  )
    throw new Error("Capture identity does not match its recording.");
  if (captureHash.slice(0, 16) !== format.captureId)
    throw new Error("Studio manifest does not match this capture.");
  return archive;
}
function entryOf(archive: Archive, name: string): Buffer {
  let data = archive.files.get(name);
  if (data) return data;
  const entry = archive.entries.get(name);
  if (!entry)
    throw Object.assign(new Error(`Capture file not found: ${name}`), {
      code: "ENOENT",
    });
  data = inflateEntry(archive.bytes, entry);
  if (name === "elements.json" && !archive.indexChecked) {
    const index = JSON.parse(data.toString());
    const captureHash = hash(entryOf(archive, "events.json"));
    if (
      index.schemaVersion !== 1 ||
      index.captureHash !== captureHash ||
      index.captureId !== captureHash.slice(0, 16) ||
      !Array.isArray(index.elements)
    )
      throw new Error("Capture identity does not match its recording.");
    archive.indexChecked = true;
  }
  archive.files.set(name, data);
  archive.size += data.length;
  return data;
}

// Share immutable bytes across preview, inspection and library requests.
// Keyed by the file's identity (size, times, inode) and the manifest, so the
// checksum runs once per archive, not on every read.
const cache = new Map<string, Archive>();
const cachedSize = () => [...cache.values()].reduce((n, a) => n + a.size, 0);
/** The archive is a regular file within the size limit (no read). */
export async function captureFileInfo(dir: string) {
  const info = await lstat(path.join(dir, CAPTURE_FILE)).catch((error) => {
    if (error.code === "ENOENT")
      throw new Error(
        "Capture bundle is missing. Run git lfs pull if this project uses Git LFS.",
      );
    throw error;
  });
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(
      "Capture bundle must be a regular file, not a symbolic link.",
    );
  if (info.size > MAX_BYTES) throw new Error("Capture bundle exceeds 256 MiB.");
  return info;
}
export async function readCaptureEntry(
  dir: string,
  format: Extract<StudioFormat, { formatVersion: 2 }>,
  name: string,
): Promise<Buffer> {
  const info = await captureFileInfo(dir);
  const key = `${path.resolve(dir)}:${format.captureId}:${format.capture.sha256}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`;
  let archive = cache.get(key);
  if (archive) {
    cache.delete(key);
    cache.set(key, archive);
  } else {
    archive = openArchive(await readProjectFile(dir, CAPTURE_FILE, null), format);
    cache.set(key, archive);
  }
  const data = entryOf(archive, name);
  while (cache.size > 1 && cachedSize() > 128 * 1024 * 1024)
    cache.delete(cache.keys().next().value!);
  return data;
}

/** Commit the manifest last. Until then, a v1 reader still has every loose file. */
export async function packCapture(
  dir: string,
): Promise<{ file: string; sha256: string; bytes: number; captureId: string }> {
  return withProjectLock(dir, async () => {
    await loadBundle(dir);
    const index = await ensureElementIndex(dir, false);
    const format = await ensureFormat(dir, index);
    if (format.formatVersion === 2) {
      await readCaptureEntry(dir, format, "events.json");
      await removeLooseCapture(dir);
      return {
        file: CAPTURE_FILE,
        sha256: format.capture.sha256,
        bytes: (await lstat(path.join(dir, CAPTURE_FILE))).size,
        captureId: index.captureId,
      };
    }
    const files: Record<string, Uint8Array> = Object.create(null);
    files["capture.json"] = Buffer.from(
      JSON.stringify({
        format: "demohunter.capture",
        formatVersion: 1,
        captureHash: index.captureHash,
      }) + "\n",
    );
    for (const name of ["events.json", "elements.json"])
      files[name] = await readProjectFile(dir, name, null);
    async function assets(relative: string): Promise<void> {
      const folder = path.join(dir, relative);
      const info = await lstat(folder).catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!info) return;
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error(`${relative} must be a real folder.`);
      for (const entry of (await readdir(folder, { withFileTypes: true })).sort(
        (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      )) {
        const name = `${relative}/${entry.name}`;
        if (!capturePath(name))
          throw new Error(`Invalid capture path: ${name}`);
        if (entry.isDirectory()) await assets(name);
        else if (entry.isFile())
          files[name] = await readProjectFile(dir, name, null);
        else throw new Error(`${name} must be a regular capture file.`);
      }
    }
    await assets("assets");
    if (
      Object.keys(files).length > MAX_FILES ||
      Object.values(files).reduce((n, data) => n + data.length, 0) > MAX_BYTES
    )
      throw new Error("Capture exceeds its bundle size or file limit.");
    const bytes = Buffer.from(
      zipSync(files, { level: 6, mtime: new Date(1980, 0, 1) }),
    );
    decode(bytes);
    const sha256 = hash(bytes);
    await atomicWrite(path.join(dir, CAPTURE_FILE), bytes);
    await writeJson(path.join(dir, "studio.json"), {
      ...format,
      formatVersion: 2,
      capture: { file: CAPTURE_FILE, sha256 },
    });
    // These files are derived or now contained in the verified archive. Author
    // files, audio, scenes and runtime history are not changed by packing.
    await removeLooseCapture(dir);
    return {
      file: CAPTURE_FILE,
      sha256,
      bytes: bytes.length,
      captureId: index.captureId,
    };
  });
}

async function removeLooseCapture(dir: string): Promise<void> {
  for (const name of ["events.json", "elements.json", "assets", "sources"])
    await rm(path.join(dir, name), { recursive: true, force: true });
}
