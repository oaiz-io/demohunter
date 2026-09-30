import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import { browserLaunchOptions } from "@demohunter/generator-playwright";
import * as playwright from "playwright";

import { isPathInside, loadConfig } from "../config/load-config.js";
import { readGitIgnoreStatus } from "../config/session-file.js";

export type SessionCaptureInput = {
  startUrl: string;
  out?: string;
};

type SessionCaptureDependencies = {
  loadConfig: typeof loadConfig;
  log: (message: string) => void;
  playwright: Pick<typeof playwright, "chromium" | "firefox" | "webkit">;
  readGitIgnoreStatus: typeof readGitIgnoreStatus;
  /** Resolves true when the user presses Enter, false when stdin closes. */
  waitForEnter: () => Promise<boolean>;
};

const defaultDependencies: SessionCaptureDependencies = {
  loadConfig,
  log: console.log,
  playwright,
  readGitIgnoreStatus,
  waitForEnter,
};

/**
 * Opens a visible browser for the user to sign in by hand, then saves the
 * resulting Playwright storage state. DemoHunter never types into the page.
 */
export async function sessionCaptureCommand(
  cwd: string,
  input: SessionCaptureInput,
  dependencies: Partial<SessionCaptureDependencies> = {},
): Promise<void> {
  const resolvedDependencies = {
    ...defaultDependencies,
    ...dependencies,
  };
  const { config } = await resolvedDependencies.loadConfig(cwd);
  const startUrl = parseStartUrl(input.startUrl);
  const outPath = input.out === undefined ? config.session?.storageState : path.resolve(cwd, input.out);

  if (outPath === undefined) {
    throw new Error("Pass --out <path>, or set session.storageState in demohunter.config.ts.");
  }

  const displayPath = path.relative(cwd, outPath) || outPath;

  for (const [name, directory] of [["outputDir", config.outputDir], ["cacheDir", config.cacheDir]] as const) {
    if (isPathInside(outPath, directory)) {
      throw new Error(`Refusing to write the session inside ${name} (${directory}); generated output is meant to be shared.`);
    }
  }
  if (await resolvedDependencies.readGitIgnoreStatus(outPath) === "not-ignored") {
    throw new Error(
      `Refusing to write the session to ${displayPath}: it is inside a git work tree and not ignored. Add it to .gitignore or choose a path outside the repository.`,
    );
  }

  const browser = await resolvedDependencies.playwright[config.browser].launch({
    ...browserLaunchOptions(config),
    headless: false,
  });

  try {
    const context = await browser.newContext({
      viewport: null,
      ...(config.launch?.locale === undefined ? {} : { locale: config.launch.locale }),
      ...(config.launch?.timezoneId === undefined ? {} : { timezoneId: config.launch.timezoneId }),
    });
    const page = await context.newPage();
    await page.goto(startUrl);

    resolvedDependencies.log(`Opened ${startUrl} in a ${config.browser} window. Sign in there yourself; DemoHunter never sees what you type.`);
    resolvedDependencies.log(`When the app shows you signed in, press Enter here to save the session to ${displayPath}. Press Ctrl-C to cancel without saving.`);

    if (!await resolvedDependencies.waitForEnter()) {
      throw new Error("Session capture cancelled. Nothing was saved.");
    }

    const state = await context.storageState({ indexedDB: true });
    await writePrivateFile(outPath, `${JSON.stringify(state, null, 2)}\n`);
  } finally {
    await browser.close();
  }

  resolvedDependencies.log(
    `Saved the session to ${displayPath}, readable only by you. It is a credential: keep it out of version control, and sign it out in the app when you no longer need it.`,
  );
  if (outPath !== config.session?.storageState) {
    resolvedDependencies.log(`Load it with session.storageState in demohunter.config.ts or DEMOHUNTER_STORAGE_STATE=${displayPath}.`);
  }
}

function parseStartUrl(value: string): string {
  const url = URL.canParse(value) ? new URL(value) : undefined;

  if (url?.protocol !== "http:" && url?.protocol !== "https:") {
    throw new Error(`session capture needs an http(s) start URL, for example the app's sign-in page. Received: ${value}`);
  }

  return url.href;
}

// The file never exists with looser permissions, and a cancelled write leaves no partial file.
async function writePrivateFile(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.tmp`;

  try {
    await writeFile(tempPath, contents, { mode: 0o600 });
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

// Not a raw-mode terminal reader, so Ctrl-C still reaches Playwright's signal
// handler, which closes the browser before the process exits.
async function waitForEnter(): Promise<boolean> {
  const lines = createInterface({ input: process.stdin });

  try {
    return await new Promise<boolean>((resolve) => {
      lines.once("line", () => resolve(true));
      lines.once("close", () => resolve(false));
    });
  } finally {
    lines.close();
  }
}
