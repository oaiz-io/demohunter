import type { LibraryRecording, LibraryTour } from "../library.js";
import type { GitStatus } from "../git.js";
import type { MachineCheck, RecordJob } from "../machine.js";
import { copyText } from "./workbench.js";

const $ = <T extends HTMLElement = HTMLElement>(q: string) =>
  document.querySelector<T>(q)!;
type Library = {
  workspace: string;
  git?: GitStatus;
  recordings: LibraryRecording[];
  tours: LibraryTour[];
  warnings: string[];
};
let data: Library = { workspace: "", recordings: [], tours: [], warnings: [] };
let filter = "all",
  folder: string | undefined,
  showHidden = false,
  loading = false,
  scannedAt = 0,
  jobs: RecordJob[] = [],
  picked: string | undefined;
const node = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  cls?: string,
) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (cls) el.className = cls;
  return el;
};
const clock = (ms: number) => {
  const s = ms / 1000;
  return `${Math.floor(s / 60)
    .toString()
    .padStart(2, "0")}:${(s % 60).toFixed(1).padStart(4, "0")}`;
};
const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "Edited just now";
  if (s < 3600) return `Edited ${Math.round(s / 60)} min ago`;
  if (s < 86400) return `Edited ${Math.round(s / 3600)} h ago`;
  return `Edited ${new Date(iso).toLocaleDateString()}`;
};
const HIDDEN = /^(tests?|fixtures?)\//;
/** The repo folder a demo belongs to: the tour's project, else the capture's. */
function folderOf(path: string) {
  const parts = path.split("/");
  const demos = parts.indexOf("demos");
  if (demos > 0) return parts.slice(0, demos).join("/");
  if (demos === 0) return "demos";
  const replays = parts.indexOf("replays");
  if (replays >= 0) return parts.slice(0, replays + 1).join("/");
  return parts.slice(0, Math.min(2, parts.length - 1)).join("/") || ".";
}
const recordingFolder = (r: LibraryRecording) => folderOf(r.tourPath ?? r.path);
const needsAttention = (r: LibraryRecording) =>
  !!(
    r.error ||
    r.comments ||
    r.tourChanged ||
    r.narration.ready < r.narration.total
  );
