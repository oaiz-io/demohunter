import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  writeFile,
  rename,
  realpath,
  open,
  unlink,
  mkdir,
  readdir,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import { readFormat } from "./format.js";
import { validateBundle, type ReplayBundle } from "./model.js";

export async function atomicWrite(
  file: string,
  content: string | Uint8Array,
): Promise<void> {
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    // "wx": never write through something that already sits at the temp name.
    await writeFile(temp, content, { flag: "wx" });
    await rename(temp, file);
  } catch (error) {
    // Never leave temp files behind (full disk, rename onto a directory…).
    await unlink(temp).catch(() => {});
    throw error;
  }
}
/** Read a project file without following symlinks, so a repository cannot
 * point `overrides.css` (or any project file) at ~/.ssh and have Studio serve
 * it. Folders on the way (e.g. `.history/`) must not be symlinks either. */
export async function readProjectFile(dir: string, relative: string): Promise<string>;
export async function readProjectFile(
  dir: string,
  relative: string,
  encoding: null,
): Promise<Buffer>;
export async function readProjectFile(
  dir: string,
  relative: string,
  encoding: "utf8" | null = "utf8",
): Promise<string | Buffer> {
  let current = dir;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink())
      throw new Error(
        `${relative} is a symbolic link; Studio does not follow symlinks inside a project.`,
      );
  }
  // O_NOFOLLOW closes the gap between the check above and the read.
  const handle = await open(
    current,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  ).catch((error) => {
    throw error.code === "ELOOP"
      ? new Error(
          `${relative} is a symbolic link; Studio does not follow symlinks inside a project.`,
        )
      : error;
  });
  try {
    return encoding ? await handle.readFile(encoding) : await handle.readFile();
  } finally {
    await handle.close();
  }
}
const NOT_A_FOLDER = (relative: string, link: boolean) =>
  link
    ? `${relative}/ must be a folder inside the project, not a link`
    : `${relative}/ must be a folder inside the project`;
/** Walk `relative` (e.g. ".demohunter/studio") below `root`, refusing any
 * component that is a symlink or not a folder, and creating missing ones. A
 * cloned repository can commit `.studio -> ~/Documents`; mkdir/readdir/write
 * would follow it out of the project. Returns the folder path. */
export async function ensureRealFolders(
  root: string,
  relative: string,
  create = true,
): Promise<string> {
  let current = root;
  let walked = "";
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    walked = walked ? `${walked}/${part}` : part;
    let info = await lstat(current).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) {
      if (!create) return current;
      await mkdir(current).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error(NOT_A_FOLDER(walked, info.isSymbolicLink()));
  }
  return current;
}
/** A runtime-state folder (`.demohunter/studio`, …) that keeps itself out of
 * git. `wx` never follows a symlink planted at `.gitignore`. */
