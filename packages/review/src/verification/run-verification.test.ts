import { describe, expect, test } from "bun:test";

import type { ReviewVerificationCommand } from "../authoring/review-types.js";
import {
  runVerification,
  truncateTail,
  VERIFICATION_OUTPUT_TAIL_BYTES,
  type RunCommand,
} from "./run-verification.js";

const command: ReviewVerificationCommand = {
  id: "tests",
  label: "Unit tests",
  command: ["bun", "test", "packages/review"],
  rationale: "Covers the changed behaviour.",
};

describe("runVerification", () => {
  test("records declared commands as not-run rather than as passing", async () => {
    const report = await runVerification({
      commands: [command],
      cwd: "/repo",
      run: false,
      runCommand: shouldNotRun,
    });

    expect(report.status).toBe("not-run");
    expect(report.ran).toBe(false);
    expect(report.results[0]).toMatchObject({
      id: "tests",
      status: "not-run",
      exitCode: null,
      durationMs: 0,
      outputTail: "",
    });
  });

  test("passes when the real exit code matches the expectation", async () => {
    let elapsed = 0;
    const report = await runVerification({
      commands: [command],
      cwd: "/repo",
      run: true,
      now: () => (elapsed += 1_500),
      runCommand: async () => ({ exitCode: 0, output: "3 pass\n", timedOut: false }),
    });

    expect(report.status).toBe("passed");
    expect(report.ran).toBe(true);
    expect(report.results[0]).toMatchObject({
      status: "passed",
      exitCode: 0,
      expectedExitCode: 0,
      timedOut: false,
      outputTail: "3 pass\n",
      outputTruncated: false,
    });
    expect(report.results[0]?.durationMs).toBe(1_500);
  });

  test("fails on the wrong exit code and reports the whole run as failed", async () => {
    const report = await runVerification({
      commands: [command, { ...command, id: "second", label: "Second" }],
      cwd: "/repo",
      run: true,
      runCommand: async ({ args }) =>
        args.includes("packages/review")
          ? { exitCode: 1, output: "1 fail\n", timedOut: false }
          : { exitCode: 0, output: "", timedOut: false },
    });

    expect(report.status).toBe("failed");
    expect(report.results.every((result) => result.status === "failed")).toBe(true);
  });

  test("honours a non-zero expected exit code", async () => {
    const report = await runVerification({
      commands: [{ ...command, expectExitCode: 2 }],
      cwd: "/repo",
      run: true,
      runCommand: async () => ({ exitCode: 2, output: "", timedOut: false }),
    });

    expect(report.results[0]?.status).toBe("passed");
  });

  test("treats a timeout as a failure even with a matching exit code", async () => {
    const report = await runVerification({
      commands: [command],
      cwd: "/repo",
      run: true,
      runCommand: async () => ({ exitCode: 0, output: "", timedOut: true }),
    });

    expect(report.results[0]).toMatchObject({ status: "failed", timedOut: true });
  });

  test("runs each command as argv in the repository root by default", async () => {
    const seen: Array<{ command: string; args: string[]; cwd: string }> = [];
    const runCommand: RunCommand = async (input) => {
      seen.push({ command: input.command, args: input.args, cwd: input.cwd });
      return { exitCode: 0, output: "", timedOut: false };
    };

    await runVerification({
      commands: [command, { ...command, id: "scoped", cwd: "packages/review" }],
      cwd: "/repo",
      run: true,
      runCommand,
    });

    expect(seen[0]).toEqual({
      command: "bun",
      args: ["test", "packages/review"],
      cwd: "/repo",
    });
    expect(seen[1]?.cwd).toBe("/repo/packages/review");
  });

  test("reports an empty command list as not-run without inventing a status", async () => {
    const report = await runVerification({ commands: [], cwd: "/repo", run: true });

    expect(report).toEqual({ status: "not-run", ran: true, results: [] });
  });

  test("reports progress for each command", async () => {
    const messages: string[] = [];

    await runVerification({
      commands: [command],
      cwd: "/repo",
      run: true,
      runCommand: async () => ({ exitCode: 0, output: "", timedOut: false }),
      onProgress: (message) => messages.push(message),
    });

    expect(messages).toEqual(["Running verification: Unit tests"]);
  });
});

describe("truncateTail", () => {
  test("keeps short output verbatim", () => {
    expect(truncateTail("short")).toEqual({ text: "short", truncated: false });
  });

  test("keeps the tail of long output and flags the truncation", () => {
    const long = `${"a".repeat(VERIFICATION_OUTPUT_TAIL_BYTES)}TAIL`;
    const result = truncateTail(long);

    expect(result.truncated).toBe(true);
    expect(result.text.endsWith("TAIL")).toBe(true);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(VERIFICATION_OUTPUT_TAIL_BYTES);
  });
});

describe("runVerification against real processes", () => {
  test("records the real exit code of a command that exists", async () => {
    const report = await runVerification({
      commands: [
        { id: "true", label: "true", command: ["node", "-e", "process.exit(0)"] },
        { id: "false", label: "false", command: ["node", "-e", "process.exit(3)"] },
      ],
      cwd: process.cwd(),
      run: true,
    });

    expect(report.results[0]?.exitCode).toBe(0);
    expect(report.results[0]?.status).toBe("passed");
    expect(report.results[1]?.exitCode).toBe(3);
    expect(report.results[1]?.status).toBe("failed");
  }, 20_000);

  test("reports a missing executable as a failure instead of throwing", async () => {
    const report = await runVerification({
      commands: [{ id: "missing", label: "missing", command: ["demohunter-does-not-exist"] }],
      cwd: process.cwd(),
      run: true,
    });

    expect(report.results[0]?.status).toBe("failed");
    expect(report.results[0]?.exitCode).toBeNull();
    expect(report.results[0]?.outputTail).toContain("demohunter-does-not-exist");
  }, 20_000);
});

const shouldNotRun: RunCommand = async () => {
  throw new Error("runCommand must not be called when run is false");
};
