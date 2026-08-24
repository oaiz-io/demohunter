import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { createPortableFileChecksum, parsePortableOutputManifest } from "@demohunter/manifest";

import { collectChangedFiles } from "../git/collect-changed-files.js";
import { resolveEvidence } from "../evidence/resolve-evidence.js";
import { createGitRunner, type RunGit } from "../git/run-git.js";
import { readWorktreeStatus } from "../git/worktree-status.js";
import { describeWorktreeStatus } from "../git/worktree-status.js";
import { detectStaleness } from "../lock/staleness.js";
import {
  REVIEW_LOCK_FILE_NAME,
  parseReviewLock,
  type ReviewLock,
} from "../lock/review-lock.js";
import { probeReviewMedia, type ProbeMediaRunner } from "./probe-media.js";

export const REVIEW_CHECK_CATEGORIES = [
  "lock",
  "stale",
  "artifact",
  "coverage",
  "evidence",
  "verification",
  "worktree",
] as const;

export type ReviewCheckCategory = (typeof REVIEW_CHECK_CATEGORIES)[number];

export type ReviewCheckStatus = "pass" | "fail" | "warn" | "skip";

export type ReviewCheck = {
  id: string;
  category: ReviewCheckCategory;
  status: ReviewCheckStatus;
  message: string;
};

export type VerifyReviewArtifactResult = {
  ok: boolean;
  strict: boolean;
  reviewDir: string;
  lock: ReviewLock | null;
  checks: ReviewCheck[];
  /** First failing category, used by the CLI to pick a specific exit code. */
  failedCategory: ReviewCheckCategory | null;
};

export type VerifyReviewArtifactInput = {
  reviewDir: string;
  cwd?: string;
  /** Strict mode additionally requires passing verification and a clean tree. */
  strict?: boolean;
};

export type VerifyReviewArtifactDependencies = {
  runGit: RunGit;
  probeRunCommand?: ProbeMediaRunner;
};

/**
 * Re-derives everything the artifact claims and compares it against the
 * repository as it exists now.
 *
 * Nothing in the artifact is trusted: checksums are recomputed, the changed-file
 * set is re-collected from Git, evidence anchors are re-resolved from the same
 * blobs, and the video is re-probed with ffprobe.
 */
