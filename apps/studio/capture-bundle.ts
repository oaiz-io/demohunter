import { createHash } from "node:crypto";
import { lstat, readdir, rm } from "node:fs/promises";
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

// Share immutable bytes across preview, inspection and library requests.
const cache = new Map<string, Record<string, Buffer>>();
let cachedBytes = 0;
export async function readCaptureEntry(
  dir: string,
  format: Extract<StudioFormat, { formatVersion: 2 }>,
  name: string,
): Promise<Buffer> {
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
  const key = `${path.resolve(dir)}:${format.captureId}:${format.capture.sha256}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`;
  let files = cache.get(key);
  if (files) {
    cache.delete(key);
    cache.set(key, files);
  } else {
    const bytes = await readProjectFile(dir, CAPTURE_FILE, null);
    if (
      bytes
        .subarray(0, 80)
        .toString()
        .startsWith("version https://git-lfs.github.com/spec/v1")
    )
      throw new Error(
        "Capture is a Git LFS pointer. Run git lfs pull in this repository.",
      );
    if (hash(bytes) !== format.capture.sha256)
      throw new Error("Capture bundle checksum does not match studio.json.");
    files = decode(bytes);
    if (
      JSON.parse(files["elements.json"]!.toString()).captureId !==
      format.captureId
    )
      throw new Error("Studio manifest does not match this capture.");
    cache.set(key, files);
    cachedBytes += Object.values(files).reduce((n, data) => n + data.length, 0);
    while (cache.size > 1 && cachedBytes > 128 * 1024 * 1024) {
      const oldest = cache.keys().next().value!;
      cachedBytes -= Object.values(cache.get(oldest)!).reduce(
        (n, data) => n + data.length,
        0,
      );
      cache.delete(oldest);
    }
  }
  const data = files[name];
  if (!data)
    throw Object.assign(new Error(`Capture file not found: ${name}`), {
      code: "ENOENT",
    });
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
