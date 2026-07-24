import { describe, expect, test } from "bun:test";

import { generateContentSpec, DEFAULT_CONTENT_MODEL } from "./generator.js";
import { CONTENT_SPEC_VERSION, type ContentSpec } from "./schema.js";
import { VideoGenError } from "../pipeline/errors.js";

const validSpec: ContentSpec = {
  version: CONTENT_SPEC_VERSION,
  title: "DNS Basics",
  duration: "2m",
  slides: [
    {
      id: "intro",
      heading: "What is DNS?",
      body: [{ type: "paragraph", text: "DNS maps names to addresses." }],
      narration: "DNS maps human-friendly names to IP addresses.",
      transition: "fade",
    },
    {
      id: "lookup",
      heading: "A lookup",
      body: [
        { type: "bullet_list", items: ["Resolver", "Root", "Authoritative"] },
        { type: "code_block", language: "bash", code: "dig example.com" },
      ],
      narration: "A lookup walks from resolver to root to authoritative servers.",
      transition: "slide-left",
    },
    {
      id: "summary",
      heading: "Summary",
      body: [{ type: "paragraph", text: "DNS is the internet phonebook." }],
      narration: "In short, DNS is the internet phonebook.",
      transition: "fade",
    },
  ],
};

describe("generateContentSpec", () => {
  test("returns validated content on success and honors model override", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const result = await generateContentSpec(
      { prompt: "How does DNS work?", model: "gpt-test" },
      {
        createClient: () => ({
          responses: {
            parse: async (args) => {
              calls.push(args);
              return { output_parsed: validSpec };
            },
          },
        }),
        loadSystemPrompt: () => "system",
        sleep: async () => undefined,
        random: () => 0,
      },
    );

    expect(result.title).toBe("DNS Basics");
    expect(calls[0]?.model).toBe("gpt-test");
    expect(DEFAULT_CONTENT_MODEL.length).toBeGreaterThan(0);
  });

  test("fails when API key is missing for the default client", async () => {
    await expect(
      generateContentSpec(
        { prompt: "topic" },
        {
          env: {},
          loadSystemPrompt: () => "system",
        },
      ),
    ).rejects.toMatchObject({ code: "PREFLIGHT_FAILED" });
  });

  test("treats refusals as non-retryable", async () => {
    await expect(
      generateContentSpec(
        { prompt: "topic" },
        {
          createClient: () => ({
            responses: {
              parse: async () => ({ refusal: "I cannot help with that." }),
            },
          }),
          loadSystemPrompt: () => "system",
        },
      ),
    ).rejects.toBeInstanceOf(VideoGenError);
  });

  test("performs one corrective retry on semantic validation failure", async () => {
    let attempts = 0;
    const invalid = {
      ...validSpec,
      slides: [
        validSpec.slides[0]!,
        { ...validSpec.slides[1]!, id: "intro" },
        validSpec.slides[2]!,
      ],
    };
    const result = await generateContentSpec(
      { prompt: "topic" },
      {
        createClient: () => ({
          responses: {
            parse: async () => {
              attempts += 1;
              return { output_parsed: attempts === 1 ? invalid : validSpec };
            },
          },
        }),
        loadSystemPrompt: () => "system",
        sleep: async () => undefined,
        random: () => 0,
      },
    );
    expect(attempts).toBe(2);
    expect(result.slides[0]?.id).toBe("intro");
  });

  test("retries transient failures with bounded attempts", async () => {
    let attempts = 0;
    const delays: number[] = [];
    await expect(
      generateContentSpec(
        { prompt: "topic" },
        {
          createClient: () => ({
            responses: {
              parse: async () => {
                attempts += 1;
                throw new Error("network timeout");
              },
            },
          }),
          loadSystemPrompt: () => "system",
          sleep: async (ms) => {
            delays.push(ms);
          },
          random: () => 0,
        },
      ),
    ).rejects.toMatchObject({ code: "CONTENT_FAILED" });
    expect(attempts).toBe(3);
    expect(delays.length).toBe(2);
    expect(Math.max(...delays)).toBeLessThanOrEqual(8_000);
  });

  test("aborts when signal is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      generateContentSpec(
        { prompt: "topic", signal: controller.signal },
        {
          createClient: () => ({
            responses: {
              parse: async () => ({ output_parsed: validSpec }),
            },
          }),
          loadSystemPrompt: () => "system",
        },
      ),
    ).rejects.toMatchObject({ code: "INTERRUPTED" });
  });
});
