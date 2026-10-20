import type { AgentEvent, AgentStatus } from "../agents.js";
import type { TourDraft } from "../create-demo.js";
import type { LibraryRecording, LibraryWorktree } from "../library.js";
import { AgentChat } from "./agent-chat.js";
import { resizablePanel } from "./panel-resize.js";

/**
 * New demo: the person tells their own agent what demo to make, and watches
 * it take shape — the tour's chapters, steps and narration as the agent
 * writes the file, then the recording, then the demo itself. Studio only
 * watches: the agent (agents.ts, briefed by create-demo.ts) does the work.
 */

const $ = <T extends HTMLElement = HTMLElement>(q: string) => document.querySelector<T>(q)!;
const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};
const clock = (ms: number) => {
  const s = ms / 1000;
  return `${Math.floor(s / 60).toString().padStart(2, "0")}:${(s % 60).toFixed(1).padStart(4, "0")}`;
};
const elapsed = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
type Library = { workspace: string; worktrees?: LibraryWorktree[]; recordings: LibraryRecording[] };

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  const value = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((value as { error?: string }).error ?? `Request failed (${r.status})`);
  return value as T;
}

// ------------------------------------------------------------ errors

let errorTimer: ReturnType<typeof setTimeout> | undefined;
function report(error: unknown) {
  $("#error-text").textContent = error instanceof Error ? error.message : String(error);
  $("#error").hidden = false;
}
$("#error-dismiss").onclick = () => ($("#error").hidden = true);
function toast(text: string) {
  const box = $("#toast");
  box.textContent = text;
  box.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => (box.hidden = true), 2400);
}

// ------------------------------------------------------------ state

let library: Library = { workspace: "", recordings: [] };
let root = new URLSearchParams(location.search).get("root") ?? "";
/** This page's demo: since when, and the demos that already existed. Kept
 * across reloads of the tab; "Create another" starts over. */
type Run = { since: number; baseline: string[] };
const runKey = () => `demohunter-new:${root}`;
let run: Run | undefined;
const events = new Map<number, AgentEvent>();
let status: AgentStatus | undefined;
let tours: TourDraft[] = [];
let capturing: string[] = [];
let created: LibraryRecording | undefined;
let recordingSince: number | undefined;
let chat: AgentChat | undefined;

const inRoot = (r: LibraryRecording) => (r.worktree ?? library.workspace) === root;

// ------------------------------------------------------------ stage

const STEP_LABELS = {
  brief: "Brief",
  explore: "Reading the project",
  tour: "Writing the tour",
  record: "Recording",
  ready: "Demo ready",
} as const;
type StepState = "todo" | "active" | "done" | "failed";

/** The agent's capture run: a shell call that runs Studio's `capture`. */
const captureCall = () =>
  [...events.values()]
    .filter((e): e is Extract<AgentEvent, { type: "tool" }> => e.type === "tool")
    .filter((e) => /\bcapture\b/i.test(e.title))
    .at(-1);
