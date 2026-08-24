import { afterEach, describe, expect, test } from "bun:test";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { DemoHunterTour, ResolvedDemoHunterConfig } from "@demohunter/sdk";

import type { ReviewDefinition } from "../authoring/review-types.js";
import { parseReviewLock } from "../lock/review-lock.js";
import { serveReview } from "../server/serve-review.js";
import { writeFakeTourOutput } from "../test-support/fake-tour-output.ts";
import { createTempRepo, type TempRepo } from "../test-support/temp-repo.ts";
import {
  createDefinitionDigest,
  generateReview,
  REVIEWS_DIRECTORY_NAME,
  ReviewWorktreeError,
  toWalkthroughConfig,
  type GenerateReviewProgressEvent,
} from "./generate-review.js";

const repos: TempRepo[] = [];

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.dispose()));
});

describe("generateReview", () => {
  test("writes a complete artifact grounded in the real range", async () => {
    const repo = await makeReviewRepo();
    const events: GenerateReviewProgressEvent[] = [];
    const result = await generateReview(
      { ...baseInput(repo), onProgress: (event) => events.push(event) },
      fakeDependencies(),
    );

    expect(result.reviewDir).toBe(
      path.join(repo.root, ".demohunter", REVIEWS_DIRECTORY_NAME, "pr-22-review"),
    );
    expect((await readdir(result.reviewDir)).sort()).toEqual([
      "assets",
      "audio",
      "captions.srt",
      "captions.vtt",
      "chapters.json",
      "data",
      "diagrams",
      "index.html",
      "manifest.json",
      "poster.jpg",
      "review.lock.json",
      "video.mp4",
    ]);

    const headSha = (await repo.runGit(["rev-parse", "HEAD"])).trim();
    const mergeBaseSha = (await repo.runGit(["merge-base", "main", "HEAD"])).trim();

    expect(result.lock.git.headSha).toBe(headSha);
    expect(result.lock.git.mergeBaseSha).toBe(mergeBaseSha);
    expect(result.lock.git.worktree.clean).toBe(true);
    expect(result.lock.coverage.complete).toBe(true);
    expect(result.lock.coverage.accountedCount).toBe(result.lock.coverage.totalCount);
    expect(result.lock.review.definitionDigest).toBe(createDefinitionDigest(reviewDefinition()));
    expect(events.map((event) => event.phase)).toContain("completed");
  });

  test("writes a lock that parses back and matches the files on disk", async () => {
    const repo = await makeReviewRepo();
    const result = await generateReview(baseInput(repo), fakeDependencies());
    const lock = parseReviewLock(JSON.parse(await readFile(result.lockPath, "utf8")));

    expect(lock).toEqual(result.lock);
    expect(lock.artifacts.map((artifact) => artifact.path).sort()).toEqual([
      "assets/viewer.css",
      "assets/viewer.js",
      "captions.srt",
      "captions.vtt",
      "chapters.json",
      "data/review.json",
      "diagrams/arch.svg",
      "index.html",
      "manifest.json",
      "poster.jpg",
      "video.mp4",
    ]);

    for (const artifact of lock.artifacts) {
      const fileStat = await stat(path.join(result.reviewDir, artifact.path));
      expect(fileStat.size).toBe(artifact.checksum.byteSize);
    }
  });

  test("re-renders the website so the recorded walkthrough is embedded", async () => {
    const repo = await makeReviewRepo();
    const result = await generateReview(baseInput(repo), fakeDependencies());
    const html = await readFile(result.indexPath, "utf8");

    expect(html).toContain('<section id="walkthrough">');
    expect(html).toContain('<source src="video.mp4" type="video/mp4" />');
    expect(result.lock.video).toMatchObject({
      video: "video.mp4",
      captionsVtt: "captions.vtt",
      chapters: "chapters.json",
    });
    expect(result.lock.video?.narrationCount).toBeGreaterThan(0);
    expect(result.lock.video?.chapterCount).toBeGreaterThan(0);
  });

  test("walks the authored architecture in the recorded walkthrough", async () => {
    // The website renders its own SVGs, so a section list derived from
    // pre-rendered diagrams looked fine on the page while the walkthrough
    // silently dropped the architecture chapter and its narration.
    const repo = await makeReviewRepo();
    const result = await generateReview(baseInput(repo), fakeDependencies());
    const chapters = JSON.parse(
      await readFile(path.join(result.reviewDir, "chapters.json"), "utf8"),
    ) as Array<{ title: string }>;
    const captions = await readFile(path.join(result.reviewDir, "captions.vtt"), "utf8");

    expect(chapters.map((chapter) => chapter.title)).toContain("Architecture");
    expect(captions).toContain("The target architecture is shown in");
    expect(await readFile(result.indexPath, "utf8")).toContain('href="#architecture"');
  });

  test("marks the artifact directory as ignored so it never dirties the tree", async () => {
    const repo = await makeReviewRepo();
    await generateReview(baseInput(repo), fakeDependencies());

    const ignore = await readFile(
      path.join(repo.root, ".demohunter", REVIEWS_DIRECTORY_NAME, ".gitignore"),
      "utf8",
    );
    expect(ignore).toContain("*");

    const status = await repo.runGit(["status", "--porcelain"]);
    expect(status.trim()).toBe("");
  });

  test("ignores the narration cache, which lives outside the reviews root", async () => {
    const repo = await makeReviewRepo();
    const input = baseInput(repo);
    await generateReview(input, fakeDependencies());

    expect(await readFile(path.join(input.config.cacheDir, ".gitignore"), "utf8")).toContain("*");

    // Recording resolves narration through the cache; entries must stay hidden.
    await writeFile(path.join(input.config.cacheDir, "entry.json"), "{}", "utf8");

    expect((await repo.runGit(["status", "--porcelain"])).trim()).toBe("");
  });

  test("refuses to generate from a dirty work tree", async () => {
    const repo = await makeReviewRepo();
    await writeFile(path.join(repo.root, "src/app.ts"), "uncommitted\n", "utf8");

    await expect(generateReview(baseInput(repo), fakeDependencies())).rejects.toThrow(
      ReviewWorktreeError,
    );
  });

  test("allows an explicitly marked draft from a dirty work tree", async () => {
    const repo = await makeReviewRepo();
    await writeFile(path.join(repo.root, "src/app.ts"), "uncommitted\n", "utf8");

    const result = await generateReview(
      { ...baseInput(repo), allowDirtyWorktree: true },
      fakeDependencies(),
    );

    expect(result.lock.git.worktree.clean).toBe(false);
    expect(await readFile(result.indexPath, "utf8")).toContain("work tree was not clean");
  });

  test("fails when a changed file is unaccounted for", async () => {
    const repo = await makeReviewRepo();
    await repo.write("src/forgotten.ts", "export const forgotten = true;\n");
    await repo.commit("add an unexplained file");

    await expect(generateReview(baseInput(repo), fakeDependencies())).rejects.toThrow(
      "src/forgotten.ts",
    );
  });

  test("fails when the range is empty instead of producing an empty review", async () => {
    const repo = await makeReviewRepo();

    await expect(
      generateReview({ ...baseInput(repo), baseRef: "HEAD" }, fakeDependencies()),
    ).rejects.toThrow("There is nothing to review");
  });

  test("records verification as not-run unless it was asked to run", async () => {
    const repo = await makeReviewRepo();
    const notRun = await generateReview(baseInput(repo), fakeDependencies());

    expect(notRun.lock.verification).toMatchObject({ status: "not-run", ran: false });
    expect(notRun.lock.verification.results[0]?.exitCode).toBeNull();

    const ran = await generateReview(
      { ...baseInput(repo), runVerificationCommands: true },
      { ...fakeDependencies(), runCommand: async () => ({ exitCode: 0, output: "ok\n", timedOut: false }) },
    );

    expect(ran.lock.verification).toMatchObject({ status: "passed", ran: true });
    expect(ran.lock.verification.results[0]?.exitCode).toBe(0);
  });

  test("records the exact blob provenance of every piece of evidence", async () => {
    const repo = await makeReviewRepo();
    const result = await generateReview(baseInput(repo), fakeDependencies());

    expect(result.lock.evidence).toHaveLength(2);
    for (const evidence of result.lock.evidence) {
      expect(evidence.anchor).toMatch(/^[0-9a-f]{64}$/);
      expect(evidence.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    }

    const diff = result.lock.evidence.find((evidence) => evidence.kind === "diff")!;
    expect(diff.provenance.newBlobSha).toMatch(/^[0-9a-f]{40}$/);
    expect(diff.provenance.mergeBaseSha).toBe(result.lock.git.mergeBaseSha);

    const code = result.lock.evidence.find((evidence) => evidence.kind === "code")!;
    expect(code.provenance.blobSha).toMatch(/^[0-9a-f]{40}$/);
    expect(code.range).toEqual({ startLine: 1, endLine: 2 });
  });

  test("serves the website on loopback while recording, then stops", async () => {
    const repo = await makeReviewRepo();
    const servedUrls: string[] = [];
    let closed = 0;

    await generateReview(baseInput(repo), {
      ...fakeDependencies(),
      serveReview: async (options) => {
        const server = await serveReview(options);
        servedUrls.push(server.baseUrl);
        return {
          ...server,
          close: async () => {
            closed += 1;
            await server.close();
          },
        };
      },
    });

    expect(servedUrls).toHaveLength(1);
    expect(servedUrls[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(closed).toBe(1);
  });

  test("stops the server even when recording fails", async () => {
    const repo = await makeReviewRepo();
    let closed = 0;

    await expect(
      generateReview(baseInput(repo), {
        ...fakeDependencies(),
        serveReview: async (options) => {
          const server = await serveReview(options);
          return {
            ...server,
            close: async () => {
              closed += 1;
              await server.close();
            },
          };
        },
        generateTour: async () => {
          throw new Error("recording blew up");
        },
      }),
    ).rejects.toThrow("recording blew up");

    expect(closed).toBe(1);
  });

  test("builds the website without a walkthrough when video is skipped", async () => {
    const repo = await makeReviewRepo();
    let recorded = 0;
    const result = await generateReview(
      { ...baseInput(repo), skipVideo: true },
      {
        ...fakeDependencies(),
        generateTour: async () => {
          recorded += 1;
          throw new Error("must not record");
        },
      },
    );

    expect(recorded).toBe(0);
    expect(result.videoPath).toBeNull();
    expect(result.lock.video).toBeNull();
    expect(await readFile(result.indexPath, "utf8")).not.toContain('id="walkthrough"');
  });

  test("removes a stale walkthrough rather than leaving it beside a lock that disowns it", async () => {
    const repo = await makeReviewRepo();
    const recorded = await generateReview(baseInput(repo), fakeDependencies());

    expect(await pathExists(path.join(recorded.reviewDir, "video.mp4"))).toBe(true);

    const rebuilt = await generateReview(
      { ...baseInput(repo), skipVideo: true },
      fakeDependencies(),
    );

    expect(rebuilt.lock.video).toBeNull();
    for (const stale of ["video.mp4", "poster.jpg", "captions.srt", "captions.vtt", "chapters.json", "manifest.json", "audio"]) {
      expect(await pathExists(path.join(rebuilt.reviewDir, stale))).toBe(false);
    }
  });

  test("removes a stale diagram rather than leaving it beside the lock", async () => {
    const repo = await makeReviewRepo();
    const first = await generateReview(baseInput(repo), fakeDependencies());
    await stat(path.join(first.reviewDir, "diagrams/arch.svg"));

    const renamed = reviewDefinition();
    renamed.architecture = [{ ...renamed.architecture![0]!, id: "renamed-arch" } as never];

    const second = await generateReview(
      { ...baseInput(repo), review: renamed },
      fakeDependencies(),
    );

    expect((await readdir(path.join(second.reviewDir, "diagrams"))).sort()).toEqual([
      "renamed-arch.svg",
    ]);
  });
});

describe("toWalkthroughConfig", () => {
  test("points the recording at the local server and disables restaging variants", () => {
    const config = toWalkthroughConfig(makeConfig("/repo"), "http://127.0.0.1:4321", "/repo/reviews");

    expect(config.baseURL).toBe("http://127.0.0.1:4321");
    expect(config.outputDir).toBe("/repo/reviews");
    // Social variants would restage the directory and clobber the website.
    expect(config.output.formats).toEqual([]);
    expect(config.record.container).toBe("mp4");
    expect(config.record.showChapters).toBe(true);
    expect(config.record.showCursor).toBe(false);
    expect(config.record.cursor).toBe(false);
    expect(config.record.cookieBanners.enabled).toBe(false);
  });

  test("keeps the caller's TTS and viewport settings", () => {
    const config = toWalkthroughConfig(makeConfig("/repo"), "http://127.0.0.1:1", "/repo/reviews");

    expect(config.tts).toEqual(makeConfig("/repo").tts);
    expect(config.viewport).toEqual(makeConfig("/repo").viewport);
  });
});

describe("createDefinitionDigest", () => {
  test("changes when any authored field changes", () => {
    const digest = createDefinitionDigest(reviewDefinition());

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(createDefinitionDigest(reviewDefinition())).toBe(digest);
    expect(createDefinitionDigest({ ...reviewDefinition(), title: "Other" })).not.toBe(digest);
  });
});

async function makeReviewRepo(): Promise<TempRepo> {
  const repo = await createTempRepo("demohunter-review-generate-");
  repos.push(repo);

  await repo.write("src/app.ts", ["const port = 3000;", "listen(port);"].join("\n") + "\n");
  await repo.write("src/app.test.ts", "export const covered = false;\n");
  await repo.commit("base");
  await repo.runGit(["checkout", "--quiet", "-b", "feature"]);
  await repo.write(
    "src/app.ts",
    ["const port = 3000;", 'listen(port, "127.0.0.1");', "logBoundAddress();"].join("\n") + "\n",
  );
  await repo.write("src/app.test.ts", "export const covered = true;\n");
  await repo.commit("feature work");

  return repo;
}

function baseInput(repo: TempRepo) {
  return {
    review: reviewDefinition(),
    sourcePath: "reviews/pr-22.review.ts",
    cwd: repo.root,
    baseRef: "main",
    config: makeConfig(repo.root),
    generatorVersion: "0.1.5",
  };
}

/**
 * Stands in for the Playwright + ffmpeg pipeline.
 *
 * It actually runs the compiled tour with a recording stub, so the narration
 * lines and chapter titles written into the fake captions and manifest are the
 * ones `compileReviewTour` really produces.
 */
function fakeDependencies() {
  return {
    generateTour: (async (input: {
      loadedConfig: { config: ResolvedDemoHunterConfig };
      tourFile: { tour: DemoHunterTour };
    }) => {
      const narrationLines: string[] = [];
      const chapterTitles: string[] = [];

      await input.tourFile.tour.run(makeRecordingStub(narrationLines, chapterTitles) as never);

      return writeFakeTourOutput({
        outputDir: path.join(input.loadedConfig.config.outputDir, input.tourFile.tour.id),
        tourId: input.tourFile.tour.id,
        tourTitle: input.tourFile.tour.title,
        narrationLines,
        chapterTitles,
      });
    }) as never,
  };
}

function makeRecordingStub(narrationLines: string[], chapterTitles: string[]) {
  return {
    chapter: async (title: string) => {
      chapterTitles.push(title);
    },
    narrate: async (text: string) => {
      narrationLines.push(text);
    },
    narrateWhile: async (
      text: string,
      body: (timeline: { sleep: (ms: number) => Promise<void> }) => Promise<void>,
    ) => {
      narrationLines.push(text);
      await body({ sleep: async () => undefined });
    },
    step: async (_title: string, body: () => Promise<void>) => {
      await body();
    },
    highlight: async () => undefined,
    page: {
      evaluate: async () => undefined,
      waitForTimeout: async () => undefined,
      locator: () => ({ first: () => ({ count: async () => 0 }) }),
    },
  };
}

function reviewDefinition(): ReviewDefinition {
  return {
    id: "pr-22-review",
    title: "PR 22 review",
    problem: { summary: "The server bound every interface." },
    architecture: [
      {
        kind: "component",
        id: "arch",
        title: "Architecture",
        nodes: [
          { id: "cli", label: "CLI", column: 0, row: 0 },
          { id: "server", label: "Server", column: 1, row: 0, changed: true },
        ],
        edges: [{ from: "cli", to: "server", label: "serve" }],
      },
    ],
    chapters: [
      {
        id: "core",
        title: "Core change",
        intent: "Binds loopback only.",
        narration: "The server now binds loopback only.",
        files: ["src/app.ts"],
        evidence: [
          { kind: "diff", id: "app-diff", path: "src/app.ts", note: "Check the bind address." },
          { kind: "code", id: "app-code", path: "src/app.ts", startLine: 1, endLine: 2 },
        ],
        reviewerChecks: [{ id: "check-bind", check: "The bind address is 127.0.0.1." }],
      },
    ],
    verification: [{ id: "tests", label: "Unit tests", command: ["node", "-e", "process.exit(0)"] }],
    coverage: {
      groups: [
        { id: "tests", title: "Tests", rationale: "Reviewed with the behaviour.", patterns: ["**/*.test.ts"] },
      ],
    },
  };
}

function makeConfig(projectRoot: string): ResolvedDemoHunterConfig {
  return {
    baseURL: "http://127.0.0.1:3000",
    outputDir: path.join(projectRoot, ".demohunter"),
    cacheDir: path.join(projectRoot, ".demohunter/cache"),
    browser: "chromium",
    viewport: { width: 1440, height: 900 },
    holdPaddingMs: 300,
    record: {
      container: "mp4",
      format: "mp4",
      showActions: true,
      showChapters: true,
      showCursor: true,
      showClickRipple: true,
      highlightStyle: "ring",
      cookieBanners: { enabled: true, action: "reject", timeoutMs: 1000, additionalSelectors: [] },
      cursor: { mode: "smooth", shape: "dot", color: "#3b82f6", ripple: true, sizePx: 18, minDurationMs: 120, maxDurationMs: 900, pixelsPerMs: 1.6, arcHeightPx: 40 },
    },
    output: { formats: [] },
    tts: { provider: "openai", voice: "marin", model: "gpt-4o-mini-tts", format: "mp3", instructions: "Speak clearly." },
  } as ResolvedDemoHunterConfig;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
