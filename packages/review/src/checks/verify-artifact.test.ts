import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { DemoHunterTour, ResolvedDemoHunterConfig } from "@demohunter/sdk";

import type { ReviewDefinition } from "../authoring/review-types.js";
import { generateReview, type GenerateReviewResult } from "../generate/generate-review.js";
import { REVIEW_LOCK_FILE_NAME, serializeReviewLock, type ReviewLock } from "../lock/review-lock.js";
import { writeFakeTourOutput } from "../test-support/fake-tour-output.ts";
import { createTempRepo, type TempRepo } from "../test-support/temp-repo.ts";
import type { ProbeMediaRunner } from "./probe-media.js";
import { countCues, REVIEW_CHECK_CATEGORIES, verifyReviewArtifact } from "./verify-artifact.js";

const repos: TempRepo[] = [];

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.dispose()));
});

describe("countCues", () => {
  test("counts VTT and SRT timing lines", () => {
    expect(countCues("WEBVTT\n\n1\n00:00:00.000 --> 00:00:04.000\nhello\n")).toBe(1);
    expect(countCues("1\n00:00:00,000 --> 00:00:04,000\nhello\n\n2\n00:00:04,000 --> 00:00:08,000\nbye\n")).toBe(2);
    expect(countCues("WEBVTT\n")).toBe(0);
  });
});

