/**
 * Authoring-only surface for `*.review.ts` files.
 *
 * This module is deliberately free of Node built-ins, Git access, and
 * Playwright so the published `demohunter` package can re-export it from its
 * library entrypoint without dragging the whole generation pipeline into a
 * consumer's bundle.
 */

export {
  changeSet,
  codeEvidence,
  compatibilityNote,
  componentDiagram,
  coverageGroup,
  dataFlowDiagram,
  defineReview,
  diffEvidence,
  reviewerQuestion,
  risk,
  securityNote,
  sequenceDiagram,
  verificationCommand,
} from "./define-review.js";
export {
  REVIEW_ID_PATTERN,
  ReviewDefinitionError,
  validateReviewDefinition,
} from "./validate-review.js";
export type {
  ReviewChangeSet,
  ReviewCodeEvidence,
  ReviewCompatibilityImpact,
  ReviewCompatibilityNote,
  ReviewComponentDiagram,
  ReviewCoverageGroup,
  ReviewDecision,
  ReviewDefinition,
  ReviewDiagram,
  ReviewDiagramEdge,
  ReviewDiagramNode,
  ReviewDiagramNodeKind,
  ReviewDiffEvidence,
  ReviewEvidence,
  ReviewOrderEntry,
  ReviewProblem,
  ReviewQuestion,
  ReviewReviewerCheck,
  ReviewRisk,
  ReviewRiskSeverity,
  ReviewSecurityNote,
  ReviewSequenceDiagram,
  ReviewSequenceMessage,
  ReviewSequenceParticipant,
  ReviewVerificationCommand,
} from "./review-types.js";