const toolLabel = (title: string) =>
  title
    .replace(/^mcp__demohunter__|^mcp\.demohunter\./, "DemoHunter · ")
    .replace(/`/g, "")
    .slice(0, 90);

function renderStage() {
  const users = [...events.values()].filter((e) => e.type === "user");
  const asked = users.length > 0;
  $("#nd-intro").hidden = asked || !!created;
  $("#nd-live").hidden = !asked && !created;
  const tour = tours[0];
  const call = captureCall();
  const recording = !created && (capturing.length > 0 || (!!call && ["pending", "in_progress"].includes(call.status)));
  if (recording) recordingSince ??= Date.now();
  else recordingSince = undefined;
  const failed = !created && !recording && call?.status === "failed";
  const working = status === "working" || status === "waiting";
  const lastTool = [...events.values()].filter((e) => e.type === "tool").at(-1) as Extract<AgentEvent, { type: "tool" }> | undefined;

  const steps: { key: keyof typeof STEP_LABELS; state: StepState; sub?: string }[] = [
    { key: "brief", state: asked ? "done" : "active", sub: users[0] ? `“${users[0].text.slice(0, 90)}${users[0].text.length > 90 ? "…" : ""}”` : undefined },
    {
      key: "explore",
      state: tour || created || call ? "done" : asked ? "active" : "todo",
      sub: !tour && !created && working && lastTool ? toolLabel(lastTool.title) : undefined,
    },
    {
      key: "tour",
      state: created || recording || failed || (call && call.status === "completed") ? "done" : tour ? "active" : "todo",
      sub: tour
        ? [
            count(tour.items.filter((i) => i.kind === "step").length, "step"),
            count(tour.items.filter((i) => i.kind === "narrate").length, "narration line"),
          ].join(" · ")
        : undefined,
    },
    {
      key: "record",
      state: created ? "done" : recording ? "active" : failed ? "failed" : "todo",
      sub: failed ? (working ? "Didn't finish. The agent is fixing the tour." : "Didn't finish.") : undefined,
    },
    { key: "ready", state: created ? "done" : "todo", sub: created?.title },
  ];
  const list = $("#nd-steps");
  const key = JSON.stringify(steps);
  if (list.dataset.key !== key) {
    list.dataset.key = key;
    list.replaceChildren(
      ...steps.map((s) => {
        const li = make("li", `nd-step ${s.state}`);
        li.dataset.step = s.key;
        li.append(make("span", "nd-step-mark", s.state === "done" ? "✓" : s.state === "failed" ? "!" : ""));
        const text = make("div", "nd-step-text");
        text.append(make("span", "nd-step-label", STEP_LABELS[s.key]));
        if (s.sub) text.append(make("span", "nd-step-sub", s.sub));
        li.append(text);
        return li;
      }),
    );
  }

  // The tour, as it is written.
  $("#nd-board").hidden = !tour;
  if (tour) renderBoard(tour);

  // The recording.
  $("#nd-recording").hidden = !recording;
  if (recording && recordingSince) $("#nd-recording-time").textContent = elapsed(Date.now() - recordingSince);

  // The demo.
  $("#nd-result").hidden = !created;
  if (created) renderResult(created);

  const waiting = $("#nd-waiting");
  const idle = status === "idle" && asked && !created && !recording;
  waiting.hidden = !idle;
  waiting.textContent = idle ? `${chat?.current?.name ?? "Your agent"} is waiting for you in the chat.` : "";
}

/** Storyboard items keep their nodes; new ones animate in. */
let shownItems: string[] = [];
function renderBoard(tour: TourDraft) {
  $("#nd-title").textContent = tour.title ?? tour.id ?? "Untitled tour";
  $("#nd-path").textContent = tour.path;
  const keys = tour.items.map((item, i) => `${i}\u0000${item.kind}\u0000${item.text}`);
  if (keys.join("\u0001") === shownItems.join("\u0001")) return;
  const old = new Set(shownItems);
  shownItems = keys;
  let step = 0;
  let fresh = 0;
  const items = tour.items.map((item, i) => {
    const li = make("li", `nd-item ${item.kind}`);
    if (item.kind === "step") {
      step++;
      li.append(make("span", "nd-item-n mono", String(step).padStart(2, "0")), make("span", "nd-item-text", item.text));
    } else if (item.kind === "chapter") li.append(make("span", "nd-item-text", item.text));
    else if (item.kind === "visit") li.append(make("span", "nd-item-text mono", `→ ${item.text}`));
    else li.append(make("span", "nd-item-q", "“"), make("span", "nd-item-text", item.text));
    if (!old.has(keys[i]!)) {
      li.classList.add("enter");
      li.style.animationDelay = `${Math.min(fresh++, 12) * 70}ms`;
    }
    return li;
  });
  if (!tour.items.length) items.push(make("li", "nd-item empty muted", "The tour file is there; its steps come next."));
  $("#nd-items").replaceChildren(...items);
}

function renderResult(r: LibraryRecording) {
  const img = $<HTMLImageElement>("#nd-poster");
  const src = `/projects/${r.id}/poster.png?revision=${r.revision ?? "legacy"}`;
  if (img.dataset.src !== src) {
    img.dataset.src = src;
    img.classList.remove("loaded");
    img.onload = () => img.classList.add("loaded");
    img.src = src;
    img.alt = `First frame of ${r.title}`;
  }
  $<HTMLAnchorElement>("#nd-result-art").href = `/projects/${r.id}/#agent`;
  $("#nd-duration").textContent = clock(r.durationMs);
  $("#nd-result-title").textContent = r.title;
  $("#nd-result-path").textContent = r.path;
}

