import { openReplayRenderer } from "./render.js";
import { totalDuration } from "./model.js";
import { writeUnderScenes } from "./workspace.js";

/**
 * Lift a recorded element at an output time into `scenes/lifts/<name>.html`
 * (inline computed styles, pixel-faithful) with its on-screen rect, so a
 * scene or overlay can pick it up from exactly where it sits on the page.
 * The files are written like any scene file: under the project lock, after a
 * revision check, atomically, and never through symlinks.
 */
export async function liftElement(
  dir: string,
  input: {
    ref?: string;
    selector?: string;
    atMs: number;
    name: string;
    /** Revision the caller read; omitted by the CLI, which has no editor state. */
    expectedRevision?: string;
  },
): Promise<{
  html: string;
  json: string;
  rect: { x: number; y: number; width: number; height: number };
  revision: string;
}> {
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(input.name))
    throw new Error("Lift name must be lowercase letters, digits and dashes.");
  if ((input.ref === undefined) === (input.selector === undefined))
    throw new Error("Give exactly one of ref or selector.");
  if (!Number.isFinite(input.atMs))
    throw new Error("Lift time must be a number of output milliseconds.");
  const renderer = await openReplayRenderer(dir, input.expectedRevision);
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
    // Project-relative from scenes/*.html (fragments) and scenes/lifts/ (css).
    const html = snapshot.html.replaceAll("/files/", "../");
    const base = `scenes/lifts/${input.name}`;
    const { revision } = await writeUnderScenes(
      dir,
      // The page was rendered at this revision; refuse to write if it moved.
      input.expectedRevision ?? renderer.bundle.revision,
      [
        { relative: `${base}.html`, content: `${html}\n` },
        {
          relative: `${base}.json`,
          content: `${JSON.stringify(
            {
              name: input.name,
              atMs: input.atMs,
              ref: input.ref,
              selector: input.selector,
              rect: snapshot.rect,
            },
            null,
            2,
          )}\n`,
        },
        {
          relative: "scenes/lifts/fonts.css",
          content: `/* Fonts used by the captured page (for lifted elements). */\n${snapshot.fontsCss.replaceAll("/files/", "../../")}\n`,
        },
      ],
    );
    return {
      html: `${base}.html`,
      json: `${base}.json`,
      rect: snapshot.rect,
      revision,
    };
  } finally {
    await renderer.close();
  }
}
