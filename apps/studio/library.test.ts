import { test, expect } from "bun:test";
import { mkdir, writeFile, rm, symlink, cp, readFile } from "node:fs/promises";
import path from "node:path";
import { LocalLibrary } from "./library.js";
import { serveLibrary } from "./library-server.js";
import { projectFixture } from "./test-support.js";
import { loadBundle, writeJson } from "./storage.js";
import { ReplayWorkspace } from "./workspace.js";
import { readFormat } from "./format.js";

test("discovers captures and source tours, contains routes, isolates project edits, tolerates invalid files", async () => {
  const { root, dir } = await projectFixture();
  const other = path.join(root, "other");
  await cp(dir, other, { recursive: true });
  const data = await loadBundle(other);
  data.project.title = "Other recording";
  await writeJson(path.join(other, "project.json"), data.project);
  await mkdir(path.join(root, "demos"));
  await writeFile(
    path.join(root, "demos/example.tour.ts"),
    "// Discovery must never execute tour code",
  );
  await mkdir(path.join(root, "node_modules"));
  await writeFile(path.join(root, "node_modules/hidden.tour.ts"), "");
  await symlink("/tmp", path.join(root, "escape"));
  const broken = path.join(root, "broken");
  await cp(dir, broken, { recursive: true });
  await writeFile(path.join(broken, "edits.json"), "{");
  const app = await serveLibrary(root, { port: 0 });
  try {
    const response = await fetch(app.url + "/api/library").then((r) =>
      r.json(),
    );
    expect(response.recordings).toHaveLength(3);
    expect(response.tours).toHaveLength(1);
    expect(
      response.recordings.find((r: any) => r.path === "broken").error,
    ).toContain("Invalid replay");
    const first = response.recordings.find((r: any) => r.path === "project"),
      second = response.recordings.find((r: any) => r.path === "other");
    const base = `${app.url}/projects/${first.id}`;
    const html = await fetch(base + "/").then((r) => r.text());
    expect(html).toContain(`src="/projects/${first.id}/app.js"`);
    expect(html).toMatch(/href="\/"\s+class="library-back"/);
    const a = await fetch(base + "/api/project").then((r) => r.json());
    a.project.title = "Changed first";
    expect(
      (
        await fetch(base + "/api/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            file: "project.json",
            revision: a.revision,
            value: a.project,
          }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${app.url}/projects/${second.id}/api/project`).then((r) =>
          r.json(),
        )
      ).project.title,
    ).toBe("Other recording");
    expect(
      (
        await fetch(base + "/api/save", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://evil.example",
          },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    await rm(dir, { recursive: true });
    await symlink("/tmp", dir);
    await expect(app.library.resolve(first.id)).rejects.toThrow("outside");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("v1 upgrades legacy captures once, preserves content, and rejects future versions before writes", async () => {
  const { root, dir } = await projectFixture();
  try {
    const before = await loadBundle(dir);
    const [a, b] = await Promise.all([
      ReplayWorkspace.open(dir),
      ReplayWorkspace.open(dir),
    ]);
    expect(a.index.captureId).toBe(b.index.captureId);
    const format = await readFormat(dir);
    expect(format?.formatVersion).toBe(1);
    expect((await loadBundle(dir)).revision).toBe(before.revision);
    const bytes = await readFile(path.join(dir, "edits.json"), "utf8");
    await writeJson(path.join(dir, "studio.json"), {
      ...format,
      formatVersion: 99,
    });
    await expect(ReplayWorkspace.open(dir)).rejects.toThrow("Unsupported");
    expect(await readFile(path.join(dir, "edits.json"), "utf8")).toBe(bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
