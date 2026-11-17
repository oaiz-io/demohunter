import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchRenderBrowser, openReplayRenderer } from "./render.js";
import { clipDuration, clipStart, totalDuration, type ReplayBundle } from "./model.js";
import { ensureIgnoredFolder, ensureRealFolders, loadBundle } from "./storage.js";

/**
 * Contact sheets: the whole film in a few images, so an agent can look at it
 * itself. Frames come from the same deterministic player as export and MCP
 * `get_screenshot`, in one browser for the run. A sheet is a grid of tiles;
 * each tile has its time and clip or overlay id in a label under the picture.
 * This returns pictures and data only; it judges nothing.
 */

export type SheetOptions = {
  /** Tiles at these output times (ms). */
  at?: number[];
  /** Tiles every this many ms, from 0 to the end. */
  every?: number;
  /** A strip of frames across every clip boundary and overlay start/end. */
  cuts?: boolean;
  /** Each frame 360 px wide, shown 1:1, as on a phone. */
  phone?: boolean;
};
export type SheetTile = {
  /** Output time of the frame (ms). */
  timeMs: number;
  /** The clip on screen at that time. */
  clipId: string;
  /** Overlays on screen at that time. */
  overlayIds: string[];
  /** What the tile was taken for (default mode): a clip or overlay id. */
  subject?: string;
  /** --cuts: the seam this tile belongs to, and its offset from it (ms). */
  seam?: string;
  offsetMs?: number;
  label: string;
  /** Which sheet (1-based), row and column (0-based) the tile is in. */
  sheet: number;
  row: number;
  column: number;
};
type Planned = Omit<SheetTile, "sheet" | "row" | "column" | "label" | "clipId" | "overlayIds">;

/** Frame offsets across a seam (ms): about ±6, ±3 and ±1 frames at 30 fps. */
export const CUT_OFFSETS = [-200, -100, -33, 33, 100, 200];
/** "A few frames in" (3 frames at 30 fps), so a tile is not a blank fade-in. */
const START_IN_MS = 100;
const MAX_TILES = 600;
const MAX_PER_SHEET = 30;
const SHEET_WIDTH = 1980;
const GAP = 12;
const LABEL = 22;

