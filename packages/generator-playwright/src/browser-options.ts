import type { ResolvedDemoHunterConfig } from "@demohunter/sdk";
import type { BrowserContextOptions, LaunchOptions } from "playwright";

/** Only the configured launch options; an empty config keeps Playwright's defaults. */
export function browserLaunchOptions(config: ResolvedDemoHunterConfig): LaunchOptions {
  const { channel, headless } = config.launch ?? {};

  return {
    ...(channel === undefined ? {} : { channel }),
    ...(headless === undefined ? {} : { headless }),
  };
}

/**
 * Options for every generation context. With a session, each pass loads the
 * same user-owned storage-state file, so both passes start from identical
 * client state instead of Pass 2 inheriting what Pass 1 changed.
 */
export function browserContextOptions(config: ResolvedDemoHunterConfig): BrowserContextOptions {
  const { locale, timezoneId } = config.launch ?? {};

  return {
    baseURL: config.baseURL,
    viewport: config.viewport,
    ...(config.session === undefined ? {} : { storageState: config.session.storageState }),
    ...(locale === undefined ? {} : { locale }),
    ...(timezoneId === undefined ? {} : { timezoneId }),
  };
}
