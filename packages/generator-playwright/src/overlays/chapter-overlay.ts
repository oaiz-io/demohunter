import type { Page } from "playwright";

const CHAPTER_OVERLAY_ID = "demohunter-chapter-overlay";
const CHAPTER_OVERLAY_TIMER_KEY = "__demohunterChapterOverlayHideTimer";

export type ShowChapterOverlayInput = {
  durationMs: number;
  page: Page;
  title: string;
};

export async function showChapterOverlay({
  durationMs,
  page,
  title,
}: ShowChapterOverlayInput): Promise<void> {
  await page.evaluate(
    ({ durationMs: overlayDurationMs, title: chapterTitle, overlayId, overlayTimerKey }) => {
      const scope = globalThis as typeof globalThis & Record<string, unknown>;

      let overlay = document.getElementById(overlayId);

      if (overlay === null) {
        overlay = document.createElement("div");
        overlay.id = overlayId;
        overlay.setAttribute("data-demohunter-overlay", "");
        overlay.style.position = "fixed";
        overlay.style.top = "24px";
        overlay.style.left = "24px";
        overlay.style.zIndex = "2147483647";
        overlay.style.padding = "8px 12px";
        overlay.style.borderRadius = "999px";
        overlay.style.background = "rgba(15, 23, 42, 0.88)";
        overlay.style.color = "#f8fafc";
        overlay.style.fontFamily = "system-ui, sans-serif";
        overlay.style.fontSize = "14px";
        overlay.style.fontWeight = "600";
        overlay.style.letterSpacing = "0.02em";
        overlay.style.pointerEvents = "none";
        overlay.style.opacity = "0";
        overlay.style.transition = "opacity 120ms ease";
        document.body.appendChild(overlay);
      }

      overlay.textContent = chapterTitle;
      overlay.style.opacity = "1";

      const existingTimer = scope[overlayTimerKey];
      if (existingTimer !== undefined) {
        clearTimeout(existingTimer as ReturnType<typeof setTimeout>);
      }

      scope[overlayTimerKey] = setTimeout(() => {
        const currentOverlay = document.getElementById(overlayId);

        if (currentOverlay !== null) {
          currentOverlay.style.opacity = "0";
        }
      }, overlayDurationMs);
    },
    {
      durationMs,
      title,
      overlayId: CHAPTER_OVERLAY_ID,
      overlayTimerKey: CHAPTER_OVERLAY_TIMER_KEY,
    },
  );
}
