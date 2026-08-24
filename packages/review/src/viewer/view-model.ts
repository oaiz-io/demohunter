import type { ReviewDefinition } from "../authoring/review-types.js";
import type { ReviewCoverage } from "../coverage/compute-coverage.js";
import type { ResolvedEvidence } from "../evidence/resolve-evidence.js";
import type { ChangedFile, GitComparison, WorktreeStatus } from "../git/git-types.js";
import type { VerificationReport } from "../verification/run-verification.js";
import type { RenderedDiagram } from "./diagrams.js";

export type ReviewVideoView = {
  video: string;
  poster: string;
  captionsVtt: string;
  durationMs: number;
  chapters: Array<{ title: string; startMs: number }>;
};

/**
 * Everything the viewer and the narrated walkthrough render from.
 *
 * Both outputs consume this one structure, which is why the website and the
 * video can never drift apart: they are two projections of the same authored
 * review plus the same Git-derived evidence.
 */
export type ReviewViewModel = {
  generatedAt: string;
  generatorVersion: string;
  review: ReviewDefinition;
  git: GitComparison & { worktree: WorktreeStatus };
  files: ChangedFile[];
  coverage: ReviewCoverage;
  evidenceByChapter: Record<string, ResolvedEvidence[]>;
  diagrams: RenderedDiagram[];
  verification: VerificationReport;
  /** Null during the recording pass, populated once the video exists. */
  video: ReviewVideoView | null;
};

export type ReviewSection = {
  id: string;
  title: string;
  kind:
    | "overview"
    | "architecture"
    | "review-order"
    | "chapter"
    | "verification"
    | "risks"
    | "compatibility"
    | "security"
    | "questions"
    | "coverage"
    | "walkthrough";
};

/** Ordered navigation model, shared by the viewer nav and the video chapters. */
export function listReviewSections(model: ReviewViewModel): ReviewSection[] {
  const sections: ReviewSection[] = [
    { id: "overview", title: "Problem and scope", kind: "overview" },
  ];

  if (model.diagrams.length > 0) {
    sections.push({ id: "architecture", title: "Architecture", kind: "architecture" });
  }

  if ((model.review.reviewOrder ?? []).length > 0) {
    sections.push({ id: "review-order", title: "Recommended review order", kind: "review-order" });
  }

  for (const chapter of orderedChapters(model)) {
    sections.push({ id: `chapter-${chapter.id}`, title: chapter.title, kind: "chapter" });
  }

  if (model.verification.results.length > 0) {
    sections.push({ id: "verification", title: "Verification", kind: "verification" });
  }
  if ((model.review.risks ?? []).length > 0) {
    sections.push({ id: "risks", title: "Risks", kind: "risks" });
  }
  if ((model.review.compatibility ?? []).length > 0) {
    sections.push({ id: "compatibility", title: "Compatibility", kind: "compatibility" });
  }
  if ((model.review.security ?? []).length > 0) {
    sections.push({ id: "security", title: "Security", kind: "security" });
  }
  if ((model.review.reviewerQuestions ?? []).length > 0) {
    sections.push({ id: "questions", title: "Reviewer questions", kind: "questions" });
  }

  sections.push({ id: "coverage", title: "Changed-file coverage", kind: "coverage" });

  if (model.video !== null) {
    sections.push({ id: "walkthrough", title: "Narrated walkthrough", kind: "walkthrough" });
  }

  return sections;
}

/** Chapters in the authored review order, with any unlisted chapters appended. */
export function orderedChapters(model: ReviewViewModel): ReviewDefinition["chapters"] {
  const byId = new Map(model.review.chapters.map((chapter) => [chapter.id, chapter]));
  const ordered: ReviewDefinition["chapters"] = [];
  const seen = new Set<string>();

  for (const entry of model.review.reviewOrder ?? []) {
    const chapter = byId.get(entry.chapterId);

    if (chapter !== undefined && !seen.has(chapter.id)) {
      ordered.push(chapter);
      seen.add(chapter.id);
    }
  }

  for (const chapter of model.review.chapters) {
    if (!seen.has(chapter.id)) {
      ordered.push(chapter);
      seen.add(chapter.id);
    }
  }

  return ordered;
}
