import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
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
let installRoot = "";
let tarballPath = "";
let fixtureServer: Server | undefined;
let fixtureBaseURL = "";

beforeAll(async () => {
  await rm(path.join(cliRoot, "dist"), { force: true, recursive: true });

  const pack = await run(["npm", "pack", "--json", "--silent"], cliRoot);
  const packed = parsePackJson(pack.stdout);
  tarballPath = path.join(cliRoot, packed[0]!.filename);

  installRoot = await mkdtemp(path.join(os.tmpdir(), "demohunter-kokoro-package-"));
  tempRoots.push(installRoot);
  const fixturesRoot = path.join(installRoot, "fixtures");
  const playwrightRoot = path.join(fixturesRoot, "playwright");
  const typescriptRoot = path.join(fixturesRoot, "typescript");
  const nodeTypesRoot = path.join(fixturesRoot, "types-node");
  await writeFixturePackage(playwrightRoot, {
    name: "playwright",
    version: "1.61.0",
    type: "module",
    exports: { ".": "./index.js", "./package.json": "./package.json" },
  }, `const launcher = { launch: async () => ({ close: async () => undefined }) };
export const chromium = launcher;
export const firefox = launcher;
export const webkit = launcher;
`);
  await writeFixturePackage(typescriptRoot, {
    name: "typescript",
    version: "5.9.3",
    type: "module",
    exports: "./index.js",
  }, `export const JsxEmit = { ReactJSX: 1 };
export const ModuleKind = { ESNext: 99 };
export const ScriptTarget = { ES2022: 9 };
export function transpileModule(source) { return { outputText: source }; }
`);
  await writeFixturePackage(nodeTypesRoot, {
    name: "@types/node",
    version: "25.6.0",
    types: "./index.d.ts",
  }, "", { "index.d.ts": "export {};\n" });

  await writeFile(path.join(installRoot, "package.json"), `${JSON.stringify({
    name: "demohunter-kokoro-install-fixture",
    private: true,
    dependencies: {
      "@types/node": `file:${nodeTypesRoot}`,
      demohunter: `file:${tarballPath}`,
      playwright: `file:${playwrightRoot}`,
      typescript: `file:${typescriptRoot}`,
    },
  }, null, 2)}\n`);
  await run([
    "npm",
    "install",
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
  ], installRoot);

  const nodeModules = path.join(installRoot, "node_modules");
  packageRoot = path.join(nodeModules, "demohunter");
  fixtureServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });
  await new Promise<void>((resolve, reject) => {
    fixtureServer!.once("error", reject);
    fixtureServer!.listen(0, "127.0.0.1", () => resolve());
  });
  const address = fixtureServer.address();
  if (address === null || typeof address === "string") throw new Error("Fixture HTTP server did not bind a TCP port.");
  fixtureBaseURL = `http://127.0.0.1:${address.port}`;
}, 60_000);

