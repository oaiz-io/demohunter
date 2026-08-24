import type { ChangedFile, ChangedFileStatus } from "./git-types.js";
import { splitNulFields, type RunGit } from "./run-git.js";

export type CollectChangedFilesInput = {
  runGit: RunGit;
  mergeBaseSha: string;
  headSha: string;
  /** Restrict the comparison to these repository-relative pathspecs. */
  pathspecs?: readonly string[];
  /** Extra generated-file patterns, in addition to the built-in list. */
  generatedPatterns?: readonly string[];
};

const SUBMODULE_MODE = "160000";
const EMPTY_MODE = "000000";

/**
 * Paths that are almost always machine-produced. They still have to be
 * accounted for by the review, but a reviewer should not be asked to read them
 * line by line, so they are flagged rather than hidden.
 */
export const DEFAULT_GENERATED_PATTERNS: readonly string[] = [
  "**/bun.lock",
  "**/bun.lockb",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/Cargo.lock",
  "**/poetry.lock",
  "**/go.sum",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
  "**/*.snap",
  "dist/**",
  "**/dist/**",
  "**/__generated__/**",
  "**/*.generated.*",
];

export async function collectChangedFiles(input: CollectChangedFilesInput): Promise<ChangedFile[]> {
  const pathspecArgs = toPathspecArgs(input.pathspecs);
  const rawOutput = await input.runGit([
    "diff",
    "--no-color",
    "--no-textconv",
    "--find-renames",
    "--find-copies",
    "--raw",
    // Git abbreviates blob shas in --raw output by default. Evidence is pinned
    // to exact object ids, so the full sha is not optional here.
    "--no-abbrev",
    "-z",
    input.mergeBaseSha,
    input.headSha,
    ...pathspecArgs,
  ]);
  const numstatOutput = await input.runGit([
    "diff",
    "--no-color",
    "--no-textconv",
    "--find-renames",
    "--find-copies",
    "--numstat",
    "-z",
    input.mergeBaseSha,
    input.headSha,
    ...pathspecArgs,
  ]);

  const stats = parseNumstat(numstatOutput);
  const generatedMatcher = createGeneratedMatcher([
    ...DEFAULT_GENERATED_PATTERNS,
    ...(input.generatedPatterns ?? []),
  ]);

  return parseRawDiff(rawOutput)
    .map((entry) => {
      const stat = stats.get(entry.path) ?? stats.get(entry.previousPath ?? entry.path);
      const isSubmodule = entry.oldMode === SUBMODULE_MODE || entry.newMode === SUBMODULE_MODE;
      const isBinary = stat?.isBinary ?? isSubmodule;
      const isModeOnly = entry.status === "modified"
        && entry.oldMode !== entry.newMode
        && entry.oldBlobSha !== null
        && entry.oldBlobSha === entry.newBlobSha;

      return {
        path: entry.path,
        ...(entry.previousPath === undefined ? {} : { previousPath: entry.previousPath }),
        status: entry.status,
        ...(entry.similarity === undefined ? {} : { similarity: entry.similarity }),
        insertions: stat?.insertions ?? 0,
        deletions: stat?.deletions ?? 0,
        oldMode: entry.oldMode,
        newMode: entry.newMode,
        oldBlobSha: entry.oldBlobSha,
        newBlobSha: entry.newBlobSha,
        isBinary,
        isSubmodule,
        isModeOnly,
        isGenerated: generatedMatcher(entry.path),
      } satisfies ChangedFile;
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

type RawDiffEntry = {
  path: string;
  previousPath?: string;
  status: ChangedFileStatus;
  similarity?: number;
  oldMode: string;
  newMode: string;
  oldBlobSha: string | null;
  newBlobSha: string | null;
};

/**
 * Parses `git diff --raw -z` records of the shape
 * `:<oldmode> <newmode> <oldsha> <newsha> <status>\0<path>[\0<newpath>]`.
 */
export function parseRawDiff(output: string): RawDiffEntry[] {
  const fields = splitNulFields(output);
  const entries: RawDiffEntry[] = [];

  for (let index = 0; index < fields.length; index += 1) {
    const meta = fields[index]!;

    if (!meta.startsWith(":")) {
      continue;
    }

    const [oldMode, newMode, oldSha, newSha, statusToken] = meta.slice(1).split(" ");

    if (statusToken === undefined) {
      continue;
    }

    const statusLetter = statusToken[0]!;
    const similarity = Number.parseInt(statusToken.slice(1), 10);
    const hasSecondPath = statusLetter === "R" || statusLetter === "C";
    const firstPath = fields[index + 1];
    const secondPath = hasSecondPath ? fields[index + 2] : undefined;

    if (firstPath === undefined || (hasSecondPath && secondPath === undefined)) {
      throw new Error("Malformed git diff --raw -z output: missing path field.");
    }

    index += hasSecondPath ? 2 : 1;

    entries.push({
      path: hasSecondPath ? secondPath! : firstPath,
      ...(hasSecondPath ? { previousPath: firstPath } : {}),
      status: toChangedFileStatus(statusLetter),
      ...(Number.isFinite(similarity) ? { similarity } : {}),
      oldMode: oldMode ?? EMPTY_MODE,
      newMode: newMode ?? EMPTY_MODE,
      oldBlobSha: normalizeBlobSha(oldSha),
      newBlobSha: normalizeBlobSha(newSha),
    });
  }

  return entries;
}

/** Parses `git diff --numstat -z`, including its two-extra-field rename form. */
export function parseNumstat(
  output: string,
): Map<string, { insertions: number; deletions: number; isBinary: boolean }> {
  const fields = splitNulFields(output);
  const stats = new Map<string, { insertions: number; deletions: number; isBinary: boolean }>();

  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index]!;
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(record);

    if (match === null) {
      continue;
    }

    const [, insertions, deletions, inlinePath] = match;
    const isBinary = insertions === "-" || deletions === "-";
    const value = {
      insertions: isBinary ? 0 : Number.parseInt(insertions!, 10),
      deletions: isBinary ? 0 : Number.parseInt(deletions!, 10),
      isBinary,
    };

    if (inlinePath !== "") {
      stats.set(inlinePath!, value);
      continue;
    }

    // Rename/copy form: the record ends after the counts and the old and new
    // paths follow as two separate NUL-delimited fields.
    const previousPath = fields[index + 1];
    const newPath = fields[index + 2];

    if (previousPath === undefined || newPath === undefined) {
      throw new Error("Malformed git diff --numstat -z output: missing rename path fields.");
    }

    stats.set(newPath, value);
    stats.set(previousPath, value);
    index += 2;
  }

  return stats;
}

function toChangedFileStatus(letter: string): ChangedFileStatus {
  switch (letter) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type-changed";
    case "U":
      return "unmerged";
    default:
      return "modified";
  }
}

function normalizeBlobSha(sha: string | undefined): string | null {
  if (sha === undefined || /^0+$/.test(sha)) {
    return null;
  }

  return sha;
}

function toPathspecArgs(pathspecs: readonly string[] | undefined): string[] {
  if (pathspecs === undefined || pathspecs.length === 0) {
    return [];
  }

  return ["--", ...pathspecs];
}

/**
 * Minimal deterministic glob matcher covering `*`, `**`, and `?`. Kept local so
 * the review layer does not pull in a matching dependency for a handful of
 * generated-file patterns.
 */
export function createGeneratedMatcher(patterns: readonly string[]): (path: string) => boolean {
  const expressions = patterns.map(compileGlob);

  return (candidate) => expressions.some((expression) => expression.test(candidate));
}

export function compileGlob(pattern: string): RegExp {
  let source = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;

    if (char === "*") {
      const isDoubleStar = pattern[index + 1] === "*";

      if (isDoubleStar) {
        const consumesSlash = pattern[index + 2] === "/";
        source += consumesSlash ? "(?:.*/)?" : ".*";
        index += consumesSlash ? 2 : 1;
        continue;
      }

      source += "[^/]*";
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }

  return new RegExp(`^${source}$`);
}
