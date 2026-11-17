import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createFilm, parseSize } from "./film.js";
import { ensureElementIndex } from "./elements.js";
import { readFormat } from "./format.js";
import { packCapture } from "./capture-bundle.js";
import { LocalLibrary } from "./library.js";
import { liftElement } from "./lift.js";
import { regenerateNarration } from "./narration.js";
import { loadBundle, readProjectFile } from "./storage.js";
import { ReplayWorkspace } from "./workspace.js";
import { renderReplayFrame } from "./render.js";
import { totalDuration } from "./model.js";

const roots: string[] = [];
async function scratch() {
  const root = await mkdtemp(path.join(tmpdir(), "dh-film-"));
  roots.push(root);
  return root;
}
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test("parseSize accepts WxH inside the schema limits", () => {
  expect(parseSize()).toEqual({ width: 1920, height: 1080 });
  expect(parseSize("1080x1920")).toEqual({ width: 1080, height: 1920 });
  expect(parseSize("1080x1080")).toEqual({ width: 1080, height: 1080 });
  expect(parseSize("1001x777")).toEqual({ width: 1001, height: 777 });
  for (const bad of ["99x1080", "1920x9000", "1920", "axb", "1920x1080x1", "-1x100"])
    expect(() => parseSize(bad)).toThrow("--size");
});

test("new creates a scene-only film that every reader accepts", async () => {
  const root = await scratch();
  const dir = path.join(root, "films", "tides");
  const made = await createFilm(dir, { title: "Why <tides> turn", size: "1080x1920" });
  expect(made.projectDir).toBe(dir);
  expect(made.next.some((c) => c.includes("kit"))).toBe(true);

  // Valid v2 project: a blank capture, one scene clip, no narration.
  const bundle = await loadBundle(dir);
  expect(bundle.project.title).toBe("Why <tides> turn");
  expect(bundle.project.viewport).toEqual({ width: 1080, height: 1920 });
  expect(bundle.edits.clips).toEqual([
    { id: "opening", kind: "scene", src: "scenes/opening.html", durationMs: 4000, title: "Opening" },
  ]);
  expect(bundle.narration.segments).toEqual([]);
  expect((await readFormat(dir))?.formatVersion).toBe(2);
  const events = JSON.parse(await readProjectFile(dir, "events.json"));
  expect(events[0].data).toMatchObject({ width: 1080, height: 1920 });

  // The kit exactly as `kit` installs it, without a score.
  const kit = path.join(import.meta.dir, "scene-kit");
  for (const name of await readdir(kit))
    expect(await readFile(path.join(dir, "scenes/kit", name), "utf8")).toBe(
      await readFile(path.join(kit, name), "utf8"),
    );
  expect(await readdir(dir)).not.toContain("audio");
  const opening = await readFile(path.join(dir, "scenes/opening.html"), "utf8");
  expect(opening).toContain('name="demohunter:duration" content="4000"');
  expect(opening).toContain("Why &lt;tides&gt; turn");
  expect(opening).toContain('from "./kit/motion.js"');
  const plan = await readFile(path.join(dir, "PLAN.md"), "utf8");
  expect(plan).toStartWith("# Why <tides> turn\n");
  for (const line of ["FILM:", "SPINE:", "BEATS:", "LOOK AT:"]) expect(plan).toContain(line);

  // The capture survives the "capture changed" check and packing again.
  const index = await ensureElementIndex(dir, false);
  expect(index.elements).toEqual([]);
  expect((await packCapture(dir)).captureId).toBe(index.captureId);

  // A destination that exists is refused and left alone.
  await expect(createFilm(dir)).rejects.toThrow("already exists");
  expect((await loadBundle(dir)).project.title).toBe("Why <tides> turn");

  // Each film has its own capture id.
  const other = await createFilm(path.join(root, "films", "other"));
  expect(other.captureId).not.toBe(made.captureId);
  expect(other.title).toBe("other");
  expect((await loadBundle(other.projectDir)).project.viewport).toEqual({ width: 1920, height: 1080 });
});

