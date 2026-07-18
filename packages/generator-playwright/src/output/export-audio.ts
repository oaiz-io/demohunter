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

  await resolvedDependencies.mkdir(audioDir, { recursive: true });

  const exported = new Map<string, ExportedNarrationAudio>();

  for (const narration of narrations) {
    if (exported.has(narration.audioPath)) {
      continue;
    }

    const fileName = `${basename(narration.audioPath, extname(narration.audioPath))}${extname(narration.audioPath)}`;
    const outputPath = join(audioDir, fileName);
    await resolvedDependencies.copyFile(narration.audioPath, outputPath);
    exported.set(narration.audioPath, {
      cacheKey: narration.cacheKey,
      durationMs: narration.durationMs,
      outputPath,
    });
  }

  const expectedPaths = new Set(
    [...exported.values()].map((artifact) => resolve(artifact.outputPath)),
  );
  const existingEntries = await resolvedDependencies.readdir(audioDir, { withFileTypes: true });
  await Promise.all(existingEntries
    .map((entry) => join(audioDir, entry.name))
    .filter((entryPath) => !expectedPaths.has(resolve(entryPath)))
    .map((entryPath) => resolvedDependencies.rm(entryPath, { recursive: true, force: true })));

  return [...exported.values()];
}
