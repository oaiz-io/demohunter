import type { WorktreeStatus, WorktreeStatusEntry } from "./git-types.js";
import { splitNulFields, type RunGit } from "./run-git.js";

export type ReadWorktreeStatusInput = {
  runGit: RunGit;
};

/**
 * Reads porcelain status for the current work tree. Ignored files are excluded
 * on purpose: a generated review artifact that the repository ignores must not
 * make the tree look dirty.
 */
export async function readWorktreeStatus(input: ReadWorktreeStatusInput): Promise<WorktreeStatus> {
  const output = await input.runGit([
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=normal",
    "--ignored=no",
  ]);
  const entries = parsePorcelainStatus(output);

  return {
    clean: entries.length === 0,
    entries,
    untracked: entries.filter((entry) => entry.code === "??").map((entry) => entry.path),
    unmerged: entries.filter((entry) => isUnmergedCode(entry.code)).map((entry) => entry.path),
  };
}

export function parsePorcelainStatus(output: string): WorktreeStatusEntry[] {
  const fields = splitNulFields(output);
  const entries: WorktreeStatusEntry[] = [];

  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index]!;

    if (record.length < 4) {
      continue;
    }

    const code = record.slice(0, 2);
    const path = record.slice(3);

    // Rename and copy records carry the original path in the next field.
    if (code[0] === "R" || code[0] === "C") {
      index += 1;
    }

    entries.push({ code, path });
  }

  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function isUnmergedCode(code: string): boolean {
  return (
    code === "DD"
    || code === "AU"
    || code === "UD"
    || code === "UA"
    || code === "DU"
    || code === "AA"
    || code === "UU"
  );
}

export function describeWorktreeStatus(status: WorktreeStatus): string {
  if (status.clean) {
    return "clean";
  }

  const preview = status.entries
    .slice(0, 10)
    .map((entry) => `${entry.code} ${entry.path}`)
    .join(", ");
  const suffix = status.entries.length > 10 ? `, +${status.entries.length - 10} more` : "";

  return `${status.entries.length} pending change(s): ${preview}${suffix}`;
}
