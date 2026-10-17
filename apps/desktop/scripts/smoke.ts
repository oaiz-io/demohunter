// Smoke test for a packaged "DemoHunter Studio.app": opens a fresh git
// repository with one demo in a second worktree and checks that the bundled
// Studio service (its own Bun, sources and modules) serves the library.
//
//   bun apps/desktop/scripts/smoke.ts "/path/to/DemoHunter Studio.app"
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron } from "playwright";
import { projectFixture } from "../../studio/test-support.js";

const bundle = process.argv[2];
if (!bundle) throw new Error("Usage: bun smoke.ts <path to .app>");
const base = await realpath(await mkdtemp(path.join(tmpdir(), "dh-smoke-")));
const repo = path.join(base, "repo"),
  feature = path.join(base, "feature");
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" });
execFileSync("mkdir", ["-p", repo]);
git(repo, "init", "-q", "-b", "main");
await writeFile(path.join(repo, ".gitignore"), ".demohunter/\n");
git(repo, "add", ".");
git(repo, "-c", "user.email=ci@example.com", "-c", "user.name=ci", "commit", "-qm", "init");
git(repo, "worktree", "add", "-q", "-b", "feature/smoke", feature);
const fixture = await projectFixture();
await cp(fixture.dir, path.join(feature, ".demohunter/replays/smoke"), { recursive: true });

// A bare environment: nothing from this checkout or the developer's PATH.
const app = await _electron.launch({
  executablePath: path.join(bundle, "Contents/MacOS/Electron"),
  args: [repo],
  env: {
    HOME: process.env.HOME!,
    PATH: "/usr/bin:/bin",
    DEMOHUNTER_DESKTOP_USER_DATA: path.join(base, "data"),
    DEMOHUNTER_DESKTOP_DRY_SHELL: "1",
    DEMOHUNTER_DESKTOP_HIDDEN: "1",
  },
  timeout: 60_000,
});
try {
  const page = await app.firstWindow();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 120_000 });
  await page.locator(".recording-card").first().waitFor({ timeout: 60_000 });
  const worktrees = await page.locator(".worktree").count();
  const info = await app.evaluate(({ app }) => ({
    name: app.getName(),
    version: app.getVersion(),
    path: app.getAppPath(),
  }));
  if (info.name !== "DemoHunter Studio") throw new Error(`Unexpected app name ${info.name}`);
  if (!info.path.startsWith(bundle) && !info.path.includes(".app/Contents/Resources/app"))
    throw new Error(`App runs from outside the bundle: ${info.path}`);
  if (worktrees < 1) throw new Error("Worktree sidebar is missing");
  console.log(`Smoke test passed: ${JSON.stringify(info)}, ${worktrees} worktree row(s).`);
} finally {
  await app.close().catch(() => {});
  await rm(base, { recursive: true, force: true });
  await rm(fixture.root, { recursive: true, force: true });
}
process.exit(0);
