---
name: demohunter-review
description: Turn a large pull request into a local DemoHunter Review artifact — a typed `*.review.ts` definition, a static review website, and a narrated walkthrough — grounded in the real merge-base..HEAD diff with 100% changed-file accounting.
---

# DemoHunter Review Skill

Use this skill when a reviewer needs to understand a large or structural pull request and reading the raw diff top to bottom would not explain it.

The deliverable is one `*.review.ts` file plus the artifact generated from it. Everything a reviewer sees is derived from that single definition and from Git. Nothing is fetched at runtime, no cloud service is involved, and no model runs while the artifact is being built.

## Workflow

1. **Read the real diff first.** Never write the review from memory or from the branch name.
   ```bash
   git merge-base <base> HEAD
   git diff --stat $(git merge-base <base> HEAD)..HEAD
   git diff $(git merge-base <base> HEAD)..HEAD -- <path>
   ```
2. **Scaffold from the diff**, so the changed-file inventory is the real one:
   ```bash
   demohunter review init --base <base>
   ```
3. **Author the review.** Read [references/authoring.md](references/authoring.md) for the component surface and [assets/pr.review.template.ts](assets/pr.review.template.ts) for a filled-in shape. Replace every `TODO`.
4. **Account for every changed file.** Each path goes in a chapter's `files` or matches a `coverageGroup` pattern. Generation fails on the first unaccounted path.
5. **Capture real verification.** Declare the commands you actually ran as argv arrays and generate with `--run-verification`, so the recorded exit codes are real.
6. **Generate, on a clean tree:**
   ```bash
   demohunter review generate reviews/<id>.review.ts --base <base> --run-verification
   ```
7. **Inspect what you produced.** Read [references/inspection.md](references/inspection.md). Serve the site, open it, watch the walkthrough, then re-derive it from Git:
   ```bash
   demohunter review serve .demohunter/reviews/<id> --open
   demohunter review verify .demohunter/reviews/<id> --strict
   ```
8. **Fix anything misleading or visually broken, then regenerate.** A wrong explanation is worse than no explanation.

## Rules

- Ground every claim in the diff. If you cannot point at a hunk, do not assert it.
- Never invent shas, file lists, line ranges, or verification results. The generator records the real ones and `review verify` recomputes them.
- Evidence must point at paths that are actually in `merge-base(base, HEAD)..HEAD`. Binary files, submodules, and mode-only changes have no reviewable hunks — account for them in a coverage group.
- Keep `intent` about *what conceptually changed and why*, not about which lines moved. The diff already shows the lines.
- Write `narration` as spoken prose. It is read aloud by TTS, so avoid paths, punctuation-heavy code, and bare shas.
- Diagram layout is authored: every node carries an explicit `column`/`row`, and sequence messages render in array order. Mark changed nodes and edges with `changed: true`.
- Regenerate after every commit that changes the range. The artifact pins exact shas and `review verify` fails as soon as HEAD moves.
- Generate from a clean work tree. `--allow-dirty` produces a clearly-marked draft and fails `--strict` verification.
- Do not add cloud calls, GitHub API calls, CDN assets, remote diagram services, telemetry, or runtime model calls. The viewer must work with the network unplugged.

## Deliverable

- one `*.review.ts` file with 100% changed-file coverage
- a generated artifact under `.demohunter/reviews/<id>/` containing `index.html`, `review.lock.json`, and (unless `--no-video`) `video.mp4`, `captions.srt`, `captions.vtt`, `chapters.json`
- the exact commands you ran, and the `demohunter review verify` result
