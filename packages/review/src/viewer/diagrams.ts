import type {
  ReviewComponentDiagram,
  ReviewDiagram,
  ReviewSequenceDiagram,
} from "../authoring/review-types.js";

/**
 * Deterministic SVG rendering for authored diagram layouts.
 *
 * Layout is authored (each node carries an explicit column/row, each sequence
 * message an explicit order), so rendering is a pure function of the review
 * definition. There is no layout engine, no remote diagram service, and no
 * runtime network access; the same definition always produces byte-identical
 * SVG.
 */

const COMPONENT = {
  nodeWidth: 208,
  nodeHeight: 78,
  columnGap: 74,
  rowGap: 62,
  paddingX: 24,
  paddingY: 24,
} as const;

const SEQUENCE = {
  laneWidth: 196,
  headerHeight: 56,
  headerGap: 26,
  messageGap: 56,
  paddingX: 24,
  paddingY: 24,
  footerHeight: 34,
} as const;

export type RenderedDiagram = {
  id: string;
  title: string;
  caption?: string;
  kind: ReviewDiagram["kind"];
  /** Standalone SVG document, safe to write to disk and to inline in HTML. */
  svg: string;
  width: number;
  height: number;
};

export function renderDiagram(diagram: ReviewDiagram): RenderedDiagram {
  return diagram.kind === "sequence"
    ? renderSequenceDiagram(diagram)
    : renderComponentDiagram(diagram);
}

export function renderComponentDiagram(diagram: ReviewComponentDiagram): RenderedDiagram {
  const columns = Math.max(...diagram.nodes.map((node) => node.column)) + 1;
  const rows = Math.max(...diagram.nodes.map((node) => node.row)) + 1;
  const width =
    COMPONENT.paddingX * 2 + columns * COMPONENT.nodeWidth + (columns - 1) * COMPONENT.columnGap;
  const height =
    COMPONENT.paddingY * 2 + rows * COMPONENT.nodeHeight + (rows - 1) * COMPONENT.rowGap;
  const boxes = new Map(
    diagram.nodes.map((node) => [
      node.id,
      {
        node,
        x: COMPONENT.paddingX + node.column * (COMPONENT.nodeWidth + COMPONENT.columnGap),
        y: COMPONENT.paddingY + node.row * (COMPONENT.nodeHeight + COMPONENT.rowGap),
        width: COMPONENT.nodeWidth,
        height: COMPONENT.nodeHeight,
      },
    ]),
  );

  const edgeMarkup = diagram.edges.map((edge) => {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);

    if (from === undefined || to === undefined) {
      return "";
    }

    const start = boxCenter(from);
    const end = boxCenter(to);
    const startPoint = intersectBox(from, start, end);
    const endPoint = intersectBox(to, end, start);
    const midX = (startPoint.x + endPoint.x) / 2;
    const midY = (startPoint.y + endPoint.y) / 2;
    const label = edge.label === undefined
      ? ""
      : `<rect class="dh-edge-label-bg" x="${round(midX - estimateTextWidth(edge.label, 11) / 2 - 5)}" y="${round(midY - 9)}" width="${round(estimateTextWidth(edge.label, 11) + 10)}" height="18" rx="4" />`
        + `<text class="dh-edge-label" x="${round(midX)}" y="${round(midY + 4)}" text-anchor="middle">${escapeXml(edge.label)}</text>`;

    return (
      `<line class="dh-edge${edge.changed === true ? " dh-edge-changed" : ""}${edge.style === "dashed" ? " dh-edge-dashed" : ""}" `
      + `x1="${round(startPoint.x)}" y1="${round(startPoint.y)}" x2="${round(endPoint.x)}" y2="${round(endPoint.y)}" `
      + `marker-end="url(#dh-arrow${edge.changed === true ? "-changed" : ""})" />${label}`
    );
  });

  const nodeMarkup = [...boxes.values()].map(({ node, x, y, width: boxWidth, height: boxHeight }) => {
    const detail = node.detail === undefined
      ? ""
      : `<text class="dh-node-detail" x="${round(x + boxWidth / 2)}" y="${round(y + boxHeight / 2 + 16)}" text-anchor="middle">${escapeXml(truncate(node.detail, 30))}</text>`;
    const kind = node.kind === undefined
      ? ""
      : `<text class="dh-node-kind" x="${round(x + 12)}" y="${round(y + 17)}">${escapeXml(node.kind.toUpperCase())}</text>`;
    const labelY = node.detail === undefined ? y + boxHeight / 2 + 8 : y + boxHeight / 2 - 2;

    return (
      `<g class="dh-node${node.changed === true ? " dh-node-changed" : ""}">`
      + `<rect x="${x}" y="${y}" width="${boxWidth}" height="${boxHeight}" rx="10" />`
      + kind
      + `<text class="dh-node-label" x="${round(x + boxWidth / 2)}" y="${round(labelY)}" text-anchor="middle">${escapeXml(truncate(node.label, 26))}</text>`
      + detail
      + "</g>"
    );
  });

  return {
    id: diagram.id,
    title: diagram.title,
    ...(diagram.caption === undefined ? {} : { caption: diagram.caption }),
    kind: diagram.kind,
    width,
    height,
    svg: wrapSvg({
      width,
      height,
      title: diagram.title,
      body: `${edgeMarkup.join("")}${nodeMarkup.join("")}`,
      variant: diagram.kind,
    }),
  };
}

