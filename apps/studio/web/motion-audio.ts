import {
  musicGain,
  totalDuration,
  voiceSpans,
  type ReplayBundle,
} from "../model.js";
import type { SceneCue } from "./scenes.js";
import { projectUrl } from "./transport.js";

/** Music beds and sound effects in the preview, mixed like the export:
 * the same fades and ducking under narration, effects fired on time. */
export class MotionAudio {
  private beds = new Map<string, HTMLAudioElement>();
  private samples = new Map<string, HTMLAudioElement>();
  private lastMs = -1;

  pause(): void {
    for (const player of this.beds.values()) if (!player.paused) player.pause();
    this.lastMs = -1;
  }

  sync(
    bundle: ReplayBundle,
    positionMs: number,
    playing: boolean,
    seek: boolean,
    sceneCues: SceneCue[],
  ): void {
    const total = totalDuration(bundle.edits),
      voice = voiceSpans(bundle),
      music = bundle.edits.audio?.music ?? [];
    // A rewritten file keeps its path, so the asset stamp is part of the key.
    const stamp = bundle.assetsRevision ?? "";
    const wanted = new Set(music.map((m) => `${m.id}:${m.src}#${stamp}`));
    for (const [key, player] of this.beds)
      if (!wanted.has(key)) {
        player.pause();
        this.beds.delete(key);
      }
    for (const bed of music) {
      const key = `${bed.id}:${bed.src}#${stamp}`;
      let player = this.beds.get(key);
      if (!player) {
        player = new Audio(this.url(bundle, bed.src));
        player.preload = "auto";
        this.beds.set(key, player);
      }
      const gain = musicGain(bed, positionMs, total, voice);
      const at = (positionMs - bed.startMs + bed.offsetMs) / 1000;
      const inside =
        positionMs >= bed.startMs && at < (player.duration || Infinity);
      player.volume = Math.max(0, Math.min(1, gain));
      if (!playing || !inside) {
        if (!player.paused) player.pause();
        continue;
      }
      if (seek || Math.abs(player.currentTime - at) > 0.25)
        player.currentTime = Math.max(0, at);
      if (player.paused) void player.play().catch(() => {});
    }
    // A fresh play or seek starts at the position itself, so a cue at 0 ms
    // sounds when playing from the start; afterwards cues fire as time passes.
    const restart = seek || this.lastMs < 0;
    if (playing && (restart || positionMs > this.lastMs)) {
      const cues = [
        ...(bundle.edits.audio?.sfx ?? []).map((s) => ({
          src: s.src,
          atMs: s.atMs,
          volume: s.volume,
        })),
        ...sceneCues,
      ];
      for (const cue of cues)
        if (
          restart
            ? Math.abs(cue.atMs - positionMs) <= 0.5
            : cue.atMs > this.lastMs &&
              cue.atMs <= positionMs &&
              positionMs - cue.atMs < 250
        )
          this.fire(bundle, cue.src, cue.volume);
    }
    this.lastMs = playing ? positionMs : -1;
  }

  private fire(bundle: ReplayBundle, src: string, volume: number): void {
    const url = this.url(bundle, src);
    let sample = this.samples.get(url);
    if (!sample) {
      sample = new Audio(url);
      sample.preload = "auto";
      this.samples.set(url, sample);
    }
    const voice = sample.cloneNode() as HTMLAudioElement;
    voice.volume = Math.max(0, Math.min(1, volume));
    void voice.play().catch(() => {});
  }

  private url(bundle: ReplayBundle, src: string): string {
    return projectUrl(`/files/${src}?v=${bundle.assetsRevision ?? ""}`);
  }
}
