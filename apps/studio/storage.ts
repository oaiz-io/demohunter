import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  readFile,
  writeFile,
  rename,
  realpath,
  open,
  unlink,
  link,
  mkdir,
  readdir,
  lstat,
  stat,
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
    await writeFile(temp, content);
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
  const motion = await motionFingerprint(dir);
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
    });
  } catch (error) {
    throw new Error(
      `Invalid replay project: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Scene/overlay files by content, audio by size and time (they can be big). */
async function motionFingerprint(dir: string): Promise<string> {
  const parts: string[] = [];
  for (const [folder, byContent] of [
    ["scenes", true],
    ["audio", false],
  ] as const) {
    for (const name of (await listFiles(path.join(dir, folder))).sort()) {
      const file = path.join(dir, folder, name);
      const info = await stat(file).catch(() => undefined);
      if (!info?.isFile()) continue;
      parts.push(
        `${folder}/${name}:${
          byContent
            ? createHash("sha256")
                .update(await readFile(file))
                .digest("hex")
            : `${info.size}:${Math.round(info.mtimeMs)}`
        }`,
      );
    }
  }
  return parts.join("\n");
}
/** Cheap change stamp for scene/audio files (size and time, no reads), for
 * caches that must notice any edit, however deep. */
export async function assetStamp(dir: string): Promise<string> {
  const parts: string[] = [];
  for (const folder of ["scenes", "audio"])
    for (const name of await listFiles(path.join(dir, folder))) {
      const info = await stat(path.join(dir, folder, name)).catch(() => undefined);
      if (info?.isFile()) parts.push(`${folder}/${name}:${info.size}:${info.mtimeMs}`);
    }
  return parts.sort().join("|");
}
/** Files under a folder, without following symlinks (no loops, no escapes). */
async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, prefix), {
    withFileTypes: true,
  }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(root, name)));
    else if (entry.isFile()) files.push(name);
  }
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
/** Removes a lock whose owner died or went silent. Reports whether the file
 * is now gone (or was already). */
async function clearStaleLock(file: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  let pid: number | undefined, at: number | undefined;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      pid = Number(parsed.pid);
      at = Date.parse(parsed.at);
    } else pid = Number(parsed); // older versions wrote a bare pid
  } catch {}
  // Just created (not written yet) or from an older version: use the file time.
  if (at === undefined || Number.isNaN(at))
    at = (await stat(file).catch(() => undefined))?.mtimeMs;
  if (at === undefined) return true;
  const dead = Number.isInteger(pid) && pid! > 0 && !pidAlive(pid!);
  if (!dead && Date.now() - at < LOCK_STALE_MS) return false;
  // Move it aside first: of several takers only one rename succeeds.
  const moved = `${file}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await rename(file, moved);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  if ((await readFile(moved, "utf8").catch(() => text)) !== text) {
    // A new owner took the lock between our read and the move: give it back.
    await link(moved, file).catch(() => {});
    await unlink(moved).catch(() => {});
    return false;
  }
  await unlink(moved).catch(() => {});
  return true;
}
/** Exclusive lock file holding the owner's pid and time. A lock whose process
 * is gone, or that nobody refreshed for 30 s, is taken over. Resolves
 * undefined while a live owner holds it; other errors are thrown as-is. */
export async function acquireLock(file: string): Promise<FileLock | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(file, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await clearStaleLock(file)) continue;
      return undefined;
    }
    const stamp = () => JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
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
        await unlink(file).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      },
    };
  }
  return undefined;
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
