import type { CursorConfig, CursorOptions } from "@demohunter/sdk";

export type RecordingEffectsFlags = {
  cursor?: CursorConfig;
  /** Backward-compatible alias used by existing callers. */
  showCursor?: boolean;
  /** Backward-compatible alias used by existing callers. */
  showClickRipple?: boolean;
};

export type RecordingEffectsApi = {
  setCursorEnabled: (enabled: boolean) => void;
  setRippleEnabled: (enabled: boolean) => void;
  moveCursorTo: (x: number, y: number, durationMs?: number) => Promise<void>;
  showRipple: (x: number, y: number) => void;
  showRing: (x: number, y: number, width: number, height: number, padding: number) => void;
  clearRing: () => void;
  showSpotlight: (x: number, y: number, width: number, height: number, padding: number) => void;
  clearSpotlight: () => void;
};

declare global {
  interface Window {
    __demohunterEffects?: RecordingEffectsApi;
  }
}

export function calculateCursorDuration(distancePx: number, config: CursorOptions): number {
  const unclamped = distancePx / config.pixelsPerMs;
  return Math.round(Math.min(config.maxDurationMs, Math.max(config.minDurationMs, unclamped)));
}

export function quadraticBezierPoint(
  from: { x: number; y: number },
  control: { x: number; y: number },
  to: { x: number; y: number },
  progress: number,
): { x: number; y: number } {
  const inverse = 1 - progress;
  return {
    x: inverse * inverse * from.x + 2 * inverse * progress * control.x + progress * progress * to.x,
    y: inverse * inverse * from.y + 2 * inverse * progress * control.y + progress * progress * to.y,
  };
}

/**
 * Browser-side runtime for Pass 2 recording effects. It is serialized by Playwright, so every
 * browser helper and default is deliberately defined inside this function.
 */
