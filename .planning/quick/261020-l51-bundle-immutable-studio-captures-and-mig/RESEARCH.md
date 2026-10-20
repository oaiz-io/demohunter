# Capture storage research

- The BYOK film stored 6,792 generated HTML inspection files and two recording
  JSON files with 347,938 lines. Authored edits and scenes are separate already.
- Keep raw event bytes and the frozen index together to preserve capture IDs
  and references. Keep all authored files outside the archive.
- Use deterministic ZIP entries with pinned fflate 0.8.3. Validate paths, entry
  counts, expanded sizes, archive checksum and recording/index identity before
  using data. Read entries in memory; do not extract project-controlled paths.
- Build inspection HTML only for the requested element and use its frozen refs.
- Git LFS stores small text pointers and transfers full versions of changed
  objects. Keep narration segments separate so one edit replaces one segment.
  Keep cue JSON and other editable metadata in normal Git.
- Source of the format decision: apps/studio/FORMAT.md.

References:
- https://github.com/101arrowz/fflate/blob/master/README.md
- https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-git-large-file-storage
- https://docs.github.com/en/billing/concepts/product-billing/git-lfs
