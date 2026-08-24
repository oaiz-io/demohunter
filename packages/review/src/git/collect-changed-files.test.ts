import { describe, expect, test } from "bun:test";

import {
  collectChangedFiles,
  compileGlob,
  createGeneratedMatcher,
  DEFAULT_GENERATED_PATTERNS,
  parseNumstat,
  parseRawDiff,
} from "./collect-changed-files.js";
import type { RunGit } from "./run-git.js";

const MERGE_BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const OLD_BLOB = "1".repeat(40);
const NEW_BLOB = "2".repeat(40);
const ZERO_BLOB = "0".repeat(40);

describe("parseRawDiff", () => {
  test("parses modified, added, and deleted records", () => {
    const output = [
      `:100644 100644 ${OLD_BLOB} ${NEW_BLOB} M`,
      "src/changed.ts",
      `:000000 100644 ${ZERO_BLOB} ${NEW_BLOB} A`,
      "src/added.ts",
      `:100644 000000 ${OLD_BLOB} ${ZERO_BLOB} D`,
      "src/removed.ts",
      "",
    ].join("\0");

    expect(parseRawDiff(output)).toEqual([
      {
        path: "src/changed.ts",
        status: "modified",
        oldMode: "100644",
        newMode: "100644",
        oldBlobSha: OLD_BLOB,
        newBlobSha: NEW_BLOB,
      },
      {
        path: "src/added.ts",
        status: "added",
        oldMode: "000000",
        newMode: "100644",
        oldBlobSha: null,
        newBlobSha: NEW_BLOB,
      },
      {
        path: "src/removed.ts",
        status: "deleted",
        oldMode: "100644",
        newMode: "000000",
        oldBlobSha: OLD_BLOB,
        newBlobSha: null,
      },
    ]);
  });

  test("keeps the head path and the previous path for renames", () => {
    const output = [
      `:100644 100644 ${OLD_BLOB} ${NEW_BLOB} R096`,
      "src/old-name.ts",
      "src/new-name.ts",
      "",
    ].join("\0");

    expect(parseRawDiff(output)).toEqual([
      {
        path: "src/new-name.ts",
        previousPath: "src/old-name.ts",
        status: "renamed",
        similarity: 96,
        oldMode: "100644",
        newMode: "100644",
        oldBlobSha: OLD_BLOB,
        newBlobSha: NEW_BLOB,
      },
    ]);
  });

  test("throws instead of guessing when a rename record is truncated", () => {
    const output = [`:100644 100644 ${OLD_BLOB} ${NEW_BLOB} R100`, "src/old-name.ts", ""].join("\0");

    expect(() => parseRawDiff(output)).toThrow("missing path field");
  });
});

describe("parseNumstat", () => {
  test("reads counts, binary markers, and the rename form", () => {
    const output = ["12\t3\tsrc/changed.ts", "-\t-\tassets/logo.png", "5\t1\t", "src/old.ts", "src/new.ts", ""].join(
      "\0",
    );
    const stats = parseNumstat(output);

    expect(stats.get("src/changed.ts")).toEqual({ insertions: 12, deletions: 3, isBinary: false });
    expect(stats.get("assets/logo.png")).toEqual({ insertions: 0, deletions: 0, isBinary: true });
    expect(stats.get("src/new.ts")).toEqual({ insertions: 5, deletions: 1, isBinary: false });
    expect(stats.get("src/old.ts")).toEqual({ insertions: 5, deletions: 1, isBinary: false });
  });
});