export function installRecordingEffectsRuntime(flags: RecordingEffectsFlags): void {
  const scope = window as Window & { __demohunterEffects?: RecordingEffectsApi };

  if (scope.__demohunterEffects) {
    return;
  }

  const DEFAULT_CURSOR = {
    mode: "smooth" as const,
    shape: "pointer" as const,
    color: "#3b82f6",
    sizePx: 20,
    minDurationMs: 400,
    maxDurationMs: 1200,
    pixelsPerMs: 1.4,
    arcHeightPx: 56,
    ripple: true,
  };
  const resolvedCursor = flags.cursor === false || (flags.cursor === undefined && flags.showCursor === false)
    ? false
    : {
        ...DEFAULT_CURSOR,
        ...(typeof flags.cursor === "object" ? flags.cursor : {}),
        ripple: typeof flags.cursor === "object"
          ? flags.cursor.ripple
          : (flags.showClickRipple ?? DEFAULT_CURSOR.ripple),
      };
  const CURSOR_ID = "demohunter-cursor";
  const RING_ID = "demohunter-highlight-ring";
  const SPOTLIGHT_ID = "demohunter-spotlight";
  const STYLE_ID = "demohunter-effects-style";
  const RIPPLE_CLASS = "demohunter-click-ripple";
  const OVERLAY_ATTRIBUTE = "data-demohunter-overlay";
  const CURSOR_Z_INDEX = "2147483647";
  const RING_Z_INDEX = "2147483645";
  const SPOTLIGHT_Z_INDEX = "2147483646";
  const state: {
    animationFrame?: number;
    animationResolve?: () => void;
    cursorEnabled: boolean;
    position?: { x: number; y: number };
    rippleEnabled: boolean;
  } = {
    cursorEnabled: resolvedCursor !== false,
    rippleEnabled: resolvedCursor !== false && resolvedCursor.ripple,
  };

  const root = (): HTMLElement => document.body ?? document.documentElement;
  const viewportWidth = (): number => Number.isFinite(window.innerWidth) ? window.innerWidth : 1920;
  const viewportHeight = (): number => Number.isFinite(window.innerHeight) ? window.innerHeight : 1080;
  const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
  const now = (): number => window.performance?.now?.() ?? Date.now();

  const ensureStyle = (): void => {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.setAttribute(OVERLAY_ATTRIBUTE, "");
    style.textContent = `
      @keyframes demohunter-ripple {
        0% { transform: translate(-50%, -50%) scale(0.6); opacity: 0.9; }
        100% { transform: translate(-50%, -50%) scale(3); opacity: 0; }
      }
      .${RIPPLE_CLASS} {
        position: fixed;
        width: 40px;
        height: 40px;
        margin: 0;
        border: 2px solid ${resolvedCursor === false ? DEFAULT_CURSOR.color : resolvedCursor.color};
        border-radius: 50%;
        pointer-events: none;
        z-index: ${CURSOR_Z_INDEX};
        transform: translate(-50%, -50%);
        animation: demohunter-ripple 0.6s ease-out forwards;
      }
    `;
    (document.head ?? document.documentElement).appendChild(style);
  };

  const ensureCursor = (): SVGSVGElement => {
    let cursor = document.getElementById(CURSOR_ID) as SVGSVGElement | null;

    if (cursor === null) {
      const config = resolvedCursor === false ? DEFAULT_CURSOR : resolvedCursor;
      cursor = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      cursor.id = CURSOR_ID;
      cursor.setAttribute("viewBox", "0 0 24 24");
      cursor.setAttribute(OVERLAY_ATTRIBUTE, "");
      cursor.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: ${config.sizePx}px;
        height: ${config.sizePx}px;
        margin: 0;
        overflow: visible;
        pointer-events: none;
        z-index: ${CURSOR_Z_INDEX};
        transform: translate(-50%, -50%);
        filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.35));
        display: none;
      `;
      const shape = document.createElementNS("http://www.w3.org/2000/svg", config.shape === "dot" ? "circle" : "path");

      if (config.shape === "dot") {
        shape.setAttribute("cx", "12");
        shape.setAttribute("cy", "12");
        shape.setAttribute("r", "8");
      } else {
        shape.setAttribute("d", "M3 2.5v17l4.8-4.3 3.2 6.3 3-1.5-3.2-6.1 6.6-.2L3 2.5Z");
      }

      shape.setAttribute("fill", config.color);
      shape.setAttribute("stroke", "#ffffff");
      shape.setAttribute("stroke-width", "2");
      shape.setAttribute("stroke-linejoin", "round");
      cursor.appendChild(shape);
      root().appendChild(cursor);
    }

    return cursor;
  };

  const setPosition = (position: { x: number; y: number }): void => {
    const cursor = ensureCursor();
    const inset = (resolvedCursor === false ? DEFAULT_CURSOR.sizePx : resolvedCursor.sizePx) / 2;
    const clamped = {
      x: clamp(position.x, inset, Math.max(inset, viewportWidth() - inset)),
      y: clamp(position.y, inset, Math.max(inset, viewportHeight() - inset)),
    };
    state.position = clamped;
    cursor.style.left = `${clamped.x}px`;
    cursor.style.top = `${clamped.y}px`;
    cursor.style.display = state.cursorEnabled ? "block" : "none";
  };

  const cancelAnimation = (): void => {
    if (state.animationFrame !== undefined) {
      window.cancelAnimationFrame(state.animationFrame);
      state.animationFrame = undefined;
    }
    state.animationResolve?.();
    state.animationResolve = undefined;
  };

  const moveCursorTo = (x: number, y: number, requestedDurationMs?: number): Promise<void> => {
    if (!state.cursorEnabled) {
      return Promise.resolve();
    }

    const to = { x, y };
    const config = resolvedCursor === false ? DEFAULT_CURSOR : resolvedCursor;

    if (state.position === undefined || config.mode === "highlight") {
      cancelAnimation();
      setPosition(to);
      return Promise.resolve();
    }

    cancelAnimation();
    const from = { ...state.position };
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const durationMs = requestedDurationMs === undefined
      ? Math.round(clamp(distance / config.pixelsPerMs, config.minDurationMs, config.maxDurationMs))
      : Math.max(0, requestedDurationMs);

    if (durationMs === 0 || distance === 0) {
      setPosition(to);
      return Promise.resolve();
    }

    const midpoint = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    const normal = { x: -(to.y - from.y) / distance, y: (to.x - from.x) / distance };
    const control = {
      x: clamp(midpoint.x + normal.x * config.arcHeightPx, 0, viewportWidth()),
      y: clamp(midpoint.y + normal.y * config.arcHeightPx, 0, viewportHeight()),
    };
    const startedAt = now();

    return new Promise<void>((resolve) => {
      state.animationResolve = resolve;
      const tick = (timestamp: number): void => {
        const progress = clamp((timestamp - startedAt) / durationMs, 0, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        const inverse = 1 - eased;
        setPosition({
          x: inverse * inverse * from.x + 2 * inverse * eased * control.x + eased * eased * to.x,
          y: inverse * inverse * from.y + 2 * inverse * eased * control.y + eased * eased * to.y,
        });

        if (progress >= 1) {
          state.animationFrame = undefined;
          state.animationResolve = undefined;
          setPosition(to);
          resolve();
          return;
        }

        state.animationFrame = window.requestAnimationFrame(tick);
      };

      state.animationFrame = window.requestAnimationFrame(tick);
    });
  };

  const showRipple = (x: number, y: number): void => {
    if (!state.rippleEnabled) {
      return;
    }

    ensureStyle();
    const ripple = document.createElement("div");
    ripple.className = RIPPLE_CLASS;
    ripple.setAttribute(OVERLAY_ATTRIBUTE, "");
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    root().appendChild(ripple);
    window.setTimeout(() => ripple.remove(), 600);
  };

  document.addEventListener("mousemove", (event) => {
    if (state.cursorEnabled) {
      void moveCursorTo((event as MouseEvent).clientX, (event as MouseEvent).clientY);
    }
  }, true);
  document.addEventListener("click", (event) => {
    showRipple((event as MouseEvent).clientX, (event as MouseEvent).clientY);
  }, true);

  const ensureBoxOverlay = (id: string, spotlight: boolean): HTMLElement => {
    let overlay = document.getElementById(id);

    if (overlay === null) {
      overlay = document.createElement("div");
      overlay.id = id;
      overlay.setAttribute(OVERLAY_ATTRIBUTE, "");
      overlay.style.cssText = spotlight
        ? `position:fixed;margin:0;border-radius:8px;box-shadow:0 0 0 9999px rgba(15,23,42,.6);outline:2px solid rgba(59,130,246,.9);pointer-events:none;z-index:${SPOTLIGHT_Z_INDEX};transition:opacity 150ms ease;opacity:0;display:none;`
        : `position:fixed;margin:0;border-radius:8px;outline:2px solid rgba(59,130,246,.95);box-shadow:0 0 0 4px rgba(59,130,246,.22),0 0 22px rgba(59,130,246,.45);pointer-events:none;z-index:${RING_Z_INDEX};transition:opacity 150ms ease;opacity:0;display:none;`;
      root().appendChild(overlay);
    }

    return overlay;
  };

  const showBox = (
    overlay: HTMLElement,
    x: number,
    y: number,
    width: number,
    height: number,
    padding: number,
  ): void => {
    const pad = padding > 0 ? padding : 0;
    overlay.style.left = `${x - pad}px`;
    overlay.style.top = `${y - pad}px`;
    overlay.style.width = `${width + pad * 2}px`;
    overlay.style.height = `${height + pad * 2}px`;
    overlay.style.display = "block";
    overlay.style.opacity = "1";
  };

  const clearBox = (id: string): void => {
    const overlay = document.getElementById(id);
    if (overlay !== null) {
      overlay.style.opacity = "0";
      overlay.style.display = "none";
    }
  };

  const api: RecordingEffectsApi = {
    setCursorEnabled(enabled): void {
      state.cursorEnabled = enabled;
      if (!enabled) {
        cancelAnimation();
        const cursor = document.getElementById(CURSOR_ID);
        if (cursor !== null) cursor.style.display = "none";
      }
    },
    setRippleEnabled(enabled): void {
      state.rippleEnabled = enabled;
    },
    moveCursorTo,
    showRipple,
    showRing(x, y, width, height, padding): void {
      showBox(ensureBoxOverlay(RING_ID, false), x, y, width, height, padding);
    },
    clearRing(): void {
      clearBox(RING_ID);
    },
    showSpotlight(x, y, width, height, padding): void {
      showBox(ensureBoxOverlay(SPOTLIGHT_ID, true), x, y, width, height, padding);
    },
    clearSpotlight(): void {
      clearBox(SPOTLIGHT_ID);
    },
  };

  const setup = (): void => {
    ensureStyle();
    if (state.cursorEnabled) ensureCursor();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setup);
  } else {
    setup();
  }

  scope.__demohunterEffects = api;
}
