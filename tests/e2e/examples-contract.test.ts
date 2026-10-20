import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Subprocess } from "bun";

import { parsePortableOutputManifest } from "../../packages/manifest/src/index.js";
import { createNarrationRequest, resolveNarrationFromCache } from "../../packages/tts-core/src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tempRoots: string[] = [];
const serverProcesses: ManagedServer[] = [];
let repoBuildPromise: Promise<void> | undefined;

const EXAMPLES = [
  {
    readyText: "Hello DemoHunter!",
    name: "Next.js",
    projectRoot: path.join(repoRoot, "examples", "nextjs-demo"),
    tourId: "nextjs-demo",
    narrationTexts: [
      "Welcome to DemoHunter. A tiny Next.js page is all we need to show a narrated tour.",
      "One click reveals the finale, proving DemoHunter captures real state changes and narrates them.",
    ],
  },
  {
    name: "Vite",
    projectRoot: path.join(repoRoot, "examples", "vite-demo"),
    tourId: "vite-demo",
    narrationTexts: [
      "This showcase video is demonstrating DemoHunter's recording effects. The blue ring around the heading is a Pass 2 highlight, added only to the video while the strict replay timeline stays unchanged.",
      "Now watch the injected cursor move to the button. The click creates a visible ripple, then the spotlight highlight dims the page and cuts out the result message.",
    ],
  },
] as const;

afterEach(async () => {
  await Promise.all(serverProcesses.splice(0).map((server) => stopServer(server)));
  await Promise.all(tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { force: true, recursive: true })));
  await Promise.all(
    EXAMPLES.map((example) => rm(path.join(example.projectRoot, ".demohunter"), { force: true, recursive: true })),
  );
});

describe("example app contract", () => {
  for (const example of EXAMPLES) {
    test(
      `generates portable output for the ${example.name} example from its own project root`,
      async () => {
        await ensureRepoBuilt();

        const outputRoot = await makeTempRoot(`${example.tourId}-output-`);
        const cacheRoot = path.join(outputRoot, "cache");

        await primeNarrationCache(cacheRoot, example.narrationTexts);

        // Any free port works; the example dev script and config both read PORT.
        const port = String(await freePort());
        const stopServer = startServer(example.projectRoot, port);
        serverProcesses.push(stopServer);

        await waitForReady(`http://127.0.0.1:${port}`, "readyText" in example ? example.readyText : undefined);

        const generateResult = await spawnCommand(
          [process.execPath, "run", "generate"],
          example.projectRoot,
          withoutNarrationEnv({
            DEMOHUNTER_EXAMPLE_CACHE_DIR: cacheRoot,
            DEMOHUNTER_EXAMPLE_OUTPUT_DIR: outputRoot,
          PORT: port,
          }),
        );

        if (generateResult.exitCode !== 0) {
          throw new Error(
            `Example generation failed for ${example.name}.\nSTDOUT:\n${generateResult.stdout}\nSTDERR:\n${generateResult.stderr}`,
          );
        }

        expect(generateResult.exitCode).toBe(0);

        const demoDir = path.join(outputRoot, example.tourId);
        const manifestPath = path.join(demoDir, "manifest.json");
        const chaptersPath = path.join(demoDir, "chapters.json");
        const videoPath = path.join(demoDir, "video.mp4");

        await access(manifestPath);
        await access(chaptersPath);
        await access(videoPath);

        const manifest = parsePortableOutputManifest(JSON.parse(await readFile(manifestPath, "utf8")));
        const chapters = JSON.parse(await readFile(chaptersPath, "utf8")) as Array<{ startMs: number; title: string }>;

        expect(manifest.artifacts.videos.mp4.path).toBe("video.mp4");
        expect(manifest.artifacts.audio).toHaveLength(example.narrationTexts.length);
        expect(chapters).toHaveLength(2);
        await expectVideoToContainAudio(videoPath);
      },
      60_000,
    );
  }
});

