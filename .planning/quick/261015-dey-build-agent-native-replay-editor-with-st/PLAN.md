# Agent-accessible replay workbench

Started with `gsd-sdk query init.quick` on 2026-10-15. Continue in the existing worktree without discarding the prior experiment. GSD agent types are not installed; research, execution, and verification stay in this session.

## Product intent

The editor contains no chat/model. Human and agent share a local project: select and link elements, attach comments, inspect captured HTML with stable references, make bounded edits/animations, and edit/regenerate narration from a readable transcript interface. Files remain an equally supported interface alongside real MCP.

## Plan

1. Research Paper's current agent workflow, tools, selection/context model, and transport using official docs and tool schemas. Specify honest source provenance: captured DOM is not original React/HTML source without explicit author metadata.
2. Add a persistent element registry and readable captured HTML, portable references/deep links, scoped inspection, comments, timeline-aware element animation, and shared validated mutations with revision checking/history.
3. Provide an actual stdio MCP server using the current official SDK. Expose bounded project/selection/element/HTML/comment/narration reads and targeted writes, sharing the same file store as the UI. Add copyable connection configuration rather than editing agent settings automatically.
4. Improve the visual editor: clean neutral design, element outline/hover/selection, copy link and agent context, comment threads, agent setup, transcript cards with per-segment edit/save/preview/regenerate, dirty-state/conflict handling, keyboard use, and undo.
5. Create a realistic invoicing walkthrough captured through DemoHunter, with deliberate reading holds and local sample narration if available. Verify actual UI workflows, file edits, MCP client round trips, concurrency, and narration/cache behavior; run appropriate existing checks.

## Acceptance

- A copied link opens the same project/element/time and resolves through a CLI/MCP call to registry ID, captured document/node, readable HTML, and editable file locations.
- Comments survive reload, attach to an element/time, and are readable/resolvable by an agent.
- UI and MCP use the same validated mutations; stale revision writes cannot silently overwrite another editor. History restores edits while keeping original capture intact.
- Narration edits remain in the UI across unrelated live reloads; save status, stale audio, selective regeneration, and timing are clear.
- The tool stays local and provider-agnostic; no built-in model, credentials in project files, or automatic changes to user agent configuration.
