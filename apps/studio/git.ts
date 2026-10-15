import { execFile } from "node:child_process";
import path from "node:path";

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
      args,
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
      const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(remote.trim());
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
