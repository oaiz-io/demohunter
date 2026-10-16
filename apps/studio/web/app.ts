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
if ("__TAURI__" in window || "__TAURI_INTERNALS__" in window)
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
let manualError = "",
  fileError = "",
  jobError = "";
const narrationPlayback = new NarrationPlayback(report);
let audioNeedsSeek = true;
let workspaceData: WorkspaceData, workbench: AgentWorkbench;
let timeline: Timeline | undefined;
let hoverRef: string | undefined,
  firstSnapshotMs = 0,
  lastCommand = "";
const feedback = new AgentFeedback((ref) => boxOf({ ref }), selectRef);
$("#export-open").onclick = () => {
  renderExportReadiness();
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
      $("#export-status").textContent = "Preparing saved replay…";
      $("#export-progress").hidden = false;
    })
    .catch((error) => {
      $("#export-status").textContent =
        error instanceof Error ? error.message : String(error);
    });
for (const [id, file] of [
  ["export-video", "video.mp4"],
  ["export-captions", "captions.vtt"],
  ["export-manifest", "manifest.json"],
])
  $<HTMLAnchorElement>(`#${id}`).href = projectUrl(
    `/api/export/download/${file}`,
  );
const renderMode = new URLSearchParams(location.search).get("render") === "1";
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
  $("#save-indicator").textContent = count
    ? `${count} unsaved change${count === 1 ? "" : "s"}`
    : "";
  $("#save-indicator").hidden = !count;
}

function replaySource(): number {
  return Math.max(firstSnapshotMs + 1, outputToSource(bundle.edits, position));
}

