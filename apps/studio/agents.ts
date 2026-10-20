import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { ensureIgnoredFolder, writeJson } from "./storage.js";
import { openTerminal, type TerminalResult } from "./terminal.js";

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
    entry: () => packageFile("@agentclientprotocol/codex-acp", "dist/index.js"),
  },
];

/** An executable on the person's PATH, if there is one. */
function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  // Absolute entries only: "." would find a `codex` shipped in the repository.
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter((d) => path.isAbsolute(d))) {
    const file = path.join(dir, name);
    try {
      accessSync(file, fsConstants.X_OK);
      return file;
    } catch {}
  }
}
/** The person's environment for an agent. Codex runs the person's own
 * `codex` when they have one, so it matches their login, config and models
 * (the adapter's bundled copy can lag behind them). */
function agentEnv(kind: AgentKind): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (kind === "codex" && !env.CODEX_PATH) {
    const own = onPath("codex", env);
    if (own) env.CODEX_PATH = own;
  }
  return env;
}

/** A choice the agent offers for its session: the model or the mode. */
export type AgentOption = {
  id: string;
  name: string;
  category: "model" | "mode";
  current: string;
  choices: { value: string; name: string; description?: string }[];
};
function readOptions(raw: unknown): AgentOption[] {
  if (!Array.isArray(raw)) return [];
  const options: AgentOption[] = [];
  for (const o of raw as Record<string, unknown>[]) {
    const category = o.category === "model" || o.id === "model" ? "model" : o.category === "mode" || o.id === "mode" ? "mode" : undefined;
    if (!category || o.type !== "select" || typeof o.id !== "string" || !Array.isArray(o.options)) continue;
    // Options can be grouped; flatten the groups.
    const flat = (o.options as Record<string, unknown>[]).flatMap((c) =>
      Array.isArray(c.options) ? (c.options as Record<string, unknown>[]) : [c],
    );
    options.push({
      id: o.id,
      name: typeof o.name === "string" ? o.name : o.id,
      category,
      current: String(o.currentValue ?? ""),
      choices: flat
        .filter((c) => typeof c.value === "string")
        .map((c) => ({
          value: c.value as string,
          name: typeof c.name === "string" ? c.name : (c.value as string),
          ...(typeof c.description === "string" ? { description: c.description } : {}),
        })),
    });
  }
  return options;
}
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
/** Which DemoHunter tool a permission request is for, from what the agent
 * reports about the call — never its free-form title, which for a shell
 * command is the command itself and can say anything. Claude Code names the
 * tool and its MCP server in _meta; Codex's MCP call announces itself as
 * "mcp.<server>.<tool>" in its tool_call event. */
function demoToolName(
  call: acp.ToolCallUpdate,
  announced?: { title: string; kind?: string },
): string | undefined {
  const claude = (call._meta as { claudeCode?: { toolName?: unknown; mcpServer?: { name?: unknown } } } | undefined)
    ?.claudeCode;
  if (claude) {
    if (typeof claude.toolName !== "string" || (claude.mcpServer && claude.mcpServer.name !== "demohunter")) return;
    return /^mcp__demohunter__([a-z0-9_]+)$/.exec(claude.toolName)?.[1];
  }
  if (!announced || ["execute", "edit", "delete", "move"].includes(announced.kind ?? "")) return;
  return /^mcp\.demohunter\.([a-z0-9_]+)$/.exec(announced.title)?.[1];
}

/** Modes that stop asking before the agent acts. They are offered, but never
 * restored on their own: a repository could otherwise ship (or an agent
 * write) settings that start the next session with no prompts. */
export const unsafeMode = (choice: { value: string; name?: string }) =>
  /bypass|full|never|danger|yolo/i.test(`${choice.value} ${choice.name ?? ""}`);

/** Tests point a kind at a scripted agent. */
const overrides = new Map<AgentKind, string>();
/** Tests record terminal launches instead of opening Terminal. */
let terminalLauncher: ((script: string) => Promise<unknown>) | undefined;
export function useTerminalLauncher(launch: ((script: string) => Promise<unknown>) | undefined) {
  terminalLauncher = launch;
}
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
  | {
      seq: number;
      at: string;
      type: "notice";
      text: string;
      tone?: "error";
      /** The agent needs the person to sign in; the panel offers it. */
      signIn?: boolean;
    }
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
  | { type: "status"; status: AgentStatus }
  | { type: "options"; options: AgentOption[] }
  | { type: "yolo"; on: boolean };

