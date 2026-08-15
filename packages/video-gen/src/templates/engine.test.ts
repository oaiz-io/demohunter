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

  test("emits stable continuous-flow sections without navigation controls", () => {
    const rendered = renderLesson({ spec, style: "minimal" });
    expect(rendered.html).toContain('id="section-intro"');
    expect(rendered.html).toContain('data-section-id="intro"');
    expect(rendered.html).toContain('data-section-index="0"');
    expect(rendered.html).toContain('data-transition="fade"');
    expect(rendered.html).toContain('data-reveal-state="pending"');
    expect(rendered.html).toContain('data-lesson-flow="true"');
    expect(rendered.html).toContain('data-style="minimal"');
    expect(rendered.html).not.toContain("data-nav=");
    expect(rendered.html).not.toContain("<button");
    expect(rendered.html).not.toContain("data-active=");
    expect(rendered.html.indexOf('data-section-id="intro"')).toBeLessThan(
      rendered.html.indexOf('data-section-id="next"'),
    );
  });

  test("is deterministic across presets and runs", () => {
    const a = renderLesson({ spec, style: "terminal" });
    const b = renderLesson({ spec, style: "terminal" });
    expect(a.html).toBe(b.html);
    expect(a.css).toBe(b.css);
    expect(a.javascript).toBe(b.javascript);
    expect(a.css).toContain("--void:");
    expect(renderLesson({ spec, style: "notebook" }).css).toContain("--font-serif:");
    expect(renderLesson({ spec, style: "notebook" }).html).toContain('data-style="notebook"');
  });

  test("runtime js uses viewport observation without random or variable timers", () => {
    const { javascript } = renderLesson({ spec, style: "minimal" });
    expect(javascript).toContain("IntersectionObserver");
    expect(javascript).toContain('data-reveal-state');
    expect(javascript).not.toContain("Math.random");
    expect(javascript).not.toContain("Date.now");
    expect(javascript).not.toContain("setTimeout");
  });
});
