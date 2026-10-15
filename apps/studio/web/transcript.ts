import { projectUrl } from "./transport.js";
import {
  audioIsCurrent,
  narrationStart,
  type ReplayBundle,
  type NarrationSegment,
} from "../model.js";

export type ScriptPatch = Partial<
  Pick<
    NarrationSegment,
    | "text"
    | "title"
    | "clipId"
    | "offsetMs"
    | "voice"
    | "instructions"
    | "language"
  >
>;
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
  preview: (ms: number) => void;
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
      const badge = card.querySelector<HTMLElement>(".status-tag")!;
      badge.textContent = !segment.audio
        ? "DRAFT"
        : !ready
          ? "AUDIO STALE"
          : segment.audio.origin === "local-demo"
            ? "SAMPLE VOICE"
            : "READY";
      badge.classList.toggle("stale", !!segment.audio && !ready);
      badge.classList.toggle("ready", !!segment.audio && ready);
      card.querySelector<HTMLElement>(".segment-time")!.textContent =
        start === undefined ? "Scene removed" : clock(start);
      card.querySelector<HTMLElement>(".segment-words")!.textContent =
        `${values.text.trim().split(/\s+/).filter(Boolean).length} words${segment.audio && ready ? ` · ${(segment.audio.durationMs / 1000).toFixed(1)}s audio` : ""}`;
      const status = card.querySelector<HTMLElement>(".segment-status")!;
      status.textContent = draft?.error
        ? "Needs review"
        : draft?.pending
          ? "Saving…"
          : draft
            ? "Unsaved"
            : "Saved";
      status.classList.toggle("conflict", !!draft?.error);
      card.classList.toggle("dirty", !!draft);
      const conflict = card.querySelector<HTMLElement>(".segment-conflict")!;
      conflict.hidden = !draft?.error;
      conflict.querySelector("p")!.textContent = draft?.error ?? "";
      const select = card.querySelector<HTMLSelectElement>(".segment-clip")!;
      if (document.activeElement !== select) {
        select.replaceChildren(
          ...bundle.edits.clips.map((clip) => {
            const option = el("option");
            option.value = clip.id;
            option.textContent = clip.id;
            return option;
          }),
        );
        select.value = values.clipId;
      }
      const offset = card.querySelector<HTMLInputElement>(".segment-offset")!;
      if (document.activeElement !== offset)
        offset.value = String(values.offsetMs / 1000);
      const voice = card.querySelector<HTMLInputElement>(".segment-voice")!;
      if (document.activeElement !== voice) voice.value = values.voice ?? "";
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
      card.querySelector<HTMLButtonElement>(".segment-preview")!.disabled =
        start === undefined;
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
      `${bundle.narration.segments.length} segments · ${bundle.narration.segments.reduce((n, s) => n + s.text.trim().split(/\s+/).filter(Boolean).length, 0)} words`;
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
      title = el("input", "narration-title"),
      badge = el("span", "status-tag");
    title.setAttribute("aria-label", `Title for ${id}`);
    title.oninput = () => this.patch(id, { title: title.value });
    top.append(title, badge);
    const textarea = el("textarea", "script-text");
    textarea.rows = 4;
    textarea.setAttribute("aria-label", `Script for ${id}`);
    textarea.oninput = () => this.patch(id, { text: textarea.value });
    const canvas = el("canvas", "waveform");
    canvas.width = 560;
    canvas.height = 46;
    canvas.hidden = true;
    const info = el("div", "segment-info");
    info.append(el("span", "segment-time"), el("span", "segment-words"));
    const tools = el("div", "segment-tools"),
      preview = el("button", "segment-preview", "▷ Preview"),
      generate = el("button", "segment-generate", "↻ Audio"),
      save = el("button", "segment-save quiet", "Save"),
      remove = el("button", "quiet", "×");
    remove.setAttribute("aria-label", `Remove ${id}`);
    preview.onclick = () => {
      const segment = this.bundle!.narration.segments.find((s) => s.id === id);
      const time = segment && narrationStart(this.bundle!.edits, segment);
      if (time !== undefined) this.hooks.preview(time);
    };
    generate.onclick = () =>
      void this.save(id)
        .then(() => this.hooks.regenerate([id]))
        .catch(this.hooks.error);
    save.onclick = () => void this.save(id).catch(this.hooks.error);
    remove.onclick = () =>
      void this.hooks
        .remove(id)
        .then(() => {
          this.drafts.delete(id);
          this.render(this.bundle!);
        })
        .catch(this.hooks.error);
    tools.append(preview, generate, save, remove);
    const status = el("span", "segment-status", "Saved");
    const details = el("details", "segment-settings");
    details.append(el("summary", undefined, "Timing & voice override"));
    const form = el("div", "voice-form");
    const clipLabel = el("label", undefined, "Scene"),
      clips = el("select", "segment-clip");
    clips.onchange = () => this.patch(id, { clipId: clips.value });
    clipLabel.append(clips);
    const offsetLabel = el("label", undefined, "Offset (seconds)"),
      offset = el("input", "segment-offset");
    offset.type = "number";
    offset.min = "0";
    offset.step = "0.1";
    offset.onchange = () =>
      this.patch(id, { offsetMs: Number(offset.value) * 1000 });
    offsetLabel.append(offset);
    const voiceLabel = el("label", "full", "Voice override"),
      voice = el("input", "segment-voice");
    voice.placeholder = "Use project voice";
    voice.onchange = () =>
      this.patch(id, { voice: voice.value.trim() || undefined });
    voiceLabel.append(voice);
    form.append(clipLabel, offsetLabel, voiceLabel);
    details.append(form);
    const conflict = el("div", "segment-conflict");
    conflict.hidden = true;
    conflict.append(el("p"));
    const keep = el("button", undefined, "Keep my changes"),
      discard = el("button", "quiet", "Use file version");
    keep.onclick = () => void this.save(id, true).catch(this.hooks.error);
    discard.onclick = () => {
      const d = this.drafts.get(id);
      if (d?.timer) clearTimeout(d.timer);
      this.drafts.delete(id);
      this.render(this.bundle!);
    };
    conflict.append(keep, discard);
    card.append(top, textarea, canvas, info, tools, status, details, conflict);
    return card;
  }
  private async drawWaveform(
    canvas: HTMLCanvasElement,
    audioPath: string,
  ): Promise<void> {
    try {
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
        this.waveforms.set(audioPath, decoded);
      }
      const data = await decoded;
      if (canvas.dataset.path !== audioPath) return;
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#7ba497";
      const bars = 110,
        step = Math.max(1, Math.floor(data.length / bars));
      for (let i = 0; i < bars; i++) {
        let peak = 0;
        for (
          let j = i * step;
          j < Math.min(data.length, (i + 1) * step);
          j += 3
        )
          peak = Math.max(peak, Math.abs(data[j]!));
        const height = Math.max(2, Math.min(42, peak * 110));
        ctx.fillRect(i * 5, (46 - height) / 2, 2, height);
      }
    } catch {
      canvas.hidden = true;
    }
  }
}
