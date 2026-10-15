export function elementUri(
  captureId: string,
  elementRef: string,
  timeMs = 0,
): string {
  return `demohunter://capture/${encodeURIComponent(captureId)}/element/${encodeURIComponent(elementRef)}?t=${Math.round(timeMs)}`;
}
export function previewLink(
  base: string,
  captureId: string,
  elementRef?: string,
  timeMs = 0,
): string {
  const url = new URL(base);
  const hash = new URLSearchParams({
    capture: captureId,
    t: String(Math.round(timeMs)),
  });
  if (elementRef) hash.set("element", elementRef);
  url.hash = hash.toString();
  return url.href;
}
export function parseReference(value: string): {
  captureId: string;
  elementRef: string;
  timeMs: number;
} {
  const url = new URL(value);
  if (url.protocol === "demohunter:" && url.hostname === "capture") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 3 && parts[1] === "element")
      return checked(
        decodeURIComponent(parts[0]!),
        decodeURIComponent(parts[2]!),
        url.searchParams.get("t"),
      );
  } else if (["http:", "https:"].includes(url.protocol)) {
    const params = new URLSearchParams(url.hash.slice(1));
    return checked(
      params.get("capture") ?? "",
      params.get("element") ?? "",
      params.get("t"),
    );
  }
  throw new Error("Expected an element link copied from DemoHunter.");
}
function checked(
  captureId: string,
  elementRef: string,
  rawTime: string | null,
) {
  const timeMs = Number(rawTime ?? 0);
  if (
    !/^[a-f0-9]{16}$/.test(captureId) ||
    !/^[a-zA-Z0-9_-]+$/.test(elementRef) ||
    !Number.isFinite(timeMs) ||
    timeMs < 0
  )
    throw new Error("Invalid capture, element, or time in reference.");
  return { captureId, elementRef, timeMs };
}
