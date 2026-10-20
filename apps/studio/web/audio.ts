import { audioIsCurrent, narrationStart, type ReplayBundle } from "../model.js";
import { projectUrl } from "./transport.js";

type Track = {
  player: HTMLAudioElement;
  url: string;
  active: boolean;
  aligned: boolean;
  alignedAt: number;
  pending: boolean;
  failed: boolean;
  startMs: number;
};

/** Keep decoded speech running between explicit timeline seeks. */
export class NarrationPlayback {
  private tracks = new Map<string, Track>();
  constructor(
    private error: (error: Error) => void,
    private create: (url: string) => HTMLAudioElement = (url) => new Audio(url),
    private now: () => number = () => performance.now(),
  ) {}

  pause(): void {
    for (const { player } of this.tracks.values())
      if (!player.paused) player.pause();
  }

  get buffering(): boolean {
    for (const track of this.tracks.values())
      if (
        track.active &&
        !track.failed &&
        !track.player.ended &&
        (!track.aligned ||
          track.pending ||
          track.player.seeking ||
          track.player.readyState < 3)
      )
        return true;
    return false;
  }

  sync(
    bundle: ReplayBundle,
    positionMs: number,
    playing: boolean,
    seek = false,
  ): void {
    const retained = new Set<string>();
    for (const segment of bundle.narration.segments) {
      const start = narrationStart(bundle.edits, segment);
      if (
        !segment.audio ||
        !audioIsCurrent(bundle.project, segment) ||
        start === undefined
      )
        continue;
      retained.add(segment.id);
      const url = new URL(
        projectUrl(`/files/${segment.audio.path}`),
        location.href,
      ).href;
      let track = this.tracks.get(segment.id);
      if (!track || track.url !== url) {
        if (track) this.release(track);
        const player = this.create(url);
        player.preload = "auto";
        track = {
          player,
          url,
          active: false,
          aligned: false,
          alignedAt: 0,
          pending: false,
          failed: false,
          startMs: start,
        };
        this.tracks.set(segment.id, track);
      }
      const { player } = track;
      const elapsedMs = positionMs - start;
      if (elapsedMs < 0 || elapsedMs >= segment.audio.durationMs) {
        if (!player.paused) player.pause();
        track.active = false;
        track.aligned = false;
        continue;
      }
      if (seek || !track.active || track.startMs !== start) {
        track.aligned = false;
        track.failed = false;
        track.startMs = start;
      }
      track.active = true;
      // Seek once after metadata is available. Repeating currentTime writes
      // while a seek is pending repeatedly flushes the decoder.
      if (!track.aligned && player.readyState >= (playing ? 3 : 1)) {
        player.playbackRate = 1;
        if (Math.abs(player.currentTime * 1000 - elapsedMs) > 50)
          player.currentTime = elapsedMs / 1000;
        track.aligned = true;
        track.alignedAt = this.now();
      }
      if (!playing) {
        if (!player.paused) player.pause();
        continue;
      }
      if (track.aligned && !player.seeking && player.readyState >= 3) {
        const driftMs = elapsedMs - player.currentTime * 1000;
        // Small drift is normal (startup latency, timer precision, decoder
        // latency). Correct it gently instead of chopping speech into seeks.
        const rate =
          Math.abs(driftMs) < 100
            ? 1
            : Math.max(0.96, Math.min(1.04, 1 + driftMs / 5000));
        if (Math.abs(player.playbackRate - rate) > 0.001)
          player.playbackRate = rate;
        // Recover from a long stall, with a grace period after each seek.
        if (Math.abs(driftMs) > 1500 && this.now() - track.alignedAt > 1500) {
          player.currentTime = elapsedMs / 1000;
          track.alignedAt = this.now();
        }
      }
      if (player.paused && !player.ended && !track.pending && !track.failed) {
        track.pending = true;
        const current = track;
        void player.play().then(
          () => {
            current.pending = false;
          },
          (error: Error) => {
            current.pending = false;
            if (error.name === "AbortError") return;
            current.failed = true;
            this.error(
              new Error(
                "Audio could not play. Check the audio file and click Play again.",
              ),
            );
          },
        );
      }
    }
    // Removed/stale narration must not continue playing from an old player.
    for (const [id, track] of this.tracks)
      if (!retained.has(id)) {
        this.release(track);
        this.tracks.delete(id);
      }
  }

  private release({ player }: Track): void {
    player.pause();
    player.removeAttribute("src");
    player.load();
  }
}
