/**
 * Files that a page, assignment, announcement, discussion or syllabus points at.
 *
 * Canvas returns the text of these as HTML whose links read
 * `/courses/12/files/345?wrap=1` (and `data-api-endpoint=".../files/345"`), and
 * announcements and discussions also carry an `attachments` array. The archive
 * saves the text; this module finds the files it names so the planner can save
 * them beside it, and rewrites the links in the saved copy to point at them.
 *
 * Pure: no network, no file system.
 */

const FILE_ID = /\/files\/(\d+)(?![\d])/;
const ANCHOR = /<a\b[^>]*>/gi;
const HREF = /(\shref\s*=\s*)("[^"]*"|'[^']*')/i;
const ENDPOINT = /\sdata-api-endpoint\s*=\s*("[^"]*"|'[^']*')/i;
const unquote = (value: string) => value.slice(1, -1).replace(/&amp;/g, "&");

/** The file id an `<a>` tag links to, from its href or its data-api-endpoint, or null. */
function anchorFileId(tag: string): number | null {
  const href = HREF.exec(tag);
  const endpoint = ENDPOINT.exec(tag);
  for (const value of [href?.[2], endpoint?.[1]]) {
    if (!value) continue;
    const id = FILE_ID.exec(unquote(value))?.[1];
    if (id) return Number(id);
  }
  return null;
}

/** File ids linked from `html`, in order of first appearance, each once. */
export function fileIdsIn(html: string): number[] {
  const ids: number[] = [];
  for (const [tag] of html.matchAll(ANCHOR)) {
    const id = anchorFileId(tag);
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Ids from an API `attachments` array, then the ids linked in the HTML, each once. */
export function attachmentIds(attachments: unknown, html: string): number[] {
  const ids: number[] = [];
  if (Array.isArray(attachments)) {
    for (const entry of attachments) {
      const id = (entry as Record<string, unknown> | null)?.["id"];
      if (typeof id === "number" && Number.isFinite(id) && !ids.includes(id)) ids.push(id);
    }
  }
  for (const id of fileIdsIn(html)) if (!ids.includes(id)) ids.push(id);
  return ids;
}

/** Relative link from the directory `from` to the file at `to` (both path segments), URL-encoded. */
export function relativeLink(from: string[], to: string[]): string {
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared++;
  const up = from.length - shared;
  const parts = [...Array<string>(up).fill(".."), ...to.slice(shared).map(encodeURIComponent)];
  return parts.join("/");
}

const escapeAttr = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/**
 * Point each link to a saved file at its relative path. `links` maps a Canvas
 * file id to the link. The original Canvas address is kept in `data-canvas-href`.
 * A link to a file that was not saved is left as it was.
 */
export function rewriteFileLinks(html: string, links: ReadonlyMap<number, string>): string {
  if (links.size === 0) return html;
  return html.replace(ANCHOR, (tag) => {
    const id = anchorFileId(tag);
    const link = id === null ? undefined : links.get(id);
    const href = HREF.exec(tag);
    if (link === undefined || !href) return tag;
    const original = unquote(href[2] as string);
    const swapped = tag.replace(HREF, `$1"${escapeAttr(link)}"`);
    return swapped.replace(/^<a\b/i, `<a data-canvas-href="${escapeAttr(original)}"`);
  });
}
