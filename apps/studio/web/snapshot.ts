/**
 * Lift: copy a recorded element, as it looks at this moment, into standalone
 * HTML with inline computed styles, so a scene can pick it up and animate it
 * while it looks pixel-identical to the page underneath.
 */
const PROPS = [
  "display",
  "position",
  "box-sizing",
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "top",
  "right",
  "bottom",
  "left",
  "z-index",
  "flex",
  "flex-direction",
  "flex-wrap",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "align-items",
  "align-self",
  "align-content",
  "justify-content",
  "justify-items",
  "justify-self",
  "order",
  "gap",
  "row-gap",
  "column-gap",
  "grid-template-columns",
  "grid-template-rows",
  "grid-column",
  "grid-row",
  "grid-auto-flow",
  "place-items",
  "overflow-x",
  "overflow-y",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-variant-numeric",
  "font-feature-settings",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-align",
  "text-transform",
  "text-decoration-line",
  "text-decoration-color",
  "text-overflow",
  "white-space",
  "word-break",
  "color",
  "opacity",
  "visibility",
  "background-color",
  "background-image",
  "background-size",
  "background-position",
  "background-repeat",
  "background-clip",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-style",
  "border-right-style",
  "border-bottom-style",
  "border-left-style",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
  "outline-style",
  "outline-width",
  "outline-color",
  "box-shadow",
  "transform",
  "transform-origin",
  "filter",
  "backdrop-filter",
  "object-fit",
  "object-position",
  "vertical-align",
  "list-style-type",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "cursor",
  "aspect-ratio",
  "-webkit-text-fill-color",
  "-webkit-background-clip",
];

export type Snapshot = {
  html: string;
  rect: { x: number; y: number; width: number; height: number };
  fontsCss: string;
};

function styleText(style: CSSStyleDeclaration): string {
  let text = "";
  for (const prop of PROPS) {
    const value = style.getPropertyValue(prop);
    if (value) text += `${prop}:${value};`;
  }
  return text;
}

const unsafeTags = new Set([
  "script",
  "noscript",
  "template",
  "style",
  "link",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "base",
  "meta",
  "portal",
  // Raw-text elements serialise their text unescaped, so recorded text like
  // "</xmp><img onerror=…>" would become markup when the file is parsed.
  "xmp",
  "noembed",
  "noframes",
  "plaintext",
]);
const droppedAttributes = new Set([
  "id",
  "class",
  "href",
  "xlink:href",
  "srcset",
  "srcdoc",
  "action",
  "formaction",
  "ping",
  "nonce",
]);

function copy(source: Element, view: Window): Element | undefined {
  const tag = source.tagName.toLowerCase();
  // Recorded pages are third-party content and lifted copies run inside
  // scene pages: keep markup and computed style, never anything executable.
  if (unsafeTags.has(tag)) return undefined;
  const style = view.getComputedStyle(source);
  if (style.display === "none") return undefined;
  const clone = source.cloneNode(false) as Element;
  for (const attribute of [...clone.attributes]) {
    const name = attribute.name.toLowerCase();
    if (
      name.startsWith("on") ||
      droppedAttributes.has(name) ||
      /^\s*(javascript|vbscript)\s*:|^\s*data:text\/html/i.test(attribute.value)
    )
      clone.removeAttribute(attribute.name);
  }
  clone.setAttribute("style", styleText(style));
  const pseudo = (which: "::before" | "::after") => {
    const p = view.getComputedStyle(source, which);
    if (!p.content || p.content === "none" || p.content === "normal")
      return undefined;
    const span = source.ownerDocument.createElement("span");
    span.setAttribute("style", styleText(p));
    if (!/^(url|counter|attr)\(/.test(p.content))
      span.textContent = p.content.replace(/^["']|["']$/g, "");
    return span;
  };
  const before = pseudo("::before");
  if (before) clone.append(before);
  for (const child of source.childNodes) {
    if (child.nodeType === 3) clone.append(child.cloneNode());
    else if (child.nodeType === 1) {
      const next = copy(child as Element, view);
      if (next) clone.append(next);
    }
  }
  const after = pseudo("::after");
  if (after) clone.append(after);
  return clone;
}

/** Snapshot `element` from the replay document; rect is in replay viewport px. */
/** Parse the serialised copy again (inertly) and strip anything executable
 * that only appears after a parse round trip; the file is what scenes load. */
function inert(html: string): string {
  const parsed = new DOMParser().parseFromString(`<body>${html}`, "text/html");
  for (const node of parsed.body.querySelectorAll("*")) {
    if (unsafeTags.has(node.localName)) {
      node.remove();
      continue;
    }
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      if (
        name.startsWith("on") ||
        droppedAttributes.has(name) ||
        /^\s*(javascript|vbscript)\s*:|^\s*data:text\/html/i.test(attribute.value)
      )
        node.removeAttribute(attribute.name);
    }
  }
  return parsed.body.innerHTML;
}

export function snapshotElement(element: Element): Snapshot {
  const doc = element.ownerDocument,
    view = doc.defaultView!;
  const rect = element.getBoundingClientRect();
  const clone = copy(element, view) as HTMLElement;
  clone.style.position = "absolute";
  clone.style.left = "0px";
  clone.style.top = "0px";
  clone.style.margin = "0";
  clone.style.width = `${rect.width}px`;
  clone.style.height = `${rect.height}px`;
  clone.style.transform = "none";
  const fonts: string[] = [];
  for (const sheet of doc.styleSheets)
    try {
      for (const rule of sheet.cssRules)
        if (rule instanceof view.CSSFontFaceRule) fonts.push(rule.cssText);
    } catch {
      /* Cross-origin sheet; captured pages inline theirs. */
    }
  return {
    html: inert(clone.outerHTML),
    rect: {
      x: Math.round(rect.x * 10) / 10,
      y: Math.round(rect.y * 10) / 10,
      width: Math.round(rect.width * 10) / 10,
      height: Math.round(rect.height * 10) / 10,
    },
    fontsCss: [...new Set(fonts)].join("\n"),
  };
}
