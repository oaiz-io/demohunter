const api = window.demohunterDesktop;
const ago = (t) => {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
(async () => {
  const info = await api.info();
  document.getElementById("version").textContent = `Version ${info.version}`;
  const list = document.getElementById("recent");
  if (!info.recent.length) {
    document.getElementById("recents").innerHTML =
      '<p class="empty">Open a repository to see the demos in all of its worktrees,<br>or any folder with captured demos. You can also drop it on this window.</p>';
  }
  for (const repo of info.recent) {
    const li = document.createElement("li");
    li.tabIndex = 0;
    li.innerHTML = `<span class="glyph"></span><span class="name"></span><span class="when"></span><span class="path mono"></span>`;
    li.querySelector(".glyph").textContent = repo.name.slice(0, 1);
    li.querySelector(".name").textContent = repo.name;
    li.querySelector(".when").textContent = repo.openedAt ? ago(repo.openedAt) : "";
    li.querySelector(".path").textContent = repo.path.replace(info.home, "~");
    li.title = repo.path;
    li.onclick = () => api.open(repo.path);
    li.onkeydown = (e) => e.key === "Enter" && api.open(repo.path);
    list.append(li);
  }
  document.getElementById("open").onclick = () => api.choose();
})();
// Drop a folder onto the window to open it.
addEventListener("dragover", (e) => {
  e.preventDefault();
  document.body.classList.add("dragging");
});
addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) document.body.classList.remove("dragging");
});
addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("dragging");
  const file = e.dataTransfer?.files?.[0];
  if (file) api.openDropped(file);
});