afterAll(async () => {
  if (fixtureServer !== undefined) {
    await new Promise<void>((resolve, reject) => fixtureServer!.close((error) => error ? reject(error) : resolve()));
  }
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
    for (const generatedDoc of ["README.md", "LICENSE", "CHANGELOG.md"]) {
      await expect(access(path.join(cliRoot, generatedDoc))).rejects.toThrow();
    }
  }, 30_000);

  test("packs a standalone CLI with no private workspace dependency, weights, secrets, or local paths", async () => {
    const files = await listFiles(packageRoot);
    const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as Record<string, unknown>;
    const manifestText = JSON.stringify(packageJson);
    const shippedText = await readTextFiles(packageRoot, files);

    expect(files).toContain("dist/workers/demohunter_kokoro_worker.py");
    expect(files.filter((name) => name.endsWith("demohunter_kokoro_worker.py"))).toHaveLength(1);
    expect(files.some((name) => /(^|\/)(?:models?|voices?|cache|\.venv|venv)(?:\/|$)/i.test(name))).toBe(false);
    expect(files.some((name) => /\.(?:bin|onnx|npz|pt|pth|safetensors|wav|mp3|flac|sidecar)$/i.test(name))).toBe(false);
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
    expect(shippedText).not.toMatch(/(?:OPENAI|ELEVENLABS)_API_KEY\s*=\s*[A-Za-z0-9_-]{20,}/);
  });

  test("runs the npm-installed package entry and npm-created bin without workspace links", async () => {
    const installedStats = await lstat(packageRoot);
    expect(installedStats.isSymbolicLink()).toBe(false);
    await expect(access(path.join(installRoot, "node_modules/@demohunter/tts-kokoro"))).rejects.toThrow();

    const imported = await import(`${pathToFileURL(path.join(packageRoot, "dist/index.js")).href}?contract=${Date.now()}`) as {
      kokoro?: (options?: unknown) => unknown;
      kokoroTTS?: (options?: unknown) => unknown;
    };
    expect(imported.kokoro).toBeFunction();
    expect(imported.kokoroTTS).toBeFunction();

    const bin = await run([process.execPath, path.join(packageRoot, "dist/bin/demohunter.js"), "--version"], packageRoot);
    const npmBinPath = path.join(installRoot, "node_modules/.bin/demohunter");
    await access(npmBinPath);
    const globalBin = await run([npmBinPath, "--version"], packageRoot);
    expect(bin.stdout.trim()).toBe("0.1.4");
    expect(globalBin.stdout.trim()).toBe(bin.stdout.trim());
  });

  test("starts the actual packaged worker through the npm-installed CLI doctor", async () => {
    const projectRoot = path.join(installRoot, "doctor-project");
    const commandRoot = path.join(projectRoot, "bin");
    const pythonModules = path.join(projectRoot, "python-modules");
    const modelPath = path.join(projectRoot, "kokoro-v1.0.onnx");
    const voicesPath = path.join(projectRoot, "voices-v1.0.bin");
    await Promise.all([
      mkdir(commandRoot, { recursive: true }),
      mkdir(pythonModules, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(modelPath, "fixture-model"),
      writeFile(voicesPath, "fixture-voices"),
    ]);
    await Promise.all([
      writeExecutable(path.join(commandRoot, "ffmpeg"), "#!/bin/sh\nexit 0\n"),
      writeExecutable(path.join(commandRoot, "ffprobe"), "#!/bin/sh\nexit 0\n"),
      writeFile(path.join(pythonModules, "kokoro_onnx.py"), "class Kokoro:\n    def __init__(self, model, voices):\n        self.model = model\n        self.voices = voices\n"),
      writeFile(path.join(pythonModules, "soundfile.py"), "def write(*args, **kwargs):\n    return None\n"),
    ]);
    await writeFile(path.join(projectRoot, "demohunter.config.ts"), `export default ${JSON.stringify({
      baseURL: fixtureBaseURL,
      providers: {
        tts: [{
          name: "kokoro",
          options: {
            modelPath,
            voicesPath,
            env: { PYTHONPATH: pythonModules },
          },
        }],
      },
      tts: { provider: "kokoro", voice: "af_heart", language: "en-US" },
    }, null, 2)};\n`);

    const npmBinPath = path.join(installRoot, "node_modules/.bin/demohunter");
    const doctor = await run([npmBinPath, "doctor"], projectRoot, {
      ...process.env,
      PATH: `${commandRoot}${path.delimiter}${process.env.PATH ?? ""}`,
    });
    const summary = JSON.parse(doctor.stdout) as {
      ok: boolean;
      checks: Array<{ name: string; status: string; message: string }>;
    };
    expect(summary.ok).toBe(true);
    expect(summary.checks.find((check) => check.name === "kokoro protocol/version/language capability")).toMatchObject({
      status: "pass",
    });
    const handshakeMessage = summary.checks.find(
      (check) => check.name === "kokoro protocol/version/language capability",
    )?.message;
    expect(handshakeMessage).toContain("protocol/version handshake");
    expect(handshakeMessage).toContain("asset");
  }, 30_000);
});

function parsePackJson(stdout: string): Array<{ filename: string }> {
  const start = stdout.lastIndexOf("\n[");
  const json = start === -1 ? stdout : stdout.slice(start + 1);
  return JSON.parse(json) as Array<{ filename: string }>;
}

async function hashFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
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

async function writeFixturePackage(
  root: string,
  manifest: Record<string, unknown>,
  indexSource: string,
  extraFiles: Readonly<Record<string, string>> = {},
): Promise<void> {
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(path.join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(path.join(root, "index.js"), indexSource),
    ...Object.entries(extraFiles).map(async ([name, source]) => {
      const destination = path.join(root, name);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, source);
    }),
  ]);
}

async function writeExecutable(filePath: string, source: string): Promise<void> {
  await writeFile(filePath, source);
  await chmod(filePath, 0o755);
}

async function run(
  cmd: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ stdout: string; stderr: string }> {
  const child = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe", env });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Command failed (${exitCode}): ${cmd.join(" ")}\n${stdout}\n${stderr}`);
  return { stdout, stderr };
}
