import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LibraryRecording } from "./library.js";
import { writeJson } from "./storage.js";

type Mark = { captureId?: string; agentChanges: number };

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
  private load() {
    return (this.marks ??= readFile(this.file, "utf8").then(
      (text) => JSON.parse(text) as Record<string, Mark>,
      () => null,
    ));
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
    if (!marks) {
      marks = Object.fromEntries(recordings.map((r) => [r.id, mark(r)]));
      await this.save(marks);
    }
    return recordings.map((r) => {
      const seen = marks![r.id];
      const fresh = !seen
        ? "new"
        : (r.captureId && seen.captureId && r.captureId !== seen.captureId) ||
            r.agentChanges > seen.agentChanges
          ? "updated"
          : undefined;
      return fresh ? { ...r, fresh } : r;
    });
  }
  async mark(recording: LibraryRecording): Promise<void> {
    const marks = { ...((await this.load()) ?? {}) };
    marks[recording.id] = mark(recording);
    await this.save(marks);
  }
}
const mark = (r: LibraryRecording): Mark => ({
  captureId: r.captureId,
  agentChanges: r.agentChanges,
});
