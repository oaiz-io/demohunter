import { createHash } from "node:crypto";
import { watch, type Dirent, type FSWatcher } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { assetStamp, loadBundle, readProjectFile } from "./storage.js";
import { readFormat } from "./format.js";
import { totalDuration, audioIsCurrent, isScene } from "./model.js";
import { historySummary } from "./storage.js";
import { readActivity } from "./activity.js";
import { restrictFolder, scenesTrusted } from "./trust.js";
import {
  cachedWorktreeState,
  forgetGitSummary,
  gitSummary,
  limitedListing,
  limitedWalk,
  listTrackedDemoSources,
  listUntrackedDemoSources,
  listWorktrees,
  mergeDemoSources,
  type DemoSourceParts,
} from "./git.js";
/** Same horizon as readActivity: no update for 15 s means interrupted. */
const ACTIVE_MS = 15_000;
type Cached = LibraryRecording & {
  tourSha256?: string;
  /** Running tool calls at read time, to be judged against the clock later. */
  running?: { actor: string; at: number }[];
};
export type LibraryRecording = {
  id: string;
  path: string;
  title: string;
  modifiedAt: string;
  durationMs: number;
  scenes: number;
  /** Every clip is an HTML scene: a film with no recording (`studio new`). */
  film?: boolean;
  narration: { ready: number; total: number };
  comments: number;
  revision?: string;
  captureId?: string;
  sourceTour?: string;
  /** Library-relative path of the tour this recording came from, if found. */
  tourPath?: string;
  /** The tour file changed after this recording was captured. */
  tourChanged?: boolean;
  /** Tracked edits made by agents (MCP) among the kept history entries. */
  agentChanges: number;
  /** When an agent last made a tracked edit (ISO time). */
  lastAgentChangeAt?: string;
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
  /** Uncommitted files; absent when git could not tell (timed out). */
  changed?: number;
  ahead?: number;
  behind?: number;
  recordings: number;
  tours: number;
};
/** Folders the scan never descends into. */
const SKIP = new Set([
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
/** Entries one walk may read; a larger folder is cut off (with a warning). */
const WALK_BUDGET = 20_000;
const MAX_DEPTH = 10;
/** Recursive file watching is cheap and does not follow symlinks on macOS
 * (FSEvents) and Windows. Elsewhere (inotify) it needs one watch per folder,
 * so the service polls instead. */
const CAN_WATCH = process.platform === "darwin" || process.platform === "win32";

const unref = (timer: unknown) => (timer as { unref?: () => void }).unref?.();

/** Stale-while-revalidate value: the first read waits (or not, see `get`);
 * later reads get the last value at once and refresh it in the background
 * when it is older than the given age or was invalidated. */
class Swr<T> {
  private value?: T;
  private known = false;
  private at = 0;
  private dirty = false;
  private running?: Promise<T>;
  constructor(private readonly load: () => Promise<T>) {}
  private start() {
    this.dirty = false;
    this.lastStart = Date.now();
    const started = Date.now();
    const run = this.load().then((value) => {
      this.value = value;
      this.known = true;
      this.at = started;
      return value;
    });
    this.running = run;
    void run.catch(() => {}).finally(() => {
      if (this.running === run) this.running = undefined;
    });
    return run;
  }
  /** `wait`: true waits for the first value, a number waits at most that many
   * milliseconds (undefined when it is not there yet), false never waits. */
  async get(maxAgeMs: number, wait: boolean | number = true): Promise<T | undefined> {
    if (!this.known) {
      const run = this.running ?? this.start();
      if (wait === true) return run;
      if (wait === false) return undefined;
      return Promise.race([
        run.catch(() => undefined),
        new Promise<undefined>((r) => unref(setTimeout(r, wait))),
      ]);
    }
    if (!this.running && (this.dirty || Date.now() - this.at > maxAgeMs))
      void this.start().catch(() => {});
    return this.value;
  }
  /** A fresh value: waits for a new load that starts after this call. */
  async fresh(): Promise<T> {
    await this.running?.catch(() => {});
    return this.start();
  }
  private timer?: ReturnType<typeof setTimeout>;
  private lastStart = 0;
  /** Something changed: refresh soon (debounced, and at most every 5 s, so
   * a burst of changes costs one listing). */
  invalidate() {
    this.dirty = true;
    if (this.timer || !this.known) return;
    const delay = Math.max(1000, this.lastStart + 5000 - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.dirty && !this.running && !this.stopped) void this.start().catch(() => {});
    }, delay);
    unref(this.timer);
  }
  private stopped = false;
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  /** Wait for a load in progress (tests). */
  async settled() {
    await this.running?.catch(() => {});
  }
}

