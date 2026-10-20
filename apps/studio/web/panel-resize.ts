/**
 * The side panel can be dragged wider or narrower from its left edge (or
 * with the arrow keys on the handle); double-click resets it. The width is
 * remembered in this browser.
 */
const KEY = "demohunter-panel-width";
const MIN = 300;
const max = () => Math.max(MIN, Math.min(900, Math.round(window.innerWidth * 0.6)));

export function resizablePanel(panel: HTMLElement, onResize: () => void = () => {}) {
  const handle = document.createElement("div");
  handle.className = "panel-resize";
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", "Resize panel");
  handle.tabIndex = 0;
  handle.title = "Drag to resize · double-click to reset";
  panel.prepend(handle);

  const apply = (width: number | undefined, save = true) => {
    if (width === undefined) {
      panel.style.removeProperty("--panel");
      if (save) localStorage.removeItem(KEY);
    } else {
      const w = Math.round(Math.min(max(), Math.max(MIN, width)));
      panel.style.setProperty("--panel", `${w}px`);
      handle.setAttribute("aria-valuenow", String(w));
      if (save) localStorage.setItem(KEY, String(w));
    }
    onResize();
  };
  const saved = Number(localStorage.getItem(KEY));
  if (saved) apply(saved, false);

  handle.addEventListener("pointerdown", (down) => {
    down.preventDefault();
    handle.setPointerCapture(down.pointerId);
    const right = panel.getBoundingClientRect().right;
    document.body.classList.add("resizing-panel");
    const move = (e: PointerEvent) => apply(right - e.clientX);
    const up = () => {
      document.body.classList.remove("resizing-panel");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
  handle.addEventListener("dblclick", () => apply(undefined));
  handle.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 64 : 16;
    const width = panel.getBoundingClientRect().width;
    if (e.key === "ArrowLeft") apply(width + step);
    else if (e.key === "ArrowRight") apply(width - step);
    else return;
    e.preventDefault();
  });
  // Keep it within bounds when the window shrinks.
  window.addEventListener("resize", () => {
    if (localStorage.getItem(KEY)) apply(Number(localStorage.getItem(KEY)), false);
  });
}
