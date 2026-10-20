/** The browser knows only its project route, never OS filesystem APIs. */
export function projectUrl(resource: string): string {
  const match = location.pathname.match(/^\/projects\/[a-f0-9]+/);
  return `${match?.[0] ?? ""}${resource.startsWith("/") ? resource : `/${resource}`}`;
}
