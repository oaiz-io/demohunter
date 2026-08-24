import type { ReviewCoverageGroup, ReviewDefinition } from "../authoring/review-types.js";
import { createGeneratedMatcher } from "../git/collect-changed-files.js";
import type { ChangedFile } from "../git/git-types.js";

export type CoverageAssignmentKind = "chapter" | "group";

export type CoverageAssignment = {
  path: string;
  kind: CoverageAssignmentKind;
  /** Chapter id or coverage-group id that accounts for the path. */
  ownerId: string;
  ownerTitle: string;
};

export type ReviewCoverage = {
  /** Every changed path in merge-base..HEAD, sorted. */
  changedPaths: string[];
  assignments: CoverageAssignment[];
  /** Changed paths with no chapter or group. Generation fails when non-empty. */
  unaccounted: string[];
  /** Authored references that do not exist in the diff. Generation fails too. */
  unknownReferences: Array<{ ownerId: string; kind: CoverageAssignmentKind; path: string }>;
  /** Groups whose patterns matched nothing, which is usually a stale group. */
  emptyGroups: string[];
  groups: Array<ReviewCoverageGroup & { paths: string[] }>;
  chapters: Array<{ id: string; title: string; paths: string[] }>;
  accountedCount: number;
  totalCount: number;
  /** True only when the accounted set equals the changed set exactly. */
  complete: boolean;
};

export class ReviewCoverageError extends Error {
  readonly coverage: ReviewCoverage;

  constructor(message: string, coverage: ReviewCoverage) {
    super(message);
    this.name = "ReviewCoverageError";
    this.coverage = coverage;
  }
}

/**
 * Assigns every changed path to exactly one owner.
 *
 * Chapters win over groups so an explicitly explained file is never silently
 * demoted into a bucket. Coverage is only "complete" when the accounted set is
 * set-equal to the changed set: no missing paths, and no authored references
 * to paths the pull request never touched.
 */
export function computeCoverage(input: {
  review: ReviewDefinition;
  changedFiles: readonly ChangedFile[];
}): ReviewCoverage {
  const changedPaths = [...input.changedFiles.map((file) => file.path)].sort();
  const changedPathSet = new Set(changedPaths);
  const assignments = new Map<string, CoverageAssignment>();
  const unknownReferences: ReviewCoverage["unknownReferences"] = [];
  const chapters: ReviewCoverage["chapters"] = [];

  for (const chapter of input.review.chapters) {
    const paths: string[] = [];

    for (const file of chapter.files) {
      const normalized = normalizePath(file);

      if (!changedPathSet.has(normalized)) {
        unknownReferences.push({ ownerId: chapter.id, kind: "chapter", path: normalized });
        continue;
      }

      paths.push(normalized);

      if (!assignments.has(normalized)) {
        assignments.set(normalized, {
          path: normalized,
          kind: "chapter",
          ownerId: chapter.id,
          ownerTitle: chapter.title,
        });
      }
    }

    chapters.push({ id: chapter.id, title: chapter.title, paths: [...new Set(paths)].sort() });
  }

  const groups: ReviewCoverage["groups"] = [];

  for (const group of input.review.coverage?.groups ?? []) {
    const matcher = createGeneratedMatcher(group.patterns);
    const paths = changedPaths.filter((path) => matcher(path));

    for (const path of paths) {
      if (!assignments.has(path)) {
        assignments.set(path, {
          path,
          kind: "group",
          ownerId: group.id,
          ownerTitle: group.title,
        });
      }
    }

    groups.push({ ...group, paths });
  }

  const unaccounted = changedPaths.filter((path) => !assignments.has(path));
  const sortedAssignments = [...assignments.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );

  return {
    changedPaths,
    assignments: sortedAssignments,
    unaccounted,
    unknownReferences,
    emptyGroups: groups.filter((group) => group.paths.length === 0).map((group) => group.id),
    groups,
    chapters,
    accountedCount: sortedAssignments.length,
    totalCount: changedPaths.length,
    complete:
      unaccounted.length === 0
      && unknownReferences.length === 0
      && sortedAssignments.length === changedPaths.length,
  };
}

export function assertCoverageComplete(coverage: ReviewCoverage): void {
  if (coverage.complete) {
    return;
  }

  const problems: string[] = [];

  if (coverage.unaccounted.length > 0) {
    problems.push(
      `${coverage.unaccounted.length} changed file(s) are not explained by any chapter or coverage group:\n`
        + coverage.unaccounted.map((path) => `    ${path}`).join("\n"),
    );
  }

  if (coverage.unknownReferences.length > 0) {
    problems.push(
      `${coverage.unknownReferences.length} authored path(s) are not part of merge-base..HEAD:\n`
        + coverage.unknownReferences
          .map((reference) => `    ${reference.path} (referenced by ${reference.kind} ${reference.ownerId})`)
          .join("\n"),
    );
  }

  throw new ReviewCoverageError(
    `Review coverage is incomplete (${coverage.accountedCount}/${coverage.totalCount} changed files accounted for).\n`
      + `${problems.join("\n")}\n`
      + "  Add the missing files to a chapter, or account for them with a coverage group such as tests, docs, or config.",
    coverage,
  );
}

function normalizePath(value: string): string {
  return value.replace(/^\.\//, "").replace(/\\/g, "/");
}
