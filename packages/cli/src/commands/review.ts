import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createGitRunner,
  generateReview,
  REVIEWS_DIRECTORY_NAME,
  scaffoldReview,
  serveReview,
  verifyReviewArtifact,
  type GenerateReviewProgressEvent,
  type ReviewCheck,
  type ReviewDefinition,
  type VerifyReviewArtifactResult,
} from "@demohunter/review";

import { loadConfig } from "../config/load-config.js";
import { loadAuthoredModule } from "../utils/load-authored-module.js";
import { readPackageVersion } from "../utils/read-package-version.js";

export const DEFAULT_REVIEW_DIRECTORY = "reviews";

export type ReviewInitOptions = {
  baseRef: string;
  headRef?: string;
  id?: string;
  outputPath?: string;
  force?: boolean;
};

export type ReviewGenerateOptions = {
  baseRef: string;
  headRef?: string;
  runVerification?: boolean;
  allowDirty?: boolean;
  skipVideo?: boolean;
};

export type ReviewServeOptions = {
  port?: number;
  open?: boolean;
};

export type ReviewVerifyOptions = {
  strict?: boolean;
};

type ReviewDependencies = {
  loadConfig: typeof loadConfig;
  importModule: (modulePath: string) => Promise<{ default: unknown }>;
  log: (message: string) => void;
  generateReview: typeof generateReview;
  serveReview: typeof serveReview;
  verifyReviewArtifact: typeof verifyReviewArtifact;
  scaffoldReview: typeof scaffoldReview;
  openUrl: (url: string) => Promise<void>;
  waitForShutdown: () => Promise<void>;
};

const defaultDependencies: ReviewDependencies = {
  loadConfig,
  importModule: loadAuthoredModule,
  log: console.log,
  generateReview,
  serveReview,
  verifyReviewArtifact,
  scaffoldReview,
  openUrl: openInBrowser,
  waitForShutdown: waitForInterrupt,
};

/**
 * Scaffolds a `*.review.ts` grounded in the real `merge-base(base, HEAD)..HEAD`
 * diff, so the author starts from the true changed-file set instead of from
 * memory.
 */
export async function reviewInitCommand(
  cwd: string,
  options: ReviewInitOptions,
  dependencies: Partial<ReviewDependencies> = {},
): Promise<void> {
  const resolved = { ...defaultDependencies, ...dependencies };
  const scaffold = await resolved.scaffoldReview({
    runGit: createGitRunner(cwd),
    baseRef: options.baseRef,
    ...(options.headRef === undefined ? {} : { headRef: options.headRef }),
    ...(options.id === undefined ? {} : { id: options.id }),
  });
  const outputPath = path.resolve(
    cwd,
    options.outputPath ?? path.join(DEFAULT_REVIEW_DIRECTORY, `${scaffold.id}.review.ts`),
  );

  if (options.force !== true && (await pathExists(outputPath))) {
    throw new Error(
      `${path.relative(cwd, outputPath)} already exists. Pass --force to overwrite it.`,
    );
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, scaffold.contents, "utf8");

  resolved.log(`Scaffolded ${path.relative(cwd, outputPath)}`);
  resolved.log(
    `Range: ${scaffold.comparison.baseRef} (merge base ${short(scaffold.comparison.mergeBaseSha)})`
      + ` -> ${scaffold.comparison.headRef} (${short(scaffold.comparison.headSha)})`,
  );
  resolved.log(`Changed files: ${scaffold.changedFiles.length}`);
  resolved.log("");
  resolved.log("Next:");
  resolved.log("  1. Read the diff and replace every TODO with something you verified.");
  resolved.log("  2. Account for every changed file in a chapter or a coverage group.");
  resolved.log(
    `  3. demohunter review generate ${path.relative(cwd, outputPath)} --base ${options.baseRef} --run-verification`,
  );
}

/** Builds the local review website plus the narrated walkthrough. */
export async function reviewGenerateCommand(
  cwd: string,
  reviewPath: string,
  options: ReviewGenerateOptions,
  dependencies: Partial<ReviewDependencies> = {},
): Promise<void> {
  const resolved = { ...defaultDependencies, ...dependencies };
  const resolvedReviewPath = path.resolve(cwd, reviewPath);
  const loadedConfig = await resolved.loadConfig(cwd);
  const reviewModule = await resolved.importModule(resolvedReviewPath);
  const review = readReviewDefaultExport(reviewModule.default, resolvedReviewPath);

  const result = await resolved.generateReview({
    review,
    sourcePath: toPosix(path.relative(loadedConfig.projectRoot, resolvedReviewPath)),
    cwd,
    baseRef: options.baseRef,
    ...(options.headRef === undefined ? {} : { headRef: options.headRef }),
    config: loadedConfig.config,
    generatorVersion: readPackageVersion(),
    runVerificationCommands: options.runVerification === true,
    allowDirtyWorktree: options.allowDirty === true,
    skipVideo: options.skipVideo === true,
    onProgress: (event: GenerateReviewProgressEvent) => {
      resolved.log(`[${event.phase}] ${event.message}`);
    },
  });

  resolved.log("");
  resolved.log(`Review artifact: ${result.reviewDir}`);
  resolved.log(`Website:         ${result.indexPath}`);
  resolved.log(`Walkthrough:     ${result.videoPath ?? "not recorded (--no-video)"}`);
  resolved.log(
    `Coverage:        ${result.lock.coverage.accountedCount}/${result.lock.coverage.totalCount} changed files`,
  );
  resolved.log(`Verification:    ${result.lock.verification.status}`);
  resolved.log(
    `Range:           ${result.lock.git.baseRef} (merge base ${short(result.lock.git.mergeBaseSha)})`
      + ` -> ${result.lock.git.headRef} (${short(result.lock.git.headSha)})`,
  );
  resolved.log("");
  resolved.log(`Serve it with: demohunter review serve ${path.relative(cwd, result.reviewDir)} --open`);
}

