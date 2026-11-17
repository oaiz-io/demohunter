import { expect, test } from "bun:test";
import { cameraPose, type CameraWindow } from "./timeline-math.js";

type Window = CameraWindow & { x: number; y: number };
const centre = (w: Window) => ({ x: w.x, y: w.y });
const a: Window = { startMs: 1000, endMs: 3000, scale: 2, x: 400, y: 300, easeMs: 500 };

test("one window eases in from the full frame and back out", () => {
  expect(cameraPose([a], 500, centre)).toBeUndefined();
  expect(cameraPose([a], 1000, centre)).toEqual({ scale: 1, x: 400, y: 300 });
  expect(cameraPose([a], 1250, centre)!.scale).toBeCloseTo(1.5);
  expect(cameraPose([a], 2000, centre)).toEqual({ scale: 2, x: 400, y: 300 });
  expect(cameraPose([a], 2750, centre)!.scale).toBeCloseTo(1.5);
  expect(cameraPose([a], 3000, centre)).toBeUndefined();
});

test("two windows in a row travel pose to pose and never dip to the full frame", () => {
  const b: Window = { startMs: 3000, endMs: 5000, scale: 3, x: 1200, y: 700, easeMs: 400 };
  // The first window holds its pose to its end: no ease out before a neighbour.
  expect(cameraPose([a, b], 2900, centre)).toEqual({ scale: 2, x: 400, y: 300 });
  // The second starts at the first one's pose and moves to its own.
  expect(cameraPose([a, b], 3000, centre)).toEqual({ scale: 2, x: 400, y: 300 });
  const mid = cameraPose([a, b], 3200, centre)!;
  expect(mid.scale).toBeCloseTo(2.5);
  expect(mid.x).toBeCloseTo(800);
  expect(mid.y).toBeCloseTo(500);
  expect(cameraPose([a, b], 3400, centre)).toEqual({ scale: 3, x: 1200, y: 700 });
  for (let t = 1500; t < 4600; t += 50) expect(cameraPose([a, b], t, centre)!.scale).toBeGreaterThanOrEqual(2);
  // The last window still eases out to the full frame.
  expect(cameraPose([a, b], 4800, centre)!.scale).toBeCloseTo(2);
});

test("windows with a gap between them keep their own ease in and out", () => {
  const b: Window = { startMs: 3500, endMs: 5000, scale: 3, x: 1200, y: 700, easeMs: 400 };
  expect(cameraPose([a, b], 2750, centre)!.scale).toBeCloseTo(1.5);
  expect(cameraPose([a, b], 3200, centre)).toBeUndefined();
  expect(cameraPose([a, b], 3500, centre)).toEqual({ scale: 1, x: 1200, y: 700 });
});

test("easeMs 0 arrives framed", () => {
  const cut: Window = { startMs: 0, endMs: 2000, scale: 2.4, x: 500, y: 500, easeMs: 0 };
  expect(cameraPose([cut], 1, centre)).toEqual({ scale: 2.4, x: 500, y: 500 });
});
