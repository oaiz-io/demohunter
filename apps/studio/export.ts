import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { cpus } from "node:os";
import { createHash } from "node:crypto";
import { openReplayRenderer } from "./render.js";
import {
  audioIsCurrent,
  outputToSource,
  sceneAt,
  musicGain,
  narrationStart,
  totalDuration,
  voiceSpans,
} from "./model.js";
import { readFormat } from "./format.js";
import { safeFile, writeJson } from "./storage.js";
export async function exportReplay(
  dir: string,
  out: string,
  options: {
    fps?: number;
    expectedRevision?: string;
    strictAudio?: boolean;
    /** Integrated loudness target: −16 LUFS default, −14 for YouTube. */
    lufs?: number;
    /** x264 quality (lower is better): 18 default, 14–16 for publishing. */
    crf?: number;
    /** Parallel render workers (browsers); default depends on CPU count. */
    workers?: number;
    onProgress?: (message: string) => void;
  } = {},
) {
  const lufs = options.lufs ?? -16;
  const crf = options.crf ?? 18;
  if (!Number.isFinite(lufs) || lufs < -30 || lufs > -9)
    throw new Error("Loudness must be between -30 and -9 LUFS.");
  if (!Number.isInteger(crf) || crf < 0 || crf > 40)
    throw new Error("CRF must be an integer from 0 to 40.");
  const fps = options.fps ?? 24;
  if (!Number.isInteger(fps) || fps < 1 || fps > 60)
    throw new Error("FPS must be an integer from 1 to 60.");
  // Fail before rendering anything when ffmpeg is missing.
  await run(["-hide_banner", "-version"]);
  const destination = path.resolve(out);
  await mkdir(path.dirname(destination), { recursive: true });
  // New destination only: failed renders cannot replace a previous good artifact.
  try {
    await access(destination);
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
    // A missing music or sound file would only surface after the whole render.
    for (const src of new Set(
      [
        ...(bundle.edits.audio?.music ?? []),
        ...(bundle.edits.audio?.sfx ?? []),
      ].map((a) => a.src),
    ))
      await safeFile(dir, src)
        .then((file) => access(file))
        .catch((error) => {
          if (String(error?.message).includes("outside")) throw error;
          throw new Error(
            `Audio file ${src} is missing from the demo. Add it to the audio/ folder or remove it from the timeline, then export again.`,
          );
        });
    // Prepare the audio mix while the frames render; only the mux waits.
    const audioReady = (async () => {
      const segments = bundle.narration.segments.filter(
        (s) =>
          audioIsCurrent(bundle.project, s) &&
          narrationStart(bundle.edits, s) !== undefined,
      );
      const music = bundle.edits.audio?.music ?? [];
      const effects = [
        ...(bundle.edits.audio?.sfx ?? []),
        ...(await renderer.sceneCues()),
      ];
      if (!(segments.length || music.length || effects.length))
        return undefined;
      // Mix in memory so preview and export share one gain model, then
      // normalise loudness for sharing (−16 LUFS, −1.5 dBTP).
      const mix = new Float32Array(Math.ceil(duration * RATE) * 2);
      // Decode every file once, in parallel (cue sounds repeat a lot).
      const pcm = new Map<string, Promise<Float32Array>>();
      const load = (src: string) => {
        if (!pcm.has(src))
          pcm.set(
            src,
            safeFile(dir, src).then((file) => decode(file)),
          );
        return pcm.get(src)!;
      };
      for (const src of new Set([
        ...segments.map((s) => s.audio!.path),
        ...music.map((m) => m.src),
        ...effects.map((e) => e.src),
      ]))
        void load(src).catch(() => {});
      for (const s of segments)
        addAt(
          mix,
          await load(s.audio!.path),
          narrationStart(bundle.edits, s)!,
          () => 1,
        );
      const voice = voiceSpans(bundle);
      for (const bed of music) {
        const track = await load(bed.src);
        addAt(
          mix,
          track.subarray(Math.round((bed.offsetMs / 1000) * RATE) * 2),
          bed.startMs,
          (ms) => musicGain(bed, ms, durationMs, voice),
        );
      }
      for (const effect of effects)
        addAt(mix, await load(effect.src), effect.atMs, () => effect.volume);
      const raw = path.join(stage, "mix.f32");
      const input = ["-f", "f32le", "-ar", String(RATE), "-ac", "2", "-i", raw];
      // Loudness: measure EBU R128 once (fast), apply the exact gain, and
      // limit true peaks only if the gain pushes them past −1.5 dBTP.
      // (ffmpeg's loudnorm oversamples to 192 kHz and needs two passes.)
      await writeFile(raw, new Uint8Array(mix.buffer));
      const report = await run(
        [
          "-hide_banner",
          "-nostats",
          ...input,
          "-af",
          "ebur128=peak=true",
          "-f",
          "null",
          "-",
        ],
        true,
      );
      const summary = report.slice(report.lastIndexOf("Summary:"));
      const integrated = Number(/I:\s*(-?[\d.]+) LUFS/.exec(summary)?.[1]);
      const peak = Number(/Peak:\s*(-?[\d.inf]+) dBFS/.exec(summary)?.[1]);
      let limiter = "";
      if (Number.isFinite(integrated)) {
        const gainDb = lufs - integrated;
        const gain = Math.pow(10, gainDb / 20);
        for (let i = 0; i < mix.length; i++) mix[i]! *= gain;
        await writeFile(raw, new Uint8Array(mix.buffer));
        if (!Number.isFinite(peak) || peak + gainDb > -1.5) {
          limiter = `alimiter=limit=${Math.pow(10, -2 / 20).toFixed(4)}:attack=3:release=60:level=false,`;
          // Limiting lowers loudness a little; measure once more and make
          // up the difference so the export lands on the target.
          const after = await run(
            [
              "-hide_banner",
              "-nostats",
              ...input,
              "-af",
              `${limiter}ebur128`,
              "-f",
              "null",
              "-",
            ],
            true,
          );
          const limited = Number(
            /I:\s*(-?[\d.]+) LUFS/.exec(
              after.slice(after.lastIndexOf("Summary:")),
            )?.[1],
          );
          if (Number.isFinite(limited) && Math.abs(lufs - limited) > 0.05) {
            const makeUp = Math.pow(10, (lufs - limited) / 20);
            for (let i = 0; i < mix.length; i++) mix[i]! *= makeUp;
            await writeFile(raw, new Uint8Array(mix.buffer));
          }
        }
      }
      return { input, limiter, raw };
    })();
    audioReady.catch(() => {});
    // Render contiguous ranges in parallel (one browser each), encode each
    // range to its own segment, then join them without re-encoding. JPEG
    // frames are ~2.5× cheaper to capture than PNG; quality is set high
    // enough that x264 sees no difference.
    const video = path.join(stage, "silent.mp4");
    const workers = Math.max(
      1,
      Math.min(
        options.workers ?? defaultWorkers(),
        Math.ceil(frames / (fps * 3)),
      ),
    );
    const quality = crf < 18 ? 95 : 90;
    const videoCodec = [
      "-c:v",
      "libx264",
      "-preset",
      crf < 18 ? "fast" : "veryfast",
      "-crf",
      String(crf),
    ];
    // Every extra browser is tracked from the moment it starts opening, so
    // one that is still starting when another worker fails is closed too.
    const extra: Promise<Awaited<ReturnType<typeof openReplayRenderer>>>[] = [];
    let done = 0,
      failed: unknown;
    const progress = setInterval(
      () =>
        options.onProgress?.(
          `Rendering ${Math.floor(done / fps)}s / ${Math.ceil(duration)}s${workers > 1 ? ` (${workers} workers)` : ""}`,
        ),
      1000,
    );
    try {
      // Small chunks from a shared queue keep every worker busy: some
      // stretches (blurred backdrops, dense scenes) render slower than others.
      const size = Math.max(fps, Math.ceil(frames / (workers * 8)));
      const chunks = Array.from(
        { length: Math.ceil(frames / size) },
        (_, i) => [i * size, Math.min(frames, (i + 1) * size)],
      );
      const parts: string[] = new Array(chunks.length);
      let next = 0;
      const work = async (
        r: Awaited<ReturnType<typeof openReplayRenderer>>,
      ) => {
        while (next < chunks.length) {
          const index = next++;
          const [first, last] = chunks[index]!;
          parts[index] = await encodeRange(
            r,
            first!,
            last!,
            path.join(stage, `part-${String(index).padStart(4, "0")}.mp4`),
          ).catch((error) => {
            failed ??= error;
            throw error;
          });
        }
      };
      // Each extra browser joins the queue as soon as it is up.
      await Promise.all([
        work(renderer),
        ...Array.from({ length: workers - 1 }, async () => {
          if (next >= chunks.length) return;
          const opening = openReplayRenderer(dir, bundle.revision);
          extra.push(opening);
          await work(await opening);
        }),
      ]);
      if (parts.length === 1) await rename(parts[0]!, video);
      else {
        const list = path.join(stage, "parts.txt");
        // concat-list syntax: a quote inside a name is written '\''.
        await writeFile(
          list,
          parts.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join("\n"),
        );
        await run([
          "-hide_banner",
          "-loglevel",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          list,
          "-c",
          "copy",
          "-movflags",
          "+faststart",
          video,
        ]);
        await Promise.all([...parts, list].map((p) => rm(p)));
      }
    } finally {
      clearInterval(progress);
      await Promise.all(extra.map((r) => r.then((x) => x.close(), () => {})));
    }
    /** Whether nothing on screen can change between two output times. */
    function still(a: number, b: number): boolean {
      const { edits } = bundle;
      const during = (e: { startMs: number; endMs: number }) =>
        e.startMs <= b && e.endMs >= a;
      return (
        !sceneAt(edits, a) &&
        !sceneAt(edits, b) &&
        !(edits.overlays ?? []).some(during) &&
        !edits.camera.some(during) &&
        !edits.highlights.some(during) &&
        !(edits.animations ?? []).some(
          (e) => during(e) || (e.fill === "forwards" && e.startMs <= b),
        ) &&
        outputToSource(edits, a) === outputToSource(edits, b)
      );
    }
    async function encodeRange(
      r: Awaited<ReturnType<typeof openReplayRenderer>>,
      first: number,
      last: number,
      file: string,
    ): Promise<string> {
      const encoder = spawn(
        FFMPEG,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "image2pipe",
          "-vcodec",
          "mjpeg",
          "-framerate",
          String(fps),
          "-i",
          "pipe:0",
          "-an",
          ...videoCodec,
          "-vf",
          "pad=ceil(iw/2)*2:ceil(ih/2)*2",
          "-pix_fmt",
          "yuv420p",
          "-y",
          file,
        ],
        { stdio: ["pipe", "ignore", "pipe"] },
      );
      let errorText = "";
      encoder.stderr.on("data", (d) => {
        errorText = (errorText + d.toString()).slice(-4000);
      });
      encoder.stdin.on("error", () => {});
      const completed = new Promise<void>((resolve, reject) => {
        encoder.once("error", (e) => reject(ffmpegError(e)));
        encoder.once("close", (code) =>
          code === 0
            ? resolve()
            : reject(new Error(errorText || `Encoder exited ${code}`)),
        );
      });
      completed.catch(() => {});
      try {
        let previous: Uint8Array | undefined;
        for (let i = first; i < last; i++) {
          if (failed) throw failed;
          if ((i - first) % fps === 0) await r.checkRevision();
          const time = Math.min(durationMs, (i * 1000) / fps);
          // Held frames with nothing animating are identical: reuse them.
          const bytes =
            previous && still(time - 1000 / fps, time)
              ? previous
              : await r.frame(time, { format: "jpeg", quality });
          previous = bytes;
          if (!encoder.stdin.write(bytes))
            await Promise.race([
              once(encoder.stdin, "drain"),
              completed.then(() => {
                throw new Error("Encoder closed early");
              }),
            ]);
          done++;
        }
        encoder.stdin.end();
        await completed;
        return file;
      } catch (error) {
        encoder.kill("SIGTERM");
        await completed.catch(() => {});
        throw error;
      }
    }
    const audio = await audioReady;
    if (audio) {
      options.onProgress?.("Mixing audio");
      const { input, limiter, raw } = audio;
      await run([
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        video,
        ...input,
        "-filter_complex",
        `[1:a]${limiter}aresample=${RATE},apad[mix]`,
        "-map",
        "0:v",
        "-map",
        "[mix]",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        crf < 18 ? "384k" : "192k",
        "-t",
        String(duration),
        "-movflags",
        "+faststart",
        path.join(stage, "video.mp4"),
      ]);
      await rm(video);
      await rm(raw);
    } else await rename(video, path.join(stage, "video.mp4"));
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
              `${i + 1}\n${stamp(c.startMs)} --> ${stamp(c.endMs)}\n${cueText(c.text)}\n`,
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
/** WebVTT cue text: a blank line would end the cue, `&` and `<` are markup. */
export function cueText(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll("-->", "→")
    .replace(/\r\n?/g, "\n")
    .replace(/\n(?:[ \t]*\n)+/g, "\n");
}
/** HH:MM:SS.mmm from whole milliseconds, so 59.9996 s never prints 60.000. */
export function stamp(ms: number) {
  const total = Math.round(ms);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(Math.floor(total / 3600000))}:${pad(Math.floor(total / 60000) % 60)}:${pad(Math.floor(total / 1000) % 60)}.${pad(total % 1000, 3)}`;
}
const RATE = 48000;
/** ffmpeg from PATH, or FFMPEG_PATH. */
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
/** A missing ffmpeg says what to do instead of "spawn ffmpeg ENOENT". */
function ffmpegError(error: NodeJS.ErrnoException): Error {
  return error.code === "ENOENT"
    ? new Error(
        "Export needs ffmpeg. Install it (macOS: `brew install ffmpeg`) or set FFMPEG_PATH, then export again.",
      )
    : error;
}
/** About one render browser per four cores, at most four. */
function defaultWorkers(): number {
  return Math.max(1, Math.min(4, Math.floor(cpus().length / 4)));
}
/** Runs ffmpeg; resolves with the tail of stderr (loudnorm prints there). */
async function run(args: string[], keepLog = false): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(FFMPEG, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let text = "";
    child.stderr.on(
      "data",
      (d) => (text = (text + d).slice(keepLog ? -20000 : -4000)),
    );
    child.once("error", (e) => reject(ffmpegError(e)));
    child.once("close", (c) =>
      c === 0 ? resolve(text) : reject(new Error(text)),
    );
  });
}
/** Any audio file → interleaved stereo float PCM at RATE. */
async function decode(file: string): Promise<Float32Array> {
  return await new Promise<Float32Array>((resolve, reject) => {
    const child = spawn(
      FFMPEG,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        // User audio can be a playlist naming URLs: read local files only.
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        file,
        "-f",
        "f32le",
        "-ac",
        "2",
        "-ar",
        String(RATE),
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let text = "";
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d) => (text = (text + d).slice(-2000)));
    child.once("error", (e) => reject(ffmpegError(e)));
    child.once("close", (code) => {
      if (code !== 0)
        return reject(new Error(text || `Could not decode ${file}`));
      const bytes = Buffer.concat(chunks);
      resolve(
        new Float32Array(
          bytes.buffer,
          bytes.byteOffset,
          Math.floor(bytes.length / 8) * 2,
        ),
      );
    });
  });
}
/** Adds stereo PCM at an output time with a time-varying gain. */
function addAt(
  mix: Float32Array,
  pcm: Float32Array,
  atMs: number,
  gain: (outputMs: number) => number,
): void {
  const first = Math.round((atMs / 1000) * RATE);
  const block = RATE / 100; // gain is evaluated every 10 ms and interpolated
  let next = gain(atMs),
    current = next;
  for (let i = 0; i < pcm.length / 2; i++) {
    const frame = first + i;
    if (frame < 0) continue;
    if (frame * 2 + 1 >= mix.length) break;
    if (i % block === 0) {
      current = next;
      next = gain(((frame + block) / RATE) * 1000);
    }
    const g = current + ((next - current) * (i % block)) / block;
    mix[frame * 2] += pcm[i * 2]! * g;
    mix[frame * 2 + 1] += pcm[i * 2 + 1]! * g;
  }
}