const isHidden = (path: string) => HIDDEN.test(path);
function visibleTours() {
  return data.tours.filter((t) => !isHidden(t.path) || showHidden);
}
function render() {
  const q = $<HTMLInputElement>("#search").value.toLowerCase().trim();
  $("#workspace").textContent = data.workspace;
  $("#service").textContent = location.host;
  $("#repo-name").textContent =
    data.git?.repository ?? data.workspace.split("/").at(-1) ?? "Workspace";
  $("#repo-owner").textContent = data.git?.remote?.split("/")[0] ?? "";
  $("#branch").hidden = !data.git?.branch;
  $("#branch").textContent = data.git?.branch ? `⎇ ${data.git.branch}` : "";
  $("#scan-status").textContent =
    data.warnings.join(" · ") ||
    (scannedAt
      ? `Scanned ${Math.max(1, Math.round((Date.now() - scannedAt) / 1000))} s ago`
      : "");
  // A demo is a tour with or without recordings, or a recording on its own.
  const toursLeft = visibleTours().filter((t) => !t.recordings.length);
  const recordings = data.recordings.filter(
    (r) => showHidden || !isHidden(r.tourPath ?? r.path),
  );
  $("#count-all").textContent = String(recordings.length + toursLeft.length);
  $("#count-attention").textContent = String(
    recordings.filter(needsAttention).length,
  );
  $("#count-agent").textContent = String(
    recordings.filter((r) => r.agentChanges || r.activeAgent).length,
  );
  // Folders
  const folders = new Map<string, number>();
  for (const r of data.recordings) {
    const f = recordingFolder(r);
    folders.set(f, (folders.get(f) ?? 0) + 1);
  }
  for (const t of data.tours.filter((t) => !t.recordings.length)) {
    const f = folderOf(t.path);
    folders.set(f, (folders.get(f) ?? 0) + 1);
  }
  const folderRoot = $("#folders");
  folderRoot.replaceChildren();
  let hiddenCount = 0;
  for (const [name, count] of [...folders].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    if (isHidden(`${name}/`)) {
      hiddenCount += count;
      continue;
    }
    const button = node("button");
    button.classList.toggle("active", folder === name);
    button.append(node("span", name), node("span", String(count), "count"));
    button.onclick = () => {
      folder = folder === name ? undefined : name;
      render();
    };
    folderRoot.append(button);
  }
  if (hiddenCount) {
    const toggle = node("button", undefined, "hidden-folder");
    toggle.append(
      node("span", showHidden ? "tests · shown" : "tests · hidden"),
      node("span", String(hiddenCount), "count"),
    );
    toggle.onclick = () => {
      showHidden = !showHidden;
      render();
    };
    folderRoot.append(toggle);
  }
  // Agent presence in the title bar
  const active = data.recordings.find((r) => r.activeAgent);
  $("#agent-presence").hidden = !active;
  if (active) {
    $("#agent-name").textContent = active.activeAgent!;
    $("#agent-where").textContent = `in ${active.title}`;
    $<HTMLAnchorElement>("#agent-presence").href = `/projects/${active.id}/`;
  }
  // Cards
  const matches = (text: string) => !q || text.toLowerCase().includes(q);
  const shown = recordings
    .filter(
      (r) =>
        matches(`${r.title} ${r.path} ${r.tourPath ?? ""}`) &&
        (!folder || recordingFolder(r) === folder) &&
        (filter === "all" ||
          (filter === "attention" && needsAttention(r)) ||
          (filter === "agent" && (r.agentChanges || r.activeAgent))),
    )
    .sort(
      (a, b) =>
        Number(!!b.activeAgent) - Number(!!a.activeAgent) ||
        b.modifiedAt.localeCompare(a.modifiedAt),
    );
  const root = $("#recordings");
  root.replaceChildren(...shown.map(card));
  // Not recorded
  const tours = toursLeft.filter(
    (t) =>
      filter === "all" &&
      matches(`${t.title ?? ""} ${t.path}`) &&
      (!folder || folderOf(t.path) === folder),
  );
  $("#tours-section").hidden = !tours.length;
  $("#tours-title").textContent = `Not recorded yet · ${tours.length}`;
  $("#tours").replaceChildren(
    ...tours.map((t) => {
      const row = node("article", undefined, "tour-row");
      row.append(
        node(
          "span",
          t.title ??
            t.path
              .split("/")
              .at(-1)!
              .replace(/\.tour\.ts$/, ""),
          "tour-title",
        ),
        node("code", t.path, "tour-path"),
      );
      const record = node("button", "Record", "button secondary small");
      record.onclick = () => openRecord(t.path);
      row.append(record);
      return row;
    }),
  );
  $("#empty").hidden = shown.length + tours.length > 0;
  $("#empty h2").textContent =
    data.recordings.length + data.tours.length
      ? "No matches."
      : "No demos yet.";
  $("#view-title").textContent =
    filter === "attention"
      ? "Needs attention"
      : filter === "agent"
        ? "Agent changes"
        : (folder ?? "Demos");
  for (const b of document.querySelectorAll<HTMLElement>("[data-filter]"))
    b.classList.toggle("active", b.dataset.filter === filter);
}
function card(r: LibraryRecording) {
  const el = node(
    "article",
    undefined,
    `recording-card${r.activeAgent ? " agent" : ""}`,
  );
  const link = node("a", undefined, "recording-art") as HTMLAnchorElement;
  link.href = `/projects/${r.id}/`;
  link.setAttribute("aria-label", `Open ${r.title}`);
  const poster = node("img") as HTMLImageElement;
  poster.src = `/projects/${r.id}/poster.png?revision=${r.revision ?? "legacy"}`;
  poster.alt = `First frame of ${r.title}`;
  poster.loading = "lazy";
  poster.decoding = "async";
  poster.className = "recording-poster";
  poster.onload = () => poster.classList.add("loaded");
  poster.onerror = () => poster.remove();
  link.append(poster, node("span", clock(r.durationMs), "duration"));
  if (r.activeAgent) {
    const pill = node("span", undefined, "art-agent");
    pill.append(node("i"), document.createTextNode(`${r.activeAgent} working`));
    link.append(pill);
  }
  const body = node("div", undefined, "card-body");
  const top = node("div", undefined, "card-top");
  const title = node("a", r.title, "card-title") as HTMLAnchorElement;
  title.href = link.href;
  top.append(title, node("span", ago(r.modifiedAt), "card-when small"));
  const path = node(
    "code",
    r.tourPath ?? `${r.path}${r.sourceTour ? "" : " · built-in sample"}`,
    "card-path",
  );
  path.title = r.path;
  const chips = node("div", undefined, "chips");
  if (r.error) chips.append(node("span", "Needs repair", "tag error"));
  if (r.comments)
    chips.append(
      node(
        "span",
        `${r.comments} open note${r.comments === 1 ? "" : "s"}`,
        "tag note",
      ),
    );
  if (r.agentChanges)
    chips.append(
      node(
        "span",
        `${r.agentChanges} agent change${r.agentChanges === 1 ? "" : "s"}`,
        "tag agent",
      ),
    );
  const stale = r.narration.total - r.narration.ready;
  if (stale)
    chips.append(
      node(
        "span",
        `${stale} segment${stale === 1 ? "" : "s"} without current audio`,
        "tag stale",
      ),
    );
  if (r.tourChanged && r.tourPath) {
    chips.append(
      node("span", "Tour file changed after recording", "tag outline"),
    );
    const again = node("button", "Record again", "link");
    again.onclick = () => openRecord(r.tourPath!);
    chips.append(again);
  }
  body.append(top, path);
  if (chips.childElementCount) body.append(chips);
  if (r.error) body.append(node("p", r.error, "recording-error"));
  el.append(link, body);
  return el;
}
// Machine check ---------------------------------------------------------------
async function loadMachine() {
  try {
    const m: MachineCheck = await fetch("/api/machine").then((r) => r.json());
    const rows: [string, string, string][] = [
      [
        m.chromium ? "ok" : "bad",
        "Chromium for recording and rendering",
        m.chromium ? "Playwright" : "Run: bunx playwright install chromium",
      ],
      [
        m.ffmpeg ? "ok" : "bad",
        "FFmpeg for video export",
        m.ffmpeg ? "on PATH" : "Install FFmpeg",
      ],
      [
        m.speechKeys.openai || m.speechKeys.elevenlabs ? "ok" : "warn",
        "Speech provider key",
        m.speechKeys.openai || m.speechKeys.elevenlabs
          ? [
              m.speechKeys.openai && "OPENAI_API_KEY",
              m.speechKeys.elevenlabs && "ELEVENLABS_API_KEY",
            ]
              .filter(Boolean)
              .join(", ")
          : "Not set · narration stays draft",
      ],
      [
        m.flite ? "ok" : "warn",
        "Local sample voice (flite)",
        m.flite ? "available" : "Optional · not in this FFmpeg",
      ],
    ];
    $("#machine-list").replaceChildren(
      ...rows.map(([state, label, detail]) => {
        const li = node("li");
        const text = node("span");
        text.append(
          node("strong", label),
          document.createElement("br"),
          node("span", detail, "muted"),
        );
        text.querySelector("strong")!.style.fontWeight = "500";
        li.append(node("i", undefined, `dot ${state}`), text);
        return li;
      }),
    );
    const bad = rows.some((r) => r[0] === "bad");
    $("#machine-dot").className =
      `dot ${bad ? "bad" : rows.some((r) => r[0] === "warn") ? "warn" : "ok"}`;
    $("#machine-summary").textContent = bad
      ? "This machine needs setup"
      : "This machine is ready";
  } catch {
    $("#machine-summary").textContent = "Machine check unavailable";
  }
}
// Recording -----------------------------------------------------------------------
function openRecord(tour?: string) {
  picked = tour;
  renderRecord();
  $<HTMLDialogElement>("#record-dialog").showModal();
}
function command(tour: string) {
  const name = tour
    .split("/")
    .at(-1)!
    .replace(/\.tour\.ts$/, "");
  return `bun run studio capture ${tour} --project .demohunter/replays/${name}-${Date.now()}`;
}
function renderRecord() {
  const job =
    jobs.find((j) => j.status === "running") ??
    (picked ? jobs.find((j) => j.tour === picked) : undefined);
  const running = job?.status === "running";
  const tour = job?.tour ?? picked;
  const meta = data.tours.find((t) => t.path === tour);
  $("#record-title").textContent = running
    ? `Recording ${meta?.title ?? tour}`
    : job?.status === "succeeded"
      ? `Recorded ${meta?.title ?? tour}`
      : tour
        ? `Record ${meta?.title ?? tour}`
        : "Record a tour";
  $(".dialog-head .rec").hidden = !running;
  $("#record-source").textContent =
    tour ?? "Choose a tour from this repository.";
  const pick = $("#record-pick");
  pick.replaceChildren();
  if (!tour)
    for (const t of visibleTours()) {
      const button = node("button");
      button.append(node("span", t.title ?? t.path), node("span", t.path));
      button.onclick = () => {
        picked = t.path;
        renderRecord();
      };
      pick.append(button);
    }
  $("#record-steps").hidden = !job;
  const order = ["timeline", "record", "bundle"];
  const at = job?.step ? order.indexOf(job.step) : -1;
  for (const li of document.querySelectorAll<HTMLElement>("#record-steps li")) {
    const i = order.indexOf(li.dataset.step!);
    const done = job?.status === "succeeded" || (running && i < at);
    li.className = done
      ? "done"
      : running && i === Math.max(0, at)
        ? "running"
        : "";
    li.querySelector("small")!.textContent = done
      ? "done"
      : li.className === "running"
        ? "running"
        : "";
  }
  $("#record-error").hidden = job?.status !== "failed";
  $("#record-error").textContent = job?.error ?? "";
  $("#record-dest").textContent = job
    ? job.status === "failed"
      ? "Nothing was saved. Fix the error, then try again."
      : `Saves to a new folder: ${job.destination}`
    : "Runs the tour in Chromium and saves the DOM. No video and no speech yet. The app at the tour's baseURL must be running.";
  $("#record-command").textContent = tour
    ? command(tour)
    : "bun run studio capture …";
  $<HTMLButtonElement>("#record-start").hidden =
    running || job?.status === "succeeded";
  $<HTMLButtonElement>("#record-start").disabled = !tour;
  $<HTMLButtonElement>("#record-start").textContent =
    job?.status === "failed" ? "Try again" : "Record";
  $("#record-stop").hidden = !running;
  $("#record-copy").hidden = running;
}
async function pollJobs() {
  try {
    const before = jobs.find((j) => j.status === "running");
    jobs = await fetch("/api/record").then((r) => r.json());
    if (
      before &&
      jobs.find((j) => j.id === before.id)?.status === "succeeded"
    ) {
      await refresh(true);
      const done = jobs.find((j) => j.id === before.id)!;
      const recording = data.recordings.find(
        (r) => r.path === done.destination,
      );
      if (recording) location.href = `/projects/${recording.id}/`;
    }
    if ($<HTMLDialogElement>("#record-dialog").open) renderRecord();
  } catch {}
}
$("#record-open").onclick = () => openRecord();
$("#record-close").onclick = () =>
  $<HTMLDialogElement>("#record-dialog").close();
