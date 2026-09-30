import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliEntryPoint = path.join(repoRoot, "packages/cli/src/bin/demohunter.ts");
const generationTimeoutMs = 60_000;
const tempRoots: string[] = [];

const SESSION_COOKIE = "e2e-session-cookie-7f3a91c2";
const LOCAL_STORAGE_VALUE = "e2e-local-storage-9c61e4";
const QUERY_SECRET = "e2e-account-query-5d20b8";

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const signedIn = (request.headers.get("cookie") ?? "").includes(`demo_session=${SESSION_COOKIE}`);
      return new Response(signedIn ? SIGNED_IN_PAGE : SIGN_IN_PAGE, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { force: true, recursive: true })));
});

describe("session storage state", () => {
  test("fails before launching a browser when the session file is missing", async () => {
    const project = await makeProject();

    const result = await runCli(project.cwd, ["generate", "demos/session.tour.ts"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `Session file not found: ${path.join("..", "sessions", "demo-state.json")} (from session.storageState).`,
    );
    expect(result.stderr).toContain("--save-storage=");
    expect(result.stdout).not.toContain("Launching chromium");
  }, generationTimeoutMs);

  test("tells the user to recreate the session when the app shows its sign-in page", async () => {
    const project = await makeProject();
    await project.writeSession("revoked-cookie-value");

    const result = await runCli(project.cwd, ["generate", "demos/session.tour.ts"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Timeout 3000ms exceeded");
    expect(result.stderr).toContain(
      "A session file was loaded (source: config). If the app showed a sign-in page, the session has expired or was revoked.",
    );
  }, generationTimeoutMs);

  test("records the signed-in app in both passes and keeps session material out of the output", async () => {
    const project = await makeProject();
    await project.writeSession(SESSION_COOKIE);

    const result = await runCli(project.cwd, ["generate", "demos/session.tour.ts"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Session: loading storage state from session.storageState (config) into 2 browser passes",
    );
    await access(path.join(project.outputDir, "video.mp4"));
    await access(path.join(project.outputDir, "manifest.json"));
    await access(path.join(project.outputDir, "captions.vtt"));
    await access(path.join(project.outputDir, "chapters.json"));
    await expectNoSessionMaterial(project, `${result.stdout}\n${result.stderr}`);
  }, generationTimeoutMs);

  test("writes redacted debug artifacts when the recorded pass fails under a session", async () => {
    const project = await makeProject();
    await project.writeSession(SESSION_COOKIE);

    const result = await runCli(project.cwd, ["generate", "demos/session.tour.ts"], {
      DEMOHUNTER_E2E_FAIL_RECORDING: "1",
    });

    expect(result.exitCode).toBe(1);
    const debugRuns = await readdir(path.join(project.outputDir, "debug"));
    expect(debugRuns).toHaveLength(1);
    const debugDir = path.join(project.outputDir, "debug", debugRuns[0]!);
    expect((await readdir(debugDir)).sort()).toEqual(["failure.json", "screenshot.png"]);
    const failure = JSON.parse(await readFile(path.join(debugDir, "failure.json"), "utf8")) as {
      failedRequests: Array<{ url: string }>;
      page: { url: string };
      phase: string;
    };
    expect(failure.phase).toBe("record-replay");
    expect(failure.page.url).toBe(`${server.url.origin}/`);
    expect(failure.failedRequests.map((request) => request.url)).toContain("http://127.0.0.1:1/sync");
    await expectNoSessionMaterial(project, `${result.stdout}\n${result.stderr}`);
  }, generationTimeoutMs);
});

async function makeProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), "demohunter-session-e2e-"));
  tempRoots.push(root);
  const cwd = path.join(root, "project");
  const sessionPath = path.join(root, "sessions", "demo-state.json");
  await mkdir(path.join(cwd, "demos"), { recursive: true });
  await writeFile(
    path.join(cwd, "demohunter.config.ts"),
    `export default {
  baseURL: ${JSON.stringify(`${server.url.origin}/?view=home&account=${QUERY_SECRET}`)},
  session: { storageState: "../sessions/demo-state.json" },
  record: { showActions: false },
};
`,
  );
  await writeFile(path.join(cwd, "demos", "session.tour.ts"), TOUR_SOURCE);

  return {
    cwd,
    outputDir: path.join(cwd, ".demohunter", "session-e2e"),
    sessionPath,
    async writeSession(cookieValue: string) {
      await mkdir(path.dirname(sessionPath), { recursive: true });
      await writeFile(sessionPath, JSON.stringify({
        cookies: [{
          name: "demo_session",
          value: cookieValue,
          domain: "127.0.0.1",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        }],
        origins: [{
          origin: server.url.origin,
          localStorage: [{ name: "demo_token", value: LOCAL_STORAGE_VALUE }],
        }],
      }));
    },
  };
}

