import { describe, expect, test } from "bun:test";

import {
  collectFileDiff,
  narrowHunkToRange,
  parseUnifiedDiff,
  selectHunksForRange,
} from "./collect-hunks.js";
import type { RunGit } from "./run-git.js";

const SINGLE_FILE_DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,4 +10,5 @@ export function start() {
 const port = 3000;
-  listen(port);
+  listen(port, "127.0.0.1");
+  logBoundAddress();
 }
@@ -40,2 +41,2 @@ export function stop() {
-  close();
+  closeAll();
`;

describe("parseUnifiedDiff", () => {
  test("assigns one-based line numbers to each side", () => {
    const diff = parseUnifiedDiff(SINGLE_FILE_DIFF, "src/app.ts");

    expect(diff.path).toBe("src/app.ts");
    expect(diff.isBinary).toBe(false);
    expect(diff.hunks).toHaveLength(2);

    const [first] = diff.hunks;
    expect(first?.oldStart).toBe(10);
    expect(first?.newStart).toBe(10);
    expect(first?.lines.map((line) => [line.kind, line.oldLine, line.newLine, line.text])).toEqual([
      ["context", 10, 10, "const port = 3000;"],
      ["deletion", 11, null, "  listen(port);"],
      ["addition", null, 11, '  listen(port, "127.0.0.1");'],
      ["addition", null, 12, "  logBoundAddress();"],
      ["context", 12, 13, "}"],
    ]);
  });

  test("keeps only the hunks belonging to the requested path", () => {
    const twoFileDiff = `${SINGLE_FILE_DIFF}diff --git a/src/other.ts b/src/other.ts
index 3333333..4444444 100644
--- a/src/other.ts
+++ b/src/other.ts
@@ -1,1 +1,1 @@
-const other = 1;
+const other = 2;
`;

    expect(parseUnifiedDiff(twoFileDiff, "src/app.ts").hunks).toHaveLength(2);
    expect(parseUnifiedDiff(twoFileDiff, "src/other.ts").hunks).toHaveLength(1);
  });

  test("records the previous path for a rename and drops the a/ b/ prefixes", () => {
    const renameDiff = `diff --git a/src/old.ts b/src/new.ts
similarity index 90%
rename from src/old.ts
rename to src/new.ts
--- a/src/old.ts
+++ b/src/new.ts
@@ -1,1 +1,1 @@
-const value = 1;
+const value = 2;
`;
    const diff = parseUnifiedDiff(renameDiff, "src/new.ts");

    expect(diff.previousPath).toBe("src/old.ts");
    expect(diff.hunks).toHaveLength(1);
  });

  test("flags a binary file and produces no hunks", () => {
    const binaryDiff = `diff --git a/assets/logo.png b/assets/logo.png
index 1111111..2222222 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
`;
    const diff = parseUnifiedDiff(binaryDiff, "assets/logo.png");

    expect(diff.isBinary).toBe(true);
    expect(diff.hunks).toEqual([]);
  });

  test("ignores the no-newline marker instead of treating it as a line", () => {
    const noNewlineDiff = `--- a/src/app.ts
+++ b/src/app.ts
@@ -1,1 +1,1 @@
-const a = 1;
\\ No newline at end of file
+const a = 2;
`;
    const [hunk] = parseUnifiedDiff(noNewlineDiff, "src/app.ts").hunks;

    expect(hunk?.lines.map((line) => line.kind)).toEqual(["deletion", "addition"]);
  });

  test("handles a quoted path with a space", () => {
    const quotedDiff = `--- "a/src/my file.ts"
+++ "b/src/my file.ts"
@@ -1,1 +1,1 @@
-const a = 1;
+const a = 2;
`;

    expect(parseUnifiedDiff(quotedDiff, "src/my file.ts").hunks).toHaveLength(1);
  });
});

describe("selectHunksForRange", () => {
  const hunks = parseUnifiedDiff(SINGLE_FILE_DIFF, "src/app.ts").hunks;

  test("returns every hunk when no range is given", () => {
    expect(selectHunksForRange(hunks, undefined)).toHaveLength(2);
  });

  test("returns only the overlapping hunks", () => {
    expect(selectHunksForRange(hunks, { startLine: 10, endLine: 12 })).toHaveLength(1);
    expect(selectHunksForRange(hunks, { startLine: 41, endLine: 42 })[0]?.newStart).toBe(41);
    expect(selectHunksForRange(hunks, { startLine: 200, endLine: 300 })).toHaveLength(0);
  });

  test("includes a hunk touched at its first or last line", () => {
    expect(selectHunksForRange(hunks, { startLine: 14, endLine: 14 })).toHaveLength(1);
    expect(selectHunksForRange(hunks, { startLine: 15, endLine: 15 })).toHaveLength(0);
  });
});

describe("collectFileDiff", () => {
  test("passes both sides of a rename as pathspecs and honours the context width", async () => {
    let captured: string[] = [];
    const runGit: RunGit = async (args) => {
      captured = [...args];
      return SINGLE_FILE_DIFF;
    };

    await collectFileDiff({
      runGit,
      mergeBaseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      path: "src/app.ts",
      previousPath: "src/old.ts",
      contextLines: 7,
    });

    expect(captured).toContain("--unified=7");
    expect(captured.slice(-3)).toEqual(["--", "src/old.ts", "src/app.ts"]);
  });
});

describe("narrowHunkToRange", () => {
  const [hunk] = parseUnifiedDiff(SINGLE_FILE_DIFF, "src/app.ts").hunks;

  test("keeps only the lines inside the post-image range and rewrites the header", () => {
    const narrowed = narrowHunkToRange(hunk!, { startLine: 11, endLine: 12 });

    expect(narrowed?.lines.map((line) => [line.kind, line.text])).toEqual([
      ["deletion", "  listen(port);"],
      ["addition", '  listen(port, "127.0.0.1");'],
      ["addition", "  logBoundAddress();"],
    ]);
    expect(narrowed?.newStart).toBe(11);
    expect(narrowed?.oldStart).toBe(11);
    expect(narrowed?.header).toBe("@@ -11,1 +11,2 @@");
  });

  test("anchors a deletion to the post-image line it sits before", () => {
    // Line 11 is where the deleted line used to be; asking only for line 12
    // drops it rather than pulling unrelated context along.
    const narrowed = narrowHunkToRange(hunk!, { startLine: 12, endLine: 12 });

    expect(narrowed?.lines.map((line) => line.kind)).toEqual(["addition"]);
    expect(narrowed?.header).toBe("@@ -12,0 +12,1 @@");
  });

  test("returns the whole hunk when the range covers it", () => {
    const narrowed = narrowHunkToRange(hunk!, { startLine: 1, endLine: 1000 });

    expect(narrowed?.lines).toEqual(hunk!.lines);
    expect(narrowed?.oldStart).toBe(hunk!.oldStart);
    expect(narrowed?.newStart).toBe(hunk!.newStart);
  });

  test("returns undefined when nothing falls inside the range", () => {
    expect(narrowHunkToRange(hunk!, { startLine: 500, endLine: 600 })).toBeUndefined();
  });

  test("narrows a single added-file hunk instead of showing the whole file", () => {
    const addedFileDiff = `--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,5 @@
+const one = 1;
+const two = 2;
+const three = 3;
+const four = 4;
+const five = 5;
`;
    const [addedHunk] = parseUnifiedDiff(addedFileDiff, "src/new.ts").hunks;
    const narrowed = narrowHunkToRange(addedHunk!, { startLine: 2, endLine: 3 });

    expect(narrowed?.lines.map((line) => line.text)).toEqual(["const two = 2;", "const three = 3;"]);
    // A pure addition has no pre-image lines, which Git writes as -0,0.
    expect(narrowed?.header).toBe("@@ -0,0 +2,2 @@");
  });
});
