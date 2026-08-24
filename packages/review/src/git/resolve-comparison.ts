import type { RunGit } from "./run-git.js";
import type { GitComparison } from "./git-types.js";

export type ResolveComparisonInput = {
  runGit: RunGit;
  baseRef: string;
  headRef?: string;
};

/**
 * Resolves the PR-shaped comparison `merge-base(base, HEAD) -> HEAD`.
 *
 * The merge base is recorded as an exact sha, and every candidate Git reported
 * is preserved so an ambiguous history is visible to the reviewer instead of
 * being silently collapsed to whichever one Git happened to print first.
 */
export async function resolveComparison(input: ResolveComparisonInput): Promise<GitComparison> {
  const headRef = input.headRef ?? "HEAD";
  const repoRoot = (await input.runGit(["rev-parse", "--show-toplevel"])).trim();

  if (repoRoot.length === 0) {
    throw new Error("DemoHunter Review must run inside a Git work tree.");
  }

  const baseSha = await resolveCommitSha(input.runGit, input.baseRef);
  const headSha = await resolveCommitSha(input.runGit, headRef);
  const mergeBaseCandidates = splitLines(
    await input.runGit(["merge-base", "--all", baseSha, headSha]).catch(() => ""),
  );

  if (mergeBaseCandidates.length === 0) {
    throw new Error(
      `No merge base between ${input.baseRef} (${shortSha(baseSha)}) and ${headRef} (${shortSha(headSha)}). `
        + "The two histories are unrelated, so there is no reviewable pull-request range. "
        + "Fetch the base branch (git fetch origin <base>) and rerun.",
    );
  }

  const headParents = splitLines(await input.runGit(["rev-list", "--parents", "-n", "1", headSha]))
    .flatMap((line) => line.split(" "))
    .slice(1);

  return {
    repoRoot,
    baseRef: input.baseRef,
    baseSha,
    headRef,
    headSha,
    // Sorted so the chosen base does not depend on Git's traversal order.
    mergeBaseSha: [...mergeBaseCandidates].sort()[0]!,
    mergeBaseCandidates: [...mergeBaseCandidates].sort(),
    headIsMergeCommit: headParents.length > 1,
    headParents,
  };
}

async function resolveCommitSha(runGit: RunGit, ref: string): Promise<string> {
  const output = await runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => "");
  const sha = output.trim();

  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(
      `Could not resolve "${ref}" to a commit. `
        + "Pass an existing branch, tag, or sha, and fetch it first when it only exists on the remote.",
    );
  }

  return sha;
}

function splitLines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}
