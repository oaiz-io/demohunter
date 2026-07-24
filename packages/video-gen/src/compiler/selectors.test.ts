import { describe, expect, test } from "bun:test";

import {
  activeSlideSelector,
  nextNavSelector,
  slideCodeBlockSelector,
  slideHeadingSelector,
  slideSectionSelector,
} from "./selectors.js";

describe("selectors", () => {
  test("builds stable id and data-attribute selectors", () => {
    expect(slideSectionSelector("intro")).toBe("#slide-intro");
    expect(activeSlideSelector("intro")).toBe('#slide-intro[data-active="true"]');
    expect(slideHeadingSelector("intro")).toBe('#slide-intro [data-slide-heading="true"]');
    expect(slideCodeBlockSelector("intro")).toBe('#slide-intro [data-code-block="true"]');
    expect(nextNavSelector()).toBe('[data-nav="next"]');
  });

  test("rejects unsafe slide ids", () => {
    expect(() => slideSectionSelector("../x")).toThrow();
    expect(() => activeSlideSelector("Bad Id")).toThrow();
  });
});