describe("verifyReviewArtifact", () => {
  test("passes strict verification for a freshly generated artifact", async () => {
    const { repo, result } = await generateFixture();
    const verification = await verifyReviewArtifact(
      { reviewDir: result.reviewDir, cwd: repo.root, strict: true },
      { runGit: repo.runGit, probeRunCommand: fakeProbe(result) },
    );

    expect(failures(verification.checks)).toEqual([]);
    expect(verification.ok).toBe(true);
    expect(verification.failedCategory).toBeNull();
    for (const category of REVIEW_CHECK_CATEGORIES) {
      expect(verification.checks.some((check) => check.category === category)).toBe(true);
    }
  });

  test("fails when the lock is missing or unparseable", async () => {
    const { repo, result } = await generateFixture();
    await writeFile(path.join(result.reviewDir, REVIEW_LOCK_FILE_NAME), "{ not json", "utf8");

    const verification = await verifyReviewArtifact(
      { reviewDir: result.reviewDir, cwd: repo.root },
      { runGit: repo.runGit },
    );

    expect(verification.ok).toBe(false);
    expect(verification.lock).toBeNull();
    expect(verification.failedCategory).toBe("lock");
  });

  test("fails as stale once HEAD moves", async () => {
    const { repo, result } = await generateFixture();
    await repo.write("src/extra.ts", "export const extra = true;\n");
    await repo.commit("more work");

    const verification = await verifyReviewArtifact(
      { reviewDir: result.reviewDir, cwd: repo.root },
      { runGit: repo.runGit, probeRunCommand: fakeProbe(result) },
    );

    expect(verification.ok).toBe(false);
    expect(verification.failedCategory).toBe("stale");
    expect(verification.checks.some((check) => check.id === "stale-head-moved")).toBe(true);
    expect(
      verification.checks.find((check) => check.id === "stale-head-moved")?.message,
    ).toContain("Regenerate the review against the current HEAD.");
  });

  test("fails when a recorded artifact was edited on disk", async () => {
    const { repo, result } = await generateFixture();
    await writeFile(path.join(result.reviewDir, "index.html"), "<!doctype html>tampered", "utf8");

    const verification = await verifyReviewArtifact(
      { reviewDir: result.reviewDir, cwd: repo.root },
      { runGit: repo.runGit, probeRunCommand: fakeProbe(result) },
    );

    expect(verification.ok).toBe(false);
    expect(
      verification.checks.some((check) => check.id === "artifact-checksum:index.html"),
    ).toBe(true);
  });

  test("fails when a recorded artifact is missing", async () => {
    const { repo, result } = await generateFixture();
    await rm(path.join(result.reviewDir, "diagrams/arch.svg"));

    const verification = await verifyReviewArtifact(
      { reviewDir: result.reviewDir, cwd: repo.root },
      { runGit: repo.runGit, probeRunCommand: fakeProbe(result) },
    );

    expect(verification.ok).toBe(false);
    expect(
      verification.checks.some((check) => check.id === "artifact-missing:diagrams/arch.svg"),
    ).toBe(true);
  });

  test("fails when the walkthrough has no audio stream", async () => {
    const { repo, result } = await generateFixture();
    const verification = await verifyReviewArtifact(
      { reviewDir: result.reviewDir, cwd: repo.root },
      { runGit: repo.runGit, probeRunCommand: fakeProbe(result, { audio: false }) },
    );

    expect(verification.ok).toBe(false);
    const audioCheck = verification.checks.find((check) => check.id === "video-audio-stream");
    expect(audioCheck?.status).toBe("fail");
    expect(audioCheck?.message).toContain("without narration");
  });

  test("fails when the probed duration drifts from the recorded duration", async () => {
    const { repo, result } = await generateFixture();
    const verification = await verifyReviewArtifact(
      { reviewDir: result.reviewDir, cwd: repo.root },
      { runGit: repo.runGit, probeRunCommand: fakeProbe(result, { durationMs: 999_000 }) },
    );

    expect(verification.checks.find((check) => check.id === "video-duration")?.status).toBe("fail");
  });

  test("fails when the caption cue count no longer matches the narration count", async () => {
    const { repo, result } = await generateFixture();
    const lockPath = path.join(result.reviewDir, REVIEW_LOCK_FILE_NAME);
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as ReviewLock;
    lock.video!.narrationCount += 1;
    await writeFile(lockPath, serializeReviewLock(lock), "utf8");

    const verification = await verifyReviewArtifact(
      { reviewDir: result.reviewDir, cwd: repo.root },
      { runGit: repo.runGit, probeRunCommand: fakeProbe(result) },
    );

    expect(verification.checks.find((check) => check.id === "captions-cues")?.status).toBe("fail");
  });

  test("fails when chapters.json is not monotonic", async () => {
    const { repo, result } = await generateFixture();
    await writeFile(
      path.join(result.reviewDir, "chapters.json"),
      `${JSON.stringify([{ title: "Second", startMs: 9000 }, { title: "First", startMs: 0 }], null, 2)}\n`,
      "utf8",
    );

    const verification = await verifyReviewArtifact(
      { reviewDir: result.reviewDir, cwd: repo.root },
      { runGit: repo.runGit, probeRunCommand: fakeProbe(result) },
    );

    const chaptersCheck = verification.checks.find((check) => check.id === "chapters");
    expect(chaptersCheck?.status).toBe("fail");
    expect(chaptersCheck?.message).toContain("monotonic: false");
  });

  test("fails when evidence no longer resolves to the recorded blobs", async () => {
    const { repo, result } = await generateFixture();
    const lockPath = path.join(result.reviewDir, REVIEW_LOCK_FILE_NAME);
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as ReviewLock;
    lock.evidence[0]!.provenance.newBlobSha = "0".repeat(40);
    await writeFile(lockPath, serializeReviewLock(lock), "utf8");

    const verification = await verifyReviewArtifact(
      { reviewDir: result.reviewDir, cwd: repo.root },
      { runGit: repo.runGit, probeRunCommand: fakeProbe(result) },
    );

    expect(verification.ok).toBe(false);
    expect(verification.failedCategory).toBe("evidence");
    expect(
      verification.checks.some((check) => check.message.includes("no longer resolves")),
    ).toBe(true);
  });

  test("fails when code evidence points at a different range than recorded", async () => {
    const { repo, result } = await generateFixture();
    const lockPath = path.join(result.reviewDir, REVIEW_LOCK_FILE_NAME);
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as ReviewLock;
    const code = lock.evidence.find((evidence) => evidence.kind === "code")!;
    code.range = { startLine: 2, endLine: 3 };
    await writeFile(lockPath, serializeReviewLock(lock), "utf8");

    const verification = await verifyReviewArtifact(
      { reviewDir: result.reviewDir, cwd: repo.root },
      { runGit: repo.runGit, probeRunCommand: fakeProbe(result) },
    );

    expect(verification.checks.some((check) => check.id === `evidence-anchor:${code.id}`)).toBe(true);
  });

  test("fails coverage when the recorded file set no longer matches Git", async () => {
    const { repo, result } = await generateFixture();
    const lockPath = path.join(result.reviewDir, REVIEW_LOCK_FILE_NAME);
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as ReviewLock;
    lock.files = lock.files.filter((file) => file.path !== "src/app.test.ts");
    await writeFile(lockPath, serializeReviewLock(lock), "utf8");

    const verification = await verifyReviewArtifact(
      { reviewDir: result.reviewDir, cwd: repo.root },
      { runGit: repo.runGit, probeRunCommand: fakeProbe(result) },
    );

    const coverageCheck = verification.checks.find((check) => check.id === "coverage-file-set");
    expect(coverageCheck?.status).toBe("fail");
    expect(coverageCheck?.message).toContain("src/app.test.ts");
  });

  test("warns without strict, fails with strict, when verification never ran", async () => {
    const { repo, result } = await generateFixture({ runVerificationCommands: false });

    const lenient = await verifyReviewArtifact(
      { reviewDir: result.reviewDir, cwd: repo.root },
      { runGit: repo.runGit, probeRunCommand: fakeProbe(result) },
    );
    const strict = await verifyReviewArtifact(
      { reviewDir: result.reviewDir, cwd: repo.root, strict: true },
      { runGit: repo.runGit, probeRunCommand: fakeProbe(result) },
    );

    expect(lenient.checks.find((check) => check.id === "verification")?.status).toBe("warn");
    expect(lenient.ok).toBe(true);
    expect(strict.checks.find((check) => check.id === "verification")?.status).toBe("fail");
    expect(strict.ok).toBe(false);
    expect(strict.failedCategory).toBe("verification");
  });

  test("warns without strict, fails with strict, when the tree is dirty", async () => {
    const { repo, result } = await generateFixture();
    await writeFile(path.join(repo.root, "src/app.ts"), "dirty\n", "utf8");

    const lenient = await verifyReviewArtifact(
      { reviewDir: result.reviewDir, cwd: repo.root },
      { runGit: repo.runGit, probeRunCommand: fakeProbe(result) },
    );
    const strict = await verifyReviewArtifact(
      { reviewDir: result.reviewDir, cwd: repo.root, strict: true },
      { runGit: repo.runGit, probeRunCommand: fakeProbe(result) },
    );

    expect(lenient.checks.find((check) => check.id === "current-worktree-clean")?.status).toBe("warn");
    expect(strict.checks.find((check) => check.id === "current-worktree-clean")?.status).toBe("fail");
  });

  test("reports a failed probe rather than silently passing", async () => {
    const { repo, result } = await generateFixture();
    const verification = await verifyReviewArtifact(
      { reviewDir: result.reviewDir, cwd: repo.root },
      {
        runGit: repo.runGit,
        probeRunCommand: async () => {
          throw new Error("ffprobe not found");
        },
      },
    );

    expect(verification.ok).toBe(false);
    expect(verification.checks.find((check) => check.id === "video-probe")?.message).toContain(
      "ffprobe not found",
    );
  });

  test("warns rather than passing silently when no walkthrough was recorded", async () => {
    const { repo, result } = await generateFixture({ skipVideo: true });
    const verification = await verifyReviewArtifact(
      { reviewDir: result.reviewDir, cwd: repo.root },
      { runGit: repo.runGit },
    );

    expect(verification.checks.find((check) => check.id === "video-present")?.status).toBe("warn");
    expect(verification.ok).toBe(true);
  });
});

