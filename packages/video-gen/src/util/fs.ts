import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readUtf8(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

/**
 * Write UTF-8 content atomically via a temp file in the same directory.
 */
export async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  const absolutePath = path.resolve(filePath);
  const directory = path.dirname(absolutePath);
  await ensureDir(directory);
  const tempPath = path.join(
    directory,
    `.${path.basename(absolutePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await writeFile(tempPath, contents, "utf8");
    await rename(tempPath, absolutePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Remove a generation workspace only when it is contained under
 * `<outputDir>/video-gen/` and is not the filesystem root, cwd, or output root.
 */
export async function removeGenerationWorkspace(input: {
  workspaceDir: string;
  outputDir: string;
}): Promise<void> {
  const workspaceDir = path.resolve(input.workspaceDir);
  const outputDir = path.resolve(input.outputDir);
  const videoGenRoot = path.resolve(outputDir, "video-gen");
  const cwd = path.resolve(process.cwd());

  assertSafeRemovalTarget({
    target: workspaceDir,
    allowedRoot: videoGenRoot,
    forbidden: [outputDir, cwd, path.parse(workspaceDir).root],
  });

  await rm(workspaceDir, { recursive: true, force: true });
}

export async function removeStagingDir(stagingDir: string): Promise<void> {
  const absolute = path.resolve(stagingDir);
  const tmpRoot = path.resolve(os.tmpdir());
  if (!isPathInside(tmpRoot, absolute) && !path.basename(absolute).includes(".staging.")) {
    throw new Error(`Refusing to remove non-staging directory: ${absolute}`);
  }
  await rm(absolute, { recursive: true, force: true });
}

export function assertSafeRemovalTarget(input: {
  target: string;
  allowedRoot: string;
  forbidden: string[];
}): void {
  const target = path.resolve(input.target);
  const allowedRoot = path.resolve(input.allowedRoot);

  if (target === allowedRoot) {
    throw new Error(`Refusing to remove video-gen root: ${target}`);
  }

  for (const forbidden of input.forbidden) {
    if (target === path.resolve(forbidden)) {
      throw new Error(`Refusing to remove protected path: ${target}`);
    }
  }

  if (!isPathInside(allowedRoot, target)) {
    throw new Error(
      `Refusing to remove path outside ${allowedRoot}: ${target}`,
    );
  }
}

export function isPathInside(parent: string, child: string): boolean {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  if (resolvedParent === resolvedChild) {
    return false;
  }
  const relative = path.relative(resolvedParent, resolvedChild);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
