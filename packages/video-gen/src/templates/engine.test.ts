import { describe, expect, test } from "bun:test";

import { CONTENT_SPEC_VERSION, type ContentSpec } from "../content/schema.js";
import { escapeHtml, renderLesson } from "./engine.js";

const spec: ContentSpec = {
  version: CONTENT_SPEC_VERSION,
  title: 'Trees & "Graphs"',
  duration: "2m",
  slides: [
    {
      id: "intro",
      heading: "Hello <world>",
      body: [
        { type: "paragraph", text: "A & B" },
        { type: "bullet_list", items: ["one", "two"] },
        { type: "code_block", language: "html", code: "<div onclick=\"alert(1)\">x</div>" },
      ],
      narration: "Intro narration.",
      transition: "fade",
    },
    {
      id: "next",
      heading: "Next",
      body: [{ type: "paragraph", text: "Second" }],
      narration: "Second narration.",
      transition: "slide-left",
    },
  ],
};

describe("template engine", () => {
  test("escapes model-controlled text and keeps code literal", () => {
    const rendered = renderLesson({ spec, style: "minimal" });
    expect(rendered.html).toContain("Hello &lt;world&gt;");
    expect(rendered.html).toContain("A &amp; B");
    expect(rendered.html).toContain("&lt;div onclick=&quot;alert(1)&quot;&gt;x&lt;/div&gt;");
    expect(rendered.html).not.toContain('<div onclick="alert(1)">');
    expect(escapeHtml(`<"&>'`)).toBe("&lt;&quot;&amp;&gt;&#39;");
  });

  test("emits stable selectors and initial active state", () => {
    const rendered = renderLesson({ spec, style: "minimal" });
    expect(rendered.html).toContain('id="slide-intro"');
    expect(rendered.html).toContain('data-slide-id="intro"');
    expect(rendered.html).toContain('data-slide-index="0"');
    expect(rendered.html).toContain('data-transition="fade"');
    expect(rendered.html).toContain('data-nav="next"');
    expect(rendered.html).toMatch(/id="slide-intro"[^>]*data-active="true"/);
    expect(rendered.html).toMatch(/id="slide-next"[^>]*data-active="false"/);
  });

  test("is deterministic across presets and runs", () => {
    const a = renderLesson({ spec, style: "terminal" });
    const b = renderLesson({ spec, style: "terminal" });
    expect(a.html).toBe(b.html);
    expect(a.css).toBe(b.css);
    expect(a.javascript).toBe(b.javascript);
    expect(a.css).toContain("--bg:");
    expect(renderLesson({ spec, style: "notebook" }).css).toContain("--font-sans:");
    expect(a.html).toBe(renderLesson({ spec, style: "notebook" }).html);
  });

  test("runtime js has no random or variable timers", () => {
    const { javascript } = renderLesson({ spec, style: "minimal" });
    expect(javascript).not.toContain("Math.random");
    expect(javascript).not.toContain("Date.now");
    expect(javascript).not.toContain("setTimeout");
  });
});
