import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { ensureIgnoredFolder, writeJson } from "./storage.js";

/**
 * Agents running inside Studio, over the Agent Client Protocol. Studio starts
 * the person's own coding agent (Claude Code, Codex) as a subprocess in the
 * demo's worktree, hands it Studio's MCP server, and relays its messages,
 * plans, tool calls and permission requests to the editor. Studio never
 * calls a model itself: the agent uses its own login and settings.
 */

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

export type AgentKind = "claude" | "codex";
type Adapter = { kind: AgentKind; name: string; entry: () => string };
const packageFile = (pkg: string, file: string) =>
  path.join(path.dirname(require.resolve(`${pkg}/package.json`)), file);
const ADAPTERS: Adapter[] = [
  {
    kind: "claude",
    name: "Claude Code",
    entry: () => packageFile("@agentclientprotocol/claude-agent-acp", "dist/index.js"),
  },
  {
    kind: "codex",
    name: "Codex",
    entry: () => packageFile("@zed-industries/codex-acp", "bin/codex-acp.js"),
  },
];
/**
 * DemoHunter tools that only read (their readOnlyHint), asked from Studio's
 * own MCP server. Agents use these without stopping to ask; anything that
 * changes the demo, and every tool of the agent itself, still asks.
 */
let readOnly: Promise<Set<string>> | undefined;
function readOnlyTools(root: string): Promise<Set<string>> {
  return (readOnly ??= (async () => {
    const [{ createReplayMcp }, { ProjectTargets }, { Client }, { InMemoryTransport }] = await Promise.all([
      import("./mcp.js"),
      import("./workspace.js"),
      import("@modelcontextprotocol/client"),
      import("@modelcontextprotocol/server"),
    ]);
    const server = createReplayMcp(await ProjectTargets.open(root));
    const client = new Client({ name: "demohunter-studio", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const { tools } = await client.listTools();
      return new Set(tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name));
    } finally {
      await client.close();
    }
  })().catch(() => {
    readOnly = undefined;
    return new Set<string>();
  }));
}
/** "mcp__demohunter__get_guide" (Claude) or "demohunter.get_guide" → "get_guide". */
function demoToolName(call: acp.ToolCallUpdate): string | undefined {
  const meta = (call._meta as { claudeCode?: { toolName?: unknown } } | undefined)?.claudeCode?.toolName;
  const name = typeof meta === "string" ? meta : (call.title ?? "");
  return /^(?:mcp__demohunter__|demohunter[./:])([a-z0-9_]+)$/i.exec(name.trim())?.[1];
}

/** Tests point a kind at a scripted agent. */
const overrides = new Map<AgentKind, string>();
export function useAdapterScript(kind: AgentKind, script: string | undefined) {
  if (script) overrides.set(kind, script);
  else overrides.delete(kind);
}

export type AgentEvent =
  | { seq: number; at: string; type: "user"; text: string; context?: string[] }
  | { seq: number; at: string; type: "agent"; text: string }
  | { seq: number; at: string; type: "thought"; text: string }
  | {
      seq: number;
      at: string;
      type: "tool";
      toolCallId: string;
      title: string;
      status: string;
      kind?: string;
    }
  | {
      seq: number;
      at: string;
      type: "plan";
      entries: { content: string; status: string }[];
    }
  | {
      seq: number;
      at: string;
      type: "permission";
      requestId: string;
      title: string;
      detail?: string;
      options: { optionId: string; name: string; kind: string }[];
      chosen?: string;
    }
  | { seq: number; at: string; type: "notice"; text: string; tone?: "error" }
  | { seq: number; at: string; type: "done"; stopReason: string };

export type AgentStatus =
  | "starting"
  | "idle"
  | "working"
  | "waiting"
  | "stopped"
  | "error";

/** What the editor's stream receives: a new or updated event, or a status. */
export type AgentMessage =
  | { type: "event"; event: AgentEvent }
  | { type: "status"; status: AgentStatus };

export type AgentSummary = {
  id: string;
  kind: AgentKind;
  name: string;
  root: string;
  status: AgentStatus;
  startedAt: string;
};

type Pending = {
  resolve: (r: acp.RequestPermissionResponse) => void;
  event: Extract<AgentEvent, { type: "permission" }>;
};

class AgentSession {
  readonly id = randomUUID();
  readonly startedAt = new Date().toISOString();
  status: AgentStatus = "starting";
  events: AgentEvent[] = [];
  private seq = 0;
  private listeners = new Set<(message: AgentMessage) => void>();
  private child?: ChildProcess;
  private conn?: acp.ClientSideConnection;
  private acpSession?: string;
  private pending = new Map<string, Pending>();
  private queue: Promise<unknown> = Promise.resolve();
  private stderr = "";
  private tools = new Map<string, Extract<AgentEvent, { type: "tool" }>>();

