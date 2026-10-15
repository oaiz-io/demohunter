import { clipDuration, type ReplayBundle } from "../model.js";
import { elementUri, previewLink } from "../links.js";
import type { ElementIndex, ElementRecord } from "../elements.js";

export type WorkspaceData = {
  index: ElementIndex;
  projectDir: string;
  connection: { command: string; args: string[] };
  sourceBoundary: string;
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
const clock = (ms: number) =>
  `${Math.floor(ms / 60000)
    .toString()
    .padStart(2, "0")}:${Math.floor((ms / 1000) % 60)
    .toString()
    .padStart(2, "0")}`;
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
  if (!success)
    throw new Error(
      "Clipboard unavailable. Copy the reference from Source & element identity.",
    );
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

export class AgentWorkbench {
  private showResolved = false;
  private commentCards = new Map<string, HTMLElement>();
  constructor(private hooks: Hooks) {
    $("#element-search").oninput = () => this.renderTree();
    $("#copy-element-link").onclick = () =>
      void this.copyReference(false).catch(hooks.error);
    $("#copy-agent-context").onclick = () =>
      void this.copyReference(true).catch(hooks.error);
    $("#show-source").onclick = () => void this.showSource().catch(hooks.error);
    $("#connect-agent").onclick = () =>
      $<HTMLDialogElement>("#agent-dialog").showModal();
    $("#close-agent").onclick = () =>
      $<HTMLDialogElement>("#agent-dialog").close();
    $("#agent-dialog").onclick = (e) => {
      if (e.target === $("#agent-dialog")) {
        const r = $("#agent-dialog").getBoundingClientRect();
        if (
          e.clientX < r.left ||
          e.clientX > r.right ||
          e.clientY < r.top ||
          e.clientY > r.bottom
        )
          $<HTMLDialogElement>("#agent-dialog").close();
      }
    };
    $("#copy-agent-config").onclick = () =>
      void copyText(JSON.stringify(this.hooks.data().connection, null, 2))
        .then(() => toast("MCP command and arguments copied"))
        .catch(hooks.error);
    $("#copy-agent-command").onclick = () => {
      const c = hooks.data().connection;
      void copyText([c.command, ...c.args].map(shellQuote).join(" "))
        .then(() => toast("MCP launch command copied"))
        .catch(hooks.error);
    };
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
    $("#comment-element").onclick = () => {
      this.openComments();
      $<HTMLTextAreaElement>("#new-comment").focus();
    };
    $("#add-comment").onclick = () => void this.addComment().catch(hooks.error);
    $("#toggle-resolved").onclick = () => {
      this.showResolved = !this.showResolved;
      $("#toggle-resolved").textContent = this.showResolved
        ? "Hide resolved"
        : "Show resolved";
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
  render(): void {
    const data = this.hooks.data(),
      bundle = this.hooks.bundle();
    $("#outline-title").textContent = bundle.project.title;
    $("#outline-meta").textContent =
      `${bundle.edits.clips.length} scenes · ${Math.round(bundle.project.durationMs / 1000)}s captured`;
    $("#scene-count").textContent = String(bundle.edits.clips.length);
    $("#element-count").textContent = String(data.index.elements.length);
    $("#viewport-label").textContent =
      `${bundle.project.viewport.width} × ${bundle.project.viewport.height}`;
    $("#agent-config").textContent = JSON.stringify(data.connection, null, 2);
    $("#agent-project-path").textContent = data.projectDir;
    $("#scene-list").replaceChildren();
    let offset = 0;
    for (const [i, clip] of bundle.edits.clips.entries()) {
      const start = offset;
      offset += clipDuration(clip);
      const button = make("button", "scene-button");
      button.dataset.start = String(start);
      button.dataset.end = String(offset);
      const segment = bundle.narration.segments.find(
        (s) => s.clipId === clip.id,
      );
      button.append(
        make("span", "scene-number", String(i + 1).padStart(2, "0")),
        make("span", undefined, segment?.title ?? `Scene ${i + 1}`),
        make("span", "scene-time", clock(start)),
      );
      button.onclick = () => this.hooks.seek(start);
      $("#scene-list").append(button);
    }
    this.renderTree();
    this.selectionChanged();
    this.renderComments();
    this.updateTime();
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
    $("#comment-anchor").textContent =
      `${selected?.name ?? "Recording"} · ${clock(this.hooks.time())}`;
  }
  selectionChanged(): void {
    const element = this.selected();
    for (const node of document.querySelectorAll<HTMLElement>(".layer-button"))
      node.classList.toggle("active", node.dataset.ref === element?.ref);
    if (!element) return;
    const root = $("#source-locations");
    root.replaceChildren();
    for (const [label, value] of [
      ["Reference", element.ref],
      ["Captured HTML", element.source.file],
      ["Registry", `elements.json#${element.source.registryPointer}`],
      ["Edits", "edits.json → elements / animations"],
      [
        "Original source",
        element.source.originalFile
          ? `${element.source.originalFile}${element.source.originalLine ? `:${element.source.originalLine}` : ""}`
          : "Not supplied by the captured app",
      ],
    ]) {
      const row = make("p");
      row.append(
        make("strong", undefined, `${label}: `),
        document.createTextNode(value!),
      );
      root.append(row);
    }
    $("#source-html").hidden = true;
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
    $("#element-tree").replaceChildren();
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
      $("#element-tree").append(button);
    }
    if (!useful.length)
      $("#element-tree").append(
        make("p", "hint", "No matching captured elements."),
      );
  }
  private async copyReference(context: boolean): Promise<void> {
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
      context
        ? JSON.stringify(
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
                capturedHtml: `${data.projectDir}/${element.source.file}`,
                htmlAnchor: element.source.htmlAnchor,
                registry: `elements.json#${element.source.registryPointer}`,
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
          )
        : link,
    );
    history.replaceState(null, "", link);
    toast(
      context
        ? "Element, files, and timeline context copied"
        : "Element link copied — paste it to your agent",
    );
  }
  private async showSource(): Promise<void> {
    const element = this.selected();
    if (!element) return;
    const result = await this.hooks.api<{ html: string; truncated: boolean }>(
      `/api/source?ref=${encodeURIComponent(element.ref)}`,
    );
    $("#source-html").textContent =
      result.html +
      (result.truncated
        ? "\n…Inspect a smaller child element for the rest."
        : "");
    $("#source-html").hidden = false;
  }
  openComments(): void {
    document
      .querySelector<HTMLButtonElement>('button[data-tab="comments"]')!
      .click();
  }
  private async addComment(): Promise<void> {
    const textarea = $<HTMLTextAreaElement>("#new-comment");
    if (!textarea.value.trim()) return;
    const selected = this.selected();
    await this.hooks.api("/api/comments", {
      action: "add",
      expectedRevision: this.hooks.bundle().revision,
      elementRef: $<HTMLInputElement>("#attach-comment").checked
        ? selected?.ref
        : undefined,
      timeMs: this.hooks.time(),
      body: textarea.value,
      author: "You",
    });
    textarea.value = "";
    await this.hooks.reload();
    toast("Comment saved to comments.json");
  }
  private renderComments(): void {
    const bundle = this.hooks.bundle(),
      open = bundle.comments.threads.filter((t) => t.status === "open").length;
    $("#comment-count").textContent = String(open);
    $("#comment-count").hidden = open === 0;
    $("#comment-summary").textContent =
      `${open} open comment${open === 1 ? "" : "s"}`;
    const visible = bundle.comments.threads.filter(
      (t) => this.showResolved || t.status === "open",
    );
    $("#comments-empty").hidden = visible.length > 0;
    for (const thread of visible) {
      let card = this.commentCards.get(thread.id);
      if (!card) {
        card = this.createCommentCard(thread.id);
        this.commentCards.set(thread.id, card);
        $("#comments-list").append(card);
      }
      card.hidden = false;
      card.classList.toggle("resolved", thread.status === "resolved");
      card.querySelector(".comment-author-name")!.textContent = thread.author;
      card.querySelector(".avatar")!.textContent = thread.author
        .slice(0, 1)
        .toUpperCase();
      card.querySelector(".comment-time")!.textContent = clock(thread.timeMs);
      card.querySelector(".comment-body")!.textContent = thread.body;
      const target = thread.elementRef
        ? this.hooks
            .data()
            .index.elements.find((e) => e.ref === thread.elementRef)
        : undefined;
      const targetButton =
        card.querySelector<HTMLButtonElement>(".comment-target")!;
      targetButton.textContent = target?.name ?? "Recording";
      targetButton.onclick = () =>
        thread.elementRef
          ? this.hooks.select(thread.elementRef, thread.timeMs)
          : this.hooks.seek(thread.timeMs);
      card.querySelector<HTMLButtonElement>(".comment-resolve")!.textContent =
        thread.status === "resolved" ? "Reopen" : "✓ Resolve";
      const replies = card.querySelector(".comment-replies")!;
      replies.replaceChildren(
        ...thread.replies.map((reply) => {
          const row = make("div", "comment-reply");
          row.append(
            make("strong", undefined, `${reply.author}  `),
            document.createTextNode(reply.body),
          );
          return row;
        }),
      );
    }
    for (const [id, card] of this.commentCards)
      if (!visible.some((t) => t.id === id)) card.hidden = true;
  }
  private createCommentCard(id: string): HTMLElement {
    const card = make("article", "comment-card");
    const top = make("div", "comment-top"),
      author = make("span", "comment-author");
    author.append(make("span", "avatar"), make("span", "comment-author-name"));
    top.append(author, make("span", "comment-time"));
    const footer = make("div", "comment-footer"),
      replyButton = make("button", "quiet", "Reply"),
      resolve = make("button", "comment-resolve");
    const copy = make("button", "comment-copy", "Copy for agent");
    copy.onclick = () => {
      const thread = this.hooks
        .bundle()
        .comments.threads.find((t) => t.id === id);
      if (!thread) return;
      const data = this.hooks.data(),
        element = data.index.elements.find((e) => e.ref === thread.elementRef);
      const context = {
        projectDir: data.projectDir,
        revision: this.hooks.bundle().revision,
        captureId: data.index.captureId,
        reference: element
          ? elementUri(data.index.captureId, element.ref, thread.timeMs)
          : undefined,
        preview: previewLink(
          location.href.split("#")[0]!,
          data.index.captureId,
          element?.ref,
          thread.timeMs,
        ),
        element: element
          ? {
              ref: element.ref,
              capturedHtml: `${data.projectDir}/${element.source.file}`,
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
          "Read this project’s AGENTS.md or use DemoHunter MCP. Inspect this comment and its element before editing. Preserve the capture; reply and resolve after verifying the result.",
      };
      void copyText(JSON.stringify(context, null, 2))
        .then(() => toast("Comment and element context copied"))
        .catch(this.hooks.error);
    };
    footer.append(copy, replyButton, resolve);
    const reply = make("div", "reply-compose");
    reply.hidden = true;
    const textarea = make("textarea");
    textarea.rows = 2;
    textarea.placeholder = "Add a reply…";
    textarea.setAttribute("aria-label", "Comment reply");
    const submit = make("button", "primary", "Save reply");
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
    card.append(
      top,
      make("p", "comment-body"),
      make("button", "comment-target"),
      make("div", "comment-replies"),
      footer,
      reply,
    );
    return card;
  }
}
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
