/**
 * RFC 5988 `Link` header parsing.
 *
 * Canvas paginates every list endpoint with this header, advertising `current`,
 * `next`, `prev`, `first` and `last`. Iteration follows `next` until it is
 * absent, which is how you know you have reached the last page.
 *
 *     Link: <https://canvas.cornell.edu/api/v1/courses?page=2&per_page=100>; rel="next",
 *           <https://canvas.cornell.edu/api/v1/courses?page=9&per_page=100>; rel="last"
 *
 * Pure logic, no network — which is why it carries the densest tests in the
 * client layer.
 */

const LINK_ENTRY = /<([^>]*)>\s*;\s*rel="([^"]*)"/g;

/** Parse a `Link` header into `{ rel: url }`. Junk and absence both give `{}`. */
export function parseLinkHeader(value: string | null): Record<string, string> {
  if (!value) return {};

  const links: Record<string, string> = {};
  // `matchAll` needs the regex to be global and unshared across calls, so the
  // lastIndex of a module-level regex cannot leak between invocations.
  for (const match of value.matchAll(new RegExp(LINK_ENTRY))) {
    const [, url, rel] = match;
    if (url && rel) links[rel.toLowerCase()] = url;
  }
  return links;
}
