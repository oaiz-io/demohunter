import { createHash } from "node:crypto";
import {
  readFile,
  writeFile,
  rename,
  realpath,
  open,
  unlink,
  mkdir,
} from "node:fs/promises";
import path from "node:path";
import { readFormat } from "./format.js";
import { validateBundle, type ReplayBundle } from "./model.js";

export async function atomicWrite(
  file: string,
  content: string | Uint8Array,
): Promise<void> {
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temp, content);
  await rename(temp, file);
}
export async function writeJson(file: string, value: unknown): Promise<void> {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}
export async function loadBundle(dir: string): Promise<ReplayBundle> {
  await readFormat(dir);
  const files = await Promise.all(
    ["project.json", "edits.json", "narration.json", "overrides.css"].map(
      (name) => readFile(path.join(dir, name), "utf8"),
    ),
  );
  files.push(
    await readFile(path.join(dir, "comments.json"), "utf8").catch((error) => {
      if (error.code === "ENOENT") return '{"threads":[]}';
      throw error;
    }),
  );
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
    });
  } catch (error) {
    throw new Error(
      `Invalid replay project: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export class RevisionConflict extends Error {
  readonly status = 409;
}
export async function withProjectLock<T>(
  dir: string,
  work: () => Promise<T>,
): Promise<T> {
  const file = path.join(dir, ".project.lock");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      handle = await open(file, "wx");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!handle)
    throw new RevisionConflict(
      "Project is busy. Retry shortly; if a writer crashed, remove .project.lock.",
    );
  try {
    await handle.writeFile(String(process.pid));
    return await work();
  } finally {
    await handle.close();
    await unlink(file);
  }
}
type HistoryEntry = {
  id: string;
  description: string;
  createdAt: string;
  afterRevision: string;
  before: ReplayBundle;
};
async function readHistory(dir: string): Promise<HistoryEntry[]> {
  try {
    const history = JSON.parse(
      await readFile(path.join(dir, ".history/edits.json"), "utf8"),
    );
    if (!Array.isArray(history)) throw new Error("Invalid edit history.");
    return history;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
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
    const history = await readHistory(dir);
    const draft = structuredClone(before);
    await mutate(draft);
    const valid = validateBundle(draft);
    await persistBundle(dir, valid, before);
    const after = await loadBundle(dir);
    if (before.revision !== after.revision) {
      history.push({
        id: `change-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        description,
        createdAt: new Date().toISOString(),
        afterRevision: after.revision,
        before,
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
export async function undoProject(
  dir: string,
  expectedRevision: string,
): Promise<ReplayBundle> {
  return withProjectLock(dir, async () => {
    const current = await loadBundle(dir);
    if (current.revision !== expectedRevision)
      throw new RevisionConflict(
        "The project changed. Read the latest revision before undoing.",
      );
    const history = await readHistory(dir);
    const entry = history.at(-1);
    if (!entry) throw new Error("Nothing to undo yet.");
    if (entry.afterRevision !== current.revision)
      throw new RevisionConflict(
        "Files changed outside the editor or MCP since this action. Undo would overwrite those edits; restore them explicitly instead.",
      );
    await persistBundle(dir, validateBundle(entry.before), current);
    history.pop();
    const result = await loadBundle(dir);
    if (history.length)
      history[history.length - 1]!.afterRevision = result.revision;
    await writeJson(path.join(dir, ".history/edits.json"), history);
    return result;
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
