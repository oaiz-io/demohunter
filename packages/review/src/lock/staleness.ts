import { resolveComparison } from "../git/resolve-comparison.js";
import type { RunGit } from "../git/run-git.js";
import type { ReviewLock } from "./review-lock.js";

export type StalenessReason = {
  code:
    | "head-moved"
    | "merge-base-moved"
    | "base-moved"
    | "merge-base-ambiguity-changed"
    | "ref-unresolvable";
  message: string;
  expected?: string;
  actual?: string;
};

export type StalenessReport = {
  stale: boolean;
  reasons: StalenessReason[];
  current?: {
    baseSha: string;
    headSha: string;
    mergeBaseSha: string;
    mergeBaseCandidates: string[];
  };
};

/**
 * Compares a recorded lock against the repository as it exists now.
 *
 * A review artifact is only trustworthy for the exact range it was built from,
 * so any movement of HEAD, the base, or the merge base marks it stale.
 */
export async function detectStaleness(input: {
  lock: ReviewLock;
  runGit: RunGit;
}): Promise<StalenessReport> {
  let comparison: Awaited<ReturnType<typeof resolveComparison>>;

  try {
    comparison = await resolveComparison({
      runGit: input.runGit,
      baseRef: input.lock.git.baseRef,
      headRef: input.lock.git.headRef,
    });
  } catch (error) {
    return {
      stale: true,
      reasons: [
        {
          code: "ref-unresolvable",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  const reasons: StalenessReason[] = [];

  if (comparison.headSha !== input.lock.git.headSha) {
    reasons.push({
      code: "head-moved",
      message: `${input.lock.git.headRef} now resolves to a different commit than the artifact was built from.`,
      expected: input.lock.git.headSha,
      actual: comparison.headSha,
    });
  }

  if (comparison.baseSha !== input.lock.git.baseSha) {
    reasons.push({
      code: "base-moved",
      message: `${input.lock.git.baseRef} has moved since the artifact was generated.`,
      expected: input.lock.git.baseSha,
      actual: comparison.baseSha,
    });
  }

  if (comparison.mergeBaseSha !== input.lock.git.mergeBaseSha) {
    reasons.push({
      code: "merge-base-moved",
      message: "The merge base of the reviewed range changed.",
      expected: input.lock.git.mergeBaseSha,
      actual: comparison.mergeBaseSha,
    });
  }

  const recordedCandidates = [...input.lock.git.mergeBaseCandidates].sort().join(",");
  const currentCandidates = [...comparison.mergeBaseCandidates].sort().join(",");

  if (recordedCandidates !== currentCandidates) {
    reasons.push({
      code: "merge-base-ambiguity-changed",
      message: "The set of merge-base candidates changed, so the reviewed range is ambiguous.",
      expected: recordedCandidates,
      actual: currentCandidates,
    });
  }

  return {
    stale: reasons.length > 0,
    reasons,
    current: {
      baseSha: comparison.baseSha,
      headSha: comparison.headSha,
      mergeBaseSha: comparison.mergeBaseSha,
      mergeBaseCandidates: comparison.mergeBaseCandidates,
    },
  };
}
