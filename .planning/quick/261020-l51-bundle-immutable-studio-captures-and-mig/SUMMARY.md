---
status: complete
---
# Capture bundles and BYOK migration

## Delivered
- Studio v2 stores immutable events, captured assets and frozen element refs in
  one checksummed ZIP. v1 remains readable; `studio pack` migrates explicitly.
- New captures use v2. Preview, export, library discovery, agent context, MCP
  inspection and schema discovery support bundles. Inspection creates no files.
- Authored edits, narration, comments, scenes and media remain separate.
- Code commit: `28b8cd6` on `t3code/research-editable-demo-capture`.
- OAIZ commit: `87420b0c1cc2e60192b86aa9e24986b314d29c70` on
  `feat/byok-feature-demo-and-docs`, pushed with an exact lease.
- Film tracked files: 6,900 -> 77. PR: 6,922 -> 99 files and
  390,486 -> 4,894 added lines. Capture bundle: 1,375,232 bytes.
- 29 required LFS objects (capture, 27 audio files, master video). Cue JSON stays
  readable. Original master bytes and all website source/assets are unchanged.
- Original OAIZ tip retained locally at refs/backup/byok-before-lfs-20261020.
- The three pre-existing dirty Studio files retain the exact user changes;
  these changes and their separate quick-task folder are not committed here.

## Checks
- Bun 1.4.3 full verify: build/typecheck passed; 467 tests passed, one live
  ElevenLabs test skipped, zero failures. Final bundle/MCP tests: 16 passed.
  Final capture/export tests: eight passed. Final typecheck passed.
- BYOK: 65 project file hashes, three HTML fragments, capture/index identity,
  revision and five frames match before/after migration.
- Full 116.6-second 1080p30 strict-audio export passed, with no omitted audio.
- Fresh remote sparse clone: all 29 LFS objects and checked-out files match their
  SHA-256; five replay frames and 65 project hashes match the original. Clean
  checkout. Source repository `git lfs fsck --objects` passed. Full LFS fsck in
  the partial clone cannot inspect a non-downloaded ordinary Git blob, so the
  clone check verifies each required downloaded LFS object directly by hash.
- OAIZ website docs tests: 29 passed. Website format check passed. Website source
  and deployment assets are unchanged by this storage migration.
- No automatic change detection or override transfer across recapture added.

## Limits
Older desktop builds reject v2. Use the updated Studio branch or a desktop build
made from it. Hosted CI results are separate from the local checks above.
