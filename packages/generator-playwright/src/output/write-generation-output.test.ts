import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parsePortableOutputManifest } from "@demohunter/manifest";
import { writeGenerationOutput } from "./write-generation-output.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { force: true, recursive: true })));
});

describe("writeGenerationOutput", () => {
  test("writes the chosen final video and chapters.json into the prepared output directory", async () => {
    const fixture = await makeFixture();

    const result = await writeGenerationOutput({
      tourId: "billing-overview",
      tourTitle: "Billing overview",
      chapters: [
        { title: "Billing", startMs: 0 },
        { title: "Invoices", startMs: 1400 },
      ],
      videos: {
        mp4: {
          format: "mp4",
          fileName: "video.mp4",
          path: fixture.sourceMp4Path,
        },
        webm: {
          format: "webm",
          fileName: "video.webm",
          path: fixture.sourceWebmPath,
        },
      },
      recordedNarrations: [
        {
          audioPath: fixture.sourceBillingAudioPath,
          cacheKey: "billing",
          chapterTitle: "Billing",
          durationMs: 1_200,
          endMs: 1_200,
          startMs: 0,
          text: "Open the billing workspace.",
        },
        {
          audioPath: fixture.sourceInvoicesAudioPath,
          cacheKey: "invoices",
          chapterTitle: "Invoices",
          durationMs: 800,
          endMs: 2_000,
          startMs: 1_200,
          text: "Explain the invoice table.",
        },
      ],
      outputDir: fixture.outputDir,
    }, {
      capturePoster: async ({ outputDir }) => {
        const posterPath = path.join(outputDir, "poster.jpg");
        await writeFile(posterPath, "poster bytes");
        return {
          captureTimestampMs: 1_000,
          posterPath,
          videoDurationMs: 2_000,
        };
      },
    });
    const manifest = parsePortableOutputManifest(
      JSON.parse(await readFile(path.join(fixture.outputDir, "manifest.json"), "utf8")),
    );

    expect(result).toEqual({
      captionsSrtPath: path.join(fixture.outputDir, "captions.srt"),
      captionsVttPath: path.join(fixture.outputDir, "captions.vtt"),
      chaptersPath: path.join(fixture.outputDir, "chapters.json"),
      outputDir: fixture.outputDir,
      videoPath: path.join(fixture.outputDir, "video.mp4"),
    });
    expect((await readdir(fixture.outputDir)).sort()).toEqual([
      "audio",
      "captions.srt",
      "captions.vtt",
      "chapters.json",
      "manifest.json",
      "poster.jpg",
      "video.mp4",
      "video.webm",
    ]);
    expect((await readdir(path.join(fixture.outputDir, "audio"))).sort()).toEqual([
      "billing.mp3",
      "invoices.mp3",
    ]);
    expect(await readFile(result.videoPath, "utf8")).toBe("mp4 bytes");
    expect(await readFile(path.join(fixture.outputDir, "video.webm"), "utf8")).toBe("webm bytes");
    expect(await readFile(result.captionsSrtPath, "utf8")).toContain("Open the billing workspace.");
    expect(await readFile(result.captionsVttPath, "utf8")).toContain("Explain the invoice table.");
    expect(manifest.playback.durationMs).toBe(2_000);
    expect(manifest.artifacts.poster.captureTimestampMs).toBe(1_000);
    expect(manifest.artifacts.audio.map((artifact) => artifact.path).sort()).toEqual([
      "audio/billing.mp3",
      "audio/invoices.mp3",
    ]);
    expect(JSON.parse(await readFile(result.chaptersPath, "utf8"))).toEqual([
      { title: "Billing", startMs: 0 },
      { title: "Invoices", startMs: 1400 },
    ]);
  });

  test("writes only the baseline phase 3 artifacts", async () => {
    const fixture = await makeFixture();

    await writeGenerationOutput({
      tourId: "billing-overview",
      tourTitle: "Billing overview",
      chapters: [{ title: "Billing", startMs: 0 }],
      videos: {
        mp4: {
          format: "mp4",
          fileName: "video.mp4",
          path: fixture.sourceMp4Path,
        },
      },
      recordedNarrations: [],
      outputDir: fixture.outputDir,
    }, {
      capturePoster: async ({ outputDir }) => {
        const posterPath = path.join(outputDir, "poster.jpg");
        await writeFile(posterPath, "poster bytes");
        return {
          captureTimestampMs: 999,
          posterPath,
          videoDurationMs: 999,
        };
      },
    });

    expect((await readdir(fixture.outputDir)).sort()).toEqual([
      "captions.srt",
      "captions.vtt",
      "chapters.json",
      "manifest.json",
      "poster.jpg",
      "video.mp4",
    ]);
    expect((await readdir(fixture.outputDir)).includes("audio")).toBe(false);
  });

  test("removes stale alternate video and variant artifacts on rerun", async () => {
    const fixture = await makeFixture();
    await writeFile(path.join(fixture.outputDir, "video.webm"), "stale webm bytes");
    await mkdir(path.join(fixture.outputDir, "variants", "square"), { recursive: true });
    await writeFile(
      path.join(fixture.outputDir, "variants", "square", "video.mp4"),
      "stale variant bytes",
    );

    await writeGenerationOutput({
      tourId: "billing-overview",
      tourTitle: "Billing overview",
      chapters: [{ title: "Billing", startMs: 100 }],
      videos: {
        mp4: {
          format: "mp4",
          fileName: "video.mp4",
          path: fixture.sourceMp4Path,
        },
      },
      recordedNarrations: [],
      outputDir: fixture.outputDir,
    }, {
      capturePoster: async ({ outputDir }) => {
        const posterPath = path.join(outputDir, "poster.jpg");
        await writeFile(posterPath, "poster bytes");
        return {
          captureTimestampMs: 250,
          posterPath,
          videoDurationMs: 500,
        };
      },
    });

    expect((await readdir(fixture.outputDir)).sort()).toEqual([
      "captions.srt",
      "captions.vtt",
      "chapters.json",
      "manifest.json",
      "poster.jpg",
      "video.mp4",
    ]);
  });
});

async function makeFixture(): Promise<{
  outputDir: string;
  sourceBillingAudioPath: string;
  sourceInvoicesAudioPath: string;
  sourceMp4Path: string;
  sourceWebmPath: string;
}> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "demohunter-write-output-"));
  tempRoots.push(tempRoot);

  const outputDir = path.join(tempRoot, ".demohunter", "billing-overview");
  const sourceDir = path.join(tempRoot, "recording");
  const cacheDir = path.join(tempRoot, "cache");
  await mkdir(outputDir, { recursive: true });
  await mkdir(sourceDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });

  const sourceMp4Path = path.join(sourceDir, "video.mp4");
  const sourceWebmPath = path.join(sourceDir, "video.webm");
  const sourceBillingAudioPath = path.join(cacheDir, "billing.mp3");
  const sourceInvoicesAudioPath = path.join(cacheDir, "invoices.mp3");
  await writeFile(sourceMp4Path, "mp4 bytes");
  await writeFile(sourceWebmPath, "webm bytes");
  await writeFile(sourceBillingAudioPath, "billing bytes");
  await writeFile(sourceInvoicesAudioPath, "invoices bytes");

  return {
    outputDir,
    sourceBillingAudioPath,
    sourceInvoicesAudioPath,
    sourceMp4Path,
    sourceWebmPath,
  };
}
