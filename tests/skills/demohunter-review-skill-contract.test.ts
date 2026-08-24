import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const skillRoot = path.join(repoRoot, "packages", "cli", "skills", "demohunter-review");
const cliSourcePath = path.join(repoRoot, "packages", "cli", "src", "bin", "demohunter.ts");
const templatePath = path.join(skillRoot, "assets", "pr.review.template.ts");
const markdownFiles = [
  path.join(skillRoot, "SKILL.md"),
  path.join(skillRoot, "references", "authoring.md"),
  path.join(skillRoot, "references", "cli.md"),
  path.join(skillRoot, "references", "inspection.md"),
  path.join(skillRoot, "references", "troubleshooting.md"),
] as const;

describe("demohunter-review skill bundle", () => {
  test("ships the canonical installable skill files", async () => {
    for (const filePath of [...markdownFiles, templatePath]) {
      await expect(access(filePath)).resolves.toBeNull();
    }

    const skill = await readFile(markdownFiles[0], "utf8");
    expect(skill).toContain("name: demohunter-review");
    expect(skill).toContain("description:");
  });

  test("ships a template that typechecks against the current authoring surface", async () => {
    const templateSource = await readFile(templatePath, "utf8");

    expect(templateSource).toContain('from "demohunter"');
    expect(templateSource).toContain("export default defineReview({");
    expect(templateSource).toContain("componentDiagram(");
    expect(templateSource).toContain("sequenceDiagram(");
    expect(templateSource).toContain("changeSet(");
    expect(templateSource).toContain("diffEvidence(");
    expect(templateSource).toContain("codeEvidence(");
    expect(templateSource).toContain("verificationCommand(");
    expect(templateSource).toContain("coverageGroup(");
    expect(templateSource).not.toContain("TODO");

    await expect(typecheckTemplate()).resolves.toBeUndefined();
  }, 60_000);

  test("documents only commands the CLI actually implements", async () => {
    const cliSource = await readFile(cliSourcePath, "utf8");
    const documentedCommands = [
      "demohunter review init",
      "demohunter review generate",
      "demohunter review serve",
      "demohunter review verify",
    ] as const;

    expect(cliSource).toContain('case "review"');
    for (const action of ["init", "generate", "serve", "verify"]) {
      expect(cliSource).toContain(`case "${action}":`);
    }

    const cliReference = await readFile(path.join(skillRoot, "references", "cli.md"), "utf8");
    for (const command of documentedCommands) {
      expect(cliReference).toContain(command);
    }

    // Nothing hosted, and no GitHub integration, because neither exists.
    for (const markdownPath of markdownFiles) {
      const markdown = await readFile(markdownPath, "utf8");
      expect(markdown).not.toContain("demohunter review publish");
      expect(markdown).not.toContain("demohunter review push");
    }
  });

  test("teaches the local-only and no-invention rules", async () => {
    const skill = await readFile(markdownFiles[0], "utf8");

    expect(skill).toContain("Never invent shas, file lists, line ranges, or verification results");
    expect(skill).toContain("100% changed-file");
    expect(skill).toContain("network unplugged");
    expect(skill).toMatch(/demohunter review verify .*--strict/);
  });

  test("keeps every relative markdown link resolvable", async () => {
    for (const markdownPath of markdownFiles) {
      const markdown = await readFile(markdownPath, "utf8");

      for (const linkPath of collectRelativeMarkdownLinks(markdown)) {
        await expect(
          access(path.resolve(path.dirname(markdownPath), linkPath)),
        ).resolves.toBeNull();
      }
    }
  });

  test("is listed in the installer so add-skill ships it", async () => {
    const installerSource = await readFile(
      path.join(repoRoot, "packages", "cli", "src", "commands", "skill.ts"),
      "utf8",
    );

    expect(installerSource).toContain('"demohunter-review"');
  });
});

function collectRelativeMarkdownLinks(markdown: string): string[] {
  const matches = markdown.matchAll(/\[[^\]]+\]\((?!https?:|#)([^)]+)\)/g);
  return [...new Set(Array.from(matches, (match) => match[1]!.split("#")[0]!.trim()).filter(Boolean))];
}

async function typecheckTemplate(): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "demohunter-review-skill-contract-"));

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
            strict: true,
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
      throw new Error(stderr || stdout || "Review template typecheck failed.");
    }
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}
