import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  lutimes,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { scenesTrusted } from "./trust.js";
import { loadBundle, atomicWrite, writeJson, RevisionConflict } from "./storage.js";
import {
  launchRenderBrowser,
  openReplayRenderer,
  type RenderBrowser,
} from "./render.js";
import { clipStart, isScene, totalDuration } from "./model.js";
import { frameKey, type ElementSpans } from "./frame-key.js";

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
  // Restricted renders (scene scripts off) are cached apart, so trusting a
  // folder re-renders its posters and thumbnails with scripts.
  const real = await realpath(dir);
  const id = createHash("sha256")
    .update(scenesTrusted(real) ? real : `${real}\0restricted`)
    .digest("hex");
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
/** Thumbnails are cached by visual key; the poster has its own file. */
const FRAME_NAME = /^[0-9a-f]{24}\.jpg$/;
/** Thumbnails from before visual keys (revision and time, PNG). */
const OLD_FRAME_NAME = /^[0-9a-f]{16}-\d+\.png$/;
const MAX_CACHED_BYTES = 32 * 1024 * 1024;
/** Size bound of one project's thumbnail cache; least recently used go. */
const FRAME_CACHE_BYTES = 24 * 1024 * 1024,
  FRAME_CACHE_FILES = 600;
/** Thumbnail width in pixels; the timeline shows them in a small box. */
export const THUMB_WIDTH = 320;
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
/** Keep the most recently used thumbnails within the size bound. Only plain
 * files that look like ours are removed; anything else is left be. */
export async function pruneFrames(folder: string): Promise<void> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const files: { name: string; size: number; used: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (OLD_FRAME_NAME.test(entry.name)) {
      await unlink(path.join(folder, entry.name)).catch(() => {});
      continue;
    }
    if (!FRAME_NAME.test(entry.name)) continue;
    const info = await lstat(path.join(folder, entry.name)).catch(() => undefined);
    if (info?.isFile())
      files.push({ name: entry.name, size: info.size, used: info.mtimeMs });
  }
  files.sort((a, b) => b.used - a.used);
  let bytes = 0;
  for (const [i, file] of files.entries()) {
    bytes += file.size;
    if (i >= FRAME_CACHE_FILES || bytes > FRAME_CACHE_BYTES)
      await unlink(path.join(folder, file.name)).catch(() => {});
  }
}
const writesSincePrune = new Map<string, number>();
/** Store a thumbnail. Prune on the first write of a process and then every
 * 50 writes, not on each one. */
async function storeFrame(dir: string, name: string, bytes: Buffer) {
  const store = await ensureCacheFolder(dir);
  await atomicWrite(path.join(store, name), bytes);
  const writes = writesSincePrune.get(store);
  if (writes === undefined || writes >= 50) {
    writesSincePrune.set(store, 1);
    await pruneFrames(store);
  } else writesSincePrune.set(store, writes + 1);
}

// Derived work is bounded globally, with one in-flight render per image.
let queue = Promise.resolve();
const pending = new Map<string, Promise<Buffer>>();
/** Run on the shared queue, after the work that is already there. */
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const task = queue.catch(() => {}).then(work);
  queue = task.then(
    () => {},
    () => {},
  );
  return task;
}

/**
 * One long-lived Chromium for posters, thumbnails and screenshots. Each
 * project gets one page per kind: thumbnails render at a small device scale
 * (about THUMB_WIDTH pixels wide, at the full layout size), posters and
 * screenshots at full size. An edit reloads the page; it does not start a
 * browser. Idle pages close after PAGE_IDLE_MS, and the browser closes
 * BROWSER_IDLE_MS after its last page.
 */
const PAGE_IDLE_MS = 60_000,
  BROWSER_IDLE_MS = 30_000,
  MAX_PAGES = 4;
type Renderer = Awaited<ReturnType<typeof openReplayRenderer>>;
type Warm = {
  key: string;
  renderer: Renderer;
  width: number;
  idle?: ReturnType<typeof setTimeout>;
};
const warmPages = new Map<string, Warm>();
let browser: Promise<RenderBrowser> | undefined,
  browserIdle: ReturnType<typeof setTimeout> | undefined;
