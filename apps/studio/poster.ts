import { mkdir, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { loadBundle, atomicWrite, writeJson } from "./storage.js";
import { openReplayRenderer, renderReplayFrame } from "./render.js";
import { clipStart, isScene, totalDuration } from "./model.js";
// Derived work is bounded globally, with one in-flight render per project.
let queue = Promise.resolve();
const pending = new Map<string, Promise<Buffer>>();

/** One warm renderer for consecutive thumbnails of the same project, so a
 * timeline full of thumbnails launches Chromium once instead of per frame. */
let warm:
  | {
      dir: string;
      renderer: Awaited<ReturnType<typeof openReplayRenderer>>;
      idle?: ReturnType<typeof setTimeout>;
    }
  | undefined;
async function closeWarm() {
  const current = warm;
  warm = undefined;
  if (current) {
    clearTimeout(current.idle);
    await current.renderer.close().catch(() => {});
  }
}
async function warmFrame(dir: string, ms: number) {
  if (warm && warm.dir === dir) {
    const { revision } = await loadBundle(dir);
    if (revision !== warm.renderer.bundle.revision) await closeWarm();
  } else await closeWarm();
  if (!warm) {
    // A renderer that never starts must not stall the shared queue.
    let startTimer: ReturnType<typeof setTimeout> | undefined;
    const opening = openReplayRenderer(dir);
    try {
      warm = {
        dir,
        renderer: await Promise.race([
          opening,
          new Promise<never>((_, reject) => {
            startTimer = setTimeout(
              () => reject(new Error("Frame renderer did not start.")),
              60_000,
            );
          }),
        ]),
      };
    } catch (error) {
      void opening.then(
        (late) => late.close().catch(() => {}),
        () => {},
      );
      throw error;
    } finally {
      clearTimeout(startTimer);
    }
  }
  const current = warm;
  clearTimeout(current.idle);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const bytes = await Promise.race([
      current.renderer.frame(ms),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Frame render timed out.")), 30_000);
      }),
    ]);
    await current.renderer.checkRevision();
    current.idle = setTimeout(() => {
      if (warm === current) void closeWarm();
    }, 15_000);
    return { bytes, revision: current.renderer.bundle.revision };
  } catch (error) {
    await closeWarm();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** The library poster: the first recorded frame, not a title card's blank
 * first frame. */
function posterTime(bundle: Awaited<ReturnType<typeof loadBundle>>) {
  const { edits } = bundle;
  if (!edits.clips[0] || !isScene(edits.clips[0])) return 0;
  const clip = edits.clips.find((c) => !isScene(c));
  return clip ? (clipStart(edits, clip.id) ?? 0) + 500 : 0;
}
export async function projectPoster(dir: string): Promise<Buffer> {
  const bundle = await loadBundle(dir),
    folder = path.join(dir, ".studio");
  try {
    const cache = JSON.parse(
      await readFile(path.join(folder, "poster.json"), "utf8"),
    );
    if (cache.revision === bundle.revision && cache.rendererVersion === 3)
      return await readFile(path.join(folder, "poster.png"));
  } catch {}
  const existing = pending.get(dir);
  if (existing) return existing;
  const task = queue
    .catch(() => {})
    .then(async () => {
      const frame = await renderReplayFrame(dir, {
        outputMs: Math.min(posterTime(bundle), totalDuration(bundle.edits)),
      });
      await mkdir(folder, { recursive: true });
      await atomicWrite(path.join(folder, "poster.png"), frame.bytes);
      await writeJson(path.join(folder, "poster.json"), {
        revision: frame.revision,
        rendererVersion: 3,
      });
      return frame.bytes;
    })
    .finally(() => pending.delete(dir));
  pending.set(dir, task);
  queue = task.then(
    () => {},
    () => {},
  );
  return task;
}
/** A cached frame of the edited timeline, e.g. a scene thumbnail. Shares the
 * global render queue so thumbnails never compete with exports for Chromium. */
export async function projectFrame(
  dir: string,
  outputMs: number,
): Promise<Buffer> {
  const bundle = await loadBundle(dir),
    folder = path.join(dir, ".studio/frames"),
    ms = Math.min(
      Math.floor(totalDuration(bundle.edits)),
      Math.max(0, Math.round(outputMs)),
    ),
    file = path.join(folder, `${bundle.revision}-${ms}.png`);
  try {
    return await readFile(file);
  } catch {}
  const key = `${dir}#${bundle.revision}#${ms}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const task = queue
    .catch(() => {})
    .then(async () => {
      // An agent may change the project mid-render; retry on the new revision.
      let frame: { bytes: Buffer; revision: string } | undefined;
      for (let attempt = 0; !frame; attempt++)
        try {
          frame = await warmFrame(dir, ms);
        } catch (error) {
          if (attempt >= 2 || (error as { status?: number }).status !== 409)
            throw error;
        }
      await mkdir(folder, { recursive: true });
      // Thumbnails for older revisions are disposable.
      for (const name of await readdir(folder).catch(() => [] as string[]))
        if (!name.startsWith(`${frame.revision}-`))
          await unlink(path.join(folder, name)).catch(() => {});
      await atomicWrite(
        path.join(folder, `${frame.revision}-${ms}.png`),
        frame.bytes,
      );
      return frame.bytes;
    })
    .finally(() => pending.delete(key));
  pending.set(key, task);
  queue = task.then(
    () => {},
    () => {},
  );
  return task;
}
