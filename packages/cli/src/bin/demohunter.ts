#!/usr/bin/env node

import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cacheCommand } from "../commands/cache.js";
import { doctorCommand } from "../commands/doctor.js";
import { generateCommand } from "../commands/generate.js";
import type { GenerateCommandOptions } from "../commands/generate.js";
import { initCommand } from "../commands/init.js";
import {
  reviewGenerateCommand,
  reviewInitCommand,
  reviewServeCommand,
  reviewVerifyCommand,
} from "../commands/review.js";
import type {
  ReviewGenerateOptions,
  ReviewInitOptions,
  ReviewServeOptions,
  ReviewVerifyOptions,
} from "../commands/review.js";
import { addSkillCommand, parseSkillTargets } from "../commands/skill.js";
import { readPackageVersion } from "../utils/read-package-version.js";

type AddSkillInput = {
  targets: readonly ("claude" | "codex")[];
};

type CliDependencies = {
  cacheCommand: (
    cwd: string,
    input: { action: "list" | "prune" | "clear" },
  ) => Promise<void>;
  doctorCommand: (cwd: string) => Promise<void>;
  initCommand: (cwd: string, options?: { force?: boolean }) => Promise<void>;
  generateCommand: (cwd: string, tourPath: string, options?: GenerateCommandOptions) => Promise<void>;
  addSkillCommand: (cwd: string, input: AddSkillInput) => Promise<void>;
  reviewInitCommand: (cwd: string, options: ReviewInitOptions) => Promise<void>;
  reviewGenerateCommand: (
    cwd: string,
    reviewPath: string,
    options: ReviewGenerateOptions,
  ) => Promise<void>;
  reviewServeCommand: (cwd: string, reviewDir: string, options: ReviewServeOptions) => Promise<void>;
  reviewVerifyCommand: (cwd: string, reviewDir: string, options: ReviewVerifyOptions) => Promise<unknown>;
};

const defaultDependencies: CliDependencies = {
  cacheCommand,
  doctorCommand,
  initCommand,
  generateCommand,
  addSkillCommand,
  reviewInitCommand,
  reviewGenerateCommand,
  reviewServeCommand,
  reviewVerifyCommand,
};

const HELP_TEXT = `demohunter - generate narrated demo videos from Playwright tours

Usage:
  demohunter <command> [options]

Commands:
  init                     Scaffold a starter tour, config, and .gitignore entry
  generate <tour-file>     Run a tour and write portable assets to .demohunter/<tour-id>/
  doctor                   Check local prerequisites and project setup
  cache list               Show cached narration entries
  cache prune              Remove stale or corrupt cache entries
  cache clear              Delete every cached narration entry
  add-skill [--target ...] Install the DemoHunter agent skills into .claude or .codex
  review init              Scaffold a *.review.ts from the real merge-base..HEAD diff
  review generate <file>   Build the local review website and narrated walkthrough
  review serve <dir|id>    Serve one generated review on 127.0.0.1 only
  review verify <dir|id>   Re-derive the artifact from Git and report drift

generate flags:
  --dry-run                Validate the browser flow without narration or video
  --flow-only              Alias for --dry-run
  --cookie-dismiss <mode>  Dismiss recognized consent banners: reject, accept, or hide
  --no-cookie-dismiss      Disable cookie-banner automation for this run
  --cursor <preset>        Cursor rendering: none, highlight, smooth, or ripple
  --format <preset>        Repeatable output: standard, square, mobile, or gif
  --duration <seconds>     GIF duration in seconds (0.001 to 15)

add-skill flags:
  --target <name>          Repeatable. One of: claude, codex, both.
                           When omitted, installs to both.

review flags:
  --base <ref>             Base branch for merge-base(base, HEAD) (default: main)
  --head <ref>             Head to review (default: HEAD)
  --id <slug>              Review id for "review init"
  --out <path>             Output path for "review init"
  --force                  Overwrite an existing scaffold
  --run-verification       Execute the declared verification commands
  --allow-dirty            Generate a draft artifact from a dirty work tree
  --no-video               Build the website without recording the walkthrough
  --port <number>          Loopback port for "review serve" (default: ephemeral)
  --open                   Open the served review in the default browser
  --strict                 Also require passing verification and a clean tree

Global flags:
  -h, --help               Print this help text
  -v, --version            Print the installed version

Docs: https://github.com/emilwareus/demohunter`;

