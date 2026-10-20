---
quick_id: 261015-ms5
status: complete
date: 2026-10-15
---

# Clear comment IDs and agent links

- Each note shows its stable ID with click-to-copy, Copy link and always-visible Copy for agent. Double-clicking note text copies its agent context. Card pins are buttons.
- Comment URI and HTTP links identify the exact thread. MCP resolve_reference accepts both links and bare comment IDs, returns replies/status/time and optional element HTML, and keeps capture boundaries. Notes without an element and resolved notes are supported.
- Opening a note selects the correct Open/Resolved filter and clears scene-only filtering. Canvas pins now keep their DOM nodes across animation frames: replacing them each frame had prevented reliable clicks.
- Documentation and bundled agent guidance updated.

## Verification

- Studio typecheck passed. Studio suite on Bun 1.4.3: 22 passed, 0 failed, 230 assertions across 8 files. Includes actual browser copy buttons/double-click, canvas/card/timeline pin clicks, fresh links to open/resolved notes, real stdio MCP comment resolution, capture/export and mobile layout.
- Browser review of an isolated copy of the invoice recording at 1440x900 and 390x844: no page errors or horizontal overflow. Also opened a resolved note and an unanchored note through fresh links. Screenshots in .context/comment-links-desktop.png and .context/comment-links-mobile.png.
- Existing user recordings were preserved. Existing dirty files were preserved; changes remain uncommitted with the prior Studio work instead of including unrelated edits in a quick-task commit.
