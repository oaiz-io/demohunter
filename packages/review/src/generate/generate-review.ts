import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { generateTour } from "@demohunter/generator-playwright";
import { createPortableArtifactDescriptor } from "@demohunter/manifest";
import type { ResolvedDemoHunterConfig } from "@demohunter/sdk";

import type { ReviewDefinition } from "../authoring/review-types.js";
import { validateReviewDefinition } from "../authoring/validate-review.js";
import { assertCoverageComplete, computeCoverage } from "../coverage/compute-coverage.js";
import { resolveEvidence, type ResolvedEvidence } from "../evidence/resolve-evidence.js";
import { collectChangedFiles } from "../git/collect-changed-files.js";
import type { ChangedFile } from "../git/git-types.js";
import { resolveComparison } from "../git/resolve-comparison.js";
import { createGitRunner, type RunGit } from "../git/run-git.js";
import { describeWorktreeStatus, readWorktreeStatus } from "../git/worktree-status.js";
import {
  REVIEW_LOCK_FILE_NAME,
  REVIEW_LOCK_VERSION,
  parseReviewLock,
  serializeReviewLock,
  type ReviewLock,
} from "../lock/review-lock.js";
import { runVerification, type RunCommand } from "../verification/run-verification.js";
import { renderViewer } from "../viewer/render-viewer.js";
import type { ReviewViewModel } from "../viewer/view-model.js";
import { serveReview, type ReviewServer } from "../server/serve-review.js";
import { compileReviewTour } from "../video/compile-review-tour.js";

export const REVIEWS_DIRECTORY_NAME = "reviews";

/** Everything a recorded walkthrough leaves in the review directory. */
const WALKTHROUGH_ARTIFACT_FILES = [
  "video.mp4",
  "poster.jpg",
  "captions.srt",
  "captions.vtt",
  "chapters.json",
  "manifest.json",
] as const;
const WALKTHROUGH_ARTIFACT_DIRECTORIES = ["audio"] as const;

export type GenerateReviewProgressEvent = {
  phase:
    | "resolving-git"
    | "collecting-diff"
    | "checking-coverage"
    | "resolving-evidence"
    | "running-verification"
    | "rendering-viewer"
    | "recording-video"
    | "writing-lock"
    | "completed";
  message: string;
};

export type GenerateReviewInput = {
  review: ReviewDefinition;
  /** Repository-relative path of the authored `pr.review.ts`. */
  sourcePath: string;
  cwd: string;
  baseRef: string;
  headRef?: string;
  config: ResolvedDemoHunterConfig;
  generatorVersion: string;
  runVerificationCommands?: boolean;
  allowDirtyWorktree?: boolean;
  /** Skip the narrated walkthrough. The website is still produced. */
  skipVideo?: boolean;
  onProgress?: (event: GenerateReviewProgressEvent) => void;
};

export type GenerateReviewDependencies = {
  runGit: RunGit;
  generateTour: typeof generateTour;
  serveReview: typeof serveReview;
  runCommand?: RunCommand;
  now: () => Date;
};

export type GenerateReviewResult = {
  reviewDir: string;
  lock: ReviewLock;
  lockPath: string;
  indexPath: string;
  videoPath: string | null;
};

export class ReviewWorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewWorktreeError";
  }
}

/**
 * Produces one review artifact: a local website and a narrated walkthrough,
 * both derived from a single authored definition plus the real Git range.
 */
