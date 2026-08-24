import type { DiffHunk, DiffHunkLine, FileDiff } from "./git-types.js";
import type { RunGit } from "./run-git.js";

export type CollectFileDiffInput = {
  runGit: RunGit;
  mergeBaseSha: string;
  headSha: string;
  path: string;
  previousPath?: string;
  contextLines?: number;
};

export const DEFAULT_DIFF_CONTEXT_LINES = 3;

/** Produces parsed hunks for one path in the reviewed range. */
export async function collectFileDiff(input: CollectFileDiffInput): Promise<FileDiff> {
  const contextLines = input.contextLines ?? DEFAULT_DIFF_CONTEXT_LINES;
  const pathspecs = input.previousPath === undefined
    ? [input.path]
    : [input.previousPath, input.path];
  const output = await input.runGit([
    "diff",
    "--no-color",
    "--no-textconv",
    "--find-renames",
    "--find-copies",
    `--unified=${contextLines}`,
    input.mergeBaseSha,
    input.headSha,
    "--",
    ...pathspecs,
  ]);

  return parseUnifiedDiff(output, input.path);
}

/**
 * Parses a single-file unified diff. Only the sections belonging to
 * `expectedPath` are kept so a rename pathspec that also matches an unrelated
 * file cannot leak foreign hunks into the evidence.
 */
export function parseUnifiedDiff(diffText: string, expectedPath: string): FileDiff {
  const lines = diffText.split("\n");
  const hunks: DiffHunk[] = [];
  let isBinary = false;
  let previousPath: string | undefined;
  let currentPath: string | undefined;
  let capturing = false;
  let current: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  const flush = (): void => {
    if (current !== undefined && capturing) {
      hunks.push(current);
    }
    current = undefined;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      capturing = false;
      currentPath = undefined;
      continue;
    }

    if (line.startsWith("--- ")) {
      const parsed = parseDiffPath(line.slice(4));
      if (parsed !== null) {
        previousPath = parsed;
      }
      continue;
    }

    if (line.startsWith("+++ ")) {
      const parsed = parseDiffPath(line.slice(4));
      currentPath = parsed ?? currentPath;
      capturing = (parsed ?? previousPath) === expectedPath || previousPath === expectedPath;
      continue;
    }

    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      if (capturing || currentPath === undefined) {
        isBinary = true;
      }
      continue;
    }

    if (line.startsWith("@@")) {
      flush();
      const header = parseHunkHeader(line);

      if (header === null) {
        continue;
      }

      oldLine = header.oldStart;
      newLine = header.newStart;
      current = { ...header, lines: [] };
      continue;
    }

    if (current === undefined) {
      continue;
    }

    if (line.startsWith("\\")) {
      // "\ No newline at end of file" belongs to the previous line.
      continue;
    }

    const marker = line[0];

    if (marker === "+") {
      current.lines.push(toHunkLine("addition", null, newLine, line.slice(1)));
      newLine += 1;
      continue;
    }

    if (marker === "-") {
      current.lines.push(toHunkLine("deletion", oldLine, null, line.slice(1)));
      oldLine += 1;
      continue;
    }

    if (marker === " ") {
      current.lines.push(toHunkLine("context", oldLine, newLine, line.slice(1)));
      oldLine += 1;
      newLine += 1;
      continue;
    }

    // Any other prefix ends the hunk body (for example a trailing empty line).
    flush();
  }

  flush();

  return {
    path: expectedPath,
    ...(previousPath !== undefined && previousPath !== expectedPath ? { previousPath } : {}),
    status: "modified",
    isBinary,
    hunks,
  };
}

function toHunkLine(
  kind: DiffHunkLine["kind"],
  oldLineNumber: number | null,
  newLineNumber: number | null,
  text: string,
): DiffHunkLine {
  return { kind, oldLine: oldLineNumber, newLine: newLineNumber, text };
}

function parseHunkHeader(line: string): Omit<DiffHunk, "lines"> | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);

  if (match === null) {
    return null;
  }

  return {
    header: line,
    oldStart: Number.parseInt(match[1]!, 10),
    oldLines: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
    newStart: Number.parseInt(match[3]!, 10),
    newLines: match[4] === undefined ? 1 : Number.parseInt(match[4], 10),
  };
}

function parseDiffPath(rawPath: string): string | null {
  const trimmed = rawPath.split("\t")[0]!.trim();

  if (trimmed === "/dev/null") {
    return null;
  }

  const unquoted = trimmed.startsWith('"') && trimmed.endsWith('"')
    ? JSON.parse(trimmed) as string
    : trimmed;

  return unquoted.replace(/^[ab]\//, "");
}

export type DiffLineRange = { startLine: number; endLine: number };

/** Returns only the hunks overlapping the requested post-image line range. */
export function selectHunksForRange(
  hunks: readonly DiffHunk[],
  range: DiffLineRange | undefined,
): DiffHunk[] {
  if (range === undefined) {
    return [...hunks];
  }

  return hunks.filter((hunk) => {
    const hunkStart = hunk.newStart;
    const hunkEnd = hunk.newStart + Math.max(hunk.newLines, 1) - 1;

    return hunkEnd >= range.startLine && hunkStart <= range.endLine;
  });
}

/**
 * Trims one hunk down to the requested post-image line range.
 *
 * Selecting whole hunks is not enough on its own: a newly added file has a
 * single hunk covering the entire file, so an authored range would "focus" a
 * seven-hundred-line diff on all seven hundred lines. Narrowing keeps a focused
 * diff genuinely focused.
 *
 * Deletions have no post-image line of their own, so each one is anchored to the
 * post-image position it sits immediately before. Returns undefined when nothing
 * in the hunk falls inside the range.
 */
export function narrowHunkToRange(hunk: DiffHunk, range: DiffLineRange): DiffHunk | undefined {
  let oldCursor = hunk.oldStart;
  let newCursor = hunk.newStart;
  const positioned = hunk.lines.map((line) => {
    const position = { oldLine: oldCursor, newLine: newCursor };

    if (line.kind !== "addition") oldCursor += 1;
    if (line.kind !== "deletion") newCursor += 1;

    return { line, position };
  });
  const kept = positioned.filter(
    (entry) => entry.position.newLine >= range.startLine && entry.position.newLine <= range.endLine,
  );

  if (kept.length === 0) {
    return undefined;
  }

  const first = kept[0]!.position;
  const oldLines = kept.filter((entry) => entry.line.kind !== "addition").length;
  const newLines = kept.filter((entry) => entry.line.kind !== "deletion").length;

  return {
    header: `@@ -${first.oldLine},${oldLines} +${first.newLine},${newLines} @@`,
    oldStart: first.oldLine,
    oldLines,
    newStart: first.newLine,
    newLines,
    lines: kept.map((entry) => entry.line),
  };
}
