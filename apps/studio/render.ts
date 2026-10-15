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
    browser = await chromium.launch();
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
    await page.evaluate(async () => {
      const doc = document.querySelector("iframe")?.contentDocument;
      await doc?.fonts.ready;
      await Promise.all(
        [...(doc?.images ?? [])].map((img) => img.decode().catch(() => {})),
      );
    });
    return {
      bundle,
      page,
      frame: async (outputMs: number) => {
        if (
          !Number.isFinite(outputMs) ||
          outputMs < 0 ||
          outputMs > totalDuration(bundle.edits)
        )
          throw new Error("Frame time is outside the edited timeline.");
        await page.evaluate(async (time) => {
          (window as any).__replayLab.seek(time);
          await new Promise<void>((r) =>
            requestAnimationFrame(() => requestAnimationFrame(() => r())),
          );
        }, outputMs);
        return page.screenshot({
          type: "png",
          animations: "disabled",
          timeout: 15000,
        });
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
