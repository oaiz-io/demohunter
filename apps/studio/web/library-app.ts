import type { LibraryRecording } from "../library.js";
import type { GitStatus } from "../git.js";

const $ = <T extends HTMLElement = HTMLElement>(q: string) =>
  document.querySelector<T>(q)!;
type Library = {
  workspace: string;
  git?: GitStatus;
  recordings: LibraryRecording[];
  warnings: string[];
};
let data: Library = { workspace: "", recordings: [], warnings: [] },
  scanned = "",
  loading = false;
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
/** Test and fixture captures stay out of the library. */
const isTestPath = (path: string) => /^(tests?|fixtures?)\//.test(path);
function render() {
  const q = $<HTMLInputElement>("#search").value.toLowerCase().trim();
  $("#repo-name").textContent =
    data.git?.repository ?? data.workspace.split("/").at(-1) ?? "Workspace";
  $("#branch").hidden = !data.git?.branch;
  $("#branch").textContent = data.git?.branch ? `⎇ ${data.git.branch}` : "";
  $("#warnings").hidden = !data.warnings.length;
  $("#warnings").textContent = data.warnings.join(" · ");
  const recordings = data.recordings.filter(
    (r) => !isTestPath(r.tourPath ?? r.path),
  );
  const shown = recordings
    .filter(
      (r) =>
        !q ||
        `${r.title} ${r.path} ${r.tourPath ?? ""}`.toLowerCase().includes(q),
    )
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  $("#recordings").replaceChildren(...shown.map(card));
  $("#empty").hidden = shown.length > 0;
  $("#empty-title").textContent = recordings.length
    ? "No matches"
    : "No demos yet";
  $("#empty-command").hidden = recordings.length > 0;
}
/** One status per card: open notes first, else a tour changed since capture. */
function status(r: LibraryRecording) {
  if (r.comments)
    return node(
      "span",
      `${r.comments} open note${r.comments === 1 ? "" : "s"}`,
      "tag note",
    );
  if (r.tourChanged && r.tourPath)
    return node("span", "Tour changed", "tag outline");
}
function card(r: LibraryRecording) {
  const el = node("article", undefined, "recording-card");
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
  const body = node("div", undefined, "card-body");
  const top = node("div", undefined, "card-top");
  const title = node("a", r.title, "card-title") as HTMLAnchorElement;
  title.href = link.href;
  top.append(title);
  const tag = status(r);
  if (tag) top.append(tag);
  const meta = node("div", undefined, "card-meta");
  const path = node(
    "code",
    r.tourPath ?? `${r.path}${r.sourceTour ? "" : " · built-in sample"}`,
    "card-path",
  );
  path.title = r.path;
  meta.append(path, node("span", ago(r.modifiedAt), "card-when"));
  body.append(top, meta);
  if (r.error) body.append(node("p", r.error, "recording-error"));
  el.append(link, body);
  return el;
}
async function refresh() {
  if (loading) return;
  loading = true;
  try {
    const res = await fetch("/api/library");
    if (!res.ok)
      throw new Error("Unable to read the workspace. Retry refresh.");
    const text = await res.text();
    if (text !== scanned) {
      scanned = text;
      data = JSON.parse(text);
      render();
    }
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
if ("__TAURI__" in window || "__TAURI_INTERNALS__" in window)
  document.body.classList.add("desktop");
$("#search").oninput = render;
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    $("#search").focus();
  }
});
void refresh();
setInterval(() => {
  if (!document.hidden) void refresh();
}, 4000);
