import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { generateVideo } from "./index.js";
import { CONTENT_SPEC_VERSION, type ContentSpec } from "../content/schema.js";

const spec: ContentSpec = {
  version: CONTENT_SPEC_VERSION,
  title: "API Lesson",
  duration: "90s",
  slides: [
    {
      id: "intro",
      heading: "Intro",
      body: [{ type: "paragraph", text: "Hello" }],
      narration: "Hello from the API.",
      transition: "fade",
    },
  ],
};

describe("generateVideo API", () => {
  test("applies defaults and returns structured paths", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "video-gen-api-"));
    const progress: string[] = [];
    try {
      const result = await generateVideo(
        {
          prompt: "Teach me something",
          outputDir,
          style: "terminal",
          model: "gpt-test",
          onProgress: (event) => progress.push(event.phase),
        },
        {
          preflightDependencies: {
            env: { OPENAI_API_KEY: "test-key" },
            checkCommand: async () => undefined,
            launchBrowser: async () => ({ close: async () => undefined }),
          },
          generateContentSpec: async (input) => {
            expect(input.model).toBe("gpt-test");
            return spec;
          },
          startStaticServer: async () => ({
            baseURL: "http://127.0.0.1:9",
            close: async () => undefined,
          }),
          runDemoHunterBridge: async (input) => {
            const finalDir = path.join(outputDir, input.tour.id);
            await mkdir(finalDir, { recursive: true });
            const videoPath = path.join(finalDir, "video.mp4");
            await writeFile(videoPath, "video");
            return {
              outputDir: finalDir,
              videoPath,
              captionsSrtPath: path.join(finalDir, "captions.srt"),
              captionsVttPath: path.join(finalDir, "captions.vtt"),
              chaptersPath: path.join(finalDir, "chapters.json"),
            };
          },
        },
      );

      expect(result.style).toBe("terminal");
      expect(result.id).toBe("api-lesson");
      expect(result.workspacePreserved).toBe(true);
      expect(progress[0]).toBe("preflight");
      expect(progress.at(-1)).toBe("complete");
      await access(result.tourPath);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
