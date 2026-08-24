import { describe, expect, test } from "bun:test";

import {
  RecordingInterruptedError,
  describeRecordingInterruption,
  isTargetClosedError,
} from "./recording-interruption.js";

describe("isTargetClosedError", () => {
  test("recognizes the error Playwright throws once it has closed the browser", () => {
    expect(
      isTargetClosedError(
        new Error("page.waitForTimeout: Target page, context or browser has been closed"),
      ),
    ).toBe(true);
  });

  test("leaves unrelated failures alone", () => {
    expect(isTargetClosedError(new Error("locator.click: Timeout 30000ms exceeded"))).toBe(false);
    expect(isTargetClosedError("Target page, context or browser has been closed")).toBe(false);
    expect(isTargetClosedError(undefined)).toBe(false);
  });
});

describe("describeRecordingInterruption", () => {
  test("names the interruption, the phase, and the original error", () => {
    const original = new Error(
      "page.waitForTimeout: Target page, context or browser has been closed",
    );

    const described = describeRecordingInterruption(original, "record-replay");

    expect(described).toBeInstanceOf(RecordingInterruptedError);
    const error = described as RecordingInterruptedError;
    expect(error.name).toBe("RecordingInterruptedError");
    expect(error.message).toContain("recording the replay");
    expect(error.message).toContain("from outside the process");
    expect(error.message).toContain(original.message);
    expect(error.cause).toBe(original);
  });

  test("describes the phase the run was actually in", () => {
    const original = new Error("page.goto: Target page, context or browser has been closed");

    expect((describeRecordingInterruption(original, "collect-timeline") as Error).message).toContain(
      "collecting the timeline",
    );
    expect((describeRecordingInterruption(original, "dry-run") as Error).message).toContain(
      "validating the tour",
    );
  });

  test("returns a real tour failure untouched so it keeps its own message", () => {
    const divergence = new Error("Recorded pass diverged at entry 2");

    expect(describeRecordingInterruption(divergence, "record-replay")).toBe(divergence);
  });
});
