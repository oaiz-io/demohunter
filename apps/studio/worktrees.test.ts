import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalLibrary } from "./library.js";
import { settledWorktreeStates } from "./git.js";
import { serveLibrary } from "./library-server.js";
import { projectFixture } from "./test-support.js";
import { loadBundle, writeJson } from "./storage.js";
import { ProjectTargets, readStudioSession } from "./workspace.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

let base: string, main: string, feature: string, nested: string, fixtureRoot: string;
async function addDemo(root: string, name: string, title: string) {
  const dir = path.join(root, ".demohunter/replays", name);
  await mkdir(path.dirname(dir), { recursive: true });
  await cp(path.join(fixtureRoot, "project"), dir, { recursive: true });
  const bundle = await loadBundle(dir);
  bundle.project.title = title;
  await writeJson(path.join(dir, "project.json"), bundle.project);
  return dir;
}

beforeAll(async () => {
  fixtureRoot = (await projectFixture()).root;
  base = await realpath(await mkdtemp(path.join(tmpdir(), "dh-worktrees-")));
  main = path.join(base, "repo");
  await mkdir(path.join(main, "demos"), { recursive: true });
  git(main, "init", "-q", "-b", "main");
  git(main, "config", "user.email", "test@example.com");
  git(main, "config", "user.name", "Test");
  await writeFile(path.join(main, ".gitignore"), ".demohunter/\n");
  await writeFile(path.join(main, "demos/home.tour.ts"), 'export default { title: "Home" };\n');
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  feature = path.join(base, "workspaces", "krakow");
  git(main, "worktree", "add", "-q", "-b", "feature/login", feature);
  // A worktree nested inside the main checkout is scanned once, as itself.
  nested = path.join(main, ".worktrees", "nested");
  git(main, "worktree", "add", "-q", "--detach", nested);
  await writeFile(path.join(feature, "demos/home.tour.ts"), 'export default { title: "Home v2" };\n');
  await addDemo(main, "home", "Main home");
  await addDemo(feature, "home", "Feature home");
  await addDemo(nested, "nested", "Nested demo");
  // A removed worktree folder is reported as missing.
  const gone = path.join(base, "workspaces", "gone");
  git(main, "worktree", "add", "-q", "-b", "gone", gone);
  await rm(gone, { recursive: true, force: true });
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe("repository libraries", () => {
  test("a repository root lists every worktree and its demos", async () => {
    const library = await LocalLibrary.open(main);
    // Git status arrives in the background so it never holds up the library.
    await library.scan();
    await settledWorktreeStates();
    const scan = await library.scan();
    expect(scan.worktrees?.map((w) => w.name)).toEqual(["repo", "krakow", "nested", "gone"]);
    const [m, f, n, g] = scan.worktrees!;
    expect(m).toMatchObject({ current: true, main: true, branch: "main", recordings: 1, tours: 1 });
    expect(f).toMatchObject({ current: false, branch: "feature/login", recordings: 1, tours: 1, changed: 1 });
    expect(n).toMatchObject({ detached: true, recordings: 1 });
    expect(g).toMatchObject({ missing: true, recordings: 0 });
    expect(scan.recordings.map((r) => r.title).sort()).toEqual(["Feature home", "Main home", "Nested demo"]);
    const ids = new Set(scan.recordings.map((r) => r.id));
    expect(ids.size).toBe(3);
    // Paths are relative to their worktree; tours link within the worktree.
    const featureHome = scan.recordings.find((r) => r.title === "Feature home")!;
    expect(featureHome).toMatchObject({ path: ".demohunter/replays/home", worktree: feature });
    expect(await library.resolve(featureHome.id)).toBe(path.join(feature, ".demohunter/replays/home"));
    // The main checkout's IDs are unchanged from single-folder libraries.
    const mainHome = scan.recordings.find((r) => r.title === "Main home")!;
    expect(mainHome.id).toBe(
      (await import("./workspace.js")).libraryProjectId(".demohunter/replays/home"),
    );
  });

  test("a scan is stable when nothing changed", async () => {
    const library = await LocalLibrary.open(main);
    const first = JSON.stringify(await library.scan());
    await new Promise((r) => setTimeout(r, 1100));
    expect(JSON.stringify(await library.scan())).toBe(first);
    expect(first).not.toMatch(/replays\/home-\d{10,}/);
  });

  test("opening a linked worktree also shows the others; subfolders stay plain", async () => {
    const fromFeature = await (await LocalLibrary.open(feature)).scan();
    expect(fromFeature.worktrees?.find((w) => w.current)?.path).toBe(feature);
    expect(fromFeature.recordings).toHaveLength(3);
    const sub = await (await LocalLibrary.open(path.join(main, "demos"))).scan();
    expect(sub.worktrees).toBeUndefined();
    expect(sub.recordings).toHaveLength(0);
    // A plain (non-git) folder keeps today's behaviour.
    const plainScan = await (await LocalLibrary.open(fixtureRoot)).scan();
    expect(plainScan.worktrees).toBeUndefined();
    expect(plainScan.recordings).toHaveLength(1);
  });

  test("viewing a demo tells the agent in its worktree, and MCP can reach it", async () => {
    const app = await serveLibrary(main, { port: 0 });
    try {
      const scan = await fetch(`${app.url}/api/library`).then((r) => r.json());
      const featureHome = scan.recordings.find((r: any) => r.title === "Feature home");
      const html = await fetch(`${app.url}/projects/${featureHome.id}/`).then((r) => r.text());
      expect(html).toContain("app.js");
      const workspace = await fetch(`${app.url}/projects/${featureHome.id}/api/workspace`).then((r) => r.json());
      expect(workspace.connection.args.at(-1)).toBe(feature);
      let inFeature, inMain;
      for (let i = 0; i < 50 && !(inFeature && inMain); i++) {
        await new Promise((r) => setTimeout(r, 50));
        inFeature = await readStudioSession(feature);
        inMain = await readStudioSession(main);
      }
      expect(inFeature?.projectDir).toBe(".demohunter/replays/home");
      expect(inMain?.projectDir).toBe(path.relative(main, path.join(feature, ".demohunter/replays/home")));
      // An agent connected in either worktree targets the demo on screen.
      for (const root of [feature, main]) {
        const targets = await ProjectTargets.open(root);
        const target = await targets.resolve();
        expect(target.dir).toBe(path.join(feature, ".demohunter/replays/home"));
        expect(target.title).toBe("Feature home");
      }
      const listed = await (await ProjectTargets.open(main)).projects();
      expect(listed.find((p: any) => p.title === "Feature home")).toMatchObject({ branch: "feature/login" });
      // Switching to a demo in the main checkout releases the feature worktree.
      const mainHome = scan.recordings.find((r: any) => r.title === "Main home");
      await fetch(`${app.url}/projects/${mainHome.id}/`).then((r) => r.text());
      let released = await readStudioSession(feature);
      for (let i = 0; i < 50 && released; i++) {
        await new Promise((r) => setTimeout(r, 50));
        released = await readStudioSession(feature);
      }
      expect(released).toBeNull();
      expect((await readStudioSession(main))?.projectDir).toBe(".demohunter/replays/home");
    } finally {
      await app.close();
    }
    expect(await readStudioSession(feature)).toBeNull();
    expect(await readStudioSession(main)).toBeNull();
  });
});

test("a crafted worktree entry pointing elsewhere is never scanned", async () => {
  const decoy = path.join(base, "decoy");
  await mkdir(path.join(decoy, ".demohunter/replays"), { recursive: true });
  await addDemo(decoy, "stolen", "Decoy demo");
  // .git/worktrees/evil/gitdir is plain text in the repository.
  const entry = path.join(main, ".git/worktrees/evil");
  await mkdir(entry, { recursive: true });
  await writeFile(path.join(entry, "gitdir"), path.join(decoy, ".git") + "\n");
  await writeFile(path.join(entry, "commondir"), "../..\n");
  await writeFile(path.join(entry, "HEAD"), "ref: refs/heads/main\n");
  try {
    expect(git(main, "worktree", "list")).toContain(decoy);
    const library = await LocalLibrary.open(main);
    const scan = await library.scan();
    expect(scan.recordings.map((r) => r.title)).not.toContain("Decoy demo");
    expect(library.roots).not.toContain(decoy);
    expect(scan.worktrees?.find((w) => w.path.endsWith("decoy"))?.missing).toBe(true);
  } finally {
    await rm(entry, { recursive: true, force: true });
    await rm(decoy, { recursive: true, force: true });
  }
});
