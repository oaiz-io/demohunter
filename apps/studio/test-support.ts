import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_TTS_CONFIG } from "@demohunter/sdk";
import { writeJson } from "./storage.js";
import { validateBundle, type ReplayBundle } from "./model.js";

export function fixture(): ReplayBundle {
  return validateBundle({
    project: {
      schemaVersion: 1,
      id: "test-replay",
      title: "Test replay",
      viewport: { width: 1120, height: 700 },
      durationMs: 4000,
      createdAt: new Date().toISOString(),
      tts: { ...DEFAULT_TTS_CONFIG, format: "wav" },
      capture: { eventCount: 1, assetCount: 0, warnings: [] },
    },
    edits: {
      clips: [
        { id: "a", sourceStartMs: 0, sourceEndMs: 1000, rate: 1, holdMs: 0 },
        {
          id: "b",
          sourceStartMs: 3000,
          sourceEndMs: 4000,
          rate: 2,
          holdMs: 1000,
        },
      ],
      elements: [],
      camera: [],
      highlights: [],
    },
    narration: {
      segments: [
        { id: "n1", clipId: "b", offsetMs: 100, text: "The same amount." },
      ],
    },
    css: "",
    revision: "fixture",
  });
}
export async function projectFixture(): Promise<{ root: string; dir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "demohunter-replay-"));
  const dir = path.join(root, "project");
  await mkdir(dir);
  const data = fixture();
  await Promise.all([
    writeJson(path.join(dir, "project.json"), data.project),
    writeJson(path.join(dir, "edits.json"), data.edits),
    writeJson(path.join(dir, "narration.json"), data.narration),
    writeJson(path.join(dir, "events.json"), []),
    writeFile(path.join(dir, "overrides.css"), ""),
  ]);
  return { root, dir };
}
export function wavBytes(): Buffer {
  const rate = 24000,
    samples = 6000;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    buffer.writeInt16LE(
      Math.round(Math.sin((i * 2 * Math.PI * 220) / rate) * 1000),
      44 + i * 2,
    );
  return buffer;
}