export async function runCli(
  argv: string[],
  cwd = process.cwd(),
  dependencies: CliDependencies = defaultDependencies,
): Promise<void> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "-h" || command === "--help" || command === "help") {
    console.log(HELP_TEXT);
    return;
  }

  if (command === "-v" || command === "--version") {
    console.log(readPackageVersion());
    return;
  }

  switch (command) {
    case "init":
      await dependencies.initCommand(cwd, { force: rest.includes("--force") });
      return;
    case "cache": {
      const [action, ...extraArgs] = rest;
      if (!isCacheAction(action) || extraArgs.length > 0) {
        throw new Error("Usage: demohunter cache <list|prune|clear>");
      }
      await dependencies.cacheCommand(cwd, { action });
      return;
    }
    case "generate": {
      const { options, tourPath } = parseGenerateArgs(rest);
      if (!tourPath) {
        throw new Error("Usage: demohunter generate <tour-file> [--dry-run|--flow-only]");
      }
      await dependencies.generateCommand(cwd, tourPath, options);
      return;
    }
    case "doctor": {
      if (rest.length > 0) {
        throw new Error("Usage: demohunter doctor");
      }
      await dependencies.doctorCommand(cwd);
      return;
    }
    case "add-skill": {
      const targets = parseSkillTargets(extractTargetValues(rest));
      await dependencies.addSkillCommand(cwd, { targets });
      return;
    }
    case "review": {
      await runReviewCommand(rest, cwd, dependencies);
      return;
    }
    default:
      throw new Error(
        `Unknown command: ${command}. Run "demohunter --help" to see available commands.`,
      );
  }
}

