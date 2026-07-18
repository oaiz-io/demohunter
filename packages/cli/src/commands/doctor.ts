import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import * as playwright from "playwright";
import {
  hashKokoroAssetFile,
  KOKORO_LANGUAGES,
  parseReadyMessage,
  type KokoroPluginOptions,
  type KokoroReadyMessage,
} from "@demohunter/tts-kokoro";
import type { KokoroProviderDescriptor, ResolvedDemoHunterConfig } from "@demohunter/sdk";

import { loadConfig } from "../config/load-config.js";
import {
  resolveAuthoredCommand,
  resolveAuthoredFilesystemPath,
  resolveKokoroPluginOptions,
} from "./generate.js";

const execFileAsync = promisify(execFile);

const MINIMUM_PLAYWRIGHT_MAJOR = 1;
const MINIMUM_PLAYWRIGHT_MINOR = 61;

function readInstalledPlaywrightVersion(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("playwright/package.json") as { version?: string };

    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

function isPlaywrightTooOld(version: string): boolean {
  const [major, minor] = version
    .split(".")
    .map((part) => Number.parseInt(part, 10));

  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    return false;
  }

  if (major < MINIMUM_PLAYWRIGHT_MAJOR) {
    return true;
  }

  return major === MINIMUM_PLAYWRIGHT_MAJOR && minor < MINIMUM_PLAYWRIGHT_MINOR;
}

type DoctorStatus = "pass" | "warn" | "fail";

type DoctorCheck = {
  name: string;
  status: DoctorStatus;
  message: string;
};

type DoctorDependencies = {
  checkCommand: (command: string, args: string[]) => Promise<void>;
  fetch: typeof fetch;
  getPlaywrightVersion: () => string | undefined;
  loadConfig: typeof loadConfig;
  log: (message: string) => void;
  playwright: Pick<typeof playwright, "chromium" | "firefox" | "webkit">;
  accessPath: typeof access;
  statPath: typeof stat;
  resolveKokoroOptions: typeof resolveKokoroPluginOptions;
  probeKokoroWorker: typeof probeKokoroWorker;
  hashKokoroAsset: typeof hashKokoroAssetFile;
};

const defaultDependencies: DoctorDependencies = {
  checkCommand: async (command, args) => {
    await execFileAsync(command, args);
  },
  fetch: globalThis.fetch,
  getPlaywrightVersion: readInstalledPlaywrightVersion,
  loadConfig,
  log: console.log,
  playwright,
  accessPath: access,
  statPath: stat,
  resolveKokoroOptions: resolveKokoroPluginOptions,
  probeKokoroWorker,
  hashKokoroAsset: hashKokoroAssetFile,
};

export async function doctorCommand(
  cwd: string,
  dependencies: Partial<DoctorDependencies> = {},
): Promise<void> {
  const resolvedDependencies = {
    ...defaultDependencies,
    ...dependencies,
  };
  const checks: DoctorCheck[] = [];
  const loadedConfig = await runCheck(checks, "config", async () => {
    const loaded = await resolvedDependencies.loadConfig(cwd);

    return {
      message: `Loaded ${path.relative(cwd, loaded.configPath)}`,
      value: loaded,
    };
  });

  await runCheck(checks, "ffmpeg", async () => {
    await resolvedDependencies.checkCommand("ffmpeg", ["-version"]);
    return { message: "ffmpeg is available on PATH" };
  });
  await runCheck(checks, "ffprobe", async () => {
    await resolvedDependencies.checkCommand("ffprobe", ["-version"]);
    return { message: "ffprobe is available on PATH" };
  });

  const playwrightVersion = resolvedDependencies.getPlaywrightVersion();

  if (playwrightVersion === undefined) {
    checks.push({
      name: "playwright version",
      status: "warn",
      message:
        "Could not determine the installed Playwright version; visual effects require Playwright >=1.61",
    });
  } else if (isPlaywrightTooOld(playwrightVersion)) {
    checks.push({
      name: "playwright version",
      status: "warn",
      message: `Playwright ${playwrightVersion} is older than 1.61; cursor, click ripple, and highlight effects may not render`,
    });
  } else {
    checks.push({
      name: "playwright version",
      status: "pass",
      message: `Playwright ${playwrightVersion} satisfies the >=1.61 requirement for visual effects`,
    });
  }

  if (loadedConfig?.config.tts.provider === "openai") {
    checks.push(credentialCheck("OPENAI_API_KEY"));
  } else if (loadedConfig?.config.tts.provider === "elevenlabs") {
    checks.push(credentialCheck("ELEVENLABS_API_KEY"));
  } else if (loadedConfig?.config.tts.provider === "kokoro") {
    await addKokoroChecks(checks, loadedConfig.config, resolvedDependencies, loadedConfig.projectRoot);
  } else if (loadedConfig !== undefined) {
    checks.push({
      name: "narration provider",
      status: "fail",
      message: `Narration provider ${JSON.stringify(loadedConfig.config.tts.provider)} has no installed CLI implementation.`,
    });
  }

  if (loadedConfig !== undefined) {
    await runCheck(checks, "playwright browser", async () => {
      const browser = await resolvedDependencies.playwright[loadedConfig.config.browser].launch();

      try {
        return { message: `${loadedConfig.config.browser} launched successfully` };
      } finally {
        await browser.close();
      }
    });
    await runCheck(checks, "baseURL", async () => {
      await checkBaseURL(loadedConfig.config.baseURL, resolvedDependencies.fetch);
      return { message: `${loadedConfig.config.baseURL} is reachable` };
    });
    await runCheck(checks, "outputDir", async () => {
      await checkWritableDirectory(loadedConfig.config.outputDir);
      return { message: `${loadedConfig.config.outputDir} is writable` };
    });
    await runCheck(checks, "cacheDir", async () => {
      await checkWritableDirectory(loadedConfig.config.cacheDir);
      return { message: `${loadedConfig.config.cacheDir} is writable` };
    });
  } else {
    checks.push(
      {
        name: "playwright browser",
        status: "fail",
        message: "Skipped because config did not load",
      },
      {
        name: "baseURL",
        status: "fail",
        message: "Skipped because config did not load",
      },
      {
        name: "outputDir",
        status: "fail",
        message: "Skipped because config did not load",
      },
      {
        name: "cacheDir",
        status: "fail",
        message: "Skipped because config did not load",
      },
    );
  }

  const summary = {
    ok: checks.every((check) => check.status !== "fail"),
    checks,
  };

  resolvedDependencies.log(JSON.stringify(summary, null, 2));

  if (!summary.ok) {
    throw new Error("Doctor found failing checks.");
  }
}

