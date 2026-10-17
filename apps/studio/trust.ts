import path from "node:path";
import type { IncomingMessage } from "node:http";

/**
 * Folders whose scene pages must not run scripts (opened from the desktop
 * app without being trusted). Process-wide, so headless thumbnail, poster and
 * export renders started for a demo honour it too.
 */
const restricted = new Set<string>();
export function restrictFolder(root: string): void {
  restricted.add(path.resolve(root));
}
export function scenesTrusted(dir: string): boolean {
  const resolved = path.resolve(dir);
  for (const root of restricted)
    if (resolved === root || resolved.startsWith(root + path.sep)) return false;
  return true;
}
const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
/**
 * DNS rebinding guard: a page on attacker.example that resolves to 127.0.0.1
 * reaches the service with `Host: attacker.example`. Only loopback names (and
 * an explicitly configured --host) are served; binding all interfaces is an
 * explicit opt-in to a trusted network.
 */
export function hostAllowed(req: IncomingMessage, configured?: string): boolean {
  const header = req.headers.host;
  if (!header) return false;
  if (configured === "0.0.0.0" || configured === "::") return true;
  const name = header.startsWith("[")
    ? header.slice(0, header.indexOf("]") + 1)
    : header.replace(/:\d+$/, "");
  return loopback.has(name.toLowerCase()) || (!!configured && name === configured);
}
