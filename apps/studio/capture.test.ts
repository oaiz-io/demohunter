import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_DEMOHUNTER_CONFIG } from "@demohunter/sdk";
import { captureReplay } from "./capture.js";
import { chromium } from "playwright";
async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Timed out waiting for shared project state");
}
import { serveLibrary } from "./library-server.js";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { serveReplay } from "./server.js";
import { ReplayWorkspace } from "./workspace.js";
import { exportReplay } from "./export.js";
import { narrationRequestKey, totalDuration } from "./model.js";
import { wavBytes } from "./test-support.js";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { renderReplayFrame, openReplayRenderer } from "./render.js";
import { loadBundle, writeJson } from "./storage.js";

test("captures editable DOM replay and exports saved narration and video without the source app", async () => {
  const app = createServer((req, res) => {
    if (req.url === "/theme.css") {
      res.setHeader("Content-Type", "text/css");
      res.end(
        "body{color:rgb(20,40,20);background-image:url('/image.svg')}@font-face{font-family:Unused;src:url('/unused.woff2')}",
      );
      return;
    }
    if (req.url === "/unused.woff2") {
      res.setHeader("Content-Type", "font/woff2");
      res.end("wOF2");
      return;
    }
    if (req.url === "/image.svg") {
      res.setHeader("Content-Type", "image/svg+xml");
      res.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="white"/></svg>',
      );
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<html><head><link rel="stylesheet" href="/theme.css"><link rel="icon" href="/favicon.png"></head><body><h1>${req.url === "/second" ? "Second document" : "Original heading"}</h1><button onclick="document.querySelector('h1').textContent='Changed heading'">Change</button></body></html>`,
    );
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const port = (app.address() as { port: number }).port;
  const root = await mkdtemp(path.join(tmpdir(), "demohunter-capture-"));
  const dir = path.join(root, "capture");
  try {
    await captureReplay({
      projectDir: dir,
      loadedConfig: {
        projectRoot: root,
        configPath: "fixture",
        config: {
          ...DEFAULT_DEMOHUNTER_CONFIG,
          baseURL: `http://127.0.0.1:${port}`,
          outputDir: root,
          cacheDir: path.join(root, "cache"),
          record: { ...DEFAULT_DEMOHUNTER_CONFIG.record, cursor: false },
        },
      },
      tourFile: {
        path: "fixture",
        tour: {
          id: "capture-test",
          title: "Capture test",
          async run({ page, goto }) {
            await page.getByRole("button", { name: "Change" }).click();
            await page.waitForTimeout(80);
            await goto("/second");
            await page.waitForTimeout(80);
          },
        },
      },
    });
    await new Promise<void>((resolve) => app.close(() => resolve()));
    const bundle = await loadBundle(dir);
    const eventText = await readFile(path.join(dir, "events.json"), "utf8");
    expect(bundle.project.capture.assetCount).toBeGreaterThanOrEqual(2);
    expect(eventText).toContain("Original heading");
    expect(eventText).toContain("Changed heading");
    expect(eventText).toContain("Second document");
    expect(eventText).toContain("/files/assets/");
    // Declared but unused fonts are bundled; unfetched icons are dropped.
    expect(eventText).not.toContain(`127.0.0.1:${port}/unused.woff2`);
    expect(eventText).not.toContain(`127.0.0.1:${port}/favicon.png`);
    const events = JSON.parse(eventText);
    expect(
      events.filter((e: { type: number }) => e.type === 2).length,
    ).toBeGreaterThanOrEqual(2);
    const files = await readdir(dir);
    expect(files).not.toContain("video.mp4");
    expect(files).toContain("AGENTS.md");
    const assetNames = await readdir(path.join(dir, "assets"));
    const cssName = assetNames.find(
      (name) => name.endsWith(".css") && name !== "rrweb.css",
    )!;
    expect(await readFile(path.join(dir, "assets", cssName), "utf8")).toContain(
      "/files/assets/",
    );
    await expect(captureReplay({ projectDir: dir } as any)).rejects.toThrow();
    // Test the shared human/agent workflow against this actual capture, with
    // its source server already stopped.
    bundle.narration.segments.push({
      id: "script",
      clipId: bundle.edits.clips[0]!.id,
      offsetMs: 0,
      text: "Original script.",
    });
    await writeJson(path.join(dir, "narration.json"), bundle.narration);
    const workspace = await ReplayWorkspace.open(dir);
    const heading = workspace.index.elements.find(
      (e) => e.tag === "h1" && e.documentId === 1,
    )!;
    const preview = await serveReplay(dir, { port: 0 });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 960 },
      });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async (text: string) => {
              (window as any).__copied = text;
            },
          },
        });
      });
      await page.goto(preview.url);
      await page.waitForFunction(
        () => (window as any).__replayLab?.state().ready,
      );
      await page.evaluate(() => (window as any).__replayLab.seek(999999));
      await page.evaluate(() => (window as any).__replayLab.seek(0));
      expect(
        await page.frameLocator("iframe").locator("h1").textContent(),
      ).toBe("Original heading");
      expect(await page.locator("#panel-comments").isVisible()).toBe(true);
      expect(await page.locator("#scene-drawer").isVisible()).toBe(false);
      expect(await page.locator("#selection-toolbar").isVisible()).toBe(false);
      // The editor is a review surface: no element/timing panels, find and
      // replace, speed or export tuning.
      expect(
        await page
          .locator(
            "#element-tab, #panel-selection, #panel-timing, #find-toggle, #speed, #export-fps, #export-strict, #follow-agent, #review-open",
          )
          .count(),
      ).toBe(0);
      expect(
        await page.locator('.tabs [role="tab"]').allTextContents(),
      ).toEqual([
        expect.stringContaining("Notes"),
        expect.stringContaining("Script"),
        expect.stringContaining("Agent"),
      ]);
      await page.locator("#scenes-toggle").click();
      expect(await page.locator("#scene-drawer").isVisible()).toBe(true);
      await page.locator(".scene-button").first().click();
      expect(await page.locator("#scene-drawer").isVisible()).toBe(false);
      const clickHeading = async () => {
        const box = await page
          .frameLocator("iframe")
          .locator("h1")
          .boundingBox();
        if (!box) throw new Error("Heading is not visible");
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      };
      await clickHeading();
      await page.locator("#selection-toolbar:not([hidden])").waitFor();
      expect(
        await page.locator("#selection-box .selection-label").textContent(),
      ).toContain(heading.ref);
      expect(
        await page.locator("#selection-toolbar button").allTextContents(),
      ).toEqual([
        expect.stringContaining("Note"),
        expect.stringContaining("Copy for agent"),
      ]);
      await page.locator("#toolbar-copy").click();
      const handoff = JSON.parse(
        await page.evaluate(() => (window as any).__copied),
      );
      expect(handoff.element.ref).toBe(heading.ref);
      expect(handoff.reference).toContain(heading.ref);
      expect(handoff.element.capturedHtml).toContain(
        `/sources/${heading.ref}.html`,
      );
      await page.keyboard.press("c");
      await clickHeading();
      expect(await page.locator("#panel-comments").isVisible()).toBe(true);
      expect(
        await page
          .locator("#new-comment")
          .evaluate((n) => document.activeElement === n),
      ).toBe(true);
      await page.locator("#new-comment").fill("Please shorten this heading");
      await page.locator("#add-comment").click();
      await until(
        async () => (await loadBundle(dir)).comments.threads.length === 1,
      );
      expect((await loadBundle(dir)).comments.threads[0]!.elementRef).toBe(
        heading.ref,
      );
      await page.locator(".comment-copy").click();
      const copied = JSON.parse(
        await page.evaluate(() => (window as any).__copied),
      );
      expect(copied.comment.body).toBe("Please shorten this heading");
      expect(copied.threadId).toBe(copied.comment.id);
      expect(copied.reference).toContain(`/comment/${copied.comment.id}`);
      expect(
        new URLSearchParams(new URL(copied.preview).hash.slice(1)).get(
          "comment",
        ),
      ).toBe(copied.comment.id);
      expect(copied.element.ref).toBe(heading.ref);
      expect(copied.element.capturedHtml).toContain(
        `/sources/${heading.ref}.html`,
      );
      await page
        .getByRole("button", { name: "Copy comment ID", exact: true })
        .click();
      expect(await page.evaluate(() => (window as any).__copied)).toBe(
        copied.comment.id,
      );
      await page.locator(".comment-link").click();
      const commentLink = await page.evaluate(() => (window as any).__copied);
      expect(commentLink).toBe(copied.preview);
      await page.locator(".comment-body").dblclick();
      expect(
        JSON.parse(await page.evaluate(() => (window as any).__copied))
          .threadId,
      ).toBe(copied.comment.id);
      // A canvas pin opens the note even when the Resolved filter was active.
      await page.locator("#toggle-resolved").click();
      await page.locator("#comment-pins .comment-pin").click();
      await page.locator(".comment-card.active:not([hidden])").waitFor();
      expect(
        await page.locator("#filter-open").getAttribute("class"),
      ).toContain("active");
      // The note pin inside a card also opens its exact note and moment.
      await page.locator(".comment-card > button.pin").click();
      expect(
        await page.locator(".comment-card.active").getAttribute("data-id"),
      ).toBe(copied.comment.id);
      await page.keyboard.press("Escape");
      await until(
        async () => ((await workspace.selection()) as any).selection === null,
      );
      expect(await page.locator("#selection-toolbar").isVisible()).toBe(false);
      await page.keyboard.press("s");
      expect(await page.locator("#panel-narration").isVisible()).toBe(true);
      const script = page.locator("textarea.script-text");
      await script.fill("My local draft.");
      let current = await loadBundle(dir);
      await workspace.change(current.revision, "Agent changes title", (d) => {
        d.project.title = "Agent title";
      });
      await until(
        async () =>
          (await loadBundle(dir)).narration.segments[0]!.text ===
          "My local draft.",
      );
      // Race a field against the same field: preserve the human's draft and
      // agent's file text until the human explicitly chooses a version.
      await script.fill("Human version.");
      current = await loadBundle(dir);
      await workspace.change(current.revision, "Agent changes script", (d) => {
        d.narration.segments[0]!.text = "Agent version.";
      });
      await page.locator(".segment-conflict:not([hidden])").waitFor();
      expect(await script.inputValue()).toBe("Human version.");
      expect((await loadBundle(dir)).narration.segments[0]!.text).toBe(
        "Agent version.",
      );
      await page.getByRole("button", { name: "Keep my changes" }).click();
      await until(
        async () =>
          (await loadBundle(dir)).narration.segments[0]!.text ===
          "Human version.",
      );
      const command = await workspace.focus(heading.ref, 0);
      await until(
        async () =>
          (await workspace.previewState())?.acknowledgedCommand ===
          command.command.id,
      );
      const stateBefore = await readFile(
        path.join(dir, "preview-state.json"),
        "utf8",
      );
      // Stop the foreground page's polling so screenshot read-only behavior can
      // be checked independently of its periodic playhead publications.
      await page.close();
      const frame = await renderReplayFrame(dir, { outputMs: 0 });
      expect(frame.bytes.subarray(1, 4).toString()).toBe("PNG");
      const rendered = await openReplayRenderer(dir);
      try {
        const first = await rendered.frame(0);
        expect(
          await rendered.page
            .frameLocator("iframe")
            .locator("h1")
            .textContent(),
        ).toBe("Original heading");
        const last = await rendered.frame(
          totalDuration((await loadBundle(dir)).edits),
        );
        expect(
          await rendered.page
            .frameLocator("iframe")
            .locator("h1")
            .textContent(),
        ).toBe("Second document");
        expect(first.equals(last)).toBe(false);
      } finally {
        await rendered.close();
      }

      expect(await readFile(path.join(dir, "preview-state.json"), "utf8")).toBe(
        stateBefore,
      );
      expect(errors).toEqual([]);
      const short = await loadBundle(dir);
      short.edits.clips = [
        {
          id: short.edits.clips[0]!.id,
          sourceStartMs: 0,
          sourceEndMs: Math.min(200, short.project.durationMs),
          rate: 1,
          holdMs: 0,
        },
      ];
      short.narration.segments[0]!.clipId = short.edits.clips[0]!.id;
      short.narration.segments[0]!.offsetMs = 0;
      await writeJson(path.join(dir, "edits.json"), short.edits);
      await writeJson(path.join(dir, "narration.json"), short.narration);
      await expect(
        exportReplay(dir, path.join(root, "missing-audio"), {
          fps: 5,
          strictAudio: true,
        }),
      ).rejects.toThrow("draft or stale");
      await mkdir(path.join(dir, "audio"));
      await writeFile(path.join(dir, "audio/voice.wav"), wavBytes());
      const segment = short.narration.segments[0]!;
      segment.audio = {
        path: "audio/voice.wav",
        durationMs: 250,
        cacheKey: "test-audio",
        requestKey: narrationRequestKey(short.project, segment),
      };
      await writeJson(path.join(dir, "narration.json"), short.narration);
      const exported = await exportReplay(dir, path.join(root, "export"), {
        fps: 5,
        strictAudio: true,
      });
      const video = await readFile(path.join(root, "export/video.mp4"));
      expect(video.subarray(4, 8).toString()).toBe("ftyp");
      expect(exported.files.find((f) => f.path === "video.mp4")!.sha256).toBe(
        createHash("sha256").update(video).digest("hex"),
      );
      expect(exported.omittedAudio).toEqual([]);
      const probe = Bun.spawn(
        [
          "ffprobe",
          "-v",
          "error",
          "-show_entries",
          "stream=codec_type,width,height",
          "-of",
          "json",
          path.join(root, "export/video.mp4"),
        ],
        { stdout: "pipe" },
      );
      const probed = JSON.parse(
        await new Response(probe.stdout).text(),
      ).streams;
      expect(probed.map((s: any) => s.codec_type).sort()).toEqual([
        "audio",
        "video",
      ]);
      expect(probed.find((s: any) => s.codec_type === "video").width).toBe(
        short.project.viewport.width + (short.project.viewport.width % 2),
      );
      expect(probed.find((s: any) => s.codec_type === "video").height).toBe(
        short.project.viewport.height + (short.project.viewport.height % 2),
      );
      expect(await probe.exited).toBe(0);
      await expect(
        exportReplay(dir, path.join(root, "export"), { fps: 5 }),
      ).rejects.toThrow("already exists");
      const exporter = await browser.newPage();
      await exporter.goto(preview.url);
      await exporter.waitForFunction(
        () => (window as any).__replayLab?.state().ready,
      );
      await exporter.locator("#export-open").click();
      await exporter.locator("#export-start").click();
      await until(async () => {
        const status = await fetch(preview.url + "/api/status").then((r) =>
          r.json(),
        );
        if (status.export.error) throw new Error(status.export.error);
        return !!status.export.directory;
      });
      await exporter.locator("#export-downloads:not([hidden])").waitFor();
      const download = await fetch(
        preview.url + "/api/export/download/video.mp4",
      );
      expect(download.status).toBe(200);
      expect(download.headers.get("Content-Type")).toBe("video/mp4");
      await exporter.close();
      const library = await serveLibrary(root, { port: 0 });
      const client = new Client({ name: "Browser test agent", version: "1" });
      try {
        const catalog = await fetch(library.url + "/api/library").then((r) =>
          r.json(),
        );
        const record = catalog.recordings.find(
          (r: any) => r.path === "capture",
        );
        const scoped = await browser.newPage();
        await scoped.goto(`${library.url}/projects/${record.id}/`);
        await scoped.waitForFunction(
          () => (window as any).__replayLab?.state().ready,
        );
        expect(
          await scoped.frameLocator("iframe").locator("h1").textContent(),
        ).toBe("Original heading");
        expect(
          await scoped
            .frameLocator("iframe")
            .locator("body")
            .evaluate((n) => getComputedStyle(n).backgroundImage),
        ).toContain(`/projects/${record.id}/files/assets/`);
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [path.resolve(import.meta.dir, "cli.ts"), "mcp", dir],
            stderr: "pipe",
          }),
        );
        const beforePosition = await scoped.evaluate(
          () => (window as any).__replayLab.state().position,
        );
        await client.callTool({
          name: "get_html",
          arguments: { elementRef: heading.ref },
        });
        await scoped.locator("#agent-activity:not([hidden])").waitFor();
        expect(
          await scoped.locator(".agent-activity-label").textContent(),
        ).toContain("Browser test agent");
        expect(
          await scoped.evaluate(
            () => (window as any).__replayLab.state().position,
          ),
        ).toBe(beforePosition);
        const resolved = await client.callTool({
          name: "resolve_reference",
          arguments: { reference: copied.reference },
        });
        expect(resolved.isError).not.toBe(true);
        expect(JSON.parse((resolved.content as any)[0].text).threadId).toBe(
          copied.comment.id,
        );
        // Project links survive a fresh load and select the exact comment.
        const scopedCommentLink = `${library.url}/projects/${record.id}/${new URL(copied.preview).hash}`;
        await scoped.goto(scopedCommentLink);
        await scoped.locator(".comment-card.active:not([hidden])").waitFor();
        expect(
          await scoped.locator(".comment-card.active").getAttribute("data-id"),
        ).toBe(copied.comment.id);
        const currentEdit = await loadBundle(dir);
        const change = await client.callTool({
          name: "apply_element_edit",
          arguments: {
            expectedRevision: currentEdit.revision,
            elementRef: heading.ref,
            text: "A clearer heading",
          },
        });
        expect(change.isError).not.toBe(true);
        await until(
          async () =>
            (await scoped
              .frameLocator("iframe")
              .locator("h1")
              .textContent()) === "A clearer heading",
        );
        // The Agent panel groups the session's changes into an undoable turn.
        await scoped.locator('[data-tab="agent"]').click();
        await scoped
          .locator("#review-list .turn .change-row")
          .first()
          .waitFor();
        await scoped
          .locator("#review-list .turn")
          .first()
          .getByRole("button", { name: "Undo turn" })
          .waitFor();
        const now = await loadBundle(dir);
        await client.callTool({
          name: "reply_to_comment",
          arguments: {
            expectedRevision: now.revision,
            threadId: copied.comment.id,
            reply: "Updated the heading and checked the preview.",
          },
        });
        await scoped.locator('[data-tab="comments"]').click();
        await until(async () =>
          (await scoped.locator(".comment-replies").textContent())!.includes(
            "Updated the heading",
          ),
        );
        expect(await scoped.locator(".comment-copy").isVisible()).toBe(true);
        await client.callTool({
          name: "set_comment_status",
          arguments: {
            expectedRevision: (await loadBundle(dir)).revision,
            threadId: copied.comment.id,
            status: "resolved",
          },
        });
        await until(
          async () =>
            (await loadBundle(dir)).comments.threads[0]!.status === "resolved",
        );
        expect(
          await scoped.evaluate(
            () => (window as any).__replayLab.state().position,
          ),
        ).toBe(beforePosition);
        await scoped.reload();
        await scoped
          .locator(".comment-card.resolved.active:not([hidden])")
          .waitFor();
        expect(await scoped.locator(".comment-copy").isVisible()).toBe(true);
        expect(await scoped.locator(".comment-link").isVisible()).toBe(true);
        // A resolved timeline pin opens the thread from another panel.
        await scoped.locator('[data-tab="narration"]').click();
        await scoped.locator("#notes-track .note-mark").click();
        expect(await scoped.locator("#panel-comments").isVisible()).toBe(true);
        await scoped.setViewportSize({ width: 390, height: 844 });
        expect(
          await scoped.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await scoped.getByRole("link", { name: "Back to library" }).click();
        await scoped.waitForURL(library.url + "/");
        await scoped.locator(".recording-card").first().waitFor();
        await scoped.close();
      } finally {
        await client.close();
        await library.close();
      }
    } finally {
      await browser.close();
      await preview.close();
    }
  } finally {
    app.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
