import type { ReviewEvidence } from "../authoring/review-types.js";
import {
  collectFileDiff,
  narrowHunkToRange,
  selectHunksForRange,
  DEFAULT_DIFF_CONTEXT_LINES,
} from "../git/collect-hunks.js";
import type { ChangedFile, DiffHunk } from "../git/git-types.js";
import { readBlob } from "../git/read-blob.js";
import type { RunGit } from "../git/run-git.js";
import { createEvidenceAnchor, createTextDigest } from "./anchors.js";

export type ResolvedDiffEvidence = {
  kind: "diff";
  id: string;
  chapterId: string;
  path: string;
  previousPath?: string;
  title: string;
  note?: string;
  status: ChangedFile["status"];
  isBinary: boolean;
  hunks: DiffHunk[];
  /** Total hunk count before any authored range filter was applied. */
  totalHunks: number;
  /** Post-image range the author narrowed this evidence to, when they did. */
  range?: { startLine: number; endLine: number };
  provenance: {
    mergeBaseSha: string;
    headSha: string;
    oldBlobSha: string | null;
    newBlobSha: string | null;
  };
  anchor: string;
  /** Digest of the exact rendered diff text. */
  contentDigest: string;
};

export type ResolvedCodeEvidence = {
  kind: "code";
  id: string;
  chapterId: string;
  path: string;
  title: string;
  note?: string;
  side: "head" | "base";
  startLine: number;
  endLine: number;
  lines: Array<{ line: number; text: string }>;
  provenance: {
    commitSha: string;
    blobSha: string;
  };
  anchor: string;
  contentDigest: string;
};

export type ResolvedEvidence = ResolvedDiffEvidence | ResolvedCodeEvidence;

export type ResolveEvidenceInput = {
  runGit: RunGit;
  evidence: ReviewEvidence;
  chapterId: string;
  mergeBaseSha: string;
  headSha: string;
  changedFilesByPath: ReadonlyMap<string, ChangedFile>;
};

export class ReviewEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewEvidenceError";
  }
}

export async function resolveEvidence(input: ResolveEvidenceInput): Promise<ResolvedEvidence> {
  return input.evidence.kind === "diff"
    ? await resolveDiffEvidence(input, input.evidence)
    : await resolveCodeEvidence(input, input.evidence);
}

async function resolveDiffEvidence(
  input: ResolveEvidenceInput,
  evidence: Extract<ReviewEvidence, { kind: "diff" }>,
): Promise<ResolvedDiffEvidence> {
  const changedFile = input.changedFilesByPath.get(evidence.path);

  if (changedFile === undefined) {
    throw new ReviewEvidenceError(
      `Diff evidence "${evidence.id}" points at ${evidence.path}, which is not part of `
        + `merge-base..HEAD. Reference a path the pull request actually changed.`,
    );
  }

  if (changedFile.isSubmodule) {
    throw new ReviewEvidenceError(
      `Diff evidence "${evidence.id}" points at the submodule ${evidence.path}. `
        + "Submodule pointer changes have no textual diff; describe them in a coverage group instead.",
    );
  }

  if (changedFile.isBinary) {
    throw new ReviewEvidenceError(
      `Diff evidence "${evidence.id}" points at the binary file ${evidence.path}. `
        + "Binary files have no reviewable hunks; account for them in a coverage group instead.",
    );
  }

  const fileDiff = await collectFileDiff({
    runGit: input.runGit,
    mergeBaseSha: input.mergeBaseSha,
    headSha: input.headSha,
    path: evidence.path,
    previousPath: evidence.previousPath ?? changedFile.previousPath,
    contextLines: evidence.contextLines ?? DEFAULT_DIFF_CONTEXT_LINES,
  });
  const selected = selectHunksForRange(fileDiff.hunks, evidence.range);
  // Selecting whole hunks is not enough: a newly added file is one hunk
  // covering the entire file, so the authored range has to trim it as well.
  const hunks = evidence.range === undefined
    ? selected
    : selected
        .map((hunk) => narrowHunkToRange(hunk, evidence.range!))
        .filter((hunk): hunk is DiffHunk => hunk !== undefined);

  if (hunks.length === 0) {
    throw new ReviewEvidenceError(
      `Diff evidence "${evidence.id}" selected no hunks for ${evidence.path}`
        + `${evidence.range === undefined ? "" : ` in lines ${evidence.range.startLine}-${evidence.range.endLine}`}. `
        + describeEmptyDiff(changedFile),
    );
  }

  const renderedText = renderHunks(hunks);
  const provenance = {
    mergeBaseSha: input.mergeBaseSha,
    headSha: input.headSha,
    oldBlobSha: changedFile.oldBlobSha,
    newBlobSha: changedFile.newBlobSha,
  };

  return {
    kind: "diff",
    id: evidence.id,
    chapterId: input.chapterId,
    path: evidence.path,
    ...(changedFile.previousPath === undefined ? {} : { previousPath: changedFile.previousPath }),
    title: evidence.title ?? evidence.path,
    ...(evidence.note === undefined ? {} : { note: evidence.note }),
    status: changedFile.status,
    isBinary: false,
    hunks,
    totalHunks: fileDiff.hunks.length,
    ...(evidence.range === undefined ? {} : { range: evidence.range }),
    provenance,
    anchor: createEvidenceAnchor([
      "diff",
      evidence.path,
      changedFile.previousPath ?? "",
      provenance.oldBlobSha ?? "",
      provenance.newBlobSha ?? "",
      renderedText,
    ]),
    contentDigest: createTextDigest(renderedText),
  };
}

