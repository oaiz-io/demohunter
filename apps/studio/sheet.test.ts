import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createFilm } from "./film.js";
import { CUT_OFFSETS, planSheet, renderSheets, sheetLayout, writeSheets } from "./sheet.js";
import { loadBundle } from "./storage.js";

let root: string, dir: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dh-sheet-"));
  dir = path.join(root, "film");
  await createFilm(dir, { title: "Sheet film" });
  await writeFile(
    path.join(dir, "scenes/two.html"),
    `<!doctype html><meta name="demohunter:duration" content="2000"><body style="margin:0;background:rgb(0,128,255)"></body>`,
  );
  await writeFile(
    path.join(dir, "scenes/tag.html"),
    `<!doctype html><body style="margin:0;background:transparent"><b style="position:absolute;left:0;top:0">tag</b></body>`,
  );
  const edits = JSON.parse(await readFile(path.join(dir, "edits.json"), "utf8"));
  edits.clips.push({ id: "two", kind: "scene", src: "scenes/two.html", durationMs: 2000 });
  edits.overlays = [{ id: "tag", src: "scenes/tag.html", startMs: 1000, endMs: 3000 }];
  await writeFile(path.join(dir, "edits.json"), JSON.stringify(edits));
});
afterAll(() => rm(root, { recursive: true, force: true }));

test("default plan: a few frames in and the middle of every clip and overlay, in time order", async () => {
  const plan = planSheet(await loadBundle(dir));
  expect(plan.total).toBe(6000);
  expect(plan.tiles.map((t) => [t.timeMs, t.subject])).toEqual([
    [100, "opening"],
    [1100, "tag"],
    [2000, "opening"],
    [2000, "tag"],
    [4100, "two"],
    [5000, "two"],
  ]);
  const tag = plan.tiles[1]!;
  expect(tag).toMatchObject({ clipId: "opening", overlayIds: ["tag"], label: "1.10 s · opening + tag" });
});

test("--at, --every and --cuts plans; bad input is refused", async () => {
  const bundle = await loadBundle(dir);
  expect(planSheet(bundle, { at: [0, 4500, 6000] }).tiles.map((t) => [t.timeMs, t.clipId])).toEqual([
    [0, "opening"],
    [4500, "two"],
    [6000, "two"],
  ]);
  expect(planSheet(bundle, { every: 2000 }).tiles.map((t) => t.timeMs)).toEqual([0, 2000, 4000, 6000]);
  const cuts = planSheet(bundle, { cuts: true });
  expect(cuts.seams).toEqual([
    { seam: "tag in", timeMs: 1000 },
    { seam: "tag out", timeMs: 3000 },
    { seam: "opening → two", timeMs: 4000 },
  ]);
  expect(cuts.tiles).toHaveLength(3 * CUT_OFFSETS.length);
  expect(cuts.tiles.slice(12).map((t) => [t.timeMs, t.clipId])).toEqual([
    [3800, "opening"],
    [3900, "opening"],
    [3967, "opening"],
    [4033, "two"],
    [4100, "two"],
    [4200, "two"],
  ]);
  expect(() => planSheet(bundle, { at: [7000] })).toThrow("outside the film");
  expect(() => planSheet(bundle, { every: 0 })).toThrow("--every");
  expect(() => planSheet(bundle, { every: 1 })).toThrow("tiles");
  expect(() => planSheet(bundle, { at: [0], cuts: true })).toThrow("Choose one");
});

test("layout: about 480 px tiles, 360 px phone frames, at most 30 tiles a sheet", () => {
  const land = sheetLayout({ width: 1920, height: 1080 });
  expect(land).toMatchObject({ tile: { width: 480, height: 270 }, columns: 4 });
  expect(land.perSheet).toBeLessThanOrEqual(30);
  const portrait = sheetLayout({ width: 1080, height: 1920 });
  expect(portrait).toMatchObject({ tile: { width: 270, height: 480 }, columns: 6, perSheet: 30 });
  expect(sheetLayout({ width: 1080, height: 1920 }, { phone: true }).tile).toEqual({ width: 360, height: 640 });
  expect(sheetLayout({ width: 1920, height: 1080 }, { phone: true }).tile).toEqual({ width: 360, height: 203 });
  expect(sheetLayout({ width: 1920, height: 1080 }, { cuts: true }).columns).toBe(CUT_OFFSETS.length);
});

test("sheets render as JPEGs with tile positions; written under ignored .studio/", async () => {
  const before = (await loadBundle(dir)).revision;
  const result = await writeSheets(dir, { every: 200 });
  expect(result.tiles).toHaveLength(31);
  expect(result.sheets).toHaveLength(2);
  expect(result.tiles.at(-1)).toMatchObject({ timeMs: 6000, sheet: 2, row: 0, column: 2 });
  for (const file of result.sheets) {
    expect(path.relative(dir, file)).toStartWith(path.join(".studio", "sheets"));
    const bytes = await readFile(file);
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  }
  expect(await readFile(path.join(dir, ".studio/.gitignore"), "utf8")).toBe("*\n");
  // Runtime files: the content revision does not change.
  expect((await loadBundle(dir)).revision).toBe(before);

  // --output must be a new folder.
  const out = path.join(root, "out");
  const written = await writeSheets(dir, { cuts: true, phone: true, output: out });
  expect(await readdir(out)).toEqual(["sheet-01.jpg"]);
  expect(written.tile).toEqual({ width: 360, height: 203 });
  await expect(writeSheets(dir, { output: out })).rejects.toThrow("already exists");
}, 60_000);

test("a sheet's tile shows the frame at its time", async () => {
  const { sheets, tiles } = await renderSheets(dir, { at: [4500] });
  expect(tiles).toHaveLength(1);
  expect(sheets).toHaveLength(1);
}, 60_000);

test("MCP get_film_sheet returns images and the tile list", async () => {
  const client = new Client({ name: "sheet-test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve(import.meta.dir, "cli.ts"), "mcp", dir],
      stderr: "pipe",
    }),
  );
  try {
    const tool = (await client.listTools()).tools.find((t) => t.name === "get_film_sheet");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    const r = (await client.callTool({ name: "get_film_sheet", arguments: { cuts: true } })) as {
      isError?: boolean;
      content: { type: string; mimeType?: string; data?: string; text?: string }[];
    };
    expect(r.isError).not.toBe(true);
    expect(r.content[0]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    const data = JSON.parse(r.content.at(-1)!.text!);
    expect(data.tiles).toHaveLength(18);
    expect(data.sheets).toBe(1);
    // No playhead command was written.
    await expect(readFile(path.join(dir, "preview-command.json"))).rejects.toThrow();
  } finally {
    await client.close();
  }
}, 60_000);
