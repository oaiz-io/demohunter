import { elementKey, type ElementEdit } from "../element-edit.js";
type Styled = HTMLElement | SVGElement;
type StyleUndo = {
  node: Styled;
  name: string;
  value: string;
  priority: string;
  applied: string;
};
type TextUndo = {
  node: Node;
  value: string | null;
  applied: string;
  added?: boolean;
};

/** Reversible DOM changes; preserve rrweb's mirrored nodes and scene animations. */
export class ElementOverrides {
  private styles: StyleUndo[] = [];
  private texts: TextUndo[] = [];
  restore(): void {
    for (const u of this.styles.reverse()) {
      if (
        u.node.style.getPropertyValue(u.name) === u.applied &&
        u.node.style.getPropertyPriority(u.name) === "important"
      )
        u.node.style.setProperty(u.name, u.value, u.priority);
    }
    for (const u of this.texts.reverse())
      if (u.node.nodeValue === u.applied) {
        if (u.added) u.node.parentNode?.removeChild(u.node);
        else u.node.nodeValue = u.value;
      }
    this.styles = [];
    this.texts = [];
  }
  private style(node: Styled, name: string, value: string): void {
    const undo = {
      node,
      name,
      value: node.style.getPropertyValue(name),
      priority: node.style.getPropertyPriority(name),
      applied: "",
    };
    node.style.setProperty(name, value, "important");
    undo.applied = node.style.getPropertyValue(name);
    this.styles.push(undo);
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
    for (const edit of combined.values())
      for (const element of find(edit.target)) {
        const node = element as Styled,
          doc = node.ownerDocument;
        if (!node.style) continue;
        if (edit.text !== undefined) {
          const walker = doc.createTreeWalker(node, 4),
            leaves: Node[] = [];
          let leaf: Node | null;
          while ((leaf = walker.nextNode()))
            if (!leaf.parentElement?.closest("script,style,noscript"))
              leaves.push(leaf);
          if (!leaves.length) {
            const leaf = doc.createTextNode(edit.text);
            node.append(leaf);
            this.texts.push({
              node: leaf,
              value: null,
              applied: edit.text,
              added: true,
            });
          } else
            leaves.forEach((leaf, i) => {
              const text = i === 0 ? edit.text! : "";
              this.texts.push({
                node: leaf,
                value: leaf.nodeValue,
                applied: text,
              });
              if (leaf.nodeValue !== text) leaf.nodeValue = text;
            });
        }
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
