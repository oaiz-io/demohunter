/**
 * Markdown for agent replies, rendered safely: the DOM is built with
 * createElement and textContent only, never innerHTML, so whatever an agent
 * (or a prompt-injected page it read) writes stays text. Links open only for
 * https (what the desktop app opens). Every pattern is bounded and long lines
 * are left as text, so no reply can stall rendering. Supported: paragraphs, headings, lists (one nested
 * level), quotes, fenced code, tables, rules, **bold**, *italic*, ~~strike~~,
 * `code` and [links](https://…).
 */

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};

const SAFE_URL = /^https:\/\//i;
// Earliest match wins; bold before italic so ** isn't read as two *. Every
// part is length-bounded and backtick runs are fixed (` or ``), so matching
// stays linear-ish even on hostile input.
const INLINE =
  /``([^`\n]{1,400}?)``|`([^`\n]{1,400})`|\*\*(?=\S)([^\n]{0,400}?\S)\*\*|__(?=\S)([^\n]{0,400}?\S)__|~~(?=\S)([^\n]{0,400}?\S)~~|\*(?=[^\s*])([^*\n]{0,400}?[^\s*])\*|(?<![\p{L}\p{N}_])_(?=[^\s_])([^_\n]{0,400}?[^\s_])_(?![\p{L}\p{N}_])|\[([^\]\n]{1,200})\]\(\s*(\S{1,800}?)\s*\)/gu;
/** Lines longer than this are shown as plain text. */
const MAX_INLINE = 4000;

/** Inline Markdown into `parent`. */
export function inline(text: string, parent: Node): void {
  if (text.length > MAX_INLINE) {
    parent.appendChild(document.createTextNode(text));
    return;
  }
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    last = m.index! + m[0].length;
    if (m[1] !== undefined || m[2] !== undefined) parent.appendChild(el("code", (m[1] ?? m[2])!.replace(/^ (.*) $/s, "$1")));
    else if (m[3] !== undefined || m[4] !== undefined) {
      const strong = el("strong");
      inline((m[3] ?? m[4])!, strong);
      parent.appendChild(strong);
    } else if (m[5] !== undefined) {
      const del = el("del");
      inline(m[5], del);
      parent.appendChild(del);
    } else if (m[6] !== undefined || m[7] !== undefined) {
      const em = el("em");
      inline((m[6] ?? m[7])!, em);
      parent.appendChild(em);
    } else if (m[8] !== undefined) {
      const url = m[9]!;
      if (SAFE_URL.test(url)) {
        const a = el("a");
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        inline(m[8], a);
        parent.appendChild(a);
      } else parent.appendChild(document.createTextNode(m[0]));
    }
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

const startsBlock = (line: string, next: string | undefined) =>
  /^\s*(```|~~~)/.test(line) ||
  /^#{1,6}\s/.test(line) ||
  /^\s*>/.test(line) ||
  /^\s*([-*_])(\s*\1){2,}\s*$/.test(line) ||
  (line.includes("|") && next !== undefined && TABLE_RULE.test(next));

/** Block Markdown into a fragment. Quotes nest at most six deep. */
export function renderMarkdown(source: string, depth = 0): DocumentFragment {
  const out = document.createDocumentFragment();
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      // Closed only by a bare fence line (```js inside the block is content).
      while (i < lines.length && lines[i]!.trim() !== fence[1]) body.push(lines[i++]!);
      i++;
      const pre = el("pre");
      const code = el("code", body.join("\n"));
      if (fence[2]) code.dataset.lang = fence[2];
      pre.appendChild(code);
      out.appendChild(pre);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (heading) {
      // Replies live in a narrow panel: headings stay small.
      const h = el(heading[1]!.length <= 2 ? "h3" : "h4");
      inline(heading[2]!, h);
      out.appendChild(h);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.appendChild(el("hr"));
      i++;
      continue;
    }
    if (/^\s*>/.test(line) && depth < 6) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) quote.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      const block = el("blockquote");
      block.appendChild(renderMarkdown(quote.join("\n"), depth + 1));
      out.appendChild(block);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]!)) {
      const table = el("table");
      const head = el("tr");
      for (const c of cells(line)) {
        const th = el("th");
        inline(c, th);
        head.appendChild(th);
      }
      table.appendChild(el("thead")).appendChild(head);
      const tbody = table.appendChild(el("tbody"));
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) {
        const tr = el("tr");
        for (const c of cells(lines[i++]!)) {
          const td = el("td");
          inline(c, td);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      const wrap = el("div");
      wrap.className = "md-table";
      wrap.appendChild(table);
      out.appendChild(wrap);
      continue;
    }
    const item = LIST.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2]!);
      const list = el(ordered ? "ol" : "ul");
      if (ordered && item[2] !== "1." && item[2] !== "1)") list.setAttribute("start", String(parseInt(item[2]!, 10)));
      const base = item[1]!.length;
      let li: HTMLLIElement | undefined;
      let nested: HTMLElement | undefined;
      while (i < lines.length) {
        const m = LIST.exec(lines[i]!);
        if (m && m[1]!.length <= base + 1) {
          li = el("li");
          inline(m[3]!, li);
          list.appendChild(li);
          nested = undefined;
        } else if (m && li) {
          // One nested level.
          if (!nested) {
            nested = el(/\d/.test(m[2]!) ? "ol" : "ul");
            li.appendChild(nested);
          }
          const sub = el("li");
          inline(m[3]!, sub);
          nested.appendChild(sub);
        } else if (li && lines[i]!.trim() && /^\s{2,}\S/.test(lines[i]!)) {
          // A continuation line of the item.
          li.appendChild(document.createTextNode(" "));
          inline(lines[i]!.trim(), li);
        } else break;
        i++;
      }
      out.appendChild(list);
      continue;
    }
    // A paragraph: up to a blank line or the next block. Single line breaks stay.
    const p = el("p");
    let first = true;
    while (i < lines.length && lines[i]!.trim()) {
      const next = lines[i]!;
      if (!first && (LIST.test(next) || startsBlock(next, lines[i + 1]))) break;
      if (!first) p.appendChild(el("br"));
      inline(next.trim(), p);
      first = false;
      i++;
    }
    out.appendChild(p);
  }
  return out;
}
