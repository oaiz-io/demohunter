---
status: complete
---
# 261017-agt — Agents inside Studio

Studio's Agents panel starts the person's own Claude Code or Codex over the Agent Client Protocol (`@agentclientprotocol/claude-agent-acp` 0.90.0, `@zed-industries/codex-acp` 0.16.0, SDK 1.8.0). No sign-in step: the adapter uses the existing CLI login; a signed-out agent shows how to sign in. Each session runs in the demo's worktree with Studio's MCP server attached (named after the agent, so presence says "Claude Code").

- Server: `agents.ts` (AgentHub/AgentSession: one session per worktree and kind, serial prompts, streamed messages/thoughts/plans/tools, permission relay, cancel/stop, per-worktree `.demohunter/studio/agents.json`), `agent-routes.ts` (`/api/agents*`, SSE stream, JSON-only POSTs, server-built context preamble from project files). Read-only DemoHunter tools (`readOnlyHint`) are approved automatically; everything else asks. Untrusted folders refuse to start agents.
- UI: `web/agent-chat.ts` — roster pills with status, thread (user messages with context chips, agent text, thinking, tool rows, plan, permission cards), composer (Enter sends, Stop, live time/selection chips), "Send to agent" on notes, auto-send new notes, tab dot while working/waiting. Outside-agent activity and turn review moved under "Activity & changes"; standalone Studio keeps showing it.
- Docs: Studio README, ARCHITECTURE, FORMAT, agent skill.

Verification: scripted ACP agent fixture; `agents.test.ts` (11) and headless `agent-chat.test.ts` (4); full Studio suite 137 pass; repo typecheck and build pass. Real Claude Code smoke through the headless UI: read question answered in 8 s with no prompts; a note write asked once, landed on disk and reloaded the editor. Desktop tests not run locally (CI only).