async function generateFixture(
  options: { runVerificationCommands?: boolean; skipVideo?: boolean } = {},
): Promise<{ repo: TempRepo; result: GenerateReviewResult }> {
  const repo = await createTempRepo("demohunter-review-verify-");
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

  const result = await generateReview(
    {
      review: reviewDefinition(),
      sourcePath: "reviews/pr-22.review.ts",
      cwd: repo.root,
      baseRef: "main",
      config: makeConfig(repo.root),
      generatorVersion: "0.1.5",
      runVerificationCommands: options.runVerificationCommands ?? true,
      skipVideo: options.skipVideo === true,
    },
    {
      runCommand: async () => ({ exitCode: 0, output: "ok\n", timedOut: false }),
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
    },
  );

  return { repo, result };
}

/** ffprobe stand-in that agrees with the recorded lock unless told otherwise. */
function fakeProbe(
  result: GenerateReviewResult,
  overrides: { audio?: boolean; durationMs?: number } = {},
): ProbeMediaRunner {
  return async () =>
    JSON.stringify({
      streams: [
        { codec_type: "video", codec_name: "h264", width: 1440, height: 900 },
        ...(overrides.audio === false
          ? []
          : [{ codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000" }]),
      ],
      format: {
        duration: String((overrides.durationMs ?? result.lock.video?.durationMs ?? 0) / 1000),
      },
    });
}

function failures(checks: ReadonlyArray<{ status: string; message: string }>): string[] {
  return checks.filter((check) => check.status === "fail").map((check) => check.message);
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
