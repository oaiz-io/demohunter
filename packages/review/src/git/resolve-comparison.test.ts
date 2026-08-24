import { describe, expect, test } from "bun:test";

import { resolveComparison } from "./resolve-comparison.js";
import type { RunGit } from "./run-git.js";

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const MERGE_BASE = "3".repeat(40);
const OTHER_MERGE_BASE = "0".repeat(40);
const PARENT = "4".repeat(40);
const SECOND_PARENT = "5".repeat(40);

describe("resolveComparison", () => {
  test("resolves the PR-shaped range and records exact shas", async () => {
    const comparison = await resolveComparison({
      runGit: createRunGit({}),
      baseRef: "main",
    });

    expect(comparison).toEqual({
      repoRoot: "/repo",
      baseRef: "main",
      baseSha: BASE,
      headRef: "HEAD",
      headSha: HEAD,
      mergeBaseSha: MERGE_BASE,
      mergeBaseCandidates: [MERGE_BASE],
      headIsMergeCommit: false,
      headParents: [PARENT],
    });
  });

  test("keeps every merge-base candidate and picks the lowest sorted one", async () => {
    const comparison = await resolveComparison({
      runGit: createRunGit({ mergeBases: [MERGE_BASE, OTHER_MERGE_BASE] }),
      baseRef: "main",
    });

    // Sorted, so the chosen base never depends on Git's traversal order.
    expect(comparison.mergeBaseCandidates).toEqual([OTHER_MERGE_BASE, MERGE_BASE]);
    expect(comparison.mergeBaseSha).toBe(OTHER_MERGE_BASE);
  });

  test("flags a merge commit at HEAD", async () => {
    const comparison = await resolveComparison({
      runGit: createRunGit({ headParents: [PARENT, SECOND_PARENT] }),
      baseRef: "main",
    });

    expect(comparison.headIsMergeCommit).toBe(true);
    expect(comparison.headParents).toEqual([PARENT, SECOND_PARENT]);
  });

  test("uses an explicit head ref when one is given", async () => {
    const seen: string[][] = [];
    const runGit = createRunGit({ onCall: (args) => seen.push([...args]) });
    const comparison = await resolveComparison({ runGit, baseRef: "main", headRef: "feature" });

    expect(comparison.headRef).toBe("feature");
    expect(seen).toContainEqual(["rev-parse", "--verify", "--quiet", "feature^{commit}"]);
  });

  test("refuses to run outside a work tree", async () => {
    const runGit: RunGit = async () => "";

    await expect(resolveComparison({ runGit, baseRef: "main" })).rejects.toThrow(
      "must run inside a Git work tree",
    );
  });

  test("explains an unresolvable ref instead of guessing", async () => {
    const runGit = createRunGit({ unresolvable: ["missing^{commit}"] });

    await expect(resolveComparison({ runGit, baseRef: "missing" })).rejects.toThrow(
      'Could not resolve "missing" to a commit',
    );
  });

  test("explains unrelated histories instead of returning an empty range", async () => {
    const runGit = createRunGit({ mergeBases: [] });

    await expect(resolveComparison({ runGit, baseRef: "main" })).rejects.toThrow(
      "No merge base between main",
    );
  });
});

function createRunGit(options: {
  mergeBases?: string[];
  headParents?: string[];
  unresolvable?: string[];
  onCall?: (args: readonly string[]) => void;
}): RunGit {
  const mergeBases = options.mergeBases ?? [MERGE_BASE];
  const headParents = options.headParents ?? [PARENT];

  return async (args) => {
    options.onCall?.(args);

    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return "/repo\n";
    }

    if (args[0] === "rev-parse") {
      const ref = args[args.length - 1]!;

      if ((options.unresolvable ?? []).includes(ref)) {
        throw new Error("unknown revision");
      }

      return `${ref.startsWith("main") ? BASE : HEAD}\n`;
    }

    if (args[0] === "merge-base") {
      if (mergeBases.length === 0) {
        throw new Error("no merge base");
      }

      return `${mergeBases.join("\n")}\n`;
    }

    if (args[0] === "rev-list") {
      return `${[HEAD, ...headParents].join(" ")}\n`;
    }

    return "";
  };
}
