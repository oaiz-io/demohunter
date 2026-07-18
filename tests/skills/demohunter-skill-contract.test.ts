import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const skillRoot = path.join(repoRoot, "packages", "cli", "skills", "demohunter");
const cliSourcePath = path.join(repoRoot, "packages", "cli", "src", "bin", "demohunter.ts");
const markdownFiles = [
  path.join(skillRoot, "SKILL.md"),
  path.join(skillRoot, "references", "authoring.md"),
  path.join(skillRoot, "references", "cli.md"),
  path.join(skillRoot, "references", "troubleshooting.md"),
] as const;

const requiredFiles = [
  path.join(skillRoot, "SKILL.md"),
  path.join(skillRoot, "references", "authoring.md"),
  path.join(skillRoot, "references", "cli.md"),
  path.join(skillRoot, "references", "troubleshooting.md"),
  path.join(skillRoot, "assets", "tour.template.ts"),
] as const;

describe("demohunter skill bundle", () => {
  test("ships the canonical installable skill files", async () => {
    for (const filePath of requiredFiles) {
      await expect(access(filePath)).resolves.toBeNull();
    }
  });

  test("ships a template that uses the current authoring surface", async () => {
    const templatePath = path.join(skillRoot, "assets", "tour.template.ts");
    const templateSource = await readFile(templatePath, "utf8");

    expect(templateSource).toContain('import { defineTour } from "demohunter"');
    expect(templateSource).toContain("export default defineTour({");
    expect(templateSource).toContain("chapter(");
    expect(templateSource).toContain("step(");
    expect(templateSource).toContain("narrate(");
    expect(templateSource).toContain("narrateWhile(");
    expect(templateSource).not.toContain("replace-with-tour-id");
    expect(templateSource).not.toContain("Replace visible heading");

    await expect(typecheckTemplate(templatePath)).resolves.toBeUndefined();
  });

  test("keeps markdown links and documented CLI commands aligned with the repo", async () => {
    const cliSource = await readFile(cliSourcePath, "utf8");
    const documentedCommands = [
      "demohunter init",
      "demohunter generate <tour-file>",
      "demohunter generate <tour-file> --dry-run",
      "demohunter generate <tour-file> --flow-only",
      "demohunter doctor",
      "demohunter cache list",
      "demohunter cache prune",
      "demohunter cache clear",
      "demohunter add-skill [--target claude|codex|both]",
    ] as const;

    expect(cliSource).toContain('case "init"');
    expect(cliSource).toContain('case "generate"');
    expect(cliSource).toContain('case "doctor"');
    expect(cliSource).toContain('case "cache"');
    expect(cliSource).toContain('case "add-skill"');

    for (const markdownPath of markdownFiles) {
      const markdown = await readFile(markdownPath, "utf8");

      for (const command of documentedCommands) {
        if (markdownPath.endsWith("cli.md")) {
          expect(markdown).toContain(command);
        }
      }

      for (const linkPath of collectRelativeMarkdownLinks(markdown)) {
        await expect(access(path.resolve(path.dirname(markdownPath), linkPath))).resolves.toBeNull();
      }
    }

    const authoringReference = await readFile(
      path.join(skillRoot, "references", "authoring.md"),
      "utf8",
    );
    expect(authoringReference).toContain(
      '`click(..., { position?, motion?: "smooth" | "instant", timeoutMs? })`',
    );
    expect(authoringReference).not.toContain("clickCount?");
    expect(authoringReference).not.toContain("force?");
  });
});

function collectRelativeMarkdownLinks(markdown: string): string[] {
  const matches = markdown.matchAll(/\[[^\]]+\]\((?!https?:|#)([^)]+)\)/g);
  return [...new Set(Array.from(matches, (match) => match[1]!.split("#")[0]!.trim()).filter(Boolean))];
}

async function typecheckTemplate(templatePath: string): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "demohunter-skill-contract-"));

  try {
    const tsconfigPath = path.join(tempDir, "tsconfig.json");
    await writeFile(
      tsconfigPath,
      `${JSON.stringify(
        {
          compilerOptions: {
            noEmit: true,
            target: "ESNext",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            lib: ["ESNext"],
            ignoreDeprecations: "5.0",
            types: ["node"],
            typeRoots: [path.join(repoRoot, "node_modules", "@types")],
            skipLibCheck: true,
            baseUrl: repoRoot,
            paths: {
              demohunter: ["packages/cli/src/index.ts"],
            },
          },
          files: [templatePath],
        },
        null,
        2,
      )}\n`,
    );

    const processResult = Bun.spawn({
      cmd: [process.execPath, "x", "tsc", "-p", tsconfigPath],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      processResult.exited,
      new Response(processResult.stdout).text(),
      new Response(processResult.stderr).text(),
    ]);

    if (exitCode !== 0) {
      throw new Error(stderr || stdout || "Template typecheck failed.");
    }
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}
