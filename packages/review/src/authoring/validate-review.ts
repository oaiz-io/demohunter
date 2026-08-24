import type { ReviewDefinition, ReviewDiagram, ReviewEvidence } from "./review-types.js";

export const REVIEW_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class ReviewDefinitionError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(
      `Invalid review definition:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`,
    );
    this.name = "ReviewDefinitionError";
    this.issues = issues;
  }
}

/**
 * Structural validation of an authored review.
 *
 * This deliberately does not touch Git. It only checks that the definition is
 * internally consistent, so that later failures are always about the diff and
 * never about a typo in the review file.
 */
export function validateReviewDefinition(review: ReviewDefinition): void {
  const issues: string[] = [];

  if (typeof review?.id !== "string" || !REVIEW_ID_PATTERN.test(review.id)) {
    issues.push('id must be a lowercase slug such as "pr-22-review"');
  }
  requireText(issues, review?.title, "title");
  requireText(issues, review?.problem?.summary, "problem.summary");

  if (!Array.isArray(review?.chapters) || review.chapters.length === 0) {
    issues.push("chapters must contain at least one change set");
  }

  const chapterIds = new Set<string>();
  const evidenceIds = new Set<string>();

  for (const [index, chapter] of (review?.chapters ?? []).entries()) {
    const label = `chapters[${index}]`;

    if (typeof chapter?.id !== "string" || !REVIEW_ID_PATTERN.test(chapter.id)) {
      issues.push(`${label}.id must be a lowercase slug`);
    } else if (chapterIds.has(chapter.id)) {
      issues.push(`${label}.id duplicates an earlier chapter id: ${chapter.id}`);
    } else {
      chapterIds.add(chapter.id);
    }

    requireText(issues, chapter?.title, `${label}.title`);
    requireText(issues, chapter?.intent, `${label}.intent`);
    requireText(issues, chapter?.narration, `${label}.narration`);

    if (!Array.isArray(chapter?.files) || chapter.files.length === 0) {
      issues.push(`${label}.files must list at least one repository-relative path`);
    } else {
      for (const [fileIndex, file] of chapter.files.entries()) {
        if (typeof file !== "string" || file.trim().length === 0) {
          issues.push(`${label}.files[${fileIndex}] must be a non-empty path`);
        }
      }
    }

    for (const [evidenceIndex, evidence] of (chapter?.evidence ?? []).entries()) {
      validateEvidence(issues, evidence, `${label}.evidence[${evidenceIndex}]`, evidenceIds);
    }

    for (const [checkIndex, check] of (chapter?.reviewerChecks ?? []).entries()) {
      requireText(issues, check?.id, `${label}.reviewerChecks[${checkIndex}].id`);
      requireText(issues, check?.check, `${label}.reviewerChecks[${checkIndex}].check`);
    }
  }

  for (const [index, entry] of (review?.reviewOrder ?? []).entries()) {
    if (!chapterIds.has(entry?.chapterId)) {
      issues.push(
        `reviewOrder[${index}].chapterId does not match any chapter id: ${String(entry?.chapterId)}`,
      );
    }
    requireText(issues, entry?.why, `reviewOrder[${index}].why`);
  }

  const diagramIds = new Set<string>();
  for (const [index, diagram] of (review?.architecture ?? []).entries()) {
    validateDiagram(issues, diagram, `architecture[${index}]`, diagramIds);
  }

  const verificationIds = new Set<string>();
  for (const [index, command] of (review?.verification ?? []).entries()) {
    const label = `verification[${index}]`;
    requireText(issues, command?.id, `${label}.id`);
    requireText(issues, command?.label, `${label}.label`);

    if (verificationIds.has(command?.id)) {
      issues.push(`${label}.id duplicates an earlier verification id: ${command.id}`);
    } else if (typeof command?.id === "string") {
      verificationIds.add(command.id);
    }

    if (!Array.isArray(command?.command) || command.command.length === 0) {
      issues.push(`${label}.command must be a non-empty argv array`);
    } else if (command.command.some((part) => typeof part !== "string" || part.length === 0)) {
      issues.push(`${label}.command entries must all be non-empty strings`);
    }

    if (
      command?.expectExitCode !== undefined
      && (!Number.isInteger(command.expectExitCode) || command.expectExitCode < 0)
    ) {
      issues.push(`${label}.expectExitCode must be a non-negative integer`);
    }

    if (
      command?.timeoutMs !== undefined
      && (!Number.isInteger(command.timeoutMs) || command.timeoutMs <= 0)
    ) {
      issues.push(`${label}.timeoutMs must be a positive integer`);
    }
  }

  for (const [index, group] of (review?.coverage?.groups ?? []).entries()) {
    const label = `coverage.groups[${index}]`;
    requireText(issues, group?.id, `${label}.id`);
    requireText(issues, group?.title, `${label}.title`);
    requireText(issues, group?.rationale, `${label}.rationale`);

    if (!Array.isArray(group?.patterns) || group.patterns.length === 0) {
      issues.push(`${label}.patterns must contain at least one glob`);
    }
  }

  for (const [index, entry] of (review?.risks ?? []).entries()) {
    const label = `risks[${index}]`;
    requireText(issues, entry?.id, `${label}.id`);
    requireText(issues, entry?.title, `${label}.title`);
    requireText(issues, entry?.detail, `${label}.detail`);

    if (entry?.severity !== "low" && entry?.severity !== "medium" && entry?.severity !== "high") {
      issues.push(`${label}.severity must be low, medium, or high`);
    }
  }

  for (const [index, entry] of (review?.compatibility ?? []).entries()) {
    const label = `compatibility[${index}]`;
    requireText(issues, entry?.id, `${label}.id`);
    requireText(issues, entry?.area, `${label}.area`);
    requireText(issues, entry?.detail, `${label}.detail`);

    if (!["none", "additive", "behavioral", "breaking"].includes(entry?.impact)) {
      issues.push(`${label}.impact must be none, additive, behavioral, or breaking`);
    }
  }

  for (const [index, entry] of (review?.reviewerQuestions ?? []).entries()) {
    requireText(issues, entry?.id, `reviewerQuestions[${index}].id`);
    requireText(issues, entry?.question, `reviewerQuestions[${index}].question`);
  }

  for (const [index, entry] of (review?.security ?? []).entries()) {
    requireText(issues, entry?.id, `security[${index}].id`);
    requireText(issues, entry?.title, `security[${index}].title`);
    requireText(issues, entry?.detail, `security[${index}].detail`);
  }

  if (issues.length > 0) {
    throw new ReviewDefinitionError(issues);
  }
}

