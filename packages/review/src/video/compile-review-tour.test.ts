import { describe, expect, test } from "bun:test";

import { makeReviewDefinition, makeViewModel } from "../test-support/view-model-fixture.ts";
import { buildNarrationSegments, compileReviewTour, pluralize } from "./compile-review-tour.js";

function fullModel() {
  return makeViewModel({ review: makeReviewDefinition() });
}

describe("buildNarrationSegments", () => {
  test("produces one segment per review section, in order, and skips the walkthrough", () => {
    const segments = buildNarrationSegments(fullModel());

    expect(segments.map((segment) => segment.sectionId)).toEqual([
      "overview",
      "architecture",
      "review-order",
      "chapter-core",
      "verification",
      "risks",
      "compatibility",
      "security",
      "questions",
      "coverage",
    ]);
    expect(segments.every((segment) => segment.narration.length > 0)).toBe(true);
  });

  test("opens with the authored line and states the real range and file count", () => {
    const withoutOpening = makeViewModel({
      review: makeReviewDefinition({ narration: { closing: "Done." } }),
    });
    const [overview] = buildNarrationSegments(withoutOpening);

    expect(overview?.narration[0]).toContain("It changes 2 files");
    // Shas are spelled out so speech synthesis does not slur them.
    expect(overview?.narration[0]).toContain("3 3 3 3 3 3 3");

    const [authored] = buildNarrationSegments(fullModel());
    expect(authored?.narration[0]).toBe("Welcome.");
  });

  test("narrates real verification results, including failures", () => {
    const model = fullModel();
    model.verification = {
      status: "failed",
      ran: true,
      results: [
        { ...model.verification.results[0]!, status: "failed", exitCode: 1 },
        { ...model.verification.results[0]!, id: "second", label: "Typecheck", status: "passed" },
      ],
    };

    const verification = buildNarrationSegments(model).find(
      (segment) => segment.sectionId === "verification",
    );

    expect(verification?.narration[0]).toContain("2 verification commands ran");
    expect(verification?.narration[0]).toContain("1 passed and 1 failed");
    expect(verification?.narration[1]).toContain("Unit tests: failed, exit code 1");
  });

  test("keeps the spoken script free of wall-clock timings", () => {
    // Narration is content-addressed in the TTS cache. Speaking a measured
    // duration would change the text on every regeneration and force a paid
    // re-synthesis of lines whose review content never moved.
    const model = fullModel();
    const slower = fullModel();
    slower.verification = {
      ...slower.verification,
      results: slower.verification.results.map((result) => ({
        ...result,
        durationMs: result.durationMs + 9_000,
      })),
    };

    expect(compileReviewTour(slower).narrationScript).toEqual(
      compileReviewTour(model).narrationScript,
    );
  });

  test("says plainly when verification never ran", () => {
    const model = fullModel();
    model.verification = { ...model.verification, ran: false, status: "not-run" };

    const verification = buildNarrationSegments(model).find(
      (segment) => segment.sectionId === "verification",
    );

    expect(verification?.narration[0]).toContain("none were executed");
    expect(verification?.narration[0]).toContain("unverified");
  });

  test("keeps subject and verb in agreement around counted nouns", () => {
    const spoken = buildNarrationSegments(fullModel())
      .flatMap((segment) => segment.narration)
      .join(" ");

    expect(spoken).not.toContain("groups accounts");
    expect(spoken).not.toContain("group account ");

    const single = makeViewModel({
      review: makeReviewDefinition(),
      coverage: {
        ...makeViewModel().coverage,
        changedPaths: ["src/app.ts"],
        totalCount: 1,
        accountedCount: 1,
        complete: true,
        assignments: [
          { path: "src/app.ts", kind: "chapter", ownerId: "core", ownerTitle: "Core" },
        ],
        groups: [
          { id: "tests", title: "Tests", rationale: "Reviewed with the behaviour.", patterns: ["**/*.test.ts"], paths: ["src/app.test.ts"] },
        ],
      },
    });
    const coverage = buildNarrationSegments(single).find(
      (segment) => segment.sectionId === "coverage",
    );

    expect(coverage?.narration[0]).toContain("All 1 changed file is accounted for");
    expect(coverage?.narration[0]).toContain("1 coverage group accounts for");
  });

  test("narrates the real coverage split", () => {
    const coverage = buildNarrationSegments(fullModel()).find(
      (segment) => segment.sectionId === "coverage",
    );

    expect(coverage?.narration[0]).toContain("All 2 changed files are accounted for");
    expect(coverage?.narration[0]).toContain("1 explained directly by a change set");
    expect(coverage?.narration.at(-1)).toBe("Check the bind address first.");
  });

  test("says coverage is incomplete rather than rounding up", () => {
    const model = fullModel();
    model.coverage = { ...model.coverage, complete: false, accountedCount: 1, totalCount: 2 };

    const coverage = buildNarrationSegments(model).find((segment) => segment.sectionId === "coverage");

    expect(coverage?.narration[0]).toContain("Coverage is incomplete");
  });

  test("narrates at most three reviewer checks per chapter", () => {
    const review = makeReviewDefinition();
    review.chapters[0]!.reviewerChecks = Array.from({ length: 5 }, (_, index) => ({
      id: `c${index}`,
      check: `Check number ${index}.`,
    }));

    const chapter = buildNarrationSegments(makeViewModel({ review })).find(
      (segment) => segment.sectionId === "chapter-core",
    );

    expect(chapter?.narration.filter((line) => line.startsWith("Check that"))).toHaveLength(3);
    expect(chapter?.narration[1]).toContain("1 file, with 1 focused diff");
  });

  test("uses each diagram's narration, falling back to its caption", () => {
    const model = fullModel();
    model.review.architecture![0]!.narration = "Spoken diagram line.";

    const architecture = buildNarrationSegments(model).find(
      (segment) => segment.sectionId === "architecture",
    );

    expect(architecture?.narration).toEqual([
      "The target architecture is shown in 2 diagrams.",
      "Spoken diagram line.",
      "Flow.",
    ]);
  });
});

