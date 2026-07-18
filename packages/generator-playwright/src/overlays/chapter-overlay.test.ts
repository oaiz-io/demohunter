import { afterEach, describe, expect, mock, test } from "bun:test";

import { showChapterOverlay } from "./chapter-overlay.js";

type OverlayEvaluate = (
  input: {
    durationMs: number;
    title: string;
    overlayId: string;
    overlayTimerKey: string;
  },
) => void;

class FakeElement {
  public attributes: Record<string, string> = {};
  public children: FakeElement[] = [];
  public dataset: Record<string, string> = {};
  public id = "";
  public parentNode: FakeElement | null = null;
  public style: Record<string, string> = {};
  public textContent = "";

  appendChild(child: FakeElement): FakeElement {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
}

class FakeDocument {
  public readonly body = new FakeElement();

  createElement(): FakeElement {
    return new FakeElement();
  }

  getElementById(id: string): FakeElement | null {
    return this.findById(this.body, id);
  }

  private findById(node: FakeElement, id: string): FakeElement | null {
    if (node.id === id) {
      return node;
    }

    for (const child of node.children) {
      const match = this.findById(child, id);

      if (match !== null) {
        return match;
      }
    }

    return null;
  }
}

const originalDocument = globalThis.document;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const CHAPTER_OVERLAY_TIMER_KEY = "__demohunterChapterOverlayHideTimer";

afterEach(() => {
  globalThis.document = originalDocument;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  delete (globalThis as typeof globalThis & Record<string, unknown>)[CHAPTER_OVERLAY_TIMER_KEY];
});

describe("showChapterOverlay", () => {
  test("renders a chapter label through Playwright page APIs", async () => {
    const evaluate = mock(async (callback: OverlayEvaluate, input: { durationMs: number; title: string; overlayId: string; overlayTimerKey: string }) => {
      const state = installOverlayGlobals();
      callback(input);

      const overlay = state.document.getElementById("demohunter-chapter-overlay");

      expect(overlay).not.toBeNull();
      expect(overlay?.textContent).toBe("Billing");
      expect(overlay?.style.opacity).toBe("1");
      expect(overlay?.style.position).toBe("fixed");
      expect(overlay?.attributes["data-demohunter-overlay"]).toBe("");
      expect(state.scheduled).toHaveLength(1);
    });

    await showChapterOverlay({ durationMs: 900, page: { evaluate } as never, title: "Billing" });

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0]?.[1]).toEqual({
      durationMs: 900,
      title: "Billing",
      overlayId: "demohunter-chapter-overlay",
      overlayTimerKey: "__demohunterChapterOverlayHideTimer",
    });
  });

  test("uses a short timeout to hide the overlay deterministically", async () => {
    const evaluate = mock(async (callback: OverlayEvaluate, input: { durationMs: number; title: string; overlayId: string; overlayTimerKey: string }) => {
      const state = installOverlayGlobals();
      callback(input);

      const overlay = state.document.getElementById("demohunter-chapter-overlay");

      expect(overlay?.style.opacity).toBe("1");
      expect(state.scheduled).toHaveLength(1);
      expect(state.scheduled[0]?.delay).toBe(600);

      state.scheduled[0]?.callback();

      expect(overlay?.style.opacity).toBe("0");
    });

    await showChapterOverlay({ durationMs: 600, page: { evaluate } as never, title: "Chapter 2" });
  });

  test("updates the existing overlay and resets the hide timer on subsequent calls", async () => {
    const pageState = installOverlayGlobals();
    const evaluate = mock(async (callback: OverlayEvaluate, input: { durationMs: number; title: string; overlayId: string; overlayTimerKey: string }) => {
      callback(input);
    });

    await showChapterOverlay({ durationMs: 400, page: { evaluate } as never, title: "Intro" });
    const overlay = pageState.document.getElementById("demohunter-chapter-overlay");
    const firstTimerId = pageState.scheduled[0]?.id;

    await showChapterOverlay({ durationMs: 250, page: { evaluate } as never, title: "Checkout" });

    expect(overlay).not.toBeNull();
    expect(overlay?.textContent).toBe("Checkout");
    expect(pageState.cleared).toEqual([firstTimerId]);
    expect(pageState.scheduled).toHaveLength(2);
    expect(pageState.scheduled[1]?.delay).toBe(250);
  });
});

function installOverlayGlobals() {
  const document = new FakeDocument();
  const scheduled: Array<{ callback: () => void; delay: number; id: number }> = [];
  const cleared: number[] = [];
  let nextId = 1;

  globalThis.document = document as never;
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    const id = nextId++;
    scheduled.push({ callback, delay: delay ?? 0, id });
    return id as never;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timeoutId: number) => {
    cleared.push(timeoutId);
  }) as typeof clearTimeout;

  return { cleared, document, scheduled };
}
