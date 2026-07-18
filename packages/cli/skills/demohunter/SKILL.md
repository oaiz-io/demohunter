---
name: demohunter
description: Create or update DemoHunter `.tour.ts` files, inspect `demohunter.config.ts`, preserve normal Playwright code, and verify tours with the local DemoHunter CLI.
---

# DemoHunter Skill

Use this skill when you need to create or update a DemoHunter `.tour.ts` file in this repo or in a consumer project.

## Workflow

1. Inspect `demohunter.config.ts` and any existing `demos/*.tour.ts` files before editing.
2. Read [references/authoring.md](references/authoring.md) for the current tour shape, helper surface, and editing rules.
3. Use [assets/tour.template.ts](assets/tour.template.ts) as the starter when no suitable tour already exists.
4. Read [references/cli.md](references/cli.md) for supported commands and local verification.
5. Read [references/troubleshooting.md](references/troubleshooting.md) only when generation or environment setup fails.

## Rules

- Keep user code Playwright-native. Use normal `page`, `locator`, and `getByRole` flows instead of inventing wrapper abstractions.
- Keep app-specific auth, bootstrap, and session setup in user Playwright code. Use `beforeRecord` for setup that must finish before the generated video starts.
- Default export `defineTour({ ... })` from `demohunter`.
- Keep narration grounded in visible product behavior. Do not narrate speculative backend behavior.
- Use `narrate(...)` when the viewer should absorb a static state.
- Use `narrateWhile(...)` when narration should bridge navigation, clicks, typing, waits, generation, highlights, or other visible motion.
- Use `sleep(ms)` inside `narrateWhile(...)` when an action should happen at a specific moment in the voiceover.
- Prefer editing the existing tour shape and selectors over rewriting the file unless the current file is clearly broken.
- After changes, run repo-local verification from the closest consumer root instead of assuming the tour is valid.
- Treat narration providers as config-owned plugins. OpenAI remains the default; local Kokoro requires an explicit `kokoro(...)` descriptor and user-owned runtime/assets.
- Never install or download Kokoro, model weights, or voices while authoring a tour. Use `demohunter doctor` to report setup problems.

## Deliverable

Produce or update:

- one valid `.tour.ts` file
- any minimal supporting selector or config edits required for that tour
- verification notes listing the commands you ran
