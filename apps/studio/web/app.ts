import { initializeShell } from "./shell.js";
import { NarrationPlayback } from "./audio.js";
import { SceneLayer, type SceneCue } from "./scenes.js";
import {
  ElementEditor,
  sceneSelector,
  type Editable,
} from "./element-editor.js";
import { ElementOverrides } from "./element-overrides.js";
import { MotionAudio } from "./motion-audio.js";
import { snapshotElement, type Snapshot } from "./snapshot.js";
import { projectUrl } from "./transport.js";
import { AgentFeedback } from "./feedback.js";
import {
  audioIsCurrent,
  clipDuration,
  narrationStart,
  outputToSource,
  totalDuration,
  sourceToOutput,
  clipStart,
  sampleAnimation,
  type ReplayBundle,
  type Target,
} from "../model.js";
import type { Replayer, eventWithTime } from "rrweb";
import { TranscriptEditor, type ScriptPatch } from "./transcript.js";
import { AgentWorkbench, toast, type WorkspaceData } from "./workbench.js";
import { AgentChat, standaloneAgents } from "./agent-chat.js";
import { parseReference } from "../links.js";
import { Timeline, clockMs } from "./timeline.js";
import type { HistoryItem } from "./agent.js";
import type { AgentActivity } from "../contract.js";

declare global {
  interface Window {
    rrweb: { Replayer: typeof Replayer };
    __replayLab?: {
      seek: (ms: number) => void;
      select: (ref: string, ms?: number) => void;
      state: () => unknown;
      scenesReady: () => Promise<void>;
      sceneCues: () => SceneCue[];
      snapshot: (target: Target) => Snapshot | undefined;
    };
  }
}
const $ = <T extends HTMLElement = HTMLElement>(selector: string): T =>
  document.querySelector<T>(selector)!;
/** Write text only when it changed: idle frames and polls must not touch the
 * DOM (a rewrite drops text selections and restarts screen-reader output). */
function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}
function setHidden(node: HTMLElement, hidden: boolean): void {
  if (node.hidden !== hidden) node.hidden = hidden;
}
let bundle: ReplayBundle,
  events: eventWithTime[],
  replayer: Replayer | undefined;
let position = 0,
  playing = false,
  lastTick = 0;
let interactionMode: "select" | "comment" = "select";
const sceneLayer = new SceneLayer($("#scene-layer"));
const motionAudio = new MotionAudio();
const elementOverrides = new ElementOverrides();
let elementEditor: ElementEditor | undefined;
initializeShell();
if (
  "demohunterDesktop" in window ||
  "__TAURI__" in window ||
  "__TAURI_INTERNALS__" in window
)
  document.body.classList.add("desktop");
// In the library the logo and "Demos" go back to the repo's demo list.
{
  const back = $<HTMLAnchorElement>(".library-back");
  const inLibrary = back.getAttribute("href") === "/";
  if (!inLibrary) {
    back.hidden = false;
    back.removeAttribute("href");
    back.removeAttribute("title");
    back.setAttribute("aria-label", "DemoHunter Studio");
  }
  for (const node of document.querySelectorAll<HTMLElement>(
    "[data-library-only]",
  ))
    node.hidden = !inLibrary;
  if (inLibrary) $<HTMLAnchorElement>(".crumb-link").href = "/";
}
let statusHistory: HistoryItem[] = [];
let selection:
  | {
      nodeId: number;
      documentId: number;
      tag: string;
      selector: string;
      text: string;
      attributes: Record<string, string>;
      elementRef?: string;
    }
  | undefined;
let lastSource = -1,
  baseScale = 1,
  cameraScale = 1,
  cameraX = 0,
  cameraY = 0,
  reloading = false;
let reloadRun: Promise<void> | undefined,
  reloadFollowUp: Promise<void> | undefined;
let manualError = "",
  fileError = "",
  jobError = "",
  dismissedError = "";
const narrationPlayback = new NarrationPlayback(report);
let audioNeedsSeek = true;
let workspaceData: WorkspaceData, workbench: AgentWorkbench;
let timeline: Timeline | undefined;
let agentChat: AgentChat | undefined;
/** What the current replayer was built from; see runReload. */
let builtReplay = "";
let hoverRef: string | undefined,
  firstSnapshotMs = 0,
  lastCommand = "";
/** Captured elements by ref and by document+node, for per-frame lookups. */
type ElementRecord = WorkspaceData["index"]["elements"][number];
let recordsByRef = new Map<string, ElementRecord>(),
  recordsByNode = new Map<string, ElementRecord>();
/** Timestamps of the recording's full snapshots (one per document). */
let snapshotTimes: number[] = [];
const recordOf = (ref: string | undefined) =>
  ref === undefined ? undefined : recordsByRef.get(ref);
const recordAt = (nodeId: number | null | undefined, documentId: number) =>
  nodeId == null ? undefined : recordsByNode.get(`${documentId}:${nodeId}`);
const feedback = new AgentFeedback((ref) => boxOf({ ref }), selectRef);
$("#export-open").onclick = () => {
  renderExportReadiness(true);
  $<HTMLDialogElement>("#export-dialog").showModal();
};
$("#export-close").onclick = () =>
  $<HTMLDialogElement>("#export-dialog").close();
$("#export-cancel").onclick = () =>
  $<HTMLDialogElement>("#export-dialog").close();
$("#export-start").onclick = () =>
  void transcript
    .flushAll()
    .then(() => elementEditor?.flushAll())
    .then(() => api("/api/export", { revision: bundle.revision }))
    .then(() => {
      setText($("#export-status"), "Preparing saved replay…");
      $("#export-progress").hidden = false;
    })
    .catch((error) => {
      // Idle polls leave this alone until the export itself changes state.
      setText(
        $("#export-status"),
        error instanceof Error ? error.message : String(error),
      );
    });
for (const [id, file] of [
  ["export-video", "video.mp4"],
  ["export-captions", "captions.vtt"],
  ["export-manifest", "manifest.json"],
])
  $<HTMLAnchorElement>(`#${id}`).href = projectUrl(
    `/api/export/download/${file}`,
  );
/** In the desktop app exports open in place instead of downloading. */
const desktopFiles = (
  window as {
    demohunterDesktop?: {
      openFile(file: string): Promise<unknown>;
      showFile(file: string): Promise<unknown>;
    };
  }
).demohunterDesktop;
let exportDirectory: string | undefined;
if (desktopFiles?.openFile) {
  $("#export-video").textContent = "Open video";
  for (const [id, file] of [
    ["export-video", "video.mp4"],
    ["export-captions", "captions.vtt"],
    ["export-manifest", "manifest.json"],
  ] as const)
    $(`#${id}`).onclick = (event) => {
      if (!exportDirectory) return;
      event.preventDefault();
      void desktopFiles.openFile(`${exportDirectory}/${file}`);
    };
  const reveal = document.createElement("a");
  reveal.className = "quiet small-text";
  reveal.href = "#";
  reveal.textContent = "Show in Finder";
  reveal.onclick = (event) => {
    event.preventDefault();
    if (exportDirectory)
      void desktopFiles.showFile(`${exportDirectory}/video.mp4`);
  };
  $("#export-downloads").append(reveal);
}
type DesktopTrust = { trust?: () => unknown };
const desktopTrust = () =>
  (window as { demohunterDesktop?: DesktopTrust }).demohunterDesktop;
