import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliPackageDir = path.join(repoRoot, "packages", "cli");

let cachedTarball: Promise<string> | undefined;

/**
 * Returns the absolute path to a packed `demohunter-<version>.tgz` tarball
 * that's safe to use as a `file:` dependency in test temp projects.
 *
 * `bun pm pack` rewrites workspace:* references to concrete versions, so
 * installing from the tarball avoids the workspace resolution failure that
 * would otherwise hit when bun reads `packages/cli/package.json` directly.
 *
 * The tarball is built lazily and shared across tests within the same
 * process. Process exit cleans up the temp directory.
 */
export function getDemohunterTarballPath(): Promise<string> {
  cachedTarball ??= buildTarball();
  return cachedTarball;
}

async function buildTarball(): Promise<string> {
  const tarballSourceDir = await mkdtemp(path.join(os.tmpdir(), "demohunter-pack-source-"));
  process.on("exit", () => {
    rm(tarballSourceDir, { force: true, recursive: true }).catch(() => {});
  });

  await runCommand([process.execPath, "pm", "pack"], cliPackageDir);

  const entries = await readdir(cliPackageDir);
  const tarballName = entries.find((entry) => entry.startsWith("demohunter-") && entry.endsWith(".tgz"));

  if (tarballName === undefined) {
    throw new Error(`Could not find packed demohunter tarball in ${cliPackageDir}`);
  }

  const sourcePath = path.join(cliPackageDir, tarballName);
  const cachedPath = path.join(tarballSourceDir, tarballName);

  await copyFile(sourcePath, cachedPath);
  await rm(sourcePath, { force: true });

  return cachedPath;
}

async function runCommand(cmd: string[], cwd: string): Promise<void> {
  const child = Bun.spawn({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${cmd.join(" ")}\nstdout: ${stdout}\nstderr: ${stderr}`);
  }
}
