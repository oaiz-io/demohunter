import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_REVIEW_DIRECTORY,
  readReviewDefaultExport,
  resolveReviewDir,
  reviewGenerateCommand,
  reviewInitCommand,
  reviewServeCommand,
  reviewVerifyCommand,
  ReviewVerificationFailedError,
} from "./review.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("readReviewDefaultExport", () => {
  test("accepts a definition-shaped default export", () => {
    const review = { id: "pr-22-review", chapters: [] };

    expect(readReviewDefaultExport(review, "reviews/pr.review.ts")).toBe(review);
  });

  test("rejects anything else with a message that names the file", () => {
    for (const value of [undefined, null, [], { id: "x" }, { chapters: [] }, "text"]) {
      expect(() => readReviewDefaultExport(value, "reviews/pr.review.ts")).toThrow(
        "Review file must default export defineReview({ ... }): reviews/pr.review.ts",
      );
    }
  });
});

describe("resolveReviewDir", () => {
  test("accepts a directory path", async () => {
    const cwd = await makeTempRoot();
    const reviewDir = path.join(cwd, ".demohunter/reviews/pr-22-review");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(path.join(reviewDir, "review.lock.json"), "{}", "utf8");

    expect(await resolveReviewDir(cwd, ".demohunter/reviews/pr-22-review")).toBe(reviewDir);
  });

  test("accepts a bare review id", async () => {
    const cwd = await makeTempRoot();
    const reviewDir = path.join(cwd, ".demohunter/reviews/pr-22-review");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(path.join(reviewDir, "review.lock.json"), "{}", "utf8");

    expect(await resolveReviewDir(cwd, "pr-22-review")).toBe(reviewDir);
  });

  test("explains what to pass when nothing matches", async () => {
    const cwd = await makeTempRoot();

    await expect(resolveReviewDir(cwd, "missing")).rejects.toThrow(
      "Could not find a review artifact at missing",
    );
  });
});

describe("reviewInitCommand", () => {
  test("writes the scaffold and prints the range it was built from", async () => {
    const cwd = await makeTempRoot();
    const logs: string[] = [];

    await reviewInitCommand(cwd, { baseRef: "main" }, {
      log: (message) => logs.push(message),
      scaffoldReview: async () => scaffoldResult(),
    });

    const written = await readFile(
      path.join(cwd, DEFAULT_REVIEW_DIRECTORY, "pr-22-review.review.ts"),
      "utf8",
    );

    expect(written).toContain("defineReview");
    expect(logs.join("\n")).toContain("reviews/pr-22-review.review.ts");
    expect(logs.join("\n")).toContain("main (merge base 333333333333)");
    expect(logs.join("\n")).toContain("Changed files: 1");
    expect(logs.join("\n")).toContain("demohunter review generate reviews/pr-22-review.review.ts --base main");
  });

  test("refuses to overwrite an existing scaffold unless forced", async () => {
    const cwd = await makeTempRoot();
    const target = path.join(cwd, "reviews/pr-22-review.review.ts");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "// hand written\n", "utf8");

    const dependencies = { log: () => undefined, scaffoldReview: async () => scaffoldResult() };

    await expect(reviewInitCommand(cwd, { baseRef: "main" }, dependencies)).rejects.toThrow(
      "already exists. Pass --force",
    );
    expect(await readFile(target, "utf8")).toBe("// hand written\n");

    await reviewInitCommand(cwd, { baseRef: "main", force: true }, dependencies);
    expect(await readFile(target, "utf8")).toContain("defineReview");
  });

  test("honours an explicit output path", async () => {
    const cwd = await makeTempRoot();

    await reviewInitCommand(
      cwd,
      { baseRef: "main", outputPath: "docs/reviews/custom.review.ts" },
      { log: () => undefined, scaffoldReview: async () => scaffoldResult() },
    );

    expect(await readFile(path.join(cwd, "docs/reviews/custom.review.ts"), "utf8")).toContain(
      "defineReview",
    );
  });
});

