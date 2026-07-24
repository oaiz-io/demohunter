import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CONTENT_SPEC_VERSION, type ContentSpec } from "../content/schema.js";
import { compileTour } from "../compiler/tour-compiler.js";
import { renderLesson } from "../templates/engine.js";
import {
  assertNoWorkspaceCollision,
  createGenerationWorkspace,
  resolveGenerationPaths,
} from "./workspace.js";

const spec: ContentSpec = {
  version: CONTENT_SPEC_VERSION,
  title: "Workspace Lesson",
  duration: "90s",
  slides: [
    {
      id: "intro",
      heading: "Intro",
      body: [{ type: "paragraph", text: "Hello" }],
      narration: "Hello there.",
      transition: "fade",
    },
  ],
};

describe("workspace", () => {
  test("resolves the documented path layout", () => {
    const workspace = resolveGenerationPaths({
      outputDir: "/tmp/out",
      tourId: "workspace-lesson",
    });
    expect(workspace.workspaceDir).toBe(path.resolve("/tmp/out/video-gen/workspace-lesson"));
    expect(workspace.siteDir).toBe(path.resolve("/tmp/out/video-gen/workspace-lesson/site"));
    expect(workspace.finalOutputDir).toBe(path.resolve("/tmp/out/workspace-lesson"));
    expect(workspace.cacheDir).toBe(path.resolve("/tmp/out/cache"));
  });

  test("publishes atomically and detects collisions", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "video-gen-ws-"));
    try {
      const workspace = resolveGenerationPaths({ outputDir, tourId: "workspace-lesson" });
      const site = renderLesson({ spec, style: "minimal" });
      const compiled = compileTour({ spec, tourId: "workspace-lesson" });
      await createGenerationWorkspace({
        workspace,
        spec,
        site,
        compiled,
        configSource: "export default {};\n",
      });

      expect(await readFile(workspace.contentSpecPath, "utf8")).toContain('"Workspace Lesson"');
      expect(await readFile(path.join(workspace.siteDir, "index.html"), "utf8")).toContain("slide-intro");
      expect(await readFile(workspace.tourPath, "utf8")).toContain("defineTour");

      await expect(assertNoWorkspaceCollision(workspace)).rejects.toMatchObject({
        code: "WORKSPACE_COLLISION",
      });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("collision also checks final output dir", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "video-gen-ws-"));
    try {
      const workspace = resolveGenerationPaths({ outputDir, tourId: "workspace-lesson" });
      await mkdir(workspace.finalOutputDir, { recursive: true });
      await writeFile(path.join(workspace.finalOutputDir, "video.mp4"), "x");
      await expect(assertNoWorkspaceCollision(workspace)).rejects.toMatchObject({
        code: "WORKSPACE_COLLISION",
      });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
