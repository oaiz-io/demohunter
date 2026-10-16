import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium } from "playwright";
import { fixture, projectFixture } from "./test-support.js";
import { writeJson, loadBundle, mutateProject } from "./storage.js";
import { openReplayRenderer } from "./render.js";
import { serveReplay } from "./server.js";

async function waitUntil(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error("Saved edit did not match");
    await Bun.sleep(30);
  }
}

test("direct editing saves captured and scene elements, gestures, reset and conflicts", async () => {
  const { root, dir } = await projectFixture();
  let preview: Awaited<ReturnType<typeof serveReplay>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const b = fixture();
    b.edits.clips = [
      { id: "a", sourceStartMs: 0, sourceEndMs: 1000, rate: 1, holdMs: 0 },
      {
        id: "title",
        kind: "scene",
        src: "scenes/title.html",
        durationMs: 2000,
      },
    ];
    b.edits.camera = [
      { id: "zoom", startMs: 0, endMs: 1000, scale: 1.25, x: 400, y: 250 },
    ];
    b.narration.segments = [];
    await writeJson(path.join(dir, "edits.json"), b.edits);
    await writeJson(path.join(dir, "narration.json"), b.narration);
    const text = { type: 3, id: 7, textContent: "Original heading" };
    const title = {
      type: 2,
      id: 6,
      tagName: "h1",
      attributes: {
        id: "title",
        style:
          "position:absolute;left:120px;top:100px;margin:0;width:240px;height:60px;font:32px sans-serif;color:#111111",
      },
      childNodes: [text],
    };
    await writeJson(path.join(dir, "events.json"), [
      {
        type: 4,
        timestamp: 1000,
        data: { href: "http://example.test", width: 1120, height: 700 },
      },
      {
        type: 2,
        timestamp: 1001,
        data: {
          initialOffset: { left: 0, top: 0 },
          node: {
            type: 0,
            id: 1,
            childNodes: [
              {
                type: 2,
                id: 2,
                tagName: "html",
                attributes: {},
                childNodes: [
                  {
                    type: 2,
                    id: 3,
                    tagName: "head",
                    attributes: {},
                    childNodes: [],
                  },
                  {
                    type: 2,
                    id: 4,
                    tagName: "body",
                    attributes: {},
                    childNodes: [title],
                  },
                ],
              },
            ],
          },
        },
      },
      {
        type: 3,
        timestamp: 1600,
        data: {
          source: 0,
          texts: [{ id: 7, value: "Later heading" }],
          attributes: [],
          removes: [],
          adds: [],
        },
      },
    ]);
    await mkdir(path.join(dir, "assets"));
    await mkdir(path.join(dir, "scenes"));
    const originalScene =
      '<!doctype html><html><body style="margin:0;background:#f5f1e8"><h1 id="hero" style="position:absolute;left:180px;top:140px;margin:0;font:48px sans-serif">Scene title</h1><span id="inline">Inline label</span><script>window.demohunterScene={seek(ms){document.body.dataset.time=ms}};</script></body></html>';
    await writeFile(path.join(dir, "scenes/title.html"), originalScene);
    const rrweb = path.dirname(createRequire(import.meta.url).resolve("rrweb"));
    await writeFile(
      path.join(dir, "assets/rrweb.js"),
      await readFile(path.join(rrweb, "rrweb.umd.cjs")),
    );
    await writeFile(
      path.join(dir, "assets/rrweb.css"),
      await readFile(path.join(rrweb, "style.css")),
    );
    preview = await serveReplay(dir, { port: 0 });
    browser = await chromium.launch();
    const page = await browser.newPage({
        viewport: { width: 1440, height: 960 },
      }),
      errors: string[] = [];
    page.setDefaultTimeout(5000);
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(preview.url);
    await page.waitForFunction(
      () => (window as any).__replayLab?.state().ready,
    );
    await page.evaluate(() => (window as any).__replayLab.seek(0));
    await page.locator('[data-tab="edit"]').click();
    const heading = page.frameLocator("#replay iframe").locator("h1");
    const box = await heading.boundingBox();
    if (!box) throw Error("No title");
    await page.mouse.click(box.x + 30, box.y + 20);
    await page.locator("#element-text").fill("Edited heading");
    await waitUntil(async () =>
      (await loadBundle(dir)).edits.elements.some(
        (e: any) => e.text === "Edited heading",
      ),
    );
    expect((await loadBundle(dir)).edits.elements[0]!.text).toBe(
      "Edited heading",
    );
    await page.locator("#element-color").fill("#b02030");
    await waitUntil(async () =>
      (await loadBundle(dir)).edits.elements.some(
        (e: any) => e.style?.color === "#b02030",
      ),
    );
    await page
      .locator("#element-save-state")
      .filter({ hasText: "Saved" })
      .waitFor();
    const before = await heading.boundingBox();
    if (!before) throw Error("No heading");
    const frame = await page.locator("#replay iframe").boundingBox();
    if (!frame) throw Error("No frame");
    await page.mouse.move(before.x + 30, before.y + 20);
    await page.mouse.down();
    await page.mouse.move(before.x + 90, before.y + 50, { steps: 8 });
    await page.mouse.up();
    await waitUntil(async () =>
      (await loadBundle(dir)).edits.elements.some(
        (e: any) => e.transform?.x > 10,
      ),
    );
    let saved = (await loadBundle(dir)).edits.elements[0]!;
    expect(saved.transform!.x).toBeCloseTo(60 / (frame.width / 1120), 0);
    const after = await heading.boundingBox();
    expect(after!.x - before.x).toBeCloseTo(60, 0);
    expect(after!.y - before.y).toBeCloseTo(30, 0);
    await page
      .locator("#element-save-state")
      .filter({ hasText: "Saved" })
      .waitFor();
    const handle = page.locator(".direct-handle.se");
    const corner = await handle.boundingBox();
    if (!corner) throw Error("No resize handle");
    await page.mouse.move(corner.x + 5, corner.y + 5);
    await page.mouse.down();
    await page.mouse.move(corner.x + 65, corner.y + 35, { steps: 8 });
    await page.mouse.up();
    await waitUntil(async () =>
      (await loadBundle(dir)).edits.elements.some(
        (e: any) => e.transform?.scaleX > 1.1,
      ),
    );
    const resized = await heading.boundingBox();
    expect(resized!.width - after!.width).toBeCloseTo(60, 0);
    expect(resized!.x - after!.x).toBeCloseTo(0, 0);
    await page
      .locator("#element-save-state")
      .filter({ hasText: "Saved" })
      .waitFor();
    await page.reload();
    await page.waitForFunction(
      () => (window as any).__replayLab?.state().ready,
    );
    await page.evaluate(() => (window as any).__replayLab.seek(700));
    expect(await heading.textContent()).toBe("Edited heading");
    await page.evaluate(() => (window as any).__replayLab.seek(0));
    expect(await heading.textContent()).toBe("Edited heading");
    // Scene picks use the unzoomed scene frame, independently of the camera.
    await page.evaluate(async () => {
      await (window as any).__replayLab.scenesReady();
      (window as any).__replayLab.seek(1200);
    });
    await page.locator('[data-tab="edit"]').click();
    const hero = page.frameLocator(".scene-frame.scene").locator("#hero");
    const heroBox = await hero.boundingBox();
    if (!heroBox) throw Error("No hero");
    await page.mouse.click(heroBox.x + 30, heroBox.y + 20);
    await page.locator("#element-text").fill("New scene title");
    await waitUntil(async () =>
      (await loadBundle(dir)).edits.elements.some(
        (e: any) => e.target.scene && e.text === "New scene title",
      ),
    );
    await page
      .locator("#element-save-state")
      .filter({ hasText: "Saved" })
      .waitFor();
    await page.locator("#element-remove").click();
    await waitUntil(async () =>
      (await loadBundle(dir)).edits.elements.some(
        (e: any) => e.target.scene && e.style?.display === "none",
      ),
    );
    await page
      .locator("#element-save-state")
      .filter({ hasText: "Saved" })
      .waitFor();
    expect(await hero.isVisible()).toBe(false);
    await page.locator("#element-hide").click();
    await page.waitForFunction(() => {
      const n = document
        .querySelector<HTMLIFrameElement>(".scene-frame.scene")
        ?.contentDocument?.querySelector("#hero");
      return (
        n &&
        getComputedStyle(n).display !== "none" &&
        getComputedStyle(n).visibility === "visible"
      );
    });
    await page
      .locator("#element-save-state")
      .filter({ hasText: "Saved" })
      .waitFor();
    await page.locator("#element-reset").click();
    await waitUntil(
      async () =>
        !(await loadBundle(dir)).edits.elements.some(
          (e: any) => e.target.scene,
        ),
    );
    await page
      .locator("#element-save-state")
      .filter({ hasText: "Saved" })
      .waitFor();
    expect(await hero.textContent()).toBe("Scene title");
    expect(await readFile(path.join(dir, "scenes/title.html"), "utf8")).toBe(
      originalScene,
    );
    // Force an agent mutation between the human draft and save.
    await page.route(
      "**/api/element-edit",
      async (route) => {
        await mutateProject(dir, undefined, "Agent font edit", (draft) => {
          draft.edits.elements.push({
            id: "agent-weight",
            target: { selector: "h1" },
            style: { "font-weight": "800" },
          });
        });
        await route.continue();
      },
      { times: 1 },
    );
    await page.locator("#element-text").fill("Conflict draft");
    await page.locator("#element-conflict:not([hidden])").waitFor();
    expect(await page.locator("#element-text").inputValue()).toBe(
      "Conflict draft",
    );
    await page.locator("#element-keep").click();
    await waitUntil(async () =>
      (await loadBundle(dir)).edits.elements.some(
        (e: any) => e.text === "Conflict draft",
      ),
    );
    await page
      .locator("#element-save-state")
      .filter({ hasText: "Saved" })
      .waitFor();
    expect(
      (await loadBundle(dir)).edits.elements.some(
        (e) => e.style?.["font-weight"] === "800",
      ),
    ).toBe(true);
    // Undo from the UI restores a scene without reloading its source iframe.
    await page.evaluate(() =>
      (document.querySelector("#undo") as HTMLButtonElement).click(),
    );
    await waitUntil(
      async () =>
        !(await loadBundle(dir)).edits.elements.some(
          (e) => e.text === "Conflict draft",
        ),
    );
    await page.waitForFunction(
      () =>
        document
          .querySelector<HTMLIFrameElement>(".scene-frame.scene")
          ?.contentDocument?.querySelector("#hero")?.textContent ===
        "Scene title",
    );
    await page.locator("#element-text").fill("Product overview");
    await waitUntil(async () =>
      (await loadBundle(dir)).edits.elements.some(
        (e) => e.text === "Product overview",
      ),
    );
    await page
      .locator("#element-save-state")
      .filter({ hasText: "Saved" })
      .waitFor();
    // Switching between pending drafts keeps each element's own values.
    await page.locator("#element-text").fill("Product overview draft");
    // Inline text can scale too; reset restores its original display.
    await page
      .locator(".direct-layer")
      .filter({ hasText: "span · Inline label" })
      .click();
    await page.locator("#element-scale-x").fill("150");
    await page
      .locator(".direct-layer")
      .filter({ hasText: "h1 · Product overview" })
      .click();
    expect(await page.locator("#element-text").inputValue()).toBe(
      "Product overview draft",
    );
    await page.locator("#element-text").fill("Product overview");
    await page
      .locator(".direct-layer")
      .filter({ hasText: "span · Inline label" })
      .click();

    await waitUntil(async () =>
      (await loadBundle(dir)).edits.elements.some(
        (e) => e.target.selector === "#inline" && e.transform?.scaleX === 1.5,
      ),
    );
    await page
      .locator("#element-save-state")
      .filter({ hasText: "Saved" })
      .waitFor();
    expect(
      await page
        .frameLocator(".scene-frame.scene")
        .locator("#inline")
        .evaluate((n) => getComputedStyle(n).display),
    ).toBe("inline-block");
    await page.locator("#element-reset").click();
    await waitUntil(
      async () =>
        !(await loadBundle(dir)).edits.elements.some(
          (e) => e.target.selector === "#inline",
        ),
    );
    await page
      .locator("#element-save-state")
      .filter({ hasText: "Saved" })
      .waitFor();
    expect(
      await page
        .frameLocator(".scene-frame.scene")
        .locator("#inline")
        .evaluate((n) => getComputedStyle(n).display),
    ).toBe("inline");
    await page
      .locator(".direct-layer")
      .filter({ hasText: "h1 · Product overview" })
      .click();
    await page.locator(".direct-scroll").evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.screenshot({ path: path.resolve(".context/direct-edit.png") });
    const renderer = await openReplayRenderer(dir);
    try {
      const capture = await renderer.snapshot(0, {
        ref: (await loadBundle(dir)).edits.elements[0]!.target.ref,
      });
      expect(capture?.html).toContain("Edited heading");
      expect(capture?.html).toContain("rgb(176, 32, 48)");
      const scene = await renderer.snapshot(1200, {
        scene: "scenes/title.html",
        selector: "#hero",
      });
      expect(scene?.html).toContain("Product overview");
      await writeFile(
        path.resolve(".context/direct-edit-export.png"),
        await renderer.frame(1200),
      );
    } finally {
      await renderer.close();
    }
    await page.setViewportSize({ width: 780, height: 900 });
    expect(await page.locator("#panel-edit").isVisible()).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    await preview?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 45000);
