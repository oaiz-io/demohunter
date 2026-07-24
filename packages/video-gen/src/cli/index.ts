#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateVideo } from "../api/index.js";
import { formatCliError, VideoGenError } from "../pipeline/errors.js";
import type { StylePresetName, VideoGenerationProgressEvent } from "../pipeline/types.js";
import { STYLE_PRESET_NAMES } from "../pipeline/types.js";

export type CliDependencies = {
  generateVideo?: typeof generateVideo;
  log?: (message: string) => void;
  error?: (message: string) => void;
  exit?: (code: number) => void;
  getVersion?: () => string;
};

const HELP_TEXT = `demohunter-video - generate narrated teaching videos from a prompt

Usage:
  demohunter-video generate "<prompt>" [options]

Options:
  --style <name>     Style preset: minimal, terminal, or notebook (default: minimal)
  --output <dir>     Output root directory (default: .demohunter)
  --cleanup          Remove the inspectable source workspace after success
  -h, --help         Print this help text
  -v, --version      Print the package version

Examples:
  demohunter-video generate "What is a binary tree?" --style minimal
  demohunter-video generate "How does DNS work?" --style terminal --output .demohunter

Output:
  <output>/<tour-id>/video.mp4              portable DemoHunter artifacts
  <output>/video-gen/<tour-id>/             inspectable source (kept unless --cleanup)

Requires OPENAI_API_KEY, ffmpeg/ffprobe, and Playwright Chromium.
`;

export async function runCli(
  argv: string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const log = dependencies.log ?? console.log;
  const error = dependencies.error ?? console.error;
  const generate = dependencies.generateVideo ?? generateVideo;
  const getVersion = dependencies.getVersion ?? readPackageVersion;

  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    log(HELP_TEXT);
    return 0;
  }

  if (argv[0] === "-v" || argv[0] === "--version" || argv[0] === "version") {
    log(getVersion());
    return 0;
  }

  const [command, ...rest] = argv;
  if (command !== "generate") {
    error(`Unknown command: ${command}\n\n${HELP_TEXT}`);
    return 1;
  }

  let parsed: ReturnType<typeof parseGenerateArgs>;
  try {
    parsed = parseGenerateArgs(rest);
  } catch (parseError) {
    error(formatCliError(parseError));
    return 1;
  }

  if (parsed.help) {
    log(HELP_TEXT);
    return 0;
  }
  if (parsed.version) {
    log(getVersion());
    return 0;
  }

  const controller = new AbortController();
  let sigintCount = 0;
  const onSigint = () => {
    sigintCount += 1;
    if (sigintCount === 1) {
      error("\nCancellation requested. Finishing cleanup...");
      controller.abort();
      return;
    }
    error("\nSecond interrupt received. Exiting.");
    dependencies.exit?.(130);
    process.exitCode = 130;
  };

  process.on("SIGINT", onSigint);

  try {
    const result = await generate({
      prompt: parsed.prompt,
      style: parsed.style,
      outputDir: parsed.output,
      cleanup: parsed.cleanup,
      signal: controller.signal,
      onProgress: (event) => {
        log(formatProgress(event));
      },
    });

    log(`Video: ${result.videoPath}`);
    if (result.workspacePreserved) {
      log(`Workspace: ${result.workspaceDir}`);
    } else {
      log("Workspace removed (--cleanup).");
    }
    return 0;
  } catch (runError) {
    error(formatCliError(runError));
    if (runError instanceof VideoGenError && runError.code === "INTERRUPTED") {
      return 130;
    }
    return 1;
  } finally {
    process.off("SIGINT", onSigint);
  }
}

export function parseGenerateArgs(args: string[]): {
  prompt: string;
  style: StylePresetName;
  output: string;
  cleanup: boolean;
  help: boolean;
  version: boolean;
} {
  let prompt: string | undefined;
  let style: StylePresetName = "minimal";
  let output = ".demohunter";
  let cleanup = false;
  let help = false;
  let version = false;
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "-v" || arg === "--version") {
      version = true;
      continue;
    }
    if (arg === "--cleanup") {
      if (seen.has("cleanup")) {
        throw new VideoGenError("INVALID_INPUT", "Duplicate --cleanup flag");
      }
      seen.add("cleanup");
      cleanup = true;
      continue;
    }
    if (arg === "--style") {
      if (seen.has("style")) {
        throw new VideoGenError("INVALID_INPUT", "Duplicate --style flag");
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new VideoGenError("INVALID_INPUT", "--style requires a value");
      }
      if (!(STYLE_PRESET_NAMES as readonly string[]).includes(value)) {
        throw new VideoGenError(
          "INVALID_INPUT",
          `--style must be one of: ${STYLE_PRESET_NAMES.join(", ")}`,
        );
      }
      seen.add("style");
      style = value as StylePresetName;
      index += 1;
      continue;
    }
    if (arg === "--output") {
      if (seen.has("output")) {
        throw new VideoGenError("INVALID_INPUT", "Duplicate --output flag");
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new VideoGenError("INVALID_INPUT", "--output requires a value");
      }
      seen.add("output");
      output = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new VideoGenError("INVALID_INPUT", `Unknown flag: ${arg}`);
    }
    if (prompt !== undefined) {
      throw new VideoGenError("INVALID_INPUT", "Only one prompt argument is allowed");
    }
    prompt = arg;
  }

  if (help || version) {
    return { prompt: prompt ?? "", style, output, cleanup, help, version };
  }

  if (prompt === undefined || prompt.trim() === "") {
    throw new VideoGenError("INVALID_INPUT", "generate requires a non-empty prompt");
  }

  return { prompt, style, output, cleanup, help, version };
}

export function formatProgress(event: VideoGenerationProgressEvent): string {
  if (event.phase === "record" && event.detail !== undefined) {
    return `[record:${event.detail.phase}] ${event.message}`;
  }
  return `[${event.phase}] ${event.message}`;
}

function readPackageVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "../../package.json"),
    path.join(here, "../package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const raw = readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as { version?: string };
      if (typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
      // continue
    }
  }
  return "0.0.0";
}

async function main(): Promise<void> {
  const entry = process.argv[1];
  if (entry === undefined) {
    return;
  }
  const isDirect = realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  if (!isDirect) {
    return;
  }
  const code = await runCli(process.argv.slice(2));
  process.exitCode = code;
}

void main();
