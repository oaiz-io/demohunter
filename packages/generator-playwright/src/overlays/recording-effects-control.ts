import type { RecordConfig } from "@demohunter/sdk";
import type { Locator, Page } from "playwright";

export type RecordingEffectsState = {
  cursorEnabled: boolean;
  rippleEnabled: boolean;
};

type RecordingEffectsRecordConfig = Pick<
  RecordConfig,
  "cursor" | "showCursor" | "showClickRipple"
>;

export function resolveRecordingEffectsState(
  record: RecordingEffectsRecordConfig,
): RecordingEffectsState {
  if (record.cursor === false) {
    return { cursorEnabled: false, rippleEnabled: false };
  }

  return {
    cursorEnabled: record.cursor === undefined ? (record.showCursor ?? true) : true,
    rippleEnabled: typeof record.cursor === "object"
      ? record.cursor.ripple
      : (record.showClickRipple ?? true),
  };
}

export function createDeterministicRecordingClickHandler(
  page: Page,
  record: RecordingEffectsRecordConfig,
): (
  target: Locator,
  options: Parameters<Locator["click"]>[0],
  destination: { x: number; y: number },
) => Promise<void> {
  const restoredState = resolveRecordingEffectsState(record);

  return async (target, options, destination): Promise<void> => {
    await prepareDeterministicClick(page, restoredState, destination);

    try {
      await target.click(options);
    } finally {
      await setRecordingEffectsEnabled(
        page,
        restoredState.cursorEnabled,
        restoredState.rippleEnabled,
      );
    }
  };
}

export async function setRecordingEffectsEnabled(
  page: Page,
  cursorEnabled: boolean,
  rippleEnabled: boolean,
): Promise<void> {
  await Promise.all(page.frames().map(async (frame) => {
    try {
      await frame.evaluate(
        ([showCursor, showRipple]) => {
          window.__demohunterEffects?.setCursorEnabled(showCursor);
          window.__demohunterEffects?.setRippleEnabled(showRipple);
        },
        [cursorEnabled, rippleEnabled] as const,
      );
    } catch {
      // Clicks and consent actions can detach or navigate frames. The init script
      // restores configured effects in each next document.
    }
  }));
}

async function prepareDeterministicClick(
  page: Page,
  restoredState: RecordingEffectsState,
  destination: { x: number; y: number },
): Promise<void> {
  const mainFrame = page.mainFrame();

  await Promise.all(page.frames().map(async (frame) => {
    const isMainFrame = frame === mainFrame;

    try {
      await frame.evaluate(
        ({ cursorEnabled, rippleEnabled, showInThisFrame, x, y }) => {
          const effects = window.__demohunterEffects;
          if (effects === undefined) {
            return;
          }

          effects.setCursorEnabled(showInThisFrame && cursorEnabled);
          effects.setRippleEnabled(showInThisFrame && rippleEnabled);
          if (showInThisFrame && rippleEnabled) {
            effects.showRipple(x, y);
          }
          // The explicit top-frame ripple above is authoritative. Suppress the
          // native click event in every frame so it cannot create a duplicate.
          effects.setRippleEnabled(false);
        },
        {
          cursorEnabled: restoredState.cursorEnabled,
          rippleEnabled: restoredState.rippleEnabled,
          showInThisFrame: isMainFrame,
          x: destination.x,
          y: destination.y,
        },
      );
    } catch {
      // A target frame may detach between bounding-box measurement and click.
      // Let Playwright's click surface the actionable target error if necessary.
    }
  }));
}
