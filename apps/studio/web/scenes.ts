import { clipStart, isScene, type ReplayBundle } from "../model.js";
import { projectUrl } from "./transport.js";

/** A sound a scene page declares with `<audio data-start="1.2">`. */
export type SceneCue = {
  id: string;
  src: string;
  atMs: number;
  volume: number;
};

type Layer = {
  key: string;
  kind: "scene" | "overlay";
  iframe: HTMLIFrameElement;
  loaded: Promise<void>;
  ready: boolean;
  startMs: number;
  endMs: number;
  zIndex: number;
  src: string;
};

/**
 * HTML scenes (intro, outro, chapter cards) and transparent overlays. Every
 * page is a pure function of time: on each update all of its Web Animations
 * and CSS animations are paused and set to the local time, media elements are
 * seeked, and an optional `window.demohunterScene.seek(ms)` drives the rest.
 * Preview and export share this, so exports are frame-accurate.
 */
export class SceneLayer {
  private layers = new Map<string, Layer>();
  private active = false;

  constructor(private root: HTMLElement) {}

  /** True while an opaque scene covers the recording. */
  get covering(): boolean {
    return this.active;
  }

  documents(
    visibleOnly = true,
  ): { src: string; iframe: HTMLIFrameElement; document: Document }[] {
    return [...this.layers.values()]
      .sort(
        (a, b) =>
          Number(b.iframe.classList.contains("visible")) -
            Number(a.iframe.classList.contains("visible")) ||
          b.zIndex - a.zIndex,
      )
      .filter(
        (l) =>
          l.ready &&
          (!visibleOnly || l.iframe.classList.contains("visible")) &&
          l.iframe.contentDocument,
      )
      .map((l) => ({
        src: l.src,
        iframe: l.iframe,
        document: l.iframe.contentDocument!,
      }));
  }

  load(bundle: ReplayBundle): void {
    const wanted = new Map<
      string,
      Omit<Layer, "iframe" | "loaded" | "ready">
    >();
    const { width, height } = bundle.project.viewport;
    for (const clip of bundle.edits.clips) {
      if (!isScene(clip)) continue;
      const startMs = clipStart(bundle.edits, clip.id) ?? 0;
      wanted.set(`scene:${clip.id}`, {
        key: `${clip.src}#${bundle.assetsRevision}`,
        src: clip.src,
        kind: "scene",
        startMs,
        endMs: startMs + clip.durationMs,
        zIndex: 1,
      });
    }
    (bundle.edits.overlays ?? []).forEach((overlay, i) =>
      wanted.set(`overlay:${overlay.id}`, {
        key: `${overlay.src}#${bundle.assetsRevision}`,
        src: overlay.src,
        kind: "overlay",
        startMs: overlay.startMs,
        endMs: overlay.endMs,
        zIndex: 2 + i,
      }),
    );
    for (const [id, layer] of this.layers)
      if (wanted.get(id)?.key !== layer.key) {
        layer.iframe.remove();
        this.layers.delete(id);
      }
    for (const [id, spec] of wanted) {
      const existing = this.layers.get(id);
      if (existing) {
        Object.assign(existing, spec);
        existing.iframe.style.zIndex = String(spec.zIndex);
        continue;
      }
      const src = id.startsWith("scene:")
        ? bundle.edits.clips.find((c) => isScene(c) && `scene:${c.id}` === id)!
        : bundle.edits.overlays!.find((o) => `overlay:${o.id}` === id)!;
      const iframe = document.createElement("iframe");
      iframe.className = `scene-frame ${spec.kind}`;
      iframe.setAttribute("aria-hidden", "true");
      iframe.tabIndex = -1;
      Object.assign(iframe.style, {
        width: `${width}px`,
        height: `${height}px`,
        zIndex: String(spec.zIndex),
      });
      const layer: Layer = {
        ...spec,
        iframe,
        ready: false,
        loaded: new Promise<void>((resolve) => {
          iframe.addEventListener(
            "load",
            async () => {
              const doc = iframe.contentDocument;
              // Scenes that fetch lifted elements register a ready promise.
              await (
                iframe.contentWindow as
                  | (Window & {
                      demohunterScene?: { ready?: Promise<unknown> };
                    })
                  | null
              )?.demohunterScene?.ready?.catch?.(() => {});
              await doc?.fonts?.ready;
              await Promise.all(
                [...(doc?.images ?? [])].map((img) =>
                  img.decode().catch(() => {}),
                ),
              );
              // Freeze the page on its first frame right away: animations that
              // ran (and finished) in real time while the page waited could
              // otherwise be auto-removed by the browser as "replaced".
              seekDocument(iframe, 0);
              layer.ready = true;
              resolve();
            },
            { once: true },
          );
        }),
      };
      iframe.src = projectUrl(
        `/files/${(src as { src: string }).src}?v=${bundle.assetsRevision ?? ""}`,
      );
      this.root.append(iframe);
      this.layers.set(id, layer);
    }
  }

