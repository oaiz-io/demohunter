import { execFile } from "node:child_process";
import path from "node:path";
import { realpath } from "node:fs/promises";

export type GitStatus = {
  /** Repository folder name, e.g. "demohunter". */
  repository?: string;
  /** Owner/name from the origin remote when it is a GitHub-style URL. */
  remote?: string;
  branch?: string;
  /** Changed or untracked files under the requested folder, repo-relative. */
  changed: string[];
  /** True when the folder is inside the repo but ignored (e.g. local captures). */
  ignored?: boolean;
};

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      "git",
      // Read-only polling must never take index.lock from people (or agents)
      // committing in the same worktree.
      ["--no-optional-locks", ...args],
      { cwd, timeout: 3000, maxBuffer: 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
}

const cache = new Map<string, { at: number; value: Promise<GitStatus> }>();

/** Read-only git facts for a folder. Missing git or a non-repo folder is not an
 * error: Studio works the same, it just has nothing to show. */
export function gitStatus(dir: string, maxAgeMs = 2500): Promise<GitStatus> {
  const hit = cache.get(dir);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.value;
  const value = (async (): Promise<GitStatus> => {
    try {
      const root = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
      const [branch, status, remote, ignored] = await Promise.all([
        git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).then((s) => s.trim()),
        git(dir, ["status", "--porcelain", "-z", "--", "."]),
        git(dir, ["remote", "get-url", "origin"]).catch(() => ""),
        git(root, ["check-ignore", "-q", path.relative(root, dir) || "."]).then(
          () => true,
          () => false,
        ),
      ]);
      const changed = status
        .split("\0")
        .filter((entry) => entry.length > 3)
        .map((entry) => entry.slice(3))
        .filter((file) => !/(^|\/)\.(studio|history)\//.test(file))
        .filter(
          (file) =>
            !/(^|\/)(selection|preview-state|preview-command)\.json$/.test(
              file,
            ) && !file.endsWith(".lock"),
        );
      const match = remoteName(remote);
      return {
        // Worktrees often live in arbitrary folders; the remote name is truer.
        repository: match?.[1]?.split("/")[1] ?? path.basename(root),
        remote: match?.[1],
        branch: branch === "HEAD" ? undefined : branch,
        changed,
        ignored,
      };
    } catch {
      return { changed: [] };
    }
  })();
  cache.set(dir, { at: Date.now(), value });
  return value;
}

/** "owner/name" from a GitHub-style origin URL (https or ssh). */
function remoteName(remote: string) {
  return /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(remote.trim());
}

export type Worktree = {
  path: string;
  head?: string;
  branch?: string;
  detached?: boolean;
  locked?: boolean;
  /** The folder no longer exists (git reports it as prunable). */
  missing?: boolean;
  /** The repository's main checkout (absent when the repository is bare). */
  main?: boolean;
};

/** Worktrees of the repository whose top level is `dir`, main first. Only a
 * repository root qualifies: subfolders and plain folders return undefined,
 * so Studio never goes looking for repositories on its own. */
