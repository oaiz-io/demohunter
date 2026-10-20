import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { zipSync } from "fflate";
import { packCapture } from "./capture-bundle.js";
import { projectFixture } from "./test-support.js";
import { loadBundle, readProjectFile, writeJson } from "./storage.js";
import { ReplayWorkspace } from "./workspace.js";
import { readFormat } from "./format.js";
import { LocalLibrary } from "./library.js";
import { serveReplay } from "./server.js";
import { listDemoSources } from "./git.js";
import { indexEvents } from "./elements.js";
import { execFileSync } from "node:child_process";

async function setup() {
  const fixture = await projectFixture();
  await writeJson(path.join(fixture.dir, "events.json"), [
    { type: 4, timestamp: 1000, data: { href: "http://fixture.test" } },
    {
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
              childNodes: [
                { type: 3, id: 3, textContent: "Keep this heading" },
              ],
            },
          ],
        },
      },
    },
  ]);
  await mkdir(path.join(fixture.dir, "assets"));
  await writeFile(path.join(fixture.dir, "assets/test.css"), "h1{color:red}");
  return fixture;
}

test("packing preserves capture bytes, refs, edits, media and revision; readers need no loose files", async () => {
  const { root, dir } = await setup();
  try {
    const before = await ReplayWorkspace.open(dir);
    const ref = before.index.elements[0]!.ref;
    const html = await before.html(ref);
    const events = await readProjectFile(dir, "events.json", null);
    const revision = (await loadBundle(dir)).revision;
    const content = await Promise.all(
      ["edits.json", "narration.json", "overrides.css"].map((f) =>
        readFile(path.join(dir, f)),
      ),
    );
    const result = await packCapture(dir);
    expect(result.captureId).toBe(before.index.captureId);
    expect((await readFormat(dir))?.formatVersion).toBe(2);
    const entries = await readdir(dir);
    expect(entries).toContain("capture.dhcapture");
    for (const name of ["events.json", "elements.json", "sources", "assets"])
      expect(entries).not.toContain(name);
    expect(await readProjectFile(dir, "events.json", null)).toEqual(events);
    expect(await readProjectFile(dir, "assets/test.css")).toBe("h1{color:red}");
    expect((await loadBundle(dir)).revision).toBe(revision);
    expect(
      await Promise.all(
        ["edits.json", "narration.json", "overrides.css"].map((f) =>
          readFile(path.join(dir, f)),
        ),
      ),
    ).toEqual(content);
    const after = await ReplayWorkspace.open(dir);
    expect(after.index).toEqual(before.index);
    expect(await after.html(ref)).toEqual(html);
    expect(await packCapture(dir)).toEqual(result);
    await expect(
      (await LocalLibrary.open(root)).scan().then((v) => v.recordings.length),
    ).resolves.toBe(1);
    execFileSync("git", ["init", "-q", root]);
    expect((await listDemoSources(root))?.folders).toContain("project");
    const app = await serveReplay(dir, { port: 0 });
    try {
      expect(
        await fetch(app.url + "/api/events").then((r) => r.json()),
      ).toEqual(JSON.parse(events.toString()));
      expect(
        await fetch(app.url + "/files/assets/test.css").then((r) => r.text()),
      ).toBe("h1{color:red}");
    } finally {
      await app.close();
    }
    expect(await readdir(dir)).not.toContain("sources");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspection uses frozen refs rather than assigning new refs", () => {
  const events = [
    {
      type: 2,
      timestamp: 0,
      data: {
        node: { type: 2, id: 9, tagName: "h1", attributes: {}, childNodes: [] },
      },
    },
  ];
  const frozen = indexEvents(events).elements;
  frozen[0]!.ref = "old-stable-reference";
  const html = indexEvents(events, "old-stable-reference", frozen).snippets[0]!
    .html;
  expect(html).toContain('data-demohunter-ref="old-stable-reference"');
});

test("a declared oversized ZIP entry is rejected before decompression", async () => {
  const { root, dir } = await setup();
  try {
    await packCapture(dir);
    const format = await readFormat(dir);
    const bytes = Buffer.from(zipSync({ "events.json": Buffer.from("[]") }));
    const header = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(256 * 1024 * 1024 + 1, header + 24);
    await writeFile(path.join(dir, "capture.dhcapture"), bytes);
    await writeJson(path.join(dir, "studio.json"), {
      ...format,
      capture: {
        file: "capture.dhcapture",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    });
    await expect(readProjectFile(dir, "events.json")).rejects.toThrow(
      "expands beyond",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packing completes interrupted loose-file cleanup without changing the archive", async () => {
  const { root, dir } = await setup();
  try {
    const packed = await packCapture(dir);
    await writeFile(
      path.join(dir, "events.json"),
      "left from interrupted cleanup",
    );
    await mkdir(path.join(dir, "sources"));
    await writeFile(path.join(dir, "sources/left.html"), "derived");
    expect(await packCapture(dir)).toEqual(packed);
    expect(await readdir(dir)).not.toContain("events.json");
    expect(await readdir(dir)).not.toContain("sources");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture packing is deterministic across folders and preserves provenance", async () => {
  const a = await setup(),
    b = await setup();
  try {
    await Promise.all([packCapture(a.dir), packCapture(b.dir)]);
    expect(await readFile(path.join(a.dir, "capture.dhcapture"))).toEqual(
      await readFile(path.join(b.dir, "capture.dhcapture")),
    );
  } finally {
    await Promise.all(
      [a.root, b.root].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
  }
});

test("bundle readers reject corrupt bytes, missing LFS objects and symlinks", async () => {
  const { root, dir } = await setup();
  try {
    await packCapture(dir);
    const file = path.join(dir, "capture.dhcapture");
    const bytes = await readFile(file);
    await writeFile(file, "broken");
    await expect(readProjectFile(dir, "events.json")).rejects.toThrow(
      "checksum",
    );
    await writeFile(
      file,
      "version https://git-lfs.github.com/spec/v1\noid sha256:0000\nsize 42\n",
    );
    await expect(readProjectFile(dir, "events.json")).rejects.toThrow(
      "git lfs pull",
    );
    await rm(file);
    await expect(readProjectFile(dir, "events.json")).rejects.toThrow(
      "missing",
    );
    const outside = path.join(root, "outside");
    await writeFile(outside, bytes);
    await symlink(outside, file);
    await expect(readProjectFile(dir, "events.json")).rejects.toThrow(
      "symbolic link",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid archive entries fail before use, even with a matching archive hash", async () => {
  const { root, dir } = await setup();
  try {
    await packCapture(dir);
    const format = await readFormat(dir);
    for (const name of [
      "../outside",
      "assets/../secret",
      "assets/bad\\name",
      "prototype",
    ]) {
      const bytes = zipSync({ [name]: Buffer.from("no") });
      await writeFile(path.join(dir, "capture.dhcapture"), bytes);
      await writeJson(path.join(dir, "studio.json"), {
        ...format,
        capture: {
          file: "capture.dhcapture",
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      });
      await expect(readProjectFile(dir, "events.json")).rejects.toThrow(
        "Invalid",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