const unref = (timer: unknown) => (timer as { unref?: () => void }).unref?.();
function sharedBrowser(): Promise<RenderBrowser> {
  clearTimeout(browserIdle);
  if (!browser) {
    const launching = launchRenderBrowser();
    browser = launching;
    launching.then(
      (b) =>
        b.on("disconnected", () => {
          if (browser !== launching) return;
          browser = undefined;
          for (const w of warmPages.values()) clearTimeout(w.idle);
          warmPages.clear();
        }),
      () => {
        if (browser === launching) browser = undefined;
      },
    );
  }
  return browser;
}
function idleLater(w: Warm) {
  clearTimeout(w.idle);
  w.idle = setTimeout(() => void closePage(w), PAGE_IDLE_MS);
  unref(w.idle);
}
async function closePage(w: Warm) {
  clearTimeout(w.idle);
  if (warmPages.get(w.key) === w) warmPages.delete(w.key);
  await w.renderer.close().catch(() => {});
  if (!warmPages.size && browser) {
    clearTimeout(browserIdle);
    browserIdle = setTimeout(() => {
      if (warmPages.size) return;
      const current = browser;
      browser = undefined;
      void current?.then((b) => b.close()).catch(() => {});
    }, BROWSER_IDLE_MS);
    unref(browserIdle);
  }
}
/** Close every warm page and the browser (service shutdown, tests). */
export async function closeWarmRenderers(): Promise<void> {
  await Promise.all([...warmPages.values()].map(closePage));
  clearTimeout(browserIdle);
  const current = browser;
  browser = undefined;
  await current?.then((b) => b.close()).catch(() => {});
}
function withTimeout<T>(work: Promise<T>, ms: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
/** A warm page for this project and kind, on the current revision. */
async function warmPage(dir: string, kind: "thumb" | "full"): Promise<Warm> {
  // Restricted renders (scene scripts off) never share a page with trusted ones.
  const key = `${dir}\0${kind}\0${scenesTrusted(dir)}`;
  const { revision, project } = await loadBundle(dir);
  let w = warmPages.get(key);
  if (w && project.viewport.width !== w.width) {
    await closePage(w);
    w = undefined;
  } else if (w && revision !== w.renderer.bundle.revision) {
    try {
      await withTimeout(w.renderer.reload(), 60_000, "Frame renderer did not reload.");
    } catch {
      await closePage(w);
      w = undefined;
    }
  }
  if (w) return w;
  // A renderer that never starts must not stall the shared queue.
  const opening = sharedBrowser().then((b) =>
    openReplayRenderer(dir, undefined, {
      browser: b,
      deviceScaleFactor:
        kind === "thumb" ? Math.min(1, THUMB_WIDTH / project.viewport.width) : 1,
    }),
  );
  let renderer: Renderer;
  try {
    renderer = await withTimeout(opening, 60_000, "Frame renderer did not start.");
  } catch (error) {
    void opening.then(
      (late) => late.close().catch(() => {}),
      () => {},
    );
    throw error;
  }
  const fresh: Warm = { key, renderer, width: renderer.bundle.project.viewport.width };
  warmPages.set(key, fresh);
  // Least recently opened first: keep at most MAX_PAGES.
  for (const other of [...warmPages.values()].slice(0, Math.max(0, warmPages.size - MAX_PAGES)))
    if (other !== fresh) await closePage(other);
  return fresh;
}
/** One frame from a warm page; call inside the shared queue. Without an
 * expected revision, a project that changes mid-render is rendered again. */
async function warmFrame(
  dir: string,
  kind: "thumb" | "full",
  ms: number,
  shot: { format?: "png" | "jpeg"; quality?: number },
  expectedRevision?: string,
): Promise<{ bytes: Buffer; bundle: Renderer["bundle"] }> {
  for (let attempt = 0; ; attempt++) {
    const w = await warmPage(dir, kind);
    clearTimeout(w.idle);
    try {
      if (expectedRevision && w.renderer.bundle.revision !== expectedRevision)
        throw new RevisionConflict("The project changed before rendering.");
      const bytes = await withTimeout(
        w.renderer.frame(ms, shot),
        30_000,
        "Frame render timed out.",
      );
      await w.renderer.checkRevision();
      idleLater(w);
      return { bytes, bundle: w.renderer.bundle };
    } catch (error) {
      if ((error as { status?: number }).status !== 409) {
        await closePage(w);
        throw error;
      }
      // A revision conflict leaves the page fine; the next call reloads it.
      idleLater(w);
      if (expectedRevision || attempt >= 2) throw error;
    }
  }
}
/** Size and mtime of the capture files: a recapture changes every key. */
async function captureStamp(dir: string) {
  return (
    await Promise.all(
      ["capture.dhcapture", "events.json"].map((name) =>
        lstat(path.join(dir, name))
          .then((s) => `${s.size}:${s.mtimeMs}`)
          .catch(() => "-"),
      ),
    )
  ).join("|");
}

/** The library poster: the first recorded frame, not a title card's blank
 * first frame. A film without recording clips shows the middle of its first
 * scene. */
function posterTime(bundle: Awaited<ReturnType<typeof loadBundle>>) {
  const { edits } = bundle;
  const first = edits.clips[0];
  if (!first || !isScene(first)) return 0;
  const clip = edits.clips.find((c) => !isScene(c));
  return clip
    ? (clipStart(edits, clip.id) ?? 0) + 500
    : Math.round(first.durationMs / 2);
}
const posterAt = (bundle: Awaited<ReturnType<typeof loadBundle>>) =>
  Math.min(posterTime(bundle), totalDuration(bundle.edits));
const POSTER_RENDERER_VERSION = 4;
/** The poster.json record that matches the project as it is now (tests seed
 * the cache with it). */
export async function posterCacheRecord(dir: string) {
  const bundle = await loadBundle(dir);
  return {
    key: frameKey(bundle, posterAt(bundle), {
      kind: "poster",
      stamp: await captureStamp(dir),
    }),
    rendererVersion: POSTER_RENDERER_VERSION,
  };
}
export async function projectPoster(dir: string): Promise<Buffer> {
  const bundle = await loadBundle(dir),
    folder = await projectCacheFolder(dir),
    stamp = await captureStamp(dir);
  // A comment or narration edit keeps the poster; a visual change renders it.
  const key = frameKey(bundle, posterAt(bundle), { kind: "poster", stamp });
  try {
    const cache = JSON.parse(
      (await readCached(path.join(folder, "poster.json")))?.toString("utf8") ?? "",
    );
    if (cache.key === key && cache.rendererVersion === POSTER_RENDERER_VERSION) {
      const png = await readCached(path.join(folder, "poster.png"));
      if (png) return png;
    }
  } catch {}
  const id = `${dir}#poster#${key}`;
  const existing = pending.get(id);
  if (existing) return existing;
  const task = enqueue(async () => {
    const frame = await warmFrame(dir, "full", posterAt(bundle), {});
    // The cache is an optimisation: a failure to store must not fail the image.
    try {
      const store = await ensureCacheFolder(dir);
      await atomicWrite(path.join(store, "poster.png"), frame.bytes);
      await writeJson(path.join(store, "poster.json"), {
        // The key of what was rendered (the project may have changed since).
        key: frameKey(frame.bundle, posterAt(frame.bundle), { kind: "poster", stamp }),
        rendererVersion: POSTER_RENDERER_VERSION,
      });
    } catch {}
    return frame.bytes;
  }).finally(() => pending.delete(id));
  pending.set(id, task);
  return task;
}
/** A cached frame of the edited timeline, e.g. a scene thumbnail: a small
 * JPEG, cached by what it shows (see frameKey), so an edit renders again only
 * the frames it can change. Shares the global render queue so thumbnails never
 * compete with exports for Chromium.
 *
 * `spans` (from the element index) lets an element edit keep the frames where
 * its element is not on the page. `signal`: the request went away, so a
 * render that has not started yet is skipped. */
export async function projectFrame(
  dir: string,
  outputMs: number,
  options: { spans?: ElementSpans; signal?: AbortSignal } = {},
): Promise<{ bytes: Buffer; revision: string }> {
  const bundle = await loadBundle(dir),
    folder = await projectCacheFolder(dir),
    stamp = await captureStamp(dir);
  const at = (b: typeof bundle) =>
    Math.min(Math.floor(totalDuration(b.edits)), Math.max(0, Math.round(outputMs)));
  const keyOf = (b: typeof bundle) =>
    frameKey(b, at(b), { kind: "thumb", spans: options.spans, stamp });
  const key = keyOf(bundle),
    file = path.join(folder, `${key}.jpg`);
  const cached = await readCached(file);
  if (cached) {
    // Most recently used: kept longest when the cache is full.
    const now = new Date();
    void lutimes(file, now, now).catch(() => {});
    return { bytes: cached, revision: bundle.revision };
  }
  const id = `${dir}#${key}`;
  let entry = framesPending.get(id);
  if (!entry) {
    const signals = new Set<AbortSignal | undefined>();
    const task = enqueue(async () => {
      // Every request for this frame went away: skip the render.
      if ([...signals].every((s) => s?.aborted))
        throw new Error("Frame request was cancelled.");
      const frame = await warmFrame(dir, "thumb", at(bundle), {
        format: "jpeg",
        quality: 80,
      });
      // Stored under the key of what was rendered.
      try {
        await storeFrame(dir, `${keyOf(frame.bundle)}.jpg`, frame.bytes);
      } catch {}
      return { bytes: frame.bytes, revision: frame.bundle.revision };
    }).finally(() => framesPending.delete(id));
    entry = { task, signals };
    framesPending.set(id, entry);
  }
  entry.signals.add(options.signal);
  return entry.task;
}
const framesPending = new Map<
  string,
  {
    task: Promise<{ bytes: Buffer; revision: string }>;
    signals: Set<AbortSignal | undefined>;
  }
>();
/** A full-size PNG of the edited timeline from the warm renderer, not cached
 * (MCP `get_screenshot` through the running Studio service). */
export function projectScreenshot(
  dir: string,
  outputMs: number,
  expectedRevision?: string,
): Promise<{ bytes: Buffer; revision: string; outputMs: number }> {
  return enqueue(async () => {
    const bundle = await loadBundle(dir);
    if (expectedRevision && bundle.revision !== expectedRevision)
      throw new RevisionConflict("The project changed before rendering.");
    if (
      !Number.isFinite(outputMs) ||
      outputMs < 0 ||
      outputMs > totalDuration(bundle.edits)
    )
      throw new Error("Frame time is outside the edited timeline.");
    const frame = await warmFrame(dir, "full", outputMs, {}, expectedRevision);
    return { bytes: frame.bytes, revision: frame.bundle.revision, outputMs };
  });
}
