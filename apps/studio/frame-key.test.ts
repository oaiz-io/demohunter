import { expect, test } from "bun:test";
import { elementSpans, frameKey } from "./frame-key.js";
import { fixture } from "./test-support.js";

// Clips: a = source 0–1000 (output 0–1000), b = source 3000–4000 at rate 2
// with a 1000 ms hold (output 1000–2500).
const spans = elementSpans({
  elements: [
    { ref: "early", documentId: 1, nodeId: 2, firstSeenMs: 0, lastSeenMs: 900 },
    { ref: "late", documentId: 1, nodeId: 3, firstSeenMs: 3000 },
  ],
});
const key = (bundle: ReturnType<typeof fixture>, ms: number) =>
  frameKey(bundle, ms, { kind: "thumb", spans });

test("comments, narration and audio do not change a frame's key", () => {
  const a = fixture();
  const b = fixture();
  b.comments.threads.push({
    id: "t", timeMs: 0, body: "x", author: "y", status: "open", createdAt: "", updatedAt: "", replies: [],
  });
  b.narration.segments[0]!.text = "Changed text";
  b.edits.audio = { music: [], sfx: [{ id: "s", src: "audio/x.mp3", atMs: 10, volume: 1 }] };
  b.revision = "other";
  expect(key(b, 500)).toBe(key(a, 500));
});

test("an element edit changes only frames where its element is on the page", () => {
  const a = fixture();
  const b = fixture();
  b.edits.elements.push({ id: "e", target: { ref: "early" }, style: { color: "red" } });
  expect(key(b, 500)).not.toBe(key(a, 500)); // source 500: on the page
  expect(key(b, 1200)).toBe(key(a, 1200)); // source 3400: removed
  // A selector target cannot be placed in time: it counts everywhere.
  const c = fixture();
  c.edits.elements.push({ id: "e", target: { selector: "h1" }, hidden: true });
  expect(key(c, 1200)).not.toBe(key(a, 1200));
  // Without the element index, every element edit counts.
  expect(frameKey(b, 1200, { kind: "thumb" })).not.toBe(frameKey(a, 1200, { kind: "thumb" }));
});

test("time-ranged effects count only near their time, and keys move with trims", () => {
  const a = fixture();
  const b = fixture();
  b.edits.highlights.push({ id: "h", startMs: 100, endMs: 300, target: { ref: "early" }, color: "#fff", padding: 8 });
  expect(key(b, 200)).not.toBe(key(a, 200));
  expect(key(b, 2400)).toBe(key(a, 2400));
  // CSS and the viewport change every frame.
  const c = fixture();
  c.css = "h1{color:blue}";
  expect(key(c, 2400)).not.toBe(key(a, 2400));
  // The same source moment after a trim earlier in the film: same key.
  const d = fixture();
  d.edits.clips[0] = { ...d.edits.clips[0]!, sourceStartMs: 0, sourceEndMs: 500 } as never;
  expect(key(d, 700)).toBe(key(a, 1200));
});
