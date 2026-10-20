import { expect, spyOn, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_DEMOHUNTER_CONFIG } from "@demohunter/sdk";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { resolveNarrationSegment } from "../../packages/generator-playwright/src/narration/resolve-narration.js";
import { captureReplay } from "./capture.js";
import { cueText, exportReplay, stamp } from "./export.js";
import { listDemoSources, worktreeState } from "./git.js";
import { liftElement } from "./lift.js";
import { LocalLibrary } from "./library.js";
import { defaultCacheDir, regenerateNarration } from "./narration.js";
import { SeenDemos } from "./seen.js";
import {
  atomicWrite,
  loadBundle,
  readProjectFile,
  mutateProject,
  undoProject,
  writeJson,
} from "./storage.js";
import { projectFixture, wavBytes } from "./test-support.js";
import {
  ReplayWorkspace,
  writeSceneFile,
  writeUnderScenes,
} from "./workspace.js";
import { readFormat } from "./format.js";

const snapshot = {
  type: 2,
  timestamp: 1001,
  data: {
    node: {
      type: 0,
      id: 1,
      childNodes: [
        {
          type: 2,
          id: 2,
          tagName: "h1",
          attributes: { id: "title" },
          childNodes: [{ type: 3, id: 3, textContent: "Invoice" }],
        },
      ],
    },
  },
};
async function setup() {
  const result = await projectFixture();
  await writeJson(path.join(result.dir, "events.json"), [
    { type: 4, timestamp: 1000, data: {} },
    snapshot,
  ]);
  return { ...result, workspace: await ReplayWorkspace.open(result.dir) };
}
const fakeVoice = (root: string) => async (input: { event: { text: string } }) => {
  const audioPath = path.join(root, "voice.wav");
  await writeFile(audioPath, wavBytes());
  return {
    audioPath,
    cacheKey: `key-${input.event.text.replace(/\W/g, "")}`,
    durationMs: 250,
    text: input.event.text,
  };
};
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;

// ---------------------------------------------------------------- undo chain

