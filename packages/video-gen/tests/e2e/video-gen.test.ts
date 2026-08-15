import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const enabled = process.env.DEMOHUNTER_VIDEO_E2E === "1";

describe("video-gen e2e", () => {
  test.skipIf(!enabled)("generates a real short video when DEMOHUNTER_VIDEO_E2E=1", async () => {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required for DEMOHUNTER_VIDEO_E2E=1");
    }

    const outputDir = await mkdtemp(path.join(os.tmpdir(), "video-gen-e2e-"));
    try {
      const { generateVideo } = await import("../../src/api/index.js");
      const result = await generateVideo({
        prompt: "In 60 seconds, explain what a binary tree is.",
        style: "minimal",
        outputDir,
      });

      const { access } = await import("node:fs/promises");
      await access(result.videoPath);
      await access(result.captionsSrtPath);
      await access(result.captionsVttPath);
      await access(result.chaptersPath);
      await access(path.join(result.outputDir, "manifest.json"));
    } catch (error) {
      console.error(`E2E failed. Preserved output at: ${outputDir}`);
      throw error;
    }

    await rm(outputDir, { recursive: true, force: true });
  }, 600_000);
});
