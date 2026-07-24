import { describe, expect, test } from "bun:test";

import { isValidTourId, slugify } from "./slug.js";

describe("slugify", () => {
  test("normalizes titles into stable tour ids", () => {
    expect(slugify("What is a Binary Tree?")).toBe("what-is-a-binary-tree");
    expect(slugify("How does DNS work?")).toBe("how-does-dns-work");
    expect(slugify("  Hello---World  ")).toBe("hello-world");
  });

  test("handles empty and non-ascii input with a deterministic fallback", () => {
    expect(slugify("")).toBe("lesson");
    expect(slugify("!!!")).toBe("lesson");
    expect(slugify("Café résumé")).toBe("cafe-resume");
  });

  test("validates tour id pattern", () => {
    expect(isValidTourId("binary-tree")).toBe(true);
    expect(isValidTourId("Binary")).toBe(false);
    expect(isValidTourId("-bad")).toBe(false);
  });
});
