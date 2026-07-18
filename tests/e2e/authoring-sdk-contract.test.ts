import { afterEach, describe, expect, test } from "bun:test";
import { access, cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getDemohunterTarballPath } from "../helpers/demohunter-tarball.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliEntryPoint = path.join(repoRoot, "packages/cli/src/bin/demohunter.ts");
const authoringFixturePath = path.join(repoRoot, "tests/fixtures/tours/phase-02-authoring.tour.ts");
const authoredNoNarrationFixture = `import { defineTour } from "demohunter";

export default defineTour({
  id: "phase-02-authoring",
  title: "Phase 2 authoring contract",
  async setup({ page }) {
    await page.getByLabel("Email").fill("demo@demohunter.dev");
    await page.getByLabel("Password").fill("demo-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Workspace home" }).waitFor();
  },
  async run({ page, chapter, step, waitForStable, highlight, snapshot, assertVisible }) {
    await chapter("Workspace Settings", { id: "workspace-settings" });

    await step("Open the settings panel", async () => {
      const openSettingsButton = page.getByRole("button", { name: "Open settings" });
      await highlight(openSettingsButton, {
        name: "open-settings-button",
        paddingPx: 12,
      });
      await openSettingsButton.click();
      await waitForStable({ state: "load", timeoutMs: 1_000 });
      await assertVisible(page.getByRole("heading", { name: "Workspace Settings" }), {
        timeoutMs: 1_000,
      });
      await snapshot({ name: "workspace-settings-open" });
    });
  },
  async teardown({ page }) {
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("button", { name: "Sign in" }).waitFor();
  },
});
`;
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { force: true, recursive: true })));
});

describe("authoring sdk contract", () => {
  test(
    "runs a defineTour fixture from a fresh temp repo via the source cli",
    async () => {
      const cwd = await makeTempProject();
      const tourPath = "demos/phase-02-authoring.tour.ts";

      await writeTempRepoPackageJson(cwd);
      await writeTempRepoConfig(cwd);
      await writeTempRepoSite(cwd);
      await mkdir(path.join(cwd, "demos"), { recursive: true });
      await writeFile(path.join(cwd, tourPath), authoredNoNarrationFixture);

      const installResult = await spawnCommand([process.execPath, "install"], cwd);
      expect(installResult.exitCode).toBe(0);

      const generateResult = await spawnCommand([process.execPath, cliEntryPoint, "generate", tourPath], cwd);
      expect(generateResult.exitCode).toBe(0);

      const outputDir = path.join(cwd, ".demohunter/phase-02-authoring");
      const chaptersPath = path.join(outputDir, "chapters.json");
      const videoPath = path.join(outputDir, "video.mp4");
      const chapters = JSON.parse(await readFile(chaptersPath, "utf8")) as Array<{
        startMs: number;
        title: string;
      }>;

      await access(videoPath);
      await access(path.join(outputDir, "captions.srt"));
      await access(path.join(outputDir, "captions.vtt"));
      await access(path.join(outputDir, "manifest.json"));
      await access(path.join(outputDir, "poster.jpg"));
      await expect(access(path.join(outputDir, "audio"))).rejects.toThrow();
      expect(chapters).toHaveLength(1);
      expect(chapters[0]?.title).toBe("Workspace Settings");
      expect(chapters[0]?.startMs).toBeGreaterThanOrEqual(0);
      expect((await readdir(outputDir)).sort()).toEqual([
        "captions.srt",
        "captions.vtt",
        "chapters.json",
        "manifest.json",
        "poster.jpg",
        "video.mp4",
      ]);
    },
    45_000,
  );

  test("keeps bootstrap logic in setup with plain Playwright page actions", async () => {
    const fixtureSource = await readFile(authoringFixturePath, "utf8");

    expect(fixtureSource).toContain("async setup({ page })");
    expect(fixtureSource).toContain('page.getByLabel("Email").fill("demo@demohunter.dev")');
    expect(fixtureSource).toContain('page.getByRole("button", { name: "Sign in" }).click()');
    expect(fixtureSource).not.toContain("login(");
  });
});

async function makeTempProject(): Promise<string> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "demohunter-authoring-sdk-"));
  tempRoots.push(tempRoot);
  return tempRoot;
}

async function writeTempRepoPackageJson(cwd: string): Promise<void> {
  const tarballPath = await getDemohunterTarballPath();
  await writeFile(
    path.join(cwd, "package.json"),
    `${JSON.stringify(
      {
        name: "phase-02-authoring-contract",
        private: true,
        type: "module",
        dependencies: {
          demohunter: `file:${tarballPath}`,
        },
      },
      null,
      2,
    )}\n`,
  );
}

async function writeTempRepoConfig(cwd: string): Promise<void> {
  const sitePath = path.join(cwd, "site", "index.html");

  await writeFile(
    path.join(cwd, "demohunter.config.ts"),
    `export default {
  baseURL: ${JSON.stringify(pathToFileURL(sitePath).href)},
};
`,
  );
}

async function writeTempRepoSite(cwd: string): Promise<void> {
  const siteDir = path.join(cwd, "site");
  await mkdir(siteDir, { recursive: true });
  await writeFile(
    path.join(siteDir, "index.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Phase 2 Authoring Contract</title>
  </head>
  <body>
    <main>
      <form id="login-form">
        <label>
          Email
          <input aria-label="Email" />
        </label>
        <label>
          Password
          <input aria-label="Password" type="password" />
        </label>
        <button type="button" id="sign-in">Sign in</button>
      </form>

      <section id="dashboard" hidden>
        <h1>Workspace home</h1>
        <button type="button" id="open-settings">Open settings</button>
        <section id="settings-panel" hidden>
          <h2>Workspace Settings</h2>
          <button type="button" id="save-settings">Save settings</button>
          <p id="settings-status" hidden>Settings saved</p>
        </section>
        <button type="button" id="sign-out">Sign out</button>
      </section>
    </main>

    <script type="module">
      const loginForm = document.querySelector("#login-form");
      const dashboard = document.querySelector("#dashboard");
      const settingsPanel = document.querySelector("#settings-panel");
      const settingsStatus = document.querySelector("#settings-status");

      document.querySelector("#sign-in")?.addEventListener("click", () => {
        loginForm.hidden = true;
        dashboard.hidden = false;
      });

      document.querySelector("#open-settings")?.addEventListener("click", () => {
        settingsPanel.hidden = false;
      });

      document.querySelector("#save-settings")?.addEventListener("click", () => {
        settingsStatus.hidden = false;
      });

      document.querySelector("#sign-out")?.addEventListener("click", () => {
        settingsPanel.hidden = true;
        settingsStatus.hidden = true;
        dashboard.hidden = true;
        loginForm.hidden = false;
      });
    </script>
  </body>
</html>
`,
  );
}

async function spawnCommand(
  cmd: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const processResult = Bun.spawn({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    processResult.exited,
    new Response(processResult.stdout).text(),
    new Response(processResult.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
}
