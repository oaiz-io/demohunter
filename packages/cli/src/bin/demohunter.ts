#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cacheCommand } from "../commands/cache.js";
import { doctorCommand } from "../commands/doctor.js";
import { generateCommand } from "../commands/generate.js";
import type { GenerateCommandOptions } from "../commands/generate.js";
import { initCommand } from "../commands/init.js";
import { addSkillCommand, parseSkillTargets } from "../commands/skill.js";

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
};

const defaultDependencies: CliDependencies = {
  cacheCommand,
  doctorCommand,
  initCommand,
  generateCommand,
  addSkillCommand,
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
  add-skill [--target ...] Install the DemoHunter agent skill into .claude or .codex

generate flags:
  --dry-run                Validate the browser flow without narration or video
  --flow-only              Alias for --dry-run
  --cookie-dismiss <mode>  Dismiss recognized consent banners: reject, accept, or hide
  --no-cookie-dismiss      Disable cookie-banner automation for this run

add-skill flags:
  --target <name>          Repeatable. One of: claude, codex, both.
                           When omitted, installs to both.

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
    console.log(readVersion());
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
    default:
      throw new Error(
        `Unknown command: ${command}. Run "demohunter --help" to see available commands.`,
      );
  }
}

export function parseGenerateArgs(args: readonly string[]): {
  options: GenerateCommandOptions;
  tourPath?: string;
} {
  const options: GenerateCommandOptions = {};
  let tourPath: string | undefined;

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

    if (arg.startsWith("-")) {
      throw new Error(`Unknown generate flag: ${arg}`);
    }

    if (tourPath !== undefined) {
      throw new Error("Usage: demohunter generate <tour-file> [--dry-run|--flow-only]");
    }

    tourPath = arg;
  }

  return { options, tourPath };
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

function readVersion(): string {
  try {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    let dir = moduleDir;

    while (true) {
      const candidate = path.join(dir, "package.json");

      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };

        if (parsed.name === "demohunter" && typeof parsed.version === "string") {
          return parsed.version;
        }
      } catch {
        // ignore and keep walking up
      }

      const parent = path.dirname(dir);

      if (parent === dir) {
        break;
      }

      dir = parent;
    }
  } catch {
    // fall through
  }

  return "unknown";
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
