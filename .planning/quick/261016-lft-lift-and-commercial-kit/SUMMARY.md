---
quick_id: 261016-lft
status: complete
date: 2026-10-16
branch: t3code/research-editable-demo-capture (PR #28, experimental)
---

# Lift and the commercial kit

- `bun run studio lift` / MCP `lift_element`: snapshot a recorded element
  with inline computed styles and its rect into `scenes/lifts/`; kit `lift()`
  picks it up from the page in a scene or overlay.
- Overlay `backdrop` (blur/dim the recording, eased).
- Scene kit `show.js`/`show.css`: `liftShow`, `cursorClick` (translate
  position, press around the tip), `flip`, `byText`, `byColour`; `kit`
  copies the whole kit. Browser regression test for click accuracy.
- Studio pauses and persists scene animations on load (no auto-removal in
  long exports); no Playwright "disabled" screenshots when scenes exist.
- `demohunter-commercial` skill (adapted from Hyperframes, Apache-2.0, and
  brag, MIT); replay skill rules for kit moves and transform order.
- Camera `easeMs`; capture samples scroll every 16 ms; export `--lufs`/`--crf`.
