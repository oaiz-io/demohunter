import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { _electron, type ElectronApplication } from "playwright";

const require = createRequire(import.meta.url);
// Needs a display (macOS, or Linux with X) and the Electron binary. The
// display check comes first: loading "electron" downloads it if missing.
const display = process.platform === "darwin" || !!process.env.DISPLAY;
let electron = "";
if (display)
  try {
    electron = require("electron") as unknown as string;
  } catch {}
const runnable = display && !!electron;
const here = import.meta.dir;
const shots = process.env.DESKTOP_SHOTS;
let app: ElectronApplication | undefined;
const temp: string[] = [];

async function tmp(prefix: string) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temp.push(dir);
  return dir;
}
async function launch(userData: string, args: string[] = [], env: Record<string, string> = {}) {
  app = await _electron.launch({
    executablePath: electron,
    args: [here, ...args],
    env: { ...process.env, DEMOHUNTER_DESKTOP_USER_DATA: userData, DEMOHUNTER_DESKTOP_DRY_SHELL: "1", ...env } as Record<string, string>,
    timeout: 30_000,
  });
  const page = await app.firstWindow();
  return { app, page };
}
afterEach(async () => {
  await app?.close().catch(() => {});
  app = undefined;
  await Promise.all(temp.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}, 30_000);

describe.skipIf(!runnable)("desktop app", () => {
  test("first launch shows the welcome window with the app icon", async () => {
    const { app, page } = await launch(await tmp("dh-desktop-data-"));
    await page.waitForURL("app://ui/welcome.html");
    await page.getByRole("button", { name: /Open repository/ }).waitFor();
    expect(await page.title()).toBe("DemoHunter Studio");
    expect(await page.locator(".empty").textContent()).toContain("Open a repository");
    // Icon and bundled fonts load through the app:// protocol.
    expect(await page.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1024);
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.fonts.check('13px "Geist"'))).toBe(true);
    // Only the shell's own pages are served.
    expect(await page.evaluate(() => fetch("app://ui/../main.cjs").then((r) => r.status))).toBe(404);
    const info = await app.evaluate(({ app }) => ({ name: app.getName() }));
    expect(info.name).toBe("DemoHunter Studio");
    if (shots) await page.screenshot({ path: path.join(shots, "welcome.png") });
  }, 60_000);

  test("opens a repository in Studio, remembers it and the window size", async () => {
    const userData = await tmp("dh-desktop-data-");
    const repo = await tmp("dh-desktop-repo-");
    const first = await launch(userData, [repo]);
    await first.page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 45_000 });
    await first.page.waitForFunction(() => document.body.classList.contains("desktop"));
    // Exports open in place: only export results inside the opened folder,
    // even when it is reached through a symlink (/var → /private/var).
    const exportDir = path.join(repo, ".demohunter/replays/demo/exports/export-1");
    await mkdir(exportDir, { recursive: true });
    await writeFile(path.join(exportDir, "video.mp4"), "");
    await writeFile(path.join(repo, "run.command"), "#!/bin/sh\n");
    const desk = (fn: string, arg: string) =>
      first.page.evaluate(([fn, arg]) => (window as any).demohunterDesktop[fn](arg), [fn, arg] as const);
    expect(await desk("openFile", await realpath(path.join(exportDir, "video.mp4")))).toBe(true);
    expect(await desk("showFile", path.join(exportDir, "video.mp4"))).toBe(true);
    for (const bad of ["/etc/hosts", path.join(repo, "run.command"), path.join(exportDir, "../../../../../run.command")])
      expect(await desk("openFile", bad)).toBe(false);
    // Another local server (e.g. the app being demoed) never gets the bridge.
    await first.page.evaluate(() => (location.href = "http://127.0.0.1:9/elsewhere"));
    await new Promise((r) => setTimeout(r, 500));
    expect(first.page.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(new URL(first.page.url()).port).not.toBe("9");
    expect(await first.page.evaluate(() => (window as any).demohunterDesktop.platform)).toBe(process.platform);
    // The repository name switches repositories.
    expect(await first.page.locator("#repo-name").getAttribute("role")).toBe("button");
    expect(await first.page.evaluate(() => typeof (window as any).demohunterDesktop.choose)).toBe("function");
    const title = await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getTitle());
    expect(title).toBe(`${path.basename(repo)} — DemoHunter Studio`);
    if (shots) await first.page.screenshot({ path: path.join(shots, "library.png") });
    await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setBounds({ x: 120, y: 90, width: 1200, height: 760 }));
    await first.app.close();
    app = undefined;
    const saved = JSON.parse(await readFile(path.join(userData, "settings.json"), "utf8"));
    expect(saved.recent[0].path).toBe(await realpath(repo));
    expect(saved.window).toMatchObject({ width: 1200, height: 760 });
    // Next launch reopens the last repository at the same size.
    const second = await launch(userData);
    await second.page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 45_000 });
    const bounds = await second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
    expect(bounds).toMatchObject({ width: 1200, height: 760 });
    // Close Repository returns to the welcome window with it listed.
    await second.app.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu()!.items.find((i) => i.label === "File")!;
      file.submenu!.items.find((i) => i.label === "Close Repository")!.click();
    });
    await second.page.waitForURL("app://ui/welcome.html");
    await second.page.locator(".recent li").first().waitFor();
    expect(await second.page.locator(".recent .name").first().textContent()).toBe(path.basename(repo));
    if (shots) await second.page.screenshot({ path: path.join(shots, "welcome-recent.png") });
  }, 120_000);

  test("a saved size without a position still opens the window", async () => {
    const userData = await tmp("dh-desktop-data-");
    await writeFile(path.join(userData, "settings.json"), JSON.stringify({ recent: ["/no/such/folder"], window: { width: 1000, height: 700 } }));
    const { app, page } = await launch(userData);
    await page.waitForURL("app://ui/welcome.html");
    const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
    expect(bounds).toMatchObject({ width: 1000, height: 700 });
  }, 60_000);

  test("a repository shows every worktree's demos and the library holds still", async () => {
    const userData = await tmp("dh-desktop-data-");
    const base = await realpath(await tmp("dh-desktop-wt-"));
    const repo = path.join(base, "repo"), feature = path.join(base, "feature-x");
    await mkdir(repo);
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
    git(repo, "init", "-q", "-b", "main");
    await writeFile(path.join(repo, ".gitignore"), ".demohunter/\n");
    git(repo, "add", ".");
    git(repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init");
    git(repo, "worktree", "add", "-q", "-b", "feature/x", feature);
    const { projectFixture } = await import("../studio/test-support.js");
    const fixture = await projectFixture();
    temp.push(fixture.root);
    const demo = path.join(feature, ".demohunter/replays/demo");
    await cp(fixture.dir, demo, { recursive: true });
    // The fixture has no recorded frames to render; seed its poster cache.
    const { loadBundle } = await import("../studio/storage.js");
    await mkdir(path.join(demo, ".studio"), { recursive: true });
    await writeFile(path.join(demo, ".studio/poster.png"), await readFile(path.join(here, "build/icon.png")));
    await writeFile(path.join(demo, ".studio/poster.json"), JSON.stringify({ revision: (await loadBundle(demo)).revision, rendererVersion: 3 }));
    const { page } = await launch(userData, [repo]);
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 45_000 });
    await page.locator(".recording-card").first().waitFor();
    // Projects: the open repository with its worktrees nested under it.
    expect(await page.locator(".projects-head h2").textContent()).toBe("Projects");
    expect(await page.locator(".project.current .project-row .row-name").textContent()).toBe("repo");
    // Only worktrees with demos are listed; the empty main checkout folds away.
    expect(await page.locator(".worktree").count()).toBe(1);
    expect(await page.locator(".more-trees").textContent()).toBe("+ 1 without demos");
    expect(await page.locator(".open-project").first().isVisible()).toBe(true);
    expect(await page.locator(".card-branch").textContent()).toContain("feature-x");
    // Polling must not rebuild cards (that caused flicker and lost hover).
    await page.locator(".recording-poster.loaded").waitFor({ timeout: 30_000 });
    await page.locator(".recording-art").first().hover();
    const mutations = await page.evaluate(async () => {
      let count = 0;
      const mo = new MutationObserver((list) => (count += list.length));
      mo.observe(document.querySelector("#recordings")!, { childList: true, subtree: true, attributes: true });
      await new Promise((r) => setTimeout(r, 9000));
      mo.disconnect();
      return count;
    });
    expect(mutations).toBe(0);
    await page.locator(".more-trees").click();
    await page.locator(".worktree", { hasText: "repo" }).click();
    expect(await page.locator("#empty-title").textContent()).toBe("No demos in repo");
    await page.locator(".worktree", { hasText: "feature-x" }).click();
    expect(await page.locator(".recording-card").count()).toBe(1);
    if (shots) await page.screenshot({ path: path.join(shots, "worktrees.png") });
  }, 120_000);

  test("folders open restricted until trusted", async () => {
    const repo = await realpath(await tmp("dh-desktop-repo-"));
    const { projectFixture } = await import("../studio/test-support.js");
    const fixture = await projectFixture();
    temp.push(fixture.root);
    await cp(fixture.dir, path.join(repo, ".demohunter/replays/demo"), { recursive: true });
    const sceneTrust = (page: import("playwright").Page) =>
      page.evaluate(async () => {
        const lib = await fetch("/api/library").then((r) => r.json());
        const id = lib.recordings[0].id;
        return (await fetch(`/projects/${id}/api/workspace`).then((r) => r.json())).trusted as boolean;
      });
    // Untrusted: scene scripts are off.
    const first = await launch(await tmp("dh-desktop-data-"), [repo]);
    await first.page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 45_000 });
    await first.page.locator(".recording-card").first().waitFor();
    expect(await sceneTrust(first.page)).toBe(false);
    await first.app.close();
    app = undefined;
    // Trusted (as after "Trust Folder…"): scene scripts run.
    const trustedData = await tmp("dh-desktop-data-");
    await writeFile(path.join(trustedData, "settings.json"), JSON.stringify({ recent: [], trusted: [repo] }));
    const second = await launch(trustedData, [repo]);
    await second.page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 45_000 });
    await second.page.locator(".recording-card").first().waitFor();
    expect(await sceneTrust(second.page)).toBe(true);
  }, 120_000);

  test("Studio stops when the app is force-killed", async () => {
    const userData = await tmp("dh-desktop-data-");
    const repo = await tmp("dh-desktop-repo-");
    const { app, page } = await launch(userData, [repo]);
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 45_000 });
    const url = page.url();
    app.process().kill("SIGKILL");
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      await new Promise((r) => setTimeout(r, 250));
      alive = await fetch(url).then(() => true, () => false);
    }
    expect(alive).toBe(false);
  }, 60_000);

  test("a service that cannot start shows the error page with Try again", async () => {
    const userData = await tmp("dh-desktop-data-");
    const repo = await tmp("dh-desktop-repo-");
    const fake = path.join(repo, "fake-bun.sh");
    await writeFile(fake, "#!/bin/sh\necho 'error: something broke' >&2\nexit 3\n", { mode: 0o755 });
    const { page } = await launch(userData, [repo], { BUN: fake });
    await page.waitForURL(/status\.html\?.*error=/);
    expect(await page.locator("h1").textContent()).toBe(`Could not open ${path.basename(repo)}`);
    expect(await page.locator("pre").textContent()).toContain("something broke");
    await page.getByRole("button", { name: "Try again" }).waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, "error.png") });
  }, 60_000);
});
