import { afterEach, describe, expect, test } from "bun:test";
import { access, cp, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parsePortableOutputManifest } from "../../packages/manifest/src/index.js";
import { getDemohunterTarballPath } from "../helpers/demohunter-tarball.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const builtCliEntryPoint = path.join(repoRoot, "packages/cli/dist/bin/demohunter.js");
const narrationFixturePath = path.join(repoRoot, "tests/fixtures/tours/phase-04-narration.tour.ts");
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { force: true, recursive: true })));
});

describe("built cli bin contract", () => {
  test(
    "runs init and generate from compiled dist output",
    async () => {
      await runRepoCommand(["x", "tsc", "-b", "tsconfig.json", "--pretty", "false"]);

      const cwd = await makeTempProject();

      const initResult = await spawnCommand([process.execPath, builtCliEntryPoint, "init"], cwd);
      expect(initResult.exitCode).toBe(0);
      expect(await listFiles(cwd)).toEqual([
        "demohunter.config.ts",
        "demos/sample-site/index.html",
        "demos/sample.tour.ts",
      ]);

      const generateResult = await spawnCommand(
        [process.execPath, builtCliEntryPoint, "generate", "demos/sample.tour.ts"],
        cwd,
      );
      expect(generateResult.exitCode).toBe(0);

      const outputDir = path.join(cwd, ".demohunter/sample-smoke");
      await access(path.join(outputDir, "video.mp4"));
      await access(path.join(outputDir, "chapters.json"));
      await access(path.join(outputDir, "captions.srt"));
      await access(path.join(outputDir, "captions.vtt"));
      await access(path.join(outputDir, "manifest.json"));
      await access(path.join(outputDir, "poster.jpg"));
      await expect(access(path.join(outputDir, "audio"))).rejects.toThrow();
      expect((await readdir(outputDir)).sort()).toEqual([
        "captions.srt",
        "captions.vtt",
        "chapters.json",
        "manifest.json",
        "poster.jpg",
        "video.mp4",
      ]);
    },
    45_000,
  );

  test(
    "proves narrated generation, cache commands, offline reuse, and missing-key failure through compiled dist output",
    async () => {
      await runRepoCommand(["x", "tsc", "-b", "tsconfig.json", "--pretty", "false"]);

      const cwd = await makeTempProject();
      const tourPath = "demos/phase-04-narration.tour.ts";
      const preloadPath = await writeOpenAIMockPreload(cwd);

      await writeGenerationPackageJson(cwd);
      await writeGenerationConfig(cwd, { recordFormat: "webm", ttsFormat: "wav" });
      await writeGenerationSite(cwd);
      await mkdir(path.join(cwd, "demos"), { recursive: true });
      await cp(narrationFixturePath, path.join(cwd, tourPath));

      const installResult = await spawnCommand([process.execPath, "install"], cwd);
      expect(installResult.exitCode).toBe(0);

      const generateResult = await spawnCommand(
        [process.execPath, "--preload", preloadPath, builtCliEntryPoint, "generate", tourPath],
        cwd,
        { OPENAI_API_KEY: "test-openai-key" },
      );
      expect(generateResult.exitCode).toBe(0);

      const outputDir = path.join(cwd, ".demohunter/phase-04-narration");
      const chapters = JSON.parse(await readFile(path.join(outputDir, "chapters.json"), "utf8")) as Array<{
        startMs: number;
        title: string;
      }>;
      const captionsSrt = await readFile(path.join(outputDir, "captions.srt"), "utf8");
      const manifest = parsePortableOutputManifest(
        JSON.parse(await readFile(path.join(outputDir, "manifest.json"), "utf8")),
      );

      await access(path.join(outputDir, "video.mp4"));
      await access(path.join(outputDir, "video.webm"));
      await access(path.join(outputDir, "manifest.json"));
      await access(path.join(outputDir, "poster.jpg"));
      await access(path.join(outputDir, "captions.srt"));
      await access(path.join(outputDir, "captions.vtt"));
      await expect(access(path.join(cwd, ".demohunter/phase-04-narration.recording.webm"))).rejects.toThrow();
      expect(chapters.map((chapter) => chapter.title)).toEqual(["Workspace Overview", "Payment History"]);
      expect(captionsSrt).toContain("The billing workspace keeps invoices, exports, and credits together.");
      expect(manifest.artifacts.videos.mp4.path).toBe("video.mp4");
      expect(manifest.artifacts.videos.webm?.path).toBe("video.webm");
      expect(manifest.artifacts.audio.every((artifact) => artifact.path.endsWith(".wav"))).toBe(true);
      expect(manifest.artifacts.audio.every((artifact) => !artifact.path.startsWith("/"))).toBe(true);
      expect(manifest.artifacts.audio.every((artifact) => !artifact.path.includes(cwd))).toBe(true);
      await expectVideoToContainAudio(path.join(outputDir, "video.mp4"), cwd);
      await expectVideoToContainAudio(path.join(outputDir, "video.webm"), cwd);
      expect((await readdir(outputDir)).sort()).toEqual([
        "audio",
        "captions.srt",
        "captions.vtt",
        "chapters.json",
        "manifest.json",
        "poster.jpg",
        "video.mp4",
        "video.webm",
      ]);
      expect((await readdir(path.join(outputDir, "audio"))).every((fileName) => fileName.endsWith(".wav"))).toBe(true);

      const cacheList = await spawnCommand([process.execPath, builtCliEntryPoint, "cache", "list"], cwd);
      expect(cacheList.exitCode).toBe(0);
      expect(JSON.parse(cacheList.stdout).entries).toHaveLength(3);

      const offlineGenerate = await spawnCommand([process.execPath, builtCliEntryPoint, "generate", tourPath], cwd);
      expect(offlineGenerate.exitCode).toBe(0);

      const clearResult = await spawnCommand([process.execPath, builtCliEntryPoint, "cache", "clear"], cwd);
      expect(clearResult.exitCode).toBe(0);

      const missingKeyGenerate = await spawnCommand([process.execPath, builtCliEntryPoint, "generate", tourPath], cwd);
      expect(missingKeyGenerate.exitCode).toBe(1);
      expect(missingKeyGenerate.stderr).toContain("OPENAI_API_KEY");

    },
    60_000,
  );
});

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
  const env = {
    ...process.env,
    ...envOverrides,
  } as Record<string, string | undefined>;
  delete env.OPENAI_API_KEY;
  delete env.DEMOHUNTER_RUN_LIVE_OPENAI_TESTS;
  Object.assign(env, envOverrides);

  const processResult = Bun.spawn({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    processResult.exited,
    new Response(processResult.stdout).text(),
    new Response(processResult.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
}

async function makeTempProject(): Promise<string> {
  const tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "demohunter-built-bin-")));
  tempRoots.push(tempRoot);
  return tempRoot;
}

