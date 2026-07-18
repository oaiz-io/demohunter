import { afterEach, describe, expect, test } from "bun:test";

import { DEFAULT_RECORD_CONFIG } from "@demohunter/sdk";
import { chromium, type Browser } from "playwright";

import { installRecordingEffectsRuntime } from "./recording-effects-runtime.js";
import { createDeterministicRecordingClickHandler } from "./recording-effects-control.js";

let browser: Browser | undefined;

afterEach(async () => {
  await browser?.close();
  browser = undefined;
});

describe("createDeterministicRecordingClickHandler", () => {
  test("renders one top-frame cursor and ripple when clicking inside an iframe", async () => {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.addInitScript(installRecordingEffectsRuntime, {
      showClickRipple: true,
      showCursor: true,
    });
    const page = await context.newPage();
    await page.goto(
      'data:text/html,<style>iframe{margin:100px;width:300px;height:200px}</style><iframe srcdoc="<button style=margin:50px>Inside</button>"></iframe>',
    );
    const button = page.locator("iframe").contentFrame().getByRole("button");
    const box = await button.boundingBox();
    if (box === null) {
      throw new Error("Expected the iframe button to have a bounding box");
    }
    const destination = {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    };

    await page.evaluate(async ({ x, y }) => {
      await window.__demohunterEffects?.moveCursorTo(x, y, 0);
    }, destination);
    await createDeterministicRecordingClickHandler(page, DEFAULT_RECORD_CONFIG)(
      button,
      {},
      destination,
    );

    const [mainFrame, childFrame] = page.frames();
    if (mainFrame === undefined || childFrame === undefined) {
      throw new Error("Expected a main frame and one child frame");
    }
    expect(await mainFrame.locator("#demohunter-cursor").getAttribute("style")).toContain("display: block");
    expect(await mainFrame.locator(".demohunter-click-ripple").count()).toBe(1);
    expect(await childFrame.locator("#demohunter-cursor").getAttribute("style")).toContain("display: none");
    expect(await childFrame.locator(".demohunter-click-ripple").count()).toBe(0);
  });
});