describe("compileGlob", () => {
  test("matches ** across directories and * within one segment", () => {
    expect(compileGlob("**/bun.lock").test("bun.lock")).toBe(true);
    expect(compileGlob("**/bun.lock").test("packages/cli/bun.lock")).toBe(true);
    expect(compileGlob("packages/*/src").test("packages/cli/src")).toBe(true);
    expect(compileGlob("packages/*/src").test("packages/cli/nested/src")).toBe(false);
    expect(compileGlob("dist/**").test("dist/index.js")).toBe(true);
    expect(compileGlob("src/?.ts").test("src/a.ts")).toBe(true);
    expect(compileGlob("src/?.ts").test("src/ab.ts")).toBe(false);
  });

  test("escapes regex metacharacters in literal segments", () => {
    expect(compileGlob("src/a+b.ts").test("src/a+b.ts")).toBe(true);
    expect(compileGlob("src/a+b.ts").test("src/aab.ts")).toBe(false);
    expect(compileGlob("src/file.ts").test("src/fileXts")).toBe(false);
  });

  test("flags the built-in generated paths", () => {
    const matcher = createGeneratedMatcher(DEFAULT_GENERATED_PATTERNS);

    expect(matcher("bun.lock")).toBe(true);
    expect(matcher("packages/cli/dist/index.js")).toBe(true);
    expect(matcher("src/schema.generated.ts")).toBe(true);
    expect(matcher("packages/review/src/index.ts")).toBe(false);
  });
});

describe("collectChangedFiles", () => {
  test("joins raw and numstat output, sorts by path, and flags derived facts", async () => {
    const runGit = createRunGit({
      raw: [
        `:100644 100755 ${OLD_BLOB} ${OLD_BLOB} M`,
        "scripts/run.sh",
        `:100644 100644 ${OLD_BLOB} ${NEW_BLOB} M`,
        "bun.lock",
        `:160000 160000 ${OLD_BLOB} ${NEW_BLOB} M`,
        "vendor/module",
        `:160000 160000 ${OLD_BLOB} ${NEW_BLOB} M`,
        "vendor/unreported",
        `:100644 100644 ${OLD_BLOB} ${NEW_BLOB} M`,
        "assets/logo.png",
        "",
      ].join("\0"),
      numstat: [
        "0\t0\tscripts/run.sh",
        "40\t2\tbun.lock",
        "-\t-\tassets/logo.png",
        "1\t1\tvendor/module",
        "",
      ].join("\0"),
    });

    const files = await collectChangedFiles({ runGit, mergeBaseSha: MERGE_BASE, headSha: HEAD });

    expect(files.map((file) => file.path)).toEqual([
      "assets/logo.png",
      "bun.lock",
      "scripts/run.sh",
      "vendor/module",
      "vendor/unreported",
    ]);
    expect(files.find((file) => file.path === "assets/logo.png")?.isBinary).toBe(true);
    expect(files.find((file) => file.path === "bun.lock")?.isGenerated).toBe(true);
    expect(files.find((file) => file.path === "scripts/run.sh")?.isModeOnly).toBe(true);
    expect(files.find((file) => file.path === "vendor/module")?.isSubmodule).toBe(true);
    // Git reports a gitlink bump as a one-line change, so the numstat row wins.
    expect(files.find((file) => file.path === "vendor/module")?.isBinary).toBe(false);
    // Without a numstat row there is nothing textual to show, so it falls back.
    expect(files.find((file) => file.path === "vendor/unreported")?.isBinary).toBe(true);
  });

  test("passes pathspecs through after a -- separator", async () => {
    const calls: string[][] = [];
    const runGit: RunGit = async (args) => {
      calls.push([...args]);
      return "";
    };

    await collectChangedFiles({
      runGit,
      mergeBaseSha: MERGE_BASE,
      headSha: HEAD,
      pathspecs: ["packages/review"],
    });

    for (const call of calls) {
      expect(call.slice(-2)).toEqual(["--", "packages/review"]);
      expect(call).toContain(MERGE_BASE);
      expect(call).toContain(HEAD);
    }
  });

  test("honours extra generated patterns from the review definition", async () => {
    const runGit = createRunGit({
      raw: [`:100644 100644 ${OLD_BLOB} ${NEW_BLOB} M`, "schemas/api.json", ""].join("\0"),
      numstat: ["3\t1\tschemas/api.json", ""].join("\0"),
    });

    const [file] = await collectChangedFiles({
      runGit,
      mergeBaseSha: MERGE_BASE,
      headSha: HEAD,
      generatedPatterns: ["schemas/**"],
    });

    expect(file?.isGenerated).toBe(true);
  });
});

function createRunGit(output: { raw: string; numstat: string }): RunGit {
  return async (args) => (args.includes("--numstat") ? output.numstat : output.raw);
}
