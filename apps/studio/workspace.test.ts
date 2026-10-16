import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readActivity } from "./activity.js";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fixture, projectFixture, wavBytes } from "./test-support.js";
import { loadBundle, mutateProject, writeJson } from "./storage.js";
import {
  ReplayWorkspace,
  libraryProjectId,
  readStudioSession,
  sessionFile,
  writeStudioSession,
} from "./workspace.js";
import { serveLibrary } from "./library-server.js";
import {
  commentUri,
  elementUri,
  previewLink,
  parseReference,
} from "./links.js";
import { indexEvents } from "./elements.js";
import { sampleAnimation } from "./model.js";

const snapshot = (title = "Invoice") => ({
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
          attributes: { id: "title", "data-demohunter-source": "fixture.html" },
          childNodes: [{ type: 3, id: 3, textContent: title }],
        },
      ],
    },
  },
});
async function setup() {
  const result = await projectFixture();
  await writeJson(path.join(result.dir, "events.json"), [
    { type: 4, timestamp: 1000, data: {} },
    snapshot(),
  ]);
  return { ...result, workspace: await ReplayWorkspace.open(result.dir) };
}

test("element links preserve capture identity, document scope and honest source locations", async () => {
  const { root, dir, workspace: w } = await setup();
  try {
    const e = w.index.elements[0]!;
    expect(e.source.originalFile).toBe("fixture.html");
    expect((await w.html(e.ref)).html).toContain(
      `data-demohunter-ref="${e.ref}"`,
    );
    expect((await ReplayWorkspace.open(dir)).index).toEqual(w.index);
    for (const link of [
      elementUri(w.index.captureId, e.ref, 120),
      previewLink("http://localhost:4310", w.index.captureId, e.ref, 120),
    ])
      expect((await w.resolve(link)).outputMs).toBe(120);
    await expect(
      w.resolve(elementUri("0123456789abcdef", e.ref)),
    ).rejects.toThrow("different capture");
    expect(() => parseReference("file:///etc/passwd")).toThrow();
    const scoped = indexEvents([
      { type: 4, timestamp: 1000, data: {} },
      snapshot(),
      { type: 4, timestamp: 2000, data: {} },
      { ...snapshot("Second"), timestamp: 2001 },
    ]);
    expect(new Set(scoped.elements.map((e) => e.ref)).size).toBe(2);
    await writeJson(path.join(dir, "events.json"), []);
    await expect(ReplayWorkspace.open(dir)).rejects.toThrow("Capture changed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("comment links resolve the exact thread, including resolved and recording-wide notes", async () => {
  const { root, dir, workspace: w } = await setup();
  try {
    const ref = w.index.elements[0]!.ref;
    const anchored = await w.addComment({
      expectedRevision: (await loadBundle(dir)).revision,
      elementRef: ref,
      timeMs: 120,
      body: "Change this heading",
    });
    await w.commentAction({
      expectedRevision: anchored.revision,
      threadId: anchored.id,
      reply: "Checked the result",
      status: "resolved",
    });
    const general = await w.addComment({
      expectedRevision: (await loadBundle(dir)).revision,
      timeMs: 200,
      body: "Shorten the whole recording",
    });
    const before = (await loadBundle(dir)).revision;
    for (const reference of [
      anchored.id,
      commentUri(w.index.captureId, anchored.id, 120),
      previewLink(
        "http://localhost:4310/projects/demo/",
        w.index.captureId,
        ref,
        120,
        anchored.id,
      ),
    ]) {
      const result = await w.resolve(reference);
      expect(result.comment?.id).toBe(anchored.id);
      expect(result.comment?.status).toBe("resolved");
      expect(result.comment?.replies[0]?.body).toBe("Checked the result");
      expect(result.outputMs).toBe(120);
      expect(result.capturedHtml?.html).toContain("Invoice");
    }
    const result = await w.resolve(commentUri(w.index.captureId, general.id));
    expect(result.comment?.body).toBe("Shorten the whole recording");
    expect(result.outputMs).toBe(200);
    expect(result.capturedHtml).toBeUndefined();
    expect((await loadBundle(dir)).revision).toBe(before);
    await expect(
      w.resolve(commentUri("0123456789abcdef", anchored.id)),
    ).rejects.toThrow("different capture");
    await expect(
      w.resolve(commentUri(w.index.captureId, "comment-missing")),
    ).rejects.toThrow("Comment not found");
    expect(() =>
      parseReference(commentUri(w.index.captureId, "../bad")),
    ).toThrow();
    expect(() =>
      parseReference(commentUri(w.index.captureId, general.id, -1)),
    ).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent writes conflict, comment threads round-trip, undo protects external changes", async () => {
  const { root, dir, workspace: w } = await setup();
  try {
    const initial = await loadBundle(dir);
    const results = await Promise.allSettled([
      w.change(initial.revision, "First", (d) => {
        d.project.title = "First";
      }),
      w.change(initial.revision, "Second", (d) => {
        d.project.title = "Second";
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    let revision = (await loadBundle(dir)).revision;
    const comment = await w.addComment({
      expectedRevision: revision,
      elementRef: w.index.elements[0]!.ref,
      timeMs: 100,
      body: "Make the total clearer",
    });
    revision = (
      await w.commentAction({
        expectedRevision: comment.revision,
        threadId: comment.id,
        reply: "Adjusted contrast",
        author: "Agent",
        status: "resolved",
      })
    ).revision;
    expect((await loadBundle(dir)).comments.threads[0]!.replies[0]!.body).toBe(
      "Adjusted contrast",
    );
    await w.undo(revision);
    expect((await loadBundle(dir)).comments.threads[0]!.status).toBe("open");
    const external = await loadBundle(dir);
    external.project.title = "External";
    await writeJson(path.join(dir, "project.json"), external.project);
    await expect(w.undo((await loadBundle(dir)).revision)).rejects.toThrow(
      "outside",
    );
    const before = await loadBundle(dir);
    await writeJson(path.join(dir, ".history/edits.json"), { bad: true });
    // Malformed history must not cause a partial content write.
    await expect(
      mutateProject(dir, before.revision, "Bad history", (d) => {
        d.project.title = "Lost";
      }),
    ).rejects.toThrow();
    expect((await loadBundle(dir)).project.title).toBe("External");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent can inspect and edit through the real stdio MCP transport", async () => {
  const { root, dir, workspace: w } = await setup();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(import.meta.dir, "cli.ts"), "mcp", dir],
    stderr: "pipe",
  });
  const client = new Client({ name: "replay-test", version: "1.0.0" });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    expect(r.isError).not.toBe(true);
    return JSON.parse((r.content as any)[0].text);
  };
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("get_screenshot");
    expect(names).toContain("get_selection");
    const info = await call("get_basic_info"),
      ref = w.index.elements[0]!.ref;
    expect((await call("get_html", { elementRef: ref })).html).toContain(
      "Invoice",
    );
    const readRevision = (await loadBundle(dir)).revision;
    expect(
      (await readActivity(dir)).some(
        (e) => e.actor === "replay-test" && e.status === "succeeded",
      ),
    ).toBe(true);
    expect(readRevision).toBe(info.revision);
    const changed = await call("apply_element_edit", {
      expectedRevision: info.revision,
      elementRef: ref,
      text: "Approved invoice",
    });
    expect((await loadBundle(dir)).edits.elements[0]!.text).toBe(
      "Approved invoice",
    );
    const stale = await client.callTool({
      name: "apply_element_edit",
      arguments: {
        expectedRevision: info.revision,
        elementRef: ref,
        text: "Clobber",
      },
    });
    expect(stale.isError).toBe(true);
    const comment = await call("add_comment", {
      expectedRevision: changed.revision,
      elementRef: ref,
      timeMs: 0,
      body: "Looks good",
    });
    expect((await call("list_comments")).threads).toHaveLength(1);
    for (const reference of [
      comment.id,
      commentUri(w.index.captureId, comment.id),
    ]) {
      const resolved = await call("resolve_reference", { reference });
      expect(resolved.threadId).toBe(comment.id);
      expect(resolved.comment.body).toBe("Looks good");
      expect(resolved.capturedHtml.html).toContain("Invoice");
    }
    const beforeCamera = await loadBundle(dir);
    const camera = await call("update_timeline_item", {
      expectedRevision: beforeCamera.revision,
      item: {
        kind: "camera",
        value: {
          id: "agent-zoom",
          target: { ref },
          startMs: 0,
          endMs: 300,
          scale: 1.2,
        },
      },
    });
    expect((await loadBundle(dir)).edits.camera[0]!.id).toBe("agent-zoom");
    await call("remove_timeline_item", {
      expectedRevision: camera.revision,
      collection: "camera",
      id: "agent-zoom",
    });
    expect((await loadBundle(dir)).edits.camera).toHaveLength(0);
    expect((await call("get_schema", { file: "edits" })).type).toBe("object");

    expect(
      (
        await call("resolve_reference", {
          reference: elementUri(w.index.captureId, ref),
        })
      ).editFile,
    ).toBe("edits.json");
    await call("set_selection", { elementRef: ref, outputMs: 10 });
    expect(
      JSON.parse(await readFile(path.join(dir, "preview-command.json"), "utf8"))
        .elementRef,
    ).toBe(ref);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

test("animations interpolate output time and retain final values only with forwards fill", () => {
  const animation = {
    id: "fade",
    target: { ref: "title" },
    startMs: 100,
    endMs: 1100,
    from: { opacity: 0, x: 0 },
    to: { opacity: 1, x: 100 },
    easing: "linear" as const,
    fill: "forwards" as const,
  };
  expect(sampleAnimation(animation, 600)).toMatchObject({
    opacity: 0.5,
    x: 50,
  });
  expect(sampleAnimation(animation, 1200)).toMatchObject({
    opacity: 1,
    x: 100,
  });
  expect(sampleAnimation({ ...animation, fill: "none" }, 1200)).toBeUndefined();
});

/** A workspace with two demos whose captures (and titles) differ. */
async function twoDemos() {
  const root = await mkdtemp(path.join(tmpdir(), "demohunter-workspace-"));
  const dirs: Record<"alpha" | "beta", string> = {
    alpha: path.join(root, "demos", "alpha"),
    beta: path.join(root, "demos", "beta"),
  };
  for (const [name, dir] of Object.entries(dirs)) {
    await mkdir(dir, { recursive: true });
    const data = fixture();
    data.project.title = name === "alpha" ? "Alpha demo" : "Beta demo";
    await Promise.all([
      writeJson(path.join(dir, "project.json"), data.project),
      writeJson(path.join(dir, "edits.json"), data.edits),
      writeJson(path.join(dir, "narration.json"), data.narration),
      writeJson(path.join(dir, "events.json"), [
        { type: 4, timestamp: 1000, data: {} },
        snapshot(name === "alpha" ? "Alpha" : "Beta"),
      ]),
      writeFile(path.join(dir, "overrides.css"), ""),
    ]);
  }
  return { root, dirs };
}
async function connect(target: string) {
  const client = new Client({ name: "workspace-test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve(import.meta.dir, "cli.ts"), "mcp", target],
      stderr: "pipe",
    }),
  );
  const raw = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args }) as Promise<{
      isError?: boolean;
      content: { text: string }[];
    }>;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await raw(name, args);
    if (r.isError) throw new Error(r.content[0]!.text);
    return JSON.parse(r.content[0]!.text);
  };
  const fails = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await raw(name, args);
    expect(r.isError).toBe(true);
    return r.content[0]!.text;
  };
  return { client, call, fails };
}
const viewing = (root: string, projectDir: string, ageMs = 0) =>
  writeStudioSession(root, {
    protocolVersion: 1,
    projectDir,
    projectId: libraryProjectId(projectDir),
    title: projectDir,
    updatedAt: new Date(Date.now() - ageMs).toISOString(),
  });

test("workspace MCP edits the demo open in Studio, an explicit project, or refuses to guess", async () => {
  const { root, dirs } = await twoDemos();
  const { client, call, fails } = await connect(root);
  try {
    // No Studio session: a clear error listing every demo.
    const closed = await fails("get_basic_info");
    expect(closed).toContain("No demo is open in DemoHunter Studio");
    expect(closed).toContain('project: "demos/alpha"');
    expect(closed).toContain('project: "demos/beta"');
    const listed = await call("list_projects");
    expect(listed.mode).toBe("workspace");
    expect(listed.current).toBeNull();
    expect(listed.projects.map((p: any) => p.path).sort()).toEqual([
      "demos/alpha",
      "demos/beta",
    ]);

    await viewing(root, "demos/alpha");
    const alpha = await call("get_basic_info");
    expect(alpha.target).toMatchObject({
      title: "Alpha demo",
      path: "demos/alpha",
      id: libraryProjectId("demos/alpha"),
      source: "studio",
    });
    const [ref] = (await call("find_elements", { query: "Alpha" })).map(
      (e: any) => e.ref,
    );
    const edited = await call("apply_element_edit", {
      expectedRevision: alpha.revision,
      elementRef: ref,
      text: "Edited alpha",
    });
    expect(edited.project).toEqual({
      title: "Alpha demo",
      path: "demos/alpha",
    });
    expect((await loadBundle(dirs.alpha)).edits.elements[0]!.text).toBe(
      "Edited alpha",
    );
    expect((await loadBundle(dirs.beta)).edits.elements).toHaveLength(0);
    // Presence is recorded in the demo being edited, not the other one.
    expect(
      (await readActivity(dirs.alpha)).some(
        (a) => a.tool === "apply_element_edit" && a.status === "succeeded",
      ),
    ).toBe(true);
    expect(await readActivity(dirs.beta)).toHaveLength(0);

    // The person opens another demo: the next call follows them.
    await viewing(root, "demos/beta");
    const beta = await call("get_basic_info");
    expect(beta.target).toMatchObject({ title: "Beta demo", source: "studio" });
    // Edits to the previous demo's stale revision cannot land in this one.
    expect(
      await fails("apply_element_edit", {
        expectedRevision: edited.revision,
        elementRef: (await call("find_elements", { query: "Beta" }))[0].ref,
        text: "Wrong",
      }),
    ).toContain('demo: "Beta demo"');

    // Explicit project (path or library id) overrides Studio.
    for (const project of ["demos/alpha", libraryProjectId("demos/alpha")])
      expect((await call("get_basic_info", { project })).target).toMatchObject({
        title: "Alpha demo",
        source: "explicit",
      });
    // A copied link selects the demo that owns its capture.
    const alphaCapture = (
      await call("get_basic_info", { project: "demos/alpha" })
    ).captureId;
    const resolved = await call("resolve_reference", {
      reference: `demohunter://capture/${alphaCapture}/element/${ref}?t=0`,
    });
    expect(resolved.target).toMatchObject({
      title: "Alpha demo",
      source: "reference",
    });
    for (const project of ["../outside", "demos", "demos/missing"])
      expect(await fails("get_basic_info", { project })).toContain(
        "No demo matches",
      );

    // A stale record (Studio closed or idle) is never a target.
    await viewing(root, "demos/beta", 5 * 60_000);
    const stale = await fails("get_timeline");
    expect(stale).toContain("no longer a safe target");
    expect(stale).toContain('project: "demos/alpha"');
    expect(
      (await call("get_timeline", { project: "demos/beta" })).clips,
    ).toHaveLength(2);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("a project directory still binds the MCP server to that one demo", async () => {
  const { root, dirs } = await twoDemos();
  await viewing(root, "demos/beta");
  const { client, call, fails } = await connect(dirs.alpha);
  try {
    expect((await call("get_basic_info")).target).toMatchObject({
      title: "Alpha demo",
      source: "bound",
    });
    expect((await call("list_projects")).projects).toHaveLength(1);
    expect(await fails("get_basic_info", { project: "../beta" })).toContain(
      "bound to one demo",
    );
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

test("library server records the demo the person is viewing", async () => {
  const { root } = await twoDemos();
  const library = await serveLibrary(root, { port: 0 });
  const alpha = libraryProjectId("demos/alpha"),
    beta = libraryProjectId("demos/beta");
  const until = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 100 && !(await check()); i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(await check()).toBe(true);
  };
  const shown = async () =>
    (await readStudioSession(library.library.root))?.projectId;
  try {
    await fetch(`${library.url}/projects/${alpha}/`).then((r) => r.text());
    await until(async () => (await shown()) === alpha);
    const session = await readStudioSession(library.library.root);
    expect(session).toMatchObject({
      projectDir: "demos/alpha",
      title: "Alpha demo",
      url: `${library.url}/projects/${alpha}/`,
    });
    expect(
      await readFile(
        path.join(
          path.dirname(sessionFile(library.library.root)),
          ".gitignore",
        ),
        "utf8",
      ),
    ).toBe("*\n");
    // Background polls keep a demo alive but do not steal focus.
    await fetch(`${library.url}/projects/${beta}/api/status`).then((r) =>
      r.text(),
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(await shown()).toBe(alpha);
    // Opening (or acting in) another demo makes it the target.
    await fetch(`${library.url}/projects/${beta}/`).then((r) => r.text());
    await until(async () => (await shown()) === beta);
    await fetch(`${library.url}/projects/${alpha}/api/status`).then((r) =>
      r.text(),
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(await shown()).toBe(beta);
    await fetch(`${library.url}/projects/${alpha}/api/status?focused=1`).then(
      (r) => r.text(),
    );
    await until(async () => (await shown()) === alpha);
    // Connect agent offers one workspace-scoped server for every demo.
    const workspace = await fetch(
      `${library.url}/projects/${alpha}/api/workspace`,
    ).then((r) => r.json());
    expect(workspace.connection.scope).toBe("workspace");
    expect(workspace.connection.args.slice(-2)).toEqual([
      "mcp",
      library.library.root,
    ]);
    expect(workspace.connection.name).toMatch(/^demohunter-/);
  } finally {
    await library.close();
  }
  // Closing Studio removes its record, so agents stop targeting it.
  expect(await readStudioSession(library.library.root)).toBeNull();
  await rm(root, { recursive: true, force: true });
}, 30000);

test("agents add, move and remove scene clips, overlays, music and sfx, and write scene files", async () => {
  const { root, dir } = await setup();
  await mkdir(path.join(dir, "audio"));
  await writeFile(path.join(dir, "audio", "bed.wav"), wavBytes());
  const { client, call, fails } = await connect(dir);
  const revision = async () => (await loadBundle(dir)).revision;
  try {
    const before = await revision();
    const page =
      "<!doctype html><style>h1{animation:in 1s both}@keyframes in{from{opacity:0}}</style><h1>Intro</h1>";
    const written = await call("write_project_file", {
      expectedRevision: before,
      path: "scenes/intro.html",
      content: page,
    });
    expect(written).toMatchObject({ path: "scenes/intro.html", created: true });
    expect(written.revision).not.toBe(before);
    expect(written.revision).toBe(await revision());
    expect(await readFile(path.join(dir, "scenes/intro.html"), "utf8")).toBe(
      page,
    );
    expect(
      await fails("write_project_file", {
        expectedRevision: before,
        path: "scenes/intro.html",
        content: "stale",
      }),
    ).toContain("project changed");
    for (const [file, message] of [
      ["edits.json", "inside scenes/"],
      ["scenes/../edits.json", "inside scenes/"],
      ["/tmp/x.html", "inside scenes/"],
      ["scenes/run.sh", ".html, .css"],
    ])
      expect(
        await fails("write_project_file", {
          expectedRevision: await revision(),
          path: file,
          content: "x",
        }),
      ).toContain(message!);
    expect(
      await fails("write_project_file", {
        expectedRevision: await revision(),
        path: "scenes/big.html",
        content: "x".repeat(512 * 1024 + 1),
      }),
    ).toContain("512 KB");
    // Symlinked folders cannot carry writes out of the project.
    await symlink(root, path.join(dir, "scenes", "escape"));
    expect(
      await fails("write_project_file", {
        expectedRevision: await revision(),
        path: "scenes/escape/x.html",
        content: "x",
      }),
    ).toContain("not a folder");
    expect(await stat(path.join(root, "x.html")).catch(() => null)).toBeNull();

    // Scene clips: insert by index and after a clip, then move.
    const scene = (id: string, src = "scenes/intro.html") => ({
      kind: "scene",
      id,
      src,
      durationMs: 2000,
    });
    expect(
      await fails("update_timeline_item", {
        expectedRevision: await revision(),
        item: { kind: "clips", value: scene("intro", "scenes/missing.html") },
      }),
    ).toContain("does not exist");
    let result = await call("update_timeline_item", {
      expectedRevision: await revision(),
      item: { kind: "clips", value: scene("intro"), position: { index: 0 } },
    });
    expect(result.clipOrder).toEqual(["intro", "a", "b"]);
    result = await call("update_timeline_item", {
      expectedRevision: result.revision,
      item: {
        kind: "clips",
        value: scene("chapter"),
        position: { after: "a" },
      },
    });
    expect(result.clipOrder).toEqual(["intro", "a", "chapter", "b"]);
    result = await call("update_timeline_item", {
      expectedRevision: result.revision,
      item: { kind: "clips", value: scene("intro"), position: { after: "b" } },
    });
    expect(result).toMatchObject({ action: "replaced" });
    expect(result.clipOrder).toEqual(["a", "chapter", "b", "intro"]);
    expect(
      await fails("update_timeline_item", {
        expectedRevision: result.revision,
        item: {
          kind: "clips",
          value: scene("outro"),
          position: { before: "nope" },
        },
      }),
    ).toContain('No clip with id "nope"');

    // Overlays and audio, with src checks per folder.
    result = await call("update_timeline_item", {
      expectedRevision: result.revision,
      item: {
        kind: "overlays",
        value: {
          id: "badge",
          src: "scenes/intro.html",
          startMs: 0,
          endMs: 900,
        },
      },
    });
    result = await call("update_timeline_item", {
      expectedRevision: result.revision,
      item: { kind: "music", value: { id: "bed", src: "audio/bed.wav" } },
    });
    result = await call("update_timeline_item", {
      expectedRevision: result.revision,
      item: {
        kind: "sfx",
        value: { id: "whoosh", src: "audio/bed.wav", atMs: 500 },
      },
    });
    expect(
      await fails("update_timeline_item", {
        expectedRevision: result.revision,
        item: {
          kind: "sfx",
          value: { id: "x", src: "scenes/intro.html", atMs: 0 },
        },
      }),
    ).toContain("under audio/");
    await symlink(
      path.join(dir, "edits.json"),
      path.join(dir, "scenes", "edits.html"),
    );
    expect(
      await fails("update_timeline_item", {
        expectedRevision: await revision(),
        item: {
          kind: "overlays",
          value: {
            id: "sneaky",
            src: "scenes/edits.html",
            startMs: 0,
            endMs: 1,
          },
        },
      }),
    ).toContain("outside scenes/");
    // The same scene target and partial geometry work through real MCP.
    result = await call("apply_element_edit", {
      expectedRevision: await revision(),
      target: { scene: "scenes/intro.html", selector: "h1" },
      text: "Edited intro",
      transform: { x: 20, scaleX: 1.5 },
    });
    result = await call("apply_element_edit", {
      expectedRevision: result.revision,
      target: { scene: "scenes/intro.html", selector: "h1" },
      transform: { y: 30 },
    });
    expect((await loadBundle(dir)).edits.elements[0]!.transform).toEqual({
      x: 20,
      y: 30,
      scaleX: 1.5,
      scaleY: 1,
    });
    await call("apply_element_edit", {
      expectedRevision: result.revision,
      target: { scene: "scenes/intro.html", selector: "h1" },
      reset: true,
    });
    expect((await loadBundle(dir)).edits.elements).toEqual([]);
    let edits = (await loadBundle(dir)).edits;
    expect(edits.overlays?.[0]?.id).toBe("badge");
    expect(edits.audio?.music[0]).toMatchObject({ id: "bed", volume: 0.3 });
    expect(edits.audio?.sfx[0]).toMatchObject({ id: "whoosh", atMs: 500 });
    const timeline = await call("get_timeline");
    expect(timeline.files.scenes).toContain("scenes/intro.html");
    expect(timeline.files.audio).toContain("audio/bed.wav");

    for (const [collection, id] of [
      ["music", "bed"],
      ["sfx", "whoosh"],
      ["overlays", "badge"],
      ["clips", "intro"],
      ["clips", "chapter"],
    ])
      await call("remove_timeline_item", {
        expectedRevision: await revision(),
        collection,
        id,
      });
    edits = (await loadBundle(dir)).edits;
    expect(edits.clips.map((c) => c.id)).toEqual(["a", "b"]);
    expect(edits.overlays).toEqual([]);
    expect(edits.audio).toEqual({ music: [], sfx: [] });
    expect(
      await fails("remove_timeline_item", {
        expectedRevision: await revision(),
        collection: "sfx",
        id: "whoosh",
      }),
    ).toContain('No sfx item with id "whoosh"');
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
