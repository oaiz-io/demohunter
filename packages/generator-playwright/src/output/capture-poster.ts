import { execFile } from "node:child_process";
import path from "node:path";

export const PORTABLE_POSTER_TIMESTAMP_MS = 1_000;

export type CapturedPoster = {
  posterPath: string;
  videoDurationMs: number;
  captureTimestampMs: number;
};

export type CapturePosterInput = {
  outputDir: string;
  videoPath: string;
};

type CapturePosterDependencies = {
  ffmpegCommand: string;
  ffprobeCommand: string;
  runCommand: (command: string, args: string[]) => Promise<string>;
};

const defaultDependencies: CapturePosterDependencies = {
  ffmpegCommand: "ffmpeg",
  ffprobeCommand: "ffprobe",
  runCommand: runCommand,
};

export async function capturePoster(
  input: CapturePosterInput,
  dependencies: Partial<CapturePosterDependencies> = {},
): Promise<CapturedPoster> {
  const resolvedDependencies = {
    ...defaultDependencies,
    ...dependencies,
  };
  const posterPath = path.join(input.outputDir, "poster.jpg");
  const probeStdout = await resolvedDependencies.runCommand(resolvedDependencies.ffprobeCommand, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    input.videoPath,
  ]);
  const parsed = JSON.parse(probeStdout) as {
    format?: {
      duration?: string;
    };
  };
  const durationSeconds = Number(parsed.format?.duration);

  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    throw new Error(`Unable to probe final video duration for ${input.videoPath}.`);
  }

  const videoDurationMs = Math.round(durationSeconds * 1_000);
  const captureTimestampMs = Math.max(
    0,
    Math.min(PORTABLE_POSTER_TIMESTAMP_MS, videoDurationMs > 0 ? videoDurationMs - 100 : 0),
  );

  await resolvedDependencies.runCommand(resolvedDependencies.ffmpegCommand, [
    "-y",
    "-i",
    input.videoPath,
    "-ss",
    (captureTimestampMs / 1_000).toFixed(3),
    "-frames:v",
    "1",
    "-pix_fmt",
    "yuvj420p",
    posterPath,
  ]);

  return {
    posterPath,
    videoDurationMs,
    captureTimestampMs,
  };
}

async function runCommand(command: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(
          new Error(
            `${command} failed: ${stderr.trim() || error.message || "unknown error"}`,
          ),
        );
        return;
      }

      resolve(stdout);
    });
  });
}
