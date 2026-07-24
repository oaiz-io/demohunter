---
quick_id: 260724-axx
status: in_progress
---

# Research and document the video generation agent concept

## Scope

Research the current DemoHunter monorepo and write the requested concept documentation. Do not add implementation code or scaffold a `packages/video-gen/` directory yet.

## Tasks

1. Inspect the workspace/package conventions, authoring DSL, config resolution, CLI flow, two-pass generator, narration cache, media output, and manifest contract. Record only claims supported by the checkout and official OpenAI documentation where the future LLM boundary is discussed.
2. Design the proposed `video-gen` boundary: generated content model, tour generation, narration ownership, templates/themes, visual effects, package layout, dependencies, and phased roadmap. Explicitly separate MVP decisions from later extensions.
3. Write and review `README.md`, `docs/architecture.md`, `docs/roadmap.md`, and `docs/research.md`. Keep the deliverables architectural/documentary; do not implement the package.

## Verification

- All four requested files exist and cover the user’s listed sections.
- The documents name real current DemoHunter APIs and paths (`defineTour`, `defineConfig`, `generateTour`, `.demohunter/<tour-id>/`, TTS cache, manifest).
- No implementation files or `packages/video-gen/` files are added.
- Markdown structure and links are internally consistent.
