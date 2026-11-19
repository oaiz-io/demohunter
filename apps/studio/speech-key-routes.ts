import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { SPEECH_PROVIDERS, isSpeechProvider, type SpeechKeyStatus } from "./speech-keys.js";

const loopback = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** The Host header's name, without the port. */
const hostName = (header = "") =>
  (header.startsWith("[") ? header.slice(0, header.indexOf("]") + 1) : header.replace(/:\d+$/, "")).toLowerCase();
const MAX_BODY = 4096;

const changeSchema = z.union([
  z.object({ provider: z.string().refine(isSpeechProvider), key: z.string().min(1).max(MAX_BODY) }).strict(),
  z.object({ provider: z.string().refine(isSpeechProvider), remove: z.literal(true) }).strict(),
]);

/**
 * GET  /api/speech-keys  → which providers have a saved key (last 4 characters
 *                          only) and which key synthesis uses. Read from the
 *                          store once; `?refresh=1` (the dialog opening)
 *                          reads it again.
 * POST /api/speech-keys  → { provider, key } saves; { provider, remove: true }
 *                          removes.
 *
 * The full key is never sent back. Only this computer may call these routes,
 * by a loopback name, even when Studio listens on a network (--host
 * 0.0.0.0): a person on the network, or a web page that rebinds its own
 * domain to 127.0.0.1 (which --host 0.0.0.0 lets through the library's Host
 * check), must not be able to replace or remove the person's keys. The
 * library service has already refused cross-site requests and cross-origin
 * writes.
 */
export async function handleSpeechKeyRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  keys: SpeechKeyStatus,
): Promise<boolean> {
  if (url.pathname !== "/api/speech-keys") return false;
  const json = (value: unknown, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  };
  if (!loopback.has(req.socket.remoteAddress ?? "") || !loopbackHosts.has(hostName(req.headers.host)))
    return json({ error: "Speech keys can be changed only on this computer." }, 403), true;
  if (req.method === "GET") return json(await keys.status(url.searchParams.get("refresh") === "1")), true;
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405), true;
  // A cross-site form cannot send application/json without a CORS preflight,
  // which Studio never answers.
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? ""))
    return json({ error: "Expected application/json." }, 415), true;
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) return json({ error: "Request is too large." }, 413), true;
  }
  let change: z.infer<typeof changeSchema>;
  try {
    change = changeSchema.parse(JSON.parse(body || "{}"));
  } catch {
    // Zod's message would quote the input, and the input may be a key.
    return json({ error: `Expected { provider, key } or { provider, remove: true }; provider is one of ${SPEECH_PROVIDERS.map((p) => p.id).join(", ")}.` }, 400), true;
  }
  const provider = change.provider as (typeof SPEECH_PROVIDERS)[number]["id"];
  try {
    return json("key" in change ? await keys.set(provider, change.key) : await keys.remove(provider)), true;
  } catch (error) {
    // Store errors are written to name no key (see speech-keys.ts).
    return json({ error: error instanceof Error ? error.message : "Could not change the speech key." }, 400), true;
  }
}