describe("reviewGenerateCommand", () => {
  test("passes the authored definition and flags through, then reports the artifact", async () => {
    const cwd = await makeTempRoot();
    const logs: string[] = [];
    let received: Record<string, unknown> | undefined;

    await reviewGenerateCommand(
      cwd,
      "reviews/pr-22-review.review.ts",
      { baseRef: "main", headRef: "feature", runVerification: true, allowDirty: true, skipVideo: true },
      {
        log: (message) => logs.push(message),
        loadConfig: async () => ({ projectRoot: cwd, configPath: `${cwd}/demohunter.config.ts`, config: {} as never }),
        importModule: async () => ({ default: { id: "pr-22-review", chapters: [] } }),
        generateReview: (async (input: Record<string, unknown>) => {
          received = input;
          return generateResult(cwd);
        }) as never,
      },
    );

    expect(received?.baseRef).toBe("main");
    expect(received?.headRef).toBe("feature");
    expect(received?.runVerificationCommands).toBe(true);
    expect(received?.allowDirtyWorktree).toBe(true);
    expect(received?.skipVideo).toBe(true);
    expect(received?.sourcePath).toBe("reviews/pr-22-review.review.ts");
    expect(typeof received?.generatorVersion).toBe("string");
    expect(received?.generatorVersion).not.toBe("");

    const output = logs.join("\n");
    expect(output).toContain("Coverage:        4/4 changed files");
    expect(output).toContain("Verification:    passed");
    expect(output).toContain("main (merge base 333333333333) -> HEAD (222222222222)");
    expect(output).toContain("demohunter review serve");
  });

  test("says plainly when no walkthrough was recorded", async () => {
    const cwd = await makeTempRoot();
    const logs: string[] = [];

    await reviewGenerateCommand(
      cwd,
      "reviews/pr.review.ts",
      { baseRef: "main" },
      {
        log: (message) => logs.push(message),
        loadConfig: async () => ({ projectRoot: cwd, configPath: "", config: {} as never }),
        importModule: async () => ({ default: { id: "pr-22-review", chapters: [] } }),
        generateReview: (async () => ({ ...generateResult(cwd), videoPath: null })) as never,
      },
    );

    expect(logs.join("\n")).toContain("not recorded (--no-video)");
  });

  test("rejects a review file that does not default export a definition", async () => {
    const cwd = await makeTempRoot();

    await expect(
      reviewGenerateCommand(
        cwd,
        "reviews/pr.review.ts",
        { baseRef: "main" },
        {
          log: () => undefined,
          loadConfig: async () => ({ projectRoot: cwd, configPath: "", config: {} as never }),
          importModule: async () => ({ default: { nope: true } }),
        },
      ),
    ).rejects.toThrow("Review file must default export");
  });
});

describe("reviewServeCommand", () => {
  test("serves the artifact, opens it on request, and closes on shutdown", async () => {
    const cwd = await makeTempRoot();
    const reviewDir = path.join(cwd, ".demohunter/reviews/pr-22-review");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(path.join(reviewDir, "review.lock.json"), "{}", "utf8");

    const logs: string[] = [];
    const opened: string[] = [];
    let closed = 0;

    await reviewServeCommand(
      cwd,
      "pr-22-review",
      { open: true, port: 4321 },
      {
        log: (message) => logs.push(message),
        openUrl: async (url) => {
          opened.push(url);
        },
        waitForShutdown: async () => undefined,
        serveReview: (async (options: { root: string; port?: number }) => {
          expect(options.root).toBe(reviewDir);
          expect(options.port).toBe(4321);
          return {
            baseUrl: "http://127.0.0.1:4321",
            port: 4321,
            close: async () => {
              closed += 1;
            },
          };
        }) as never,
      },
    );

    expect(opened).toEqual(["http://127.0.0.1:4321"]);
    expect(closed).toBe(1);
    expect(logs.join("\n")).toContain("Bound to 127.0.0.1 only");
  });

  test("closes the server even when the wait throws", async () => {
    const cwd = await makeTempRoot();
    const reviewDir = path.join(cwd, ".demohunter/reviews/pr-22-review");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(path.join(reviewDir, "review.lock.json"), "{}", "utf8");
    let closed = 0;

    await expect(
      reviewServeCommand(
        cwd,
        "pr-22-review",
        {},
        {
          log: () => undefined,
          waitForShutdown: async () => {
            throw new Error("interrupted");
          },
          serveReview: (async () => ({
            baseUrl: "http://127.0.0.1:1",
            port: 1,
            close: async () => {
              closed += 1;
            },
          })) as never,
        },
      ),
    ).rejects.toThrow("interrupted");

    expect(closed).toBe(1);
  });
});

