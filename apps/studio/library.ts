import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { loadBundle } from "./storage.js";
import { readFormat } from "./format.js";
import { totalDuration, audioIsCurrent } from "./model.js";
import { historySummary } from "./storage.js";
import { readActivity } from "./activity.js";
import { gitStatus } from "./git.js";
export type LibraryRecording = {
  id: string;
  path: string;
  title: string;
  modifiedAt: string;
  durationMs: number;
  scenes: number;
  narration: { ready: number; total: number };
  comments: number;
  revision?: string;
  captureId?: string;
  sourceTour?: string;
  /** Library-relative path of the tour this recording came from, if found. */
  tourPath?: string;
  /** The tour file changed after this recording was captured. */
  tourChanged?: boolean;
  /** Tracked edits made by agents (MCP), newest first count. */
  agentChanges: number;
  /** An agent tool call is running in this recording right now. */
  activeAgent?: string;
  error?: string;
};
export type LibraryTour = {
  path: string;
  command: string;
  title?: string;
  /** IDs of recordings captured from this tour. */
  recordings: string[];
};
export class LocalLibrary {
  readonly recordings = new Map<string, string>();
  constructor(readonly root: string) {}
  static async open(root: string) {
    return new LocalLibrary(await realpath(root));
  }
  async scan() {
    const recordings: (LibraryRecording & { tourSha256?: string })[] = [],
      tours: LibraryTour[] = [],
      warnings: string[] = [];
    let visited = 0;
    const tourHashes = new Map<string, string | undefined>();
    const skip = new Set([
      "node_modules",
      ".git",
      ".history",
      ".studio",
      "dist",
      "build",
      "audio",
      "assets",
      "sources",
      "cache",
      ".cache",
    ]);
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 10 || visited > 20000) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        warnings.push(`Cannot read ${path.relative(this.root, dir) || "."}`);
        return;
      }
      visited += entries.length;
      if (
        entries.some((e) => e.name === "project.json") &&
        entries.some((e) => e.name === "events.json")
      ) {
        const relative = path.relative(this.root, dir),
          id = createHash("sha256").update(relative).digest("hex").slice(0, 16);
        this.recordings.set(id, dir);
        try {
          const bundle = await loadBundle(dir),
            format = await readFormat(dir);
          let captureId = format?.captureId;
          try {
            captureId ??= JSON.parse(
              await readFile(path.join(dir, "elements.json"), "utf8"),
            ).captureId;
          } catch {}
          const timestamps = await Promise.all(
            [
              "project.json",
              "edits.json",
              "narration.json",
              "comments.json",
              "overrides.css",
            ].map((name) =>
              stat(path.join(dir, name))
                .then((s) => s.mtimeMs)
                .catch(() => 0),
            ),
          );
          const [history, activity] = await Promise.all([
            historySummary(dir).catch(() => []),
            readActivity(dir).catch(() => []),
          ]);
          const running = activity.find((a) => a.status === "running");
          recordings.push({
            id,
            path: relative,
            title: bundle.project.title,
            agentChanges: history.filter((h) => h.author).length,
            activeAgent: running?.actor,
            tourSha256: format?.source?.tourSha256,
            modifiedAt: new Date(Math.max(...timestamps)).toISOString(),
            revision: bundle.revision,
            durationMs: totalDuration(bundle.edits),
            scenes: bundle.edits.clips.length,
            narration: {
              ready: bundle.narration.segments.filter((s) =>
                audioIsCurrent(bundle.project, s),
              ).length,
              total: bundle.narration.segments.length,
            },
            comments: bundle.comments.threads.filter((t) => t.status === "open")
              .length,
            captureId,
            sourceTour: format?.source?.tour,
          });
        } catch (e) {
          recordings.push({
            id,
            path: relative,
            title: path.basename(dir),
            modifiedAt: new Date(0).toISOString(),
            durationMs: 0,
            scenes: 0,
            narration: { ready: 0, total: 0 },
            comments: 0,
            agentChanges: 0,
            error: e instanceof Error ? e.message : String(e),
          });
        }
        return;
      }
      for (const e of entries) {
        if (e.isSymbolicLink()) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory() && !skip.has(e.name)) await walk(full, depth + 1);
        else if (e.isFile() && e.name.endsWith(".tour.ts")) {
          const relative = path.relative(this.root, full);
          let title: string | undefined, sha256: string | undefined;
          try {
            const source = await readFile(full);
            sha256 = createHash("sha256").update(source).digest("hex");
            // Read the literal title without executing the tour.
            title = /\btitle:\s*(["'`])((?:(?!\1).){1,160})\1/.exec(
              source.toString("utf8"),
            )?.[2];
          } catch {}
          tourHashes.set(relative, sha256);
          tours.push({
            path: relative,
            title,
            recordings: [],
            command: `cd ${quote(this.root)} && ${quote(process.execPath)} ${quote(fileURLToPath(new URL("./cli.ts", import.meta.url)))} capture ${quote(relative)} --project ${quote(`.demohunter/replays/${e.name.replace(/\.tour\.ts$/, "")}-${Date.now()}`)}`,
          });
        }
      }
    };
    await walk(this.root, 0);
    // Link recordings to the tour they came from. studio.json stores the tour
    // relative to the capturing config, so match on the path suffix.
    for (const recording of recordings as (LibraryRecording & {
      tourSha256?: string;
    })[]) {
      const source = recording.sourceTour;
      const tour = source
        ? tours.find(
            (t) => t.path === source || t.path.endsWith(`${path.sep}${source}`),
          )
        : undefined;
      if (tour) {
        tour.recordings.push(recording.id);
        recording.tourPath = tour.path;
        const now = tourHashes.get(tour.path);
        if (recording.tourSha256 && now)
          recording.tourChanged = now !== recording.tourSha256;
      }
      delete recording.tourSha256;
    }
    if (visited > 20000)
      warnings.push(
        "Scan limited to 20,000 entries; start Studio in a smaller workspace.",
      );
    return {
      protocolVersion: 1,
      workspace: this.root,
      git: await gitStatus(this.root),
      recordings: recordings.sort((a, b) =>
        b.modifiedAt.localeCompare(a.modifiedAt),
      ),
      tours,
      warnings,
    };
  }
  async resolve(id: string) {
    if (!/^[a-f0-9]{16}$/.test(id)) throw new Error("Invalid recording ID");
    if (!this.recordings.has(id)) await this.scan();
    const dir = this.recordings.get(id);
    if (!dir) throw new Error("Recording not found");
    const resolved = await realpath(dir);
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep))
      throw new Error("Recording is outside the workspace");
    return resolved;
  }
}
function quote(s: string) {
  return `'${s.replaceAll("'", "'\\''")}'`;
}
