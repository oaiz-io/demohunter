import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_DEMOHUNTER_CONFIG, DEFAULT_RECORD_CONFIG, DEFAULT_TTS_CONFIG } from "../../../sdk/src/index.js";
import { doctorCommand } from "./doctor.js";

describe("doctorCommand", () => {
  test("prints passing checks as JSON", async () => {
    const log = mock(() => {});
    const launch = mock(async () => ({
      close: mock(async () => {}),
    }));

    await doctorCommand("/tmp/project", {
      checkCommand: mock(async () => {}),
      fetch: mock(async () => new Response("ok", { status: 200 })) as never,
      loadConfig: async () => makeLoadedConfig("/tmp/project"),
      log,
      playwright: {
        chromium: { launch } as never,
        firefox: { launch: mock(async () => { throw new Error("unexpected browser"); }) } as never,
        webkit: { launch: mock(async () => { throw new Error("unexpected browser"); }) } as never,
      },
    });

    const parsed = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      ok: boolean;
      checks: Array<{ name: string; status: string }>;
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.checks.map((check) => check.name)).toContain("config");
    expect(parsed.checks.map((check) => check.name)).toContain("ffmpeg");
    expect(parsed.checks.map((check) => check.name)).toContain("ffprobe");
    expect(parsed.checks.map((check) => check.name)).toContain("baseURL");
  });

  test("warns without failing when the installed Playwright is older than 1.61", async () => {
    const log = mock(() => {});

    await doctorCommand("/tmp/project", {
      checkCommand: mock(async () => {}),
      fetch: mock(async () => new Response("ok", { status: 200 })) as never,
      getPlaywrightVersion: () => "1.59.1",
      loadConfig: async () => makeLoadedConfig("/tmp/project"),
      log,
      playwright: {
        chromium: { launch: mock(async () => ({ close: mock(async () => {}) })) } as never,
        firefox: { launch: mock(async () => { throw new Error("unexpected browser"); }) } as never,
        webkit: { launch: mock(async () => { throw new Error("unexpected browser"); }) } as never,
      },
    });

    const parsed = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      ok: boolean;
      checks: Array<{ name: string; status: string; message: string }>;
    };
    const playwrightVersion = parsed.checks.find((check) => check.name === "playwright version");

    expect(parsed.ok).toBe(true);
    expect(playwrightVersion?.status).toBe("warn");
    expect(playwrightVersion?.message).toContain("1.61");
  });

  test("passes the Playwright version check when 1.61 or newer is installed", async () => {
    const log = mock(() => {});

    await doctorCommand("/tmp/project", {
      checkCommand: mock(async () => {}),
      fetch: mock(async () => new Response("ok", { status: 200 })) as never,
      getPlaywrightVersion: () => "1.61.0",
      loadConfig: async () => makeLoadedConfig("/tmp/project"),
      log,
      playwright: {
        chromium: { launch: mock(async () => ({ close: mock(async () => {}) })) } as never,
        firefox: { launch: mock(async () => { throw new Error("unexpected browser"); }) } as never,
        webkit: { launch: mock(async () => { throw new Error("unexpected browser"); }) } as never,
      },
    });

    const parsed = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      ok: boolean;
      checks: Array<{ name: string; status: string }>;
    };
    const playwrightVersion = parsed.checks.find((check) => check.name === "playwright version");

    expect(playwrightVersion?.status).toBe("pass");
  });

  test("throws after printing JSON when a required check fails", async () => {
    const log = mock(() => {});

    await expect(
      doctorCommand("/tmp/project", {
        checkCommand: mock(async (command) => {
          if (command === "ffmpeg") {
            throw new Error("missing ffmpeg");
          }
        }),
        fetch: mock(async () => new Response("ok", { status: 200 })) as never,
        loadConfig: async () => makeLoadedConfig("/tmp/project"),
        log,
        playwright: {
          chromium: {
            launch: mock(async () => ({
              close: mock(async () => {}),
            })),
          } as never,
          firefox: { launch: mock(async () => { throw new Error("unexpected browser"); }) } as never,
          webkit: { launch: mock(async () => { throw new Error("unexpected browser"); }) } as never,
        },
      }),
    ).rejects.toThrow("Doctor found failing checks.");

    const parsed = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      ok: boolean;
      checks: Array<{ name: string; status: string; message: string }>;
    };
    const ffmpeg = parsed.checks.find((check) => check.name === "ffmpeg");

    expect(parsed.ok).toBe(false);
    expect(ffmpeg?.status).toBe("fail");
    expect(ffmpeg?.message).toBe("missing ffmpeg");
  });
});

