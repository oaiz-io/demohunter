import {
  clipDuration,
  sourceToOutput,
  totalDuration,
  type ReplayBundle,
} from "../model.js";
import { commentUri, elementUri, previewLink } from "../links.js";
import type { ElementIndex, ElementRecord } from "../elements.js";
import type { AgentActivity } from "../contract.js";
import type { HistoryChange } from "../storage.js";
import {
  agentTurns,
  ago,
  elapsed,
  noteState,
  threadTitle,
  type HistoryItem,
  type Turn,
} from "./agent.js";
import { clockMs } from "./timeline.js";

/** When the person last opened the Changes view of this demo. */
export const changesSeenKey = () => `demohunter-changes-seen:${location.pathname}`;

export type WorkspaceData = {
  index: ElementIndex;
  projectDir: string;
  captureBundle?: string;
  connection: {
    command: string;
    args: string[];
    /** "workspace": the server edits whichever demo is open in Studio. */
    scope?: "workspace" | "project";
    name?: string;
  };
  sourceBoundary: string;
  /** False when scene scripts must not run (absent means trusted). */
  trusted?: boolean;
};
type Hooks = {
  data: () => WorkspaceData;
  bundle: () => ReplayBundle;
  time: () => number;
  selection: () => string | undefined;
  select: (ref: string, time?: number) => void;
  seek: (time: number) => void;
  hover: (ref?: string) => void;
  api: <T>(url: string, data?: unknown) => Promise<T>;
  reload: () => Promise<void>;
  error: (e: unknown) => void;
  showElement: (ref: string) => void;
  /** Hand a note to the in-Studio agent. */
  sendToAgent?: (id: string) => void;
  /** A note was just added here (auto-send). */
  noteAdded?: (id: string) => void;
};
const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const make = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};
const icon = (name: string) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
};
/** Text is written only when it differs, so live polls never reset a text
 * selection the user is making (for example in the copyable command). */
function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}
/** Swap a container's children without losing keyboard focus: the focused
 * control is re-focused by position in the new content. */
function replaceKeepingFocus(container: HTMLElement, nodes: Node[]): void {
  const focusable = "button,a,input,textarea,select,[tabindex]";
  const active = document.activeElement;
  const index =
    active && container.contains(active)
      ? [...container.querySelectorAll(focusable)].indexOf(active)
      : -1;
  container.replaceChildren(...nodes);
  if (index >= 0)
    container
      .querySelectorAll<HTMLElement>(focusable)
      [index]?.focus({ preventScroll: true });
}
/** Put `wanted` in order inside `list` without moving anything that holds
 * focus: re-appending a node blurs a textarea being typed in. */
function keepOrder(list: HTMLElement, wanted: HTMLElement[]): void {
  const current = [...list.children].filter((c) =>
    wanted.includes(c as HTMLElement),
  );
  if (
    current.length === wanted.length &&
    current.every((c, i) => c === wanted[i])
  )
    return;
  for (const card of wanted)
    if (!card.contains(document.activeElement)) list.append(card);
}
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* HTTP/private-network fallback below. */
    }
  }
  const input = make("textarea");
  input.value = text;
  input.style.cssText = "position:fixed;left:-9999px;top:0";
  document.body.append(input);
  const focused = document.activeElement as HTMLElement | null;
  input.select();
  const success = document.execCommand("copy");
  input.remove();
  focused?.focus();
  if (!success) throw new Error("Clipboard unavailable in this browser.");
}
let toastTimer: ReturnType<typeof setTimeout>;
export function toast(text: string): void {
  $("#toast").textContent = text;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $("#toast").hidden = true;
  }, 2300);
}
const START_PROMPT = "Work through the open notes in DemoHunter Studio.";