export async function ensureIgnoredFolder(
  root: string,
  relative: string,
): Promise<string> {
  const folder = await ensureRealFolders(root, relative);
  await writeFile(path.join(folder, ".gitignore"), "*\n", { flag: "wx" }).catch(
    () => {},
  );
  return folder;
}
export async function writeJson(file: string, value: unknown): Promise<void> {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}
export async function loadBundle(dir: string): Promise<ReplayBundle> {
  await readFormat(dir);
  const files = await Promise.all(
    ["project.json", "edits.json", "narration.json", "overrides.css"].map(
      (name) => readProjectFile(dir, name),
    ),
  );
  files.push(
    await readProjectFile(dir, "comments.json").catch((error) => {
      if (error.code === "ENOENT") return '{"threads":[]}';
      throw error;
    }),
  );
  // What history snapshots: the JSON files and overrides.css. Undo compares
  // this, so scene/audio writes (which history does not record) cannot break
  // the chain.
  const contentRevision = createHash("sha256")
    .update(files.join("\0"))
    .digest("hex")
    .slice(0, 16);
  // Scene pages and audio are project content too: agents edit them directly.
  const { text: motion, stamps } = await motionFingerprint(dir);
  files.push(motion);
  const revision = createHash("sha256")
    .update(files.join("\0"))
    .digest("hex")
    .slice(0, 16);
  try {
    return validateBundle({
      project: JSON.parse(files[0]!),
      edits: JSON.parse(files[1]!),
      narration: JSON.parse(files[2]!),
      css: files[3]!,
      comments: JSON.parse(files[4]!),
      revision,
      contentRevision,
      assetsRevision: createHash("sha256")
        .update(motion)
        .digest("hex")
        .slice(0, 16),
      scenesRevision: createHash("sha256")
        .update(motion.split("\n").filter((l) => l.startsWith("scenes/")).join("\n"))
        .digest("hex")
        .slice(0, 16),
      assetStamps: stamps,
    });
  } catch (error) {
    throw new Error(
      `Invalid replay project: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** A huge or hostile `scenes/` or `audio/` must not stall every request that
 * loads the project: bound the walk, and hash only modest files. */
const MAX_WALK_ENTRIES = 2000;
const MAX_WALK_DEPTH = 10;
const MAX_HASHED_BYTES = 5 * 1024 * 1024;
/** Scene/overlay files by content, audio by size and time (they can be big). */
async function motionFingerprint(
  dir: string,
): Promise<{ text: string; stamps: Record<string, string> }> {
  const parts: string[] = [];
  const stamps: Record<string, string> = {};
  const folders = [
    ["scenes", true],
    ["audio", false],
  ] as const;
  // Refuse links before reading anything: a linked folder would pull in (and
  // hash, and later serve) files from outside the project.
  for (const [folder] of folders) await ensureRealFolders(dir, folder, false);
  for (const [folder, byContent] of folders) {
    for (const name of await listFiles(path.join(dir, folder))) {
      const file = path.join(dir, folder, name);
      const info = await lstat(file).catch(() => undefined);
      if (!info?.isFile()) continue;
      const stamp =
        byContent && info.size <= MAX_HASHED_BYTES
          ? await hashFile(file)
          : `${info.size}:${Math.round(info.mtimeMs)}`;
      if (stamp === undefined) continue;
      stamps[`${folder}/${name}`] = stamp.slice(0, 16);
      parts.push(`${folder}/${name}:${stamp}`);
    }
  }
  return { text: parts.join("\n"), stamps };
}
async function hashFile(file: string): Promise<string | undefined> {
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  ).catch(() => undefined);
  if (!handle) return undefined;
  try {
    if (!(await handle.stat()).isFile()) return undefined;
    return createHash("sha256").update(await handle.readFile()).digest("hex");
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}
/** Cheap change stamp for scene/audio files (size and time, no reads), for
 * caches that must notice any edit, however deep. A linked folder is not
 * walked; loadBundle reports it. */
export async function assetStamp(dir: string): Promise<string> {
  const parts: string[] = [];
  for (const folder of ["scenes", "audio"]) {
    const ok = await ensureRealFolders(dir, folder, false).then(
      () => true,
      () => false,
    );
    if (!ok) {
      parts.push(`${folder}:unusable`);
      continue;
    }
    for (const name of await listFiles(path.join(dir, folder))) {
      const info = await lstat(path.join(dir, folder, name)).catch(() => undefined);
      if (info?.isFile()) parts.push(`${folder}/${name}:${info.size}:${info.mtimeMs}`);
    }
  }
  return parts.sort().join("|");
}
/** Files under a folder, without following symlinks (no loops, no escapes),
 * in a stable order and capped. Interrupted-write temp files are skipped. */
async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  let budget = MAX_WALK_ENTRIES;
  const walk = async (prefix: string, depth: number) => {
    const entries = await readdir(path.join(root, prefix), {
      withFileTypes: true,
    }).catch(() => []);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (budget-- <= 0) return;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < MAX_WALK_DEPTH) await walk(name, depth + 1);
      } else if (entry.isFile() && !entry.name.endsWith(".tmp")) files.push(name);
    }
  };
  await walk("", 0);
  return files;
}
export class RevisionConflict extends Error {
  readonly status = 409;
}
const LOCK_STALE_MS = 30_000;
const LOCK_BEAT_MS = 10_000;
export type FileLock = { release(): Promise<void> };
const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};
const LOCK_READ_BYTES = 4096;
const notRegular = (file: string) =>
  new Error(`Lock file is not a regular file: ${file}`);
/** Read a lock without following links or blocking on a FIFO a repository
 * planted there. undefined: gone. Throws for anything but a regular file. */
async function readLock(
  file: string,
): Promise<{ text: string; ino: number; mtimeMs: number } | undefined> {
  const info = await lstat(file).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return undefined;
  if (!info.isFile()) throw notRegular(file);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    // O_NONBLOCK: even if the file is swapped for a FIFO after the lstat,
    // open must not hang.
    handle = await open(
      file,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "ELOOP") throw notRegular(file);
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw notRegular(file);
    const buffer = Buffer.alloc(LOCK_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, LOCK_READ_BYTES, 0);
    return {
      text: buffer.toString("utf8", 0, bytesRead),
      ino: opened.ino,
      mtimeMs: opened.mtimeMs,
    };
  } finally {
    await handle.close();
  }
}
/** Can the lock be taken over: owner process gone, or nobody refreshed it. */
function lockIsStale(read: { text: string; mtimeMs: number }): boolean {
  let pid: number | undefined, at: number | undefined;
  try {
    const parsed = JSON.parse(read.text);
    if (parsed && typeof parsed === "object") {
      pid = Number(parsed.pid);
      at = Date.parse(parsed.at);
    } else pid = Number(parsed); // older versions wrote a bare pid
  } catch {}
  // Just created (not written yet) or from an older version: use the file time.
  if (at === undefined || Number.isNaN(at)) at = read.mtimeMs;
  // A clock-skewed or forged future stamp must not keep a lock alive forever.
  at = Math.min(at, Date.now());
  const dead = Number.isInteger(pid) && pid! > 0 && !pidAlive(pid!);
  return dead || Date.now() - at >= LOCK_STALE_MS;
}
/** Removes a lock whose owner died or went silent. "gone": the file is now
 * absent; "live": a real owner holds it; "retry": another taker is busy with
 * the takeover, ask again shortly. */
async function clearStaleLock(file: string): Promise<"gone" | "live" | "retry"> {
  const first = await readLock(file);
  if (!first) return "gone";
  if (!lockIsStale(first)) return "live";
  // Takeover runs under a second exclusive lock: renaming the lock aside and
  // linking it back leaves a window with no lock at all, in which a second
  // taker creates its own and both hold it.
  const reap = `${file}.reap`;
  let reaper: Awaited<ReturnType<typeof open>>;
  try {
    reaper = await open(reap, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await lstat(reap).catch(() => undefined);
    if (info && !info.isFile()) throw notRegular(reap);
    // A taker that died mid-takeover: its reap lock expires like any other.
    if (info && Date.now() - Math.min(info.mtimeMs, Date.now()) > LOCK_STALE_MS)
      await unlink(reap).catch(() => {});
    return "retry";
  }
  try {
    // Decide again with the takeover lock held: the owner may have changed.
    const current = await readLock(file);
    if (!current) return "gone";
    if (!lockIsStale(current)) return "live";
    // Same file we judged (not a successor that appeared meanwhile).
    const now = await lstat(file).catch(() => undefined);
    if (!now) return "gone";
    if (now.ino !== current.ino) return "retry";
    await unlink(file).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    return "gone";
  } finally {
    await reaper.close().catch(() => {});
    await unlink(reap).catch(() => {});
  }
}
/** Exclusive lock file holding the owner's pid and time. A lock whose process
 * is gone, or that nobody refreshed for 30 s, is taken over. Resolves
 * undefined while a live owner holds it; other errors are thrown as-is. */
export async function acquireLock(file: string): Promise<FileLock | undefined> {
  let attempts = 0,
    waits = 0;
  let handle: Awaited<ReturnType<typeof open>>;
  for (;;) {
    try {
      handle = await open(file, "wx");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const state = await clearStaleLock(file);
    if (state === "live") return undefined;
    if (state === "retry") {
      if (++waits > 100) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 10));
    } else if (++attempts >= 3) return undefined;
  }
  // The token identifies this holder: a holder that stalled past the stale
  // limit and lost the lock must not delete its successor's file.
  const token = Math.random().toString(36).slice(2, 12).padEnd(10, "0");
  const stamp = () => JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token });
  try {
    await handle.writeFile(stamp());
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(file).catch(() => {});
    throw error;
  }
  // Long jobs (speech generation) keep the lock fresh while they run.
  let beat = Promise.resolve();
  const timer = setInterval(() => {
    beat = beat.then(() => handle.write(stamp(), 0)).then(() => {}, () => {});
  }, LOCK_BEAT_MS);
  timer.unref();
  return {
    async release() {
      clearInterval(timer);
      await beat;
      await handle.close();
      const current = (await readLock(file).catch(() => undefined))?.text ?? "";
      let owner: unknown;
      try {
        owner = JSON.parse(current)?.token;
      } catch {}
      if (owner !== token) return; // taken over (or gone): not ours to remove
      await unlink(file).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
  };
}
export async function withProjectLock<T>(
  dir: string,
  work: () => Promise<T>,
): Promise<T> {
  const file = path.join(dir, ".project.lock");
  let lock: FileLock | undefined;
  for (let attempt = 0; attempt < 80 && !lock; attempt++) {
    lock = await acquireLock(file);
    if (!lock) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!lock)
    throw new RevisionConflict("Project is busy. Retry shortly.");
  try {
    return await work();
  } finally {
    await lock.release();
  }
}
/** Who is writing. MCP tool calls run inside this context; UI and CLI writes
 * have none and are recorded as the local person ("You"). */
export type MutationAuthor = {
  actor: string;
  sessionId: string;
  tool: string;
  elementRef?: string;
  threadId?: string;
  segmentId?: string;
};
export const mutationAuthor = new AsyncLocalStorage<MutationAuthor>();
export type HistoryChange = {
  kind:
    | "text"
    | "style"
    | "hidden"
    | "element"
    | "camera"
    | "highlight"
    | "animation"
    | "overlay"
    | "music"
    | "sound"
    | "scene"
    | "clip"
    | "narration"
    | "voice"
    | "comment"
    | "reply"
    | "status"
    | "css"
    | "project";
  label: string;
  file: string;
  ref?: string;
  before?: string;
  after?: string;
};
type HistoryEntry = {
  id: string;
  description: string;
  createdAt: string;
  afterRevision: string;
  /** Content revision (what history snapshots) after the change; older
   * entries only have `afterRevision`. */
  afterContentRevision?: string;
  before: ReplayBundle;
  author?: MutationAuthor;
  changes?: HistoryChange[];
};
const short = (value: unknown) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text === undefined
    ? undefined
    : text.length > 160
      ? `${text.slice(0, 157)}…`
      : text;
};
/** A compact, human-readable list of what one tracked mutation changed. */
export function describeChanges(
  before: ReplayBundle,
  after: ReplayBundle,
): HistoryChange[] {
  const changes: HistoryChange[] = [];
  const beforeElements = new Map(before.edits.elements.map((e) => [e.id, e]));
  for (const edit of after.edits.elements) {
    const old = beforeElements.get(edit.id);
    const ref = edit.target.ref;
    if (edit.text !== old?.text && edit.text !== undefined)
      changes.push({
        kind: "text",
        label: "Text",
        file: "edits.json",
        ref,
        before: short(old?.text),
        after: short(edit.text),
      });
    const styleKeys = new Set([
      ...Object.keys(old?.style ?? {}),
      ...Object.keys(edit.style ?? {}),
    ]);
    const styles = [...styleKeys]
      .filter((k) => old?.style?.[k] !== edit.style?.[k])
      .map(
        (k) =>
          `${k} ${old?.style?.[k] ? `${old.style[k]} → ` : ""}${edit.style?.[k] ?? "removed"}`,
      );
    if (JSON.stringify(edit.transform) !== JSON.stringify(old?.transform))
      changes.push({
        kind: "style",
        label: "Position and scale",
        file: "edits.json",
        ref,
        before: short(JSON.stringify(old?.transform)),
        after: short(JSON.stringify(edit.transform)),
      });
    if (styles.length)
      changes.push({
        kind: "style",
        label: "Style",
        file: "edits.json",
        ref,
        after: short(styles.join(" · ")),
      });
    if (!!edit.hidden !== !!old?.hidden)
      changes.push({
        kind: "hidden",
        label: edit.hidden ? "Hidden" : "Shown",
        file: "edits.json",
        ref,
      });
  }
  for (const old of before.edits.elements)
    if (!after.edits.elements.some((e) => e.id === old.id))
      changes.push({
        kind: "element",
        label: "Edit removed",
        file: "edits.json",
        ref: old.target.ref,
      });
  for (const [kind, label, a, b] of [
    ["camera", "Zoom", before.edits.camera, after.edits.camera],
    ["highlight", "Highlight", before.edits.highlights, after.edits.highlights],
    [
      "animation",
      "Animation",
      before.edits.animations ?? [],
      after.edits.animations ?? [],
    ],
    [
      "overlay",
      "Overlay",
      before.edits.overlays ?? [],
      after.edits.overlays ?? [],
    ],
    [
      "music",
      "Music",
      before.edits.audio?.music ?? [],
      after.edits.audio?.music ?? [],
    ],
    [
      "sound",
      "Sound",
      before.edits.audio?.sfx ?? [],
      after.edits.audio?.sfx ?? [],
    ],
  ] as const) {
    const old = new Map<string, unknown>(a.map((e) => [e.id, e]));
    for (const effect of b as { id: string; target?: { ref?: string } }[])
      if (JSON.stringify(old.get(effect.id)) !== JSON.stringify(effect))
        changes.push({
          kind,
          label: old.has(effect.id) ? `${label} changed` : `${label} added`,
          file: "edits.json",
          ref: effect.target?.ref,
        });
    for (const effect of a as { id: string; target?: { ref?: string } }[])
      if (!(b as { id: string }[]).some((e) => e.id === effect.id))
        changes.push({
          kind,
          label: `${label} removed`,
          file: "edits.json",
          ref: effect.target?.ref,
        });
  }
  if (JSON.stringify(before.edits.clips) !== JSON.stringify(after.edits.clips))
    changes.push({ kind: "clip", label: "Scene timing", file: "edits.json" });
  if (before.assetsRevision !== after.assetsRevision)
    changes.push({
      kind: "scene",
      label: "Scene or audio files",
      file: "scenes/",
    });
  const oldSegments = new Map(before.narration.segments.map((s) => [s.id, s]));
  for (const segment of after.narration.segments) {
    const old = oldSegments.get(segment.id);
    if (old?.text !== segment.text)
      changes.push({
        kind: "narration",
        label: old ? "Script" : "Segment added",
        file: "narration.json",
        before: short(old?.text),
        after: short(segment.text),
      });
    else if (JSON.stringify(old?.audio) !== JSON.stringify(segment.audio))
      changes.push({
        kind: "voice",
        label: "Audio",
        file: "narration.json",
      });
  }
  for (const old of before.narration.segments)
    if (!after.narration.segments.some((s) => s.id === old.id))
      changes.push({
        kind: "narration",
        label: "Segment removed",
        file: "narration.json",
        before: short(old.text),
      });
  const oldThreads = new Map(before.comments.threads.map((t) => [t.id, t]));
  for (const thread of after.comments.threads) {
    const old = oldThreads.get(thread.id);
    if (!old)
      changes.push({
        kind: "comment",
        label: "Note added",
        file: "comments.json",
        ref: thread.elementRef,
        after: short(thread.body),
      });
    else {
      for (const reply of thread.replies.slice(old.replies.length))
        changes.push({
          kind: "reply",
          label: "Reply",
          file: "comments.json",
          ref: thread.elementRef,
          after: short(reply.body),
        });
      if (old.status !== thread.status)
        changes.push({
          kind: "status",
          label:
            thread.status === "resolved" ? "Note resolved" : "Note reopened",
          file: "comments.json",
          ref: thread.elementRef,
        });
    }
  }
  if (before.css !== after.css)
    changes.push({ kind: "css", label: "Page styles", file: "overrides.css" });
  if (JSON.stringify(before.project) !== JSON.stringify(after.project))
    changes.push({
      kind: "project",
      label: "Project settings",
      file: "project.json",
    });
  return changes;
}
async function readHistory(
  dir: string,
  /** Under the project lock: move an unreadable history aside and start over. */
  repair = false,
): Promise<HistoryEntry[]> {
  const file = path.join(dir, ".history/edits.json");
  let text: string;
  try {
    text = await readProjectFile(dir, ".history/edits.json");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const history = JSON.parse(text);
    if (!Array.isArray(history)) throw new Error("Invalid edit history.");
    return history;
  } catch {
    // Undo history is a convenience: a damaged file must not block every edit.
    if (repair)
      await rename(
        file,
        `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`,
      );
    return [];
  }
}
export async function historySummary(dir: string) {
  return (await readHistory(dir))
    .map(({ before: _before, ...entry }) => entry)
    .reverse();
}
async function persistBundle(
  dir: string,
  next: ReplayBundle,
  before: ReplayBundle,
): Promise<void> {
  for (const [name, key] of [
    ["project.json", "project"],
    ["edits.json", "edits"],
    ["narration.json", "narration"],
    ["comments.json", "comments"],
  ] as const) {
    if (JSON.stringify(next[key]) !== JSON.stringify(before[key]))
      await writeJson(path.join(dir, name), next[key]);
  }
  if (next.css !== before.css)
    await atomicWrite(path.join(dir, "overrides.css"), next.css);
}
export async function mutateProject(
  dir: string,
  expectedRevision: string | undefined,
  description: string,
  mutate: (draft: ReplayBundle) => void | Promise<void>,
): Promise<ReplayBundle> {
  return withProjectLock(dir, async () => {
    const before = await loadBundle(dir);
    if (expectedRevision !== undefined && expectedRevision !== before.revision)
      throw new RevisionConflict(
        "The project changed. Reload or read the latest revision before retrying; your edits were not overwritten.",
      );
    const history = await readHistory(dir, true);
    const draft = structuredClone(before);
    await mutate(draft);
    const valid = validateBundle(draft);
    await persistBundle(dir, valid, before);
    const after = await loadBundle(dir);
    if (before.contentRevision !== after.contentRevision) {
      const author = mutationAuthor.getStore();
      history.push({
        id: `change-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        description,
        createdAt: new Date().toISOString(),
        afterRevision: after.revision,
        afterContentRevision: after.contentRevision,
        before,
        ...(author ? { author: { ...author } } : {}),
        changes: describeChanges(before, after),
      });
      await mkdir(path.join(dir, ".history"), { recursive: true });
      await writeJson(
        path.join(dir, ".history/edits.json"),
        history.slice(-50),
      );
    }
    return after;
  });
}
/** Undo the newest tracked changes. `steps` > 1 undoes a whole agent turn in
 * one locked operation; it still refuses to overwrite direct-file edits. */