async function ensureRepoBuilt(): Promise<void> {
  repoBuildPromise ??= runRepoCommand(["run", "build"]);
  await repoBuildPromise;
}

async function makeTempRoot(prefix: string): Promise<string> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), `demohunter-${prefix}`));
  tempRoots.push(tempRoot);
  return tempRoot;
}

async function primeNarrationCache(cacheDir: string, texts: readonly string[]): Promise<void> {
  for (const [index, text] of texts.entries()) {
    const request = createNarrationRequest({
      provider: "openai",
      model: "gpt-4o-mini-tts",
      voice: "marin",
      format: "mp3",
      sampleRate: 24_000,
      instructions: "Speak clearly, calm, concise, product-demo style.",
      text,
    });

    await resolveNarrationFromCache({
      cacheDir,
      request,
      provider: {
        async synthesize(currentRequest) {
          return {
            request: currentRequest,
            output: {
              kind: "bytes",
              bytes: await createSilentMp3Bytes(650 + index * 175),
            },
            metadata: {
              provider: currentRequest.provider,
              model: currentRequest.model,
              voice: currentRequest.voice,
              format: currentRequest.format,
              sampleRate: currentRequest.sampleRate,
            },
          };
        },
      },
      measureDurationMs: async () => 650 + index * 175,
    });
  }
}

type ManagedServer = {
  cwd: string;
  process: Subprocess<"ignore", "ignore", "ignore">;
};

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function startServer(cwd: string, port: string): ManagedServer {
  const serverProcess = Bun.spawn({
    cmd: [process.execPath, "run", "dev"],
    cwd,
    stdout: "ignore",
    stderr: "ignore",
    env: buildEnv({ CI: "1", PORT: port }),
  });

  return { cwd, process: serverProcess };
}

async function stopServer(server: ManagedServer): Promise<void> {
  server.process.kill();
  await server.process.exited;
}

async function waitForReady(url: string, expectedText?: string, timeoutMs = 20_000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);

      if (response.ok && (expectedText === undefined || (await response.text()).includes(expectedText))) {
        return;
      }
    } catch {
      // Wait for the dev server to accept connections.
    }

    await Bun.sleep(250);
  }

  throw new Error(`Timed out waiting for example app readiness: ${url}`);
}

async function expectVideoToContainAudio(videoPath: string): Promise<void> {
  const result = await spawnCommand(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", videoPath], repoRoot);

  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toContain("audio");
}

async function createSilentMp3Bytes(durationMs: number): Promise<Uint8Array> {
  const processResult = Bun.spawn({
    cmd: [
      "ffmpeg",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=mono:sample_rate=24000",
      "-t",
      `${durationMs / 1000}`,
      "-q:a",
      "9",
      "-f",
      "mp3",
      "pipe:1",
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, bytes, stderr] = await Promise.all([
    processResult.exited,
    new Response(processResult.stdout).arrayBuffer(),
    new Response(processResult.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(stderr || `ffmpeg failed with exit code ${exitCode}`);
  }

  return new Uint8Array(bytes);
}

async function runRepoCommand(args: string[]): Promise<void> {
  const result = await spawnCommand([process.execPath, ...args], repoRoot);

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `Command failed: bun ${args.join(" ")}`);
  }
}

async function spawnCommand(
  cmd: string[],
  cwd: string,
  envOverrides: Record<string, string | undefined> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const processResult = Bun.spawn({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: buildEnv(envOverrides),
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    processResult.exited,
    new Response(processResult.stdout).text(),
    new Response(processResult.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
}

function buildEnv(overrides: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
      continue;
    }

    env[key] = value;
  }

  return env;
}

function withoutNarrationEnv(overrides: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    DEMOHUNTER_RUN_LIVE_OPENAI_TESTS: undefined,
    OPENAI_API_KEY: undefined,
    ...overrides,
  };
}