  /** Recording blur/dim requested by the overlays at an output time. */
  backdrop(
    bundle: ReplayBundle,
    positionMs: number,
  ): { blur: number; dim: number } {
    let blur = 0,
      dim = 0;
    for (const overlay of bundle.edits.overlays ?? []) {
      const b = overlay.backdrop;
      if (!b || positionMs < overlay.startMs || positionMs >= overlay.endMs)
        continue;
      const edge = Math.min(
        1,
        (positionMs - overlay.startMs) / Math.max(1, b.easeMs),
        (overlay.endMs - positionMs) / Math.max(1, b.easeMs),
      );
      const k = edge * edge * (3 - 2 * edge);
      blur = Math.max(blur, b.blur * k);
      dim = Math.max(dim, b.dim * k);
    }
    return { blur, dim };
  }

  /** Show and seek the layers at an output time. */
  update(positionMs: number, totalMs: number): void {
    let covering = false;
    for (const layer of this.layers.values()) {
      const visible =
        positionMs >= layer.startMs &&
        (positionMs < layer.endMs ||
          (positionMs >= totalMs - 0.5 && layer.endMs >= totalMs - 0.5));
      layer.iframe.classList.toggle("visible", visible);
      if (!visible || !layer.ready) continue;
      if (layer.kind === "scene") covering = true;
      seekDocument(layer.iframe, Math.max(0, positionMs - layer.startMs));
    }
    this.active = covering;
    this.root.classList.toggle("covering", covering);
  }

  /** Resolves when every scene page, font and image has loaded. */
  async ready(): Promise<void> {
    await Promise.all([...this.layers.values()].map((layer) => layer.loaded));
  }

  /** Sounds declared inside scene pages, in output time. */
  cues(): SceneCue[] {
    const cues: SceneCue[] = [];
    for (const [id, layer] of this.layers) {
      const doc = layer.iframe.contentDocument;
      if (!layer.ready || !doc) continue;
      doc
        .querySelectorAll<HTMLAudioElement>("audio[data-start]")
        .forEach((audio, i) => {
          const start = Number(audio.dataset.start);
          const src = projectPath(audio.currentSrc || audio.src);
          if (!Number.isFinite(start) || !src) return;
          cues.push({
            id: `${id}:${audio.id || i}`,
            src,
            atMs: layer.startMs + start * 1000,
            volume: Math.max(0, Math.min(1, Number(audio.dataset.volume ?? 1))),
          });
        });
    }
    return cues.sort((a, b) => a.atMs - b.atMs);
  }
}

function seekDocument(iframe: HTMLIFrameElement, localMs: number): void {
  const doc = iframe.contentDocument,
    win = iframe.contentWindow as
      | (Window & { demohunterScene?: { seek?: (ms: number) => void } })
      | null;
  if (!doc || !win) return;
  for (const animation of doc.getAnimations()) {
    if (animation.playState !== "paused") {
      animation.pause();
      animation.persist();
    }
    animation.currentTime = localMs;
  }
  doc.querySelectorAll<HTMLMediaElement>("video").forEach((video) => {
    if (!video.paused) video.pause();
    if (Math.abs(video.currentTime - localMs / 1000) > 0.02)
      video.currentTime = localMs / 1000;
  });
  try {
    win.demohunterScene?.seek?.(localMs);
  } catch (error) {
    console.error(error);
  }
}

/** `/projects/<id>/files/audio/x.wav` → `audio/x.wav`. */
function projectPath(url: string): string | undefined {
  try {
    const pathname = decodeURIComponent(new URL(url, location.href).pathname);
    const index = pathname.indexOf("/files/");
    return index < 0 ? undefined : pathname.slice(index + "/files/".length);
  } catch {
    return undefined;
  }
}
