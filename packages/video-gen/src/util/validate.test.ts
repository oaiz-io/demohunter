import { describe, expect, test } from "bun:test";

import {
  CONTENT_SPEC_VERSION,
  ContentSpecSchema,
  serializeContentSpec,
  type ContentSpec,
} from "../content/schema.js";
import { ContentValidationError, validateContentSpec } from "./validate.js";

const validSpec: ContentSpec = {
  version: CONTENT_SPEC_VERSION,
  title: "Binary Trees",
  duration: "2m",
  slides: [
    {
      id: "intro",
      heading: "What is a binary tree?",
      body: [
        { type: "paragraph", text: "A binary tree is a hierarchical structure." },
        { type: "bullet_list", items: ["Root", "Left child", "Right child"] },
        { type: "code_block", language: "ts", code: "type Node = { left?: Node; right?: Node };" },
      ],
      narration: "A binary tree organizes values with at most two children per node.",
      transition: "fade",
    },
    {
      id: "why",
      heading: "Why use one?",
      body: [{ type: "paragraph", text: "They support efficient search and insert." }],
      narration: "Binary trees are useful because they support efficient search and insert.",
      transition: "slide-left",
    },
  ],
};

describe("content schema", () => {
  test("accepts a mixed-content lesson", () => {
    const parsed = ContentSpecSchema.parse(validSpec);
    expect(parsed.slides).toHaveLength(2);
    expect(serializeContentSpec(parsed).endsWith("\n")).toBe(true);
  });

  test("rejects unknown keys and malformed duration", () => {
    expect(() =>
      ContentSpecSchema.parse({ ...validSpec, extra: true }),
    ).toThrow();
    expect(() =>
      ContentSpecSchema.parse({ ...validSpec, duration: "about two minutes" }),
    ).toThrow();
  });

  test("rejects empty narration or body", () => {
    expect(() =>
      ContentSpecSchema.parse({
        ...validSpec,
        slides: [{ ...validSpec.slides[0], narration: "   " }],
      }),
    ).toThrow();
    expect(() =>
      ContentSpecSchema.parse({
        ...validSpec,
        slides: [{ ...validSpec.slides[0], body: [] }],
      }),
    ).toThrow();
  });

  test("semantic validation catches duplicate and unsafe ids", () => {
    expect(() =>
      validateContentSpec({
        ...validSpec,
        slides: [validSpec.slides[0]!, { ...validSpec.slides[1]!, id: "intro" }],
      }),
    ).toThrow(ContentValidationError);
  });
});
