import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { ChangedFile } from "../git/git-types.js";
import { createTempRepo, type TempRepo } from "../test-support/temp-repo.ts";
import { deriveReviewId, groupChangedFiles, scaffoldReview } from "./scaffold-review.js";

describe("groupChangedFiles", () => {
  test("buckets by the first two path segments and drops support files", () => {
    const groups = groupChangedFiles(
      changed([
        "packages/review/src/index.ts",
        "packages/review/src/git/run-git.ts",
        "packages/cli/src/bin/demohunter.ts",
        "packages/review/src/index.test.ts",
        "README.md",
        "docs/review.md",
        "package.json",
        ".github/workflows/ci.yml",
      ]),
    );

    expect(groups.map((group) => group.title)).toEqual(["packages/cli", "packages/review"]);
    expect(groups[1]?.paths).toEqual([
      "packages/review/src/git/run-git.ts",
      "packages/review/src/index.ts",
    ]);
    expect(groups[1]?.id).toBe("packages-review");
  });

  test("puts a repository-root file in its own bucket", () => {
    expect(groupChangedFiles(changed(["Makefile"]))).toEqual([
      { id: "repository-root", title: "repository root", paths: ["Makefile"] },
    ]);
  });
});

describe("deriveReviewId", () => {
  test("slugifies an explicit head ref", () => {
    expect(deriveReviewId({ headRef: "feat/demo-hunter-review" } as never)).toBe(
      "feat-demo-hunter-review-review",
    );
  });

  test("names the review after the checked-out branch when head is HEAD", () => {
    expect(deriveReviewId({ headRef: "HEAD" } as never, "feat/demo-hunter-review")).toBe(
      "feat-demo-hunter-review-review",
    );
  });

  test("falls back to a generic id on a detached HEAD instead of using a sha", () => {
    expect(deriveReviewId({ headRef: "HEAD" } as never)).toBe("pr-review");
  });
});

describe("scaffoldReview", () => {
  let repo: TempRepo;

  beforeAll(async () => {
    repo = await createTempRepo("demohunter-review-scaffold-");
    await repo.write("src/app.ts", "export const app = 1;\n");
    await repo.commit("base");
    await repo.runGit(["checkout", "--quiet", "-b", "feature"]);
    await repo.write("src/app.ts", "export const app = 2;\n");
    await repo.write("src/new.ts", "export const added = true;\n");
    await repo.write("src/app.test.ts", "export const test = true;\n");
    await repo.write("README.md", "# readme\n");
    await repo.commit("feature");
  });

  afterAll(async () => {
    await repo.dispose();
  });

  test("grounds the scaffold in the real changed-file set", async () => {
    const scaffold = await scaffoldReview({ runGit: repo.runGit, baseRef: "main" });

    expect(scaffold.changedFiles.map((file) => file.path)).toEqual([
      "README.md",
      "src/app.test.ts",
      "src/app.ts",
      "src/new.ts",
    ]);
    expect(scaffold.contents).toContain("Changed files in this range:");
    expect(scaffold.contents).toContain("modified     src/app.ts");
    expect(scaffold.contents).toContain("added        src/new.ts");
    // Support files stay out of chapters; coverage groups pick them up.
    expect(scaffold.chapterGroups.flatMap((group) => group.paths)).toEqual([
      "src/app.ts",
      "src/new.ts",
    ]);
  });

  test("writes no shas, so the scaffold cannot drift out of sync with the lock", async () => {
    const scaffold = await scaffoldReview({ runGit: repo.runGit, baseRef: "main" });

    expect(scaffold.contents).not.toContain(scaffold.comparison.headSha);
    expect(scaffold.contents).not.toContain(scaffold.comparison.mergeBaseSha);
    expect(scaffold.contents).not.toMatch(/\b[0-9a-f]{40}\b/);
  });

  test("marks every authored field as a TODO", async () => {
    const scaffold = await scaffoldReview({ runGit: repo.runGit, baseRef: "main" });

    expect(scaffold.contents).toContain("TODO: state the problem this pull request solves");
    expect(scaffold.contents).toContain("intent: \"TODO:");
    expect(scaffold.contents).toContain("narration: \"TODO:");
    expect(scaffold.contents.match(/TODO/g)!.length).toBeGreaterThan(10);
  });

  test("emits a definition that imports from the published package", async () => {
    const scaffold = await scaffoldReview({ runGit: repo.runGit, baseRef: "main" });

    expect(scaffold.contents).toContain('from "demohunter"');
    expect(scaffold.contents).toContain("export default defineReview({");
    expect(scaffold.contents).toContain('id: "feature-review"');
  });

  test("honours an explicit id and title", async () => {
    const scaffold = await scaffoldReview({
      runGit: repo.runGit,
      baseRef: "main",
      id: "pr-22-review",
      title: "PR 22",
    });

    expect(scaffold.id).toBe("pr-22-review");
    expect(scaffold.contents).toContain('id: "pr-22-review"');
    expect(scaffold.contents).toContain('title: "PR 22"');
  });

  test("refuses to scaffold an empty range", async () => {
    await expect(scaffoldReview({ runGit: repo.runGit, baseRef: "HEAD" })).rejects.toThrow(
      "There is nothing to review yet",
    );
  });
});

function changed(paths: string[]): ChangedFile[] {
  return paths.map((filePath) => ({
    path: filePath,
    status: "modified" as const,
    insertions: 1,
    deletions: 0,
    oldMode: "100644",
    newMode: "100644",
    oldBlobSha: "1".repeat(40),
    newBlobSha: "2".repeat(40),
    isBinary: false,
    isSubmodule: false,
    isModeOnly: false,
    isGenerated: false,
  }));
}
