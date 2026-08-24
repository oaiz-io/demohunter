import type { ChangedFile, GitComparison } from "../git/git-types.js";
import { collectChangedFiles } from "../git/collect-changed-files.js";
import { resolveComparison } from "../git/resolve-comparison.js";
import type { RunGit } from "../git/run-git.js";

export type ScaffoldReviewInput = {
  runGit: RunGit;
  baseRef: string;
  headRef?: string;
  /** Review id. Defaults to a slug derived from the head ref. */
  id?: string;
  title?: string;
};

export type ScaffoldReviewResult = {
  id: string;
  title: string;
  contents: string;
  comparison: GitComparison;
  changedFiles: ChangedFile[];
  /** Chapter stubs the scaffold pre-grouped, in file order. */
  chapterGroups: Array<{ id: string; title: string; paths: string[] }>;
};

const TEST_PATTERNS = ["**/*.test.ts", "**/*.test.tsx", "tests/**", "**/__tests__/**"];
const DOC_PATTERNS = ["**/*.md", "docs/**"];
const CONFIG_PATTERNS = [
  "**/package.json",
  "**/tsconfig*.json",
  "**/bun.lock",
  "**/*.config.ts",
  ".github/**",
];

/**
 * Produces a starter `*.review.ts` grounded in the real diff.
 *
 * The scaffold never guesses intent: chapters are pre-grouped by directory and
 * every field an agent must replace is written as an explicit TODO. The changed
 * files are listed verbatim from Git so the author starts from the true set
 * rather than from memory.
 */
export async function scaffoldReview(input: ScaffoldReviewInput): Promise<ScaffoldReviewResult> {
  const comparison = await resolveComparison({
    runGit: input.runGit,
    baseRef: input.baseRef,
    ...(input.headRef === undefined ? {} : { headRef: input.headRef }),
  });
  const changedFiles = await collectChangedFiles({
    runGit: input.runGit,
    mergeBaseSha: comparison.mergeBaseSha,
    headSha: comparison.headSha,
  });

  if (changedFiles.length === 0) {
    throw new Error(
      `No files changed between ${comparison.baseRef} (merge base ${comparison.mergeBaseSha.slice(0, 12)}) `
        + `and ${comparison.headRef} (${comparison.headSha.slice(0, 12)}). There is nothing to review yet.`,
    );
  }

  const id = input.id ?? deriveReviewId(comparison, await readCurrentBranch(input.runGit));
  const title = input.title ?? `Review of ${comparison.headRef}`;
  const grouped = groupChangedFiles(changedFiles);

  return {
    id,
    title,
    comparison,
    changedFiles,
    chapterGroups: grouped,
    contents: renderReviewScaffold({ id, title, comparison, changedFiles, groups: grouped }),
  };
}

/**
 * Names the review after the branch under review.
 *
 * `--head` defaults to the literal `HEAD`, which would produce a useless
 * `head-review` id, so the checked-out branch name is used when one is
 * available. A detached HEAD falls back to a generic slug rather than to a sha,
 * which would make the id change on every commit.
 */
export function deriveReviewId(comparison: GitComparison, currentBranch?: string): string {
  const source = comparison.headRef === "HEAD" ? currentBranch ?? "" : comparison.headRef;
  const slug = toSlug(source);

  return slug.length === 0 || slug === "head" ? "pr-review" : `${slug}-review`;
}

async function readCurrentBranch(runGit: RunGit): Promise<string | undefined> {
  const branch = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim();

  return branch === "" || branch === "HEAD" ? undefined : branch;
}

/**
 * Buckets changed paths into candidate chapters.
 *
 * Grouping is by the first two path segments, which lines up with how this
 * workspace (and most monorepos) separates concerns. Support files land in
 * coverage groups instead so the chapter stubs stay about product behaviour.
 */
export function groupChangedFiles(
  changedFiles: readonly ChangedFile[],
): Array<{ id: string; title: string; paths: string[] }> {
  const buckets = new Map<string, string[]>();

  for (const file of changedFiles) {
    if (matchesAny(file.path, [...TEST_PATTERNS, ...DOC_PATTERNS, ...CONFIG_PATTERNS])) {
      continue;
    }

    const key = bucketKeyFor(file.path);
    const bucket = buckets.get(key);

    if (bucket === undefined) {
      buckets.set(key, [file.path]);
      continue;
    }

    bucket.push(file.path);
  }

  return [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, paths]) => ({
      id: toSlug(key) || "changes",
      title: key,
      paths: [...paths].sort(),
    }));
}

function bucketKeyFor(filePath: string): string {
  const segments = filePath.split("/");

  if (segments.length === 1) {
    return "repository root";
  }

  return segments.slice(0, Math.min(2, segments.length - 1)).join("/");
}

