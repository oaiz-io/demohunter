import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { SessionFileError, readGitIgnoreStatus, readStorageStateFile } from "./session-file.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { force: true, recursive: true })));
});

describe("readStorageStateFile", () => {
  test("summarizes cookie domains, expiry, and origins", async () => {
    const root = await makeTempRoot();
    const storageState = path.join(root, "state.json");
    await writeFile(storageState, JSON.stringify({
      cookies: [
        { name: "token_v2", value: "secret-cookie", domain: ".notion.so", path: "/", expires: 1_900_000_000 },
        { name: "session", value: "other-secret", domain: "www.notion.so", path: "/", expires: -1 },
      ],
      origins: [{ origin: "https://www.notion.so", localStorage: [] }],
    }));

    await expect(readStorageStateFile({ storageState, source: "config" }, root)).resolves.toEqual({
      cookies: [
        { domain: ".notion.so", expires: 1_900_000_000 },
        { domain: "www.notion.so", expires: -1 },
      ],
      originCount: 1,
    });
  });

  test("explains how to create a missing session file", async () => {
    const root = await makeTempRoot();
    const storageState = path.join(root, "sessions", "app.json");

    const error = await readStorageStateFile({ storageState, source: "env" }, root).catch((caught) => caught);

    expect(error).toBeInstanceOf(SessionFileError);
    expect(error.message).toBe(
      `Session file not found: ${path.join("sessions", "app.json")} (from DEMOHUNTER_STORAGE_STATE). Create it by signing in once in a browser window: npx playwright open --save-storage=${path.join("sessions", "app.json")} <sign-in URL>`,
    );
  });

  test("rejects invalid JSON and other shapes without quoting the file", async () => {
    const root = await makeTempRoot();
    const invalidJson = path.join(root, "invalid.json");
    const wrongShape = path.join(root, "wrong-shape.json");
    await writeFile(invalidJson, '{"cookies": [{"value": "leaked-secret"');
    await writeFile(wrongShape, JSON.stringify({ token: "leaked-secret" }));

    const invalidError = await readStorageStateFile({ storageState: invalidJson, source: "config" }, root)
      .catch((caught) => caught);
    const shapeError = await readStorageStateFile({ storageState: wrongShape, source: "config" }, root)
      .catch((caught) => caught);

    expect(invalidError.message).toBe(
      "Session file invalid.json (from session.storageState) is not valid JSON. Recreate it and retry.",
    );
    expect(shapeError.message).toContain("is not a Playwright storage-state file");
    expect(`${invalidError.message}${shapeError.message}`).not.toContain("leaked-secret");
  });
});

describe("readGitIgnoreStatus", () => {
  test("reports files outside any git work tree", async () => {
    const root = await makeTempRoot();

    expect(await readGitIgnoreStatus(path.join(root, "sessions", "app.json"))).toBe("outside-work-tree");
  });

  test("distinguishes ignored and committable paths, even before the file exists", async () => {
    const root = await makeTempRoot();
    await execFileAsync("git", ["init", "--quiet"], { cwd: root });
    await writeFile(path.join(root, ".gitignore"), ".demohunter-sessions/\n");
    await mkdir(path.join(root, "demos"));

    expect(await readGitIgnoreStatus(path.join(root, ".demohunter-sessions", "app.json"))).toBe("ignored");
    expect(await readGitIgnoreStatus(path.join(root, "demos", "app.json"))).toBe("not-ignored");
  });
});

async function makeTempRoot(): Promise<string> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "demohunter-session-file-"));
  tempRoots.push(tempRoot);
  return tempRoot;
}
