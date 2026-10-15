import { mkdir, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { loadBundle, atomicWrite, writeJson } from "./storage.js";
import { renderReplayFrame } from "./render.js";
import { totalDuration } from "./model.js";
// Derived work is bounded globally, with one in-flight render per project.
let queue = Promise.resolve();
const pending = new Map<string, Promise<Buffer>>();
export async function projectPoster(dir: string): Promise<Buffer> {
  const bundle = await loadBundle(dir),
    folder = path.join(dir, ".studio");
  try {
    const cache = JSON.parse(
      await readFile(path.join(folder, "poster.json"), "utf8"),
    );
    if (cache.revision === bundle.revision && cache.rendererVersion === 2)
      return await readFile(path.join(folder, "poster.png"));
  } catch {}
  const existing = pending.get(dir);
  if (existing) return existing;
  const task = queue
    .catch(() => {})
    .then(async () => {
      const frame = await renderReplayFrame(dir, { outputMs: 0 });
      await mkdir(folder, { recursive: true });
      await atomicWrite(path.join(folder, "poster.png"), frame.bytes);
      await writeJson(path.join(folder, "poster.json"), {
        revision: frame.revision,
        rendererVersion: 2,
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
      const frame = await renderReplayFrame(dir, { outputMs: ms });
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
