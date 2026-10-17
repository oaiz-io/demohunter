import { ensureFormat } from "./format.js";
import {
  elementPatchSchema,
  elementKey,
  patchElement,
  type ElementPatch,
} from "./element-edit.js";
import { contract } from "./contract.js";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { LocalLibrary } from "./library.js";
import {
  ensureElementIndex,
  elementHtml,
  type ElementIndex,
  type ElementRecord,
} from "./elements.js";
import { elementUri, parseReference, previewLink } from "./links.js";
import {
  atomicWrite,
  ensureIgnoredFolder,
  loadBundle,
  readProjectFile,
  mutateProject,
  mutationAuthor,
  RevisionConflict,
  writeJson,
  historySummary,
  undoProject,
  withProjectLock,
  safeFile,
} from "./storage.js";
import {
  targetSchema,
  type Target,
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
        scenes: "scenes/<name>.html (scene clips and overlays)",
        audio: "audio/<name>.mp3|wav|ogg|m4a (music beds and sound effects)",
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
        "scene-clips",
        "overlays",
        "music",
        "sfx",
        "scene-files",
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
        "This link belongs to a different capture. Open that demo in Studio or pass its `project`.",
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
        // Only what this change adds or alters is checked: one stale ref
        // (the capture changed) must not block every unrelated write.
        const collections = (d: ReplayBundle) => [
          d.edits.elements,
          d.edits.camera,
          d.edits.highlights,
          d.edits.animations ?? [],
        ];
        const known = new Set(
          collections(draft).flatMap((c) => c.map((i) => JSON.stringify(i))),
        );
        const threads = new Set(
          draft.comments.threads.map((t) => `${t.id}\0${t.elementRef}`),
        );
        await mutate(draft);
        for (const collection of collections(draft))
          for (const item of collection)
            if (item.target?.ref && !known.has(JSON.stringify(item)))
              this.element(item.target.ref);
        for (const thread of draft.comments.threads)
          if (
            thread.elementRef &&
            !threads.has(`${thread.id}\0${thread.elementRef}`)
          )
            this.element(thread.elementRef);
      },
    );
  }
  async editElement(
    expectedRevision: string,
    target: Target,
    patch: ElementPatch,
  ) {
    target = targetSchema.parse(target);
    patch = elementPatchSchema.parse(patch);
    if (target.ref) this.element(target.ref);
    if (target.scene) await safeFile(this.dir, target.scene);
    return this.change(
      expectedRevision,
      `${patch.reset ? "Reset" : patch.hidden ? "Hide" : "Edit"} ${target.ref ?? target.selector ?? "element"}`,
      (draft) => {
        const id = target.ref
          ? `edit-${target.ref}`
          : `edit-${createHash("sha256").update(elementKey(target)).digest("hex").slice(0, 16)}`;
        patchElement(draft.edits.elements, target, patch, id);
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
    return JSON.parse(await readProjectFile(dir, file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Which demo the person is viewing in Studio. The library server writes it
 * from editor polls; the workspace MCP server reads it on every tool call. */
export type StudioSession = {
  protocolVersion: 1;
  /** Project directory relative to the workspace root. */
  projectDir: string;
  /** Library project ID (stable hash of projectDir). */
  projectId: string;
  title: string;
  url?: string;
  updatedAt: string;
  /** Identifies the Studio process that wrote the record. */
  serverId?: string;
};
export const SESSION_STALE_MS = 120_000;
export function sessionFile(root: string): string {
  return path.join(root, ".demohunter", "studio", "session.json");
}
export function libraryProjectId(relative: string): string {
  return createHash("sha256").update(relative).digest("hex").slice(0, 16);
}
export async function writeStudioSession(
  root: string,
  session: StudioSession,
): Promise<void> {
  // Runtime state, kept out of git without touching the user's .gitignore. A
  // repository can commit `.demohunter` or `.demohunter/studio` as a link:
  // refuse it rather than write outside the workspace.
  const folder = await ensureIgnoredFolder(root, ".demohunter/studio");
  await writeJson(path.join(folder, "session.json"), session);
}
export async function readStudioSession(
  root: string,
): Promise<StudioSession | null> {
  try {
    const value = JSON.parse(
      await readProjectFile(root, ".demohunter/studio/session.json"),
    );
    return typeof value?.projectDir === "string" &&
      typeof value?.updatedAt === "string"
      ? (value as StudioSession)
      : null;
  } catch {
    return null;
  }
}
/** Remove the record if this Studio process wrote it (Studio closing). */
export async function clearStudioSession(
  root: string,
  serverId: string,
): Promise<void> {
  const current = await readStudioSession(root);
  if (current?.serverId === serverId)
    await unlink(sessionFile(root)).catch(() => {});
}
async function isProjectDir(dir: string): Promise<boolean> {
  return stat(path.join(dir, "project.json"))
    .then((s) => s.isFile())
    .catch(() => false);
}
export type ProjectTarget = {
  workspace: ReplayWorkspace;
  dir: string;
  /** Path relative to the workspace root ("." when bound to one project). */
  path: string;
  id: string;
  title: string;
  /** How the target was chosen. */
  source: "bound" | "explicit" | "studio" | "reference";
  url?: string;
};
/**
 * Resolves which project an MCP tool call edits. Bound to one project when
 * started on a project directory; otherwise workspace-scoped: an explicit
 * `project` wins, then the demo currently open in Studio. Never guesses.
 */
export class ProjectTargets {
  private cache = new Map<
    string,
    { key: string; workspace: Promise<ReplayWorkspace> }
  >();
  private library?: Promise<LocalLibrary>;
  private constructor(
    readonly root: string,
    readonly bound: boolean,
  ) {}
  static async open(dir: string): Promise<ProjectTargets> {
    const resolved = await realpath(path.resolve(dir));
    if (await isProjectDir(resolved)) {
      const targets = new ProjectTargets(resolved, true);
      await targets.workspaceFor(resolved);
      return targets;
    }
    return new ProjectTargets(resolved, false);
  }
  get mode(): "project" | "workspace" {
    return this.bound ? "project" : "workspace";
  }
  private lib(): Promise<LocalLibrary> {
    // Scanned once up front so other worktrees of a repository are known.
    return (this.library ??= LocalLibrary.open(this.root).then(async (l) => {
      await l.scan();
      return l;
    }));
  }
  /** Inside a worktree of this repository; rescans once for worktrees
   * added after this server started. */
  private async inWorktree(dir: string): Promise<boolean> {
    const library = await this.lib();
    if (library.rootOf(dir)) return true;
    await library.scan();
    return !!library.rootOf(dir);
  }
  /** One ReplayWorkspace per project, reopened when the capture changes. */
  async workspaceFor(dir: string): Promise<ReplayWorkspace> {
    const key = (
      await Promise.all(
        ["events.json", "elements.json"].map((name) =>
          stat(path.join(dir, name))
            .then((s) => `${s.size}:${s.mtimeMs}`)
            .catch(() => "-"),
        ),
      )
    ).join("|");
    const cached = this.cache.get(dir);
    if (cached?.key === key) return cached.workspace;
    const workspace = ReplayWorkspace.open(dir);
    this.cache.set(dir, { key, workspace });
    // A newer entry (the capture changed meanwhile) must survive this failure.
    workspace.catch(() => {
      if (this.cache.get(dir)?.workspace === workspace) this.cache.delete(dir);
    });
    return workspace;
  }
  private async target(
    dir: string,
    source: ProjectTarget["source"],
    url?: string,
  ): Promise<ProjectTarget> {
    const workspace = await this.workspaceFor(dir);
    const relative = path.relative(this.root, dir) || ".";
    const title = await loadBundle(dir)
      .then((b) => b.project.title)
      .catch(() => path.basename(dir));
    return {
      workspace,
      dir,
      path: relative,
      id: libraryProjectId(this.bound ? "" : relative),
      title,
      source,
      url,
    };
  }
  /** Resolve an explicit `project` argument: a workspace-relative (or
   * absolute) project directory, or a Studio library project ID. */
  private async explicit(project: string): Promise<string> {
    const value = project.trim();
    if (this.bound) {
      if (
        [".", "", libraryProjectId("")].includes(value) ||
        path.resolve(this.root, value) === this.root
      )
        return this.root;
      throw new Error(
        `This MCP server is bound to one demo (${this.root}). Re-add it with the workspace root (\`studio mcp <workspace>\`) to edit other demos.`,
      );
    }
    let dir: string | undefined;
    if (/^[a-f0-9]{16}$/.test(value)) {
      dir = await (await this.lib()).resolve(value).catch(() => undefined);
    }
    if (!dir) {
      const requested = path.resolve(this.root, value);
      const real = await realpath(requested).catch(() => undefined);
      if (
        real &&
        (real === this.root ||
          real.startsWith(this.root + path.sep) ||
          (await this.inWorktree(real))) &&
        (await isProjectDir(real))
      )
        dir = real;
    }
    if (!dir)
      throw new Error(
        `No demo matches project "${value}" in ${this.root}.\n${await this.available()}`,
      );
    return dir;
  }
  async projects() {
    if (this.bound) {
      const t = await this.target(this.root, "bound");
      return [{ id: t.id, path: t.path, title: t.title }];
    }
    const scan = await (await this.lib()).scan();
    const branch = new Map(
      (scan.worktrees ?? []).map((w) => [w.path, w.branch ?? w.head]),
    );
    return scan.recordings.map((r) => ({
      id: r.id,
      // Relative to this workspace, so it works as a `project` argument even
      // for demos in another worktree.
      path: r.worktree
        ? path.relative(this.root, path.join(r.worktree, r.path)) || "."
        : r.path,
      title: r.title,
      ...(r.worktree && r.worktree !== this.root
        ? { worktree: r.worktree, branch: branch.get(r.worktree) }
        : {}),
      captureId: r.captureId,
      durationMs: r.durationMs,
      openComments: r.comments,
      modifiedAt: r.modifiedAt,
      ...(r.error ? { error: r.error } : {}),
    }));
  }
  private async available(): Promise<string> {
    const list = await this.projects().catch(() => []);
    if (!list.length)
      return "No demos found in this workspace. Capture one with `bun run studio capture <tour.ts>`.";
    return `Available demos (pass one as \`project\`):\n${list
      .slice(0, 25)
      .map((p) => `- ${p.title} — project: "${p.path}" (id ${p.id})`)
      .join("\n")}${list.length > 25 ? `\n… ${list.length - 25} more` : ""}`;
  }
  /** The live Studio view, if fresh and pointing at a project here. */
  async studio(): Promise<
    | { status: "open"; session: StudioSession; dir: string }
    | { status: "stale" | "closed" | "missing"; session?: StudioSession }
  > {
    const session = await readStudioSession(this.root);
    if (!session) return { status: "closed" };
    if (Date.now() - Date.parse(session.updatedAt) > SESSION_STALE_MS)
      return { status: "stale", session };
    const dir = await realpath(
      path.resolve(this.root, session.projectDir),
    ).catch(() => undefined);
    if (
      !dir ||
      !(
        dir === this.root ||
        dir.startsWith(this.root + path.sep) ||
        // Another worktree of this repository.
        (!this.bound && (await this.inWorktree(dir)))
      ) ||
      !(await isProjectDir(dir))
    )
      return { status: "missing", session };
    return { status: "open", session, dir };
  }
  /**
   * Pick the project for one tool call. `captureId` (from a copied link)
   * selects the demo that owns that capture when no project is explicit.
   */
  async resolve(project?: string, captureId?: string): Promise<ProjectTarget> {
    if (this.bound)
      return this.target(
        project === undefined ? this.root : await this.explicit(project),
        "bound",
      );
    if (project !== undefined)
      return this.target(await this.explicit(project), "explicit");
    const live = await this.studio();
    const open =
      live.status === "open"
        ? await this.target(live.dir, "studio", live.session.url)
        : undefined;
    if (captureId && open?.workspace.index.captureId !== captureId) {
      const owners = (await this.projects()).filter(
        (p) => "captureId" in p && p.captureId === captureId,
      );
      if (owners.length === 1)
        return this.target(
          path.resolve(this.root, owners[0]!.path),
          "reference",
        );
    }
    if (open) return open;
    const reason =
      live.status === "stale"
        ? `Studio last showed "${live.session!.title}" ${Math.round((Date.now() - Date.parse(live.session!.updatedAt)) / 60000)} min ago, so it is no longer a safe target.`
        : live.status === "missing"
          ? `Studio points at "${live.session!.projectDir}", which is no longer a demo here.`
          : "No demo is open in DemoHunter Studio for this workspace.";
    throw new Error(
      `${reason} Open the demo in Studio (\`bun run studio\`) or pass \`project\` explicitly.\n${await this.available()}`,
    );
  }
}
const SCENE_FILE_LIMIT = 512 * 1024;
const sceneExtensions = new Set([".html", ".css", ".js", ".svg", ".json"]);
/**
 * Write a scene page or its asset under `scenes/`. Runs under the project
 * lock with a revision check; scene files are part of the project revision.
 */
export async function writeSceneFile(
  dir: string,
  expectedRevision: string,
  relative: string,
  content: string,
): Promise<{
  path: string;
  bytes: number;
  revision: string;
  created: boolean;
}> {
  const parts = relative.split("/");
  if (
    parts[0] !== "scenes" ||
    parts.length < 2 ||
    relative.includes("\\") ||
    parts.some((p) => p === "" || p === "." || p === "..")
  )
    throw new Error(
      'Path must be inside scenes/, e.g. "scenes/intro.html" (no "..", absolute paths or backslashes).',
    );
  if (!sceneExtensions.has(path.extname(relative).toLowerCase()))
    throw new Error("Scene files must be .html, .css, .js, .svg or .json.");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > SCENE_FILE_LIMIT)
    throw new Error(
      `Scene file is ${bytes} bytes; the limit is ${SCENE_FILE_LIMIT} (512 KB).`,
    );
  return writeUnderScenes(dir, expectedRevision, [{ relative, content }]).then(
    (result) => ({
      path: relative,
      bytes,
      revision: result.revision,
      created: result.created[0]!,
    }),
  );
}
/**
 * Atomically (per file) write files under `scenes/` while holding the project
 * lock, after checking the revision. Folders and targets that are symlinks are
 * refused so a write cannot leave the project. Callers validate names/sizes.
 */
export async function writeUnderScenes(
  dir: string,
  expectedRevision: string | undefined,
  files: { relative: string; content: string }[],
): Promise<{ revision: string; created: boolean[] }> {
  return withProjectLock(dir, async () => {
    const before = await loadBundle(dir);
    if (
      expectedRevision !== undefined &&
      before.revision !== expectedRevision
    )
      throw new RevisionConflict(
        "The project changed. Read the latest revision before retrying; the file was not written.",
      );
    const root = await realpath(dir);
    // Check everything first so a refusal leaves no partial write.
    const plan: { file: string; content: string; existed: boolean }[] = [];
    for (const { relative, content } of files) {
      const parts = relative.split("/");
      let current = root;
      for (const part of parts.slice(0, -1)) {
        current = path.join(current, part);
        const info = await lstat(current).catch(() => undefined);
        if (info && (!info.isDirectory() || info.isSymbolicLink()))
          throw new Error(`${path.relative(root, current)} is not a folder.`);
        if (!info) break;
      }
      const file = path.join(root, ...parts);
      const existing = await lstat(file).catch(() => undefined);
      if (existing && !existing.isFile())
        throw new Error(`${relative} exists and is not a regular file.`);
      plan.push({ file, content, existed: !!existing });
    }
    for (const { relative } of files) {
      let current = root;
      for (const part of relative.split("/").slice(0, -1)) {
        current = path.join(current, part);
        if (!(await lstat(current).catch(() => undefined)))
          await mkdir(current);
      }
    }
    for (const { file, content } of plan) await atomicWrite(file, content);
    const after = await loadBundle(dir);
    return { revision: after.revision, created: plan.map((p) => !p.existed) };
  });
}
/** Project-relative files usable as scene/overlay pages and audio sources.
 * Walks without following symlinked folders (Bun's recursive readdir does). */
export async function projectMediaFiles(
  dir: string,
): Promise<{ scenes: string[]; audio: string[] }> {
  const list = async (folder: string, pattern: RegExp) => {
    const found: string[] = [];
    // A linked folder would list files from outside the project.
    const info = await lstat(path.join(dir, folder)).catch(() => undefined);
    if (!info?.isDirectory()) return found;
    const walk = async (relative: string, depth: number) => {
      if (depth > 6 || found.length >= 200) return;
      const entries = await readdir(path.join(dir, relative), {
        withFileTypes: true,
      }).catch(() => []);
      for (const entry of entries) {
        const name = `${relative}/${entry.name}`;
        if (entry.isDirectory()) await walk(name, depth + 1);
        else if (entry.isFile() && pattern.test(name)) found.push(name);
      }
    };
    await walk(folder, 0);
    return found.sort().slice(0, 200);
  };
  return {
    scenes: await list("scenes", /\.html$/i),
    audio: await list("audio", /\.(mp3|wav|ogg|m4a)$/i),
  };
}
