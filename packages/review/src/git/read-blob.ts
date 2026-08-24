import type { RunGit } from "./run-git.js";

export type ReadBlobInput = {
  runGit: RunGit;
  /** Exact blob sha taken from `git diff --raw`. */
  blobSha: string;
};

export type ReadBlobAtCommitInput = {
  runGit: RunGit;
  commitSha: string;
  path: string;
};

/**
 * Reads a blob by its object id. Addressing content by sha rather than by
 * `<commit>:<path>` is what keeps snapshotted evidence pinned to exactly the
 * bytes that were reviewed, even if the path later moves.
 */
export async function readBlob(input: ReadBlobInput): Promise<string> {
  return await input.runGit(["cat-file", "blob", input.blobSha]);
}

export async function readBlobAtCommit(input: ReadBlobAtCommitInput): Promise<string> {
  return await input.runGit(["show", `${input.commitSha}:${input.path}`]);
}

export async function blobExists(input: ReadBlobInput): Promise<boolean> {
  try {
    const type = (await input.runGit(["cat-file", "-t", input.blobSha])).trim();
    return type === "blob";
  } catch {
    return false;
  }
}
