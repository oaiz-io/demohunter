import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createPortableArtifactDescriptor,
  parsePortableOutputManifest,
} from "@demohunter/manifest";
import type {
  PortableOutputManifestV1,
  PortableOutputVariantV2,
} from "@demohunter/manifest";
import {
  createFFmpegMediaRenderer,
  probeMedia,
} from "@demohunter/media-ffmpeg";
import type { MediaProbe, MediaRenderer } from "@demohunter/media-ffmpeg";
import type { OutputFormatRequest, OutputPresetName } from "@demohunter/sdk";

import { capturePoster } from "./capture-poster.js";

type VideoPreset = Exclude<OutputPresetName, "gif">;

export type RenderOutputVariantsInput = {
  formats: OutputFormatRequest[];
  outputDir: string;
  responsiveSourceDirs?: Partial<Record<VideoPreset, string>>;
};

type RenderOutputVariantsDependencies = {
  capturePoster: typeof capturePoster;
  cp: typeof cp;
  createPortableArtifactDescriptor: typeof createPortableArtifactDescriptor;
  mediaRenderer: MediaRenderer;
  mkdir: typeof mkdir;
  mkdtemp: typeof mkdtemp;
  probeMedia: typeof probeMedia;
  readFile: typeof readFile;
  rename: typeof rename;
  rm: typeof rm;
  writeFile: typeof writeFile;
};

const defaultDependencies: RenderOutputVariantsDependencies = {
  capturePoster,
  cp,
  createPortableArtifactDescriptor,
  mediaRenderer: createFFmpegMediaRenderer(),
  mkdir,
  mkdtemp,
  probeMedia,
  readFile,
  rename,
  rm,
  writeFile,
};