export class AgentWorkbench {
  private showResolved = false;
  private sceneOnly = false;
  private commentCards = new Map<string, HTMLElement>();
  private activity: AgentActivity[] = [];
  private history: HistoryItem[] = [];
  private client: "claude" | "codex" | "other" = "claude";
  private activeThread?: string;
  private addingComment = false;
  constructor(private hooks: Hooks) {
    $("#element-search").oninput = () => this.renderTree();
    const dialog = $<HTMLDialogElement>("#agent-dialog");
    $("#connect-agent").onclick = () => {
      this.renderConnect();
      dialog.showModal();
    };
    $("#close-agent").onclick = () => dialog.close();
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      "#agent-clients [data-client]",
    ))
      button.onclick = () => {
        this.client = button.dataset.client as typeof this.client;
        this.renderConnect();
      };
    $("#copy-agent-config").onclick = () =>
      void copyText(JSON.stringify(this.mcpConfig(), null, 2))
        .then(() => toast("MCP config copied"))
        .catch(hooks.error);
    $("#copy-agent-command").onclick = () =>
      void copyText(
        this.client === "other"
          ? JSON.stringify(this.mcpConfig(), null, 2)
          : this.command(this.client as "claude" | "codex"),
      )
        .then(() => toast("Command copied — run it in the repo"))
        .catch(hooks.error);
    for (const id of ["#copy-agent-prompt", "#copy-start-prompt"])
      $(id).onclick = () =>
        void copyText(START_PROMPT)
          .then(() => toast("Prompt copied — paste it into your agent"))
          .catch(hooks.error);
    $("#copy-project-path").onclick = () =>
      void copyText(hooks.data().projectDir)
        .then(() => toast("Project path copied"))
        .catch(hooks.error);
    $("#focus-preview").onclick = () => {
      $(".workspace").classList.toggle("focus-mode");
      $("#focus-preview").setAttribute(
        "aria-pressed",
        String($(".workspace").classList.contains("focus-mode")),
      );
    };
    $("#undo").onclick = () =>
      void hooks
        .api("/api/undo", { revision: hooks.bundle().revision })
        .then(() => hooks.reload())
        .then(() => toast("Last edit undone"))
        .catch(hooks.error);
    $("#add-comment").onclick = () => void this.addComment().catch(hooks.error);
    $("#new-comment").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void this.addComment().catch(hooks.error);
      }
    });
    $("#filter-open").onclick = () => this.setResolved(false);
    $("#toggle-resolved").onclick = () => this.setResolved(true);
    $("#scope-toggle").onclick = () => {
      this.sceneOnly = !this.sceneOnly;
      $("#scope-toggle").textContent = this.sceneOnly
        ? "This scene"
        : "All scenes";
      this.renderComments();
    };
    document.addEventListener("keydown", (event) => {
      if (
        !(event.target as HTMLElement).closest("input,textarea,select") &&
        (event.metaKey || event.ctrlKey) &&
        event.key === "z"
      ) {
        event.preventDefault();
        $("#undo").click();
      }
    });
  }
  /** Called when agent history changes so the editor can refresh marks. */
  onReview?: () => void;
  private setResolved(resolved: boolean) {
    this.showResolved = resolved;
    $("#filter-open").classList.toggle("active", !resolved);
    $("#toggle-resolved").classList.toggle("active", resolved);
    this.renderComments();
  }
  render(): void {
    const data = this.hooks.data(),
      bundle = this.hooks.bundle();
    $("#outline-title").textContent = bundle.project.title;
    $("#outline-meta").textContent =
      `${bundle.edits.clips.length} scenes · ${Math.round(bundle.project.durationMs / 1000)}s captured`;
    $("#scene-count").textContent = String(bundle.edits.clips.length);
    $("#element-count").textContent = String(data.index.elements.length);
    $("#agent-project-path").textContent = data.projectDir;
    const scenes: Node[] = [];
    let offset = 0;
    for (const [i, clip] of bundle.edits.clips.entries()) {
      const start = offset;
      offset += clipDuration(clip);
      const button = make("button", "scene-button");
      button.dataset.start = String(start);
      button.dataset.end = String(offset);
      button.append(
        make("span", "scene-number", String(i + 1).padStart(2, "0")),
        make("span", undefined, this.sceneTitle(i)),
        make("span", "scene-time", clockMs(start)),
      );
      button.onclick = () => this.hooks.seek(start);
      scenes.push(button);
    }
    replaceKeepingFocus($("#scene-list"), scenes);
    this.renderTree();
    this.renderComments();
    this.renderAgent();
    this.updateTime();
  }
  sceneTitle(index: number): string {
    const bundle = this.hooks.bundle();
    const clip = bundle.edits.clips[index];
    return (
      (clip?.kind === "scene" ? clip.title : undefined) ??
      bundle.narration.segments.find((s) => s.clipId === clip?.id)?.title ??
      `Scene ${index + 1}`
    );
  }
  /** Activity and history arrive with every status poll. */
  live(activity: AgentActivity[], history: HistoryItem[]): void {
    const changed =
      JSON.stringify([activity, history.map((h) => h.id)]) !==
      JSON.stringify([this.activity, this.history.map((h) => h.id)]);
    this.activity = activity;
    this.history = history;
    if (!changed) {
      // Elapsed time still moves.
      for (const node of document.querySelectorAll<HTMLElement>("[data-since]"))
        node.textContent = elapsed(node.dataset.since!);
      if ($<HTMLDialogElement>("#agent-dialog").open) this.renderConnect();
      return;
    }
    this.renderComments();
    this.renderAgent();
    this.onReview?.();
    if ($<HTMLDialogElement>("#agent-dialog").open) this.renderConnect();
  }
  turns(): Turn[] {
    return agentTurns(this.history);
  }
  agentMarks(): { timeMs: number; title: string }[] {
    const bundle = this.hooks.bundle(),
      index = this.hooks.data().index;
    const marks = [];
    for (const turn of this.turns())
      for (const entry of turn.entries) {
        const ref =
          entry.changes?.find((c) => c.ref)?.ref ?? entry.author?.elementRef;
        const thread = bundle.comments.threads.find(
          (t) => t.id === entry.author?.threadId,
        );
        const record = ref
          ? index.elements.find((e) => e.ref === ref)
          : undefined;
        const time =
          thread?.timeMs ??
          (record
            ? sourceToOutput(bundle.edits, record.firstSeenMs + 2)
            : undefined);
        if (time === undefined) continue;
        marks.push({
          timeMs: time,
          title: `${entry.author?.actor}: ${entry.description}`,
        });
      }
    return marks;
  }
  updateTime(): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      ".scene-button",
    ))
      button.classList.toggle(
        "active",
        this.hooks.time() >= Number(button.dataset.start) &&
          this.hooks.time() < Number(button.dataset.end),
      );
    const selected = this.selected();
    setText(
      $("#comment-anchor"),
      `${selected?.ref ?? "Recording"} · ${clockMs(this.hooks.time())}`,
    );
  }
  selectionChanged(): void {
    const element = this.selected();
    for (const node of document.querySelectorAll<HTMLElement>(".layer-button"))
      node.classList.toggle("active", node.dataset.ref === element?.ref);
    this.updateTime();
  }
  private selected(): ElementRecord | undefined {
    return this.hooks
      .data()
      .index.elements.find((e) => e.ref === this.hooks.selection());
  }
  private renderTree(): void {
    const query = $<HTMLInputElement>("#element-search").value.toLowerCase();
    const all = this.hooks.data().index.elements;
    const useful = all
      .filter(
        (e) =>
          ![
            "html",
            "body",
            "svg",
            "path",
            "g",
            "circle",
            "rect",
            "i",
            "br",
          ].includes(e.tag) &&
          (query
            ? `${e.name} ${e.text} ${e.tag} ${e.ref}`
                .toLowerCase()
                .includes(query)
            : e.attributes.id ||
              e.attributes["data-demohunter-id"] ||
              [
                "button",
                "h1",
                "h2",
                "h3",
                "main",
                "aside",
                "section",
                "nav",
              ].includes(e.tag)),
      )
      .slice(0, 200);
    const tree: Node[] = [];
    for (const element of useful) {
      const button = make("button", "layer-button");
      button.dataset.ref = element.ref;
      button.title = `${element.name} · ${element.ref}`;
      button.append(
        make(
          "span",
          "layer-icon",
          /^h\d$/.test(element.tag) ||
            ["span", "p", "label"].includes(element.tag)
            ? "T"
            : element.tag === "button"
              ? "◉"
              : "◇",
        ),
        make("span", "layer-name", element.name),
        make("span", "layer-tag", element.tag),
      );
      button.onclick = () => this.hooks.select(element.ref);
      button.onmouseenter = () => this.hooks.hover(element.ref);
      button.onmouseleave = () => this.hooks.hover();
      tree.push(button);
    }
    if (!useful.length)
      tree.push(make("p", "hint", "No matching captured elements."));
    replaceKeepingFocus($("#element-tree"), tree);
    this.selectionChanged();
  }
  /** The selected element's reference, files and moment for an agent. */
  async copyReference(): Promise<void> {
    const element = this.selected();
    if (!element) return;
    const data = this.hooks.data(),
      bundle = this.hooks.bundle();
    const uri = elementUri(
      data.index.captureId,
      element.ref,
      this.hooks.time(),
    );
    const link = previewLink(
      location.href.split("#")[0]!,
      data.index.captureId,
      element.ref,
      this.hooks.time(),
    );
    await copyText(
      JSON.stringify(
        {
          reference: uri,
          preview: link,
          projectDir: data.projectDir,
          revision: bundle.revision,
          element: {
            ref: element.ref,
            name: element.name,
            documentId: element.documentId,
            nodeId: element.nodeId,
            capturedHtml: data.captureBundle ? `MCP get_html(${element.ref})` : `${data.projectDir}/${element.source.file}`,
            htmlAnchor: element.source.htmlAnchor,
            registry: `${data.captureBundle ? "capture.dhcapture!/" : ""}elements.json#${element.source.registryPointer}`,
            editFile: "edits.json",
            narrationFile: "narration.json",
            commentsFile: "comments.json",
          },
          outputMs: Math.round(this.hooks.time()),
          comments: bundle.comments.threads.filter(
            (t) => t.elementRef === element.ref && t.status === "open",
          ),
          instruction:
            "Resolve this reference with DemoHunter MCP or read the project AGENTS.md. Preserve captured events; edit the project overrides and transcript.",
        },
        null,
        2,
      ),
    );
    history.replaceState(null, "", link);
    toast("Element, files and moment copied — paste into your agent");
  }
  openComments(): void {
    document
      .querySelector<HTMLButtonElement>('button[data-tab="comments"]')!
      .click();
  }
  focusComposer(): void {
    this.openComments();
    $<HTMLTextAreaElement>("#new-comment").focus();
  }
  openThread(id: string): void {
    const bundle = this.hooks.bundle();
    const thread = bundle.comments.threads.find((t) => t.id === id);
    if (!thread) throw new Error("Comment not found in this recording.");
    this.sceneOnly = false;
    $("#scope-toggle").textContent = "All scenes";
    this.setResolved(thread.status === "resolved");
    this.activeThread = id;
    this.openComments();
    if (thread.elementRef) this.hooks.select(thread.elementRef, thread.timeMs);
    else this.hooks.seek(thread.timeMs);
    this.openComments();
    this.renderComments();
    this.commentCards.get(id)?.scrollIntoView({ block: "nearest" });
  }
  private threadLink(id: string): string {
    const thread = this.hooks
      .bundle()
      .comments.threads.find((t) => t.id === id);
    if (!thread) throw new Error("Comment not found in this recording.");
    return previewLink(
      location.href.split("#")[0]!,
      this.hooks.data().index.captureId,
      thread.elementRef,
      thread.timeMs,
      thread.id,
    );
  }
  private async copyComment(id: string): Promise<void> {
    const bundle = this.hooks.bundle();
    const thread = bundle.comments.threads.find((t) => t.id === id);
    if (!thread) return;
    const data = this.hooks.data();
    const element = data.index.elements.find(
      (e) => e.ref === thread.elementRef,
    );
    await copyText(
      JSON.stringify(
        {
          projectDir: data.projectDir,
          revision: bundle.revision,
          captureId: data.index.captureId,
          threadId: thread.id,
          reference: commentUri(data.index.captureId, thread.id, thread.timeMs),
          preview: this.threadLink(id),
          element: element
            ? {
                ref: element.ref,
                capturedHtml: data.captureBundle ? `MCP get_html(${element.ref})` : `${data.projectDir}/${element.source.file}`,
                htmlAnchor: element.source.htmlAnchor,
              }
            : undefined,
          comment: thread,
          files: {
            edits: "edits.json",
            narration: "narration.json",
            comments: "comments.json",
          },
          instruction:
            "Read this project's AGENTS.md or use DemoHunter MCP resolve_reference with this reference or threadId. Inspect this exact comment and its element before editing. Preserve the capture; reply and resolve after verifying the result.",
        },
        null,
        2,
      ),
    );
    toast("Comment and ID copied — paste into your agent");
  }
  private async addComment(): Promise<void> {
    const textarea = $<HTMLTextAreaElement>("#new-comment");
    // A double click or repeated shortcut must not post the note twice.
    if (!textarea.value.trim() || this.addingComment) return;
    this.addingComment = true;
    $<HTMLButtonElement>("#add-comment").disabled = true;
    try {
      const selected = this.selected();
      const body = textarea.value;
      const result = await this.hooks.api<{ id: string }>("/api/comments", {
        action: "add",
        expectedRevision: this.hooks.bundle().revision,
        elementRef: $<HTMLInputElement>("#attach-comment").checked
          ? selected?.ref
          : undefined,
        timeMs: this.hooks.time(),
        body,
        author: "You",
      });
      // Keep anything typed while the request was in flight.
      if (textarea.value === body) textarea.value = "";
      this.activeThread = result.id;
      await this.hooks.reload();
      toast("Note saved — your agent can read it through MCP");
      this.hooks.noteAdded?.(result.id);
    } finally {
      this.addingComment = false;
      $<HTMLButtonElement>("#add-comment").disabled = false;
    }
  }
  private activeId(): string | undefined {
    const bundle = this.hooks.bundle();
    if (
      this.activeThread &&
      bundle.comments.threads.some((t) => t.id === this.activeThread)
    )
      return this.activeThread;
    const ref = this.hooks.selection();
    return bundle.comments.threads.find(
      (t) => t.status === "open" && ref && t.elementRef === ref,
    )?.id;
  }
  renderComments(): void {
    const bundle = this.hooks.bundle();
    if (!bundle) return;
    const threads = bundle.comments.threads;
    const open = threads.filter((t) => t.status === "open").length;
    $("#comment-count").textContent = open ? String(open) : "";
    $("#comment-summary").textContent = String(open);
    $("#toggle-resolved").textContent = `Resolved ${threads.length - open}`;
    const clips = bundle.edits.clips;
    let sceneStart = 0,
      sceneEnd = totalDuration(bundle.edits);
    if (this.sceneOnly) {
      let offset = 0;
      for (const clip of clips) {
        const end = offset + clipDuration(clip);
        if (this.hooks.time() >= offset && this.hooks.time() < end) {
          sceneStart = offset;
          sceneEnd = end;
        }
        offset = end;
      }
    }
    const visible = threads.filter(
      (t) =>
        (this.showResolved ? t.status === "resolved" : t.status === "open") &&
        (!this.sceneOnly || (t.timeMs >= sceneStart && t.timeMs < sceneEnd)),
    );
    $("#comments-empty").hidden = threads.length > 0;
    $(".filter-row").hidden = threads.length === 0;
    const turns = this.turns();
    const active = this.activeId();
    const ordered: HTMLElement[] = [];
    for (const thread of visible) {
      let card = this.commentCards.get(thread.id);
      if (!card) {
        card = this.createCommentCard(thread.id);
        this.commentCards.set(thread.id, card);
      }
      ordered.push(card);
      card.hidden = false;
      const number = threads.indexOf(thread) + 1;
      card.classList.toggle("resolved", thread.status === "resolved");
      card.classList.toggle("active", thread.id === active);
      const pin = card.querySelector<HTMLElement>(".pin")!;
      pin.textContent = String(number);
      pin.classList.toggle("resolved", thread.status === "resolved");
      const identity = card.querySelector<HTMLButtonElement>(".comment-id")!;
      identity.textContent = thread.id;
      identity.title = `Copy comment ID: ${thread.id}`;
      pin.setAttribute(
        "aria-label",
        `Open note ${number}: ${thread.body.slice(0, 80)}`,
      );
      card.querySelector(".comment-author-name")!.textContent = thread.author;
      card.querySelector(".comment-time")!.textContent = clockMs(thread.timeMs);
      card.querySelector(".comment-body")!.textContent = thread.body;
      const target = thread.elementRef
        ? this.hooks
            .data()
            .index.elements.find((e) => e.ref === thread.elementRef)
        : undefined;
      const targetButton =
        card.querySelector<HTMLButtonElement>(".comment-target")!;
      targetButton.textContent = target
        ? `${target.tag} · ${target.ref}`
        : "Whole recording";
      targetButton.onclick = () =>
        thread.elementRef
          ? this.hooks.select(thread.elementRef, thread.timeMs)
          : this.hooks.seek(thread.timeMs);
      const replies = card.querySelector(".comment-replies")!;
      replies.replaceChildren(
        ...thread.replies.map((reply) => {
          const agent = reply.author !== "You";
          const row = make("div", `reply${agent ? " agent" : ""}`);
          const head = make("div", "reply-head");
          head.append(
            make("strong", undefined, reply.author),
            make("span", undefined, `· ${ago(reply.createdAt)}`),
          );
          row.append(head, make("p", undefined, reply.body));
          return row;
        }),
      );
      const state = noteState(thread, this.activity, turns);
      const working = card.querySelector<HTMLElement>(".agent-working-card")!;
      working.hidden = state.kind !== "working";
      if (state.kind === "working") {
        working.querySelector(".who")!.textContent = `${state.actor} is on it`;
        const since = working.querySelector<HTMLElement>(".since")!;
        since.dataset.since = state.since;
        since.textContent = elapsed(state.since);
        const steps = working.querySelector(".tool-steps")!;
        steps.replaceChildren(
          ...state.calls.map((call) => {
            const li = make(
              "li",
              call.status === "running"
                ? "running"
                : call.status === "failed"
                  ? "failed"
                  : "",
            );
            if (call.status === "succeeded") li.append(icon("check"));
            li.append(
              document.createTextNode(
                `${call.tool}${call.elementRef ? ` · ${call.elementRef}` : ""}`,
              ),
            );
            return li;
          }),
        );
      }
      const status = card.querySelector<HTMLElement>(".thread-status")!;
      const undo = card.querySelector<HTMLButtonElement>(".comment-undo")!;
      const show = card.querySelector<HTMLButtonElement>(".comment-show")!;
      undo.hidden = true;
      show.hidden = state.kind !== "working" || !thread.elementRef;
      // Sharing stays available in every note state.
      card.querySelector<HTMLElement>(".comment-copy")!.hidden = false;
      card.querySelector<HTMLElement>(".comment-reply")!.hidden =
        state.kind === "working" || state.kind === "resolved";
      card.querySelector<HTMLElement>(".comment-resolve")!.hidden =
        state.kind === "working";
      status.replaceChildren();
      if (state.kind === "replied") {
        if (state.changes)
          status.append(
            make(
              "span",
              "change-count",
              `${state.changes} change${state.changes === 1 ? "" : "s"}`,
            ),
          );
        else status.textContent = "Waiting for your review";
        const top = turns[0];
        if (
          top?.undoSteps &&
          (top.threadId === thread.id ||
            top.entries.some((e) => e.author?.elementRef === thread.elementRef))
        ) {
          undo.hidden = false;
          undo.onclick = () => void this.undoTurn(top).catch(this.hooks.error);
        }
      } else if (state.kind === "working")
        status.textContent = "Your playhead stays where it is.";
      else if (state.kind === "open") status.textContent = "";
      else status.textContent = `Resolved ${ago(thread.updatedAt)}`;
      card.querySelector<HTMLButtonElement>(".comment-resolve")!.textContent =
        thread.status === "resolved" ? "Reopen" : "Resolve";
      card.querySelector<HTMLButtonElement>(".comment-resolve")!.className =
        `comment-resolve button small ${thread.status === "resolved" || state.kind === "open" ? "secondary" : "primary"}`;
    }
    keepOrder($("#comments-list"), ordered);
    for (const [id, card] of this.commentCards)
      if (!visible.some((t) => t.id === id)) card.hidden = true;
    if (!visible.length && threads.length) {
      let empty =
        $("#comments-list").querySelector<HTMLElement>(".review-empty");
      if (!empty) {
        empty = make("p", "review-empty");
        empty.style.padding = "20px";
        $("#comments-list").append(empty);
      }
      empty.hidden = false;
      empty.textContent = this.showResolved
        ? "No resolved notes yet."
        : this.sceneOnly
          ? "No open notes in this scene."
          : "No open notes. Press C to add one.";
    } else
      $("#comments-list")
        .querySelector<HTMLElement>(".review-empty")
        ?.setAttribute("hidden", "");
  }
  private createCommentCard(id: string): HTMLElement {
    const card = make("article", "thread comment-card");
    card.dataset.id = id;
    const body = make("div", "thread-body");
    const top = make("div", "thread-top");
    top.append(
      make("span", "comment-author-name"),
      make("button", "comment-time"),
    );
    top.querySelector<HTMLButtonElement>(".comment-time")!.onclick = () => {
      const thread = this.hooks
        .bundle()
        .comments.threads.find((t) => t.id === id);
      if (thread) this.hooks.seek(thread.timeMs);
    };
    const working = make("div", "agent-working-card");
    working.hidden = true;
    const head = make("div", "head");
    const who = make("span");
    const avatar = make("span", "presence-avatar");
    avatar.append(icon("pencil"));
    who.append(avatar, make("span", "who"));
    head.append(who, make("span", "since mono"));
    working.append(head, make("ul", "tool-steps"));
    const actions = make("div", "thread-actions");
    const left = make("div", "left thread-status");
    const right = make("div", "right");
    const copy = make(
      "button",
      "comment-copy quiet small-text",
      "Copy for agent",
    );
    const show = make("button", "comment-show link-agent", "Show on canvas");
    const replyButton = make(
      "button",
      "comment-reply button secondary small",
      "Reply",
    );
    const undo = make("button", "comment-undo button secondary small", "Undo");
    const resolve = make(
      "button",
      "comment-resolve button small primary",
      "Resolve",
    );
    const send = make("button", "comment-send quiet small-text", "Send to agent");
    send.onclick = () => this.hooks.sendToAgent?.(id);
    right.append(send, copy, show, replyButton, undo, resolve);
    actions.append(left, right);
    copy.prepend(icon("copy"));
    copy.onclick = () => void this.copyComment(id).catch(this.hooks.error);
    const reference = make("div", "comment-reference");
    const identity = make("button", "comment-id");
    identity.setAttribute("aria-label", "Copy comment ID");
    identity.onclick = () =>
      void copyText(id)
        .then(() => toast("Comment ID copied"))
        .catch(this.hooks.error);
    const link = make("button", "comment-link quiet small-text", "Copy link");
    link.prepend(icon("copy"));
    link.title = "Copy a link to this comment";
    link.onclick = () =>
      void copyText(this.threadLink(id))
        .then(() => toast("Comment link copied"))
        .catch(this.hooks.error);
    reference.append(identity, link);
    show.onclick = () => {
      const thread = this.hooks
        .bundle()
        .comments.threads.find((t) => t.id === id);
      if (thread?.elementRef) this.hooks.showElement(thread.elementRef);
    };
    const reply = make("div", "reply-compose");
    reply.hidden = true;
    const textarea = make("textarea");
    textarea.rows = 2;
    textarea.placeholder = "Reply…";
    textarea.setAttribute("aria-label", "Reply");
    const submit = make("button", "button primary small", "Save reply");
    submit.style.alignSelf = "flex-end";
    reply.append(textarea, submit);
    replyButton.onclick = () => {
      reply.hidden = !reply.hidden;
      if (!reply.hidden) textarea.focus();
    };
    resolve.onclick = () => {
      const current = this.hooks
        .bundle()
        .comments.threads.find((t) => t.id === id)!;
      void this.hooks
        .api("/api/comments", {
          action: "update",
          expectedRevision: this.hooks.bundle().revision,
          threadId: id,
          status: current.status === "open" ? "resolved" : "open",
        })
        .then(() => this.hooks.reload())
        .catch(this.hooks.error);
    };
    submit.onclick = () => {
      if (!textarea.value.trim()) return;
      void this.hooks
        .api("/api/comments", {
          action: "update",
          expectedRevision: this.hooks.bundle().revision,
          threadId: id,
          reply: textarea.value,
          author: "You",
        })
        .then(() => {
          textarea.value = "";
          reply.hidden = true;
          return this.hooks.reload();
        })
        .catch(this.hooks.error);
    };
    card.onclick = (event) => {
      if ((event.target as HTMLElement).closest("button,textarea")) return;
      this.activeThread = id;
      this.renderComments();
    };
    card.ondblclick = (event) => {
      if ((event.target as HTMLElement).closest("button,textarea")) return;
      void this.copyComment(id).catch(this.hooks.error);
    };
    body.append(
      top,
      reference,
      make("p", "comment-body"),
      make("button", "comment-target ref-chip"),
      make("div", "comment-replies"),
      working,
      actions,
      reply,
    );
    const pin = make("button", "pin");
    pin.onclick = () => this.openThread(id);
    card.append(pin, body);
    return card;
  }
  private async undoTurn(turn: Turn) {
    if (!turn.undoSteps) return;
    await this.hooks.api("/api/undo", {
      revision: this.hooks.bundle().revision,
      steps: turn.undoSteps,
    });
    await this.hooks.reload();
    toast(
      `Undid ${turn.undoSteps} change${turn.undoSteps === 1 ? "" : "s"} by ${turn.actor}`,
    );
  }
  // Agent panel ----------------------------------------------------------
  private lastAgent(): AgentActivity | undefined {
    return this.activity[0];
  }
  renderAgent(): void {
    const bundle = this.hooks.bundle();
    if (!bundle) return;
    const last = this.lastAgent();
    const who = make("div", "who");
    const avatar = make(
      "span",
      `presence-avatar${last?.status === "running" ? "" : " idle"}`,
    );
    avatar.append(icon("pencil"));
    const text = make("div");
    if (last) {
      text.append(
        make("strong", undefined, last.actor),
        make(
          "span",
          "muted",
          `MCP · this demo only · last call ${ago(last.finishedAt ?? last.startedAt)}`,
        ),
      );
    } else
      text.append(
        make("strong", undefined, "No agent yet"),
        make("span", "muted", "Agents appear after their first tool call."),
      );
    who.append(avatar, text);
    const connect = make(
      "button",
      "quiet",
      last ? "+ Connect" : "Connect agent",
    );
    connect.onclick = () => $("#connect-agent").click();
    replaceKeepingFocus($("#agent-connection"), [who, connect]);
    // Now
    const nowNodes: Node[] = [];
    const running = this.activity.find((a) => a.status === "running");
    if (running) {
      const card = make("button", "now-card");
      const info = make("div");
      info.append(
        make("strong", undefined, running.label),
        make(
          "span",
          "mono",
          `${running.tool}${running.elementRef ? ` · ${running.elementRef}` : ""}`,
        ),
      );
      const since = make("span", "mono elapsed", elapsed(running.startedAt));
      since.dataset.since = running.startedAt;
      card.append(make("i"), info, since);
      card.onclick = () =>
        running.elementRef && this.hooks.showElement(running.elementRef);
      nowNodes.push(card);
    } else
      nowNodes.push(
        make(
          "p",
          "now-idle",
          last
            ? `Idle · last call ${ago(last.finishedAt ?? last.startedAt)}`
            : "Nothing is running.",
        ),
      );
    // Changes, newest turn first
    replaceKeepingFocus($("#agent-now"), nowNodes);
    const turns = this.turns();
    const cards: Node[] = turns
      .slice(0, 20)
      .map((turn) => this.turnCard(turn, running));
    if (!turns.length)
      cards.push(
        make("p", "review-empty", "Agent changes appear here, by turn."),
      );
    replaceKeepingFocus($("#review-list"), cards);
    // The Changes view's count: turns since the person last looked at it.
    const count = document.querySelector<HTMLElement>("#agent-changes-count");
    if (count) {
      const seen = Number(localStorage.getItem(changesSeenKey()) ?? 0);
      const unseen = turns.filter((t) => Date.parse(t.endedAt) > seen).length;
      count.textContent = unseen > 9 ? "9+" : String(unseen);
      count.hidden = !unseen;
    }
  }
  /** What `actor` changed between two times, as a small receipt for the end
   * of its chat turn: the changes, Review (the Changes view) and, when it is
   * the newest turn, Undo. Undefined when it changed nothing. */
  receipt(actor: string, fromMs: number, toMs: number, review: () => void): HTMLElement | undefined {
    const inTurn = (e: HistoryItem) => {
      const at = Date.parse(e.createdAt);
      return e.author?.actor === actor && at >= fromMs - 250 && at < toMs;
    };
    // History is newest first.
    const entries = this.history.filter(inTurn);
    if (!entries.length) return;
    const card = make("div", "turn receipt");
    const head = make("div", "turn-head");
    const rows = this.changeRows(entries.slice(0, 8));
    const total = entries.reduce((n, e) => n + Math.max(1, e.changes?.length ?? 0), 0);
    head.append(make("strong", undefined, `${total} change${total === 1 ? "" : "s"} in this turn`));
    const actions = make("span", "receipt-actions");
    const show = make("button", "quiet small-text", "Review");
    show.onclick = review;
    actions.append(show);
    // Undo when these are the newest changes (one locked step back), even
    // if history groups them with an earlier message of the same session.
    if (entries.every((e, i) => this.history[i]?.id === e.id)) {
      const undo = make("button", "quiet small-text", "Undo");
      const turn: Turn = {
        id: entries[0]!.id,
        actor,
        sessionId: entries[0]!.author!.sessionId,
        entries,
        startedAt: entries.at(-1)!.createdAt,
        endedAt: entries[0]!.createdAt,
        undoSteps: entries.length,
      };
      undo.onclick = () => void this.undoTurn(turn).catch(this.hooks.error);
      actions.append(undo);
    }
    head.append(actions);
    card.append(head, ...rows);
    return card;
  }
  private turnCard(
    turn: Turn,
    running: AgentActivity | undefined,
  ): HTMLElement {
    const bundle = this.hooks.bundle();
    const live =
      running?.sessionId === turn.sessionId && turn === this.turns()[0];
    const card = make("div", `turn${live ? " live" : ""}`);
    const head = make("div", "turn-head");
    const title = make("span");
    const note = threadTitle(
      bundle,
      turn.threadId ??
        bundle.comments.threads.find((t) =>
          turn.entries.some(
            (e) => e.author?.elementRef && e.author.elementRef === t.elementRef,
          ),
        )?.id,
    );
    if (note) title.append(make("span", "pin", String(note.index)));
    title.append(
      make(
        "strong",
        undefined,
        note?.body ?? `${turn.actor} · ${turn.entries.at(-1)!.description}`,
      ),
    );
    head.append(
      title,
      make("span", "when", live ? "In progress" : ago(turn.endedAt)),
    );
    card.append(head);
    card.append(...this.changeRows(turn.entries.slice(0, 8)));
    // Undo is linear: only the newest turn can be undone in one step.
    if (turn.undoSteps) {
      const foot = make("div", "turn-foot");
      const undo = make("button", "button secondary small", "Undo turn");
      undo.onclick = () => void this.undoTurn(turn).catch(this.hooks.error);
      foot.append(undo);
      card.append(foot);
    }
    return card;
  }
  /** One row per change (up to four per history entry), as in turn cards. */
  private changeRows(entries: HistoryItem[]): HTMLElement[] {
    const bundle = this.hooks.bundle();
    const index = this.hooks.data().index;
    const rows: HTMLElement[] = [];
    for (const entry of entries) {
      const changes: HistoryChange[] = entry.changes?.length
        ? entry.changes
        : [{ kind: "project", label: entry.description, file: "" }];
      for (const change of changes.slice(0, 4)) {
        const row = make("button", "change-row");
        const info = make("div");
        const element = change.ref
          ? index.elements.find((e) => e.ref === change.ref)
          : undefined;
        const note = threadTitle(bundle, entry.author?.threadId);
        info.append(
          make(
            "span",
            undefined,
            ["reply", "status", "comment"].includes(change.kind)
              ? `${change.label}${note ? ` on note ${note.index}` : ""}`
              : `${change.label}${element ? ` of ${(element.attributes["data-demohunter-name"] ?? element.name).toLowerCase()}` : ""}`,
          ),
        );
        const before =
          change.before ??
          (change.kind === "text" && element ? element.text : undefined);
        if (before !== undefined || change.after !== undefined) {
          if (
            before !== undefined &&
            change.kind !== "style" &&
            change.kind !== "reply"
          )
            info.append(make("del", undefined, before));
          if (change.after !== undefined)
            info.append(
              change.kind === "reply"
                ? make("span", "mono", change.after)
                : make(
                    change.kind === "style" ? "span" : "ins",
                    change.kind === "style" ? "mono" : undefined,
                    change.after,
                  ),
            );
        } else if (change.file) info.append(make("span", "mono", change.file));
        const time =
          element && sourceToOutput(bundle.edits, element.firstSeenMs + 2);
        row.append(
          info,
          make("span", "time", time !== undefined ? clockMs(time) : "—"),
        );
        row.onclick = () => {
          if (element) this.hooks.select(element.ref, time);
        };
        rows.push(row);
      }
    }
    return rows;
  }
  // Connect dialog --------------------------------------------------------
  private serverName() {
    const named = this.hooks.data().connection.name;
    if (named) return named;
    const slug = this.hooks
      .bundle()
      .project.id.toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
    return `demohunter-${slug || "replay"}`;
  }
  private mcpConfig() {
    const c = this.hooks.data().connection;
    return {
      mcpServers: { [this.serverName()]: { command: c.command, args: c.args } },
    };
  }
  private command(client: "claude" | "codex") {
    const c = this.hooks.data().connection;
    return `${client} mcp add ${this.serverName()} -- \\\n  ${[c.command, ...c.args].map(shellQuote).join(" ")}`;
  }
  renderConnect(): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      "#agent-clients [data-client]",
    ))
      button.classList.toggle("active", button.dataset.client === this.client);
    const client = this.client;
    setText(
      $("#agent-command"),
      client === "other"
        ? JSON.stringify(this.mcpConfig(), null, 2)
        : this.command(client),
    );
    setText($("#agent-config"), JSON.stringify(this.mcpConfig(), null, 2));
    setText(
      $("#agent-dialog .dialog-lead"),
      this.hooks.data().connection.scope === "workspace"
        ? "Run once in the repo. It edits whichever demo is open in Studio; your agent settings are not changed."
        : "Run once in the repo. Studio does not change your agent settings.",
    );
    const status = $("#agent-dialog-status");
    const last = this.lastAgent();
    const running = this.activity.find((a) => a.status === "running");
    status.classList.toggle("connected", !!running);
    setText(
      status,
      running
        ? `${running.actor} is working now`
        : last
          ? `${last.actor} · last activity ${ago(last.finishedAt ?? last.startedAt)}`
          : "Waiting for the first tool call…",
    );
  }
}
function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}
