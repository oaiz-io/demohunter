import { describe, expect, test } from "bun:test";

import {
  describeWorktreeStatus,
  parsePorcelainStatus,
  readWorktreeStatus,
} from "./worktree-status.js";
import type { RunGit } from "./run-git.js";

describe("parsePorcelainStatus", () => {
  test("reads the two-letter code and path from each record", () => {
    const output = [" M src/app.ts", "?? notes.md", "A  src/new.ts", ""].join("\0");

    // Sorted by path so two runs of the same dirty tree describe it identically.
    expect(parsePorcelainStatus(output)).toEqual([
      { code: "??", path: "notes.md" },
      { code: " M", path: "src/app.ts" },
      { code: "A ", path: "src/new.ts" },
    ]);
  });

  test("consumes the extra field a rename record carries", () => {
    const output = ["R  src/new.ts", "src/old.ts", " M src/other.ts", ""].join("\0");

    expect(parsePorcelainStatus(output)).toEqual([
      { code: "R ", path: "src/new.ts" },
      { code: " M", path: "src/other.ts" },
    ]);
  });
});

describe("readWorktreeStatus", () => {
  test("reports a clean tree and excludes ignored files from the query", async () => {
    let captured: string[] = [];
    const runGit: RunGit = async (args) => {
      captured = [...args];
      return "";
    };

    const status = await readWorktreeStatus({ runGit });

    expect(status).toEqual({ clean: true, entries: [], untracked: [], unmerged: [] });
    // A generated review artifact the repo ignores must not make the tree dirty.
    expect(captured).toContain("--ignored=no");
    expect(captured).toContain("--porcelain=v1");
    expect(captured).toContain("-z");
  });

  test("separates untracked and unmerged paths", async () => {
    const runGit: RunGit = async () =>
      [" M src/app.ts", "?? notes.md", "UU src/conflict.ts", ""].join("\0");

    const status = await readWorktreeStatus({ runGit });

    expect(status.clean).toBe(false);
    expect(status.untracked).toEqual(["notes.md"]);
    expect(status.unmerged).toEqual(["src/conflict.ts"]);
  });
});

describe("describeWorktreeStatus", () => {
  test("summarizes a clean tree", () => {
    expect(
      describeWorktreeStatus({ clean: true, entries: [], untracked: [], unmerged: [] }),
    ).toBe("clean");
  });

  test("truncates a long list so the error message stays readable", () => {
    const entries = Array.from({ length: 13 }, (_, index) => ({
      code: " M",
      path: `src/file-${index}.ts`,
    }));

    const summary = describeWorktreeStatus({ clean: false, entries, untracked: [], unmerged: [] });

    expect(summary).toContain("13 pending change(s)");
    expect(summary).toContain("+3 more");
  });
});
