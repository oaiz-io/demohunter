import { afterAll, beforeAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { serveLibrary } from "./library-server.js";
import { serveReplay } from "./server.js";
import { projectFixture } from "./test-support.js";
import { writeJson } from "./storage.js";
import { useAdapterScript } from "./agents.js";
import { restrictFolder } from "./trust.js";

// The Agents panel in a real (headless) browser, against the scripted agent.
const FAKE = path.join(import.meta.dir, "fixtures/fake-acp-agent.ts");
const SHOTS = process.env.DEMOHUNTER_SHOTS;
let browser: Browser;

beforeAll(async () => {
  useAdapterScript("claude", FAKE);
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
  useAdapterScript("claude", undefined);
});

const el = (id: number, tagName: string, childNodes: unknown[] = []) => ({ type: 2, id, tagName, attributes: {}, childNodes });
/** A one-page recording with a button to select. */
const recording = [
  { type: 4, timestamp: 1000, data: { href: "http://example.test", width: 1120, height: 700 } },
  {
    type: 2,
    timestamp: 1001,
    data: {
      initialOffset: { left: 0, top: 0 },
      node: {
        type: 0,
        id: 1,
        childNodes: [el(2, "html", [el(3, "head"), el(4, "body", [el(5, "button", [{ type: 3, id: 6, textContent: "Approve" }])])])],
      },
    },
  },
];

async function openStudio(restricted = false) {
  const { root, dir } = await projectFixture();
  await writeJson(path.join(dir, "events.json"), recording);
  if (restricted) restrictFolder(root);
  const app = await serveLibrary(root, { port: 0, restricted });
  const project = (await fetch(`${app.url}/api/library`).then((r) => r.json())).recordings[0].id;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${app.url}/projects/${project}/`);
  await page.waitForFunction(() => (window as any).__replayLab?.state().ready);
  await page.click('[data-tab="agent"]');
  await page.waitForSelector('.roster-pill[data-kind="claude"]');
  return {
    page,
    errors,
    async close() {
      await page.close();
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
const shot = (page: Page, name: string) =>
  SHOTS ? page.screenshot({ path: path.join(SHOTS, `${name}.png`) }) : undefined;
const ask = async (page: Page, text: string) => {
  await page.fill("#agent-input", text);
  await page.press("#agent-input", "Enter");
};

test("chat with the agent: context, replies, plan, tools, approvals and stop", async () => {
  const studio = await openStudio();
  const { page } = studio;
  try {
    expect(await page.textContent('.roster-pill[data-kind="claude"]')).toContain("start");
    await page.waitForSelector("#agent-chips .agent-chip");
    await shot(page, "agent-empty");

    // Typing starts the agent; Studio's view of the demo rides along.
    await ask(page, "Make a plan");
    await page.waitForSelector('.agent-msg.agent:has-text("Got: Demo:")');
    await page.waitForSelector(".agent-plan li.completed");
    await page.waitForSelector('.agent-tool.completed:has-text("DemoHunter · get basic info")');
    expect(await page.inputValue("#agent-input")).toBe("");
    expect(await page.textContent(".agent-msg.user")).toContain("Make a plan");
    expect(await page.textContent(".agent-msg.user .agent-chips")).toMatch(/^00:00\.\d$/);
    await page.waitForSelector('.roster-pill[data-status="idle"]');

    // Approvals show as a card; answering it resumes the turn.
    await ask(page, "needs permission");
    await page.waitForSelector(".agent-permission:not(.answered)");
    expect(await page.isHidden("#agent-dot")).toBe(false);
    await shot(page, "agent-permission");
    await page.click('.agent-permission button:has-text("Allow once")');
    await page.waitForSelector('.agent-permission.answered:has-text("Allowed — Allow once")');
    await page.waitForSelector('.agent-msg.agent:has-text("Permission: yes")');

    // A long turn can be stopped from the composer.
    await ask(page, "slow job");
    await page.waitForSelector("#agent-stop:not([hidden])");
    await page.click("#agent-stop");
    await page.waitForSelector('.agent-done:has-text("Stopped")');
    await page.waitForSelector("#agent-stop[hidden]", { state: "attached" });
    expect(studio.errors).toEqual([]);
  } finally {
    await studio.close();
  }
}, 60_000);

test("notes go to the agent by button, or by themselves when auto-send is on", async () => {
  const studio = await openStudio();
  const { page } = studio;
  try {
    await page.click('[data-tab="comments"]');
    await page.fill("#new-comment", "Zoom in on the button");
    await page.click("#add-comment");
    await page.click('.comment-send:has-text("Send to agent")');
    // Sending switches to the agent and shows the note as context.
    await page.waitForSelector('#panel-agent:not([hidden]) .agent-chip.note:has-text("Note: Zoom in on the button")');
    await page.waitForSelector('.roster-pill[data-status="idle"]');

    await page.check("#agent-autosend");
    await page.waitForFunction(async () => {
      const r = await fetch(`/api/agents?project=${location.pathname.split("/")[2]}`).then((r) => r.json());
      return r.settings.autoSendNotes === true;
    });
    await page.click('[data-tab="comments"]');
    await page.fill("#new-comment", "Slow the cursor down");
    await page.click("#add-comment");
    await page.click('[data-tab="agent"]');
    await page.waitForSelector('.agent-chip.note:has-text("Note: Slow the cursor down")');
    await shot(page, "agent-notes");
    expect(studio.errors).toEqual([]);
  } finally {
    await studio.close();
  }
}, 60_000);

test("an untrusted folder can't start an agent", async () => {
  const studio = await openStudio(true);
  const { page } = studio;
  try {
    expect(await page.isDisabled('.roster-pill[data-kind="claude"]')).toBe(true);
    expect(await page.isDisabled("#agent-input")).toBe(true);
    expect(await page.isVisible(".agent-empty-trust")).toBe(true);
    expect(studio.errors).toEqual([]);
  } finally {
    await studio.close();
  }
}, 60_000);

test("standalone Studio (one demo) shows outside agents' activity, no chat", async () => {
  const { root, dir } = await projectFixture();
  await writeJson(path.join(dir, "events.json"), recording);
  const app = await serveReplay(dir, { port: 0 });
  const page = await browser.newPage();
  try {
    await page.goto(app.url);
    await page.waitForFunction(() => (window as any).__replayLab?.state().ready);
    await page.click('[data-tab="agent"]');
    await page.waitForFunction(() => document.body.classList.contains("no-agent-chat"));
    expect(await page.isVisible("#agent-composer")).toBe(false);
    expect(await page.getAttribute("#agent-activity-details", "open")).toBe("");
    expect(await page.isVisible("#review-list")).toBe(true);
  } finally {
    await page.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
