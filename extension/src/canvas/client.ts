/**
 * The Canvas REST client.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * This is the module the auth spike can overturn.
 *
 * It assumes the **service worker** can call Canvas directly: that a
 * cross-origin `fetch` from `chrome-extension://<id>` to a host listed in
 * `host_permissions` carries the session cookie when `credentials: "include"`
 * is passed. If the spike shows otherwise, every request has to be proxied
 * through a content script running in an open Canvas tab — and the change is
 * confined to `canvasFetch` below, because nothing else in the codebase calls
 * `fetch`.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Rules carried over from the Python reference implementation in `cli/`:
 *
 * - **GET only**, hard-coded, with no option to override (see `canvasFetch`).
 * - **`per_page=100`** always — Canvas's default is 10.
 * - **403 can mean "slow down"**, not just "denied", so its body is read.
 * - **Backoff uses full jitter**, so concurrent requests do not retry in
 *   lockstep.
 * - **Expired sessions surface as a redirect or HTML**, not a clean 401.
 */

import { API_BASE, DEFAULT_CANVAS_ORIGIN } from "@/src/config/canvas";
import {
  AccessDeniedError,
  CanvasError,
  NotFoundError,
  RateLimitError,
  SessionExpiredError,
} from "./errors";
import { parseLinkHeader } from "./link-header";
import { assertCanvasOrigin, CredentialScopeError } from "./url-guard";

/** Canvas's maximum page size. The default of 10 would decuple our requests. */
export const MAX_PER_PAGE = 100;

/** Retries for throttling and transient server errors. */
const MAX_RETRIES = 4;

/** First backoff window, in ms. Doubles per attempt. */
const BACKOFF_BASE_MS = 500;

/** Backoff never waits longer than this. */
const BACKOFF_CAP_MS = 20_000;

/**
 * Pause when the remaining quota drops below this.
 *
 * Canvas reports quota in `X-Rate-Limit-Remaining`, a bucket starting near 700
 * and decremented by each request's cost. Backing off voluntarily is cheaper
 * than being throttled and retrying.
 */
const RATE_LIMIT_FLOOR = 100;
const RATE_LIMIT_PAUSE_MS = 1_500;

/** Canvas signals throttling with 403 and this phrase — not with 429. */
const RATE_LIMIT_BODY = /rate limit exceeded/i;

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 507]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with full jitter. */
function backoffMs(attempt: number): number {
  const window = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
  return window / 2 + Math.random() * (window / 2);
}

/**
 * Does this response look like Canvas serving a sign-in page?
 *
 * An expired session does not reliably produce a clean 401. Cornell redirects
 * to `login.canvas.cornell.edu` — a host this extension deliberately has no
 * permission for — and Canvas will also serve an HTML login page with status
 * 200, which would otherwise be parsed as a bafflingly-shaped API response.
 */
function looksLikeSignIn(response: Response, body: string): boolean {
  if (response.status === 401) return true;
  if (response.redirected && /\/login|login\./.test(response.url)) return true;

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html") && body.trimStart().startsWith("<"))
    return true;

  return false;
}

export interface CanvasResponse<T> {
  data: T;
  /** Present only when the response carried a `Link` header we could read. */
  nextUrl: string | null;
}

/**
 * Issue one authenticated GET against Canvas.
 *
 * The method is a literal, not a parameter. There is no configuration that
 * makes this write — the read-only guarantee is structural, exactly as in the
 * CLI, and `fetch` appears nowhere else in the extension.
 */
async function canvasFetch(url: string): Promise<Response> {
  // Checked immediately before the only fetch in the extension, so there is no
  // gap between validating a URL and using it. See `url-guard.ts` for why this
  // is worth doing even though cookies are already per-origin.
  assertCanvasOrigin(url);

  return fetch(url, {
    method: "GET",
    // `fetch` defaults to `credentials: "same-origin"`. From the service
    // worker every Canvas call is cross-origin, so without this the session
    // cookie is silently omitted and every request reads as logged-out.
    credentials: "include",
    headers: { Accept: "application/json" },
    redirect: "follow",
  });
}

/**
 * GET a Canvas URL, with retries, throttle handling and error classification.
 *
 * @param url Absolute URL, already carrying its query string.
 */
