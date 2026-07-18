# Roadmap: DemoHunter

## Archived Milestones

- [x] `v1.0` OSS Core shipped 2026-04-14 — 6 phases, 24 plans, 55 tasks. Archive: [v1.0-ROADMAP.md](./milestones/v1.0-ROADMAP.md)

## Active Milestone: v1.1 Output Quality

Single phase — all three features delivered together.

### Phase 01 — Output Quality (active)

**Goal:** Visibly more professional demos. Sharable in more formats. Reliable recording.

**Features:**
- Cookie banner dismissal middleware
- Smooth cursor animations with synchronized click helper
- Social media output formats + media-ffmpeg package + manifest v2

**Plans:**
- [ ] 01-output-quality — Full implementation of all three features as one cohesive unit

**Exit criteria:**
- Existing default standard MP4/output paths remain compatible
- No network access introduced
- `bun run verify` passes including real ffmpeg dimension/subtitle/frame tests
- Manifest v1 remains parseable and v2 bundles validate every artifact checksum
- `--format gif`, `--cursor smooth`, `--cookie-dismiss reject` all work end-to-end