async function expectVideoToContainAudio(videoPath: string, cwd: string): Promise<void> {
  const probe = await spawnCommand(
    ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", videoPath],
    cwd,
  );

  expect(probe.exitCode).toBe(0);
  expect(probe.stdout.trim()).toContain("audio");
}

async function listFiles(cwd: string): Promise<string[]> {
  const results = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd, onlyFiles: true }));
  return results.sort();
}

async function writeGenerationPackageJson(cwd: string): Promise<void> {
  const tarballPath = await getDemohunterTarballPath();
  await writeFile(
    path.join(cwd, "package.json"),
    `${JSON.stringify(
      {
        name: "phase-04-built-generation-contract",
        private: true,
        type: "module",
        dependencies: {
          demohunter: `file:${tarballPath}`,
        },
      },
      null,
      2,
    )}\n`,
  );
}

async function writeGenerationConfig(
  cwd: string,
  options: { recordFormat?: "webm"; ttsFormat?: "wav" } = {},
): Promise<void> {
  const sitePath = path.join(cwd, "site", "index.html");
  const recordBlock = options.recordFormat === undefined
    ? ""
    : `  record: { format: ${JSON.stringify(options.recordFormat)} },\n`;
  const ttsBlock = options.ttsFormat === undefined ? "" : `  tts: { format: ${JSON.stringify(options.ttsFormat)} },\n`;

  await writeFile(
    path.join(cwd, "demohunter.config.ts"),
    `export default {
  baseURL: ${JSON.stringify(pathToFileURL(sitePath).href)},
${recordBlock}${ttsBlock}};
`,
  );
}

