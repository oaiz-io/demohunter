# DemoHunter Review CLI Reference

## Supported Commands

```bash
demohunter review init [path] --base <ref> [--head <ref>] [--id <slug>] [--out <path>] [--force]
demohunter review generate <review-file> --base <ref> [--head <ref>] [--run-verification] [--allow-dirty] [--no-video]
demohunter review serve <review-dir-or-id> [--port <number>] [--open]
demohunter review verify <review-dir-or-id> [--strict]
```

`--base` defaults to `main`. `--head` defaults to `HEAD`. Unknown flags are rejected rather than ignored, because a silently dropped `--base` would produce a confident artifact for the wrong range.

The rest of the CLI is unchanged; see the `demohunter` skill for `init`, `generate`, `doctor`, `cache`, and `add-skill`.

## review init

Resolves `merge-base(base, HEAD)..HEAD`, lists the real changed files, and writes a scaffold to `reviews/<id>.review.ts`. Chapters are pre-grouped by directory and every authored field is a `TODO`. The scaffold deliberately contains no shas: generation records them in `review.lock.json` so they cannot drift.

## review generate

1. Validates the definition.
2. Resolves base, head, merge base, and every merge-base candidate.
3. Requires a clean work tree unless `--allow-dirty`.
4. Collects the changed-file set with renames, copies, modes, blob shas, and stats.
5. Fails unless 100% of changed files are accounted for.
6. Snapshots each piece of evidence from the exact blobs.
7. Runs verification commands when `--run-verification` is passed; otherwise records them as `not-run`.
8. Renders the static website, records the narrated walkthrough through the normal DemoHunter pipeline, then re-renders with the video embedded.
9. Writes `review.lock.json` with checksums for every artifact.

Output lands in `.demohunter/reviews/<review-id>/`:

```
index.html          the review website
assets/             viewer.css, viewer.js (no CDN, no remote fonts)
data/review.json    machine-readable view model
diagrams/*.svg      deterministic authored-layout SVG
video.mp4           narrated walkthrough
poster.jpg
captions.srt
captions.vtt
chapters.json
manifest.json       portable DemoHunter manifest with sha256 checksums
audio/              per-segment narration clips
review.lock.json    provenance, coverage, evidence anchors, artifact checksums
```

The directory carries its own `.gitignore`, and so does the narration cache beside it, so a generated review never dirties the work tree.

## review serve

Binds `127.0.0.1` on an ephemeral port unless `--port` is given. GET and HEAD only, no directory listing, Host header pinned to loopback, symlinks and `..` blocked by a realpath containment check, and a strict `Content-Security-Policy`. Range requests are supported so the walkthrough seeks properly.

## review verify

Recomputes everything the artifact claims instead of trusting it:

- lock parses against its schema
- HEAD, base, merge base, and merge-base candidates still match (`stale-*` failures otherwise)
- every recorded artifact checksum matches on disk
- the video has both a video and an audio stream, and the recorded duration matches ffprobe
- captions and chapters exist, are well-formed, and match the recorded narration count
- the DemoHunter manifest validates and its checksums match
- the changed-file set still matches Git exactly, and coverage is still 100%
- every evidence anchor still resolves to the recorded blobs

`--strict` additionally requires passing verification results and a clean work tree. A failing verify exits non-zero.

## Verification Flow

From the repository root:

```bash
demohunter review generate reviews/<id>.review.ts --base main --run-verification
demohunter review verify .demohunter/reviews/<id> --strict
demohunter review serve .demohunter/reviews/<id> --open
```

Do not reference unimplemented commands, hosted workflows, or a GitHub integration. There is none.
