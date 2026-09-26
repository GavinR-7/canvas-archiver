# Extension architecture

The product is a Chrome extension. The Python CLI in [`../cli/`](../cli/) is
frozen as the reference implementation — it is not being extended, but its
Canvas knowledge is hard-won and carries over wholesale. This document records
what transfers, what is new, and how the MV3 pieces fit together.

- [What carries over from the CLI](#what-carries-over-from-the-cli)
- [MV3 in the shape this project needs it](#mv3-in-the-shape-this-project-needs-it)
- [The auth spike](#the-auth-spike)
- [Build setup](#build-setup)
- [Credential scoping](#credential-scoping)
- [Data flow](#data-flow)
- [Loading from WSL](#loading-from-wsl)
- [Types](#types)

---

## What carries over from the CLI

Six things were learned the expensive way and should not be rediscovered.

### 1. Pagination is a `Link` header, and the default page size is 10

Canvas paginates every list endpoint with an RFC 5988 `Link` header advertising
`current`, `next`, `prev`, `first` and `last`. Iteration follows `rel="next"`
until it is absent.

```
Link: <https://canvas.cornell.edu/api/v1/courses?page=2&per_page=100>; rel="next",
      <https://canvas.cornell.edu/api/v1/courses?page=9&per_page=100>; rel="last"
```

`per_page=100` is Canvas's maximum and must be passed explicitly — the default
of 10 turns one request into ten.

**New wrinkle in the browser.** `Link` is not a
[CORS-safelisted response header](https://developer.mozilla.org/en-US/docs/Glossary/CORS-safelisted_response_header).
A cross-origin `fetch` can therefore receive the response body and still be
unable to read the header that says where the next page is, unless the server
sends `Access-Control-Expose-Headers`. This does not arise for a same-origin
request. It is one of the things the spike measures, because it determines
whether pagination is even possible from the service worker.

### 2. Canvas signals throttling with 403, not 429

Canvas returns **`403`** with `403 Forbidden (Rate Limit Exceeded)` in the body
— the same status as an ordinary permission denial. A 403 has to be *read*
before it can be classified. Canvas also reports quota in
`X-Rate-Limit-Remaining`, a bucket starting near 700 and decremented by each
request's cost; backing off voluntarily below ~100 is cheaper than being
throttled and retrying.

Retries use exponential backoff with **full jitter**, so concurrent requests do
not all wake and retry in the same instant.

### 3. `calendar_events` needs two requests, not one

`GET /api/v1/calendar_events` is context-scoped: it needs
`context_codes[]=course_<id>` per course, plus `all_events=true` to escape the
default date window. Critically, **assignment due dates come back only with
`type=assignment`, which is a separate request from `type=event`.** Asking for
one and assuming it covers both silently loses every assignment deadline.

### 4. `planner/items` is user-scoped, not course-scoped

`GET /api/v1/planner/items?start_date=…&end_date=…` returns items across every
course at once. One request per run, then split by `course_id` from each item's
`plannable` payload — not one request per course.

### 5. Read-only is enforced structurally, not promised

The CLI exposes no `post`/`put`/`patch`/`delete`, and the single method every
request funnels through asserts `method === "GET"`. The extension keeps this:
there will be one `canvasFetch` helper, it will hard-code `method: "GET"`, and
no configuration will relax it.

A pleasant consequence: Canvas requires an `X-CSRF-Token` header for
cookie-authenticated *writes*. Being GET-only, we never need one — which also
means the extension never needs to read the `_csrf_token` cookie.

### 6. Canvas omits fields as readily as it nulls them

A course outside its availability window arrives with
`access_restricted_by_date: true` and essentially nothing else. `"name": null`
and a missing `name` key both occur. Normalisation happens once, at the
boundary, converting API JSON into the types in `src/types/canvas.ts`, so no
component downstream writes a defensive lookup.

Restricted courses are **flagged, not dropped**, so the UI can explain an
absence rather than silently producing one.

### Also carried: timestamps stay as Canvas sent them

ISO 8601, UTC, `Z` suffix, stored verbatim. Conversion to local time happens at
render. Stored data outlives any one machine's timezone setting.

---

## MV3 in the shape this project needs it

Manifest V3 splits an extension into several isolated contexts that cannot call
each other's functions directly. They pass messages instead. The pieces:

### `manifest.json`

The declaration of everything: which scripts exist, which permissions are
requested, what the toolbar button does. Chrome reads it at install time. There
is no code in it, and getting it wrong usually produces silence rather than an
error.

Two permission fields that are easy to confuse:

- **`permissions`** — capability APIs (`storage`, `scripting`, `tabs`).
- **`host_permissions`** — which *sites* the extension may talk to
  (`https://canvas.cornell.edu/*`). This is what makes an authenticated
  cross-origin fetch possible at all, and it is deliberately narrow here: one
  host, kept configurable in code so other institutions can be added without
  the extension ever asking for `<all_urls>`.

### The service worker (`background.service_worker`)

The extension's background context. In MV3 it is a **service worker**, not the
persistent background page of MV2, which means:

- It is **terminated when idle** (roughly 30s) and restarted on the next event.
  Anything held in a module-level variable is gone after that. State that must
  survive belongs in `chrome.storage`.
- It has **no DOM**. No `window`, no `document`, no `localStorage`.
- Its origin is `chrome-extension://<id>`, so every Canvas call is
  cross-origin.

It is the right home for work that must outlive a popup: fetching, caching,
and — later — scheduled refreshes.

### Content scripts

JavaScript injected into a web page. Two properties matter:

- They run in an **isolated world**: a separate JS heap from the page, so the
  page's variables and the content script's cannot collide or be read across.
- They share the page's **origin** for network purposes. A `fetch` from a
  content script on `canvas.cornell.edu` is same-origin, and carries cookies
  exactly as Canvas's own front-end does.

That second property is why they are a candidate for the auth path at all.

They can be declared statically in the manifest, or injected on demand with
`chrome.scripting.executeScript` — which is what the spike uses, since it needs
to inject only at the moment of measurement.

### The popup (`action.default_popup`)

An ordinary HTML page at a `chrome-extension://` URL, shown when the toolbar
icon is clicked. Its JavaScript context is **created on open and destroyed on
close** — so an in-flight `fetch` started by the popup is cancelled when the
popup closes. That is the reason to delegate work to the service worker even
though the popup has identical origin and permissions.

### Extension pages

Any other HTML page the extension ships, opened in a normal tab via
`chrome.tabs.create({ url: chrome.runtime.getURL("upcoming.html") })`. Same
origin and permissions as the popup, but a full tab's worth of space and a
lifetime that does not end when focus moves. The "Upcoming" view is one of
these.

### How they pass messages

One bus, `chrome.runtime`:

```js
// Popup / content script / extension page — the sender:
const reply = await chrome.runtime.sendMessage({ type: "RUN_SPIKE" });

// Service worker — the receiver:
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "RUN_SPIKE") return false;
  (async () => {
    sendResponse(await doTheWork());
  })();
  return true; // <- keeps the channel open for the async reply
});
```

**That `return true` is the single most common MV3 bug.** Without it, Chrome
closes the message channel as soon as the listener returns, and the async
`sendResponse` lands nowhere. The failure is silent: the sender's promise
resolves to `undefined`, with no error in either console.

Messages are structured-cloned, so only plain data crosses — no functions, no
class instances, no `Response` objects. This is why the spike's probe returns a
flat object of primitives rather than the `Response` it got.

---

## The auth spike

**Question:** when the extension calls `/api/v1`, does the Canvas session
cookie attach — and from which context?

**Why it is not obvious.** Cornell's Canvas sets its cookies with **no
`SameSite` attribute**:

```
set-cookie: _csrf_token=<value>; path=/; secure
```

Chrome's default for a cookie with no `SameSite` is `Lax`, and `Lax` cookies
are **not** sent on cross-site subresource requests — which is what a
`fetch` from `chrome-extension://<id>` to `canvas.cornell.edu` looks like on
its face. Chrome does grant extensions a same-site context for hosts they hold
permissions for, but that behaviour has shifted across Chrome versions and is
not something to build a product on from memory.

A second discovery from probing the login flow: Cornell bounces unauthenticated
requests to **`login.canvas.cornell.edu`**, a *different host* from
`canvas.cornell.edu`:

```
$ curl -sSI https://canvas.cornell.edu/login
HTTP/2 302
location: https://login.canvas.cornell.edu
```

So the extension will hold permission for the API host but deliberately not for
the login host. An expired session therefore does not surface as a clean `401`
— it surfaces as a redirect to a host we cannot read, which is a *good* outcome
(it makes expiry unmistakable) but has to be handled deliberately. This is the
same failure mode as the CLI's D13, arriving by a different route.

**Design.** `spike/` is a throwaway MV3 extension with no build step. It runs
three tests and reports structured results:

| Test | Context | What it settles |
| --- | --- | --- |
| A | Service worker `fetch` | Does a cross-origin extension fetch carry the session cookie? |
| B | Content script in a Canvas tab | Does the same-origin path work? (Expected yes.) |
| C | `Link` header read | Is pagination metadata visible, or stripped by CORS? |

Tests A and B each run **twice** — `credentials: "include"` and
`credentials: "omit"`. A pass with `include` proves nothing on its own; it only
means something if `omit` fails, since otherwise the endpoint might not require
auth at all.

**Why the answer matters.** If A works, the architecture is simple: the service
worker owns all fetching, works with no Canvas tab open, and can refresh in the
background. If only B works, every request must be proxied through a content
script in an open Canvas tab — which means the extension cannot refresh unless
the user happens to have Canvas open, and the design needs an entirely
different story for background refresh.

### Result — measured 2026-09-25

**Test A (service worker fetch) passes.** The architecture is the simple one.

| Test | `credentials` | Outcome |
| --- | --- | --- |
| A. Service worker fetch | `"include"` | **200, authenticated** — returned the signed-in user |
| A. Service worker fetch | `"omit"` | 401 `{"status":"unauthenticated"}` |
| B. Content script fetch | `"include"` | 200, authenticated |
| B. Content script fetch | `"omit"` | 401 |
| C. `Link` header | `"include"` | **Readable**, with all four rels |

Four conclusions:

1. **A cross-origin fetch from `chrome-extension://` does carry the Canvas
   session cookie**, given `host_permissions` for the host. Chrome grants
   extensions a same-site context for hosts they hold permission for, so the
   `SameSite=Lax`-by-default concern does not bite.
2. **`credentials: "include"` is load-bearing, not decorative.** The `"omit"`
   probes returned a clean 401 from the same endpoint in the same context. Since
   `fetch` defaults to `credentials: "same-origin"`, a plain `fetch(url)` from
   the service worker would be silently unauthenticated — reading as "logged
   out" rather than as a bug.
3. **No content-script proxy is needed.** Test B works too, but requiring an
   open Canvas tab would have meant no background refresh. That constraint is
   lifted.
4. **The `Link` header is readable**, so pagination works from the service
   worker. This was a genuine open question: `Link` is not CORS-safelisted, and
   a cross-origin fetch can normally read a body while being denied the header.
   It is visible because a fetch to a host in `host_permissions` is a
   *privileged* extension request, not subject to CORS at all.

`X-Rate-Limit-Remaining` also came back as `700.0`, confirming the bucket size
the client's `RATE_LIMIT_FLOOR` of 100 was written against.

The spike extension is kept in `spike/` as the evidence for these claims.

---

## Build setup

**WXT**, chosen over Vite + CRXJS and over a hand-rolled Vite config.

The deciding factor was maintenance health: CRXJS has stalled before and its
v2 has been in beta a long time, and a build plugin going unmaintained under a
project is an expensive problem to discover late. WXT is actively released and
its service-worker auto-reload removes real friction, which matters more than
usual here because every reload also crosses the WSL→Windows boundary.

The cost is one abstraction between the source and Chrome's documentation. It
is smaller than it looks: `wxt.config.ts` contains the real manifest fields as
a typed object, and the generated result is readable at
`.output/chrome-mv3/manifest.json` — worth looking at, since it is the file
Chrome actually parses.

`host_permissions` is *not* written in `wxt.config.ts`. It is imported from
`src/config/canvas.ts`, which is also what the runtime reads:

```ts
export const CANVAS_ORIGINS = ["https://canvas.cornell.edu"] as const;
export const hostPermissions = CANVAS_ORIGINS.map((o) => `${o}/*`);
```

So adding an institution is a one-line change that updates the manifest and the
client together, and the extension never has to ask for `<all_urls>`.

---

## Data flow

```
  ┌────────────┐  GET_SNAPSHOT / REFRESH   ┌──────────────────┐
  │   popup    │ ─────────────────────────▶│                  │
  └────────────┘ ◀───────── Snapshot ──────│  service worker  │
  ┌────────────┐                           │                  │
  │  upcoming  │ ─────────────────────────▶│  · fetches       │──▶ Canvas /api/v1
  │   (page)   │ ◀───────── Snapshot ──────│  · caches        │
  └────────────┘                           └──────────────────┘
                                                    │
                                            chrome.storage.local
```

Three decisions worth stating:

**One `Snapshot`, not several endpoints.** The UI asks for user, courses and
tasks together. That makes rendering atomic — there is no intermediate state
where courses have arrived but tasks have not, and no loading spinner per
section.

**Errors are a field on the snapshot, not a thrown exception.** Messages are
structured-cloned, and a thrown `Error` crossing `sendMessage` arrives as
`undefined`. Carrying `error` as data also allows the useful case of showing
stale cached data *with* a warning, rather than going blank on a failed
refresh.

**All fetching lives in the service worker.** The popup could fetch — same
origin, same permissions — but a popup's JS context is destroyed when it
closes, cancelling any in-flight request with it. Work started in the worker
survives the popup being dismissed.

### Why `/planner/items` and not three endpoints per course

"Everything due in the next 14 days" could be assembled from
`/courses/:id/assignments`, `/courses/:id/quizzes` and
`/courses/:id/discussion_topics` — three requests per course, so 15 for five
courses.

`GET /api/v1/planner/items?start_date=…&end_date=…` is **user-scoped**: one
request covers every course. It also returns exactly the things that carry a
date, already merged, with the current user's submission state attached. For
this view it is both cheaper and a closer fit.

Two shapes to know about, both handled in `normalize.ts`:

- `plannable_type` includes things that are not tasks — `wiki_page`,
  `planner_note`, `calendar_event`, `assessment_request` — which are dropped.
- **`submissions` is sometimes the boolean `false`**, not an object, for items
  with no submission concept. Coercing that into an object would invent a
  submission that does not exist, so it maps to `null`.

---

## Credential scoping

The CLI learned two rules the hard way. Both carry over, one softened by the
browser and one sharpened by it.

### Credentials only go to the configured Canvas host

`assertCanvasOrigin` runs immediately before the only `fetch` in the extension,
and again on any pagination `next` URL. Scheme, host and port must match;
subdomains are rejected; non-HTTPS is refused except on loopback.

**The browser already blocks the worst version of this attack.** Cookies are
per-origin, so a `next` URL pointing at `evil.com` would *not* carry
`canvas_session` — unlike the Python client, where the bearer header travels
with whatever URL it is handed. CORS would also block reading the response.

Three reasons it is still worth the one comparison per request:

- **The request still fires.** A URL is an exfiltration channel on its own:
  `https://evil.com/?data=…` leaks whatever is in the path whether or not the
  response can be read.
- **Other sites' cookies would be sent.** With `credentials: "include"`, a
  request to a host the user is signed into carries *that* site's session — an
  authenticated third-party action, triggered by Canvas.
- It costs nothing, and the failure mode it prevents is silent.

### The downloader must not send Canvas credentials to a CDN

Not yet built; recorded now, because in the extension the naive version fails
in a *different* way than in the CLI and the right answer is a different API.

Canvas file URLs do not serve bytes: `GET /api/v1/files/:id/download`
302-redirects to a signed S3 URL on an unrelated host. Consequences here:

1. **`fetch` is the wrong tool.** S3 is not in `host_permissions`, so the
   cross-origin request would be subject to CORS and would fail. Adding S3 to
   `host_permissions` to work around that would widen the extension's reach for
   no good reason.
2. **`chrome.downloads.download()` is the right tool.** It hands the URL to the
   browser's own download stack, which follows the redirect, needs no host
   permission, and writes to the user's Downloads folder without the bytes ever
   passing through extension code.
3. **The signed URL is itself a credential.** Its query string authorises
   anyone holding it until it expires. It must never be logged, persisted, or
   written into stored data.
4. **Ask Canvas for the redirect target authenticated; fetch the bytes
   unauthenticated.** Two requests, two credential postures — the same rule as
   the CLI's D15, reached by a different route.

---

## Loading from WSL

Chrome runs on Windows; the source lives in WSL. Chrome loads unpacked
extensions unreliably from `\\wsl.localhost\` UNC paths — it will sometimes
accept the folder and then fail to pick up changed files, which produces
confusing "why didn't my edit apply" sessions.

Builds are therefore staged onto the Windows filesystem:

```bash
cd extension && npm run build:load
# builds, then rsyncs to C:\Users\gavin\canvas-archiver-ext\canvas-archiver
```

`rsync --delete`, so a file removed from source does not linger in the loaded
extension. After each run, hit the reload arrow on `chrome://extensions`.

The spike is staged the same way:

```bash
./dev/sync-to-windows.sh extension/spike
# -> C:\Users\gavin\canvas-archiver-ext\spike
```

---

## Types

`src/types/canvas.ts` defines `Course` and `Task` before any UI consumes them,
because a future scheduler reads `Task` directly.

**`Task` is anything with a due date** — assignments, quizzes and discussions.
Pages, files and announcements never carry one, so they are not tasks. The
scheduling fields (`dueAt`, `unlockAt`, `lockAt`, `pointsPossible`,
`submission`) are first-class, never buried in a rendered description.

`TaskStatus` is **derived, not stored**, because the answer depends on the
current time: an unsubmitted task only becomes "overdue" once its due date has
passed. It is recomputed on read.
