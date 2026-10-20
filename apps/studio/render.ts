import { chromium } from "playwright";
import { serveReplay } from "./server.js";
import { loadBundle, RevisionConflict } from "./storage.js";
import { totalDuration } from "./model.js";
/** Shared deterministic player for screenshots and exports. It publishes no
 * selection/activity/playhead and never visits the original application. */
export async function openReplayRenderer(
  dir: string,
  expectedRevision?: string,
) {
  const bundle = await loadBundle(dir);
  if (expectedRevision && bundle.revision !== expectedRevision)
    throw new RevisionConflict("The project changed before rendering.");
  const preview = await serveReplay(dir, { port: 0 });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    // Full Chromium in new headless mode renders frames ~4–6× faster than
    // the stripped headless shell; fall back where it is not installed.
    browser = await chromium
      .launch({ channel: "chromium" })
      .catch(() => chromium.launch());
    const page = await browser.newPage({
      viewport: {
        width: bundle.project.viewport.width,
        height: bundle.project.viewport.height,
      },
      deviceScaleFactor: 1,
    });
    await page.goto(`${preview.url}/?render=1`);
    await page.waitForFunction(
      () => (window as any).__replayLab?.state().ready === true,
    );
    await page.evaluate((size) => {
      const stage = document.querySelector<HTMLElement>("#stage")!;
      stage.style.cssText = `position:fixed;left:0;top:0;width:${size.width}px;height:${size.height}px;z-index:2147483647;flex:none;min-height:0;overflow:hidden;border:0;border-radius:0;box-sizing:content-box`;
      document.body.style.overflow = "hidden";
      const style = document.createElement("style");
      style.textContent =
        "#viewport{left:0!important;top:0!important;transform:none!important}#selection-box,#hover-box,#agent-target,#comment-pins,.canvas-label,.replayer-mouse{display:none!important}";
      document.head.append(style);
    }, bundle.project.viewport);
    await page.evaluate(() => (window as any).__replayLab.scenesReady());
    await page.evaluate(async () => {
      const doc =
        document.querySelector<HTMLIFrameElement>(
          "#replay iframe",
        )?.contentDocument;
      await doc?.fonts.ready;
      await Promise.all(
        [...(doc?.images ?? [])].map((img) => img.decode().catch(() => {})),
      );
    });
    return {
      bundle,
      page,
      frame: async (
        outputMs: number,
        shot: { format?: "png" | "jpeg"; quality?: number } = {},
      ) => {
        if (
          !Number.isFinite(outputMs) ||
          outputMs < 0 ||
          outputMs > totalDuration(bundle.edits)
        )
          throw new Error("Frame time is outside the edited timeline.");
        // seek() updates the DOM synchronously; the screenshot itself
        // produces a fresh frame, so no animation-frame wait is needed.
        await page.evaluate(
          (time) => (window as any).__replayLab.seek(time),
          outputMs,
        );
        // Playwright's "disabled" mode finish()es every animation in every
        // frame, which would freeze scene and overlay pages at their end
        // state for the rest of the export. With scenes in the project the
        // pages are seeked per frame (and the paused replay holds still).
        const scene =
          bundle.edits.clips.some((c) => c.kind === "scene") ||
          (bundle.edits.overlays ?? []).length > 0;
        return page.screenshot({
          type: shot.format ?? "png",
          quality: shot.format === "jpeg" ? (shot.quality ?? 90) : undefined,
          animations: scene ? "allow" : "disabled",
          timeout: 15000,
        });
      },
      sceneCues: () =>
        page.evaluate(
          () =>
            (window as any).__replayLab.sceneCues() as {
              id: string;
              src: string;
              atMs: number;
              volume: number;
            }[],
        ),
      /** A recorded element at an output time, as standalone styled HTML. */
      snapshot: async (outputMs: number, target: Record<string, unknown>) => {
        await page.evaluate(async (time) => {
          (window as any).__replayLab.seek(time);
          await new Promise<void>((r) =>
            requestAnimationFrame(() => requestAnimationFrame(() => r())),
          );
        }, outputMs);
        return page.evaluate(
          (target) =>
            (window as any).__replayLab.snapshot(target) as
              | {
                  html: string;
                  rect: { x: number; y: number; width: number; height: number };
                  fontsCss: string;
                }
              | undefined,
          target,
        );
      },
      checkRevision: async () => {
        if ((await loadBundle(dir)).revision !== bundle.revision)
          throw new RevisionConflict(
            "The project changed while rendering. Retry for a consistent revision.",
          );
      },
      close: async () => {
        await browser?.close();
        await preview.close();
      },
    };
  } catch (error) {
    await browser?.close();
    await preview.close();
    throw error;
  }
}
export async function renderReplayFrame(
  dir: string,
  options: {
    outputMs?: number;
    elementRef?: string;
    expectedRevision?: string;
    timeoutMs?: number;
  } = {},
) {
  // Frames share one global queue; a render that never settles (for example
  // when the project folder is replaced mid-render) must not block it.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Frame render timed out.")),
      options.timeoutMs ?? 60_000,
    );
  });
  const opening = openReplayRenderer(dir, options.expectedRevision);
  let renderer: Awaited<typeof opening> | undefined;
  try {
    renderer = await Promise.race([opening, timeout]);
    const outputMs = options.outputMs ?? 0;
    const bytes = await Promise.race([renderer.frame(outputMs), timeout]);
    await renderer.checkRevision();
    return { bytes, revision: renderer.bundle.revision, outputMs };
  } finally {
    clearTimeout(timer);
    if (renderer) await renderer.close().catch(() => {});
    else
      void opening.then(
        (late) => late.close().catch(() => {}),
        () => {},
      );
  }
}