export async function generateReview(
  input: GenerateReviewInput,
  dependencies: Partial<GenerateReviewDependencies> = {},
): Promise<GenerateReviewResult> {
  const resolved: GenerateReviewDependencies = {
    runGit: dependencies.runGit ?? createGitRunner(input.cwd),
    generateTour: dependencies.generateTour ?? generateTour,
    serveReview: dependencies.serveReview ?? serveReview,
    ...(dependencies.runCommand === undefined ? {} : { runCommand: dependencies.runCommand }),
    now: dependencies.now ?? (() => new Date()),
  };

  validateReviewDefinition(input.review);

  report(input, "resolving-git", `Resolving ${input.baseRef}...${input.headRef ?? "HEAD"}`);
  const comparison = await resolveComparison({
    runGit: resolved.runGit,
    baseRef: input.baseRef,
    ...(input.headRef === undefined ? {} : { headRef: input.headRef }),
  });
  const worktree = await readWorktreeStatus({ runGit: resolved.runGit });

  if (!worktree.clean && input.allowDirtyWorktree !== true) {
    throw new ReviewWorktreeError(
      `The work tree is not clean (${describeWorktreeStatus(worktree)}).\n`
        + "  A review artifact records exact commit shas, so generating one from a dirty tree would\n"
        + "  describe code that is not in any commit. Commit or stash your changes and rerun, or pass\n"
        + "  --allow-dirty to generate a clearly-marked draft artifact.",
    );
  }

  report(
    input,
    "collecting-diff",
    `Collecting merge-base..HEAD diff (${comparison.mergeBaseSha.slice(0, 12)}..${comparison.headSha.slice(0, 12)})`,
  );
  const changedFiles = await collectChangedFiles({
    runGit: resolved.runGit,
    mergeBaseSha: comparison.mergeBaseSha,
    headSha: comparison.headSha,
    ...(input.review.coverage?.generatedPatterns === undefined
      ? {}
      : { generatedPatterns: input.review.coverage.generatedPatterns }),
  });

  if (changedFiles.length === 0) {
    throw new Error(
      `No files changed between ${comparison.baseRef} (merge base ${comparison.mergeBaseSha.slice(0, 12)}) `
        + `and ${comparison.headRef} (${comparison.headSha.slice(0, 12)}). There is nothing to review.`,
    );
  }

  report(input, "checking-coverage", `Accounting for ${changedFiles.length} changed file(s)`);
  const coverage = computeCoverage({ review: input.review, changedFiles });
  assertCoverageComplete(coverage);

  report(input, "resolving-evidence", "Snapshotting focused evidence from Git");
  const evidenceByChapter = await resolveAllEvidence({
    review: input.review,
    runGit: resolved.runGit,
    mergeBaseSha: comparison.mergeBaseSha,
    headSha: comparison.headSha,
    changedFiles,
  });

  report(
    input,
    "running-verification",
    input.runVerificationCommands === true
      ? "Running verification commands"
      : "Recording verification commands as not-run",
  );
  const verification = await runVerification({
    commands: input.review.verification ?? [],
    cwd: comparison.repoRoot,
    run: input.runVerificationCommands === true,
    ...(resolved.runCommand === undefined ? {} : { runCommand: resolved.runCommand }),
    onProgress: (message) => report(input, "running-verification", message),
  });

  const reviewsRoot = path.join(input.config.outputDir, REVIEWS_DIRECTORY_NAME);
  const reviewDir = path.join(reviewsRoot, input.review.id);
  await mkdir(reviewDir, { recursive: true });
  await ensureSelfIgnored(reviewsRoot, REVIEWS_ROOT_GITIGNORE);
  // Recording resolves narration through the cache, which lives outside the
  // reviews root. Left alone it would show up as an untracked directory and
  // make the very tree this artifact calls clean look dirty.
  await ensureSelfIgnored(input.config.cacheDir, CACHE_DIR_GITIGNORE);

  const baseModel: ReviewViewModel = {
    generatedAt: resolved.now().toISOString(),
    generatorVersion: input.generatorVersion,
    review: input.review,
    git: { ...comparison, worktree },
    files: changedFiles,
    coverage,
    evidenceByChapter,
    verification,
    video: null,
  };

  report(input, "rendering-viewer", `Rendering review website into ${reviewDir}`);
  await writeViewerFiles(reviewDir, baseModel);

  let videoModel = baseModel;
  let videoResult: Awaited<ReturnType<typeof generateTour>> | undefined;

  if (input.skipVideo === true) {
    // A lock that records no walkthrough must not sit beside a playable one
    // from an earlier run: the reviewer would watch a video this artifact does
    // not vouch for, narrated from a range that may no longer exist.
    await removeStaleWalkthrough(reviewDir);
  }

  if (input.skipVideo !== true) {
    let server: ReviewServer | undefined;

    try {
      server = await resolved.serveReview({ root: reviewDir });
      report(input, "recording-video", `Recording narrated walkthrough from ${server.baseUrl}`);
      const compiled = compileReviewTour(baseModel);

      videoResult = await resolved.generateTour({
        loadedConfig: {
          projectRoot: comparison.repoRoot,
          configPath: path.join(comparison.repoRoot, "demohunter.config.ts"),
          config: toWalkthroughConfig(input.config, server.baseUrl, reviewsRoot),
        },
        tourFile: {
          path: path.join(reviewDir, `${input.review.id}.review.tour.ts`),
          tour: compiled.tour,
        },
        onProgress: (event) => report(input, "recording-video", event.message),
      });
    } finally {
      await server?.close();
    }

    const videoView = await readVideoView(reviewDir, videoResult);
    videoModel = { ...baseModel, video: videoView.view };
    report(input, "rendering-viewer", "Re-rendering the website with the recorded walkthrough");
    await writeViewerFiles(reviewDir, videoModel);
  }

  report(input, "writing-lock", `Writing ${REVIEW_LOCK_FILE_NAME}`);
  const lock = await buildReviewLock({
    model: videoModel,
    sourcePath: input.sourcePath,
    reviewDir,
    hasVideo: videoResult !== undefined,
  });
  const lockPath = path.join(reviewDir, REVIEW_LOCK_FILE_NAME);
  await writeFile(lockPath, serializeReviewLock(lock), "utf8");

  report(input, "completed", `Review artifact ready at ${reviewDir}`);

  return {
    reviewDir,
    lock,
    lockPath,
    indexPath: path.join(reviewDir, "index.html"),
    videoPath: videoResult?.videoPath ?? null,
  };
}

