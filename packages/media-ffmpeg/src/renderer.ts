import { spawn } from "node:child_process";

import type {
  AudioTransform,
  MediaProbe,
  MediaRenderPlan,
  MediaRenderer,
  RenderedMedia,
  VideoTransform,
} from "./render-plan.js";

export type RunMediaCommand = (
  command: string,
  args: string[],
  signal?: AbortSignal,
) => Promise<void>;

export type FFmpegMediaRendererOptions = {
  ffmpegCommand?: string;
  runCommand?: RunMediaCommand;
};

export function createFFmpegMediaRenderer(
  options: FFmpegMediaRendererOptions = {},
): MediaRenderer {
  const ffmpegCommand = options.ffmpegCommand ?? "ffmpeg";
  const runCommand = options.runCommand ?? runProcess;

  return {
    async render(plan, signal): Promise<RenderedMedia> {
      validateRenderPlan(plan);
      await runCommand(ffmpegCommand, buildFFmpegArgs(plan), signal);
      return { outputPath: plan.outputPath, container: plan.container };
    },
  };
}

export function buildFFmpegArgs(plan: MediaRenderPlan): string[] {
  const narration = plan.audio.find(
    (transform): transform is Extract<AudioTransform, { kind: "narration" }> =>
      transform.kind === "narration",
  );
  const gif = plan.video.find(
    (transform): transform is Extract<VideoTransform, { kind: "gif" }> => transform.kind === "gif",
  );
  const scalePad = plan.video.find(
    (transform): transform is Extract<VideoTransform, { kind: "scale-pad" }> =>
      transform.kind === "scale-pad",
  );
  const args = ["-y", "-i", plan.inputVideoPath];

  if (narration !== undefined) {
    args.push(...narration.clips.flatMap((clip) => ["-i", clip.inputPath]));
  }

  if (gif !== undefined) {
    const durationSeconds = formatSeconds(gif.durationMs);
    const fps = gif.fps ?? 15;
    const width = gif.width ?? 960;
    const maxColors = gif.maxColors ?? 128;
    args.push(
      "-filter_complex",
      `[0:v]trim=duration=${durationSeconds},fps=${fps},scale=${width}:-2:flags=lanczos,split[g0][g1];[g0]palettegen=max_colors=${maxColors}:stats_mode=diff[p];[g1][p]paletteuse=dither=bayer:bayer_scale=3[vout]`,
      "-map",
      "[vout]",
      "-an",
      "-loop",
      "0",
      plan.outputPath,
    );
    return args;
  }

  const filters: string[] = [];
  let mappedVideo = "0:v:0";

  if (scalePad !== undefined) {
    const color = normalizeColor(scalePad.color ?? "black");
    filters.push(
      `[0:v]scale=w=${scalePad.width}:h=${scalePad.height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${scalePad.width}:${scalePad.height}:(ow-iw)/2:(oh-ih)/2:color=${color},setsar=1[vout]`,
    );
    mappedVideo = "[vout]";
  }

  let mappedAudio: string | undefined;
  if (narration !== undefined && narration.clips.length > 0) {
    const labels = narration.clips.map((_, index) => `[a${index}]`);
    filters.push(...narration.clips.map(
      (clip, index) => `[${index + 1}:a]adelay=${Math.max(0, Math.round(clip.startMs))}:all=true${labels[index]}`,
    ));
    filters.push(labels.length === 1
      ? `${labels[0]}anull[aout]`
      : `${labels.join("")}amix=inputs=${labels.length}:duration=longest:dropout_transition=0[aout]`);
    mappedAudio = "[aout]";
  }

  if (filters.length > 0) {
    args.push("-filter_complex", filters.join(";"));
  }

  if (filters.length > 0 || mappedAudio !== undefined) {
    args.push("-map", mappedVideo);
    if (mappedAudio !== undefined) {
      args.push("-map", mappedAudio);
    } else if (scalePad !== undefined) {
      args.push("-map", "0:a?");
    }
  }

  args.push(...videoCodecArgs(plan), ...audioCodecArgs(plan), plan.outputPath);
  return args;
}

export async function probeMedia(
  filePath: string,
  options: {
    ffprobeCommand?: string;
    runCommand?: (command: string, args: string[]) => Promise<string>;
  } = {},
): Promise<MediaProbe> {
  const output = await (options.runCommand ?? runProcessWithOutput)(
    options.ffprobeCommand ?? "ffprobe",
    ["-v", "error", "-show_streams", "-show_format", "-of", "json", filePath],
  );
  const parsed = JSON.parse(output) as {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      pix_fmt?: string;
      avg_frame_rate?: string;
      r_frame_rate?: string;
      duration?: string;
    }>;
    format?: { duration?: string };
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  const durationSeconds = Number(parsed.format?.duration ?? video?.duration ?? 0);

  return {
    width: video?.width,
    height: video?.height,
    durationMs: Number.isFinite(durationSeconds) ? Math.max(0, Math.round(durationSeconds * 1000)) : 0,
    videoCodec: video?.codec_name,
    pixelFormat: video?.pix_fmt,
    fps: parseFrameRate(video?.r_frame_rate ?? video?.avg_frame_rate),
  };
}

