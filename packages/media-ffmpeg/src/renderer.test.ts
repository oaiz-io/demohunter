import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildFFmpegArgs, createFFmpegMediaRenderer, probeMedia } from "./renderer.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("buildFFmpegArgs", () => {
  test("builds a centered scale-and-pad transform without a shell command", () => {
    expect(buildFFmpegArgs({
      inputVideoPath: "/tmp/input.webm",
      outputPath: "/tmp/output.mp4",
      container: "mp4",
      video: [{ kind: "scale-pad", width: 1080, height: 1080, color: "#101010" }],
      audio: [],
    })).toEqual([
      "-y", "-i", "/tmp/input.webm",
      "-filter_complex",
      "[0:v]scale=w=1080:h=1080:force_original_aspect_ratio=decrease:flags=lanczos,pad=1080:1080:(ow-iw)/2:(oh-ih)/2:color=0x101010,setsar=1[vout]",
      "-map", "[vout]", "-map", "0:a?",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "/tmp/output.mp4",
    ]);
  });

  test("builds a bounded palette-based GIF transform", () => {
    const args = buildFFmpegArgs({
      inputVideoPath: "/tmp/input.mp4",
      outputPath: "/tmp/output.gif",
      container: "gif",
      video: [{ kind: "gif", durationMs: 12_500, fps: 15, width: 960 }],
      audio: [],
    });

    expect(args).toContain("[0:v]trim=duration=12.5,fps=15,scale=960:-2:flags=lanczos,split[g0][g1];[g0]palettegen=max_colors=128:stats_mode=diff[p];[g1][p]paletteuse=dither=bayer:bayer_scale=3[vout]");
    expect(args).toContain("-an");
  });

  test("disables amix normalization on a normalized, peak-limited narration bus", () => {
    const args = buildFFmpegArgs({
      inputVideoPath: "/tmp/input.mp4",
      outputPath: "/tmp/output.mp4",
      container: "mp4",
      video: [],
      audio: [{
        kind: "narration",
        clips: [
          { inputPath: "/tmp/first.wav", startMs: 0 },
          { inputPath: "/tmp/second.wav", startMs: 2_000 },
        ],
      }],
    });
    const filterGraph = args[args.indexOf("-filter_complex") + 1];

    expect(filterGraph).toContain(
      "[1:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,adelay=0:all=true[a0]",
    );
    expect(filterGraph).toContain(
      "[a0][a1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[amixout]",
    );
    expect(filterGraph).toContain(
      "[amixout]alimiter=limit=0.9:attack=5:release=50:level=false:latency=true[aout]",
    );
  });

  test("peak-limits a single normalized narration clip without amix", () => {
    const args = buildFFmpegArgs({
      inputVideoPath: "/tmp/input.mp4",
      outputPath: "/tmp/output.mp4",
      container: "mp4",
      video: [],
      audio: [{
        kind: "narration",
        clips: [{ inputPath: "/tmp/narration.wav", startMs: 500 }],
      }],
    });
    const filterGraph = args[args.indexOf("-filter_complex") + 1];

    expect(filterGraph).toContain(
      "[1:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,adelay=500:all=true[a0]",
    );
    expect(filterGraph).toContain("[a0]anull[amixout]");
    expect(filterGraph).not.toContain("amix=inputs=");
    expect(filterGraph).toContain(
      "[amixout]alimiter=limit=0.9:attack=5:release=50:level=false:latency=true[aout]",
    );
    expect(args).toContain("[aout]");
  });
});

