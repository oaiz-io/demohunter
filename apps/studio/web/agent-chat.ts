import type { AgentEvent, AgentOption, AgentStatus, AgentSummary, AgentSettings } from "../agents.js";
import { renderMarkdown } from "./markdown.js";
import { changesSeenKey } from "./workbench.js";

/**
 * The Agents panel: start the person's own coding agent inside Studio, chat
 * with it, approve its tool calls and send notes to it. The agent runs in the
 * demo's worktree with Studio's MCP server attached (see agents.ts); this
 * module only talks to the library service's /api/agents routes.
 */
type Info = {
  root: string;
  /** Where agents run: the demo's repository checkout or worktree. */
  place: { name: string; branch?: string };
  trusted: boolean;
  kinds: { kind: AgentSummary["kind"]; name: string; available: boolean }[];
  sessions: AgentSummary[];
  settings: AgentSettings;
};
type Hooks = {
  /** Library project id of the demo on screen. */
  project: () => string;
  time: () => number;
  selection: () => { ref?: string; label?: string } | undefined;
  /** Playing (not paused) in the editor. */
  playing?: () => boolean;
  /** Element refs on screen in the current frame. */
  visible?: () => string[];
  error: (e: unknown) => void;
  /** The panel's status changed (tab badge). */
  status: (status: AgentStatus | undefined) => void;
  /** A short confirmation. */
  toast: (text: string) => void;
  /** What an agent changed in the demo between two times, as a receipt for
   * the end of its turn (none when it changed nothing). */
  receipt?: (actor: string, fromMs: number, toMs: number) => HTMLElement | undefined;
  /** The Changes view was opened (its count resets). */
  changesSeen?: () => void;
};

export type AgentView = "chat" | "changes";
/** Show the chat or the changes (what agents changed, by turn). */
export function setAgentView(view: AgentView) {
  const changes = view === "changes";
  for (const tab of document.querySelectorAll<HTMLButtonElement>("[data-agent-view]"))
    tab.setAttribute("aria-selected", String(tab.dataset.agentView === view));
  document.querySelector<HTMLElement>("#panel-agent")!.dataset.view = view;
  document.querySelector<HTMLElement>("#agent-changes")!.hidden = !changes;
}

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};
const clock = (ms: number) =>
  `${Math.floor(ms / 60000).toString().padStart(2, "0")}:${((ms / 1000) % 60).toFixed(1).padStart(4, "0")}`;
/** "mcp__demohunter__apply_element_edit" (Claude) or
 * "mcp.demohunter.apply_element_edit" (Codex) → "DemoHunter · apply element edit". */
const toolTitle = (title: string) => {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(title) ?? /^mcp\.([^.]+)\.(.+)$/.exec(title);
  if (!m) return title;
  const server = m[1] === "demohunter" ? "DemoHunter" : m[1]!;
  return `${server} · ${m[2]!.replace(/_/g, " ")}`;
};
const STATUS_TEXT: Record<AgentStatus, string> = {
  starting: "starting…",
  idle: "ready",
  working: "working",
  waiting: "needs you",
  stopped: "stopped",
  error: "stopped",
};

/** Without the library service there is no in-app agent: only the activity
 * of agents connected over MCP. */
export function standaloneAgents() {
  document.body.classList.add("no-agent-chat");
  setAgentView("changes");
}

export class AgentChat {
  private info?: Info;
  private session?: AgentSummary;
  private events = new Map<number, AgentEvent>();
  private nodes = new Map<number, HTMLElement>();
  private stream?: EventSource;
  private starting?: AgentSummary["kind"];
  private warmed = false;
  /** A message on its way to the agent (before it starts working on it). */
  private sending = false;
  /** When the current turn began, for the elapsed time. */
  private turnStarted?: number;
  /** A restart in progress; anything that needs the agent waits for it. */
  private restarting?: Promise<AgentSummary>;
  readonly available: Promise<boolean>;

