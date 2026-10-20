# Capture bundles and BYOK migration

## Scope
Keep each immutable capture in a deterministic ZIP bundle. Keep edits, narration,
comments, scenes and audio separate. Preserve capture identity and all edits.
Do not implement UI change detection or recapture rebasing.

## Tasks
1. Add a versioned bundle reader/writer and explicit `studio pack` migration.
   Integrate capture, discovery, preview, MCP inspection, agents and export.
   New captures use bundles. Keep v1 projects readable. Generate inspection HTML
   in memory for bundled projects. Verify identity, corruption, missing LFS data,
   hostile paths, deterministic packing and edit preservation.
2. Verify Studio typecheck, tests, builds and real BYOK rendering before/after.
   Update the format, CLI and agent documentation. Commit and push the existing
   DemoHunter branch without including the user's library changes.
3. Pack the existing BYOK capture, retain authored content, move capture/audio
   and the master film to LFS, and remove inspection files and duplicate master
   output from normal Git. Keep public website assets usable by its current
   deployment. Back up the old branch tip locally, replace its two feature
   commits with the final source and LFS pointers, verify LFS and PR contents,
   and push with an exact lease. Do not change either branch name.

## Verification
- Compare capture bytes, IDs, editable files and real replay frames.
- Check Git LFS objects locally and after upload; check a fresh clone.
- Check the exact pushed heads and CI; report unrelated failures separately.
