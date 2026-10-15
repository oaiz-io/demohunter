import { ensureFormat } from "./format.js";
import { contract } from "./contract.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ensureElementIndex,
  elementHtml,
  type ElementIndex,
  type ElementRecord,
} from "./elements.js";
import { elementUri, parseReference, previewLink } from "./links.js";
import {
  loadBundle,
  mutateProject,
  mutationAuthor,
  writeJson,
  historySummary,
  undoProject,
} from "./storage.js";
import {
  audioIsCurrent,
  narrationStart,
  totalDuration,
  type ReplayBundle,
} from "./model.js";

export type PreviewState = {
  updatedAt: string;
  outputMs: number;
  sourceMs: number;
  playing: boolean;
  elementRef?: string;
  html?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  styles?: Record<string, string>;
  acknowledgedCommand?: string;
};
export class ReplayWorkspace {
  constructor(
    readonly dir: string,
    readonly index: ElementIndex,
  ) {}
  static async open(dir: string): Promise<ReplayWorkspace> {
    const resolved = path.resolve(dir);
    await loadBundle(resolved);
    const index = await ensureElementIndex(resolved);
    await ensureFormat(resolved, index);
    return new ReplayWorkspace(resolved, index);
  }
  element(ref: string): ElementRecord {
    const record = this.index.elements.find((e) => e.ref === ref);
    if (!record) throw new Error(`Unknown element reference: ${ref}`);
    return record;
  }
  async previewState(): Promise<PreviewState | null> {
    return readOptional(this.dir, "preview-state.json");
  }
  async selection(): Promise<unknown> {
    const state = await this.previewState();
    const selected = await readOptional<{
      elementRef?: string;
      ref?: string;
      nodeId: number;
      documentId?: number;
      outputMs?: number;
    }>(this.dir, "selection.json");
    const ref =
      selected?.elementRef ??
      selected?.ref ??
      (selected &&
        this.index.elements.find(
          (e) =>
            e.nodeId === selected.nodeId &&
            e.documentId === (selected.documentId ?? 1),
        )?.ref);
    return ref
      ? {
          ...(await this.nodeInfo(ref)),
          selectedAt: selected?.outputMs,
          preview: state,
        }
      : { selection: null, preview: state };
  }
  async basicInfo() {
    const bundle = await loadBundle(this.dir);
    const preview = await this.previewState();
    return {
      contract,
      title: bundle.project.title,
      projectDir: this.dir,
      captureId: this.index.captureId,
      revision: bundle.revision,
      durationMs: totalDuration(bundle.edits),
      viewport: bundle.project.viewport,
      elementCount: this.index.elements.length,
      comments: {
        open: bundle.comments.threads.filter((t) => t.status === "open").length,
      },
      preview: {
        ...preview,
        connected:
          !!preview && Date.now() - Date.parse(preview.updatedAt) < 8000,
      },
      files: {
        registry: "elements.json",
        capturedHtml: "sources/<element-ref>.html",
        edits: "edits.json",
        narration: "narration.json",
        comments: "comments.json",
        css: "overrides.css",
      },
      sourceBoundary:
        "HTML files are captured DOM, not original application source. Original file locations are only present when the app supplied data-demohunter-source.",
      capabilities: [
        "selection",
        "element-links",
        "comments",
        "text-style-visibility",
        "camera",
        "highlights",
        "animations",
        "narration",
        "undo",
      ],
    };
  }
  async nodeInfo(ref: string) {
    const element = this.element(ref);
    const bundle = await loadBundle(this.dir);
    const current = await this.previewState();
    return {
      ...element,
      projectDir: this.dir,
      captureId: this.index.captureId,
      uri: elementUri(this.index.captureId, ref, current?.outputMs ?? 0),
      editFile: "edits.json",
      edits: bundle.edits.elements.filter(
        (edit) =>
          edit.target.ref === ref ||
          (edit.target.nodeId === element.nodeId &&
            (edit.target.documentId ?? 1) === element.documentId),
      ),
      comments: bundle.comments.threads.filter(
        (thread) => thread.elementRef === ref,
      ),
      current: current?.elementRef === ref ? current : undefined,
      revision: bundle.revision,
    };
  }
  async html(ref: string, limit?: number) {
    return {
      ref,
      source: this.element(ref).source,
      ...(await elementHtml(this.dir, this.element(ref), limit)),
    };
  }
  async resolve(value: string) {
    const parsed = /^comment-[a-zA-Z0-9_-]+$/.test(value)
      ? { captureId: this.index.captureId, commentId: value, timeMs: 0 }
      : parseReference(value);
    if (parsed.captureId !== this.index.captureId)
      throw new Error(
        "This link belongs to a different capture. Connect the agent to that project first.",
      );
    if (parsed.commentId !== undefined) {
      const bundle = await loadBundle(this.dir);
      const comment = bundle.comments.threads.find(
        (t) => t.id === parsed.commentId,
      );
      if (!comment) throw new Error("Comment not found in this capture.");
      return {
        ...(comment.elementRef ? await this.nodeInfo(comment.elementRef) : {}),
        projectDir: this.dir,
        captureId: this.index.captureId,
        revision: bundle.revision,
        threadId: comment.id,
        comment,
        outputMs: comment.timeMs,
        ...(comment.elementRef
          ? { capturedHtml: await this.html(comment.elementRef) }
          : {}),
      };
    }
    return {
      ...(await this.nodeInfo(parsed.elementRef)),
      outputMs: parsed.timeMs,
      capturedHtml: await this.html(parsed.elementRef),
    };
  }
  find(query = "", parentRef?: string, limit = 40) {
    return this.index.elements
      .filter(
        (e) =>
          (!parentRef || e.parentRef === parentRef) &&
          `${e.ref} ${e.tag} ${e.name} ${e.text}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      )
      .slice(0, limit);
  }
  async focus(ref: string | undefined, timeMs: number) {
    if (ref) this.element(ref);
    const bundle = await loadBundle(this.dir);
    if (timeMs > totalDuration(bundle.edits))
      throw new Error("Requested time is beyond the edited timeline.");
    const command = {
      id: randomUUID(),
      elementRef: ref,
      outputMs: timeMs,
      createdAt: new Date().toISOString(),
    };
    await writeJson(path.join(this.dir, "preview-command.json"), command);
    return {
      command,
      note: "The open preview follows this command. If closed, open the project to apply it.",
    };
  }
  async change(
    expectedRevision: string | undefined,
    description: string,
    mutate: (draft: ReplayBundle) => void | Promise<void>,
  ) {
    return mutateProject(
      this.dir,
      expectedRevision,
      description,
      async (draft) => {
        await mutate(draft);
        for (const collection of [
          draft.edits.elements,
          draft.edits.camera,
          draft.edits.highlights,
          draft.edits.animations ?? [],
        ])
          for (const item of collection)
            if (item.target?.ref) this.element(item.target.ref);
        for (const thread of draft.comments.threads)
          if (thread.elementRef) this.element(thread.elementRef);
      },
    );
  }
  async addComment(input: {
    expectedRevision: string;
    elementRef?: string;
    timeMs: number;
    body: string;
    author?: string;
  }) {
    const id = `comment-${randomUUID()}`,
      now = new Date().toISOString();
    const bundle = await this.change(
      input.expectedRevision,
      "Add comment",
      (draft) => {
        draft.comments.threads.push({
          id,
          elementRef: input.elementRef,
          timeMs: input.timeMs,
          body: input.body,
          author: input.author ?? mutationAuthor.getStore()?.actor ?? "You",
          status: "open",
          createdAt: now,
          updatedAt: now,
          replies: [],
        });
      },
    );
    return { id, revision: bundle.revision };
  }
  async commentAction(input: {
    expectedRevision: string;
    threadId: string;
    status?: "open" | "resolved";
    reply?: string;
    author?: string;
  }) {
    const bundle = await this.change(
      input.expectedRevision,
      input.reply ? "Reply to comment" : "Update comment status",
      (draft) => {
        const thread = draft.comments.threads.find(
          (t) => t.id === input.threadId,
        );
        if (!thread) throw new Error("Comment was removed. Reload and retry.");
        if (input.status) thread.status = input.status;
        if (input.reply)
          thread.replies.push({
            id: `reply-${randomUUID()}`,
            body: input.reply,
            author: input.author ?? mutationAuthor.getStore()?.actor ?? "You",
            createdAt: new Date().toISOString(),
          });
        thread.updatedAt = new Date().toISOString();
      },
    );
    return { revision: bundle.revision };
  }
  async narration() {
    const bundle = await loadBundle(this.dir);
    return {
      revision: bundle.revision,
      settings: bundle.project.tts,
      segments: bundle.narration.segments.map((segment) => ({
        ...segment,
        startMs: narrationStart(bundle.edits, segment),
        status: !segment.audio
          ? "draft"
          : audioIsCurrent(bundle.project, segment)
            ? "ready"
            : "stale",
      })),
    };
  }
  history() {
    return historySummary(this.dir);
  }
  undo(revision: string, steps = 1) {
    return undoProject(this.dir, revision, steps);
  }
}
export async function readOptional<T>(
  dir: string,
  file: string,
): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path.join(dir, file), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
