import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

import type { RecordedNarration } from "../execute/generator-types.js";

export type ExportedNarrationAudio = {
  cacheKey: string;
  durationMs: number;
  outputPath: string;
};

type ExportAudioDependencies = {
  copyFile: typeof copyFile;
  mkdir: typeof mkdir;
  readdir: typeof readdir;
  rm: typeof rm;
};

const defaultDependencies: ExportAudioDependencies = {
  copyFile,
  mkdir,
  readdir,
  rm,
};

export async function exportAudio(
  outputDir: string,
  narrations: RecordedNarration[],
  dependencies: Partial<ExportAudioDependencies> = {},
): Promise<ExportedNarrationAudio[]> {
  const resolvedDependencies = {
    ...defaultDependencies,
    ...dependencies,
  };

  const audioDir = join(outputDir, "audio");

  if (narrations.length === 0) {
    await resolvedDependencies.rm(audioDir, { recursive: true, force: true });
    return [];
  }

  const planned = new Map<string, { artifact: ExportedNarrationAudio; sourcePath: string }>();
  const sourcesByPortableOutput = new Map<string, string>();

  for (const narration of narrations) {
    const normalizedSourcePath = resolve(narration.audioPath);
    if (planned.has(normalizedSourcePath)) {
      continue;
    }

    const fileName = `${basename(narration.audioPath, extname(narration.audioPath))}${extname(narration.audioPath)}`;
    const outputPath = join(audioDir, fileName);
    const portableOutputKey = resolve(outputPath).toLowerCase();
    const conflictingSourcePath = sourcesByPortableOutput.get(portableOutputKey);

    if (conflictingSourcePath !== undefined && conflictingSourcePath !== normalizedSourcePath) {
      throw new Error(
        `Cannot export narration audio: "${conflictingSourcePath}" and "${normalizedSourcePath}" both map to "audio/${fileName}". Ensure cached narration files have unique names.`,
      );
    }

    sourcesByPortableOutput.set(portableOutputKey, normalizedSourcePath);
    planned.set(normalizedSourcePath, {
      artifact: {
        cacheKey: narration.cacheKey,
        durationMs: narration.durationMs,
        outputPath,
      },
      sourcePath: narration.audioPath,
    });
  }

  await resolvedDependencies.mkdir(audioDir, { recursive: true });
  await Promise.all([...planned.values()].map(async ({ artifact, sourcePath }) => {
    await resolvedDependencies.copyFile(sourcePath, artifact.outputPath);
  }));

  const expectedPaths = new Set(
    [...planned.values()].map(({ artifact }) => resolve(artifact.outputPath)),
  );
  const existingEntries = await resolvedDependencies.readdir(audioDir, { withFileTypes: true });
  await Promise.all(existingEntries
    .map((entry) => join(audioDir, entry.name))
    .filter((entryPath) => !expectedPaths.has(resolve(entryPath)))
    .map((entryPath) => resolvedDependencies.rm(entryPath, { recursive: true, force: true })));

  return [...planned.values()].map(({ artifact }) => artifact);
}
