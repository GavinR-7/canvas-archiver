# Canvas Archiver

A Chrome extension that puts everything a Cornell student needs from Canvas,
Gradescope and Ed Discussion in one place, on their own machine: what is due,
every course file in a folder they chose, and an optional chat over their course
text. Local-first and read-only. No backend, no account, no analytics.

Built with WXT, React and TypeScript on Manifest V3. 494 unit tests.

> **Status:** release candidate (PR #27), loaded unpacked. It has not been
> through Chrome Web Store review, and the Gradescope, Ed and chat paths have not
> yet been confirmed against a live account (see [Limits](#limits-stated-plainly)).

## The problem

Cornell's Canvas gives students **no API tokens**. Cornell's own page says tokens
"are basically equivalent to your username and password" and that student
requests need a faculty sponsor, and the service was decommissioned in April 2024.
So the usual route for a student tool (generate a token, call the REST API) is
closed.

The real pain this leaves:

- Deadlines live in three places. Canvas, Gradescope and Ed each hold some, and
  CS 3700 posts assignments only on Gradescope. Exam dates often appear only in a
  syllabus PDF or an Ed announcement.
- Course files vanish when a term ends. There is no "download everything"
  button, and files are scattered across modules, pages, assignments and
  announcements.

## The approach

Use the session the student already has. A service worker makes `GET` requests
to Canvas with the browser's own cookies, the same way Canvas's front end does.
There is no token, no password, and no server. This was measured, not assumed:
`extension/spike/` is a throwaway extension that answered the auth question
before any product code was written (see
[`extension/ARCHITECTURE.md`](extension/ARCHITECTURE.md)).

| Piece | What it does |
| --- | --- |
| Popup | Who you are signed in as, current-term courses, what is due in 14 days. Off Canvas it shows the stored snapshot only and prompts you to open Canvas. |
| Upcoming | One list across Canvas, Gradescope and Ed with a source badge on each item. Duplicates across sources collapse. A separate **All exams** list reaches 240 days out. |
| Files | Pick a folder once (File System Access API). Archives modules, course files, pages, assignments, announcements and syllabi into `Cornell/<course>/<module>/`, incrementally, with a manifest per course. Falls back to `Downloads/` if the browser blocks a write. |
| Course browser | Tick individual files and download them. Page attachments and embedded images are saved beside their pages. |
| Due-date scheduler | A 2-hour alarm refreshes dates. Optional, opt-in sync writes a `due.json` of upcoming deadlines to a GitHub repo you name ([contract](docs/DUE_JSON.md)). |
| Week schedule | A week view of class times and due items. |
| Course chat | Search your course text (no key needed), or ask questions with your own Anthropic key. Answers cite numbered passages and invented citations are flagged. Per-course opt-in. |

## Architecture

```
                       your browser (everything below runs here)
 ┌────────────────────────────────────────────────────────────────────────┐
 │                                                                        │
 │  popup ─┐                                                              │
 │  upcoming ─┤  runtime messages   ┌───────────────────────────┐         │
 │  files ────┼───────────────────► │ service worker            │         │
 │  browse ───┤  GET_SNAPSHOT /     │  - 2h alarm               │         │
 │  chat ─────┤  REFRESH            │  - serialized sync        │         │
 │  schedule ─┘                     │  - snapshot cache         │         │
 │     │                            └──────┬─────────┬──────────┘         │
 │     │ reads cache                       │         │                    │
 │     ▼                                   │         │ opt-in only        │
 │  chrome.storage.local  ◄────────────────┘         │                    │
 │                                                   │                    │
 │  Files page (extension page, user gesture)        │                    │
 │   planner → runner → sink ─► chosen folder        │                    │
 │              │  manifest per course               │                    │
 └──────────────┼────────────────────────────────────┼────────────────────┘
                │ GET, session cookie                │ your own key / token
                ▼                                    ▼
   canvas.cornell.edu · gradescope.com · edstem.org     api.github.com
                                                        api.anthropic.com
```

Decisions worth reading:

- **Pure core, thin shell.** Planning, merging, parsing, retrieval and
  scheduling are pure functions with unit tests. The browser pieces (storage,
  folder, downloads) sit behind small interfaces, so the file runner is tested
  without a browser.
- **Why the File System Access API, not `chrome.downloads`.** `chrome.downloads`
  can only write under the Downloads folder, so a user-chosen root is impossible.
  The folder picker works only from an extension page, not the service worker, so
  archiving runs in the Files page. Downloads stays as an honest fallback, and
  the UI says when it was used. Reasoning is in [`docs/V2_SPEC.md`](docs/V2_SPEC.md).
- **Incremental archive.** Each course has a manifest keyed by stable source id
  (`canvas:file/<id>`), compared by modified time or content hash, plus a size
  check on disk. A second run downloads only what changed. A course folder is
  bound to its Canvas id so two same-named courses cannot collide.
- **`Task` is the single contract.** Each new source (Gradescope, Ed, syllabus,
  manual exams) adds a `TaskSource`, not another list.
- **Data survives partial failure.** One source failing never blanks the others.
  A source that did not read completely cannot replace cached dates, so a flaky
  Ed call does not wipe real deadlines.
- **Carried over from the CLI.** The Python CLI in [`cli/`](cli/) is frozen, but
  its hard-won Canvas knowledge lives on: `Link`-header pagination (page size
  defaults to 10, so `per_page=100`), throttling signalled by `403` rather than
  `429`, assignment deadlines needing a separate `calendar_events` request, and
  `planner/items` being user-scoped.

## Security choices

The extension holds a signed-in session, so most of the design is about where
that session can and cannot go.

- **Read-only, enforced in code.** One `canvasFetch` helper hard-codes `GET`.
  No configuration changes that, so the extension never needs Canvas's CSRF token.
- **Credentials go to one host.** `assertCanvasOrigin` compares scheme, host and
  port exactly (`evil.canvas.cornell.edu` is rejected). The server-supplied `Link`
  `next` URL is checked before it is followed.
- **File bytes go cookie-less first.** The authenticated call only asks Canvas
  for a signed file URL, and the download is tried with `credentials: "omit"`.
  Only if that fails, and only when the URL is on the Canvas origin, is it retried
  with the session. A URL on any other host never gets the session. The signed
  URL is not logged or stored.
- **Embedded images stay on the Canvas origin (T-532).** An image address comes
  from file metadata, not the page, so it is held to the same rule. An off-origin
  address is refused before any request, and images are fetched with
  `credentials: "omit"` (no session, no browser downloader). Redirects are read
  one hop at a time, an off-origin hop is refused, and hops are capped at four.
  Caveat: when the browser hides a redirect (`opaqueredirect`), that hop is
  re-fetched with `redirect: "follow"`, so the origin check does not see where it
  went; the request is still cookie-less.
- **No surprise network from the popup (T-548).** Opened off Canvas, the popup
  reads only the stored snapshot. It does not wake the worker or refresh, and the
  refresh button is disabled. One function, `readSnapshot`, decides whether a read
  may reach the network.
- **Signed-out is quiet (T-535).** Signed-out services no longer write errors
  into `chrome://extensions`; the popup tells you to open Canvas instead.
- **Narrow permissions.** Host access is Canvas, Gradescope and Ed only. GitHub
  and Anthropic access is requested at the moment you turn the feature on. No
  `tabs`, no `<all_urls>`.
- **Keys are removed when a feature is turned off.** The GitHub token and
  Anthropic key leave storage when you switch the feature off or clear the field.
- **AI is opt-in per course.** Course text is sent only for courses you tick,
  only the retrieved passages, only to the provider with your own key.
  See [`docs/PRIVACY.md`](docs/PRIVACY.md).

## Run it

```bash
cd extension
npm ci
npm run compile     # type check
npm test            # 494 tests
npm run build       # unpacked MV3 build in .output/chrome-mv3/
```

Load `extension/.output/chrome-mv3/` at `chrome://extensions` (Developer mode,
Load unpacked). Windows-side steps and first-run notes are in
[`docs/CANVAS_V2_RC.md`](docs/CANVAS_V2_RC.md) and [`docs/SETUP.md`](docs/SETUP.md).
To show it off, follow [`docs/demo-script.md`](docs/demo-script.md).

## Limits, stated plainly

- **Cornell only.** One Canvas origin is configured, kept in a single place so
  other schools are a code change, not a rewrite.
- **Not verified on a live account:** the Gradescope parser (written against
  reconstructed markup), Ed's endpoints, the syllabus date extractor on real
  syllabi, and the chat model call. Failures are isolated, so these degrade to
  "source unavailable" instead of breaking Canvas.
- **Chat reads Canvas text only.** PDFs and slides are not read yet.
- **Exam dates from syllabi are labelled unconfirmed.** They are best-effort
  text extraction.
- **Policy.** Cornell's rules prohibit selling or distributing course materials
  and say nothing on a personal browser extension either way. This tool keeps
  files on the student's device and never sells or shares them. Check your
  course's AI policy before using chat.
- It is an independent project, not affiliated with Cornell, Instructure,
  Gradescope or Ed.

## Repo layout

```
extension/            the Chrome extension (src/, entrypoints/, tests/, spike/)
cli/                  frozen Python reference implementation (Canvas knowledge)
tools/hq-ingest/      optional script that ingests the archive layout
docs/                 spec, privacy policy, due.json contract, store notes
NEXT.md               roadmap
```

The Python CLI reached `login`, `list-courses` and `status` before the project
pivoted to an extension; see [`cli/README.md`](cli/README.md).
