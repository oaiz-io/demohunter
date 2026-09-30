import type { ResolvedDemoHunterConfig } from "@demohunter/sdk";
import type { BrowserContextOptions } from "playwright";

/**
 * Options for every generation context. With a session, each pass loads the
 * same user-owned storage-state file, so both passes start from identical
 * client state instead of Pass 2 inheriting what Pass 1 changed.
 */
export function browserContextOptions(config: ResolvedDemoHunterConfig): BrowserContextOptions {
  return {
    baseURL: config.baseURL,
    viewport: config.viewport,
    ...(config.session === undefined ? {} : { storageState: config.session.storageState }),
  };
}