function credentialCheck(name: "OPENAI_API_KEY" | "ELEVENLABS_API_KEY"): DoctorCheck {
  return process.env[name]
    ? { name, status: "pass", message: `${name} is set for uncached narration` }
    : { name, status: "warn", message: `${name} is not set; generation still works when narration is fully cached` };
}

async function addKokoroChecks(
  checks: DoctorCheck[],
  config: ResolvedDemoHunterConfig,
  dependencies: DoctorDependencies,
  projectRoot: string,
): Promise<void> {
  const descriptors = config.providers?.tts.filter(
    (descriptor): descriptor is KokoroProviderDescriptor => descriptor.name === "kokoro",
  ) ?? [];

  if (descriptors.length !== 1) {
    checks.push({
      name: "kokoro provider config",
      status: "fail",
      message: descriptors.length === 0
        ? "Kokoro is selected but providers.tts has no kokoro(...) descriptor. DemoHunter never installs or downloads Kokoro."
        : "Kokoro is configured more than once; keep exactly one kokoro(...) descriptor.",
    });
    return;
  }

  const authoredOptions = descriptors[0].options;
  const authoredExecutable = authoredOptions.runtime === "command"
    ? authoredOptions.executable
    : authoredOptions.pythonCommand ?? "python3";
  const executable = resolveAuthoredCommand(authoredExecutable, projectRoot);
  const modelPath = authoredOptions.modelPath === undefined
    ? undefined
    : resolveAuthoredFilesystemPath(authoredOptions.modelPath, projectRoot);
  const voicesPath = authoredOptions.voicesPath === undefined
    ? undefined
    : resolveAuthoredFilesystemPath(authoredOptions.voicesPath, projectRoot);
  const executableReady = await runCheck(checks, "kokoro executable", async () => {
    try {
      if (path.isAbsolute(executable) || executable.includes("/") || executable.includes("\\")) {
        await dependencies.accessPath(executable, constants.X_OK);
        if (!(await dependencies.statPath(executable)).isFile()) throw new Error("not a regular executable file");
      } else {
        await dependencies.checkCommand(process.platform === "win32" ? "where" : "which", [executable]);
      }
    } catch (error) {
      throw new Error(`kokoro executable not found: ${executable}. Install it separately or correct the configured command.`, { cause: error });
    }
    return { message: `${executable} is available without shell parsing`, value: true };
  });
  const modelReady = await runCheck(checks, "kokoro model", async () => {
    if (!authoredOptions.modelPath?.trim()) {
      if (authoredOptions.runtime === "command" && !authoredOptions.voicesPath?.trim()) {
        return { message: "model identity is supplied by the external command protocol", value: true };
      }
      throw new Error("model file missing from config: set providers.tts[].options.modelPath; DemoHunter never downloads model weights");
    }
    try {
      await dependencies.accessPath(modelPath!, constants.R_OK);
      if (!(await dependencies.statPath(modelPath!)).isFile()) throw new Error("not a regular file");
    } catch (error) {
      throw new Error(`model file missing: ${modelPath}`, { cause: error });
    }
    return { message: `model file is readable: ${modelPath}`, value: true };
  });
  const voicesReady = await runCheck(checks, "kokoro voices", async () => {
    if (!authoredOptions.voicesPath?.trim()) {
      if (authoredOptions.runtime === "command" && !authoredOptions.modelPath?.trim()) {
        return { message: "voices identity is supplied by the external command protocol", value: true };
      }
      throw new Error("voices file missing from config: set providers.tts[].options.voicesPath; DemoHunter never downloads voice assets");
    }
    try {
      await dependencies.accessPath(voicesPath!, constants.R_OK);
      if (!(await dependencies.statPath(voicesPath!)).isFile()) throw new Error("not a regular file");
    } catch (error) {
      throw new Error(`voices file missing: ${voicesPath}`, { cause: error });
    }
    return { message: `voices file is readable: ${voicesPath}`, value: true };
  });

  if (executableReady && modelReady && voicesReady) {
    await runCheck(checks, "kokoro protocol/version/language capability", async () => {
      const options = await dependencies.resolveKokoroOptions(authoredOptions, undefined, projectRoot);
      if (config.tts.format !== "wav") {
        throw new Error("Kokoro doctor requires WAV output for ffmpeg-compatible narration.");
      }
      const normalizedLanguage = config.tts.language?.trim().toLowerCase().replaceAll("_", "-");
      if (normalizedLanguage === undefined || !KOKORO_LANGUAGES.includes(normalizedLanguage as never)) {
        throw new Error(`Kokoro language ${JSON.stringify(config.tts.language)} is unsupported. Supported values: ${KOKORO_LANGUAGES.join(", ")}.`);
      }
      const ready = await dependencies.probeKokoroWorker(options);
      if (modelPath !== undefined && voicesPath !== undefined) {
        const [modelSha256, voicesSha256] = await Promise.all([
          dependencies.hashKokoroAsset(modelPath),
          dependencies.hashKokoroAsset(voicesPath),
        ]);
        if (ready.modelSha256 !== modelSha256 || ready.voicesSha256 !== voicesSha256) {
          throw new Error("Kokoro worker identity does not match the configured model and voices files.");
        }
      }
      return {
        message: modelPath === undefined
          ? "Kokoro protocol/version handshake passed with the command's self-reported asset identity; selected language is configured for WAV at 24,000 Hz"
          : "Kokoro protocol/version handshake and configured asset digest comparison passed; selected language is configured for WAV at 24,000 Hz",
      };
    });
  } else {
    checks.push({
      name: "kokoro protocol/version/language capability",
      status: "fail",
      message: "Skipped until the Kokoro executable, model file, and voices file checks pass",
    });
  }
}

