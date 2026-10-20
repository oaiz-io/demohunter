import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { elementPatchSchema, patchElement } from "./element-edit.js";
import { targetSchema, type ReplayEdits } from "./model.js";
import { projectFixture } from "./test-support.js";
import { loadBundle } from "./storage.js";
import { ReplayWorkspace } from "./workspace.js";

test("partial geometry and property reset preserve other saved changes", () => {
  const elements: ReplayEdits["elements"] = [
    {
      id: "a",
      target: { selector: "h1" },
      text: "Title",
      style: { color: "red", "font-size": "32px" },
      transform: { x: 5, y: 6, scaleX: 2, scaleY: 3 },
    },
  ];
  const patch = elementPatchSchema.parse({
    transform: { x: 20 },
    style: { color: null },
  });
  expect(patch.transform).toEqual({ x: 20 });
  patchElement(elements, { selector: "h1" }, patch, "unused");
  expect(elements[0]!.transform).toEqual({ x: 20, y: 6, scaleX: 2, scaleY: 3 });
  expect(elements[0]!.style).toEqual({ "font-size": "32px" });
  expect(elements[0]!.text).toBe("Title");
  expect(
    targetSchema.safeParse({ scene: "../secret", selector: "h1" }).success,
  ).toBe(false);
  expect(
    targetSchema.safeParse({ scene: "scenes/title.html", ref: "abc" }).success,
  ).toBe(false);
});

test("scene element saves are portable, revision checked and undoable", async () => {
  const { root, dir } = await projectFixture();
  try {
    await mkdir(path.join(dir, "scenes"));
    const html = "<h1 id=title>Original</h1>";
    await writeFile(path.join(dir, "scenes/title.html"), html);
    const workspace = await ReplayWorkspace.open(dir);
    const initial = await loadBundle(dir),
      target = { scene: "scenes/title.html", selector: "#title" };
    const changed = await workspace.editElement(initial.revision, target, {
      text: "Changed",
      transform: { scaleX: 1.5, scaleY: 1.5 },
      style: { color: "red" },
    });
    expect(changed.edits.elements[0]!.text).toBe("Changed");
    expect((await loadBundle(dir)).edits.elements[0]!.transform?.scaleX).toBe(
      1.5,
    );
    expect(await readFile(path.join(dir, "scenes/title.html"), "utf8")).toBe(
      html,
    );
    await expect(
      workspace.editElement(initial.revision, target, { hidden: true }),
    ).rejects.toThrow();
    const reset = await workspace.editElement(changed.revision, target, {
      reset: true,
    });
    expect(reset.edits.elements).toEqual([]);
    await workspace.undo(reset.revision);
    const restored = await loadBundle(dir);
    expect(restored.edits.elements[0]!.text).toBe("Changed");
    expect((await workspace.history())[0]!.changes).toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
