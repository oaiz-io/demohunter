/** UI disclosure/focus behavior, independent of replay and project state. */
export function initializeShell() {
  const $ = <T extends HTMLElement = HTMLElement>(s: string) =>
    document.querySelector<T>(s)!;
  const menu = $<HTMLDetailsElement>("#project-menu"),
    help = $<HTMLDialogElement>("#help-dialog"),
    drawer = $("#scene-drawer");
  $("#timeline-toggle").onclick = () => {
    drawer.showPopover();
    $<HTMLDetailsElement>("#element-details").open = true;
    $("#element-search").focus();
  };
  $("#help-open").onclick = () => help.showModal();
  $("#help-close").onclick = () => help.close();
  for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog")) {
    // A drag that starts inside (selecting text) and ends on the backdrop
    // must not dismiss the dialog.
    let downOnBackdrop = false;
    dialog.addEventListener("pointerdown", (e) => {
      downOnBackdrop = e.target === dialog;
    });
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog && downOnBackdrop) {
        const r = dialog.getBoundingClientRect();
        if (
          e.clientX < r.left ||
          e.clientX > r.right ||
          e.clientY < r.top ||
          e.clientY > r.bottom
        )
          dialog.close();
      }
      downOnBackdrop = false;
    });
  }
  menu.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".menu-content>button"))
      menu.open = false;
  });
  document.addEventListener("pointerdown", (e) => {
    if (!menu.contains(e.target as Node)) menu.open = false;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menu.open) {
      e.stopImmediatePropagation();
      menu.open = false;
      menu.querySelector<HTMLElement>("summary")!.focus();
    }
  });
  drawer.addEventListener("toggle", () =>
    $("#scenes-toggle").setAttribute(
      "aria-expanded",
      String(drawer.matches(":popover-open")),
    ),
  );
  drawer.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".scene-button,.layer-button"))
      drawer.hidePopover();
  });
}
