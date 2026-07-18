import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { access, cp, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { locateBundledKokoroWorker } from "../../packages/cli/src/commands/generate.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliRoot = path.join(repoRoot, "packages/cli");
const canonicalWorker = path.join(repoRoot, "packages/tts-kokoro/worker/demohunter_kokoro_worker.py");
const generatedWorker = path.join(cliRoot, "dist/workers/demohunter_kokoro_worker.py");
const tempRoots: string[] = [];
let packageRoot = "";
let tarballPath = "";
let statusBeforeBuild = "";

beforeAll(async () => {
  statusBeforeBuild = await gitStatus();
  await run([process.execPath, "run", "build"], repoRoot);

  const pack = await run(["npm", "pack", "--json", "--ignore-scripts"], cliRoot);
  const packed = JSON.parse(pack.stdout) as Array<{ filename: string }>;
  tarballPath = path.join(cliRoot, packed[0]!.filename);

  const installRoot = await mkdtemp(path.join(os.tmpdir(), "demohunter-kokoro-package-"));
  tempRoots.push(installRoot);
  const nodeModules = path.join(installRoot, "node_modules");
  packageRoot = path.join(nodeModules, "demohunter");
  await mkdir(packageRoot, { recursive: true });
  await run(["tar", "-xzf", tarballPath, "--strip-components=1", "-C", packageRoot], installRoot);

  for (const dependency of ["typescript", "playwright", "playwright-core"]) {
    const resolveFrom = dependency === "playwright-core"
      ? Bun.resolveSync("playwright", cliRoot)
      : cliRoot;
    const packageSource = await findPackageRoot(Bun.resolveSync(dependency, resolveFrom));
    await cp(packageSource, path.join(nodeModules, dependency), { recursive: true });
  }

  const binRoot = path.join(nodeModules, ".bin");
  await mkdir(binRoot, { recursive: true });
  await symlink(path.relative(binRoot, path.join(packageRoot, "dist/bin/demohunter.js")), path.join(binRoot, "demohunter"));
}, 30_000);

afterAll(async () => {
  if (tarballPath !== "") await rm(tarballPath, { force: true });
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Kokoro packed CLI contract", () => {
  test("discovers the identical weight-free worker from source, dist, and installed layouts", async () => {
    const layouts = [
      path.join(cliRoot, "src/commands/generate.ts"),
      path.join(cliRoot, "dist/index.js"),
      path.join(cliRoot, "dist/bin/demohunter.js"),
      path.join(packageRoot, "dist/index.js"),
      path.join(packageRoot, "dist/bin/demohunter.js"),
    ];
    const discovered = await Promise.all(layouts.map((entry) => locateBundledKokoroWorker(pathToFileURL(entry).href)));
    const hashes = await Promise.all([canonicalWorker, generatedWorker, ...discovered].map(hashFile));

    expect(new Set(hashes).size).toBe(1);
    expect(await readFile(canonicalWorker, "utf8")).not.toMatch(/https?:\/\/|pip\s+install|curl\s|wget\s/);
    expect(await gitStatus()).toBe(statusBeforeBuild);
  }, 30_000);

  test("packs a standalone CLI with no private workspace dependency, weights, secrets, or local paths", async () => {
    const files = await listFiles(packageRoot);
    const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as Record<string, unknown>;
    const manifestText = JSON.stringify(packageJson);
    const shippedText = await readTextFiles(packageRoot, files);

    expect(files).toContain("dist/workers/demohunter_kokoro_worker.py");
    expect(files.filter((name) => name.endsWith("demohunter_kokoro_worker.py"))).toHaveLength(1);
    expect(files.some((name) => /(^|\/)(?:models?|voices?|cache|\.venv|venv)(?:\/|$)/i.test(name))).toBe(false);
    expect(files.some((name) => /\.(?:onnx|npz|pt|pth|safetensors|wav|mp3|flac|sidecar)$/i.test(name))).toBe(false);
    const runtimeManifest = JSON.stringify({
      dependencies: packageJson.dependencies,
      optionalDependencies: packageJson.optionalDependencies,
      peerDependencies: packageJson.peerDependencies,
    });
    expect(runtimeManifest).not.toContain("workspace:");
    expect(runtimeManifest).not.toContain("@demohunter/tts-kokoro");
    expect(shippedText).not.toContain('from "@demohunter/tts-kokoro"');
    expect(shippedText).not.toContain(repoRoot);
    expect(shippedText).not.toContain("/workspace/demohunter-kokoro");
    expect(shippedText).not.toMatch(/(?:OPENAI|ELEVENLABS)_API_KEY\s*=\s*[^"'\s}]+/);
  });

  test("runs both the clean installed package entry and global-style bin without workspace links", async () => {
    const installedStats = await lstat(packageRoot);
    expect(installedStats.isSymbolicLink()).toBe(false);
    await expect(access(path.join(packageRoot, "node_modules/@demohunter/tts-kokoro"))).rejects.toThrow();

    const imported = await import(`${pathToFileURL(path.join(packageRoot, "dist/index.js")).href}?contract=${Date.now()}`) as {
      kokoro?: (options?: unknown) => unknown;
      kokoroTTS?: (options?: unknown) => unknown;
    };
    expect(imported.kokoro).toBeFunction();
    expect(imported.kokoroTTS).toBeFunction();

    const bin = await run([process.execPath, path.join(packageRoot, "dist/bin/demohunter.js"), "--version"], packageRoot);
    const globalBin = await run([process.execPath, path.join(packageRoot, "../.bin/demohunter"), "--version"], packageRoot);
    expect(bin.stdout.trim()).toBe("0.1.4");
    expect(globalBin.stdout.trim()).toBe(bin.stdout.trim());
  });
});

async function gitStatus(): Promise<string> {
  return (await run(["git", "status", "--short"], repoRoot)).stdout;
}

async function hashFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function findPackageRoot(resolvedEntry: string): Promise<string> {
  let candidate = path.dirname(resolvedEntry);
  while (candidate !== path.dirname(candidate)) {
    try {
      await access(path.join(candidate, "package.json"));
      return candidate;
    } catch {
      candidate = path.dirname(candidate);
    }
  }
  throw new Error(`Could not locate package root for ${resolvedEntry}`);
}

async function listFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else result.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }
  await walk(root);
  return result.sort();
}

async function readTextFiles(root: string, files: readonly string[]): Promise<string> {
  const textFiles = files.filter((name) => /\.(?:js|mjs|json|md|ts|py|map)$/.test(name));
  return (await Promise.all(textFiles.map((name) => readFile(path.join(root, name), "utf8")))).join("\n");
}

async function run(cmd: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const child = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe", env: process.env });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Command failed (${exitCode}): ${cmd.join(" ")}\n${stdout}\n${stderr}`);
  return { stdout, stderr };
}