async function api<T>(url: string, data?: unknown): Promise<T> {
  const response = await fetch(
    projectUrl(url),
    data === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error ?? `Request failed: ${response.status}`);
  return result;
}
function showErrors(): void {
  const text = [manualError, fileError, jobError].filter(Boolean).join("\n");
  $("#error").textContent = text;
  $("#error").hidden = !text;
}
function report(error: unknown): void {
  manualError = error instanceof Error ? error.message : String(error);
  showErrors();
}
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
    const record = workspaceData?.index.elements.find(
      (e) => e.ref === target.ref,
    );
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
  return Math.max(
    1,
    events.filter((event) => event.type === 4 && event.timestamp <= timestamp)
      .length,
  );
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
  $("#camera").style.transform =
    `translate(${cameraX}px,${cameraY}px) scale(${cameraScale})`;
  // Marks drawn inside the scaled recording keep a constant screen size.
  $("#camera").style.setProperty(
    "--unscale",
    String(1 / Math.max(0.05, baseScale * cameraScale)),
  );
  $("#effects").replaceChildren();
  for (const highlight of bundle.edits.highlights) {
    if (position < highlight.startMs || position >= highlight.endMs) continue;
    const box = boxOf(highlight.target);
    if (!box) continue;
    const ring = document.createElement("div");
    ring.className = "highlight";
    Object.assign(ring.style, {
      left: `${box.x - highlight.padding}px`,
      top: `${box.y - highlight.padding}px`,
      width: `${box.width + highlight.padding * 2}px`,
      height: `${box.height + highlight.padding * 2}px`,
      borderColor: highlight.color,
    });
    $("#effects").append(ring);
  }
  const box = selection ? boxOf(selectionTarget()) : undefined;
  $("#selection-box").hidden = !selection || !box || !$("#panel-edit").hidden;
  if (box) {
    Object.assign($("#selection-box").style, {
      left: `${box.x}px`,
      top: `${box.y}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    });
    $("#selection-box .selection-label").textContent =
      `${selection!.tag} · ${selection!.elementRef ?? `node ${selection!.nodeId}`}`;
  }
  elementEditor?.draw(!$("#panel-edit").hidden && !playing && !renderMode);
  placeToolbar((!!box || !!elementEditor?.rect()) && !playing && !renderMode);
  const hoverBox = hoverRef ? boxOf({ ref: hoverRef }) : undefined;
  $("#hover-box").hidden = !hoverBox;
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
  $("#time").textContent = clockMs(position);
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
      if (
        $("#scene-title").textContent !== title ||
        $("#scene-number").textContent !== label
      ) {
        $("#scene-number").textContent = label;
        $("#scene-title").textContent = title;
      }
      break;
    }
    offset = end;
  }
}
/** Which scene an agent call is changing, for the timeline stripes. */
function sceneOfActivity(activity: AgentActivity): string | undefined {
  if (activity.segmentId)
    return bundle.narration.segments.find((s) => s.id === activity.segmentId)
      ?.clipId;
  const record = activity.elementRef
    ? workspaceData?.index.elements.find((e) => e.ref === activity.elementRef)
    : undefined;
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
}
async function reload(): Promise<void> {
  if (reloading) return;
  reloading = true;
  try {
    const next = await api<ReplayBundle>("/api/project");
    if (!workspaceData)
      workspaceData = await api<WorkspaceData>("/api/workspace");
    if (!events) {
      events = await api<eventWithTime[]>("/api/events");
      firstSnapshotMs =
        (events.find((event) => event.type === 2)?.timestamp ??
          events[0]!.timestamp) - events[0]!.timestamp;
    }
    const changedVisuals =
      !bundle ||
      JSON.stringify([bundle.project.viewport, bundle.edits, bundle.css]) !==
        JSON.stringify([next.project.viewport, next.edits, next.css]);
    restoreAnimations();
    elementOverrides.restore();
    bundle = next;
    sceneLayer.load(bundle);
    // Sounds declared inside scene pages are known once the pages load.
    void sceneLayer
      .ready()
      .then(() => timeline?.render(workbench?.agentMarks() ?? []));
    position = Math.min(position, totalDuration(bundle.edits));
    if (changedVisuals || !replayer) {
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
    }
    lastTick = performance.now();
    $("#project-title").textContent = bundle.project.title;
    document.title = `${bundle.project.title} · DemoHunter Studio`;
    $("#file-revision").textContent = bundle.revision.slice(0, 8);
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
      });
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
  const record = workspaceData?.index.elements.find((e) => e.ref === ref);
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
    node &&
    workspaceData.index.elements.find(
      (e) =>
        e.nodeId === replayer?.getMirror().getId(node) &&
        e.documentId === currentDocumentId(),
    );
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
  const entry = pickEditable(event);
  if (entry) {
    selectEditable(entry);
    $("#element-text").focus();
  }
};
$("#select-layer").onmousemove = (event: MouseEvent) => {
  const node = pickNode(event);
  const nodeId = node && replayer?.getMirror().getId(node);
  hoverRef = workspaceData?.index.elements.find(
    (e) => e.nodeId === nodeId && e.documentId === currentDocumentId(),
  )?.ref;
};
$("#select-layer").onmouseleave = () => {
  hoverRef = undefined;
};
/** Bring an element into view without selecting it (Show on canvas). */
function showElement(ref: string): void {
  const record = workspaceData?.index.elements.find((e) => e.ref === ref);
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
function renderExportReadiness(): void {
  const duration = totalDuration(bundle.edits);
  $("#export-revision").textContent = `rev ${bundle.revision.slice(0, 8)}`;
  $("#export-output").textContent =
    `${workspaceData.projectDir.replace(/^.*\/(\.demohunter\/)/, "$1")}/exports/export-…`;
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
    setPlaying(!playing);
  }
  if (event.code === "ArrowRight") seek(position + 1000);
  if (event.code === "ArrowLeft") seek(position - 1000);
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
    position += now - lastTick;
    if (position >= totalDuration(bundle.edits)) {
      position = totalDuration(bundle.edits);
      setPlaying(false);
    }
  }
  lastTick = now;
  if (!reloading) update();
  requestAnimationFrame(tick);
}
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
    $("#narration-job").textContent = status.narrationMessage;
    if (status.export) {
      $<HTMLButtonElement>("#export-start").disabled = status.export.running;
      $("#export-status").textContent =
        status.export.error ?? status.export.message;
      $("#export-downloads").hidden = !status.export.directory;
      const progress = /Rendering (\d+)s \/ (\d+)s/.exec(status.export.message);
      $("#export-progress").hidden = !status.export.running;
      $("#export-progress").style.setProperty(
        "--progress",
        progress
          ? `${(Number(progress[1]) / Math.max(1, Number(progress[2]))) * 100}%`
          : "4%",
      );
    }
    feedback.update(status.activity ?? []);
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
let publishing = false;
async function publishPreview(): Promise<void> {
  if (publishing || !bundle || reloading || renderMode) return;
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
