import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { openReplayRenderer } from "./render.js";
import { audioIsCurrent, narrationStart, totalDuration } from "./model.js";
import { readFormat } from "./format.js";
import { safeFile, writeJson } from "./storage.js";
export async function exportReplay(
  dir: string,
  out: string,
  options: {
    fps?: number;
    expectedRevision?: string;
    strictAudio?: boolean;
    onProgress?: (message: string) => void;
  } = {},
) {
  const fps = options.fps ?? 24;
  if (!Number.isInteger(fps) || fps < 1 || fps > 60)
    throw new Error("FPS must be an integer from 1 to 60.");
  const destination = path.resolve(out);
  await mkdir(path.dirname(destination), { recursive: true });
  // New destination only: failed renders cannot replace a previous good artifact.
  try {
    await import("node:fs/promises").then((fs) => fs.access(destination));
    throw new Error(
      "Export destination already exists. Choose a new directory.",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const renderer = await openReplayRenderer(dir, options.expectedRevision);
  let stage: string;
  try {
    stage = await mkdtemp(
      path.join(path.dirname(destination), ".studio-export-"),
    );
  } catch (error) {
    await renderer.close();
    throw error;
  }
  let published = false;
  try {
    const { bundle } = renderer,
      durationMs = totalDuration(bundle.edits),
      frames = Math.ceil((durationMs * fps) / 1000),
      duration = frames / fps;
    const missing = bundle.narration.segments.filter(
      (s) =>
        s.text.trim() &&
        narrationStart(bundle.edits, s) !== undefined &&
        !audioIsCurrent(bundle.project, s),
    );
    if (options.strictAudio && missing.length)
      throw new Error(
        `Audio is draft or stale: ${missing.map((s) => s.id).join(", ")}. Regenerate narration or omit --strict-audio.`,
      );
    const video = path.join(stage, "silent.mp4");
    const encoder = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "image2pipe",
        "-vcodec",
        "png",
        "-framerate",
        String(fps),
        "-i",
        "pipe:0",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-vf",
        "pad=ceil(iw/2)*2:ceil(ih/2)*2",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-y",
        video,
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    let errorText = "";
    encoder.stderr.on("data", (d) => {
      errorText = (errorText + d.toString()).slice(-4000);
    });
    encoder.stdin.on("error", () => {});
    const completed = new Promise<void>((resolve, reject) => {
      encoder.once("error", reject);
      encoder.once("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(errorText || `Encoder exited ${code}`)),
      );
    });
    completed.catch(() => {});
    try {
      for (let i = 0; i < frames; i++) {
        if (i % fps === 0) {
          await renderer.checkRevision();
          options.onProgress?.(
            `Rendering ${Math.floor(i / fps)}s / ${Math.ceil(duration)}s`,
          );
        }
        const bytes = await renderer.frame(
          Math.min(durationMs, (i * 1000) / fps),
        );
        if (!encoder.stdin.write(bytes))
          await Promise.race([
            once(encoder.stdin, "drain"),
            completed.then(() => {
              throw new Error("Encoder closed early");
            }),
          ]);
      }
      encoder.stdin.end();
      await completed;
    } catch (error) {
      encoder.kill("SIGTERM");
      await completed.catch(() => {});
      throw error;
    }
    const segments = bundle.narration.segments.filter(
      (s) =>
        audioIsCurrent(bundle.project, s) &&
        narrationStart(bundle.edits, s) !== undefined,
    );
    const args = ["-hide_banner", "-loglevel", "error", "-i", video];
    for (const s of segments)
      args.push("-i", await safeFile(dir, s.audio!.path));
    if (segments.length) {
      const filters = segments.map(
        (s, i) =>
          `[${i + 1}:a]adelay=${Math.round(narrationStart(bundle.edits, s)!)}:all=1[a${i}]`,
      );
      filters.push(
        `${segments.map((_, i) => `[a${i}]`).join("")}amix=inputs=${segments.length}:normalize=0,alimiter=limit=0.95:level=0,apad[mix]`,
      );
      args.push(
        "-filter_complex",
        filters.join(";"),
        "-map",
        "0:v",
        "-map",
        "[mix]",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-t",
        String(duration),
        "-movflags",
        "+faststart",
        path.join(stage, "video.mp4"),
      );
      await run(args);
    } else await rename(video, path.join(stage, "video.mp4"));
    if (segments.length) await rm(video);
    const cues = bundle.narration.segments.flatMap((s) => {
      const start = narrationStart(bundle.edits, s);
      if (start === undefined) return [];
      const end = Math.min(
        durationMs,
        start +
          (s.audio && audioIsCurrent(bundle.project, s)
            ? s.audio.durationMs
            : Math.max(1500, s.text.length * 45)),
      );
      return end > start
        ? [{ id: s.id, startMs: start, endMs: end, text: s.text }]
        : [];
    });
    await writeFile(
      path.join(stage, "captions.vtt"),
      "WEBVTT\n\n" +
        cues
          .map(
            (c, i) =>
              `${i + 1}\n${stamp(c.startMs)} --> ${stamp(c.endMs)}\n${c.text.replaceAll("-->", "→").replaceAll("<", "&lt;")}\n`,
          )
          .join("\n"),
    );
    await writeJson(path.join(stage, "captions.json"), cues);
    const files = await Promise.all(
      ["video.mp4", "captions.vtt", "captions.json"].map(async (file) => {
        const bytes = await readFile(path.join(stage, file));
        return {
          path: file,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      }),
    );
    await renderer.checkRevision();
    const identity = await readFormat(dir);
    const manifest = {
      format: "demohunter.studio.export",
      formatVersion: 1,
      sourceRevision: bundle.revision,
      sourceProjectId: identity?.projectId,
      captureId: identity?.captureId,
      viewport: {
        width:
          bundle.project.viewport.width + (bundle.project.viewport.width % 2),
        height:
          bundle.project.viewport.height + (bundle.project.viewport.height % 2),
      },
      title: bundle.project.title,
      fps,
      durationMs: Math.round(duration * 1000),
      omittedAudio: missing.map((s) => s.id),
      files,
    };
    await writeJson(path.join(stage, "manifest.json"), manifest);
    await rename(stage, destination);
    published = true;
    return { directory: destination, ...manifest };
  } finally {
    await renderer.close();
    if (!published) await rm(stage, { recursive: true, force: true });
  }
}
function stamp(ms: number) {
  return `${Math.floor(ms / 3600000)
    .toString()
    .padStart(2, "0")}:${Math.floor((ms / 60000) % 60)
    .toString()
    .padStart(2, "0")}:${((ms / 1000) % 60).toFixed(3).padStart(6, "0")}`;
}
async function run(args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let text = "";
    child.stderr.on("data", (d) => (text = (text + d).slice(-4000)));
    child.once("error", reject);
    child.once("close", (c) => (c === 0 ? resolve() : reject(new Error(text))));
  });
}