export async function undoProject(
  dir: string,
  expectedRevision: string,
  steps = 1,
): Promise<ReplayBundle> {
  if (!Number.isInteger(steps) || steps < 1 || steps > 50)
    throw new Error("Undo steps must be an integer from 1 to 50.");
  return withProjectLock(dir, async () => {
    let current = await loadBundle(dir);
    if (current.revision !== expectedRevision)
      throw new RevisionConflict(
        "The project changed. Read the latest revision before undoing.",
      );
    const history = await readHistory(dir, true);
    if (history.length < steps)
      throw new Error(
        history.length
          ? "Not enough tracked changes to undo."
          : "Nothing to undo yet.",
      );
    const chain = history.slice(-steps).reverse();
    // Check the whole chain before writing. A direct-file edit between two
    // tracked changes is a boundary even if both changes are in one turn.
    // Content revisions are compared, so scene/audio files (not snapshotted)
    // may change in between; entries from older versions compare full ones.
    let expected = {
      content: current.contentRevision,
      full: current.revision,
    };
    for (const entry of chain) {
      const matches = entry.afterContentRevision
        ? entry.afterContentRevision === expected.content
        : entry.afterRevision === expected.full;
      if (!matches) {
        throw new RevisionConflict(
          "Files changed outside the editor or MCP since this action. Undo would overwrite those edits; restore them explicitly instead.",
        );
      }
      expected = {
        content: entry.before.contentRevision,
        full: entry.before.revision,
      };
    }
    // Nothing is written unless every snapshot is valid.
    const snapshots = chain.map((entry) => validateBundle(entry.before));
    for (let i = 0; i < steps; i++) {
      const entry = history.at(-1)!;
      await persistBundle(dir, snapshots[i]!, current);
      history.pop();
      current = await loadBundle(dir);
      const previous = history.at(-1);
      // Canonical serialization can change the revision of restored data.
      // Carry that change forward only across an intact tracked chain.
      if (previous?.afterRevision === entry.before.revision)
        previous.afterRevision = current.revision;
      if (
        previous?.afterContentRevision &&
        previous.afterContentRevision === entry.before.contentRevision
      )
        previous.afterContentRevision = current.contentRevision;
    }
    await writeJson(path.join(dir, ".history/edits.json"), history);
    return current;
  });
}
export async function safeFile(dir: string, relative: string): Promise<string> {
  const root = await realpath(dir);
  const requested = path.resolve(root, relative);
  if (!requested.startsWith(root + path.sep))
    throw new Error("Path is outside the project.");
  const resolved = await realpath(requested);
  if (!resolved.startsWith(root + path.sep))
    throw new Error("Path is outside the project.");
  return resolved;
}
