import type { ContentSpec, SlideSpec } from "../content/schema.js";
import { ContentSpecSchema } from "../content/schema.js";
import { isValidTourId } from "./slug.js";

export type ValidationIssue = {
  path: string;
  message: string;
};

export class ContentValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(formatValidationIssues(issues));
    this.name = "ContentValidationError";
    this.issues = issues;
  }
}

export function formatValidationIssues(issues: ValidationIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
}

/**
 * Application-level semantic checks that complement the Zod schema.
 */
export function validateContentSpec(input: ContentSpec): ContentSpec {
  const parsed = ContentSpecSchema.safeParse(input);
  if (!parsed.success) {
    throw new ContentValidationError(
      parsed.error.issues.map((issue) => ({
        path: issue.path.length === 0 ? "(root)" : issue.path.join("."),
        message: issue.message,
      })),
    );
  }

  const issues: ValidationIssue[] = [];
  const seenIds = new Set<string>();

  for (const [index, slide] of parsed.data.slides.entries()) {
    collectSlideIssues(slide, index, seenIds, issues);
  }

  if (issues.length > 0) {
    throw new ContentValidationError(issues);
  }

  return parsed.data;
}

function collectSlideIssues(
  slide: SlideSpec,
  index: number,
  seenIds: Set<string>,
  issues: ValidationIssue[],
): void {
  const base = `slides[${index}]`;

  if (seenIds.has(slide.id)) {
    issues.push({ path: `${base}.id`, message: `duplicate slide id "${slide.id}"` });
  } else {
    seenIds.add(slide.id);
  }

  if (!isValidTourId(slide.id)) {
    issues.push({
      path: `${base}.id`,
      message: "must be a lowercase filesystem-safe slug",
    });
  }

  if (slide.id.includes("--") || slide.id.startsWith("-") || slide.id.endsWith("-")) {
    issues.push({
      path: `${base}.id`,
      message: "ambiguous or unsafe selector slug",
    });
  }

  let bodyChars = 0;
  for (const [bodyIndex, element] of slide.body.entries()) {
    switch (element.type) {
      case "paragraph":
        bodyChars += element.text.length;
        break;
      case "bullet_list":
        bodyChars += element.items.join(" ").length;
        break;
      case "code_block":
        bodyChars += element.code.length;
        if (element.language.includes("<") || element.language.includes(">")) {
          issues.push({
            path: `${base}.body[${bodyIndex}].language`,
            message: "language must not contain HTML-like characters",
          });
        }
        break;
      default: {
        const _exhaustive: never = element;
        issues.push({
          path: `${base}.body[${bodyIndex}]`,
          message: `unrecognized body variant: ${JSON.stringify(_exhaustive)}`,
        });
      }
    }
  }

  if (bodyChars > 6_000) {
    issues.push({
      path: `${base}.body`,
      message: "combined body text exceeds the Phase 1 size bound",
    });
  }
}
