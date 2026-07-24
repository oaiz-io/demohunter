import { isValidTourId } from "../util/slug.js";

export function slideSectionSelector(slideId: string): string {
  assertSafeSlideId(slideId);
  return `#slide-${slideId}`;
}

export function activeSlideSelector(slideId: string): string {
  assertSafeSlideId(slideId);
  return `#slide-${slideId}[data-active="true"]`;
}

export function slideHeadingSelector(slideId: string): string {
  assertSafeSlideId(slideId);
  return `#slide-${slideId} [data-slide-heading="true"]`;
}

export function slideCodeBlockSelector(slideId: string): string {
  assertSafeSlideId(slideId);
  return `#slide-${slideId} [data-code-block="true"]`;
}

export function nextNavSelector(): string {
  return '[data-nav="next"]';
}

export function prevNavSelector(): string {
  return '[data-nav="prev"]';
}

function assertSafeSlideId(slideId: string): void {
  if (!isValidTourId(slideId)) {
    throw new Error(`Unsafe slide id for selector construction: ${slideId}`);
  }
}
