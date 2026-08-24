import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createGitRunner, type RunGit } from "../git/run-git.js";

export type TempRepo = {
  root: string;
  runGit: RunGit;
  /** Writes a file (creating parents) and stages it. */
  write: (relativePath: string, contents: string) => Promise<void>;
  remove: (relativePath: string) => Promise<void>;
  commit: (message: string) => Promise<string>;
  dispose: () => Promise<void>;
};

/**
 * Creates a throwaway repository so the Git-facing code can be exercised
 * against real `git` output rather than against a hand-written fake.
 */
export async function createTempRepo(prefix = "demohunter-review-repo-"): Promise<TempRepo> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const runGit = createGitRunner(root);

  await runGit(["init", "--quiet", "--initial-branch=main", "."]);
  await runGit(["config", "user.email", "review@example.com"]);
  await runGit(["config", "user.name", "Review Fixture"]);
  await runGit(["config", "commit.gpgsign", "false"]);

  const write = async (relativePath: string, contents: string): Promise<void> => {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
    await runGit(["add", "--", relativePath]);
  };

  return {
    root,
    runGit,
    write,
    remove: async (relativePath) => {
      await runGit(["rm", "--quiet", "--", relativePath]);
    },
    commit: async (message) => {
      await runGit(["commit", "--quiet", "--allow-empty", "-m", message]);
      return (await runGit(["rev-parse", "HEAD"])).trim();
    },
    dispose: async () => {
      await rm(root, { force: true, recursive: true });
    },
  };
}
