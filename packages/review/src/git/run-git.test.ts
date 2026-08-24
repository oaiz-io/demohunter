import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createGitRunner, GitCommandError, splitNulFields } from "./run-git.js";

describe("splitNulFields", () => {
  test("drops only the trailing empty field", () => {
    expect(splitNulFields("a\0b\0")).toEqual(["a", "b"]);
    expect(splitNulFields("a\0\0b\0")).toEqual(["a", "", "b"]);
    expect(splitNulFields("")).toEqual([]);
  });
});

describe("GitCommandError", () => {
  test("names the failing argv and the exit code", () => {
    const error = new GitCommandError({
      args: ["rev-parse", "--verify", "nope"],
      exitCode: 128,
      stderr: "fatal: bad revision\n",
    });

    expect(error.name).toBe("GitCommandError");
    expect(error.message).toContain("git rev-parse --verify nope");
    expect(error.message).toContain("exit code 128");
    expect(error.message).toContain("fatal: bad revision");
  });
});

describe("createGitRunner", () => {
  test("runs against a real repository and normalizes the environment", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "demohunter-review-run-git-"));

    try {
      const runGit = createGitRunner(repoRoot);
      await runGit(["init", "--quiet", "--initial-branch=main", "."]);
      await runGit(["config", "user.email", "test@example.com"]);
      await runGit(["config", "user.name", "Test"]);
      await writeFile(path.join(repoRoot, "file.txt"), "content\n", "utf8");
      await runGit(["add", "file.txt"]);
      await runGit(["commit", "--quiet", "-m", "initial"]);

      const headSha = (await runGit(["rev-parse", "HEAD"])).trim();
      expect(headSha).toMatch(/^[0-9a-f]{40}$/);

      // GIT_PAGER=cat keeps output machine-readable regardless of local config.
      const log = await runGit(["log", "--format=%s"]);
      expect(log.trim()).toBe("initial");
    } finally {
      await rm(repoRoot, { force: true, recursive: true });
    }
  });

  test("rejects with a GitCommandError carrying stderr", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "demohunter-review-run-git-fail-"));

    try {
      const runGit = createGitRunner(repoRoot);
      await runGit(["init", "--quiet", "--initial-branch=main", "."]);

      const failure = await runGit(["rev-parse", "--verify", "does-not-exist"]).catch(
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(GitCommandError);
      expect((failure as GitCommandError).args).toEqual(["rev-parse", "--verify", "does-not-exist"]);
      expect((failure as GitCommandError).exitCode).not.toBeNull();
    } finally {
      await rm(repoRoot, { force: true, recursive: true });
    }
  });
});
