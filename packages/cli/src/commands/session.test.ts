import { afterEach, describe, expect, mock, test } from "bun:test";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright";

import { DEFAULT_DEMOHUNTER_CONFIG, DEFAULT_RECORD_CONFIG, DEFAULT_TTS_CONFIG } from "../../../sdk/src/index.js";
import { sessionCaptureCommand } from "./session.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { force: true, recursive: true })));
});

describe("sessionCaptureCommand", () => {
  test("saves the storage state after the user presses Enter, readable only by the owner", async () => {
    const harness = await createHarness({ launch: { channel: "chrome", locale: "en-US", timezoneId: "UTC" } });

    await sessionCaptureCommand(harness.cwd, { startUrl: "https://www.notion.so/login" }, harness.dependencies);

    expect(harness.launch).toHaveBeenCalledWith({ channel: "chrome", headless: false });
    expect(harness.newContext).toHaveBeenCalledWith({ viewport: null, locale: "en-US", timezoneId: "UTC" });
    expect(harness.goto).toHaveBeenCalledWith("https://www.notion.so/login");
    expect(harness.storageState).toHaveBeenCalledWith({ indexedDB: true });
    expect(harness.closeBrowser).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(harness.sessionPath, "utf8"))).toEqual(STORAGE_STATE);
    expect((await stat(harness.sessionPath)).mode & 0o777).toBe(0o600);
    expect(harness.output()).toContain(`save the session to ${path.join("..", "sessions", "app.json")}`);
    expect(harness.output()).not.toContain("cookie-secret");
  });

  test("writes to --out relative to the working directory and explains how to load it", async () => {
    const harness = await createHarness();

    await sessionCaptureCommand(
      harness.cwd,
      { startUrl: "https://app.slack.com", out: "../other/slack.json" },
      harness.dependencies,
    );

    await access(path.join(harness.root, "other", "slack.json"));
    expect(harness.output()).toContain("DEMOHUNTER_STORAGE_STATE=../other/slack.json");
  });

  test("writes nothing and closes the browser when the user cancels", async () => {
    const harness = await createHarness({ confirm: false });

    await expect(
      sessionCaptureCommand(harness.cwd, { startUrl: "https://www.notion.so/login" }, harness.dependencies),
    ).rejects.toThrow("Session capture cancelled. Nothing was saved.");

    expect(harness.storageState).not.toHaveBeenCalled();
    expect(harness.closeBrowser).toHaveBeenCalledTimes(1);
    await expect(access(harness.sessionPath)).rejects.toThrow();
  });

  test.each([
    ["inside outputDir", { out: ".demohunter/app.json" }, "Refusing to write the session inside outputDir"],
    ["inside cacheDir", { out: "tmp/cache/app.json" }, "Refusing to write the session inside cacheDir"],
    ["for an unexpanded ~ in --out", { out: "~/sessions/app.json" }, '--out starts with "~", which DemoHunter does not expand'],
    ["committable by git", { gitStatus: "not-ignored" as const }, "it is inside a git work tree and not ignored"],
    ["without a destination", { session: false }, "Pass --out <path>, or set session.storageState"],
    ["for a non-web start URL", { startUrl: "file:///etc/passwd" }, "session capture needs an http(s) start URL"],
  ])("refuses to open a browser %s", async (_label, input, message) => {
    const harness = await createHarness(input);

    await expect(
      sessionCaptureCommand(
        harness.cwd,
        { startUrl: input.startUrl ?? "https://www.notion.so/login", ...(input.out === undefined ? {} : { out: input.out }) },
        harness.dependencies,
      ),
    ).rejects.toThrow(message);

    expect(harness.launch).not.toHaveBeenCalled();
  });

  test("captures cookies and local storage from a real browser into a file that signs a new context in", async () => {
    const harness = await createHarness();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const signedIn = (request.headers.get("cookie") ?? "").includes("sid=captured-secret");
        return new Response(
          `<h1>${signedIn ? "Signed in" : "Sign in"}</h1><script>localStorage.setItem("prefs", "dark")</script>`,
          {
            headers: {
              "content-type": "text/html",
              ...(new URL(request.url).pathname === "/login" ? { "set-cookie": "sid=captured-secret; Path=/; HttpOnly" } : {}),
            },
          },
        );
      },
    });

    try {
      await sessionCaptureCommand(harness.cwd, { startUrl: `${server.url.origin}/login` }, {
        ...harness.dependencies,
        playwright: {
          ...harness.dependencies.playwright,
          // No display is available in tests; the command itself always asks for a visible window.
          chromium: { launch: (options) => chromium.launch({ ...options, headless: true }) } as never,
        },
      });

      const saved = JSON.parse(await readFile(harness.sessionPath, "utf8")) as {
        cookies: Array<{ name: string; value: string }>;
        origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
      };
      expect(saved.cookies.map(({ name, value }) => ({ name, value }))).toEqual([{ name: "sid", value: "captured-secret" }]);
      expect(saved.origins[0]?.localStorage).toContainEqual({ name: "prefs", value: "dark" });

      const browser = await chromium.launch();
      try {
        const context = await browser.newContext({ storageState: harness.sessionPath });
        const page = await context.newPage();
        await page.goto(`${server.url.origin}/app`);
        expect(await page.locator("h1").innerText()).toBe("Signed in");
      } finally {
        await browser.close();
      }
    } finally {
      server.stop(true);
    }
  }, 30_000);
});

