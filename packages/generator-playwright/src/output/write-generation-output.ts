import { copyFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createPortableArtifactDescriptor,
  parsePortableOutputManifest,
} from "@demohunter/manifest";
import type {
  PortableVideoOutputs,
  RecordedNarration,
} from "../execute/generator-types.js";
import { capturePoster } from "./capture-poster.js";
import { exportAudio } from "./export-audio.js";
import { serializeNarrationSubtitles } from "./subtitles.js";

export type GenerationChapter = {
  title: string;
  startMs: number;
};

export type WriteGenerationOutputInput = {
  tourId: string;
  tourTitle: string;
  videos: PortableVideoOutputs;
  chapters: GenerationChapter[];
  recordedNarrations: RecordedNarration[];
  outputDir: string;
};

type WriteGenerationOutputDependencies = {
  capturePoster: typeof capturePoster;
  copyFile: typeof copyFile;
  createPortableArtifactDescriptor: typeof createPortableArtifactDescriptor;
  exportAudio: typeof exportAudio;
  parsePortableOutputManifest: typeof parsePortableOutputManifest;
  rm: typeof rm;
  writeFile: typeof writeFile;
};

export type WriteGenerationOutputResult = {
  captionsSrtPath: string;
  captionsVttPath: string;
  chaptersPath: string;
  outputDir: string;
  videoPath: string;
};

const defaultDependencies: WriteGenerationOutputDependencies = {
  capturePoster,
  copyFile,
  createPortableArtifactDescriptor,
  exportAudio,
  parsePortableOutputManifest,
  rm,
  writeFile,
};

export async function writeGenerationOutput(
  input: WriteGenerationOutputInput,
  dependencies: Partial<WriteGenerationOutputDependencies> = {},
): Promise<WriteGenerationOutputResult> {
  const resolvedDependencies = {
    ...defaultDependencies,
    ...dependencies,
  };
  const videoPath = path.join(input.outputDir, input.videos.mp4.fileName);
  const chaptersPath = path.join(input.outputDir, "chapters.json");
  const captionsSrtPath = path.join(input.outputDir, "captions.srt");
  const captionsVttPath = path.join(input.outputDir, "captions.vtt");
  const manifestPath = path.join(input.outputDir, "manifest.json");
  const videoArtifacts = [input.videos.mp4, input.videos.webm].filter((artifact) => artifact !== undefined);
  const expectedVideoPaths = new Set(
    videoArtifacts.map((artifact) => path.resolve(path.join(input.outputDir, artifact.fileName))),
  );
  const staleVideoPaths = ["video.mp4", "video.webm"]
    .map((fileName) => path.join(input.outputDir, fileName))
    .filter((candidatePath) => !expectedVideoPaths.has(path.resolve(candidatePath)));
  const subtitles = serializeNarrationSubtitles(input.recordedNarrations);

  await Promise.all([
    ...staleVideoPaths.map((candidatePath) => resolvedDependencies.rm(candidatePath, { force: true })),
    resolvedDependencies.rm(path.join(input.outputDir, "variants"), { recursive: true, force: true }),
  ]);

  await Promise.all(
    videoArtifacts.map(async (artifact) => {
      const destinationPath = path.join(input.outputDir, artifact.fileName);

      if (path.resolve(artifact.path) !== path.resolve(destinationPath)) {
        await resolvedDependencies.copyFile(artifact.path, destinationPath);
      }
    }),
  );

  await resolvedDependencies.writeFile(chaptersPath, JSON.stringify(input.chapters, null, 2));
  await Promise.all([
    resolvedDependencies.writeFile(captionsSrtPath, subtitles.srt),
    resolvedDependencies.writeFile(captionsVttPath, subtitles.vtt),
  ]);
  const exportedAudio = await resolvedDependencies.exportAudio(input.outputDir, input.recordedNarrations);
  const poster = await resolvedDependencies.capturePoster({
    outputDir: input.outputDir,
    videoPath,
  });
  const manifest = resolvedDependencies.parsePortableOutputManifest({
    manifestVersion: 1,
    tour: {
      id: input.tourId,
      title: input.tourTitle,
    },
    playback: {
      durationMs: poster.videoDurationMs,
    },
    artifacts: {
      videos: {
        mp4: await resolvedDependencies.createPortableArtifactDescriptor({
          filePath: videoPath,
          mediaType: "video/mp4",
          outputDir: input.outputDir,
        }),
        ...(input.videos.webm === undefined
          ? {}
          : {
              webm: await resolvedDependencies.createPortableArtifactDescriptor({
                filePath: path.join(input.outputDir, input.videos.webm.fileName),
                mediaType: "video/webm",
                outputDir: input.outputDir,
              }),
            }),
      },
      poster: {
        ...(await resolvedDependencies.createPortableArtifactDescriptor({
          filePath: poster.posterPath,
          mediaType: "image/jpeg",
          outputDir: input.outputDir,
        })),
        captureTimestampMs: poster.captureTimestampMs,
      },
      captions: {
        srt: await resolvedDependencies.createPortableArtifactDescriptor({
          filePath: captionsSrtPath,
          mediaType: "text/plain",
          outputDir: input.outputDir,
        }),
        vtt: await resolvedDependencies.createPortableArtifactDescriptor({
          filePath: captionsVttPath,
          mediaType: "text/vtt",
          outputDir: input.outputDir,
        }),
      },
      chapters: await resolvedDependencies.createPortableArtifactDescriptor({
        filePath: chaptersPath,
        mediaType: "application/json",
        outputDir: input.outputDir,
      }),
      audio: await Promise.all(
        exportedAudio.map(async (artifact) => ({
          ...(await resolvedDependencies.createPortableArtifactDescriptor({
            filePath: artifact.outputPath,
            mediaType: detectAudioMediaType(artifact.outputPath),
            outputDir: input.outputDir,
          })),
          cacheKey: artifact.cacheKey,
          durationMs: artifact.durationMs,
        })),
      ),
    },
    timeline: {
      chapters: input.chapters,
      narrations: input.recordedNarrations.map((narration) => ({
        cacheKey: narration.cacheKey,
        chapterTitle: narration.chapterTitle,
        durationMs: narration.durationMs,
        endMs: narration.endMs,
        startMs: narration.startMs,
        text: narration.text,
      })),
    },
  });
  await resolvedDependencies.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    captionsSrtPath,
    captionsVttPath,
    chaptersPath,
    outputDir: input.outputDir,
    videoPath: path.join(input.outputDir, "video.mp4"),
  };
}

function detectAudioMediaType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();

  switch (extension) {
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".ogg":
      return "audio/ogg";
    case ".m4a":
      return "audio/mp4";
    case ".webm":
      return "audio/webm";
    default:
      return "application/octet-stream";
  }
}
