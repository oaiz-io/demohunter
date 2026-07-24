import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CONTENT_SPEC_VERSION, type ContentSpec } from "../content/schema.js";
import { runVideoGenerationPipeline } from "./orchestrator.js";

const spec: ContentSpec = {
  version: CONTENT_SPEC_VERSION,
  title: "Binary Trees",
  duration: "2m",
  slides: [
    {
      id: "intro",
      heading: "Intro",
      body: [
        { type: "paragraph", text: "A tree." },
        { type: "code_block", language: "ts", code: "type N = {};" },
      ],
      narration: "A binary tree has two children.",
      transition: "fade",
    },
    {
      id: "summary",
      heading: "Summary",
      body: [{ type: "bullet_list", items: ["root", "leaf"] }],
      narration: "Roots and leaves make the shape.",
      transition: "slide-left",
    },
  ],
};

describe("orchestrator", () => {
  test("runs the full mocked pipeline and inspects artifacts", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "video-gen-orch-"));
    const progress: string[] = [];
    let closed = false;

    try {
      const result = await runVideoGenerationPipeline(
        {
          prompt: "What is a binary tree?",
          style: "minimal",
          outputDir,
          onProgress: (event) => progress.push(event.phase),
        },
        {
          preflightDependencies: {
            env: { OPENAI_API_KEY: "test-key" },
            checkCommand: async () => undefined,
            launchBrowser: async () => ({ close: async () => undefined }),
          },
          generateContentSpec: async () => spec,
          startStaticServer: async () => ({
            baseURL: "http://127.0.0.1:5555",
            close: async () => {
              closed = true;
            },
          }),
          runDemoHunterBridge: async (input) => {
            const finalDir = path.join(outputDir, input.tour.id);
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

      // Bridge validates video existence; create the fake artifact before assertion path.
      // The injected bridge above skips access checks by returning paths — re-run with writing bridge.
      expect(result.id).toBe("binary-trees");
      expect(result.workspacePreserved).toBe(true);
      expect(progress[0]).toBe("preflight");
      expect(progress).toContain("content");
      expect(progress).toContain("render");
      expect(progress).toContain("compile");
      expect(progress).toContain("serve");
      expect(progress).toContain("record");
      expect(progress.at(-1)).toBe("complete");
      expect(closed).toBe(true);

      await access(result.contentSpecPath);
      await access(path.join(result.siteDir, "index.html"));
      await access(result.tourPath);
      await access(result.configPath);
      const html = await readFile(path.join(result.siteDir, "index.html"), "utf8");
      expect(html).not.toMatch(/https?:\/\/cdn\.|fonts\.googleapis/);
      const config = await readFile(result.configPath, "utf8");
      expect(config).toContain("http://127.0.0.1:5555");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("honors cleanup and surfaces typed failures", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "video-gen-orch-"));
    try {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const result = await runVideoGenerationPipeline(
        {
          prompt: "What is a binary tree?",
          outputDir,
          cleanup: true,
        },
        {
          preflightDependencies: {
            env: { OPENAI_API_KEY: "test-key" },
            checkCommand: async () => undefined,
            launchBrowser: async () => ({ close: async () => undefined }),
          },
          generateContentSpec: async () => spec,
          startStaticServer: async () => ({
            baseURL: "http://127.0.0.1:5555",
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

      expect(result.workspacePreserved).toBe(false);
      await expect(access(result.workspaceDir)).rejects.toThrow();

      await expect(
        runVideoGenerationPipeline(
          { prompt: "x", outputDir },
          {
            preflightDependencies: {
              env: {},
              checkCommand: async () => undefined,
              launchBrowser: async () => ({ close: async () => undefined }),
            },
          },
        ),
      ).rejects.toMatchObject({ code: "PREFLIGHT_FAILED" });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
