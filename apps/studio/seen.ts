import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LibraryRecording } from "./library.js";
import { writeJson } from "./storage.js";

type Mark = {
  captureId?: string;
  /** Marks written by older versions only have this count. */
  agentChanges: number;
  lastAgentChangeAt?: string;
};

/**
 * Which demos the person has looked at, so the library can point out new and
 * updated ones. "Updated" means re-captured or changed by an agent — your own
 * edits don't count. Stored as runtime state in .demohunter/studio/seen.json
 * (git-ignored), because the desktop app's port, and so browser storage,
 * changes every launch.
 */
export class SeenDemos {
  private marks?: Promise<Record<string, Mark> | null>;
  private writing = Promise.resolve();
  constructor(private readonly root: string) {}
  private get file() {
    return path.join(this.root, ".demohunter", "studio", "seen.json");
  }
  /** A missing or damaged file means "first run" (null), never a cached
   * rejection: the next save replaces it. */
  private load() {
    return (this.marks ??= readFile(this.file, "utf8")
      .then((text) => {
        const value = JSON.parse(text);
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("Invalid seen marks.");
        return value as Record<string, Mark>;
      })
      .catch(() => null));
  }
  /** One read-modify-write at a time, so concurrent marks keep each other. */
  private queue: Promise<unknown> = Promise.resolve();
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => {});
    return run;
  }
  private save(marks: Record<string, Mark>) {
    this.marks = Promise.resolve(marks);
    this.writing = this.writing
      .then(async () => {
        await mkdir(path.dirname(this.file), { recursive: true });
        await writeFile(path.join(path.dirname(this.file), ".gitignore"), "*\n", {
          flag: "wx",
        }).catch(() => {});
        await writeJson(this.file, marks);
      })
      .catch(() => {});
    return this.writing;
  }
  /** `fresh` for each recording. The first run sees everything as known. */
  async annotate<T extends LibraryRecording>(
    recordings: T[],
  ): Promise<(T & { fresh?: "new" | "updated" })[]> {
    let marks = await this.load();
    if (!marks)
      marks = await this.exclusive(async () => {
        const known = await this.load();
        if (known) return known;
        const first = Object.fromEntries(recordings.map((r) => [r.id, mark(r)]));
        await this.save(first);
        return first;
      });
    return recordings.map((r) => {
      const seen = marks![r.id];
      const fresh = !seen
        ? "new"
        : (r.captureId && seen.captureId && r.captureId !== seen.captureId) ||
            agentTouched(r, seen)
          ? "updated"
          : undefined;
      return fresh ? { ...r, fresh } : r;
    });
  }
  async mark(recording: LibraryRecording): Promise<void> {
    await this.exclusive(async () => {
      const marks = { ...((await this.load()) ?? {}) };
      marks[recording.id] = mark(recording);
      await this.save(marks);
    });
  }
}
/** An agent edited since the mark. By time, not by count: history keeps only
 * the newest entries, so a count can stop growing. */
const agentTouched = (r: LibraryRecording, seen: Mark) =>
  seen.lastAgentChangeAt
    ? !!r.lastAgentChangeAt && r.lastAgentChangeAt > seen.lastAgentChangeAt
    : // Marks from before timestamps were stored.
      r.agentChanges > seen.agentChanges ||
      (!!r.lastAgentChangeAt && seen.agentChanges === 0);
const mark = (r: LibraryRecording): Mark => ({
  captureId: r.captureId,
  agentChanges: r.agentChanges,
  lastAgentChangeAt: r.lastAgentChangeAt,
});