async function requestWithRetry(url: string): Promise<CanvasResponse<unknown>> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response: Response;
    try {
      response = await canvasFetch(url);
    } catch (error) {
      // A network-level failure. Also what a redirect to a host we lack
      // permission for looks like from here.
      lastError = error;
      if (attempt === MAX_RETRIES) break;
      await sleep(backoffMs(attempt));
      continue;
    }

    const body = await response.text();

    // 403 is ambiguous in Canvas: throttling *or* an ordinary denial. The only
    // way to tell is to read the body.
    const throttled =
      response.status === 429 ||
      (response.status === 403 && RATE_LIMIT_BODY.test(body));

    if (throttled) {
      if (attempt === MAX_RETRIES) {
        throw new RateLimitError(
          "Canvas is rate-limiting this extension. Try again in a minute.",
        );
      }
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, BACKOFF_CAP_MS)
          : backoffMs(attempt),
      );
      continue;
    }

    if (RETRYABLE_STATUSES.has(response.status)) {
      if (attempt === MAX_RETRIES) {
        throw new CanvasError(
          `Canvas returned ${response.status} after ${MAX_RETRIES} retries.`,
        );
      }
      await sleep(backoffMs(attempt));
      continue;
    }

    if (looksLikeSignIn(response, body)) throw new SessionExpiredError();

    if (response.status === 403)
      throw new AccessDeniedError(`Canvas denied access to ${url}`);
    if (response.status === 404) throw new NotFoundError(`Not found: ${url}`);
    if (!response.ok)
      throw new CanvasError(`Canvas returned ${response.status} for ${url}`);

    // Voluntary throttle: cheaper than being forced to back off later.
    const remaining = Number(response.headers.get("x-rate-limit-remaining"));
    if (Number.isFinite(remaining) && remaining < RATE_LIMIT_FLOOR) {
      await sleep(RATE_LIMIT_PAUSE_MS);
    }

    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      throw new CanvasError(`Canvas returned non-JSON content for ${url}`);
    }

    return {
      data,
      nextUrl: parseLinkHeader(response.headers.get("link")).next ?? null,
    };
  }

  throw new SessionExpiredError(
    `Could not reach Canvas. If you are signed out, sign in and try again. (${String(lastError)})`,
  );
}

/** Build an absolute API URL with Canvas's `include[]`-style bracket params. */
export function buildUrl(
  path: string,
  params: Record<string, string | number | boolean | string[]> = {},
  origin: string = DEFAULT_CANVAS_ORIGIN,
): string {
  const url = new URL(`${API_BASE}${path}`, origin);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      // Canvas expects repeated keys: include[]=term&include[]=teachers
      for (const item of value) url.searchParams.append(key, item);
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** GET a single (non-paginated) Canvas resource. */
export async function getOne<T>(
  path: string,
  params?: Record<string, string | number | boolean | string[]>,
): Promise<T> {
  const { data } = await requestWithRetry(buildUrl(path, params));
  return data as T;
}

/**
 * GET every page of a Canvas list endpoint.
 *
 * Follows `rel="next"` until it is absent. Note the ceiling: a runaway loop
 * here would hammer Canvas, so pages are capped.
 */
export async function getAll<T>(
  path: string,
  params: Record<string, string | number | boolean | string[]> = {},
  { maxPages = 25 }: { maxPages?: number } = {},
): Promise<T[]> {
  let url: string | null = buildUrl(path, { per_page: MAX_PER_PAGE, ...params });
  const items: T[] = [];

  for (let page = 0; url && page < maxPages; page++) {
    const response: CanvasResponse<unknown> = await requestWithRetry(url);
    const payload = response.data;

    if (Array.isArray(payload)) {
      items.push(...(payload as T[]));
    } else if (payload && typeof payload === "object") {
      // A few endpoints wrap their list, e.g. /planner/items in some versions.
      const wrapped = (payload as Record<string, unknown>)["items"];
      if (Array.isArray(wrapped)) items.push(...(wrapped as T[]));
      else items.push(payload as T);
    }

    // The `next` URL is chosen by the server. canvasFetch would reject an
    // off-host one anyway; checking here names pagination as the source.
    if (response.nextUrl) {
      try {
        assertCanvasOrigin(response.nextUrl);
      } catch (error) {
        throw new CredentialScopeError(
          `Canvas returned a pagination link pointing off-host while reading ${path}. ` +
            String(error),
        );
      }
    }

    url = response.nextUrl;
  }

  return items;
}
