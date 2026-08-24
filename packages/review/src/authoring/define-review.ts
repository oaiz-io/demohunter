import type {
  ReviewChangeSet,
  ReviewCodeEvidence,
  ReviewComponentDiagram,
  ReviewCompatibilityNote,
  ReviewCoverageGroup,
  ReviewDefinition,
  ReviewDiffEvidence,
  ReviewQuestion,
  ReviewRisk,
  ReviewSecurityNote,
  ReviewSequenceDiagram,
  ReviewVerificationCommand,
} from "./review-types.js";
import { validateReviewDefinition } from "./validate-review.js";

/**
 * Entry point for `pr.review.ts` files.
 *
 * Validation runs here, at authoring time, so a malformed review fails while
 * the agent still has the file open instead of halfway through a recording.
 */
export function defineReview<T extends ReviewDefinition>(review: T): T {
  validateReviewDefinition(review);
  return review;
}

export function componentDiagram(
  input: Omit<ReviewComponentDiagram, "kind">,
): ReviewComponentDiagram {
  return { kind: "component", ...input };
}

/** A component diagram rendered with flow-oriented styling. */
export function dataFlowDiagram(
  input: Omit<ReviewComponentDiagram, "kind">,
): ReviewComponentDiagram {
  return { kind: "data-flow", ...input };
}

export function sequenceDiagram(
  input: Omit<ReviewSequenceDiagram, "kind">,
): ReviewSequenceDiagram {
  return { kind: "sequence", ...input };
}

export function changeSet(input: ReviewChangeSet): ReviewChangeSet {
  return input;
}

export function diffEvidence(input: Omit<ReviewDiffEvidence, "kind">): ReviewDiffEvidence {
  return { kind: "diff", ...input };
}

export function codeEvidence(input: Omit<ReviewCodeEvidence, "kind">): ReviewCodeEvidence {
  return { kind: "code", ...input };
}

export function verificationCommand(input: ReviewVerificationCommand): ReviewVerificationCommand {
  return input;
}

export function risk(input: ReviewRisk): ReviewRisk {
  return input;
}

export function compatibilityNote(input: ReviewCompatibilityNote): ReviewCompatibilityNote {
  return input;
}

export function securityNote(input: ReviewSecurityNote): ReviewSecurityNote {
  return input;
}

export function reviewerQuestion(input: ReviewQuestion): ReviewQuestion {
  return input;
}

export function coverageGroup(input: ReviewCoverageGroup): ReviewCoverageGroup {
  return input;
}
