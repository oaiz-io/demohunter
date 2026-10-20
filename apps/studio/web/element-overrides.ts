import { elementKey, type ElementEdit } from "../element-edit.js";
type Styled = HTMLElement | SVGElement;
type StyleUndo = {
  node: Styled;
  name: string;
  value: string;
  priority: string;
  applied: string;
  /** The style attribute before the first override, to leave no residue. */
  attribute: string | null;
};
type TextUndo = {
  node: Node;
  value: string | null;
  applied: string;
  added?: boolean;
};
type ValueUndo = {
  node: HTMLInputElement | HTMLTextAreaElement;
  value: string;
  applied: string;
  attribute: string | null;
};
/** Input types whose value is the text the field shows. */
const textInputs = new Set([
  "",
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "submit",
  "button",
  "reset",
]);
/** A recorded or authored field whose displayed value is editable text. */
export function isTextField(
  node: Element,
): node is HTMLInputElement | HTMLTextAreaElement {
  if (node.localName === "textarea") return true;
  return (
    node.localName === "input" &&
    textInputs.has((node.getAttribute("type") ?? "").toLowerCase())
  );
}

/** Keep/delete flags for `source` and insertions before each position. */
function diff(
  source: string,
  text: string,
): { keep: boolean[]; inserts: string[] } {
  const keep = new Array<boolean>(source.length).fill(false),
    inserts = new Array<string>(source.length + 1).fill("");
  let prefix = 0;
  while (
    prefix < source.length &&
    prefix < text.length &&
    source[prefix] === text[prefix]
  )
    keep[prefix++] = true;
  let suffix = 0;
  while (
    suffix < source.length - prefix &&
    suffix < text.length - prefix &&
    source[source.length - 1 - suffix] === text[text.length - 1 - suffix]
  ) {
    keep[source.length - 1 - suffix] = true;
    suffix++;
  }
  const a = source.slice(prefix, source.length - suffix),
    b = text.slice(prefix, text.length - suffix),
    n = a.length,
    m = b.length;
  if (n * m > 250_000) {
    // Large rewrites: one replacement, as a whole-text edit always did.
    inserts[prefix] = b;
    return { keep, inserts };
  }
  // Longest common subsequence of the changed middle.
  const table = new Uint16Array((n + 1) * (m + 1)),
    at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[at(i, j)] =
        a[i] === b[j]
          ? table[at(i + 1, j + 1)]! + 1
          : Math.max(table[at(i + 1, j)]!, table[at(i, j + 1)]!);
  let i = 0,
    j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      keep[prefix + i++] = true;
      j++;
    } else if (
      j < m &&
      (i >= n || table[at(i, j + 1)]! >= table[at(i + 1, j)]!)
    )
      inserts[prefix + i] += b[j++];
    else i++;
  }
  return { keep, inserts };
}

/**
 * New text for each text node so that together they read `text`. Unchanged
 * characters stay in their own node and each changed run goes to the node it
 * replaces, so formatting such as the `<b>` in `<p>Hello <b>world</b></p>`
 * survives an edit to the paragraph. `fixed` nodes (line breaks) only keep
 * or lose their character.
 */
export function distributeText(
  values: string[],
  text: string,
  fixed: boolean[] = [],
): string[] {
  // Overrides are re-applied on every frame with the same inputs; the diff
  // is quadratic, so remember recent results.
  const key = JSON.stringify([values, text, fixed]);
  const known = distributed.get(key);
  if (known) return [...known];
  const result = distribute(values, text, fixed);
  if (distributed.size >= 200) distributed.clear();
  distributed.set(key, result);
  return [...result];
}
const distributed = new Map<string, string[]>();
function distribute(
  values: string[],
  text: string,
  fixed: boolean[],
): string[] {
  const source = values.join(""),
    { keep, inserts } = diff(source, text),
    owners: number[] = [];
  values.forEach((value, leaf) => {
    for (let k = 0; k < value.length; k++) owners.push(leaf);
  });
  const usable = (leaf: number, step: number) => {
    while (leaf >= 0 && leaf < values.length && fixed[leaf]) leaf += step;
    return leaf >= 0 && leaf < values.length ? leaf : -1;
  };
  const result = values.map(() => "");
  for (let k = 0; k <= source.length; k++) {
    if (inserts[k]) {
      // A replacement takes the formatting of the first character it
      // replaces; a pure insertion continues the text before it.
      const replaced = k < source.length && !keep[k];
      let leaf = replaced
        ? owners[k]!
        : k > 0
          ? owners[k - 1]!
          : (owners[0] ?? 0);
      leaf = usable(leaf, -1);
      if (leaf < 0)
        leaf = usable(
          replaced || k === 0 ? (owners[k] ?? 0) : owners[k - 1]!,
          1,
        );
      result[leaf < 0 ? 0 : leaf] += inserts[k];
    }
    if (k < source.length && keep[k]) result[owners[k]!] += source[k];
  }
  return result;
}

