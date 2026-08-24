# DemoHunter Review Troubleshooting

## `The work tree is not clean`

A review artifact records exact commit shas, so generating from a dirty tree would describe code that is in no commit. Commit or stash, then rerun. `--allow-dirty` produces a clearly-marked draft that fails `--strict` verification.

## `Review coverage is incomplete (N/M changed files accounted for)`

The error lists every unaccounted path. Add each one to a chapter's `files`, or match it with a `coverageGroup`. The same error also fires in reverse: if a chapter or group references a path that is not in `merge-base(base, HEAD)..HEAD`, generation fails rather than rendering a file list that does not exist.

## `Diff evidence "<id>" points at <path>, which is not part of merge-base..HEAD`

The path is misspelled, was renamed (pass the HEAD path, not the old one), or the range is wrong. Check with:

```bash
git diff --name-status $(git merge-base <base> HEAD)..HEAD
```

## `Diff evidence "<id>" selected no hunks`

The authored `range` does not overlap any hunk, or the file only changed mode. Widen or remove the range. Mode-only, binary, and submodule changes have no reviewable hunks — account for them in a coverage group.

## `Code evidence "<id>" starts at line N, but <path> has only M lines`

`codeEvidence` line numbers are one-based and refer to the file as it exists on the requested `side` (`head` by default, `base` for the pre-image).

## `No merge base between <base> and HEAD`

The base branch is not present locally. `git fetch origin <base>` and rerun. In a shallow clone, deepen it first: `git fetch --unshallow`.

## `Could not resolve "<ref>" to a commit`

Pass an existing branch, tag, or sha. Remote-only branches need `origin/<name>` or a fetch first.

## Multiple merge-base candidates

The website shows a banner and `review.lock.json` records every candidate. The lowest sorted candidate is used so the range never depends on Git's traversal order. Merge the base into the branch (or rebase) if the ambiguity matters.

## `ffprobe found no audio stream`

Narration did not resolve. Either the narration cache is missing entries and no provider key is exported, or the provider call failed. Check `OPENAI_API_KEY` / `ELEVENLABS_API_KEY`, or run `demohunter cache list` to confirm the cache is populated. Regeneration is fully offline when every narration line is already cached.

## `Could not read chapters.json` / caption cue mismatch

The recording pass ended early. Rerun `demohunter review generate`; the underlying failure is usually reported above the caption check in the generate log.

## Video recording fails to start

The walkthrough is recorded through the normal DemoHunter pipeline, so it needs Chromium and `ffmpeg`/`ffprobe`:

```bash
npx playwright install chromium
demohunter doctor
```

## Port already in use

`demohunter review serve` binds an ephemeral port by default. Pass `--port 0` explicitly, or a free port. The server only ever binds `127.0.0.1`.

## The served page looks unstyled

Open it through `demohunter review serve`, not with `file://` plus a proxy. The viewer ships its own CSS and JS under `assets/` and loads nothing from a network, so a missing stylesheet means the artifact is incomplete — verify it and regenerate.
