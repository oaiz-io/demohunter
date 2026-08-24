import { createHash } from "node:crypto";

export const REVIEW_ANCHOR_ALGORITHM = "sha256";

/**
 * Content-addressed anchor for a piece of displayed evidence.
 *
 * The anchor covers both the Git provenance (blob shas) and the exact text the
 * viewer shows. `demohunter review verify` recomputes it from the repository,
 * so any drift between the artifact and the real diff is detected instead of
 * being trusted.
 */
export function createEvidenceAnchor(parts: readonly string[]): string {
  const hash = createHash(REVIEW_ANCHOR_ALGORITHM);

  for (const part of parts) {
    // Length-prefixing keeps the concatenation unambiguous, so two different
    // field splits can never hash to the same anchor.
    hash.update(`${Buffer.byteLength(part, "utf8")}:`);
    hash.update(part, "utf8");
  }

  return hash.digest("hex");
}

export function createTextDigest(text: string): string {
  return createHash(REVIEW_ANCHOR_ALGORITHM).update(text, "utf8").digest("hex");
}
