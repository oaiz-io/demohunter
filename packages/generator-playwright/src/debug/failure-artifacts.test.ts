import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { attachDebugCapture } from "./failure-artifacts.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { force: true, recursive: true })));
});

describe("attachDebugCapture", () => {
  test("writes screenshot, page text, and failure metadata", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "demohunter-debug-"));
    tempRoots.push(outputDir);
    const handlers = new Map<string, Function>();
    const page = {
      locator: mock(() => ({
        innerText: mock(async () => "Visible page text"),
      })),
      off: mock((event: string) => {
        handlers.delete(event);
      }),
      on: mock((event: string, handler: Function) => {
        handlers.set(event, handler);
      }),
      screenshot: mock(async ({ path: screenshotPath }: { path: string }) => {
        await writeFile(screenshotPath, "png", "utf8");
      }),
      title: mock(async () => "Failure page"),
      url: mock(() => "http://localhost:3000/failure"),
    };
    const capture = attachDebugCapture({
      outputDir,
      page: page as never,
      timestamp: () => new Date("2026-05-19T08:00:00.000Z"),
    });

    handlers.get("console")?.({
      text: () => "console warning",
      type: () => "warning",
    });
    const result = await capture.captureFailure({
      error: new Error("selector failed"),
      lastRuntimeEvent: {
        chapterTitle: "Setup",
        kind: "step-start",
        title: "Wait for artifact",
      },
      phase: "collect-timeline",
    });

    const failure = JSON.parse(await readFile(result.failureJsonPath, "utf8")) as {
      console: Array<{ text: string; type: string }>;
      error: { message: string };
      page: { title: string; url: string };
      lastRuntimeEvent: { title: string };
    };

    expect(result.directory).toBe(path.join(outputDir, "debug", "2026-05-19T08-00-00-000Z-collect-timeline"));
    expect(await readFile(path.join(result.directory, "body.txt"), "utf8")).toBe("Visible page text");
    expect(await readFile(path.join(result.directory, "screenshot.png"), "utf8")).toBe("png");
    expect(failure.error.message).toBe("selector failed");
    expect(failure.page).toEqual({
      title: "Failure page",
      url: "http://localhost:3000/failure",
    });
    expect(failure.console).toEqual([{ text: "console warning", type: "warning" }]);
    expect(failure.lastRuntimeEvent.title).toBe("Wait for artifact");

    capture.dispose();
    expect(page.off).toHaveBeenCalledTimes(3);
  });

  test("skips page text and strips URL queries when a session is loaded", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "demohunter-debug-"));
    tempRoots.push(outputDir);
    const handlers = new Map<string, Function>();
    const innerText = mock(async () => "Inbox of someone@example.com");
    const page = {
      locator: mock(() => ({ innerText })),
      off: mock(() => {}),
      on: mock((event: string, handler: Function) => {
        handlers.set(event, handler);
      }),
      screenshot: mock(async ({ path: screenshotPath }: { path: string }) => {
        await writeFile(screenshotPath, "png", "utf8");
      }),
      title: mock(async () => "Inbox"),
      url: mock(() => "https://mail.example.com/mail/u/0/?account=42#inbox/thread-9"),
    };
    const capture = attachDebugCapture({
      outputDir,
      page: page as never,
      redact: true,
      timestamp: () => new Date("2026-05-19T08:00:00.000Z"),
    });

    handlers.get("console")?.({
      text: () => "fetch failed for https://api.example.com/v1/sync?token=abc123",
      type: () => "error",
    });
    handlers.get("requestfailed")?.({
      failure: () => ({ errorText: "net::ERR_FAILED" }),
      method: () => "GET",
      resourceType: () => "fetch",
      url: () => "https://api.example.com/v1/sync?token=abc123",
    });
    const result = await capture.captureFailure({
      error: new Error('page.goto: Timeout exceeded while navigating to "https://mail.example.com/?account=42"'),
      phase: "record-replay",
    });

    const failureJson = await readFile(result.failureJsonPath, "utf8");
    const failure = JSON.parse(failureJson) as {
      artifacts: { bodyTextPath?: string; screenshotPath?: string };
      console: Array<{ text: string }>;
      error: { message: string };
      failedRequests: Array<{ url: string }>;
      page: { url: string };
    };

    expect(innerText).not.toHaveBeenCalled();
    expect(result.bodyTextPath).toBeUndefined();
    expect((await readdir(result.directory)).sort()).toEqual(["failure.json", "screenshot.png"]);
    expect(failure.artifacts).toEqual({ screenshotPath: "screenshot.png" });
    expect(failure.page.url).toBe("https://mail.example.com/mail/u/0/");
    expect(failure.failedRequests[0]?.url).toBe("https://api.example.com/v1/sync");
    expect(failure.console[0]?.text).toBe("fetch failed for https://api.example.com/v1/sync");
    expect(failure.error.message).toBe('page.goto: Timeout exceeded while navigating to "https://mail.example.com/"');
    expect(failureJson).not.toContain("account=42");
    expect(failureJson).not.toContain("abc123");
    expect(failureJson).not.toContain("thread-9");
  });
});
