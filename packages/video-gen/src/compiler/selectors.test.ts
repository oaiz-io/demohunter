import { describe, expect, test } from "bun:test";

import {
  lessonSectionSelector,
  sectionCodeBlockSelector,
  sectionHeadingSelector,
} from "./selectors.js";

describe("selectors", () => {
  test("builds stable id and data-attribute selectors", () => {
    expect(lessonSectionSelector("intro")).toBe('[data-section-id="intro"]');
    expect(sectionHeadingSelector("intro")).toBe(
      '[data-section-id="intro"] [data-section-heading="true"]',
    );
    expect(sectionCodeBlockSelector("intro")).toBe(
      '[data-section-id="intro"] [data-code-block="true"]',
    );
  });

  test("rejects unsafe section ids", () => {
    expect(() => lessonSectionSelector("../x")).toThrow();
    expect(() => sectionHeadingSelector("Bad Id")).toThrow();
  });
});
