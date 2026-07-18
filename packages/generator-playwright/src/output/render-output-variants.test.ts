import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parsePortableOutputManifest } from "@demohunter/manifest";
import { probeMedia } from "@demohunter/media-ffmpeg";

import { renderOutputVariants } from "./render-output-variants.js";
import { writeGenerationOutput } from "./write-generation-output.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("renderOutputVariants", () => {
  test("publishes standard, square, responsive mobile, and GIF output with manifest v2", async () => {
    const root = await makeRoot();
    const outputDir = await makeBaseline(root, "main", 640, 360);
    const mobileDir = await makeBaseline(root, "mobile-source", 390, 844);

    await renderOutputVariants({
      outputDir,
      formats: [
        { preset: "standard", layout: "fit" },
        { preset: "square", layout: "fit" },
        { preset: "mobile", layout: "responsive" },
        { preset: "gif", layout: "fit", durationMs: 500 },
      ],
      responsiveSourceDirs: { mobile: mobileDir },
    });

    const parsed = parsePortableOutputManifest(
      JSON.parse(await readFile(path.join(outputDir, "manifest.json"), "utf8")),
    );
    expect(parsed.manifestVersion).toBe(2);
    if (parsed.manifestVersion !== 2) throw new Error("expected manifest v2");
    expect(parsed.defaultVariantId).toBe("standard");
    expect(parsed.variants.map(({ id, width, height }) => ({ id, width, height }))).toEqual([
      { id: "standard", width: 1920, height: 1080 },
      { id: "square", width: 1080, height: 1080 },
      { id: "mobile", width: 1080, height: 1920 },
    ]);
    expect(parsed.variants[0]?.artifacts.gif?.path).toBe("variants/gif/video.gif");
    expect(await probeMedia(path.join(outputDir, "video.mp4"))).toMatchObject({
      width: 1920,
      height: 1080,
      pixelFormat: "yuv420p",
    });
    expect(await probeMedia(path.join(outputDir, "variants/square/video.mp4"))).toMatchObject({
      width: 1080,
      height: 1080,
      pixelFormat: "yuv420p",
    });
    expect(await probeMedia(path.join(outputDir, "variants/mobile/video.mp4"))).toMatchObject({
      width: 1080,
      height: 1920,
      pixelFormat: "yuv420p",
    });
    const gif = await probeMedia(path.join(outputDir, "variants/gif/video.gif"));
    expect(gif.fps).toBeCloseTo(15, 1);
    expect(gif.durationMs).toBeGreaterThan(0);
    expect(gif.durationMs).toBeLessThanOrEqual(600);
  }, 60_000);

  test("leaves the prior portable output untouched when rendering fails before publication", async () => {
    const root = await makeRoot();
    const outputDir = await makeBaseline(root, "atomic", 320, 180);
    const manifestBefore = await readFile(path.join(outputDir, "manifest.json"), "utf8");
    const videoBefore = await readFile(path.join(outputDir, "video.mp4"));

    await expect(renderOutputVariants({
      outputDir,
      formats: [{ preset: "square", layout: "fit" }],
    }, {
      mediaRenderer: {
        render: async () => {
          throw new Error("synthetic renderer failure");
        },
      },
    })).rejects.toThrow("synthetic renderer failure");

    expect(await readFile(path.join(outputDir, "manifest.json"), "utf8")).toBe(manifestBefore);
    expect(await readFile(path.join(outputDir, "video.mp4"))).toEqual(videoBefore);
    expect(await readdir(outputDir)).not.toContain("variants");
  }, 30_000);
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "demohunter-output-variants-"));
  tempRoots.push(root);
  return root;
}

async function makeBaseline(root: string, id: string, width: number, height: number): Promise<string> {
  const sourceDir = path.join(root, `${id}-recording`);
  const outputDir = path.join(root, "outputs", id);
  const sourcePath = path.join(sourceDir, "video.mp4");
  await mkdir(sourceDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await run("ffmpeg", [
    "-y", "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=30`,
    "-t", "0.8", "-c:v", "libx264", "-pix_fmt", "yuv420p", sourcePath,
  ]);
  await writeGenerationOutput({
    tourId: id,
    tourTitle: id,
    chapters: [{ title: "Intro", startMs: 0 }],
    recordedNarrations: [],
    videos: { mp4: { fileName: "video.mp4", format: "mp4", path: sourcePath } },
    outputDir,
  });
  return outputDir;
}

async function run(command: string, args: string[]): Promise<void> {
  const process = Bun.spawn([command, ...args], { stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(process.stderr).text();
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`${command} failed: ${stderr}`);
}
