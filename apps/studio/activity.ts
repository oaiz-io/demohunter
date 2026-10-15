import { mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { activitySchema, type AgentActivity } from "./contract.js";
import { writeJson } from "./storage.js";
const labels: Record<string, string> = {
  get_selection: "Inspecting selection",
  get_html: "Reading captured HTML",
  get_node_info: "Inspecting element",
  get_computed_styles: "Reading element styles",
  apply_element_edit: "Editing element",
  animate_element: "Animating element",
  update_narration: "Editing narration",
  regenerate_narration: "Generating narration",
  add_comment: "Adding comment",
  reply_to_comment: "Replying to comment",
  set_comment_status: "Updating comment",
  get_screenshot: "Rendering a frame",
  find_elements: "Exploring elements",
  undo_last_edit: "Undoing an edit",
};
export async function beginActivity(
  dir: string,
  sessionId: string,
  actor: string,
  tool: string,
  input: unknown,
) {
  const args = input as {
    elementRef?: string;
    animation?: { target?: { ref?: string } };
    segment?: { id?: string };
    item?: { value?: { target?: { ref?: string } } };
  };
  const event: AgentActivity = {
    id: randomUUID(),
    sessionId,
    actor: actor.slice(0, 100),
    tool,
    label: labels[tool] ?? tool.replaceAll("_", " "),
    elementRef:
      args?.elementRef ??
      args?.animation?.target?.ref ??
      args?.item?.value?.target?.ref,
    segmentId: args?.segment?.id,
    startedAt: new Date().toISOString(),
    status: "running",
    updatedAt: new Date().toISOString(),
  };
  const folder = path.join(dir, ".studio/activity");
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, `${event.id}.json`);
  await writeJson(file, event);
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    event.updatedAt = new Date().toISOString();
    pending = pending.then(() => writeJson(file, event)).catch(() => {});
  }, 2500);
  timer.unref();
  return async (error?: unknown) => {
    clearInterval(timer);
    await pending;
    event.finishedAt = new Date().toISOString();
    event.status = error ? "failed" : "succeeded";
    if (error)
      event.error = (
        error instanceof Error ? error.message : String(error)
      ).slice(0, 500);
    await writeJson(file, event);
    await prune(folder);
  };
}
export async function readActivity(dir: string): Promise<AgentActivity[]> {
  const folder = path.join(dir, ".studio/activity");
  let names: string[];
  try {
    names = await readdir(folder);
  } catch {
    return [];
  }
  const events = (
    await Promise.all(
      names
        .filter((n) => /^[a-f0-9-]+\.json$/.test(n))
        .map(async (n) => {
          try {
            const parsed = activitySchema.safeParse(
              JSON.parse(await readFile(path.join(folder, n), "utf8")),
            );
            return parsed.success ? parsed.data : null;
          } catch {
            return null;
          }
        }),
    )
  ).filter((x): x is AgentActivity => !!x);
  return events
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 40)
    .map((e) =>
      e.status === "running" &&
      Date.now() - Date.parse(e.updatedAt ?? e.startedAt) > 15000
        ? { ...e, status: "interrupted" }
        : e,
    );
}
async function prune(folder: string) {
  const names = await readdir(folder);
  if (names.length < 80) return;
  const events = await readActivity(path.resolve(folder, "../.."));
  const keep = new Set(events.map((e) => `${e.id}.json`));
  await Promise.all(
    names
      .filter((n) => /^[a-f0-9-]+\.json$/.test(n) && !keep.has(n))
      .map((n) => unlink(path.join(folder, n)).catch(() => {})),
  );
}
/** Feedback is best effort: an activity disk failure must never turn an
 * already-committed content mutation into an apparent failed tool call. */
export async function trackActivity(...args: Parameters<typeof beginActivity>) {
  try {
    const finish = await beginActivity(...args);
    return async (error?: unknown) => {
      try {
        await finish(error);
      } catch {
        console.error("Studio activity update unavailable.");
      }
    };
  } catch {
    console.error("Studio activity unavailable.");
    return async (_error?: unknown) => {};
  }
}
