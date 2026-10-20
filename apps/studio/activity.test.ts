import { test, expect } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { trackActivity, readActivity } from "./activity.js";
import { projectFixture } from "./test-support.js";
import { loadBundle, writeJson, mutateProject } from "./storage.js";
test("agent activity has terminal states, detects interruption and cannot change content revisions", async () => {
  const { root, dir } = await projectFixture();
  try {
    const before = await loadBundle(dir);
    const finish = await trackActivity(
      dir,
      "session",
      "Test agent",
      "get_html",
      { elementRef: "title" },
    );
    expect((await readActivity(dir))[0]!.status).toBe("running");
    await finish();
    expect((await readActivity(dir))[0]!.status).toBe("succeeded");
    expect((await loadBundle(dir)).revision).toBe(before.revision);
    const id = randomUUID();
    await writeJson(path.join(dir, `.studio/activity/${id}.json`), {
      id,
      sessionId: "crashed",
      actor: "Interrupted agent",
      tool: "get_html",
      label: "Reading",
      startedAt: new Date(Date.now() - 60000).toISOString(),
      status: "running",
    });
    expect((await readActivity(dir)).find((e) => e.id === id)!.status).toBe(
      "interrupted",
    );
    await writeFile(
      path.join(dir, ".studio/activity/bad.json"),
      '{"not":"an event"}',
    );
    expect((await readActivity(dir)).length).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("broken disposable feedback storage does not turn an edit into failure", async () => {
  const { root, dir } = await projectFixture();
  try {
    await writeFile(path.join(dir, ".studio"), "unavailable");
    const finish = await trackActivity(dir, "session", "Agent", "edit", {});
    const before = await loadBundle(dir);
    const after = await mutateProject(
      dir,
      before.revision,
      "Edit title",
      (draft) => {
        draft.project.title = "Saved successfully";
      },
    );
    await finish();
    expect(after.project.title).toBe("Saved successfully");
    expect(await readActivity(dir)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
