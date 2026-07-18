import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { exportAudio } from "./export-audio.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { force: true, recursive: true })));
});

describe("exportAudio", () => {
  test("copies unique narration audio files into audio/ while preserving extensions", async () => {
    const fixture = await makeFixture();
    await mkdir(path.join(fixture.outputDir, "audio", "stale"), { recursive: true });
    await writeFile(path.join(fixture.outputDir, "audio", "obsolete.mp3"), "obsolete bytes");
    await writeFile(path.join(fixture.outputDir, "audio", "stale", "nested.wav"), "stale bytes");

    const exported = await exportAudio(fixture.outputDir, [
      {
        audioPath: fixture.mp3Path,
        cacheKey: "billing",
        chapterTitle: "Billing",
        durationMs: 1_200,
        endMs: 1_200,
        startMs: 0,
        text: "Explain billing",
      },
      {
        audioPath: fixture.mp3Path,
        cacheKey: "billing",
        chapterTitle: "Billing",
        durationMs: 1_200,
        endMs: 1_200,
        startMs: 0,
        text: "Explain billing",
      },
      {
        audioPath: fixture.wavPath,
        cacheKey: "history",
        chapterTitle: "History",
        durationMs: 900,
        endMs: 2_100,
        startMs: 1_200,
        text: "Open payment history",
      },
    ]);

    expect(exported).toEqual([
      {
        cacheKey: "billing",
        durationMs: 1_200,
        outputPath: path.join(fixture.outputDir, "audio", "billing.mp3"),
      },
      {
        cacheKey: "history",
        durationMs: 900,
        outputPath: path.join(fixture.outputDir, "audio", "history.wav"),
      },
    ]);
    expect((await readdir(path.join(fixture.outputDir, "audio"))).sort()).toEqual([
      "billing.mp3",
      "history.wav",
    ]);
    expect(await readFile(path.join(fixture.outputDir, "audio", "billing.mp3"), "utf8")).toBe("mp3 bytes");
    expect(await readFile(path.join(fixture.outputDir, "audio", "history.wav"), "utf8")).toBe("wav bytes");
  });

  test("does not create placeholder audio output when narrations are empty", async () => {
    const fixture = await makeFixture();
    await mkdir(path.join(fixture.outputDir, "audio"), { recursive: true });
    await writeFile(path.join(fixture.outputDir, "audio", "obsolete.mp3"), "obsolete bytes");

    const exported = await exportAudio(fixture.outputDir, []);

    expect(exported).toEqual([]);
    await expect(readdir(path.join(fixture.outputDir, "audio"))).rejects.toThrow();
  });
});

async function makeFixture(): Promise<{ outputDir: string; mp3Path: string; wavPath: string }> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "demohunter-export-audio-"));
  tempRoots.push(tempRoot);

  const outputDir = path.join(tempRoot, ".demohunter", "billing-overview");
  const sourceDir = path.join(tempRoot, "cache");
  await mkdir(outputDir, { recursive: true });
  await mkdir(sourceDir, { recursive: true });

  const mp3Path = path.join(sourceDir, "billing.mp3");
  const wavPath = path.join(sourceDir, "history.wav");
  await writeFile(mp3Path, "mp3 bytes");
  await writeFile(wavPath, "wav bytes");

  return { outputDir, mp3Path, wavPath };
}