export async function listWorktrees(
  dir: string,
): Promise<Worktree[] | undefined> {
  try {
    const top = await realpath(
      (await git(dir, ["rev-parse", "--show-toplevel"])).trim(),
    );
    if (top !== (await realpath(dir))) return undefined;
    const out = await git(dir, ["worktree", "list", "--porcelain"]);
    const list: Worktree[] = [];
    let current: (Worktree & { bare?: boolean }) | undefined,
      first = true;
    for (const line of [...out.split("\n"), ""]) {
      if (!line) {
        // git lists the main worktree first; a bare one is not a checkout.
        if (current && !current.bare) list.push({ ...current, main: first });
        if (current) first = false;
        current = undefined;
        continue;
      }
      const [key, ...rest] = line.split(" ");
      const value = rest.join(" ");
      if (key === "worktree") current = { path: value };
      else if (!current) continue;
      else if (key === "HEAD") current.head = value.slice(0, 7);
      else if (key === "branch")
        current.branch = value.replace(/^refs\/heads\//, "");
      else if (key === "detached") current.detached = true;
      else if (key === "bare") current.bare = true;
      else if (key === "locked") current.locked = true;
      else if (key === "prunable") current.missing = true;
    }
    for (const w of list) {
      const real = await realpath(w.path).catch(() => undefined);
      if (real) w.path = real;
      else w.missing = true;
    }
    return list.length ? list : undefined;
  } catch {
    return undefined;
  }
}

/** Uncommitted file count and distance from upstream for a worktree. */
export async function worktreeState(
  dir: string,
): Promise<{ changed: number; ahead?: number; behind?: number }> {
  try {
    const out = await git(dir, [
      "status",
      "--porcelain=v2",
      "--branch",
      "--untracked-files=normal",
    ]);
    let changed = 0,
      ahead: number | undefined,
      behind: number | undefined;
    for (const line of out.split("\n")) {
      const ab = /^# branch\.ab \+(\d+) -(\d+)/.exec(line);
      if (ab) {
        ahead = Number(ab[1]);
        behind = Number(ab[2]);
      } else if (line && !line.startsWith("#")) changed++;
    }
    return { changed, ahead, behind };
  } catch {
    return { changed: 0 };
  }
}

// Background git work: a library of many worktrees must never wait on
// `git status` (seconds in large repositories), and never run dozens at once.
function limiter(max: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (running >= max) await new Promise<void>((r) => waiting.push(r));
    running++;
    try {
      return await work();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}
/** `git status` is slow in large repositories; listings are cheap. */
const statusLimit = limiter(2),
  listLimit = limiter(8);
type State = Awaited<ReturnType<typeof worktreeState>>;
const states = new Map<
  string,
  { at: number; value?: State; refreshing?: Promise<void> }
>();
/** Last known worktree state right away (undefined at first); refreshes in
 * the background when older than `maxAgeMs`. */
export function cachedWorktreeState(
  dir: string,
  maxAgeMs = 15_000,
): State | undefined {
  let entry = states.get(dir);
  if (!entry) states.set(dir, (entry = { at: 0 }));
  const e = entry;
  if (!e.refreshing && Date.now() - e.at > maxAgeMs)
    e.refreshing = statusLimit(() => worktreeState(dir))
      .then((value) => {
        e.value = value;
        e.at = Date.now();
      })
      .finally(() => (e.refreshing = undefined));
  return e.value;
}
/** Wait for pending background state (tests and first paint). */
export async function settledWorktreeStates(): Promise<void> {
  await Promise.all([...states.values()].map((e) => e.refreshing));
}

/** Repository name and branch without `git status` (the library header). */
const summaries = new Map<string, { at: number; value: Promise<GitStatus> }>();
export function gitSummary(dir: string, maxAgeMs = 10_000): Promise<GitStatus> {
  const hit = summaries.get(dir);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.value;
  const value = (async (): Promise<GitStatus> => {
    try {
      const [root, branch, remote] = await Promise.all([
        git(dir, ["rev-parse", "--show-toplevel"]).then((s) => s.trim()),
        git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).then((s) => s.trim()),
        git(dir, ["remote", "get-url", "origin"]).catch(() => ""),
      ]);
      const match = remoteName(remote);
      return {
        repository: match?.[1]?.split("/")[1] ?? path.basename(root),
        remote: match?.[1],
        branch: branch === "HEAD" ? undefined : branch,
        changed: [],
      };
    } catch {
      return { changed: [] };
    }
  })();
  summaries.set(dir, { at: Date.now(), value });
  return value;
}

/** Where demos can be in a worktree, from git instead of walking the tree:
 * tour files (tracked or new) and every `.demohunter` folder (captures live
 * there and are usually git-ignored). Paths are relative to `dir`. */
export async function listDemoSources(
  dir: string,
): Promise<{ tours: string[]; folders: string[] } | undefined> {
  const folders = new Set([".demohunter"]),
    tours = new Set<string>();
  const folder = (entry: string) => {
    const i = entry.lastIndexOf(".demohunter/");
    if (i >= 0 && (i === 0 || entry[i - 1] === "/"))
      folders.add(entry.slice(0, i + ".demohunter".length));
    else if (/(^|\/)\.demohunter\/?$/.test(entry))
      folders.add(entry.replace(/\/$/, ""));
  };
  try {
    const [listed, ignored] = await Promise.all([
      git(dir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.tour.ts", "*/.demohunter/*", ".demohunter/*"]),
      git(dir, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]).catch(() => ""),
    ]);
    for (const entry of listed.split("\0").filter(Boolean))
      if (entry.endsWith(".tour.ts")) tours.add(entry);
      else folder(entry);
    for (const entry of ignored.split("\0").filter(Boolean)) folder(entry);
    return { tours: [...tours].sort(), folders: [...folders].sort() };
  } catch {
    return undefined;
  }
}

/** Stale-while-revalidate: the first call waits; later calls get the last
 * value at once and refresh it in the background when older than `maxAgeMs`. */
const lists = new Map<string, { at: number; value: Promise<unknown>; refreshing?: boolean }>();
export function cachedList<T>(
  key: string,
  load: () => Promise<T>,
  maxAgeMs = 10_000,
): Promise<T> {
  const hit = lists.get(key);
  if (!hit) {
    const entry = { at: Date.now(), value: listLimit(load) as Promise<unknown> };
    lists.set(key, entry);
    entry.value.catch(() => lists.delete(key));
    return entry.value as Promise<T>;
  }
  if (!hit.refreshing && Date.now() - hit.at > maxAgeMs) {
    hit.refreshing = true;
    void listLimit(load)
      .then((value) => {
        hit.value = Promise.resolve(value);
        hit.at = Date.now();
      })
      .catch(() => {})
      .finally(() => (hit.refreshing = false));
  }
  return hit.value as Promise<T>;
}