export type AgentSummary = {
  id: string;
  kind: AgentKind;
  name: string;
  root: string;
  status: AgentStatus;
  startedAt: string;
  /** Model and mode choices the agent offers, with the current ones. */
  options: AgentOption[];
  /** Every tool request is approved without asking. */
  yolo: boolean;
  /** Started from the New demo page; the editor doesn't follow it until it
   * is handed over there. */
  purpose?: "create";
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
  options: AgentOption[] = [];
  /** Approve every tool request without asking (this session only; never saved). */
  yolo = false;
  /** Set for a New demo session until it is handed over to the editor. */
  purpose?: "create";
  /** Settles when the session can take prompts (or failed to start). */
  private ready: Promise<void> = Promise.resolve();

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
      options: this.options,
      yolo: this.yolo,
      ...(this.purpose ? { purpose: this.purpose } : {}),
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

  async start(preferred: { model?: string; mode?: string } = {}): Promise<void> {
    const entry = overrides.get(this.adapter.kind) ?? this.adapter.entry();
    // The agent runs as the person, in the demo's worktree, with their own
    // environment (login, PATH, API keys).
    const child = spawn(process.execPath, [entry], {
      cwd: this.root,
      env: agentEnv(this.adapter.kind),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr!.on("data", (d) => (this.stderr = (this.stderr + d).slice(-4000)));
    child.once("exit", (code, signal) => {
      for (const p of this.pending.values()) {
        p.event.chosen = "cancelled";
        this.emit(p.event, false);
        p.resolve({ outcome: { outcome: "cancelled" } });
      }
      this.pending.clear();
      // Stopped on purpose, or a failed start that already said why.
      if (this.status === "stopped" || this.status === "error") return;
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
    let settle!: () => void;
    this.ready = new Promise<void>((resolve) => (settle = resolve));
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
      this.options = readOptions((session as { configOptions?: unknown }).configOptions);
      for (const listener of this.listeners) listener({ type: "options", options: this.options });
      // The person's last choices for this worktree, when the agent still
      // offers them; never a mode that stops asking.
      for (const [category, value] of Object.entries(preferred) as ["model" | "mode", string | undefined][]) {
        const option = this.options.find((o) => o.category === category);
        const choice = option?.choices.find((c) => c.value === value);
        if (!option || !choice || option.current === value || (category === "mode" && unsafeMode(choice))) continue;
        await this.setOption(option.id, choice.value).catch(() => {});
      }
      this.setStatus("idle");
      settle();
    } catch (error) {
      settle();
      this.add("notice", { ...startError(this.adapter, error, this.stderr), tone: "error" });
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
          // One message is capped, so a runaway stream can't grow without bound.
          if (last.text.length > 200_000) return;
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
      case "config_option_update": {
        this.options = readOptions((update as { configOptions?: unknown }).configOptions);
        for (const listener of this.listeners) listener({ type: "options", options: this.options });
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
    if (this.yolo) {
      const allow = params.options.find((o) => o.kind === "allow_once") ?? params.options.find((o) => o.kind === "allow_always");
      if (allow) return { outcome: { outcome: "selected", optionId: allow.optionId } };
    }
    const tool = demoToolName(params.toolCall, this.tools.get(params.toolCall.toolCallId));
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
    if (this.status === "error" || this.status === "stopped")
      throw new Error(`${this.adapter.name} stopped. Start it again.`);
    if (!this.conn) throw new Error(`${this.adapter.name} isn't ready yet.`);
    this.add("user", { text, context });
    const run = async () => {
      // A message sent while the agent starts waits for it.
      await this.ready;
      // (The status may have changed while waiting.)
      if (!this.acpSession || ["error", "stopped"].includes(this.status as AgentStatus)) return;
      this.setStatus("working");
      try {
        const result = await this.conn!.prompt({
          sessionId: this.acpSession!,
          prompt: [{ type: "text", text: `${preamble}\n\n${text}` }],
        });
        this.add("done", { stopReason: result.stopReason });
      } catch (error) {
        // A signed-out agent starts fine and fails on its first message.
        this.add(
          "notice",
          needsSignIn(message(error))
            ? { text: `${this.adapter.name} isn't signed in. Sign in, then send your message again.`, tone: "error", signIn: true }
            : { text: message(error), tone: "error" },
        );
      } finally {
        if (this.status !== "error" && this.status !== "stopped")
          this.setStatus(this.pending.size ? "waiting" : "idle");
      }
    };
    this.queue = this.queue.then(run, run);
  }

  /** YOLO: approve every tool request from now on (and the ones waiting). */
  setYolo(on: boolean) {
    this.yolo = on;
    if (on)
      for (const [id, p] of [...this.pending]) {
        const allow = p.event.options.find((o) => o.kind === "allow_once") ?? p.event.options.find((o) => o.kind === "allow_always");
        if (allow) this.answer(id, allow.optionId);
      }
    for (const listener of this.listeners) listener({ type: "yolo", on });
  }

  /** Choose a model or mode for this session. */
  async setOption(id: string, value: string): Promise<AgentOption[]> {
    if (!this.conn || !this.acpSession) throw new Error(`${this.adapter.name} isn't ready yet.`);
    const option = this.options.find((o) => o.id === id);
    if (!option) throw new Error(`${this.adapter.name} has no ${id} setting.`);
    if (!option.choices.some((c) => c.value === value)) throw new Error(`Unknown ${option.name.toLowerCase()}: ${value}`);
    const result = await this.conn.setSessionConfigOption({ sessionId: this.acpSession, configId: id, value });
    this.options = readOptions(result.configOptions);
    for (const listener of this.listeners) listener({ type: "options", options: this.options });
    return this.options;
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
const needsSignIn = (text: string) => /auth|log ?in|sign.?in|credential|api key|unauthori[sz]ed|401/i.test(text);
function startError(adapter: Adapter, error: unknown, stderr: string) {
  if (needsSignIn(`${message(error)}\n${stderr}`))
    return {
      text: `${adapter.name} isn't signed in. Sign in (or run \`${adapter.kind === "claude" ? "claude" : "codex"}\` once in a terminal), then start it again.`,
      signIn: true,
    };
  return { text: `Couldn't start ${adapter.name}: ${message(error)}` };
}

/** The command line for an agent in a terminal: its own sign-in, or the
 * agent itself in the worktree with Studio's MCP server and the chosen model. */
export function terminalCommand(
  kind: AgentKind,
  root: string,
  purpose: "signin" | "run",
  model?: string,
): string[] {
  const env = agentEnv(kind);
  const mcp = { command: process.execPath, args: [path.join(here, "cli.ts"), "mcp", root] };
  if (kind === "claude") {
    // The adapter's --cli runs the Claude Code it ships with, so this works
    // without a separate install; it shares the person's ~/.claude login.
    const claude = [process.execPath, ADAPTERS[0]!.entry(), "--cli"];
    if (purpose === "signin") return [...claude, "auth", "login", "--claudeai"];
    return [
      ...claude,
      ...(model && model !== "default" ? ["--model", model] : []),
      "--mcp-config",
      JSON.stringify({ mcpServers: { demohunter: { ...mcp, env: { DEMOHUNTER_AGENT_NAME: "Claude Code" } } } }),
    ];
  }
  const codex = env.CODEX_PATH
    ? [env.CODEX_PATH]
    : [process.execPath, createRequire(ADAPTERS[1]!.entry()).resolve("@openai/codex/bin/codex.js")];
  if (purpose === "signin") return [...codex, "login"];
  return [
    ...codex,
    ...(model ? ["-m", model] : []),
    "-c",
    `mcp_servers.demohunter.command=${JSON.stringify(mcp.command)}`,
    "-c",
    `mcp_servers.demohunter.args=${JSON.stringify(mcp.args)}`,
    "-c",
    'mcp_servers.demohunter.env.DEMOHUNTER_AGENT_NAME="Codex"',
  ];
}

/** All agent sessions of one Studio service. */
export class AgentHub {
  private sessions = new Map<string, AgentSession>();
  /** Starts in flight, so a warm-up and a click share one session. */
  private starting = new Map<string, Promise<AgentSummary>>();

  kinds() {
    return ADAPTERS.map((a) => {
      let available = overrides.has(a.kind);
      try {
        available ||= !!a.entry();
      } catch {}
      return { kind: a.kind, name: a.name, available };
    });
  }
  /** Live sessions, newest first: the editor's own, or New demo ones. */
  list(root?: string, purpose?: "create"): AgentSummary[] {
    return [...this.sessions.values()]
      .reverse()
      .filter((s) => !root || s.root === root)
      .filter((s) => s.purpose === purpose)
      .filter((s) => s.status !== "stopped")
      .map((s) => s.summary());
  }
  get(id: string): AgentSession {
    const session = this.sessions.get(id);
    if (!session) throw Object.assign(new Error("No such agent session."), { status: 404 });
    return session;
  }
  /** One running session per worktree and agent; reuses a live one. A New
   * demo session (`purpose: "create"`) is separate from the editor's, and
   * `fresh` starts a new one for a new demo instead of reusing it. */
  async start(
    kind: AgentKind,
    root: string,
    restricted: boolean,
    preferred: { model?: string; mode?: string } = {},
    { purpose, fresh = false }: { purpose?: "create"; fresh?: boolean } = {},
  ): Promise<AgentSummary> {
    if (restricted)
      throw Object.assign(
        new Error("Agents run code in this folder. Trust the folder first, then start the agent."),
        { status: 403 },
      );
    const key = `${kind}\0${root}\0${purpose ?? ""}`;
    // A start in flight answers first: its session is listed as "starting".
    const inFlight = this.starting.get(key);
    if (inFlight) return inFlight;
    const same = (s: AgentSession) => s.adapter.kind === kind && s.root === root && s.purpose === purpose;
    const live = [...this.sessions.values()]
      .reverse()
      .find((s) => same(s) && !["stopped", "error"].includes(s.status));
    if (live && !fresh) return live.summary();
    // A new demo: earlier New demo agents that sit idle go (one still working
    // on another demo keeps going).
    if (fresh) for (const s of this.sessions.values()) if (same(s) && s.status === "idle") s.stop();
    // Ended sessions of this agent and worktree go; the new one replaces them.
    for (const [id, s] of this.sessions)
      if (s.adapter.kind === kind && s.root === root && ["stopped", "error"].includes(s.status)) this.sessions.delete(id);
    const adapter = ADAPTERS.find((a) => a.kind === kind);
    if (!adapter) throw new Error(`Unknown agent: ${kind}`);
    const session = new AgentSession(adapter, root, {
      command: process.execPath,
      args: [path.join(here, "cli.ts"), "mcp", root],
    });
    session.purpose = purpose;
    this.sessions.set(session.id, session);
    const started = session.start(preferred).then(() => session.summary());
    this.starting.set(key, started);
    try {
      return await started;
    } finally {
      this.starting.delete(key);
    }
  }
  /** Open a terminal in the worktree for an agent: sign in, or run it there. */
  terminal(kind: AgentKind, root: string, restricted: boolean, purpose: "signin" | "run", model?: string): Promise<TerminalResult> {
    if (restricted)
      throw Object.assign(new Error("Agents run code in this folder. Trust the folder first."), { status: 403 });
    if (!ADAPTERS.some((a) => a.kind === kind)) throw new Error(`Unknown agent: ${kind}`);
    return openTerminal(root, terminalCommand(kind, root, purpose, model), terminalLauncher);
  }
  /** Hand a New demo session to the editor: it becomes the worktree's
   * agent there (the newest one), with its thread. */
  adopt(id: string): AgentSummary {
    const session = this.get(id);
    session.purpose = undefined;
    this.sessions.delete(id);
    this.sessions.set(id, session);
    return session.summary();
  }
  stopAll() {
    for (const s of this.sessions.values()) s.stop();
  }
}

/** Per-worktree agent preferences: auto-send notes, the preferred agent, and
 * each agent's last model and mode. */
export type AgentSettings = {
  autoSendNotes: boolean;
  agent: AgentKind;
  models: Partial<Record<AgentKind, string>>;
  modes: Partial<Record<AgentKind, string>>;
};
const choiceMap = (value: unknown): Partial<Record<AgentKind, string>> => {
  const out: Partial<Record<AgentKind, string>> = {};
  if (value && typeof value === "object")
    for (const kind of ["claude", "codex"] as const) {
      const v = (value as Record<string, unknown>)[kind];
      if (typeof v === "string" && v.length <= 200) out[kind] = v;
    }
  return out;
};
const settingsFile = (root: string) => path.join(root, ".demohunter", "studio", "agents.json");
export async function readAgentSettings(root: string): Promise<AgentSettings> {
  try {
    const value = JSON.parse(await readFile(settingsFile(root), "utf8"));
    return {
      autoSendNotes: value.autoSendNotes === true,
      agent: value.agent === "codex" ? "codex" : "claude",
      models: choiceMap(value.models),
      modes: choiceMap(value.modes),
    };
  } catch {
    return { autoSendNotes: false, agent: "claude", models: {}, modes: {} };
  }
}
export async function writeAgentSettings(root: string, settings: AgentSettings) {
  await ensureIgnoredFolder(root, ".demohunter/studio");
  await writeJson(settingsFile(root), settings);
}
/** Change some settings: read, change and write one at a time per worktree,
 * so two quick changes (model, then mode) don't overwrite each other. */
const settingsQueues = new Map<string, Promise<unknown>>();
export function updateAgentSettings(root: string, change: (settings: AgentSettings) => void): Promise<AgentSettings> {
  const run = (settingsQueues.get(root) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const settings = await readAgentSettings(root);
    change(settings);
    await writeAgentSettings(root, settings);
    return settings;
  });
  settingsQueues.set(root, run);
  void run.finally(() => {
    if (settingsQueues.get(root) === run) settingsQueues.delete(root);
  });
  return run;
}
