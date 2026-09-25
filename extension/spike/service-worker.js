/**
 * Auth spike — service worker side.
 *
 * The question: when the extension calls Canvas's REST API, does the browser
 * attach the session cookie that makes the call authenticated?
 *
 * There are two candidate places to make that call, and they differ in origin:
 *
 *   A. The service worker. Its origin is `chrome-extension://<id>`. A fetch to
 *      canvas.cornell.edu is therefore cross-origin. Whether the cookie rides
 *      along depends on host permissions and on the cookie's SameSite
 *      attribute — Canvas sets none, and Chrome's default for a cookie with no
 *      SameSite is Lax, which is NOT sent on cross-site subresource requests.
 *      So this may or may not work, and reasoning about it is unreliable
 *      enough to be worth measuring.
 *
 *   B. A content script injected into an open Canvas tab. Code there runs in
 *      an isolated JavaScript world but with the *page's* origin for network
 *      purposes, so its fetch is same-origin and the cookie attaches the same
 *      way it does for Canvas's own front-end.
 *
 * Each test runs twice, once with `credentials: "include"` and once with
 * `"omit"`, because a pass with `include` only proves something if `omit`
 * fails — otherwise the endpoint might simply not require auth.
 */

const CANVAS_ORIGIN = "https://canvas.cornell.edu";
const PROBE_PATH = "/api/v1/users/self";

/**
 * Run one probe and describe what came back, without ever throwing.
 *
 * @param {RequestCredentials} credentials
 * @returns {Promise<object>} a plain, structured-cloneable result
 */
async function probe(credentials) {
  const url = `${CANVAS_ORIGIN}${PROBE_PATH}`;
  const started = performance.now();

  try {
    const response = await fetch(url, {
      credentials,
      headers: { Accept: "application/json" },
      // Follow redirects so we can see *where* an unauthenticated call lands.
      // Cornell bounces to login.canvas.cornell.edu, a host this extension
      // deliberately has no permission for.
      redirect: "follow",
    });

    const body = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      /* Not JSON — almost certainly an HTML login page. */
    }

    return {
      credentials,
      ok: response.ok,
      status: response.status,
      redirected: response.redirected,
      finalUrl: response.url,
      contentType: response.headers.get("content-type"),
      // The decisive signal: an authenticated call returns a user object.
      authenticated: Boolean(parsed && typeof parsed.id !== "undefined"),
      userName: parsed?.name ?? null,
      bodyPreview: body.slice(0, 120),
      ms: Math.round(performance.now() - started),
      error: null,
    };
  } catch (error) {
    return {
      credentials,
      ok: false,
      status: null,
      redirected: null,
      finalUrl: null,
      contentType: null,
      authenticated: false,
      userName: null,
      bodyPreview: null,
      ms: Math.round(performance.now() - started),
      error: String(error),
    };
  }
}

/** Test A: fetch straight from the service worker. */
async function testServiceWorker() {
  return {
    name: "A. Service worker fetch",
    detail: "Origin is chrome-extension://. Cross-origin to Canvas.",
    results: [await probe("include"), await probe("omit")],
  };
}

/**
 * Test B: fetch from inside an open Canvas tab.
 *
 * `chrome.scripting.executeScript` runs the function in an isolated world on
 * the target tab. Isolated means it cannot see the page's JS variables, but it
 * shares the page's *origin*, so `fetch` is same-origin.
 */
async function testContentScript() {
  const tabs = await chrome.tabs.query({ url: `${CANVAS_ORIGIN}/*` });

  if (tabs.length === 0) {
    return {
      name: "B. Content script fetch",
      detail: "Origin is the Canvas page itself. Same-origin.",
      results: [],
      skipped: "No canvas.cornell.edu tab is open. Open one and re-run.",
    };
  }

  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tabs[0].id },
    // The probe function is serialised and re-evaluated inside the tab, so it
    // cannot close over anything from this file. Arguments are passed instead.
    args: [`${CANVAS_ORIGIN}${PROBE_PATH}`],
    func: async (url) => {
      const run = async (credentials) => {
        try {
          const response = await fetch(url, {
            credentials,
            headers: { Accept: "application/json" },
          });
          const body = await response.text();
          let parsed = null;
          try {
            parsed = JSON.parse(body);
          } catch {
            /* HTML login page */
          }
          return {
            credentials,
            ok: response.ok,
            status: response.status,
            redirected: response.redirected,
            finalUrl: response.url,
            contentType: response.headers.get("content-type"),
            authenticated: Boolean(parsed && typeof parsed.id !== "undefined"),
            userName: parsed?.name ?? null,
            bodyPreview: body.slice(0, 120),
            error: null,
          };
        } catch (error) {
          return { credentials, ok: false, authenticated: false, error: String(error) };
        }
      };
      return [await run("include"), await run("omit")];
    },
  });

  return {
    name: "B. Content script fetch",
    detail: `Injected into ${tabs[0].url}. Same-origin with Canvas.`,
    results: injection?.result ?? [],
  };
}

/**
 * Test C: does pagination look the way the Python client expects?
 *
 * Carried over from the reference implementation: Canvas paginates with an
 * RFC 5988 `Link` header, and the default page size is 10 unless `per_page` is
 * set. Worth confirming the header is actually *readable* from an extension —
 * `Link` is not a CORS-safelisted response header, so a cross-origin fetch can
 * receive the response and still be unable to see the header that says where
 * the next page is.
 */
async function testPaginationHeader() {
  try {
    const response = await fetch(
      `${CANVAS_ORIGIN}/api/v1/courses?enrollment_state=active&per_page=2`,
      { credentials: "include", headers: { Accept: "application/json" } },
    );
    return {
      name: "C. Link header visibility",
      detail: "Can the extension read the pagination header, or only the body?",
      results: [
        {
          credentials: "include",
          ok: response.ok,
          status: response.status,
          linkHeader: response.headers.get("link"),
          rateLimitRemaining: response.headers.get("x-rate-limit-remaining"),
          error: null,
        },
      ],
    };
  } catch (error) {
    return {
      name: "C. Link header visibility",
      detail: "Can the extension read the pagination header?",
      results: [{ ok: false, error: String(error) }],
    };
  }
}

/**
 * Message handler.
 *
 * This is the MV3 message bus: any extension surface (popup, options page,
 * content script) calls `chrome.runtime.sendMessage`, and this listener
 * answers. Returning `true` keeps the channel open for an async reply —
 * forgetting it is the single most common MV3 bug, and it fails silently.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "RUN_SPIKE") return false;

  (async () => {
    sendResponse({
      ranAt: new Date().toISOString(),
      tests: [
        await testServiceWorker(),
        await testContentScript(),
        await testPaginationHeader(),
      ],
    });
  })();

  return true; // keep the message channel open for the async sendResponse
});
