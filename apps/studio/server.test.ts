import { describe, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { serveReplay } from "./server.js";
import { loadBundle, writeJson } from "./storage.js";
import { projectFixture } from "./test-support.js";

describe("replay file server", () => {
  test("observes external edits, reports partial writes, rejects conflicting saves and unsafe file access", async () => {
    const { root, dir } = await projectFixture();
    const preview = await serveReplay(dir, { port: 0 });
    const post = (route: string, data: unknown, headers = {}) =>
      fetch(preview.url + route, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(data),
      });
    try {
      const initial = await fetch(preview.url + "/api/project").then((r) =>
        r.json(),
      );
      const changed = await loadBundle(dir);
      changed.edits.elements.push({
        id: "title",
        target: { selector: "h1" },
        text: "Edited by an external agent",
      });
      await writeJson(path.join(dir, "edits.json"), changed.edits);
      const status = await fetch(preview.url + "/api/status").then((r) =>
        r.json(),
      );
      expect(status.revision).not.toBe(initial.revision);
      expect(
        (
          await post("/api/save", {
            file: "edits.json",
            value: initial.edits,
            revision: initial.revision,
          })
        ).status,
      ).toBe(409);
      await writeFile(path.join(dir, "edits.json"), "{ partial");
      expect(
        (await fetch(preview.url + "/api/status").then((r) => r.json())).error,
      ).toContain("Invalid replay");
      await writeJson(path.join(dir, "edits.json"), changed.edits);
      expect(
        (
          await post(
            "/api/selection",
            {},
            { Origin: "https://another-site.example" },
          )
        ).status,
      ).toBe(403);
      await mkdir(path.join(dir, "assets"));
      await writeFile(path.join(root, "outside.txt"), "private");
      await symlink(
        path.join(root, "outside.txt"),
        path.join(dir, "assets/escape.txt"),
      );
      expect(
        (await fetch(preview.url + "/files/assets/escape.txt")).status,
      ).toBe(400);
      expect((await fetch(preview.url + "/files/project.json")).status).toBe(
        404,
      );
      await writeFile(path.join(dir, "assets/sound.wav"), "0123456789");
      const range = await fetch(preview.url + "/files/assets/sound.wav", {
        headers: { Range: "bytes=2-5" },
      });
      expect(range.status).toBe(206);
      expect(await range.text()).toBe("2345");
    } finally {
      await preview.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
