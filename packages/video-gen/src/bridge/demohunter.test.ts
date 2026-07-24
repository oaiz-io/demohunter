import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { defineTour } from "@demohunter/sdk";

import { buildBridgeConfig, renderConfigSource, runDemoHunterBridge } from "./demohunter.js";

describe("demohunter bridge", () => {
  test("emitted config matches in-memory resolved config", () => {
    const bridge = buildBridgeConfig({
      baseURL: "http://127.0.0.1:4321",
      outputDir: "/tmp/out",
      cacheDir: "/tmp/out/cache",
    });
    expect(bridge.resolved.baseURL).toBe("http://127.0.0.1:4321");
    expect(bridge.resolved.record.showChapters).toBe(false);
    expect(bridge.configSource).toContain("http://127.0.0.1:4321");
    expect(bridge.configSource).toContain("showChapters: false");
    expect(renderConfigSource(bridge.resolved)).toBe(bridge.configSource);
  });

  test("forwards progress and validates returned paths", async () => {
    const outputRoot = await mkdtemp(path.join(os.tmpdir(), "video-gen-bridge-"));
    try {
      const tourId = "bridge-lesson";
      const finalDir = path.join(outputRoot, tourId);
      await writeFile(path.join(await mkdirp(finalDir), "video.mp4"), "video");
      const progress: string[] = [];
      const tour = defineTour({
        id: tourId,
        title: "Bridge",
        async run() {},
      });

      const result = await runDemoHunterBridge(
        {
          baseURL: "http://127.0.0.1:9",
          outputDir: outputRoot,
          cacheDir: path.join(outputRoot, "cache"),
          configPath: path.join(outputRoot, "demohunter.config.ts"),
          projectRoot: outputRoot,
          tourPath: path.join(outputRoot, `${tourId}.tour.ts`),
          tour,
          onProgress: (event) => progress.push(event.message),
        },
        {
          generateTour: async ({ onProgress }) => {
            onProgress?.({ phase: "collecting-timeline", message: "collecting" });
            return {
              outputDir: finalDir,
              videoPath: path.join(finalDir, "video.mp4"),
              captionsSrtPath: path.join(finalDir, "captions.srt"),
              captionsVttPath: path.join(finalDir, "captions.vtt"),
              chaptersPath: path.join(finalDir, "chapters.json"),
            };
          },
        },
      );

      expect(result.videoPath).toContain("video.mp4");
      expect(progress).toContain("collecting");
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});

async function mkdirp(dir: string): Promise<string> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  return dir;
}