/** Untrusted folders load scene pages without scripts; say so, quietly. */
function renderTrustNotice(): void {
  setHidden($("#scene-trust"), workspaceData?.trusted !== false);
  setHidden($("#trust-folder"), typeof desktopTrust()?.trust !== "function");
}
$("#trust-folder").onclick = () => {
  const desktop = desktopTrust();
  if (typeof desktop?.trust !== "function") return;
  void Promise.resolve(desktop.trust())
    .then(async () => {
      workspaceData.trusted = (
        await api<WorkspaceData>("/api/workspace")
      ).trusted;
      renderTrustNotice();
      await reload();
    })
    .catch(report);
};
const renderMode = new URLSearchParams(location.search).get("render") === "1";
// Leaving a demo marks it as looked at, so agent changes made while it was
// open don't show up as "Updated" in the library.
const libraryDemo = /^\/projects\/([a-f0-9]{16})\//.exec(
  location.pathname,
)?.[1];
if (libraryDemo && !renderMode)
  addEventListener("pagehide", () =>
    navigator.sendBeacon("/api/seen", JSON.stringify({ id: libraryDemo })),
  );
let saveQueue = Promise.resolve();
function queued<T>(work: () => Promise<T>): Promise<T> {
  const result = saveQueue.catch(() => {}).then(work);
  saveQueue = result.then(
    () => {},
    () => {},
  );
  return result;
}
const transcript = new TranscriptEditor($("#narration-list"), {
  save: (id, patch, base, force) =>
    queued(async () => {
      const latest = await api<ReplayBundle>("/api/project");
      const current = latest.narration.segments.find((s) => s.id === id);
      if (!current)
        throw new Error(
          "This segment was removed elsewhere. Copy your text before discarding it.",
        );
      for (const key of Object.keys(patch) as (keyof ScriptPatch)[])
        if (!force && current[key] !== base[key] && current[key] !== patch[key])
          throw new Error(
            "This segment changed in the file or another editor. Your draft is preserved; choose which version to keep.",
          );
      Object.assign(current, patch);
      await api("/api/save", {
        file: "narration.json",
        value: latest.narration,
        revision: latest.revision,
      });
      await reload();
      return current;
    }),
  regenerate: async (ids) => {
    setPlaying(false);
    await api("/api/narrate", { segmentIds: ids });
    toast("Narration generation started");
  },
  remove: (id) =>
    queued(async () => {
      const latest = await api<ReplayBundle>("/api/project");
      latest.narration.segments = latest.narration.segments.filter(
        (s) => s.id !== id,
      );
      await api("/api/save", {
        file: "narration.json",
        value: latest.narration,
        revision: latest.revision,
      });
      await reload();
    }),
  dirty: () => updateSaveIndicator(),
  error: report,
});

function updateSaveIndicator(): void {
  const count = transcript.dirtyCount + (elementEditor?.dirtyCount ?? 0);
  setText(
    $("#save-indicator"),
    count ? `${count} unsaved change${count === 1 ? "" : "s"}` : "",
  );
  setHidden($("#save-indicator"), !count);
}

function replaySource(): number {
  return Math.max(firstSnapshotMs + 1, outputToSource(bundle.edits, position));
}

/** Background writes that say nothing about whether the user's last action
 * worked, so they never clear a shown error. */
const quietWrites = new Set(["/api/preview-state", "/api/selection"]);
async function api<T>(url: string, data?: unknown): Promise<T> {
  const body = data === undefined ? undefined : JSON.stringify(data);
  const response = await fetch(
    projectUrl(url),
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          // Small saves started while the page closes still reach the server.
          // Chromium caps keepalive bodies (bytes, shared across requests).
          keepalive: new TextEncoder().encode(body).length < 30_000,
        },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error ?? `Request failed: ${response.status}`);
  // A later successful action means the old message no longer applies.
  if (body !== undefined && manualError && !quietWrites.has(url)) {
    manualError = "";
    showErrors();
  }
  return result;
}
function showErrors(): void {
  const text = [manualError, fileError, jobError].filter(Boolean).join("\n");
  if (!text) dismissedError = "";
  const shown = text === dismissedError ? "" : text;
  setText($("#error-text"), shown);
  setHidden($("#error"), !shown);
}
function report(error: unknown): void {
  manualError = error instanceof Error ? error.message : String(error);
  dismissedError = "";
  showErrors();
}
$("#error-dismiss").onclick = () => {
  dismissedError = [manualError, fileError, jobError]
    .filter(Boolean)
    .join("\n");
  showErrors();
};
function pauseAudio(): void {
  narrationPlayback.pause();
  motionAudio.pause();
}
function setPlaying(value: boolean): void {
  if (!bundle) return;
  if (value && position >= totalDuration(bundle.edits) - 1) position = 0;
  playing = value;
  audioNeedsSeek = true;
  $("#select-layer").hidden = playing;
  lastTick = performance.now();
  $("#play")
    .querySelector("use")!
    .setAttribute("href", playing ? "#i-pause" : "#i-play");
  $("#play").setAttribute("aria-label", playing ? "Pause" : "Play");
  lastSource = -1;
  if (!playing) {
    replayer?.pause(replaySource());
    pauseAudio();
  }
  update();
}
function seek(ms: number): void {
  position = Math.max(0, Math.min(totalDuration(bundle.edits), ms));
  lastTick = performance.now();
  lastSource = -1;
  audioNeedsSeek = true;
  replayer?.pause(replaySource());
  update();
}

