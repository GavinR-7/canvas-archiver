/**
 * Rendering Canvas text (pages, assignments, announcements, syllabus) to a
 * standalone HTML file.
 *
 * The body is HTML Canvas already sanitised; it is the user's own course
 * content, saved as-is so formatting and links survive. As a second line of
 * defence we drop `<script>` blocks and inline `on*=` handlers: a saved file
 * opened from disk should never run code just because an instructor pasted it.
 */

import { rewriteFileLinks } from "./attachments";
import type { CanvasDocument } from "./plan";

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function stripActiveContent(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script\b[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

/** `links` maps a Canvas file id to the relative path it was saved at; those links in the body are rewritten. */
export function renderDocument(doc: CanvasDocument, links: ReadonlyMap<number, string> = new Map()): string {
  const meta = [
    `Source: canvas:${doc.kind}/${doc.key}`,
    doc.modifiedAt ? `Modified: ${doc.modifiedAt}` : null,
    doc.htmlUrl ? `Canvas: ${doc.htmlUrl}` : null,
  ]
    .filter(Boolean)
    .map((line) => escapeHtml(line as string))
    .join(" · ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(doc.title)}</title>
</head>
<body>
<h1>${escapeHtml(doc.title)}</h1>
<p><small>${meta}</small></p>
${rewriteFileLinks(stripActiveContent(doc.html), links)}
</body>
</html>
`;
}