export async function verifyReviewArtifact(
  input: VerifyReviewArtifactInput,
  dependencies: Partial<VerifyReviewArtifactDependencies> = {},
): Promise<VerifyReviewArtifactResult> {
  const reviewDir = path.resolve(input.reviewDir);
  const cwd = input.cwd ?? reviewDir;
  const runGit = dependencies.runGit ?? createGitRunner(cwd);
  const strict = input.strict === true;
  const checks: ReviewCheck[] = [];

  const lockPath = path.join(reviewDir, REVIEW_LOCK_FILE_NAME);
  let lock: ReviewLock;

  try {
    lock = parseReviewLock(JSON.parse(await readFile(lockPath, "utf8")));
    checks.push({
      id: "lock-parses",
      category: "lock",
      status: "pass",
      message: `${REVIEW_LOCK_FILE_NAME} is valid (lockVersion ${lock.lockVersion}).`,
    });
  } catch (error) {
    return {
      ok: false,
      strict,
      reviewDir,
      lock: null,
      failedCategory: "lock",
      checks: [
        ...checks,
        {
          id: "lock-parses",
          category: "lock",
          status: "fail",
          message: `Could not read ${lockPath}: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }

  await checkStaleness(checks, { lock, runGit });
  await checkWorktree(checks, { runGit, recordedClean: lock.git.worktree.clean, strict });
  await checkArtifactChecksums(checks, { lock, reviewDir });
  await checkVideoArtifacts(checks, {
    lock,
    reviewDir,
    ...(dependencies.probeRunCommand === undefined
      ? {}
      : { probeRunCommand: dependencies.probeRunCommand }),
  });
  await checkCoverage(checks, { lock, runGit });
  await checkEvidence(checks, { lock, runGit });
  checkVerification(checks, { lock, strict });

  const failed = checks.find((check) => check.status === "fail");

  return {
    ok: failed === undefined,
    strict,
    reviewDir,
    lock,
    checks,
    failedCategory: failed?.category ?? null,
  };
}

async function checkStaleness(
  checks: ReviewCheck[],
  input: { lock: ReviewLock; runGit: RunGit },
): Promise<void> {
  const staleness = await detectStaleness({ lock: input.lock, runGit: input.runGit });

  if (!staleness.stale) {
    checks.push({
      id: "not-stale",
      category: "stale",
      status: "pass",
      message:
        `Artifact matches the current range: ${input.lock.git.baseRef} `
        + `(merge base ${short(input.lock.git.mergeBaseSha)}) -> ${input.lock.git.headRef} `
        + `(${short(input.lock.git.headSha)}).`,
    });
    return;
  }

  for (const reason of staleness.reasons) {
    checks.push({
      id: `stale-${reason.code}`,
      category: "stale",
      status: "fail",
      message:
        `${reason.message}`
        + (reason.expected === undefined ? "" : ` Recorded ${short(reason.expected)}, found ${short(reason.actual ?? "")}.`)
        + " Regenerate the review against the current HEAD.",
    });
  }
}

async function checkWorktree(
  checks: ReviewCheck[],
  input: { runGit: RunGit; recordedClean: boolean; strict: boolean },
): Promise<void> {
  const status = await readWorktreeStatus({ runGit: input.runGit });

  checks.push({
    id: "recorded-worktree-clean",
    category: "worktree",
    status: input.recordedClean ? "pass" : input.strict ? "fail" : "warn",
    message: input.recordedClean
      ? "The work tree was clean when the artifact was generated."
      : "The artifact was generated from a dirty work tree, so it may describe uncommitted code.",
  });

  checks.push({
    id: "current-worktree-clean",
    category: "worktree",
    status: status.clean ? "pass" : input.strict ? "fail" : "warn",
    message: status.clean
      ? "The work tree is clean."
      : `The work tree is not clean (${describeWorktreeStatus(status)}).`,
  });
}

async function checkArtifactChecksums(
  checks: ReviewCheck[],
  input: { lock: ReviewLock; reviewDir: string },
): Promise<void> {
  let mismatches = 0;

  for (const artifact of input.lock.artifacts) {
    const filePath = path.join(input.reviewDir, artifact.path);
    const fileStat = await stat(filePath).catch(() => undefined);

    if (fileStat === undefined || !fileStat.isFile()) {
      mismatches += 1;
      checks.push({
        id: `artifact-missing:${artifact.path}`,
        category: "artifact",
        status: "fail",
        message: `Artifact ${artifact.path} is listed in the lock but missing from ${input.reviewDir}.`,
      });
      continue;
    }

    const checksum = await createPortableFileChecksum(filePath);

    if (checksum.hex !== artifact.checksum.hex || checksum.byteSize !== artifact.checksum.byteSize) {
      mismatches += 1;
      checks.push({
        id: `artifact-checksum:${artifact.path}`,
        category: "artifact",
        status: "fail",
        message:
          `Artifact ${artifact.path} does not match its recorded sha256 `
          + `(recorded ${artifact.checksum.hex.slice(0, 16)}, found ${checksum.hex.slice(0, 16)}).`,
      });
    }
  }

  if (mismatches === 0) {
    checks.push({
      id: "artifact-checksums",
      category: "artifact",
      status: "pass",
      message: `All ${input.lock.artifacts.length} recorded artifact checksum(s) match on disk.`,
    });
  }
}

async function checkVideoArtifacts(
  checks: ReviewCheck[],
  input: { lock: ReviewLock; reviewDir: string; probeRunCommand?: ProbeMediaRunner },
): Promise<void> {
  const video = input.lock.video;

  if (video === null) {
    checks.push({
      id: "video-present",
      category: "artifact",
      status: "warn",
      message: "This artifact has no narrated walkthrough. Regenerate without --no-video to record one.",
    });
    return;
  }

  const videoPath = path.join(input.reviewDir, video.video);

  try {
    const probe = await probeReviewMedia(videoPath, {
      ...(input.probeRunCommand === undefined ? {} : { runCommand: input.probeRunCommand }),
    });

    if (probe.video === undefined) {
      checks.push({
        id: "video-stream",
        category: "artifact",
        status: "fail",
        message: `ffprobe found no video stream in ${video.video}.`,
      });
    } else {
      checks.push({
        id: "video-stream",
        category: "artifact",
        status: "pass",
        message: `Video stream: ${probe.video.codec} ${probe.video.width}x${probe.video.height}.`,
      });
    }

    if (probe.audio === undefined) {
      checks.push({
        id: "video-audio-stream",
        category: "artifact",
        status: "fail",
        message:
          `ffprobe found no audio stream in ${video.video}. A review walkthrough without narration `
          + "is not a walkthrough; check that narration resolved from the TTS cache or provider.",
      });
    } else {
      checks.push({
        id: "video-audio-stream",
        category: "artifact",
        status: "pass",
        message: `Audio stream: ${probe.audio.codec}, ${probe.audio.channels} channel(s) at ${probe.audio.sampleRate} Hz.`,
      });
    }

    const drift = Math.abs(probe.durationMs - video.durationMs);
    checks.push({
      id: "video-duration",
      category: "artifact",
      status: probe.durationMs > 0 && drift <= 1500 ? "pass" : "fail",
      message:
        probe.durationMs <= 0
          ? `${video.video} has no measurable duration.`
          : `ffprobe duration ${probe.durationMs}ms vs recorded ${video.durationMs}ms (drift ${drift}ms).`,
    });
  } catch (error) {
    checks.push({
      id: "video-probe",
      category: "artifact",
      status: "fail",
      message: `Could not probe ${video.video}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  await checkCaptions(checks, { lock: input.lock, reviewDir: input.reviewDir });
  await checkChapters(checks, { lock: input.lock, reviewDir: input.reviewDir });
  await checkPortableManifest(checks, { lock: input.lock, reviewDir: input.reviewDir });
}

async function checkCaptions(
  checks: ReviewCheck[],
  input: { lock: ReviewLock; reviewDir: string },
): Promise<void> {
  const video = input.lock.video;

  if (video === null) {
    return;
  }

  const vtt = await readFile(path.join(input.reviewDir, video.captionsVtt), "utf8").catch(() => undefined);
  const srt = await readFile(path.join(input.reviewDir, video.captionsSrt), "utf8").catch(() => undefined);

  if (vtt === undefined || srt === undefined) {
    checks.push({
      id: "captions-present",
      category: "artifact",
      status: "fail",
      message: "Captions are missing from the review artifact.",
    });
    return;
  }

  if (!vtt.startsWith("WEBVTT")) {
    checks.push({
      id: "captions-vtt-header",
      category: "artifact",
      status: "fail",
      message: `${video.captionsVtt} does not start with a WEBVTT header.`,
    });
    return;
  }

  const vttCues = countCues(vtt);
  const srtCues = countCues(srt);

  checks.push({
    id: "captions-cues",
    category: "artifact",
    status: vttCues === video.narrationCount && srtCues === video.narrationCount && vttCues > 0
      ? "pass"
      : "fail",
    message:
      `Captions contain ${vttCues} VTT cue(s) and ${srtCues} SRT cue(s) for `
      + `${video.narrationCount} recorded narration segment(s).`,
  });
}

async function checkChapters(
  checks: ReviewCheck[],
  input: { lock: ReviewLock; reviewDir: string },
): Promise<void> {
  const video = input.lock.video;

  if (video === null) {
    return;
  }

  try {
    const parsed = JSON.parse(
      await readFile(path.join(input.reviewDir, video.chapters), "utf8"),
    ) as Array<{ title?: unknown; startMs?: unknown }>;

    if (!Array.isArray(parsed)) {
      throw new Error("chapters.json must contain an array");
    }

    const wellFormed = parsed.every(
      (chapter) =>
        typeof chapter.title === "string"
        && chapter.title.length > 0
        && typeof chapter.startMs === "number"
        && chapter.startMs >= 0,
    );
    const monotonic = parsed.every(
      (chapter, index) =>
        index === 0 || (chapter.startMs as number) >= (parsed[index - 1]!.startMs as number),
    );

    checks.push({
      id: "chapters",
      category: "artifact",
      status: wellFormed && monotonic && parsed.length === video.chapterCount && parsed.length > 0
        ? "pass"
        : "fail",
      message:
        `chapters.json has ${parsed.length} chapter(s) (recorded ${video.chapterCount}), `
        + `well-formed: ${wellFormed}, monotonic: ${monotonic}.`,
    });
  } catch (error) {
    checks.push({
      id: "chapters",
      category: "artifact",
      status: "fail",
      message: `Could not read chapters.json: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function checkPortableManifest(
  checks: ReviewCheck[],
  input: { lock: ReviewLock; reviewDir: string },
): Promise<void> {
  const video = input.lock.video;

  if (video === null) {
    return;
  }

  try {
    const manifest = parsePortableOutputManifest(
      JSON.parse(await readFile(path.join(input.reviewDir, video.manifest), "utf8")),
    );
    const descriptors = manifest.manifestVersion === 1
      ? [
          manifest.artifacts.videos.mp4,
          ...(manifest.artifacts.videos.webm === undefined ? [] : [manifest.artifacts.videos.webm]),
          manifest.artifacts.poster,
          manifest.artifacts.captions.srt,
          manifest.artifacts.captions.vtt,
          manifest.artifacts.chapters,
          ...manifest.artifacts.audio,
        ]
      : manifest.variants.flatMap((variant) => [
          variant.artifacts.videos.mp4,
          variant.artifacts.poster,
          variant.artifacts.captions.srt,
          variant.artifacts.captions.vtt,
          variant.artifacts.chapters,
          ...variant.artifacts.audio,
        ]);

    let mismatches = 0;

    for (const descriptor of descriptors) {
      const checksum = await createPortableFileChecksum(
        path.join(input.reviewDir, descriptor.path),
      ).catch(() => undefined);

      if (checksum === undefined || checksum.hex !== descriptor.checksum.hex) {
        mismatches += 1;
      }
    }

    checks.push({
      id: "portable-manifest",
      category: "artifact",
      status: mismatches === 0 ? "pass" : "fail",
      message: mismatches === 0
        ? `DemoHunter manifest v${manifest.manifestVersion} validates and all ${descriptors.length} checksum(s) match.`
        : `${mismatches} of ${descriptors.length} manifest checksum(s) do not match on disk.`,
    });
  } catch (error) {
    checks.push({
      id: "portable-manifest",
      category: "artifact",
      status: "fail",
      message: `Could not validate manifest.json: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function checkCoverage(
  checks: ReviewCheck[],
  input: { lock: ReviewLock; runGit: RunGit },
): Promise<void> {
  let currentFiles;

  try {
    currentFiles = await collectChangedFiles({
      runGit: input.runGit,
      mergeBaseSha: input.lock.git.mergeBaseSha,
      headSha: input.lock.git.headSha,
    });
  } catch (error) {
    checks.push({
      id: "coverage-recompute",
      category: "coverage",
      status: "fail",
      message: `Could not re-collect the changed-file set: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }

  const recordedPaths = new Set(input.lock.files.map((file) => file.path));
  const currentPaths = new Set(currentFiles.map((file) => file.path));
  const missing = [...currentPaths].filter((candidate) => !recordedPaths.has(candidate)).sort();
  const extra = [...recordedPaths].filter((candidate) => !currentPaths.has(candidate)).sort();

  checks.push({
    id: "coverage-file-set",
    category: "coverage",
    status: missing.length === 0 && extra.length === 0 ? "pass" : "fail",
    message: missing.length === 0 && extra.length === 0
      ? `The recorded changed-file set matches Git exactly (${currentPaths.size} file(s)).`
      : `Changed-file set drifted: ${missing.length} missing from the artifact, ${extra.length} no longer changed.`
        + (missing.length === 0 ? "" : ` Missing: ${missing.slice(0, 5).join(", ")}.`)
        + (extra.length === 0 ? "" : ` Extra: ${extra.slice(0, 5).join(", ")}.`),
  });

  const accountedPaths = new Set(input.lock.coverage.assignments.map((assignment) => assignment.path));
  const unaccounted = [...recordedPaths].filter((candidate) => !accountedPaths.has(candidate)).sort();

  checks.push({
    id: "coverage-complete",
    category: "coverage",
    status:
      input.lock.coverage.complete
      && unaccounted.length === 0
      && input.lock.coverage.accountedCount === input.lock.coverage.totalCount
      && input.lock.coverage.totalCount === recordedPaths.size
        ? "pass"
        : "fail",
    message:
      `Coverage accounts for ${input.lock.coverage.accountedCount}/${input.lock.coverage.totalCount} changed file(s)`
      + (unaccounted.length === 0 ? "." : `; unaccounted: ${unaccounted.slice(0, 5).join(", ")}.`),
  });
}

async function checkEvidence(
  checks: ReviewCheck[],
  input: { lock: ReviewLock; runGit: RunGit },
): Promise<void> {
  if (input.lock.evidence.length === 0) {
    checks.push({
      id: "evidence-anchors",
      category: "evidence",
      status: "warn",
      message: "This artifact contains no focused evidence, so there is nothing to re-anchor.",
    });
    return;
  }

  let changedFiles;

  try {
    changedFiles = await collectChangedFiles({
      runGit: input.runGit,
      mergeBaseSha: input.lock.git.mergeBaseSha,
      headSha: input.lock.git.headSha,
    });
  } catch (error) {
    checks.push({
      id: "evidence-anchors",
      category: "evidence",
      status: "fail",
      message: `Could not re-read the diff to re-anchor evidence: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }

  const changedFilesByPath = new Map(changedFiles.map((file) => [file.path, file]));
  let mismatches = 0;

  for (const record of input.lock.evidence) {
    try {
      const resolved = await resolveEvidence({
        runGit: input.runGit,
        chapterId: record.chapterId,
        mergeBaseSha: input.lock.git.mergeBaseSha,
        headSha: input.lock.git.headSha,
        changedFilesByPath,
        evidence: record.kind === "diff"
          ? {
              kind: "diff",
              id: record.id,
              path: record.path,
              ...(record.previousPath === undefined ? {} : { previousPath: record.previousPath }),
            }
          : {
              kind: "code",
              id: record.id,
              path: record.path,
              startLine: record.range?.startLine ?? 1,
              endLine: record.range?.endLine ?? 1,
              side: record.side ?? "head",
            },
      });

      // Diff evidence may have been narrowed by an authored range, so compare
      // provenance instead of demanding an identical rendering there.
      const matches = record.kind === "code"
        ? resolved.anchor === record.anchor
        : resolved.kind === "diff"
          && resolved.provenance.newBlobSha === record.provenance.newBlobSha
          && resolved.provenance.oldBlobSha === record.provenance.oldBlobSha;

      if (!matches) {
        mismatches += 1;
        checks.push({
          id: `evidence-anchor:${record.id}`,
          category: "evidence",
          status: "fail",
          message: `Evidence "${record.id}" no longer resolves to the recorded content in ${record.path}.`,
        });
      }
    } catch (error) {
      mismatches += 1;
      checks.push({
        id: `evidence-anchor:${record.id}`,
        category: "evidence",
        status: "fail",
        message: `Evidence "${record.id}" could not be re-resolved: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  if (mismatches === 0) {
    checks.push({
      id: "evidence-anchors",
      category: "evidence",
      status: "pass",
      message: `All ${input.lock.evidence.length} evidence anchor(s) still resolve to the recorded blobs.`,
    });
  }
}

function checkVerification(
  checks: ReviewCheck[],
  input: { lock: ReviewLock; strict: boolean },
): void {
  const { verification } = input.lock;

  if (verification.results.length === 0) {
    checks.push({
      id: "verification",
      category: "verification",
      status: input.strict ? "fail" : "warn",
      message: "The review declares no verification commands, so nothing was proven about this change.",
    });
    return;
  }

  const failing = verification.results.filter((result) => result.status !== "passed");

  checks.push({
    id: "verification",
    category: "verification",
    status: verification.status === "passed"
      ? "pass"
      : input.strict
        ? "fail"
        : "warn",
    message: verification.status === "passed"
      ? `All ${verification.results.length} verification command(s) passed when the artifact was generated.`
      : verification.ran
        ? `${failing.length} verification command(s) did not pass: ${failing.map((result) => result.label).join(", ")}.`
        : "Verification commands were declared but never executed. Regenerate with --run-verification.",
  });
}

export function countCues(captions: string): number {
  return (captions.match(/^\d{2}:\d{2}:\d{2}[.,]\d{3} --> /gm) ?? []).length;
}

function short(sha: string): string {
  return sha.slice(0, 12);
}