function findTargets(target: Target): Element[] {
  if (target.scene) {
    try {
      return sceneLayer
        .documents(false)
        .filter((layer) => layer.src === target.scene)
        .flatMap((layer) => [
          ...layer.document.querySelectorAll(target.selector!),
        ])
        .slice(0, 100);
    } catch {
      return [];
    }
  }
  if (target.ref) {
    const record = recordOf(target.ref);
    if (!record) return [];
    target = { nodeId: record.nodeId, documentId: record.documentId };
  }
  const doc = replayer?.iframe.contentDocument;
  if (
    !doc ||
    !replayer ||
    (target.documentId !== undefined &&
      target.documentId !== currentDocumentId())
  )
    return [];
  if (target.nodeId !== undefined) {
    const node = replayer.getMirror().getNode(target.nodeId);
    return node?.nodeType === 1 ? [node as Element] : [];
  }
  try {
    return [...doc.querySelectorAll(target.selector!)].slice(0, 100);
  } catch {
    return [];
  }
}
function currentDocumentId(): number {
  if (!events || !bundle) return 1;
  const timestamp =
    events[0]!.timestamp + outputToSource(bundle.edits, position);
  // How many full snapshots started by now (binary search over sorted times).
  let low = 0,
    high = snapshotTimes.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (snapshotTimes[mid]! <= timestamp) low = mid + 1;
    else high = mid;
  }
  return Math.max(1, low);
}
function selectionTarget(): Target {
  return selection!.elementRef
    ? { ref: selection!.elementRef }
    : { nodeId: selection!.nodeId, documentId: selection!.documentId };
}
function boxOf(target: Target): DOMRect | undefined {
  return findTargets(target)[0]?.getBoundingClientRect();
}
function applyOverrides(): void {
  if (!bundle || !replayer) return;
  const doc = replayer.iframe.contentDocument;
  if (!doc?.head) return;
  let style = doc.getElementById("__dhReplayOverrides");
  if (!style) {
    style = doc.createElement("style");
    style.id = "__dhReplayOverrides";
    doc.head.append(style);
  }
  if (style.textContent !== bundle.css) style.textContent = bundle.css;
  elementOverrides.restore();
  elementOverrides.apply(
    elementEditor?.edits() ?? bundle.edits.elements,
    findTargets,
  );
}
function drawEffects(): void {
  if (!bundle) return;
  feedback.draw();
  cameraScale = 1;
  cameraX = 0;
  cameraY = 0;
  const camera = bundle.edits.camera.findLast(
    (effect) => position >= effect.startMs && position < effect.endMs,
  );
  if (camera) {
    const box = camera.target ? boxOf(camera.target) : undefined;
    const x = box
      ? box.x + box.width / 2
      : (camera.x ?? bundle.project.viewport.width / 2);
    const y = box
      ? box.y + box.height / 2
      : (camera.y ?? bundle.project.viewport.height / 2);
    // Short eased entry/exit; camera motion never changes layout inside the replay.
    const ease = Math.max(
      1,
      Math.min(camera.easeMs ?? 300, (camera.endMs - camera.startMs) / 2),
    );
    const edge = Math.min(
      1,
      (position - camera.startMs) / ease,
      (camera.endMs - position) / ease,
    );
    const blend = edge * edge * (3 - 2 * edge);
    cameraScale = 1 + (camera.scale - 1) * blend;
    cameraX = Math.max(
      bundle.project.viewport.width * (1 - cameraScale),
      Math.min(0, bundle.project.viewport.width / 2 - x * cameraScale),
    );
    cameraY = Math.max(
      bundle.project.viewport.height * (1 - cameraScale),
      Math.min(0, bundle.project.viewport.height / 2 - y * cameraScale),
    );
  }
  // Skip identical style writes: they still cost a style recalculation.
  const transform = `translate(${cameraX}px,${cameraY}px) scale(${cameraScale})`;
  if (transform !== drawn.camera) {
    drawn.camera = transform;
    $("#camera").style.transform = transform;
  }
  // Marks drawn inside the scaled recording keep a constant screen size.
  const unscale = String(1 / Math.max(0.05, baseScale * cameraScale));
  if (unscale !== drawn.unscale) {
    drawn.unscale = unscale;
    $("#camera").style.setProperty("--unscale", unscale);
  }
  // Highlight rings are reused in place while the frame moves.
  const rings: { box: DOMRect; padding: number; color: string }[] = [];
  for (const highlight of bundle.edits.highlights) {
    if (position < highlight.startMs || position >= highlight.endMs) continue;
    const box = boxOf(highlight.target);
    if (box) rings.push({ box, ...highlight });
  }
  const effects = $("#effects");
  while (effects.children.length > rings.length)
    effects.lastElementChild!.remove();
  rings.forEach(({ box, padding, color }, i) => {
    let ring = effects.children[i] as HTMLElement | undefined;
    if (!ring) {
      ring = document.createElement("div");
      ring.className = "highlight";
      effects.append(ring);
    }
    Object.assign(ring.style, {
      left: `${box.x - padding}px`,
      top: `${box.y - padding}px`,
      width: `${box.width + padding * 2}px`,
      height: `${box.height + padding * 2}px`,
      borderColor: color,
    });
  });
  const box = selection ? boxOf(selectionTarget()) : undefined;
  setHidden(
    $("#selection-box"),
    !selection || !box || !$("#panel-edit").hidden,
  );
  if (box) {
    Object.assign($("#selection-box").style, {
      left: `${box.x}px`,
      top: `${box.y}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    });
    setText(
      $("#selection-box .selection-label"),
      `${selection!.tag} · ${selection!.elementRef ?? `node ${selection!.nodeId}`}`,
    );
  }
  elementEditor?.draw(!$("#panel-edit").hidden && !playing && !renderMode);
  placeToolbar(
    (!!box || !!elementEditor?.rect()) &&
      !playing &&
      !renderMode &&
      !elementEditor?.editingText,
  );
  const hoverBox = hoverRef ? boxOf({ ref: hoverRef }) : undefined;
  setHidden($("#hover-box"), !hoverBox);
  if (hoverBox)
    Object.assign($("#hover-box").style, {
      left: `${hoverBox.x}px`,
      top: `${hoverBox.y}px`,
      width: `${hoverBox.width}px`,
      height: `${hoverBox.height}px`,
    });
  // Keep pin nodes between preview frames so pointer/keyboard clicks can finish.
  const pinContainer = $("#comment-pins");
  const previousPins = new Map(
    [...pinContainer.querySelectorAll<HTMLButtonElement>(".comment-pin")].map(
      (pin) => [pin.dataset.threadId!, pin] as const,
    ),
  );
  if (!renderMode)
    for (const [i, thread] of bundle.comments.threads.entries()) {
      if (
        thread.status !== "open" ||
        !thread.elementRef ||
        Math.abs(position - thread.timeMs) > 3000
      )
        continue;
      const target = boxOf({ ref: thread.elementRef });
      if (!target) continue;
      let pin = previousPins.get(thread.id);
      previousPins.delete(thread.id);
      if (!pin) {
        pin = document.createElement("button");
        pin.dataset.threadId = thread.id;
        pin.onclick = () => workbench.openThread(thread.id);
        pinContainer.append(pin);
      }
      pin.className = `comment-pin${thread.elementRef === selection?.elementRef ? " active" : ""}`;
      pin.textContent = String(i + 1);
      pin.title = thread.body;
      pin.setAttribute(
        "aria-label",
        `Note ${i + 1}: ${thread.body.slice(0, 100)}`,
      );
      // Pins sit at the element's top-right; near the top edge they hang below.
      const below = (cameraY + target.y * cameraScale) * baseScale < 28;
      pin.classList.toggle("below", below);
      Object.assign(pin.style, {
        left: `${target.x + target.width + 2}px`,
        top: `${below ? target.y + target.height - 6 : target.y + 6}px`,
      });
    }
  for (const pin of previousPins.values()) pin.remove();
}
/** What drawEffects last wrote, to skip identical writes. */
const drawn = { camera: "", unscale: "" };
/** The selection toolbar floats under (or above) the selected element, inside
 * the canvas, without covering the element itself. */
function placeToolbar(visible: boolean): void {
  const toolbar = $("#selection-toolbar");
  if (!visible || (playing && !renderMode)) {
    toolbar.hidden = true;
    return;
  }
  toolbar.hidden = false;
  const wrap = $("#canvas-wrap").getBoundingClientRect();
  const stage = $("#stage").getBoundingClientRect();
  const target =
    elementEditor?.rect()?.box ?? $("#selection-box").getBoundingClientRect();
  const width = toolbar.offsetWidth,
    height = toolbar.offsetHeight;
  let left = target.right - wrap.left - width;
  left = Math.max(
    stage.left - wrap.left + 4,
    Math.min(left, stage.right - wrap.left - width - 4),
  );
  let top = target.bottom - wrap.top + 8;
  if (top + height > stage.bottom - wrap.top - 4)
    top = target.top - wrap.top - height - 30;
  top = Math.max(stage.top - wrap.top + 4, top);
  toolbar.style.left = `${Math.round(left)}px`;
  toolbar.style.top = `${Math.round(top)}px`;
}
const animated = new Map<
  HTMLElement,
  {
    transform: string;
    opacity: string;
    transformPriority: string;
    opacityPriority: string;
    lastTransform: string;
    lastOpacity: string;
  }
>();
function restoreAnimations(): void {
  for (const [node, original] of animated) {
    if (!node.isConnected) {
      animated.delete(node);
      continue;
    }
    if (node.style.transform === original.lastTransform)
      node.style.setProperty(
        "transform",
        original.transform,
        original.transformPriority,
      );
    else original.transform = node.style.transform;
    if (node.style.opacity === original.lastOpacity)
      node.style.setProperty(
        "opacity",
        original.opacity,
        original.opacityPriority,
      );
    else original.opacity = node.style.opacity;
  }
  animated.clear();
}
function applyAnimations(): void {
  for (const effect of bundle.edits.animations ?? []) {
    const sampled = sampleAnimation(effect, position);
    if (!sampled) continue;
    for (const element of findTargets(effect.target)) {
      const node = element as HTMLElement;
      let original = animated.get(node);
      if (!original) {
        original = {
          transform: node.style.transform,
          opacity: node.style.opacity,
          transformPriority: node.style.getPropertyPriority("transform"),
          opacityPriority: node.style.getPropertyPriority("opacity"),
          lastTransform: "",
          lastOpacity: "",
        };
        animated.set(node, original);
      }
      const computed = node.ownerDocument.defaultView!.getComputedStyle(node);
      node.style.setProperty(
        "transform",
        `${computed.transform === "none" ? "" : computed.transform} translate(${sampled.x}px, ${sampled.y}px) scale(${sampled.scale}) rotate(${sampled.rotate}deg)`,
        "important",
      );
      node.style.setProperty(
        "opacity",
        String(sampled.opacity * Number(computed.opacity)),
        "important",
      );
      original.lastTransform = node.style.transform;
      original.lastOpacity = node.style.opacity;
    }
  }
}
function syncAudio(): void {
  narrationPlayback.sync(bundle, position, playing, audioNeedsSeek);
  motionAudio.sync(
    bundle,
    position,
    playing,
    audioNeedsSeek,
    sceneLayer.cues(),
  );
  audioNeedsSeek = false;
}
/** Paused frames are redrawn only when something they show has changed. */
let frameUpdates = 0,
  frameDirty = true,
  frameKeyDrawn = "",
  frameDrawnAt = 0;
const markDirty = () => {
  frameDirty = true;
};
/** Re-measure at least this often even when nothing reported a change:
 * images and fonts finishing inside the recording move boxes silently. */
const HEARTBEAT_MS = 250;
/** Longest step playback takes in one frame; a stalled tab must not jump. */
const MAX_FRAME_MS = 250;
function frameKey(): string {
  const stage = $("#stage"),
    pointer = elementEditor?.pointer,
    agent = feedback.current();
  return [
    position,
    bundle.revision,
    selection?.elementRef ?? selection?.nodeId ?? "",
    hoverRef ?? "",
    sceneLayer.generation,
    stage.clientWidth,
    stage.clientHeight,
    baseScale,
    agent?.id ?? "",
    agent?.status ?? "",
    pointer ? `${pointer.x},${pointer.y}` : "",
    transcript.dirtyCount + (elementEditor?.dirtyCount ?? 0),
    elementEditor?.selected?.target.ref ??
      elementEditor?.selected?.target.selector ??
      "",
  ].join("|");
}
function update(): void {
  if (!bundle || !replayer) return;
  const source = replaySource();
  if (playing) {
    const next = outputToSource(
      bundle.edits,
      Math.min(totalDuration(bundle.edits), position + 20),
    );
    const holding = Math.abs(next - source) < 0.01;
    if (holding) {
      if (lastSource !== source) replayer.pause(source);
    } else {
      const rate = (next - source) / 20;
      if (
        lastSource < 0 ||
        Math.abs(replayer.getCurrentTime() - source) > 180 ||
        Math.abs(source - lastSource) > 250
      ) {
        replayer.setConfig({ speed: Math.max(0.1, rate) });
        replayer.play(source);
      } else replayer.setConfig({ speed: Math.max(0.1, rate) });
    }
  }
  lastSource = source;
  restoreAnimations();
  elementOverrides.restore();
  sceneLayer.update(position, totalDuration(bundle.edits));
  applyOverrides();
  applyAnimations();
  const backdrop = sceneLayer.backdrop(bundle, position);
  const filter =
    backdrop.blur || backdrop.dim
      ? `blur(${backdrop.blur.toFixed(2)}px) brightness(${(1 - backdrop.dim).toFixed(3)})`
      : "";
  if ($("#replay").style.filter !== filter) $("#replay").style.filter = filter;
  drawEffects();
  updateSaveIndicator();
  syncAudio();
  workbench?.updateTime();
  setText($("#time"), clockMs(position));
  timeline?.update(position, feedback.current(), sceneOfActivity);
  let offset = 0;
  for (const [i, clip] of bundle.edits.clips.entries()) {
    const end = offset + clipDuration(clip);
    if (position < end || i === bundle.edits.clips.length - 1) {
      transcript.setActive(
        bundle.narration.segments.find((s) => s.clipId === clip.id)?.id,
      );
      const label = String(i + 1).padStart(2, "0");
      const title = workbench?.sceneTitle(i) ?? "";
      setText($("#scene-number"), label);
      setText($("#scene-title"), title);
      break;
    }
    offset = end;
  }
  frameUpdates++;
  frameDirty = false;
  frameKeyDrawn = frameKey();
  frameDrawnAt = performance.now();
}
/** Which scene an agent call is changing, for the timeline stripes. */
function sceneOfActivity(activity: AgentActivity): string | undefined {
  if (activity.segmentId)
    return bundle.narration.segments.find((s) => s.id === activity.segmentId)
      ?.clipId;
  const record = recordOf(activity.elementRef);
  if (!record) return undefined;
  const time = sourceToOutput(bundle.edits, record.firstSeenMs + 2);
  if (time === undefined) return undefined;
  let offset = 0;
  for (const clip of bundle.edits.clips) {
    offset += clipDuration(clip);
    if (time < offset) return clip.id;
  }
  return bundle.edits.clips.at(-1)?.id;
}
function resize(): void {
  if (!bundle) return;
  const stage = $("#stage");
  const { width, height } = bundle.project.viewport;
  baseScale = Math.min(stage.clientWidth / width, stage.clientHeight / height);
  Object.assign($("#viewport").style, {
    width: `${width}px`,
    height: `${height}px`,
    transform: `translate(-50%,-50%) scale(${baseScale})`,
  });
  markDirty();
}
/**
 * Reload the project. A call that arrives while a reload is running is not
 * dropped (its caller just saved and needs the newest files): one follow-up
 * reload runs afterwards and every such caller waits for it.
 */
function reload(): Promise<void> {
  if (!reloadRun) {
    reloadRun = runReload().finally(() => {
      reloadRun = undefined;
    });
    return reloadRun;
  }
  reloadFollowUp ??= reloadRun
    .catch(() => {})
    .then(() => {
      reloadFollowUp = undefined;
      return reload();
    });
  return reloadFollowUp;
}
async function runReload(): Promise<void> {
  reloading = true;
  try {
    const next = await api<ReplayBundle>("/api/project");
    if (!workspaceData) {
      workspaceData = await api<WorkspaceData>("/api/workspace");
      recordsByRef = new Map(
        workspaceData.index.elements.map((e) => [e.ref, e]),
      );
      recordsByNode = new Map(
        workspaceData.index.elements.map((e) => [
          `${e.documentId}:${e.nodeId}`,
          e,
        ]),
      );
      renderTrustNotice();
    }
    if (!events) {
      events = await api<eventWithTime[]>("/api/events");
      firstSnapshotMs =
        (events.find((event) => event.type === 2)?.timestamp ??
          events[0]!.timestamp) - events[0]!.timestamp;
      snapshotTimes = events
        .filter((event) => event.type === 4)
        .map((event) => event.timestamp)
        .sort((a, b) => a - b);
    }
    // Only what the replayer itself is built from forces a rebuild. Element
    // edits, clips, camera, overlays and the rest are applied on every frame,
    // so saving an edit must not tear the recording down.
    const replayKey = JSON.stringify([
      next.project.viewport,
      next.css,
      workspaceData.index.captureId,
    ]);
    restoreAnimations();
    elementOverrides.restore();
    bundle = next;
    sceneLayer.load(bundle, workspaceData.trusted !== false);
    // Sounds declared inside scene pages are known once the pages load.
    void sceneLayer
      .ready()
      .then(() => timeline?.render(workbench?.agentMarks() ?? []));
    position = Math.min(position, totalDuration(bundle.edits));
    if (replayKey !== builtReplay || !replayer) {
      builtReplay = replayKey;
      pauseAudio();
      replayer?.destroy();
      $("#replay").replaceChildren();
      replayer = new window.rrweb.Replayer(structuredClone(events), {
        root: $("#replay"),
        skipInactive: false,
        showWarning: false,
        mouseTail: false,
        pauseAnimation: true,
        useVirtualDom: false,
      });
      replayer.on("event-cast", () => {
        restoreAnimations();
        applyOverrides();
      });
      replayer.on("fullsnapshot-rebuilded", () => {
        applyOverrides();
        resize();
      });
      replayer.pause(replaySource());
      lastSource = -1;
    } else if (!playing) {
      // Clip edits can map the same output time to another source moment;
      // a paused canvas must show it without waiting for a seek.
      replayer.pause(replaySource());
      lastSource = -1;
    }
    lastTick = performance.now();
    setText($("#project-title"), bundle.project.title);
    document.title = `${bundle.project.title} · DemoHunter Studio`;
    setText($("#file-revision"), bundle.revision.slice(0, 8));
    renderSaveState();
    $("#stage-loading").hidden = true;
    if (!workbench)
      workbench = new AgentWorkbench({
        data: () => workspaceData,
        bundle: () => bundle,
        time: () => position,
        selection: () => selection?.elementRef,
        select: selectRef,
        seek,
        hover: (ref) => {
          hoverRef = ref;
          drawEffects();
        },
        api,
        reload,
        error: report,
        showElement,
        sendToAgent: (id) =>
          void agentChat
            ?.sendNotes([id])
            .then(() => tab("agent"))
            .catch(report),
        noteAdded: (id) => {
          if (!agentChat?.settings?.autoSendNotes) return;
          void agentChat
            .sendNotes([id])
            .then(() => toast("Sent to your agent"))
            .catch(report);
        },
      });
    // In-Studio agents (library service only; not in headless renders).
    if (!agentChat && libraryDemo && !renderMode)
      agentChat = new AgentChat({
        project: () => libraryDemo,
        time: () => position,
        selection: () =>
          selection?.elementRef
            ? {
                ref: selection.elementRef,
                label: `${selection.tag} · ${selection.text.slice(0, 40)}`.trim(),
              }
            : undefined,
        error: report,
        toast,
        status: (status) => {
          const dot = $("#agent-dot");
          dot.hidden = status !== "working" && status !== "waiting";
          dot.classList.toggle("waiting", status === "waiting");
        },
      });
    else if (!agentChat && !document.body.classList.contains("no-agent-chat")) standaloneAgents();
    workbench.onReview = () => timeline?.render(workbench.agentMarks());
    timeline ??= new Timeline({
      bundle: () => bundle,
      seek: (ms) => {
        setPlaying(false);
        seek(ms);
      },
      openThread: (id) => workbench.openThread(id),
      frameUrl: (ms) =>
        renderMode
          ? undefined
          : projectUrl(`/api/frame?t=${Math.round(ms)}&r=${bundle.revision}`),
      waveform: (path) => transcript.waveform(path),
      sceneTitle: (i) => workbench.sceneTitle(i),
      sceneCues: () => sceneLayer.cues(),
    });
    elementEditor ??= new ElementEditor($("#panel-edit"), {
      bundle: () => bundle,
      resolve: (target) => findTargets(target)[0],
      frame: (node) =>
        node.ownerDocument === replayer?.iframe.contentDocument
          ? replayer.iframe
          : sceneLayer
              .documents(false)
              .find((layer) => layer.document === node.ownerDocument)?.iframe,
      entries: editableEntries,
      context: () =>
        sceneLayer
          .documents()
          .map((layer) => layer.src)
          .join("|"),
      select: selectEditable,
      api,
      reload,
      update,
      pause: () => setPlaying(false),
      editableOf,
      textLayers,
    });
    renderPanels();
    resize();
    update();
    fileError = "";
    showErrors();
  } finally {
    reloading = false;
  }
}
function renderPanels(): void {
  transcript.render(bundle);
  workbench.render();
  timeline?.render(workbench.agentMarks());
  renderScriptStatus();
}
function tab(name: string): void {
  $(".workspace").classList.remove("focus-mode");
  $("#focus-preview").setAttribute("aria-pressed", "false");
  for (const el of document.querySelectorAll<HTMLElement>("[data-tab]")) {
    el.classList.toggle("active", el.dataset.tab === name);
    if (el.getAttribute("role") === "tab")
      el.setAttribute("aria-selected", String(el.dataset.tab === name));
  }
  for (const panel of document.querySelectorAll<HTMLElement>(".panel"))
    panel.hidden = panel.id !== `panel-${name}`;
  markDirty();
  drawEffects();
}
function chooseTool(mode: "select" | "comment"): void {
  interactionMode = mode;
  setPlaying(false);
  document.body.dataset.tool = mode;
  $("#select-layer").hidden = false;
  $("#inspect-toggle").setAttribute("aria-pressed", String(mode === "select"));
  $("#tool-comment").setAttribute("aria-pressed", String(mode === "comment"));
  if (mode === "comment") tab("comments");
  markDirty();
  drawEffects();
}
function clearSelection(): void {
  selection = undefined;
  elementEditor?.select(undefined);
  hoverRef = undefined;
  chooseTool("select");
  workbench?.selectionChanged();
  drawEffects();
  void api("/api/selection", { clear: true })
    .then(() => publishPreview())
    .catch(report);
}

$("#play").onclick = () => setPlaying(!playing);
$("#inspect-toggle").onclick = () => chooseTool("select");
$("#tool-comment").onclick = () => chooseTool("comment");
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]"))
  button.onclick = () => tab(button.dataset.tab!);
function pickNode(event: MouseEvent): Element | null {
  if (!replayer) return null;
  const rect = replayer.iframe.getBoundingClientRect();
  let node = replayer.iframe.contentDocument?.elementFromPoint(
    (event.clientX - rect.left) / (baseScale * cameraScale),
    (event.clientY - rect.top) / (baseScale * cameraScale),
  );
  while (node && replayer.getMirror().getId(node) <= 0)
    node = node.parentElement;
  return node && !["HTML", "BODY"].includes(node.tagName) ? node : null;
}
function persistSelection(): void {
  if (!selection || renderMode) return;
  void api("/api/selection", {
    ...selection,
    sourceMs: outputToSource(bundle.edits, position),
    outputMs: position,
  }).catch(report);
}
function selectRef(ref: string, time?: number): void {
  const record = recordOf(ref);
  if (!record) {
    report(new Error("This element is not part of this capture."));
    return;
  }
  setPlaying(false);
  if (time !== undefined) seek(time);
  else if (!findTargets({ ref }).length)
    seek(sourceToOutput(bundle.edits, record.firstSeenMs + 2) ?? 0);
  const node = findTargets({ ref })[0];
  selection = {
    nodeId: record.nodeId,
    documentId: record.documentId,
    elementRef: ref,
    tag: record.tag,
    selector: record.selector,
    text: (node?.textContent ?? record.text).trim().slice(0, 4000),
    attributes: record.attributes,
  };
  elementEditor?.select({
    target: { ref },
    label: `${record.tag} · ${record.text.slice(0, 70) || record.selector}`,
  });
  workbench.selectionChanged();
  drawEffects();
  persistSelection();
}
function editableEntries(): Editable[] {
  const entries: Editable[] = (workspaceData?.index.elements ?? []).map(
    (e) => ({
      target: { ref: e.ref },
      label: `${e.tag} · ${e.text.slice(0, 70) || e.selector}`,
    }),
  );
  for (const layer of sceneLayer.documents()) {
    for (const node of layer.document.querySelectorAll("body, body *")) {
      if (["SCRIPT", "STYLE", "LINK", "META", "BR"].includes(node.tagName))
        continue;
      entries.push({
        target: { scene: layer.src, selector: sceneSelector(node) },
        label: `${node.localName} · ${(node.textContent?.trim() || node.id || layer.src).slice(0, 70)}`,
      });
    }
  }
  return entries;
}
function selectEditable(entry: Editable): void {
  setPlaying(false);
  if (entry.target.ref) selectRef(entry.target.ref);
  else {
    selection = undefined;
    elementEditor?.select(entry);
    workbench?.selectionChanged();
    void api("/api/selection", { clear: true }).catch(report);
  }
  tab("edit");
  drawEffects();
}
/** The editable target for a node in the recording or a scene page. */
function editableOf(node: Element): Editable | undefined {
  if (["HTML", "BODY"].includes(node.tagName)) return undefined;
  const layer = sceneLayer
    .documents(false)
    .find((l) => l.document === node.ownerDocument);
  if (layer)
    return {
      target: { scene: layer.src, selector: sceneSelector(node) },
      label: `${node.localName} · ${(node.textContent?.trim() || node.id || layer.src).slice(0, 70)}`,
    };
  if (!replayer || node.ownerDocument !== replayer.iframe.contentDocument)
    return undefined;
  const record = recordAt(
    replayer.getMirror().getId(node),
    currentDocumentId(),
  );
  return record
    ? {
        target: { ref: record.ref },
        label: `${record.tag} · ${record.text.slice(0, 70) || record.selector}`,
      }
    : undefined;
}
/** Documents visible on the current frame, top-most first. */
function textLayers(): Document[] {
  const docs: Document[] = [];
  for (const layer of sceneLayer.documents()) {
    docs.push(layer.document);
    if (layer.iframe.classList.contains("scene")) return docs;
  }
  const doc = replayer?.iframe.contentDocument;
  return doc ? [...docs, doc] : docs;
}
/** The deepest element under the pointer, in its own document's pixels. */
function pickText(
  event: MouseEvent,
): { node: Element; x: number; y: number } | undefined {
  for (const layer of sceneLayer.documents()) {
    const rect = layer.iframe.getBoundingClientRect();
    const x =
        ((event.clientX - rect.left) * layer.iframe.clientWidth) / rect.width,
      y =
        ((event.clientY - rect.top) * layer.iframe.clientHeight) / rect.height;
    const node = layer.document.elementFromPoint(x, y);
    if (node && !["HTML", "BODY"].includes(node.tagName)) return { node, x, y };
    if (layer.iframe.classList.contains("scene")) return undefined;
  }
  const doc = replayer?.iframe.contentDocument;
  if (!doc) return undefined;
  const rect = replayer!.iframe.getBoundingClientRect(),
    x = (event.clientX - rect.left) / (baseScale * cameraScale),
    y = (event.clientY - rect.top) / (baseScale * cameraScale);
  const node = doc.elementFromPoint(x, y);
  return node && !["HTML", "BODY"].includes(node.tagName)
    ? { node, x, y }
    : undefined;
}
function pickEditable(event: MouseEvent): Editable | undefined {
  for (const layer of sceneLayer.documents()) {
    const rect = layer.iframe.getBoundingClientRect();
    const node = layer.document.elementFromPoint(
      ((event.clientX - rect.left) * layer.iframe.clientWidth) / rect.width,
      ((event.clientY - rect.top) * layer.iframe.clientHeight) / rect.height,
    );
    if (node && !["HTML", "BODY"].includes(node.tagName))
      return {
        target: { scene: layer.src, selector: sceneSelector(node) },
        label: `${node.localName} · ${(node.textContent?.trim() || node.id || layer.src).slice(0, 70)}`,
      };
    // An opaque HTML scene covers the recording; an overlay can pass through.
    if (layer.iframe.classList.contains("scene"))
      return node
        ? {
            target: { scene: layer.src, selector: "body" },
            label: "Scene background",
          }
        : undefined;
  }
  const node = pickNode(event);
  const record =
    node && recordAt(replayer?.getMirror().getId(node), currentDocumentId());
  return record
    ? {
        target: { ref: record.ref },
        label: `${record.tag} · ${record.text.slice(0, 70) || record.selector}`,
      }
    : undefined;
}
$("#select-layer").addEventListener("pointerdown", (event) => {
  if (interactionMode !== "select" || $("#panel-edit").hidden) return;
  const entry = pickEditable(event);
  if (!entry) return;
  selectEditable(entry);
  elementEditor?.begin(event);
});
$("#select-layer").onclick = (event: MouseEvent) => {
  if (elementEditor?.consumeClick()) return;
  const entry = pickEditable(event);
  if (!entry) return;
  if (entry.target.ref) selectRef(entry.target.ref, position);
  else selectEditable(entry);
  if (interactionMode === "comment") {
    tab("comments");
    $<HTMLTextAreaElement>("#new-comment").focus();
  }
};
$("#select-layer").ondblclick = (event: MouseEvent) => {
  if (interactionMode !== "select" || renderMode) return;
  // Rewrite the double-clicked text in place; otherwise focus the panel.
  const hit = pickText(event);
  if (hit && elementEditor?.editText(hit.node, hit)) return;
  const entry = pickEditable(event);
  if (entry) {
    selectEditable(entry);
    $("#element-text").focus();
  }
};
$("#select-layer").onmousemove = (event: MouseEvent) => {
  if (elementEditor)
    elementEditor.pointer = { x: event.clientX, y: event.clientY };
  const node = pickNode(event);
  hoverRef = recordAt(
    node && replayer?.getMirror().getId(node),
    currentDocumentId(),
  )?.ref;
};
$("#select-layer").onmouseleave = () => {
  hoverRef = undefined;
  if (elementEditor) elementEditor.pointer = undefined;
};
/** Bring an element into view without selecting it (Show on canvas). */
function showElement(ref: string): void {
  const record = recordOf(ref);
  if (!record) return;
  if (!findTargets({ ref }).length) {
    setPlaying(false);
    seek(sourceToOutput(bundle.edits, record.firstSeenMs + 2) ?? position);
  }
  hoverRef = ref;
  drawEffects();
  setTimeout(() => {
    if (hoverRef === ref) hoverRef = undefined;
  }, 1600);
}
// Selection toolbar ---------------------------------------------------------
$("#toolbar-edit").onclick = () => {
  chooseTool("select");
  tab("edit");
};
$("#toolbar-note").onclick = () => workbench.focusComposer();
$("#toolbar-copy").onclick = () => {
  const entry = elementEditor?.selected;
  if (!entry?.target.scene) {
    void workbench.copyReference().catch(report);
    return;
  }
  const node = findTargets(entry.target)[0];
  void navigator.clipboard
    .writeText(
      JSON.stringify(
        {
          projectDir: workspaceData.projectDir,
          revision: bundle.revision,
          outputMs: position,
          target: entry.target,
          html: node?.outerHTML.slice(0, 16000),
          instruction:
            "Use apply_element_edit with this target and the latest expectedRevision.",
        },
        null,
        2,
      ),
    )
    .then(() => toast("Element context copied"))
    .catch(report);
};
// Script audio status ----------------------------------------------------------
function renderScriptStatus(): void {
  const segments = bundle.narration.segments.filter(
    (s) => s.text.trim() && narrationStart(bundle.edits, s) !== undefined,
  );
  const stale = segments.filter(
    (s) => s.audio && !audioIsCurrent(bundle.project, s),
  );
  const draft = segments.filter((s) => !s.audio);
  const missing = stale.length + draft.length;
  $("#script-dot").hidden = !missing;
  $("#audio-status").hidden = !segments.length;
  $("#audio-status").classList.toggle("ok", !missing);
  $("#audio-status-title").textContent = missing
    ? `${missing} segment${missing === 1 ? "" : "s"} need${missing === 1 ? "s" : ""} audio`
    : "All audio is current";
  $("#audio-status-detail").textContent = [
    stale.length ? `${stale.length} stale` : "",
    draft.length ? `${draft.length} draft` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  $("#regenerate").textContent = missing
    ? `Regenerate ${missing}`
    : "Regenerate all";
  $("#regenerate").className =
    `button small ${missing ? "primary" : "secondary"}`;
}
// Export readiness -------------------------------------------------------------
let readinessShown = "";
function renderExportReadiness(force = false): void {
  const duration = totalDuration(bundle.edits);
  setText($("#export-revision"), `rev ${bundle.revision.slice(0, 8)}`);
  setText(
    $("#export-output"),
    `${workspaceData.projectDir.replace(/^.*\/(\.demohunter\/)/, "$1")}/exports/export-…`,
  );
  const rows: {
    mark: string;
    title: string;
    detail?: string;
    action?: [string, () => void];
  }[] = [
    {
      mark: "ok",
      title: `${bundle.edits.clips.length} scenes · ${(duration / 1000).toFixed(1)} s · ${bundle.project.viewport.width} × ${bundle.project.viewport.height}`,
    },
  ];
  const segments = bundle.narration.segments.filter(
    (s) => s.text.trim() && narrationStart(bundle.edits, s) !== undefined,
  );
  const missing = segments.filter(
    (s) => !audioIsCurrent(bundle.project, s),
  ).length;
  rows.push(
    missing
      ? {
          mark: "bad",
          title: `${missing} of ${segments.length} segments have no current audio`,
          detail:
            "They are left silent. Captions still use the current script.",
          action: [
            "Regenerate",
            () => {
              $<HTMLDialogElement>("#export-dialog").close();
              tab("narration");
            },
          ],
        }
      : { mark: "ok", title: "All narration audio is current" },
  );
  // Restricted folders export what the editor shows: scenes without scripts.
  const scripted =
    bundle.edits.clips.some((c) => c.kind === "scene") ||
    !!bundle.edits.overlays?.length;
  if (workspaceData.trusted === false && scripted) {
    const trust = (window as { demohunterDesktop?: { trust?: () => unknown } })
      .demohunterDesktop?.trust;
    rows.push({
      mark: "bad",
      title: "Scene scripts are off for this folder",
      detail: "Animated scenes and overlays export as static pages.",
      ...(typeof trust === "function"
        ? {
            action: [
              "Trust folder…",
              () => {
                $<HTMLDialogElement>("#export-dialog").close();
                void trust();
              },
            ] as [string, () => void],
          }
        : {}),
    });
  }
  const open = bundle.comments.threads.filter(
    (t) => t.status === "open",
  ).length;
  if (open)
    rows.push({
      mark: "note",
      title: `${open} open note${open === 1 ? "" : "s"}`,
    });
  const running = feedback.activity().find((a) => a.status === "running");
  if (running)
    rows.push({
      mark: "agent",
      title: `${running.actor} is still editing`,
      detail: "If the files change while rendering, the export stops.",
    });
  // Polls re-run this while the dialog is open; rebuild only on a change.
  const signature = JSON.stringify(
    rows.map(({ mark, title, detail, action }) => [
      mark,
      title,
      detail,
      action?.[0],
    ]),
  );
  if (!force && signature === readinessShown) return;
  readinessShown = signature;
  const list = $("#export-readiness");
  list.replaceChildren(
    ...rows.map((row) => {
      const li = document.createElement("li");
      const mark = document.createElement("span");
      mark.className = "mark";
      if (row.mark === "ok") {
        mark.innerHTML =
          '<svg class="icon" aria-hidden="true"><use href="#i-check"/></svg>';
      } else if (row.mark === "note") {
        const pin = document.createElement("span");
        pin.className = "pin";
        mark.append(pin);
      } else {
        const dot = document.createElement("i");
        dot.className = row.mark;
        mark.append(dot);
      }
      const text = document.createElement("div");
      text.className = "text";
      const strong = document.createElement("strong");
      strong.style.fontWeight = "400";
      strong.textContent = row.title;
      text.append(strong);
      if (row.detail) {
        const detail = document.createElement("span");
        detail.textContent = row.detail;
        text.append(detail);
      }
      li.append(mark, text);
      if (row.action) {
        const button = document.createElement("button");
        button.className = "quiet";
        button.textContent = row.action[0];
        button.onclick = row.action[1];
        li.append(button);
      }
      return li;
    }),
  );
}
// Header save state ---------------------------------------------------------------
function renderSaveState(error?: string): void {
  const status = $("#live-status");
  status.dataset.state = error ? "error" : "saved";
  status.textContent = error ?? "Saved";
}
async function saveScript(): Promise<void> {
  await transcript.flushAll();
}
$("#save-narration").onclick = () => void saveScript().catch(report);
$("#regenerate").onclick = () => {
  setPlaying(false);
  manualError = "";
  void saveScript()
    .then(() => api("/api/narrate", {}))
    .catch(report);
};
$("#add-segment").onclick = () =>
  void queued(async () => {
    const latest = await api<ReplayBundle>("/api/project");
    const clip =
      latest.edits.clips.find((c) => {
        const start = clipStart(latest.edits, c.id)!;
        return position >= start && position < start + clipDuration(c);
      }) ?? latest.edits.clips[0]!;
    latest.narration.segments.push({
      id: `narration-${Date.now()}`,
      title: "New narration",
      clipId: clip.id,
      offsetMs: Math.max(0, position - clipStart(latest.edits, clip.id)!),
      text: "",
    });
    await api("/api/save", {
      file: "narration.json",
      value: latest.narration,
      revision: latest.revision,
    });
    await reload();
    toast("Narration segment added");
  }).catch(report);
document.addEventListener("keydown", (event) => {
  if (
    (event.target as HTMLElement).closest(
      "input,textarea,select,[contenteditable=true]",
    ) ||
    document.querySelector("dialog[open]")
  )
    return;
  if (
    event.code === "Space" &&
    (event.target as HTMLElement).closest("button,summary,a")
  )
    return;
  if (event.code === "Space") {
    event.preventDefault();
    // Holding the key must not flip play/pause on every repeat.
    if (!event.repeat) setPlaying(!playing);
  }
  // Cmd/Ctrl/Alt + arrows belong to the browser and the OS.
  if (!event.metaKey && !event.ctrlKey && !event.altKey) {
    if (event.code === "ArrowRight") seek(position + 1000);
    if (event.code === "ArrowLeft") seek(position - 1000);
  }
  if (
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey &&
    event.code === "KeyC"
  ) {
    event.preventDefault();
    void workbench.copyReference().catch(report);
    return;
  }
  if (
    document.querySelector("dialog[open]") ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  )
    return;
  if (event.code === "KeyV") {
    event.preventDefault();
    chooseTool("select");
  }
  if (event.code === "KeyC") {
    event.preventDefault();
    chooseTool("comment");
  }
  if (event.code === "KeyS") {
    event.preventDefault();
    tab("narration");
  }
  if (event.code === "Escape" && !$("#scene-drawer").matches(":popover-open"))
    clearSelection();
});
new ResizeObserver(resize).observe($("#stage"));
function tick(now: number): void {
  if (playing && bundle && !reloading && !narrationPlayback.buffering) {
    position += Math.min(now - lastTick, MAX_FRAME_MS);
    if (position >= totalDuration(bundle.edits)) {
      position = totalDuration(bundle.edits);
      setPlaying(false);
    }
  }
  lastTick = now;
  if (
    !reloading &&
    bundle &&
    (playing ||
      frameDirty ||
      now - frameDrawnAt > HEARTBEAT_MS ||
      frameKey() !== frameKeyDrawn)
  )
    update();
  requestAnimationFrame(tick);
}
let lastExportState = "";
async function poll(): Promise<void> {
  try {
    const status = await api<{
      revision?: string;
      error?: string;
      narrating: boolean;
      narrationMessage: string;
      narrationError: string;
      command?: { id: string; elementRef?: string; outputMs: number };
      historyCount: number;
      history?: HistoryItem[];
      activity?: AgentActivity[];
      export?: {
        running: boolean;
        message: string;
        error?: string;
        directory?: string;
      };
    }>(`/api/status?focused=${document.hasFocus() ? 1 : 0}`);
    fileError = status.error
      ? `Project files need attention; showing the last valid version. ${status.error}`
      : "";
    jobError = status.narrationError;
    statusHistory = status.history ?? [];
    renderSaveState(status.error ? "Waiting for valid files" : undefined);
    $<HTMLButtonElement>("#regenerate").disabled = status.narrating;
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      ".segment-generate",
    ))
      button.disabled = status.narrating;
    $<HTMLButtonElement>("#undo").disabled = status.historyCount === 0;
    setText($("#narration-job"), status.narrationMessage);
    if (status.export) {
      $<HTMLButtonElement>("#export-start").disabled = status.export.running;
      // Only a change of the export's own state replaces the status line, so
      // an error from starting it stays until something new happens.
      const exportState = JSON.stringify([
        status.export.running,
        status.export.error,
        status.export.message,
      ]);
      if (exportState !== lastExportState) {
        lastExportState = exportState;
        setText(
          $("#export-status"),
          status.export.error ?? status.export.message,
        );
      }
      setHidden($("#export-downloads"), !status.export.directory);
      exportDirectory = status.export.directory;
      const progress = /Rendering (\d+)s \/ (\d+)s/.exec(status.export.message);
      setHidden($("#export-progress"), !status.export.running);
      $("#export-progress").style.setProperty(
        "--progress",
        progress
          ? `${(Number(progress[1]) / Math.max(1, Number(progress[2]))) * 100}%`
          : "4%",
      );
    }
    feedback.update(status.activity ?? []);
    markDirty();
    workbench?.live(status.activity ?? [], statusHistory);
    if ($<HTMLDialogElement>("#export-dialog").open && !status.export?.running)
      renderExportReadiness();
    if (status.revision && status.revision !== bundle?.revision) await reload();
    if (status.command && status.command.id !== lastCommand) {
      if (!initialLink) {
        if (status.command.elementRef)
          selectRef(status.command.elementRef, status.command.outputMs);
        else seek(status.command.outputMs);
      }
      lastCommand = status.command.id;
      sessionStorage.setItem(
        `demohunter-command-${workspaceData.index.captureId}`,
        lastCommand,
      );
    }
    initialLink = false;
    showErrors();
  } catch (error) {
    fileError = `Preview disconnected: ${error instanceof Error ? error.message : String(error)}`;
    renderSaveState("Disconnected");
    showErrors();
  }
  setTimeout(() => void poll(), 800);
}
let initialLink = !!location.hash;
function applyLocation(): void {
  if (!location.hash || !workspaceData) return;
  try {
    const params = new URLSearchParams(location.hash.slice(1));
    if (params.has("comment") || params.has("element")) {
      const reference = parseReference(location.href);
      if (reference.captureId !== workspaceData.index.captureId)
        throw new Error(
          "This link belongs to a different capture. Open that project to follow it.",
        );
      if (reference.commentId !== undefined)
        workbench.openThread(reference.commentId);
      else selectRef(reference.elementRef, reference.timeMs);
    } else if (params.has("t")) {
      const time = Number(params.get("t"));
      if (Number.isFinite(time) && time >= 0) seek(time);
    }
  } catch (error) {
    report(error);
  }
}
window.addEventListener("hashchange", applyLocation);
let publishing = false,
  publishedKey = "",
  publishedAt = 0;
/** Agents treat a preview as connected if it reported within 8 s. */
const PUBLISH_REFRESH_MS = 5000;
async function publishPreview(): Promise<void> {
  if (publishing || !bundle || reloading || renderMode) return;
  // A hidden window (behind the agent's terminal) still sends the periodic
  // heartbeat, so agents keep seeing the preview as connected.
  if (document.hidden && Date.now() - publishedAt < PUBLISH_REFRESH_MS) return;
  const key = [
    position,
    playing,
    bundle.revision,
    selection?.elementRef ?? selection?.nodeId ?? "",
    lastCommand,
    baseScale,
    cameraX,
    cameraY,
    cameraScale,
  ].join("|");
  // Nothing moved: only a periodic refresh keeps the preview "connected".
  if (key === publishedKey && Date.now() - publishedAt < PUBLISH_REFRESH_MS)
    return;
  publishing = true;
  try {
    const node = selection && findTargets(selectionTarget())[0];
    const rect = node?.getBoundingClientRect();
    const styles: Record<string, string> = {};
    if (node) {
      const computed = node.ownerDocument.defaultView!.getComputedStyle(node);
      for (const name of [
        "color",
        "background-color",
        "font-family",
        "font-size",
        "font-weight",
        "line-height",
        "display",
        "visibility",
        "opacity",
        "transform",
        "border-radius",
        "padding",
      ])
        styles[name] = computed.getPropertyValue(name);
    }
    await api("/api/preview-state", {
      outputMs: position,
      sourceMs: outputToSource(bundle.edits, position),
      playing,
      elementRef: selection?.elementRef,
      html: node?.outerHTML.slice(0, 30000),
      styles: node ? styles : undefined,
      bounds: rect
        ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        : undefined,
      acknowledgedCommand: lastCommand || undefined,
    });
    publishedKey = key;
    publishedAt = Date.now();
  } catch {
    /* Project status polling reports connection failures. */
  } finally {
    publishing = false;
  }
}
window.addEventListener("beforeunload", (event) => {
  if (transcript.dirtyCount || elementEditor?.dirtyCount)
    event.preventDefault();
});
/** Save every pending draft (script text and element edits). */
function flushDrafts(): Promise<void> {
  return transcript.flushAll().then(() => elementEditor?.flushAll());
}
const hasDrafts = () =>
  transcript.dirtyCount + (elementEditor?.dirtyCount ?? 0) > 0;
// Leaving the page must not lose what was typed in the last second.
if (!renderMode) {
  // On pagehide there is no second round trip: start both flushes at once.
  addEventListener("pagehide", () => {
    void transcript.flushAll().catch(() => {});
    void elementEditor?.flushAll().catch(() => {});
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) return;
    // A hidden tab neither shows nor needs playback; stop instead of racing
    // ahead on the first frame back.
    if (playing) setPlaying(false);
    if (hasDrafts()) void flushDrafts().catch(() => {});
  });
  // In-app navigation (library, crumbs) saves first and stays put on failure.
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    const link = (event.target as Element).closest<HTMLAnchorElement>(
      "a[href]",
    );
    if (!link || link.target || link.hasAttribute("download") || !hasDrafts())
      return;
    const url = new URL(link.href, location.href);
    if (
      url.origin !== location.origin ||
      (url.pathname === location.pathname && url.search === location.search)
    )
      return;
    event.preventDefault();
    void flushDrafts()
      .then(() => location.assign(url.href))
      .catch(report);
  });
}
window.__replayLab = {
  seek,
  select: selectRef,
  state: () => ({
    position,
    sourceMs: bundle ? outputToSource(bundle.edits, position) : 0,
    playing,
    revision: bundle?.revision,
    selection,
    durationMs: bundle && totalDuration(bundle.edits),
    /** Full frame updates so far; paused, unchanged frames are skipped. */
    updates: frameUpdates,
    ready: !!bundle && !!replayer,
    captureId: workspaceData?.index.captureId,
  }),
  scenesReady: () => sceneLayer.ready(),
  sceneCues: () => sceneLayer.cues(),
  snapshot: (target) => {
    const element = findTargets(target)[0];
    return element ? snapshotElement(element) : undefined;
  },
};
void reload()
  .then(() => {
    lastCommand =
      sessionStorage.getItem(
        `demohunter-command-${workspaceData.index.captureId}`,
      ) ?? "";
    if (!renderMode) chooseTool("select");
    applyLocation();
    requestAnimationFrame(tick);
    if (!renderMode) {
      void poll();
      void publishPreview();
      setInterval(() => void publishPreview(), 1200);
    }
  })
  .catch(report);