async function openCreated() {
  if (!created) return;
  // The agent that made it carries on in the editor's Agents panel.
  await chat?.adopt().catch(() => {});
  sessionStorage.removeItem(runKey());
  location.href = `/projects/${created.id}/#agent`;
}
$("#nd-open").onclick = () => void openCreated();
$("#nd-result-art").onclick = (e) => {
  e.preventDefault();
  void openCreated();
};
$("#nd-again").onclick = () => {
  sessionStorage.removeItem(runKey());
  sessionStorage.removeItem(`demohunter-new-agent:${root}`);
  location.reload();
};

const EXAMPLES = [
  "A one-minute tour of the main workflow, for someone seeing the product for the first time",
  "How a new user signs up and gets to their first result",
  "One feature from start to finish: ",
];
$("#nd-examples").replaceChildren(
  ...EXAMPLES.map((text) => {
    const b = make("button", "nd-example", text) as HTMLButtonElement;
    b.type = "button";
    b.onclick = () => {
      const input = $<HTMLTextAreaElement>("#agent-input");
      input.value = text;
      input.focus();
      input.setSelectionRange(text.length, text.length);
    };
    return b;
  }),
);

// ------------------------------------------------------------ polling

async function pollTours() {
  if (!run || created || document.hidden) return;
  const value = await getJson<{ tours: TourDraft[]; capturing: string[] }>(
    `/api/agents/tours?${new URLSearchParams({ root, since: String(run.since) })}`,
  );
  tours = value.tours;
  capturing = value.capturing;
  renderStage();
}
async function pollLibrary() {
  if (document.hidden && library.workspace) return;
  library = await getJson<Library>("/api/library");
  if (!root) {
    root = library.workspace;
    history.replaceState(null, "", `/new?${new URLSearchParams({ root })}`);
  }
  if (!run) {
    const saved = sessionStorage.getItem(runKey());
    run = saved ? (JSON.parse(saved) as Run) : { since: Date.now() - 1000, baseline: library.recordings.map((r) => r.id) };
    sessionStorage.setItem(runKey(), JSON.stringify(run));
  }
  const fresh = library.recordings
    .filter((r) => inRoot(r) && !run!.baseline.includes(r.id))
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))[0];
  if (fresh && fresh.id !== created?.id) {
    created = fresh;
    toast("Your demo is ready");
  }
  renderWhere();
  renderStage();
}

function renderWhere() {
  const select = $<HTMLSelectElement>("#nd-root");
  const trees = (library.worktrees ?? []).filter((w) => !w.missing);
  const places = trees.length
    ? trees.map((w) => ({ path: w.path, label: `${w.name}${w.branch ? ` · ${w.branch}` : ""}` }))
    : [{ path: library.workspace, label: library.workspace.split("/").at(-1) || library.workspace }];
  if (!places.some((p) => p.path === root)) places.unshift({ path: root, label: root.split("/").at(-1) || root });
  const key = JSON.stringify([places, root]);
  if (select.dataset.key === key) return;
  select.dataset.key = key;
  select.replaceChildren(
    ...places.map((p) => {
      const o = make("option", undefined, p.label) as HTMLOptionElement;
      o.value = p.path;
      o.title = p.path;
      o.selected = p.path === root;
      return o;
    }),
  );
  select.disabled = places.length < 2;
  select.title = root;
}
$<HTMLSelectElement>("#nd-root").onchange = (e) => {
  location.href = `/new?${new URLSearchParams({ root: (e.target as HTMLSelectElement).value })}`;
};

// ------------------------------------------------------------ start

if ("demohunterDesktop" in window || "__TAURI__" in window || "__TAURI_INTERNALS__" in window)
  document.body.classList.add("desktop");
resizablePanel($(".nd-chat"));
void (async () => {
  try {
    await pollLibrary();
  } catch (error) {
    report(error);
    return;
  }
  chat = new AgentChat({
    project: () => "",
    root: () => root,
    time: () => 0,
    selection: () => undefined,
    error: report,
    status: (s) => {
      status = s;
      renderStage();
    },
    toast,
    event: (e) => {
      events.set(e.seq, e);
      renderStage();
    },
  });
  await chat.available;
  setInterval(() => void pollTours().catch(() => {}), 2000);
  setInterval(() => void pollLibrary().catch(() => {}), 3000);
  // The recording's elapsed time.
  setInterval(() => {
    if (recordingSince) renderStage();
  }, 1000);
  void pollTours().catch(() => {});
})();
