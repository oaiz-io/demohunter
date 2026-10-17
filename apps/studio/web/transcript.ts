import { projectUrl } from "./transport.js";
import {
  audioIsCurrent,
  clipDuration,
  narrationStart,
  type ReplayBundle,
  type NarrationSegment,
} from "../model.js";

export type ScriptPatch = Partial<Pick<NarrationSegment, "text" | "title">>;
type Draft = {
  base: NarrationSegment;
  patch: ScriptPatch;
  timer?: ReturnType<typeof setTimeout>;
  pending?: Promise<void>;
  error?: string;
  version: number;
};
type Hooks = {
  save: (
    id: string,
    patch: ScriptPatch,
    base: NarrationSegment,
    force: boolean,
  ) => Promise<NarrationSegment>;
  regenerate: (ids: string[]) => Promise<void>;
  remove: (id: string) => Promise<void>;
  dirty: (count: number) => void;
  error: (error: unknown) => void;
};
const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const clock = (ms: number) =>
  `${Math.floor(ms / 60000)
    .toString()
    .padStart(2, "0")}:${((ms / 1000) % 60).toFixed(1).padStart(4, "0")}`;

export class TranscriptEditor {
  private bundle?: ReplayBundle;
  private drafts = new Map<string, Draft>();
  private cards = new Map<string, HTMLElement>();
  private waveforms = new Map<string, Promise<Float32Array>>();
  private audioContext?: AudioContext;
  constructor(
    private root: HTMLElement,
    private hooks: Hooks,
  ) {}
  private active?: string;
  /** The segment of the scene under the playhead is expanded; others are
   * compact excerpts. */
  setActive(id: string | undefined): void {
    if (id === this.active) return;
    this.active = id;
    for (const [segment, card] of this.cards)
      card.classList.toggle("active", segment === id);
  }
  get dirtyCount(): number {
    return this.drafts.size;
  }
  render(bundle: ReplayBundle): void {
    this.bundle = bundle;
    for (const segment of bundle.narration.segments) {
      let card = this.cards.get(segment.id);
      if (!card) {
        card = this.createCard(segment.id);
        this.cards.set(segment.id, card);
        this.root.append(card);
      }
      const draft = this.drafts.get(segment.id);
      const values = { ...segment, ...draft?.patch };
      const start = narrationStart(bundle.edits, values);
      const title = card.querySelector<HTMLInputElement>(".narration-title")!;
      if (document.activeElement !== title)
        title.value =
          values.title ??
          `Scene ${bundle.narration.segments.indexOf(segment) + 1}`;
      const textarea = card.querySelector<HTMLTextAreaElement>(
        "textarea.script-text",
      )!;
      if (
        document.activeElement !== textarea ||
        textarea.value !== values.text
      ) {
        const pos = textarea.selectionStart;
        textarea.value = values.text;
        if (document.activeElement === textarea)
          textarea.setSelectionRange(
            Math.min(pos, values.text.length),
            Math.min(pos, values.text.length),
          );
      }
      const ready = audioIsCurrent(bundle.project, values);
      const index = bundle.narration.segments.indexOf(segment);
      // Screen readers get the segment's name, not its internal id.
      const name =
        values.title?.trim() ||
        values.text.trim().split(/\s+/).slice(0, 6).join(" ") ||
        `segment ${index + 1}`;
      card
        .querySelector(".narration-title")!
        .setAttribute("aria-label", `Title for ${name}`);
      textarea.setAttribute("aria-label", `Script for ${name}`);
      card
        .querySelector(".segment-remove")!
        .setAttribute("aria-label", `Remove ${name}`);
      card.querySelector<HTMLElement>(".segment-number")!.textContent = String(
        index + 1,
      ).padStart(2, "0");
      const badge = card.querySelector<HTMLElement>(".status-tag")!;
      const state = !segment.audio
        ? "draft"
        : !ready
          ? "stale"
          : segment.audio.origin === "local-demo"
            ? "sample"
            : "current";
      badge.textContent = {
        draft: "Draft",
        stale: "Stale",
        sample: "Sample voice",
        current: "Current",
      }[state];
      badge.className = `status-tag tag ${state}`;
      card.dataset.state = state;
      card.querySelector<HTMLElement>(".segment-time")!.textContent =
        start === undefined ? "Scene removed" : clock(start);
      const words = values.text.trim().split(/\s+/).filter(Boolean).length;
      card.querySelector<HTMLElement>(".segment-words")!.textContent =
        `${words} words`;
      card.querySelector<HTMLElement>(".stale-reason")!.hidden =
        state !== "stale";
      card.querySelector<HTMLButtonElement>(".segment-generate")!.className =
        `segment-generate button small ${state === "current" || state === "sample" ? "secondary" : "primary"}`;
      const status = card.querySelector<HTMLElement>(".segment-status")!;
      status.textContent = draft?.error
        ? "Needs review"
        : draft?.pending
          ? "Saving…"
          : draft
            ? "Unsaved"
            : "";
      status.classList.toggle("conflict", !!draft?.error);
      card.classList.toggle("dirty", !!draft);
      card.classList.toggle("active", segment.id === this.active);
      card.querySelector<HTMLElement>(".segment-save")!.hidden = !draft;
      const conflict = card.querySelector<HTMLElement>(".segment-conflict")!;
      conflict.hidden = !draft?.error;
      conflict.querySelector("p")!.textContent = draft?.error ?? "";
      const canvas = card.querySelector<HTMLCanvasElement>("canvas")!;
      canvas.hidden = !segment.audio || !ready;
      if (
        segment.audio &&
        ready &&
        canvas.dataset.path !== segment.audio.path
      ) {
        canvas.dataset.path = segment.audio.path;
        void this.drawWaveform(canvas, segment.audio.path);
      }
      // Append existing nodes to reflect reordered segments without rebuilding focused editors.
      if (
        this.root.children[bundle.narration.segments.indexOf(segment)] !==
          card &&
        !card.contains(document.activeElement)
      )
        this.root.append(card);
    }
    for (const [id, card] of this.cards)
      if (!bundle.narration.segments.some((s) => s.id === id)) {
        if (this.drafts.has(id)) {
          const draft = this.drafts.get(id)!;
          draft.error =
            "This segment was removed elsewhere. Copy your unsaved text before discarding it.";
          card.querySelector<HTMLElement>(".segment-conflict")!.hidden = false;
          card.querySelector(".segment-conflict p")!.textContent = draft.error;
        } else {
          card.remove();
          this.cards.delete(id);
        }
      }
    document.querySelector("#transcript-meta")!.textContent =
      `${bundle.edits.clips.length} scenes · ${bundle.narration.segments.reduce((n, s) => n + s.text.trim().split(/\s+/).filter(Boolean).length, 0)} words · ${(bundle.edits.clips.reduce((n, c) => n + clipDuration(c), 0) / 1000).toFixed(1)} s`;
    this.hooks.dirty(this.drafts.size);
  }
  private patch(id: string, patch: ScriptPatch): void {
    let draft = this.drafts.get(id);
    if (!draft) {
      draft = {
        base: structuredClone(
          this.bundle!.narration.segments.find((s) => s.id === id)!,
        ),
        patch: {},
        version: 0,
      };
      this.drafts.set(id, draft);
    }
    Object.assign(draft.patch, patch);
    draft.version++;
    draft.error = undefined;
    if (draft.timer) clearTimeout(draft.timer);
    draft.timer = setTimeout(() => void this.save(id).catch(() => {}), 900);
    this.render(this.bundle!);
  }
  async save(id: string, force = false): Promise<void> {
    const draft = this.drafts.get(id);
    if (!draft) return;
    if (draft.timer) clearTimeout(draft.timer);
    if (draft.pending) {
      await draft.pending;
      if (this.drafts.has(id)) return this.save(id, force);
      return;
    }
    const version = draft.version;
    const patch = structuredClone(draft.patch);
    const pending = this.hooks
      .save(id, patch, draft.base, force)
      .then((saved) => {
        if (draft.version === version) this.drafts.delete(id);
        else {
          draft.base = structuredClone(saved);
          for (const key of Object.keys(patch) as (keyof ScriptPatch)[])
            if (draft.patch[key] === patch[key]) delete draft.patch[key];
        }
      })
      .catch((error) => {
        draft.error = error instanceof Error ? error.message : String(error);
        throw error;
      })
      .finally(() => {
        draft.pending = undefined;
        this.render(this.bundle!);
      });
    draft.pending = pending;
    this.render(this.bundle!);
    await pending;
  }
  async flushAll(): Promise<void> {
    for (const id of this.drafts.keys()) await this.save(id);
  }
  private createCard(id: string): HTMLElement {
    const card = el("div", "narration-card");
    card.dataset.id = id;
    const top = el("div", "card-top"),
      number = el("span", "segment-number"),
      title = el("input", "narration-title"),
      badge = el("span", "status-tag tag");
    title.setAttribute("aria-label", "Title");
    title.oninput = () => this.patch(id, { title: title.value });
    top.append(number, title, badge);
    const textarea = el("textarea", "script-text");
    textarea.rows = 3;
    textarea.setAttribute("aria-label", "Script");
    textarea.oninput = () => this.patch(id, { text: textarea.value });
    const canvas = el("canvas", "waveform");
    canvas.width = 640;
    canvas.height = 56;
    canvas.hidden = true;
    const info = el("div", "segment-info sr-only");
    info.append(el("span", "segment-time"), el("span", "segment-words"));
    const reason = el(
      "p",
      "stale-reason hint",
      "The text or voice changed after this audio was made.",
    );
    const tools = el("div", "segment-tools"),
      generate = el(
        "button",
        "segment-generate button small primary",
        "Regenerate",
      ),
      spacer = el("span", "spacer"),
      status = el("span", "segment-status"),
      save = el("button", "segment-save quiet small-text", "Save"),
      remove = el("button", "quiet segment-remove", "×");
    remove.setAttribute("aria-label", "Remove segment");
    remove.title = "Remove segment";
    generate.onclick = () =>
      void this.save(id)
        .then(() => this.hooks.regenerate([id]))
        .catch(this.hooks.error);
    save.onclick = () => void this.save(id).catch(this.hooks.error);
    remove.onclick = () => {
      // Unsaved words are lost with the segment; make that a conscious choice.
      const draft = this.drafts.get(id);
      if (
        draft?.patch.text !== undefined &&
        draft.patch.text !== draft.base.text &&
        !confirm("This segment has unsaved text. Remove it anyway?")
      )
        return;
      void this.hooks
        .remove(id)
        .then(() => {
          this.drafts.delete(id);
          this.render(this.bundle!);
        })
        .catch(this.hooks.error);
    };
    tools.append(generate, spacer, status, save, remove);
    const conflict = el("div", "segment-conflict");
    conflict.hidden = true;
    conflict.append(el("p"));
    const row = el("div", "button-row");
    const keep = el("button", "button primary small", "Keep my changes"),
      discard = el("button", "button secondary small", "Use file version");
    keep.onclick = () => void this.save(id, true).catch(this.hooks.error);
    discard.onclick = () => {
      const d = this.drafts.get(id);
      if (d?.timer) clearTimeout(d.timer);
      this.drafts.delete(id);
      this.render(this.bundle!);
    };
    row.append(keep, discard);
    conflict.append(row);
    card.append(top, textarea, canvas, reason, info, tools, conflict);
    return card;
  }
  /** Decoded first channel, shared with the timeline voice lane. */
  waveform(audioPath: string): Promise<Float32Array> {
    let decoded = this.waveforms.get(audioPath);
    if (!decoded) {
      decoded = fetch(projectUrl(`/files/${audioPath}`))
        .then((res) => {
          if (!res.ok) throw new Error("Missing audio");
          return res.arrayBuffer();
        })
        .then(async (bytes) => {
          this.audioContext ??= new AudioContext();
          return (
            await this.audioContext.decodeAudioData(bytes)
          ).getChannelData(0);
        });
      decoded.catch(() => this.waveforms.delete(audioPath));
      this.waveforms.set(audioPath, decoded);
    }
    return decoded;
  }
  private async drawWaveform(
    canvas: HTMLCanvasElement,
    audioPath: string,
  ): Promise<void> {
    try {
      const data = await this.waveform(audioPath);
      if (canvas.dataset.path !== audioPath) return;
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#3d3d3d";
      const bars = Math.floor(canvas.width / 8),
        step = Math.max(1, Math.floor(data.length / bars));
      for (let i = 0; i < bars; i++) {
        let peak = 0;
        for (
          let j = i * step;
          j < Math.min(data.length, (i + 1) * step);
          j += 3
        )
          peak = Math.max(peak, Math.abs(data[j]!));
        const height = Math.max(
          4,
          Math.min(canvas.height - 8, peak * canvas.height * 2.2),
        );
        ctx.beginPath();
        ctx.roundRect(i * 8 + 2, (canvas.height - height) / 2, 4, height, 2);
        ctx.fill();
      }
    } catch {
      canvas.hidden = true;
    }
  }
}
