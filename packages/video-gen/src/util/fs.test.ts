import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assertSafeRemovalTarget,
  isPathInside,
  removeGenerationWorkspace,
  writeFileAtomic,
} from "./fs.js";

describe("fs helpers", () => {
  test("writeFileAtomic writes utf-8 contents", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "video-gen-fs-"));
    try {
      const filePath = path.join(dir, "nested", "file.json");
      await writeFileAtomic(filePath, '{"ok":true}\n');
      expect(await readFile(filePath, "utf8")).toBe('{"ok":true}\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("removeGenerationWorkspace only removes contained workspaces", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "video-gen-out-"));
    try {
      const workspaceDir = path.join(outputDir, "video-gen", "lesson");
      await mkdir(workspaceDir, { recursive: true });
      await writeFile(path.join(workspaceDir, "x.txt"), "x");

      await removeGenerationWorkspace({ workspaceDir, outputDir });
      await expect(readFile(path.join(workspaceDir, "x.txt"), "utf8")).rejects.toThrow();

      await expect(
        removeGenerationWorkspace({
          workspaceDir: outputDir,
          outputDir,
        }),
      ).rejects.toThrow(/protected path|video-gen root|outside/i);

      await expect(
        removeGenerationWorkspace({
          workspaceDir: path.join(outputDir, "video-gen", "..", "other"),
          outputDir,
        }),
      ).rejects.toThrow(/outside/i);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("path containment helpers reject traversal", () => {
    const root = "/tmp/site";
    expect(isPathInside(root, "/tmp/site/index.html")).toBe(true);
    expect(isPathInside(root, "/tmp/site")).toBe(false);
    expect(isPathInside(root, "/tmp/other")).toBe(false);
    expect(() =>
      assertSafeRemovalTarget({
        target: "/tmp/site",
        allowedRoot: "/tmp/site",
        forbidden: ["/"],
      }),
    ).toThrow();
  });
});