/** A worktree, or the opened plain folder. */
type Tree = {
  path: string;
  /** `git ls-files --cached` and the `.demohunter` probe. */
  tracked: Swr<DemoSourceParts | undefined>;
  /** Untracked and ignored sources: a worktree walk, run in the background. */
  untracked: Swr<DemoSourceParts | undefined>;
  /** Plain folders: the last bounded walk, reused while no folder it read
   * changed (folder mtimes). */
  walk?: PlainWalk;
  watcher?: FSWatcher;
  /** Last change a watcher saw outside ignored folders (for `git status`). */
  changedAt: number;
  /** Folders the last scan looked in, to tell a new `.demohunter` folder. */
  folders: Set<string>;
};
type PlainWalk = {
  tours: string[];
  folders: string[];
  limited: boolean;
  warnings: string[];
  /** Every folder the walk read, with its mtime before the read. */
  dirs: [dir: string, mtimeMs: number][];
};

const isRecording = (entries: Dirent[]) =>
  entries.some((e) => e.name === "project.json") &&
  entries.some((e) => e.name === "events.json" || e.name === "capture.dhcapture");

export type LibraryOptions = {
  restricted?: boolean;
  /** The Studio service: caches git listings, watches files where the
   * platform can do it cheaply, and never waits for a worktree walk. Other
   * callers (CLI, MCP, tests) get a complete scan on first use. */
  live?: boolean;
};

