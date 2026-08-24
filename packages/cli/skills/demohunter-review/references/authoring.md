# DemoHunter Review Authoring Reference

Everything below is imported from `demohunter`:

```ts
import {
  changeSet,
  codeEvidence,
  compatibilityNote,
  componentDiagram,
  coverageGroup,
  dataFlowDiagram,
  defineReview,
  diffEvidence,
  reviewerQuestion,
  risk,
  securityNote,
  sequenceDiagram,
  verificationCommand,
} from "demohunter";
```

`defineReview({ ... })` validates the definition at authoring time and must be the default export.

## Shape

```ts
export default defineReview({
  id: "pr-22-review",          // lowercase slug; also the output directory
  title: "...",
  subtitle: "...",             // optional
  pullRequest: { number: 22, url: "...", author: "...", branch: "..." }, // optional
  problem: { summary, detail?, narration?, inScope?, outOfScope? },
  goals: ["..."],              // optional
  nonGoals: ["..."],           // optional
  decisions: [{ id, title, rationale, alternatives? }],                  // optional
  architecture: [componentDiagram(...), dataFlowDiagram(...), sequenceDiagram(...)],
  reviewOrder: [{ chapterId, why }],
  chapters: [changeSet(...)],  // at least one
  verification: [verificationCommand(...)],
  risks: [risk(...)],
  compatibility: [compatibilityNote(...)],
  security: [securityNote(...)],
  reviewerQuestions: [reviewerQuestion(...)],
  coverage: { groups: [coverageGroup(...)], generatedPatterns?: ["..."] },
  narration: { opening?, closing? },
});
```

## Chapters

```ts
changeSet({
  id: "git-provenance",
  title: "Git provenance",
  intent: "One sentence: what conceptually changed, and why.",
  detail: "Optional second paragraph for the website only.",
  narration: "Spoken prose for the walkthrough.",
  files: ["packages/review/src/git/resolve-comparison.ts"],
  evidence: [diffEvidence({ ... }), codeEvidence({ ... })],
  reviewerChecks: [{ id: "check-merge-base", check: "The merge base is recorded, not the base tip." }],
})
```

- `files` are repository-relative HEAD paths and must exist in the reviewed range.
- `reviewerChecks[].check` is an imperative statement; the first three are narrated.

## Evidence

```ts
diffEvidence({
  id: "resolve-comparison-diff",
  path: "packages/review/src/git/resolve-comparison.ts",
  previousPath: "packages/review/src/git/old-name.ts", // only for renames
  title: "Merge-base resolution",
  note: "What the reviewer should verify in these lines.",
  range: { startLine: 27, endLine: 55 },               // post-image lines; optional
  contextLines: 3,                                     // optional
})

codeEvidence({
  id: "viewer-csp",
  path: "packages/review/src/viewer/render-viewer.ts",
  startLine: 129,
  endLine: 140,
  side: "head",   // or "base"
  title: "Viewer CSP",
  note: "...",
})
```

Both are snapshotted from the exact blobs in the reviewed range and content-addressed with a sha256 anchor. `demohunter review verify` re-resolves them, so a stale range or a moved line range is caught rather than trusted.

Evidence ids must be unique across the whole review.

## Diagrams

Layout is authored, not computed:

```ts
componentDiagram({
  id: "target-architecture",
  title: "Target architecture",
  caption: "Rendered under the diagram.",
  narration: "Spoken instead of the caption when present.",
  nodes: [
    { id: "cli", label: "demohunter review", kind: "module", detail: "argv only", column: 0, row: 0 },
    { id: "git", label: "Git", kind: "external", column: 1, row: 0, changed: true },
  ],
  edges: [{ from: "cli", to: "git", label: "merge-base..HEAD", style: "solid", changed: true }],
})
```

- `kind`: `service | module | store | external | actor | artifact`.
- `column` and `row` are zero-based grid coordinates.
- `changed: true` highlights what this pull request introduced.
- `dataFlowDiagram(...)` takes the same input with flow-oriented styling.

```ts
sequenceDiagram({
  id: "generation-flow",
  title: "Generation flow",
  participants: [{ id: "cli", label: "CLI" }, { id: "git", label: "Git" }],
  messages: [
    { from: "cli", to: "git", label: "resolve merge base" },
    { from: "git", to: "cli", label: "sha", kind: "return" },
    { from: "cli", to: "cli", label: "assert coverage", kind: "note" },
  ],
})
```

Messages render top to bottom in array order. Every `from`/`to` must be a declared participant id.

## Verification

```ts
verificationCommand({
  id: "unit-tests",
  label: "Workspace unit tests",
  command: ["bun", "test", "packages/review"],  // argv, never a shell string
  cwd: "packages/review",                        // optional, relative to repo root
  expectExitCode: 0,                             // optional, defaults to 0
  timeoutMs: 600_000,                            // optional
  rationale: "Why this is meaningful evidence for this change.",
})
```

Commands run only with `--run-verification`. Without it they are recorded as `not-run`, never as passing.

## Coverage

Every changed path must be explained by a chapter or matched by a coverage group:

```ts
coverageGroup({
  id: "tests",
  title: "Tests",
  rationale: "Why grouping these is enough for a reviewer.",
  patterns: ["**/*.test.ts", "tests/**"],
})
```

Patterns support `*`, `**`, and `?` against repository-relative HEAD paths. Chapters win over groups, so an explicitly explained file is never demoted into a bucket. Generation fails when any path is unaccounted for, and also when a chapter or group references a path the pull request never touched.
