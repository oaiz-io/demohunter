import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  capturePoster,
  PORTABLE_POSTER_TIMESTAMP_MS,
} from "./capture-poster.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { force: true, recursive: true })));
});

describe("capturePoster", () => {
  test("returns probed video metadata and captures poster.jpg at the preferred timestamp", async () => {
    const fixture = await makeFixture();
    const commands: Array<{ command: string; args: string[] }> = [];

    const result = await capturePoster(
      {
        outputDir: fixture.outputDir,
        videoPath: fixture.videoPath,
      },
      {
        ffmpegCommand: "/custom/bin/ffmpeg",
        ffprobeCommand: "/custom/bin/ffprobe",
        runCommand: async (command, args) => {
          commands.push({ command, args });

          if (command.includes("ffprobe")) {
            return JSON.stringify({ format: { duration: "3.5" } });
          }

          await writeFile(args[args.length - 1], "poster bytes");
          return "";
        },
      },
    );

    expect(result).toEqual({
      captureTimestampMs: PORTABLE_POSTER_TIMESTAMP_MS,
      posterPath: path.join(fixture.outputDir, "poster.jpg"),
      videoDurationMs: 3_500,
    });
    expect(commands).toEqual([
      {
        command: "/custom/bin/ffprobe",
        args: [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "json",
          fixture.videoPath,
        ],
      },
      {
        command: "/custom/bin/ffmpeg",
        args: [
          "-y",
          "-i",
          fixture.videoPath,
          "-ss",
          "1.000",
          "-frames:v",
          "1",
          "-pix_fmt",
          "yuvj420p",
          path.join(fixture.outputDir, "poster.jpg"),
        ],
      },
    ]);
    expect(await readFile(result.posterPath, "utf8")).toBe("poster bytes");
  });

  test("clamps the capture timestamp for short videos", async () => {
    const fixture = await makeFixture();

    const result = await capturePoster(
      {
        outputDir: fixture.outputDir,
        videoPath: fixture.videoPath,
      },
      {
        runCommand: async (_command, args) => {
          if (args.includes("json")) {
            return JSON.stringify({ format: { duration: "0.5" } });
          }

          await writeFile(args[args.length - 1], "poster bytes");
          return "";
        },
      },
    );

    expect(result.videoDurationMs).toBe(500);
    expect(result.captureTimestampMs).toBe(400);
  });
});

async function makeFixture(): Promise<{ outputDir: string; videoPath: string }> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "demohunter-capture-poster-"));
  tempRoots.push(tempRoot);

  const outputDir = path.join(tempRoot, ".demohunter", "billing-overview");
  await mkdir(outputDir, { recursive: true });

  const videoPath = path.join(outputDir, "video.mp4");
  await writeFile(videoPath, "video bytes");

  return { outputDir, videoPath };
}