$("#record-copy").onclick = () =>
  void copyText($("#record-command").textContent!).then(copied);
$("#record-start").onclick = () =>
  void fetch("/api/record", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tour: picked }),
  })
    .then(async (r) => {
      const result = await r.json();
      if (!r.ok) throw new Error(result.error);
      jobs = [result, ...jobs];
      renderRecord();
    })
    .catch((e) => {
      $("#record-error").hidden = false;
      $("#record-error").textContent =
        e instanceof Error ? e.message : String(e);
    });
$("#record-stop").onclick = () => {
  const job = jobs.find((j) => j.status === "running");
  if (job)
    void fetch("/api/record/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: job.id }),
    }).then(() => pollJobs());
};
// Scanning ------------------------------------------------------------------------
async function refresh(force = false) {
  if (loading && !force) return;
  loading = true;
  try {
    const res = await fetch("/api/library");
    if (!res.ok)
      throw new Error("Unable to read the workspace. Retry refresh.");
    const next = await res.json();
    const signature = (v: Library) =>
      JSON.stringify({ ...v, recordings: v.recordings, tours: v.tours });
    const changed = signature(data) !== signature(next);
    data = next;
    scannedAt = Date.now();
    if (changed) render();
    else
      $("#scan-status").textContent =
        data.warnings.join(" · ") || "Scanned just now";
    $("#error").hidden = true;
    const hash = new URLSearchParams(location.hash.slice(1));
    if (hash.has("capture")) {
      const recording = data.recordings.find(
        (r) => r.captureId === hash.get("capture"),
      );
      if (recording)
        location.replace(`/projects/${recording.id}/${location.hash}`);
    }
  } catch (e) {
    $("#error").textContent = e instanceof Error ? e.message : String(e);
    $("#error").hidden = false;
  } finally {
    loading = false;
  }
}
function copied() {
  $("#toast").hidden = false;
  setTimeout(() => ($("#toast").hidden = true), 1700);
}
if ("__TAURI__" in window || "__TAURI_INTERNALS__" in window)
  document.body.classList.add("desktop");
$("#refresh").onclick = () => void refresh(true);
$("#copy-open").onclick = () =>
  void copyText("bun run studio library /path/to/repo").then(copied);
$("#search").oninput = render;
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    $("#search").focus();
  }
});
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-filter]",
))
  button.onclick = () => {
    filter = button.dataset.filter!;
    folder = undefined;
    render();
  };
void refresh();
void loadMachine();
void pollJobs();
setInterval(() => {
  if (!document.hidden) void refresh();
}, 4000);
setInterval(() => {
  if (
    jobs.some((j) => j.status === "running") ||
    $<HTMLDialogElement>("#record-dialog").open
  )
    void pollJobs();
}, 1000);