export function renderSequenceDiagram(diagram: ReviewSequenceDiagram): RenderedDiagram {
  const lanes = diagram.participants.map((participant, index) => ({
    participant,
    centerX: SEQUENCE.paddingX + SEQUENCE.laneWidth / 2 + index * SEQUENCE.laneWidth,
  }));
  const laneByLabel = new Map(lanes.map((lane) => [lane.participant.id, lane]));
  const width = SEQUENCE.paddingX * 2 + lanes.length * SEQUENCE.laneWidth;
  const bodyTop = SEQUENCE.paddingY + SEQUENCE.headerHeight + SEQUENCE.headerGap;
  const height = bodyTop + diagram.messages.length * SEQUENCE.messageGap + SEQUENCE.footerHeight;

  const laneMarkup = lanes.map((lane) => {
    const boxX = lane.centerX - SEQUENCE.laneWidth / 2 + 12;
    const boxWidth = SEQUENCE.laneWidth - 24;
    const detail = lane.participant.detail === undefined
      ? ""
      : `<text class="dh-node-detail" x="${round(lane.centerX)}" y="${round(SEQUENCE.paddingY + 44)}" text-anchor="middle">${escapeXml(truncate(lane.participant.detail, 24))}</text>`;
    const labelY = lane.participant.detail === undefined
      ? SEQUENCE.paddingY + 34
      : SEQUENCE.paddingY + 26;

    return (
      `<g class="dh-node">`
      + `<rect x="${round(boxX)}" y="${SEQUENCE.paddingY}" width="${round(boxWidth)}" height="${SEQUENCE.headerHeight}" rx="10" />`
      + `<text class="dh-node-label" x="${round(lane.centerX)}" y="${round(labelY)}" text-anchor="middle">${escapeXml(truncate(lane.participant.label, 22))}</text>`
      + detail
      + "</g>"
      + `<line class="dh-lifeline" x1="${round(lane.centerX)}" y1="${SEQUENCE.paddingY + SEQUENCE.headerHeight}" x2="${round(lane.centerX)}" y2="${round(height - 12)}" />`
    );
  });

  const messageMarkup = diagram.messages.map((message, index) => {
    const from = laneByLabel.get(message.from);
    const to = laneByLabel.get(message.to);

    if (from === undefined || to === undefined) {
      return "";
    }

    const y = bodyTop + index * SEQUENCE.messageGap;
    const isSelf = message.from === message.to || message.kind === "note";

    if (isSelf) {
      const boxWidth = Math.min(220, Math.max(120, estimateTextWidth(message.label, 12) + 24));
      return (
        `<g class="dh-sequence-note">`
        + `<rect x="${round(from.centerX + 12)}" y="${round(y - 16)}" width="${round(boxWidth)}" height="30" rx="6" />`
        + `<text class="dh-edge-label" x="${round(from.centerX + 24)}" y="${round(y + 4)}">${escapeXml(truncate(message.label, 34))}</text>`
        + "</g>"
      );
    }

    const dashed = message.kind === "return";
    const direction = to.centerX > from.centerX ? 1 : -1;
    const startX = from.centerX + direction * 6;
    const endX = to.centerX - direction * 8;

    return (
      `<g class="dh-sequence-message">`
      + `<text class="dh-edge-label" x="${round((startX + endX) / 2)}" y="${round(y - 10)}" text-anchor="middle">${escapeXml(truncate(message.label, 34))}</text>`
      + `<line class="dh-edge${dashed ? " dh-edge-dashed" : ""}" x1="${round(startX)}" y1="${round(y)}" x2="${round(endX)}" y2="${round(y)}" marker-end="url(#dh-arrow)" />`
      + `<text class="dh-sequence-index" x="${round(SEQUENCE.paddingX - 8)}" y="${round(y + 4)}" text-anchor="end">${index + 1}</text>`
      + "</g>"
    );
  });

  return {
    id: diagram.id,
    title: diagram.title,
    ...(diagram.caption === undefined ? {} : { caption: diagram.caption }),
    kind: diagram.kind,
    width,
    height,
    svg: wrapSvg({
      width,
      height,
      title: diagram.title,
      body: `${laneMarkup.join("")}${messageMarkup.join("")}`,
      variant: "sequence",
    }),
  };
}

