---
quick_id: 261016-moj
status: complete
---

# Restore direct visual editing

## Loop 1: portable edits and safe persistence
- [x] Extend validated element targets for scene files and add position/scale geometry. Share targeted element mutation logic across the UI and MCP.
- [x] Add a revision-checked API, preserving unrelated agent changes and tracked undo. Regenerate schemas from model source.
- [x] Verify target validation, persistence, reset, external-edit conflicts and undo with focused tests.

## Loop 2: direct editor and canvas interaction
- [x] Add an Edit panel and a contextual Edit action. Pick captured elements and visible scene/overlay elements.
- [x] Add drag, corner resize, arrow nudges, text/color/size/opacity controls, hide/remove/restore/reset, and an element list. Show live changes and save them to disk.
- [x] Keep stable handles, convert screen movement to document pixels, and save once per gesture. Preserve drafts on revision conflicts.

## Loop 3: browser verification and refinement
- [x] Exercise real pointer drags/resizes, fields, hiding/restoring, scene selection, revision conflicts, reload/seek, agent edits and undo in a temporary captured project.
- [x] Check edited screenshots/rendering and desktop/mobile layout. Fix findings and repeat focused checks, then run appropriate Studio/root checks.
- [x] Update README, format/architecture notes and bundled agent guide to explain direct editing and disk persistence. Preserve unrelated desktop work and user demo files; do not restart the user's service.
