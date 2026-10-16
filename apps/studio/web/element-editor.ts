import type { ReplayBundle, Target } from "../model.js";
import {
  effectiveElementEdit,
  elementKey,
  patchElement,
  type ElementPatch,
  type ElementEdit,
} from "../element-edit.js";
export type Editable = { target: Target; label: string };
type Draft = {
  target: Target;
  patch: ElementPatch;
  revision: string;
  version: number;
  error?: string;
  busy?: boolean;
  timer?: ReturnType<typeof setTimeout>;
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
};
const defaults = { x: 0, y: 0, scaleX: 1, scaleY: 1 };
export class ElementEditor {
  selected?: Editable;
  private drafts = new Map<string, Draft>();
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
  constructor(
    private root: HTMLElement,
    private hooks: Hooks,
  ) {
    root.innerHTML = `<div class="direct-heading"><strong>Edit element</strong><span id="element-save-state" role="status">Select an element</span></div>
      <div class="direct-scroll"><p id="element-empty" class="hint">Click an element in the preview, or choose one below.</p>
      <form id="element-form" hidden><p id="element-name" class="mono"></p>
      <label class="direct-field">Text<textarea id="element-text" rows="3" spellcheck="false"></textarea></label>
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
      this.outline.append(handle);
    }
    this.outline.setAttribute("aria-label", "Drag selected element");
    this.outline.tabIndex = 0;
    document.querySelector("#canvas-wrap")!.append(this.outline);
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
        if (
          !this.selected ||
          this.root.hidden ||
          (event.target as HTMLElement).closest(
            "input,textarea,select,button,[contenteditable]",
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
    return this.drafts.size;
  }
  select(entry: Editable | undefined): void {
    this.selected = entry;
    this.rendered = "";
    this.refresh();
  }
  edits(elements = this.hooks.bundle().edits.elements): ElementEdit[] {
    if (!this.drafts.size) return elements;
    const result = structuredClone(elements);
    let i = 0;
    for (const d of this.drafts.values())
      patchElement(result, d.target, d.patch, `preview-${i++}`);
    return result;
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
  ): void {
    const key = elementKey(target);
    let d = this.drafts.get(key);
    if (!d) {
      d = {
        target,
        patch: {},
        revision: this.hooks.bundle().revision,
        version: 0,
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
    for (const key of [...this.drafts.keys()]) await this.flush(key);
    if (this.drafts.size)
      throw new Error("Resolve element edit changes before continuing.");
  }
  private flush(key: string): Promise<void> {
    this.queue = this.queue.then(async () => {
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
          if (pending.revision === revision) pending.revision = result.revision;
        if (draft.version === version) this.drafts.delete(key);
        await this.hooks.reload();
      } catch (error) {
        draft.error = `${error instanceof Error ? error.message : String(error)} Your changes are kept. Apply them to the latest version or use the saved version.`;
        await this.hooks.reload().catch(() => {});
      } finally {
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
    });
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
      : d?.busy
        ? "Saving…"
        : d
          ? "Unsaved changes"
          : selected
            ? "Saved"
            : "Select an element";
    this.field("element-conflict").hidden = !d?.error;
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
    const node = this.hooks.resolve(this.selected.target),
      frame = node && this.hooks.frame(node);
    if (
      !node ||
      !frame ||
      (frame.classList.contains("scene-frame") &&
        !frame.classList.contains("visible"))
    )
      return;
    const local = node.getBoundingClientRect(),
      f = frame.getBoundingClientRect();
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
    const rect = enabled && this.rect();
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
