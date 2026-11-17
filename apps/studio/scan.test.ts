import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalLibrary } from "./library.js";
import { serveLibrary } from "./library-server.js";
import { listDemoSources, listTrackedDemoSources, mergeDemoSources } from "./git.js";
import { projectFixture } from "./test-support.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

let fixtureRoot: string, fixtureDir: string, repo: string;
beforeAll(async () => {
  ({ root: fixtureRoot, dir: fixtureDir } = await projectFixture());
  repo = await realpath(await mkdtemp(path.join(tmpdir(), "dh-scan-")));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  await writeFile(path.join(repo, ".gitignore"), ".demohunter/\n");
  await mkdir(path.join(repo, "apps/web/demos"), { recursive: true });
  await writeFile(path.join(repo, "apps/web/demos/home.tour.ts"), 'export default { title: "Home" };\n');
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  // Ignored captures next to a tracked tour, and an untracked tour.
  await cp(fixtureDir, path.join(repo, "apps/web/.demohunter/replays/a"), { recursive: true });
  await cp(fixtureDir, path.join(repo, ".demohunter/replays/b"), { recursive: true });
  await writeFile(path.join(repo, "apps/web/demos/new.tour.ts"), "");
});
afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(fixtureRoot, { recursive: true, force: true });
});

test("the tracked listing finds ignored .demohunter folders without a worktree walk", async () => {
  const tracked = await listTrackedDemoSources(repo);
  expect([...tracked!.tours]).toEqual(["apps/web/demos/home.tour.ts"]);
  expect([...tracked!.folders].sort()).toEqual([".demohunter", "apps/web/.demohunter"]);
  // The complete listing still has the untracked tour, and equals the
  // merge of the fast and the slow parts.
  const all = await listDemoSources(repo);
  expect(all!.tours).toEqual(["apps/web/demos/home.tour.ts", "apps/web/demos/new.tour.ts"]);
  expect(mergeDemoSources(tracked).folders).toEqual(all!.folders);
});

test("a live library and a complete scan agree once background listings finish", async () => {
  const complete = await (await LocalLibrary.open(repo)).scan();
  const live = await LocalLibrary.open(repo, { live: true });
  try {
    await live.scan();
    await live.settled();
    const scan = await live.scan();
    const shape = (s: typeof scan) => ({
      tours: s.tours.map((t) => t.path),
      recordings: s.recordings.map((r) => r.path),
    });
    expect(shape(scan)).toEqual(shape(complete));
    expect(shape(scan).recordings.sort()).toEqual([".demohunter/replays/b", "apps/web/.demohunter/replays/a"]);
    // Tours carry no shell command; the page builds its own.
    expect(scan.tours.every((t) => !("command" in t))).toBe(true);
  } finally {
    live.close();
  }
});

test("a live library shows a new recording on the next scan without new git listings", async () => {
  const live = await LocalLibrary.open(repo, { live: true });
  const dir = path.join(repo, ".demohunter/replays/c");
  try {
    expect((await live.scan()).recordings).toHaveLength(2);
    await cp(fixtureDir, dir, { recursive: true });
    expect((await live.scan()).recordings.map((r) => r.path)).toContain(".demohunter/replays/c");
  } finally {
    live.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test.if(process.platform === "darwin")("a watched worktree picks up a new untracked tour", async () => {
  const live = await LocalLibrary.open(repo, { live: true });
  const tour = path.join(repo, "apps/web/demos/later.tour.ts");
  try {
    await live.scan();
    await live.settled();
    await new Promise((r) => setTimeout(r, 300));
    await writeFile(tour, "");
    let found = false;
    for (let i = 0; i < 40 && !found; i++) {
      await new Promise((r) => setTimeout(r, 250));
      found = (await live.scan()).tours.some((t) => t.path === "apps/web/demos/later.tour.ts");
    }
    expect(found).toBe(true);
  } finally {
    live.close();
    await rm(tour, { force: true });
  }
}, 20_000);

test("a plain folder over the entry budget gives the same result on every scan", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "dh-plain-budget-")));
  try {
    // Breadth-first in name order: "a" uses up the budget, so "b" and "c"
    // are cut off on every scan, not on some of them.
    await mkdir(path.join(root, "a"));
    await Promise.all(
      Array.from({ length: 20_100 }, (_, i) => writeFile(path.join(root, "a", `f${i}`), "")),
    );
    await mkdir(path.join(root, "b"));
    await writeFile(path.join(root, "b/x.tour.ts"), "");
    await cp(fixtureDir, path.join(root, "c/.demohunter/replays/demo"), { recursive: true });
    const results = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const scan = await (await LocalLibrary.open(root)).scan();
      results.add(JSON.stringify({ tours: scan.tours, recordings: scan.recordings.map((r) => r.path), warnings: scan.warnings }));
    }
    expect(results.size).toBe(1);
    const [only] = [...results];
    expect(JSON.parse(only!).warnings.join(" ")).toContain("limited to 20,000 entries");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("/api/library answers 304 when nothing changed and 200 after a change", async () => {
  const app = await serveLibrary(repo, { port: 0 });
  const dir = path.join(repo, ".demohunter/replays/d");
  try {
    const first = await fetch(`${app.url}/api/library`);
    const tag = first.headers.get("ETag");
    expect(first.status).toBe(200);
    expect(tag).toMatch(/^"[\w-]+"$/);
    await first.json();
    const same = await fetch(`${app.url}/api/library`, { headers: { "If-None-Match": tag! } });
    expect(same.status).toBe(304);
    expect(await same.text()).toBe("");
    await cp(fixtureDir, dir, { recursive: true });
    const changed = await fetch(`${app.url}/api/library`, { headers: { "If-None-Match": tag! } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("ETag")).not.toBe(tag);
    expect((await changed.json()).recordings.map((r: { path: string }) => r.path)).toContain(".demohunter/replays/d");
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