/** Reversible DOM changes; preserve rrweb's mirrored nodes and scene animations. */
export class ElementOverrides {
  private styles: StyleUndo[] = [];
  private texts: TextUndo[] = [];
  private values: ValueUndo[] = [];
  restore(): void {
    for (const u of this.styles.reverse()) {
      if (
        u.node.style.getPropertyValue(u.name) === u.applied &&
        u.node.style.getPropertyPriority(u.name) === "important"
      ) {
        u.node.style.setProperty(u.name, u.value, u.priority);
        if (u.attribute === null && u.node.getAttribute("style") === "")
          u.node.removeAttribute("style");
      }
    }
    for (const u of this.texts.reverse())
      if (u.node.nodeValue === u.applied) {
        if (u.added) u.node.parentNode?.removeChild(u.node);
        else u.node.nodeValue = u.value;
      }
    // A recorded input event that changed the value since wins until the
    // override is applied again.
    for (const u of this.values.reverse())
      if (u.node.value === u.applied) {
        u.node.value = u.value;
        if (
          u.node.localName === "input" &&
          u.node.getAttribute("value") === u.applied
        )
          if (u.attribute === null) u.node.removeAttribute("value");
          else u.node.setAttribute("value", u.attribute);
      }
    this.styles = [];
    this.texts = [];
    this.values = [];
  }
  private style(node: Styled, name: string, value: string): void {
    const undo = {
      node,
      name,
      value: node.style.getPropertyValue(name),
      priority: node.style.getPropertyPriority(name),
      applied: "",
      attribute: node.getAttribute("style"),
    };
    node.style.setProperty(name, value, "important");
    undo.applied = node.style.getPropertyValue(name);
    this.styles.push(undo);
  }
  private text(node: Element, text: string): void {
    const doc = node.ownerDocument;
    if (isTextField(node)) {
      const undo: ValueUndo = {
        node,
        value: node.value,
        applied: text,
        attribute: node.getAttribute("value"),
      };
      // The attribute keeps standalone snapshots (lift, agent HTML) in step.
      if (node.localName === "input") node.setAttribute("value", text);
      if (node.value !== text) node.value = text;
      undo.applied = node.value;
      this.values.push(undo);
      if (node.localName === "input") return;
    }
    // Text nodes and line breaks, in reading order.
    const walker = doc.createTreeWalker(node, 1 | 4),
      leaves: Node[] = [];
    let leaf: Node | null;
    while ((leaf = walker.nextNode()))
      if (
        (leaf.nodeType === 3 || (leaf as Element).localName === "br") &&
        !(
          leaf.nodeType === 3 ? leaf.parentElement : (leaf as Element)
        )?.closest("script,style,noscript")
      )
        leaves.push(leaf);
    if (!leaves.some((leaf) => leaf.nodeType === 3)) {
      const leaf = doc.createTextNode(text);
      node.append(leaf);
      this.texts.push({ node: leaf, value: null, applied: text, added: true });
      return;
    }
    const breaks = leaves.map((leaf) => leaf.nodeType === 1);
    const next = distributeText(
      leaves.map((leaf, i) => (breaks[i] ? "\n" : (leaf.nodeValue ?? ""))),
      text,
      breaks,
    );
    leaves.forEach((leaf, i) => {
      if (breaks[i]) {
        // A removed line break; the typed text carries its own.
        if (!next[i]) this.style(leaf as HTMLElement, "display", "none");
        return;
      }
      this.texts.push({ node: leaf, value: leaf.nodeValue, applied: next[i]! });
      if (leaf.nodeValue !== next[i]) leaf.nodeValue = next[i]!;
    });
  }
  apply(
    edits: ElementEdit[],
    find: (target: ElementEdit["target"]) => Element[],
  ): void {
    const combined = new Map<string, ElementEdit>();
    for (const edit of edits) {
      const key = elementKey(edit.target),
        old = combined.get(key);
      combined.set(key, {
        ...old,
        ...edit,
        style: { ...old?.style, ...edit.style },
        transform: edit.transform ?? old?.transform,
      });
    }
    // Ancestors first: a nested element's own text edit wins over the text
    // its paragraph or button was given.
    const depth = (node: Node) => {
      let n = 0;
      for (let p = node.parentNode; p; p = p.parentNode) n++;
      return n;
    };
    const targets = [...combined.values()]
      .flatMap((edit) =>
        find(edit.target).map((element) => ({ edit, element })),
      )
      .map((item) => ({ ...item, depth: depth(item.element) }))
      .sort((a, b) => a.depth - b.depth);
    for (const { edit, element } of targets) {
      const node = element as Styled,
        doc = node.ownerDocument;
      if (!node.style) continue;
      if (edit.text !== undefined) this.text(node, edit.text);
      if (edit.hidden) this.style(node, "visibility", "hidden");
      for (const [name, value] of Object.entries(edit.style ?? {}))
        this.style(node, name, value);
      if (edit.transform) {
        const { x, y, scaleX, scaleY } = edit.transform;
        // CSS transforms do not apply to normal inline HTML text.
        if (
          node.namespaceURI === "http://www.w3.org/1999/xhtml" &&
          doc.defaultView!.getComputedStyle(node).display === "inline"
        )
          this.style(node, "display", "inline-block");
        const base = doc.defaultView!.getComputedStyle(node).transform;
        this.style(
          node,
          "transform",
          `translate(${x}px, ${y}px) ${base === "none" ? "" : base} scale(${scaleX}, ${scaleY})`,
        );
      }
    }
  }
}
