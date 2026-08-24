/**
 * Authored review shapes.
 *
 * Everything in this file is written by hand (or by an agent) into a
 * `pr.review.ts` file. Nothing here is derived from Git: derived facts live in
 * `review.lock.json` and are produced at generation time. Keeping the two
 * apart is what lets the viewer and the video be rendered from one definition
 * while still being provably grounded in the real diff.
 */

export type ReviewDiagramNodeKind =
  | "service"
  | "module"
  | "store"
  | "external"
  | "actor"
  | "artifact";

export type ReviewDiagramNode = {
  id: string;
  label: string;
  kind?: ReviewDiagramNodeKind;
  /** Short second line rendered under the label. */
  detail?: string;
  /** Authored layout: zero-based grid column. */
  column: number;
  /** Authored layout: zero-based grid row. */
  row: number;
  /** Marks a node introduced or materially changed by this pull request. */
  changed?: boolean;
};

export type ReviewDiagramEdge = {
  from: string;
  to: string;
  label?: string;
  /** Dashed rendering for optional or asynchronous relationships. */
  style?: "solid" | "dashed";
  changed?: boolean;
};

export type ReviewComponentDiagram = {
  kind: "component" | "data-flow";
  id: string;
  title: string;
  caption?: string;
  narration?: string;
  nodes: ReviewDiagramNode[];
  edges: ReviewDiagramEdge[];
};

export type ReviewSequenceParticipant = {
  id: string;
  label: string;
  detail?: string;
};

export type ReviewSequenceMessage = {
  from: string;
  to: string;
  label: string;
  /** `call` draws a solid arrow, `return` a dashed one, `note` a self box. */
  kind?: "call" | "return" | "note";
};

export type ReviewSequenceDiagram = {
  kind: "sequence";
  id: string;
  title: string;
  caption?: string;
  narration?: string;
  participants: ReviewSequenceParticipant[];
  messages: ReviewSequenceMessage[];
};

export type ReviewDiagram = ReviewComponentDiagram | ReviewSequenceDiagram;

export type ReviewDiffEvidence = {
  kind: "diff";
  id: string;
  /** Repository-relative path at HEAD. */
  path: string;
  /** Repository-relative path before a rename, when the author knows it. */
  previousPath?: string;
  title?: string;
  /** What a reviewer should look at in this diff. */
  note?: string;
  /** Restrict the rendered hunks to this post-image line range. */
  range?: { startLine: number; endLine: number };
  contextLines?: number;
};

export type ReviewCodeEvidence = {
  kind: "code";
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  /** Which side of the comparison to snapshot from. Defaults to `head`. */
  side?: "head" | "base";
  title?: string;
  note?: string;
};

export type ReviewEvidence = ReviewDiffEvidence | ReviewCodeEvidence;

export type ReviewReviewerCheck = {
  id: string;
  /** Imperative statement of what the reviewer should confirm. */
  check: string;
  detail?: string;
};

export type ReviewChangeSet = {
  id: string;
  title: string;
  /** One sentence describing what conceptually changed and why. */
  intent: string;
  detail?: string;
  /** Narration spoken while this chapter is on screen in the video. */
  narration: string;
  /** Repository-relative paths this chapter explains. */
  files: string[];
  evidence: ReviewEvidence[];
  reviewerChecks: ReviewReviewerCheck[];
};

export type ReviewVerificationCommand = {
  id: string;
  label: string;
  /** Argv form so no shell quoting or shell injection is involved. */
  command: string[];
  cwd?: string;
  expectExitCode?: number;
  /** Why this command is meaningful evidence for the change. */
  rationale?: string;
  timeoutMs?: number;
};

export type ReviewRiskSeverity = "low" | "medium" | "high";

export type ReviewRisk = {
  id: string;
  title: string;
  severity: ReviewRiskSeverity;
  detail: string;
  mitigation?: string;
};

export type ReviewCompatibilityImpact = "none" | "additive" | "behavioral" | "breaking";

export type ReviewCompatibilityNote = {
  id: string;
  area: string;
  impact: ReviewCompatibilityImpact;
  detail: string;
  migration?: string;
};

export type ReviewSecurityNote = {
  id: string;
  title: string;
  detail: string;
  /** Where the control is implemented, for cross-referencing the diff. */
  control?: string;
};

export type ReviewQuestion = {
  id: string;
  question: string;
  context?: string;
};

export type ReviewCoverageGroup = {
  id: string;
  title: string;
  /** Why grouping these files is enough for a reviewer. */
  rationale: string;
  /** Glob patterns matched against repository-relative HEAD paths. */
  patterns: string[];
};

export type ReviewOrderEntry = {
  /** Id of a chapter in `chapters`. */
  chapterId: string;
  why: string;
};

export type ReviewDecision = {
  id: string;
  title: string;
  rationale: string;
  alternatives?: string[];
};

export type ReviewProblem = {
  /** One-sentence statement of the problem the pull request solves. */
  summary: string;
  detail?: string;
  /** Narration spoken over the problem section of the video. */
  narration?: string;
  inScope?: string[];
  outOfScope?: string[];
};

export type ReviewDefinition = {
  /** Filesystem-safe slug. Also the output directory and tour id. */
  id: string;
  title: string;
  subtitle?: string;
  pullRequest?: {
    number?: number;
    url?: string;
    author?: string;
    branch?: string;
  };
  problem: ReviewProblem;
  goals?: string[];
  nonGoals?: string[];
  decisions?: ReviewDecision[];
  architecture?: ReviewDiagram[];
  /** Recommended reading order across the authored chapters. */
  reviewOrder?: ReviewOrderEntry[];
  chapters: ReviewChangeSet[];
  verification?: ReviewVerificationCommand[];
  risks?: ReviewRisk[];
  compatibility?: ReviewCompatibilityNote[];
  security?: ReviewSecurityNote[];
  reviewerQuestions?: ReviewQuestion[];
  coverage?: {
    groups?: ReviewCoverageGroup[];
    /** Extra generated-file globs on top of the built-in list. */
    generatedPatterns?: string[];
  };
  narration?: {
    opening?: string;
    closing?: string;
  };
};
