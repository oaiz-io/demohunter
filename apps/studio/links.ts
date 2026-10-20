export function elementUri(
  captureId: string,
  elementRef: string,
  timeMs = 0,
): string {
  return `demohunter://capture/${encodeURIComponent(captureId)}/element/${encodeURIComponent(elementRef)}?t=${Math.round(timeMs)}`;
}
export function commentUri(
  captureId: string,
  commentId: string,
  timeMs = 0,
): string {
  return `demohunter://capture/${encodeURIComponent(captureId)}/comment/${encodeURIComponent(commentId)}?t=${Math.round(timeMs)}`;
}
export function previewLink(
  base: string,
  captureId: string,
  elementRef?: string,
  timeMs = 0,
  commentId?: string,
): string {
  const url = new URL(base);
  const hash = new URLSearchParams({
    capture: captureId,
    t: String(Math.round(timeMs)),
  });
  if (elementRef) hash.set("element", elementRef);
  if (commentId) hash.set("comment", commentId);
  url.hash = hash.toString();
  return url.href;
}
export type ReplayReference = { captureId: string; timeMs: number } & (
  | { elementRef: string; commentId?: never }
  | { commentId: string; elementRef?: never }
);
export function parseReference(value: string): ReplayReference {
  const url = new URL(value);
  if (url.protocol === "demohunter:" && url.hostname === "capture") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 3 && ["element", "comment"].includes(parts[1]!))
      return checked(
        decodeURIComponent(parts[0]!),
        decodeURIComponent(parts[2]!),
        url.searchParams.get("t"),
        parts[1] === "comment",
      );
  } else if (["http:", "https:"].includes(url.protocol)) {
    const params = new URLSearchParams(url.hash.slice(1));
    return checked(
      params.get("capture") ?? "",
      params.get("comment") ?? params.get("element") ?? "",
      params.get("t"),
      params.has("comment"),
    );
  }
  throw new Error(
    "Expected an element or comment link copied from DemoHunter.",
  );
}
function checked(
  captureId: string,
  elementRef: string,
  rawTime: string | null,
  comment = false,
): ReplayReference {
  const timeMs = Number(rawTime ?? 0);
  if (
    !/^[a-f0-9]{16}$/.test(captureId) ||
    !/^[a-zA-Z0-9_-]+$/.test(elementRef) ||
    !Number.isFinite(timeMs) ||
    timeMs < 0
  )
    throw new Error("Invalid capture, target, or time in reference.");
  return comment
    ? { captureId, commentId: elementRef, timeMs }
    : { captureId, elementRef, timeMs };
}
