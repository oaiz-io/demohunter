import type { CookieBannerConfig, CookieDismissAction, RecordConfig } from "@demohunter/sdk";
import type { Frame, Locator, Page } from "playwright";

import {
  resolveRecordingEffectsState,
  setRecordingEffectsEnabled,
} from "../overlays/recording-effects-control.js";

export type CookieBannerRule = {
  id: string;
  containerSelectors: readonly string[];
  rejectSelectors?: readonly string[];
  acceptSelectors?: readonly string[];
  dismissSelectors?: readonly string[];
  backdropSelectors?: readonly string[];
};

export type CookieBannerDismissal = {
  action: CookieDismissAction;
  ruleId: string;
  selector: string;
};

export type CookieBannerMiddleware = {
  afterSetup(page: Page): Promise<CookieBannerDismissal | undefined>;
  afterNavigation(page: Page): Promise<CookieBannerDismissal | undefined>;
};

export const COOKIE_BANNER_RULESET_VERSION = 1;
const COOKIE_BANNER_ACTION_TIMEOUT_MS = 250;

/**
 * Built-in selectors are deliberately scoped to recognizable vendor containers. Broad text
 * selectors such as `button:has-text("Accept")` are intentionally excluded because they can
 * activate unrelated application UI.
 */
export const COOKIE_BANNER_RULES: readonly CookieBannerRule[] = [
  {
    id: "onetrust-v1",
    containerSelectors: ["#onetrust-banner-sdk"],
    rejectSelectors: ["#onetrust-reject-all-handler"],
    acceptSelectors: ["#onetrust-accept-btn-handler"],
    dismissSelectors: ["#onetrust-close-btn-container button", ".onetrust-close-btn-handler"],
    backdropSelectors: [".onetrust-pc-dark-filter"],
  },
  {
    id: "cookiebot-v1",
    containerSelectors: ["#CybotCookiebotDialog"],
    rejectSelectors: ["#CybotCookiebotDialogBodyButtonDecline"],
    acceptSelectors: ["#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll"],
  },
  {
    id: "didomi-v1",
    containerSelectors: ["#didomi-host", ".didomi-popup-container"],
    rejectSelectors: ["[data-testid='notice-disagree-button']"],
    acceptSelectors: ["[data-testid='notice-agree-button']"],
    dismissSelectors: ["[data-testid='notice-dismiss-button']", "button[aria-label='Close']"],
    backdropSelectors: [".didomi-popup-backdrop"],
  },
  {
    id: "trustarc-v1",
    containerSelectors: ["#truste-consent-track", ".truste_box_overlay"],
    rejectSelectors: [".declineAll"],
    acceptSelectors: [".acceptAll"],
    dismissSelectors: [".close", ".truste_close"],
    backdropSelectors: [".truste_overlay"],
  },
  {
    id: "quantcast-v1",
    containerSelectors: [".qc-cmp2-container"],
    rejectSelectors: ["button[mode='secondary']"],
    acceptSelectors: ["button[mode='primary']"],
    dismissSelectors: [".qc-cmp2-close-icon"],
    backdropSelectors: [".qc-cmp2-ui-bg"],
  },
] as const;

export function createCookieBannerMiddleware(input: {
  config: CookieBannerConfig;
  suppressActivity?: <T>(action: () => Promise<T>) => Promise<T>;
}): CookieBannerMiddleware {
  const run = (page: Page) => dismissCookieBanner(page, input.config, {
    suppressActivity: input.suppressActivity,
  });

  return {
    afterSetup: run,
    afterNavigation: run,
  };
}

export async function dismissCookieBanner(
  page: Page,
  config: CookieBannerConfig,
  options: {
    now?: () => number;
    rules?: readonly CookieBannerRule[];
    suppressActivity?: <T>(action: () => Promise<T>) => Promise<T>;
  } = {},
): Promise<CookieBannerDismissal | undefined> {
  if (!config.enabled) {
    return undefined;
  }

  const now = options.now ?? Date.now;
  const deadline = now() + Math.max(0, config.timeoutMs);
  const rules = options.rules ?? COOKIE_BANNER_RULES;

  do {
    const actionDeadline = now() + COOKIE_BANNER_ACTION_TIMEOUT_MS;
    const actionTimeoutMs = () => Math.max(1, actionDeadline - now());
    const dismissal = await scanFrames(
      page.frames(),
      config.action,
      rules,
      actionTimeoutMs,
      options.suppressActivity,
    );

    if (dismissal !== undefined) {
      return dismissal;
    }

    const customDismissal = await scanAdditionalSelectors(
      page.frames(),
      config.action,
      config.additionalSelectors,
      actionTimeoutMs,
      options.suppressActivity,
    );

    if (customDismissal !== undefined) {
      return customDismissal;
    }

    const remainingMs = deadline - now();

    if (remainingMs <= 0) {
      break;
    }

    await page.waitForTimeout(Math.min(50, remainingMs));
  } while (now() <= deadline);

  return undefined;
}

