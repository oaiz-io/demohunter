import { initializeShell } from "./shell.js";
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
  narrationSchema,
  sampleAnimation,
  type NarrationSegment,
  type ReplayBundle,
  type Target,
  type ReplayEdits,
} from "../model.js";
import type { Replayer, eventWithTime } from "rrweb";
import { TranscriptEditor, type ScriptPatch } from "./transcript.js";
import { AgentWorkbench, toast, type WorkspaceData } from "./workbench.js";
import { parseReference } from "../links.js";
import { Timeline, clockMs } from "./timeline.js";
import type { HistoryItem } from "./agent.js";
import type { GitStatus } from "../git.js";
import type { AgentActivity } from "../contract.js";

declare global {
  interface Window {
    rrweb: { Replayer: typeof Replayer };
    __replayLab?: {
      seek: (ms: number) => void;
      select: (ref: string, ms?: number) => void;
      state: () => unknown;
    };
  }
}
const $ = <T extends HTMLElement = HTMLElement>(selector: string): T =>
  document.querySelector<T>(selector)!;
const fmt = (ms: number): string =>
  `${Math.floor(ms / 60000)
    .toString()
    .padStart(2, "0")}:${Math.floor((ms / 1000) % 60)
    .toString()
    .padStart(2, "0")}`;
const input = (selector: string) => $<HTMLInputElement>(selector);
let bundle: ReplayBundle,
  events: eventWithTime[],
  replayer: Replayer | undefined;
let position = 0,
  playing = false,
  speed = 1,
  lastTick = 0,
  inspecting = true;
let interactionMode: "select" | "comment" = "select";
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
let statusHistory: HistoryItem[] = [],
  statusGit: GitStatus | undefined,
  lastFollowed = "";
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
const audio = new Map<string, HTMLAudioElement>();
let workspaceData: WorkspaceData, workbench: AgentWorkbench;
let timeline: Timeline | undefined;
let voiceBase: string | undefined;
let hoverRef: string | undefined,
  voiceDirty = false,
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
$("#export-fps").onchange = () => renderExportReadiness();
$("#export-start").onclick = () =>
  void transcript
    .flushAll()
    .then(() =>
      api("/api/export", {
        revision: bundle.revision,
        fps: Number(input("#export-fps").value),
        strictAudio: input("#export-strict").checked,
      }),
    )
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
  preview: (time) => {
    seek(time);
    setPlaying(true);
  },
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
  const count = transcript.dirtyCount;
  const text = [
    count ? `${count} unsaved script change${count === 1 ? "" : "s"}` : "",
    voiceDirty ? "Unsaved voice settings" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  $("#save-indicator").textContent = text;
  $("#save-indicator").hidden = !text;
}
$("#discard-voice").onclick = () => {
  voiceDirty = false;
  renderPanels();
  updateSaveIndicator();
};

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
  for (const player of audio.values()) player.pause();
}
function setPlaying(value: boolean): void {
  if (!bundle) return;
  if (value && position >= totalDuration(bundle.edits) - 1) position = 0;
  playing = value;
  $("#select-layer").hidden = playing || !inspecting;
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
  replayer?.pause(replaySource());
  update();
}

