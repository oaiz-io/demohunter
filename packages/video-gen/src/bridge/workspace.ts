import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ContentSpec } from "../content/schema.js";
import { serializeContentSpec } from "../content/schema.js";
import { VideoGenError } from "../pipeline/errors.js";
import type { CompiledTour, GenerationWorkspace, RenderedSite } from "../pipeline/types.js";
import {
  ensureDir,
  pathExists,
  removeGenerationWorkspace,
  writeFileAtomic,
} from "../util/fs.js";

export function resolveGenerationPaths(input: {
  outputDir: string;
  tourId: string;
}): GenerationWorkspace {
  const outputDir = path.resolve(input.outputDir);
  const workspaceDir = path.join(outputDir, "video-gen", input.tourId);
  const siteDir = path.join(workspaceDir, "site");
  return {
    tourId: input.tourId,
    outputDir,
    workspaceDir,
    siteDir,
    contentSpecPath: path.join(workspaceDir, "content-spec.json"),
    tourPath: path.join(workspaceDir, `${input.tourId}.tour.ts`),
    configPath: path.join(workspaceDir, "demohunter.config.ts"),
    finalOutputDir: path.join(outputDir, input.tourId),
    cacheDir: path.join(outputDir, "cache"),
  };
}

export async function assertNoWorkspaceCollision(workspace: GenerationWorkspace): Promise<void> {
  const collisions: string[] = [];
  if (await pathExists(workspace.workspaceDir)) {
    collisions.push(workspace.workspaceDir);
  }
  if (await pathExists(workspace.finalOutputDir)) {
    collisions.push(workspace.finalOutputDir);
  }
  if (collisions.length > 0) {
    throw new VideoGenError(
      "WORKSPACE_COLLISION",
      "A previous generation already exists at the target paths. Remove it before regenerating.",
      { details: collisions },
    );
  }
}

export async function createGenerationWorkspace(input: {
  workspace: GenerationWorkspace;
  spec: ContentSpec;
  site: RenderedSite;
  compiled: CompiledTour;
  configSource: string;
}): Promise<GenerationWorkspace> {
  const stagingDir = `${input.workspace.workspaceDir}.staging.${process.pid}.${Date.now()}`;
  try {
    await ensureDir(path.join(stagingDir, "site"));
    await writeFileAtomic(
      path.join(stagingDir, "content-spec.json"),
      serializeContentSpec(input.spec),
    );
    await writeFile(path.join(stagingDir, "site", "index.html"), input.site.html, "utf8");
    await writeFile(path.join(stagingDir, "site", "styles.css"), input.site.css, "utf8");
    await writeFile(path.join(stagingDir, "site", "app.js"), input.site.javascript, "utf8");
    await writeFile(
      path.join(stagingDir, `${input.workspace.tourId}.tour.ts`),
      input.compiled.moduleSource,
      "utf8",
    );
    await writeFile(path.join(stagingDir, "demohunter.config.ts"), input.configSource, "utf8");

    await ensureDir(path.dirname(input.workspace.workspaceDir));
    await rename(stagingDir, input.workspace.workspaceDir);
    return input.workspace;
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof VideoGenError) {
      throw error;
    }
    throw new VideoGenError(
      "RENDER_FAILED",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}

export async function cleanupWorkspaceIfRequested(input: {
  workspace: GenerationWorkspace;
  cleanup: boolean;
}): Promise<boolean> {
  if (!input.cleanup) {
    return true;
  }
  await removeGenerationWorkspace({
    workspaceDir: input.workspace.workspaceDir,
    outputDir: input.workspace.outputDir,
  });
  return false;
}

export async function ensureOutputRootWritable(outputDir: string): Promise<void> {
  const absolute = path.resolve(outputDir);
  await mkdir(absolute, { recursive: true });
  const probe = path.join(absolute, `.video-gen-write-probe.${process.pid}`);
  await writeFile(probe, "ok", "utf8");
  await rm(probe, { force: true });
}
