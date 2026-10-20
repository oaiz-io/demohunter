import { createHash } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { readFormat } from "./format.js";
import {
  atomicWrite,
  ensureRealFolders,
  writeJson,
  safeFile,
  readProjectFile,
} from "./storage.js";

export type CapturedNode = {
  id: number;
  type: number;
  tagName?: string;
  textContent?: string;
  attributes?: Record<string, string | number | boolean | null>;
  childNodes?: CapturedNode[];
};
export type ElementRecord = {
  ref: string;
  documentId: number;
  nodeId: number;
  tag: string;
  name: string;
  selector: string;
  parentRef?: string;
  children: string[];
  attributes: Record<string, string>;
  text: string;
  firstSeenMs: number;
  lastSeenMs?: number;
  source: {
    kind: "captured-dom";
    file: string;
    htmlAnchor: string;
    registryPointer: string;
    originalFile?: string;
    originalLine?: number;
  };
};
export type ElementIndex = {
  schemaVersion: 1;
  captureId: string;
  captureHash: string;
  elements: ElementRecord[];
};
type CaptureEvent = { type: number; timestamp: number; data: any };
const excluded = new Set([
  "script",
  "noscript",
  "head",
  "style",
  "link",
  "meta",
  "title",
  "base",
]);
const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);

