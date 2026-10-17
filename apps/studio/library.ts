import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { assetStamp, loadBundle } from "./storage.js";
import { readFormat } from "./format.js";
import { totalDuration, audioIsCurrent } from "./model.js";
import { historySummary } from "./storage.js";
import { readActivity } from "./activity.js";
import {
  cachedList,
  cachedWorktreeState,
  gitSummary,
  listDemoSources,
  listWorktrees,
} from "./git.js";
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
  /** Worktree folder holding this recording (repository libraries only). */
  worktree?: string;
  /** Not looked at yet, or re-captured / changed by an agent since. */
  fresh?: "new" | "updated";
  error?: string;
};
export type LibraryTour = {
  path: string;
  command: string;
  title?: string;
  /** IDs of recordings captured from this tour. */
  recordings: string[];
  worktree?: string;
};
/** One worktree of the opened repository. */
export type LibraryWorktree = {
  path: string;
  /** Folder name, e.g. the Conductor workspace name. */
  name: string;
  branch?: string;
  head?: string;
  detached?: boolean;
  locked?: boolean;
  /** The folder no longer exists. */
  missing?: boolean;
  /** The folder Studio was opened on. */
  current: boolean;
  /** The repository's main checkout. */
  main: boolean;
  changed: number;
  ahead?: number;
  behind?: number;
  recordings: number;
  tours: number;
};
export class LocalLibrary {
  readonly recordings = new Map<string, string>();
  /** Folders that hold demos: the opened folder, or every worktree when the
   * opened folder is a repository root. */
  roots: string[];
  private scanning?: ReturnType<LocalLibrary["run"]>;
  constructor(readonly root: string) {
    this.roots = [root];
  }
  static async open(root: string) {
    return new LocalLibrary(await realpath(root));
  }
  /** Concurrent callers (several viewers polling, lookups) share one
   * in-flight scan instead of each walking every worktree. */
  scan() {
    this.scanning ??= this.run().finally(() => (this.scanning = undefined));
    return this.scanning;
  }
  /** The worktree (or opened folder) that holds `dir`. */
  rootOf(dir: string): string | undefined {
    return this.roots
      .filter((r) => dir === r || dir.startsWith(r + path.sep))
      .sort((a, b) => b.length - a.length)[0];
  }
  private async run() {
    const recordings: (LibraryRecording & { tourSha256?: string })[] = [],
      tours: LibraryTour[] = [],
      warnings: string[] = [];
    // Main checkout first, then by folder name; missing folders last.
    const listed = (await listWorktrees(this.root))?.map((w) => ({
      ...w,
      main: !!w.main,
    }));
    listed?.sort(
      (a, b) =>
        Number(b.main) - Number(a.main) ||
        Number(!!a.missing) - Number(!!b.missing) ||
        path.basename(a.path).localeCompare(path.basename(b.path)),
    );
    const present = listed?.filter((w) => !w.missing) ?? [];
    this.roots = listed ? present.map((w) => w.path) : [this.root];
    if (listed && !this.roots.includes(this.root)) this.roots.unshift(this.root);
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
      "vendor",
      "target",
      ".next",
      ".turbo",
      ".venv",
      "venv",
      "__pycache__",
      "coverage",
      "Pods",
      "DerivedData",
      ".gradle",
    ]);
    // Tours are listed by path; only tours with recordings are read (to tell
    // whether they changed since capture), so large repositories stay fast.
    const tour = async (base: string, worktree: string | undefined, relative: string) => {
      tours.push({
        path: relative,
        recordings: [],
        worktree,
        // Stable text (no timestamps) so unchanged scans compare equal.
        command: `cd ${quote(base)} && ${quote(process.execPath)} ${quote(fileURLToPath(new URL("./cli.ts", import.meta.url)))} capture ${quote(relative)} --project ".demohunter/replays/${path.basename(relative).replace(/\.tour\.ts$/, "").replace(/[^\w.-]/g, "-")}-$(date +%s)"`,
      });
    };
    const scanRoot = async (base: string) => {
      const worktree = listed ? base : undefined;
      // Worktrees nested inside another (e.g. .worktrees/x) are scanned once.
      const others = new Set(this.roots.filter((r) => r !== base));
      let visited = 0;
      const label = (dir: string) =>
        path.relative(this.root, dir) || path.basename(dir) || ".";
      const walk = async (
        dir: string,
        depth: number,
        tourFiles: boolean,
      ): Promise<void> => {
        if (depth > 10 || visited > 20000) return;
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            warnings.push(`Cannot read ${label(dir)}`);
          return;
        }
        visited += entries.length;
        if (
          entries.some((e) => e.name === "project.json") &&
          entries.some((e) => e.name === "events.json")
        ) {
          recordings.push(await this.recording(dir, base, worktree));
          return;
        }
        const work: Promise<void>[] = [];
        for (const e of entries) {
          if (e.isSymbolicLink()) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory() && !skip.has(e.name) && !others.has(full))
            work.push(walk(full, depth + 1, tourFiles));
          else if (tourFiles && e.isFile() && e.name.endsWith(".tour.ts"))
            work.push(tour(base, worktree, path.relative(base, full)));
        }
        await Promise.all(work);
      };
      if (listed) {
        // Repositories: git knows where tours and .demohunter folders are,
        // so the (possibly huge) source tree is never walked.
        const sources = await cachedList(`sources:${base}`, () =>
          listDemoSources(base),
        );
        if (!sources) await walk(base, 0, true);
        else
          await Promise.all([
            ...sources.folders.map((f) => walk(path.join(base, f), 0, false)),
            ...sources.tours.map((t) => tour(base, worktree, t)),
          ]);
      } else await walk(base, 0, true);
      if (visited > 20000)
        warnings.push(
          `Scan of ${label(base)} limited to 20,000 entries; open a smaller folder.`,
        );
    };
    await Promise.all(this.roots.map(scanRoot));
    // Link recordings to the tour they came from in the same worktree.
    // studio.json stores the tour relative to the capturing config, so match
    // on the path suffix.
    for (const recording of recordings) {
      const source = recording.sourceTour;
      const tour = source
        ? tours.find(
            (t) =>
              t.worktree === recording.worktree &&
              (t.path === source || t.path.endsWith(`${path.sep}${source}`)),
          )
        : undefined;
      if (tour) {
        tour.recordings.push(recording.id);
        recording.tourPath = tour.path;
        const info = await this.tourInfo(
          path.join(recording.worktree ?? this.root, tour.path),
        );
        tour.title ??= info?.title;
        if (recording.tourSha256 && info)
          recording.tourChanged = info.sha256 !== recording.tourSha256;
      }
      delete recording.tourSha256;
    }
    const worktrees: LibraryWorktree[] | undefined = listed
      ? await Promise.all(
          listed.map(async (w) => ({
            path: w.path,
            name: path.basename(w.path),
            branch: w.branch,
            head: w.head,
            detached: w.detached,
            locked: w.locked,
            missing: w.missing,
            current: w.path === this.root,
            main: w.main,
            // Refreshed in the background; never holds up the library.
            ...(w.missing
              ? { changed: 0 }
              : (cachedWorktreeState(w.path) ?? { changed: 0 })),
            recordings: recordings.filter((r) => r.worktree === w.path).length,
            tours: tours.filter((t) => t.worktree === w.path).length,
          })),
        )
      : undefined;
    const byKey = (a: { path: string; worktree?: string }) =>
      `${a.worktree ?? ""}\0${a.path}`;
    return {
      protocolVersion: 1,
      workspace: this.root,
      git: await gitSummary(this.root),
      worktrees,
      recordings: recordings.sort(
        (a, b) =>
          b.modifiedAt.localeCompare(a.modifiedAt) ||
          byKey(a).localeCompare(byKey(b)),
      ),
      tours: tours.sort((a, b) => byKey(a).localeCompare(byKey(b))),
      warnings: warnings.sort(),
    };
  }
  /** Per-file caches keyed by modification time, so a rescan only reads
   * what changed. */
  private tourCache = new Map<
    string,
    { key: string; info: { sha256: string; title?: string } }
  >();
  private recordingCache = new Map<
    string,
    { key: string; value: LibraryRecording & { tourSha256?: string } }
  >();
  private async tourInfo(file: string) {
    const s = await stat(file).catch(() => undefined);
    if (!s?.isFile()) return undefined;
    const key = `${s.size}:${s.mtimeMs}`;
    const hit = this.tourCache.get(file);
    if (hit?.key === key) return hit.info;
    try {
      const source = await readFile(file);
      const info = {
        sha256: createHash("sha256").update(source).digest("hex"),
        // Read the literal title without executing the tour.
        title: /\btitle:\s*(["'`])((?:(?!\1).){1,160})\1/.exec(
          source.toString("utf8"),
        )?.[2],
      };
      this.tourCache.set(file, { key, info });
      return info;
    } catch {
      return undefined;
    }
  }
  private async recording(
    dir: string,
    base: string,
    worktree: string | undefined,
  ): Promise<LibraryRecording & { tourSha256?: string }> {
    const key = (
      await Promise.all(
        [
          "project.json",
          "edits.json",
          "narration.json",
          "comments.json",
          "overrides.css",
          "studio.json",
          "elements.json",
          ".history/edits.json",
          ".studio/activity",
        ]
          .map((name) =>
            stat(path.join(dir, name))
              .then((s) => `${s.size}:${s.mtimeMs}`)
              .catch(() => "-"),
          )
          .concat(assetStamp(dir)),
      )
    ).join("|");
    const hit = this.recordingCache.get(dir);
    if (hit?.key === key) {
      this.recordings.set(hit.value.id, dir);
      return { ...hit.value };
    }
    const value = await this.readRecording(dir, base, worktree);
    this.recordingCache.set(dir, { key, value });
    return { ...value };
  }
  private async readRecording(
    dir: string,
    base: string,
    worktree: string | undefined,
  ): Promise<LibraryRecording & { tourSha256?: string }> {
    const relative = path.relative(base, dir),
      // IDs stay relative to the opened folder, so existing links still work.
      id = createHash("sha256")
        .update(path.relative(this.root, dir))
        .digest("hex")
        .slice(0, 16);
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
      return {
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
        worktree,
      };
    } catch (e) {
      return {
        id,
        path: relative,
        title: path.basename(dir),
        modifiedAt: new Date(0).toISOString(),
        durationMs: 0,
        scenes: 0,
        narration: { ready: 0, total: 0 },
        comments: 0,
        agentChanges: 0,
        worktree,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
  async resolve(id: string) {
    if (!/^[a-f0-9]{16}$/.test(id)) throw new Error("Invalid recording ID");
    if (!this.recordings.has(id)) await this.scan();
    // A shared scan may have started before this demo was captured.
    if (!this.recordings.has(id)) await this.run();
    const dir = this.recordings.get(id);
    if (!dir) throw new Error("Recording not found");
    const resolved = await realpath(dir);
    if (!this.rootOf(resolved))
      throw new Error("Recording is outside the workspace");
    return resolved;
  }
}
function quote(s: string) {
  return `'${s.replaceAll("'", "'\\''")}'`;
}
