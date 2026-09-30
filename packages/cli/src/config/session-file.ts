import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { ResolvedSessionConfig } from "@demohunter/sdk";

import { STORAGE_STATE_ENV } from "./load-config.js";

const execFileAsync = promisify(execFile);

export type StorageStateSummary = {
  cookies: Array<{ domain: string; expires: number }>;
  originCount: number;
};

/** A session-file problem whose message already tells the user what to do. */
export class SessionFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionFileError";
  }
}

export function describeSessionSource(session: ResolvedSessionConfig): string {
  return session.source === "env" ? STORAGE_STATE_ENV : "session.storageState";
}

/**
 * Reads only what DemoHunter checks: cookie domains and expiry dates. Errors
 * never quote the file, because it holds bearer credentials.
 */
export async function readStorageStateFile(session: ResolvedSessionConfig, cwd: string): Promise<StorageStateSummary> {
  const displayPath = path.relative(cwd, session.storageState) || session.storageState;
  const origin = `${displayPath} (from ${describeSessionSource(session)})`;
  let contents: string;

  try {
    contents = await readFile(session.storageState, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SessionFileError(
        `Session file not found: ${origin}. Create it by signing in once in a browser window: demohunter session capture <sign-in URL>`,
      );
    }
    throw new SessionFileError(`Could not read session file ${origin}: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new SessionFileError(`Session file ${origin} is not valid JSON. Recreate it and retry.`);
  }

  if (
    typeof parsed !== "object"
    || parsed === null
    || !Array.isArray((parsed as { cookies?: unknown }).cookies)
    || !Array.isArray((parsed as { origins?: unknown }).origins ?? [])
  ) {
    throw new SessionFileError(
      `Session file ${origin} is not a Playwright storage-state file (expected { "cookies": [...], "origins": [...] }). Recreate it and retry.`,
    );
  }

  const state = parsed as { cookies: unknown[]; origins?: unknown[] };

  return {
    cookies: state.cookies.flatMap((cookie) => {
      const { domain, expires } = (cookie ?? {}) as { domain?: unknown; expires?: unknown };
      return typeof domain === "string" && typeof expires === "number" ? [{ domain, expires }] : [];
    }),
    originCount: state.origins?.length ?? 0,
  };
}

export type GitIgnoreStatus = "ignored" | "not-ignored" | "outside-work-tree" | "unknown";

/** Whether git would let the session file be committed. The file may not exist yet. */
export async function readGitIgnoreStatus(filePath: string): Promise<GitIgnoreStatus> {
  const cwd = await nearestExistingDirectory(path.dirname(filePath));

  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "unknown" : "outside-work-tree";
  }

  try {
    await execFileAsync("git", ["check-ignore", "--quiet", filePath], { cwd });
    return "ignored";
  } catch (error) {
    return (error as { code?: unknown }).code === 1 ? "not-ignored" : "unknown";
  }
}

async function nearestExistingDirectory(directory: string): Promise<string> {
  let current = directory;

  while (true) {
    try {
      if ((await stat(current)).isDirectory()) {
        return current;
      }
    } catch {
      // Keep walking up until an existing directory is found.
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
}