export async function ensureElementIndex(
  dir: string,
  writeSources = true,
): Promise<ElementIndex> {
  const bytes = await readProjectFile(dir, "events.json", null);
  const hash = createHash("sha256").update(bytes).digest("hex");
  try {
    const existing = JSON.parse(
      await readProjectFile(dir, "elements.json"),
    ) as ElementIndex;
    if (existing.schemaVersion !== 1 || existing.captureHash !== hash)
      throw new Error(
        "Capture changed after element references were created. Restore events.json or create a new capture.",
      );
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const result = indexEvents(
    JSON.parse(bytes.toString()),
    writeSources ? undefined : "",
  );
  const index: ElementIndex = {
    schemaVersion: 1,
    captureId: hash.slice(0, 16),
    captureHash: hash,
    elements: result.elements,
  };
  // A repository can commit `sources` (or a snippet) as a link; a write must
  // never leave the project through it. Check every target before writing any.
  const sources = writeSources ? await ensureRealFolders(dir, "sources") : "";
  for (const { ref } of result.snippets) {
    const existing = await lstat(path.join(sources, `${ref}.html`)).catch(
      () => undefined,
    );
    if (existing && !existing.isFile())
      throw new Error(`sources/${ref}.html exists and is not a regular file.`);
  }
  await Promise.all(
    result.snippets.map(({ ref, html }) =>
      atomicWrite(path.join(sources, `${ref}.html`), html),
    ),
  );
  await writeJson(path.join(dir, "elements.json"), index);
  return index;
}

export function indexEvents(
  events: CaptureEvent[],
  snippetRef?: string,
  frozenElements: ElementRecord[] = [],
): {
  elements: ElementRecord[];
  snippets: { ref: string; html: string }[];
} {
  const elements: ElementRecord[] = [],
    snippets: { ref: string; html: string }[] = [];
  const known = new Map<string, ElementRecord>();
  let documentId = 0;
  const firstTime = events[0]?.timestamp ?? 0;
  const key = (nodeId: number) => `${documentId}:${nodeId}`;
  const refs = new Map(
    frozenElements.map((e) => [`${e.documentId}:${e.nodeId}`, e.ref]),
  );
  function visit(
    node: CapturedNode,
    parentRef: string | undefined,
    time: number,
  ): string | undefined {
    let ref: string | undefined;
    const tag = node.tagName?.toLowerCase();
    if (node.type === 2 && tag && !excluded.has(tag)) {
      const attributes = Object.fromEntries(
        Object.entries(node.attributes ?? {})
          .filter(
            ([name, value]) =>
              typeof value === "string" &&
              !name.startsWith("on") &&
              !name.startsWith("rr_"),
          )
          .map(([name, value]) => [name, String(value)]),
      );
      ref =
        refs.get(key(node.id)) ??
        `d${documentId}-${slug(attributes["data-demohunter-id"] ?? attributes.id ?? attributes["data-testid"] ?? tag) || tag}-n${node.id}`;
      refs.set(key(node.id), ref);
      if (!known.has(key(node.id))) {
        const text = nodeText(node).trim().replace(/\s+/g, " ").slice(0, 1000);
        const record: ElementRecord = {
          ref,
          nodeId: node.id,
          documentId,
          tag,
          parentRef,
          children: [],
          attributes,
          text,
          name:
            attributes["aria-label"] ??
            attributes["data-demohunter-name"] ??
            (attributes.id
              ? attributes.id.replace(/[-_]/g, " ")
              : text.slice(0, 70) || tag),
          selector: attributes.id ? `#${attributes.id}` : tag,
          firstSeenMs: time,
          source: {
            kind: "captured-dom",
            file: `sources/${ref}.html`,
            htmlAnchor: `[data-demohunter-ref="${ref}"]`,
            registryPointer: `/elements/${elements.length}`,
            originalFile: attributes["data-demohunter-source"],
            originalLine:
              attributes["data-demohunter-line"] &&
              /^\d+$/.test(attributes["data-demohunter-line"])
                ? Number(attributes["data-demohunter-line"])
                : undefined,
          },
        };
        known.set(key(node.id), record);
        elements.push(record);
        if (parentRef) {
          const parent = elements.find((e) => e.ref === parentRef);
          if (parent && !parent.children.includes(ref))
            parent.children.push(ref);
        }
      }
    }
    for (const child of node.childNodes ?? [])
      visit(child, ref ?? parentRef, time);
    if (
      ref &&
      (snippetRef === undefined || snippetRef === ref) &&
      !snippets.some((s) => s.ref === ref)
    )
      snippets.push({
        ref,
        html: `<!-- Captured DOM at ${(time / 1000).toFixed(3)}s. Inspect this source; apply changes through edits.json. -->\n${serialize(node, 0)}\n`,
      });
    return ref;
  }
  function serialize(node: CapturedNode, depth: number): string {
    const pad = "  ".repeat(Math.min(depth, 30));
    if (node.type === 3) return `${pad}${escape(node.textContent ?? "")}`;
    if (
      node.type !== 2 ||
      !node.tagName ||
      excluded.has(node.tagName.toLowerCase())
    )
      return "";
    const tag = node.tagName.toLowerCase();
    const ref = refs.get(key(node.id));
    const attrs = Object.entries(node.attributes ?? {})
      .filter(
        ([name, val]) =>
          typeof val === "string" &&
          /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/.test(name) &&
          !name.startsWith("on") &&
          !["srcdoc", "data-demohunter-ref"].includes(name),
      )
      .map(([name, val]) => ` ${name}="${escape(String(val))}"`)
      .join("");
    const open = `${pad}<${tag}${attrs}${ref ? ` data-demohunter-ref="${ref}"` : ""}>`;
    if (
      [
        "img",
        "input",
        "br",
        "hr",
        "area",
        "source",
        "wbr",
        "embed",
        "col",
        "param",
        "track",
      ].includes(tag)
    )
      return open;
    const content = (node.childNodes ?? [])
      .map((child) => serialize(child, depth + 1))
      .filter(Boolean)
      .join("\n");
    return `${open}${content ? `\n${content}\n${pad}` : ""}</${tag}>`;
  }
  for (const event of events) {
    const time = Math.max(0, event.timestamp - firstTime);
    if (event.type === 4) documentId++;
    documentId ||= 1;
    if (event.type === 2 && event.data.node)
      visit(event.data.node, undefined, time);
    if (event.type === 3 && event.data.source === 0) {
      for (const addition of event.data.adds ?? []) {
        visit(addition.node, refs.get(key(addition.parentId)), time);
        // rrweb adds text nodes separately from their element; give the
        // element (and its ancestors) the text it shows.
        if (addition.node.type === 3) {
          const text = (addition.node.textContent ?? "").trim();
          let record = known.get(key(addition.parentId));
          const seen = new Set<ElementRecord>();
          // Only text that arrives with the element; later text changes are
          // replay state, not the element's identity.
          while (
            text &&
            record &&
            record.firstSeenMs === time &&
            !seen.has(record)
          ) {
            seen.add(record);
            if (record.text.length < 1000) {
              record.text = `${record.text} ${text}`
                .trim()
                .replace(/\s+/g, " ")
                .slice(0, 1000);
              if (record.name === record.tag)
                record.name = record.text.slice(0, 70);
            }
            record = record.parentRef
              ? elements.find((e) => e.ref === record!.parentRef)
              : undefined;
          }
        }
      }
      for (const removal of event.data.removes ?? []) {
        const removed = known.get(key(removal.id));
        if (removed) removed.lastSeenMs = time;
      }
    }
  }
  return { elements, snippets };
}
function nodeText(node: CapturedNode): string {
  if (node.type === 3) return node.textContent ?? "";
  if (excluded.has(node.tagName?.toLowerCase() ?? "")) return "";
  return (node.childNodes ?? []).map(nodeText).join(" ");
}

export async function elementHtml(
  dir: string,
  element: ElementRecord,
  maxChars = 30000,
): Promise<{ html: string; truncated: boolean }> {
  if ((await readFormat(dir))?.formatVersion === 2) {
    const events = JSON.parse(await readProjectFile(dir, "events.json"));
    const index = JSON.parse(
      await readProjectFile(dir, "elements.json"),
    ) as ElementIndex;
    const html = indexEvents(events, element.ref, index.elements).snippets[0]
      ?.html;
    if (html === undefined)
      throw new Error("Captured element is missing from its recording.");
    if (Buffer.byteLength(html) > 5_000_000)
      throw new Error(
        "Captured HTML is too large; inspect a smaller child element.",
      );
    return { html: html.slice(0, maxChars), truncated: html.length > maxChars };
  }
  const file = await safeFile(dir, element.source.file);
  const size = (await stat(file)).size;
  if (size > 5_000_000)
    throw new Error(
      "Captured HTML is too large; inspect a smaller child element.",
    );
  const html = await readFile(file, "utf8");
  return { html: html.slice(0, maxChars), truncated: html.length > maxChars };
}
