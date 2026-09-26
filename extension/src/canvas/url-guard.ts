/**
 * Credentials only ever go to the configured Canvas host.
 *
 * The extension follows URLs that Canvas chooses: the `Link` header's `next`
 * is an absolute URL supplied by the server. A compromised or misconfigured
 * Canvas could point it anywhere, and `getAll` would follow it.
 *
 * ## How much does the browser already protect us?
 *
 * More than the CLI, but not enough to skip the check.
 *
 * - **Cookies are per-origin.** A fetch to `evil.com` would *not* carry the
 *   `canvas_session` cookie, so the Canvas credential itself cannot leak this
 *   way. This is the big difference from the Python client, where the bearer
 *   header travels with whatever URL it is given.
 * - **CORS would block reading the response**, since `host_permissions` covers
 *   only Canvas.
 *
 * What remains, and why this module exists anyway:
 *
 * - **The request still fires.** A URL is a channel: `https://evil.com/?x=…`
 *   exfiltrates whatever is in the path, response unread.
 * - **Other sites' cookies would be sent.** With `credentials: "include"`, a
 *   request to a host the user is logged into carries *that* site's session —
 *   an authenticated action on a third party, triggered by Canvas.
 * - **Defence in depth is nearly free here.** One comparison per request.
 */

import { CanvasError } from "./errors";
import { DEFAULT_CANVAS_ORIGIN } from "@/src/config/canvas";

/** Hosts allowed to use plain HTTP, so tests can run against a local stub. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class CredentialScopeError extends CanvasError {
  constructor(message: string) {
    super(message);
    this.name = "CredentialScopeError";
  }
}

/**
 * Confirm `url` is safe to send a credentialed request to. Returns it.
 *
 * Compares scheme, host **and port**. Subdomains are rejected: an origin is an
 * exact triple, and `evil.canvas.cornell.edu` is not `canvas.cornell.edu`.
 *
 * @throws {CredentialScopeError} if the target is anything else.
 */
export function assertCanvasOrigin(
  url: string,
  expectedOrigin: string = DEFAULT_CANVAS_ORIGIN,
): string {
  let parsed: URL;
  let expected: URL;
  try {
    parsed = new URL(url);
    expected = new URL(expectedOrigin);
  } catch {
    throw new CredentialScopeError(`Refusing to request a malformed URL: ${url}`);
  }

  if (parsed.protocol !== "https:" && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new CredentialScopeError(
      `Refusing to send credentials over ${parsed.protocol}// to ${parsed.hostname}.`,
    );
  }

  // `URL.origin` already normalises the default port away and lower-cases the
  // host, so comparing origins covers scheme, host and port in one step.
  if (parsed.origin !== expected.origin) {
    throw new CredentialScopeError(
      `Refusing to send Canvas credentials to ${parsed.origin} — ` +
        `configured Canvas is ${expected.origin}. This can happen if a ` +
        `pagination link points off-host, which a healthy Canvas does not do.`,
    );
  }

  return url;
}
