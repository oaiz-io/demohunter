import { REVIEW_LOCK_VERSION, type ReviewLock } from "../lock/review-lock.js";

export const FIXTURE_BASE_SHA = "1".repeat(40);
export const FIXTURE_HEAD_SHA = "2".repeat(40);
export const FIXTURE_MERGE_BASE_SHA = "3".repeat(40);
export const FIXTURE_OLD_BLOB_SHA = "4".repeat(40);
export const FIXTURE_NEW_BLOB_SHA = "5".repeat(40);
export const FIXTURE_DIGEST = "6".repeat(64);

/** A minimal lock that satisfies the schema, for tests that mutate one field. */
export function makeReviewLock(overrides: Partial<ReviewLock> = {}): ReviewLock {
  return {
    lockVersion: REVIEW_LOCK_VERSION,
    generator: { name: "demohunter-review", version: "0.1.5" },
    generatedAt: "2026-08-24T00:00:00.000Z",
    review: {
      id: "pr-22-review",
      title: "PR 22",
      sourcePath: "reviews/pr-22.review.ts",
      definitionDigest: FIXTURE_DIGEST,
    },
    git: {
      baseRef: "main",
      baseSha: FIXTURE_BASE_SHA,
      headRef: "HEAD",
      headSha: FIXTURE_HEAD_SHA,
      mergeBaseSha: FIXTURE_MERGE_BASE_SHA,
      mergeBaseCandidates: [FIXTURE_MERGE_BASE_SHA],
      headIsMergeCommit: false,
      headParents: [FIXTURE_MERGE_BASE_SHA],
      worktree: { clean: true, entries: [] },
    },
    files: [
      {
        path: "src/app.ts",
        status: "modified",
        insertions: 3,
        deletions: 1,
        oldMode: "100644",
        newMode: "100644",
        oldBlobSha: FIXTURE_OLD_BLOB_SHA,
        newBlobSha: FIXTURE_NEW_BLOB_SHA,
        isBinary: false,
        isSubmodule: false,
        isModeOnly: false,
        isGenerated: false,
      },
    ],
    coverage: {
      totalCount: 1,
      accountedCount: 1,
      complete: true,
      assignments: [
        { path: "src/app.ts", kind: "chapter", ownerId: "core", ownerTitle: "Core" },
      ],
      unaccounted: [],
      groups: [],
      chapters: [{ id: "core", title: "Core", paths: ["src/app.ts"] }],
    },
    evidence: [],
    verification: { status: "passed", ran: true, results: [] },
    video: null,
    artifacts: [],
    ...overrides,
  };
}