async function resolveAllEvidence(input: {
  review: ReviewDefinition;
  runGit: RunGit;
  mergeBaseSha: string;
  headSha: string;
  changedFiles: readonly ChangedFile[];
}): Promise<Record<string, ResolvedEvidence[]>> {
  const changedFilesByPath = new Map(input.changedFiles.map((file) => [file.path, file]));
  const evidenceByChapter: Record<string, ResolvedEvidence[]> = {};

  for (const chapter of input.review.chapters) {
    const resolvedEvidence: ResolvedEvidence[] = [];

    for (const evidence of chapter.evidence) {
      resolvedEvidence.push(
        await resolveEvidence({
          runGit: input.runGit,
          evidence,
          chapterId: chapter.id,
          mergeBaseSha: input.mergeBaseSha,
          headSha: input.headSha,
          changedFilesByPath,
        }),
      );
    }

    evidenceByChapter[chapter.id] = resolvedEvidence;
  }

  return evidenceByChapter;
}

/**
 * A review artifact embeds verbatim source from the repository and is rebuilt
 * from the definition on demand, so it is never meant to be committed.
 */
export const REVIEWS_ROOT_GITIGNORE = `# Managed by DemoHunter Review. Review artifacts are generated, never committed.
*
`;

export const CACHE_DIR_GITIGNORE = `# Managed by DemoHunter. Narration cache entries are local and regenerable.
*
`;

/**
 * Writes a `.gitignore` that also covers itself, unless one already exists.
 *
 * Covering itself is the point: generation requires a clean work tree and
 * `verify --strict` re-checks it, so a directory DemoHunter creates must not
 * leave a stray untracked file behind. The recording pass writes its own, more
 * permissive ignore file when none exists, so this has to land first to win.
 */
