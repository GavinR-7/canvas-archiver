# Canvas Archiver v2 — spec

Status: draft for Gavin's review, 2026-10-15. Supersedes the "File archiving" bullet in `NEXT.md` (slices 1–6 there stay valid; this adds the file side and orders v2).

## The goal in one paragraph

Today the extension shows what is due. v2 makes it the place where everything for a class lives on Gavin's own disk and in his own calendar: every file from every course in a folder he picked, an assistant that can fetch "the lecture slides for ECE 3140" for him, a chat over his course data, a schedule maker, and due dates from every source. Local-first and read-only toward Canvas, Gradescope and Ed stays true throughout; anything that leaves the machine is opt-in.

## Decision 1 — how a Chrome extension writes to a chosen folder

There are two real mechanisms. They are not equivalent.

| | `chrome.downloads.download({ filename })` | File System Access API (`showDirectoryPicker`) |
|---|---|---|
| Where files can go | **Only under the browser's default Downloads folder.** `filename` is a relative path; absolute paths and `..` are rejected. Subfolders (`Cornell/ECE 3140/Week 1/x.pdf`) are created automatically. | **Any folder the user picks**, including another drive or a synced folder. |
| Choosing the root | **Impossible from an extension.** The root is whatever Chrome's Downloads setting is. `saveAs: true` prompts for each file, which is useless for 400 files. | One picker, one click. |
| Who can call it | Service worker or any page. Survives the page closing. | **Extension pages only, with a user gesture for the picker.** Not the service worker. The page must stay open while a run is going. |
| Bytes | Never touch extension code; the browser follows Canvas's redirect to the CDN itself. | Extension code `fetch`es the bytes and writes them. Needs the CDN to answer a cross-origin read (see risk below). |
| Conflicts | `conflictAction`: `uniquify`, `overwrite` or `prompt`. | Our code decides; we can skip a file already present with the same size. |
| Persistence | Nothing to persist. | The directory handle is structured-cloneable and kept in IndexedDB. After a browser restart Chrome may need the user to re-grant access, and re-granting needs a click. |

The problem Gavin has ("a folder that gets lost") is exactly the first row: with `chrome.downloads` the root can never be his folder.

**Pick: File System Access API from the full-page app, with `chrome.downloads` under `Downloads/Cornell/…` as the fallback.**

- Primary path: Gavin clicks **Choose folder** once. The handle is stored. Runs write `Cornell/<course>/<module>/<file>` beneath it.
- The fallback exists for one honest reason: if the file CDN refuses cross-origin reads, the primary path cannot get bytes. Then the same planned layout is handed to `chrome.downloads`, which lands under `Downloads/` instead, and the UI says so plainly rather than pretending.
- Things Chrome does that we cannot change: `showDirectoryPicker` refuses a few system folders (the Downloads folder itself, Documents, Desktop at their root). The UI tells him to pick or create a subfolder, e.g. `Documents/School`.
- Credentials: the bytes request goes **without cookies** (`credentials: "omit"`) to the signed file URL; the Canvas-authenticated request only asks Canvas for that URL. This keeps the rule in `ARCHITECTURE.md` ("The downloader must not send Canvas credentials to a CDN"). The signed URL is never logged or stored.

## Deliverables, mechanism, done-when

Order is the build order. Each is one PR with unit tests on the pure logic and `npm run compile && npm test && npm run build` green, plus a note on what was not verified on a live account.

### D1 — Download folder and layout (T-13, this PR)
- **Mechanism:** Options in the full-page app: choose/reconnect folder (IndexedDB handle). Planner is pure: modules → files → relative paths `Cornell/<course>/<module>/<file>`, with path sanitising (illegal characters, Windows reserved names, length), duplicate-name handling inside a folder, files not in any module under `Cornell/<course>/Course files/<folder>/…`. Runner skips files already on disk with the same size, reports progress, continues past per-file failures.
- **Done when:** unit tests cover sanitising, collisions, module ordering and the not-in-a-module bucket; the app shows a plan (counts, total size) before anything is written; a run writes the tree into the chosen folder; a second run downloads nothing new; Gavin has run it on one real course.

