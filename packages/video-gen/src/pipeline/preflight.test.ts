import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assertPreflightOk,
  deriveTourId,
  runPreflight,
  validateGenerateOptions,
} from "./preflight.js";
import { VideoGenError } from "./errors.js";

describe("preflight", () => {
  test("validates options and defaults", () => {
    const validated = validateGenerateOptions({ prompt: "  Hello  " }, "/tmp/project");
    expect(validated.prompt).toBe("Hello");
    expect(validated.style).toBe("minimal");
    expect(validated.outputDir).toBe(path.resolve("/tmp/project/.demohunter"));
    expect(validated.cleanup).toBe(false);
  });

  test("rejects empty prompt and bad style", () => {
    expect(() => validateGenerateOptions({ prompt: "   " })).toThrow(VideoGenError);
    expect(() =>
      validateGenerateOptions({ prompt: "x", style: "neon" as never }),
    ).toThrow(/style/);
  });

  test("aggregates failures and passes the all-green case", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "video-gen-pre-"));
    try {
      const failed = await runPreflight(
        {
          options: {
            prompt: "x",
            style: "minimal",
            outputDir,
            cleanup: false,
          },
        },
        {
          env: {},
          checkCommand: async () => {
            throw new Error("missing");
          },
          launchBrowser: async () => {
            throw new Error("no browser");
          },
        },
      );
      expect(failed.ok).toBe(false);
      expect(() => assertPreflightOk(failed)).toThrow(/PREFLIGHT_FAILED|Preflight/);

      const ok = await runPreflight(
        {
          options: {
            prompt: "x",
            style: "minimal",
            outputDir,
            cleanup: false,
          },
        },
        {
          env: { OPENAI_API_KEY: "test-key" },
          checkCommand: async () => undefined,
          launchBrowser: async () => ({ close: async () => undefined }),
        },
      );
      expect(ok.ok).toBe(true);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("detects collisions and cancellation", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "video-gen-pre-"));
    try {
      const tourId = deriveTourId("Binary Trees");
      await mkdir(path.join(outputDir, tourId), { recursive: true });
      const result = await runPreflight(
        {
          options: {
            prompt: "x",
            style: "minimal",
            outputDir,
            cleanup: false,
          },
          tourId,
        },
        {
          env: { OPENAI_API_KEY: "test-key" },
          checkCommand: async () => undefined,
          launchBrowser: async () => ({ close: async () => undefined }),
        },
      );
      expect(result.ok).toBe(false);
      expect(result.checks.some((check) => check.name === "collision" && !check.ok)).toBe(true);

      const controller = new AbortController();
      controller.abort();
      await expect(
        runPreflight(
          {
            options: {
              prompt: "x",
              style: "minimal",
              outputDir,
              cleanup: false,
              signal: controller.signal,
            },
          },
          {
            env: { OPENAI_API_KEY: "test-key" },
            checkCommand: async () => undefined,
            launchBrowser: async () => ({ close: async () => undefined }),
          },
        ),
      ).rejects.toMatchObject({ code: "INTERRUPTED" });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