describe("doctorCommand session checks", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { force: true, recursive: true })));
  });

  async function runDoctorWithSession(input: {
    cookies?: unknown[];
    gitStatus?: "ignored" | "not-ignored" | "outside-work-tree" | "unknown";
    writeFile?: boolean;
  }) {
    const root = await mkdtemp(path.join(os.tmpdir(), "demohunter-doctor-session-"));
    tempRoots.push(root);
    const storageState = path.join(root, "sessions", "app.json");
    if (input.writeFile !== false) {
      await mkdir(path.dirname(storageState), { recursive: true });
      await writeFile(storageState, JSON.stringify({ cookies: input.cookies ?? [], origins: [] }));
    }
    const log = mock(() => {});
    const loadedConfig = makeLoadedConfig(root);
    const readGitIgnoreStatus = mock(async () => input.gitStatus ?? "outside-work-tree");

    const outcome = await doctorCommand(root, {
      checkCommand: mock(async () => {}),
      fetch: mock(async () => new Response("ok", { status: 200 })) as never,
      getPlaywrightVersion: () => "1.61.0",
      loadConfig: async () => ({
        ...loadedConfig,
        config: {
          ...loadedConfig.config,
          baseURL: "https://www.notion.so",
          session: { storageState, source: "config" as const },
        },
      }),
      log,
      playwright: {
        chromium: { launch: mock(async () => ({ close: mock(async () => {}) })) } as never,
        firefox: { launch: mock(async () => { throw new Error("unexpected browser"); }) } as never,
        webkit: { launch: mock(async () => { throw new Error("unexpected browser"); }) } as never,
      },
      readGitIgnoreStatus,
    }).then(() => "ok", () => "failed");
    const output = String(log.mock.calls[0]?.[0]);
    const parsed = JSON.parse(output) as { checks: Array<{ name: string; status: string; message: string }> };

    return {
      outcome,
      output,
      readGitIgnoreStatus,
      session: (name: string) => parsed.checks.find((check) => check.name === name),
      storageState,
    };
  }

  test("reports the file, git status, and earliest cookie expiry without cookie names or values", async () => {
    const result = await runDoctorWithSession({
      cookies: [
        { name: "token_v2", value: "cookie-secret-1", domain: ".notion.so", path: "/", expires: 4_102_444_800 },
        { name: "notion_browser_id", value: "cookie-secret-2", domain: "www.notion.so", path: "/", expires: 4_133_980_800 },
        { name: "tracker", value: "cookie-secret-3", domain: ".example.com", path: "/", expires: 946_684_800 },
      ],
      gitStatus: "ignored",
    });

    expect(result.outcome).toBe("ok");
    expect(result.session("session file")).toEqual({
      name: "session file",
      status: "pass",
      message: "session.storageState (config) is a Playwright storage-state file with 3 cookies and 0 origins",
    });
    expect(result.session("session git status")).toEqual({
      name: "session git status",
      status: "pass",
      message: "The session file is ignored by git",
    });
    expect(result.session("session cookies")).toEqual({
      name: "session cookies",
      status: "pass",
      message: "2 unexpired cookies for www.notion.so; the earliest expires on 2100-01-01",
    });
    expect(result.readGitIgnoreStatus).toHaveBeenCalledWith(result.storageState);
    for (const secret of ["token_v2", "notion_browser_id", "tracker", "cookie-secret"]) {
      expect(result.output).not.toContain(secret);
    }
  });

  test("warns when the file could be committed or its cookies have expired", async () => {
    const expired = await runDoctorWithSession({
      cookies: [{ name: "token_v2", value: "cookie-secret", domain: ".notion.so", path: "/", expires: 946_684_800 }],
      gitStatus: "not-ignored",
    });
    const unrelated = await runDoctorWithSession({
      cookies: [{ name: "sid", value: "cookie-secret", domain: ".slack.com", path: "/", expires: -1 }],
    });

    expect(expired.outcome).toBe("ok");
    expect(expired.session("session git status")?.status).toBe("warn");
    expect(expired.session("session git status")?.message).toContain("add it to .gitignore");
    expect(expired.session("session cookies")).toEqual({
      name: "session cookies",
      status: "warn",
      message: "Every cookie for www.notion.so has expired (1 cookie). Recreate the session file.",
    });
    expect(unrelated.session("session cookies")?.status).toBe("warn");
    expect(unrelated.session("session cookies")?.message).toContain("No cookies in the session file apply to www.notion.so");
  });

  test("fails when the configured session file is missing", async () => {
    const result = await runDoctorWithSession({ writeFile: false });

    expect(result.outcome).toBe("failed");
    expect(result.session("session file")?.status).toBe("fail");
    expect(result.session("session file")?.message).toContain("Session file not found");
    expect(result.session("session cookies")).toBeUndefined();
  });
});

function makeLoadedConfig(cwd: string) {
  return {
    projectRoot: cwd,
    configPath: path.join(cwd, "demohunter.config.ts"),
    config: {
      baseURL: "http://localhost:3000",
      outputDir: path.join(cwd, DEFAULT_DEMOHUNTER_CONFIG.outputDir),
      cacheDir: path.join(cwd, DEFAULT_DEMOHUNTER_CONFIG.cacheDir),
      browser: DEFAULT_DEMOHUNTER_CONFIG.browser,
      viewport: DEFAULT_DEMOHUNTER_CONFIG.viewport,
      holdPaddingMs: DEFAULT_DEMOHUNTER_CONFIG.holdPaddingMs,
      record: DEFAULT_RECORD_CONFIG,
      tts: DEFAULT_TTS_CONFIG,
    },
  };
}