  constructor(private hooks: Hooks) {
    const form = document.querySelector<HTMLFormElement>("#agent-composer")!;
    const input = document.querySelector<HTMLTextAreaElement>("#agent-input")!;
    form.onsubmit = (e) => {
      e.preventDefault();
      void this.submit();
    };
    input.addEventListener("keydown", (e) => {
      // Enter sends; Shift+Enter is a new line.
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.submit();
      }
    });
    document.querySelector<HTMLButtonElement>("#agent-stop")!.onclick = () =>
      void this.post(`/api/agents/${this.session?.id}/cancel`, {}).catch(hooks.error);
    document.querySelector<HTMLInputElement>("#agent-autosend")!.onchange = (e) =>
      void this.saveSettings({ autoSendNotes: (e.target as HTMLInputElement).checked });
    for (const category of ["model", "mode"] as const)
      document.querySelector<HTMLSelectElement>(`#agent-${category}`)!.onchange = (e) =>
        void this.choose(category, (e.target as HTMLSelectElement).value);
    // The desktop app can trust the folder from here; it reopens Studio trusted.
    const trust = (window as { demohunterDesktop?: { trust?: () => unknown } }).demohunterDesktop?.trust;
    const trustButton = document.querySelector<HTMLButtonElement>("#agent-trust")!;
    trustButton.hidden = typeof trust !== "function";
    document.querySelector<HTMLElement>(".agent-trust-hint")!.hidden = typeof trust === "function";
    trustButton.onclick = () => void Promise.resolve(trust?.()).catch(hooks.error);
    for (const tab of document.querySelectorAll<HTMLButtonElement>("[data-agent-view]"))
      tab.onclick = () => this.showView(tab.dataset.agentView as AgentView);
    setAgentView("chat");
    document.querySelector<HTMLButtonElement>("#agent-terminal")!.onclick = () =>
      void this.terminal(this.session?.kind ?? this.info?.settings.agent ?? "claude", "run");
    // Start the preferred agent when the Agents panel opens, so it is ready
    // by the first message (not on every page load).
    const panel = document.querySelector<HTMLElement>("#panel-agent")!;
    new MutationObserver(() => {
      if (!panel.hidden) this.warm();
    }).observe(panel, { attributes: true, attributeFilter: ["hidden"] });
    this.available = this.refresh().then(
      () => {
        if (!panel.hidden) this.warm();
        return true;
      },
      () => {
        // Standalone Studio (one demo, no library service): no in-app agents.
        standaloneAgents();
        return false;
      },
    );
    setInterval(() => {
      if (!document.hidden) void this.refresh().catch(() => {});
    }, 5000);
    setInterval(() => this.renderContext(), 700);
    // The elapsed time of a running turn.
    setInterval(() => {
      if (this.turnStarted) this.renderActivity();
    }, 1000);
  }

  showView(view: AgentView) {
    setAgentView(view);
    if (view === "changes") {
      localStorage.setItem(changesSeenKey(), String(Date.now()));
      this.hooks.changesSeen?.();
    }
    if (view === "chat") document.querySelector<HTMLTextAreaElement>("#agent-input")!.focus({ preventScroll: true });
  }
  /** Re-draw the change receipts (the demo's history changed). */
  refreshReceipts() {
    for (const e of this.events.values()) if (e.type === "done") this.upsert(e);
  }

  get settings(): AgentSettings | undefined {
    return this.info?.settings;
  }
  private async post<T = unknown>(url: string, body: unknown): Promise<T> {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const value = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((value as { error?: string }).error ?? `Request failed (${r.status})`);
    return value as T;
  }

  async refresh(): Promise<void> {
    const r = await fetch(`/api/agents?project=${encodeURIComponent(this.hooks.project())}`);
    if (!r.ok) throw new Error("Agents are unavailable.");
    this.info = (await r.json()) as Info;
    const preferred = this.info.settings.agent;
    const live =
      this.info.sessions.find((s) => s.kind === preferred && s.status !== "error") ??
      this.info.sessions.find((s) => s.status !== "error");
    // Follow a live agent only when the open thread has none: nothing open,
    // or it stopped or failed (a failed thread says why until then).
    const open = this.session && this.info.sessions.find((s) => s.id === this.session!.id);
    if (live && live.id !== this.session?.id && (!open || ["error", "stopped"].includes(open.status)))
      this.connect(live);
    this.renderRoster();
    this.renderComposer();
    this.renderSetup();
  }

  /** Start the preferred agent as soon as the panel opens, so the first
   * message doesn't wait for it. Starting costs no model calls. */
  private warm() {
    const info = this.info;
    if (this.warmed || !info?.trusted) return;
    this.warmed = true;
    const kind = info.settings.agent;
    if (!info.kinds.some((k) => k.kind === kind && k.available)) return;
    if (info.sessions.some((s) => s.kind === kind && s.status !== "error")) return;
    // A failure shows in the thread (e.g. "isn't signed in"); no toast.
    void this.start(kind).catch(() => {});
  }

  /** Start (or reuse) the preferred agent for this demo's worktree. */
  async start(kind = this.info?.settings.agent ?? "claude"): Promise<AgentSummary> {
    if (this.restarting) return this.restarting;
    return this.startNow(kind);
  }
  private async startNow(kind: AgentSummary["kind"]): Promise<AgentSummary> {
    if (this.session && this.session.kind === kind && !["error", "stopped"].includes(this.session.status))
      return this.session;
    this.starting = kind;
    this.renderRoster();
    this.renderActivity();
    try {
      const summary = await this.post<AgentSummary>("/api/agents/start", { project: this.hooks.project(), kind });
      if (this.info && this.info.settings.agent !== kind) void this.saveSettings({ agent: kind });
      this.connect(summary);
      return summary;
    } catch (error) {
      // Show why: the failed session's thread says what to do next.
      await this.refresh().catch(() => {});
      const failed = this.info?.sessions.filter((s) => s.kind === kind && s.status === "error").at(-1);
      if (failed) this.connect(failed);
      throw error;
    } finally {
      this.starting = undefined;
      this.renderActivity();
      await this.refresh().catch(() => {});
    }
  }

  /** Open Terminal in the worktree: the agent's own sign-in, or the agent
   * itself with Studio's tools and the chosen model. */
  private async terminal(kind: AgentSummary["kind"], purpose: "signin" | "run") {
    const model = this.session?.kind === kind ? this.session.options?.find((o) => o.category === "model")?.current : undefined;
    try {
      const result = await this.post<{ opened: boolean; line: string }>("/api/agents/terminal", {
        project: this.hooks.project(),
        kind,
        purpose,
        ...(purpose === "run" && model ? { model } : {}),
      });
      if (result.opened) this.hooks.toast(purpose === "signin" ? "Finish signing in in Terminal" : "Opened in Terminal");
      else {
        await navigator.clipboard?.writeText(result.line).catch(() => {});
        this.hooks.toast("Command copied — paste it in a terminal");
      }
    } catch (error) {
      this.hooks.error(error);
    }
  }

  /** Pick a model or mode for the running agent (remembered per worktree). */
  private async choose(category: AgentOption["category"], value: string) {
    const session = this.session;
    const option = session?.options?.find((o) => o.category === category);
    if (!session || !option || option.current === value) return;
    try {
      const { options } = await this.post<{ options: AgentOption[] }>(`/api/agents/${session.id}/option`, {
        project: this.hooks.project(),
        id: option.id,
        value,
      });
      session.options = options;
    } catch (error) {
      // Show the choice that still applies.
      delete document.querySelector<HTMLSelectElement>(`#agent-${category}`)!.dataset.key;
      this.hooks.error(error);
    }
    this.renderSetup();
  }

  private connect(summary: AgentSummary) {
    this.stream?.close();
    this.session = summary;
    this.events.clear();
    this.nodes.clear();
    this.pendingRender.clear();
    document.querySelector("#agent-thread")!.replaceChildren();
    const stream = new EventSource(`/api/agents/${summary.id}/stream`);
    this.stream = stream;
    stream.onmessage = (message) => {
      const data = JSON.parse(message.data);
      if (data.type === "snapshot") {
        if (data.options) summary.options = data.options;
        summary.yolo = !!data.yolo;
        this.renderSetup();
        this.setStatus(data.status);
        for (const e of data.events as AgentEvent[]) this.upsert(e);
      } else if (data.type === "status") this.setStatus(data.status);
      else if (data.type === "yolo") {
        summary.yolo = data.on;
        this.renderSetup();
      } else if (data.type === "options") {
        summary.options = data.options;
        this.renderSetup();
      } else this.upsert(data.event as AgentEvent);
    };
    stream.onerror = () => {
      // The service restarted or the session ended; the next refresh decides.
      if (stream.readyState === EventSource.CLOSED) this.setStatus("stopped");
    };
    this.renderRoster();
    this.renderComposer();
    this.renderSetup();
  }

  private setStatus(status: AgentStatus) {
    if (!this.session) return;
    this.session.status = status;
    if (status === "working" || status === "waiting") this.turnStarted ??= Date.now();
    else this.turnStarted = undefined;
    this.renderActivity();
    this.hooks.status(status);
    this.renderRoster();
    this.renderComposer();
  }

  /** Send the composer text (starting the agent first if needed). */
  private async submit() {
    const input = document.querySelector<HTMLTextAreaElement>("#agent-input")!;
    const text = input.value.trim();
    if (!text || this.sending) return;
    this.sending = true;
    this.renderActivity();
    try {
      await this.send(text);
      if (input.value.trim() === text) input.value = "";
    } catch (error) {
      this.hooks.error(error);
    } finally {
      this.sending = false;
      this.renderActivity();
    }
  }
  async send(text: string, notes?: string[]): Promise<void> {
    // To the agent whose thread is open (else the preferred one).
    const session = await this.start(this.session?.kind);
    const selection = this.hooks.selection();
    await this.post(`/api/agents/${session.id}/prompt`, {
      text,
      project: this.hooks.project(),
      outputMs: Math.round(this.hooks.time()),
      playing: this.hooks.playing?.() ?? false,
      visible: this.hooks.visible?.() ?? [],
      ...(selection?.ref ? { selection } : {}),
      ...(notes?.length ? { notes } : {}),
    });
  }
  /** Hand notes to the agent ("Send to agent" or auto-send). */
  sendNotes(ids: string[]): Promise<void> {
    return this.send(
      ids.length === 1 ? "Please address this note." : `Please address these ${ids.length} notes.`,
      ids,
    );
  }
  private async saveSettings(patch: Partial<AgentSettings>) {
    if (!this.info) return;
    this.info.settings = { ...this.info.settings, ...patch };
    await this.post("/api/agents/settings", { project: this.hooks.project(), ...this.info.settings }).catch(this.hooks.error);
    this.renderComposer();
  }

  // ------------------------------------------------------------ rendering

  private renderRoster() {
    const roster = document.querySelector<HTMLElement>("#agent-roster")!;
    const info = this.info;
    if (!info) return;
    const pills: HTMLElement[] = [];
    for (const kind of info.kinds.filter((k) => k.available)) {
      const live = this.session?.kind === kind.kind ? this.session : info.sessions.find((s) => s.kind === kind.kind);
      const button = make("button", "roster-pill") as HTMLButtonElement;
      button.type = "button";
      button.dataset.kind = kind.kind;
      const dot = make("span", "roster-dot");
      button.append(dot, make("span", "roster-name", kind.name));
      if (live) {
        button.dataset.status = live.status;
        button.append(make("span", "roster-status", STATUS_TEXT[live.status]));
        button.setAttribute("aria-pressed", String(live.id === this.session?.id));
        button.onclick = () => {
          if (["error", "stopped"].includes(live.status)) void this.start(kind.kind).catch(this.hooks.error);
          else this.connect(live);
        };
      } else {
        button.dataset.status = "off";
        button.append(make("span", "roster-status", this.starting === kind.kind ? "starting…" : "start"));
        button.title = `Start ${kind.name} in this worktree`;
        if (this.starting === kind.kind) button.dataset.status = "starting";
        button.disabled = !!this.starting || !info.trusted;
        button.onclick = () => void this.start(kind.kind).catch(this.hooks.error);
      }
      pills.push(button);
    }
    roster.replaceChildren(...pills);
    const thread = document.querySelector<HTMLElement>("#agent-thread")!;
    const empty = document.querySelector<HTMLElement>("#agent-empty")!;
    empty.hidden = !!this.session && this.events.size > 0;
    empty.querySelector(".agent-empty-trust")!.toggleAttribute("hidden", info.trusted);
    thread.hidden = !this.session;
  }

  /** What the agent is doing right now, at the end of the thread: starting,
   * thinking, writing, running a tool or waiting for an approval. */
  private renderActivity() {
    const box = document.querySelector<HTMLElement>("#agent-working")!;
    const session = this.session;
    const name =
      session?.name ?? this.info?.kinds.find((k) => k.kind === (this.starting ?? this.info?.settings.agent))?.name ?? "The agent";
    let text: string | undefined;
    let state = "busy";
    if (this.starting || session?.status === "starting") text = `Starting ${name}…`;
    else if (session?.status === "waiting") {
      text = `${name} is waiting for your approval`;
      state = "waiting";
    } else if (session?.status === "working") {
      const last = [...this.events.values()].at(-1);
      if (last?.type === "tool" && ["pending", "in_progress"].includes(last.status)) text = `Running ${toolTitle(last.title)}…`;
      else if (last?.type === "agent") text = `${name} is writing…`;
      else text = `${name} is thinking…`;
    } else if (this.sending) text = "Sending…";
    box.hidden = !text;
    box.dataset.state = state;
    document.querySelector<HTMLButtonElement>("#agent-send")!.classList.toggle("is-sending", this.sending);
    if (!text) return;
    const label = document.querySelector<HTMLElement>("#agent-working-text")!;
    if (label.textContent !== text) label.textContent = text;
    const seconds = this.turnStarted ? Math.floor((Date.now() - this.turnStarted) / 1000) : 0;
    document.querySelector<HTMLElement>("#agent-working-time")!.textContent =
      seconds >= 2 ? (seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`) : "";
    // Keep it in view while following the thread.
    const scroller = document.querySelector<HTMLElement>("#agent-scroll")!;
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120) scroller.scrollTop = scroller.scrollHeight;
  }

  /** Where the agent works, and its model and mode. */
  private renderSetup() {
    const setup = document.querySelector<HTMLElement>("#agent-setup")!;
    const info = this.info;
    setup.hidden = !info || !info.trusted;
    if (!info) return;
    const yolo = document.querySelector<HTMLButtonElement>("#agent-yolo")!;
    yolo.hidden = !this.session?.yolo || this.session.status === "error";
    yolo.onclick = () => void this.post(`/api/agents/${this.session?.id}/yolo`, { on: false }).catch(this.hooks.error);
    const place = document.querySelector<HTMLElement>("#agent-place")!;
    place.textContent = `${info.place.name}${info.place.branch ? ` · ${info.place.branch}` : ""}`;
    place.title = `${this.session?.name ?? "Agents"} work in ${info.root}`;
    for (const category of ["model", "mode"] as const) {
      const select = document.querySelector<HTMLSelectElement>(`#agent-${category}`)!;
      const option = this.session?.status === "error" ? undefined : this.session?.options?.find((o) => o.category === category);
      select.parentElement!.hidden = !option;
      if (!option) continue;
      const key = `${this.session?.id}|${option.current}|${option.choices.map((c) => c.value).join(",")}`;
      if (select.dataset.key === key) continue;
      select.dataset.key = key;
      select.replaceChildren(
        ...option.choices.map((c) => {
          const o = make("option", undefined, c.name) as HTMLOptionElement;
          o.value = c.value;
          if (c.description) o.title = c.description;
          o.selected = c.value === option.current;
          return o;
        }),
      );
      select.title = `${option.name}: ${option.choices.find((c) => c.value === option.current)?.description ?? ""}`.trim();
    }
  }

  private renderComposer() {
    const name =
      this.session?.name ??
      this.info?.kinds.find((k) => k.kind === this.info?.settings.agent)?.name ??
      "Claude Code";
    const input = document.querySelector<HTMLTextAreaElement>("#agent-input")!;
    input.placeholder = `Ask ${name}… (Enter to send)`;
    input.disabled = this.info?.trusted === false;
    const working = this.session && ["working", "waiting"].includes(this.session.status);
    document.querySelector<HTMLButtonElement>("#agent-stop")!.hidden = !working;
    const auto = document.querySelector<HTMLInputElement>("#agent-autosend")!;
    auto.checked = !!this.info?.settings.autoSendNotes;
    auto.disabled = this.info?.trusted === false;
    document.querySelector("#agent-autosend-name")!.textContent = name;
  }

  private renderContext() {
    const chips = document.querySelector<HTMLElement>("#agent-chips");
    if (!chips || document.querySelector<HTMLElement>("#panel-agent")?.hidden) return;
    const selection = this.hooks.selection();
    const text = [clock(this.hooks.time()), selection?.label ?? selection?.ref].filter(Boolean) as string[];
    const key = text.join("|");
    if (chips.dataset.key === key) return;
    chips.dataset.key = key;
    chips.replaceChildren(...text.map((t) => make("span", "agent-chip", t)));
  }

  /** Streamed text re-renders at most once per frame, not once per chunk. */
  private pendingRender = new Map<number, AgentEvent>();
  private renderFrame?: number;
  private upsert(event: AgentEvent, follow = true) {
    if ((event.type === "agent" || event.type === "thought") && this.nodes.has(event.seq)) {
      this.events.set(event.seq, event);
      this.pendingRender.set(event.seq, event);
      this.renderFrame ??= requestAnimationFrame(() => {
        this.renderFrame = undefined;
        const due = [...this.pendingRender.values()];
        this.pendingRender.clear();
        for (const e of due) this.place(e, follow);
      });
      return;
    }
    this.place(event, follow);
  }
  private place(event: AgentEvent, follow: boolean) {
    this.events.set(event.seq, event);
    const thread = document.querySelector<HTMLElement>("#agent-thread")!;
    const scroller = document.querySelector<HTMLElement>("#agent-scroll")!;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    const next = this.renderEvent(event);
    const old = this.nodes.get(event.seq);
    if (old) old.replaceWith(next);
    else if (event.type === "tool") this.toolGroup(thread).append(next);
    else thread.append(next);
    this.nodes.set(event.seq, next);
    if (event.type === "tool") this.renderToolGroup(next.parentElement!.parentElement as HTMLDetailsElement);
    document.querySelector<HTMLElement>("#agent-empty")!.hidden = true;
    if (follow && (atBottom || event.type === "user" || event.type === "permission"))
      scroller.scrollTop = scroller.scrollHeight;
    this.renderActivity();
  }

  /** Consecutive tool calls share one folded line: "Used 4 tools". */
  private toolGroup(thread: HTMLElement): HTMLElement {
    const last = thread.lastElementChild;
    if (last?.classList.contains("agent-tools")) return last.querySelector(".agent-tools-list")!;
    const group = make("details", "agent-tools");
    group.append(make("summary"), make("div", "agent-tools-list"));
    thread.append(group);
    return group.querySelector(".agent-tools-list")!;
  }
  private renderToolGroup(group: HTMLDetailsElement) {
    const rows = [...group.querySelectorAll<HTMLElement>(".agent-tool")];
    const running = rows.find((r) => r.classList.contains("in_progress") || r.classList.contains("pending"));
    const failed = rows.filter((r) => r.classList.contains("failed")).length;
    const names = [...new Set(rows.map((r) => r.querySelector(".agent-tool-title")!.textContent!.replace(/^DemoHunter · /, "")))];
    const summary = group.querySelector("summary")!;
    summary.replaceChildren(
      make("span", `agent-tool-mark${running ? " spinning" : failed ? " failed" : ""}`, running ? "" : failed ? "✕" : "✓"),
      make(
        "span",
        "agent-tools-title",
        running
          ? `Running ${running.querySelector(".agent-tool-title")!.textContent}…`
          : `Used ${rows.length} tool${rows.length === 1 ? "" : "s"}${failed ? ` · ${failed} failed` : ""}`,
      ),
      make("span", "agent-tools-names", names.slice(0, 4).join(" · ")),
    );
  }

  private renderEvent(e: AgentEvent): HTMLElement {
    const name = this.session?.name ?? "Agent";
    switch (e.type) {
      case "user": {
        const box = make("div", "agent-msg user");
        box.append(make("div", "agent-meta", "You"), make("div", "agent-text", e.text));
        if (e.context?.length) {
          const chips = make("div", "agent-chips");
          chips.append(...e.context.map((c) => make("span", `agent-chip${c.startsWith("Note:") ? " note" : ""}`, c)));
          box.append(chips);
        }
        return box;
      }
      case "agent": {
        const box = make("div", "agent-msg agent");
        // Markdown, built as DOM (never HTML): see markdown.ts.
        const text = make("div", "agent-text md");
        text.append(renderMarkdown(e.text));
        box.append(make("div", "agent-meta", name), text);
        return box;
      }
      case "thought": {
        const box = make("details", "agent-thought");
        const text = make("div", "agent-text md");
        text.append(renderMarkdown(e.text));
        box.append(make("summary", undefined, "Thinking"), text);
        return box;
      }
      case "tool": {
        const row = make("div", `agent-tool ${e.status}`);
        row.append(make("span", "agent-tool-mark", e.status === "completed" ? "✓" : e.status === "failed" ? "✕" : ""), make("span", "agent-tool-title", toolTitle(e.title)));
        return row;
      }
      case "plan": {
        const list = make("ul", "agent-plan");
        for (const entry of e.entries) {
          const li = make("li", entry.status);
          li.append(make("span", "agent-plan-mark", entry.status === "completed" ? "✓" : ""), make("span", undefined, entry.content));
          list.append(li);
        }
        return list;
      }
      case "permission": {
        const card = make("div", `agent-permission${e.chosen ? " answered" : ""}`);
        card.append(make("div", "agent-permission-title", `${name} wants to: ${toolTitle(e.title)}`));
        if (e.detail) card.append(make("pre", "agent-permission-detail", e.detail));
        if (e.chosen) {
          const chosen = e.options.find((o) => o.optionId === e.chosen);
          card.append(make("div", "agent-permission-answer", e.chosen === "cancelled" ? "Cancelled" : chosen?.kind.startsWith("allow") ? `Allowed — ${chosen.name}` : "Denied"));
        } else {
          const actions = make("div", "agent-permission-actions");
          // YOLO: approve this and everything after it in this session.
          const yolo = make("button", "button small yolo", "YOLO") as HTMLButtonElement;
          yolo.type = "button";
          yolo.title = "Approve this and every tool request from now on (this session)";
          yolo.onclick = () => {
            for (const other of actions.querySelectorAll("button")) other.disabled = true;
            void this.post(`/api/agents/${this.session?.id}/yolo`, { on: true }).catch(this.hooks.error);
          };
          for (const option of e.options) {
            const b = make("button", option.kind === "allow_once" ? "button small primary" : option.kind.startsWith("reject") ? "quiet small-text deny" : "button small secondary", option.name) as HTMLButtonElement;
            b.type = "button";
            b.onclick = () => {
              for (const other of actions.querySelectorAll("button")) other.disabled = true;
              void this.post(`/api/agents/${this.session?.id}/permission`, { requestId: e.requestId, optionId: option.optionId }).catch(this.hooks.error);
            };
            actions.append(b);
          }
          actions.append(yolo);
          card.append(actions);
        }
        return card;
      }
      case "notice": {
        const box = make("div", `agent-notice${e.tone === "error" ? " is-error" : ""}`, e.text);
        if (e.signIn && this.session) {
          const kind = this.session.kind;
          const actions = make("div", "agent-notice-actions");
          const signIn = make("button", "button small primary", "Sign in…") as HTMLButtonElement;
          signIn.type = "button";
          signIn.onclick = () => void this.terminal(kind, "signin");
          const again = make("button", "button small secondary", "Start again") as HTMLButtonElement;
          again.type = "button";
          again.onclick = () => {
            const session = this.session;
            // A running session that failed a message is stopped first. It is
            // marked stopped at once, so a message typed meanwhile waits for
            // the new session instead of going to this one.
            const stopping =
              session && session.kind === kind && session.status !== "error"
                ? this.post(`/api/agents/${session.id}/stop`, {})
                : Promise.resolve();
            if (session) session.status = "stopped";
            this.renderRoster();
            // Held until the new session is up, so a message typed now goes to it.
            const restart = stopping.then(() => this.startNow(kind));
            this.restarting = restart;
            void restart.catch(this.hooks.error).finally(() => {
              if (this.restarting === restart) this.restarting = undefined;
            });
          };
          actions.append(signIn, again);
          box.append(actions);
        }
        return box;
      }
      case "done": {
        const box = make("div", "agent-done-wrap");
        box.append(make("div", "agent-done", e.stopReason === "cancelled" ? "Stopped" : e.stopReason === "end_turn" ? "" : `Ended: ${e.stopReason}`));
        // What this turn changed in the demo, from Studio's history.
        // The turn runs from its message to its end, and never into the next message.
        const all = [...this.events.values()];
        const asked = all.filter((x) => x.type === "user" && x.seq < e.seq).at(-1);
        const next = all.find((x) => x.type === "user" && x.seq > e.seq);
        const until = Math.min(Date.parse(e.at) + 1500, next ? Date.parse(next.at) : Infinity);
        const receipt = asked && this.hooks.receipt?.(name, Date.parse(asked.at), until);
        if (receipt) box.append(receipt);
        return box;
      }
    }
  }
}
