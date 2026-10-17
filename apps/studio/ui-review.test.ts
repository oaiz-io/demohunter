import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { fixture, projectFixture, wavBytes } from "./test-support.js";
import { writeJson } from "./storage.js";
import { serveReplay } from "./server.js";
import { serveLibrary } from "./library-server.js";
import { MotionAudio } from "./web/motion-audio.js";

async function waitUntil(check: () => Promise<boolean>, what = "condition") {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error(`Timed out waiting for ${what}`);
    await Bun.sleep(30);
  }
}
const el = (
  id: number,
  tagName: string,
  attributes: Record<string, string>,
  childNodes: unknown[] = [],
) => ({ type: 2, id, tagName, attributes, childNodes });

/** A two-clip project: a recorded page, then an HTML scene whose script
 * marks the body when it runs. */
async function sceneProject() {
  const { root, dir } = await projectFixture();
  const b = fixture();
  b.edits.clips = [
    { id: "a", sourceStartMs: 0, sourceEndMs: 1000, rate: 1, holdMs: 0 },
    { id: "title", kind: "scene", src: "scenes/title.html", durationMs: 2000 },
  ];
  b.narration.segments = [
    { id: "n1", clipId: "a", offsetMs: 0, text: "Hello world again" },
  ];
  await writeJson(path.join(dir, "edits.json"), b.edits);
  await writeJson(path.join(dir, "narration.json"), b.narration);
  const body = el(4, "body", { style: "margin:0;background:#fff" }, [
    el(6, "h1", { id: "title", style: "margin:40px" }, [
      { type: 3, id: 7, textContent: "Original heading" },
    ]),
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
  ]);
  await mkdir(path.join(dir, "scenes"));
  await mkdir(path.join(dir, "audio"));
  await writeFile(
    path.join(dir, "scenes/title.html"),
    '<!doctype html><html><body style="margin:0;background:#f5f1e8"><h1 id="hero">Scene</h1><script>document.body.dataset.ran = "1";</script></body></html>',
  );
  return { root, dir };
}

async function withStudio(
  setup: Awaited<ReturnType<typeof sceneProject>>,
  run: (
    page: Page,
    app: Awaited<ReturnType<typeof serveReplay>>,
    errors: string[],
    dir: string,
  ) => Promise<void>,
  prepare?: (page: Page) => Promise<void>,
) {
  const app = await serveReplay(setup.dir, { port: 0 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 960 },
    });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await prepare?.(page);
    await page.goto(app.url);
    await page.waitForFunction(
      () => (window as any).__replayLab?.state().ready,
    );
    await page.evaluate(() => (window as any).__replayLab.scenesReady());
    await run(page, app, errors, setup.dir);
  } finally {
    await browser.close();
    await app.close();
    await rm(setup.root, { recursive: true, force: true });
  }
}
const seek = (page: Page, ms: number) =>
  page.evaluate((t) => (window as any).__replayLab.seek(t), ms);
const lab = (page: Page) =>
  page.evaluate(() => (window as any).__replayLab.state());
