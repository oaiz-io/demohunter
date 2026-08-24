import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_TARGETS = ["claude", "codex"] as const;
export type SkillTarget = (typeof SKILL_TARGETS)[number];

/**
 * Every skill bundle shipped in the package, installed together.
 *
 * `demohunter` teaches tour authoring; `demohunter-review` teaches turning a
 * pull request into a review artifact. They are separate bundles because an
 * agent should load only the one that matches the task in front of it.
 */
export const SKILL_BUNDLES = ["demohunter", "demohunter-review"] as const;
export type SkillBundle = (typeof SKILL_BUNDLES)[number];

export type AddSkillInput = {
  targets: readonly SkillTarget[];
  /** Bundles to install. Defaults to all of them. */
  bundles?: readonly SkillBundle[];
};

const TARGET_SKILL_ROOTS: Record<SkillTarget, string> = {
  claude: ".claude/skills",
  codex: ".codex/skills",
};

export async function addSkillCommand(cwd: string, input: AddSkillInput): Promise<void> {
  if (input.targets.length === 0) {
    throw new Error("Usage: demohunter add-skill [--target claude|codex|both]");
  }

  const bundles = input.bundles ?? SKILL_BUNDLES;

  for (const target of input.targets) {
    for (const bundle of bundles) {
      const relativeDir = path.join(TARGET_SKILL_ROOTS[target], bundle);
      await copyDirectory(findSkillSourceRoot(bundle), path.join(cwd, relativeDir));
      console.log(`Installed ${bundle} skill into ${toPosix(relativeDir)}`);
    }
  }
}

export function parseSkillTargets(rawTargets: readonly string[]): SkillTarget[] {
  if (rawTargets.length === 0) {
    return [...SKILL_TARGETS];
  }

  const seen = new Set<SkillTarget>();

  for (const value of rawTargets) {
    if (value === "both") {
      for (const target of SKILL_TARGETS) {
        seen.add(target);
      }
      continue;
    }

    if (!isSkillTarget(value)) {
      throw new Error(
        `Unknown skill target: ${value}. Supported targets: ${SKILL_TARGETS.join(", ")}, both.`,
      );
    }

    seen.add(value);
  }

  return [...seen];
}

function isSkillTarget(value: string): value is SkillTarget {
  return (SKILL_TARGETS as readonly string[]).includes(value);
}

export function findSkillSourceRoot(bundle: SkillBundle): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  let dir = moduleDir;

  while (true) {
    const candidate = path.join(dir, "skills", bundle);

    if (existsSync(path.join(candidate, "SKILL.md"))) {
      return candidate;
    }

    const parent = path.dirname(dir);

    if (parent === dir) {
      break;
    }

    dir = parent;
  }

  throw new Error(`Could not locate the ${bundle} skill bundle from ${moduleDir}.`);
}

async function copyDirectory(sourceDir: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });

  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, targetPath);
      continue;
    }

    if (entry.isFile()) {
      await copyFile(sourcePath, targetPath);
    }
  }
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