describe("reviewVerifyCommand", () => {
  test("prints one line per check and returns the result when everything passes", async () => {
    const cwd = await makeTempRoot();
    const reviewDir = await makeArtifactDir(cwd);
    const logs: string[] = [];

    const result = await reviewVerifyCommand(
      cwd,
      "pr-22-review",
      { strict: true },
      {
        log: (message) => logs.push(message),
        verifyReviewArtifact: (async (input: { strict?: boolean }) => {
          expect(input.strict).toBe(true);
          return {
            ok: true,
            strict: true,
            reviewDir,
            lock: null,
            failedCategory: null,
            checks: [
              { id: "not-stale", category: "stale", status: "pass", message: "Range matches." },
              { id: "video-present", category: "artifact", status: "warn", message: "No walkthrough." },
            ],
          };
        }) as never,
      },
    );

    expect(result.ok).toBe(true);
    expect(logs[0]).toContain("PASS stale");
    expect(logs[1]).toContain("WARN artifact");
    expect(logs.join("\n")).toContain("verified in strict mode");
  });

  test("throws with the failing category so the CLI can exit non-zero", async () => {
    const cwd = await makeTempRoot();
    const reviewDir = await makeArtifactDir(cwd);
    const logs: string[] = [];

    const failure = await reviewVerifyCommand(
      cwd,
      "pr-22-review",
      {},
      {
        log: (message) => logs.push(message),
        verifyReviewArtifact: (async () => ({
          ok: false,
          strict: false,
          reviewDir,
          lock: null,
          failedCategory: "stale",
          checks: [
            { id: "stale-head-moved", category: "stale", status: "fail", message: "HEAD moved." },
          ],
        })) as never,
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ReviewVerificationFailedError);
    expect((failure as Error).message).toContain("first failing category: stale");
    expect(logs.join("\n")).toContain("FAIL stale");
    expect(logs.join("\n")).toContain("failed verification (stale)");
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "demohunter-review-cli-"));
  tempRoots.push(root);
  return root;
}

async function makeArtifactDir(cwd: string): Promise<string> {
  const reviewDir = path.join(cwd, ".demohunter/reviews/pr-22-review");
  await mkdir(reviewDir, { recursive: true });
  await writeFile(path.join(reviewDir, "review.lock.json"), "{}", "utf8");
  return reviewDir;
}

function scaffoldResult() {
  return {
    id: "pr-22-review",
    title: "PR 22 review",
    contents: "export default defineReview({});\n",
    comparison: {
      repoRoot: "/repo",
      baseRef: "main",
      baseSha: "1".repeat(40),
      headRef: "HEAD",
      headSha: "2".repeat(40),
      mergeBaseSha: "3".repeat(40),
      mergeBaseCandidates: ["3".repeat(40)],
      headIsMergeCommit: false,
      headParents: ["3".repeat(40)],
    },
    changedFiles: [{ path: "src/app.ts" }],
    chapterGroups: [],
  } as never;
}

function generateResult(cwd: string) {
  const reviewDir = path.join(cwd, ".demohunter/reviews/pr-22-review");

  return {
    reviewDir,
    lockPath: path.join(reviewDir, "review.lock.json"),
    indexPath: path.join(reviewDir, "index.html"),
    videoPath: path.join(reviewDir, "video.mp4"),
    lock: {
      coverage: { accountedCount: 4, totalCount: 4 },
      verification: { status: "passed" },
      git: {
        baseRef: "main",
        headRef: "HEAD",
        mergeBaseSha: "3".repeat(40),
        headSha: "2".repeat(40),
      },
    },
  } as never;
}
