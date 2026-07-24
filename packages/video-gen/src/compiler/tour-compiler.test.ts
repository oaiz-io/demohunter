import { describe, expect, test } from "bun:test";

import { CONTENT_SPEC_VERSION, type ContentSpec } from "../content/schema.js";
import { compileTour, compileTourInstructions } from "./tour-compiler.js";

const spec: ContentSpec = {
  version: CONTENT_SPEC_VERSION,
  title: 'DNS & "Names"',
  duration: "2m",
  slides: [
    {
      id: "intro",
      heading: "DNS",
      body: [
        { type: "paragraph", text: "Maps names." },
        { type: "code_block", language: "bash", code: 'echo "hello"' },
      ],
      narration: 'DNS maps names. Use echo "hello".',
      transition: "fade",
    },
    {
      id: "lookup",
      heading: "Lookup",
      body: [{ type: "bullet_list", items: ["resolver", "authority"] }],
      narration: "Lookups walk the hierarchy.",
      transition: "slide-left",
    },
  ],
};

describe("tour compiler", () => {
  test("emits golden selectors, chapters, and escaped strings", () => {
    const compiled = compileTour({ spec, tourId: "dns-names" });
    expect(compiled.moduleSource).toContain('id: "dns-names"');
    expect(compiled.moduleSource).toContain('import { defineTour } from "@demohunter/sdk"');
    expect(compiled.moduleSource).toContain('[data-section-id=\\"intro\\"]');
    expect(compiled.moduleSource).toContain("scrollIntoView");
    expect(compiled.moduleSource).toContain("behavior: \"smooth\"");
    expect(compiled.moduleSource).toContain("await page.waitForTimeout(720)");
    expect(compiled.moduleSource).toContain("await narrateWhile(");
    expect(compiled.moduleSource).not.toContain("await click(");
    expect(compiled.moduleSource).not.toContain("data-nav");
    expect(compiled.moduleSource).toContain('{ id: "intro" }');
    expect(compiled.moduleSource).toContain('{ id: "lookup" }');
    expect(compiled.moduleSource).toContain("DNS & \\\"Names\\\"");
    expect(compiled.moduleSource).not.toContain("nth-child");
    expect(compiled.moduleSource).not.toContain("../");
    expect(compiled.tour.id).toBe("dns-names");
    expect(compiled.tour.title).toBe('DNS & "Names"');
  });

  test("instruction IR stays ordered and selector-stable", () => {
    const instructions = compileTourInstructions(spec, "dns-names");
    expect(instructions.map((item) => item.slideId)).toEqual(["intro", "lookup"]);
    expect(instructions[0]?.hasCodeBlock).toBe(true);
    expect(instructions[1]?.hasCodeBlock).toBe(false);
    expect(instructions[1]?.sectionSelector).toBe('[data-section-id="lookup"]');
  });

  test("in-memory tour emits the same ordered runtime events as the instruction list", async () => {
    const compiled = compileTour({ spec, tourId: "dns-names" });
    const events: string[] = [];
    const locator = (selector: string) => ({
      selector,
      waitFor: async () => {
        events.push(`wait:${selector}`);
      },
      evaluate: async () => {
        events.push(`scroll:${selector}`);
      },
    });

    const runtime = {
      config: {},
      page: {
        locator,
        waitForTimeout: async (ms: number) => {
          events.push(`waitForTimeout:${ms}`);
        },
      },
      goto: async () => {
        events.push("goto");
        return null;
      },
      chapter: async (title: string, options?: { id?: string }) => {
        events.push(`chapter:${options?.id}:${title}`);
      },
      step: async (title: string, fn: () => Promise<unknown>) => {
        events.push(`step:${title}`);
        return fn();
      },
      narrateWhile: async (text: string, fn: () => Promise<unknown>) => {
        events.push(`narrateWhile:${text}`);
        return fn();
      },
      assertVisible: async (target: { selector: string }) => {
        events.push(`assertVisible:${target.selector}`);
      },
    };

    await compiled.tour.beforeRecord?.(runtime as never);
    await compiled.tour.run(runtime as never);

    expect(events).toEqual([
      "goto",
      'wait:[data-section-id="intro"]',
      "chapter:intro:DNS",
      "step:DNS",
      'wait:[data-section-id="intro"]',
      'narrateWhile:DNS maps names. Use echo "hello".',
      'scroll:[data-section-id="intro"]',
      "waitForTimeout:720",
      'assertVisible:[data-section-id="intro"] [data-section-heading="true"]',
      'assertVisible:[data-section-id="intro"] [data-code-block="true"]',
      "chapter:lookup:Lookup",
      "step:Lookup",
      'wait:[data-section-id="lookup"]',
      "narrateWhile:Lookups walk the hierarchy.",
      'scroll:[data-section-id="lookup"]',
      "waitForTimeout:720",
      'assertVisible:[data-section-id="lookup"] [data-section-heading="true"]',
    ]);
  });
});