async function resolveCodeEvidence(
  input: ResolveEvidenceInput,
  evidence: Extract<ReviewEvidence, { kind: "code" }>,
): Promise<ResolvedCodeEvidence> {
  const side = evidence.side ?? "head";
  const changedFile = input.changedFilesByPath.get(evidence.path);
  const commitSha = side === "head" ? input.headSha : input.mergeBaseSha;
  const blobSha = side === "head" ? changedFile?.newBlobSha : changedFile?.oldBlobSha;

  if (changedFile !== undefined && blobSha === null) {
    throw new ReviewEvidenceError(
      `Code evidence "${evidence.id}" reads ${evidence.path} from the ${side} side, `
        + `but the file does not exist there (status: ${changedFile.status}).`,
    );
  }

  const resolvedBlobSha = blobSha ?? (await resolvePathBlobSha(input.runGit, commitSha, evidence.path));
  const source = await readBlob({ runGit: input.runGit, blobSha: resolvedBlobSha });
  const allLines = source.split("\n");
  // A trailing newline produces a final empty element that is not a real line.
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
    allLines.pop();
  }

  if (evidence.startLine > allLines.length) {
    throw new ReviewEvidenceError(
      `Code evidence "${evidence.id}" starts at line ${evidence.startLine}, but `
        + `${evidence.path} has only ${allLines.length} line(s) at ${side}.`,
    );
  }

  const endLine = Math.min(evidence.endLine, allLines.length);
  const lines = allLines
    .slice(evidence.startLine - 1, endLine)
    .map((text, index) => ({ line: evidence.startLine + index, text }));
  const renderedText = lines.map((entry) => entry.text).join("\n");

  return {
    kind: "code",
    id: evidence.id,
    chapterId: input.chapterId,
    path: evidence.path,
    title: evidence.title ?? `${evidence.path}:${evidence.startLine}-${endLine}`,
    ...(evidence.note === undefined ? {} : { note: evidence.note }),
    side,
    startLine: evidence.startLine,
    endLine,
    lines,
    provenance: { commitSha, blobSha: resolvedBlobSha },
    anchor: createEvidenceAnchor([
      "code",
      evidence.path,
      side,
      resolvedBlobSha,
      `${evidence.startLine}-${endLine}`,
      renderedText,
    ]),
    contentDigest: createTextDigest(renderedText),
  };
}

/**
 * Explains why a path in the range still produced no hunks. Each case has a
 * different fix, and "widen the range" is wrong advice for most of them.
 */
function describeEmptyDiff(changedFile: ChangedFile): string {
  if (changedFile.isModeOnly) {
    return "This path only changed file mode, so it has no content hunks.";
  }

  if (
    (changedFile.status === "renamed" || changedFile.status === "copied")
    && changedFile.insertions === 0
    && changedFile.deletions === 0
  ) {
    return (
      `This path was ${changedFile.status} from ${changedFile.previousPath ?? "another path"} `
      + "without any content change, so there is nothing to show. Account for it in a coverage "
      + "group, or point the evidence at a file whose contents actually changed."
    );
  }

  return "Widen or remove the range so the evidence shows a real change.";
}

async function resolvePathBlobSha(
  runGit: RunGit,
  commitSha: string,
  path: string,
): Promise<string> {
  const output = await runGit(["rev-parse", "--verify", "--quiet", `${commitSha}:${path}`]).catch(
    () => "",
  );
  const sha = output.trim();

  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new ReviewEvidenceError(
      `Could not resolve ${path} at ${commitSha.slice(0, 12)}. `
        + "Code evidence must point at a file that exists on the requested side of the comparison.",
    );
  }

  return sha;
}

/** Canonical text form of a hunk list, used for anchors and video narration. */
export function renderHunks(hunks: readonly DiffHunk[]): string {
  return hunks
    .map((hunk) =>
      [
        hunk.header,
        ...hunk.lines.map((line) => `${markerFor(line.kind)}${line.text}`),
      ].join("\n"),
    )
    .join("\n");
}

function markerFor(kind: DiffHunk["lines"][number]["kind"]): string {
  if (kind === "addition") return "+";
  if (kind === "deletion") return "-";
  return " ";
}