async function addComment(app: { url: string }, body: string, timeMs = 500) {
  const bundle = await fetch(`${app.url}/api/project`).then((r) => r.json());
  const response = await fetch(`${app.url}/api/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "add",
      expectedRevision: bundle.revision,
      timeMs,
      body,
      author: "You",
    }),
  });
  expect(response.status).toBe(200);
}

test("untrusted folders: scene scripts never run, the editor says so, Trust folder calls the desktop app", async () => {
  // Trusted control: the scene's inline script runs.
  await withStudio(await sceneProject(), async (page) => {
    await seek(page, 1500);
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLIFrameElement>(".scene-frame.scene")!
          .contentDocument!.body.dataset.ran === "1",
    );
    expect(await page.locator("#scene-trust").isVisible()).toBe(false);
  });
  // The workspace API reports trusted=false (the server also withholds the
  // scene CSP relaxations; the sandbox is what the editor adds on top).
  await withStudio(
    await sceneProject(),
    async (page, _app, errors) => {
      await seek(page, 1500);
      const frame = page.locator(".scene-frame.scene");
      await frame.waitFor({ state: "attached" });
      expect(await frame.getAttribute("sandbox")).toBe("allow-same-origin");
      expect(
        await page.evaluate(() => {
          const doc =
            document.querySelector<HTMLIFrameElement>(
              ".scene-frame.scene",
            )!.contentDocument!;
          return [
            doc.body.dataset.ran ?? null,
            doc.querySelector("#hero")?.textContent,
          ];
        }),
      ).toEqual([null, "Scene"]);
      // Studio can still drive the page: it is visible and seekable.
      expect(await frame.evaluate((n) => n.classList.contains("visible"))).toBe(
        true,
      );
      expect(await page.locator("#scene-trust").isVisible()).toBe(true);
      expect(await page.locator("#scene-trust").textContent()).toContain(
        "Scene scripts are off for this folder.",
      );
      await page.locator("#trust-folder").click();
      expect(await page.evaluate(() => (window as any).trustCalls)).toBe(1);
      expect(errors).toEqual([]);
    },
    async (page) => {
      await page.addInitScript(() => {
        (window as any).trustCalls = 0;
        (window as any).demohunterDesktop = {
          trust: () => {
            (window as any).trustCalls++;
            return new Promise(() => {});
          },
        };
      });
      await page.route("**/api/workspace", async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          json: { ...(await response.json()), trusted: false },
        });
      });
    },
  );
  // Without the desktop bridge the notice stays but offers no button.
  await withStudio(
    await sceneProject(),
    async (page) => {
      expect(await page.locator("#scene-trust").isVisible()).toBe(true);
      expect(await page.locator("#trust-folder").isVisible()).toBe(false);
    },
    async (page) => {
      await page.route("**/api/workspace", async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          json: { ...(await response.json()), trusted: false },
        });
      });
    },
  );
}, 60000);

test("saving does not rebuild the replay; paused frames are skipped; scenes survive audio changes; comments keep focus and thumbnails", async () => {
  const frames: string[] = [];
  await withStudio(
    await sceneProject(),
    async (page, app, errors, dir) => {
      await seek(page, 1500);
      await page.locator("#timeline-toggle").waitFor({ state: "attached" });
      await waitUntil(async () => frames.length >= 2, "thumbnails");
      await Bun.sleep(400);
      const thumbRequests = frames.length;

      // Idle: a paused, unchanged frame does (almost) no work.
      const before = (await lab(page)).updates as number;
      await Bun.sleep(1000);
      const idle = ((await lab(page)).updates as number) - before;
      expect(idle).toBeLessThan(10);
      await page.locator("#play").click();
      const playingFrom = (await lab(page)).updates as number;
      await Bun.sleep(400);
      expect(
        ((await lab(page)).updates as number) - playingFrom,
      ).toBeGreaterThan(8);
      await page.locator("#play").click();

      // A comment changes the revision but nothing visual: no new thumbnail
      // requests, and the scene page is not reloaded.
      await seek(page, 1500);
      await page.evaluate(() => {
        (window as any).sceneFrame =
          document.querySelector(".scene-frame.scene");
        (window as any).replayFrame = document.querySelector("#replay iframe");
      });
      const revision = (await lab(page)).revision;
      await addComment(app, "First note");
      await waitUntil(
        async () => (await lab(page)).revision !== revision,
        "reload",
      );
      await Bun.sleep(300);
      expect(frames.length).toBe(thumbRequests);
      expect(
        await page.evaluate(
          () =>
            (window as any).sceneFrame ===
              document.querySelector(".scene-frame.scene") &&
            (window as any).replayFrame ===
              document.querySelector("#replay iframe"),
        ),
      ).toBe(true);

      // Typing in a reply survives other notes arriving (cards were re-appended,
      // which blurred the textarea and turned letters into shortcuts).
      await page.locator('[data-tab="comments"]').click();
      await page.locator(".comment-card .comment-reply").first().click();
      const reply = page
        .locator(".comment-card .reply-compose textarea")
        .first();
      await reply.waitFor();
      await reply.focus();
      await page.keyboard.type("a");
      await addComment(app, "Second note", 900);
      await page.locator(".comment-card").nth(1).waitFor({ state: "attached" });
      await Bun.sleep(1900);
      await page.keyboard.type("bc");
      expect(await reply.inputValue()).toBe("abc");
      expect(await page.evaluate(() => document.body.dataset.tool)).toBe(
        "select",
      );
      expect(await reply.evaluate((n) => document.activeElement === n)).toBe(
        true,
      );

      // Audio changes reload the scene pages behind the visible ones: the
      // scene never disappears while the replacement loads.
      await page.locator("#timeline-toggle").waitFor({ state: "attached" });
      const sampled = page.evaluate(
        () =>
          new Promise<{ min: number; swapped: boolean }>((resolve) => {
            const started = performance.now();
            let min = Infinity;
            const first = document.querySelector(".scene-frame.scene");
            const sample = () => {
              min = Math.min(
                min,
                document.querySelectorAll(".scene-frame.scene.visible").length,
              );
              if (performance.now() - started > 2500)
                resolve({
                  min,
                  swapped:
                    first !== document.querySelector(".scene-frame.scene"),
                });
              else requestAnimationFrame(sample);
            };
            sample();
          }),
      );
      await Bun.sleep(100);
      await writeFile(path.join(dir, "audio/changed.wav"), wavBytes());
      const result = await sampled;
      expect(result.min).toBe(1);
      expect(result.swapped).toBe(true);
      expect(await page.locator(".scene-frame.scene").count()).toBe(1);
      expect(errors).toEqual([]);
    },
    async (page) => {
      page.on("request", (request) => {
        if (request.url().includes("/api/frame")) frames.push(request.url());
      });
    },
  );
}, 60000);

test("a save made while another reload is in flight waits for fresh data", async () => {
  await withStudio(await sceneProject(), async (page, app) => {
    await page.locator('[data-tab="narration"]').click();
    expect(await page.locator(".narration-card").count()).toBe(1);
    let gets = 0;
    await page.route("**/api/project", async (route) => {
      // Only the first read (the poll's reload) is slow.
      if (route.request().method() === "GET" && gets++ === 0)
        await Bun.sleep(1500);
      await route.continue();
    });
    // An outside change: the next status poll starts a slow reload.
    await addComment(app, "From outside");
    await waitUntil(async () => gets > 0, "poll reload");
    await page.locator("#add-segment").click();
    // The toast may only appear once the page shows the new segment.
    await page.locator("#toast:not([hidden])").waitFor();
    expect(await page.locator(".narration-card").count()).toBe(2);
  });
}, 60000);

test("errors can be dismissed and clear after the next successful action; notes post once", async () => {
  await withStudio(await sceneProject(), async (page) => {
    await page.locator('[data-tab="comments"]').click();
    let posts = 0,
      fail = true;
    await page.route("**/api/comments", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      posts++;
      if (fail) {
        await Bun.sleep(150);
        return route.fulfill({
          status: 500,
          json: { error: "Notes are unavailable." },
        });
      }
      await Bun.sleep(300);
      return route.continue();
    });
    const note = page.locator("#new-comment");
    await note.fill("Hello");
    await note.press("Control+Enter");
    await note.press("Control+Enter");
    await page.locator("#error").waitFor();
    expect(await page.locator("#error-text").textContent()).toBe(
      "Notes are unavailable.",
    );
    // Both shortcuts were one submission.
    expect(posts).toBe(1);
    await page.locator("#error-dismiss").click();
    expect(await page.locator("#error").isVisible()).toBe(false);
    // The same failure shows again; a success clears it without a click.
    await page.locator("#add-comment").click();
    await page.locator("#error").waitFor();
    fail = false;
    await page.locator("#add-comment").click();
    await page.locator("#error").waitFor({ state: "hidden" });
    await page.locator(".comment-card").first().waitFor();
  });
}, 60000);

test("keyboard and dialogs: modified arrows and repeats are ignored, drags ending on the backdrop keep dialogs open", async () => {
  await withStudio(await sceneProject(), async (page) => {
    await seek(page, 0);
    await page.locator("body").press("Meta+ArrowRight");
    await page.locator("body").press("Control+ArrowRight");
    await page.locator("body").press("Alt+ArrowRight");
    expect((await lab(page)).position).toBe(0);
    await page.locator("body").press("ArrowRight");
    expect((await lab(page)).position).toBe(1000);
    // Held Space toggles playback once.
    await page.evaluate(() => {
      for (const repeat of [false, true, true, true])
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", {
            code: "Space",
            key: " ",
            repeat,
            bubbles: true,
          }),
        );
    });
    expect((await lab(page)).playing).toBe(true);
    await page.locator("#play").click();
    // Resize handles are not tab stops.
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".direct-handle")].every(
          (h) => h.tabIndex === -1,
        ),
      ),
    ).toBe(true);

    await page.locator("#project-menu summary").click();
    await page.locator("#help-open").click();
    const dialog = page.locator("#help-dialog");
    await dialog.waitFor();
    const box = (await dialog.boundingBox())!;
    // Press inside, release on the backdrop: stays open.
    await page.mouse.move(box.x + box.width / 2, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x - 20, box.y - 20);
    await page.mouse.up();
    expect(await dialog.evaluate((d: HTMLDialogElement) => d.open)).toBe(true);
    // A real backdrop click closes it.
    await page.mouse.click(box.x - 20, box.y - 20);
    expect(await dialog.evaluate((d: HTMLDialogElement) => d.open)).toBe(false);
  });
}, 60000);

test("script segments: readable remove labels, confirm before dropping unsaved text", async () => {
  await withStudio(await sceneProject(), async (page) => {
    await page.locator('[data-tab="narration"]').click();
    const remove = page.locator(".narration-card .segment-remove");
    expect(await remove.getAttribute("aria-label")).toMatch(
      /^Remove (Scene 1|.+)$/,
    );
    expect(await remove.getAttribute("aria-label")).not.toContain("n1");
    const text = page.locator(".narration-card textarea.script-text");
    await text.fill("Edited words that are not saved yet");
    let asked = "";
    page.once("dialog", (d) => {
      asked = d.message();
      void d.dismiss();
    });
    await remove.click();
    expect(asked).toContain("unsaved");
    expect(await page.locator(".narration-card").count()).toBe(1);
  });
}, 60000);

test("motion audio: a cue at 0 ms plays from the start; rewritten music reloads", () => {
  const g = globalThis as any;
  const saved = { Audio: g.Audio, location: g.location };
  const made: { src: string; played: number }[] = [];
  g.location = { pathname: "/", href: "http://localhost/" };
  g.Audio = class {
    paused = true;
    volume = 1;
    currentTime = 0;
    duration = 60;
    preload = "";
    played = 0;
    constructor(public src: string) {
      made.push(this);
    }
    play() {
      this.played++;
      this.paused = false;
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
    cloneNode() {
      return this;
    }
  };
  try {
    const bundle = fixture();
    bundle.assetsRevision = "one";
    bundle.edits.audio = {
      music: [
        {
          id: "bed",
          src: "audio/bed.wav",
          startMs: 0,
          offsetMs: 0,
          volume: 0.3,
          fadeInMs: 0,
          fadeOutMs: 0,
          duck: 0.35,
        },
      ],
      sfx: [{ id: "pop", src: "audio/pop.wav", atMs: 0, volume: 0.7 }],
    };
    const audio = new MotionAudio();
    // Play from the very start: the 0 ms effect sounds exactly once.
    audio.sync(bundle, 0, true, true, []);
    audio.sync(bundle, 16, true, false, []);
    audio.sync(bundle, 32, true, false, []);
    const effects = made.filter((a) => a.src.includes("pop.wav"));
    expect(effects.reduce((n, a) => n + a.played, 0)).toBe(1);
    // Playing from elsewhere does not fire a cue that is already behind.
    audio.pause();
    made.length = 0;
    audio.sync(bundle, 500, true, true, []);
    audio.sync(bundle, 516, true, false, []);
    expect(
      made
        .filter((a) => a.src.includes("pop.wav"))
        .reduce((n, a) => n + a.played, 0),
    ).toBe(0);
    // The same path with new content (new asset stamp) loads a fresh player.
    made.length = 0;
    bundle.assetsRevision = "two";
    audio.sync(bundle, 600, true, true, []);
    expect(
      made.some((a) => a.src.includes("bed.wav") && a.src.includes("two")),
    ).toBe(true);
  } finally {
    // Leave no trace: other tests share this process.
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete g[name];
      else g[name] = value;
  }
});

test("library: narrow widths ignore the hidden scope, failed posters retry, focus survives re-render, ages refresh", async () => {
  const { root } = await projectFixture();
  const app = await serveLibrary(root, { port: 0 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
    });
    page.setDefaultTimeout(5000);
    await page.clock.install({ time: new Date() });
    const workspace = (await fetch(`${app.url}/api/library`).then((r) =>
      r.json(),
    )) as any;
    const other = "/tmp/dh-other-worktree";
    await page.route("**/api/library", async (route) => {
      const real = await fetch(`${app.url}/api/library`).then((r) => r.json());
      await route.fulfill({
        json: {
          ...real,
          worktrees: [
            {
              path: real.workspace,
              name: "main",
              branch: "main",
              current: true,
              main: true,
              recordings: real.recordings.length,
            },
            {
              path: other,
              name: "other",
              branch: "feature",
              current: false,
              main: false,
              recordings: 0,
            },
          ],
          recordings: real.recordings.map((r: any) => ({
            ...r,
            worktree: real.workspace,
            modifiedAt: new Date().toISOString(),
          })),
        },
      });
    });
    let posterTries = 0;
    await page.route("**/poster.png*", async (route) => {
      posterTries++;
      if (posterTries === 1) return route.abort();
      return route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          "base64",
        ),
      });
    });
    await page.addInitScript(
      ([key]) => localStorage.setItem(key!, "/tmp/dh-other-worktree"),
      [`demohunter.worktree:${workspace.workspace}`],
    );
    await page.goto(app.url);
    await page.locator("#projects").waitFor();
    // Wide: the remembered scope (an empty worktree) is honoured.
    expect(await page.locator(".recording-card").count()).toBe(0);
    // Narrow: the sidebar is hidden, so everything shows.
    await page.setViewportSize({ width: 700, height: 800 });
    await page.locator(".recording-card").waitFor();
    // The first poster request failed; a later render retries it.
    await page.locator("#search").fill("");
    await page.locator("#search").dispatchEvent("input");
    await page.locator(".recording-poster.loaded").waitFor();
    expect(posterTries).toBeGreaterThanOrEqual(2);
    // Ages move on without new data.
    expect(await page.locator(".card-when").first().textContent()).toBe(
      "Edited just now",
    );
    await page.clock.fastForward("05:00");
    await page.waitForFunction(
      () =>
        document.querySelector(".card-when")?.textContent ===
        "Edited 5 min ago",
    );
    // Back to wide: choosing a worktree keeps focus on its sidebar button.
    await page.setViewportSize({ width: 1200, height: 800 });
    const main = page.locator('[data-key^="wt:"]').first();
    await main.focus();
    await page.keyboard.press("Enter");
    expect(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("data-key"),
      ),
    ).toMatch(/^wt:/);
  } finally {
    await browser.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
