import {
  audioIsCurrent,
  clipDuration,
  narrationStart,
  totalDuration,
  type ReplayBundle,
} from "../model.js";
import type { AgentActivity } from "../contract.js";

export type AgentMark = { timeMs: number; title: string };
type Hooks = {
  bundle: () => ReplayBundle;
  seek: (ms: number) => void;
  openThread: (threadId: string) => void;
  /** Thumbnail URL, or undefined for none (exports render no thumbnails). */
  frameUrl: (ms: number) => string | undefined;
  waveform: (audioPath: string) => Promise<Float32Array>;
  sceneTitle: (index: number) => string;
  sceneCues: () => { atMs: number; src: string }[];
};
const $ = <T extends HTMLElement = HTMLElement>(s: string) =>
  document.querySelector<T>(s)!;
const el = <K extends keyof HTMLElementTagNameMap>(
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
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const WRITE_TOOLS = new Set([
  "apply_element_edit",
  "animate_element",
  "update_timeline_item",
  "remove_timeline_item",
  "update_narration",
  "regenerate_narration",
]);

/** The edited timeline: ruler, scenes, camera, voice and notes lanes. Lanes are
 * positioned in percent of the output duration so they follow resizes. Camera
 * and Notes only show when they have something in them. */
export class Timeline {
  private lanes = $("#lanes");
  private dragging = false;
  private thumbs = new Map<string, string>();
  private signature = "";
  constructor(private hooks: Hooks) {
    this.lanes.addEventListener("pointerdown", (event) => {
      if ((event.target as HTMLElement).closest(".note-mark")) return;
      this.dragging = true;
      this.lanes.setPointerCapture(event.pointerId);
      this.seekTo(event);
    });
    this.lanes.addEventListener("pointermove", (event) => {
      if (this.dragging) this.seekTo(event);
    });
    const stop = () => (this.dragging = false);
    this.lanes.addEventListener("pointerup", stop);
    this.lanes.addEventListener("pointercancel", stop);
    new ResizeObserver(() => this.renderRuler()).observe(this.lanes);
  }
  private seekTo(event: PointerEvent) {
    const rect = this.lanes.getBoundingClientRect();
    const ratio = Math.min(
      1,
      Math.max(0, (event.clientX - rect.left) / rect.width),
    );
    this.hooks.seek(ratio * totalDuration(this.hooks.bundle().edits));
  }
  private pct(ms: number) {
    return `${(ms / totalDuration(this.hooks.bundle().edits)) * 100}%`;
  }
  render(marks: AgentMark[] = []) {
    const bundle = this.hooks.bundle();
    const duration = totalDuration(bundle.edits);
    $("#duration-label").textContent = `/ ${clockMs(duration)}`;
    this.renderRuler();
    // Scenes
    const scenes = $("#clip-track");
    scenes.replaceChildren();
    let offset = 0;
    for (const [i, clip] of bundle.edits.clips.entries()) {
      const start = offset,
        length = clipDuration(clip);
      offset += length;
      const notes = bundle.comments.threads.filter(
        (t) => t.status === "open" && t.timeMs >= start && t.timeMs < offset,
      ).length;
      const block = el(
        "button",
        clip.kind === "scene" ? "clip-block scene" : "clip-block",
      );
      block.dataset.start = String(start);
      block.dataset.end = String(offset);
      block.dataset.clip = clip.id;
      block.style.left = this.pct(start);
      block.style.width = `calc(${this.pct(length)} - 2px)`;
      const title = this.hooks.sceneTitle(i);
      block.title = `${title} · ${clockMs(start)}`;
      const thumb = el("span", "clip-thumb");
      const at = Math.round(start + Math.min(1500, length / 2));
      const key = `${bundle.revision}:${at}`;
      if (this.thumbs.get(clip.id) !== key) this.thumbs.set(clip.id, key);
      const url = this.hooks.frameUrl(at);
      if (url) this.loadThumb(thumb, url);
      const text = el("span", "clip-text");
      text.append(
        el("strong", undefined, title),
        el(
          "span",
          undefined,
          `${seconds(length)}${clip.kind !== "scene" && clip.rate !== 1 ? ` · ${clip.rate}×` : ""}${notes ? ` · ${notes} note${notes === 1 ? "" : "s"}` : ""}`,
        ),
      );
      block.append(thumb, text);
      scenes.append(block);
    }
    // Camera and effects
    const effects = $("#effect-track");
    effects.replaceChildren();
    // Overlapping effects stack in rows so none hides another.
    const rows: number[] = [];
    const all = [
      ...bundle.edits.camera.map((e) => ["zoom", e] as const),
      ...bundle.edits.highlights.map((e) => ["highlight", e] as const),
      ...(bundle.edits.animations ?? []).map((e) => ["animate", e] as const),
      ...(bundle.edits.overlays ?? []).map((e) => ["overlay", e] as const),
    ].sort((a, b) => a[1].startMs - b[1].startMs);
    for (const [kind, effect] of all) {
      let row = rows.findIndex((end) => end <= effect.startMs);
      if (row < 0) row = rows.push(0) - 1;
      rows[row] = effect.endMs;
      const block = el("button", "effect-block");
      block.style.left = this.pct(effect.startMs);
      block.style.width = `calc(${this.pct(effect.endMs - effect.startMs)} - 2px)`;
      block.style.top = `${row * 26}px`;
      block.style.height = "22px";
      block.append(
        icon(kind === "zoom" ? "zoom" : "highlight"),
        el(
          "span",
          undefined,
          kind === "zoom"
            ? `Zoom ${(effect as { scale: number }).scale}×`
            : kind === "highlight"
              ? "Highlight"
              : kind === "overlay"
                ? ((effect as { title?: string }).title ?? "Overlay")
                : "Animation",
        ),
      );
      block.title = `${block.textContent} · ${clockMs(effect.startMs)}–${clockMs(effect.endMs)}`;
      effects.append(block);
    }
    $("#tracks").style.setProperty(
      "--camera-h",
      `${Math.max(1, rows.length) * 26 - 4}px`,
    );
    effects.hidden = $("#camera-label").hidden = !all.length;
    // Voice
    const voice = $("#voice-track");
    voice.replaceChildren();
    const starts = bundle.narration.segments
      .map((s) => (s.text.trim() ? narrationStart(bundle.edits, s) : undefined))
      .filter((t): t is number => t !== undefined)
      .sort((a, b) => a - b);
    for (const segment of bundle.narration.segments) {
      const start = narrationStart(bundle.edits, segment);
      if (start === undefined || !segment.text.trim()) continue;
      const current = audioIsCurrent(bundle.project, segment);
      // Long speech is shown up to the next segment.
      const next = starts.find((t) => t > start) ?? duration;
      const length = Math.max(
        200,
        Math.min(
          next - start,
          segment.audio?.durationMs ?? estimateSpeechMs(segment.text),
        ),
      );
      const block = el(
        "div",
        `voice-block ${!segment.audio ? "draft" : current ? "current" : "stale"}`,
      );
      block.dataset.segment = segment.id;
      block.style.left = this.pct(start);
      block.style.width = `calc(${this.pct(length)} - 2px)`;
      block.title = segment.text;
      if (!segment.audio) block.textContent = "Draft · no audio yet";
      else {
        const canvas = el("canvas");
        block.append(canvas);
        void this.drawWave(canvas, segment.audio.path, !current);
        if (!current) block.append(el("span", "tag stale", "Stale"));
      }
      voice.append(block);
    }
    // Music and sound effects
    const sound = $("#sound-track");
    sound.replaceChildren();
    for (const bed of bundle.edits.audio?.music ?? []) {
      const end = Math.min(duration, bed.endMs ?? duration);
      if (end <= bed.startMs) continue;
      const block = el("div", "music-block");
      block.style.left = this.pct(bed.startMs);
      block.style.width = `calc(${this.pct(end - bed.startMs)} - 2px)`;
      block.title = `${bed.src} · volume ${bed.volume}`;
      block.append(
        el(
          "span",
          undefined,
          bed.src
            .split("/")
            .pop()!
            .replace(/\.\w+$/, ""),
        ),
      );
      sound.append(block);
    }
    const cues = [
      ...(bundle.edits.audio?.sfx ?? []).map((s) => ({ ...s, scene: false })),
      ...this.hooks.sceneCues().map((s) => ({ ...s, scene: true })),
    ];
    for (const cue of cues) {
      const mark = el("span", cue.scene ? "sfx-mark scene-cue" : "sfx-mark");
      mark.style.left = this.pct(Math.min(duration, cue.atMs));
      mark.title = `${cue.src.split("/").pop()} · ${clockMs(cue.atMs)}`;
      sound.append(mark);
    }
    sound.hidden = $("#sound-label").hidden =
      !(bundle.edits.audio?.music ?? []).length && !cues.length;
    // Notes and agent changes
    const notes = $("#notes-track");
    notes.replaceChildren();
    for (const [i, thread] of bundle.comments.threads.entries()) {
      const pin = el(
        "button",
        `note-mark pin${thread.status === "resolved" ? " resolved" : ""}`,
        thread.status === "resolved" ? "" : String(i + 1),
      );
      pin.style.left = this.pct(Math.min(duration, thread.timeMs));
      pin.title = thread.body;
      pin.setAttribute(
        "aria-label",
        `Note ${i + 1}: ${thread.body.slice(0, 80)}`,
      );
      pin.onclick = () => this.hooks.openThread(thread.id);
      notes.append(pin);
    }
    for (const mark of marks) {
      const diamond = el("span", "agent-mark");
      diamond.style.left = this.pct(Math.min(duration, mark.timeMs));
      diamond.title = mark.title;
      notes.append(diamond);
    }
    notes.hidden = $("#notes-label").hidden =
      !bundle.comments.threads.length && !marks.length;
    this.signature = bundle.revision;
  }
  private renderRuler() {
    if (!this.signature && !this.hooks.bundle) return;
    const bundle = this.hooks.bundle();
    if (!bundle) return;
    const duration = totalDuration(bundle.edits);
    const width = this.lanes.clientWidth || 800;
    const step =
      [1, 2, 5, 10, 15, 30, 60, 120, 300].find(
        (s) => (s * 1000 * width) / duration >= 64,
      ) ?? 600;
    const ruler = $("#ruler");
    ruler.replaceChildren();
    for (let s = 0; s * 1000 <= duration; s += step) {
      const tick = el("span", undefined, `${s}s`);
      tick.style.left = this.pct(s * 1000);
      if (s * 1000 > duration - (duration * 30) / width) {
        tick.style.left = "auto";
        tick.style.right = "0";
      }
      ruler.append(tick);
    }
  }
  /** Per-frame state: playhead, active scene, agent stripes. */
  update(
    position: number,
    activity: AgentActivity | undefined,
    sceneOf: (a: AgentActivity) => string | undefined,
  ) {
    const bundle = this.hooks.bundle();
    $("#playhead").style.left = this.pct(position);
    const working =
      activity &&
      activity.status === "running" &&
      WRITE_TOOLS.has(activity.tool)
        ? sceneOf(activity)
        : undefined;
    for (const block of document.querySelectorAll<HTMLElement>(".clip-block")) {
      block.classList.toggle(
        "active",
        position >= Number(block.dataset.start) &&
          (position < Number(block.dataset.end) ||
            (Number(block.dataset.end) >= totalDuration(bundle.edits) &&
              position >= Number(block.dataset.end))),
      );
      block.classList.toggle("agent-working", block.dataset.clip === working);
    }
    for (const block of document.querySelectorAll<HTMLElement>(".voice-block"))
      block.classList.toggle(
        "agent-working",
        !!activity?.segmentId &&
          activity.status === "running" &&
          block.dataset.segment === activity.segmentId,
      );
  }
  // Thumbnails render slowly; few at a time so they never take the
  // browser's connections from scene pages, audio or status polls.
  private thumbQueue: (() => Promise<void>)[] = [];
  private thumbsLoading = 0;
  private loadThumb(thumb: HTMLElement, url: string) {
    const load = async () => {
      const image = new Image();
      image.src = url;
      try {
        await image.decode();
        if (thumb.isConnected) thumb.style.backgroundImage = `url("${url}")`;
      } catch {
        /* No thumbnail; the block still shows its title. */
      }
    };
    this.thumbQueue.push(load);
    this.pumpThumbs();
  }
  private pumpThumbs() {
    while (this.thumbsLoading < 2 && this.thumbQueue.length) {
      const next = this.thumbQueue.shift()!;
      this.thumbsLoading++;
      void next().finally(() => {
        this.thumbsLoading--;
        this.pumpThumbs();
      });
    }
  }
  private async drawWave(
    canvas: HTMLCanvasElement,
    audioPath: string,
    stale: boolean,
  ) {
    try {
      const data = await this.hooks.waveform(audioPath);
      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth || 120,
        height = canvas.clientHeight || 30;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      const ctx = canvas.getContext("2d")!;
      ctx.scale(ratio, ratio);
      ctx.fillStyle = stale ? "#d9412b" : "#3d3d3d";
      const bars = Math.max(4, Math.floor((width - 8) / 4));
      const step = Math.max(1, Math.floor(data.length / bars));
      for (let i = 0; i < bars; i++) {
        let peak = 0;
        for (
          let j = i * step;
          j < Math.min(data.length, (i + 1) * step);
          j += 4
        )
          peak = Math.max(peak, Math.abs(data[j]!));
        const h = Math.max(2, Math.min(height - 8, peak * (height - 8) * 2.4));
        ctx.beginPath();
        ctx.roundRect(4 + i * 4, (height - h) / 2, 2, h, 1);
        ctx.fill();
      }
    } catch {
      canvas.remove();
    }
  }
}
export function estimateSpeechMs(text: string) {
  // Same estimate the capture uses for draft timing.
  return Math.max(1400, text.trim().split(/\s+/).filter(Boolean).length * 360);
}
export function clockMs(ms: number) {
  const total = Math.max(0, ms) / 1000;
  return `${Math.floor(total / 60)
    .toString()
    .padStart(2, "0")}:${(total % 60).toFixed(1).padStart(4, "0")}`;
}
