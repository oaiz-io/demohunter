# Research: direct editing in Studio

## Existing behavior

- web/app.ts already resolves stable capture refs and applies edits.json element text/CSS/hidden overrides. It rebuilds the captured replay on edit changes, but HTML scene frames remain alive when only overrides change.
- model.ts validates element targets, and workspace.ts/storage.ts provide revision checks, project locking and undo. Scene HTML and audio files also contribute to the revision.
- The current canvas selection only picks recorded DOM. New scenes and overlays live in same-origin frames owned by SceneLayer and require separate hit testing. Camera scaling applies to the recording, not scene frames.
- Other work is adding a desktop shell. Its pending app.ts/CLI/library changes must remain intact. Do not start or restart the user's service.

## Design decisions

- Store all direct edits as portable overrides in edits.json. Preserve captured events and authored HTML. Use the same targeting and tracked mutation path for humans and agents.
- Add optional scene-file scope to selector targets, plus additive position/scale geometry. A scene element receives a stable selector within its source file.
- Resolve pointer movement in source-document coordinates using the frame's actual displayed dimensions; selection controls live above the preview so camera zoom cannot change handle size.
- Restore previously applied overrides before each frame and then apply current overrides after scene seeking. This prevents transform accumulation and restores hidden/text/style values after reset or agent edits. Preserve rrweb text nodes instead of replacing innerHTML.
- Use pointer capture during drag/resize, one history write at gesture end, live preview during gestures, and revision checks on saves. Form edits use debounced saves with explicit conflict recovery.
- Include an element list for hidden/removed elements, restore/reset, position, scale, size, opacity, text, foreground/background color and text size. Removal hides a recorded element and remains reversible.

## Primary references

- Pointer capture retains pointer events through drag outside the target: https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture
- CSS transform composition and transform origin: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/transform

## Loop risks to test

1. Zoomed camera and scaled preview coordinates; drag/resize must match the pointer.
2. Text overrides must not detach rrweb nodes. Reset/hide/restore must also work on persistent scene frames.
3. An agent edit during a form draft or drag must cause a conflict without losing either change.
4. Reload, backward seek, screenshot/export and undo must show the same saved edit.

## Loop results

- Persistence tests confirmed that partial geometry must not receive schema defaults: an X-only patch must preserve Y and both scale values. The patch schema now removes the persisted-field defaults.
- Browser tests found a prior CSS rule that disabled pointer input over HTML scenes. Removed it so the same canvas can pick scenes and recording elements.
- MCP schema composition needs safeExtend when preserving the new exactly-one-target refinement. Real stdio MCP tests cover scene target edits, partial geometry and reset, as well as the existing recorded-ref API.
- Inline HTML text needs inline-block while applying a transform. The override layer makes this reversible; reset restores the authored inline display.
- Switching between pending element drafts needs separate target tracking. The final browser test edits two elements before autosave and confirms that each form restores its own draft.
- Real browser tests cover camera zoom, drag and resize, backward seeks and a later rrweb text mutation, scene removal/restore/reset/undo, concurrent writes and explicit conflict recovery, the shared export renderer, and a narrow layout.
- Playwright waitForFunction did not wait for asynchronous polling predicates in this environment. Disk assertions use bounded asynchronous polling in the test runner. Tests run with Bun 1.4.3; no user service was started, stopped or restarted.
