import { expect, test } from "bun:test";
import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { serveLibrary } from "./library-server.js";
import { projectFixture } from "./test-support.js";
import { mkdir, writeFile } from "node:fs/promises";

test("the library marks new and agent-updated demos until they are opened", async () => {
  const { root, dir } = await projectFixture();
  const app = await serveLibrary(root, { port: 0 });
  const library = () => fetch(`${app.url}/api/library`).then((r) => r.json());
  const fresh = async () =>
    Object.fromEntries(
      (await library()).recordings.map((r: any) => [r.path, r.fresh ?? null]),
    );
  const seen = (id: string) =>
    fetch(`${app.url}/api/seen`, {
      method: "POST",
      body: JSON.stringify({ id }),
    });
  try {
    // First run: everything already there counts as known.
    expect(await fresh()).toEqual({ project: null });
    await cp(dir, path.join(root, "second"), { recursive: true });
    expect(await fresh()).toEqual({ project: null, second: "new" });
    const second = (await library()).recordings.find((r: any) => r.path === "second");
    expect((await seen(second.id)).status).toBe(200);
    expect(await fresh()).toEqual({ project: null, second: null });
    // An agent edit (tracked history with an author) makes it "updated".
    await mkdir(path.join(root, "second/.history"), { recursive: true });
    await writeFile(
      path.join(root, "second/.history/edits.json"),
      JSON.stringify([
        { id: "h1", at: new Date().toISOString(), label: "Agent edit", author: { kind: "agent", name: "test" }, before: {} },
      ]),
    );
    expect(await fresh()).toEqual({ project: null, second: "updated" });
    expect((await seen("0000000000000000")).status).toBe(404);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
