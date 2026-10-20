/**
 * A styled dropdown over a native <select>: a button showing the choice and a
 * menu of options (with their descriptions). The <select> stays the source
 * of truth — it keeps its value and fires `change` — and is only hidden, so
 * code that fills or reads it is unchanged.
 */
const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};

let close: (() => void) | undefined;

export function menuSelect(select: HTMLSelectElement): void {
  select.classList.add("menu-select-native");
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");
  const button = make("button", "menu-select") as HTMLButtonElement;
  button.type = "button";
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  const label = make("span", "menu-select-label");
  button.append(label, make("span", "menu-select-chevron"));
  select.after(button);

  const sync = () => {
    const current = select.selectedOptions[0];
    label.textContent = current?.textContent ?? "";
    button.title = select.title || current?.title || "";
    button.disabled = select.disabled;
    button.setAttribute("aria-label", select.getAttribute("aria-label") ?? "");
  };
  sync();
  // Studio refills the options and changes the choice from code.
  new MutationObserver(sync).observe(select, { childList: true, subtree: true, attributes: true, characterData: true });
  select.addEventListener("change", sync);

  const open = () => {
    close?.();
    const menu = make("div", "menu-select-menu");
    menu.setAttribute("role", "listbox");
    const items = [...select.options].map((option) => {
      const item = make("button", "menu-select-item") as HTMLButtonElement;
      item.type = "button";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(option.selected));
      item.append(make("span", "menu-select-check", option.selected ? "✓" : ""));
      const text = make("span", "menu-select-text");
      text.append(make("span", "menu-select-name", option.textContent ?? ""));
      if (option.title) text.append(make("span", "menu-select-detail", option.title));
      item.append(text);
      item.onclick = () => {
        done();
        if (select.value === option.value) return;
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        sync();
      };
      return item;
    });
    menu.append(...items);
    document.body.append(menu);
    // Fixed under the button, so no scrolling panel clips it.
    const r = button.getBoundingClientRect();
    menu.style.minWidth = `${Math.max(r.width, 180)}px`;
    menu.style.left = `${Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)}px`;
    const below = window.innerHeight - r.bottom - 8;
    if (below < Math.min(menu.offsetHeight, 240) && r.top > below) menu.style.bottom = `${window.innerHeight - r.top + 4}px`;
    else menu.style.top = `${r.bottom + 4}px`;
    button.setAttribute("aria-expanded", "true");
    (items.find((i) => i.getAttribute("aria-selected") === "true") ?? items[0])?.focus();
    const outside = (e: PointerEvent) => {
      if (!menu.contains(e.target as Node) && e.target !== button && !button.contains(e.target as Node)) done();
    };
    const keys = (e: KeyboardEvent) => {
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "Escape") {
        e.preventDefault();
        done();
        button.focus();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = at < 0 ? (e.key === "ArrowDown" ? 0 : items.length - 1) : (at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
        items[next]?.focus();
      } else if (e.key === "Tab") {
        // Back to the button first, so focus doesn't fall to the page.
        button.focus();
        done();
      }
    };
    const done = () => {
      menu.remove();
      button.setAttribute("aria-expanded", "false");
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", keys, true);
      window.removeEventListener("blur", done);
      window.removeEventListener("resize", done);
      document.removeEventListener("scroll", onScroll, true);
      if (close === done) close = undefined;
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", keys, true);
    // Scrolling the panel underneath would leave the fixed menu behind.
    const onScroll = (e: Event) => {
      if (!menu.contains(e.target as Node)) done();
    };
    window.addEventListener("blur", done);
    window.addEventListener("resize", done);
    document.addEventListener("scroll", onScroll, true);
    close = done;
  };
  button.onclick = () => (button.getAttribute("aria-expanded") === "true" ? close?.() : open());
  button.onkeydown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      open();
    }
  };
}
