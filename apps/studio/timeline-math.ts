// Pure timeline helpers shared by the server and the browser client. No
// zod here: the client bundles import this module, not the schemas.
import type {
  Animation,
  Clip,
  NarrationSegment,
  RecordingClip,
  ReplayAudio,
  ReplayBundle,
  ReplayEdits,
  ReplayProject,
  SceneClip,
} from "./model.js";

export function isScene(clip: Clip): clip is SceneClip {
  return clip.kind === "scene";
}

export function sampleAnimation(
  effect: Animation,
  outputMs: number,
):
  | { opacity: number; x: number; y: number; scale: number; rotate: number }
  | undefined {
  if (
    outputMs < effect.startMs ||
    (outputMs >= effect.endMs && effect.fill !== "forwards")
  )
    return undefined;
  let t = Math.max(
    0,
    Math.min(1, (outputMs - effect.startMs) / (effect.endMs - effect.startMs)),
  );
  if (effect.easing === "ease-in-out") t = t * t * (3 - 2 * t);
  const result = { opacity: 1, x: 0, y: 0, scale: 1, rotate: 0 };
  for (const key of Object.keys(result) as (keyof typeof result)[])
    result[key] =
      (effect.from[key] ?? result[key]) +
      ((effect.to[key] ?? result[key]) - (effect.from[key] ?? result[key])) * t;
  return result;
}

export function clipDuration(clip: Clip): number {
  if (isScene(clip)) return clip.durationMs;
  return (clip.sourceEndMs - clip.sourceStartMs) / clip.rate + clip.holdMs;
}

export function totalDuration(edits: ReplayEdits): number {
  return edits.clips.reduce((sum, clip) => sum + clipDuration(clip), 0);
}

export function outputToSource(edits: ReplayEdits, outputMs: number): number {
  let remaining = Math.max(0, outputMs);
  // Scenes hold the recording where it stands (or where it will start).
  let held =
    edits.clips.find((c): c is RecordingClip => !isScene(c))?.sourceStartMs ??
    0;
  for (const clip of edits.clips) {
    const duration = clipDuration(clip);
    if (isScene(clip)) {
      if (remaining < duration) return held;
    } else if (remaining < duration)
      return Math.min(
        clip.sourceEndMs,
        clip.sourceStartMs + remaining * clip.rate,
      );
    else held = clip.sourceEndMs;
    remaining -= duration;
  }
  return held;
}

/** The scene (or overlay-free recording) at an output time. */
export function sceneAt(
  edits: ReplayEdits,
  outputMs: number,
): { clip: SceneClip; startMs: number; localMs: number } | undefined {
  let start = 0;
  for (const clip of edits.clips) {
    const duration = clipDuration(clip);
    if (outputMs < start + duration || clip === edits.clips.at(-1))
      return isScene(clip)
        ? {
            clip,
            startMs: start,
            localMs: Math.min(duration, Math.max(0, outputMs - start)),
          }
        : undefined;
    start += duration;
  }
  return undefined;
}

export function sourceToOutput(
  edits: ReplayEdits,
  sourceMs: number,
): number | undefined {
  let output = 0;
  for (const clip of edits.clips) {
    if (
      !isScene(clip) &&
      sourceMs >= clip.sourceStartMs &&
      sourceMs <= clip.sourceEndMs
    )
      return output + (sourceMs - clip.sourceStartMs) / clip.rate;
    output += clipDuration(clip);
  }
  return undefined;
}

export function clipStart(
  edits: ReplayEdits,
  clipId: string,
): number | undefined {
  let time = 0;
  for (const clip of edits.clips) {
    if (clip.id === clipId) return time;
    time += clipDuration(clip);
  }
  return undefined;
}

export function narrationStart(
  edits: ReplayEdits,
  segment: NarrationSegment,
): number | undefined {
  const start = clipStart(edits, segment.clipId);
  return start === undefined ? undefined : start + segment.offsetMs;
}

// Identical in Node and browser; a request identity, not a cryptographic checksum.
export function narrationRequestKey(
  project: ReplayProject,
  segment: NarrationSegment,
): string {
  return JSON.stringify({
    text: segment.text,
    ...project.tts,
    voice: segment.voice ?? project.tts.voice,
    model: segment.model ?? project.tts.model,
    instructions: segment.instructions ?? project.tts.instructions,
    language: segment.language ?? project.tts.language,
  });
}

