import { copyFile, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_DEMOHUNTER_CONFIG } from "@demohunter/sdk";
import { resolveNarrationSegment } from "../../packages/generator-playwright/src/narration/resolve-narration.js";
import { loadBundle, mutateProject } from "./storage.js";
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
  const lockPath = path.join(dir, ".narration.lock");
  const lock = await open(lockPath, "wx").catch(() => {
    throw new Error(
      "Narration is already regenerating. If a previous process crashed, remove .narration.lock and retry.",
    );
  });
  try {
    await lock.writeFile(String(process.pid));
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
            cacheDir: options.cacheDir ?? path.resolve(".demohunter/cache"),
            tts: initial.project.tts,
          },
        },
      });
      const extension = path.extname(resolved.audioPath) || ".mp3";
      const audioPath = `audio/${resolved.cacheKey}${extension}`;
      await mkdir(path.join(dir, "audio"), { recursive: true });
      await copyFile(resolved.audioPath, path.join(dir, audioPath));
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
    await lock.close();
    await unlink(lockPath);
  }
}