test("film workspace: empty element reads, clear refusals for recording-only tools", async () => {
  const root = await scratch();
  const dir = path.join(root, "film");
  await createFilm(dir, { title: "Film" });
  const workspace = await ReplayWorkspace.open(dir);
  expect(workspace.recording).toBe(false);
  expect(workspace.find("")).toEqual([]);
  expect(await workspace.html("d1-body-n5")).toMatchObject({ html: "", recording: false });
  expect(await workspace.nodeInfo("d1-body-n5")).toMatchObject({ recording: false });
  expect(await workspace.selection()).toMatchObject({ selection: null });
  expect((await workspace.basicInfo()).recording).toBe(false);
  expect(() => workspace.element("d1-body-n5")).toThrow("no recording");
  await expect(
    liftElement(dir, { atMs: 100, selector: "body", name: "x" }),
  ).rejects.toThrow("no recording");
  // Scene targets still edit.
  const before = await loadBundle(dir);
  await workspace.editElement(
    before.revision,
    { scene: "scenes/opening.html", selector: "#title" },
    { style: { color: "rgb(255, 0, 0)" } },
  );
  expect((await loadBundle(dir)).edits.elements).toHaveLength(1);

  // Narration with no segments changes nothing.
  const revision = (await loadBundle(dir)).revision;
  await regenerateNarration(dir, { fit: true });
  expect((await loadBundle(dir)).revision).toBe(revision);

  // The library lists it as a recording without a tour.
  const library = await LocalLibrary.open(root);
  const scan = await library.scan();
  const listed = scan.recordings.find((r) => r.title === "Film");
  expect(listed).toMatchObject({ scenes: 1, durationMs: 4000, path: "film", film: true });
  expect(listed?.error).toBeUndefined();
  expect(listed?.tourPath).toBeUndefined();
});

test("film: more scene clips and overlays by file edit, then a frame renders", async () => {
  const root = await scratch();
  const dir = path.join(root, "film");
  await createFilm(dir, { title: "Film", size: "1080x1080" });
  await writeFile(
    path.join(dir, "scenes/two.html"),
    `<!doctype html><meta name="demohunter:duration" content="2000"><body style="margin:0;background:rgb(0,128,255)"></body>`,
  );
  await writeFile(
    path.join(dir, "scenes/badge.html"),
    `<!doctype html><body style="margin:0;background:transparent"><div style="position:absolute;left:0;top:0;width:100px;height:100px;background:rgb(255,0,0)"></div></body>`,
  );
  const edits = JSON.parse(await readFile(path.join(dir, "edits.json"), "utf8"));
  edits.clips.push({ id: "two", kind: "scene", src: "scenes/two.html", durationMs: 2000 });
  edits.overlays = [{ id: "badge", src: "scenes/badge.html", startMs: 4500, endMs: 5500 }];
  await writeFile(path.join(dir, "edits.json"), JSON.stringify(edits));
  const bundle = await loadBundle(dir);
  expect(totalDuration(bundle.edits)).toBe(6000);
  const frame = await renderReplayFrame(dir, { outputMs: 5000 });
  const png = frame.bytes;
  expect(png.readUInt32BE(16)).toBe(1080);
  expect(png.readUInt32BE(20)).toBe(1080);
}, 60_000);

test("MCP on a film: reads return empty results, timeline and scene writes work", async () => {
  const root = await scratch();
  const dir = path.join(root, "film");
  await createFilm(dir, { title: "Film" });
  const client = new Client({ name: "film-test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve(import.meta.dir, "cli.ts"), "mcp", dir],
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
  try {
    const info = await call("get_basic_info");
    expect(info.recording).toBe(false);
    expect(info.elementCount).toBe(0);
    expect(await call("find_elements", { query: "" })).toEqual([]);
    expect(await call("get_html", { elementRef: "d1-body-n5" })).toMatchObject({ html: "" });
    expect(await call("get_node_info", { elementRef: "d1-body-n5" })).toMatchObject({ recording: false });
    expect(await call("get_computed_styles", { elementRef: "d1-body-n5" })).toMatchObject({ available: false });
    expect(await call("get_selection")).toMatchObject({ selection: null });
    expect((await call("get_timeline")).clips).toHaveLength(1);
    expect((await call("get_narration")).segments).toEqual([]);

    let revision = info.revision;
    revision = (
      await call("write_project_file", {
        expectedRevision: revision,
        path: "scenes/close.html",
        content: `<!doctype html><meta name="demohunter:duration" content="1500"><h1>End</h1>`,
      })
    ).revision;
    revision = (
      await call("update_timeline_item", {
        expectedRevision: revision,
        item: { kind: "clips", value: { id: "close", kind: "scene", src: "scenes/close.html", durationMs: 1500 } },
      })
    ).revision;
    await call("update_timeline_item", {
      expectedRevision: revision,
      item: { kind: "overlays", value: { id: "tag", src: "scenes/close.html", startMs: 500, endMs: 1500 } },
    });
    const edits = (await loadBundle(dir)).edits;
    expect(edits.clips.map((c) => c.id)).toEqual(["opening", "close"]);
    expect(edits.overlays?.map((o) => o.id)).toEqual(["tag"]);
    // Recording-only writes refuse clearly.
    await expect(
      call("lift_element", {
        expectedRevision: (await loadBundle(dir)).revision,
        elementRef: "d1-body-n5",
        outputMs: 100,
        name: "x",
      }),
    ).rejects.toThrow("no recording");
  } finally {
    await client.close();
  }
}, 60_000);
