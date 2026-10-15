import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { projectFixture } from "./test-support.js";
import {
  historySummary,
  loadBundle,
  mutateProject,
  mutationAuthor,
  undoProject,
  writeJson,
} from "./storage.js";
import { LocalLibrary } from "./library.js";
import { gitStatus } from "./git.js";

const agent = {
  actor: "Claude Code",
  sessionId: "session-1",
  tool: "apply_element_edit",
  elementRef: "d1-total-n9",
};

test("history attributes agent writes, lists readable changes and undoes a whole turn", async () => {
  const { root, dir } = await projectFixture();
  try {
    const start = await loadBundle(dir);
    await mutateProject(dir, start.revision, "You edit", (d) => {
      d.project.title = "Human title";
    });
    let current = await loadBundle(dir);
    await mutationAuthor.run(agent, () =>
      mutateProject(dir, current.revision, "Agent style", (d) => {
        d.edits.elements.push({
          id: "total",
          target: { ref: "d1-total-n9" },
          text: "€2,640.00",
          style: { "font-size": "28px" },
        });
      }),
    );
    current = await loadBundle(dir);
    await mutationAuthor.run({ ...agent, tool: "update_narration" }, () =>
      mutateProject(dir, current.revision, "Agent script", (d) => {
        d.narration.segments[0]!.text = "A different amount.";
      }),
    );
    const history = await historySummary(dir);
    expect(history.map((h) => h.author?.actor)).toEqual([
      "Claude Code",
      "Claude Code",
      undefined,
    ]);
    expect(history[1]!.author).toMatchObject({
      sessionId: "session-1",
      elementRef: "d1-total-n9",
    });
    expect(history[1]!.changes).toEqual([
      expect.objectContaining({ kind: "text", after: "€2,640.00" }),
      expect.objectContaining({
        kind: "style",
        after: "font-size 28px",
        ref: "d1-total-n9",
      }),
    ]);
    expect(history[0]!.changes![0]).toMatchObject({
      kind: "narration",
      before: "The same amount.",
      after: "A different amount.",
    });
    expect(history[2]!.changes![0]!.kind).toBe("project");
    // "Undo turn": both agent entries, one locked operation.
    current = await loadBundle(dir);
    const undone = await undoProject(dir, current.revision, 2);
    expect(undone.edits.elements).toEqual([]);
    expect(undone.narration.segments[0]!.text).toBe("The same amount.");
    expect(undone.project.title).toBe("Human title");
    expect(await historySummary(dir)).toHaveLength(1);
    await expect(undoProject(dir, undone.revision, 5)).rejects.toThrow(
      "Not enough",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("undo cannot cross an external edit between tracked changes, even across separate requests", async () => {
  const { root, dir } = await projectFixture();
  try {
    let current = await loadBundle(dir);
    await mutateProject(dir, current.revision, "First agent edit", (d) => {
      d.narration.segments[0]!.text = "First agent script";
    });
    const external = await loadBundle(dir);
    external.project.title = "Keep this direct file edit";
    await writeJson(path.join(dir, "project.json"), external.project);
    current = await loadBundle(dir);
    await mutateProject(dir, current.revision, "Second agent edit", (d) => {
      d.narration.segments[0]!.text = "Second agent script";
    });
    current = await loadBundle(dir);
    const history = await historySummary(dir);
    await expect(undoProject(dir, current.revision, 2)).rejects.toThrow(
      "outside",
    );
    expect((await loadBundle(dir)).revision).toBe(current.revision);
    expect(await historySummary(dir)).toEqual(history);
    const once = await undoProject(dir, current.revision);
    expect(once.project.title).toBe("Keep this direct file edit");
    expect(once.narration.segments[0]!.text).toBe("First agent script");
    await expect(undoProject(dir, once.revision)).rejects.toThrow("outside");
    expect((await loadBundle(dir)).project.title).toBe(
      "Keep this direct file edit",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("library links recordings to tours and notices a changed tour", async () => {
  const { root, dir } = await projectFixture();
  try {
    await mkdir(path.join(root, "demos"));
    const tour = path.join(root, "demos/invoices.tour.ts");
    const source =
      'export default { id: "invoices", title: "Invoice approval" };';
    await writeFile(tour, source);
    await writeJson(path.join(dir, "studio.json"), {
      format: "demohunter.studio",
      formatVersion: 1,
      protocolVersion: 1,
      projectId: "7d1b7a63-2a8f-4a39-9a43-0a7f6b5f0a11",
      captureId: "0123456789abcdef",
      createdAt: new Date().toISOString(),
      files: {
        project: "project.json",
        events: "events.json",
        elements: "elements.json",
        edits: "edits.json",
        narration: "narration.json",
        comments: "comments.json",
        css: "overrides.css",
      },
      source: {
        tour: "demos/invoices.tour.ts",
        tourSha256: createHash("sha256").update(source).digest("hex"),
      },
    });
    const library = await LocalLibrary.open(root);
    let scan = await library.scan();
    const linked = scan.tours.find((t) => t.path === "demos/invoices.tour.ts")!;
    expect(linked.title).toBe("Invoice approval");
    expect(linked.recordings).toHaveLength(1);
    expect(scan.recordings[0]).toMatchObject({
      tourPath: "demos/invoices.tour.ts",
      tourChanged: false,
      agentChanges: 0,
    });
    await writeFile(tour, source.replace("approval", "approvals"));
    scan = await library.scan();
    expect(scan.recordings[0]!.tourChanged).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git status reports branch and changed files, and tolerates non-repositories", async () => {
  const { root, dir } = await projectFixture();
  try {
    expect(await gitStatus(dir, 0)).toEqual({ changed: [] });
    const run = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, stdio: "ignore" });
    run("init", "-q", "-b", "main");
    run("add", ".");
    run(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "init",
    );
    await writeFile(path.join(dir, "overrides.css"), "h1{color:red}");
    await writeJson(path.join(dir, "selection.json"), { ignored: true });
    const status = await gitStatus(dir, 0);
    expect(status.branch).toBe("main");
    expect(status.changed).toEqual(["project/overrides.css"]);
    expect(status.ignored).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed capture removes its new folder so a retry can use the same path", async () => {
  const { root } = await projectFixture();
  try {
    const { captureReplay } = await import("./capture.js");
    const { existsSync } = await import("node:fs");
    const target = path.join(root, "new-capture");
    await expect(
      captureReplay({
        projectDir: target,
        loadedConfig: { config: { browser: "not-a-browser" } },
      } as any),
    ).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
