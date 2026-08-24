import type { ReviewDefinition } from "../authoring/review-types.js";
import { computeCoverage } from "../coverage/compute-coverage.js";
import type { ResolvedEvidence } from "../evidence/resolve-evidence.js";
import type { ChangedFile } from "../git/git-types.js";
import type { ReviewViewModel } from "../viewer/view-model.js";

export const VIEW_BASE_SHA = "1".repeat(40);
export const VIEW_HEAD_SHA = "2".repeat(40);
export const VIEW_MERGE_BASE_SHA = "3".repeat(40);

/** A small but complete view model, so viewer tests exercise every section. */
export function makeViewModel(overrides: Partial<ReviewViewModel> = {}): ReviewViewModel {
  const review = overrides.review ?? makeReviewDefinition();
  const files = overrides.files ?? makeChangedFiles(["src/app.ts", "src/app.test.ts"]);

  return {
    generatedAt: "2026-08-24T00:00:00.000Z",
    generatorVersion: "0.1.5",
    review,
    git: {
      repoRoot: "/repo",
      baseRef: "main",
      baseSha: VIEW_BASE_SHA,
      headRef: "HEAD",
      headSha: VIEW_HEAD_SHA,
      mergeBaseSha: VIEW_MERGE_BASE_SHA,
      mergeBaseCandidates: [VIEW_MERGE_BASE_SHA],
      headIsMergeCommit: false,
      headParents: [VIEW_MERGE_BASE_SHA],
      worktree: { clean: true, entries: [], untracked: [], unmerged: [] },
    },
    files,
    coverage: computeCoverage({ review, changedFiles: files }),
    evidenceByChapter: { core: [makeDiffEvidence()] },
    diagrams: [],
    verification: {
      status: "passed",
      ran: true,
      results: [
        {
          id: "tests",
          label: "Unit tests",
          command: ["bun", "test"],
          cwd: ".",
          rationale: "Covers the changed behaviour.",
          status: "passed",
          expectedExitCode: 0,
          exitCode: 0,
          durationMs: 4200,
          timedOut: false,
          outputTail: "3 pass\n0 fail\n",
          outputTruncated: false,
        },
      ],
    },
    video: null,
    ...overrides,
  };
}

export function makeReviewDefinition(overrides: Partial<ReviewDefinition> = {}): ReviewDefinition {
  return {
    id: "pr-22-review",
    title: "PR 22 review",
    subtitle: "A small change",
    pullRequest: { number: 22, author: "emilwareus" },
    problem: {
      summary: "Something needed fixing.",
      detail: "The detail behind it.",
      inScope: ["The fix"],
      outOfScope: ["Everything else"],
    },
    goals: ["Fix it"],
    nonGoals: ["Rewrite it"],
    decisions: [{ id: "d1", title: "Keep it local", rationale: "No backend needed.", alternatives: ["A service"] }],
    architecture: [
      {
        kind: "component",
        id: "arch",
        title: "Architecture",
        caption: "How it fits together.",
        nodes: [
          { id: "cli", label: "CLI", kind: "module", detail: "argv only", column: 0, row: 0 },
          { id: "git", label: "Git", kind: "external", column: 1, row: 0, changed: true },
        ],
        edges: [{ from: "cli", to: "git", label: "merge-base..HEAD", changed: true }],
      },
      {
        kind: "sequence",
        id: "flow",
        title: "Flow",
        participants: [
          { id: "cli", label: "CLI" },
          { id: "git", label: "Git" },
        ],
        messages: [
          { from: "cli", to: "git", label: "resolve" },
          { from: "git", to: "cli", label: "sha", kind: "return" },
          { from: "cli", to: "cli", label: "assert coverage", kind: "note" },
        ],
      },
    ],
    reviewOrder: [{ chapterId: "core", why: "It is the whole change." }],
    chapters: [
      {
        id: "core",
        title: "Core change",
        intent: "Explains the core change.",
        detail: "More detail.",
        narration: "The core change is small.",
        files: ["src/app.ts"],
        evidence: [{ kind: "diff", id: "core-diff", path: "src/app.ts", note: "Look here." }],
        reviewerChecks: [{ id: "c1", check: "The bind address is loopback.", detail: "Not 0.0.0.0." }],
      },
    ],
    verification: [{ id: "tests", label: "Unit tests", command: ["bun", "test"] }],
    risks: [{ id: "r1", title: "Latency", severity: "medium", detail: "Adds a retry.", mitigation: "Bounded." }],
    compatibility: [
      { id: "cp1", area: "API", impact: "additive", detail: "New optional flag.", migration: "None needed." },
    ],
    security: [{ id: "s1", title: "Loopback only", detail: "Binds 127.0.0.1.", control: "serve-review.ts" }],
    reviewerQuestions: [{ id: "q1", question: "Is three attempts right?", context: "Bounded either way." }],
    coverage: { groups: [{ id: "tests", title: "Tests", rationale: "Reviewed with the behaviour.", patterns: ["**/*.test.ts"] }] },
    narration: { opening: "Welcome.", closing: "Check the bind address first." },
    ...overrides,
  };
}

export function makeChangedFiles(paths: string[]): ChangedFile[] {
  return paths.map((filePath) => ({
    path: filePath,
    status: "modified" as const,
    insertions: 4,
    deletions: 2,
    oldMode: "100644",
    newMode: "100644",
    oldBlobSha: "4".repeat(40),
    newBlobSha: "5".repeat(40),
    isBinary: false,
    isSubmodule: false,
    isModeOnly: false,
    isGenerated: false,
  }));
}

export function makeDiffEvidence(overrides: Partial<ResolvedEvidence> = {}): ResolvedEvidence {
  return {
    kind: "diff",
    id: "core-diff",
    chapterId: "core",
    path: "src/app.ts",
    title: "Core diff",
    note: "Look here.",
    status: "modified",
    isBinary: false,
    hunks: [
      {
        header: "@@ -1,2 +1,2 @@",
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        lines: [
          { kind: "context", oldLine: 1, newLine: 1, text: "const port = 3000;" },
          { kind: "deletion", oldLine: 2, newLine: null, text: "listen(port);" },
          { kind: "addition", oldLine: null, newLine: 2, text: 'listen(port, "127.0.0.1");' },
        ],
      },
    ],
    totalHunks: 1,
    provenance: {
      mergeBaseSha: VIEW_MERGE_BASE_SHA,
      headSha: VIEW_HEAD_SHA,
      oldBlobSha: "4".repeat(40),
      newBlobSha: "5".repeat(40),
    },
    anchor: "a".repeat(64),
    contentDigest: "b".repeat(64),
    ...overrides,
  } as ResolvedEvidence;
}