export const REVIEW_ACTIONS = ["init", "generate", "serve", "verify"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

const REVIEW_USAGE =
  "Usage: demohunter review <init|generate|serve|verify> [target] [flags]";

async function runReviewCommand(
  args: readonly string[],
  cwd: string,
  dependencies: CliDependencies,
): Promise<void> {
  const [action, ...rest] = args;

  if (!isReviewAction(action)) {
    throw new Error(REVIEW_USAGE);
  }

  const parsed = parseReviewArgs(action, rest);

  switch (action) {
    case "init":
      await dependencies.reviewInitCommand(cwd, parsed.init!);
      return;
    case "generate":
      await dependencies.reviewGenerateCommand(cwd, parsed.target!, parsed.generate!);
      return;
    case "serve":
      await dependencies.reviewServeCommand(cwd, parsed.target!, parsed.serve!);
      return;
    case "verify":
      await dependencies.reviewVerifyCommand(cwd, parsed.target!, parsed.verify!);
      return;
  }
}

export type ParsedReviewArgs = {
  action: ReviewAction;
  target?: string;
  init?: ReviewInitOptions;
  generate?: ReviewGenerateOptions;
  serve?: ReviewServeOptions;
  verify?: ReviewVerifyOptions;
};

const REVIEW_VALUE_FLAGS: Record<ReviewAction, readonly string[]> = {
  init: ["--base", "--head", "--id", "--out"],
  generate: ["--base", "--head"],
  serve: ["--port"],
  verify: [],
};

const REVIEW_BOOLEAN_FLAGS: Record<ReviewAction, readonly string[]> = {
  init: ["--force"],
  generate: ["--run-verification", "--allow-dirty", "--no-video"],
  serve: ["--open"],
  verify: ["--strict"],
};

export const DEFAULT_REVIEW_BASE_REF = "main";

/**
 * Parses one `demohunter review <action>` invocation.
 *
 * Unknown flags are rejected rather than ignored: a review artifact records
 * exact shas, so a silently dropped `--base` would produce a confident artifact
 * for the wrong range.
 */
export function parseReviewArgs(action: ReviewAction, args: readonly string[]): ParsedReviewArgs {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const equalsIndex = arg.indexOf("=");
    const name = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : arg.slice(equalsIndex + 1);

    if (REVIEW_BOOLEAN_FLAGS[action].includes(name)) {
      if (inlineValue !== undefined) {
        throw new Error(`${name} does not take a value.`);
      }
      booleans.add(name);
      continue;
    }

    if (!REVIEW_VALUE_FLAGS[action].includes(name)) {
      throw new Error(`Unknown "review ${action}" flag: ${name}. ${REVIEW_USAGE}`);
    }

    const value = inlineValue ?? args[index + 1];

    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${name} requires a value.`);
    }

    if (values.has(name)) {
      throw new Error(`${name} may only be provided once.`);
    }

    values.set(name, value);
    if (inlineValue === undefined) index += 1;
  }

  if (positionals.length > 1) {
    throw new Error(REVIEW_USAGE);
  }

  const target = positionals[0];
  const baseRef = values.get("--base") ?? DEFAULT_REVIEW_BASE_REF;
  const headRef = values.get("--head");

  if (action === "init") {
    if (target !== undefined && values.has("--out")) {
      throw new Error("Pass the scaffold path either positionally or with --out, not both.");
    }

    const outputPath = target ?? values.get("--out");

    return {
      action,
      ...(target === undefined ? {} : { target }),
      init: {
        baseRef,
        ...(headRef === undefined ? {} : { headRef }),
        ...(values.has("--id") ? { id: values.get("--id")! } : {}),
        ...(outputPath === undefined ? {} : { outputPath }),
        force: booleans.has("--force"),
      },
    };
  }

  if (action === "generate") {
    if (target === undefined) {
      throw new Error("Usage: demohunter review generate <review-file> [--base main]");
    }

    return {
      action,
      target,
      generate: {
        baseRef,
        ...(headRef === undefined ? {} : { headRef }),
        runVerification: booleans.has("--run-verification"),
        allowDirty: booleans.has("--allow-dirty"),
        skipVideo: booleans.has("--no-video"),
      },
    };
  }

  if (target === undefined) {
    throw new Error(`Usage: demohunter review ${action} <review-dir-or-id>`);
  }

  if (action === "serve") {
    return {
      action,
      target,
      serve: {
        ...(values.has("--port") ? { port: parseReviewPort(values.get("--port")!) } : {}),
        open: booleans.has("--open"),
      },
    };
  }

  return { action, target, verify: { strict: booleans.has("--strict") } };
}

function parseReviewPort(value: string): number {
  const port = Number(value);

  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("--port requires an integer from 0 to 65535");
  }

  return port;
}

function isReviewAction(value: string | undefined): value is ReviewAction {
  return value !== undefined && (REVIEW_ACTIONS as readonly string[]).includes(value);
}

export function parseGenerateArgs(args: readonly string[]): {
  options: GenerateCommandOptions;
  tourPath?: string;
} {
  const options: GenerateCommandOptions = {};
  let tourPath: string | undefined;
  let gifDurationMs: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--flow-only") {
      options.flowOnly = true;
      continue;
    }

    if (arg === "--no-cookie-dismiss") {
      assertCookieDismissNotSet(options);
      options.cookieDismiss = false;
      continue;
    }

    if (arg === "--cookie-dismiss") {
      assertCookieDismissNotSet(options);
      const value = args[index + 1];

      if (value === undefined || value.startsWith("-")) {
        throw new Error("--cookie-dismiss requires one of: reject, accept, hide");
      }

      options.cookieDismiss = parseCookieDismissAction(value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--cookie-dismiss=")) {
      assertCookieDismissNotSet(options);
      options.cookieDismiss = parseCookieDismissAction(arg.slice("--cookie-dismiss=".length));
      continue;
    }

    if (arg === "--cursor") {
      assertCursorNotSet(options);
      const value = args[index + 1];

      if (value === undefined || value.startsWith("-")) {
        throw new Error("--cursor requires one of: none, highlight, smooth, ripple");
      }

      options.cursor = parseCursorPreset(value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--cursor=")) {
      assertCursorNotSet(options);
      options.cursor = parseCursorPreset(arg.slice("--cursor=".length));
      continue;
    }

    if (arg === "--format") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--format requires one of: standard, square, mobile, gif");
      }
      addOutputFormat(options, value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--format=")) {
      addOutputFormat(options, arg.slice("--format=".length));
      continue;
    }

    if (arg === "--duration" || arg.startsWith("--duration=")) {
      if (gifDurationMs !== undefined) {
        throw new Error("--duration may only be provided once per generation.");
      }
      const value = arg === "--duration" ? args[index + 1] : arg.slice("--duration=".length);
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--duration requires a number of seconds from 0.001 to 15");
      }
      gifDurationMs = parseGifDuration(value);
      if (arg === "--duration") index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown generate flag: ${arg}`);
    }

    if (tourPath !== undefined) {
      throw new Error("Usage: demohunter generate <tour-file> [--dry-run|--flow-only]");
    }

    tourPath = arg;
  }

  if (gifDurationMs !== undefined) {
    const gif = options.formats?.find((format) => format.preset === "gif");
    if (gif === undefined) {
      throw new Error("--duration may only be used together with --format gif");
    }
    gif.durationMs = gifDurationMs;
  }

  return { options, tourPath };
}

