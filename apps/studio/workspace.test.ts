import { expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { readActivity } from "./activity.js";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { projectFixture } from "./test-support.js";
import { loadBundle, mutateProject, writeJson } from "./storage.js";
import { ReplayWorkspace } from "./workspace.js";
import { elementUri, previewLink, parseReference } from "./links.js";
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
    await call("add_comment", {
      expectedRevision: changed.revision,
      elementRef: ref,
      timeMs: 0,
      body: "Looks good",
    });
    expect((await call("list_comments")).threads).toHaveLength(1);
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
