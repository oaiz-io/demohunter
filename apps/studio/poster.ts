import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { loadBundle, atomicWrite, writeJson } from "./storage.js";
import { openReplayRenderer, renderReplayFrame } from "./render.js";
import { clipStart, isScene, totalDuration } from "./model.js";

/** Derived images live in a per-user cache, never inside the project: a cloned
 * repository can commit `.studio/frames -> ~/Documents`, and a cache that
 * prunes or reads through that link would delete or serve the user's files. */
export function studioCacheRoot(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg
    ? xdg
    : process.platform === "darwin"
      ? path.join(homedir(), "Library", "Caches")
      : path.join(homedir(), ".cache");
  return path.join(base, "demohunter-studio");
}
/** The folder for one project's derived images (not created). */
export async function projectCacheFolder(dir: string): Promise<string> {
  const id = createHash("sha256").update(await realpath(dir)).digest("hex");
  return path.join(studioCacheRoot(), "frames", id.slice(0, 24));
}
async function ensureCacheFolder(dir: string): Promise<string> {
  const folder = await projectCacheFolder(dir);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const info = await lstat(folder);
  // Ours alone: a link, or a folder someone else owns, is not a cache.
  if (
    !info.isDirectory() ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error("Studio cache folder is not a private folder.");
  if ((info.mode & 0o077) !== 0) await chmod(folder, 0o700);
  return folder;
}
const FRAME_NAME = /^[0-9a-f]{16}-\d+\.png$/;
const MAX_CACHED_BYTES = 32 * 1024 * 1024;
/** A cached regular file, or undefined. Never follows a link. */
async function readCached(file: string): Promise<Buffer | undefined> {
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  ).catch(() => undefined);
  if (!handle) return undefined;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_CACHED_BYTES) return undefined;
    return await handle.readFile();
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}
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
    folder = await projectCacheFolder(dir);
  try {
    const cache = JSON.parse(
      (await readCached(path.join(folder, "poster.json")))?.toString("utf8") ?? "",
    );
    if (cache.revision === bundle.revision && cache.rendererVersion === 3) {
      const png = await readCached(path.join(folder, "poster.png"));
      if (png) return png;
    }
  } catch {}
  const existing = pending.get(dir);
  if (existing) return existing;
  const task = queue
    .catch(() => {})
    .then(async () => {
      const frame = await renderReplayFrame(dir, {
        outputMs: Math.min(posterTime(bundle), totalDuration(bundle.edits)),
      });
      // The cache is an optimisation: a failure to store must not fail the image.
      try {
        const store = await ensureCacheFolder(dir);
        await atomicWrite(path.join(store, "poster.png"), frame.bytes);
        await writeJson(path.join(store, "poster.json"), {
          revision: frame.revision,
          rendererVersion: 3,
        });
      } catch {}
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
    folder = await projectCacheFolder(dir),
    ms = Math.min(
      Math.floor(totalDuration(bundle.edits)),
      Math.max(0, Math.round(outputMs)),
    ),
    file = path.join(folder, `${bundle.revision}-${ms}.png`);
  const cached = await readCached(file);
  if (cached) return cached;
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
      try {
        const store = await ensureCacheFolder(dir);
        // Thumbnails for older revisions are disposable. Only plain files that
        // look like ours are removed; anything else in the folder is left be.
        for (const entry of await readdir(store, { withFileTypes: true }).catch(
          () => [],
        ))
          if (
            entry.isFile() &&
            FRAME_NAME.test(entry.name) &&
            !entry.name.startsWith(`${frame.revision}-`)
          )
            await unlink(path.join(store, entry.name)).catch(() => {});
        await atomicWrite(
          path.join(store, `${frame.revision}-${ms}.png`),
          frame.bytes,
        );
      } catch {}
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
