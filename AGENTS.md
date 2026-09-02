<!-- GSD:project-start source:PROJECT.md -->
## Project

**DemoHunter**

DemoHunter is an OAIZ Labs open-source TypeScript CLI and SDK maintained by OAIZ AB. It creates narrated product demos from Playwright-style `.tour.ts` files. It runs locally, generates portable demo assets into `.demohunter/`, and supports OpenAI and ElevenLabs text-to-speech. A cloud offering can be an additive product later, but it is not a dependency of the OSS core.

**Core Value:** Developers can turn normal Playwright automation into portable narrated demo assets locally, without depending on a hosted backend.

### Constraints

- **Tech stack**: Bun workspace, TypeScript 5+, ESM-first, Playwright `>=1.61`, and ffmpeg-backed media generation.
- **Product boundary**: OSS must stand on its own and work entirely locally - cloud features cannot leak into the default flow.
- **Provider boundary**: TTS reads `OPENAI_API_KEY` or `ELEVENLABS_API_KEY` from the environment only. DemoHunter does not store credentials.
- **Output contract**: `.demohunter/` must be portable and versioned so Cloud can ingest it later without source-repo access.
- **Reliability**: Narration caching is mandatory, including offline regeneration behavior and corrupt-cache recovery.
<!-- GSD:project-end -->

<!-- GSD:stack-start source:STACK.md -->
## Technology Stack

Technology stack not yet documented. Will populate after codebase mapping or first phase.
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, or `.github/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
