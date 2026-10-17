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
  /** Scene file and asset stamp the visible iframe was loaded for. */
  version: string;
  trusted: boolean;
  kind: "scene" | "overlay";
  iframe: HTMLIFrameElement;
  /** Resolves when the newest iframe for this layer is ready (and shown). */
  loaded: Promise<void>;
  ready: boolean;
  startMs: number;
  endMs: number;
  zIndex: number;
  src: string;
  /** A replacement loading out of sight; swapped in once ready. */
  pending?: LoadingFrame;
};
type LoadingFrame = {
  iframe: HTMLIFrameElement;
  loaded: Promise<void>;
  /** Stop waiting (the frame was discarded before it finished loading). */
  release: () => void;
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
  private lastPosition = 0;
  private changes = 0;

  constructor(private root: HTMLElement) {}

  /** Bumps whenever pages load, swap or change visibility, so callers can
   * skip redrawing a paused frame that nothing touched. */
  get generation(): number {
    return this.changes;
  }

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

  /**
   * Bring the layers in line with the bundle. `trusted` false loads pages in a
   * sandbox without scripts: Studio can still seek CSS and Web Animations
   * through the document, but the page's own code never runs.
   */
  load(bundle: ReplayBundle, trusted = true): void {
    this.changes++;
    const wanted = new Map<
      string,
      Pick<
        Layer,
        "src" | "kind" | "startMs" | "endMs" | "zIndex" | "version" | "trusted"
      >
    >();
    const { width, height } = bundle.project.viewport;
    // Scene pages only: new narration audio must not reload every scene.
    const version = bundle.scenesRevision ?? bundle.assetsRevision ?? "";
    for (const clip of bundle.edits.clips) {
      if (!isScene(clip)) continue;
      const startMs = clipStart(bundle.edits, clip.id) ?? 0;
      wanted.set(`scene:${clip.id}`, {
        version,
        trusted,
        src: clip.src,
        kind: "scene",
        startMs,
        endMs: startMs + clip.durationMs,
        zIndex: 1,
      });
    }
    (bundle.edits.overlays ?? []).forEach((overlay, i) =>
      wanted.set(`overlay:${overlay.id}`, {
        version,
        trusted,
        src: overlay.src,
        kind: "overlay",
        startMs: overlay.startMs,
        endMs: overlay.endMs,
        zIndex: 2 + i,
      }),
    );
    for (const [id, layer] of this.layers)
      if (!wanted.has(id)) {
        this.discard(layer.pending);
        layer.iframe.remove();
        this.layers.delete(id);
      }
    for (const [id, spec] of wanted) {
      const existing = this.layers.get(id);
      if (existing) {
        const {
          version: nextVersion,
          src,
          trusted: nextTrusted,
          ...rest
        } = spec;
        Object.assign(existing, rest);
        existing.iframe.style.zIndex = String(spec.zIndex);
        // The viewport can change while pages are open.
        for (const frame of [existing.iframe, existing.pending?.iframe])
          if (frame)
            Object.assign(frame.style, {
              width: `${width}px`,
              height: `${height}px`,
            });
        const current = existing.pending
          ? existing.pending.iframe.dataset.version
          : existing.version;
        const sandboxed = (
          existing.pending?.iframe ?? existing.iframe
        ).hasAttribute("sandbox");
        if (
          current === nextVersion &&
          sandboxed === !spec.trusted &&
          (existing.pending?.iframe ?? existing.iframe).dataset.src === spec.src
        )
          continue;
        // Keep showing the old page until the replacement is ready, so a
        // change anywhere in the assets never blanks every scene.
        this.discard(existing.pending);
        const next = this.frame(spec, nextVersion, width, height);
        existing.pending = next;
        existing.loaded = next.loaded.then(() => {
          if (existing.pending !== next || this.layers.get(id) !== existing)
            return;
          const old = existing.iframe;
          next.iframe.classList.toggle(
            "visible",
            old.classList.contains("visible"),
          );
          existing.iframe = next.iframe;
          existing.version = nextVersion;
          existing.src = src;
          existing.trusted = nextTrusted;
          existing.pending = undefined;
          // The first page may never have finished loading before it was
          // replaced; the swapped-in one is ready.
          existing.ready = true;
          this.changes++;
          old.remove();
          if (next.iframe.classList.contains("visible"))
            seekDocument(
              next.iframe,
              Math.max(0, this.lastPosition - existing.startMs),
            );
        });
        continue;
      }
      const first = this.frame(spec, spec.version, width, height);
      const layer: Layer = {
        ...spec,
        iframe: first.iframe,
        ready: false,
        loaded: first.loaded.then(() => {
          layer.ready = true;
          this.changes++;
        }),
      };
      this.layers.set(id, layer);
    }
  }

  /** A hidden iframe for a scene page; `loaded` resolves once it is frozen on
   * its first frame (fonts, images and the page's ready promise included). */
  private frame(
    spec: {
      src: string;
      kind: Layer["kind"];
      zIndex: number;
      trusted: boolean;
    },
    version: string,
    width: number,
    height: number,
  ): LoadingFrame {
    const iframe = document.createElement("iframe");
    iframe.className = `scene-frame ${spec.kind}`;
    iframe.setAttribute("aria-hidden", "true");
    iframe.tabIndex = -1;
    iframe.dataset.version = version;
    iframe.dataset.src = spec.src;
    // Untrusted folders: no scripts, but same-origin so Studio can seek the
    // page. Must be set before src or the first load would run scripts.
    if (!spec.trusted) iframe.setAttribute("sandbox", "allow-same-origin");
    Object.assign(iframe.style, {
      width: `${width}px`,
      height: `${height}px`,
      zIndex: String(spec.zIndex),
    });
    let release = () => {};
    const loaded = new Promise<void>((resolve) => {
      release = resolve;
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
            [...(doc?.images ?? [])].map((img) => img.decode().catch(() => {})),
          );
          // Freeze the page on its first frame right away: animations that
          // ran (and finished) in real time while the page waited could
          // otherwise be auto-removed by the browser as "replaced".
          seekDocument(iframe, 0);
          resolve();
        },
        { once: true },
      );
    });
    iframe.src = projectUrl(`/files/${spec.src}?v=${version}`);
    this.root.append(iframe);
    return { iframe, loaded, release };
  }

  private discard(frame: LoadingFrame | undefined): void {
    if (!frame) return;
    frame.iframe.remove();
    frame.release();
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
    this.lastPosition = positionMs;
    for (const layer of this.layers.values()) {
      const visible =
        positionMs >= layer.startMs &&
        (positionMs < layer.endMs ||
          (positionMs >= totalMs - 0.5 && layer.endMs >= totalMs - 0.5));
      // A page that is still loading would show as a blank card.
      const shown = visible && layer.ready;
      if (layer.iframe.classList.contains("visible") !== shown) {
        layer.iframe.classList.toggle("visible", shown);
        this.changes++;
      }
      if (!shown) continue;
      if (layer.kind === "scene") covering = true;
      seekDocument(layer.iframe, Math.max(0, positionMs - layer.startMs));
    }
    this.active = covering;
    this.root.classList.toggle("covering", covering);
  }

  /** Resolves when every scene page, font and image has loaded, including
   * replacements started while waiting. */
  async ready(): Promise<void> {
    for (let round = 0; round < 5; round++) {
      const loading = [...this.layers.values()].map((layer) => layer.loaded);
      await Promise.all(loading);
      const settled = [...this.layers.values()].every(
        (layer, i) => layer.loaded === loading[i],
      );
      if (settled) return;
    }
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
      (Window & { demohunterScene?: { seek?: (ms: number) => void } }) | null;
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
