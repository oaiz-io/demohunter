import type { LibraryRecording, LibraryTour } from "../library.js";
import { copyText } from "./workbench.js";
const $ = <T extends HTMLElement = HTMLElement>(q: string) =>
  document.querySelector<T>(q)!;
let data: {
  workspace: string;
  recordings: LibraryRecording[];
  tours: LibraryTour[];
  warnings: string[];
} = { workspace: "", recordings: [], tours: [], warnings: [] };
let view = "recordings",
  filter = "all",
  loading = false;
const node = (tag: string, text?: string, cls?: string) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (cls) el.className = cls;
  return el;
};
const time = (ms: number) =>
  `${Math.floor(ms / 60000)}:${Math.round((ms / 1000) % 60)
    .toString()
    .padStart(2, "0")}`;
function render() {
  const q = $<HTMLInputElement>("#search").value.toLowerCase();
  $("#workspace").textContent = data.workspace;
  $("#recording-count").textContent = String(data.recordings.length);
  $("#tour-count").textContent = String(data.tours.length);
  $("#recordings").hidden = view !== "recordings";
  $("#tours").hidden = view !== "tours";
  $(".filters").hidden = view !== "recordings";
  $(".filters>summary").textContent =
    filter === "all"
      ? "Filter"
      : filter === "review"
        ? "Open comments"
        : "Audio to update";
  $("#sort").hidden = view !== "recordings";
  $("#view-title").textContent =
    view === "recordings" ? "Recordings" : "Source tours";
  $("#view-description").textContent =
    view === "recordings"
      ? "Your local workspace."
      : "Open a tour with your agent, then capture it.";
  const records = data.recordings
    .filter(
      (r) =>
        `${r.title} ${r.path}`.toLowerCase().includes(q) &&
        (filter === "all" ||
          (filter === "review" && !!(r.comments || r.error)) ||
          (filter === "audio" && r.narration.ready < r.narration.total)),
    )
    .sort((a, b) =>
      $<HTMLSelectElement>("#sort").value === "title"
        ? a.title.localeCompare(b.title)
        : b.modifiedAt.localeCompare(a.modifiedAt),
    );
  const root = $("#recordings");
  root.replaceChildren();
  for (const [i, r] of records.entries()) {
    const card = node("article", undefined, "recording-card");
    const link = node("a", undefined, "recording-art") as HTMLAnchorElement;
    link.href = `/projects/${r.id}/`;
    link.setAttribute("aria-label", `Open ${r.title}`);
    link.dataset.palette = String(i % 4);
    const art = node("div", undefined, "recording-sheet");
    art.append(node("div", undefined, "sheet-nav"));
    const content = node("div", undefined, "sheet-content");
    content.append(
      node("div", undefined, "sheet-heading"),
      node("div", undefined, "sheet-line"),
      node("div", undefined, "sheet-panels"),
      node("div", undefined, "sheet-line"),
      node("div", undefined, "sheet-line"),
    );
    art.append(content);
    const poster = node("img") as HTMLImageElement;
    poster.src = `/projects/${r.id}/poster.png?revision=${r.revision ?? "legacy"}`;
    poster.alt = `First frame of ${r.title}`;
    poster.loading = "lazy";
    poster.decoding = "async";
    poster.className = "recording-poster";
    poster.onload = () => poster.classList.add("loaded");
    poster.onerror = () => poster.remove();
    link.append(
      art,
      poster,
      node("span", "▶", "art-play"),
      node("span", time(r.durationMs), "duration"),
    );
    card.append(link);
    const body = node("div", undefined, "card-body"),
      title = node("a", r.title, "card-title") as HTMLAnchorElement;
    title.href = link.href;
    const filename = node(
      "code",
      r.path.split("/").at(-1) ?? r.path,
      "card-path",
    );
    filename.title = r.path;
    body.append(title, filename);
    const meta = node("div", undefined, "card-meta");
    meta.append(
      node("span", `${r.scenes} scenes`),
      node(
        "span",
        r.narration.total
          ? `${r.narration.ready}/${r.narration.total} audio ready`
          : "Visual replay",
      ),
    );
    body.append(meta);
    const bottom = node("div", undefined, "card-bottom");
    bottom.append(
      node(
        "span",
        r.error
          ? "Needs repair"
          : r.comments
            ? `${r.comments} open comment${r.comments === 1 ? "" : "s"}`
            : r.narration.ready < r.narration.total
              ? "Audio to update"
              : "Ready to edit",
        r.error ? "badge error" : r.comments ? "badge review" : "badge",
      ),
    );
    const copy = node("button", "Copy path") as HTMLButtonElement;
    copy.onclick = () =>
      void copyText(`${data.workspace}/${r.path}`).then(copied);
    bottom.append(copy);
    if (!r.error && !r.comments && r.narration.ready === r.narration.total)
      bottom.querySelector<HTMLElement>(".badge")!.hidden = true;
    body.append(bottom);
    if (r.error) body.append(node("p", r.error, "recording-error"));
    card.append(body);
    root.append(card);
  }
  const tours = data.tours.filter((t) => t.path.toLowerCase().includes(q));
  $("#tours").replaceChildren();
  for (const t of tours) {
    const row = node("article", undefined, "tour-row");
    row.append(node("span", "⌘", "tour-icon"), node("code", t.path));
    const button = node("button", "Capture command") as HTMLButtonElement;
    button.onclick = () => showCapture(t.command);
    row.append(button);
    $("#tours").append(row);
  }
  const count = view === "recordings" ? records.length : tours.length;
  $("#empty").hidden = count > 0;
  const hasFiles =
    view === "recordings" ? data.recordings.length > 0 : data.tours.length > 0;
  $("#empty h2").textContent = hasFiles
    ? "No matches"
    : view === "recordings"
      ? "No recordings yet."
      : "No source tours yet.";
  $("#empty p").textContent = hasFiles
    ? "Try another search or filter."
    : "Capture a tour with your agent, or add a saved recording to this workspace.";
  $("#empty code").hidden = hasFiles;
  $("#result-count").textContent =
    `${count} ${view === "recordings" ? "recording" : "source tour"}${count === 1 ? "" : "s"}`;
  $("#scan-status").textContent =
    data.warnings.join(" · ") || "● Synced with your filesystem";
}
async function refresh() {
  if (loading) return;
  loading = true;
  try {
    const res = await fetch("/api/library");
    if (!res.ok)
      throw new Error("Unable to read the workspace. Retry refresh.");
    const next = await res.json();
    const signature = (v: typeof data) =>
      JSON.stringify({
        workspace: v.workspace,
        recordings: v.recordings,
        tours: v.tours.map((t) => t.path),
        warnings: v.warnings,
      });
    const changed = signature(data) !== signature(next);
    data = next;
    if (changed) render();
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
function showCapture(command = "bun run studio capture demos/example.tour.ts") {
  $("#capture-command").textContent = command;
  $<HTMLDialogElement>("#capture-dialog").showModal();
}
function copied() {
  $("#toast").hidden = false;
  setTimeout(() => ($("#toast").hidden = true), 1700);
}
$("#refresh").onclick = () => void refresh();
$("#search").oninput = render;
$("#sort").onchange = render;
$("#capture-help").onclick = () => showCapture();
$("#close-dialog").onclick = () =>
  $<HTMLDialogElement>("#capture-dialog").close();
$("#copy-command").onclick = () =>
  void copyText($("#capture-command").textContent!).then(copied);
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-view]",
))
  button.onclick = () => {
    view = button.dataset.view!;
    for (const b of document.querySelectorAll("[data-view]"))
      b.classList.toggle("active", b === button);
    render();
  };
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-filter]",
))
  button.onclick = () => {
    filter = button.dataset.filter!;
    for (const b of document.querySelectorAll("[data-filter]"))
      b.classList.toggle("active", b === button);
    render();
    document.querySelector<HTMLDetailsElement>(".filters")!.open = false;
  };
void refresh();
setInterval(() => {
  if (!document.hidden) void refresh();
}, 4000);
