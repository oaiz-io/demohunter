import type { ReplayBundle, Target } from "../model.js";
import {
  effectiveElementEdit,
  elementKey,
  patchElement,
  type ElementPatch,
  type ElementEdit,
} from "../element-edit.js";
import { isTextField } from "./element-overrides.js";
export type Editable = { target: Target; label: string };
type Draft = {
  target: Target;
  patch: ElementPatch;
  revision: string;
  version: number;
  label?: string;
  error?: string;
  busy?: boolean;
  timer?: ReturnType<typeof setTimeout>;
};
/** Rewriting one element's text in place, on the canvas. */
type Inline = {
  entry: Editable;
  key: string;
  original: string;
  text: string;
  revision: string;
  /** white-space to save with text that has line breaks. */
  newline?: string;
  doc?: Document;
  host?: HTMLElement;
  field?: HTMLTextAreaElement | HTMLInputElement;
  frame?: HTMLIFrameElement;
  selection: [number, number];
  baseline?: Metrics;
  warning: string;
};
type Metrics = {
  width: number;
  height: number;
  overflowX: number;
  overflowY: number;
  clipped: boolean;
};
type Hooks = {
  bundle: () => ReplayBundle;
  resolve: (target: Target) => Element | undefined;
  frame: (node: Element) => HTMLIFrameElement | undefined;
  entries: () => Editable[];
  context: () => string;
  select: (entry: Editable) => void;
  api: <T>(route: string, data: unknown) => Promise<T>;
  reload: () => Promise<void>;
  update: () => void;
  /** Stop playback while text is being rewritten. */
  pause: () => void;
  /** The editable target for a node in the recording or a scene page. */
  editableOf: (node: Element) => Editable | undefined;
  /** Documents visible on the current frame, top-most first. */
  textLayers: () => Document[];
};
const defaults = { x: 0, y: 0, scaleX: 1, scaleY: 1 };
export class ElementEditor {
  selected?: Editable;
  private drafts = new Map<string, Draft>();
  /** The newest save: until the reload after it lands, `bundle()` still
   * reports the revision it started from. */
  private lastSave?: { from: string; to: string };
  private queue = Promise.resolve();
  private rendered = "";
  private renderedNode?: Element;
  private renderedTarget = "";
  private outline: HTMLDivElement;
  private gesture?: {
    pointer: number;
    key: string;
    target: Target;
    startX: number;
    startY: number;
    box: DOMRect;
    scaleX: number;
    scaleY: number;
    transform: typeof defaults;
    patch: ElementPatch;
    mode: string;
    changed: boolean;
  };
  private suppressClick = false;
  private inline?: Inline;
  private ring: HTMLDivElement;
  private status: HTMLDivElement;
  private marks: HTMLDivElement;
  private guarded = new WeakSet<Document>();
  private guardUntil = 0;
  /** Pointer over the canvas, for the edited-text markers. */
  pointer?: { x: number; y: number };
  constructor(
    private root: HTMLElement,
    private hooks: Hooks,
  ) {
    root.innerHTML = `<div class="direct-heading"><strong>Edit element</strong><span id="element-save-state" role="status">Select an element</span></div>
      <div class="direct-scroll"><p id="element-empty" class="hint">Click an element in the preview, or choose one below.</p>
      <p class="direct-tip">Double-click text on the canvas to rewrite it.</p>
      <form id="element-form" hidden><p id="element-name" class="mono"></p>
      <label class="direct-field">Text<textarea id="element-text" rows="3" spellcheck="false"></textarea></label>
      <p id="element-text-warning" class="direct-warning" role="status" hidden></p>
      <div class="direct-grid"><label>Text color<div class="direct-color"><input id="element-color-picker" type="color" aria-label="Pick text color"><input id="element-color" aria-label="Text color" placeholder="CSS color"></div></label>
      <label>Background<div class="direct-color"><input id="element-background-picker" type="color" aria-label="Pick background color"><input id="element-background" aria-label="Background color" placeholder="transparent"></div></label></div>
      <div class="direct-grid"><label>Font size<input id="element-font-size" aria-label="Font size" type="number" min="1" max="1000" step="1"></label><label>Opacity (%)<input id="element-opacity" aria-label="Opacity" type="number" min="0" max="100" step="1"></label>
      <label>Move X<input id="element-x" aria-label="Move X" type="number" min="-100000" max="100000" step="1"></label><label>Move Y<input id="element-y" aria-label="Move Y" type="number" min="-100000" max="100000" step="1"></label>
      <label>Scale X (%)<input id="element-scale-x" aria-label="Scale X" type="number" min="5" max="2000" step="1"></label><label>Scale Y (%)<input id="element-scale-y" aria-label="Scale Y" type="number" min="5" max="2000" step="1"></label>
      <label>Width (px)<input id="element-width" aria-label="Element width" type="number" min="1" max="20000"></label><label>Height (px)<input id="element-height" aria-label="Element height" type="number" min="1" max="20000"></label></div>
      <div class="direct-actions"><button type="button" id="element-hide">Hide</button><button type="button" id="element-remove">Remove</button><button type="button" id="element-reset">Reset edits</button></div>
      <p class="hint">Drag to move. Drag a corner to resize. Hold Shift to keep proportions. Edits apply wherever this element appears.</p>
      <div id="element-conflict" class="direct-conflict" hidden><p id="element-conflict-message" role="alert"></p><button type="button" id="element-keep">Apply my changes</button><button type="button" id="element-discard">Use saved version</button></div></form>
      <details class="direct-elements" open><summary>Elements <span id="direct-element-count"></span></summary><input id="direct-element-search" aria-label="Search editable elements" placeholder="Find or restore an element…"><div id="direct-elements-list"></div></details></div>`;
    this.outline = document.createElement("div");
    this.outline.className = "direct-outline";
    this.outline.hidden = true;
    for (const corner of ["nw", "ne", "se", "sw"]) {
      const handle = document.createElement("button");
      handle.className = `direct-handle ${corner}`;
      handle.dataset.corner = corner;
      handle.setAttribute("aria-label", `Resize ${corner}`);
      // Pointer-only: resizing has no keyboard behaviour, so no tab stop.
      handle.tabIndex = -1;
      this.outline.append(handle);
    }
    this.outline.setAttribute("aria-label", "Drag selected element");
    this.outline.tabIndex = 0;
    this.ring = document.createElement("div");
    this.ring.className = "inline-text-ring";
    this.ring.hidden = true;
    this.status = document.createElement("div");
    this.status.className = "inline-text-status";
    this.status.setAttribute("role", "status");
    this.status.hidden = true;
    this.marks = document.createElement("div");
    this.marks.className = "text-edit-marks";
    document
      .querySelector("#canvas-wrap")!
      .append(this.outline, this.marks, this.ring, this.status);
    // Clicking anywhere outside the inline editor saves it.
    document.addEventListener(
      "pointerdown",
      () => {
        if (this.inline) this.commitInline();
      },
      true,
    );
    this.outline.addEventListener("pointerdown", (event) =>
      this.begin(event, (event.target as HTMLElement).dataset.corner ?? "move"),
    );
    // Capture on the canvas, not on handles that follow the moving element.
    const canvas = document.querySelector<HTMLElement>("#select-layer")!;
    canvas.addEventListener("pointermove", (event) => this.move(event));
    canvas.addEventListener("pointerup", (event) => this.end(event));
    canvas.addEventListener("pointercancel", () => this.cancelGesture());
    canvas.addEventListener("lostpointercapture", () => {
      if (this.gesture) this.cancelGesture();
    });
    this.field<HTMLFormElement>("element-form").onsubmit = (e) =>
      e.preventDefault();
    this.field<HTMLTextAreaElement>("element-text").oninput = (e) =>
      this.patch({ text: (e.target as HTMLTextAreaElement).value });
    for (const [id, property] of [
      ["color", "color"],
      ["background", "background-color"],
    ] as const) {
      this.field<HTMLInputElement>(`element-${id}`).oninput = (e) => {
        const input = e.target as HTMLInputElement,
          value = input.value.trim();
        input.setCustomValidity(
          value && !CSS.supports("color", value) ? "Enter a valid color." : "",
        );
        if (input.validity.valid)
          this.patch({ style: { [property]: value || null } });
      };
      this.field<HTMLInputElement>(`element-${id}-picker`).oninput = (e) => {
        const value = (e.target as HTMLInputElement).value;
        this.field<HTMLInputElement>(`element-${id}`).value = value;
        this.patch({ style: { [property]: value } });
      };
    }
    for (const [id, property, suffix, factor] of [
      ["font-size", "font-size", "px", 1],
      ["opacity", "opacity", "", 0.01],
      ["width", "width", "px", 1],
      ["height", "height", "px", 1],
    ] as const)
      this.field<HTMLInputElement>(`element-${id}`).oninput = (e) => {
        const input = e.target as HTMLInputElement;
        if (input.validity.valid && input.value !== "")
          this.patch({
            style: { [property]: `${input.valueAsNumber * factor}${suffix}` },
          });
      };
    for (const [id, key, factor] of [
      ["x", "x", 1],
      ["y", "y", 1],
      ["scale-x", "scaleX", 0.01],
      ["scale-y", "scaleY", 0.01],
    ] as const)
      this.field<HTMLInputElement>(`element-${id}`).oninput = (e) => {
        const input = e.target as HTMLInputElement;
        if (input.validity.valid && input.value !== "")
          this.patch({ transform: { [key]: input.valueAsNumber * factor } });
      };
    this.field("element-hide").onclick = () => {
      const edit = this.currentEdit();
      this.patch(
        {
          hidden: !edit?.hidden,
          style:
            edit?.style?.display === "none" ? { display: null } : undefined,
        },
        true,
      );
    };
    this.field("element-remove").onclick = () =>
      this.patch({ hidden: true, style: { display: "none" } }, true);
    this.field("element-reset").onclick = () =>
      this.patch({ reset: true }, true);
    this.field("element-keep").onclick = () => {
      const draft = this.draft();
      if (!draft) return;
      draft.revision = this.hooks.bundle().revision;
      draft.error = undefined;
      void this.flush(elementKey(draft.target));
    };
    this.field("element-discard").onclick = () => {
      const d = this.draft();
      if (d?.timer) clearTimeout(d.timer);
      if (this.selected) this.drafts.delete(elementKey(this.selected.target));
      this.rendered = "";
      this.hooks.update();
      this.refresh();
    };
    this.field<HTMLInputElement>("direct-element-search").oninput = () =>
      this.renderList();
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.code === "Escape" && this.gesture) {
          event.preventDefault();
          event.stopImmediatePropagation();
          this.cancelGesture();
        }
        // A dialog owns the keyboard while it is open.
        if (document.querySelector("dialog[open]")) return;
        // Keys typed into the inline editor stay in its frame; never let
        // Delete or arrows act on the element while its text is open.
        if (this.inline) {
          if ((event.target as HTMLElement).closest("input,textarea,select"))
            return;
          event.preventDefault();
          event.stopImmediatePropagation();
          if (event.code === "Escape") this.cancelInline();
          else this.inline.field?.focus();
          return;
        }
        if (
          !this.selected ||
          this.root.hidden ||
          (event.target as HTMLElement).closest(
            "input,textarea,select,button,summary,a,[role=slider],[contenteditable]",
          )
        )
          return;
        if (event.code === "Delete" || event.code === "Backspace") {
          event.preventDefault();
          this.patch({ hidden: true, style: { display: "none" } }, true);
        }
        if (
          ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
            event.code,
          )
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
          const t = this.currentEdit()?.transform ?? defaults,
            step = event.shiftKey ? 10 : 1;
          this.patch({
            transform: {
              x:
                t.x +
                (event.code === "ArrowRight"
                  ? step
                  : event.code === "ArrowLeft"
                    ? -step
                    : 0),
              y:
                t.y +
                (event.code === "ArrowDown"
                  ? step
                  : event.code === "ArrowUp"
                    ? -step
                    : 0),
            },
          });
        }
      },
      true,
    );
  }
  private field<T extends HTMLElement = HTMLElement>(id: string): T {
    return this.root.querySelector<T>(`#${id}`)!;
  }
  private draft() {
    return this.selected && this.drafts.get(elementKey(this.selected.target));
  }
  get dirtyCount(): number {
    const pending =
      this.inline && this.inline.text !== this.inline.original ? 1 : 0;
    return this.drafts.size + pending;
  }
  select(entry: Editable | undefined): void {
    this.selected = entry;
    this.rendered = "";
    this.refresh();
  }
  edits(elements = this.hooks.bundle().edits.elements): ElementEdit[] {
    if (!this.drafts.size && !this.inline) return elements;
    const result = structuredClone(elements);
    let i = 0;
    for (const d of this.drafts.values())
      patchElement(result, d.target, d.patch, `preview-${i++}`);
    // The live element shows the typed text and reflows; the editor above it
    // draws the glyphs, so hide the element's own to avoid double text.
    const inline = this.inline;
    if (inline)
      patchElement(
        result,
        inline.entry.target,
        {
          ...(inline.text !== inline.original ? { text: inline.text } : {}),
          style: {
            "-webkit-text-fill-color": "transparent",
            "text-shadow": "none",
            ...(inline.newline && inline.text.includes("\n")
              ? { "white-space": inline.newline }
              : {}),
          },
        },
        "inline-preview",
      );
    return result;
  }
  /** The revision a new edit builds on, counting a save whose reload has not
   * arrived yet (an edit made right after "Saved" would otherwise conflict). */
  private baseRevision(): string {
    const current = this.hooks.bundle().revision;
    return this.lastSave?.from === current ? this.lastSave.to : current;
  }
  private currentEdit() {
    return (
      this.selected && effectiveElementEdit(this.edits(), this.selected.target)
    );
  }
  private patch(patch: ElementPatch, immediately = false): void {
    if (!this.selected) return;
    this.patchTarget(this.selected.target, patch, immediately);
  }
  private patchTarget(
    target: Target,
    patch: ElementPatch,
    immediately = false,
    base?: { revision: string; label: string },
  ): void {
    const key = elementKey(target);
    let d = this.drafts.get(key);
    if (!d) {
      d = {
        target,
        patch: {},
        revision: base?.revision ?? this.baseRevision(),
        version: 0,
        label: base?.label,
      };
      this.drafts.set(key, d);
    }
    d.patch = patch.reset
      ? { reset: true }
      : {
          ...d.patch,
          ...patch,
          style: { ...d.patch.style, ...patch.style },
          transform:
            patch.transform === null
              ? null
              : patch.transform || d.patch.transform
                ? { ...(d.patch.transform ?? {}), ...patch.transform }
                : undefined,
        };
    d.version++;
    if (d.timer) clearTimeout(d.timer);
    if (!d.error && !this.gesture)
      d.timer = setTimeout(() => void this.flush(key), immediately ? 0 : 350);
    this.hooks.update();
    this.refresh();
  }
  async flushAll(): Promise<void> {
    if (this.inline) this.commitInline();
    for (const key of [...this.drafts.keys()]) await this.flush(key);
    if (this.drafts.size)
      throw new Error("Resolve element edit changes before continuing.");
  }
  private flush(key: string): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        const draft = this.drafts.get(key);
        if (!draft || draft.error) return;
        if (draft.timer) clearTimeout(draft.timer);
        const version = draft.version,
          revision = draft.revision,
          patch = structuredClone(draft.patch);
        draft.busy = true;
        this.refresh();
        try {
          const result = await this.hooks.api<{ revision: string }>(
            "/api/element-edit",
            { revision, target: draft.target, patch },
          );
          for (const pending of this.drafts.values())
            if (pending.revision === revision)
              pending.revision = result.revision;
          this.lastSave = { from: revision, to: result.revision };
          // A Tab-chained editor opened before this save landed has the old
          // base revision; without this its own save would report a conflict.
          if (this.inline?.revision === revision)
            this.inline.revision = result.revision;
          if (draft.version === version) this.drafts.delete(key);
          await this.hooks.reload();
          // The bundle is current again and is the source of truth.
          this.lastSave = undefined;
        } catch (error) {
          draft.error = `${error instanceof Error ? error.message : String(error)} Your changes are kept. Apply them to the latest version or use the saved version.`;
          await this.hooks.reload().catch(() => {});
          // An inline edit saved after Tab moved on: show its conflict choice.
          if (
            !this.inline &&
            draft.label &&
            this.selected &&
            elementKey(this.selected.target) !== key
          )
            this.hooks.select({ target: draft.target, label: draft.label });
        } finally {
          this.lastSave = undefined;
          draft.busy = false;
          this.rendered = "";
          this.refresh();
          if (
            this.drafts.get(key) === draft &&
            !draft.error &&
            draft.version !== version
          )
            draft.timer = setTimeout(() => void this.flush(key), 0);
        }
      })
      // One unexpected exception must not poison every later flush.
      .catch((error) => console.error("Element edit flush failed", error));
    return this.queue;
  }
  refresh(): void {
    const selected = this.selected,
      node = selected && this.hooks.resolve(selected.target),
      d = this.draft();
    const key = selected ? elementKey(selected.target) : "";
    const changedTarget = key !== this.renderedTarget;
    const signature = `${key}:${this.hooks.bundle().revision}:${this.hooks.context()}`;
    this.field("element-empty").hidden = !!selected;
    this.field("element-form").hidden = !selected;
    this.field("element-save-state").textContent = d?.error
      ? "Changes need review"
      : this.inline && this.inline.key === key
        ? "Editing on canvas"
        : d?.busy
          ? "Saving…"
          : d
            ? "Unsaved changes"
            : selected
              ? "Saved"
              : "Select an element";
    this.field("element-conflict").hidden = !d?.error;
    const warning =
      selected && this.inline?.key === key
        ? this.inline.warning
        : selected && node && this.currentEdit()?.text !== undefined
          ? overflowWarning(node)
          : "";
    if (this.field("element-text-warning").textContent !== warning) {
      this.field("element-text-warning").textContent = warning;
      this.field("element-text-warning").hidden = !warning;
    }
    this.field("element-conflict-message").textContent = d?.error ?? "";
    if (
      selected &&
      node &&
      (changedTarget ||
        (!d && (signature !== this.rendered || node !== this.renderedNode)))
    ) {
      const style = node.ownerDocument.defaultView!.getComputedStyle(node),
        edit = this.currentEdit(),
        t = edit?.transform ?? defaults;
      this.field("element-name").textContent = selected.label;
      const values: Record<string, string> = {
        text: edit?.text ?? this.sourceText(node),
        color: style.color,
        background: style.backgroundColor,
        "font-size": String(parseFloat(style.fontSize) || 16),
        opacity: String(Math.round(Number(style.opacity) * 100)),
        x: String(t.x),
        y: String(t.y),
        "scale-x": String(Math.round(t.scaleX * 100)),
        "scale-y": String(Math.round(t.scaleY * 100)),
        width: String(
          Math.round(
            parseFloat(style.width) || node.getBoundingClientRect().width,
          ),
        ),
        height: String(
          Math.round(
            parseFloat(style.height) || node.getBoundingClientRect().height,
          ),
        ),
      };
      for (const [id, value] of Object.entries(values)) {
        const field = this.field<HTMLInputElement>(`element-${id}`);
        if (changedTarget || document.activeElement !== field)
          field.value = value;
      }
      for (const [id, value] of [
        ["color", style.color],
        ["background", style.backgroundColor],
      ]) {
        const rgb = value!.match(/[\d.]+/g);
        if (rgb && rgb.length >= 3)
          this.field<HTMLInputElement>(`element-${id}-picker`).value =
            "#" +
            rgb
              .slice(0, 3)
              .map((v) => Math.round(Number(v)).toString(16).padStart(2, "0"))
              .join("");
      }
      this.field("element-hide").textContent =
        edit?.hidden || edit?.style?.display === "none" ? "Restore" : "Hide";
      this.rendered = signature;
      this.renderedTarget = key;
      this.renderedNode = node;
    }
    if (signature !== (this.root.dataset.listRevision ?? "")) {
      this.root.dataset.listRevision = signature;
      this.renderList();
    }
  }
  private sourceText(node: Element): string {
    const walker = node.ownerDocument.createTreeWalker(node, 4);
    const text: string[] = [];
    let leaf: Node | null;
    while ((leaf = walker.nextNode()))
      if (!leaf.parentElement?.closest("script,style,noscript"))
        text.push(leaf.nodeValue ?? "");
    return text.join("").trim();
  }
  renderList(): void {
    const query = this.field<HTMLInputElement>(
      "direct-element-search",
    ).value.toLowerCase();
    const all = this.hooks.entries();
    this.field("direct-element-count").textContent = String(all.length);
    const list = this.field("direct-elements-list");
    list.replaceChildren();
    for (const entry of all
      .filter(
        (e) =>
          !query ||
          `${e.label} ${e.target.selector ?? ""} ${e.target.ref ?? ""}`
            .toLowerCase()
            .includes(query),
      )
      .slice(0, 150)) {
      const row = document.createElement("button"),
        edit = effectiveElementEdit(this.edits(), entry.target);
      row.type = "button";
      row.className = "direct-layer";
      row.textContent = `${entry.label}${edit?.hidden || edit?.style?.display === "none" ? " · hidden" : ""}`;
      row.title =
        entry.target.scene ?? entry.target.ref ?? entry.target.selector ?? "";
      row.onclick = () => this.hooks.select(entry);
      list.append(row);
    }
  }
  rect(): { box: DOMRect; scaleX: number; scaleY: number } | undefined {
    if (!this.selected) return;
    const node = this.hooks.resolve(this.selected.target);
    return node && this.screenRect(node);
  }
  /** A node's box (or `local`, in its document) in Studio window pixels. */
  private screenRect(
    node: Element,
    local = node.getBoundingClientRect(),
  ): { box: DOMRect; scaleX: number; scaleY: number } | undefined {
    const frame = this.hooks.frame(node);
    if (
      !frame ||
      (frame.classList.contains("scene-frame") &&
        !frame.classList.contains("visible"))
    )
      return;
    const f = frame.getBoundingClientRect();
    if (!local.width || !local.height) return;
    const scaleX = f.width / frame.clientWidth,
      scaleY = f.height / frame.clientHeight;
    return {
      box: new DOMRect(
        f.left + local.left * scaleX,
        f.top + local.top * scaleY,
        local.width * scaleX,
        local.height * scaleY,
      ),
      scaleX,
      scaleY,
    };
  }
  draw(enabled: boolean): void {
    this.refresh();
    this.placeInline();
    this.drawMarks(enabled && !this.inline && !!this.pointer);
    const rect = enabled && !this.inline && this.rect();
    this.outline.hidden = !rect;
    if (!rect) return;
    const canvas = document
      .querySelector("#canvas-wrap")!
      .getBoundingClientRect();
    Object.assign(this.outline.style, {
      left: `${rect.box.left - canvas.left}px`,
      top: `${rect.box.top - canvas.top}px`,
      width: `${rect.box.width}px`,
      height: `${rect.box.height}px`,
    });
  }
  consumeClick(): boolean {
    const value = this.suppressClick;
    this.suppressClick = false;
    return value;
  }
  begin(event: PointerEvent, mode = "move"): void {
    const rect = this.rect();
    if (!rect || !this.selected || event.button !== 0 || this.root.hidden)
      return;
    const canvas = document.querySelector<HTMLElement>("#select-layer")!;
    const d = this.draft();
    this.gesture = {
      pointer: event.pointerId,
      key: elementKey(this.selected.target),
      target: this.selected.target,
      startX: event.clientX,
      startY: event.clientY,
      box: rect.box,
      scaleX: rect.scaleX,
      scaleY: rect.scaleY,
      transform: { ...(this.currentEdit()?.transform ?? defaults) },
      patch: structuredClone(d?.patch ?? {}),
      mode,
      changed: false,
    };
    if (d?.timer) clearTimeout(d.timer);
    canvas.tabIndex = -1;
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }
  private move(event: PointerEvent): void {
    const g = this.gesture;
    if (!g || g.pointer !== event.pointerId) return;
    const dx = event.clientX - g.startX,
      dy = event.clientY - g.startY;
    if (!g.changed && Math.hypot(dx, dy) < 3) return;
    g.changed = true;
    let t = { ...g.transform };
    if (g.mode === "move") {
      t.x += dx / g.scaleX;
      t.y += dy / g.scaleY;
    } else {
      const west = g.mode.includes("w"),
        north = g.mode.includes("n");
      let rx = Math.max(
          0.05 / g.transform.scaleX,
          1 + (dx * (west ? -1 : 1)) / g.box.width,
        ),
        ry = Math.max(
          0.05 / g.transform.scaleY,
          1 + (dy * (north ? -1 : 1)) / g.box.height,
        );
      if (event.shiftKey) rx = ry = Math.max(rx, ry);
      t.scaleX = Math.min(20, g.transform.scaleX * rx);
      t.scaleY = Math.min(20, g.transform.scaleY * ry);
      // CSS scales around the authored origin. Correct the translation so the
      // opposite visible corner stays still, including authored transforms.
      this.patchTarget(g.target, { transform: t });
      const next = this.rect();
      if (next) {
        const anchorX = west ? g.box.right : g.box.left,
          anchorY = north ? g.box.bottom : g.box.top;
        t.x += (anchorX - (west ? next.box.right : next.box.left)) / g.scaleX;
        t.y += (anchorY - (north ? next.box.bottom : next.box.top)) / g.scaleY;
      }
    }
    this.patchTarget(g.target, { transform: t });
    event.preventDefault();
  }
  private end(event: PointerEvent): void {
    const g = this.gesture;
    if (!g || event.pointerId !== g.pointer) return;
    this.gesture = undefined;
    if (g.changed) this.suppressClick = true;
    if (this.drafts.has(g.key)) void this.flush(g.key);
    const canvas = document.querySelector<HTMLElement>("#select-layer")!;
    if (canvas.hasPointerCapture(event.pointerId))
      canvas.releasePointerCapture(event.pointerId);
  }
  private cancelGesture(): void {
    const g = this.gesture;
    if (!g) return;
    this.gesture = undefined;
    const d = this.drafts.get(g.key);
    if (d) {
      if (d.timer) clearTimeout(d.timer);
      d.patch = g.patch;
      d.version++;
      if (!Object.keys(g.patch).length) this.drafts.delete(g.key);
    }
    const canvas = document.querySelector<HTMLElement>("#select-layer")!;
    if (canvas.hasPointerCapture(g.pointer))
      canvas.releasePointerCapture(g.pointer);
    if (d && Object.keys(g.patch).length && !d.error)
      d.timer = setTimeout(() => void this.flush(g.key), 350);
    this.suppressClick = g.changed;
    this.hooks.update();
    this.refresh();
  }
  // Inline text editing ------------------------------------------------------
  /**
   * Rewrite the text that owns `node` (or the text at `point`, in the node's
   * document coordinates) in place. Returns false when there is no text.
   */
  editText(node: Element, point?: { x: number; y: number }): boolean {
    let owner = textOwner(node, point),
      entry: Editable | undefined;
    while (owner && !["HTML", "BODY"].includes(owner.tagName)) {
      entry = this.hooks.editableOf(owner);
      if (entry) break;
      owner = owner.parentElement ?? undefined;
    }
    if (!owner || !entry) return false;
    const key = elementKey(entry.target);
    if (this.inline?.key === key) {
      this.inline.field?.focus();
      return true;
    }
    if (this.inline) this.commitInline();
    this.hooks.pause();
    this.hooks.select(entry);
    const live = this.hooks.resolve(entry.target) ?? owner,
      style = live.ownerDocument.defaultView!.getComputedStyle(live),
      // What is on screen, including nested elements' own edits.
      original = displayedText(live);
    this.inline = {
      entry,
      key,
      original,
      text: original,
      revision: this.baseRevision(),
      newline: isTextField(live)
        ? undefined
        : ["normal", "nowrap"].includes(style.whiteSpace)
          ? style.whiteSpace === "nowrap"
            ? "pre"
            : "pre-line"
          : undefined,
      selection: [0, original.length],
      warning: "",
    };
    this.mount(live);
    document.body.classList.add("inline-text-editing");
    this.hooks.update();
    return true;
  }
  /** Save the inline text through the same targeted patch as the panel. */
  commitInline(move?: 1 | -1): void {
    const inline = this.inline;
    if (!inline) return;
    const from = this.hooks.resolve(inline.entry.target);
    const next = move && from ? this.neighbour(from, move) : undefined;
    this.closeInline();
    if (inline.text !== inline.original)
      this.patchTarget(
        inline.entry.target,
        {
          text: inline.text,
          ...(inline.newline && inline.text.includes("\n")
            ? { style: { "white-space": inline.newline } }
            : {}),
        },
        true,
        { revision: inline.revision, label: inline.entry.label },
      );
    else this.hooks.update();
    if (next) this.editText(next);
  }
  cancelInline(): void {
    if (!this.inline) return;
    this.closeInline();
    this.rendered = "";
    this.hooks.update();
    this.refresh();
  }
  get editingText(): boolean {
    return !!this.inline;
  }
  private closeInline(): void {
    const inline = this.inline;
    if (!inline) return;
    this.inline = undefined;
    inline.host?.remove();
    inline.frame?.classList.remove("inline-text-frame");
    document.body.classList.remove("inline-text-editing");
    this.ring.hidden = this.status.hidden = true;
    // Keyboard shortcuts belong to Studio again, not the preview frame.
    if (document.activeElement === inline.frame)
      (document.activeElement as HTMLElement).blur();
    this.rendered = "";
  }
  private mount(node: Element): void {
    const inline = this.inline!,
      doc = node.ownerDocument;
    const focused =
      !inline.field ||
      document.activeElement === document.body ||
      document.activeElement === inline.frame ||
      !inline.frame?.isConnected;
    inline.host?.remove();
    inline.frame?.classList.remove("inline-text-frame");
    this.guard(doc);
    // A shadow root keeps the page's CSS off the editor; same-document
    // rendering keeps its fonts, layout and the preview/camera scale.
    const host = doc.createElement("demohunter-text-editor");
    host.setAttribute(
      "style",
      "all:initial!important;position:fixed!important;left:0!important;top:0!important;width:0!important;height:0!important;display:block!important;z-index:2147483647!important;pointer-events:none!important",
    );
    const root = host.attachShadow({ mode: "open" });
    const css = doc.createElement("style");
    css.textContent =
      ".f{all:initial;position:fixed;display:block;box-sizing:border-box;margin:0;border-style:solid;border-color:transparent;background:transparent;outline:none;resize:none;overflow:hidden;pointer-events:auto;transform-origin:0 0;cursor:text}.f::selection{background:rgba(47,91,234,.3)}";
    const multiline = node.localName !== "input";
    const field = doc.createElement(multiline ? "textarea" : "input");
    field.className = "f";
    field.spellcheck = false;
    field.setAttribute("aria-label", "Rewrite text");
    field.value = inline.text;
    root.append(css, field);
    doc.documentElement.append(host);
    Object.assign(inline, {
      doc,
      host,
      field,
      frame: this.hooks.frame(node),
    });
    inline.frame?.classList.add("inline-text-frame");
    field.addEventListener("input", () => {
      if (this.inline !== inline) return;
      inline.text = field.value;
      this.rememberSelection();
      const panel = this.field<HTMLTextAreaElement>("element-text");
      if (this.selected && elementKey(this.selected.target) === inline.key)
        panel.value = inline.text;
      this.hooks.update();
    });
    for (const type of ["select", "keyup", "pointerup"])
      field.addEventListener(type, () => this.rememberSelection());
    field.addEventListener("keydown", (event) => {
      const e = event as KeyboardEvent;
      e.stopPropagation();
      if (e.isComposing || this.inline !== inline) return;
      if (e.key === "Enter" && (!e.shiftKey || !multiline)) {
        e.preventDefault();
        this.commitInline();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.cancelInline();
      } else if (e.key === "Tab") {
        e.preventDefault();
        this.commitInline(e.shiftKey ? -1 : 1);
      }
    });
    this.placeInline();
    if (focused) {
      field.focus({ preventScroll: true });
      field.setSelectionRange(...inline.selection);
    }
  }
  private rememberSelection(): void {
    const field = this.inline?.field;
    if (field)
      this.inline!.selection = [
        field.selectionStart ?? 0,
        field.selectionEnd ?? 0,
      ];
  }
  /** Block page clicks (links, buttons) in a frame while text is edited. */
  private guard(doc: Document): void {
    if (this.guarded.has(doc)) return;
    this.guarded.add(doc);
    for (const type of [
      "pointerdown",
      "mousedown",
      "click",
      "dblclick",
      "auxclick",
      "contextmenu",
    ])
      doc.addEventListener(
        type,
        (event) => {
          if (!this.inline && performance.now() > this.guardUntil) return;
          if (
            this.inline?.host &&
            event.composedPath().includes(this.inline.host)
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          if (type === "pointerdown" && this.inline) {
            this.guardUntil = performance.now() + 600;
            this.commitInline();
          }
        },
        true,
      );
  }
  /** Lay the editor exactly over the element's text, every frame. */
  private placeInline(): void {
    const inline = this.inline;
    if (!inline) return;
    const node = this.hooks.resolve(inline.entry.target);
    if (!node) {
      // The replay is rebuilding (a save or agent edit); wait for the node.
      if (inline.host)
        inline.host.style.setProperty("display", "none", "important");
      this.ring.hidden = this.status.hidden = true;
      return;
    }
    if (node.ownerDocument !== inline.doc || !inline.host?.isConnected) {
      this.mount(node);
      return;
    }
    inline.host.style.setProperty("display", "block", "important");
    const field = inline.field!,
      view = node.ownerDocument.defaultView!,
      cs = view.getComputedStyle(node),
      rect = node.getBoundingClientRect(),
      el = node as HTMLElement,
      fs = field.style;
    // offsetWidth is rounded: only use it to undo real (moved/scaled) transforms.
    let transformed = false;
    for (let a: Element | null = node; a && !transformed; a = a.parentElement)
      transformed = view.getComputedStyle(a).transform !== "none";
    const layoutW = transformed ? (el.offsetWidth ?? rect.width) : rect.width,
      layoutH = transformed ? (el.offsetHeight ?? rect.height) : rect.height,
      sx = layoutW && rect.width ? rect.width / layoutW : 1,
      sy = layoutH && rect.height ? rect.height / layoutH : 1;
    for (const name of typography)
      fs.setProperty(name, cs.getPropertyValue(name));
    const color = cs.color;
    fs.color = /^(transparent|rgba\(.*,\s*0\))$/.test(color) ? "#111" : color;
    fs.caretColor = fs.color;
    fs.transform = `scale(${sx}, ${sy})`;
    const text = textBox(node),
      box =
        isTextField(node) ||
        /^(block|list-item|flow-root|inline-block|table-cell|table-caption|-webkit-box|table)$/.test(
          cs.display,
        );
    const px = (name: string) => parseFloat(cs.getPropertyValue(name)) || 0;
    // Range boxes start at the glyphs; the editor's lines start at the line
    // box, half the leading above them.
    const lineHeight = parseFloat(cs.lineHeight),
      first = text.lines[0],
      leading =
        first && Number.isFinite(lineHeight)
          ? (lineHeight - first.height / sy) / 2
          : 0;
    if (box) {
      // Same border box, padding and width: the text wraps where it does.
      const pad = {
        top: px("padding-top"),
        right: px("padding-right"),
        bottom: px("padding-bottom"),
        left: px("padding-left"),
      };
      const border = ["top", "right", "bottom", "left"].map(
        (side) => `${px(`border-${side}-width`)}px`,
      );
      // Buttons and table cells centre their text vertically.
      if (!isTextField(node) && text.lines.length) {
        const dy =
          (text.box.top - rect.top) / sy -
          px("border-top-width") -
          pad.top -
          leading;
        if (dy > 0.5) pad.top += dy;
      }
      Object.assign(fs, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${layoutW}px`,
        height: `${layoutH}px`,
        padding: `${pad.top}px ${pad.right}px ${pad.bottom}px ${pad.left}px`,
        borderWidth: border.join(" "),
        textAlign: cs.textAlign,
        textIndent: cs.textIndent,
        whiteSpace: ["nowrap", "pre"].includes(cs.whiteSpace)
          ? "pre"
          : "pre-wrap",
      });
      // Keep overflowing text readable while the warning explains it.
      if (field.scrollHeight > field.clientHeight + 1)
        fs.height = `${layoutH + field.scrollHeight - field.clientHeight}px`;
      if (field.scrollWidth > field.clientWidth + 1 && fs.whiteSpace === "pre")
        fs.width = `${layoutW + field.scrollWidth - field.clientWidth}px`;
    } else {
      // Inline and flex text: cover the text runs themselves.
      const b = text.lines.length ? text.box : rect;
      Object.assign(fs, {
        left: `${b.left}px`,
        top: `${b.top - leading * sy}px`,
        width: `${Math.max(2, b.width / sx + 1)}px`,
        height: `${Math.max(b.height / sy + leading * 2, parseFloat(cs.fontSize) || 0)}px`,
        padding: "0",
        borderWidth: "0",
        textAlign: text.lines.length > 1 ? cs.textAlign : "left",
        textIndent:
          text.lines.length > 1 && first
            ? `${(first.left - b.left) / sx}px`
            : "0",
        whiteSpace: text.lines.length > 1 ? "pre-wrap" : "pre",
      });
    }
    const metrics = measure(node);
    inline.baseline ??= metrics;
    const base = inline.baseline;
    inline.warning =
      metrics.overflowX > base.overflowX + 1 ||
      metrics.overflowY > base.overflowY + 1 ||
      (metrics.clipped && !base.clipped)
        ? "Text overflows its box and may be cut off."
        : metrics.width > base.width + 1 || metrics.height > base.height + 1
          ? "Text is larger than the original box. Nearby layout may shift."
          : "";
    const screen = this.screenRect(field);
    const wrap = document
      .querySelector("#canvas-wrap")!
      .getBoundingClientRect();
    this.ring.hidden = this.status.hidden = !screen;
    if (!screen) return;
    const s = screen.box;
    Object.assign(this.ring.style, {
      left: `${s.left - wrap.left - 3}px`,
      top: `${s.top - wrap.top - 3}px`,
      width: `${s.width + 6}px`,
      height: `${s.height + 6}px`,
    });
    this.ring.classList.toggle("warn", !!inline.warning);
    const message =
      inline.warning ||
      `Enter to save · ${field.localName === "textarea" ? "Shift+Enter new line · " : ""}Esc to cancel · Tab next`;
    if (this.status.textContent !== message) this.status.textContent = message;
    this.status.classList.toggle("warn", !!inline.warning);
    const stage = document.querySelector("#stage")!.getBoundingClientRect(),
      height = this.status.offsetHeight || 24;
    const below = s.bottom + 8 + height < stage.bottom;
    Object.assign(this.status.style, {
      left: `${Math.max(stage.left, Math.min(s.left, stage.right - this.status.offsetWidth)) - wrap.left}px`,
      top: `${(below ? s.bottom + 8 : Math.max(stage.top, s.top - 8 - height)) - wrap.top}px`,
    });
  }
  /** The next text element in reading order on the current frame. */
  private neighbour(from: Element, direction: 1 | -1): Element | undefined {
    const items: { node: Element; box: DOMRect }[] = [];
    for (const doc of this.hooks.textLayers())
      for (const node of doc.body?.querySelectorAll("*") ?? []) {
        if (node !== from && !ownsText(node)) continue;
        const style = doc.defaultView!.getComputedStyle(node);
        if (style.visibility !== "visible" || Number(style.opacity) === 0)
          continue;
        const local = node.getBoundingClientRect();
        if (
          !local.width ||
          !local.height ||
          local.right < 0 ||
          local.bottom < 0 ||
          local.left > doc.defaultView!.innerWidth ||
          local.top > doc.defaultView!.innerHeight
        )
          continue;
        const screen = this.screenRect(node, local);
        if (screen) items.push({ node, box: screen.box });
      }
    const ordered = readingOrder(items);
    const index = ordered.findIndex((item) => item.node === from);
    if (index < 0) return;
    for (let step = 1; step < ordered.length; step++) {
      const n = ordered.length,
        next = ordered[(((index + step * direction) % n) + n) % n]!;
      if (this.hooks.editableOf(next.node)) return next.node;
    }
  }
  /** Subtle outlines on elements with rewritten text while hovering. */
  private drawMarks(show: boolean): void {
    const boxes: DOMRect[] = [];
    if (show)
      for (const edit of this.edits()) {
        if (edit.text === undefined) continue;
        const node = this.hooks.resolve(edit.target),
          screen = node && this.screenRect(node);
        if (screen) boxes.push(screen.box);
      }
    const wrap = document
      .querySelector("#canvas-wrap")!
      .getBoundingClientRect();
    while (this.marks.children.length > boxes.length)
      this.marks.lastElementChild!.remove();
    boxes.forEach((b, i) => {
      let mark = this.marks.children[i] as HTMLElement | undefined;
      if (!mark) {
        mark = document.createElement("div");
        mark.className = "text-edit-mark";
        mark.dataset.label = "Text edited";
        this.marks.append(mark);
      }
      const p = this.pointer!;
      mark.classList.toggle(
        "hot",
        p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom,
      );
      Object.assign(mark.style, {
        left: `${b.left - wrap.left - 2}px`,
        top: `${b.top - wrap.top - 2}px`,
        width: `${b.width + 4}px`,
        height: `${b.height + 4}px`,
      });
    });
  }
}

/** Deterministic selector for a scene's authored DOM, independent of edited text/style. */
export function sceneSelector(node: Element): string {
  if (
    node.id &&
    node.ownerDocument.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1
  )
    return `#${CSS.escape(node.id)}`;
  const parts: string[] = [];
  while (node.parentElement && node.tagName !== "HTML") {
    const name = node.localName,
      siblings = [...node.parentElement.children].filter(
        (n) => n.localName === name,
      );
    parts.unshift(
      `${CSS.escape(name)}:nth-of-type(${siblings.indexOf(node) + 1})`,
    );
    node = node.parentElement;
  }
  return `html > ${parts.join(" > ")}`;
}

const typography = [
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-stretch",
  "font-variant",
  "font-feature-settings",
  "font-variation-settings",
  "font-kerning",
  "font-optical-sizing",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-transform",
  "direction",
  "overflow-wrap",
  "word-break",
  "hyphens",
  "tab-size",
  "text-rendering",
  "-webkit-font-smoothing",
  "writing-mode",
  "font-synthesis",
  "text-decoration-line",
  "text-decoration-style",
  "text-decoration-color",
  "text-decoration-thickness",
  "text-underline-offset",
];
const skipped = "script,style,noscript,template,title";
/** True when the element itself holds visible text (not only its children). */
function ownsText(node: Element): boolean {
  if (isTextField(node)) return true;
  if (node.closest(skipped)) return false;
  for (const child of node.childNodes)
    if (child.nodeType === 3 && child.nodeValue?.trim()) return true;
  return false;
}
/**
 * The deepest element that owns the text under the pointer: only the `<b>`
 * of `<p>Hello <b>world</b></p>` when "world" is double-clicked.
 */
function textOwner(
  hit: Element,
  point?: { x: number; y: number },
): Element | undefined {
  if (isTextField(hit) || (!point && ownsText(hit))) return hit;
  const doc = hit.ownerDocument;
  const caret = point && doc.caretRangeFromPoint?.(point.x, point.y);
  const leaf = caret?.startContainer;
  if (leaf?.nodeType === 3 && leaf.nodeValue?.trim() && leaf.parentElement) {
    // An icon inside a button finds the button's label.
    let near: Element | null = hit;
    for (let i = 0; near && i < 4 && !near.contains(leaf); i++)
      near = near.parentElement;
    if (near?.contains(leaf) && !leaf.parentElement.closest(skipped))
      return leaf.parentElement;
  }
  let node: Element | null = hit;
  while (node && !ownsText(node) && !node.textContent?.trim())
    node = node.parentElement;
  return node ?? undefined;
}
/** The text as it reads on screen: collapsed whitespace, `<br>` as a new line. */
function displayedText(node: Element): string {
  if (isTextField(node)) return node.value;
  const view = node.ownerDocument.defaultView!;
  const walker = node.ownerDocument.createTreeWalker(node, 1 | 4);
  let text = "",
    leaf: Node | null;
  while ((leaf = walker.nextNode())) {
    if (leaf.nodeType === 1) {
      if ((leaf as Element).localName === "br") text += "\u0000";
      continue;
    }
    const parent = leaf.parentElement;
    if (!parent || parent.closest(skipped)) continue;
    const space = view.getComputedStyle(parent).whiteSpace;
    let value = leaf.nodeValue ?? "";
    if (["normal", "nowrap"].includes(space)) {
      // Collapse like CSS, including across element boundaries.
      value = value.replace(/[\t\n\r\f ]+/g, " ");
      if (!text || /[ \u0000]$/.test(text)) value = value.replace(/^ /, "");
    } else if (space === "pre-line")
      value = value.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n");
    text += value;
  }
  return text
    .replace(/ (?=\u0000)/g, "")
    .replaceAll("\u0000", "\n")
    .trim();
}
/** Line boxes of an element's own text, without icons or other children. */
function textBox(node: Element): { box: DOMRect; lines: DOMRect[] } {
  const doc = node.ownerDocument,
    range = doc.createRange(),
    lines: DOMRect[] = [];
  const walker = doc.createTreeWalker(node, 4);
  let leaf: Node | null;
  while ((leaf = walker.nextNode())) {
    if (!leaf.nodeValue?.trim() || leaf.parentElement?.closest(skipped))
      continue;
    range.selectNodeContents(leaf);
    for (const r of range.getClientRects())
      if (r.width || r.height) lines.push(r);
  }
  if (!lines.length) return { box: node.getBoundingClientRect(), lines };
  const left = Math.min(...lines.map((r) => r.left)),
    top = Math.min(...lines.map((r) => r.top)),
    right = Math.max(...lines.map((r) => r.right)),
    bottom = Math.max(...lines.map((r) => r.bottom));
  // Line boxes of one line: merge text runs that share a line.
  const merged: DOMRect[] = [];
  for (const r of lines.sort((a, b) => a.top - b.top || a.left - b.left)) {
    const last = merged.at(-1);
    if (
      last &&
      Math.abs(last.top - r.top) < Math.min(last.height, r.height) / 2
    )
      merged[merged.length - 1] = new DOMRect(
        Math.min(last.left, r.left),
        Math.min(last.top, r.top),
        Math.max(last.right, r.right) - Math.min(last.left, r.left),
        Math.max(last.bottom, r.bottom) - Math.min(last.top, r.top),
      );
    else merged.push(r);
  }
  return {
    box: new DOMRect(left, top, right - left, bottom - top),
    lines: merged,
  };
}
function measure(node: Element): Metrics {
  const el = node as HTMLElement,
    view = node.ownerDocument.defaultView!,
    rect = node.getBoundingClientRect();
  const own = view.getComputedStyle(node);
  // Text fields scroll their value instead of showing overflow.
  const field = isTextField(node);
  const inline = !field && own.display === "inline";
  // Only real clipping counts: overflow that stays visible is not cut off,
  // and the viewport edge moves as the recording scrolls.
  let clipped = false;
  for (
    let a = node.parentElement;
    a && !clipped && a !== node.ownerDocument.body;
    a = a.parentElement
  ) {
    const s = view.getComputedStyle(a);
    if (s.overflowX === "visible" && s.overflowY === "visible") continue;
    const r = a.getBoundingClientRect();
    clipped =
      rect.left < r.left - 1 ||
      rect.top < r.top - 1 ||
      rect.right > r.right + 1 ||
      rect.bottom > r.bottom + 1;
  }
  return {
    width: el.offsetWidth ?? rect.width,
    height: el.offsetHeight ?? rect.height,
    overflowX:
      inline || (!field && own.overflowX === "visible")
        ? 0
        : Math.max(0, el.scrollWidth - el.clientWidth),
    overflowY:
      inline || (!field && own.overflowY === "visible")
        ? 0
        : Math.max(0, el.scrollHeight - el.clientHeight),
    clipped,
  };
}
/** Saved text that does not fit: the panel's warning. */
function overflowWarning(node: Element): string {
  const m = measure(node);
  return m.overflowX > 1 || m.overflowY > 1 || m.clipped
    ? "Text overflows its box and may be cut off."
    : "";
}
/** Rows from top to bottom, then left to right within a row. */
function readingOrder<T extends { box: DOMRect }>(items: T[]): T[] {
  const rows: T[][] = [];
  for (const item of [...items].sort((a, b) => a.box.top - b.box.top)) {
    const row = rows.at(-1),
      first = row?.[0]?.box;
    if (
      row &&
      first &&
      item.box.top + item.box.height / 2 < first.bottom &&
      item.box.top + item.box.height / 2 > first.top
    )
      row.push(item);
    else rows.push([item]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.box.left - b.box.left));
}
