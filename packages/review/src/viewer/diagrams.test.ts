import { describe, expect, test } from "bun:test";

import type { ReviewComponentDiagram, ReviewSequenceDiagram } from "../authoring/review-types.js";
import { renderComponentDiagram, renderDiagram, renderSequenceDiagram } from "./diagrams.js";

const componentDiagram: ReviewComponentDiagram = {
  kind: "component",
  id: "arch",
  title: "Architecture",
  caption: "How it fits together.",
  nodes: [
    { id: "cli", label: "CLI", kind: "module", detail: "argv only", column: 0, row: 0 },
    { id: "git", label: "Git", kind: "external", column: 1, row: 0, changed: true },
    { id: "disk", label: "Artifact", kind: "artifact", column: 1, row: 1 },
  ],
  edges: [
    { from: "cli", to: "git", label: "merge-base..HEAD", changed: true },
    { from: "cli", to: "disk", style: "dashed" },
  ],
};

const sequenceDiagram: ReviewSequenceDiagram = {
  kind: "sequence",
  id: "flow",
  title: "Flow",
  participants: [
    { id: "cli", label: "CLI", detail: "argv" },
    { id: "git", label: "Git" },
  ],
  messages: [
    { from: "cli", to: "git", label: "resolve" },
    { from: "git", to: "cli", label: "sha", kind: "return" },
    { from: "cli", to: "cli", label: "assert coverage", kind: "note" },
  ],
};

describe("renderComponentDiagram", () => {
  test("sizes the canvas from the authored grid", () => {
    const rendered = renderComponentDiagram(componentDiagram);

    // 2 columns x 2 rows at 208x78 with 74/62 gaps and 24 padding.
    expect(rendered.width).toBe(24 * 2 + 2 * 208 + 74);
    expect(rendered.height).toBe(24 * 2 + 2 * 78 + 62);
    expect(rendered.svg).toContain(`viewBox="0 0 ${rendered.width} ${rendered.height}"`);
  });

  test("is deterministic", () => {
    expect(renderComponentDiagram(componentDiagram).svg).toBe(
      renderComponentDiagram(componentDiagram).svg,
    );
  });

  test("marks changed nodes and edges and dashes optional relationships", () => {
    const { svg } = renderComponentDiagram(componentDiagram);

    expect(svg).toContain("dh-node dh-node-changed");
    expect(svg).toContain("dh-edge dh-edge-changed");
    expect(svg).toContain("dh-edge-dashed");
    expect(svg).toContain('marker-end="url(#dh-arrow-changed)"');
  });

  test("skips an edge whose endpoint is missing instead of drawing to origin", () => {
    const { svg } = renderComponentDiagram({
      ...componentDiagram,
      edges: [{ from: "cli", to: "ghost", label: "nowhere" }],
    });

    expect(svg).not.toContain("nowhere");
    expect(svg).not.toContain("<line");
  });

  test("escapes XML metacharacters in labels", () => {
    const { svg } = renderComponentDiagram({
      ...componentDiagram,
      nodes: [{ id: "n", label: '<script>&"x"', column: 0, row: 0 }],
      edges: [],
    });

    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;&amp;&quot;x&quot;");
  });

  test("truncates a long label rather than letting it overflow the box", () => {
    const { svg } = renderComponentDiagram({
      ...componentDiagram,
      nodes: [{ id: "n", label: "x".repeat(60), column: 0, row: 0 }],
      edges: [],
    });

    expect(svg).toContain("…");
    expect(svg).not.toContain("x".repeat(30));
  });
});

describe("renderSequenceDiagram", () => {
  test("lays lanes out left to right and messages top to bottom", () => {
    const rendered = renderSequenceDiagram(sequenceDiagram);

    expect(rendered.width).toBe(24 * 2 + 2 * 196);
    expect(rendered.svg).toContain("dh-lifeline");
    expect(rendered.svg.indexOf(">resolve<")).toBeLessThan(rendered.svg.indexOf(">sha<"));
  });

  test("dashes a return arrow and boxes a note", () => {
    const { svg } = renderSequenceDiagram(sequenceDiagram);

    expect(svg).toContain("dh-edge dh-edge-dashed");
    expect(svg).toContain("dh-sequence-note");
    expect(svg).toContain(">assert coverage<");
  });

  test("numbers the messages so the narration can refer to them", () => {
    const { svg } = renderSequenceDiagram(sequenceDiagram);

    expect(svg).toContain('class="dh-sequence-index" x="16" y="110" text-anchor="end">1<');
    expect(svg).toContain(">2<");
  });
});

describe("renderDiagram", () => {
  test("dispatches on the authored kind", () => {
    expect(renderDiagram(componentDiagram).kind).toBe("component");
    expect(renderDiagram(sequenceDiagram).kind).toBe("sequence");
    expect(renderDiagram({ ...componentDiagram, kind: "data-flow" }).kind).toBe("data-flow");
  });

  test("carries the authored caption through and always includes a title for screen readers", () => {
    const rendered = renderDiagram(componentDiagram);

    expect(rendered.caption).toBe("How it fits together.");
    expect(rendered.svg).toContain("<title>Architecture</title>");
    expect(rendered.svg).toContain('role="img"');
    expect(rendered.svg).toContain('aria-label="Architecture"');
  });

  test("embeds its own styling so the SVG stands alone on disk", () => {
    const { svg } = renderDiagram(componentDiagram);

    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain("<style>");
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });
});
