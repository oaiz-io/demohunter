import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { fixture, projectFixture } from "./test-support.js";
import { writeJson, loadBundle } from "./storage.js";
import { openReplayRenderer } from "./render.js";
import { serveReplay } from "./server.js";
import { distributeText } from "./web/element-overrides.js";

// Screenshots for visual review; DH_SHOTS=/tmp/dh-text keeps them elsewhere.
const shots = process.env.DH_SHOTS ?? path.resolve(".context");

async function waitUntil(check: () => Promise<boolean>, what = "condition") {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error(`Timed out waiting for ${what}`);
    await Bun.sleep(30);
  }
}
let nextId = 20;
const text = (value: string) => ({
  type: 3,
  id: nextId++,
  textContent: value,
});
const el = (
  id: number,
  tagName: string,
  attributes: Record<string, string>,
  childNodes: unknown[] = [],
) => ({ type: 2, id, tagName, attributes, childNodes });

test("text distribution keeps formatting of unchanged runs", () => {
  expect(distributeText(["Hello ", "world"], "Hello planet")).toEqual([
    "Hello ",
    "planet",
  ]);
  expect(
    distributeText(["Hello ", "world", " today"], "Hi world today"),
  ).toEqual(["Hi ", "world", " today"]);
  // Source indentation is dropped; the visible words keep their nodes.
  expect(distributeText(["\n  Hello ", "world", "\n"], "Hello there")).toEqual([
    "Hello ",
    "there",
    "",
  ]);
  // A full rewrite goes to the first node, as before.
  expect(distributeText(["Original heading"], "Edited heading")).toEqual([
    "Edited heading",
  ]);
  expect(distributeText(["A", "B"], "")).toEqual(["", ""]);
  // Changes in two places keep each node's own formatting.
  expect(
    distributeText(["Hello ", "world", " today"], "Hi planet today"),
  ).toEqual(["Hi ", "planet", " today"]);
  expect(distributeText(["Hello ", "world"], "Hello big world")).toEqual([
    "Hello big ",
    "world",
  ]);
  // Line breaks never receive text.
  expect(
    distributeText(["One", "\n", "Two"], "One Two", [false, true, false]),
  ).toEqual(["One ", "", "Two"]);
});

