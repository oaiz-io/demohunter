import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { chromium } from "playwright";

import {
  createCookieBannerMiddleware,
  dismissCookieBanner,
} from "./cookie-banner-middleware.js";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});

afterAll(async () => {
  await browser?.close();
});

describe("cookie banner middleware", () => {
  test("rejects a OneTrust banner using only vendor-scoped selectors", async () => {
    await page.setContent(`
      <div id="onetrust-banner-sdk">
        <button id="onetrust-reject-all-handler" onclick="this.closest('#onetrust-banner-sdk').remove()">Reject</button>
        <button id="onetrust-accept-btn-handler">Accept</button>
      </div>
    `);

    const result = await dismissCookieBanner(page, config("reject"));

    expect(result).toEqual({
      action: "reject",
      ruleId: "onetrust-v1",
      selector: "#onetrust-reject-all-handler",
    });
    expect(await page.locator("#onetrust-banner-sdk").count()).toBe(0);
  });

  test("accepts a Cookiebot banner when explicitly requested", async () => {
    await page.setContent(`
      <div id="CybotCookiebotDialog">
        <button id="CybotCookiebotDialogBodyButtonDecline">Reject</button>
        <button id="CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll" onclick="this.dataset.clicked='yes'">Accept</button>
      </div>
    `);

    const result = await dismissCookieBanner(page, config("accept"));

    expect(result?.ruleId).toBe("cookiebot-v1");
    expect(
      await page.locator("#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll").getAttribute("data-clicked"),
    ).toBe("yes");
  });

  test("waits a bounded interval for a delayed recognized banner", async () => {
    await page.setContent(`
      <script>
        setTimeout(() => {
          document.body.insertAdjacentHTML('beforeend', '<div id="onetrust-banner-sdk"><button id="onetrust-reject-all-handler" onclick="this.parentElement.remove()">Reject</button></div>');
        }, 40);
      </script>
    `);

    const result = await dismissCookieBanner(page, {
      ...config("reject"),
      timeoutMs: 250,
    });

    expect(result?.ruleId).toBe("onetrust-v1");
  });

  test("does not click an unrelated Accept button when no vendor banner exists", async () => {
    await page.setContent(`<button id="unrelated" onclick="this.dataset.clicked='yes'">Accept</button>`);

    const result = await dismissCookieBanner(page, {
      ...config("accept"),
      timeoutMs: 0,
    });

    expect(result).toBeUndefined();
    expect(await page.locator("#unrelated").getAttribute("data-clicked")).toBeNull();
  });

  test("does not use a generic vendor action selector outside its matched container", async () => {
    await page.setContent(`
      <div class="qc-cmp2-container">Consent banner without an action</div>
      <button id="application-secondary" mode="secondary" onclick="this.dataset.clicked='yes'">
        Cancel application change
      </button>
    `);

    const result = await dismissCookieBanner(page, {
      ...config("reject"),
      timeoutMs: 0,
    });

    expect(result).toBeUndefined();
    expect(await page.locator("#application-secondary").getAttribute("data-clicked")).toBeNull();
  });

  test("hide removes only the matched vendor container and backdrop", async () => {
    await page.setContent(`
      <div class="onetrust-pc-dark-filter"></div>
      <div id="onetrust-banner-sdk">Consent</div>
      <div id="app-modal">Application modal</div>
    `);

    await dismissCookieBanner(page, config("hide"));

    expect(await page.locator("#onetrust-banner-sdk").count()).toBe(0);
    expect(await page.locator(".onetrust-pc-dark-filter").count()).toBe(0);
    expect(await page.locator("#app-modal").count()).toBe(1);
  });

  test("ships disabled and does not inspect the page until opted in", async () => {
    const middleware = createCookieBannerMiddleware({
      config: {
        ...config("reject"),
        enabled: false,
      },
    });

    expect(await middleware.afterSetup({} as Page)).toBeUndefined();
    expect(await middleware.afterNavigation({} as Page)).toBeUndefined();
  });

  test("suppresses recording activity around automatic consent clicks", async () => {
    await page.setContent(`
      <div id="onetrust-banner-sdk">
        <button id="onetrust-reject-all-handler">Reject</button>
      </div>
    `);
    const order: string[] = [];

    await dismissCookieBanner(page, config("reject"), {
      suppressActivity: async (action) => {
        order.push("suppress");
        const result = await action();
        order.push("restore");
        return result;
      },
    });

    expect(order).toEqual(["suppress", "restore"]);
  });
});

function config(action: "reject" | "accept" | "hide") {
  return {
    enabled: true,
    action,
    timeoutMs: 100,
    additionalSelectors: [],
  } as const;
}