function wrapSvg(input: {
  width: number;
  height: number;
  title: string;
  body: string;
  variant: string;
}): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${input.width} ${input.height}" `
    + `width="${input.width}" height="${input.height}" role="img" `
    + `class="dh-diagram dh-diagram-${escapeXml(input.variant)}" aria-label="${escapeXml(input.title)}">`
    + `<title>${escapeXml(input.title)}</title>`
    + DIAGRAM_DEFS
    + DIAGRAM_STYLE
    + `<rect class="dh-diagram-bg" x="0" y="0" width="${input.width}" height="${input.height}" rx="12" />`
    + input.body
    + "</svg>"
  );
}

const DIAGRAM_DEFS = `<defs>`
  + `<marker id="dh-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">`
  + `<path d="M 0 0 L 10 5 L 0 10 z" fill="#8aa0c0" /></marker>`
  + `<marker id="dh-arrow-changed" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">`
  + `<path d="M 0 0 L 10 5 L 0 10 z" fill="#4f9dff" /></marker>`
  + `</defs>`;

const DIAGRAM_STYLE = `<style>
.dh-diagram-bg { fill: #0f1620; }
.dh-node rect { fill: #16202e; stroke: #2b3a4d; stroke-width: 1.25; }
.dh-node-changed rect { fill: #10243c; stroke: #4f9dff; stroke-width: 1.75; }
.dh-node-label { fill: #e6edf6; font: 600 13px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.dh-node-detail { fill: #9fb0c6; font: 400 11px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.dh-node-kind { fill: #6d8199; font: 600 8.5px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; letter-spacing: 0.08em; }
.dh-edge { stroke: #8aa0c0; stroke-width: 1.4; fill: none; }
.dh-edge-changed { stroke: #4f9dff; stroke-width: 2; }
.dh-edge-dashed { stroke-dasharray: 6 5; }
.dh-edge-label { fill: #c4d2e4; font: 500 11px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.dh-edge-label-bg { fill: #0f1620; }
.dh-lifeline { stroke: #2b3a4d; stroke-width: 1; stroke-dasharray: 4 6; }
.dh-sequence-note rect { fill: #1b2635; stroke: #3a4c63; }
.dh-sequence-index { fill: #55677d; font: 600 10px ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>`;

type Box = { x: number; y: number; width: number; height: number };

function boxCenter(box: Box): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Where the segment from `from` towards `to` leaves the box, plus a small gap. */
function intersectBox(
  box: Box,
  from: { x: number; y: number },
  to: { x: number; y: number },
): { x: number; y: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;

  if (dx === 0 && dy === 0) {
    return from;
  }

  const halfWidth = box.width / 2 + 6;
  const halfHeight = box.height / 2 + 6;
  const scale = Math.min(
    dx === 0 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(dx),
    dy === 0 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(dy),
  );

  return { x: from.x + dx * scale, y: from.y + dy * scale };
}

function estimateTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.56;
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(1, maxLength - 1))}…`;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
