# Inspecting a Generated Review

Generating is not the deliverable. An artifact that looks fine but explains the change wrongly is worse than no artifact at all, so inspect before you hand it over.

## 1. Re-derive it from Git

```bash
demohunter review verify .demohunter/reviews/<id> --strict
```

Read every line. Common failures and what they mean:

| Check | Meaning | Fix |
| --- | --- | --- |
| `stale-head-moved` | You committed after generating. | Regenerate against the new HEAD. |
| `stale-merge-base-moved` | The base branch moved under you. | Fetch the base and regenerate. |
| `coverage-file-set` | The diff no longer matches the artifact. | Regenerate; then re-account for new files. |
| `evidence-anchor:<id>` | A snapshot no longer matches the blob it came from. | Regenerate; if it persists, the evidence points at the wrong range. |
| `artifact-checksum:<path>` | A file in the artifact was edited by hand. | Never hand-edit the artifact. Regenerate. |
| `video-audio-stream` | The walkthrough has no narration track. | Check the narration cache or the TTS provider key. |
| `captions-cues` | Caption count does not match the narration count. | Regenerate; a failed narration segment usually explains it. |
| `verification` | Commands were declared but never run, or failed. | Rerun with `--run-verification` and fix the failures. |

## 2. Read the website

```bash
demohunter review serve .demohunter/reviews/<id> --open
```

Check, in order:

- **Masthead facts.** Base, merge base, head, changed-file count, coverage, verification status, worktree state. If any of these surprises you, the review is describing something other than what you think.
- **Warning banners.** Multiple merge-base candidates, a merge commit at HEAD, or a dirty tree each get a banner. Resolve the cause rather than shipping the banner.
- **Diagrams.** Nodes must not overlap or collide with edge labels. Labels are truncated past ~26 characters, so shorten them in the definition rather than letting them clip. Every node that this pull request touched should carry `changed: true`.
- **Focused diffs.** Each one should be small enough to read on screen and should show the change you described, not the whole file. If a diff renders "Showing N of M hunks", confirm the omitted hunks really are accounted for elsewhere.
- **Coverage table.** It must read 100%. Skim the "Accounted by" column for files parked in a group that actually deserve an explanation.
- **Verification output.** Real exit codes, not `not-run`.

## 3. Watch the walkthrough

Play `video.mp4` from the site, not just the file:

- Audio is present and audible for the whole runtime.
- Captions track the narration.
- Chapter buttons seek to the right sections.
- The page is fully rendered in frame; nothing is captured mid-scroll or half-loaded.
- Narration matches what is on screen at that moment.

`ffprobe -v error -show_streams -show_format -of json .demohunter/reviews/<id>/video.mp4` confirms the audio stream and duration without opening a player.

## 4. Fix and regenerate

Any fix to the definition, and any commit, invalidates the artifact. Regenerate and verify again. Only stop when:

```
artifact.headSha  === the head you are asking someone to review
artifact.mergeBaseSha === the real merge base
coverage          === 100%
verification      === passed
worktree          === clean
```
