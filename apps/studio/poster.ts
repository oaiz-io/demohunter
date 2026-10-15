import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { loadBundle, atomicWrite, writeJson } from "./storage.js";
import { renderReplayFrame } from "./render.js";
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
