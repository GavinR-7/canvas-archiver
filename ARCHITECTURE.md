# Architecture

A running record of how canvas-archiver is built and why. Each phase appends to
it. If you read this file top to bottom you should understand the whole system,
including which Canvas REST endpoints are actually being called under the
`canvasapi` abstraction.

- [Design decisions](#design-decisions)
- [Module map](#module-map)
- [Canvas REST endpoints](#canvas-rest-endpoints)
- [What `canvasapi` is doing for us](#what-canvasapi-is-doing-for-us)
- [Phase log](#phase-log)

---

## Design decisions

### D1 — Official REST API with a personal access token

No browser automation, no scraping, and the Cornell password is never involved.
A token is a revocable, scoped credential you can delete from Canvas's settings
page at any time without changing your password. Scraping would also break on
every Canvas UI change, whereas the REST API is versioned and stable.

The token is used with `Authorization: Bearer <token>` on every request. Canvas
has no concept of a read-only token, so "read-only" here is enforced by
construction: this codebase issues no `POST`, `PUT`, `PATCH` or `DELETE`, and
never will.

### D2 — `canvasapi` for the API, raw HTTP for file bytes

`canvasapi` is the right tool for the JSON API — it handles auth headers,
`Link`-header pagination and object hydration. It is the wrong tool for
downloading a 300 MB lecture video, because its file helper buffers in memory.
File bytes will therefore be fetched with `httpx` streaming in Phase 2, using
the pre-signed `url` that Canvas returns on a file object. Those URLs are
already authenticated via a short-lived token in the query string, so the
download does **not** need the `Authorization` header.

### D3 — Configuration only through environment variables

No config file format to design, no precedence rules to explain, and secrets
never sit in a file that is easy to `git add` by accident. `.env` is in
`.gitignore` as of the very first commit — before any `.env` could exist.

Real environment variables take precedence over `.env` (`load_dotenv(override=False)`),
so `CANVAS_API_TOKEN=... canvas-archive sync` works for one-off runs.

### D4 — The token is never printed, logged, or put in an exception message

`Config` stores the token in a field with `repr=False`, and `Config.__str__` is
overridden. Anything user-facing goes through `Config.redacted_token()`, which
shows only the Canvas key-id prefix (the part before `~`, which is not secret)
and the last four characters — e.g. `1234~...aB9x`. That's enough to tell two
tokens apart in a screenshot or log without the token being recoverable.

Three tests in `tests/test_config.py` assert the token is absent from `repr`,
`str` and the redacted form; one in `tests/test_client.py` asserts it is absent
from the authentication error message. This is the kind of thing that only stays
true if a test holds it true.

### D5 — The archive lives outside the repo

`ARCHIVE_ROOT` defaults to `~/canvas-archive`, a sibling of the repo rather than
a subdirectory. Course material is other people's copyrighted work and has no
business in version control. `canvas-archive/` is *also* in `.gitignore`, as a
second line of defence in case someone points `ARCHIVE_ROOT` inside the repo.

### D6 — Term codes are normalised aggressively

The term code is a top-level directory name, so `"Fall 2025"`, `"2025FA"` and
`"FA25"` must all produce exactly one directory. `terms.py` tries the term name
first (both orderings, several separators), falls back to the month of the
term's `start_at`, and finally to `NOTERM`. It is pure logic with no I/O, which
is why it has the densest test coverage in the project so far.

Cornell's calendar drives the month→season mapping: January is the winter
session, February–May spring, June–July summer, August–December fall.

### D7 — Canvas objects are converted to dataclasses at the boundary

`canvasapi` returns objects whose attributes are conditionally present.  A
course outside its availability window comes back with
`access_restricted_by_date: true` and essentially nothing else; a course fetched
without `include[]=teachers` has no `teachers` attribute at all. Rather than
scatter `getattr(x, "y", None)` through every collector, `client.py` converts
each course to a frozen `CourseSummary` at the point of retrieval. Restricted
courses are flagged rather than dropped, so the CLI can explain why a course is
absent from the archive instead of silently omitting it.

### D8 — Read-only commands never create the archive root

`setup_logging` will happily write `<archive_root>/archive.log`, but creating
that directory is `sync`'s privilege alone. `list-courses` and `status` attach
the file log only if the archive root already exists. Otherwise merely asking
"what courses do I have?" would leave an empty archive directory behind, and
`status` would then report an archive that had never been synced as existing.

---

## Module map

```
src/canvas_archiver/
  __init__.py   version, package docstring
  config.py     environment → Config; token redaction
  terms.py      Canvas term data → short codes (FA25); pure logic
  log.py        rich console + archive.log file logging
  client.py     canvasapi wrapper; Canvas objects → dataclasses
  cli.py        typer app: list-courses, sync, status
```

**`config.py`** turns process environment variables (loaded from `.env` by
python-dotenv) into a single frozen `Config`. It validates as it goes: the
Canvas URL is stripped of trailing slashes and given an `https://` scheme if
missing, `ARCHIVE_ROOT` is expanded and resolved to an absolute path, and the
worker count must parse as an integer ≥ 1. A missing token raises `ConfigError`
with instructions for generating one — except for offline commands, which pass
`require_token=False`. The token lives in a `repr=False` field and is only ever
displayed via `redacted_token()`.

**`terms.py`** is the only module with no dependencies on anything else in the
package. Given a Canvas term name and optional start date, it produces a
`TermInfo` whose `code` is always a non-empty, directory-safe string. It also
exports `sort_key`, so terms sort chronologically (winter → spring → summer →
fall within a year) with `NOTERM` last — which is what makes the
`list-courses` table read in calendar order.

**`log.py`** configures one logger per invocation, with two handlers: a
`RichHandler` for the console at INFO (DEBUG with `--verbose`, WARNING with
quiet) and a `FileHandler` at DEBUG writing `<archive_root>/archive.log`. It is
idempotent — existing handlers are torn down first — so repeated calls and test
runs don't duplicate output. A log file that cannot be opened produces a warning
and nothing worse; a permissions problem in the archive directory must not stop
an archive run. The module is named `log` rather than `logging` precisely so it
can't be confused with the stdlib module it wraps. It also owns the shared
`rich.Console` and its colour theme, so every piece of user-facing output is
styled consistently.

**`client.py`** holds one authenticated `canvasapi.Canvas` session for the life
of a run. `verify()` is the cheapest possible authentication check and returns
the account's display name, which doubles as a "you are talking to the right
account" confirmation. `iter_courses()` queries one or more enrollment states
and de-duplicates by course id, because `--include-past` asks for `active`,
`completed` *and* `invited_or_pending`, and a course can legitimately appear in
more than one. Canvas exception types are translated into two local ones:
`AuthenticationError` for a rejected token (fatal, and the message explains how
to mint a new one) and `CanvasClientError` for everything else. A `403` or `404`
on a single enrollment state is logged as a warning and skipped rather than
raised — the "one broken course must never kill the run" rule, applied at the
coarsest level first.

**`cli.py`** is a `typer` app with three subcommands. Every command funnels
through `_load()`, which sets up console logging, loads config, reports a
`ConfigError` as a one-line message with exit code 2, then re-attaches logging
now that the archive path is known. API failures exit 3. No command ever shows
the user a traceback. `sync` and `status` are scaffolded with their full flag
surface so the `--help` output is honest about where the project is going, and
both currently say which phase they arrive in.

Exit codes: `0` success, `1` command not yet implemented, `2` configuration
error, `3` Canvas API error.

---

## Canvas REST endpoints

What each piece of the tool actually requests. Base path is
`https://canvas.cornell.edu/api/v1`.

### Implemented (Phase 1)

| Caller                      | Endpoint            | Notes                                                                                                                                                                                       |
| --------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CanvasClient.verify()`     | `GET /users/self`   | The cheapest authenticated request Canvas offers. A `401` here means the token is bad; anything else means it's good.                                                                          |
| `CanvasClient.iter_courses()` | `GET /courses`    | With `enrollment_state=active` (plus `completed` and `invited_or_pending` under `--include-past`), `include[]=term`, `include[]=teachers`, `include[]=total_students`, and `per_page=100`. |

Two notes on `GET /courses`:

- **`include[]=term` is not optional for us.** Without it the response carries
  only `enrollment_term_id` — an opaque integer — and the archive's top-level
  directory names depend on the term's *name* and *start date*.
- **`per_page=100`** is Canvas's maximum. The default is 10, so omitting it
  turns a one-request listing into ten.

### Planned

| Phase | Content type  | Endpoint                                                                                   |
| ----- | ------------- | ------------------------------------------------------------------------------------------ |
| 2     | Files         | `GET /courses/:id/folders`, `GET /folders/:id/files`, `GET /courses/:id/files`              |
| 2     | File fallback | `GET /courses/:id/modules?include[]=items` → items of `type: "File"` → `GET /files/:id`     |
| 3     | Modules       | `GET /courses/:id/modules?include[]=items`                                                  |
| 3     | Pages         | `GET /courses/:id/pages`, then `GET /courses/:id/pages/:url` for each body                  |
| 3     | Assignments   | `GET /courses/:id/assignments?include[]=submission`                                         |
| 3     | Announcements | `GET /announcements?context_codes[]=course_<id>`                                            |
| 3     | Discussions   | `GET /courses/:id/discussion_topics`, `GET /courses/:id/discussion_topics/:id/view`         |
| 3     | Syllabus      | `GET /courses/:id?include[]=syllabus_body`                                                  |
| 3     | Quizzes       | `GET /courses/:id/quizzes` (metadata only — question content is generally not exposed)      |

The Files-tab problem, which shapes the whole of Phase 2: `GET
/courses/:id/files` returns `403` when an instructor has hidden the Files tab
from students, even though the same files are reachable through module items and
through attachments embedded in page and assignment bodies. Hence the three
layered strategies, de-duplicated by Canvas file id.

---

## What `canvasapi` is doing for us

Worth being explicit about, since the point of this project is to understand the
system rather than just run it.

1. **Auth.** `Canvas(url, token)` builds a `requests.Session` that attaches
   `Authorization: Bearer <token>` to every call. Nothing else in this codebase
   touches that header.
2. **Pagination.** Canvas paginates list endpoints with an RFC 5988 `Link`
   header (`rel="current"`, `"next"`, `"prev"`, `"first"`, `"last"`).
   `canvasapi` returns a lazy `PaginatedList` that follows `rel="next"` as you
   iterate, so `for course in canvas.get_courses(...)` transparently spans
   pages. The catch is that the *page size* is still ours to set, which is why
   `per_page=100` is passed explicitly.
3. **URL construction.** Keyword arguments become query parameters with Canvas's
   bracket convention: `include=["term", "teachers"]` serialises to
   `include[]=term&include[]=teachers`.
4. **Object hydration.** JSON becomes Python objects whose attributes mirror the
   response keys. This is convenient and also the source of D7's problem —
   absent keys mean absent attributes, not `None`.

What it does **not** do, and we therefore must: rate-limit handling
(`X-Rate-Limit-Remaining`, and Canvas's habit of signalling throttling with a
`403` rather than a `429`), retries with backoff, streaming downloads, and
concurrency. Those are Phase 5, except streaming downloads which Phase 2 needs.

---

## Phase log

### Phase 1 — scaffold, config/auth, `list-courses`

Built:

- `uv`-managed project, `src/` layout, Python pinned to 3.12 via `.python-version`.
- `.gitignore` written and committed **first**, so `.env` was ignored before it
  could exist. Also ignores `canvas-archive/` and `*.log`.
- `config.py`, `terms.py`, `log.py`, `client.py`, `cli.py` as described above.
- `.env.example` documenting all four variables.
- 63 tests: exhaustive term-code parsing, config validation and normalisation,
  token-redaction guarantees, and mocked tests over the Canvas→dataclass
  translation layer including the bare restricted-course case.

Dependencies, all from the approved list: `canvasapi`, `typer`, `rich`, `httpx`,
`python-dotenv`, `markdownify`; `pytest` and `pytest-cov` for dev. `httpx` and
`markdownify` are declared now but unused until Phases 2 and 3.

Note on the repo: `/home/gavin` turned out to be an initialised git repo with no
commits, which is why an unrelated `git status` listed `~/.ssh` as untracked.
This project was given its own repository at `~/canvas-archiver/.git` rather
than committing into that one.

Deferred deliberately: the `sync` and `status` implementations, the manifest
schema, filename sanitization (Phase 2, where it is first exercised), and the
rate-limit/retry layer.