describe("createFFmpegMediaRenderer", () => {
  test("rejects conflicting or unsafe plans before invoking ffmpeg", async () => {
    const invocations: string[][] = [];
    const renderer = createFFmpegMediaRenderer({
      runCommand: async (_command, args) => {
        invocations.push(args);
      },
    });
    const gifPlan = {
      inputVideoPath: "/tmp/input.mp4",
      outputPath: "/tmp/output.gif",
      container: "gif" as const,
      video: [{ kind: "gif" as const, durationMs: 1_000 }],
      audio: [],
    };

    await expect(renderer.render({
      ...gifPlan,
      container: "mp4",
    })).rejects.toThrow("gif video transforms require the gif container");
    await expect(renderer.render({
      ...gifPlan,
      video: [{ kind: "gif", durationMs: 15_001 }],
    })).rejects.toThrow("no greater than 15000");
    await expect(renderer.render({
      ...gifPlan,
      video: [{ kind: "gif", durationMs: 0.5 }],
    })).rejects.toThrow("GIF durationMs must be a positive integer");
    await expect(renderer.render({
      ...gifPlan,
      video: [{ kind: "gif", durationMs: 1_000, fps: 0 }],
    })).rejects.toThrow("GIF fps must be a positive finite number");
    await expect(renderer.render({
      ...gifPlan,
      video: [{ kind: "gif", durationMs: 1_000, maxColors: 257 }],
    })).rejects.toThrow("GIF maxColors must be an integer between 2 and 256");
    await expect(renderer.render({
      ...gifPlan,
      audio: [{ kind: "narration", clips: [] }],
    })).rejects.toThrow("cannot combine scaling or audio transforms");
    await expect(renderer.render({
      inputVideoPath: "/tmp/input.mp4",
      outputPath: "/tmp/output.mp4",
      container: "mp4",
      video: [],
      audio: [{ kind: "narration", clips: [{ inputPath: "/tmp/narration.mp3", startMs: Number.NaN }] }],
    })).rejects.toThrow("Narration clip startMs must be a non-negative finite number");

    expect(invocations).toEqual([]);
  });
});

describe("FFmpegMediaRenderer integration", () => {
  test("renders and probes square MP4 and GIF derivatives", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "demohunter-media-ffmpeg-"));
    tempRoots.push(root);
    const inputPath = path.join(root, "input.mp4");
    const squarePath = path.join(root, "square.mp4");
    const gifPath = path.join(root, "preview.gif");

    await run("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30",
      "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", inputPath,
    ]);

    const renderer = createFFmpegMediaRenderer();
    await renderer.render({
      inputVideoPath: inputPath,
      outputPath: squarePath,
      container: "mp4",
      video: [{ kind: "scale-pad", width: 1080, height: 1080 }],
      audio: [],
    });
    await renderer.render({
      inputVideoPath: inputPath,
      outputPath: gifPath,
      container: "gif",
      video: [{ kind: "gif", durationMs: 750, fps: 15, width: 320 }],
      audio: [],
    });

    const square = await probeMedia(squarePath);
    const gif = await probeMedia(gifPath);
    expect(square).toMatchObject({ width: 1080, height: 1080, pixelFormat: "yuv420p" });
    expect(gif.width).toBe(320);
    expect(gif.fps).toBeCloseTo(15, 1);
    expect(gif.durationMs).toBeGreaterThanOrEqual(700);
    expect(gif.durationMs).toBeLessThanOrEqual(850);
  }, 30_000);

  test("keeps equal staggered narration tones at a consistent level", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "demohunter-media-ffmpeg-levels-"));
    tempRoots.push(root);
    const inputPath = path.join(root, "input.mp4");
    const outputPath = path.join(root, "output.mp4");
    const sampleRates = [32_000, 44_100, 48_000];
    const tonePaths = sampleRates.map((_, index) => path.join(root, `tone-${index}.wav`));

    await run("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "color=c=black:size=320x180:rate=30:duration=6",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", inputPath,
    ]);
    await Promise.all(tonePaths.map((tonePath, index) => run("ffmpeg", [
      "-y", "-f", "lavfi", "-i", `sine=frequency=1000:duration=1:sample_rate=${sampleRates[index]}`,
      "-c:a", "pcm_s16le", tonePath,
    ])));

    const renderer = createFFmpegMediaRenderer();
    await renderer.render({
      inputVideoPath: inputPath,
      outputPath,
      container: "mp4",
      video: [],
      audio: [{
        kind: "narration",
        clips: tonePaths.map((inputPath, index) => ({ inputPath, startMs: index * 2_000 })),
      }],
    });

    const levels = await Promise.all([0.25, 2.25, 4.25].map(
      (startSeconds) => probeRmsLevel(outputPath, startSeconds, 0.5),
    ));
    expect(Math.max(...levels) - Math.min(...levels)).toBeLessThan(0.5);
  }, 30_000);

  test("peak-limits overlapping narration tones instead of clipping", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "demohunter-media-ffmpeg-limiter-"));
    tempRoots.push(root);
    const inputPath = path.join(root, "input.mp4");
    const outputPath = path.join(root, "output.mp4");
    const tonePaths = [path.join(root, "tone-0.wav"), path.join(root, "tone-1.wav")];

    await run("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "color=c=black:size=320x180:rate=30:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", inputPath,
    ]);
    await Promise.all(tonePaths.map((tonePath) => run("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "sine=frequency=1000:duration=1:sample_rate=48000",
      "-af", "volume=6.4", "-c:a", "pcm_f32le", tonePath,
    ])));

    const renderer = createFFmpegMediaRenderer();
    await renderer.render({
      inputVideoPath: inputPath,
      outputPath,
      container: "mp4",
      video: [],
      audio: [{
        kind: "narration",
        clips: [
          { inputPath: tonePaths[0], startMs: 0 },
          { inputPath: tonePaths[1], startMs: 500 },
        ],
      }],
    });

    const overlap = await probeAudioLevels(outputPath, 0.65, 0.5);
    expect(overlap.peak).toBeLessThan(-0.5);
    expect(overlap.rms).toBeLessThan(-1);
  }, 30_000);
});

