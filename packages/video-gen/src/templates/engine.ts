import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BodyElement, ContentSpec, SlideSpec } from "../content/schema.js";
import type { RenderedSite, RenderLessonInput, StylePresetName } from "../pipeline/types.js";
import { STYLE_PRESET_NAMES } from "../pipeline/types.js";

const PACKAGE_SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolveAsset(...parts: string[]): string {
  const candidates = [
    path.join(PACKAGE_SRC_ROOT, ...parts),
    path.join(PACKAGE_SRC_ROOT, "..", "dist", ...parts),
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      // try next
    }
  }
  throw new Error(`Unable to load template asset: ${parts.join("/")}`);
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function isStylePresetName(value: string): value is StylePresetName {
  return (STYLE_PRESET_NAMES as readonly string[]).includes(value);
}

export function renderLesson(input: RenderLessonInput): RenderedSite {
  const layout = resolveAsset("templates", "base", "layout.html");
  const sectionTemplate = resolveAsset("templates", "base", "section.html");
  const javascript = resolveAsset("templates", "base", "app.js");
  const css = resolveAsset("templates", "presets", input.style, "styles.css");

  const sectionsHtml = input.spec.slides
    .map((section, index) => renderSection(sectionTemplate, section, index))
    .join("\n");

  const html = layout
    .replaceAll("{{TITLE}}", escapeHtml(input.spec.title))
    .replaceAll("{{STYLE}}", escapeHtml(input.style))
    .replace("{{SECTIONS}}", sectionsHtml);

  return { html, css, javascript };
}

function renderSection(template: string, section: SlideSpec, index: number): string {
  return template
    .replaceAll("{{SECTION_ID}}", escapeHtml(section.id))
    .replaceAll("{{SECTION_INDEX}}", String(index))
    .replaceAll("{{SECTION_NUMBER}}", String(index + 1).padStart(2, "0"))
    .replaceAll("{{TRANSITION}}", escapeHtml(section.transition))
    .replaceAll("{{HEADING}}", escapeHtml(section.heading))
    .replace("{{BODY}}", renderBody(section.body));
}

function renderBody(body: BodyElement[]): string {
  return body.map((element, index) => renderBodyElement(element, index)).join("\n");
}

function renderBodyElement(element: BodyElement, index: number): string {
  const revealOrder = index * 3;
  switch (element.type) {
    case "paragraph":
      return `<p class="reveal-item body-paragraph" data-reveal="true" data-body-index="${index}" data-body-type="paragraph" style="--reveal-order:${revealOrder}">${escapeHtml(element.text)}</p>`;
    case "bullet_list": {
      const items = element.items
        .map(
          (item, itemIndex) =>
            `<li class="reveal-item" data-reveal="true" data-body-index="${index}" data-item-index="${itemIndex}" style="--reveal-order:${revealOrder + itemIndex}"><span>${escapeHtml(item)}</span></li>`,
        )
        .join("");
      return `<ul class="body-list" data-body-index="${index}" data-body-type="bullet_list">${items}</ul>`;
    }
    case "code_block":
      return `<figure class="reveal-item code-panel" data-reveal="true" data-body-index="${index}" data-body-type="code_block" data-code-block="true" style="--reveal-order:${revealOrder}"><figcaption>${escapeHtml(element.language)}</figcaption><pre><code data-language="${escapeHtml(element.language)}">${escapeHtml(element.code)}</code></pre></figure>`;
    default: {
      const _exhaustive: never = element;
      throw new Error(`Unrecognized body variant: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** Test helper: render without filesystem when assets are injected. */
export function renderLessonFromAssets(input: {
  spec: ContentSpec;
  style: StylePresetName;
  layout: string;
  sectionTemplate: string;
  javascript: string;
  css: string;
}): RenderedSite {
  const sectionsHtml = input.spec.slides
    .map((section, index) => renderSection(input.sectionTemplate, section, index))
    .join("\n");
  const html = input.layout
    .replaceAll("{{TITLE}}", escapeHtml(input.spec.title))
    .replaceAll("{{STYLE}}", escapeHtml(input.style))
    .replace("{{SECTIONS}}", sectionsHtml);
  return {
    html,
    css: input.css,
    javascript: input.javascript,
  };
}
