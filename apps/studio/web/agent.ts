import type { AgentActivity } from "../contract.js";
import type { ReplayBundle, ReplayComments } from "../model.js";
import type { HistoryChange, MutationAuthor } from "../storage.js";

export type HistoryItem = {
  id: string;
  description: string;
  createdAt: string;
  afterRevision: string;
  author?: MutationAuthor;
  changes?: HistoryChange[];
};
export type Turn = {
  id: string;
  actor: string;
  sessionId: string;
  entries: HistoryItem[];
  startedAt: string;
  endedAt: string;
  threadId?: string;
  /** Number of newest history entries this turn covers when it is on top. */
  undoSteps?: number;
};
type Thread = ReplayComments["threads"][number];
export const WRITE_TOOLS = new Set([
  "apply_element_edit",
  "animate_element",
  "update_timeline_item",
  "remove_timeline_item",
  "update_narration",
  "regenerate_narration",
  "add_comment",
  "reply_to_comment",
  "set_comment_status",
  "undo_last_edit",
]);
const TURN_GAP_MS = 3 * 60 * 1000;

/** Group agent-authored history (newest first) into turns: consecutive entries
 * of one MCP session with no long pause. Undo is offered for the newest turn
 * only when no other change sits above it, because undo is linear. */
export function agentTurns(history: HistoryItem[]): Turn[] {
  const turns: Turn[] = [];
  for (const [index, entry] of history.entries()) {
    if (!entry.author) continue;
    const last = turns.at(-1);
    const prev = history[index - 1];
    if (
      last &&
      last.sessionId === entry.author.sessionId &&
      prev?.author?.sessionId === entry.author.sessionId &&
      Date.parse(last.startedAt) - Date.parse(entry.createdAt) < TURN_GAP_MS
    ) {
      last.entries.push(entry);
      last.startedAt = entry.createdAt;
      last.threadId ??= entry.author.threadId;
    } else
      turns.push({
        id: entry.id,
        actor: entry.author.actor,
        sessionId: entry.author.sessionId,
        entries: [entry],
        startedAt: entry.createdAt,
        endedAt: entry.createdAt,
        threadId: entry.author.threadId,
      });
  }
  const top = turns[0];
  if (top && history[0]?.id === top.entries[0]!.id)
    top.undoSteps = top.entries.length;
  return turns;
}

export type NoteState =
  | { kind: "resolved" }
  | { kind: "working"; actor: string; calls: AgentActivity[]; since: string }
  | { kind: "replied"; actor: string; at: string; changes: number }
  | { kind: "open" };
/** What a note is waiting for, derived only from project data and real
 * activity records. */
export function noteState(
  thread: Thread,
  activity: AgentActivity[],
  turns: Turn[],
): NoteState {
  if (thread.status === "resolved") return { kind: "resolved" };
  const relevant = (a: AgentActivity) =>
    !!thread.elementRef && a.elementRef === thread.elementRef;
  const running = activity.find((a) => a.status === "running");
  if (running) {
    const session = activity.filter(
      (a) =>
        a.id === running.id ||
        (a.sessionId === running.sessionId &&
          Date.now() - Date.parse(a.startedAt) < 120_000),
    );
    if (relevant(running) || session.some(relevant))
      return {
        kind: "working",
        actor: running.actor,
        calls: session
          .filter((a) => relevant(a) || a.id === running.id)
          .slice(0, 6)
          .reverse(),
        since: session.at(-1)?.startedAt ?? running.startedAt,
      };
  }
  const last = thread.replies.at(-1);
  if (last && last.author !== "You") {
    const changes = turns
      .filter(
        (t) =>
          t.threadId === thread.id ||
          t.entries.some((e) => e.author?.elementRef === thread.elementRef),
      )
      .reduce(
        (n, t) =>
          n +
          t.entries.filter((e) =>
            e.changes?.some(
              (c) => !["reply", "status", "comment"].includes(c.kind),
            ),
          ).length,
        0,
      );
    return { kind: "replied", actor: last.author, at: last.createdAt, changes };
  }
  return { kind: "open" };
}

export function ago(iso: string, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return "just now";
  if (s < 90) return "1 min ago";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
export function elapsed(iso: string, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} m ${s % 60} s`;
}

/** Reviewed turns are a local acknowledgement only; files do not change. */
export class ReviewMemory {
  private kept: Set<string>;
  constructor(private key: string) {
    try {
      this.kept = new Set(JSON.parse(localStorage.getItem(key) ?? "[]"));
    } catch {
      this.kept = new Set();
    }
  }
  has(id: string) {
    return this.kept.has(id);
  }
  keep(ids: string[]) {
    for (const id of ids) this.kept.add(id);
    localStorage.setItem(this.key, JSON.stringify([...this.kept].slice(-500)));
  }
}

export function threadTitle(bundle: ReplayBundle, threadId?: string) {
  const index = bundle.comments.threads.findIndex((t) => t.id === threadId);
  return index < 0
    ? undefined
    : { index: index + 1, body: bundle.comments.threads[index]!.body };
}