export async function probeKokoroWorker(options: KokoroPluginOptions): Promise<KokoroReadyMessage> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(options.executable, [...(options.args ?? [])], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
    });
    const maxBytes = 64 * 1024;
    let output = "";
    let stderr = "";
    const timeoutMs = options.startupTimeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Kokoro worker protocol probe timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(output) < maxBytes) output += chunk.toString("utf8").slice(0, maxBytes - Buffer.byteLength(output));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) < maxBytes) stderr += chunk.toString("utf8").slice(0, maxBytes - Buffer.byteLength(stderr));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Kokoro worker protocol probe exited with code ${code}.${stderr ? ` ${stderr.trim()}` : ""}`));
      } else {
        resolve(output);
      }
    });
    child.stdin.end();
  });
  const readyLine = stdout.split(/\r?\n/).find((line) => line.trim() !== "");

  if (readyLine === undefined) {
    throw new Error("Kokoro worker did not emit its protocol ready message.");
  }

  const ready = parseReadyMessage(readyLine);
  const expectedVersion = options.backendVersion ?? options.modelVersion;
  if (expectedVersion !== undefined && ready.backendVersion !== expectedVersion) {
    throw new Error(
      `Kokoro worker backend version ${JSON.stringify(ready.backendVersion)} does not match required version ${JSON.stringify(expectedVersion)}.`,
    );
  }
  return ready;
}

async function runCheck<T>(
  checks: DoctorCheck[],
  name: string,
  fn: () => Promise<{ message: string; value?: T }>,
): Promise<T | undefined> {
  try {
    const result = await fn();
    checks.push({
      name,
      status: "pass",
      message: result.message,
    });
    return result.value;
  } catch (error) {
    checks.push({
      name,
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

async function checkBaseURL(baseURL: string, fetchImplementation: typeof fetch): Promise<void> {
  const url = new URL(baseURL);

  if (url.protocol === "file:") {
    await access(fileURLToPath(url));
    return;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported baseURL protocol for doctor: ${url.protocol}`);
  }

  const response = await fetchImplementation(url, {
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    throw new Error(`baseURL returned HTTP ${response.status}`);
  }
}

async function checkWritableDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const checkPath = path.join(directory, `.demohunter-doctor-${process.pid}.tmp`);

  try {
    await writeFile(checkPath, "ok\n", "utf8");
  } finally {
    await rm(checkPath, { force: true });
  }
}
