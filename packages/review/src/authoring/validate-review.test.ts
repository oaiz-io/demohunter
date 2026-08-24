import { describe, expect, test } from "bun:test";

import { changeSet, componentDiagram, defineReview, diffEvidence, sequenceDiagram } from "./define-review.js";
import type { ReviewDefinition } from "./review-types.js";
import { ReviewDefinitionError, validateReviewDefinition } from "./validate-review.js";

describe("validateReviewDefinition", () => {
  test("accepts a minimal valid review", () => {
    expect(() => validateReviewDefinition(minimalReview())).not.toThrow();
  });

  test("collects every problem in one error instead of failing on the first", () => {
    const issues = collectIssues({
      id: "Not A Slug",
      title: "",
      problem: { summary: "" },
      chapters: [],
    } as unknown as ReviewDefinition);

    expect(issues).toContain('id must be a lowercase slug such as "pr-22-review"');
    expect(issues).toContain("title must be a non-empty string");
    expect(issues).toContain("problem.summary must be a non-empty string");
    expect(issues).toContain("chapters must contain at least one change set");
  });

  test("rejects duplicate chapter ids and duplicate evidence ids", () => {
    const issues = collectIssues(
      withChapters([
        chapterWith("core", [diffEvidence({ id: "shared", path: "src/a.ts" })]),
        chapterWith("core", [diffEvidence({ id: "shared", path: "src/b.ts" })]),
      ]),
    );

    expect(issues.some((issue) => issue.includes("duplicates an earlier chapter id"))).toBe(true);
    expect(issues.some((issue) => issue.includes("duplicates an earlier evidence id"))).toBe(true);
  });

  test("rejects a review order that points at a chapter that does not exist", () => {
    const review = withChapters([chapterWith("core", [])]);
    review.reviewOrder = [{ chapterId: "missing", why: "because" }];

    expect(collectIssues(review).some((issue) => issue.includes("does not match any chapter id"))).toBe(
      true,
    );
  });

  test("rejects an inverted or non-integer evidence range", () => {
    const issues = collectIssues(
      withChapters([
        chapterWith("core", [
          diffEvidence({ id: "backwards", path: "src/a.ts", range: { startLine: 20, endLine: 5 } }),
          diffEvidence({ id: "fractional", path: "src/b.ts", range: { startLine: 1.5, endLine: 9 } }),
        ]),
      ]),
    );

    expect(issues.some((issue) => issue.includes("endLine must be an integer no smaller"))).toBe(true);
    expect(issues.some((issue) => issue.includes("startLine must be a positive integer"))).toBe(true);
  });

  test("requires a non-empty argv array for verification commands", () => {
    const review = withChapters([chapterWith("core", [])]);
    review.verification = [
      { id: "empty", label: "Empty", command: [] },
      { id: "blank", label: "Blank", command: ["bun", ""] },
      { id: "empty", label: "Duplicate id", command: ["bun", "test"] },
    ];

    const issues = collectIssues(review);
    expect(issues.some((issue) => issue.includes("must be a non-empty argv array"))).toBe(true);
    expect(issues.some((issue) => issue.includes("entries must all be non-empty strings"))).toBe(true);
    expect(issues.some((issue) => issue.includes("duplicates an earlier verification id"))).toBe(true);
  });

  test("rejects sequence messages that reference an undeclared participant", () => {
    const review = withChapters([chapterWith("core", [])]);
    review.architecture = [
      sequenceDiagram({
        id: "flow",
        title: "Flow",
        participants: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        messages: [{ from: "a", to: "ghost", label: "call" }],
      }),
    ];

    expect(collectIssues(review).some((issue) => issue.includes("is not a participant: ghost"))).toBe(
      true,
    );
  });

  test("rejects component edges that reference an undeclared node and negative coordinates", () => {
    const review = withChapters([chapterWith("core", [])]);
    review.architecture = [
      componentDiagram({
        id: "arch",
        title: "Arch",
        nodes: [{ id: "a", label: "A", column: -1, row: 0 }],
        edges: [{ from: "a", to: "ghost" }],
      }),
    ];

    const issues = collectIssues(review);
    expect(issues.some((issue) => issue.includes("is not a node id: ghost"))).toBe(true);
    expect(issues.some((issue) => issue.includes("column must be a non-negative integer"))).toBe(true);
  });

  test("rejects an unknown risk severity and compatibility impact", () => {
    const review = withChapters([chapterWith("core", [])]);
    review.risks = [{ id: "r", title: "Risk", severity: "critical" as never, detail: "detail" }];
    review.compatibility = [
      { id: "c", area: "API", impact: "maybe" as never, detail: "detail" },
    ];

    const issues = collectIssues(review);
    expect(issues.some((issue) => issue.includes("severity must be low, medium, or high"))).toBe(true);
    expect(
      issues.some((issue) => issue.includes("impact must be none, additive, behavioral, or breaking")),
    ).toBe(true);
  });
});

describe("defineReview", () => {
  test("validates at authoring time and returns the definition unchanged", () => {
    const review = minimalReview();

    expect(defineReview(review)).toBe(review);
  });

  test("throws before generation when the definition is malformed", () => {
    expect(() =>
      defineReview({ ...minimalReview(), chapters: [] }),
    ).toThrow(ReviewDefinitionError);
  });
});

function minimalReview(): ReviewDefinition {
  return withChapters([chapterWith("core", [])]);
}

function withChapters(chapters: ReviewDefinition["chapters"]): ReviewDefinition {
  return {
    id: "pr-22-review",
    title: "PR 22",
    problem: { summary: "Something needed fixing." },
    chapters,
  };
}

function chapterWith(id: string, evidence: ReviewDefinition["chapters"][number]["evidence"]) {
  return changeSet({
    id,
    title: "Core",
    intent: "Intent",
    narration: "Narration",
    files: ["src/a.ts"],
    evidence,
    reviewerChecks: [{ id: `${id}-check`, check: "Check something." }],
  });
}

function collectIssues(review: ReviewDefinition): string[] {
  try {
    validateReviewDefinition(review);
  } catch (error) {
    if (error instanceof ReviewDefinitionError) {
      return error.issues;
    }
    throw error;
  }

  return [];
}
