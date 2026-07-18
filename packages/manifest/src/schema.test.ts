import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as manifest from "./index.js";
import {
  parsePortableOutputManifest,
  PORTABLE_OUTPUT_MANIFEST_VERSION,
  PORTABLE_OUTPUT_MANIFEST_V2_VERSION,
  portableOutputManifestSchema,
  portableOutputManifestV1Schema,
  portableOutputManifestV2Schema,
} from "./schema.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("portableOutputManifestSchema", () => {
  test("accepts the Phase 5 manifest shape", () => {
    const value = parsePortableOutputManifest(createValidManifest());

    expect(value).toEqual(createValidManifest());
    expect(value.manifestVersion).toBe(PORTABLE_OUTPUT_MANIFEST_VERSION);
  });

  test("parses manifest v1 and variant-aware manifest v2 as a discriminated union", () => {
    const v1 = parsePortableOutputManifest(createValidManifest());
    const v2Fixture = createValidV2Manifest();
    const v2 = parsePortableOutputManifest(v2Fixture);

    expect(v1.manifestVersion).toBe(1);
    expect(v2).toEqual(v2Fixture);
    expect(v2.manifestVersion).toBe(PORTABLE_OUTPUT_MANIFEST_V2_VERSION);
    if (v2.manifestVersion === 2) {
      expect(v2.defaultVariantId).toBe("standard");
      expect(v2.variants.map((variant) => variant.id)).toEqual(["standard", "square"]);
    }
  });

  test("rejects unsafe v2 paths, duplicate ids, and missing default variants", () => {
    const unsafe = createValidV2Manifest();
    unsafe.variants[1]!.artifacts.videos.mp4.path = "../square.mp4";
    expect(() => parsePortableOutputManifest(unsafe)).toThrow("safe output-root-relative");

    const duplicate = createValidV2Manifest();
    duplicate.variants[1]!.id = "standard";
    expect(() => parsePortableOutputManifest(duplicate)).toThrow("Duplicate variant id: standard");

    const missingDefault = createValidV2Manifest();
    missingDefault.defaultVariantId = "portrait";
    expect(() => parsePortableOutputManifest(missingDefault)).toThrow("must reference a variant");
  });

  test("rejects unknown keys, missing sections, invalid optional-video handling, and malformed audio paths", () => {
    expect(() =>
      parsePortableOutputManifest({
        ...createValidManifest(),
        extra: true,
      }),
    ).toThrow();

    expect(() =>
      parsePortableOutputManifest({
        manifestVersion: PORTABLE_OUTPUT_MANIFEST_VERSION,
        tour: { id: "billing-overview", title: "Billing overview" },
      }),
    ).toThrow();

    expect(() =>
      parsePortableOutputManifest({
        ...createValidManifest(),
        artifacts: {
          ...createValidManifest().artifacts,
          videos: {
            ...createValidManifest().artifacts.videos,
            webm: {
              ...createValidManifest().artifacts.videos.mp4,
              path: "video.mkv",
            },
          },
        },
      }),
    ).toThrow();

    expect(() =>
      parsePortableOutputManifest({
        ...createValidManifest(),
        artifacts: {
          ...createValidManifest().artifacts,
          audio: [
            {
              ...createValidManifest().artifacts.audio[0],
              path: "cache/billing.mp3",
            },
          ],
        },
      }),
    ).toThrow();

    expect(() =>
      parsePortableOutputManifest({
        ...createValidManifest(),
        artifacts: {
          ...createValidManifest().artifacts,
          audio: [
            {
              ...createValidManifest().artifacts.audio[0],
              path: "audio/../outside.mp3",
            },
          ],
        },
      }),
    ).toThrow("safe output-root-relative");
  });

  test("exports the schema through the source and dist package boundary", async () => {
    expect(manifest.parsePortableOutputManifest).toBe(parsePortableOutputManifest);
    expect(manifest.portableOutputManifestSchema).toBe(portableOutputManifestSchema);
    expect(manifest.portableOutputManifestV1Schema).toBe(portableOutputManifestV1Schema);
    expect(manifest.portableOutputManifestV2Schema).toBe(portableOutputManifestV2Schema);

    await buildManifestPackage();

    const packageJson = JSON.parse(
      await readFile(path.join(repoRoot, "packages/manifest/package.json"), "utf8"),
    ) as {
      exports?: { ".": { bun?: string; default?: string } };
    };

    expect(packageJson.exports?.["."].bun).toBe("./src/index.ts");
    expect(packageJson.exports?.["."].default).toBe("./dist/index.js");

    const distModule = (await import(
      pathToFileURL(path.join(repoRoot, "packages/manifest/dist/index.js")).href
    )) as typeof manifest;

    expect(typeof distModule.parsePortableOutputManifest).toBe("function");
    expect(distModule.PORTABLE_OUTPUT_MANIFEST_VERSION).toBe(PORTABLE_OUTPUT_MANIFEST_VERSION);
  });
});

