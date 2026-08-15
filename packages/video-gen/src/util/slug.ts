const TOUR_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 64;
const FALLBACK_SLUG = "lesson";

/**
 * Normalize a title or free-form label into a DemoHunter-safe slug.
 * Matches /^[a-z0-9]+(?:-[a-z0-9]+)*$/ after normalization.
 */
export function slugify(input: string, fallback = FALLBACK_SLUG): string {
  const normalized = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-$/g, "");

  if (normalized.length === 0 || !TOUR_ID_PATTERN.test(normalized)) {
    return fallback;
  }

  return normalized;
}

export function isValidTourId(value: string): boolean {
  return TOUR_ID_PATTERN.test(value);
}

export { TOUR_ID_PATTERN };
