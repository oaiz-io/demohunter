import { z } from "zod";

export const REVIEW_LOCK_VERSION = 1;
export const REVIEW_LOCK_FILE_NAME = "review.lock.json";

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);

const portableRelativePathSchema = z.string().min(1).refine((value) => {
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) return false;
  if (value.includes("\\")) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}, "Artifact paths must be safe review-root-relative POSIX paths.");

const checksumSchema = z
  .object({
    algorithm: z.literal("sha256"),
    byteSize: z.int().nonnegative(),
    hex: digestSchema,
  })
  .strict();

const artifactSchema = z
  .object({
    path: portableRelativePathSchema,
    mediaType: z.string().min(1),
    checksum: checksumSchema,
  })
  .strict();

const changedFileSchema = z
  .object({
    path: z.string().min(1),
    previousPath: z.string().min(1).optional(),
    status: z.enum([
      "added",
      "modified",
      "deleted",
      "renamed",
      "copied",
      "type-changed",
      "unmerged",
    ]),
    similarity: z.int().min(0).max(100).optional(),
    insertions: z.int().nonnegative(),
    deletions: z.int().nonnegative(),
    oldMode: z.string().regex(/^\d{6}$/),
    newMode: z.string().regex(/^\d{6}$/),
    oldBlobSha: shaSchema.nullable(),
    newBlobSha: shaSchema.nullable(),
    isBinary: z.boolean(),
    isSubmodule: z.boolean(),
    isModeOnly: z.boolean(),
    isGenerated: z.boolean(),
  })
  .strict();

const coverageAssignmentSchema = z
  .object({
    path: z.string().min(1),
    kind: z.enum(["chapter", "group"]),
    ownerId: z.string().min(1),
    ownerTitle: z.string().min(1),
  })
  .strict();

const evidenceRecordSchema = z
  .object({
    id: z.string().min(1),
    chapterId: z.string().min(1),
    kind: z.enum(["diff", "code"]),
    path: z.string().min(1),
    previousPath: z.string().min(1).optional(),
    anchor: digestSchema,
    contentDigest: digestSchema,
    provenance: z
      .object({
        mergeBaseSha: shaSchema.optional(),
        headSha: shaSchema.optional(),
        commitSha: shaSchema.optional(),
        blobSha: shaSchema.optional(),
        oldBlobSha: shaSchema.nullable().optional(),
        newBlobSha: shaSchema.nullable().optional(),
      })
      .strict(),
    range: z
      .object({ startLine: z.int().positive(), endLine: z.int().positive() })
      .strict()
      .optional(),
    side: z.enum(["head", "base"]).optional(),
  })
  .strict();

const verificationResultSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    command: z.array(z.string().min(1)).min(1),
    cwd: z.string().min(1),
    rationale: z.string().optional(),
    status: z.enum(["passed", "failed", "not-run"]),
    expectedExitCode: z.int().nonnegative(),
    exitCode: z.int().nullable(),
    durationMs: z.int().nonnegative(),
    timedOut: z.boolean(),
    outputTail: z.string(),
    outputTruncated: z.boolean(),
  })
  .strict();

const videoSchema = z
  .object({
    tourId: z.string().min(1),
    durationMs: z.int().nonnegative(),
    video: portableRelativePathSchema,
    poster: portableRelativePathSchema,
    captionsSrt: portableRelativePathSchema,
    captionsVtt: portableRelativePathSchema,
    chapters: portableRelativePathSchema,
    manifest: portableRelativePathSchema,
    chapterCount: z.int().nonnegative(),
    narrationCount: z.int().nonnegative(),
  })
  .strict();

export const reviewLockSchema = z
  .object({
    lockVersion: z.literal(REVIEW_LOCK_VERSION),
    generator: z
      .object({
        name: z.literal("demohunter-review"),
        version: z.string().min(1),
      })
      .strict(),
    generatedAt: z.string().min(1),
    review: z
      .object({
        id: z.string().min(1),
        title: z.string().min(1),
        subtitle: z.string().optional(),
        sourcePath: z.string().min(1),
        definitionDigest: digestSchema,
        pullRequest: z
          .object({
            number: z.int().positive().optional(),
            url: z.string().min(1).optional(),
            author: z.string().min(1).optional(),
            branch: z.string().min(1).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    git: z
      .object({
        baseRef: z.string().min(1),
        baseSha: shaSchema,
        headRef: z.string().min(1),
        headSha: shaSchema,
        mergeBaseSha: shaSchema,
        mergeBaseCandidates: z.array(shaSchema).min(1),
        headIsMergeCommit: z.boolean(),
        headParents: z.array(shaSchema),
        worktree: z
          .object({
            clean: z.boolean(),
            entries: z.array(
              z.object({ code: z.string().min(1), path: z.string().min(1) }).strict(),
            ),
          })
          .strict(),
      })
      .strict(),
    files: z.array(changedFileSchema),
    coverage: z
      .object({
        totalCount: z.int().nonnegative(),
        accountedCount: z.int().nonnegative(),
        complete: z.boolean(),
        assignments: z.array(coverageAssignmentSchema),
        unaccounted: z.array(z.string().min(1)),
        groups: z.array(
          z
            .object({
              id: z.string().min(1),
              title: z.string().min(1),
              rationale: z.string().min(1),
              patterns: z.array(z.string().min(1)),
              paths: z.array(z.string().min(1)),
            })
            .strict(),
        ),
        chapters: z.array(
          z
            .object({
              id: z.string().min(1),
              title: z.string().min(1),
              paths: z.array(z.string().min(1)),
            })
            .strict(),
        ),
      })
      .strict(),
    evidence: z.array(evidenceRecordSchema),
    verification: z
      .object({
        status: z.enum(["passed", "failed", "not-run"]),
        ran: z.boolean(),
        results: z.array(verificationResultSchema),
      })
      .strict(),
    video: videoSchema.nullable(),
    artifacts: z.array(artifactSchema),
  })
  .strict();

export type ReviewLock = z.infer<typeof reviewLockSchema>;
export type ReviewLockArtifact = z.infer<typeof artifactSchema>;
export type ReviewLockEvidence = z.infer<typeof evidenceRecordSchema>;

export function parseReviewLock(value: unknown): ReviewLock {
  return reviewLockSchema.parse(value);
}

/** Stable JSON form so identical inputs always produce byte-identical locks. */
export function serializeReviewLock(lock: ReviewLock): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}
