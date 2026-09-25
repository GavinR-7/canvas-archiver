# Architecture

A running record of how canvas-archiver is built and why. Each phase appends to
it. If you read this file top to bottom you should understand the whole system,
including which Canvas REST endpoints are actually being called.

- [Design decisions](#design-decisions)
- [Two credentials, one API](#two-credentials-one-api)
- [Module map](#module-map)
- [Canvas REST endpoints](#canvas-rest-endpoints)
- [Manifest schema](#manifest-schema)
- [Phase log](#phase-log)

---

## Design decisions

### D1 — Official REST API, never scraping

Everything goes through `/api/v1`. No HTML parsing, no clicking through the UI
to extract content. The REST API is versioned and stable; the UI is neither.
Note that this holds regardless of *which* credential is used — session-cookie
auth (D9) is still the REST API, not scraping.

### D2 — A hand-written HTTP client, not `canvasapi` *(revised in Phase 1.5)*

Phase 1 used the `canvasapi` library. It was the right call while bearer tokens
were the only credential, and the wrong one the moment a browser session had to
work too: `canvasapi` constructs and owns its own `requests.Session`, with no
seam for injecting a cookie jar.

Replacing it cost about two hundred lines and bought three things the archive
needed anyway:

1. **Pagination we can see.** `Link`-header following is now ten lines in
   `http_client.paginate` instead of a `PaginatedList` we hoped was doing the
   right thing.
2. **Rate-limit handling we control.** `canvasapi` has none at all (D11).
3. **A read-only guarantee that is structural, not aspirational** (D3).

The cost is that every endpoint's response shape is now our problem. That is
mitigated by converting to dataclasses at the boundary (D7).

### D3 — Read-only is enforced by construction

`CanvasHTTP` exposes `get`, `get_json` and `paginate`, and nothing else. There
is no `post`, `put`, `patch` or `delete` to call, and the single private method
every request funnels through asserts the method is `GET`:

```python
assert method == "GET", "canvas-archiver is read-only; refusing to issue ..."
```

There is no configuration flag that relaxes this. "This tool never writes to
Canvas" is therefore a property of the code, checked by two tests — one
asserting the mutating verbs are absent from the class, one asserting the
assertion fires.

A pleasant side effect of GET-only: Canvas requires an `X-CSRF-Token` header for
state-changing requests authenticated by session cookie, and we never need one.

### D4 — Configuration only through environment variables

No config file format to design, no precedence rules to explain, and secrets
never sit in a file that is easy to `git add` by accident. `.env` is in
`.gitignore` as of the very first commit — before any `.env` could exist.

Real environment variables take precedence over `.env` (`load_dotenv(override=False)`),
so `CANVAS_API_TOKEN=... canvas-archive sync` works for one-off runs.

### D5 — Credentials are never printed, logged, or put in an exception message

`Config` stores the token in a `repr=False` field and overrides `__str__`;
`Credential` does the same for both the `Authorization` header and the cookie
jar. Anything user-facing goes through `Config.redacted_token()` (which shows
only the non-secret Canvas key-id prefix and the last four characters, e.g.
`1234~...aB9x`) or `Credential.describe()` (which reports *"browser session
(7 cookies)"* and never a value).

Six tests exist solely to hold this true: token absent from `repr`, from `str`,
from the redaction, and from the auth-error message; cookie values absent from
`repr` and from `describe()`.

### D6 — The archive lives outside the repo; credentials live outside both

`ARCHIVE_ROOT` defaults to `~/canvas-archive`, a sibling of the repo. Course
material is other people's copyrighted work and has no business in version
control.

Saved cookies and the browser profile go somewhere else again —
`~/.local/share/canvas-archiver` — rather than into the archive root. The
archive is bulk material a user may reasonably back up, copy to another machine,
or point an indexing tool at. A password-equivalent should not ride along with
it.

### D7 — Canvas JSON is converted to dataclasses at the boundary

Canvas omits fields rather than nulling them, and sometimes nulls them rather
than omitting them. A course outside its availability window arrives with
`access_restricted_by_date: true` and essentially nothing else. Rather than
scatter defensive lookups through every collector, `client.py` converts each
course to a frozen `CourseSummary` at the point of retrieval. Restricted courses
are flagged rather than dropped, so the CLI can explain why a course is absent
from the archive instead of silently omitting it.

### D8 — Read-only commands never create the archive root

`setup_logging` will happily write `<archive_root>/archive.log`, but creating
that directory is `sync`'s privilege alone. Otherwise merely asking "what
courses do I have?" would leave an empty archive behind, and `status` would
report an archive that had never been synced as existing.

### D9 — Two auth modes behind one `Credential`

See [Two credentials, one API](#two-credentials-one-api) below for the mechanics.
The design point is that the difference is confined to one frozen dataclass:

```python
Credential(mode=TOKEN,   headers={"Authorization": "Bearer ..."})
Credential(mode=SESSION, cookies={"canvas_session": "..."})
```

`CanvasHTTP` takes a `Credential` and never asks which kind it is, except in one
place: deciding whether a 401 means *"your token was revoked"* or *"run
`canvas-archive login` again"*. Collectors, the manifest and the sync engine
never see auth at all.

Default is `session`, because Cornell currently gates token issuance behind an
approval request. `token` remains preferred where available — see D10.

### D10 — A saved session is a bigger credential than a token, and is treated that way

This is worth stating plainly, because the default mode is the less safe one.

|                     | Bearer token                  | Browser session cookie              |
| ------------------- | ----------------------------- | ----------------------------------- |
| Scope               | API only                      | Whole account, API and web UI       |
| Revocable alone     | Yes, from Canvas settings     | No — only by ending all sessions    |
| Expiry              | Chosen at creation            | Canvas's session policy             |
| Visible to the user | Listed in Approved Integrations | Not listed anywhere               |

So the cookie file gets: creation at mode `0600` *before* the secret is written
into it (no window where it exists world-readable), storage outside both repo
and archive, host-pinning so a session for one Canvas is never replayed at
another, and a warning if `chmod` silently failed — which it does on
Windows-backed WSL paths.

Only cookies scoped to the Canvas host are stored. A browser profile
accumulates cookies for Duo, the identity provider, analytics and anything else
touched during login; none of that is this tool's business, and a test asserts
they are filtered out.

### D11 — Rate limiting has to be handled explicitly, and Canvas is unusual about it

Canvas does not use 429 for throttling. It returns **403** with
`403 Forbidden (Rate Limit Exceeded)` in the body — the same status as an
ordinary permission denial. A 403 therefore has to be *read* before it can be
classified, which is why `_is_throttled` inspects `response.text`.

Canvas also reports quota in `X-Rate-Limit-Remaining`, a bucket that starts near
700 and is decremented by each request's cost. The client pauses pre-emptively
when that drops below 100, on the grounds that backing off voluntarily is
cheaper than being throttled and retrying.

Backoff is exponential with **full jitter** (`uniform(window/2, window)`) rather
than a fixed doubling, so that the four download workers of Phase 2 do not all
wake up and retry in the same instant.

### D12 — Login watches the API, not the page

`canvas-archive login` could detect a completed sign-in by matching page titles
or URLs. It doesn't, because those change whenever Cornell restyles the identity
provider, and because a URL landing on the dashboard does not guarantee the API
will accept the session.

Instead it polls `GET /api/v1/users/self` through the browser context's own
request API every two seconds. That is the same condition the archiver itself
needs, tested against the same cookie jar that will be saved — so a login that
reports success cannot be one that fails on the next command.

It also means the flow never reads, fills or synthesises a keystroke on any
credential field. The browser is handed over and only watched.

### D13 — An expired session stops the run cleanly

A stale session does not always produce a clean 401: Canvas may redirect to the
identity provider, or serve an HTML login page with status 200, which would
otherwise be parsed as a bafflingly-shaped API response. `_looks_like_a_login_page`
catches all three shapes, and in session mode they raise `SessionExpiredError`,
which the CLI turns into "run `canvas-archive login` again" and exit code 4.

The alternative — letting every subsequent request fail on its own — would turn
one expired cookie into hundreds of logged warnings and a half-written archive.

---

## Two credentials, one API

The thing worth understanding here: **session-cookie auth and bearer-token auth
hit exactly the same endpoints, because Canvas's own web UI is an API client.**

When you load a course page in a browser, the server returns a mostly-empty HTML
shell plus a JavaScript bundle. That bundle then calls
`/api/v1/courses/:id/modules`, `/api/v1/courses/:id/assignments` and the rest —
the same routes documented in Canvas's public API reference — and renders the
JSON. The browser's session cookie authenticates those calls.

So Canvas's authentication layer resolves either credential to the same "current
user" before routing ever happens:

```
Authorization: Bearer 1234~...        ─┐
                                       ├─→  current_user  ──→  /api/v1/... handler
Cookie: canvas_session=...            ─┘
```

Consequences that shape the code:

- **Identical responses.** Same JSON, same `Link` pagination headers, same
  `X-Rate-Limit-Remaining`. Nothing downstream of `CanvasHTTP` needs to know
  which credential was used.
- **Identical permissions.** A session cookie confers exactly what the user can
  see in the browser — no more. It does not bypass a disabled Files tab (Phase
  2's problem is unchanged by this), and it does not reach another user's data.
- **One asymmetry: CSRF.** Cookie-authenticated *writes* require an
  `X-CSRF-Token` header, because cookies are sent automatically by the browser
  and bearer tokens are not. Being GET-only (D3), we never encounter this.
- **One more asymmetry: expiry.** A token is valid until revoked or expired; a
  session ends on Canvas's schedule, often sooner and without warning. Hence
  D13.

The honest caveat: a token is the credential Canvas *intends* a program to use,
and it is the one to prefer when available. Session mode exists because token
issuance is gated at Cornell, and it is worth checking institutional policy on
automated access before leaning on it. The rate-limit courtesies in D11 are part
of that.

---

## Module map

```
src/canvas_archiver/
  __init__.py     version, package docstring
  config.py       environment → Config; auth mode; token redaction
  paths.py        where credentials and the browser profile live
  auth.py         AuthMode, Credential, the cookie store
  http_client.py  GET-only transport: pagination, backoff, session expiry
  client.py       endpoint knowledge; Canvas JSON → dataclasses
  login.py        Playwright browser login
  terms.py        Canvas term data → short codes (FA25); pure logic
  log.py          rich console + archive.log file logging
  cli.py          typer app: login, logout, list-courses, sync, status
```

Dependency direction is strictly downward — `cli` → `client` → `http_client` →
`auth` → `paths` — with `terms` and `log` as leaves. There are no cycles.

**`config.py`** turns environment variables into a frozen `Config`, validating
as it goes: the URL is normalised, `ARCHIVE_ROOT` is expanded and resolved,
the worker count must be an integer ≥ 1, and `CANVAS_AUTH_MODE` must name a real
mode. Note what is *not* a configuration error: a missing session. That is a
"run `canvas-archive login`" prompt, raised later by the auth layer where the
remedy can be stated precisely. Only token mode can fail at config time.

**`paths.py`** answers one question — where does state that is neither code nor
archive go? — and owns the permission helpers. `is_world_readable` exists
because `chmod` is silently a no-op on Windows-backed WSL paths, and a
credential file that could not be locked down should say so rather than pretend.

**`auth.py`** holds `AuthMode`, the `Credential` dataclass, and the cookie
store. `save_cookies` filters to the Canvas host, refuses a jar with no session
cookie in it (which means login never finished), and writes through a file
created owner-only first. `load_cookies` maps every unusable state — missing,
corrupt, wrong schema version, empty — onto `SessionExpiredError`, because all
four have the same remedy. `build_credential` is the only place that decides
what a mode means.

**`http_client.py`** is the transport, and the only module that makes a request.
`paginate` follows `rel="next"` lazily, so a caller that stops early stops the
requests too, and it strips the query parameters from follow-up requests because
Canvas embeds them in the `next` URL already. Classification of responses is the
subtle part: throttling (D11), expired sessions (D13), 403 vs 404 vs 5xx, and
which of those are worth retrying.

**`client.py`** knows the endpoints. It converts JSON to dataclasses (D7), and
swallows `AccessDeniedError`/`NotFoundError` on a single enrollment state so one
broken state cannot end a listing — the "one broken course must never kill the
run" rule applied at the coarsest level first.

**`login.py`** drives Playwright. Beyond D12, the notable part is
`_diagnose_launch_failure`: Playwright downloads a Chromium binary but not the
system libraries it links against, so a fresh Ubuntu can install the browser
successfully and still fail to start it, surfacing as one opaque exception. The
three realistic causes — missing system library, missing browser, no display —
are separated and each is reported with the command that fixes it.

**`cli.py`** is a `typer` app. Every command funnels through `_load()`, then
network commands through `_connect()`, which maps auth failures onto exit codes.
No command ever shows a traceback.

Exit codes: `0` success, `1` not yet implemented, `2` configuration error,
`3` Canvas API error, `4` needs login.

---

## Canvas REST endpoints

Base path is `https://canvas.cornell.edu/api/v1`.

### Implemented

| Caller | Endpoint | Notes |
| --- | --- | --- |
| `CanvasClient.verify()` | `GET /users/self` | Cheapest authenticated request Canvas offers. |
| `login` polling | `GET /users/self` | Same endpoint, through the browser's cookie jar (D12). |
| `CanvasClient.iter_courses()` | `GET /courses` | `enrollment_state=active` (plus `completed` and `invited_or_pending` under `--include-past`), `include[]=term`, `include[]=teachers`, `include[]=total_students`, `per_page=100`. |

Two notes on `GET /courses`:

- **`include[]=term` is not optional for us.** Without it the response carries
  only `enrollment_term_id` — an opaque integer — and the archive's top-level
  directory names depend on the term's *name* and *start date*.
- **`per_page=100`** is Canvas's maximum. The default is 10, so omitting it
  turns a one-request listing into ten.

### Planned

| Phase | Content type | Endpoint |
| --- | --- | --- |
| 2 | Files | `GET /courses/:id/folders`, `GET /folders/:id/files`, `GET /courses/:id/files` |
| 2 | File fallback | `GET /courses/:id/modules?include[]=items` → items of `type: "File"` → `GET /files/:id` |
| 3 | Modules | `GET /courses/:id/modules?include[]=items` |
| 3 | Pages | `GET /courses/:id/pages`, then `GET /courses/:id/pages/:url` |
| 3 | Assignments | `GET /courses/:id/assignments?include[]=submission&include[]=all_dates` |
| 3 | Announcements | `GET /announcements?context_codes[]=course_<id>` |
| 3 | Discussions | `GET /courses/:id/discussion_topics`, `GET /courses/:id/discussion_topics/:id/view` |
| 3 | Syllabus | `GET /courses/:id?include[]=syllabus_body` |
| 3 | Quizzes | `GET /courses/:id/quizzes` (metadata only) |
| 4 | Calendar | `GET /calendar_events?context_codes[]=course_<id>&all_events=true&type=event` and `&type=assignment` |
| 4 | Planner | `GET /planner/items?start_date=…&end_date=…` |

The Files-tab problem, which shapes the whole of Phase 2: `GET
/courses/:id/files` returns 403 when an instructor has hidden the Files tab from
students, even though the same files are reachable through module items and
through attachments embedded in page and assignment bodies. Hence the three
layered strategies, de-duplicated by Canvas file id. **Session auth does not
change this** — the tab is disabled for the user, not for the credential.

Two notes on the Phase 4 scheduling endpoints:

- `/calendar_events` is context-scoped and needs `context_codes[]=course_<id>`
  per course, plus `all_events=true` to escape the default date window.
  Assignment due dates come back only with `type=assignment`, which is a
  *separate* request from `type=event`.
- `/planner/items` is user-scoped, not course-scoped. One request covers every
  course, and the results are then split by `course_id` from each item's
  `plannable` payload.

---

## Manifest schema

*Implemented in Phase 4; specified here so collectors written in Phases 2–3
gather the right fields the first time.*

Each course gets a `manifest.json` with a `schema_version` and one entry per
archived item. The base entry:

```json
{
  "canvas_id": 4821993,
  "type": "assignment",
  "title": "Lab 3 — UART Driver",
  "canvas_url": "https://canvas.cornell.edu/courses/12345/assignments/4821993",
  "local_path": "_assignments/lab-3-uart-driver.md",
  "content_type": "text/markdown",
  "size": 4211,
  "updated_at": "2026-02-11T18:03:22Z",
  "sha256": "9f2c…",
  "module": { "id": 88213, "name": "Week 4 — Serial I/O", "position": 3 }
}
```

### Structured scheduling fields

Dates and status are stored as **first-class fields, not only inside the
Markdown**. A scheduler should never have to parse prose to find out when
something is due. Assignments, quizzes and discussions each carry a `schedule`
object:

```json
"schedule": {
  "due_at":        "2026-02-18T04:59:00Z",
  "unlock_at":     "2026-02-11T05:00:00Z",
  "lock_at":       "2026-02-25T04:59:00Z",
  "all_day":       false,
  "points_possible": 100.0,
  "grading_type":  "points",
  "submission_types": ["online_upload"],
  "allowed_extensions": ["pdf", "zip"],
  "published":     true,
  "locked_for_user": false,
  "submission": {
    "workflow_state": "graded",
    "submitted_at":   "2026-02-17T22:41:09Z",
    "graded_at":      "2026-02-20T14:02:55Z",
    "attempt":        2,
    "score":          94.0,
    "grade":          "94",
    "late":           false,
    "missing":        false,
    "excused":        false
  }
}
```

Per type, the fields that differ:

| Type | Additional `schedule` fields |
| --- | --- |
| Assignment | `has_submitted_submissions`, `omit_from_final_grade`, `allowed_attempts` |
| Quiz | `question_count`, `time_limit`, `allowed_attempts`, `quiz_type`, `shuffle_answers` |
| Discussion | `posted_at`, `todo_date`, `locked`, `discussion_type`, `require_initial_post` |

All timestamps are stored exactly as Canvas returns them — ISO 8601, UTC, with
the `Z` suffix. No local-time conversion happens at archive time, because the
archive outlives any one machine's timezone setting.

`submission` is populated from `include[]=submission` on the assignments
endpoint, which returns the *current user's* submission. It is `null` for
content with no submission concept, and for assignments never attempted.

### Calendar and planner

Two further top-level arrays in each course manifest:

```json
"calendar_events": [
  {
    "canvas_id": 9912,
    "title": "ECE 3140 Prelim 1",
    "type": "event",
    "start_at": "2026-03-05T00:10:00Z",
    "end_at":   "2026-03-05T01:40:00Z",
    "all_day":  false,
    "location_name": "Phillips Hall 101",
    "canvas_url": "https://canvas.cornell.edu/calendar?event_id=9912",
    "description_path": "_calendar/prelim-1.md"
  }
],
"planner_items": [
  {
    "plannable_id":   4821993,
    "plannable_type": "assignment",
    "title":          "Lab 3 — UART Driver",
    "todo_date":      "2026-02-18T04:59:00Z",
    "completed":      true,
    "manifest_ref":   "assignment:4821993"
  }
]
```

`manifest_ref` points back at the item's own manifest entry where one exists, so
a scheduler can join "this is due Tuesday" to "here is the material" without
re-deriving the relationship.

Planner items are fetched once per run rather than per course (the endpoint is
user-scoped) and then split by course. Items whose course is not being archived
are dropped.

### Why this matters now

Phases 2 and 3 write the collectors. If they only render Markdown and leave the
dates in prose, Phase 4 has to either re-fetch everything or parse its own
output. Specifying the fields before the collectors exist means each one
captures the structured payload on the way past.

---

## Phase log

### Phase 1 — scaffold, config/auth, `list-courses`

- `uv`-managed project, `src/` layout, Python pinned to 3.12.
- `.gitignore` written and committed **first**, so `.env` was ignored before it
  could exist.
- `config.py`, `terms.py`, `log.py`, `client.py`, `cli.py`.
- 63 tests: term-code parsing, config validation, token-redaction guarantees,
  and mocked tests over the Canvas→dataclass translation layer.

Note on the repo: `/home/gavin` turned out to be an initialised git repo with no
commits, which is why an unrelated `git status` listed `~/.ssh` as untracked.
This project was given its own repository rather than committing into that one.

### Phase 1.5 — auth rework: session cookies, and `canvasapi` removed

Cornell gates self-serve API tokens behind an approval request, so Phase 1's
`list-courses` could not be verified end to end. Rather than wait, auth was
generalised.

- **`canvasapi` removed** (D2) and replaced with `http_client.py`: ~240 lines of
  httpx over pagination, backoff and response classification.
- **Read-only made structural** (D3) rather than a promise in the README.
- **Two auth modes** behind one `Credential` (D9), selected by
  `CANVAS_AUTH_MODE`, defaulting to `session`.
- **`canvas-archive login`** (D12): a visible Chromium with a persistent profile,
  polling the API rather than the page. Plus `logout`, which deletes the local
  copy and says plainly that it does not end the session on Canvas's side.
- **Rate limiting and backoff** implemented up front (D11) rather than deferred
  to Phase 5, because the transport was being written anyway and retrofitting
  retry logic is worse than building it in.
- **Manifest scheduling fields specified** ahead of the collectors that will
  populate them, so Phases 2–3 capture them on the way past.
- 117 tests, up from 63. The new ones cover Link-header parsing, lazy
  pagination, the GET-only guarantee, Canvas's 403-means-throttled quirk, all
  three shapes of expired session, cookie filtering, and file permissions.

Deferred deliberately: `sync` and `status` implementations, filename
sanitization (Phase 2, where it is first exercised), and concurrency.

One environment note, recorded because it cost a debugging cycle: Playwright's
`install chromium` fetches the browser but not its system libraries. On Ubuntu
26.04 the missing pieces were `libnss3` and `libnspr4`, and the failure
surfaced only as `error while loading shared libraries` inside a Playwright
launch exception. `login.py` now detects this and prints the fix.
