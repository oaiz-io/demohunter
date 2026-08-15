import { isValidTourId } from "../util/slug.js";

export function lessonSectionSelector(sectionId: string): string {
  assertSafeSectionId(sectionId);
  return `[data-section-id="${sectionId}"]`;
}

export function sectionHeadingSelector(sectionId: string): string {
  assertSafeSectionId(sectionId);
  return `[data-section-id="${sectionId}"] [data-section-heading="true"]`;
}

export function sectionCodeBlockSelector(sectionId: string): string {
  assertSafeSectionId(sectionId);
  return `[data-section-id="${sectionId}"] [data-code-block="true"]`;
}

function assertSafeSectionId(sectionId: string): void {
  if (!isValidTourId(sectionId)) {
    throw new Error(`Unsafe section id for selector construction: ${sectionId}`);
  }
}
