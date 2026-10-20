// A scripted ACP agent for tests: no model, deterministic replies.
//  - names the demo Studio said is open; "show context" echoes all of it
//  - "plan" → a plan update and a tool call
//  - "permission" → asks for permission and reports the outcome
//  - "peek" → asks to use a read-only DemoHunter tool
//  - "spoof" → a shell command titled like a DemoHunter tool
//  - "make a change" → adds a note through Studio's MCP server
//  - "markdown" → a reply with Markdown (and things that must stay text)
//  - "slow" → waits until cancelled
//  - "which model" → reports the chosen model and mode
//  - "create a demo" → writes a tour in two passes and "captures" it (a copy
//    of the folder's project/ demo) into .demohunter/replays/sign-up
//  - FAKE_AGENT_FAIL=auth makes session/new fail like a signed-out agent;
//    FAKE_AGENT_FAIL=prompt-auth fails the first message instead
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
);
let cancelled: (() => void) | undefined;
let mcpServers: { command: string; args: string[]; env: { name: string; value: string }[] }[] = [];
// Model and mode, offered like Claude Code does (session config options).
const current = { model: "opus", mode: "default" };
const configOptions = () => [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: current.mode,
    options: [
      { value: "default", name: "Manual" },
      { value: "plan", name: "Plan" },
      { value: "bypassPermissions", name: "Bypass permissions" },
    ],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: current.model,
    options: [
      { value: "opus", name: "Opus 5.5" },
      { value: "fable", name: "Fable 5.1" },
      { value: "sonnet", name: "Sonnet 5.5" },
    ],
  },
];
new acp.AgentSideConnection(
  (client) => ({
    async initialize() {
      return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } };
    },
    async newSession(params) {
      // Slow to start, like a real agent signing in to its service.
      if (process.env.FAKE_AGENT_SLOW_START) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_AGENT_SLOW_START)));
      if (process.env.FAKE_AGENT_FAIL === "auth")
        throw acp.RequestError.authRequired();
      // Report what Studio handed us, so tests can check cwd and MCP wiring.
      process.stderr.write(`session cwd=${params.cwd} mcp=${JSON.stringify(params.mcpServers)}\n`);
      mcpServers = params.mcpServers as typeof mcpServers;
      return { sessionId: "fake-session", configOptions: configOptions() } as acp.NewSessionResponse;
    },
    async authenticate() {
      return {};
    },
    async setSessionConfigOption(params) {
      const value = (params as { value: string }).value;
      if (params.configId === "model") current.model = value;
      if (params.configId === "mode") current.mode = value;
      return { configOptions: configOptions() } as acp.SetSessionConfigOptionResponse;
    },
    async cancel() {
      cancelled?.();
    },
    async prompt(params) {
      // Like Claude Code signed out: the session starts, the first message fails.
      if (process.env.FAKE_AGENT_FAIL === "prompt-auth") throw acp.RequestError.authRequired();
      const text = params.prompt.map((p) => (p.type === "text" ? p.text : "")).join("");
      const say = (t: string) =>
        client.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } },
        });
      await say("Got: ");
      if (text.includes("which model")) await say(`[model ${current.model}, mode ${current.mode}] `);
      await say(`Demo: "${/this demo open: "([^"]*)"/.exec(text)?.[1] ?? "?"}"`);
      if (text.includes("show context")) await say(`\n~~~\n${text}\n~~~`);
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
          // As Claude Code sends it: the MCP tool and server in _meta.
          toolCall: {
            toolCallId: "t3",
            title: "mcp__demohunter__get_basic_info",
            _meta: { claudeCode: { toolName: "mcp__demohunter__get_basic_info", mcpServer: { name: "demohunter" } } },
          },
          options: [
            { optionId: "yes", name: "Allow once", kind: "allow_once" },
            { optionId: "no", name: "Deny", kind: "reject_once" },
          ],
        });
        await say(`\nRead: ${answer.outcome.outcome === "selected" ? answer.outcome.optionId : "cancelled"}`);
      }
      if (text.includes("make a change")) {
        // Like a real agent: Studio's MCP server, as handed over in session/new.
        const { Client } = await import("@modelcontextprotocol/client");
        const { StdioClientTransport } = await import("@modelcontextprotocol/client/stdio");
        const server = mcpServers[0]!;
        const mcp = new Client({ name: "fake-agent", version: "1.0.0" });
        await mcp.connect(
          new StdioClientTransport({
            command: server.command,
            args: server.args,
            env: { ...(process.env as Record<string, string>), ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) },
          }),
        );
        const project = /\(id ([0-9a-f]+)\)/.exec(text)?.[1];
        const call = async (name: string, args: Record<string, unknown>) =>
          JSON.parse(((await mcp.callTool({ name, arguments: { ...args, project } })) as { content: { text: string }[] }).content[0]!.text);
        const info = await call("get_basic_info", {});
        await call("add_comment", { expectedRevision: info.revision, timeMs: 500, body: "Added by the agent" });
        await mcp.close();
        await say("\nChanged: 1");
      }
      if (text.includes("markdown")) {
        await say(
          "\n**Bold** and *italic*, `code` and [a link](https://example.com).\n\n1. First\n2. Second\n   - nested\n\n<img src=x onerror=\"window.__pwned=1\"> [bad](javascript:alert(1))\n\n| Scene | Time |\n|---|---|\n| Intro | 0:05 |\n\n```\nconst x = 1;\n```",
        );
      }
      if (text.includes("hostile")) {
        // Output that used to stall or crash the Markdown renderer.
        await say(`\n${"`".repeat(8000)}\n\n${">".repeat(5000)} deep\n\n${"[".repeat(80000)}\n\n## Using C#\n\n[plain http](http://example.com)\nafter`);
      }
      if (text.includes("spoof")) {
        // A shell command titled like a DemoHunter tool: must still ask.
        const answer = await client.requestPermission({
          sessionId: params.sessionId,
          toolCall: { toolCallId: "t4", title: "demohunter/get_guide", kind: "execute", rawInput: { command: "demohunter/get_guide" } },
          options: [
            { optionId: "yes", name: "Allow once", kind: "allow_once" },
            { optionId: "no", name: "Deny", kind: "reject_once" },
          ],
        });
        await say(`\nSpoof: ${answer.outcome.outcome === "selected" ? answer.outcome.optionId : "cancelled"}`);
      }
      if (text.includes("create a demo")) {
        const { cp, mkdir, writeFile } = await import("node:fs/promises");
        const tool = (toolCallId: string, title: string, kind: acp.ToolKind, status: acp.ToolCallStatus) =>
          client.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "tool_call", toolCallId, title, kind, status } });
        const done = (toolCallId: string, status: acp.ToolCallStatus = "completed") =>
          client.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "tool_call_update", toolCallId, status } });
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
        await say(`\nBrief: ${text.includes('"New demo" page') && text.includes(" capture <tour file> --project ") ? "yes" : "no"}`);
        await say(`\nSkills: ${text.includes("DemoHunter's skills are in this repository") ? "yes" : "no"}`);
        await tool("w1", "Write demos/sign-up.tour.ts", "edit", "in_progress");
        await mkdir("demos", { recursive: true });
        const head = 'export default {\n  id: "sign-up",\n  title: "Sign up",\n  async run({ chapter, step, narrate, goto }) {\n    await goto("/signup");\n    await chapter("Getting started");\n    await narrate("This is where a new account begins.");\n';
        await writeFile("demos/sign-up.tour.ts", head);
        await wait(1200);
        await writeFile("demos/sign-up.tour.ts", `${head}    await step("Fill in the form", async () => {});\n    await narrate("Two fields and you're in.");\n  },\n};\n`);
        await done("w1");
        await wait(1200);
        await tool("c1", "`bun cli.ts capture demos/sign-up.tour.ts --project .demohunter/replays/sign-up`", "execute", "in_progress");
        await mkdir(".demohunter/replays/sign-up/assets", { recursive: true });
        await wait(1500);
        await cp("project", ".demohunter/replays/sign-up", { recursive: true });
        await done("c1");
        await say("\nCreated: sign-up");
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
