// The authoring surface is re-exported verbatim so `demohunter` can publish it
// without pulling Git, Playwright, or the HTTP server into a consumer bundle.
export * from "./authoring/index.js";

export {
  assertCoverageComplete,
  computeCoverage,
  ReviewCoverageError,
} from "./coverage/compute-coverage.js";
export type { CoverageAssignment, ReviewCoverage } from "./coverage/compute-coverage.js";

export { createEvidenceAnchor, createTextDigest, REVIEW_ANCHOR_ALGORITHM } from "./evidence/anchors.js";
export { renderHunks, resolveEvidence, ReviewEvidenceError } from "./evidence/resolve-evidence.js";
export type {
  ResolvedCodeEvidence,
  ResolvedDiffEvidence,
  ResolvedEvidence,
} from "./evidence/resolve-evidence.js";

export {
  collectChangedFiles,
  compileGlob,
  createGeneratedMatcher,
  DEFAULT_GENERATED_PATTERNS,
  parseNumstat,
  parseRawDiff,
} from "./git/collect-changed-files.js";
export {
  collectFileDiff,
  DEFAULT_DIFF_CONTEXT_LINES,
  parseUnifiedDiff,
  selectHunksForRange,
} from "./git/collect-hunks.js";
export { blobExists, readBlob, readBlobAtCommit } from "./git/read-blob.js";
export { resolveComparison } from "./git/resolve-comparison.js";
export { createGitRunner, GitCommandError, splitNulFields } from "./git/run-git.js";
export type { RunGit, RunGitOptions } from "./git/run-git.js";
export {
  describeWorktreeStatus,
  parsePorcelainStatus,
  readWorktreeStatus,
} from "./git/worktree-status.js";
export type {
  ChangedFile,
  ChangedFileStatus,
  DiffHunk,
  DiffHunkLine,
  FileDiff,
  GitComparison,
  WorktreeStatus,
} from "./git/git-types.js";

export {
  parseReviewLock,
  REVIEW_LOCK_FILE_NAME,
  REVIEW_LOCK_VERSION,
  reviewLockSchema,
  serializeReviewLock,
} from "./lock/review-lock.js";
export type { ReviewLock, ReviewLockArtifact, ReviewLockEvidence } from "./lock/review-lock.js";
export { detectStaleness } from "./lock/staleness.js";
export type { StalenessReason, StalenessReport } from "./lock/staleness.js";

export {
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  runVerification,
  truncateTail,
  VERIFICATION_OUTPUT_TAIL_BYTES,
} from "./verification/run-verification.js";
export type {
  RunCommand,
  VerificationReport,
  VerificationResult,
  VerificationStatus,
} from "./verification/run-verification.js";

export { renderComponentDiagram, renderDiagram, renderSequenceDiagram } from "./viewer/diagrams.js";
export type { RenderedDiagram } from "./viewer/diagrams.js";
export {
  escapeHtml,
  renderViewer,
  VIEWER_CSP,
  VIEWER_DATA_FILE,
  VIEWER_INDEX_FILE,
} from "./viewer/render-viewer.js";
export type { RenderedViewerFile } from "./viewer/render-viewer.js";
export { listReviewSections, orderedChapters } from "./viewer/view-model.js";
export type { ReviewSection, ReviewVideoView, ReviewViewModel } from "./viewer/view-model.js";
export { VIEWER_CSS, VIEWER_JS } from "./viewer/viewer-assets.js";

export {
  decodeRequestPath,
  isLoopbackHost,
  parseRangeHeader,
  resolveRequestPath,
  REVIEW_SERVER_HOST,
  serveReview,
} from "./server/serve-review.js";
export type { ReviewServer, ServeReviewOptions } from "./server/serve-review.js";

export { buildNarrationSegments, compileReviewTour } from "./video/compile-review-tour.js";
export type { CompiledReviewTour } from "./video/compile-review-tour.js";

export {
  createDefinitionDigest,
  ensureReviewsRootIgnored,
  generateReview,
  REVIEWS_DIRECTORY_NAME,
  ReviewWorktreeError,
  toWalkthroughConfig,
} from "./generate/generate-review.js";
export type {
  GenerateReviewDependencies,
  GenerateReviewInput,
  GenerateReviewProgressEvent,
  GenerateReviewResult,
} from "./generate/generate-review.js";

export { deriveReviewId, groupChangedFiles, scaffoldReview } from "./scaffold/scaffold-review.js";
export type { ScaffoldReviewInput, ScaffoldReviewResult } from "./scaffold/scaffold-review.js";

export { probeReviewMedia } from "./checks/probe-media.js";
export type { ProbeMediaRunner, ReviewMediaProbe } from "./checks/probe-media.js";
export { countCues, REVIEW_CHECK_CATEGORIES, verifyReviewArtifact } from "./checks/verify-artifact.js";
export type {
  ReviewCheck,
  ReviewCheckCategory,
  ReviewCheckStatus,
  VerifyReviewArtifactDependencies,
  VerifyReviewArtifactInput,
  VerifyReviewArtifactResult,
} from "./checks/verify-artifact.js";
