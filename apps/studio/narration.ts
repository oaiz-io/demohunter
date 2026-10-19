import { constants, existsSync } from "node:fs";
import { copyFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_DEMOHUNTER_CONFIG } from "@demohunter/sdk";
import { resolveNarrationSegment } from "../../packages/generator-playwright/src/narration/resolve-narration.js";
import {
  acquireLock,
  ensureRealFolders,
  loadBundle,
  mutateProject,
} from "./storage.js";
import { clipDuration, narrationRequestKey } from "./model.js";

export async function regenerateNarration(
  dir: string,
  options: {
    cacheDir?: string;
    fit?: boolean;
    segmentIds?: string[];
    resolve?: typeof resolveNarrationSegment;
    onProgress?: (message: string) => void;
  } = {},
): Promise<{ generated: number; skipped: number }> {
  // A crashed run's lock (dead pid, or silent for 30 s) is taken over.
  const lock = await acquireLock(path.join(dir, ".narration.lock"));
  if (!lock) throw new Error("Narration is already regenerating.");
  try {
    const initial = await loadBundle(dir);
    for (const id of options.segmentIds ?? [])
      if (!initial.narration.segments.some((s) => s.id === id))
        throw new Error(`Unknown narration segment: ${id}`);
    let generated = 0,
      skipped = 0;
    for (const segment of initial.narration.segments) {
      if (
        (options.segmentIds && !options.segmentIds.includes(segment.id)) ||
        !segment.text.trim() ||
        !initial.edits.clips.some((c) => c.id === segment.clipId)
      )
        continue;
      options.onProgress?.(`Resolving ${segment.id}`);
      const requestKey = narrationRequestKey(initial.project, segment);
      const resolved = await (options.resolve ?? resolveNarrationSegment)({
        event: {
          kind: "narrate",
          text: segment.text,
          voice: segment.voice,
          model: segment.model,
          instructions: segment.instructions,
          language: segment.language,
        },
        loadedConfig: {
          projectRoot: dir,
          configPath: path.join(dir, "project.json"),
          config: {
            ...DEFAULT_DEMOHUNTER_CONFIG,
            baseURL: "http://replay.invalid",
            outputDir: dir,
            cacheDir: options.cacheDir ?? defaultCacheDir(dir),
            tts: initial.project.tts,
          },
        },
      });
      // Provider formats name the cache file (".mp3_44100_128"); keep the
      // container so players and the browser recognise it.
      const extension =
        /^\.(mp3|wav|opus|ogg|aac|flac|pcm|m4a)/i.exec(path.extname(resolved.audioPath))?.[0].toLowerCase() ??
        ".mp3";
      // One file per segment, named for it so a single line is easy to find,
      // listen to or replace; export stitches them. The key keeps each take
      // distinct, so a stale file never shadows the current one.
      const name = `${safeName(segment.id)}-${resolved.cacheKey.slice(0, 12)}${extension}`;
      const audioPath = `audio/${name}`;
      await copyIntoFolder(
        resolved.audioPath,
        await ensureRealFolders(dir, "audio"),
        name,
      );
      // Merge just this result into the latest files. Never overwrite concurrent agent edits.
      await mutateProject(
        dir,
        undefined,
        `Regenerate ${segment.id}`,
        (latest) => {
          const current = latest.narration.segments.find(
            (s) => s.id === segment.id,
          );
          if (
            !current ||
            narrationRequestKey(latest.project, current) !== requestKey
          ) {
            skipped++;
            return;
          }
          current.audio = {
            path: audioPath,
            durationMs: resolved.durationMs,
            cacheKey: resolved.cacheKey,
            requestKey,
            origin: "provider",
          };
          generated++;
        },
      );
    }
    if (options.fit) {
      await mutateProject(dir, undefined, "Fit narration timing", (latest) => {
        for (const segment of latest.narration.segments) {
          if (options.segmentIds && !options.segmentIds.includes(segment.id))
            continue;
          if (
            !segment.audio ||
            segment.audio.requestKey !==
              narrationRequestKey(latest.project, segment)
          )
            continue;
          const clip = latest.edits.clips.find((c) => c.id === segment.clipId);
          const overrun = clip
            ? Math.max(
                0,
                segment.offsetMs +
                  segment.audio.durationMs +
                  250 -
                  clipDuration(clip),
              )
            : 0;
          if (clip?.kind === "scene") clip.durationMs += overrun;
          else if (clip) clip.holdMs += overrun;
        }
      });
    }
    return { generated, skipped };
  } finally {
    await lock.release();
  }
}
const safeName = (id: string) =>
  id.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 60) || "segment";
/** Copy to a fresh temp file beside the target, then rename into place. A
 * plain copyFile follows a symlink committed at the destination name and would
 * overwrite whatever it points to; rename replaces the link itself. */
async function copyIntoFolder(source: string, folder: string, name: string) {
  const temp = path.join(
    folder,
    `.${name}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    // COPYFILE_EXCL: fail rather than touch anything already at the temp name.
    await copyFile(source, temp, constants.COPYFILE_EXCL);
    await rename(temp, path.join(folder, name));
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}
/** The workspace's shared speech cache: `<root>/.demohunter/cache` for a
 * project at `<root>/.demohunter/replays/x`, not wherever the process runs. */
export function defaultCacheDir(projectDir: string): string {
  const resolved = path.resolve(projectDir);
  let current = resolved;
  for (;;) {
    if (path.basename(current) === ".demohunter")
      return path.join(current, "cache");
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // A demo saved elsewhere: share the repository's cache, never a folder
  // outside it (or "/" for shallow paths).
  for (let dir = resolved; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, ".git"))) return path.join(dir, ".demohunter", "cache");
    if (path.dirname(dir) === dir) break;
  }
  return path.join(resolved, ".demohunter", "cache");
}
