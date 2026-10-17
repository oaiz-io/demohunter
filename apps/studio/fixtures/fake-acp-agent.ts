// A scripted ACP agent for tests: no model, deterministic replies.
//  - echoes the first context line Studio sent (so tests can check context)
//  - "plan" → a plan update and a tool call
//  - "permission" → asks for permission and reports the outcome
//  - "peek" → asks to use a read-only DemoHunter tool
//  - "slow" → waits until cancelled
//  - FAKE_AGENT_FAIL=auth makes session/new fail like a signed-out agent
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
);
let cancelled: (() => void) | undefined;
new acp.AgentSideConnection(
  (client) => ({
    async initialize() {
      return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } };
    },
    async newSession(params) {
      if (process.env.FAKE_AGENT_FAIL === "auth")
        throw acp.RequestError.authRequired();
      // Report what Studio handed us, so tests can check cwd and MCP wiring.
      process.stderr.write(`session cwd=${params.cwd} mcp=${JSON.stringify(params.mcpServers)}\n`);
      return { sessionId: "fake-session" };
    },
    async authenticate() {
      return {};
    },
    async cancel() {
      cancelled?.();
    },
    async prompt(params) {
      const text = params.prompt.map((p) => (p.type === "text" ? p.text : "")).join("");
      const say = (t: string) =>
        client.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } },
        });
      await say("Got: ");
      await say(text.split("\n")[1] ?? "");
      if (text.includes("plan")) {
        await client.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "plan",
            entries: [
              { content: "Raise contrast", priority: "high", status: "completed" },
              { content: "Hold the total", priority: "medium", status: "in_progress" },
            ],
          },
        });
        await client.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "mcp__demohunter__get_basic_info", status: "in_progress", kind: "read" },
        });
        await client.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" },
        });
      }
      if (text.includes("permission")) {
        const answer = await client.requestPermission({
          sessionId: params.sessionId,
          toolCall: { toolCallId: "t2", title: "Run bun run studio export", rawInput: { command: "bun run studio export ." } },
          options: [
            { optionId: "yes", name: "Allow once", kind: "allow_once" },
            { optionId: "always", name: "Always allow", kind: "allow_always" },
            { optionId: "no", name: "Deny", kind: "reject_once" },
          ],
        });
        await say(
          `\nPermission: ${answer.outcome.outcome === "selected" ? answer.outcome.optionId : "cancelled"}`,
        );
      }
      if (text.includes("peek")) {
        // A read-only DemoHunter tool: Studio answers without asking.
        const answer = await client.requestPermission({
          sessionId: params.sessionId,
          toolCall: { toolCallId: "t3", title: "mcp__demohunter__get_basic_info" },
          options: [
            { optionId: "yes", name: "Allow once", kind: "allow_once" },
            { optionId: "no", name: "Deny", kind: "reject_once" },
          ],
        });
        await say(`\nRead: ${answer.outcome.outcome === "selected" ? answer.outcome.optionId : "cancelled"}`);
      }
      if (text.includes("slow")) {
        await new Promise<void>((resolve) => (cancelled = resolve));
        return { stopReason: "cancelled" };
      }
      return { stopReason: "end_turn" };
    },
  }),
  stream,
);