function validateEvidence(
  issues: string[],
  evidence: ReviewEvidence,
  label: string,
  seenIds: Set<string>,
): void {
  requireText(issues, evidence?.id, `${label}.id`);

  if (typeof evidence?.id === "string") {
    if (seenIds.has(evidence.id)) {
      issues.push(`${label}.id duplicates an earlier evidence id: ${evidence.id}`);
    }
    seenIds.add(evidence.id);
  }

  requireText(issues, evidence?.path, `${label}.path`);

  if (evidence?.kind === "diff") {
    if (evidence.range !== undefined) {
      const { startLine, endLine } = evidence.range;

      if (!Number.isInteger(startLine) || startLine < 1) {
        issues.push(`${label}.range.startLine must be a positive integer`);
      }
      if (!Number.isInteger(endLine) || endLine < startLine) {
        issues.push(`${label}.range.endLine must be an integer no smaller than startLine`);
      }
    }

    if (
      evidence.contextLines !== undefined
      && (!Number.isInteger(evidence.contextLines) || evidence.contextLines < 0)
    ) {
      issues.push(`${label}.contextLines must be a non-negative integer`);
    }
    return;
  }

  if (evidence?.kind === "code") {
    if (!Number.isInteger(evidence.startLine) || evidence.startLine < 1) {
      issues.push(`${label}.startLine must be a positive integer`);
    }
    if (!Number.isInteger(evidence.endLine) || evidence.endLine < evidence.startLine) {
      issues.push(`${label}.endLine must be an integer no smaller than startLine`);
    }
    if (evidence.side !== undefined && evidence.side !== "head" && evidence.side !== "base") {
      issues.push(`${label}.side must be head or base`);
    }
    return;
  }

  issues.push(`${label}.kind must be diff or code`);
}

function validateDiagram(
  issues: string[],
  diagram: ReviewDiagram,
  label: string,
  seenIds: Set<string>,
): void {
  requireText(issues, diagram?.id, `${label}.id`);
  requireText(issues, diagram?.title, `${label}.title`);

  if (typeof diagram?.id === "string") {
    if (seenIds.has(diagram.id)) {
      issues.push(`${label}.id duplicates an earlier diagram id: ${diagram.id}`);
    }
    seenIds.add(diagram.id);
  }

  if (diagram?.kind === "sequence") {
    const participantIds = new Set<string>();

    if (!Array.isArray(diagram.participants) || diagram.participants.length < 2) {
      issues.push(`${label}.participants must contain at least two participants`);
    }

    for (const participant of diagram.participants ?? []) {
      if (participantIds.has(participant?.id)) {
        issues.push(`${label} has a duplicate participant id: ${participant.id}`);
      }
      participantIds.add(participant?.id);
    }

    if (!Array.isArray(diagram.messages) || diagram.messages.length === 0) {
      issues.push(`${label}.messages must contain at least one message`);
    }

    for (const [index, message] of (diagram.messages ?? []).entries()) {
      if (!participantIds.has(message?.from)) {
        issues.push(`${label}.messages[${index}].from is not a participant: ${String(message?.from)}`);
      }
      if (!participantIds.has(message?.to)) {
        issues.push(`${label}.messages[${index}].to is not a participant: ${String(message?.to)}`);
      }
      requireText(issues, message?.label, `${label}.messages[${index}].label`);
    }
    return;
  }

  if (diagram?.kind === "component" || diagram?.kind === "data-flow") {
    const nodeIds = new Set<string>();

    if (!Array.isArray(diagram.nodes) || diagram.nodes.length === 0) {
      issues.push(`${label}.nodes must contain at least one node`);
    }

    for (const [index, node] of (diagram.nodes ?? []).entries()) {
      if (nodeIds.has(node?.id)) {
        issues.push(`${label}.nodes[${index}].id duplicates an earlier node id: ${node.id}`);
      }
      nodeIds.add(node?.id);
      requireText(issues, node?.label, `${label}.nodes[${index}].label`);

      if (!Number.isInteger(node?.column) || node.column < 0) {
        issues.push(`${label}.nodes[${index}].column must be a non-negative integer`);
      }
      if (!Number.isInteger(node?.row) || node.row < 0) {
        issues.push(`${label}.nodes[${index}].row must be a non-negative integer`);
      }
    }

    for (const [index, edge] of (diagram.edges ?? []).entries()) {
      if (!nodeIds.has(edge?.from)) {
        issues.push(`${label}.edges[${index}].from is not a node id: ${String(edge?.from)}`);
      }
      if (!nodeIds.has(edge?.to)) {
        issues.push(`${label}.edges[${index}].to is not a node id: ${String(edge?.to)}`);
      }
    }
    return;
  }

  issues.push(`${label}.kind must be component, data-flow, or sequence`);
}

function requireText(issues: string[], value: unknown, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(`${label} must be a non-empty string`);
  }
}