export async function ensureSelfIgnored(directory: string, contents: string): Promise<void> {
  const gitignorePath = path.join(directory, ".gitignore");

  if (await pathExists(gitignorePath)) {
    return;
  }

  await mkdir(directory, { recursive: true });
  await writeFile(gitignorePath, contents, "utf8");
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function removeStaleWalkthrough(reviewDir: string): Promise<void> {
  for (const relativePath of [...WALKTHROUGH_ARTIFACT_FILES, ...WALKTHROUGH_ARTIFACT_DIRECTORIES]) {
    await rm(path.join(reviewDir, relativePath), { recursive: true, force: true });
  }
}

async function writeViewerFiles(reviewDir: string, model: ReviewViewModel): Promise<void> {
  const files = renderViewer(model);

  // Remove stale diagrams so a renamed or deleted diagram cannot linger in the
  // served artifact and contradict the lock.
  await rm(path.join(reviewDir, "diagrams"), { recursive: true, force: true });

  for (const file of files) {
    const target = path.join(reviewDir, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.contents, "utf8");
  }
}

/**
 * Recording configuration for the walkthrough.
 *
 * The reviewed page is a document, not an app, so pointer affordances are
 * turned off and social output variants are disabled: variants would restage
 * the whole output directory and clobber the website that lives beside the
 * video.
 */
export function toWalkthroughConfig(
  config: ResolvedDemoHunterConfig,
  baseUrl: string,
  reviewsRoot: string,
): ResolvedDemoHunterConfig {
  return {
    ...config,
    baseURL: baseUrl,
    outputDir: reviewsRoot,
    output: { formats: [] },
    record: {
      ...config.record,
      container: "mp4",
      format: "mp4",
      showActions: false,
      showChapters: true,
      showCursor: false,
      showClickRipple: false,
      cursor: false,
      cookieBanners: { enabled: false, action: "reject", timeoutMs: 0, additionalSelectors: [] },
    },
  };
}

type VideoDetails = {
  view: ReviewViewModel["video"];
  narrationCount: number;
  chapterCount: number;
};

async function readVideoView(
  reviewDir: string,
  result: { videoPath: string; captionsVttPath: string } | undefined,
): Promise<VideoDetails> {
  if (result === undefined) {
    return { view: null, narrationCount: 0, chapterCount: 0 };
  }

  const manifest = JSON.parse(await readFile(path.join(reviewDir, "manifest.json"), "utf8")) as {
    playback?: { durationMs?: number };
    timeline?: {
      chapters?: Array<{ title: string; startMs: number }>;
      narrations?: unknown[];
    };
  };
  const chapters = manifest.timeline?.chapters ?? [];

  return {
    view: {
      video: toPosix(path.relative(reviewDir, result.videoPath)),
      poster: "poster.jpg",
      captionsVtt: toPosix(path.relative(reviewDir, result.captionsVttPath)),
      durationMs: manifest.playback?.durationMs ?? 0,
      chapters,
    },
    narrationCount: manifest.timeline?.narrations?.length ?? 0,
    chapterCount: chapters.length,
  };
}

async function buildReviewLock(input: {
  model: ReviewViewModel;
  sourcePath: string;
  reviewDir: string;
  hasVideo: boolean;
}): Promise<ReviewLock> {
  const { model } = input;
  const videoDetails = input.hasVideo
    ? await readVideoView(input.reviewDir, {
        videoPath: path.join(input.reviewDir, "video.mp4"),
        captionsVttPath: path.join(input.reviewDir, "captions.vtt"),
      })
    : ({ view: null, narrationCount: 0, chapterCount: 0 } satisfies VideoDetails);

  const artifactPaths = [
    "index.html",
    "assets/viewer.css",
    "assets/viewer.js",
    "data/review.json",
    ...(model.review.architecture ?? []).map((diagram) => `diagrams/${diagram.id}.svg`),
    ...(input.hasVideo ? WALKTHROUGH_ARTIFACT_FILES : []),
  ];

  const artifacts = [];

  for (const relativePath of artifactPaths) {
    artifacts.push(
      await createPortableArtifactDescriptor({
        outputDir: input.reviewDir,
        filePath: path.join(input.reviewDir, relativePath),
        mediaType: mediaTypeFor(relativePath),
      }),
    );
  }

  return parseReviewLock({
    lockVersion: REVIEW_LOCK_VERSION,
    generator: { name: "demohunter-review", version: model.generatorVersion },
    generatedAt: model.generatedAt,
    review: {
      id: model.review.id,
      title: model.review.title,
      ...(model.review.subtitle === undefined ? {} : { subtitle: model.review.subtitle }),
      sourcePath: input.sourcePath,
      definitionDigest: createDefinitionDigest(model.review),
      ...(model.review.pullRequest === undefined ? {} : { pullRequest: model.review.pullRequest }),
    },
    git: {
      baseRef: model.git.baseRef,
      baseSha: model.git.baseSha,
      headRef: model.git.headRef,
      headSha: model.git.headSha,
      mergeBaseSha: model.git.mergeBaseSha,
      mergeBaseCandidates: model.git.mergeBaseCandidates,
      headIsMergeCommit: model.git.headIsMergeCommit,
      headParents: model.git.headParents,
      worktree: {
        clean: model.git.worktree.clean,
        entries: model.git.worktree.entries,
      },
    },
    files: model.files,
    coverage: {
      totalCount: model.coverage.totalCount,
      accountedCount: model.coverage.accountedCount,
      complete: model.coverage.complete,
      assignments: model.coverage.assignments,
      unaccounted: model.coverage.unaccounted,
      groups: model.coverage.groups.map((group) => ({
        id: group.id,
        title: group.title,
        rationale: group.rationale,
        patterns: group.patterns,
        paths: group.paths,
      })),
      chapters: model.coverage.chapters,
    },
    evidence: Object.values(model.evidenceByChapter)
      .flat()
      .map((evidence) => ({
        id: evidence.id,
        chapterId: evidence.chapterId,
        kind: evidence.kind,
        path: evidence.path,
        ...(evidence.kind === "diff" && evidence.previousPath !== undefined
          ? { previousPath: evidence.previousPath }
          : {}),
        anchor: evidence.anchor,
        contentDigest: evidence.contentDigest,
        provenance: evidence.provenance,
        ...(evidence.kind === "code"
          ? { side: evidence.side, range: { startLine: evidence.startLine, endLine: evidence.endLine } }
          : {}),
      })),
    verification: model.verification,
    video: videoDetails.view === null
      ? null
      : {
          tourId: model.review.id,
          durationMs: videoDetails.view.durationMs,
          video: "video.mp4",
          poster: "poster.jpg",
          captionsSrt: "captions.srt",
          captionsVtt: "captions.vtt",
          chapters: "chapters.json",
          manifest: "manifest.json",
          chapterCount: videoDetails.chapterCount,
          narrationCount: videoDetails.narrationCount,
        },
    artifacts,
  });
}

export function createDefinitionDigest(review: ReviewDefinition): string {
  return createHash("sha256").update(JSON.stringify(review), "utf8").digest("hex");
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function mediaTypeFor(relativePath: string): string {
  const extension = path.extname(relativePath).toLowerCase();

  switch (extension) {
    case ".html":
      return "text/html";
    case ".css":
      return "text/css";
    case ".js":
      return "text/javascript";
    case ".json":
      return "application/json";
    case ".svg":
      return "image/svg+xml";
    case ".mp4":
      return "video/mp4";
    case ".jpg":
      return "image/jpeg";
    case ".vtt":
      return "text/vtt";
    case ".srt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

function report(
  input: GenerateReviewInput,
  phase: GenerateReviewProgressEvent["phase"],
  message: string,
): void {
  input.onProgress?.({ phase, message });
}