  constructor(
    readonly adapter: Adapter,
    readonly root: string,
    private mcp: { command: string; args: string[] },
  ) {}

  summary(): AgentSummary {
    return {
      id: this.id,
      kind: this.adapter.kind,
      name: this.adapter.name,
      root: this.root,
      status: this.status,
      startedAt: this.startedAt,
    };
  }
  subscribe(listener: (message: AgentMessage) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Add an event, or re-send an updated one (same seq). */
  private emit<T extends AgentEvent>(event: T, isNew = true): T {
    if (isNew) this.events.push(event);
    if (this.events.length > 2000) this.events.splice(0, this.events.length - 2000);
    for (const listener of this.listeners) listener({ type: "event", event });
    return event;
  }
  private add<T extends AgentEvent["type"]>(
    type: T,
    fields: Omit<Extract<AgentEvent, { type: T }>, "seq" | "at" | "type">,
  ) {
    return this.emit({
      seq: ++this.seq,
      at: new Date().toISOString(),
      type,
      ...fields,
    } as Extract<AgentEvent, { type: T }>);
  }
  private setStatus(status: AgentStatus) {
    this.status = status;
    for (const listener of this.listeners) listener({ type: "status", status });
  }

  async start(): Promise<void> {
    const entry = overrides.get(this.adapter.kind) ?? this.adapter.entry();
    // The agent runs as the person, in the demo's worktree, with their own
    // environment (login, PATH, API keys) — Studio adds nothing to it.
    const child = spawn(process.execPath, [entry], {
      cwd: this.root,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr!.on("data", (d) => (this.stderr = (this.stderr + d).slice(-4000)));
    child.once("exit", (code, signal) => {
      for (const p of this.pending.values())
        p.resolve({ outcome: { outcome: "cancelled" } });
      this.pending.clear();
      if (this.status === "stopped") return;
      this.add("notice", {
        text: `${this.adapter.name} stopped (${signal ?? `exit ${code}`}).`,
        tone: "error",
      });
      this.setStatus("error");
    });
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
    );
    this.conn = new acp.ClientSideConnection(
      () => ({
        requestPermission: (params) => this.onPermission(params),
        sessionUpdate: async (params) => this.onUpdate(params.update),
      }),
      stream,
    );
    try {
      await this.conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        // The agent uses its own file and terminal tools.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      const session = await this.conn.newSession({
        cwd: this.root,
        mcpServers: [
          {
            name: "demohunter",
            command: this.mcp.command,
            args: this.mcp.args,
            env: [{ name: "DEMOHUNTER_AGENT_NAME", value: this.adapter.name }],
          },
        ],
      });
      this.acpSession = session.sessionId;
      this.setStatus("idle");
    } catch (error) {
      this.add("notice", { text: startError(this.adapter, error, this.stderr), tone: "error" });
      this.setStatus("error");
      child.kill();
      throw error;
    }
  }