async function expectNoSessionMaterial(
  project: Awaited<ReturnType<typeof makeProject>>,
  terminalOutput: string,
): Promise<void> {
  const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: project.outputDir, dot: true, onlyFiles: true }));
  expect(files.length).toBeGreaterThan(0);
  const forbidden = [SESSION_COOKIE, LOCAL_STORAGE_VALUE, QUERY_SECRET, project.sessionPath, "demo-state.json"];

  for (const file of files) {
    const contents = await readFile(path.join(project.outputDir, file));
    for (const value of forbidden) {
      expect({ file, leaked: contents.includes(value) ? value : undefined }).toEqual({ file, leaked: undefined });
    }
  }

  expect(terminalOutput).not.toContain(SESSION_COOKIE);
  expect(terminalOutput).not.toContain(LOCAL_STORAGE_VALUE);
}

async function runCli(
  cwd: string,
  args: string[],
  envOverrides: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...envOverrides };
  delete env.DEMOHUNTER_STORAGE_STATE;
  const processResult = Bun.spawn({
    cmd: [process.execPath, cliEntryPoint, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    processResult.exited,
    new Response(processResult.stdout).text(),
    new Response(processResult.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
}

const SIGN_IN_PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Sign in</title></head>
  <body><main><h1>Sign in</h1></main></body>
</html>
`;

const SIGNED_IN_PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Demo workspace</title></head>
  <body>
    <main>
      <h1>Demo workspace</h1>
      <button type="button" id="open-report">Open report</button>
      <p id="report" hidden>Report ready</p>
      <button type="button" id="sync">Sync</button>
    </main>
    <script>
      document.querySelector("#open-report").addEventListener("click", () => {
        document.querySelector("#report").hidden = false;
      });
      document.querySelector("#sync").addEventListener("click", () => {
        fetch("http://127.0.0.1:1/sync?token=${QUERY_SECRET}").catch(() => {});
      });
    </script>
  </body>
</html>
`;

// A plain object export keeps the temp project free of installs.
const TOUR_SOURCE = `let runs = 0;

export default {
  id: "session-e2e",
  title: "Session e2e",
  async beforeRecord({ page }) {
    await page.getByRole("heading", { name: "Demo workspace" }).waitFor({ timeout: 3_000 });
  },
  async run({ page, chapter, step, click }) {
    runs += 1;
    await chapter("Workspace");
    await step("Open the report", async () => {
      await click(page.getByRole("button", { name: "Open report" }));
      await page.getByText("Report ready").waitFor();
    });

    // Fail only in the recorded pass, whose debug capture writes artifacts.
    if (process.env.DEMOHUNTER_E2E_FAIL_RECORDING === "1" && runs === 2) {
      await page.getByRole("button", { name: "Sync" }).click();
      await page.waitForTimeout(300);
      await page.getByRole("button", { name: "Missing" }).click({ timeout: 500 });
    }
  },
};
`;
