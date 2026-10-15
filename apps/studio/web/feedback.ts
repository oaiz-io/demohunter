import type { AgentActivity } from "../contract.js";
export class AgentFeedback {
  private focused?: AgentActivity;
  private root = document.querySelector<HTMLElement>("#agent-activity")!;
  constructor(
    private box: (ref: string) => DOMRect | undefined,
    private select: (ref: string) => void,
  ) {}
  update(events: AgentActivity[]) {
    const now = Date.now();
    this.focused = events.find(
      (e) =>
        e.status === "running" ||
        now - Date.parse(e.finishedAt ?? e.startedAt) < 4500,
    );
    const event = this.focused;
    for (const card of document.querySelectorAll<HTMLElement>(
      ".narration-card",
    ))
      card.classList.toggle(
        "agent-editing",
        !!event?.segmentId && card.dataset.id === event.segmentId,
      );
    this.root.hidden = !event;
    if (event) {
      this.root.dataset.state = event.status;
      this.root.querySelector(".agent-activity-label")!.textContent =
        `${event.actor} · ${event.label}${event.status === "succeeded" ? " · Done" : event.status === "failed" ? " · Failed" : ""}`;
      const focus = this.root.querySelector<HTMLButtonElement>("button")!;
      focus.hidden = !event.elementRef;
      focus.onclick = () => {
        if (event.elementRef) this.select(event.elementRef);
      };
    }
    const list = document.querySelector("#agent-activity-list")!;
    list.replaceChildren();
    for (const e of events.slice(0, 12)) {
      const row = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = `${e.actor} · ${e.label}`;
      const status = document.createElement("small");
      status.textContent = e.status;
      row.append(label, status);
      if (e.elementRef) {
        const button = document.createElement("button");
        button.textContent = "Show element";
        button.onclick = () => this.select(e.elementRef!);
        row.append(button);
      }
      if (e.error) {
        const error = document.createElement("p");
        error.textContent = e.error;
        row.append(error);
      }
      list.append(row);
    }
    if (!events.length) {
      const li = document.createElement("li");
      li.textContent =
        "Agent tool activity appears here when an MCP agent inspects or edits this recording.";
      list.append(li);
    }
    this.draw();
  }
  draw() {
    const outline = document.querySelector<HTMLElement>("#agent-target")!;
    const event = this.focused;
    const rect = event?.elementRef ? this.box(event.elementRef) : undefined;
    outline.hidden = !rect;
    if (!rect) return;
    Object.assign(outline.style, {
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    outline.dataset.state = event!.status;
  }
}
