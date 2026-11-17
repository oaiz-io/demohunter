# Quick task 261117-flm: General film tools for agents

## Problem

Studio makes films only from a recording of a web app. `project.json` requires `capture`, and export of a scene-only project fails (`ENOENT … events.json`, then "Capture changed after element references were created"). Explainers, essays, data stories and shorts have nothing to record. The agent also sees only one frame at a time (MCP `get_screenshot`), and the scene kit has no helpers for text size, reading time or pan-and-zoom. Reasons and precedents: `thoughts/research/2026-11-17-product-assessment/skills-and-tools.md` sections 2.2, 3.1 and 5.2 items 1 and 3.

Owner direction: tools that return data or pictures. No gates, scores, checks or reviewer agents.

## Tasks

Each task has its own commit (`feat(studio): …`) and tests.

1. `studio new <project-dir> [--title] [--size WxH]`: a film project with only scene clips. Valid project files, the scene kit in `scenes/kit/` (no score), a plain starter scene `scenes/opening.html`, and `PLAN.md` from the research template. Refuses an existing destination. Prints JSON with the path and next commands. Every existing path (inspect, editor, library, MCP, kit, narrate, export) must work on it; recording-only tools may refuse with a clear message. Projects with a recording behave as before.
2. `studio sheet <project-dir> [--at] [--every] [--cuts] [--phone] [--output]` and MCP `get_film_sheet`: contact sheets from the deterministic renderer, labelled tiles (time, clip or overlay id), several numbered JPEGs past about 30 tiles, JSON tile list. Read-only; does not move the playhead.
3. Scene kit helpers in `scene-kit/motion.js`: `fitText(element, {max, min})`, `readTime(text)`, `kenBurns(element, {from, to, at, dur, easing})`, with tests and docs.

## Rules

- Do not edit `.agents/skills/`, `packages/cli/skills/`, `thoughts/research/` or `spikes/`.
- Keep restricted mode, the loopback host guard, inert asset serving, revision checks, the project lock and path containment.
- No new dependencies. Non-default ports; stop every process started; scratch under `.context/`.
- The set of failing tests must not grow. Baseline: studio 178 pass, 0 fail; typecheck clean.