export async function renderOutputVariants(
  input: RenderOutputVariantsInput,
  dependencies: Partial<RenderOutputVariantsDependencies> = {},
): Promise<void> {
  if (input.formats.length === 0) return;

  const resolved = { ...defaultDependencies, ...dependencies };
  const stagingRoot = await resolved.mkdtemp(
    path.join(path.dirname(input.outputDir), ".demohunter-variants-"),
  );
  const stagedOutputDir = path.join(stagingRoot, "output");

  try {
    const originalManifest = await readV1Manifest(input.outputDir, resolved);
    await resolved.cp(input.outputDir, stagedOutputDir, { recursive: true });
    await resolved.rm(path.join(stagedOutputDir, "variants"), { recursive: true, force: true });

    const requested = new Map(input.formats.map((format) => [format.preset, format]));
    const standardRequest = requested.get("standard");
    let standardSourceDir = input.outputDir;
    let standardManifest = originalManifest;

    if (standardRequest !== undefined) {
      standardSourceDir = input.responsiveSourceDirs?.standard ?? input.outputDir;
      standardManifest = standardSourceDir === input.outputDir
        ? originalManifest
        : await readV1Manifest(standardSourceDir, resolved);
      if (standardSourceDir !== input.outputDir) {
        await copySidecars(standardSourceDir, stagedOutputDir, resolved);
      }
      const transformedPath = path.join(stagingRoot, "standard.mp4");
      await renderScaledVideo({
        inputPath: path.join(standardSourceDir, "video.mp4"),
        outputPath: transformedPath,
        width: 1920,
        height: 1080,
      }, resolved);
      await resolved.rename(transformedPath, path.join(stagedOutputDir, "video.mp4"));
      await resolved.rm(path.join(stagedOutputDir, "video.webm"), { force: true });
    }

    const standardPoster = await resolved.capturePoster({
      outputDir: stagedOutputDir,
      videoPath: path.join(stagedOutputDir, "video.mp4"),
    });
    const variantRecords: Array<{
      id: VideoPreset;
      directory: string;
      manifest: PortableOutputManifestV1;
      poster: Awaited<ReturnType<typeof capturePoster>>;
    }> = [];

    for (const preset of ["square", "mobile"] as const) {
      if (!requested.has(preset)) continue;
      const sourceDir = input.responsiveSourceDirs?.[preset] ?? input.outputDir;
      const sourceManifest = sourceDir === input.outputDir
        ? originalManifest
        : await readV1Manifest(sourceDir, resolved);
      const variantDir = path.join(stagedOutputDir, "variants", preset);
      await resolved.mkdir(variantDir, { recursive: true });
      await copySidecars(sourceDir, variantDir, resolved);
      const size = preset === "square"
        ? { width: 1080, height: 1080 }
        : { width: 1080, height: 1920 };
      await renderScaledVideo({
        inputPath: path.join(sourceDir, "video.mp4"),
        outputPath: path.join(variantDir, "video.mp4"),
        ...size,
      }, resolved);
      const poster = await resolved.capturePoster({
        outputDir: variantDir,
        videoPath: path.join(variantDir, "video.mp4"),
      });
      variantRecords.push({ id: preset, directory: variantDir, manifest: sourceManifest, poster });
    }

    let gifPath: string | undefined;
    const gifRequest = requested.get("gif");
    if (gifRequest !== undefined) {
      const gifDir = path.join(stagedOutputDir, "variants", "gif");
      gifPath = path.join(gifDir, "video.gif");
      await resolved.mkdir(gifDir, { recursive: true });
      await resolved.mediaRenderer.render({
        inputVideoPath: path.join(stagedOutputDir, "video.mp4"),
        outputPath: gifPath,
        container: "gif",
        video: [{ kind: "gif", durationMs: gifRequest.durationMs ?? 15_000, fps: 15, width: 960 }],
        audio: [],
      });
      const gifProbe = await resolved.probeMedia(gifPath);
      if (gifProbe.durationMs <= 0 || gifProbe.durationMs > (gifRequest.durationMs ?? 15_000) + 100) {
        throw new Error(`Rendered GIF has invalid duration: ${gifProbe.durationMs}ms`);
      }
    }

    const standardVariant = await createVariant({
      id: "standard",
      directory: stagedOutputDir,
      gifPath,
      includeWebm: standardRequest === undefined,
      manifest: standardManifest,
      outputDir: stagedOutputDir,
      poster: standardPoster,
    }, resolved);
    const variants = [standardVariant];
    for (const record of variantRecords) {
      variants.push(await createVariant({
        ...record,
        includeWebm: false,
        outputDir: stagedOutputDir,
      }, resolved));
    }

    const v2Manifest = parsePortableOutputManifest({
      manifestVersion: 2,
      tour: originalManifest.tour,
      defaultVariantId: "standard",
      variants,
      timeline: standardManifest.timeline,
    });
    await resolved.writeFile(
      path.join(stagedOutputDir, "manifest.json"),
      `${JSON.stringify(v2Manifest, null, 2)}\n`,
    );

    await publishAtomically(input.outputDir, stagedOutputDir, stagingRoot, resolved);
  } finally {
    await resolved.rm(stagingRoot, { recursive: true, force: true });
  }
}

async function renderScaledVideo(
  input: { inputPath: string; outputPath: string; width: number; height: number },
  dependencies: RenderOutputVariantsDependencies,
): Promise<void> {
  await dependencies.mediaRenderer.render({
    inputVideoPath: input.inputPath,
    outputPath: input.outputPath,
    container: "mp4",
    video: [{ kind: "scale-pad", width: input.width, height: input.height }],
    audio: [],
    videoCodec: "h264",
  });
  assertVideoProbe(await dependencies.probeMedia(input.outputPath), input.width, input.height);
}

function assertVideoProbe(probe: MediaProbe, width: number, height: number): void {
  if (probe.width !== width || probe.height !== height) {
    throw new Error(`Rendered video dimensions ${probe.width ?? "?"}x${probe.height ?? "?"} do not match ${width}x${height}`);
  }
  if (probe.pixelFormat !== undefined && probe.pixelFormat !== "yuv420p") {
    throw new Error(`Rendered video must use yuv420p, received ${probe.pixelFormat}`);
  }
}

