# DemoHunter Review

DemoHunter Review turns a large pull request into a local, narrated review artifact: a static website plus a walkthrough video, both rendered from one typed definition and grounded in the real Git diff.

It runs entirely on your machine. No cloud backend, no GitHub API, no CDN assets, no telemetry, and no model calls at generation time or at view time.

## The loop

```sh
npx demohunter review init --base main
# edit reviews/<id>.review.ts
npx demohunter review generate reviews/<id>.review.ts --base main --run-verification
npx demohunter review serve .demohunter/reviews/<id> --open
npx demohunter review verify .demohunter/reviews/<id> --strict
```

`--base` defaults to `main` and `--head` defaults to `HEAD`. The reviewed range is always `merge-base(base, HEAD) → HEAD`, which is the same range a pull request shows.

## What a review definition looks like

```ts
// reviews/pr-22.review.ts
import {
  changeSet,
  componentDiagram,
  coverageGroup,
  defineReview,
  diffEvidence,
  reviewerQuestion,
  risk,
  sequenceDiagram,
  verificationCommand,
} from "demohunter";

export default defineReview({
  id: "pr-22-review",
  title: "Retry failed checkout captures",
  problem: {
    summary: "Transient gateway timeouts left orders paid but unconfirmed.",
    inScope: ["The capture call and its retry policy"],
    outOfScope: ["Refunds"],
  },
  architecture: [
    componentDiagram({
      id: "capture-path",
      title: "Capture path",
      nodes: [
        { id: "checkout", label: "Checkout service", kind: "service", column: 0, row: 0 },
        { id: "retry", label: "Capture retry", kind: "module", column: 1, row: 0, changed: true },
      ],
      edges: [{ from: "checkout", to: "retry", label: "capture(order)", changed: true }],
    }),
    sequenceDiagram({
      id: "retry-sequence",
      title: "Retry sequence",
      participants: [{ id: "retry", label: "Capture retry" }, { id: "gateway", label: "Gateway" }],
      messages: [
        { from: "retry", to: "gateway", label: "attempt 1" },
        { from: "gateway", to: "retry", label: "timeout", kind: "return" },
      ],
    }),
  ],
  reviewOrder: [{ chapterId: "retry-policy", why: "It defines what counts as retryable." }],
  chapters: [
    changeSet({
      id: "retry-policy",
      title: "Retry policy",
      intent: "Adds a bounded retry that only fires on transport timeouts.",
      narration: "The retry policy is deliberately narrow. It retries transport timeouts up to three times.",
      files: ["src/checkout/capture-retry.ts"],
      evidence: [
        diffEvidence({
          id: "retry-policy-diff",
          path: "src/checkout/capture-retry.ts",
          note: "Confirm a declined card is not classified as retryable.",
        }),
      ],
      reviewerChecks: [{ id: "only-timeouts", check: "Only transport timeouts are retried." }],
    }),
  ],
  verification: [
    verificationCommand({
      id: "unit",
      label: "Checkout unit tests",
      command: ["npm", "test", "--", "src/checkout"],
    }),
  ],
  risks: [
    risk({ id: "latency", title: "Worst-case latency grows", severity: "medium", detail: "Three attempts add ~600ms." }),
  ],
  reviewerQuestions: [
    reviewerQuestion({ id: "attempts", question: "Is three attempts the right bound?" }),
  ],
  coverage: {
    groups: [
      coverageGroup({
        id: "tests",
        title: "Tests",
        rationale: "Reviewed together with the behaviour they cover.",
        patterns: ["**/*.test.ts", "tests/**"],
      }),
    ],
  },
});
```

The website and the video are two projections of this one definition, so they cannot drift apart.

## Git provenance

Generation records exact facts, never inferred ones:

- `baseSha`, `headSha`, `mergeBaseSha`, and every merge-base candidate Git reported
- whether HEAD is a merge commit, and its parents
- every changed path with status, rename/copy similarity, insertions, deletions, old and new file modes, and full old and new blob shas
- whether each path is binary, a submodule, mode-only, or matched a generated-file pattern
- the work-tree status at generation time

Displayed evidence is snapshotted from those exact blobs and content-addressed with a sha256 anchor covering both provenance and the rendered text.

## 100% changed-file accounting

Every path in the range must be explained by a chapter or matched by a coverage group. Generation fails, listing the offenders, when:

- a changed path has no owner, or
- a chapter or group references a path that is not in the range.

Chapters win over groups, so an explicitly explained file is never silently demoted into a bucket.

## Verification

Verification commands are argv arrays, so no shell is involved. They run only with `--run-verification`; otherwise they are recorded as `not-run` rather than reported as passing.

## Output

```
.demohunter/reviews/<review-id>/
  index.html          the review website
  assets/             viewer.css, viewer.js — no CDN, no remote fonts
  data/review.json    machine-readable view model
  diagrams/*.svg      deterministic, authored-layout SVG
  video.mp4           narrated walkthrough
  poster.jpg
  captions.srt
  captions.vtt
  chapters.json
  manifest.json       portable DemoHunter manifest with sha256 checksums
  audio/              per-segment narration clips
  review.lock.json    provenance, coverage, evidence anchors, artifact checksums
```

The directory carries its own `.gitignore`, and so does the narration cache beside it, so a generated review never dirties the work tree it describes.

## Serving

`demohunter review serve` binds `127.0.0.1` only, on an ephemeral port unless you pass `--port`. It answers GET and HEAD only, never lists directories, pins the `Host` header to loopback against DNS rebinding, blocks `..` traversal and symlinks that escape the review root with a realpath containment check, and sends a strict `Content-Security-Policy` (`default-src 'none'`, `connect-src 'none'`). Range requests are supported so the walkthrough seeks properly.

## Verifying an artifact

`demohunter review verify` re-derives everything the artifact claims:

| Check | What it proves |
| --- | --- |
| `lock` | `review.lock.json` still matches its schema |
| `stale` | HEAD, base, merge base, and the candidate set are unchanged |
| `artifact` | every recorded checksum matches; the video has video **and** audio streams; captions, chapters, and the portable manifest are well-formed and consistent |
| `coverage` | the changed-file set still matches Git exactly, and coverage is still 100% |
| `evidence` | every anchor still resolves to the recorded blobs |
| `verification` | commands actually ran and passed |
| `worktree` | the tree was clean at generation time, and is clean now |

`--strict` promotes the verification and work-tree warnings to failures. A failing verify exits non-zero.

## Agent skill

```sh
npx demohunter add-skill            # installs demohunter and demohunter-review
```

The `demohunter-review` skill teaches an agent to read the actual diff, identify conceptual changes, author diagrams and focused evidence, account for every file, capture real verification results, generate the artifact, inspect it, and fix anything misleading before handing it over.

## Requirements

The walkthrough is recorded through the normal DemoHunter pipeline, so it needs Chromium plus `ffmpeg` and `ffprobe`, and narration resolves from the local cache or from your configured TTS provider. Use `--no-video` to build only the website when a recording environment is unavailable.