function renderReviewScaffold(input: {
  id: string;
  title: string;
  comparison: GitComparison;
  changedFiles: readonly ChangedFile[];
  groups: ReadonlyArray<{ id: string; title: string; paths: string[] }>;
}): string {
  const chapters = input.groups.length === 0
    ? [{ id: "changes", title: "Changes", paths: input.changedFiles.map((file) => file.path) }]
    : input.groups;

  return `${renderHeaderComment(input)}
import {
  changeSet,
  componentDiagram,
  coverageGroup,
  defineReview,
  diffEvidence,
  reviewerQuestion,
  risk,
  securityNote,
  sequenceDiagram,
  verificationCommand,
} from "demohunter";

export default defineReview({
  id: ${quote(input.id)},
  title: ${quote(input.title)},
  subtitle: "TODO: one line a reviewer can read in two seconds",
  problem: {
    summary: "TODO: state the problem this pull request solves, in one sentence.",
    detail: "TODO: why it matters now, and what a reviewer should hold in mind.",
    inScope: ["TODO: what this change covers"],
    outOfScope: ["TODO: what it deliberately does not cover"],
  },
  goals: ["TODO: the outcome this change is judged on"],
  nonGoals: ["TODO: a tempting scope expansion that was left out"],
  architecture: [
    componentDiagram({
      id: "target-architecture",
      title: "Target architecture",
      caption: "TODO: what a reviewer should take away from this diagram.",
      nodes: [
        { id: "caller", label: "TODO caller", kind: "actor", column: 0, row: 0 },
        { id: "unit", label: "TODO changed unit", kind: "module", column: 1, row: 0, changed: true },
      ],
      edges: [{ from: "caller", to: "unit", label: "TODO", changed: true }],
    }),
    sequenceDiagram({
      id: "primary-flow",
      title: "Primary flow",
      caption: "TODO: the order of operations this change introduces.",
      participants: [
        { id: "caller", label: "TODO caller" },
        { id: "unit", label: "TODO changed unit" },
      ],
      messages: [
        { from: "caller", to: "unit", label: "TODO request" },
        { from: "unit", to: "caller", label: "TODO result", kind: "return" },
      ],
    }),
  ],
  reviewOrder: [
${chapters.map((chapter) => `    { chapterId: ${quote(chapter.id)}, why: "TODO: why read this first" },`).join("\n")}
  ],
  chapters: [
${chapters.map(renderChapter).join("\n")}
  ],
  verification: [
    verificationCommand({
      id: "tests",
      label: "TODO: what this command proves",
      command: ["bun", "test"],
      rationale: "TODO: why this is meaningful evidence for this change.",
    }),
  ],
  risks: [
    risk({
      id: "todo-risk",
      title: "TODO: what could go wrong",
      severity: "low",
      detail: "TODO: the failure mode.",
      mitigation: "TODO: what limits the blast radius.",
    }),
  ],
  security: [
    securityNote({
      id: "todo-security",
      title: "TODO: boundary this change touches",
      detail: "TODO: how it is enforced.",
    }),
  ],
  reviewerQuestions: [
    reviewerQuestion({
      id: "todo-question",
      question: "TODO: the decision you actually want a second opinion on.",
    }),
  ],
  coverage: {
    groups: [
      coverageGroup({
        id: "tests",
        title: "Tests",
        rationale: "Test files are reviewed together with the behaviour they cover.",
        patterns: ${renderStringArray(TEST_PATTERNS, 8)},
      }),
      coverageGroup({
        id: "docs",
        title: "Docs",
        rationale: "Documentation updates follow the behaviour described above.",
        patterns: ${renderStringArray(DOC_PATTERNS, 8)},
      }),
      coverageGroup({
        id: "config",
        title: "Build and config",
        rationale: "Workspace wiring that follows mechanically from the new code.",
        patterns: ${renderStringArray(CONFIG_PATTERNS, 8)},
      }),
    ],
  },
  narration: {
    closing: "TODO: the one thing you want the reviewer to check first.",
  },
});
`;
}

function renderChapter(chapter: { id: string; title: string; paths: string[] }): string {
  const firstTextPath = chapter.paths[0] ?? "";

  return `    changeSet({
      id: ${quote(chapter.id)},
      title: ${quote(chapter.title)},
      intent: "TODO: what conceptually changed here, and why.",
      narration: "TODO: the spoken version of the intent, one or two sentences.",
      files: ${renderStringArray(chapter.paths, 6)},
      evidence: [
        diffEvidence({
          id: ${quote(`${chapter.id}-diff`)},
          path: ${quote(firstTextPath)},
          title: "TODO: what this diff shows",
          note: "TODO: what the reviewer should verify in these lines.",
        }),
      ],
      reviewerChecks: [
        { id: ${quote(`${chapter.id}-check`)}, check: "TODO: the property a reviewer should confirm." },
      ],
    }),`;
}

function renderHeaderComment(input: {
  comparison: GitComparison;
  changedFiles: readonly ChangedFile[];
}): string {
  const lines = input.changedFiles.map(
    (file) =>
      ` * ${file.status.padEnd(12)} ${file.path}`
      + (file.previousPath === undefined ? "" : ` (from ${file.previousPath})`)
      + (file.isBinary ? " [binary]" : ` +${file.insertions}/-${file.deletions}`),
  );

  return `/**
 * DemoHunter Review definition, scaffolded from the live diff.
 *
 * Range: ${input.comparison.baseRef} -> ${input.comparison.headRef}
 * Files: ${input.changedFiles.length}
 *
 * Every TODO below must be replaced with something you verified by reading the
 * diff. Every changed file has to end up in a chapter or a coverage group, or
 * "demohunter review generate" fails rather than shipping a partial story.
 *
 * Changed files in this range:
${lines.join("\n")}
 *
 * The shas are deliberately not written here: generation records them in
 * review.lock.json so they can never drift out of sync with this file.
 */`;
}

function matchesAny(candidate: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(candidate));
}

function globToRegExp(pattern: string): RegExp {
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

    source += char.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
  }

  return new RegExp(`^${source}$`);
}

function renderStringArray(values: readonly string[], indent: number): string {
  if (values.length === 0) {
    return "[]";
  }

  const pad = " ".repeat(indent);

  return `[\n${values.map((value) => `${pad}  ${quote(value)},`).join("\n")}\n${pad}]`;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
