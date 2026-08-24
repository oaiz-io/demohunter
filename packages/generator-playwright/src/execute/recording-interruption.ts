import type { DebugPhase } from "../debug/failure-artifacts.js";

/**
 * Playwright installs its own SIGTERM and SIGHUP handlers that close every
 * browser it launched and then leave the process running. A recording that is
 * interrupted therefore does not stop: the step that happens to be in flight
 * finds its page gone and fails with Playwright's generic "Target page, context
 * or browser has been closed", which reads like a broken tour and leaves a
 * debug artifact that describes the wrong problem.
 *
 * DemoHunter closes the browser it launched only after the recording finishes,
 * so seeing that error mid-run means something outside the process closed it.
 * Naming that is the difference between rerunning with a longer time budget and
 * hunting an authoring bug that is not there.
 */
export class RecordingInterruptedError extends Error {
  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = "RecordingInterruptedError";
  }
}

const TARGET_CLOSED_MESSAGE = "Target page, context or browser has been closed";

const PHASE_DESCRIPTIONS: Record<DebugPhase, string> = {
  "collect-timeline": "collecting the timeline",
  "dry-run": "validating the tour",
  "record-replay": "recording the replay",
};

export function isTargetClosedError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(TARGET_CLOSED_MESSAGE);
}

/**
 * Rewrites a target-closed failure into an interruption, and returns every
 * other error untouched so real tour failures keep their own message.
 */
export function describeRecordingInterruption(error: unknown, phase: DebugPhase): unknown {
  if (!isTargetClosedError(error)) {
    return error;
  }

  return new RecordingInterruptedError(
    `The browser closed while DemoHunter was still ${PHASE_DESCRIPTIONS[phase]}.\n`
      + "  DemoHunter closes the browser only once a recording is finished, so this one was closed\n"
      + "  from outside the process: a command timeout, a Ctrl+C, or a shell that went away.\n"
      + "  Playwright closes the browsers it launched when the process is signalled but does not\n"
      + "  stop the process, so the run reports the step it was on instead of the interruption.\n"
      + "  A narrated walkthrough plays in real time. Rerun it with a time budget that covers the\n"
      + "  whole walkthrough, in the background if your runner enforces one.\n"
      + `  Original error: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}