const STORAGE_STATE = {
  cookies: [{ name: "token_v2", value: "cookie-secret", domain: ".notion.so", path: "/", expires: -1 }],
  origins: [],
};

async function createHarness(options: {
  confirm?: boolean;
  gitStatus?: "ignored" | "not-ignored" | "outside-work-tree" | "unknown";
  launch?: { channel?: string; headless?: boolean; locale?: string; timezoneId?: string };
  session?: false;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "demohunter-session-capture-"));
  tempRoots.push(root);
  const cwd = path.join(root, "project");
  const sessionPath = path.join(root, "sessions", "app.json");
  const messages: string[] = [];
  const goto = mock(async () => null);
  const storageState = mock(async () => STORAGE_STATE);
  const newContext = mock(async () => ({ newPage: mock(async () => ({ goto })), storageState }));
  const closeBrowser = mock(async () => {});
  const launch = mock(async () => ({ close: closeBrowser, newContext }));

  return {
    closeBrowser,
    cwd,
    dependencies: {
      loadConfig: async () => ({
        projectRoot: cwd,
        configPath: path.join(cwd, "demohunter.config.ts"),
        config: {
          baseURL: "https://www.notion.so",
          outputDir: path.join(cwd, DEFAULT_DEMOHUNTER_CONFIG.outputDir),
          cacheDir: path.join(cwd, "tmp/cache"),
          browser: DEFAULT_DEMOHUNTER_CONFIG.browser,
          viewport: DEFAULT_DEMOHUNTER_CONFIG.viewport,
          holdPaddingMs: DEFAULT_DEMOHUNTER_CONFIG.holdPaddingMs,
          record: DEFAULT_RECORD_CONFIG,
          output: DEFAULT_DEMOHUNTER_CONFIG.output,
          tts: DEFAULT_TTS_CONFIG,
          ...(options.session === false ? {} : { session: { storageState: sessionPath, source: "config" as const } }),
          ...(options.launch === undefined ? {} : { launch: options.launch }),
        },
      }),
      log: (message: string) => {
        messages.push(message);
      },
      playwright: {
        chromium: { launch } as never,
        firefox: { launch: mock(async () => { throw new Error("unexpected browser"); }) } as never,
        webkit: { launch: mock(async () => { throw new Error("unexpected browser"); }) } as never,
      },
      readGitIgnoreStatus: mock(async () => options.gitStatus ?? "outside-work-tree"),
      waitForEnter: mock(async () => options.confirm ?? true),
    },
    goto,
    launch,
    newContext,
    output: () => messages.join("\n"),
    root,
    sessionPath,
    storageState,
  };
}