/** Serves one generated review directory on loopback only. */
export async function reviewServeCommand(
  cwd: string,
  reviewDir: string,
  options: ReviewServeOptions,
  dependencies: Partial<ReviewDependencies> = {},
): Promise<void> {
  const resolved = { ...defaultDependencies, ...dependencies };
  const root = await resolveReviewDir(cwd, reviewDir);
  const server = await resolved.serveReview({
    root,
    ...(options.port === undefined ? {} : { port: options.port }),
  });

  resolved.log(`Serving ${root}`);
  resolved.log(`  ${server.baseUrl}`);
  resolved.log("Bound to 127.0.0.1 only. Press Ctrl+C to stop.");

  if (options.open === true) {
    await resolved.openUrl(server.baseUrl);
  }

  try {
    await resolved.waitForShutdown();
  } finally {
    await server.close();
  }
}

/**
 * Re-derives everything a review artifact claims and reports the result.
 *
 * Returns the structured result so callers (and tests) can assert on the
 * individual checks instead of scraping stdout.
 */
export async function reviewVerifyCommand(
  cwd: string,
  reviewDir: string,
  options: ReviewVerifyOptions,
  dependencies: Partial<ReviewDependencies> = {},
): Promise<VerifyReviewArtifactResult> {
  const resolved = { ...defaultDependencies, ...dependencies };
  const root = await resolveReviewDir(cwd, reviewDir);
  const result = await resolved.verifyReviewArtifact({
    reviewDir: root,
    cwd,
    strict: options.strict === true,
  });

  for (const check of result.checks) {
    resolved.log(`${statusMarker(check)} ${check.category.padEnd(12)} ${check.message}`);
  }

  resolved.log("");
  resolved.log(
    result.ok
      ? `Review artifact verified${result.strict ? " in strict mode" : ""}: ${root}`
      : `Review artifact failed verification (${result.failedCategory}): ${root}`,
  );

  if (!result.ok) {
    throw new ReviewVerificationFailedError(result);
  }

  return result;
}

export class ReviewVerificationFailedError extends Error {
  readonly result: VerifyReviewArtifactResult;

  constructor(result: VerifyReviewArtifactResult) {
    super(
      `Review artifact at ${result.reviewDir} failed verification `
        + `(first failing category: ${result.failedCategory ?? "unknown"}). `
        + "Regenerate it against the current HEAD.",
    );
    this.name = "ReviewVerificationFailedError";
    this.result = result;
  }
}

/**
 * Accepts either a review directory or a review id, so `serve <id>` works from
 * the project root without spelling out `.demohunter/reviews/<id>`.
 */
export async function resolveReviewDir(cwd: string, reviewDir: string): Promise<string> {
  const direct = path.resolve(cwd, reviewDir);

  if (await pathExists(path.join(direct, "review.lock.json"))) {
    return direct;
  }

  const byId = path.resolve(cwd, ".demohunter", REVIEWS_DIRECTORY_NAME, reviewDir);

  if (await pathExists(path.join(byId, "review.lock.json"))) {
    return byId;
  }

  throw new Error(
    `Could not find a review artifact at ${reviewDir}. `
      + "Pass the directory printed by \"demohunter review generate\", or the review id.",
  );
}

export function readReviewDefaultExport(value: unknown, reviewPath: string): ReviewDefinition {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || typeof (value as ReviewDefinition).id !== "string"
    || !Array.isArray((value as ReviewDefinition).chapters)
  ) {
    throw new Error(
      `Review file must default export defineReview({ ... }): ${reviewPath}`,
    );
  }

  return value as ReviewDefinition;
}

function statusMarker(check: ReviewCheck): string {
  switch (check.status) {
    case "pass":
      return "PASS";
    case "fail":
      return "FAIL";
    case "warn":
      return "WARN";
    default:
      return "SKIP";
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

async function openInBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  // Argv form: the URL is never interpolated into a shell string.
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];

  await new Promise<void>((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => resolve());
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function waitForInterrupt(): Promise<void> {
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };

    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