### D2 — Every file for every class
- **Mechanism:** Extend D1's source list: syllabus, assignment and page attachments (`/courses/:id/assignments`, pages' `<a data-api-endpoint>` links), announcements' attachments, and Course files folders. Manifest (`manifest.json` per course, in the folder) records Canvas file id, updated_at, size, path, so updates are detected by `updated_at`, not name. Locked or hidden files are listed as "not available", never retried in a loop.
- **Done when:** a course with files in all of those places yields a manifest that matches Canvas's own file count (±files Canvas reports locked); re-run after Canvas changes one file downloads exactly that file.

### D3 — AI folder downloader
- **Mechanism:** "Get me all lecture slides for ECE 3140 and the last two prelims." The model sees the **manifest only** (names, modules, types, sizes — no file contents) and returns a list of file ids plus a one-line reason each. The UI shows the selection for approval; nothing downloads until Gavin confirms. BYO API key, stored in `chrome.storage.local`, same decision as slice 6.
- **Done when:** on a hand-written set of 15 requests against a real manifest, the selection is correct for at least 12 without edits (number goes in the README), and the key never appears in logs, storage exports or the manifest.

### D4 — AI chat over course data
- **Mechanism:** This is NEXT.md slice 6, extended with downloaded files: deterministic answers ("what's due Friday") come straight from the cache; the model gets only retrieved rows and, later, text extracted locally from syllabi. No hosted proxy.
- **Done when:** correctness measured on a hand-written question set and quoted in the README; answers cite which item they came from.

### D5 — Schedule maker
- **Mechanism:** NEXT.md slice 4 (class meeting times, from the Cornell Class Roster API or manual entry) plus a planner: given due dates and estimated effort, propose study blocks around class times. Output is shown, never written to a calendar without a click. DST-safe week bounds reuse `lib/time.ts`.
- **Done when:** a week view renders class times and due items, tests cover week boundaries and a DST week, and "propose blocks" produces a plan with no overlaps with class times.

### D6 — Dates from every source
- **Mechanism:** One `Task` list from Canvas planner, Gradescope (done, in review), Ed Discussion (slice 2), and syllabus-extracted dates (D2+D4, flagged "from syllabus, unconfirmed"). Opt-in sync to `gavin-data` (slice 3) so HQ can plan from real deadlines. Duplicate detection across sources (same course, near title, same day).
- **Done when:** Upcoming shows all four sources with a source badge, a duplicate across Canvas and Gradescope appears once, and `due.json` sync is idempotent (no commit when unchanged).

### D2b — HQ ingest profile (requested by Research-Lead, T-14)
`knowledge/courses/README.md` "Ingest contract" wants the same download in a different shape: `<inbox>/<course-slug>/<NN-module-slug>/<file>`, syllabus in `_syllabus/`, and a `_batches/<ISO>.json` written **last** listing `{course, path, source: "canvas:file/<id>", canvasModifiedAt, size, sha256}` per file. It is a second layout profile on the same planner, not a different downloader: D1 keeps the planner's root and segment naming parameterised for it. Needs sha256 of the bytes as they are written (streamed hash in the runner), the six course slugs mapped from Canvas course codes, and a "Chrome may refuse `\\wsl.localhost`" fallback to a Windows folder (unverified, first run decides).
- **Done when:** with profile "HQ ingest" selected, a run writes the files plus a batch manifest whose entries match the files on disk byte for byte (size, sha256), the manifest appears only after every file is written, and a re-run lists only changed files.

## Out of scope for v2

Writing anything to Canvas, Gradescope or Ed (submitting, posting, marking read). Multi-institution support. A hosted backend. Mobile.

## Risks to retire first

1. **CDN cross-origin read.** D1's primary path assumes the file URL Canvas hands back can be `fetch`ed from an extension page without cookies. Canvas file links redirect to a signed CDN URL; whether the CDN allows the read (CORS headers) or the redirect chain stays within hosts the extension may reach is **not yet verified**. That is the first thing Gavin's real-account test answers, and why the fallback exists.
2. **Persistent folder permission.** Whether Chrome keeps the folder grant for an extension page across restarts, or asks every time. The UI is built to ask with one click (**Reconnect folder**) either way.
3. **Large courses.** Hundreds of files and a page that must stay open. The runner is resumable (skips existing same-size files) so closing the tab loses nothing.
