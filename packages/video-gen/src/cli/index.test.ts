import { describe, expect, test } from "bun:test";

import { formatCliError, redactSecrets, VideoGenError } from "../pipeline/errors.js";
import { formatProgress, parseGenerateArgs, runCli } from "./index.js";

describe("cli", () => {
  test("parses generate args and rejects invalid input", () => {
    expect(parseGenerateArgs(["What is DNS?", "--style", "terminal", "--output", "out"])).toEqual({
      prompt: "What is DNS?",
      style: "terminal",
      output: "out",
      cleanup: false,
      help: false,
      version: false,
    });
    expect(() => parseGenerateArgs(["", "--style"])).toThrow();
    expect(() => parseGenerateArgs(["topic", "--style", "neon"])).toThrow(/style/);
    expect(() => parseGenerateArgs(["a", "b"])).toThrow(/one prompt/);
    expect(() => parseGenerateArgs(["topic", "--unknown"])).toThrow(/Unknown flag/);
  });

  test("help and version short-circuit", async () => {
    const lines: string[] = [];
    expect(
      await runCli(["--help"], {
        log: (message) => lines.push(message),
        getVersion: () => "0.0.0",
      }),
    ).toBe(0);
    expect(lines.join("\n")).toContain("demohunter-video generate");

    lines.length = 0;
    expect(
      await runCli(["--version"], {
        log: (message) => lines.push(message),
        getVersion: () => "9.9.9",
      }),
    ).toBe(0);
    expect(lines).toContain("9.9.9");
  });

  test("maps cleanup and prints success paths without secrets", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const code = await runCli(
      ["generate", "Teach DNS", "--style", "minimal", "--cleanup"],
      {
        log: (message) => logs.push(message),
        error: (message) => errors.push(message),
        generateVideo: async (options) => {
          expect(options.cleanup).toBe(true);
          expect(options.style).toBe("minimal");
          options.onProgress?.({ phase: "content", message: "working" });
          return {
            id: "dns",
            title: "DNS",
            style: "minimal",
            workspaceDir: "/tmp/ws",
            contentSpecPath: "/tmp/ws/content-spec.json",
            siteDir: "/tmp/ws/site",
            tourPath: "/tmp/ws/dns.tour.ts",
            configPath: "/tmp/ws/demohunter.config.ts",
            outputDir: "/tmp/dns",
            videoPath: "/tmp/dns/video.mp4",
            captionsSrtPath: "/tmp/dns/captions.srt",
            captionsVttPath: "/tmp/dns/captions.vtt",
            chaptersPath: "/tmp/dns/chapters.json",
            workspacePreserved: false,
          };
        },
      },
    );
    expect(code).toBe(0);
    expect(logs.some((line) => line.includes("[content]"))).toBe(true);
    expect(logs.some((line) => line.includes("Video: /tmp/dns/video.mp4"))).toBe(true);
    expect(logs.some((line) => line.includes("removed"))).toBe(true);
  });

  test("redacts secrets and returns non-zero on failure", async () => {
    expect(redactSecrets("token sk-abc1234567890xyz")).toContain("[redacted]");
    expect(formatCliError(new VideoGenError("INVALID_INPUT", "bad sk-abc1234567890xyz"))).not.toContain(
      "sk-abc",
    );

    const code = await runCli(["generate", "x"], {
      log: () => undefined,
      error: () => undefined,
      generateVideo: async () => {
        throw new VideoGenError("PREFLIGHT_FAILED", "OPENAI_API_KEY=sk-abc1234567890xyz missing guidance");
      },
    });
    expect(code).toBe(1);
    expect(formatProgress({ phase: "record", message: "mux", detail: { phase: "muxing-video", message: "mux" } })).toContain(
      "record:muxing-video",
    );
  });
});
