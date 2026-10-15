import { randomUUID } from "node:crypto";
import { readFile, writeFile, link, unlink } from "node:fs/promises";
import path from "node:path";
import { formatSchema, type StudioFormat } from "./contract.js";
import type { ElementIndex } from "./elements.js";
export async function readFormat(dir: string): Promise<StudioFormat | null> {
  try {
    return formatSchema.parse(
      JSON.parse(await readFile(path.join(dir, "studio.json"), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(
      `Unsupported or invalid Studio format: ${error instanceof Error ? error.message : error}`,
    );
  }
}
export async function ensureFormat(
  dir: string,
  index: ElementIndex,
): Promise<StudioFormat> {
  const existing = await readFormat(dir);
  if (existing) {
    if (existing.captureId !== index.captureId)
      throw new Error("Studio manifest does not match this capture.");
    return existing;
  }
  const value: StudioFormat = {
    format: "demohunter.studio",
    formatVersion: 1,
    protocolVersion: 1,
    projectId: randomUUID(),
    captureId: index.captureId,
    createdAt: new Date().toISOString(),
    files: {
      project: "project.json",
      events: "events.json",
      elements: "elements.json",
      edits: "edits.json",
      narration: "narration.json",
      comments: "comments.json",
      css: "overrides.css",
    },
  };
  const manifest = path.join(dir, "studio.json"),
    temp = `${manifest}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n");
  try {
    await link(temp, manifest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return (await readFormat(dir))!;
  } finally {
    await unlink(temp);
  }
  return value;
}
