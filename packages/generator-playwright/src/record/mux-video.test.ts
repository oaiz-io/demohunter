import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { muxVideo } from "./mux-video.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { force: true, recursive: true })));
});

describe("muxVideo", () => {
  test("converts a temporary screencast into a final mp4 via the injected ffmpeg command", async () => {
    const fixture = await makeFixture();
    const commands: Array<{ command: string; args: string[] }> = [];
    await writeFile(path.join(fixture.outputDir, "video.webm"), "stale webm output");

    const result = await muxVideo(
      {
        narrations: [],
        outputDir: fixture.outputDir,
        recordFormat: "mp4",
        tempScreencastPath: fixture.tempScreencastPath,
      },
      {
        ffmpegCommand: "/custom/bin/ffmpeg",
        runCommand: async (command, args) => {
          commands.push({ command, args });
          const outputPath = args[args.length - 1];
          await writeFile(outputPath, "mp4 output");
        },
      },
    );

    expect(result).toEqual({
      mp4: {
        format: "mp4",
        fileName: "video.mp4",
        path: path.join(fixture.outputDir, "video.mp4"),
      },
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual({
      command: "/custom/bin/ffmpeg",
      args: [
        "-y",
        "-i",
        fixture.tempScreencastPath,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        path.join(fixture.outputDir, "video.mp4"),
      ],
    });
    expect(await readFile(result.mp4.path, "utf8")).toBe("mp4 output");
    expect(await readdir(fixture.outputDir)).toEqual(["video.mp4"]);
  });

  test("always emits video.mp4 and adds video.webm only when the resolved record format is webm", async () => {
    const fixture = await makeFixture();
    const commands: Array<{ command: string; args: string[] }> = [];

    const result = await muxVideo(
      {
        narrations: [],
        outputDir: fixture.outputDir,
        recordFormat: "webm",
        tempScreencastPath: fixture.tempScreencastPath,
      },
      {
        runCommand: async (command, args) => {
          commands.push({ command, args });
          const outputPath = args[args.length - 1];
          await writeFile(outputPath, "mp4 output");
        },
      },
    );

    expect(result).toEqual({
      mp4: {
        format: "mp4",
        fileName: "video.mp4",
        path: path.join(fixture.outputDir, "video.mp4"),
      },
      webm: {
        format: "webm",
        fileName: "video.webm",
        path: path.join(fixture.outputDir, "video.webm"),
      },
    });
    expect(commands).toHaveLength(1);
    expect(await readFile(result.mp4.path, "utf8")).toBe("mp4 output");
    expect(await readFile(result.webm!.path, "utf8")).toBe("temporary webm");
    expect((await readdir(fixture.outputDir)).sort()).toEqual(["video.mp4", "video.webm"]);
  });

  test("mixes timed narration audio into both mp4 and webm outputs when narration exists", async () => {
    const fixture = await makeFixture();
    const commands: Array<{ command: string; args: string[] }> = [];

    const result = await muxVideo(
      {
        narrations: [
          {
            audioPath: "/tmp/cache/intro.mp3",
            cacheKey: "intro",
            chapterTitle: "Intro",
            durationMs: 800,
            endMs: 1000,
            startMs: 200,
            text: "Intro narration",
          },
          {
            audioPath: "/tmp/cache/outro.mp3",
            cacheKey: "outro",
            chapterTitle: "Outro",
            durationMs: 1200,
            endMs: 4200,
            startMs: 3000,
            text: "Outro narration",
          },
        ],
        outputDir: fixture.outputDir,
        recordFormat: "webm",
        tempScreencastPath: fixture.tempScreencastPath,
      },
      {
        ffmpegCommand: "/custom/bin/ffmpeg",
        runCommand: async (command, args) => {
          commands.push({ command, args });
          const outputPath = args[args.length - 1];
          await writeFile(outputPath, path.basename(outputPath));
        },
      },
    );

    expect(result).toEqual({
      mp4: {
        format: "mp4",
        fileName: "video.mp4",
        path: path.join(fixture.outputDir, "video.mp4"),
      },
      webm: {
        format: "webm",
        fileName: "video.webm",
        path: path.join(fixture.outputDir, "video.webm"),
      },
    });
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual({
      command: "/custom/bin/ffmpeg",
      args: [
        "-y",
        "-i",
        fixture.tempScreencastPath,
        "-i",
        "/tmp/cache/intro.mp3",
        "-i",
        "/tmp/cache/outro.mp3",
        "-filter_complex",
        "[1:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,adelay=200:all=true[a0];[2:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,adelay=3000:all=true[a1];[a0][a1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[amixout];[amixout]alimiter=limit=0.9:attack=5:release=50:level=false:latency=true[aout]",
        "-map",
        "0:v:0",
        "-map",
        "[aout]",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        path.join(fixture.outputDir, "video.mp4"),
      ],
    });
    expect(commands[1]).toEqual({
      command: "/custom/bin/ffmpeg",
      args: [
        "-y",
        "-i",
        fixture.tempScreencastPath,
        "-i",
        "/tmp/cache/intro.mp3",
        "-i",
        "/tmp/cache/outro.mp3",
        "-filter_complex",
        "[1:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,adelay=200:all=true[a0];[2:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,adelay=3000:all=true[a1];[a0][a1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[amixout];[amixout]alimiter=limit=0.9:attack=5:release=50:level=false:latency=true[aout]",
        "-map",
        "0:v:0",
        "-map",
        "[aout]",
        "-c:v",
        "copy",
        "-c:a",
        "libopus",
        path.join(fixture.outputDir, "video.webm"),
      ],
    });
    expect(await readFile(result.mp4.path, "utf8")).toBe("video.mp4");
    expect(await readFile(result.webm!.path, "utf8")).toBe("video.webm");
  });
});

async function makeFixture(): Promise<{ outputDir: string; tempScreencastPath: string }> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "demohunter-mux-video-"));
  tempRoots.push(tempRoot);

  const outputDir = path.join(tempRoot, "output");
  await mkdir(outputDir, { recursive: true });

  const tempScreencastPath = path.join(tempRoot, "temp-video.webm");
  await writeFile(tempScreencastPath, "temporary webm");

  return { outputDir, tempScreencastPath };
}