export function audioIsCurrent(
  project: ReplayProject,
  segment: NarrationSegment,
): boolean {
  return segment.audio?.requestKey === narrationRequestKey(project, segment);
}

/** Output-time spans where current narration audio plays. */
export function voiceSpans(bundle: ReplayBundle): [number, number][] {
  return bundle.narration.segments
    .flatMap((segment) => {
      const start = narrationStart(bundle.edits, segment);
      return start !== undefined &&
        segment.audio &&
        audioIsCurrent(bundle.project, segment)
        ? [[start, start + segment.audio.durationMs] as [number, number]]
        : [];
    })
    .sort((a, b) => a[0] - b[0]);
}

const DUCK_ATTACK_MS = 180,
  DUCK_RELEASE_MS = 450;
/** Gain of a music bed at an output time: volume × fades × ducking under
 * narration. Shared by the preview and the export so both mix the same. */
export function musicGain(
  music: ReplayAudio["music"][number],
  outputMs: number,
  totalMs: number,
  voice: [number, number][],
): number {
  const end = Math.min(totalMs, music.endMs ?? totalMs);
  if (outputMs < music.startMs || outputMs > end) return 0;
  const fadeIn = music.fadeInMs
    ? Math.min(1, (outputMs - music.startMs) / music.fadeInMs)
    : 1;
  const fadeOut = music.fadeOutMs
    ? Math.min(1, (end - outputMs) / music.fadeOutMs)
    : 1;
  let duck = 0;
  for (const [start, stop] of voice) {
    if (outputMs < start - DUCK_ATTACK_MS) break;
    const amount =
      outputMs < start
        ? 1 - (start - outputMs) / DUCK_ATTACK_MS
        : outputMs <= stop
          ? 1
          : Math.max(0, 1 - (outputMs - stop) / DUCK_RELEASE_MS);
    duck = Math.max(duck, amount);
  }
  const ease = (t: number) => t * t * (3 - 2 * t);
  return (
    music.volume *
    ease(Math.max(0, fadeIn)) *
    ease(Math.max(0, fadeOut)) *
    (1 - (1 - music.duck) * ease(duck))
  );
}

/** One camera window, as stored in `edits.camera`. */
export interface CameraWindow {
  startMs: number;
  endMs: number;
  scale: number;
  easeMs?: number;
}
/** Where the camera is: its zoom, and the source point it centres. */
export interface CameraPose {
  scale: number;
  x: number;
  y: number;
}
/**
 * The camera at an output time. A window eases from the full frame into its
 * pose and back out. When the window before it ends where this one starts
 * (or they overlap), the camera travels from that window's pose instead, and
 * the earlier window does not ease out: two framed shots in a row never dip
 * to the full page between them. `centre` gives the point a window frames
 * (its target element, or its x/y).
 */
export function cameraPose<W extends CameraWindow>(
  windows: W[],
  position: number,
  centre: (window: W) => { x: number; y: number },
): CameraPose | undefined {
  const active = windows.findLast((w) => position >= w.startMs && position < w.endMs);
  if (!active) return undefined;
  const own = { scale: active.scale, ...centre(active) };
  const joins = (a: W, b: W) => a !== b && a.startMs < b.startMs && a.endMs >= b.startMs - 1;
  const previous = windows.findLast((w) => joins(w, active));
  const next = windows.find((w) => joins(active, w));
  const ease = Math.max(1, Math.min(active.easeMs ?? 300, (active.endMs - active.startMs) / 2));
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const entering = Math.min(1, (position - active.startMs) / ease);
  if (previous && entering < 1) {
    const from = { scale: previous.scale, ...centre(previous) };
    const t = smooth(entering);
    return {
      scale: from.scale + (own.scale - from.scale) * t,
      x: from.x + (own.x - from.x) * t,
      y: from.y + (own.y - from.y) * t,
    };
  }
  const leaving = next ? 1 : Math.min(1, (active.endMs - position) / ease);
  const edge = Math.min(previous ? 1 : entering, leaving);
  return { ...own, scale: 1 + (own.scale - 1) * smooth(edge) };
}
