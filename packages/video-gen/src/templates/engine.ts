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
  const slideTemplate = resolveAsset("templates", "base", "slide.html");
  const javascript = resolveAsset("templates", "base", "app.js");
  const css = resolveAsset("templates", "presets", input.style, "styles.css");

  const slidesHtml = input.spec.slides
    .map((slide, index) => renderSlide(slideTemplate, slide, index))
    .join("\n");

  const html = layout
    .replaceAll("{{TITLE}}", escapeHtml(input.spec.title))
    .replace("{{SLIDES}}", slidesHtml);

  return { html, css, javascript };
}

function renderSlide(template: string, slide: SlideSpec, index: number): string {
  const isFirst = index === 0;
  return template
    .replaceAll("{{SLIDE_ID}}", escapeHtml(slide.id))
    .replaceAll("{{SLIDE_INDEX}}", String(index))
    .replaceAll("{{TRANSITION}}", escapeHtml(slide.transition))
    .replaceAll("{{ACTIVE_CLASS}}", isFirst ? " active" : "")
    .replaceAll("{{ACTIVE_FLAG}}", isFirst ? "true" : "false")
    .replaceAll("{{ARIA_HIDDEN}}", isFirst ? "false" : "true")
    .replaceAll("{{HEADING}}", escapeHtml(slide.heading))
    .replace("{{BODY}}", renderBody(slide.body));
}

function renderBody(body: BodyElement[]): string {
  return body.map((element, index) => renderBodyElement(element, index)).join("\n");
}

function renderBodyElement(element: BodyElement, index: number): string {
  switch (element.type) {
    case "paragraph":
      return `<p data-body-index="${index}" data-body-type="paragraph">${escapeHtml(element.text)}</p>`;
    case "bullet_list": {
      const items = element.items
        .map(
          (item, itemIndex) =>
            `<li data-body-index="${index}" data-item-index="${itemIndex}">${escapeHtml(item)}</li>`,
        )
        .join("");
      return `<ul data-body-index="${index}" data-body-type="bullet_list">${items}</ul>`;
    }
    case "code_block":
      return `<pre data-body-index="${index}" data-body-type="code_block" data-code-block="true"><code data-language="${escapeHtml(element.language)}">${escapeHtml(element.code)}</code></pre>`;
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
  slideTemplate: string;
  javascript: string;
  css: string;
}): RenderedSite {
  const slidesHtml = input.spec.slides
    .map((slide, index) => renderSlide(input.slideTemplate, slide, index))
    .join("\n");
  const html = input.layout
    .replaceAll("{{TITLE}}", escapeHtml(input.spec.title))
    .replace("{{SLIDES}}", slidesHtml);
  return {
    html,
    css: input.css,
    javascript: input.javascript,
  };
}