test("inline canvas text editing: commit, cancel, targeting, fields, Tab, overflow, undo and export", async () => {
  const { root, dir } = await projectFixture();
  let preview: Awaited<ReturnType<typeof serveReplay>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await mkdir(shots, { recursive: true });
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
    b.edits.overlays = [
      { id: "caption", src: "scenes/caption.html", startMs: 0, endMs: 1000 },
    ];
    b.narration.segments = [];
    await writeJson(path.join(dir, "edits.json"), b.edits);
    await writeJson(path.join(dir, "narration.json"), b.narration);
    const abs = (rest: string) => `position:absolute;margin:0;${rest}`;
    const body = el(4, "body", { style: "margin:0;background:#fff" }, [
      el(
        6,
        "h1",
        {
          id: "title",
          style: abs(
            "left:120px;top:100px;width:300px;height:60px;font:600 32px/40px Georgia,serif;letter-spacing:0.5px;color:#1d2a44",
          ),
        },
        [{ type: 3, id: 7, textContent: "Original heading" }],
      ),
      el(
        8,
        "p",
        {
          id: "intro",
          style: abs(
            "left:120px;top:200px;width:520px;font:20px/28px sans-serif",
          ),
        },
        [
          { type: 3, id: 9, textContent: "Hello " },
          el(10, "b", {}, [{ type: 3, id: 11, textContent: "world" }]),
          { type: 3, id: 12, textContent: " today" },
        ],
      ),
      el(
        13,
        "div",
        {
          id: "badge",
          style: abs(
            "left:120px;top:260px;width:90px;height:24px;overflow:hidden;white-space:nowrap;font:16px/24px sans-serif;background:#eef",
          ),
        },
        [{ type: 3, id: 14, textContent: "Short" }],
      ),
      el(15, "input", {
        id: "email",
        type: "text",
        value: "ada@example.com",
        style: abs(
          "left:120px;top:320px;width:260px;height:32px;box-sizing:border-box;padding:4px 8px;font:16px sans-serif;border:1px solid #999",
        ),
      }),
      el(
        16,
        "a",
        {
          id: "next",
          href: "http://example.test/next",
          style: abs("left:120px;top:380px;font:16px/20px sans-serif"),
        },
        [{ type: 3, id: 17, textContent: "Next page" }],
      ),
    ]);
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
            childNodes: [el(2, "html", {}, [el(3, "head", {}, []), body])],
          },
        },
      },
      // The recording types into the field, then changes the heading.
      {
        type: 3,
        timestamp: 1500,
        data: {
          source: 5,
          id: 15,
          text: "typed@example.com",
          isChecked: false,
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
    await writeFile(
      path.join(dir, "scenes/title.html"),
      '<!doctype html><html><body style="margin:0;background:#f5f1e8"><h1 id="hero" style="position:absolute;left:180px;top:140px;margin:0;font:48px sans-serif">Scene <em>title</em></h1></body></html>',
    );
    await writeFile(
      path.join(dir, "scenes/caption.html"),
      '<!doctype html><html><body style="margin:0;background:transparent"><div id="cap" style="position:absolute;left:760px;top:40px;padding:6px 10px;background:#111;color:#fff;font:14px sans-serif">Overlay caption</div></body></html>',
    );
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
    const ready = async () => {
      await page.waitForFunction(
        () => (window as any).__replayLab?.state().ready,
      );
      await page.evaluate(() => (window as any).__replayLab.scenesReady());
    };
    const seek = (ms: number) =>
      page.evaluate((t) => (window as any).__replayLab.seek(t), ms);
    await page.goto(preview.url);
    await ready();
    await seek(300);
    await page.locator('[data-tab="edit"]').click();
    expect(await page.locator(".direct-tip").textContent()).toContain(
      "Double-click text",
    );
    const replay = page.frameLocator("#replay iframe");
    const editor = replay.locator("demohunter-text-editor .f");
    const heading = replay.locator("#title");
    const saved = async () => (await loadBundle(dir)).edits.elements;
    const settled = () =>
      page
        .locator("#element-save-state")
        .filter({ hasText: "Saved" })
        .waitFor();
    const dbl = async (locator: ReturnType<Page["locator"]>, dx = 0.5) => {
      const box = await locator.boundingBox();
      if (!box) throw Error("Element is not visible");
      await page.mouse.dblclick(box.x + box.width * dx, box.y + box.height / 2);
    };

    // Opens exactly over the text, with matching type and all text selected.
    const headingBox = (await heading.boundingBox())!;
    await dbl(heading, 0.3);
    await editor.waitFor();
    const fieldBox = (await editor.boundingBox())!;
    for (const key of ["x", "y", "width", "height"] as const)
      expect(Math.abs(fieldBox[key] - headingBox[key])).toBeLessThan(1.5);
    const style = await editor.evaluate((n) => {
      const s = getComputedStyle(n);
      const f = n as HTMLTextAreaElement;
      return {
        font: `${s.fontWeight} ${s.fontSize}/${s.lineHeight} ${s.fontFamily}`,
        spacing: s.letterSpacing,
        color: s.color,
        selected: [f.selectionStart, f.selectionEnd],
        value: f.value,
        focused:
          n.getRootNode() instanceof ShadowRoot &&
          (n.getRootNode() as ShadowRoot).activeElement === n,
      };
    });
    expect(style).toEqual({
      font: "600 32px/40px Georgia, serif",
      spacing: "0.5px",
      color: "rgb(29, 42, 68)",
      selected: [0, 16],
      value: "Original heading",
      focused: true,
    });
    expect(
      await page.evaluate(() => (window as any).__replayLab.state().playing),
    ).toBe(false);
    await page.screenshot({ path: `${shots}/inline-heading.png` });
    // Typing updates the real element and the panel; Esc restores it.
    await page.keyboard.type("Draft heading");
    expect(await heading.textContent()).toBe("Draft heading");
    expect(await page.locator("#element-text").inputValue()).toBe(
      "Draft heading",
    );
    await page.keyboard.press("Escape");
    await editor.waitFor({ state: "detached" });
    expect(await heading.textContent()).toBe("Original heading");
    expect(await saved()).toEqual([]);

    // Enter commits through the targeted element patch.
    await dbl(heading, 0.3);
    await editor.waitFor();
    await page.keyboard.type("Edited heading");
    await page.keyboard.press("Enter");
    await waitUntil(
      async () => (await saved()).some((e) => e.text === "Edited heading"),
      "heading save",
    );
    await settled();
    const headingRef = (await saved()).find((e) => e.text === "Edited heading")!
      .target.ref!;
    expect(headingRef).toEndWith("-n6");

    // The deepest owner of the clicked text: only the <b>.
    await dbl(replay.locator("#intro b"));
    await editor.waitFor();
    expect(await editor.inputValue()).toBe("world");
    await page.keyboard.type("planet");
    await page.keyboard.press("Enter");
    await waitUntil(
      async () =>
        (await saved()).some(
          (e) => e.text === "planet" && e.target.ref?.endsWith("-n10"),
        ),
      "bold save",
    );
    await settled();
    expect(await replay.locator("#intro").innerHTML()).toBe(
      "Hello <b>planet</b> today",
    );
    // Rewriting the paragraph itself keeps the unchanged bold run.
    const intro = (await replay.locator("#intro").boundingBox())!;
    await page.mouse.dblclick(intro.x + 12, intro.y + intro.height / 2);
    await editor.waitFor();
    expect(await editor.inputValue()).toBe("Hello planet today");
    await page.keyboard.type("Hi planet today");
    await page.keyboard.press("Enter");
    await waitUntil(
      async () => (await saved()).some((e) => e.text === "Hi planet today"),
      "paragraph save",
    );
    await settled();
    expect(await replay.locator("#intro").innerHTML()).toBe(
      "Hi <b>planet</b> today",
    );

    // Tab moves in reading order on this frame; unchanged text saves nothing.
    const count = (await saved()).length;
    await dbl(heading, 0.3);
    await editor.waitFor();
    await page.keyboard.press("Tab");
    await page.waitForFunction(() => {
      const f = document
        .querySelector<HTMLIFrameElement>("#replay iframe")!
        .contentDocument!.querySelector("demohunter-text-editor")
        ?.shadowRoot?.querySelector<HTMLTextAreaElement>(".f");
      return f?.value === "Hi planet today";
    });
    await page.keyboard.press("Tab");
    await page.waitForFunction(
      () =>
        document
          .querySelector<HTMLIFrameElement>("#replay iframe")!
          .contentDocument!.querySelector("demohunter-text-editor")
          ?.shadowRoot?.querySelector<HTMLTextAreaElement>(".f")?.value ===
        "planet",
    );
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await page.waitForFunction(
      () =>
        document
          .querySelector<HTMLIFrameElement>("#replay iframe")!
          .contentDocument!.querySelector("demohunter-text-editor")
          ?.shadowRoot?.querySelector<HTMLTextAreaElement>(".f")?.value ===
        "Edited heading",
    );
    // Before the heading comes the overlay caption at the top of the frame.
    await page.keyboard.press("Shift+Tab");
    const caption = page
      .frameLocator(".scene-frame.overlay")
      .locator("demohunter-text-editor .f");
    await caption.waitFor();
    expect(await caption.inputValue()).toBe("Overlay caption");
    await page.keyboard.type("Edited caption");
    await page.keyboard.press("Enter");
    await waitUntil(
      async () =>
        (await saved()).some(
          (e) =>
            e.target.scene === "scenes/caption.html" &&
            e.text === "Edited caption",
        ),
      "overlay save",
    );
    await settled();
    expect((await saved()).length).toBe(count + 1);
    // Tab after a change saves it; the editor follows the rebuilt replay.
    await dbl(replay.locator("#intro b"));
    await editor.waitFor();
    await page.keyboard.type("globe");
    await page.evaluate(() => {
      (window as any).oldFrame = document.querySelector("#replay iframe");
    });
    await page.keyboard.press("Tab");
    await waitUntil(
      async () => (await saved()).some((e) => e.text === "globe"),
      "Tab save",
    );
    await page.locator("#save-indicator").waitFor({ state: "hidden" });
    // Saving an edit applies it to the live replay; it is not rebuilt.
    await editor.waitFor();
    expect(
      await page.evaluate(
        () =>
          document.querySelector("#replay iframe") === (window as any).oldFrame,
      ),
    ).toBe(true);
    expect(await editor.inputValue()).toBe("Short");
    expect(
      await editor.evaluate(
        (n) => (n.getRootNode() as ShadowRoot).activeElement === n,
      ),
    ).toBe(true);
    // The second editor of a Tab chain opened before the first save landed;
    // its own save must not report a conflict.
    await page.keyboard.type("Tiny");
    await page.keyboard.press("Enter");
    await waitUntil(
      async () => (await saved()).some((e) => e.text === "Tiny"),
      "chained Tab save",
    );
    await settled();
    expect(await page.locator("#element-conflict").isVisible()).toBe(false);
    expect((await saved()).filter((e) => e.text === "globe").length).toBe(1);
    await editor.waitFor({ state: "detached" });
    expect(await replay.locator("#intro").innerHTML()).toBe(
      "Hi <b>globe</b> today",
    );

    // Overflow warning in the editor and the panel.
    await dbl(replay.locator("#badge"));
    await editor.waitFor();
    await page.keyboard.type("A much longer badge label");
    await page.locator(".inline-text-status.warn").waitFor();
    expect(await page.locator(".inline-text-status").textContent()).toContain(
      "overflows",
    );
    expect(await page.locator("#element-text-warning").isVisible()).toBe(true);
    await page.screenshot({ path: `${shots}/inline-overflow.png` });
    await page.keyboard.press("Escape");
    await editor.waitFor({ state: "detached" });
    expect(await page.locator("#element-text-warning").isVisible()).toBe(false);

    // Clicking outside commits; the recorded link is not followed.
    await dbl(replay.locator("#next"));
    await editor.waitFor();
    await page.keyboard.type("Continue");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("reading");
    expect(
      await replay
        .locator("#next")
        .evaluate((n) => (n as HTMLElement).innerText),
    ).toBe("Continue\nreading");
    const frame = (await page.locator("#replay iframe").boundingBox())!;
    await page.mouse.click(
      frame.x + frame.width * 0.8,
      frame.y + frame.height * 0.8,
    );
    await waitUntil(
      async () =>
        (await saved()).some(
          (e) =>
            e.text === "Continue\nreading" &&
            e.style?.["white-space"] === "pre-line",
        ),
      "outside click save",
    );
    await settled();
    expect(await replay.locator("#next").textContent()).toBe(
      "Continue\nreading",
    );
    expect(
      await replay.locator("#next").evaluate((n) => n.ownerDocument.URL),
    ).not.toContain("/next");
    // Undo restores the previous text.
    await page.locator("#undo:not([disabled])").waitFor({ state: "attached" });
    await page.evaluate(() =>
      (document.querySelector("#undo") as HTMLButtonElement).click(),
    );
    await waitUntil(
      async () => !(await saved()).some((e) => e.text?.startsWith("Continue")),
      "undo",
    );
    await page.waitForFunction(
      () =>
        document
          .querySelector<HTMLIFrameElement>("#replay iframe")!
          .contentDocument!.querySelector("#next")?.textContent === "Next page",
    );

    // A recorded form field: the rewritten value wins over input events.
    await seek(800);
    const email = replay.locator("#email");
    expect(await email.inputValue()).toBe("typed@example.com");
    await dbl(email);
    await editor.waitFor();
    expect(await editor.inputValue()).toBe("typed@example.com");
    expect(await editor.evaluate((n) => n.localName)).toBe("input");
    await page.keyboard.type("demo@example.com");
    await page.screenshot({ path: `${shots}/inline-input.png` });
    await page.keyboard.press("Enter");
    await waitUntil(
      async () => (await saved()).some((e) => e.text === "demo@example.com"),
      "input save",
    );
    await settled();
    expect(await email.inputValue()).toBe("demo@example.com");
    await seek(100);
    expect(await email.inputValue()).toBe("demo@example.com");
    await page.locator("#play").click();
    await page.waitForFunction(
      () => (window as any).__replayLab.state().position > 650,
    );
    expect(await email.inputValue()).toBe("demo@example.com");
    expect(await heading.textContent()).toBe("Edited heading");
    await page.locator("#play").click();

    // HTML scene text, then reload: every edit persists for the whole video.
    await seek(1200);
    await dbl(page.frameLocator(".scene-frame.scene").locator("#hero em"));
    const scene = page
      .frameLocator(".scene-frame.scene")
      .locator("demohunter-text-editor .f");
    await scene.waitFor();
    expect(await scene.inputValue()).toBe("title");
    await page.keyboard.type("overview");
    await page.keyboard.press("Enter");
    await waitUntil(
      async () =>
        (await saved()).some(
          (e) =>
            e.target.scene === "scenes/title.html" && e.text === "overview",
        ),
      "scene save",
    );
    await settled();
    expect(
      await page
        .frameLocator(".scene-frame.scene")
        .locator("#hero")
        .innerHTML(),
    ).toBe("Scene <em>overview</em>");
    await page.reload();
    await ready();
    for (const t of [900, 100, 700]) {
      await seek(t);
      expect(await heading.textContent()).toBe("Edited heading");
      expect(await replay.locator("#intro").innerHTML()).toBe(
        "Hi <b>globe</b> today",
      );
      expect(await email.inputValue()).toBe("demo@example.com");
    }
    // Hovering in edit mode marks elements with rewritten text.
    await page.locator('[data-tab="edit"]').click();
    const h = (await heading.boundingBox())!;
    await page.mouse.move(h.x + 20, h.y + 10);
    await page.locator(".text-edit-mark.hot").waitFor();
    expect(
      await page.locator(".text-edit-mark").count(),
    ).toBeGreaterThanOrEqual(4);
    await page.screenshot({ path: `${shots}/inline-marks.png` });

    // The shared export renderer shows the same text and field value.
    const renderer = await openReplayRenderer(dir);
    try {
      const input = await renderer.snapshot(800, {
        ref: (await saved()).find((e) => e.text === "demo@example.com")!.target
          .ref,
      });
      expect(input?.html).toContain('value="demo@example.com"');
      const shot = await renderer.snapshot(800, { ref: headingRef });
      expect(shot?.html).toContain("Edited heading");
      expect(
        await renderer.page.evaluate(() => {
          const doc =
            document.querySelector<HTMLIFrameElement>(
              "#replay iframe",
            )!.contentDocument!;
          return [
            doc.querySelector<HTMLInputElement>("#email")!.value,
            doc.querySelector("#intro")!.innerHTML,
          ];
        }),
      ).toEqual(["demo@example.com", "Hi <b>globe</b> today"]);
      await writeFile(`${shots}/export-frame.png`, await renderer.frame(800));
    } finally {
      await renderer.close();
    }
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    await preview?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
