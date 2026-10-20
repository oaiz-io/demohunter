---
quick_id: 261016-moj
status: complete
---

# Direct element editing restored

Studio now has an Edit panel and contextual Edit action. Select recorded DOM, HTML scene or overlay elements, drag to move, resize from corners, nudge with arrow keys, and change text, foreground/background colors, font size, opacity, dimensions and scale. Hide preserves layout; Remove closes the space. Hidden elements remain in the searchable element list. Restore and Reset edits are reversible.

All edits are portable overrides in edits.json. The targeted HTTP endpoint and MCP apply_element_edit share patch semantics, validation, revision checks, locking and undo. Geometry is additive to authored transforms. Scene targets use their source file and a deterministic selector. Live overrides preserve rrweb text nodes, restore prior values and apply after scene seeking; screenshot and video export use the same player. Pending drafts remain available after external changes and require an explicit conflict choice. Export flushes pending edits.

The work followed research, plan, implementation and test loops. See RESEARCH.md for findings and corrections. README, format, architecture, JSON schema and the bundled agent guide now describe the feature.

## Verification

- Full `bun run verify` with Bun 1.4.3: build and Studio typecheck passed; 369 tests passed, 1 live ElevenLabs test skipped, 0 failed.
- Final browser regression after draft-switch review: passed, 22 assertions. It covers direct gestures with camera zoom, text/color saves, reload/seek, source-node mutations, scenes, visibility/reset/undo, conflicts, multiple drafts, inline text, shared export rendering and narrow layout.
- Real stdio MCP and persistence tests passed, including scene targets, partial geometry, reset and revision conflicts.
- Final Studio typecheck and git diff whitespace check passed.
- Visual checks: .context/direct-edit.png (editor) and .context/direct-edit-export.png (shared renderer).

Existing desktop app changes and demo files remain outside this task. The user's Studio service was not started, stopped, restarted or deployed. Restart the service manually to load the changed application bundle; project edits then refresh automatically.
