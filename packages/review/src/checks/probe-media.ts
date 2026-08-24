import { execFile } from "node:child_process";

export type ReviewMediaProbe = {
  durationMs: number;
  video: { codec: string; width: number; height: number } | undefined;
  audio: { codec: string; channels: number; sampleRate: number } | undefined;
};

export type ProbeMediaRunner = (command: string, args: string[]) => Promise<string>;

/**
 * ffprobe wrapper that reports the audio stream as well as the video stream.
 *
 * The narrated walkthrough is only trustworthy if it actually carries audio, so
 * the strict check needs more than the video-oriented probe used during
 * rendering.
 */
export async function probeReviewMedia(
  filePath: string,
  options: { ffprobeCommand?: string; runCommand?: ProbeMediaRunner } = {},
): Promise<ReviewMediaProbe> {
  const output = await (options.runCommand ?? runFfprobe)(options.ffprobeCommand ?? "ffprobe", [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    filePath,
  ]);
  const parsed = JSON.parse(output) as {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      channels?: number;
      sample_rate?: string;
    }>;
    format?: { duration?: string };
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  const audio = parsed.streams?.find((stream) => stream.codec_type === "audio");
  const durationSeconds = Number(parsed.format?.duration ?? 0);

  return {
    durationMs: Number.isFinite(durationSeconds) ? Math.round(durationSeconds * 1000) : 0,
    video: video === undefined
      ? undefined
      : {
          codec: video.codec_name ?? "unknown",
          width: video.width ?? 0,
          height: video.height ?? 0,
        },
    audio: audio === undefined
      ? undefined
      : {
          codec: audio.codec_name ?? "unknown",
          channels: audio.channels ?? 0,
          sampleRate: Number.parseInt(audio.sample_rate ?? "0", 10),
        },
  };
}

const runFfprobe: ProbeMediaRunner = async (command, args) =>
  await new Promise<string>((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`${command} failed: ${stderr.trim() || error.message}`));
        return;
      }

      resolve(stdout);
    });
  });