function videoCodecArgs(plan: MediaRenderPlan): string[] {
  const codec = plan.videoCodec ?? (plan.container === "webm" ? "copy" : "h264");
  if (codec === "copy") return ["-c:v", "copy"];
  if (codec === "vp9") return ["-c:v", "libvpx-vp9"];
  return ["-c:v", "libx264", "-pix_fmt", "yuv420p"];
}

function audioCodecArgs(plan: MediaRenderPlan): string[] {
  const hasNarration = plan.audio.some(
    (transform) => transform.kind === "narration" && transform.clips.length > 0,
  );
  const codec = plan.audioCodec ?? (hasNarration ? (plan.container === "webm" ? "opus" : "aac") : "none");
  if (codec === "none") return [];
  return codec === "opus" ? ["-c:a", "libopus"] : ["-c:a", "aac"];
}

function validateRenderPlan(plan: MediaRenderPlan): void {
  if (plan.inputVideoPath.trim().length === 0 || plan.outputPath.trim().length === 0) {
    throw new Error("Media render plans require non-empty input and output paths");
  }

  const gifTransforms = plan.video.filter((transform) => transform.kind === "gif");
  const scalePadTransforms = plan.video.filter((transform) => transform.kind === "scale-pad");

  if (gifTransforms.length > 1 || scalePadTransforms.length > 1) {
    throw new Error("Media render plans allow at most one transform of each kind");
  }
  if (plan.audio.length > 1) {
    throw new Error("Media render plans allow at most one narration transform");
  }
  if (plan.container === "gif") {
    if (gifTransforms.length !== 1) {
      throw new Error("GIF render plans require exactly one gif video transform");
    }
    if (plan.video.length !== 1 || plan.audio.length !== 0) {
      throw new Error("GIF render plans cannot combine scaling or audio transforms");
    }
    if (plan.videoCodec !== undefined || (plan.audioCodec !== undefined && plan.audioCodec !== "none")) {
      throw new Error("GIF render plans do not accept video or audio codecs");
    }
  } else if (gifTransforms.length > 0) {
    throw new Error("gif video transforms require the gif container");
  }

  for (const transform of plan.video) {
    if (transform.kind === "scale-pad") {
      if (!Number.isInteger(transform.width) || !Number.isInteger(transform.height)
        || transform.width <= 0 || transform.height <= 0
        || transform.width % 2 !== 0 || transform.height % 2 !== 0) {
        throw new Error("scale-pad dimensions must be positive even integers");
      }
      continue;
    }

    if (!Number.isFinite(transform.durationMs) || transform.durationMs <= 0 || transform.durationMs > 15_000) {
      throw new Error("GIF durationMs must be a positive finite number no greater than 15000");
    }
    if (transform.fps !== undefined && (!Number.isFinite(transform.fps) || transform.fps <= 0)) {
      throw new Error("GIF fps must be a positive finite number");
    }
    if (transform.width !== undefined && (!Number.isInteger(transform.width) || transform.width <= 0)) {
      throw new Error("GIF width must be a positive integer");
    }
    if (
      transform.maxColors !== undefined
      && (!Number.isInteger(transform.maxColors) || transform.maxColors < 2 || transform.maxColors > 256)
    ) {
      throw new Error("GIF maxColors must be an integer between 2 and 256");
    }
  }

  for (const transform of plan.audio) {
    for (const clip of transform.clips) {
      if (clip.inputPath.trim().length === 0) {
        throw new Error("Narration clips require a non-empty input path");
      }
      if (!Number.isFinite(clip.startMs) || clip.startMs < 0) {
        throw new Error("Narration clip startMs must be a non-negative finite number");
      }
    }
  }
}

function normalizeColor(color: string): string {
  return color.startsWith("#") ? `0x${color.slice(1)}` : color;
}

function formatSeconds(durationMs: number): string {
  return (durationMs / 1000).toFixed(3).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function parseFrameRate(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const [numerator, denominator = "1"] = value.split("/");
  const fps = Number(numerator) / Number(denominator);
  return Number.isFinite(fps) ? fps : undefined;
}

async function runProcess(command: string, args: string[], signal?: AbortSignal): Promise<void> {
  await runSpawn(command, args, signal, false);
}

async function runProcessWithOutput(command: string, args: string[]): Promise<string> {
  return runSpawn(command, args, undefined, true);
}

async function runSpawn(
  command: string,
  args: string[],
  signal: AbortSignal | undefined,
  captureStdout: boolean,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      signal,
      stdio: ["ignore", captureStdout ? "pipe" : "ignore", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (stdout.length < 1_048_576) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 1_048_576) stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${command} exited with code ${exitCode ?? "unknown"}: ${stderr.trim() || "unknown error"}`));
      }
    });
  });
}