async function createVariant(
  input: {
    id: VideoPreset;
    directory: string;
    gifPath?: string;
    includeWebm: boolean;
    manifest: PortableOutputManifestV1;
    outputDir: string;
    poster: Awaited<ReturnType<typeof capturePoster>>;
  },
  dependencies: RenderOutputVariantsDependencies,
): Promise<PortableOutputVariantV2> {
  const videoPath = path.join(input.directory, "video.mp4");
  const probe = await dependencies.probeMedia(videoPath);
  if (probe.width === undefined || probe.height === undefined) {
    throw new Error(`Unable to probe rendered dimensions for ${videoPath}`);
  }
  const descriptor = (filePath: string, mediaType: string) =>
    dependencies.createPortableArtifactDescriptor({ filePath, mediaType, outputDir: input.outputDir });
  const webmPath = path.join(input.directory, "video.webm");
  const webm = input.includeWebm && input.manifest.artifacts.videos.webm !== undefined
    ? await descriptor(webmPath, "video/webm")
    : undefined;

  return {
    id: input.id,
    preset: input.id,
    width: probe.width,
    height: probe.height,
    playback: { durationMs: input.poster.videoDurationMs },
    artifacts: {
      videos: {
        mp4: await descriptor(videoPath, "video/mp4"),
        ...(webm === undefined ? {} : { webm }),
      },
      ...(input.gifPath === undefined
        ? {}
        : { gif: await descriptor(input.gifPath, "image/gif") }),
      poster: {
        ...(await descriptor(input.poster.posterPath, "image/jpeg")),
        captureTimestampMs: input.poster.captureTimestampMs,
      },
      captions: {
        srt: await descriptor(path.join(input.directory, "captions.srt"), "text/plain"),
        vtt: await descriptor(path.join(input.directory, "captions.vtt"), "text/vtt"),
      },
      audio: await Promise.all(input.manifest.artifacts.audio.map(async (audio) => ({
        ...(await descriptor(path.join(input.directory, "audio", path.basename(audio.path)), audio.mediaType)),
        cacheKey: audio.cacheKey,
        durationMs: audio.durationMs,
      }))),
    },
  };
}

async function copySidecars(
  sourceDir: string,
  targetDir: string,
  dependencies: RenderOutputVariantsDependencies,
): Promise<void> {
  await dependencies.mkdir(targetDir, { recursive: true });
  await Promise.all(["captions.srt", "captions.vtt", "chapters.json"].map((fileName) =>
    dependencies.cp(path.join(sourceDir, fileName), path.join(targetDir, fileName)),
  ));
  await dependencies.rm(path.join(targetDir, "audio"), { recursive: true, force: true });
  try {
    await dependencies.cp(path.join(sourceDir, "audio"), path.join(targetDir, "audio"), { recursive: true });
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

async function readV1Manifest(
  outputDir: string,
  dependencies: Pick<RenderOutputVariantsDependencies, "readFile">,
): Promise<PortableOutputManifestV1> {
  const manifest = parsePortableOutputManifest(
    JSON.parse(await dependencies.readFile(path.join(outputDir, "manifest.json"), "utf8")),
  );
  if (manifest.manifestVersion !== 1) {
    throw new Error(`Expected a manifest v1 capture source in ${outputDir}`);
  }
  return manifest;
}

async function publishAtomically(
  outputDir: string,
  stagedOutputDir: string,
  stagingRoot: string,
  dependencies: Pick<RenderOutputVariantsDependencies, "rename" | "rm">,
): Promise<void> {
  const backupDir = path.join(stagingRoot, "previous-output");
  await dependencies.rename(outputDir, backupDir);
  try {
    await dependencies.rename(stagedOutputDir, outputDir);
  } catch (error) {
    await dependencies.rename(backupDir, outputDir);
    throw error;
  }
  await dependencies.rm(backupDir, { recursive: true, force: true });
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
