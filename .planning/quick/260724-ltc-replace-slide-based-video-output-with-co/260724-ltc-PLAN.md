---
quick_id: 260724-ltc
status: in_progress
date: 2026-07-24
---

# Replace slide-based video output with continuous scrollytelling

## Task 1: Replace deck rendering and click navigation

**Files:** base templates, template engine, compiler selectors/tour generation, and focused tests.

**Action:** Render the existing v1 `slides` array as semantic continuous-flow sections, remove visible navigation and active-slide state, add deterministic programmatic smooth scrolling, and synchronize each section reveal with narration. Keep stable data-attribute selectors and no external resources.

**Verify:** Focused template/compiler tests prove there are no navigation controls or click instructions, section selectors are stable, scrolling is ordered, and output is deterministic.

**Done:** Generated lessons are long-form pages and tours advance only by scroll.

## Task 2: Raise visual quality across all presets

**Files:** minimal, terminal, and notebook preset styles plus shared reveal behavior.

**Action:** Add viewport-sized editorial sections, staggered scroll reveals, improved type/spacing/code/bullet treatments, and distinct high-production minimal, authentic terminal, and warm notebook art directions.

**Verify:** Build assets successfully and inspect rendered pages at the recording viewport.

**Done:** All three presets present polished, legible continuous lessons without controls or external assets.

## Task 3: Align generation guidance and regenerate examples

**Files:** content system prompt, generated example workspaces/videos, GSD summary/state.

**Action:** Rewrite prompting around flowing educational sections while preserving the v1 JSON contract, build and test the package, regenerate the requested binary-tree and DNS examples with the environment API key, and inspect the resulting media.

**Verify:** `bun test`, `bun run build`, both CLI generations, output file probes, and final git diff review pass.

**Done:** Both requested videos are regenerated from the new scrollytelling pipeline and the scoped source changes are committed.
