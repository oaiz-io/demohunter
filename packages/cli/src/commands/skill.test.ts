import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { addSkillCommand, findSkillSourceRoot, parseSkillTargets, SKILL_BUNDLES } from "./skill.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { force: true, recursive: true })));
});

describe("parseSkillTargets", () => {
  test("defaults to every target when no values are passed", () => {
    expect(parseSkillTargets([])).toEqual(["claude", "codex"]);
  });

  test("expands the 'both' alias", () => {
    expect(parseSkillTargets(["both"])).toEqual(["claude", "codex"]);
  });

  test("deduplicates repeated targets", () => {
    expect(parseSkillTargets(["claude", "claude", "codex"])).toEqual(["claude", "codex"]);
  });

  test("rejects cursor (no longer supported)", () => {
    expect(() => parseSkillTargets(["cursor"])).toThrow("Unknown skill target: cursor");
  });

  test("throws on unknown targets", () => {
    expect(() => parseSkillTargets(["windsurf"])).toThrow("Unknown skill target: windsurf");
  });
});

describe("addSkillCommand", () => {
  test("copies every skill bundle into each requested target directory", async () => {
    const cwd = await makeTempProject();

    await addSkillCommand(cwd, { targets: ["claude", "codex"] });

    const claudeSkill = await readFile(
      path.join(cwd, ".claude", "skills", "demohunter", "SKILL.md"),
      "utf8",
    );
    const codexSkill = await readFile(
      path.join(cwd, ".codex", "skills", "demohunter", "SKILL.md"),
      "utf8",
    );

    expect(claudeSkill).toContain("name: demohunter");
    expect(codexSkill).toContain("name: demohunter");

    const claudeTemplate = await readFile(
      path.join(cwd, ".claude", "skills", "demohunter", "assets", "tour.template.ts"),
      "utf8",
    );
    expect(claudeTemplate).toContain('import { defineTour } from "demohunter"');

    for (const target of [".claude", ".codex"]) {
      const reviewSkill = await readFile(
        path.join(cwd, target, "skills", "demohunter-review", "SKILL.md"),
        "utf8",
      );
      expect(reviewSkill).toContain("name: demohunter-review");
    }

    const reviewTemplate = await readFile(
      path.join(cwd, ".claude", "skills", "demohunter-review", "assets", "pr.review.template.ts"),
      "utf8",
    );
    expect(reviewTemplate).toContain('from "demohunter"');
    expect(reviewTemplate).toContain("export default defineReview({");
  });

  test("copies nested reference directories, not just the top level", async () => {
    const cwd = await makeTempProject();

    await addSkillCommand(cwd, { targets: ["claude"] });

    for (const reference of ["authoring.md", "cli.md", "inspection.md", "troubleshooting.md"]) {
      await readFile(
        path.join(cwd, ".claude", "skills", "demohunter-review", "references", reference),
        "utf8",
      );
    }
  });

  test("installs only the requested bundles", async () => {
    const cwd = await makeTempProject();

    await addSkillCommand(cwd, { targets: ["claude"], bundles: ["demohunter-review"] });

    await readFile(path.join(cwd, ".claude", "skills", "demohunter-review", "SKILL.md"), "utf8");
    await expect(
      readFile(path.join(cwd, ".claude", "skills", "demohunter", "SKILL.md"), "utf8"),
    ).rejects.toThrow();
  });

  test("overwrites a previously installed bundle so an update lands", async () => {
    const cwd = await makeTempProject();
    const installed = path.join(cwd, ".claude", "skills", "demohunter", "SKILL.md");

    await addSkillCommand(cwd, { targets: ["claude"] });
    await writeFile(installed, "stale\n");
    await addSkillCommand(cwd, { targets: ["claude"] });

    expect(await readFile(installed, "utf8")).toContain("name: demohunter");
  });

  test("rejects an empty target list", async () => {
    const cwd = await makeTempProject();

    await expect(addSkillCommand(cwd, { targets: [] })).rejects.toThrow(
      "Usage: demohunter add-skill [--target claude|codex|both]",
    );
  });
});

describe("findSkillSourceRoot", () => {
  test("locates every shipped bundle", () => {
    for (const bundle of SKILL_BUNDLES) {
      expect(findSkillSourceRoot(bundle)).toContain(path.join("skills", bundle));
    }
  });

  test("names the bundle it could not find", () => {
    expect(() => findSkillSourceRoot("not-a-bundle" as never)).toThrow(
      "Could not locate the not-a-bundle skill bundle",
    );
  });
});

async function makeTempProject(): Promise<string> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "demohunter-skill-"));
  tempRoots.push(tempRoot);
  return tempRoot;
}