test("undo steps through narration audio copies and scene-file writes", async () => {
  const { root, dir } = await projectFixture();
  try {
    const start = await loadBundle(dir);
    start.narration.segments.push({
      id: "n2",
      clipId: "a",
      offsetMs: 0,
      text: "Second line.",
    });
    await writeJson(path.join(dir, "narration.json"), start.narration);
    // Two segments: each result copies an audio file into audio/ and is
    // recorded separately in history.
    await regenerateNarration(dir, {
      resolve: fakeVoice(root) as typeof resolveNarrationSegment,
    });
    const generated = await loadBundle(dir);
    expect(generated.narration.segments.every((s) => s.audio)).toBe(true);
    const undone = await undoProject(dir, generated.revision, 2);
    expect(undone.narration.segments.some((s) => s.audio)).toBe(false);

    // tracked edit → direct scene write → tracked edit → undo both
    let current = await loadBundle(dir);
    await mutateProject(dir, current.revision, "Title A", (d) => {
      d.project.title = "A";
    });
    current = await loadBundle(dir);
    await writeSceneFile(dir, current.revision, "scenes/x.html", "<p>x</p>");
    current = await loadBundle(dir);
    await mutateProject(dir, current.revision, "Title B", (d) => {
      d.project.title = "B";
    });
    current = await loadBundle(dir);
    const back = await undoProject(dir, current.revision, 2);
    expect(back.project.title).toBe("Test replay");
    // Scene files are not history: the page stays.
    expect(await readFile(path.join(dir, "scenes/x.html"), "utf8")).toBe(
      "<p>x</p>",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("undo still refuses a direct edit of a tracked file between changes", async () => {
  const { root, dir } = await projectFixture();
  try {
    let current = await loadBundle(dir);
    await mutateProject(dir, current.revision, "One", (d) => {
      d.project.title = "One";
    });
    const external = await loadBundle(dir);
    external.narration.segments[0]!.text = "Hand edit";
    await writeJson(path.join(dir, "narration.json"), external.narration);
    current = await loadBundle(dir);
    await mutateProject(dir, current.revision, "Two", (d) => {
      d.project.title = "Two";
    });
    current = await loadBundle(dir);
    await expect(undoProject(dir, current.revision, 2)).rejects.toThrow(
      "outside",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a multi-step undo validates every snapshot before writing anything", async () => {
  const { root, dir } = await projectFixture();
  try {
    for (const title of ["One", "Two"]) {
      const current = await loadBundle(dir);
      await mutateProject(dir, current.revision, title, (d) => {
        d.project.title = title;
      });
    }
    const file = path.join(dir, ".history/edits.json");
    const history = JSON.parse(await readFile(file, "utf8"));
    // The older snapshot is damaged (project without a title type).
    history[0].before.project.title = 42;
    await writeFile(file, JSON.stringify(history));
    const current = await loadBundle(dir);
    await expect(undoProject(dir, current.revision, 2)).rejects.toThrow();
    expect((await loadBundle(dir)).project.title).toBe("Two");
    expect(JSON.parse(await readFile(file, "utf8"))).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atomicWrite leaves no temp file when the rename fails", async () => {
  const { root, dir } = await projectFixture();
  try {
    await mkdir(path.join(dir, "taken"));
    await expect(atomicWrite(path.join(dir, "taken"), "x")).rejects.toThrow();
    expect((await readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------- locks

test("stale project locks are taken over; live fresh ones are respected", async () => {
  const { root, dir } = await projectFixture();
  const lock = path.join(dir, ".project.lock");
  const edit = async (title: string) => {
    const current = await loadBundle(dir);
    return mutateProject(dir, current.revision, title, (d) => {
      d.project.title = title;
    });
  };
  try {
    // Owner process is gone.
    await writeFile(
      lock,
      JSON.stringify({ pid: deadPid(), at: new Date().toISOString() }),
    );
    expect((await edit("Dead owner")).project.title).toBe("Dead owner");
    // Owner alive but silent for over 30 s.
    await writeFile(
      lock,
      JSON.stringify({
        pid: process.pid,
        at: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    expect((await edit("Old lock")).project.title).toBe("Old lock");
    // Older versions wrote a bare pid.
    await writeFile(lock, String(deadPid()));
    expect((await edit("Bare pid")).project.title).toBe("Bare pid");
    // Alive and fresh: busy, and the other owner's lock is left alone.
    const fresh = JSON.stringify({
      pid: process.pid,
      at: new Date().toISOString(),
    });
    await writeFile(lock, fresh);
    await expect(edit("Busy")).rejects.toThrow("busy");
    expect(await readFile(lock, "utf8")).toBe(fresh);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("narration lock: stale is taken over, live is busy, other errors surface as they are", async () => {
  const { root, dir } = await projectFixture();
  const lock = path.join(dir, ".narration.lock");
  const resolve = fakeVoice(root) as typeof resolveNarrationSegment;
  try {
    await writeFile(
      lock,
      JSON.stringify({ pid: deadPid(), at: new Date().toISOString() }),
    );
    expect((await regenerateNarration(dir, { resolve })).generated).toBe(1);
    await expect(stat(lock)).rejects.toThrow();
    await writeFile(
      lock,
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
    );
    await expect(regenerateNarration(dir, { resolve })).rejects.toThrow(
      "already regenerating",
    );
    await rm(lock);
    const missing = await regenerateNarration(path.join(root, "nope"), {
      resolve,
    }).then(
      () => undefined,
      (error) => error as NodeJS.ErrnoException,
    );
    expect(missing?.code).toBe("ENOENT");
    expect(missing?.message).not.toContain("already regenerating");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("narration speech cache defaults to the workspace's .demohunter folder", async () => {
  expect(defaultCacheDir("/work/repo/.demohunter/replays/x")).toBe(
    "/work/repo/.demohunter/cache",
  );
  // Elsewhere in a repository: the repository's cache, never above it.
  const root = await mkdtemp(path.join(tmpdir(), "dh-cache-"));
  try {
    await mkdir(path.join(root, ".git"));
    await mkdir(path.join(root, "demos/x"), { recursive: true });
    expect(defaultCacheDir(path.join(root, "demos/x"))).toBe(
      path.join(root, ".demohunter/cache"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  // Outside any repository: next to the demo, not in its parent folders.
  expect(defaultCacheDir("/nowhere/x")).toBe("/nowhere/x/.demohunter/cache");
});

// ---------------------------------------------------------------------- MCP

async function connect(target: string) {
  const client = new Client({ name: "hardening-test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve(import.meta.dir, "cli.ts"), "mcp", target],
      stderr: "pipe",
    }),
  );
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    if (r.isError) throw new Error(r.content[0]!.text);
    return JSON.parse(r.content[0]!.text);
  };
  return { client, call };
}

test("MCP: narration updates are partial, undo takes steps, write tools are declared", async () => {
  const { root, dir } = await setup();
  const { client, call } = await connect(dir);
  try {
    const base = await loadBundle(dir);
    base.narration.segments[0]!.voice = "nova";
    base.narration.segments[0]!.title = "Intro";
    await writeJson(path.join(dir, "narration.json"), base.narration);
    const start = await loadBundle(dir);
    expect(start.narration.segments[0]!.offsetMs).toBe(100);

    // Only the text is sent: offsetMs and voice must survive.
    let result = await call("update_narration", {
      expectedRevision: start.revision,
      segment: { id: "n1", text: "Fresh words." },
    });
    let segment = (await loadBundle(dir)).narration.segments[0]!;
    expect(segment).toMatchObject({
      text: "Fresh words.",
      offsetMs: 100,
      voice: "nova",
      title: "Intro",
    });
    // null clears an optional field; other fields stay.
    result = await call("update_narration", {
      expectedRevision: result.revision,
      segment: { id: "n1", voice: null },
    });
    segment = (await loadBundle(dir)).narration.segments[0]!;
    expect(segment.voice).toBeUndefined();
    expect(segment).toMatchObject({ offsetMs: 100, title: "Intro" });
    // A new segment still needs a clip and text.
    const err = await call("update_narration", {
      expectedRevision: result.revision,
      segment: { id: "n9", text: "Orphan" },
    }).catch((e) => e as Error);
    expect((err as Error).message).toContain("clipId");
    result = await call("update_narration", {
      expectedRevision: result.revision,
      segment: { id: "n9", clipId: "a", text: "Added" },
    });
    expect(
      (await loadBundle(dir)).narration.segments.find((s) => s.id === "n9"),
    ).toMatchObject({ offsetMs: 0, text: "Added" });

    // undo_last_edit takes steps (three tracked changes above, undo two).
    const undone = await call("undo_last_edit", {
      expectedRevision: (await loadBundle(dir)).revision,
      steps: 2,
    });
    expect(undone.revision).toBe((await loadBundle(dir)).revision);
    segment = (await loadBundle(dir)).narration.segments[0]!;
    expect(segment).toMatchObject({ text: "Fresh words.", voice: "nova" });

    const tools = new Map(
      (await client.listTools()).tools.map((t) => [t.name, t]),
    );
    for (const name of [
      "write_project_file",
      "remove_timeline_item",
      "undo_last_edit",
    ])
      expect(tools.get(name)!.annotations?.destructiveHint).toBe(true);
    const lift = tools.get("lift_element")!;
    expect(lift.annotations?.readOnlyHint).toBe(false);
    expect((lift.inputSchema as { required: string[] }).required).toContain(
      "expectedRevision",
    );
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

// ---------------------------------------------------------------- workspace

test("a stale element ref in existing data does not block unrelated writes", async () => {
  const { root, dir, workspace: w } = await setup();
  try {
    const bundle = await loadBundle(dir);
    bundle.edits.highlights.push({
      id: "old",
      startMs: 0,
      endMs: 500,
      target: { ref: "gone-ref" },
      color: "#fff",
      padding: 8,
    });
    await writeJson(path.join(dir, "edits.json"), bundle.edits);
    const known = w.index.elements[0]!.ref;
    const revision = (await loadBundle(dir)).revision;
    const comment = await w.addComment({
      expectedRevision: revision,
      elementRef: known,
      timeMs: 10,
      body: "Still works",
    });
    // A new item pointing at an unknown ref is rejected.
    await expect(
      w.addComment({
        expectedRevision: comment.revision,
        elementRef: "nope",
        timeMs: 10,
        body: "Bad ref",
      }),
    ).rejects.toThrow("Unknown element");
    await expect(
      w.change(comment.revision, "New highlight", (d) => {
        d.edits.highlights.push({
          id: "new",
          startMs: 0,
          endMs: 100,
          target: { ref: "also-gone" },
          color: "#fff",
          padding: 8,
        });
      }),
    ).rejects.toThrow("Unknown element");
    // Replying to a comment keeps working too.
    await w.commentAction({
      expectedRevision: comment.revision,
      threadId: comment.id,
      reply: "ok",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scene writes refuse symlinked folders and files, and honour the revision", async () => {
  const { root, dir } = await projectFixture();
  try {
    const outside = path.join(root, "outside");
    await mkdir(outside);
    const revision = async () => (await loadBundle(dir)).revision;
    // scenes/ itself is a symlink.
    await symlink(outside, path.join(dir, "scenes"));
    // The project cannot even be loaded while scenes/ is a link.
    await expect(
      writeUnderScenes(dir, "any", [
        { relative: "scenes/lifts/a.html", content: "x" },
      ]),
    ).rejects.toThrow("must be a folder inside the project");
    await rm(path.join(dir, "scenes"));
    // scenes/lifts is a symlink.
    await mkdir(path.join(dir, "scenes"));
    await symlink(outside, path.join(dir, "scenes/lifts"));
    await expect(
      writeUnderScenes(dir, await revision(), [
        { relative: "scenes/lifts/a.html", content: "x" },
      ]),
    ).rejects.toThrow("not a folder");
    await rm(path.join(dir, "scenes/lifts"));
    // A symlinked target file is not overwritten, and nothing is half-written.
    await mkdir(path.join(dir, "scenes/lifts"));
    await writeFile(path.join(outside, "target.css"), "keep");
    await symlink(
      path.join(outside, "target.css"),
      path.join(dir, "scenes/lifts/fonts.css"),
    );
    await expect(
      writeUnderScenes(dir, await revision(), [
        { relative: "scenes/lifts/a.html", content: "x" },
        { relative: "scenes/lifts/fonts.css", content: "x" },
      ]),
    ).rejects.toThrow("not a regular file");
    expect(await readFile(path.join(outside, "target.css"), "utf8")).toBe("keep");
    expect(await readdir(path.join(dir, "scenes/lifts"))).toEqual(["fonts.css"]);
    await rm(path.join(dir, "scenes/lifts/fonts.css"));
    // Stale revision.
    await expect(
      writeUnderScenes(dir, "stale", [
        { relative: "scenes/lifts/a.html", content: "x" },
      ]),
    ).rejects.toThrow("project changed");
    const ok = await writeUnderScenes(dir, await revision(), [
      { relative: "scenes/lifts/a.html", content: "x" },
    ]);
    expect(ok.created).toEqual([true]);
    expect(ok.revision).toBe(await revision());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lift rejects a non-numeric time before doing anything", async () => {
  await expect(
    liftElement("/nowhere", { ref: "a", atMs: Number.NaN, name: "card" }),
  ).rejects.toThrow("number");
});

test("project files that are symlinks are refused, not read", async () => {
  const { root, dir } = await setup();
  try {
    const secret = path.join(root, "secret.txt");
    await writeFile(secret, "PRIVATE KEY");
    const revision = (await loadBundle(dir)).revision;
    for (const name of ["overrides.css", "comments.json", "project.json"]) {
      const file = path.join(dir, name);
      const original = await readFile(file, "utf8").catch(() => undefined);
      await rm(file, { force: true });
      await symlink(secret, file);
      const error = await loadBundle(dir).catch((e) => e as Error);
      expect((error as Error).message).toContain("symbolic link");
      expect((error as Error).message).not.toContain("PRIVATE");
      await rm(file);
      if (original !== undefined) await writeFile(file, original);
    }
    expect((await loadBundle(dir)).revision).toBe(revision);
    // The element index, capture and manifest are covered too.
    for (const name of ["events.json", "elements.json", "studio.json"]) {
      const file = path.join(dir, name);
      const original = await readFile(file, "utf8");
      await rm(file);
      await symlink(secret, file);
      await expect(ReplayWorkspace.open(dir)).rejects.toThrow("symbolic link");
      await rm(file);
      await writeFile(file, original);
    }
    // And the history folder.
    await mkdir(path.join(root, "history-elsewhere"));
    await writeFile(path.join(root, "history-elsewhere/edits.json"), "[]");
    await symlink(
      path.join(root, "history-elsewhere"),
      path.join(dir, ".history"),
    );
    const current = await loadBundle(dir);
    await expect(
      mutateProject(dir, current.revision, "x", (d) => {
        d.project.title = "x";
      }),
    ).rejects.toThrow("symbolic link");
    expect(await readFormat(dir)).not.toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------- git

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

test("repository libraries find demos saved outside .demohunter", async () => {
  const { root: fixtureRoot, dir: fixtureDir } = await projectFixture();
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "dh-repo-")));
  try {
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    await writeFile(path.join(repo, ".gitignore"), ".demohunter/\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    await cp(fixtureDir, path.join(repo, "demos/x"), { recursive: true });
    await cp(fixtureDir, path.join(repo, ".demohunter/replays/y"), {
      recursive: true,
    });
    // Tracked recording elsewhere, and a project.json that is not a demo.
    await cp(fixtureDir, path.join(repo, "tracked/z"), { recursive: true });
    git(repo, "add", "tracked");
    await mkdir(path.join(repo, "libs/app"), { recursive: true });
    await writeFile(path.join(repo, "libs/app/project.json"), "{}");
    const sources = await listDemoSources(repo);
    expect(sources!.folders).toEqual(
      [".demohunter", "demos/x", "tracked/z"],
    );
    const scan = await (await LocalLibrary.open(repo)).scan();
    expect(scan.recordings.map((r) => r.path).sort()).toEqual([
      ".demohunter/replays/y",
      "demos/x",
      "tracked/z",
    ]);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("git failures are unknown, not zero changes, and repo config cannot run commands", async () => {
  const plain = await mkdtemp(path.join(tmpdir(), "dh-plain-"));
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "dh-trap-")));
  try {
    expect(await worktreeState(plain)).toBeUndefined();
    git(repo, "init", "-q", "-b", "main");
    const marker = path.join(repo, "pwned");
    const hook = path.join(repo, "fsmonitor.sh");
    await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    git(repo, "config", "core.fsmonitor", hook);
    await writeFile(path.join(repo, "a.txt"), "a");
    const state = await worktreeState(repo);
    expect(state?.changed).toBe(2);
    await listDemoSources(repo);
    expect(await stat(marker).catch(() => null)).toBeNull();
  } finally {
    await rm(plain, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ library

test("an agent that stopped updating no longer counts as active", async () => {
  const { root, dir } = await projectFixture();
  const now = Date.now();
  const now_spy = spyOn(Date, "now");
  try {
    now_spy.mockReturnValue(now);
    await mkdir(path.join(dir, ".studio/activity"), { recursive: true });
    const id = "6f1c2b0e-1b8e-4c8e-9d3a-0c1f2a3b4c5d";
    await writeJson(path.join(dir, ".studio/activity", `${id}.json`), {
      id,
      sessionId: "s",
      actor: "Claude Code",
      tool: "apply_element_edit",
      label: "Editing element",
      startedAt: new Date(now - 3000).toISOString(),
      updatedAt: new Date(now - 1000).toISOString(),
      status: "running",
    });
    const library = await LocalLibrary.open(root);
    expect((await library.scan()).recordings[0]!.activeAgent).toBe(
      "Claude Code",
    );
    // No file changed (the agent died), only the clock moved.
    now_spy.mockReturnValue(now + 20_000);
    expect((await library.scan()).recordings[0]!.activeAgent).toBeUndefined();
  } finally {
    now_spy.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("recordings report the time of the newest agent edit", async () => {
  const { root, dir } = await projectFixture();
  try {
    const first = new Date(Date.now() - 5000).toISOString(),
      second = new Date().toISOString();
    await mkdir(path.join(dir, ".history"));
    await writeJson(path.join(dir, ".history/edits.json"), [
      { id: "1", createdAt: second, author: { actor: "A" }, before: {} },
      { id: "2", createdAt: first, before: {} },
      { id: "3", createdAt: first, author: { actor: "A" }, before: {} },
    ]);
    const [recording] = (await (await LocalLibrary.open(root)).scan())
      .recordings;
    expect(recording).toMatchObject({
      agentChanges: 2,
      lastAgentChangeAt: second,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------- seen

const recording = (over: Record<string, unknown> = {}) =>
  ({
    id: "a",
    path: "a",
    title: "A",
    modifiedAt: "",
    durationMs: 0,
    scenes: 0,
    narration: { ready: 0, total: 0 },
    comments: 0,
    agentChanges: 0,
    ...over,
  }) as import("./library.js").LibraryRecording;

test("seen: updated follows the newest agent edit time, not a count", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dh-seen-"));
  try {
    const seen = new SeenDemos(root);
    const t1 = "2026-01-01T00:00:00.000Z",
      t2 = "2026-01-02T00:00:00.000Z";
    // The count is capped by the history length and stays at 50.
    await seen.annotate([recording({ agentChanges: 50, lastAgentChangeAt: t1 })]);
    await seen.mark(recording({ agentChanges: 50, lastAgentChangeAt: t1 }));
    const same = recording({ agentChanges: 50, lastAgentChangeAt: t1 });
    expect((await seen.annotate([same]))[0]!.fresh).toBeUndefined();
    const newer = recording({ agentChanges: 50, lastAgentChangeAt: t2 });
    expect((await seen.annotate([newer]))[0]!.fresh).toBe("updated");
    await seen.mark(newer);
    expect((await seen.annotate([newer]))[0]!.fresh).toBeUndefined();
    // A changed capture still counts.
    expect(
      (await seen.annotate([{ ...newer, captureId: "x" }]))[0]!.fresh,
    ).toBeUndefined();
    await seen.mark({ ...newer, captureId: "x" });
    expect(
      (await seen.annotate([{ ...newer, captureId: "y" }]))[0]!.fresh,
    ).toBe("updated");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("seen: a damaged file is not cached as a failure, and concurrent marks all land", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dh-seen-"));
  try {
    const file = path.join(root, ".demohunter/studio/seen.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{not json");
    const seen = new SeenDemos(root);
    expect(
      (await seen.annotate([recording()]))[0]!.fresh,
    ).toBeUndefined();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => seen.mark(recording({ id: `r${i}` }))),
    );
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(Object.keys(saved).sort()).toEqual(
      ["a", ...Array.from({ length: 12 }, (_, i) => `r${i}`)].sort(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------- export

test("captions: timestamps carry into minutes and cue text cannot break the cue", () => {
  expect(stamp(0)).toBe("00:00:00.000");
  expect(stamp(59_999.6)).toBe("00:01:00.000");
  expect(stamp(3_599_999.9)).toBe("01:00:00.000");
  expect(stamp(3_723_456)).toBe("01:02:03.456");
  expect(cueText("Fish & <b>chips</b>\n\n\nnext --> line")).toBe(
    "Fish &amp; &lt;b>chips&lt;/b>\nnext → line",
  );
  expect(cueText("a\r\n \r\nb")).toBe("a\nb");
});

test("export fails fast when a music or sound file is missing", async () => {
  const { root, dir } = await setup();
  try {
    const bundle = await loadBundle(dir);
    bundle.edits.audio = {
      music: [
        {
          id: "bed",
          src: "audio/missing.wav",
          startMs: 0,
          offsetMs: 0,
          volume: 0.3,
          fadeInMs: 0,
          fadeOutMs: 0,
          duck: 0.35,
        },
      ],
      sfx: [],
    };
    await writeJson(path.join(dir, "edits.json"), bundle.edits);
    const out = path.join(root, "out");
    await expect(exportReplay(dir, out)).rejects.toThrow(
      "audio/missing.wav is missing",
    );
    // Nothing is left behind.
    expect(await stat(out).catch(() => null)).toBeNull();
    expect(
      (await readdir(root)).filter((n) => n.startsWith(".studio-export-")),
    ).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

// ------------------------------------------------------------------ capture

test("capture records a warning and stops cleanly at the event limit", async () => {
  const app = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      "<html><body><h1>Limit</h1><button onclick=\"document.querySelector('h1').textContent+='!'\">More</button></body></html>",
    );
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const port = (app.address() as { port: number }).port;
  const root = await mkdtemp(path.join(tmpdir(), "demohunter-cap-limit-"));
  try {
    const dir = await captureReplay({
      projectDir: path.join(root, "capture"),
      maxEvents: 3,
      loadedConfig: {
        projectRoot: root,
        configPath: "fixture",
        config: {
          ...DEFAULT_DEMOHUNTER_CONFIG,
          baseURL: `http://127.0.0.1:${port}`,
          outputDir: root,
          cacheDir: path.join(root, "cache"),
          record: { ...DEFAULT_DEMOHUNTER_CONFIG.record, cursor: false },
        },
      },
      tourFile: {
        path: "fixture",
        tour: {
          id: "limit",
          title: "Limit",
          async run({ page, goto }) {
            await goto("/");
            for (let i = 0; i < 8; i++) {
              await page.getByRole("button", { name: "More" }).click();
              await page.waitForTimeout(40);
            }
          },
        },
      },
    });
    const bundle = await loadBundle(dir);
    expect(bundle.project.capture.eventCount).toBe(3);
    expect(bundle.project.capture.warnings.join(" ")).toContain(
      "Recording stopped after 3 events",
    );
    const events = JSON.parse(await readProjectFile(dir, "events.json"));
    expect(events).toHaveLength(3);
    expect(events.some((e: { type: number }) => e.type === 2)).toBe(true);
  } finally {
    await new Promise<void>((resolve) => app.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 60000);


test("a holder that lost a stale lock does not remove its successor's lock", async () => {
  const { acquireLock } = await import("./storage.js");
  const root = await mkdtemp(path.join(tmpdir(), "dh-lock-"));
  try {
    const file = path.join(root, ".project.lock");
    const a = await acquireLock(file);
    expect(a).toBeDefined();
    // A stalls (e.g. laptop sleep): its stamp ages past the stale limit.
    const stamp = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...stamp, at: new Date(Date.now() - 60_000).toISOString() }));
    const b = await acquireLock(file);
    expect(b).toBeDefined();
    await a!.release();
    // B still owns the lock: a third writer must wait.
    expect(await acquireLock(file)).toBeUndefined();
    await b!.release();
    expect(await acquireLock(file)).toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------- symlinks and hostile files

const withCacheHome = async <T>(root: string, work: () => Promise<T>) => {
  const before = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = path.join(root, "xdg-cache");
  try {
    return await work();
  } finally {
    if (before === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = before;
  }
};

test("thumbnail and poster caches live outside the project and ignore a linked .studio", async () => {
  const { projectFrame, projectPoster, projectCacheFolder } = await import(
    "./poster.js"
  );
  const { root, dir } = await setup();
  try {
    await withCacheHome(root, async () => {
      const outside = path.join(root, "outside");
      await mkdir(outside);
      await writeFile(path.join(outside, "victim.png"), "keep");
      await writeFile(path.join(outside, "secret.json"), "not a cache");
      // What a cloned repository could commit.
      const revision = (await loadBundle(dir)).revision;
      await mkdir(path.join(dir, ".studio"));
      await symlink(outside, path.join(dir, ".studio/frames"));
      await symlink(
        path.join(outside, "victim.png"),
        path.join(dir, ".studio/poster.png"),
      );
      await writeFile(
        path.join(outside, "poster-json"),
        JSON.stringify({ revision, rendererVersion: 3 }),
      );
      await symlink(
        path.join(outside, "poster-json"),
        path.join(dir, ".studio/poster.json"),
      );
      const outsideBefore = (await readdir(outside)).sort();

      const frame = await projectFrame(dir, 0);
      expect(frame.subarray(1, 4).toString()).toBe("PNG");
      const poster = await projectPoster(dir);
      // Not the linked file's bytes.
      expect(poster.subarray(1, 4).toString()).toBe("PNG");

      const cache = await projectCacheFolder(dir);
      expect(cache.startsWith(root)).toBe(true); // under XDG_CACHE_HOME here
      expect(cache.startsWith(dir)).toBe(false);
      expect(((await stat(cache)).mode & 0o777).toString(8)).toBe("700");
      expect((await readdir(cache)).sort()).toEqual(
        [`${revision}-0.png`, "poster.json", "poster.png"].sort(),
      );
      // Nothing behind the links changed.
      expect((await readdir(outside)).sort()).toEqual(outsideBefore);
      expect(await readFile(path.join(outside, "victim.png"), "utf8")).toBe("keep");

      // Revision-keyed reuse: the cached file is served, not re-rendered.
      await writeFile(path.join(cache, `${revision}-0.png`), "CACHED");
      expect((await projectFrame(dir, 0)).toString()).toBe("CACHED");

      // A new frame prunes other revisions' thumbnails, and only those: other
      // names and links are left alone.
      await writeFile(path.join(cache, "0123456789abcdef-5.png"), "old");
      await writeFile(path.join(cache, "notes.txt"), "mine");
      await symlink(
        path.join(outside, "victim.png"),
        path.join(cache, "fedcba9876543210-1.png"),
      );
      await projectFrame(dir, 100);
      const names = (await readdir(cache)).sort();
      expect(names).toContain("notes.txt");
      expect(names).toContain("fedcba9876543210-1.png");
      expect(names).toContain(`${revision}-100.png`);
      expect(names).not.toContain("0123456789abcdef-5.png");
      expect(await readFile(path.join(outside, "victim.png"), "utf8")).toBe("keep");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120000);

test("a linked scenes/ or audio/ is refused, not followed; the walk is bounded", async () => {
  const { assetStamp } = await import("./storage.js");
  const { root, dir } = await projectFixture();
  try {
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "x.html"), "secret");
    for (const name of ["scenes", "audio"]) {
      await symlink(outside, path.join(dir, name));
      await expect(loadBundle(dir)).rejects.toThrow(
        `${name}/ must be a folder inside the project, not a link`,
      );
      // The cheap stamp does not walk it either.
      expect(await assetStamp(dir)).toContain(`${name}:unusable`);
      expect(await assetStamp(dir)).not.toContain("x.html");
      await rm(path.join(dir, name));
    }
    expect((await loadBundle(dir)).assetStamps).toEqual({});

    // Many files: only the first 2000 (by name) are fingerprinted.
    await mkdir(path.join(dir, "scenes"));
    await Promise.all(
      Array.from({ length: 2100 }, (_, i) =>
        writeFile(path.join(dir, "scenes", `s${String(i).padStart(4, "0")}.html`), "x"),
      ),
    );
    expect(Object.keys((await loadBundle(dir)).assetStamps!).length).toBe(2000);
    await rm(path.join(dir, "scenes"), { recursive: true });

    // A big scene file is stamped by size and time, not read and hashed.
    await mkdir(path.join(dir, "scenes"));
    await writeFile(path.join(dir, "scenes/big.html"), Buffer.alloc(6 * 1024 * 1024));
    await writeFile(path.join(dir, "scenes/small.html"), "x");
    const stamps = (await loadBundle(dir)).assetStamps!;
    expect(stamps["scenes/big.html"]).toMatch(/^6291456:/);
    expect(stamps["scenes/small.html"]).toMatch(/^[0-9a-f]{16}$/);
    // Interrupted-write temp files are not content.
    await writeFile(path.join(dir, "scenes/a.html.1.x.tmp"), "x");
    expect(Object.keys((await loadBundle(dir)).assetStamps!)).not.toContain(
      "scenes/a.html.1.x.tmp",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("element sources are never written through a linked folder or file", async () => {
  const { ensureElementIndex, indexEvents } = await import("./elements.js");
  const { root, dir } = await projectFixture();
  try {
    const events = [{ type: 4, timestamp: 1000, data: {} }, snapshot];
    await writeJson(path.join(dir, "events.json"), events);
    const ref = indexEvents(events).snippets[0]!.ref;
    const outside = path.join(root, "outside");
    await mkdir(outside);
    // sources -> elsewhere.
    await symlink(outside, path.join(dir, "sources"));
    await expect(ensureElementIndex(dir)).rejects.toThrow("not a link");
    expect(await readdir(outside)).toEqual([]);
    await rm(path.join(dir, "sources"));
    // sources/<ref>.html -> a file elsewhere: refused before anything is written.
    await mkdir(path.join(dir, "sources"));
    await writeFile(path.join(outside, "victim.html"), "keep");
    await symlink(
      path.join(outside, "victim.html"),
      path.join(dir, "sources", `${ref}.html`),
    );
    await expect(ensureElementIndex(dir)).rejects.toThrow("not a regular file");
    expect(await readFile(path.join(outside, "victim.html"), "utf8")).toBe("keep");
    await expect(stat(path.join(dir, "elements.json"))).rejects.toThrow();
    // Honest project: written atomically, no temp files left.
    await rm(path.join(dir, "sources"), { recursive: true });
    const index = await ensureElementIndex(dir);
    expect(index.elements.length).toBeGreaterThan(0);
    expect((await readdir(path.join(dir, "sources"))).sort()).toEqual(
      indexEvents(events).snippets.map((s) => `${s.ref}.html`).sort(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("narration audio is copied beside the target and renamed, never through a link", async () => {
  const { root, dir } = await projectFixture();
  const resolve = fakeVoice(root) as typeof resolveNarrationSegment;
  try {
    const outside = path.join(root, "outside");
    await mkdir(outside);
    // audio/ itself is a link.
    await symlink(outside, path.join(dir, "audio"));
    await expect(regenerateNarration(dir, { resolve })).rejects.toThrow(
      "not a link",
    );
    expect(await readdir(outside)).toEqual([]);
    await rm(path.join(dir, "audio"));
    // The destination file (named for the segment) is a link elsewhere.
    await mkdir(path.join(dir, "audio"));
    await writeFile(path.join(outside, "victim.wav"), "keep");
    await symlink(
      path.join(outside, "victim.wav"),
      path.join(dir, "audio/n1-key-Thesamea.wav"),
    );
    // (The linked name makes the fingerprint read it as "not a file": fine.)
    expect((await regenerateNarration(dir, { resolve })).generated).toBe(1);
    expect(await readFile(path.join(outside, "victim.wav"), "utf8")).toBe("keep");
    const placed = await lstat(path.join(dir, "audio/n1-key-Thesamea.wav"));
    expect(placed.isFile()).toBe(true);
    expect(placed.size).toBe(wavBytes().length);
    expect(
      (await readdir(path.join(dir, "audio"))).filter((n) => n.endsWith(".tmp")),
    ).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("studio session, seen marks and activity refuse linked runtime folders", async () => {
  const { writeStudioSession, readStudioSession, clearStudioSession } =
    await import("./workspace.js");
  const { beginActivity, trackActivity, readActivity } = await import(
    "./activity.js"
  );
  const { root, dir } = await projectFixture();
  const session = {
    protocolVersion: 1 as const,
    projectDir: "x",
    projectId: "y",
    title: "T",
    updatedAt: new Date().toISOString(),
    serverId: "s1",
  };
  try {
    const outside = path.join(root, "outside");
    const workspace = path.join(root, "ws");
    await mkdir(outside);
    await mkdir(workspace);

    // .demohunter -> elsewhere.
    await symlink(outside, path.join(workspace, ".demohunter"));
    await expect(writeStudioSession(workspace, session)).rejects.toThrow("not a link");
    const library = { id: "a", captureId: "c", agentChanges: 0 } as never;
    await new SeenDemos(workspace).mark(library); // best effort: must not throw
    expect(await readdir(outside)).toEqual([]);
    await rm(path.join(workspace, ".demohunter"));

    // .demohunter/studio -> elsewhere.
    await mkdir(path.join(workspace, ".demohunter"));
    await symlink(outside, path.join(workspace, ".demohunter/studio"));
    await expect(writeStudioSession(workspace, session)).rejects.toThrow("not a link");
    await new SeenDemos(workspace).mark(library);
    expect(await readdir(outside)).toEqual([]);
    await rm(path.join(workspace, ".demohunter/studio"));

    // A session file someone else planted behind a link is neither read nor removed.
    await writeFile(path.join(outside, "session.json"), JSON.stringify(session));
    await symlink(outside, path.join(workspace, ".demohunter/studio"));
    expect(await readStudioSession(workspace)).toBeNull();
    await clearStudioSession(workspace, "s1");
    expect(await readdir(outside)).toEqual(["session.json"]);
    await rm(path.join(workspace, ".demohunter/studio"));

    // A linked .gitignore is not written through; the session still lands.
    await mkdir(path.join(workspace, ".demohunter/studio"));
    await writeFile(path.join(outside, "ignore-target"), "keep");
    await symlink(
      path.join(outside, "ignore-target"),
      path.join(workspace, ".demohunter/studio/.gitignore"),
    );
    await writeStudioSession(workspace, session);
    expect(await readFile(path.join(outside, "ignore-target"), "utf8")).toBe("keep");
    expect((await readStudioSession(workspace))?.serverId).toBe("s1");
    // A linked session.json is replaced, not written through.
    await rm(path.join(workspace, ".demohunter/studio/session.json"));
    await symlink(
      path.join(outside, "ignore-target"),
      path.join(workspace, ".demohunter/studio/session.json"),
    );
    await writeStudioSession(workspace, session);
    expect(await readFile(path.join(outside, "ignore-target"), "utf8")).toBe("keep");

    // Activity: .studio -> elsewhere, then .studio/activity -> elsewhere.
    await rm(outside, { recursive: true });
    await mkdir(outside);
    await symlink(outside, path.join(dir, ".studio"));
    await expect(
      beginActivity(dir, "s", "agent", "get_selection", {}),
    ).rejects.toThrow("not a link");
    const finish = await trackActivity(dir, "s", "agent", "get_selection", {});
    await finish();
    expect(await readdir(outside)).toEqual([]);
    expect(await readActivity(dir)).toEqual([]);
    await rm(path.join(dir, ".studio"));
    await mkdir(path.join(dir, ".studio"));
    await symlink(outside, path.join(dir, ".studio/activity"));
    await expect(
      beginActivity(dir, "s", "agent", "get_selection", {}),
    ).rejects.toThrow("not a link");
    expect(await readdir(outside)).toEqual([]);
    // Honest folders still work.
    await rm(path.join(dir, ".studio/activity"));
    const done = await beginActivity(dir, "s", "agent", "get_selection", {});
    await done();
    expect((await readActivity(dir))[0]?.status).toBe("succeeded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- lock hardening

test("lock takeover: concurrent takers of a dead lock never both hold it", async () => {
  const { acquireLock } = await import("./storage.js");
  const root = await mkdtemp(path.join(tmpdir(), "dh-lock-"));
  const file = path.join(root, ".project.lock");
  const dead = deadPid();
  try {
    let maxHolders = 0;
    for (let round = 0; round < 50; round++) {
      await writeFile(
        file,
        JSON.stringify({ pid: dead, at: new Date().toISOString() }),
      );
      let holders = 0,
        won = 0;
      await Promise.all(
        Array.from({ length: 12 }, async () => {
          const lock = await acquireLock(file);
          if (!lock) return;
          won++;
          maxHolders = Math.max(maxHolders, ++holders);
          await new Promise((resolve) => setTimeout(resolve, 15));
          holders--;
          await lock.release();
        }),
      );
      expect(won).toBeGreaterThan(0);
      expect(maxHolders).toBe(1);
      await expect(stat(`${file}.reap`)).rejects.toThrow();
      await rm(file, { force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120000);

test("locks: a FIFO, a link or a device is an error, never opened or followed", async () => {
  const { acquireLock } = await import("./storage.js");
  const root = await mkdtemp(path.join(tmpdir(), "dh-lock-"));
  const file = path.join(root, ".project.lock");
  try {
    // FIFO: reading it would block forever.
    expect(spawnSync("mkfifo", [file]).status).toBe(0);
    await expect(acquireLock(file)).rejects.toThrow("not a regular file");
    await rm(file);
    // Symlink to a file elsewhere (and a dangling one).
    const target = path.join(root, "target");
    await writeFile(target, JSON.stringify({ pid: deadPid(), at: "2000-01-01" }));
    await symlink(target, file);
    await expect(acquireLock(file)).rejects.toThrow("not a regular file");
    expect(await readFile(target, "utf8")).toContain("2000-01-01");
    await rm(file);
    await symlink(path.join(root, "missing"), file);
    await expect(acquireLock(file)).rejects.toThrow("not a regular file");
    await rm(file);
    // A directory.
    await mkdir(file);
    await expect(acquireLock(file)).rejects.toThrow("not a regular file");
    await rm(file, { recursive: true });
    // A FIFO planted as the takeover lock.
    await writeFile(
      file,
      JSON.stringify({ pid: deadPid(), at: new Date().toISOString() }),
    );
    expect(spawnSync("mkfifo", [`${file}.reap`]).status).toBe(0);
    await expect(acquireLock(file)).rejects.toThrow("not a regular file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("locks: future stamps, huge files and abandoned takeover locks", async () => {
  const { acquireLock } = await import("./storage.js");
  const { utimes } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "dh-lock-"));
  const file = path.join(root, ".project.lock");
  const ago = (ms: number) => new Date(Date.now() - ms);
  try {
    // A forged future stamp from a live process does not make a lock
    // untouchable forever: it counts as "now", so it ages out.
    await writeFile(
      file,
      JSON.stringify({ pid: process.pid, at: new Date(Date.now() + 3_600_000).toISOString() }),
    );
    expect(await acquireLock(file)).toBeUndefined(); // fresh as of now
    // ...and a dead owner's future-dated lock is taken at once.
    await writeFile(
      file,
      JSON.stringify({ pid: deadPid(), at: new Date(Date.now() + 3_600_000).toISOString() }),
    );
    const taken = await acquireLock(file);
    expect(taken).toBeDefined();
    await taken!.release();

    // Only the first 4 KB is read: a megabyte of junk is judged by file time.
    await writeFile(file, "x".repeat(1_000_000));
    expect(await acquireLock(file)).toBeUndefined();
    await utimes(file, ago(60_000), ago(60_000));
    const old = await acquireLock(file);
    expect(old).toBeDefined();
    await old!.release();

    // A takeover lock left by a crashed taker expires; a fresh one is respected.
    const dead = JSON.stringify({ pid: deadPid(), at: new Date().toISOString() });
    await writeFile(file, dead);
    await writeFile(`${file}.reap`, "");
    expect(await acquireLock(file)).toBeUndefined(); // another taker is busy
    expect(await readFile(file, "utf8")).toBe(dead);
    await utimes(`${file}.reap`, ago(60_000), ago(60_000));
    const after = await acquireLock(file);
    expect(after).toBeDefined();
    await after!.release();
    await expect(stat(`${file}.reap`)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