function findTargets(target: Target): Element[] {
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
  for (const edit of bundle.edits.elements)
    for (const node of findTargets(edit.target)) {
      const el = node as HTMLElement;
      if (edit.text !== undefined) {
        // Keep rrweb's mirrored nodes alive. Replacing innerHTML/textContent would
        // detach nodes that later replay mutations still need to address.
        const walker = doc.createTreeWalker(node, 4);
        let leaf: Node | null;
        const leaves: Node[] = [];
        while ((leaf = walker.nextNode()))
          if (!leaf.parentElement?.closest("script,style,noscript"))
            leaves.push(leaf);
        if (!leaves.length) node.append(doc.createTextNode(edit.text));
        else
          for (let i = 0; i < leaves.length; i++) {
            const text = i === 0 ? edit.text : "";
            if (leaves[i]!.nodeValue !== text) leaves[i]!.nodeValue = text;
          }
      }
      if (edit.hidden)
        el.style.setProperty("visibility", "hidden", "important");
      for (const [name, value] of Object.entries(edit.style ?? {}))
        el.style.setProperty(name, value, "important");
    }
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
    const edge = Math.min(
      1,
      (position - camera.startMs) / 300,
      (camera.endMs - position) / 300,
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
  $("#selection-box").hidden = !selection || !box;
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
  placeToolbar(!!box && !playing && !renderMode);
  const hoverBox = hoverRef ? boxOf({ ref: hoverRef }) : undefined;
  $("#hover-box").hidden = !hoverBox;
  if (hoverBox)
    Object.assign($("#hover-box").style, {
      left: `${hoverBox.x}px`,
      top: `${hoverBox.y}px`,
      width: `${hoverBox.width}px`,
      height: `${hoverBox.height}px`,
    });
  $("#comment-pins").replaceChildren();
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
      const pin = document.createElement("button");
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
      pin.onclick = () => workbench.openThread(thread.id);
      $("#comment-pins").append(pin);
    }
}
/** The selection toolbar floats under (or above) the selected element, inside
 * the canvas, without covering the element itself. */
