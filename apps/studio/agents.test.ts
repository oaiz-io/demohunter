import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import { serveLibrary } from "./library-server.js";
import { projectFixture } from "./test-support.js";
import { useAdapterScript } from "./agents.js";
import { restrictFolder } from "./trust.js";

const FAKE = path.join(import.meta.dir, "fixtures/fake-acp-agent.ts");
type App = Awaited<ReturnType<typeof serveLibrary>>;
let app: App, root: string, project: string;

beforeAll(async () => {
  useAdapterScript("claude", FAKE);
  ({ root } = await projectFixture());
  app = await serveLibrary(root, { port: 0 });
  project = (await fetch(`${app.url}/api/library`).then((r) => r.json())).recordings[0].id;
});
afterAll(async () => {
  await app.close();
  useAdapterScript("claude", undefined);
  await rm(root, { recursive: true, force: true });
});

const post = (url: string, body: unknown) =>
  fetch(`${app.url}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** Read the session's event stream until `done` says so. */
async function watch(id: string, done: (state: { events: any[]; status: string }) => boolean, ms = 15_000) {
  const res = await fetch(`${app.url}/api/agents/${id}/stream`);
  const reader = res.body!.getReader();
  const state = { events: [] as any[], status: "" };
  const upsert = (e: any) => {
    const i = state.events.findIndex((x) => x.seq === e.seq);
    if (i >= 0) state.events[i] = e;
    else state.events.push(e);
  };
  let buffer = "";
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const { value, done: end } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), deadline - Date.now())),
      ]);
      if (end) break;
      buffer += new TextDecoder().decode(value);
      let i;
      while ((i = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (!chunk.startsWith("data: ")) continue;
        const message = JSON.parse(chunk.slice(6));
        if (message.type === "snapshot") {
          state.status = message.status;
          message.events.forEach(upsert);
        } else if (message.type === "status") state.status = message.status;
        else upsert(message.event);
        if (done(state)) return state;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new Error(`Timed out; last state ${JSON.stringify(state).slice(0, 600)}`);
}
const agentText = (s: { events: any[] }) =>
  s.events.filter((e) => e.type === "agent").map((e) => e.text).join("\n");

describe("agents in Studio", () => {
  let id: string;
  test("starting reuses the worktree's session; the agent runs in that worktree", async () => {
    const info = await fetch(`${app.url}/api/agents?project=${project}`).then((r) => r.json());
    expect(info.trusted).toBe(true);
    expect(info.kinds.find((k: any) => k.kind === "claude").available).toBe(true);
    expect(info.settings).toEqual({ autoSendNotes: false, agent: "claude" });
    const started = await post("/api/agents/start", { project, kind: "claude" }).then((r) => r.json());
    expect(started).toMatchObject({ kind: "claude", name: "Claude Code", root: info.root, status: "idle" });
    const again = await post("/api/agents/start", { project, kind: "claude" }).then((r) => r.json());
    expect(again.id).toBe(started.id);
    id = started.id;
  });

  test("prompts carry Studio's context and stream the reply, plan and tool calls", async () => {
    const r = await post(`/api/agents/${id}/prompt`, { text: "Make a plan", project, outputMs: 17_900, selection: { ref: "d3-approve", label: "Approve" } });
    expect(r.status).toBe(202);
    const state = await watch(id, (s) => s.events.some((e) => e.type === "done") && s.status === "idle");
    const user = state.events.find((e) => e.type === "user");
    expect(user.text).toBe("Make a plan");
    expect(user.context).toEqual(["00:17.9", "Approve"]);
    expect(agentText(state)).toContain('Got: Demo: "Test replay"');
    expect(state.events.find((e) => e.type === "plan").entries.map((e: any) => e.status)).toEqual(["completed", "in_progress"]);
    expect(state.events.find((e) => e.type === "tool")).toMatchObject({ title: "mcp__demohunter__get_basic_info", status: "completed" });
  });

  test("tool approvals are answered from Studio", async () => {
    await post(`/api/agents/${id}/prompt`, { text: "needs permission", project });
    const asking = await watch(id, (s) => s.status === "waiting" && s.events.some((e) => e.type === "permission" && !e.chosen));
    const request = asking.events.find((e) => e.type === "permission" && !e.chosen);
    expect(request.title).toBe("Run bun run studio export");
    expect(request.detail).toContain("bun run studio export");
    expect((await post(`/api/agents/${id}/permission`, { requestId: request.requestId, optionId: "nope" })).status).toBe(400);
    expect((await post(`/api/agents/${id}/permission`, { requestId: request.requestId, optionId: "yes" })).status).toBe(200);
    const after = await watch(id, (s) => agentText(s).includes("Permission: yes") && s.status === "idle");
    expect(after.events.find((e) => e.requestId === request.requestId).chosen).toBe("yes");
    expect((await post(`/api/agents/${id}/permission`, { requestId: request.requestId, optionId: "yes" })).status).toBe(409);
  });

  test("read-only DemoHunter tools don't stop to ask", async () => {
    await post(`/api/agents/${id}/prompt`, { text: "peek at the demo", project });
    const state = await watch(id, (s) => agentText(s).includes("Read: yes") && s.status === "idle");
    expect(state.events.filter((e) => e.type === "permission")).toHaveLength(1);
  });

  test("a running turn can be stopped", async () => {
    await post(`/api/agents/${id}/prompt`, { text: "slow job", project });
    await watch(id, (s) => s.status === "working");
    expect((await post(`/api/agents/${id}/cancel`, {})).status).toBe(200);
    const state = await watch(id, (s) => s.events.some((e) => e.type === "done" && e.stopReason === "cancelled"));
    expect(state.events.at(-1).stopReason).toBe("cancelled");
  });

  test("notes are sent with their text, and agents are told to resolve them", async () => {
    const bundle = await fetch(`${app.url}/projects/${project}/api/project`).then((r) => r.json());
    const note = await fetch(`${app.url}/projects/${project}/api/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: bundle.revision, action: "add", body: "Zoom in on the button", timeMs: 1200 }),
    });
    const thread = (await fetch(`${app.url}/projects/${project}/api/project`).then((r) => r.json())).comments.threads.at(-1);
    expect(note.status).toBeLessThan(300);
    await post(`/api/agents/${id}/prompt`, { text: "Work through this note.", project, notes: [thread.id] });
    const state = await watch(id, (s) => s.events.filter((e) => e.type === "user").length >= 4 && s.status === "idle");
    expect(state.events.filter((e) => e.type === "user").at(-1).context).toEqual(["Note: Zoom in on the button"]);
  });

  test("settings persist per worktree", async () => {
    expect((await post("/api/agents/settings", { project, autoSendNotes: true, agent: "claude" })).status).toBe(200);
    const info = await fetch(`${app.url}/api/agents?project=${project}`).then((r) => r.json());
    expect(info.settings.autoSendNotes).toBe(true);
  });

  test("bad input is refused", async () => {
    expect((await post(`/api/agents/${id}/prompt`, { text: "  ", project })).status).toBe(400);
    expect((await post(`/api/agents/00000000-0000-0000-0000-000000000000/prompt`, { text: "x", project })).status).toBe(404);
    expect((await post("/api/agents/start", { project, kind: "gpt" })).status).toBe(400);
    // A cross-site form post (no JSON content type) never reaches an agent.
    const form = await fetch(`${app.url}/api/agents/start`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ project, kind: "claude" }),
    });
    expect(form.status).toBe(415);
  });

  test("a signed-out agent says how to sign in", async () => {
    await post(`/api/agents/${id}/stop`, {});
    process.env.FAKE_AGENT_FAIL = "auth";
    try {
      const r = await post("/api/agents/start", { project, kind: "claude" });
      expect(r.status).toBe(400);
      expect((await r.json()).error).toBeTruthy();
      const info = await fetch(`${app.url}/api/agents?project=${project}`).then((r) => r.json());
      const failed = info.sessions.find((s: any) => s.status === "error");
      expect(failed).toBeTruthy();
      const state = await watch(failed.id, (s) => s.events.some((e) => e.type === "notice"));
      expect(state.events.find((e) => e.type === "notice").text).toContain("isn't signed in");
    } finally {
      delete process.env.FAKE_AGENT_FAIL;
    }
  });

  test("agents never start in a folder that isn't trusted", async () => {
    const { root: other } = await projectFixture();
    restrictFolder(other);
    const restricted = await serveLibrary(other, { port: 0, restricted: true });
    try {
      const id = (await fetch(`${restricted.url}/api/library`).then((r) => r.json())).recordings[0].id;
      const r = await fetch(`${restricted.url}/api/agents/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: id, kind: "claude" }),
      });
      expect(r.status).toBe(403);
      expect((await r.json()).error).toContain("Trust the folder");
    } finally {
      await restricted.close();
      await rm(other, { recursive: true, force: true });
    }
  });
});
