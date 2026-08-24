import { describe, expect, test } from "bun:test";

import type { RunGit } from "../git/run-git.js";
import {
  FIXTURE_BASE_SHA,
  FIXTURE_HEAD_SHA,
  FIXTURE_MERGE_BASE_SHA,
  makeReviewLock,
} from "../test-support/lock-fixture.ts";
import { detectStaleness } from "./staleness.js";

const MOVED_HEAD = "9".repeat(40);
const MOVED_BASE = "8".repeat(40);
const MOVED_MERGE_BASE = "7".repeat(40);

describe("detectStaleness", () => {
  test("reports a matching range as fresh", async () => {
    const report = await detectStaleness({ lock: makeReviewLock(), runGit: createRunGit({}) });

    expect(report.stale).toBe(false);
    expect(report.reasons).toEqual([]);
    expect(report.current).toEqual({
      baseSha: FIXTURE_BASE_SHA,
      headSha: FIXTURE_HEAD_SHA,
      mergeBaseSha: FIXTURE_MERGE_BASE_SHA,
      mergeBaseCandidates: [FIXTURE_MERGE_BASE_SHA],
    });
  });

  test("detects a moved HEAD", async () => {
    const report = await detectStaleness({
      lock: makeReviewLock(),
      runGit: createRunGit({ headSha: MOVED_HEAD }),
    });

    expect(report.stale).toBe(true);
    expect(report.reasons.map((reason) => reason.code)).toContain("head-moved");
    expect(report.reasons[0]?.expected).toBe(FIXTURE_HEAD_SHA);
    expect(report.reasons[0]?.actual).toBe(MOVED_HEAD);
  });

  test("detects a moved base and a moved merge base independently", async () => {
    const report = await detectStaleness({
      lock: makeReviewLock(),
      runGit: createRunGit({ baseSha: MOVED_BASE, mergeBases: [MOVED_MERGE_BASE] }),
    });

    const codes = report.reasons.map((reason) => reason.code);
    expect(codes).toContain("base-moved");
    expect(codes).toContain("merge-base-moved");
    expect(codes).not.toContain("head-moved");
  });

  test("detects a newly ambiguous merge base even when the chosen sha is unchanged", async () => {
    const report = await detectStaleness({
      lock: makeReviewLock(),
      runGit: createRunGit({ mergeBases: [FIXTURE_MERGE_BASE_SHA, MOVED_MERGE_BASE] }),
    });

    expect(report.stale).toBe(true);
    expect(report.reasons.map((reason) => reason.code)).toContain("merge-base-ambiguity-changed");
  });

  test("treats an unresolvable ref as stale rather than as an internal error", async () => {
    const runGit: RunGit = async (args) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/repo\n";
      throw new Error("fatal: bad revision");
    };

    const report = await detectStaleness({ lock: makeReviewLock(), runGit });

    expect(report.stale).toBe(true);
    expect(report.reasons[0]?.code).toBe("ref-unresolvable");
    expect(report.current).toBeUndefined();
  });
});

function createRunGit(options: {
  baseSha?: string;
  headSha?: string;
  mergeBases?: string[];
}): RunGit {
  return async (args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return "/repo\n";
    }

    if (args[0] === "rev-parse") {
      const ref = args[args.length - 1]!;
      return ref.startsWith("main")
        ? `${options.baseSha ?? FIXTURE_BASE_SHA}\n`
        : `${options.headSha ?? FIXTURE_HEAD_SHA}\n`;
    }

    if (args[0] === "merge-base") {
      return `${(options.mergeBases ?? [FIXTURE_MERGE_BASE_SHA]).join("\n")}\n`;
    }

    if (args[0] === "rev-list") {
      return `${options.headSha ?? FIXTURE_HEAD_SHA} ${FIXTURE_MERGE_BASE_SHA}\n`;
    }

    return "";
  };
}
