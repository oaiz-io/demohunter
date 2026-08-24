import { spawn } from "node:child_process";

import type { ReviewVerificationCommand } from "../authoring/review-types.js";

export type VerificationStatus = "passed" | "failed" | "not-run";

export type VerificationResult = {
  id: string;
  label: string;
  command: string[];
  cwd: string;
  rationale?: string;
  status: VerificationStatus;
  expectedExitCode: number;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  /** Tail of combined stdout/stderr, truncated so artifacts stay small. */
  outputTail: string;
  outputTruncated: boolean;
};

export type VerificationReport = {
  status: VerificationStatus;
  ran: boolean;
  results: VerificationResult[];
};

export type RunCommandResult = {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
};

export type RunCommand = (input: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
}) => Promise<RunCommandResult>;

export const DEFAULT_VERIFICATION_TIMEOUT_MS = 20 * 60 * 1000;
export const VERIFICATION_OUTPUT_TAIL_BYTES = 8 * 1024;

/**
 * Executes the authored verification commands and records what actually
 * happened. When `run` is false the commands are recorded as `not-run` rather
 * than being quietly reported as passing, which is what keeps the strict check
 * honest.
 */
export async function runVerification(input: {
  commands: readonly ReviewVerificationCommand[];
  cwd: string;
  run: boolean;
  runCommand?: RunCommand;
  now?: () => number;
  onProgress?: (message: string) => void;
}): Promise<VerificationReport> {
  const runCommand = input.runCommand ?? defaultRunCommand;
  const now = input.now ?? (() => Date.now());

  if (input.commands.length === 0) {
    return { status: "not-run", ran: input.run, results: [] };
  }

  if (!input.run) {
    return {
      status: "not-run",
      ran: false,
      results: input.commands.map((command) => ({
        id: command.id,
        label: command.label,
        command: [...command.command],
        cwd: command.cwd ?? ".",
        ...(command.rationale === undefined ? {} : { rationale: command.rationale }),
        status: "not-run" as const,
        expectedExitCode: command.expectExitCode ?? 0,
        exitCode: null,
        durationMs: 0,
        timedOut: false,
        outputTail: "",
        outputTruncated: false,
      })),
    };
  }

  const results: VerificationResult[] = [];

  for (const command of input.commands) {
    const [executable, ...args] = command.command;
    const expectedExitCode = command.expectExitCode ?? 0;
    const startedAt = now();
    input.onProgress?.(`Running verification: ${command.label}`);

    const result = await runCommand({
      command: executable!,
      args,
      cwd: command.cwd === undefined ? input.cwd : resolveCwd(input.cwd, command.cwd),
      timeoutMs: command.timeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS,
    });
    const tail = truncateTail(result.output);

    results.push({
      id: command.id,
      label: command.label,
      command: [...command.command],
      cwd: command.cwd ?? ".",
      ...(command.rationale === undefined ? {} : { rationale: command.rationale }),
      status: !result.timedOut && result.exitCode === expectedExitCode ? "passed" : "failed",
      expectedExitCode,
      exitCode: result.exitCode,
      durationMs: Math.max(0, now() - startedAt),
      timedOut: result.timedOut,
      outputTail: tail.text,
      outputTruncated: tail.truncated,
    });
  }

  return {
    status: results.every((result) => result.status === "passed") ? "passed" : "failed",
    ran: true,
    results,
  };
}

function resolveCwd(root: string, relative: string): string {
  return relative.startsWith("/") ? relative : `${root.replace(/\/$/, "")}/${relative}`;
}

export function truncateTail(output: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(output, "utf8");

  if (bytes.byteLength <= VERIFICATION_OUTPUT_TAIL_BYTES) {
    return { text: output, truncated: false };
  }

  const sliced = bytes.subarray(bytes.byteLength - VERIFICATION_OUTPUT_TAIL_BYTES).toString("utf8");

  return { text: sliced, truncated: true };
}

const defaultRunCommand: RunCommand = async ({ command, args, cwd, timeoutMs }) => {
  return await new Promise<RunCommandResult>((resolve) => {
    let output = "";
    let timedOut = false;
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, CI: process.env.CI ?? "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);

    const append = (chunk: Buffer | string): void => {
      output += chunk.toString();
      // Keep memory bounded on very chatty test suites.
      if (output.length > 4 * VERIFICATION_OUTPUT_TAIL_BYTES) {
        output = output.slice(-2 * VERIFICATION_OUTPUT_TAIL_BYTES);
      }
    };

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => {
      if (timer !== undefined) clearTimeout(timer);
      resolve({ exitCode: null, output: `${output}\n${error.message}`, timedOut });
    });
    child.on("close", (exitCode) => {
      if (timer !== undefined) clearTimeout(timer);
      resolve({ exitCode, output, timedOut });
    });
  });
};
