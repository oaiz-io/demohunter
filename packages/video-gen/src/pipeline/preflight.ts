import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import * as playwright from "playwright";

import { ensureOutputRootWritable, resolveGenerationPaths } from "../bridge/workspace.js";
import { pathExists } from "../util/fs.js";
import { slugify } from "../util/slug.js";
import { VideoGenError } from "./errors.js";
import type {
  GenerateVideoOptions,
  PreflightCheckResult,
  PreflightResult,
  StylePresetName,
} from "./types.js";
import { STYLE_PRESET_NAMES } from "./types.js";

const execFileAsync = promisify(execFile);

export type PreflightDependencies = {
  checkCommand?: (command: string, args: string[]) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  launchBrowser?: () => Promise<{ close: () => Promise<void> }>;
  ensureOutputRootWritable?: typeof ensureOutputRootWritable;
  pathExists?: typeof pathExists;
};

export type ValidatedGenerateOptions = {
  prompt: string;
  style: StylePresetName;
  outputDir: string;
  model?: string;
  cleanup: boolean;
  signal?: AbortSignal;
  onProgress?: GenerateVideoOptions["onProgress"];
};

export function validateGenerateOptions(
  options: GenerateVideoOptions,
  cwd = process.cwd(),
): ValidatedGenerateOptions {
  const prompt = options.prompt?.trim() ?? "";
  if (prompt === "") {
    throw new VideoGenError("INVALID_INPUT", "prompt must be a non-empty string");
  }

  const style = options.style ?? "minimal";
  if (!(STYLE_PRESET_NAMES as readonly string[]).includes(style)) {
    throw new VideoGenError(
      "INVALID_INPUT",
      `style must be one of: ${STYLE_PRESET_NAMES.join(", ")}`,
    );
  }

  const outputDir = resolveOutputDir(options.outputDir, cwd);
  const model = options.model?.trim();
  if (options.model !== undefined && model === "") {
    throw new VideoGenError("INVALID_INPUT", "model must be a non-empty string when provided");
  }

  return {
    prompt,
    style,
    outputDir,
    model,
    cleanup: options.cleanup === true,
    signal: options.signal,
    onProgress: options.onProgress,
  };
}

export function resolveOutputDir(outputDir: string | undefined, cwd = process.cwd()): string {
  const value = outputDir ?? ".demohunter";
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value);
}

export async function runPreflight(
  input: {
    options: ValidatedGenerateOptions;
    tourId?: string;
    signal?: AbortSignal;
  },
  dependencies: PreflightDependencies = {},
): Promise<PreflightResult> {
  throwIfAborted(input.signal ?? input.options.signal);

  const env = dependencies.env ?? process.env;
  const checkCommand =
    dependencies.checkCommand
    ?? (async (command, args) => {
      await execFileAsync(command, args);
    });
  const launchBrowser =
    dependencies.launchBrowser
    ?? (async () => {
      const browser = await playwright.chromium.launch();
      return {
        close: async () => {
          await browser.close();
        },
      };
    });
  const ensureWritable = dependencies.ensureOutputRootWritable ?? ensureOutputRootWritable;
  const exists = dependencies.pathExists ?? pathExists;

  const checks: PreflightCheckResult[] = [];

  const apiKey = env.OPENAI_API_KEY;
  checks.push(
    apiKey !== undefined && apiKey.trim() !== ""
      ? { name: "OPENAI_API_KEY", ok: true, message: "OPENAI_API_KEY is set" }
      : {
          name: "OPENAI_API_KEY",
          ok: false,
          message:
            "OPENAI_API_KEY is not set. Export it before generating content and narration.",
        },
  );

  for (const command of ["ffmpeg", "ffprobe"] as const) {
    try {
      await checkCommand(command, ["-version"]);
      checks.push({ name: command, ok: true, message: `${command} is available on PATH` });
    } catch {
      checks.push({
        name: command,
        ok: false,
        message: `${command} is not installed or not on PATH. Install ffmpeg to continue.`,
      });
    }
  }

  try {
    const browser = await launchBrowser();
    try {
      checks.push({
        name: "playwright-chromium",
        ok: true,
        message: "Chromium launched successfully",
      });
    } finally {
      await browser.close();
    }
  } catch (error) {
    checks.push({
      name: "playwright-chromium",
      ok: false,
      message:
        `Playwright Chromium failed to launch (${error instanceof Error ? error.message : String(error)}). Run: bunx playwright install chromium`,
    });
  }

  try {
    await ensureWritable(input.options.outputDir);
    checks.push({
      name: "outputDir",
      ok: true,
      message: `Output directory is writable: ${input.options.outputDir}`,
    });
  } catch (error) {
    checks.push({
      name: "outputDir",
      ok: false,
      message: `Output directory is not writable: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  if (input.tourId !== undefined) {
    const workspace = resolveGenerationPaths({
      outputDir: input.options.outputDir,
      tourId: input.tourId,
    });
    const collisions: string[] = [];
    if (await exists(workspace.workspaceDir)) {
      collisions.push(workspace.workspaceDir);
    }
    if (await exists(workspace.finalOutputDir)) {
      collisions.push(workspace.finalOutputDir);
    }
    checks.push(
      collisions.length === 0
        ? { name: "collision", ok: true, message: "No colliding generation paths" }
        : {
            name: "collision",
            ok: false,
            message: `Existing generation paths: ${collisions.join(", ")}`,
          },
    );
  }

  throwIfAborted(input.signal ?? input.options.signal);

  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

export function assertPreflightOk(result: PreflightResult): void {
  if (result.ok) {
    return;
  }
  throw new VideoGenError("PREFLIGHT_FAILED", "Preflight checks failed.", {
    details: result.checks.filter((check) => !check.ok).map((check) => check.message),
  });
}

export function deriveTourId(title: string): string {
  return slugify(title, "lesson");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new VideoGenError("INTERRUPTED", "Generation was cancelled during preflight.");
  }
}
