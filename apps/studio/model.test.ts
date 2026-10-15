import { describe, expect, test } from "bun:test";
import {
  audioIsCurrent,
  narrationRequestKey,
  narrationStart,
  outputToSource,
  totalDuration,
  validateBundle,
} from "./model.js";
import { fixture } from "./test-support.js";

describe("editable replay time model", () => {
  test("cuts skip visible time while speed and holds map to the correct source state", () => {
    const { edits } = fixture();
    expect(totalDuration(edits)).toBe(2500);
    expect(outputToSource(edits, 500)).toBe(500);
    expect(outputToSource(edits, 1000)).toBe(3000);
    expect(outputToSource(edits, 1250)).toBe(3500);
    expect(outputToSource(edits, 1900)).toBe(4000);
    expect(outputToSource(edits, 2500)).toBe(4000);
  });
  test("narration follows a clip when it is reordered or its preceding clip is held", () => {
    const { edits, narration } = fixture();
    const segment = narration.segments[0]!;
    expect(narrationStart(edits, segment)).toBe(1100);
    edits.clips[0]!.holdMs = 700;
    expect(narrationStart(edits, segment)).toBe(1800);
    edits.clips.reverse();
    expect(narrationStart(edits, segment)).toBe(100);
    edits.clips.shift();
    expect(narrationStart(edits, segment)).toBeUndefined();
  });
  test("text or voice changes invalidate speech but camera and timing edits do not", () => {
    const { project, narration, edits } = fixture();
    const segment = narration.segments[0]!;
    segment.audio = {
      path: "audio/voice.wav",
      durationMs: 250,
      cacheKey: "cache",
      requestKey: narrationRequestKey(project, segment),
    };
    expect(audioIsCurrent(project, segment)).toBe(true);
    edits.clips[0]!.holdMs = 1000;
    expect(audioIsCurrent(project, segment)).toBe(true);
    segment.text += " Changed.";
    expect(audioIsCurrent(project, segment)).toBe(false);
    segment.audio.requestKey = narrationRequestKey(project, segment);
    project.tts.voice = "another-voice";
    expect(audioIsCurrent(project, segment)).toBe(false);
  });
  test("rejects invalid targets, duplicate IDs, non-finite timing and out-of-capture clips", () => {
    const data = fixture();
    data.edits.clips[0]!.sourceEndMs = 5000;
    expect(() => validateBundle(data)).toThrow("captured duration");
    const duplicate = fixture();
    duplicate.edits.clips[1]!.id = "a";
    expect(() => validateBundle(duplicate)).toThrow("Duplicate");
    const invalid = fixture();
    invalid.edits.elements.push({
      id: "bad",
      target: { nodeId: 1, selector: "h1" },
    });
    expect(() => validateBundle(invalid)).toThrow("exactly one");
    const nan = fixture();
    nan.edits.clips[0]!.rate = NaN;
    expect(() => validateBundle(nan)).toThrow();
  });
});
