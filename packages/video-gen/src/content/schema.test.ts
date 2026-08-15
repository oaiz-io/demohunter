import { describe, expect, test } from "bun:test";

import {
  CONTENT_SPEC_VERSION,
  ContentSpecSchema,
  serializeContentSpec,
  type ContentSpec,
} from "./schema.js";

describe("ContentSpecSchema body variants", () => {
  const base: ContentSpec = {
    version: CONTENT_SPEC_VERSION,
    title: "HTTPS",
    duration: "90s",
    slides: [
      {
        id: "intro",
        heading: "HTTPS",
        body: [{ type: "paragraph", text: "Secure HTTP." }],
        narration: "HTTPS secures HTTP with TLS.",
        transition: "fade",
      },
    ],
  };

  test("accepts each body variant", () => {
    expect(
      ContentSpecSchema.parse({
        ...base,
        slides: [
          {
            ...base.slides[0]!,
            body: [
              { type: "paragraph", text: "A" },
              { type: "bullet_list", items: ["one"] },
              { type: "code_block", language: "bash", code: "curl https://example.com" },
            ],
          },
        ],
      }).slides[0]?.body,
    ).toHaveLength(3);
  });

  test("serializer is stable and non-mutating", () => {
    const copy = structuredClone(base);
    const first = serializeContentSpec(base);
    const second = serializeContentSpec(base);
    expect(first).toBe(second);
    expect(base).toEqual(copy);
  });

  test("enforces slide bounds", () => {
    expect(() =>
      ContentSpecSchema.parse({ ...base, slides: [] }),
    ).toThrow();
  });
});