async function writeGenerationSite(cwd: string): Promise<void> {
  const siteDir = path.join(cwd, "site");
  await mkdir(siteDir, { recursive: true });
  await writeFile(
    path.join(siteDir, "index.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Phase 4 Generation Contract</title>
  </head>
  <body>
    <main>
      <form id="login-form">
        <label>
          Email
          <input aria-label="Email" />
        </label>
        <label>
          Password
          <input aria-label="Password" type="password" />
        </label>
        <button type="button" id="sign-in">Sign in</button>
      </form>

      <section id="dashboard" hidden>
        <h1>Workspace home</h1>
        <button type="button" id="open-billing-workspace">Open billing workspace</button>
        <section id="billing-workspace" hidden>
          <h2>Billing workspace</h2>
          <button type="button" id="reveal-payment-history">Reveal payment history</button>
          <section id="payment-history" hidden>
            <h2>Payment history</h2>
            <ul>
              <li>Invoice #1001</li>
              <li>Invoice #1002</li>
            </ul>
          </section>
        </section>
        <button type="button" id="sign-out">Sign out</button>
      </section>
    </main>

    <script type="module">
      const loginForm = document.querySelector("#login-form");
      const dashboard = document.querySelector("#dashboard");
      const billingWorkspace = document.querySelector("#billing-workspace");
      const paymentHistory = document.querySelector("#payment-history");

      document.querySelector("#sign-in")?.addEventListener("click", () => {
        loginForm.hidden = true;
        dashboard.hidden = false;
      });

      document.querySelector("#open-billing-workspace")?.addEventListener("click", () => {
        billingWorkspace.hidden = false;
      });

      document.querySelector("#reveal-payment-history")?.addEventListener("click", () => {
        paymentHistory.hidden = false;
      });

      document.querySelector("#sign-out")?.addEventListener("click", () => {
        paymentHistory.hidden = true;
        billingWorkspace.hidden = true;
        dashboard.hidden = true;
        loginForm.hidden = false;
      });
    </script>
  </body>
</html>
`,
  );
}

async function writeOpenAIMockPreload(cwd: string): Promise<string> {
  const preloadPath = path.join(cwd, "mock-openai.ts");
  await writeFile(
    preloadPath,
    `const OPENAI_SPEECH_ENDPOINT = "https://api.openai.com/v1/audio/speech";
const originalFetch = globalThis.fetch?.bind(globalThis);

function writeString(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function createSilentWav(durationMs, sampleRate = 24000) {
  const channelCount = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.max(1, Math.round((sampleRate * durationMs) / 1000));
  const blockAlign = channelCount * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = frameCount * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  return new Uint8Array(buffer);
}

globalThis.fetch = async (input, init) => {
  if (String(input) !== OPENAI_SPEECH_ENDPOINT) {
    if (!originalFetch) {
      throw new Error("Unexpected fetch without a base implementation.");
    }

    return originalFetch(input, init);
  }

  const request = JSON.parse(String(init?.body ?? "{}"));
  const text = String(request.input ?? "");
  const durationMs = Math.max(600, Math.min(1800, text.length * 25));

  return new Response(createSilentWav(durationMs), {
    status: 200,
    headers: {
      "content-type": "audio/wav",
    },
  });
};
`,
  );

  return preloadPath;
}