describe("compileReviewTour", () => {
  test("compiles an in-memory tour that reuses the review id and title", () => {
    const model = fullModel();
    const compiled = compileReviewTour(model);

    expect(compiled.tour.id).toBe(model.review.id);
    expect(compiled.tour.title).toBe(model.review.title);
    expect(typeof compiled.tour.run).toBe("function");
    expect(typeof compiled.tour.beforeRecord).toBe("function");
  });

  test("exposes the spoken script in order for cache pre-warming", () => {
    const compiled = compileReviewTour(fullModel());
    const segments = buildNarrationSegments(fullModel());

    expect(compiled.narrationScript).toEqual(segments.flatMap((segment) => segment.narration));
    expect(compiled.narrationScript[0]).toBe("Welcome.");
  });

  test("declares one chapter per narrated section and narrates every line", async () => {
    const compiled = compileReviewTour(fullModel());
    const chapters: string[] = [];
    const narrated: string[] = [];

    await compiled.tour.run(makeRunContext({ chapters, narrated }) as never);

    expect(chapters).toEqual(buildNarrationSegments(fullModel()).map((segment) => segment.chapterTitle));
    expect(narrated).toEqual(compiled.narrationScript);
  });

  test("waits for the viewer to signal it finished rendering before recording", async () => {
    const compiled = compileReviewTour(fullModel());
    const selectors: string[] = [];

    await compiled.tour.beforeRecord!({
      goto: async () => null,
      page: { waitForSelector: async (selector: string) => selectors.push(selector) },
    } as never);

    expect(selectors[0]).toBe("html[data-review-ready='true']");
    expect(selectors[1]).toBe("#overview");
  });
});

function makeRunContext(sink: { chapters: string[]; narrated: string[] }) {
  return {
    chapter: async (title: string) => {
      sink.chapters.push(title);
    },
    narrate: async (text: string) => {
      sink.narrated.push(text);
    },
    narrateWhile: async (text: string, body: (timeline: { sleep: (ms: number) => Promise<void> }) => Promise<void>) => {
      sink.narrated.push(text);
      await body({ sleep: async () => undefined });
    },
    step: async (_title: string, body: () => Promise<void>) => {
      await body();
    },
    highlight: async () => undefined,
    page: {
      evaluate: async () => undefined,
      waitForTimeout: async () => undefined,
      locator: () => ({ first: () => ({ count: async () => 0 }) }),
    },
  };
}

describe("pluralize", () => {
  test("uses -ies after a consonant, because narration is spoken aloud", () => {
    expect(pluralize("security boundary")).toBe("security boundaries");
    expect(pluralize("query")).toBe("queries");
  });

  test("keeps -ys after a vowel", () => {
    expect(pluralize("day")).toBe("days");
    expect(pluralize("key")).toBe("keys");
  });

  test("uses -es after a sibilant", () => {
    expect(pluralize("class")).toBe("classes");
    expect(pluralize("patch")).toBe("patches");
    expect(pluralize("index")).toBe("indexes");
  });

  test("falls back to a plain -s", () => {
    for (const [noun, plural] of [
      ["file", "files"],
      ["diagram", "diagrams"],
      ["step", "steps"],
      ["risk", "risks"],
      ["area", "areas"],
      ["open question", "open questions"],
      ["verification command", "verification commands"],
      ["focused diff", "focused diffs"],
      ["coverage group", "coverage groups"],
    ] as const) {
      expect(pluralize(noun)).toBe(plural);
    }
  });
});

describe("narration pluralization", () => {
  test("speaks each counted noun correctly", () => {
    const lines = buildNarrationSegments(fullModel()).flatMap((segment) => segment.narration);
    const spoken = lines.join(" ");

    expect(spoken).toContain("1 security boundary is touched");
    expect(spoken).not.toContain("boundarys");

    const many = fullModel();
    many.review.security = [
      { id: "s1", title: "One", detail: "First." },
      { id: "s2", title: "Two", detail: "Second." },
    ];

    expect(
      buildNarrationSegments(many)
        .flatMap((segment) => segment.narration)
        .join(" "),
    ).toContain("2 security boundaries are touched");
  });
});