function placeToolbar(visible: boolean): void {
  const toolbar = $("#selection-toolbar");
  if (!visible || (playing && !renderMode)) {
    toolbar.hidden = true;
    $("#toolbar-edit-menu").hidden = true;
    return;
  }
  toolbar.hidden = false;
  const wrap = $("#canvas-wrap").getBoundingClientRect();
  const stage = $("#stage").getBoundingClientRect();
  const target = $("#selection-box").getBoundingClientRect();
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
  for (const segment of bundle.narration.segments) {
    const start = narrationStart(bundle.edits, segment);
    const ready = segment.audio && audioIsCurrent(bundle.project, segment);
    let player = audio.get(segment.id);
    if (!ready || start === undefined) {
      player?.pause();
      continue;
    }
    const url = new URL(
      projectUrl(`/files/${segment.audio!.path}`),
      location.href,
    ).href;
    if (!player || player.src !== url) {
      player?.pause();
      player = new Audio(url);
      player.preload = "auto";
      audio.set(segment.id, player);
    }
    const elapsed = position - start;
    if (elapsed < 0 || elapsed >= segment.audio!.durationMs) {
      player.pause();
      continue;
    }
    player.playbackRate = speed;
    if (Math.abs(player.currentTime * 1000 - elapsed) > 180) {
      try {
        player.currentTime = elapsed / 1000;
      } catch {
        /* Wait for metadata. */
      }
    }
    if (playing && player.paused)
      void player.play().catch((error) => {
        if (error.name !== "AbortError") {
          manualError =
            "Audio could not play. Check the audio file and click Play again.";
          showErrors();
        }
      });
    if (!playing) player.pause();
  }
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
      const rate = ((next - source) / 20) * speed;
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
  applyOverrides();
  applyAnimations();
  drawEffects();
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
    bundle = next;
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
      replayer.on("event-cast", applyOverrides);
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
    renderGitState();
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
        projectUrl(`/api/frame?t=${Math.round(ms)}&r=${bundle.revision}`),
      waveform: (path) => transcript.waveform(path),
      sceneTitle: (i) => workbench.sceneTitle(i),
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
  $("#timing-list").replaceChildren();
  $("#effects-list").replaceChildren();
  let offset = 0;
  for (const [i, clip] of bundle.edits.clips.entries()) {
    const start = offset;
    offset += clipDuration(clip);
    const title =
      bundle.narration.segments.find((s) => s.clipId === clip.id)?.title ??
      `Scene ${i + 1}`;
    const card = document.createElement("div");
    card.className = "timing-card";
    card.dataset.id = clip.id;
    const top = document.createElement("div");
    top.className = "card-top";
    const label = document.createElement("span");
    label.textContent = title;
    top.append(label);
    const jump = document.createElement("button");
    jump.textContent = clockMs(start);
    jump.className = "mono";
    jump.onclick = () => seek(start);
    top.append(jump);
    card.append(top);
    const fields = document.createElement("div");
    fields.className = "timing-fields";
    for (const [key, name, value] of [
      ["sourceStartMs", "Start", clip.sourceStartMs / 1000],
      ["sourceEndMs", "End", clip.sourceEndMs / 1000],
      ["rate", "Speed", clip.rate],
      ["holdMs", "Hold", clip.holdMs / 1000],
    ] as const) {
      const field = document.createElement("label");
      field.textContent = name;
      const control = document.createElement("input");
      control.type = "number";
      control.step = "0.1";
      control.min = "0";
      control.value = String(Math.round(value * 1000) / 1000);
      control.dataset.field = key;
      control.setAttribute("aria-label", `${name} for ${clip.id}`);
      field.append(control);
      fields.append(field);
    }
    card.append(fields);
    $("#timing-list").append(card);
  }
  transcript.render(bundle);
  workbench.render();
  timeline?.render(workbench.agentMarks());
  renderScriptStatus();
  $("#voice-settings").textContent = JSON.stringify(
    bundle.project.tts,
    null,
    2,
  );
  if (!voiceDirty) {
    voiceBase = JSON.stringify(bundle.project.tts);
    $<HTMLSelectElement>("#tts-provider").value = bundle.project.tts.provider;
    input("#tts-voice").value = bundle.project.tts.voice;
    input("#tts-model").value = bundle.project.tts.model;
    input("#tts-language").value = bundle.project.tts.language ?? "";
    $<HTMLTextAreaElement>("#tts-instructions").value =
      bundle.project.tts.instructions;
  }
  for (const [kind, effects] of [
    ["camera", bundle.edits.camera],
    ["highlights", bundle.edits.highlights],
    ["animations", bundle.edits.animations ?? []],
  ] as const)
    for (const effect of effects) {
      const row = document.createElement("div");
      row.className = "effect-item";
      const label = document.createElement("span");
      label.textContent = `${kind === "camera" ? "Zoom" : kind === "highlights" ? "Highlight" : "Animation"} · ${fmt(effect.startMs)}–${fmt(effect.endMs)}`;
      const remove = document.createElement("button");
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove ${effect.id}`);
      remove.onclick = () => {
        const next = structuredClone(bundle.edits);
        if (kind === "camera")
          next.camera = next.camera.filter((e) => e.id !== effect.id);
        else if (kind === "highlights")
          next.highlights = next.highlights.filter((e) => e.id !== effect.id);
        else
          next.animations = next.animations?.filter((e) => e.id !== effect.id);
        void save("edits.json", next).catch(report);
      };
      row.append(label, remove);
      $("#effects-list").append(row);
    }
  renderSelection();
}
function renderSelection(): void {
  $("#element-tab").hidden = !selection;
  $("#selection-empty").hidden = !!selection;
  $("#selection-detail").hidden = !selection;
  if (!selection) return;
  $("#selected-tag").textContent =
    workspaceData?.index.elements.find((e) => e.ref === selection?.elementRef)
      ?.name ?? `<${selection.tag}>`;
  $("#selected-id").textContent =
    selection.elementRef ??
    `doc ${selection.documentId} · node ${selection.nodeId}`;
  $("#selected-selector").textContent = selection.selector;
  $<HTMLTextAreaElement>("#selection-text").value =
    bundle.edits.elements.find(
      (e) =>
        (e.target.ref === selection!.elementRef &&
          selection!.elementRef !== undefined) ||
        (e.target.nodeId === selection!.nodeId &&
          (e.target.documentId ?? 1) === selection!.documentId),
    )?.text ?? selection.text;
  workbench?.selectionChanged();
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
}
async function save(
  file: "edits.json" | "narration.json" | "project.json" | "comments.json",
  value: unknown,
): Promise<void> {
  manualError = "";
  await api("/api/save", { file, value, revision: bundle.revision });
  await reload();
}
function chooseTool(mode: "select" | "comment"): void {
  interactionMode = mode;
  inspecting = true;
  setPlaying(false);
  document.body.dataset.tool = mode;
  $("#select-layer").hidden = false;
  $("#inspect-toggle").setAttribute("aria-pressed", String(mode === "select"));
  $("#tool-comment").setAttribute("aria-pressed", String(mode === "comment"));
  $("#canvas-instruction").textContent =
    mode === "comment"
      ? "Click an element to add a note"
      : "Paused · click anything to select it";
  if (mode === "comment") tab("comments");
  drawEffects();
}
function clearSelection(): void {
  selection = undefined;
  hoverRef = undefined;
  chooseTool("select");
  if (!$("#panel-selection").hidden) tab("comments");
  renderSelection();
  drawEffects();
  void api("/api/selection", { clear: true })
    .then(() => publishPreview())
    .catch(report);
}

$("#play").onclick = () => setPlaying(!playing);
$("#restart").onclick = () => seek(0);
$("#speed").onchange = () => {
  speed = Number($<HTMLSelectElement>("#speed").value);
  lastSource = -1;
};
$("#inspect-toggle").onclick = () => chooseTool("select");
$("#tool-comment").onclick = () => chooseTool("comment");
$("#select-start").onclick = () => {
  chooseTool("select");
};
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
function selectRef(
  ref: string,
  time?: number,
  options: { inspect?: boolean } = {},
): void {
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
  // Selecting shows the toolbar; the Element panel opens on Inspect.
  if (options.inspect) tab("selection");
  renderSelection();
  drawEffects();
  persistSelection();
}
$("#select-layer").onclick = (event: MouseEvent) => {
  const node = pickNode(event);
  if (!node || !replayer) return;
  const nodeId = replayer.getMirror().getId(node),
    documentId = currentDocumentId();
  const record = workspaceData.index.elements.find(
    (e) => e.nodeId === nodeId && e.documentId === documentId,
  );
  if (record) {
    selectRef(record.ref, position);
    if (interactionMode === "comment") {
      tab("comments");
      $<HTMLTextAreaElement>("#new-comment").focus();
    }
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
/** Bring an element into view without selecting it (agent follow/show). */
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
$("#toolbar-note").onclick = () => workbench.focusComposer();
$("#toolbar-copy").onclick = () =>
  void workbench.copyReference(true).catch(report);
$("#toolbar-inspect").onclick = () => tab("selection");
$("#toolbar-edit").onclick = () => {
  const menu = $("#toolbar-edit-menu");
  menu.hidden = !menu.hidden;
  $("#toolbar-edit").setAttribute("aria-expanded", String(!menu.hidden));
};
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "#toolbar-edit-menu [data-edit]",
))
  button.onclick = () => {
    $("#toolbar-edit-menu").hidden = true;
    $("#toolbar-edit").setAttribute("aria-expanded", "false");
    const action = button.dataset.edit;
    if (action === "text") {
      tab("selection");
      $<HTMLDetailsElement>(".manual-edits").open = true;
      $<HTMLTextAreaElement>("#selection-text").focus();
    } else if (action === "hide") void editSelection("hide").catch(report);
    else if (action === "zoom") addEffect("camera");
    else if (action === "highlight") addEffect("highlights");
    else if (action === "animate") $("#add-animation").click();
  };
document.addEventListener("pointerdown", (event) => {
  if (!(event.target as HTMLElement).closest(".toolbar-menu"))
    $("#toolbar-edit-menu").hidden = true;
});
// Find and replace ------------------------------------------------------------
function findMatches(query: string) {
  if (!query || !workspaceData) return [];
  const q = query.toLowerCase();
  const overrides = new Map(
    bundle.edits.elements
      .filter((e) => e.target.ref && e.text !== undefined)
      .map((e) => [e.target.ref!, e.text!]),
  );
  const elements = workspaceData.index.elements.filter((e) =>
    (overrides.get(e.ref) ?? e.text).toLowerCase().includes(q),
  );
  const refs = new Set(elements.map((e) => e.ref));
  // Leaf matches only: a parent's text includes its children's text.
  return elements
    .filter((e) => !e.children.some((child) => refs.has(child)))
    .map((e) => ({ record: e, text: overrides.get(e.ref) ?? e.text }));
}
function renderFind(): void {
  const query = input("#find-input").value.trim();
  const matches = findMatches(query);
  const root = $("#find-results");
  root.replaceChildren();
  for (const match of matches.slice(0, 40)) {
    const row = document.createElement("button");
    row.className = "find-result";
    const text = document.createElement("span");
    const at = match.text.toLowerCase().indexOf(query.toLowerCase());
    const start = Math.max(0, at - 24);
    text.append(
      document.createTextNode((start ? "…" : "") + match.text.slice(start, at)),
    );
    const mark = document.createElement("mark");
    mark.textContent = match.text.slice(at, at + query.length);
    text.append(
      mark,
      document.createTextNode(
        match.text.slice(at + query.length, at + query.length + 40),
      ),
    );
    const ref = document.createElement("span");
    ref.className = "mono muted";
    ref.textContent = match.record.ref;
    row.append(text, ref);
    row.onclick = () => selectRef(match.record.ref);
    root.append(row);
  }
  $("#find-count").textContent = query
    ? `${matches.length} match${matches.length === 1 ? "" : "es"}${matches.length > 40 ? " · showing 40" : ""}`
    : "Text edits apply in every scene.";
  $<HTMLButtonElement>("#replace-all").disabled = !query || !matches.length;
}
function toggleFind(open?: boolean): void {
  const panel = $("#find-panel");
  panel.hidden = !(open ?? panel.hidden);
  $("#find-toggle").setAttribute("aria-pressed", String(!panel.hidden));
  if (!panel.hidden) {
    renderFind();
    input("#find-input").focus();
    input("#find-input").select();
  }
}
$("#find-toggle").onclick = () => toggleFind();
input("#find-input").oninput = renderFind;
$("#find-input").addEventListener("keydown", (event) => {
  if (event.key === "Escape") toggleFind(false);
});
$("#replace-all").onclick = () => {
  const query = input("#find-input").value.trim();
  const replacement = input("#replace-input").value;
  const matches = findMatches(query);
  if (!matches.length) return;
  const next = structuredClone(bundle.edits);
  const pattern = new RegExp(
    query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "gi",
  );
  for (const match of matches) {
    const id = `edit-${match.record.ref}`;
    let edit = next.elements.find((e) => e.id === id);
    if (!edit) {
      edit = { id, target: { ref: match.record.ref } };
      next.elements.push(edit);
    }
    edit.text = match.text.replace(pattern, replacement);
  }
  void save("edits.json", next)
    .then(() => {
      toast(
        `Replaced text in ${matches.length} element${matches.length === 1 ? "" : "s"}`,
      );
      renderFind();
    })
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
  const key =
    bundle.project.tts.provider === "openai"
      ? "OPENAI_API_KEY"
      : "ELEVENLABS_API_KEY";
  $("#audio-status-detail").textContent = missing
    ? `${[stale.length ? `${stale.length} stale` : "", draft.length ? `${draft.length} draft` : ""].filter(Boolean).join(", ")}. Uses ${key} from the service environment. Cached segments do not cost credits.`
    : `Regenerate only after you change the text or voice.`;
  $("#regenerate").textContent = missing
    ? `Regenerate ${missing}`
    : "Regenerate all";
  $("#regenerate").className =
    `button small ${missing ? "primary" : "secondary"}`;
  $("#voice-label").textContent =
    `${bundle.project.tts.provider === "openai" ? "OpenAI" : "ElevenLabs"} · ${bundle.project.tts.voice}`;
}
$("#voice-open").onclick = () => {
  const details = $<HTMLDetailsElement>("#voice-details");
  details.open = !details.open;
};
// Export readiness -------------------------------------------------------------
function renderExportReadiness(): void {
  const duration = totalDuration(bundle.edits);
  const fps = Number(input("#export-fps").value);
  $("#export-revision").textContent = `rev ${bundle.revision.slice(0, 8)}`;
  $("#export-frames").textContent =
    `${Math.ceil((duration * fps) / 1000)} frames at ${fps} fps`;
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
// Header git state ----------------------------------------------------------------
function renderGitState(error?: string): void {
  const status = $("#live-status");
  const git = statusGit ?? workspaceData?.git;
  if (git?.repository) {
    $("#repo-name").textContent = git.repository;
    $("#repo-name").hidden = false;
  }
  $("#git-branch").hidden = !git?.branch;
  $("#git-branch").textContent = git?.branch ? `⎇ ${git.branch}` : "";
  if (error) {
    status.dataset.state = "error";
    status.textContent = error;
  } else if (!git?.repository) {
    status.dataset.state = "saved";
    status.textContent = "Saved to files";
  } else if (git.ignored) {
    status.dataset.state = "saved";
    status.textContent = "Saved · not in git";
  } else if (git.changed.length) {
    status.dataset.state = "changed";
    status.textContent = `${git.changed.length} file${git.changed.length === 1 ? "" : "s"} changed`;
  } else {
    status.dataset.state = "saved";
    status.textContent = "Committed";
  }
  status.title = git?.changed.length ? git.changed.slice(0, 20).join("\n") : "";
}
async function editSelection(action: "text" | "hide" | "reset"): Promise<void> {
  if (!selection) return;
  const next = structuredClone(bundle.edits);
  const id = selection.elementRef
    ? `edit-${selection.elementRef}`
    : `element-${selection.documentId}-${selection.nodeId}`;
  let edit = next.elements.find((e) => e.id === id);
  if (action === "reset")
    next.elements = next.elements.filter((e) => e.id !== id);
  else {
    if (!edit) {
      edit = { id, target: selectionTarget() };
      next.elements.push(edit);
    }
    if (action === "text")
      edit.text = $<HTMLTextAreaElement>("#selection-text").value;
    if (action === "hide") edit.hidden = true;
  }
  await save("edits.json", next);
}
$("#apply-element").onclick = () => void editSelection("text").catch(report);
$("#hide-element").onclick = () => void editSelection("hide").catch(report);
$("#reset-element").onclick = () => void editSelection("reset").catch(report);
function addEffect(kind: "camera" | "highlights"): void {
  if (!selection) return;
  const next = structuredClone(bundle.edits);
  const startMs = Math.min(position, Math.max(0, totalDuration(next) - 1));
  const base = {
    id: `${kind}-${Date.now()}`,
    startMs,
    endMs: Math.min(totalDuration(next), startMs + 3000),
    target: selectionTarget(),
  };
  if (kind === "camera") next.camera.push({ ...base, scale: 1.8 });
  else next.highlights.push({ ...base, color: "#7484f7", padding: 8 });
  void save("edits.json", next).catch(report);
}
$("#add-zoom").onclick = () => addEffect("camera");
$("#add-highlight").onclick = () => addEffect("highlights");
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
for (const field of document.querySelectorAll<
  HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
>(".voice-form input,.voice-form textarea,.voice-form select"))
  if (field.id.startsWith("tts-"))
    field.oninput = () => {
      voiceDirty = true;
      updateSaveIndicator();
    };
$("#save-voice").onclick = () =>
  void queued(async () => {
    const latest = await api<ReplayBundle>("/api/project");
    if (JSON.stringify(latest.project.tts) !== voiceBase)
      throw new Error(
        "Voice settings changed elsewhere. Review project.json before saving.",
      );
    const provider = $<HTMLSelectElement>("#tts-provider").value as
      "openai" | "elevenlabs";
    latest.project.tts = {
      ...latest.project.tts,
      provider,
      voice: input("#tts-voice").value.trim(),
      model: input("#tts-model").value.trim(),
      language: input("#tts-language").value.trim() || undefined,
      instructions: $<HTMLTextAreaElement>("#tts-instructions").value,
      format:
        provider !== latest.project.tts.provider
          ? provider === "openai"
            ? "mp3"
            : "mp3_44100_128"
          : latest.project.tts.format,
    };
    if (provider === "openai") delete latest.project.tts.voiceSettings;
    await api("/api/save", {
      file: "project.json",
      value: latest.project,
      revision: latest.revision,
    });
    voiceDirty = false;
    await reload();
    toast("Voice settings saved; regenerate audio to hear changes");
  }).catch(report);
$("#add-animation").onclick = () => {
  if (!selection) return;
  const next = structuredClone(bundle.edits),
    startMs = Math.min(position, totalDuration(next) - 1);
  (next.animations ??= []).push({
    id: `animation-${Date.now()}`,
    target: selectionTarget(),
    startMs,
    endMs: Math.min(totalDuration(next), startMs + 900),
    from: { opacity: 0, y: 12 },
    to: { opacity: 1, y: 0 },
    easing: "ease-in-out",
    fill: "none",
  });
  void save("edits.json", next)
    .then(() => toast("Fade & rise animation added at the playhead"))
    .catch(report);
};
$("#save-timing").onclick = () => {
  const next: ReplayEdits = structuredClone(bundle.edits);
  for (const card of document.querySelectorAll<HTMLElement>(".timing-card")) {
    const clip = next.clips.find((c) => c.id === card.dataset.id)!;
    for (const field of card.querySelectorAll<HTMLInputElement>("input")) {
      const key = field.dataset.field as
        "sourceStartMs" | "sourceEndMs" | "holdMs" | "rate";
      clip[key] = Number(field.value) * (key === "rate" ? 1 : 1000);
    }
  }
  void save("edits.json", next).catch(report);
};
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
  if ((event.metaKey || event.ctrlKey) && event.code === "KeyF") {
    event.preventDefault();
    toggleFind(true);
    return;
  }
  if (
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey &&
    event.code === "KeyC"
  ) {
    event.preventDefault();
    void workbench.copyReference(true).catch(report);
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
  if (playing && bundle && !reloading) {
    position += (now - lastTick) * speed;
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
      git?: GitStatus;
      activity?: AgentActivity[];
      export?: {
        running: boolean;
        message: string;
        error?: string;
        directory?: string;
      };
    }>("/api/status");
    fileError = status.error
      ? `Project files need attention; showing the last valid version. ${status.error}`
      : "";
    jobError = status.narrationError;
    statusHistory = status.history ?? [];
    statusGit = status.git ?? statusGit;
    renderGitState(status.error ? "Waiting for valid files" : undefined);
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
    workbench?.live(status.activity ?? [], statusHistory, statusGit);
    const running = (status.activity ?? []).find((a) => a.status === "running");
    if (
      input("#follow-agent").checked &&
      running?.elementRef &&
      running.id !== lastFollowed
    ) {
      lastFollowed = running.id;
      showElement(running.elementRef);
    }
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
    renderGitState("Disconnected");
    showErrors();
  }
  setTimeout(() => void poll(), 800);
}
let initialLink = !!location.hash;
input("#follow-agent").checked =
  localStorage.getItem("demohunter-follow-agent") === "1";
input("#follow-agent").onchange = () =>
  localStorage.setItem(
    "demohunter-follow-agent",
    input("#follow-agent").checked ? "1" : "0",
  );
function applyLocation(): void {
  if (!location.hash || !workspaceData) return;
  try {
    const params = new URLSearchParams(location.hash.slice(1));
    if (params.get("element")) {
      const reference = parseReference(location.href);
      if (reference.captureId !== workspaceData.index.captureId)
        throw new Error(
          "This link belongs to a different capture. Open that project to follow it.",
        );
      selectRef(reference.elementRef, reference.timeMs);
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
  if (transcript.dirtyCount || voiceDirty) event.preventDefault();
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
