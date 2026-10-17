import type {
  LibraryRecording,
  LibraryTour,
  LibraryWorktree,
} from "../library.js";
import type { GitStatus } from "../git.js";

const $ = <T extends HTMLElement = HTMLElement>(q: string) =>
  document.querySelector<T>(q)!;
type Library = {
  workspace: string;
  git?: GitStatus;
  worktrees?: LibraryWorktree[];
  recordings: LibraryRecording[];
  tours?: LibraryTour[];
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

// ------------------------------------------------------------- projects

type Desktop = {
  choose(): Promise<unknown>;
  open(dir: string): Promise<unknown>;
  info(): Promise<{
    home: string;
    recent: { path: string; name: string; openedAt?: number }[];
  }>;
};
const desktop = (window as { demohunterDesktop?: Desktop }).demohunterDesktop;
/** Other projects (repositories or folders) opened in the desktop app. */
let recentProjects: { path: string; name: string }[] = [];
let home = "";
let showEmptyTrees = false;

/** "" shows the whole project; otherwise one worktree's path. Remembered per
 * project so returning from a demo keeps the view. */
const scopeKey = () => `demohunter.worktree:${data.workspace}`;
let scope: string | undefined;
/** The sidebar (where a scope is chosen) is hidden at this width. */
const narrow = window.matchMedia("(max-width: 860px)");
const currentScope = () => {
  const trees = data.worktrees ?? [];
  // Without the sidebar there is no way to see or change a remembered scope,
  // so the whole project shows instead of an unexplained subset.
  if (trees.length < 2 || narrow.matches) return "";
  scope ??= localStorage.getItem(scopeKey()) ?? "";
  return trees.some((w) => w.path === scope) ? scope! : "";
};
function setScope(value: string) {
  scope = value;
  localStorage.setItem(scopeKey(), value);
  render();
}
const branchLabel = (w: LibraryWorktree) =>
  w.branch ?? (w.head ? `detached ${w.head}` : "detached");
const worktreeOf = (r: { worktree?: string }) =>
  data.worktrees?.find((w) => w.path === r.worktree);
const projectName = () =>
  data.git?.repository ?? data.workspace.split("/").at(-1) ?? "Project";
const visibleRecordings = () =>
  data.recordings.filter((r) => !isTestPath(r.tourPath ?? r.path));

/** "2 new · 1 updated" badges for a set of demos. */
function freshBadges(recordings: LibraryRecording[]) {
  const added = recordings.filter((r) => r.fresh === "new").length,
    updated = recordings.filter((r) => r.fresh === "updated").length;
  const badges: HTMLElement[] = [];
  if (added) badges.push(node("span", `${added} new`, "fresh new"));
  if (updated) badges.push(node("span", `${updated} updated`, "fresh updated"));
  return badges;
}

function renderProjects() {
  const trees = data.worktrees ?? [];
  const show = !!desktop || trees.length > 1;
  document.body.classList.toggle("has-projects", show);
  const nav = $("#projects");
  nav.hidden = !show;
  if (!show) return nav.replaceChildren();
  // Rebuilding the list would drop keyboard focus; remember which control had it.
  const focused = nav.contains(document.activeElement)
    ? (document.activeElement as HTMLElement).dataset.key
    : undefined;
  const active = currentScope();
  const all = visibleRecordings();

  const head = node("div", undefined, "projects-head");
  head.append(node("h2", "Projects"));
  if (desktop) {
    const open = node("button", "Open…", "open-project") as HTMLButtonElement;
    open.type = "button";
    open.dataset.key = "open";
    open.title = "Open a repository or folder (⌘O)";
    open.onclick = () => void desktop.choose();
    head.append(open);
  }

  // The open project, with its worktrees nested when it has more than one.
  const current = node("div", undefined, "project current");
  const row = node("button", undefined, "project-row") as HTMLButtonElement;
  row.type = "button";
  row.dataset.key = "project";
  row.setAttribute("aria-pressed", String(!active));
  row.title = data.workspace;
  row.onclick = () => setScope("");
  const top = node("span", undefined, "row-top");
  top.append(node("span", projectName(), "row-name"));
  top.append(...freshBadges(all));
  if (all.length) top.append(node("span", String(all.length), "row-count"));
  row.append(top);
  if (trees.length < 2 && data.git?.branch)
    row.append(node("span", `⎇ ${data.git.branch}`, "row-sub mono"));
  current.append(row);

  if (trees.length > 1) {
    const list = node("div", undefined, "worktree-list");
    const demosIn = (w: LibraryWorktree) =>
      all.filter((r) => r.worktree === w.path);
    const latest = (w: LibraryWorktree) =>
      demosIn(w).reduce((m, r) => (r.modifiedAt > m ? r.modifiedAt : m), "");
    // Worktrees with demos: new/updated first, then most recently edited.
    const withDemos = trees
      .filter((w) => demosIn(w).length || w.path === active)
      .sort(
        (a, b) =>
          Number(demosIn(b).some((r) => r.fresh)) -
            Number(demosIn(a).some((r) => r.fresh)) ||
          latest(b).localeCompare(latest(a)),
      );
    const empty = trees.filter((w) => !withDemos.includes(w));
    const item = (w: LibraryWorktree) => {
      const demos = demosIn(w);
      const row = node("button", undefined, "worktree") as HTMLButtonElement;
      row.type = "button";
      row.dataset.key = `wt:${w.path}`;
      row.disabled = !!w.missing;
      row.classList.toggle("no-demos", !demos.length);
      row.setAttribute("aria-pressed", String(active === w.path));
      row.onclick = () => setScope(w.path);
      const git = [
        w.changed ? `${w.changed} uncommitted` : "",
        w.ahead ? `${w.ahead} ahead` : "",
        w.behind ? `${w.behind} behind` : "",
      ].filter(Boolean);
      row.title = [
        `${w.name} — ${branchLabel(w)}`,
        w.path,
        w.main ? "main checkout" : "",
        w.current ? "opened here" : "",
        w.missing ? "folder missing" : "",
        git.join(", "),
      ]
        .filter(Boolean)
        .join("\n");
      row.append(node("span", w.name, "wt-name"));
      row.append(node("span", branchLabel(w), "wt-branch mono"));
      if (w.changed) row.append(node("span", "", "wt-dirty"));
      row.append(...freshBadges(demos));
      if (demos.length)
        row.append(node("span", String(demos.length), "row-count"));
      return row;
    };
    list.append(...withDemos.map(item));
    if (empty.length) {
      const more = node(
        "button",
        showEmptyTrees
          ? "Hide empty worktrees"
          : withDemos.length
            ? `+ ${empty.length} without demos`
            : `${empty.length} worktrees, no demos yet`,
        "more-trees",
      ) as HTMLButtonElement;
      more.type = "button";
      more.dataset.key = "more";
      more.onclick = () => {
        showEmptyTrees = !showEmptyTrees;
        render();
      };
      list.append(more);
      if (showEmptyTrees) list.append(...empty.map(item));
    }
    current.append(list);
  }

  // Recent projects from the desktop app; opening one switches to it.
  const others = recentProjects.filter((p) => p.path !== data.workspace);
  const rest = others.map((p) => {
    const item = node(
      "button",
      undefined,
      "project-row other",
    ) as HTMLButtonElement;
    item.type = "button";
    item.dataset.key = `recent:${p.path}`;
    item.title = p.path;
    item.onclick = () => void desktop?.open(p.path);
    item.append(node("span", p.name, "row-name"));
    item.append(
      node(
        "span",
        home && p.path.startsWith(home)
          ? `~${p.path.slice(home.length)}`
          : p.path,
        "row-sub mono row-path",
      ),
    );
    return item;
  });
  nav.replaceChildren(
    head,
    current,
    ...(rest.length ? [node("h3", "Recent", "projects-recent")] : []),
    ...rest,
  );
  if (focused)
    [...nav.querySelectorAll<HTMLElement>("[data-key]")]
      .find((el) => el.dataset.key === focused)
      ?.focus({ preventScroll: true });
}
if (desktop)
  void desktop
    .info()
    .then((info) => {
      home = info.home;
      recentProjects = info.recent;
      render();
    })
    .catch(() => {});

// ------------------------------------------------------------- cards

/** Cards and posters are reused between scans: only a demo whose data
 * changed is rebuilt, and a loaded poster stays on screen until its
 * replacement has loaded — no flashes while polling, hovering or resizing. */
const cards = new Map<string, { sig: string; el: HTMLElement }>();
const posters = new Map<string, HTMLImageElement>();
/** The newest poster URL per demo, so an older load never wins a swap. */
const latest = new Map<string, string>();

function poster(r: LibraryRecording): HTMLImageElement {
  const src = `/projects/${r.id}/poster.png?revision=${r.revision ?? "legacy"}`;
  const current = posters.get(r.id);
  if (current?.dataset.src === src || latest.get(r.id) === src) return current!;
  const img = node("img", undefined, "recording-poster") as HTMLImageElement;
  img.dataset.src = src;
  img.alt = `First frame of ${r.title}`;
  img.decoding = "async";
  img.draggable = false;
  if (current?.classList.contains("loaded")) {
    // Swap in once the new frame is ready, replacing whatever is shown then;
    // a newer revision that started loading meanwhile wins.
    latest.set(r.id, src);
    const next = new Image();
    next.onload = () => {
      if (latest.get(r.id) !== src) return;
      img.src = src;
      img.classList.add("loaded", "instant");
      posters.get(r.id)?.replaceWith(img);
      posters.set(r.id, img);
    };
    // The shown poster stays; forget this attempt so a later render retries.
    next.onerror = () => {
      if (latest.get(r.id) === src) latest.delete(r.id);
    };
    next.src = src;
    return current;
  }
  latest.set(r.id, src);
  img.loading = "lazy";
  img.onload = () => img.classList.add("loaded");
  img.onerror = () => {
    // A transient failure must not stick: drop the entries so the next
    // render builds a fresh poster.
    img.remove();
    if (posters.get(r.id) === img) posters.delete(r.id);
    if (latest.get(r.id) === src) latest.delete(r.id);
  };
  img.src = src;
  posters.set(r.id, img);
  return img;
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
  if (r.fresh === "new") return node("span", "New", "tag fresh-tag");
  if (r.fresh === "updated") return node("span", "Updated", "tag fresh-tag");
}
function card(r: LibraryRecording, showBranch: boolean) {
  const el = node("article", undefined, "recording-card");
  el.dataset.id = r.id;
  const link = node("a", undefined, "recording-art") as HTMLAnchorElement;
  link.href = `/projects/${r.id}/`;
  link.setAttribute("aria-label", `Open ${r.title}`);
  const seen = () => {
    if (r.fresh)
      void fetch("/api/seen", {
        method: "POST",
        body: JSON.stringify({ id: r.id }),
        keepalive: true,
      });
  };
  link.append(poster(r), node("span", clock(r.durationMs), "duration"));
  const body = node("div", undefined, "card-body");
  const top = node("div", undefined, "card-top");
  const title = node("a", r.title, "card-title") as HTMLAnchorElement;
  title.href = link.href;
  link.addEventListener("click", seen);
  title.addEventListener("click", seen);
  top.append(title);
  const tag = status(r);
  if (tag) top.append(tag);
  const meta = node("div", undefined, "card-meta");
  const where = node("div", undefined, "card-where");
  const w = showBranch ? worktreeOf(r) : undefined;
  if (w) {
    const chip = node("span", w.name, "chip mono card-branch");
    chip.title = `${branchLabel(w)} — ${w.path}`;
    where.append(chip);
  }
  const path = node(
    "code",
    r.tourPath ?? `${r.path}${r.sourceTour ? "" : " · built-in sample"}`,
    "card-path",
  );
  path.title = r.worktree ? `${r.worktree}/${r.path}` : r.path;
  where.append(path);
  const when = node("span", ago(r.modifiedAt), "card-when");
  when.dataset.at = r.modifiedAt;
  meta.append(where, when);
  body.append(top, meta);
  if (r.error) body.append(node("p", r.error, "recording-error"));
  el.append(link, body);
  return el;
}

function render() {
  const q = $<HTMLInputElement>("#search").value.toLowerCase().trim();
  const active = currentScope();
  const tree = data.worktrees?.find((w) => w.path === active);
  $("#repo-name").textContent =
    data.git?.repository ?? data.workspace.split("/").at(-1) ?? "Workspace";
  const branch = tree
    ? branchLabel(tree)
    : data.worktrees && data.worktrees.length > 1
      ? undefined
      : data.git?.branch;
  $("#branch").hidden = !branch;
  $("#branch").textContent = branch ? `⎇ ${branch}` : "";
  $("#warnings").hidden = !data.warnings.length;
  $("#warnings").textContent = data.warnings.join(" · ");
  renderProjects();
  const recordings = data.recordings.filter(
    (r) =>
      !isTestPath(r.tourPath ?? r.path) && (!active || r.worktree === active),
  );
  const showBranch = !active && (data.worktrees?.length ?? 0) > 1;
  const shown = recordings
    .filter((r) => {
      const w = worktreeOf(r);
      return (
        !q ||
        `${r.title} ${r.path} ${r.tourPath ?? ""} ${w?.branch ?? ""} ${w?.name ?? ""}`
          .toLowerCase()
          .includes(q)
      );
    })
    .sort(
      (a, b) =>
        b.modifiedAt.localeCompare(a.modifiedAt) || a.id.localeCompare(b.id),
    );
  const els = shown.map((r) => {
    // Only what the card shows: git counts arriving in the background must
    // not rebuild it.
    const w = worktreeOf(r);
    const sig = JSON.stringify([r, showBranch, w && [w.name, branchLabel(w), w.path]]);
    const hit = cards.get(r.id);
    if (hit?.sig === sig) {
      // Reused cards still keep their relative time current.
      const when = hit.el.querySelector(".card-when");
      const text = ago(r.modifiedAt);
      if (when && when.textContent !== text) when.textContent = text;
      // A poster that failed to load is retried on the next render.
      const art = hit.el.querySelector(".recording-art");
      const img = poster(r);
      if (art && !art.contains(img)) {
        // One poster per card: drop any stale one before adding the new.
        art.querySelectorAll(".recording-poster").forEach((old) => old.remove());
        art.prepend(img);
      }
      return hit.el;
    }
    const el = card(r, showBranch);
    if (hit) hit.el.replaceWith(el);
    cards.set(r.id, { sig, el });
    return el;
  });
  const grid = $("#recordings");
  // Reorder only when the order actually changed.
  if (
    grid.children.length !== els.length ||
    els.some((el, i) => grid.children[i] !== el)
  )
    grid.replaceChildren(...els);
  for (const id of cards.keys())
    if (!data.recordings.some((r) => r.id === id)) {
      cards.delete(id);
      posters.delete(id);
      latest.delete(id);
    }
  $("#empty").hidden = shown.length > 0;
  const tours = (data.tours ?? []).filter(
    (t) => !isTestPath(t.path) && (!active || t.worktree === active),
  );
  $("#empty-title").textContent = recordings.length
    ? "No matches"
    : tree
      ? `No demos in ${tree.name}`
      : "No demos yet";
  // The same tour in several worktrees counts once.
  const uniqueTours = new Set(tours.map((t) => t.path)).size;
  $("#empty-detail").hidden = recordings.length > 0 || !tours.length;
  $("#empty-detail").textContent = tours.length
    ? `${uniqueTours} tour${uniqueTours === 1 ? "" : "s"} here, not captured yet. Capture one:`
    : "";
  $("#empty-command").hidden = recordings.length > 0;
  $("#empty-open").hidden = !desktop || recordings.length > 0;
  const quote = (p: string) =>
    /^[\w./-]+$/.test(p) ? p : `'${p.replaceAll("'", "'\\''")}'`;
  // Prefer a tour in the folder Studio was opened on; another worktree's
  // tour needs a cd first.
  const suggested =
    tours.find((t) => !t.worktree || t.worktree === data.workspace) ?? tours[0];
  const tourRoot = suggested?.worktree;
  $("#empty-command").textContent = suggested
    ? `${tourRoot && tourRoot !== data.workspace ? `cd ${quote(tourRoot)} && ` : ""}bun run studio capture ${quote(suggested.path)}`
    : "bun run studio capture <tour.ts>";
}

async function refresh() {
  if (loading) return;
  loading = true;
  try {
    const res = await fetch("/api/library");
    if (!res.ok)
      throw new Error("Unable to read the workspace. Retry refresh.");
    const text = await res.text();
    $("#loading").hidden = true;
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
if (
  "demohunterDesktop" in window ||
  "__TAURI__" in window ||
  "__TAURI_INTERNALS__" in window
)
  document.body.classList.add("desktop");
// In the desktop app the project name also opens another project.
if (desktop) {
  $("#empty-open").onclick = () => void desktop.choose();
  const name = $("#repo-name");
  name.classList.add("switch");
  name.title = "Open another repository or folder (⌘O)";
  name.tabIndex = 0;
  name.setAttribute("role", "button");
  name.onclick = () => void desktop.choose();
  name.onkeydown = (e) => void (e.key === "Enter" && desktop.choose());
}
$("#search").oninput = render;
narrow.addEventListener("change", render);
// "Edited 5 min ago" keeps moving even when the demos themselves do not.
const refreshAgo = () => {
  for (const when of document.querySelectorAll<HTMLElement>(".card-when")) {
    const text = ago(when.dataset.at ?? "");
    if (when.dataset.at && when.textContent !== text) when.textContent = text;
  }
};
setInterval(refreshAgo, 60_000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshAgo();
});
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
