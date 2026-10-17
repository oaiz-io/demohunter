---
quick_id: 261016-txt
status: complete
---

# Inline canvas text editing

Double-clicking text on the canvas now opens an editor over that text. This works for recorded DOM, HTML scenes and overlays. The editor is a shadow-DOM textarea (or input) inside the element's own frame, so it uses the page's fonts, layout and the preview/camera scale. It copies font, size, weight, style, line height, letter and word spacing, decoration, colour, alignment, padding, width and wrapping. It also corrects for half-leading, vertically centred buttons/cells and flex text. The real element's glyphs are hidden while it live-updates and reflows underneath. Text starts selected and playback pauses. Enter commits, Shift+Enter inserts a line break (saving `white-space: pre-line` where needed), Esc cancels and restores, clicking outside commits, and Tab/Shift+Tab commit and move through the current frame's text in reading order. Commits use the existing draft → `/api/element-edit` path: revision base taken when editing starts, conflict UI, undo, export flush. The panel Text field mirrors typing. The editor follows a rebuilt replay frame after saves or agent edits.

Targeting picks the deepest element that owns the clicked text (caret hit-test), e.g. only the `<b>` in `<p>Hello <b>world</b></p>`. The override layer no longer moves all text into the first text node. A character diff (LCS on the changed middle, capped for large rewrites) keeps unchanged characters in their recorded nodes, and each changed run goes to the node it replaces. `<br>` is kept or hidden. Overrides apply ancestors-first, so a nested element's own edit wins. rrweb text nodes stay intact and restores remain reversible. Restores no longer leave empty `style=""` attributes. Text-like recorded `<input>`/`<textarea>` elements take `text` as their displayed value (and an input's `value` attribute). It is re-applied after rrweb input events, so it holds through playback, seeks, screenshots and export.

Feedback: a ring and status line under the editor (keys hint, or a red warning when the text overflows/clips or grows beyond its original box). The same warning appears under the panel's Text field. While hovering the canvas in the Edit panel, dashed outlines mark elements with text edits, with a "Text edited" tag on the hovered one. The Edit panel has a one-line "Double-click text on the canvas to rewrite it." tip. README, FORMAT.md and the agent skill describe the semantics.

Files: web/element-editor.ts, web/element-overrides.ts, web/app.ts (hooks, `pickText`/`editableOf`/`textLayers`, dblclick, hover pointer, toolbar hidden while editing), web/style.css, inline-text.test.ts, inline-text-align.test.ts, README.md, FORMAT.md, .agents/skills/demohunter-replay/SKILL.md. Model, schema and MCP code are unchanged.

## Verification

- `npx -y bun@1.4.3 test apps/studio`: 76 pass, 0 fail (751 expects).
- inline-text.test.ts (real browser) covers distribution unit cases, open/alignment/typography/selection/pause, live update and panel sync, Esc, Enter, deepest `<b>`, paragraph edit preserving `<b>`, Tab/Shift+Tab order including an overlay, a Tab commit across a replay rebuild with focus kept, overflow warning (editor and panel), Shift+Enter line break, outside click without following a recorded link, undo, input value over recorded typing during seek and playback, a scene `<em>` edit, reload and seeks, hover marks, and the shared export renderer (snapshot HTML, live input value, frame).
- inline-text-align.test.ts: with caret and selection hidden, editor pixels match the preview (0 px at shift 0,0; justified wrap 2 px) for a zoomed heading, inline bold, wrapped text, button, flex row, centred italic, input, link and a wrapped scene title. The mixed-format paragraph is excluded because it is typed in the paragraph's own style.
- `cd apps/studio && npx tsc --noEmit -p .` passed; `git diff --check` clean.
- Screenshots: /tmp/dh-text/inline-heading.png, inline-overflow.png, inline-input.png, inline-marks.png, export-frame.png, align-*-before/editing.png.

No Studio service or desktop app was started, stopped or restarted; tests use their own servers on port 0. Restart Studio manually to load the new bundle.
