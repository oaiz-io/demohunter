import { describe, expect, test } from "bun:test";

import type { ReviewDefinition } from "../authoring/review-types.js";
import type { ChangedFile } from "../git/git-types.js";
import { assertCoverageComplete, computeCoverage, ReviewCoverageError } from "./compute-coverage.js";

describe("computeCoverage", () => {
  test("accounts for every changed file across chapters and groups", () => {
    const coverage = computeCoverage({
      review: makeReview({
        chapters: [chapter("core", "Core", ["src/app.ts"])],
        groups: [group("tests", "Tests", ["**/*.test.ts"]), group("docs", "Docs", ["**/*.md"])],
      }),
      changedFiles: changed(["src/app.ts", "src/app.test.ts", "README.md"]),
    });

    expect(coverage.complete).toBe(true);
    expect(coverage.accountedCount).toBe(3);
    expect(coverage.totalCount).toBe(3);
    expect(coverage.unaccounted).toEqual([]);
    expect(coverage.assignments.map((assignment) => [assignment.path, assignment.ownerId])).toEqual([
      ["README.md", "docs"],
      ["src/app.test.ts", "tests"],
      ["src/app.ts", "core"],
    ]);
  });

  test("lets a chapter win over a group that also matches the path", () => {
    const coverage = computeCoverage({
      review: makeReview({
        chapters: [chapter("core", "Core", ["src/app.test.ts"])],
        groups: [group("tests", "Tests", ["**/*.test.ts"])],
      }),
      changedFiles: changed(["src/app.test.ts"]),
    });

    expect(coverage.assignments[0]).toMatchObject({ kind: "chapter", ownerId: "core" });
    // The group still lists the path so the viewer can show the overlap.
    expect(coverage.groups[0]?.paths).toEqual(["src/app.test.ts"]);
  });

  test("reports unaccounted paths", () => {
    const coverage = computeCoverage({
      review: makeReview({ chapters: [chapter("core", "Core", ["src/app.ts"])] }),
      changedFiles: changed(["src/app.ts", "src/forgotten.ts"]),
    });

    expect(coverage.complete).toBe(false);
    expect(coverage.unaccounted).toEqual(["src/forgotten.ts"]);
    expect(coverage.accountedCount).toBe(1);
  });

  test("reports authored paths that the pull request never touched", () => {
    const coverage = computeCoverage({
      review: makeReview({ chapters: [chapter("core", "Core", ["src/app.ts", "src/ghost.ts"])] }),
      changedFiles: changed(["src/app.ts"]),
    });

    expect(coverage.complete).toBe(false);
    expect(coverage.unknownReferences).toEqual([
      { ownerId: "core", kind: "chapter", path: "src/ghost.ts" },
    ]);
  });

  test("normalizes ./ prefixes and backslashes before matching", () => {
    const coverage = computeCoverage({
      review: makeReview({ chapters: [chapter("core", "Core", ["./src\\app.ts"])] }),
      changedFiles: changed(["src/app.ts"]),
    });

    expect(coverage.complete).toBe(true);
  });

  test("flags a coverage group whose patterns matched nothing", () => {
    const coverage = computeCoverage({
      review: makeReview({
        chapters: [chapter("core", "Core", ["src/app.ts"])],
        groups: [group("stale", "Stale", ["legacy/**"])],
      }),
      changedFiles: changed(["src/app.ts"]),
    });

    expect(coverage.emptyGroups).toEqual(["stale"]);
    // An empty group is a warning, not a failure: coverage is still complete.
    expect(coverage.complete).toBe(true);
  });

  test("deduplicates a path listed twice inside one chapter", () => {
    const coverage = computeCoverage({
      review: makeReview({ chapters: [chapter("core", "Core", ["src/app.ts", "src/app.ts"])] }),
      changedFiles: changed(["src/app.ts"]),
    });

    expect(coverage.complete).toBe(true);
    expect(coverage.chapters[0]?.paths).toEqual(["src/app.ts"]);
    expect(coverage.accountedCount).toBe(1);
  });
});

describe("assertCoverageComplete", () => {
  test("passes through complete coverage", () => {
    const coverage = computeCoverage({
      review: makeReview({ chapters: [chapter("core", "Core", ["src/app.ts"])] }),
      changedFiles: changed(["src/app.ts"]),
    });

    expect(() => assertCoverageComplete(coverage)).not.toThrow();
  });

  test("names the missing files and suggests a grouping", () => {
    const coverage = computeCoverage({
      review: makeReview({ chapters: [chapter("core", "Core", ["src/app.ts"])] }),
      changedFiles: changed(["src/app.ts", "src/forgotten.ts"]),
    });

    let thrown: unknown;
    try {
      assertCoverageComplete(coverage);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ReviewCoverageError);
    expect((thrown as Error).message).toContain("1/2 changed files accounted for");
    expect((thrown as Error).message).toContain("src/forgotten.ts");
    expect((thrown as Error).message).toContain("coverage group");
    expect((thrown as ReviewCoverageError).coverage.unaccounted).toEqual(["src/forgotten.ts"]);
  });

  test("names authored paths that are not in the range", () => {
    const coverage = computeCoverage({
      review: makeReview({ chapters: [chapter("core", "Core", ["src/ghost.ts"])] }),
      changedFiles: changed(["src/app.ts"]),
    });

    expect(() => assertCoverageComplete(coverage)).toThrow("not part of merge-base..HEAD");
  });
});

function makeReview(input: {
  chapters: ReviewDefinition["chapters"];
  groups?: NonNullable<ReviewDefinition["coverage"]>["groups"];
}): ReviewDefinition {
  return {
    id: "test-review",
    title: "Test review",
    problem: { summary: "Test" },
    chapters: input.chapters,
    ...(input.groups === undefined ? {} : { coverage: { groups: input.groups } }),
  };
}

function chapter(id: string, title: string, files: string[]): ReviewDefinition["chapters"][number] {
  return { id, title, intent: "intent", narration: "narration", files, evidence: [], reviewerChecks: [] };
}

function group(id: string, title: string, patterns: string[]) {
  return { id, title, rationale: "rationale", patterns };
}

function changed(paths: string[]): ChangedFile[] {
  return paths.map((filePath) => ({
    path: filePath,
    status: "modified" as const,
    insertions: 1,
    deletions: 0,
    oldMode: "100644",
    newMode: "100644",
    oldBlobSha: "1".repeat(40),
    newBlobSha: "2".repeat(40),
    isBinary: false,
    isSubmodule: false,
    isModeOnly: false,
    isGenerated: false,
  }));
}