export class LocalLibrary {
  readonly recordings = new Map<string, string>();
  /** Folders that hold demos: the opened folder, or every worktree when the
   * opened folder is a repository root. */
  roots: string[];
  private scanning?: ReturnType<LocalLibrary["run"]>;
  private trees = new Map<string, Tree>();
  private worktreeList = new Swr(() => listWorktrees(this.root));
  /** `.git/worktrees/<id>` → worktree path, for watcher events. */
  private gitDirs = new Map<string, string>();
  private closed = false;
  readonly live: boolean;
  /** Opened without being trusted: every worktree it lists is restricted
   * before any git work runs in it. */
  constructor(
    readonly root: string,
    readonly restricted = false,
    options: { live?: boolean } = {},
  ) {
    this.roots = [root];
    this.live = !!options.live;
    if (restricted) restrictFolder(root);
  }
  static async open(root: string, options: LibraryOptions = {}) {
    return new LocalLibrary(await realpath(root), options.restricted, options);
  }
  /** Concurrent callers (several viewers polling, lookups) share one
   * in-flight scan instead of each walking every worktree. */
  scan() {
    this.scanning ??= this.run().finally(() => (this.scanning = undefined));
    return this.scanning;
  }
  /** A scan that re-reads every git listing first (a demo or worktree that
   * appeared after the last scan). */
  async refresh() {
    await this.scanning?.catch(() => {});
    return this.run(true);
  }
  /** Wait for background listings (tests and benchmarks). */
  async settled() {
    await Promise.all(
      [...this.trees.values()].flatMap((t) => [t.tracked.settled(), t.untracked.settled()]),
    );
  }
  close() {
    this.closed = true;
    this.worktreeList.stop();
    for (const t of this.trees.values()) this.drop(t);
  }
  private drop(t: Tree) {
    t.watcher?.close();
    t.watcher = undefined;
    for (const swr of [t.tracked, t.untracked]) swr.stop();
  }
  /** The worktree (or opened folder) that holds `dir`. */
  rootOf(dir: string): string | undefined {
    return this.roots
      .filter((r) => dir === r || dir.startsWith(r + path.sep))
      .sort((a, b) => b.length - a.length)[0];
  }
  private label(dir: string) {
    return path.relative(this.root, dir) || path.basename(dir) || ".";
  }
  /** How old a cached listing may be before a background refresh. A watched
   * tree refreshes on change, so its age limit is only a safety net. */
  private ttl(tree: Tree | undefined, watched: number, polled: number) {
    if (!this.live) return 10_000;
    return tree?.watcher ? watched : polled;
  }
  private tree(dir: string, repository: boolean): Tree {
    let t = this.trees.get(dir);
    if (t) return t;
    t = {
      path: dir,
      tracked: new Swr(() => limitedListing(() => listTrackedDemoSources(dir))),
      untracked: new Swr(() => limitedWalk(() => listUntrackedDemoSources(dir))),
      changedAt: Date.now(),
      folders: new Set(),
    };
    this.trees.set(dir, t);
    if (this.live && CAN_WATCH && repository && !this.closed) this.watch(t);
    return t;
  }
  private watch(t: Tree) {
    try {
      const watcher = watch(t.path, { recursive: true, persistent: false }, (_type, file) => {
        if (file) this.changed(t, String(file).split(path.sep).join("/"));
      });
      watcher.on("error", () => {
        // Fall back to polling for this tree.
        watcher.close();
        if (t.watcher === watcher) t.watcher = undefined;
      });
      t.watcher = watcher;
    } catch {
      t.watcher = undefined;
    }
  }
  /** A watcher event: mark what it can have changed. Cheap, because a busy
   * worktree sends thousands. */
  private changed(t: Tree, file: string) {
    if (file === ".git" || file.startsWith(".git/")) {
      if (/^\.git\/(objects|logs|lfs)\//.test(file) || file.endsWith(".lock")) return;
      // HEAD, refs and worktree entries: branches and the worktree list.
      this.worktreeList.invalidate();
      const linked = /^\.git\/worktrees\/([^/]+)\/(index|HEAD)$/.exec(file);
      if (linked) {
        void this.byGitDir(t.path, linked[1]!).then((dir) => {
          const owner = dir ? this.trees.get(dir) : undefined;
          if (owner) this.touch(owner, true);
          if (dir && linked[2] === "HEAD") forgetGitSummary(dir);
        });
      } else if (file === ".git/index" || file === ".git/HEAD") {
        this.touch(t, true);
        if (file === ".git/HEAD") forgetGitSummary(t.path);
      } else if (file.startsWith(".git/refs/") || file === ".git/packed-refs")
        // Ahead/behind of every worktree can move.
        for (const other of this.trees.values()) other.changedAt = Date.now();
      return;
    }
    // A nested worktree's events also reach the outer one: give them to
    // the innermost tree.
    const full = path.join(t.path, file);
    const owner = this.trees.get(this.rootOf(full) ?? t.path) ?? t;
    const rel = path.relative(owner.path, full).split(path.sep).join("/");
    const parts = rel.split("/");
    const demo = parts.indexOf(".demohunter");
    if (demo >= 0) {
      // Recordings in known folders are walked on every scan; a new
      // .demohunter folder needs a new listing.
      const folder = parts.slice(0, demo + 1).join("/");
      if (!owner.folders.has(folder)) owner.untracked.invalidate();
      return;
    }
    if (parts.includes(".git") || parts.some((p) => SKIP.has(p))) return;
    owner.changedAt = Date.now();
    const name = parts.at(-1) ?? "";
    if (
      name.endsWith(".tour.ts") ||
      name === "project.json" ||
      name === "events.json" ||
      name === "capture.dhcapture" ||
      name === ".gitignore"
    )
      owner.untracked.invalidate();
  }
  private touch(t: Tree, sources: boolean) {
    t.changedAt = Date.now();
    if (sources) {
      t.tracked.invalidate();
      t.untracked.invalidate();
    }
  }
  private async byGitDir(main: string, id: string) {
    const hit = this.gitDirs.get(id);
    if (hit) return hit;
    const text = await readFile(path.join(main, ".git/worktrees", id, "gitdir"), "utf8").catch(() => "");
    const dir = text ? await realpath(path.dirname(text.trim())).catch(() => "") : "";
    if (dir) this.gitDirs.set(id, dir);
    return dir || undefined;
  }
  private async run(fresh = false) {
    const recordings: (LibraryRecording & { tourSha256?: string })[] = [],
      tours: LibraryTour[] = [],
      warnings: string[] = [];
    // The worktree list is cached by the service (3 git processes); other
    // callers read it on every scan, as before.
    const list = !this.live || fresh
      ? await this.worktreeList.fresh()
      : await this.worktreeList.get(this.trees.get(this.root)?.watcher ? 60_000 : 15_000);
    // Main checkout first, then by folder name; missing folders last.
    const listed = list?.map((w) => ({ ...w, main: !!w.main }));
    // The main checkout or a sibling worktree can sit outside the opened
    // folder; restrict them before anything below (or a render) runs there.
    if (this.restricted) for (const w of listed ?? []) restrictFolder(w.path);
    listed?.sort(
      (a, b) =>
        Number(b.main) - Number(a.main) ||
        Number(!!a.missing) - Number(!!b.missing) ||
        path.basename(a.path).localeCompare(path.basename(b.path)),
    );
    const present = listed?.filter((w) => !w.missing) ?? [];
    this.roots = listed ? present.map((w) => w.path) : [this.root];
    if (listed && !this.roots.includes(this.root)) this.roots.unshift(this.root);
    for (const [dir, t] of this.trees)
      if (!this.roots.includes(dir)) {
        this.drop(t);
        this.trees.delete(dir);
      }
    const label = (dir: string) => this.label(dir);
    // Tours are listed by path; only tours with recordings are read (to tell
    // whether they changed since capture), so large repositories stay fast.
    const tour = (worktree: string | undefined, relative: string) =>
      tours.push({ path: relative, recordings: [], worktree });
    const scanRoot = async (base: string) => {
      const worktree = listed ? base : undefined;
      // Worktrees nested inside another (e.g. .worktrees/x) are scanned once.
      const others = new Set(this.roots.filter((r) => r !== base));
      const t = this.tree(base, !!listed);
      let folders: string[] | undefined;
      if (listed) {
        // Repositories: git knows where tours and .demohunter folders are,
        // so the (possibly huge) source tree is never walked here.
        const get = <T,>(swr: Swr<T>, watched: number, polled: number, wait: boolean | number) =>
          fresh ? swr.fresh() : swr.get(this.ttl(t, watched, polled), wait);
        const [tracked, untracked] = await Promise.all([
          get(t.tracked, 120_000, 10_000, true),
          // The worktree walk: the service shows the library without it and
          // adds what it finds on a later poll.
          get(t.untracked, 300_000, 60_000, this.live ? 150 : true),
        ]);
        if (tracked) {
          const sources = mergeDemoSources(tracked, untracked);
          for (const p of sources.tours) tour(worktree, p);
          folders = sources.folders;
        }
      }
      if (!folders) {
        // A plain folder (or git failed): walk it, unless no folder that the
        // last walk read has changed since.
        if (fresh || !t.walk || !(await unchanged(t.walk.dirs)))
          t.walk = await walkPlain(base, others, label);
        const walk = t.walk;
        for (const p of walk.tours) tour(worktree, p);
        warnings.push(...walk.warnings);
        if (walk.limited)
          warnings.push(`Scan of ${label(base)} limited to 20,000 entries; open a smaller folder.`);
        folders = walk.folders;
      }
      t.folders = new Set(folders);
      // Recordings in the demo folders: read on every scan, so a new or
      // changed demo shows on the next poll without any git work.
      const found = await findRecordings(base, folders, others, (dir) =>
        warnings.push(`Cannot read ${label(dir)}`),
      );
      if (found.limited)
        warnings.push(`Scan of ${label(base)} limited to 20,000 entries; open a smaller folder.`);
      recordings.push(
        ...(await Promise.all(found.dirs.map((dir) => this.recording(dir, base, worktree)))),
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
    const counts = (key: string | undefined) => ({
      recordings: recordings.filter((r) => r.worktree === key).length,
      tours: tours.filter((t) => t.worktree === key).length,
    });
    const worktrees: LibraryWorktree[] | undefined = listed?.map((w) => {
      const t = this.trees.get(w.path);
      const current = w.path === this.root;
      return {
        path: w.path,
        name: path.basename(w.path),
        branch: w.branch,
        head: w.head,
        detached: w.detached,
        locked: w.locked,
        missing: w.missing,
        current,
        main: w.main,
        // Refreshed in the background; never holds up the library.
        // Not in restricted folders: `git status` runs filters a crafted
        // repository can configure (code execution before any trust).
        ...(w.missing || this.restricted || !scenesTrusted(w.path)
          ? { changed: 0 }
          : cachedWorktreeState(
              w.path,
              // Other worktrees matter less: refresh them less often.
              !this.live || current ? 15_000 : 60_000,
              // A watched worktree runs `git status` only after a change.
              t?.watcher ? { changedAt: t.changedAt, idleMaxAgeMs: 600_000 } : {},
            )),
        ...counts(w.path),
      };
    });
    const byKey = (a: { path: string; worktree?: string }) =>
      `${a.worktree ?? ""}\0${a.path}`;
    return {
      protocolVersion: 1,
      workspace: this.root,
      git: await gitSummary(this.root, this.live ? (this.trees.get(this.root)?.watcher ? 120_000 : 30_000) : 10_000),
      worktrees,
      recordings: recordings.sort(
        (a, b) =>
          b.modifiedAt.localeCompare(a.modifiedAt) ||
          byKey(a).localeCompare(byKey(b)),
      ),
      tours: tours.sort((a, b) => byKey(a).localeCompare(byKey(b))),
      warnings: [...new Set(warnings)].sort(),
    };
  }

  /** Per-file caches keyed by modification time, so a rescan only reads
   * what changed. */
  private tourCache = new Map<
    string,
    { key: string; info: { sha256: string; title?: string } }
  >();
  private recordingCache = new Map<string, { key: string; value: Cached }>();
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
          "capture.dhcapture",
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
    let value = hit?.value;
    if (hit?.key === key) this.recordings.set(hit.value.id, dir);
    else {
      value = await this.readRecording(dir, base, worktree);
      this.recordingCache.set(dir, { key, value });
    }
    // Liveness is time, not file state: a dead agent stops touching its
    // activity file, so judge the cached timestamps on every scan.
    const { running, ...rest } = value!;
    const live = running?.find((a) => Date.now() - a.at <= ACTIVE_MS);
    return { ...rest, ...(live ? { activeAgent: live.actor } : {}) };
  }
  private async readRecording(
    dir: string,
    base: string,
    worktree: string | undefined,
  ): Promise<Cached> {
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
          await readProjectFile(dir, "elements.json"),
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
      const authored = history.filter((h) => h.author);
      return {
        id,
        path: relative,
        title: bundle.project.title,
        agentChanges: authored.length,
        lastAgentChangeAt: authored
          .map((h) => h.createdAt)
          .filter((t) => typeof t === "string" && !Number.isNaN(Date.parse(t)))
          .sort()
          .at(-1),
        running: activity
          .filter((a) => a.status === "running")
          .map((a) => ({
            actor: a.actor,
            at: Date.parse(a.updatedAt ?? a.startedAt),
          })),
        tourSha256: format?.source?.tourSha256,
        modifiedAt: new Date(Math.max(...timestamps)).toISOString(),
        revision: bundle.revision,
        durationMs: totalDuration(bundle.edits),
        scenes: bundle.edits.clips.length,
        ...(bundle.edits.clips.every(isScene) ? { film: true } : {}),
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
    if (!this.recordings.has(id)) await this.refresh();
    const dir = this.recordings.get(id);
    if (!dir) throw new Error("Recording not found");
    const resolved = await realpath(dir);
    if (!this.rootOf(resolved))
      throw new Error("Recording is outside the workspace");
    return resolved;
  }
}


/** Breadth-first walk of a plain folder with a sequential entry budget, so
 * the same folder gives the same result on every scan. Finds tours, and the
 * folders that hold recordings (`.demohunter` folders and recordings saved
 * elsewhere), which every scan then reads. */
async function walkPlain(
  base: string,
  others: Set<string>,
  label: (dir: string) => string,
): Promise<PlainWalk> {
  const tours: string[] = [],
    folders: string[] = [],
    warnings: string[] = [],
    dirs: [string, number][] = [];
  const queue = [{ dir: base, depth: 0 }];
  let visited = 0,
    limited = false;
  for (let i = 0; i < queue.length; i++) {
    if (visited > WALK_BUDGET) {
      limited = true;
      break;
    }
    const { dir, depth } = queue[i]!;
    let entries: Dirent[];
    try {
      // The mtime before the read: a change during the read shows as a
      // newer mtime on the next scan, never as a missed entry.
      dirs.push([dir, (await stat(dir)).mtimeMs]);
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        warnings.push(`Cannot read ${label(dir)}`);
      continue;
    }
    visited += entries.length;
    if (isRecording(entries)) {
      folders.push(path.relative(base, dir) || ".");
      continue;
    }
    for (const e of entries.sort(byName)) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === ".demohunter") folders.push(path.relative(base, full));
        else if (!SKIP.has(e.name) && !others.has(full) && depth < MAX_DEPTH)
          queue.push({ dir: full, depth: depth + 1 });
      } else if (e.isFile() && e.name.endsWith(".tour.ts"))
        tours.push(path.relative(base, full));
    }
  }
  return { tours, folders, limited, warnings, dirs };
}
/** No folder in the list was added, removed or renamed into since. */
async function unchanged(dirs: [string, number][]) {
  const now = await Promise.all(
    dirs.map(([dir]) => stat(dir).then((s) => s.mtimeMs, () => -1)),
  );
  return now.every((m, i) => m === dirs[i]![1]);
}

/** Recording folders under the demo folders of a worktree: breadth-first,
 * in name order, with a sequential budget (stable results). */
async function findRecordings(
  base: string,
  folders: string[],
  others: Set<string>,
  unreadable: (dir: string) => void,
): Promise<{ dirs: string[]; limited: boolean }> {
  const dirs: string[] = [],
    seen = new Set<string>();
  const queue = folders.map((f) => ({ dir: path.join(base, f), depth: 0 }));
  let visited = 0,
    limited = false;
  for (let i = 0; i < queue.length; i++) {
    if (visited > WALK_BUDGET) {
      limited = true;
      break;
    }
    const { dir, depth } = queue[i]!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") unreadable(dir);
      continue;
    }
    visited += entries.length;
    if (isRecording(entries)) {
      dirs.push(dir);
      continue;
    }
    if (depth >= MAX_DEPTH) continue;
    for (const e of entries.sort(byName)) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !e.isSymbolicLink() && !SKIP.has(e.name) && !others.has(full))
        queue.push({ dir: full, depth: depth + 1 });
    }
  }
  return { dirs, limited };
}
const byName = (a: Dirent, b: Dirent) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