export function createRecordingEffectsSuppressor(
  page: Page,
  record: Pick<RecordConfig, "cursor" | "showCursor" | "showClickRipple">,
): <T>(action: () => Promise<T>) => Promise<T> {
  const restoredState = resolveRecordingEffectsState(record);

  return async <T>(action: () => Promise<T>): Promise<T> => {
    await setRecordingEffectsEnabled(page, false, false);

    try {
      return await action();
    } finally {
      await setRecordingEffectsEnabled(
        page,
        restoredState.cursorEnabled,
        restoredState.rippleEnabled,
      );
    }
  };
}

async function scanFrames(
  frames: readonly Frame[],
  action: CookieDismissAction,
  rules: readonly CookieBannerRule[],
  actionTimeoutMs: () => number,
  suppressActivity?: <T>(action: () => Promise<T>) => Promise<T>,
): Promise<CookieBannerDismissal | undefined> {
  for (const frame of frames) {
    for (const rule of rules) {
      for (const containerSelector of rule.containerSelectors) {
        const container = frame.locator(containerSelector).first();

        if (!(await isVisible(container))) {
          continue;
        }

        if (action === "hide") {
          await runSuppressed(suppressActivity, async () => {
            await hideVendorElements(frame, [containerSelector, ...(rule.backdropSelectors ?? [])]);
          });
          return { action, ruleId: rule.id, selector: containerSelector };
        }

        const actionSelectors = action === "reject" ? rule.rejectSelectors : rule.acceptSelectors;
        const clickedSelector = await clickFirstVisible(
          container,
          [...(actionSelectors ?? []), ...(rule.dismissSelectors ?? [])],
          actionTimeoutMs,
          suppressActivity,
        );

        if (clickedSelector !== undefined) {
          return { action, ruleId: rule.id, selector: clickedSelector };
        }
      }
    }
  }

  return undefined;
}

async function scanAdditionalSelectors(
  frames: readonly Frame[],
  action: CookieDismissAction,
  selectors: readonly string[],
  actionTimeoutMs: () => number,
  suppressActivity?: <T>(action: () => Promise<T>) => Promise<T>,
): Promise<CookieBannerDismissal | undefined> {
  for (const frame of frames) {
    for (const selector of selectors) {
      const locator = frame.locator(selector).first();

      if (!(await isVisible(locator))) {
        continue;
      }

      try {
        if (action === "hide") {
          await runSuppressed(suppressActivity, () => locator.evaluate(
            (element) => element.remove(),
            { timeout: actionTimeoutMs() },
          ));
        } else {
          await runSuppressed(suppressActivity, () => locator.click({ timeout: actionTimeoutMs() }));
        }
      } catch {
        continue;
      }

      return { action, ruleId: "user-additional-selector", selector };
    }
  }

  return undefined;
}

async function clickFirstVisible(
  container: Locator,
  selectors: readonly string[],
  actionTimeoutMs: () => number,
  suppressActivity?: <T>(action: () => Promise<T>) => Promise<T>,
): Promise<string | undefined> {
  for (const selector of selectors) {
    // Some vendor rules necessarily use generic selectors. Resolve them only
    // beneath the recognized container so consent automation cannot activate
    // an unrelated application control elsewhere in the frame.
    const locator = container.locator(selector).first();

    if (!(await isVisible(locator))) {
      continue;
    }

    try {
      await runSuppressed(suppressActivity, () => locator.click({ timeout: actionTimeoutMs() }));
      return selector;
    } catch {
      // The banner may detach or navigate while it is being inspected; continue to the next
      // vendor-scoped selector rather than failing the authored tour preparation.
    }
  }

  return undefined;
}

async function isVisible(locator: Locator): Promise<boolean> {
  try {
    return await locator.isVisible();
  } catch {
    return false;
  }
}

async function hideVendorElements(frame: Frame, selectors: readonly string[]): Promise<void> {
  await frame.evaluate((selectorsToRemove) => {
    for (const selector of selectorsToRemove) {
      for (const element of document.querySelectorAll(selector)) {
        element.remove();
      }
    }
  }, selectors);
}

async function runSuppressed<T>(
  suppressActivity: (<TResult>(action: () => Promise<TResult>) => Promise<TResult>) | undefined,
  action: () => Promise<T>,
): Promise<T> {
  return suppressActivity === undefined ? action() : suppressActivity(action);
}
