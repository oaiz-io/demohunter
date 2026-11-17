---
status: complete
---
# Quick task 261117-m45: record the product assessment research

- Branch `research/studio-speed-video-quality` from `main`.
- `thoughts/research/2026-11-17-product-assessment/`:
  - `README.md`: where the product is, the four findings and the work plan.
  - `studio-performance.md`: 14 measured causes of Studio slowness with file references, fixes and budgets.
  - `video-quality.md`: comparison with open-source video tools, 13 gaps and build-or-integrate advice.
  - `rust-architecture.md`, `rust-scan-and-capture.md`, `rust-export-pipeline.md`, `rust-cli-generate.md`: four Rust spikes.
- The prototype and benchmark code of the spikes is not in the repository.
- Result: do the TypeScript fixes; no Rust now. The scan prototype takes the cold scan from 2.9 s to 0.11 s. A warm renderer takes posters and screenshots from 1.1–1.9 s to 64–190 ms. Rust was not faster than the fixed TypeScript path by a margin that a user sees in any area.
- No product code changed. No tests ran, because `apps/` and `packages/` are unchanged.
- The spikes ran on a machine with a high load from other work; they report minimum and median values.