async function buildManifestPackage(): Promise<void> {
  const processResult = Bun.spawn({
    cmd: [process.execPath, "x", "tsc", "-b", "packages/manifest/tsconfig.json", "--pretty", "false"],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    processResult.exited,
    new Response(processResult.stdout).text(),
    new Response(processResult.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(stderr || stdout || "Manifest build failed");
  }
}

function createValidV2Manifest() {
  const sharedAudio = {
    ...createDescriptor("audio/billing.mp3", "audio/mpeg"),
    cacheKey: "billing",
    durationMs: 1_200,
  };
  const createVariant = (id: "standard" | "square", width: number, height: number) => ({
    id,
    preset: id,
    width,
    height,
    playback: { durationMs: 3_500 },
    artifacts: {
      videos: {
        mp4: createDescriptor(
          id === "standard" ? "video.mp4" : "variants/square/video.mp4",
          "video/mp4",
        ),
      },
      ...(id === "standard"
        ? { gif: createDescriptor("variants/gif/video.gif", "image/gif") }
        : {}),
      poster: {
        ...createDescriptor(
          id === "standard" ? "poster.jpg" : "variants/square/poster.jpg",
          "image/jpeg",
        ),
        captureTimestampMs: 1_000,
      },
      captions: {
        srt: createDescriptor("captions.srt", "text/plain"),
        vtt: createDescriptor("captions.vtt", "text/vtt"),
      },
      audio: [sharedAudio],
    },
  });

  return {
    manifestVersion: PORTABLE_OUTPUT_MANIFEST_V2_VERSION,
    tour: { id: "billing-overview", title: "Billing overview" },
    defaultVariantId: "standard",
    variants: [createVariant("standard", 1920, 1080), createVariant("square", 1080, 1080)],
    timeline: {
      chapters: [{ title: "Billing", startMs: 0 }],
      narrations: [{
        cacheKey: "billing",
        text: "Open the billing workspace.",
        chapterTitle: "Billing",
        startMs: 0,
        endMs: 1_200,
        durationMs: 1_200,
      }],
    },
  };
}

function createValidManifest() {
  return {
    manifestVersion: PORTABLE_OUTPUT_MANIFEST_VERSION,
    tour: {
      id: "billing-overview",
      title: "Billing overview",
    },
    playback: {
      durationMs: 3_500,
    },
    artifacts: {
      videos: {
        mp4: createDescriptor("video.mp4", "video/mp4"),
        webm: createDescriptor("video.webm", "video/webm"),
      },
      poster: {
        ...createDescriptor("poster.jpg", "image/jpeg"),
        captureTimestampMs: 1_000,
      },
      captions: {
        srt: createDescriptor("captions.srt", "text/plain"),
        vtt: createDescriptor("captions.vtt", "text/vtt"),
      },
      chapters: createDescriptor("chapters.json", "application/json"),
      audio: [
        {
          ...createDescriptor("audio/billing.mp3", "audio/mpeg"),
          cacheKey: "billing",
          durationMs: 1_200,
        },
      ],
    },
    timeline: {
      chapters: [{ title: "Billing", startMs: 0 }],
      narrations: [
        {
          cacheKey: "billing",
          text: "Open the billing workspace.",
          chapterTitle: "Billing",
          startMs: 0,
          endMs: 1_200,
          durationMs: 1_200,
        },
      ],
    },
  };
}

function createDescriptor(pathValue: string, mediaType: string) {
  return {
    path: pathValue,
    mediaType,
    checksum: {
      algorithm: "sha256" as const,
      byteSize: 12,
      hex: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
  };
}