type Span = { id: string; kind: "clip" | "overlay"; start: number; end: number };
function spans(bundle: ReplayBundle): { clips: Span[]; overlays: Span[]; total: number } {
  const { edits } = bundle;
  const total = totalDuration(edits);
  const clips = edits.clips.map((clip) => {
    const start = clipStart(edits, clip.id) ?? 0;
    return { id: clip.id, kind: "clip" as const, start, end: start + clipDuration(clip) };
  });
  const overlays = (edits.overlays ?? [])
    .filter((o) => o.startMs < total)
    .map((o) => ({
      id: o.id,
      kind: "overlay" as const,
      start: o.startMs,
      end: Math.min(o.endMs, total),
    }));
  return { clips, overlays, total };
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

/** The tiles a sheet run renders, in order. Pure: exported for tests. */
export function planSheet(bundle: ReplayBundle, options: SheetOptions = {}) {
  const { clips, overlays, total } = spans(bundle);
  const modes = [options.at !== undefined, options.every !== undefined, !!options.cuts];
  if (modes.filter(Boolean).length > 1)
    throw new Error("Choose one of --at, --every or --cuts.");
  const inRange = (ms: number) => Math.min(total, Math.max(0, Math.round(ms)));
  let planned: Planned[] = [];
  const rows: { seam: string; timeMs: number }[] = [];
  if (options.at) {
    if (!options.at.length) throw new Error("--at needs at least one time.");
    for (const ms of options.at) {
      if (!Number.isFinite(ms) || ms < 0 || ms > total)
        throw new Error(
          `--at ${ms} is outside the film (0 to ${Math.floor(total)} ms).`,
        );
      planned.push({ timeMs: Math.round(ms) });
    }
  } else if (options.every !== undefined) {
    const every = options.every;
    if (!Number.isFinite(every) || every < 1)
      throw new Error("--every must be a positive number of milliseconds.");
    if (total / every + 1 > MAX_TILES)
      throw new Error(`--every ${every} gives more than ${MAX_TILES} tiles. Use a larger step.`);
    for (let ms = 0; ms <= total; ms += every) planned.push({ timeMs: Math.round(ms) });
  } else if (options.cuts) {
    const seams: { seam: string; timeMs: number }[] = [];
    for (let i = 1; i < clips.length; i++)
      seams.push({
        seam: `${clips[i - 1]!.id} → ${clips[i]!.id}`,
        timeMs: clips[i]!.start,
      });
    for (const o of overlays) {
      if (o.start > 0) seams.push({ seam: `${o.id} in`, timeMs: o.start });
      if (o.end < total) seams.push({ seam: `${o.id} out`, timeMs: o.end });
    }
    seams.sort((a, b) => a.timeMs - b.timeMs);
    if (seams.length * CUT_OFFSETS.length > MAX_TILES)
      throw new Error(`The film has too many seams for one run (over ${MAX_TILES} tiles).`);
    for (const s of seams) {
      rows.push(s);
      for (const offsetMs of CUT_OFFSETS) {
        const timeMs = s.timeMs + offsetMs;
        // Frames before the start or after the end do not exist: leave a gap.
        planned.push({
          timeMs: timeMs < 0 || timeMs > total ? -1 : Math.round(timeMs),
          seam: s.seam,
          offsetMs,
        });
      }
    }
  } else {
    for (const s of [...clips, ...overlays]) {
      const length = s.end - s.start;
      planned.push({ timeMs: inRange(s.start + Math.min(START_IN_MS, length / 4)), subject: s.id });
      planned.push({ timeMs: inRange(s.start + length / 2), subject: s.id });
    }
    const kind = (p: Planned) => (clips.some((c) => c.id === p.subject) ? 0 : 1);
    planned.sort((a, b) => a.timeMs - b.timeMs || kind(a) - kind(b));
    planned = planned.filter(
      (p, i) => !planned.slice(0, i).some((q) => q.timeMs === p.timeMs && q.subject === p.subject),
    );
  }
  const clipAt = (ms: number) =>
    (clips.find((c) => ms >= c.start && ms < c.end) ?? clips.at(-1)!).id;
  const overlaysAt = (ms: number) =>
    overlays.filter((o) => ms >= o.start && ms < o.end).map((o) => o.id);
  return {
    total,
    seams: rows,
    tiles: planned.map((p) => {
      const clipId = p.timeMs < 0 ? "" : clipAt(p.timeMs);
      const overlayIds = p.timeMs < 0 ? [] : overlaysAt(p.timeMs);
      const what = [clipId, ...overlayIds].join(" + ");
      const label =
        p.timeMs < 0
          ? `${p.offsetMs! > 0 ? "+" : ""}${p.offsetMs} ms · no frame`
          : p.seam
            ? `${seconds(p.timeMs)} (${p.offsetMs! > 0 ? "+" : ""}${p.offsetMs}) · ${what}`
            : `${seconds(p.timeMs)} · ${what}`;
      return { ...p, clipId, overlayIds, label };
    }),
  };
}

/** Tile size in px and columns for a film size. */
export function sheetLayout(
  size: { width: number; height: number },
  options: { phone?: boolean; cuts?: boolean } = {},
) {
  const scale = options.phone
    ? 360 / size.width
    : Math.min(480 / size.width, 480 / size.height);
  const tile = {
    width: Math.round(size.width * scale),
    height: Math.round(size.height * scale),
  };
  const columns = options.cuts
    ? CUT_OFFSETS.length
    : Math.max(2, Math.min(6, Math.floor((SHEET_WIDTH + GAP) / (tile.width + GAP))));
  const rows = Math.max(1, Math.floor(MAX_PER_SHEET / columns));
  return { scale, tile, columns, rows, perSheet: columns * rows };
}

const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * Render contact sheets of a project as JPEG images. One browser for the
 * run: frames in a player context scaled to tile size, sheets composed as an
 * HTML page in a second context. Does not touch the user's preview.
 */
export async function renderSheets(
  dir: string,
  options: SheetOptions & { expectedRevision?: string } = {},
): Promise<{
  sheets: Buffer[];
  tiles: SheetTile[];
  revision: string;
  durationMs: number;
  size: { width: number; height: number };
  tile: { width: number; height: number };
}> {
  const bundle = await loadBundle(dir);
  const plan = planSheet(bundle, options);
  const layout = sheetLayout(bundle.project.viewport, options);
  const browser = await launchRenderBrowser();
  try {
    const renderer = await openReplayRenderer(dir, options.expectedRevision, {
      browser,
      deviceScaleFactor: layout.scale,
    });
    const images: (Buffer | undefined)[] = [];
    try {
      // Plans and frames must come from the same revision.
      if (renderer.bundle.revision !== bundle.revision)
        throw new Error("The project changed while the sheet started. Run it again.");
      const done = new Map<number, Buffer>();
      for (const t of plan.tiles) {
        if (t.timeMs < 0) {
          images.push(undefined);
          continue;
        }
        let bytes = done.get(t.timeMs);
        if (!bytes) {
          bytes = await renderer.frame(t.timeMs, { format: "jpeg", quality: 85 });
          done.set(t.timeMs, bytes);
        }
        images.push(bytes);
      }
      await renderer.checkRevision();
    } finally {
      await renderer.close();
    }

    // Lay the tiles out: one row per seam with --cuts, a grid otherwise.
    const tiles: SheetTile[] = [];
    const pages: { tile: number; row: number; column: number }[][] = [];
    if (options.cuts) {
      plan.tiles.forEach((t, i) => {
        const seamIndex = Math.floor(i / CUT_OFFSETS.length);
        const sheet = Math.floor(seamIndex / layout.rows);
        const row = seamIndex % layout.rows,
          column = i % CUT_OFFSETS.length;
        (pages[sheet] ??= []).push({ tile: i, row, column });
        tiles.push({ ...t, sheet: sheet + 1, row, column });
      });
    } else
      plan.tiles.forEach((t, i) => {
        const sheet = Math.floor(i / layout.perSheet),
          within = i % layout.perSheet;
        const row = Math.floor(within / layout.columns),
          column = within % layout.columns;
        (pages[sheet] ??= []).push({ tile: i, row, column });
        tiles.push({ ...t, sheet: sheet + 1, row, column });
      });

    const context = await browser.newContext({
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: 1,
    });
    const sheets: Buffer[] = [];
    try {
      const page = await context.newPage();
      for (const [index, cells] of pages.entries()) {
        const rowCount = Math.max(...cells.map((c) => c.row)) + 1;
        const html: string[] = [];
        for (let row = 0; row < rowCount; row++) {
          const inRow = cells.filter((c) => c.row === row);
          if (!inRow.length) continue;
          if (options.cuts) {
            const seam = plan.seams[index * layout.rows + row]!;
            html.push(
              `<div class="seam">${escapeHtml(`${seam.seam} · ${seconds(seam.timeMs)}`)}</div>`,
            );
          }
          html.push('<div class="row">');
          for (const cell of inRow) {
            const t = plan.tiles[cell.tile]!,
              image = images[cell.tile];
            html.push(
              `<figure>${
                image
                  ? `<img src="data:image/jpeg;base64,${image.toString("base64")}">`
                  : '<div class="none"></div>'
              }<figcaption>${escapeHtml(t.label)}</figcaption></figure>`,
            );
          }
          html.push("</div>");
        }
        const { width, height } = layout.tile;
        await page.setContent(
          `<!doctype html><html><head><style>
            html,body{margin:0;background:#1b1b1b;color:#e8e8e8}
            body{display:inline-block;padding:${GAP}px;font:13px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace}
            .row{display:flex;gap:${GAP}px;margin-bottom:${GAP}px}
            .seam{margin:4px 0 6px;font-weight:600;color:#fff}
            figure{margin:0;width:${width}px}
            img,.none{display:block;width:${width}px;height:${height}px;background:#000}
            .none{background:repeating-linear-gradient(45deg,#222 0 8px,#2a2a2a 8px 16px)}
            figcaption{height:${LABEL}px;padding-top:4px;box-sizing:border-box;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
          </style></head><body>${html.join("")}</body></html>`,
          { waitUntil: "load" },
        );
        const box = await page.evaluate(() => {
          const r = document.body.getBoundingClientRect();
          return { width: Math.ceil(r.width), height: Math.ceil(r.height) };
        });
        await page.setViewportSize(box);
        sheets.push(
          await page.screenshot({
            type: "jpeg",
            quality: 88,
            clip: { x: 0, y: 0, ...box },
          }),
        );
      }
    } finally {
      await context.close();
    }
    return {
      sheets,
      tiles,
      revision: bundle.revision,
      durationMs: plan.total,
      size: bundle.project.viewport,
      tile: layout.tile,
    };
  } finally {
    await browser.close();
  }
}

/** `studio sheet`: write numbered JPEGs and return their paths and tiles.
 * Default destination: a new folder under the project's ignored `.studio/`. */
export async function writeSheets(
  dir: string,
  options: SheetOptions & { output?: string } = {},
) {
  const project = path.resolve(dir);
  await loadBundle(project);
  let folder: string;
  if (options.output) {
    folder = path.resolve(options.output);
    await mkdir(path.dirname(folder), { recursive: true });
    // A new folder: a run never overwrites earlier sheets.
    await mkdir(folder).catch((error) => {
      throw error.code === "EEXIST"
        ? new Error(`${folder} already exists. Choose a new folder.`)
        : error;
    });
  } else {
    // Runtime state, never tracked: `.studio/` keeps itself out of git.
    await ensureIgnoredFolder(project, ".studio");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    folder = await ensureRealFolders(project, `.studio/sheets/${stamp}`);
  }
  const started = performance.now();
  const result = await renderSheets(project, options);
  const files: string[] = [];
  for (const [i, bytes] of result.sheets.entries()) {
    const file = path.join(folder, `sheet-${String(i + 1).padStart(2, "0")}.jpg`);
    await writeFile(file, bytes, { flag: "wx" });
    files.push(file);
  }
  return {
    projectDir: project,
    revision: result.revision,
    durationMs: result.durationMs,
    size: result.size,
    tile: result.tile,
    sheets: files,
    tiles: result.tiles,
    renderMs: Math.round(performance.now() - started),
  };
}