async function run(command: string, args: string[]): Promise<void> {
  const process = Bun.spawn([command, ...args], { stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(process.stderr).text();
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`${command} failed: ${stderr}`);
}

async function probeRmsLevel(
  filePath: string,
  startSeconds: number,
  durationSeconds: number,
): Promise<number> {
  const escapedPath = filePath
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll(":", "\\:");
  const process = Bun.spawn([
    "ffprobe",
    "-v", "error",
    "-f", "lavfi",
    "-i", `amovie=filename='${escapedPath}',atrim=start=${startSeconds}:duration=${durationSeconds},astats=metadata=1:reset=0`,
    "-show_entries", "frame_tags=lavfi.astats.Overall.RMS_level",
    "-of", "json",
  ], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`ffprobe failed: ${stderr}`);

  const parsed = JSON.parse(stdout) as {
    frames?: Array<{ tags?: { "lavfi.astats.Overall.RMS_level"?: string } }>;
  };
  const levels = parsed.frames
    ?.map((frame) => Number(frame.tags?.["lavfi.astats.Overall.RMS_level"]))
    .filter(Number.isFinite) ?? [];
  const level = levels.at(-1);
  if (level === undefined) throw new Error(`ffprobe returned no RMS level for ${filePath}`);
  return level;
}

async function probeAudioLevels(
  filePath: string,
  startSeconds: number,
  durationSeconds: number,
): Promise<{ peak: number; rms: number }> {
  const escapedPath = filePath
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll(":", "\\:");
  const process = Bun.spawn([
    "ffprobe",
    "-v", "error",
    "-f", "lavfi",
    "-i", `amovie=filename='${escapedPath}',atrim=start=${startSeconds}:duration=${durationSeconds},astats=metadata=1:reset=0`,
    "-show_entries", "frame_tags=lavfi.astats.Overall.Peak_level,lavfi.astats.Overall.RMS_level",
    "-of", "json",
  ], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`ffprobe failed: ${stderr}`);

  const parsed = JSON.parse(stdout) as {
    frames?: Array<{ tags?: {
      "lavfi.astats.Overall.Peak_level"?: string;
      "lavfi.astats.Overall.RMS_level"?: string;
    } }>;
  };
  const levels = parsed.frames?.flatMap((frame) => {
    const peak = Number(frame.tags?.["lavfi.astats.Overall.Peak_level"]);
    const rms = Number(frame.tags?.["lavfi.astats.Overall.RMS_level"]);
    return Number.isFinite(peak) && Number.isFinite(rms) ? [{ peak, rms }] : [];
  }) ?? [];
  const level = levels.at(-1);
  if (level === undefined) throw new Error(`ffprobe returned no audio levels for ${filePath}`);
  return level;
}
