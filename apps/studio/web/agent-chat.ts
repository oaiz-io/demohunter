import type { AgentEvent, AgentStatus, AgentSummary, AgentSettings } from "../agents.js";

/**
 * The Agents panel: start the person's own coding agent inside Studio, chat
 * with it, approve its tool calls and send notes to it. The agent runs in the
 * demo's worktree with Studio's MCP server attached (see agents.ts); this
 * module only talks to the library service's /api/agents routes.
 */
type Info = {
  root: string;
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
  error: (e: unknown) => void;
  /** The panel's status changed (tab badge). */
  status: (status: AgentStatus | undefined) => void;
};

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};
const clock = (ms: number) =>
  `${Math.floor(ms / 60000).toString().padStart(2, "0")}:${((ms / 1000) % 60).toFixed(1).padStart(4, "0")}`;
/** "mcp__demohunter__apply_element_edit" → "DemoHunter · apply element edit". */
const toolTitle = (title: string) => {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(title);
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
  document.querySelector<HTMLDetailsElement>("#agent-activity-details")!.open = true;
}

export class AgentChat {
  private info?: Info;
  private session?: AgentSummary;
  private events = new Map<number, AgentEvent>();
  private nodes = new Map<number, HTMLElement>();
  private stream?: EventSource;
  private starting = false;
  private chatting?: boolean;
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
    this.available = this.refresh().then(
      () => true,
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
    if (live && live.id !== this.session?.id) this.connect(live);
    this.renderRoster();
    this.renderComposer();
  }

  /** Start (or reuse) the preferred agent for this demo's worktree. */
  async start(kind = this.info?.settings.agent ?? "claude"): Promise<AgentSummary> {
    if (this.session && this.session.kind === kind && !["error", "stopped"].includes(this.session.status))
      return this.session;
    this.starting = true;
    this.renderRoster();
    try {
      const summary = await this.post<AgentSummary>("/api/agents/start", { project: this.hooks.project(), kind });
      if (this.info && this.info.settings.agent !== kind) void this.saveSettings({ agent: kind });
      this.connect(summary);
      return summary;
    } finally {
      this.starting = false;
      await this.refresh().catch(() => {});
    }
  }

  private connect(summary: AgentSummary) {
    this.stream?.close();
    this.session = summary;
    this.events.clear();
    this.nodes.clear();
    document.querySelector("#agent-thread")!.replaceChildren();
    const stream = new EventSource(`/api/agents/${summary.id}/stream`);
    this.stream = stream;
    stream.onmessage = (message) => {
      const data = JSON.parse(message.data);
      if (data.type === "snapshot") {
        this.setStatus(data.status);
        for (const e of data.events as AgentEvent[]) this.upsert(e);
      } else if (data.type === "status") this.setStatus(data.status);
      else this.upsert(data.event as AgentEvent);
    };
    stream.onerror = () => {
      // The service restarted or the session ended; the next refresh decides.
      if (stream.readyState === EventSource.CLOSED) this.setStatus("stopped");
    };
    this.renderRoster();
    this.renderComposer();
  }

  private setStatus(status: AgentStatus) {
    if (!this.session) return;
    this.session.status = status;
    this.hooks.status(status);
    this.renderRoster();
    this.renderComposer();
  }

  /** Send the composer text (starting the agent first if needed). */
  private async submit() {
    const input = document.querySelector<HTMLTextAreaElement>("#agent-input")!;
    const text = input.value.trim();
    if (!text) return;
    try {
      await this.send(text);
      if (input.value.trim() === text) input.value = "";
    } catch (error) {
      this.hooks.error(error);
    }
  }
  async send(text: string, notes?: string[]): Promise<void> {
    const session = await this.start();
    const selection = this.hooks.selection();
    await this.post(`/api/agents/${session.id}/prompt`, {
      text,
      project: this.hooks.project(),
      outputMs: Math.round(this.hooks.time()),
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
        button.append(make("span", "roster-status", this.starting ? "starting…" : "start"));
        button.disabled = this.starting || !info.trusted;
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
    // Outside agents' activity (MCP) folds away once an in-app agent is
    // chatting; it is only decided when that changes, so a toggle sticks.
    const chatting = !!this.session;
    if (chatting !== this.chatting) {
      this.chatting = chatting;
      document.body.classList.toggle("agent-chatting", chatting);
      const details = document.querySelector<HTMLDetailsElement>("#agent-activity-details")!;
      if (chatting) {
        details.open = false;
        details.dataset.decided = "1";
      }
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

  private upsert(event: AgentEvent) {
    this.events.set(event.seq, event);
    const thread = document.querySelector<HTMLElement>("#agent-thread")!;
    const scroller = document.querySelector<HTMLElement>("#agent-scroll")!;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    const next = this.renderEvent(event);
    const old = this.nodes.get(event.seq);
    if (old) old.replaceWith(next);
    else thread.append(next);
    this.nodes.set(event.seq, next);
    document.querySelector<HTMLElement>("#agent-empty")!.hidden = true;
    if (atBottom || event.type === "user" || event.type === "permission")
      scroller.scrollTop = scroller.scrollHeight;
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
        box.append(make("div", "agent-meta", name), make("div", "agent-text", e.text));
        return box;
      }
      case "thought": {
        const box = make("details", "agent-thought");
        box.append(make("summary", undefined, "Thinking"), make("div", "agent-text", e.text));
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
          for (const option of e.options) {
            const b = make("button", option.kind === "allow_once" ? "button small primary" : option.kind.startsWith("reject") ? "quiet small-text deny" : "button small secondary", option.name) as HTMLButtonElement;
            b.type = "button";
            b.onclick = () => {
              for (const other of actions.querySelectorAll("button")) other.disabled = true;
              void this.post(`/api/agents/${this.session?.id}/permission`, { requestId: e.requestId, optionId: option.optionId }).catch(this.hooks.error);
            };
            actions.append(b);
          }
          card.append(actions);
        }
        return card;
      }
      case "notice":
        return make("div", `agent-notice${e.tone === "error" ? " error" : ""}`, e.text);
      case "done":
        return make("div", "agent-done", e.stopReason === "cancelled" ? "Stopped" : e.stopReason === "end_turn" ? "" : `Ended: ${e.stopReason}`);
    }
  }
}