  private onUpdate(update: acp.SessionNotification["update"]) {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        if (update.content.type !== "text") return;
        const type = update.sessionUpdate === "agent_message_chunk" ? "agent" : "thought";
        const last = this.events.at(-1);
        // Stream chunks into the current message.
        if (last && last.type === type) {
          last.text += update.content.text;
          this.emit(last, false);
        } else this.add(type, { text: update.content.text });
        return;
      }
      case "tool_call": {
        const event = this.add("tool", {
          toolCallId: update.toolCallId,
          title: update.title,
          status: update.status ?? "pending",
          kind: update.kind,
        });
        this.tools.set(update.toolCallId, event);
        return;
      }
      case "tool_call_update": {
        const event = this.tools.get(update.toolCallId);
        if (!event) return;
        if (update.title) event.title = update.title;
        if (update.status) event.status = update.status;
        this.emit(event, false);
        return;
      }
      case "plan":
        this.add("plan", {
          entries: update.entries.map((e) => ({ content: e.content, status: e.status })),
        });
        return;
      default:
        return;
    }
  }

  private async onPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const tool = demoToolName(params.toolCall);
    if (tool && (await readOnlyTools(this.root)).has(tool)) {
      const allow =
        params.options.find((o) => o.kind === "allow_once") ??
        params.options.find((o) => o.kind === "allow_always");
      if (allow) return { outcome: { outcome: "selected", optionId: allow.optionId } };
    }
    return new Promise<acp.RequestPermissionResponse>((resolve) => {
      const requestId = randomUUID().slice(0, 8);
      const raw = params.toolCall.rawInput;
      const detail =
        raw && typeof raw === "object"
          ? JSON.stringify(raw, null, 2).slice(0, 1200)
          : undefined;
      const event = this.add("permission", {
        requestId,
        title: params.toolCall.title ?? "Use a tool",
        detail,
        options: params.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
      });
      this.pending.set(requestId, { resolve, event });
      this.setStatus("waiting");
    });
  }

  answer(requestId: string, optionId: string) {
    const pending = this.pending.get(requestId);
    if (!pending) throw Object.assign(new Error("That request is no longer open."), { status: 409 });
    if (!pending.event.options.some((o) => o.optionId === optionId))
      throw new Error("Unknown option.");
    this.pending.delete(requestId);
    pending.event.chosen = optionId;
    this.emit(pending.event, false);
    if (!this.pending.size) this.setStatus("working");
    pending.resolve({ outcome: { outcome: "selected", optionId } });
  }

  /** Queue a prompt; prompts run one at a time. */
  prompt(text: string, context: string[], preamble: string) {
    if (!this.conn || !this.acpSession) throw new Error(`${this.adapter.name} isn't ready yet.`);
    if (this.status === "error" || this.status === "stopped")
      throw new Error(`${this.adapter.name} stopped. Start it again.`);
    this.add("user", { text, context });
    const run = async () => {
      this.setStatus("working");
      try {
        const result = await this.conn!.prompt({
          sessionId: this.acpSession!,
          prompt: [{ type: "text", text: `${preamble}\n\n${text}` }],
        });
        this.add("done", { stopReason: result.stopReason });
      } catch (error) {
        this.add("notice", { text: message(error), tone: "error" });
      } finally {
        if (this.status !== "error" && this.status !== "stopped")
          this.setStatus(this.pending.size ? "waiting" : "idle");
      }
    };
    this.queue = this.queue.then(run, run);
  }

  async cancel() {
    if (!this.conn || !this.acpSession) return;
    for (const p of this.pending.values()) {
      p.event.chosen = "cancelled";
      this.emit(p.event, false);
      p.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.pending.clear();
    await this.conn.cancel({ sessionId: this.acpSession });
  }

  stop() {
    this.setStatus("stopped");
    this.child?.kill();
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : typeof error === "object" && error && "message" in error ? String((error as { message: unknown }).message) : String(error);
}
function startError(adapter: Adapter, error: unknown, stderr: string) {
  const text = `${message(error)}\n${stderr}`;
  if (/auth|login|sign.?in|credential|api key/i.test(text))
    return `${adapter.name} isn't signed in. Run \`${adapter.kind === "claude" ? "claude" : "codex"}\` once in a terminal to sign in, then start it again.`;
  return `Couldn't start ${adapter.name}: ${message(error)}`;
}

/** All agent sessions of one Studio service. */
export class AgentHub {
  private sessions = new Map<string, AgentSession>();

  kinds() {
    return ADAPTERS.map((a) => {
      let available = overrides.has(a.kind);
      try {
        available ||= !!a.entry();
      } catch {}
      return { kind: a.kind, name: a.name, available };
    });
  }
  list(root?: string): AgentSummary[] {
    return [...this.sessions.values()]
      .filter((s) => !root || s.root === root)
      .filter((s) => s.status !== "stopped")
      .map((s) => s.summary());
  }
  get(id: string): AgentSession {
    const session = this.sessions.get(id);
    if (!session) throw Object.assign(new Error("No such agent session."), { status: 404 });
    return session;
  }
  /** One running session per worktree and agent; reuses a live one. */
  async start(kind: AgentKind, root: string, restricted: boolean): Promise<AgentSummary> {
    if (restricted)
      throw Object.assign(
        new Error("Agents run code in this folder. Trust the folder first, then start the agent."),
        { status: 403 },
      );
    const live = [...this.sessions.values()].find(
      (s) => s.adapter.kind === kind && s.root === root && !["stopped", "error"].includes(s.status),
    );
    if (live) return live.summary();
    const adapter = ADAPTERS.find((a) => a.kind === kind);
    if (!adapter) throw new Error(`Unknown agent: ${kind}`);
    const session = new AgentSession(adapter, root, {
      command: process.execPath,
      args: [path.join(here, "cli.ts"), "mcp", root],
    });
    this.sessions.set(session.id, session);
    await session.start();
    return session.summary();
  }
  stopAll() {
    for (const s of this.sessions.values()) s.stop();
  }
}

/** Per-worktree agent preferences (auto-send notes, preferred agent). */
export type AgentSettings = { autoSendNotes: boolean; agent: AgentKind };
const settingsFile = (root: string) => path.join(root, ".demohunter", "studio", "agents.json");
export async function readAgentSettings(root: string): Promise<AgentSettings> {
  try {
    const value = JSON.parse(await readFile(settingsFile(root), "utf8"));
    return {
      autoSendNotes: value.autoSendNotes === true,
      agent: value.agent === "codex" ? "codex" : "claude",
    };
  } catch {
    return { autoSendNotes: false, agent: "claude" };
  }
}
export async function writeAgentSettings(root: string, settings: AgentSettings) {
  await ensureIgnoredFolder(root, ".demohunter/studio");
  await writeJson(settingsFile(root), settings);
}