function addOutputFormat(options: GenerateCommandOptions, value: string): void {
  if (value !== "standard" && value !== "square" && value !== "mobile" && value !== "gif") {
    throw new Error(`Invalid --format value: ${value}. Expected standard, square, mobile, or gif.`);
  }
  options.formats ??= [];
  if (options.formats.some((format) => format.preset === value)) {
    throw new Error(`--format ${value} may only be provided once per generation.`);
  }
  options.formats.push({ preset: value });
}

function parseGifDuration(value: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0.001 || seconds > 15) {
    throw new Error("--duration requires a number of seconds from 0.001 to 15");
  }
  return Math.round(seconds * 1000);
}

function parseCursorPreset(value: string): "none" | "highlight" | "smooth" | "ripple" {
  if (value === "none" || value === "highlight" || value === "smooth" || value === "ripple") {
    return value;
  }

  throw new Error(`Invalid --cursor value: ${value}. Expected none, highlight, smooth, or ripple.`);
}

function assertCursorNotSet(options: GenerateCommandOptions): void {
  if (options.cursor !== undefined) {
    throw new Error("--cursor may only be provided once per generation.");
  }
}

function parseCookieDismissAction(value: string): "reject" | "accept" | "hide" {
  if (value === "reject" || value === "accept" || value === "hide") {
    return value;
  }

  throw new Error(`Invalid --cookie-dismiss value: ${value}. Expected reject, accept, or hide.`);
}

function assertCookieDismissNotSet(options: GenerateCommandOptions): void {
  if (options.cookieDismiss !== undefined) {
    throw new Error("Use only one of --cookie-dismiss or --no-cookie-dismiss per generation.");
  }
}

function isCacheAction(action: string | undefined): action is "list" | "prune" | "clear" {
  return action === "list" || action === "prune" || action === "clear";
}

function extractTargetValues(args: readonly string[]): string[] {
  const values: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg === "--target") {
      const next = args[index + 1];

      if (next === undefined) {
        throw new Error("Usage: demohunter add-skill [--target claude|codex|both]");
      }

      values.push(next);
      index += 1;
      continue;
    }

    if (arg.startsWith("--target=")) {
      values.push(arg.slice("--target=".length));
      continue;
    }

    throw new Error(`Unknown add-skill flag: ${arg}`);
  }

  return values;
}

async function main(): Promise<void> {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}

export function isExecutedAsEntrypoint(
  argvPath = process.argv[1],
  entryUrl = import.meta.url,
  resolveRealPath: (filePath: string) => string = resolveRealBinPath,
): boolean {
  if (!argvPath) {
    return false;
  }

  return resolveRealPath(path.resolve(argvPath)) === resolveRealPath(fileURLToPath(entryUrl));
}

function resolveRealBinPath(filePath: string): string {
  try {
    return realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

if (isExecutedAsEntrypoint()) {
  void main();
}
