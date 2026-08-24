import { describe, expect, test } from "bun:test";

import { makeReviewDefinition, makeViewModel } from "../test-support/view-model-fixture.ts";
import { listReviewSections, orderedChapters } from "./view-model.js";

describe("listReviewSections", () => {
  test("lists only the sections the review actually has", () => {
    const model = makeViewModel({
      review: makeReviewDefinition({
        architecture: [],
        reviewOrder: [],
        risks: [],
        compatibility: [],
        security: [],
        reviewerQuestions: [],
      }),
      verification: { status: "not-run", ran: false, results: [] },
    });

    expect(listReviewSections(model).map((section) => section.id)).toEqual([
      "overview",
      "chapter-core",
      "coverage",
    ]);
  });

  test("adds architecture whenever the review authored a diagram", () => {
    // The walkthrough reads its chapters from this list, so gating the section
    // on anything other than the authored review is how the video loses it.
    expect(listReviewSections(makeViewModel()).map((section) => section.id)).toContain("architecture");

    const withoutDiagrams = makeViewModel({
      review: makeReviewDefinition({ architecture: [] }),
    });

    expect(listReviewSections(withoutDiagrams).map((section) => section.id)).not.toContain(
      "architecture",
    );
  });

  test("appends the walkthrough only once a video exists", () => {
    expect(listReviewSections(makeViewModel()).at(-1)?.id).toBe("coverage");

    const withVideo = makeViewModel({
      video: { video: "video.mp4", poster: "poster.jpg", captionsVtt: "captions.vtt", durationMs: 1, chapters: [] },
    });

    expect(listReviewSections(withVideo).at(-1)).toEqual({
      id: "walkthrough",
      title: "Narrated walkthrough",
      kind: "walkthrough",
    });
  });

  test("keeps coverage last among the evidence sections so the accounting closes the review", () => {
    const ids = listReviewSections(makeViewModel()).map((section) => section.id);

    expect(ids.indexOf("coverage")).toBeGreaterThan(ids.indexOf("questions"));
    expect(ids.indexOf("verification")).toBeGreaterThan(ids.indexOf("chapter-core"));
  });
});

describe("orderedChapters", () => {
  test("follows the authored review order", () => {
    const review = makeReviewDefinition({
      chapters: [chapter("b"), chapter("a"), chapter("c")],
      reviewOrder: [
        { chapterId: "c", why: "first" },
        { chapterId: "a", why: "second" },
      ],
    });

    expect(orderedChapters(makeViewModel({ review })).map((entry) => entry.id)).toEqual(["c", "a", "b"]);
  });

  test("ignores a review-order entry that names an unknown chapter", () => {
    const review = makeReviewDefinition({
      chapters: [chapter("a")],
      reviewOrder: [{ chapterId: "ghost", why: "nope" }],
    });

    expect(orderedChapters(makeViewModel({ review })).map((entry) => entry.id)).toEqual(["a"]);
  });

  test("never repeats a chapter listed twice in the order", () => {
    const review = makeReviewDefinition({
      chapters: [chapter("a"), chapter("b")],
      reviewOrder: [
        { chapterId: "a", why: "first" },
        { chapterId: "a", why: "again" },
      ],
    });

    expect(orderedChapters(makeViewModel({ review })).map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

function chapter(id: string) {
  return {
    id,
    title: `Chapter ${id}`,
    intent: "intent",
    narration: "narration",
    files: ["src/app.ts"],
    evidence: [],
    reviewerChecks: [],
  };
}
