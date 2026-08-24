/** Status of a single path between the merge base and HEAD. */
export type ChangedFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type-changed"
  | "unmerged";

/**
 * One changed path in the reviewed range, described only with facts that Git
 * itself reported. Nothing here is inferred from the authored review.
 */
export type ChangedFile = {
  /** Path at HEAD, or the deleted path when the file no longer exists. */
  path: string;
  /** Original path when Git detected a rename or copy. */
  previousPath?: string;
  status: ChangedFileStatus;
  /** Rename/copy similarity score reported by Git, 0-100. */
  similarity?: number;
  insertions: number;
  deletions: number;
  /** Git object mode before the change, "000000" when the path was added. */
  oldMode: string;
  /** Git object mode after the change, "000000" when the path was deleted. */
  newMode: string;
  /** Blob sha before the change, null when the path was added. */
  oldBlobSha: string | null;
  /** Blob sha after the change, null when the path was deleted. */
  newBlobSha: string | null;
  /** Git could not produce a textual diff for this path. */
  isBinary: boolean;
  /** Path points at a gitlink (submodule) rather than a blob. */
  isSubmodule: boolean;
  /** Only the file mode changed; content is byte-identical. */
  isModeOnly: boolean;
  /** Path matched one of the configured generated-file patterns. */
  isGenerated: boolean;
};

export type GitComparison = {
  repoRoot: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  mergeBaseSha: string;
  /** Every merge base Git reported. More than one means an ambiguous history. */
  mergeBaseCandidates: string[];
  /** HEAD has more than one parent. */
  headIsMergeCommit: boolean;
  headParents: string[];
};

export type WorktreeStatusEntry = {
  path: string;
  /** Two-letter porcelain code, for example " M", "??", or "UU". */
  code: string;
};

export type WorktreeStatus = {
  clean: boolean;
  entries: WorktreeStatusEntry[];
  /** Untracked, non-ignored paths. */
  untracked: string[];
  /** Paths with unresolved merge conflicts. */
  unmerged: string[];
};

export type DiffHunkLineKind = "context" | "addition" | "deletion";

export type DiffHunkLine = {
  kind: DiffHunkLineKind;
  /** 1-based line number in the pre-image, null for additions. */
  oldLine: number | null;
  /** 1-based line number in the post-image, null for deletions. */
  newLine: number | null;
  text: string;
};

export type DiffHunk = {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffHunkLine[];
};

export type FileDiff = {
  path: string;
  previousPath?: string;
  status: ChangedFileStatus;
  isBinary: boolean;
  hunks: DiffHunk[];
};
