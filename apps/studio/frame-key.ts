import { createHash } from "node:crypto";
import {
  outputToSource,
  sampleAnimation,
  sceneAt,
  type ReplayBundle,
  type Target,
} from "./model.js";

/** Bump when the renderer's output changes, so old images are not reused. */
const RENDER_VERSION = 1;

/** When each recorded element exists (source time), by ref and by node. */
export type ElementSpans = Map<string, [number, number]>;
export function elementSpans(index: {
  elements: {
    ref: string;
    documentId: number;
    nodeId: number;
    firstSeenMs: number;
    lastSeenMs?: number;
  }[];
}): ElementSpans {
  const spans: ElementSpans = new Map();
  for (const e of index.elements) {
    const span: [number, number] = [e.firstSeenMs, e.lastSeenMs ?? Infinity];
    spans.set(`ref:${e.ref}`, span);
    spans.set(`node:${e.documentId}:${e.nodeId}`, span);
  }
  return spans;
}
/** The edit can change this frame: its element is on the page at this
 * source time. Unknown elements (selectors, missing records) always count. */
function present(target: Target, sourceMs: number, spans?: ElementSpans) {
  if (!spans) return true;
  const span = target.ref
    ? spans.get(`ref:${target.ref}`)
    : target.nodeId !== undefined && target.documentId !== undefined
      ? spans.get(`node:${target.documentId}:${target.nodeId}`)
      : undefined;
  return !span || (sourceMs >= span[0] - 1 && sourceMs <= span[1] + 1);
}

/**
 * What one rendered frame at `outputMs` depends on, as a short hash. Comments,
 * narration and audio are not part of it, and neither are edits that cannot
 * show at this time (camera, highlight, animation and overlay entries far
 * from it, element edits whose element is not on the page). Times are
 * relative to the frame, so a trim earlier in the film does not change a
 * later frame's key.
 *
 * `spans` (from the element index) narrows element edits to this frame;
 * without it every element edit counts. `stamp` identifies the capture.
 */
export function frameKey(
  bundle: ReplayBundle,
  outputMs: number,
  options: { kind: string; spans?: ElementSpans; stamp?: string },
): string {
  const { edits } = bundle;
  const t = outputMs;
  const near = (e: { startMs: number; endMs: number }, margin: number) =>
    t >= e.startMs - margin && t <= e.endMs + margin;
  const relative = <T extends { startMs: number; endMs: number }>(e: T) => ({
    ...e,
    startMs: e.startMs - t,
    endMs: e.endMs - t,
  });
  const sourceMs = outputToSource(edits, t);
  const scene = sceneAt(edits, t);
  // Overlays ease in and out (at most 3 s); camera moves ease (at most 5 s).
  const overlays = (edits.overlays ?? []).filter((o) => near(o, 3000));
  const pages = [
    ...(scene ? [scene.clip.src] : []),
    ...overlays.map((o) => o.src),
  ];
  const elements = edits.elements.filter((e) =>
    e.target.scene
      ? pages.includes(e.target.scene)
      : present(e.target, sourceMs, options.spans),
  );
  const parts = [
    RENDER_VERSION,
    options.kind,
    options.stamp,
    bundle.project.viewport,
    bundle.css,
    Math.round(sourceMs * 1000) / 1000,
    scene && { clip: scene.clip, localMs: Math.round(scene.localMs * 1000) / 1000 },
    elements,
    edits.camera.filter((c) => near(c, 5000)).map(relative),
    edits.highlights.filter((h) => near(h, 1000)).map(relative),
    (edits.animations ?? [])
      .filter((a) => sampleAnimation(a, t) !== undefined)
      .map(relative),
    overlays.map(relative),
    pages.length ? (bundle.scenesRevision ?? bundle.assetsRevision) : undefined,
  ];
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 24);
}
