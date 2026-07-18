import { spawn } from "node:child_process";
import { copyFile, rm } from "node:fs/promises";
import path from "node:path";

import { createFFmpegMediaRenderer } from "@demohunter/media-ffmpeg";
import type { RecordFormat } from "@demohunter/sdk";
import type { PortableVideoOutputs, RecordedNarration } from "../execute/generator-types.js";

export type MuxVideoInput = {
  narrations: RecordedNarration[];
  outputDir: string;
  recordFormat: RecordFormat;
  tempScreencastPath: string;
};

type RunCommand = (command: string, args: string[]) => Promise<void>;

export type MuxVideoDependencies = {
  copyFile: typeof copyFile;
  ffmpegCommand: string;
  rm: typeof rm;
  runCommand: RunCommand;
};

const defaultDependencies: MuxVideoDependencies = {
  copyFile,
  ffmpegCommand: "ffmpeg",
  rm,
  runCommand: runProcess,
};

export async function muxVideo(
  input: MuxVideoInput,
  dependencies: Partial<MuxVideoDependencies> = {},
): Promise<PortableVideoOutputs> {
  const resolvedDependencies = {
    ...defaultDependencies,
    ...dependencies,
  };
  const mp4Path = path.join(input.outputDir, "video.mp4");
  const webmPath = path.join(input.outputDir, "video.webm");

  const renderer = createFFmpegMediaRenderer({
    ffmpegCommand: resolvedDependencies.ffmpegCommand,
    runCommand: resolvedDependencies.runCommand,
  });

  await renderer.render({
    inputVideoPath: input.tempScreencastPath,
    outputPath: mp4Path,
    container: "mp4",
    video: [],
    audio: narrationTransforms(input.narrations),
    videoCodec: "h264",
    audioCodec: input.narrations.length > 0 ? "aac" : "none",
  });

  if (input.recordFormat === "webm") {
    if (input.narrations.length === 0) {
      await resolvedDependencies.copyFile(input.tempScreencastPath, webmPath);
    } else {
      await renderer.render({
        inputVideoPath: input.tempScreencastPath,
        outputPath: webmPath,
        container: "webm",
        video: [],
        audio: narrationTransforms(input.narrations),
        videoCodec: "copy",
        audioCodec: "opus",
      });
    }

    return {
      mp4: {
        fileName: "video.mp4",
        format: "mp4",
        path: mp4Path,
      },
      webm: {
        fileName: "video.webm",
        format: "webm",
        path: webmPath,
      },
    };
  }

  await resolvedDependencies.rm(webmPath, { force: true });

  return {
    mp4: {
      fileName: "video.mp4",
      format: "mp4",
      path: mp4Path,
    },
  };
}

async function runProcess(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) resolve();
      else reject(new Error(
        `ffmpeg exited with code ${exitCode ?? "unknown"}: ${stderr.trim() || "unknown error"}`,
      ));
    });
  });
}

function narrationTransforms(narrations: RecordedNarration[]) {
  return narrations.length === 0
    ? []
    : [{
        kind: "narration" as const,
        clips: narrations.map((narration) => ({
          inputPath: narration.audioPath,
          startMs: narration.startMs,
        })),
      }];
}
