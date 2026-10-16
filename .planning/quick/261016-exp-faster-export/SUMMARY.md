---
quick_id: 261016-exp
status: complete
date: 2026-10-16
branch: t3code/research-editable-demo-capture (PR #28, experimental)
---

# Faster Studio export (482 s → ~23 s for 67 s 1080p30)

- Parallel workers (one browser each, default one per four cores, max 4)
  pulling small chunks from a queue; segments joined without re-encoding.
- Full Chromium new headless (fallback: headless shell); no animation-frame
  wait before screenshots; JPEG frames (q95 when publishing).
- Still frames during holds reused; workers start as their browser is up.
- Audio: each file decoded once; one-pass EBU R128 + exact gain + true-peak
  limiter with make-up (replaces two-pass loudnorm); prepared while frames
  render. x264 `fast` for publishing.
- Rejected: >5 workers, Chromium frame-rate flags, GPU flags, half-res
  capture, VideoToolbox (session limit hangs at 8 workers).
- Verified: same frame count and loudness, SSIM 0.98–0.999, 66 tests pass.
