/**
 * Which Canvas instance this build talks to.
 *
 * Single source of truth: `wxt.config.ts` imports `hostPermissions` from here
 * to generate the manifest, and the runtime imports `DEFAULT_CANVAS_HOST` for
 * its requests. Adding another institution means editing this one array — the
 * manifest and the client stay in sync automatically, and the extension never
 * asks for `<all_urls>`.
 */

/**
 * Canvas origins this build may talk to. Narrow on purpose.
 *
 * Note that Cornell serves its *login* flow from a different host
 * (`login.canvas.cornell.edu`), which is deliberately absent. An expired
 * session redirects there, and having no permission for it is what makes the
 * expiry unmistakable rather than silently returning an HTML login page.
 */
export const CANVAS_ORIGINS = ["https://canvas.cornell.edu"] as const;

export type CanvasOrigin = (typeof CANVAS_ORIGINS)[number];

/** The origin used unless the user has selected another. */
export const DEFAULT_CANVAS_ORIGIN: CanvasOrigin = CANVAS_ORIGINS[0];

/** Match patterns for the manifest's `host_permissions`. */
export const hostPermissions: string[] = CANVAS_ORIGINS.map((o) => `${o}/*`);

/** Base path for every API call. */
export const API_BASE = "/api/v1";
