import { execFile } from "node:child_process";

/**
 * Runs one Git command and returns stdout. Every Git access in this package
 * goes through this function so tests can inject a deterministic fake instead
 * of shelling out.
 */
export type RunGit = (args: readonly string[], options?: RunGitOptions) => Promise<string>;

export type RunGitOptions = {
  cwd?: string;
  /** Decode stdout as latin1 so byte-exact blob content survives the round trip. */
  encoding?: "utf8" | "buffer";
  maxBufferBytes?: number;
};

export class GitCommandError extends Error {
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(input: { args: readonly string[]; exitCode: number | null; stderr: string }) {
    super(
      `git ${input.args.join(" ")} failed${
        input.exitCode === null ? "" : ` with exit code ${input.exitCode}`
      }: ${input.stderr.trim() || "unknown error"}`,
    );
    this.name = "GitCommandError";
    this.args = input.args;
    this.exitCode = input.exitCode;
    this.stderr = input.stderr;
  }
}

const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export function createGitRunner(defaultCwd: string): RunGit {
  return async (args, options = {}) => {
    return await new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        [...args],
        {
          cwd: options.cwd ?? defaultCwd,
          encoding: options.encoding === "buffer" ? "buffer" : "utf8",
          maxBuffer: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
          env: {
            ...process.env,
            // Keep output machine-readable regardless of the developer's local
            // Git configuration, locale, or pager.
            GIT_PAGER: "cat",
            GIT_TERMINAL_PROMPT: "0",
            LC_ALL: "C",
          },
        },
        (error, stdout, stderr) => {
          if (error !== null) {
            reject(
              new GitCommandError({
                args,
                exitCode: typeof error.code === "number" ? error.code : null,
                stderr: typeof stderr === "string" ? stderr : String(stderr ?? ""),
              }),
            );
            return;
          }

          resolve(typeof stdout === "string" ? stdout : Buffer.from(stdout).toString("utf8"));
        },
      );
    });
  };
}

/** Splits NUL-delimited Git output, dropping the trailing empty field. */
export function splitNulFields(output: string): string[] {
  const fields = output.split("\0");

  if (fields.length > 0 && fields[fields.length - 1] === "") {
    fields.pop();
  }

  return fields;
}
