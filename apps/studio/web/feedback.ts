import type { AgentActivity } from "../contract.js";
import { WRITE_TOOLS } from "./agent.js";

const SETTLE_MS = 1200;
const PRESENT_MS = 5 * 60 * 1000;
/** Agent presence in the title bar and on the canvas. Everything comes from
 * real activity records; nothing here moves the user's playhead. */
export class AgentFeedback {
  private focused?: AgentActivity;
  private root = document.querySelector<HTMLElement>("#agent-activity")!;
  private target = document.querySelector<HTMLElement>("#agent-target")!;
  private latest: AgentActivity[] = [];
  constructor(
    private box: (ref: string) => DOMRect | undefined,
    private select: (ref: string) => void,
  ) {
    this.root.onclick = () => {
      const ref = this.focused?.elementRef;
      if (ref) this.select(ref);
      else
        document
          .querySelector<HTMLButtonElement>('[data-tab="agent"]')
          ?.click();
    };
  }
  /** The call worth showing: anything running, else a call that just ended. */
  current(): AgentActivity | undefined {
    return this.focused;
  }
  update(events: AgentActivity[]) {
    this.latest = events;
    const now = Date.now();
    this.focused = events.find(
      (e) =>
        e.status === "running" ||
        (e.status !== "interrupted" &&
          now - Date.parse(e.finishedAt ?? e.updatedAt ?? e.startedAt) <
            (e.status === "failed" ? 15000 : SETTLE_MS + 600)),
    );
    const event = this.focused;
    for (const card of document.querySelectorAll<HTMLElement>(
      ".narration-card",
    ))
      card.classList.toggle(
        "agent-editing",
        !!event?.segmentId &&
          event.status === "running" &&
          card.dataset.id === event.segmentId,
      );
    // Title bar presence: shown while an agent is (or was recently) connected.
    const last = events[0];
    const present =
      !!last &&
      (last.status === "running" ||
        now - Date.parse(last.finishedAt ?? last.updatedAt ?? last.startedAt) <
          PRESENT_MS);
    this.root.hidden = !present;
    document.querySelector<HTMLElement>("#connect-agent")!.hidden = present;
    if (present) {
      const shown = event ?? last;
      this.root.dataset.state =
        event?.status === "running"
          ? "running"
          : event?.status === "failed"
            ? "failed"
            : "idle";
      this.root.querySelector(".agent-activity-label")!.textContent =
        shown.actor;
      this.root.querySelector(".presence-tool")!.textContent =
        event?.status === "running"
          ? event.tool
          : event?.status === "failed"
            ? "failed"
            : "idle";
      this.root.title = `${shown.actor} · ${shown.label}`;
    }
    this.draw();
  }
  draw() {
    const outline = this.target;
    const event = this.focused;
    // A finished read leaves no mark; a finished write settles briefly.
    const finishedRead =
      event?.status === "succeeded" && !WRITE_TOOLS.has(event.tool);
    const rect =
      event?.elementRef && !finishedRead
        ? this.box(event.elementRef)
        : undefined;
    outline.hidden = !rect;
    if (!rect || !event) return;
    Object.assign(outline.style, {
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    const mode =
      event.status === "running"
        ? WRITE_TOOLS.has(event.tool)
          ? "write"
          : "read"
        : event.status === "failed"
          ? "failed"
          : "done";
    if (outline.dataset.mode !== mode || outline.dataset.id !== event.id) {
      outline.dataset.mode = mode;
      outline.dataset.id = event.id;
      outline.querySelector(".agent-pill-name")!.textContent = event.actor;
      outline.querySelector(".agent-pill-tool")!.textContent =
        mode === "done"
          ? "changed"
          : mode === "failed"
            ? (event.error ?? "failed").slice(0, 60)
            : event.label.toLowerCase();
      // Restart the CSS animation for a new state.
      outline.style.animation = "none";
      void outline.offsetWidth;
      outline.style.animation = "";
    }
  }
  activity() {
    return this.latest;
  }
}
