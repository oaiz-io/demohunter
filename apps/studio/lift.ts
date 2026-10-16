import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { openReplayRenderer } from "./render.js";
import { totalDuration } from "./model.js";
import { atomicWrite, writeJson } from "./storage.js";

/**
 * Lift a recorded element at an output time into `scenes/lifts/<name>.html`
 * (inline computed styles, pixel-faithful) with its on-screen rect, so a
 * scene or overlay can pick it up from exactly where it sits on the page.
 */
export async function liftElement(
  dir: string,
  input: { ref?: string; selector?: string; atMs: number; name: string },
): Promise<{
  html: string;
  json: string;
  rect: { x: number; y: number; width: number; height: number };
}> {
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(input.name))
    throw new Error("Lift name must be lowercase letters, digits and dashes.");
  if ((input.ref === undefined) === (input.selector === undefined))
    throw new Error("Give exactly one of ref or selector.");
  const renderer = await openReplayRenderer(dir);
  try {
    if (input.atMs < 0 || input.atMs > totalDuration(renderer.bundle.edits))
      throw new Error("Lift time is outside the edited timeline.");
    const snapshot = await renderer.snapshot(
      input.atMs,
      input.ref ? { ref: input.ref } : { selector: input.selector },
    );
    if (!snapshot)
      throw new Error(
        "That element is not on the page at this time. Pick a time when it is visible.",
      );
    const folder = path.join(dir, "scenes/lifts");
    await mkdir(folder, { recursive: true });
    // Project-relative from scenes/*.html (fragments) and scenes/lifts/ (css).
    const html = snapshot.html.replaceAll("/files/", "../");
    await atomicWrite(path.join(folder, `${input.name}.html`), `${html}\n`);
    await writeJson(path.join(folder, `${input.name}.json`), {
      name: input.name,
      atMs: input.atMs,
      ref: input.ref,
      selector: input.selector,
      rect: snapshot.rect,
    });
    await writeFile(
      path.join(folder, "fonts.css"),
      `/* Fonts used by the captured page (for lifted elements). */\n${snapshot.fontsCss.replaceAll("/files/", "../../")}\n`,
    );
    return {
      html: `scenes/lifts/${input.name}.html`,
      json: `scenes/lifts/${input.name}.json`,
      rect: snapshot.rect,
    };
  } finally {
    await renderer.close();
  }
}
