# NEXT

Roadmap for the Chrome extension (`extension/`). The CLI in `cli/` is frozen.
Order comes from `hq/STATE.md` → Products. Updated 2026-10-14.

## Where it stands

- M1 (shipped): popup with signed-in user and active courses; full-page **Upcoming** view, next 14 days, from `/planner/items`. Session-cookie auth from the service worker, measured in the spike.
- **Slice 1 (this branch, `products/gradescope-due-dates`)**: Gradescope assignments with due dates merged into Upcoming. CS 3700 posts only there. Details below.

## Principles for every slice

- Local-first. No backend, no account, no telemetry. Anything that leaves the machine (slice 3, slice 6) is opt-in and user-supplied credentials only.
- Read-only toward Canvas, Gradescope and Ed. GET only, origin-checked.
- Each slice is one PR with unit tests on the pure logic, `npm run compile && npm test && npm run build` green, and a note on what was *not* verified against a live account.
- `Task` is the shared contract (`src/types/canvas.ts`). New sources add a `TaskSource`, not a new list.

## v2 plan

The v2 deliverables (download folder, all files, AI downloader, chat, schedule maker, dates from every source, HQ ingest profile) are specified in `docs/V2_SPEC.md`, each with a done-when. D1 (download folder, layout `Cornell/<course>/<module>/`) is on branch `products/v2-download-folder`. It adds the `downloads` permission (fallback only), so Chrome will ask to re-approve on update.

**D2 + D2b (branch `products/v2-full-archive`, built):** the Files page now archives modules, course files, pages, assignments, announcements and the syllabus per course. Incremental: a manifest per course keyed by stable source id (`canvas:file/<id>`), compared by Canvas modified time (inline items by content hash), plus an on-disk size check in the archive layout. Two layouts over one planner: `archive` (`Cornell/<course>/<NN module>/`, manifest in `.canvas-archive.json`) and `ingest` (HQ contract: `<slug>/<NN-module>/`, `files/`, `_syllabus/`, `_batches/<ISO>.json` written last, state kept in `chrome.storage.local` because ingest drains the inbox). Streaming SHA-256 of the bytes written. **Not in this PR:** Gradescope content (parser still unverified on a real account); per-course timing is displayed after a run but not yet measured. **Next:** T-25 dates from every source + `due.json` sync.

## T-390 status (branch `products/store-readiness`)

Web Store readiness, on top of the v2 stack: icons, four real-UI screenshots (`docs/store/`), first-run consent gate (every page plus the service worker), `docs/PRIVACY.md`, permission justifications and the Cornell-only host decision in `docs/STORE_LISTING.md`. **Not done (Gavin's):** policy hosting URL, contact email, developer account, submit. **Unverified:** a real-account run of the zip; Chrome's own review.

## T-464 status (branch `products/v2-2-review-fixes`, PR #11 on top of #10)

Fixes Anvil's T-461 review of #1-#9 (review-canvas-stack-1-9.md):
- **P1 course folders.** A course's folder name is bound to its Canvas id (`files/dirs.ts`, `archiveDirs:<layout>` in chrome.storage.local) and fixed at the first run that writes it, so selecting only the second of two same-named courses no longer aims it at the first one's folder. `folderManifestStore.load` throws `ForeignCourseError` when the folder's manifest names another course; the runner fails that course's items with a plain message and still archives the others. Old two-course folders made before this: select both courses in one run once and they match again. A course renamed in Canvas keeps its folder.
- **P2 feed batches.** Ingest runs stage bytes under `_staged/<batch>/<path>`; the batch entry keeps `path` (destination) and adds `stage`. `tools/hq-ingest` reads `stage` when present (confined to `_staged/<batch>/<same path>`), and prunes emptied staging folders. Batches written by the older extension still ingest. The contract text in `knowledge/courses/README.md` (gavin-data) should mention the optional `stage` field; I did not edit it.
- **P2 tokens.** The GitHub token and Anthropic key are removed from storage when their feature is turned off or the field is emptied (also on load, for leftovers from earlier versions). Durable storage while the feature is on is the accepted exception; `docs/PRIVACY.md` now says so.
- Not covered: a crash after files are staged but before the batch is written leaves unlisted staged files (reported as strays by ingest) that the manifest already counts as saved.

## Slice 1 — Gradescope due dates (in review)

- Reads `/account` (course list, term headings) and `/courses/:id` (assignment table) with the signed-in session. Regex parser because the MV3 service worker has no `DOMParser`.
- Only the current term's courses are fetched (falls back to Gradescope's newest term between terms).
- Failures are isolated: a Gradescope error never blanks Canvas data and vice versa (`Snapshot.gradescopeError`).
- New host permission `https://www.gradescope.com/*`. **Chrome disables an installed extension until the user re-approves a new host permission**; loading unpacked again is fine.
- **Unverified:** the parser is written against reconstructed markup (`tests/fixtures/gradescope-markup.ts`), not a capture. First run on Gavin's real account decides it. If a row is missing: save the course page HTML (redacted), swap it into the fixture, fix the selector. Also unverified: that the session cookie attaches cross-origin for Gradescope the way it does for Canvas (spike result is Canvas-only).
- **Follow-ups:** exams/quizzes that Gradescope lists outside the assignment table; show "late due" as a second deadline; multi-institution hosts.

## T-25 status (branch `products/v2-dates`)

Built: exam dates from the Canvas syllabus and Ed announcements/pinned threads (`src/dates`, `src/ed`), merged across sources (`mergeTasks`), shown as *unconfirmed*; opt-in `due.json` sync (`src/sync`, options page, 2-hour alarm; contract in `docs/DUE_JSON.md`). **Unverified on a real account:** Ed's endpoints/auth (written from memory of its web client), Gradescope parser (PR #1), the syllabus extractor on Gavin's real syllabi (tests use synthetic text). Canvas calendar events (instructor-posted prelims) are not read yet.

## T-27 status (branch `products/v2-feed`)

Built: opt-in nightly feed (Settings → inbox folder + switch; alarm opens `files.html?auto=feed`, which runs the ingest layout into the inbox and closes), course folders normalised to the contract name (`ECE 3030 FA26` → `ece3030`), and `tools/hq-ingest/`, the no-AI ingest script (tested). **Unverified:** (Chrome refused a `\\wsl.localhost` folder in the I-16 test; the feed now uses the Windows folder `C:\Users\gavin\hq-course-inbox`, T-500) folder permission surviving a browser restart, `pdftotext` not installed here, the whole chain on a real course.

## T-28 status (branch `products/v2-ai-pick`)

Built: "Get everything for…" on the Files page. `src/ai/pick.ts` is pure rules (exam named in folder/file, other-numbered exams excluded, "weeks 3-6", syllabus "Prelim 2 covers lectures 10-18"), each pick with its reason; `src/ai/model.ts` is the opt-in fallback with the user's own key (names only, reply cut to ids we sent). **Unverified:** a real request on a real account; syllabus phrasing varies, so coverage detection is best-effort; the model call has never been made (no key here).

## T-29 status (branch `products/v2-chat`)

Built: Course chat page (popup → "Course chat…"). `src/chat/retrieve.ts` (chunk + BM25, pure), `src/chat/prompt.ts` (numbered passages, citations checked against what was sent; invented numbers are flagged), model `claude-haiku-5-5` (cheapest tier, shown on the page). Separate Settings opt-in before any course text is sent. **Gaps, stated plainly:** it searches Canvas text (pages, assignments, announcements, syllabus) read live, not the on-disk manifest; PDFs and slides are not read (next step: pdf.js text extraction, or reuse the ingest `text/` mirror). Citation form follows the README (`[ECE 3030 · path §section]`) but page numbers need PDF text. No review guide has been generated on a real course.

## Slice 2 — Ed Discussion

- Ed has a real JSON API behind the web app (session-authenticated). Spike first: which endpoint lists a course's threads, what a staff announcement or "due" post looks like, and whether the cookie attaches from the worker.
- Goal for the slice is narrow: surface **staff announcements and pinned threads** per course in the Upcoming view, not a general Ed client. Due dates only if courses actually post them in a parseable way.
- Needs `https://edstem.org/*` (and `us.edstem.org` / the region host Cornell uses; check).
- Done when: unread staff posts from the last 7 days show per course; build and tests green.

## Slice 3 — Due-date sync to gavin-data

- Every 2 hours (`chrome.alarms`), write `due.json` (all `Task`s due in the window, normalized, no titles of private notes) to the `gavin-data` repo through the GitHub contents API (`PUT /repos/.../contents/due.json`).
- Fine-grained token, contents:write on that one repo, entered on an **options page** and kept in `chrome.storage.local`. Never logged, never in the manifest. Gavin creates the token (account/credential step, his call).
- Needs `https://api.github.com/*` host permission, so it is the first slice that sends data off-machine: off by default, explicit toggle, and the README says exactly what is sent.
- Use the `sha` of the existing file for updates; skip the PUT when content is unchanged so history doesn't fill with no-op commits.
- Why it matters: it is what lets HQ plan Gavin's week from real deadlines instead of the ICS feed, and the sync contract is a nice portfolio piece (idempotent writes, conflict handling, bounded token scope).

## Slice 4 — Weekly calendar with class times

- Week grid (Mon–Sun) combining due dates with **class meeting times**. Canvas does not expose meeting times reliably; source is the Cornell Class Roster API or a manually entered schedule on the options page. Decide after a quick look at what the roster API returns for Fall 2026.
- Pure-logic core: layout of overlapping blocks, all-day vs timed, DST-safe week bounds (reuse `lib/time.ts`).
- Done when: a week view renders courses' meetings and due items, tested on week boundaries and a DST week.

## Slice 5 — Grades view

- Per-course current grade and per-assignment scores. Canvas: `enrollments[].computed_current_score` and submissions with `include[]=submission`. Gradescope: scores already parsed in slice 1 (`submissionStatus--score`).
- Differentiator over Better Canvas: **what-if across both systems in one place** (Gradescope-only courses included) and weighted-group math done locally.
- Done when: course list with current %, drill-down to assignments, what-if input for one ungraded item.

## Slice 6 — Chatbot over course data

- Question answering over what is already cached: tasks, grades, announcements, (later) syllabus files.
- **Decision for Gavin before building:** BYO API key stored locally (zero cost to us, but setup friction and the key lives in the browser) vs a hosted proxy (smoother, but is a backend, has cost, and breaks the "nothing leaves your browser" promise). Recommendation: BYO key first.
- Retrieval first, model second: deterministic answers ("what's due Friday?") come from the data without a model call; the model gets only the retrieved rows. Measure answer correctness on a small hand-written question set and put the number in the README.

## Not scheduled, worth keeping in view

- File archiving (`chrome.downloads`, design already written in `ARCHITECTURE.md` → credential scoping). This is the original "archiver" purpose and the strongest local-first story.
- Options page, shared by slices 3, 4, 6.
- Chrome Web Store listing: screenshots, privacy policy (one paragraph, because the honest answer is short), permission justifications for each host.
- Replace the reconstructed Gradescope fixture with a redacted capture.

## Positioning: Better Canvas overlap (Boss / Gavin decision)

Better Canvas is an existing, widely used Canvas extension; I haven't re-verified its current feature list or user count here, so check before quoting anything. It is a *skin and widgets* extension: themes, dark mode, a to-do/assignment sidebar and a grade calculator inside Canvas pages.

What this project does that it does not (by design, to confirm):

1. **Cross-system:** Canvas + Gradescope + Ed in one dated view. For Cornell courses that live partly outside Canvas this is the real gap.
2. **Not a page modifier:** it reads data and presents its own UI, so Canvas redesigns don't break it the same way.
3. **Local data you own:** the dataset (and later the archive) is yours, exportable, and feeds other tools (slice 3).

Options, none decided:

- **Stay a portfolio piece.** Cheapest; the engineering write-up (auth spike with measurements, MV3 constraints, read-only-by-construction) is the asset. Recommended default.
- **Free on the Chrome Web Store, Cornell-first.** Cornell-specific hosts are an advantage inside one campus and a limit outside it. Gives real users and a number for the resume. Costs: support, and a one-time $5 developer fee (money: Gavin's call).
- **Partner or sell to Better Canvas.** Their audience already exists. A cross-system data layer is the thing they lack, so this is a plausible conversation. Premature before the Gradescope parser is proven on a real account and before there is any usage number; revisit after slice 3.
- **Paid.** Students rarely pay for study tools; the plausible revenue is institutional (not pursued) or a paid tier on the chatbot (slice 6) if hosted. Not a near-term money path. For money, Embedded Intent work is closer to cash.

Recommendation: ship slices 1–3, list it free on the Web Store, use real usage as the evidence before talking to anyone.

## T-30: weekly schedule (PR `products/v2-schedule`, base v2-chat)
Built: Week schedule page (Mon-Sun grid, 7am-11pm, classes + deadlines at Eastern time, all-day strip, unconfirmed dates in amber); paste-in importer for the schedule.md table; `schedule.json` pushed by the same opt-in sync as `due.json` (`docs/SCHEDULE_JSON.md`). 228 tests, compile and build green.
Not verified: nothing run in a real Chrome or against gavin-data; no screenshot captured (the page needs the extension runtime); sync still needs Chrome open.
Not done: habits (classes only), per-week exceptions/holidays, editing a meeting in place (remove and re-add).
HQ side: Secretary reading `schedule.json` is HQ's change; suggest a pointer next to "Where due dates live" in knowledge/schedule.md (not edited by me).

## T-448: v2.1 slice, Gradescope file content (PR `products/v2-1-gradescope-files`, base store-readiness)
Built: the Files page now also lists each current-term Gradescope course's assignments, reads each assignment page and saves attached handout/assignment PDFs into the same archive: `Cornell/<course>/Gradescope/` (archive layout) or `<slug>/files/` (ingest). Matched to the Canvas course by department+number; no unique match gets its own folder (negative id, own manifest). Incremental by asking the host, not by trusting the URL (Anvil T-449 P2): a saved file is re-requested with If-None-Match / If-Modified-Since from the stored ETag or Last-Modified (304 = skipped); with no validator it is re-fetched and kept as unchanged only when the SHA matches. The Canvas plan is published first and on its own; the Gradescope listing runs after, with a 15s per-request timeout and a 60s budget (aborted, and the wait also ends if an abort is ignored), and a late listing never replaces a plan once a run has started. GET only, `credentials: "include"` only after an origin check against www.gradescope.com, same host permission as before. Any Gradescope failure (signed out, markup change, one bad page) becomes a notice on the Files page; the Canvas plan is built first and is never touched. The Downloads fallback refuses these items (it cannot carry the session). Tests: 28 new on the parser, matching, listing, failure isolation, planning, manifest decision and a two-run save/skip; 264 total, compile and build green.
Not verified (needs Gavin's real-account run, I-16): that real assignment pages link handouts the way the reconstructed fixture does (anchor to `.pdf` or `/download` under the assignment or `/attachments/`); that the PDF request, which may redirect to a signed storage URL, is readable from the extension page (a CORS block would show as "blocked" per item); that Gradescope (or its storage redirect) sends ETag/Last-Modified and honours conditional requests (if not, every run re-downloads the handouts and compares hashes: correct, just slower); that the student's own submission is rightly excluded; the Gradescope-to-Canvas course match on real course names.
Not done: PDFs in course chat, habits on the schedule, Ed API (remaining v2.1 gaps); Gradescope files in the background feed run (Files page only); the student's own submissions and graded copies.

## T-500: feed folder moved to a Windows folder (PR `products/v2-6-windows-inbox`, base v2-5-all-exams)
Built: `docs/SETUP.md` (feed folder `C:\Users\gavin\hq-course-inbox`, Ed note, due.json stays OFF until its own token card), one hint line on the options page, notes in README and DUE_JSON.md. HQ's nightly job reads `/mnt/c/Users/gavin/hq-course-inbox` (hq-ingest change is Builder's). Code change: that one options-page string only.

## T-501 / T-503: no-key Find mode and course browser (PRs `products/v2-7-find-mode`, `products/v2-8-course-browser`)

- Course chat without an AI key now returns the best matching passages with citations and bolded dates ("Find (no AI)"); the BYO-key AI mode is unchanged and optional.
- Course browser (`browse.html`, popup button "Browse a class's files…"): click a class, folders and files with size and date, tick, "Download ticked". It plans with the archive layout and runs the incremental engine on the ticked subset, so saved-and-unchanged files are skipped and marked "saved". Ticks are remembered per course.
- Next: Gradescope handouts in the browser tree, a search box over file names, and a "tick everything new" shortcut.

## T-508: attachments saved beside their pages (PR `products/v2-9-attachments`, base v2-8-course-browser)

Gap: the archive saved assignment, syllabus and announcement pages as HTML stubs that named their files (Homework7-1.pdf) but downloaded none; the archive on disk had no Modules or Course files folder at all, so the Files list and module files were coming back empty too.
- Every file a page, assignment, announcement, discussion (new) or the syllabus links (`/files/<id>` in an `<a>` href or data-api-endpoint) or lists in its API `attachments` is now a planned download, saved in the page's own folder under the name the instructor gave it (display name, not Canvas's `+` filename), tracked in the manifest by `canvas:file/<id>` like any file (skipped while modified time is unchanged), and the saved page's link is rewritten to the relative path (the Canvas address stays in `data-canvas-href`).
- A file in a module stays in the module (pages link across, `../01 Week 1/x.pdf`); a file named by several pages is saved once, beside the first.
- Files the Files list did not return (Files tab hidden from students) but a module or page names are now fetched by id (`/courses/<c>/files/<id>`, then `/files/<id>`); ones Canvas refuses are counted as skipped "unavailable" and their link is left as the Canvas address.
- Attachments are plan items, so the course browser (#20) lists them next to their page, tickable.
- Request cost: one extra paged list per course (`discussion_topics`) plus one GET per distinct linked file not already in the Files list. Embedded images (`<img>`) are not downloaded. Same host, GET only, no new permission.
- The nightly feed uses the same planner, so it now carries attachments too (ingest layout: same `files/` or `_syllabus/` folder as the page).

## T-510: blocked file saves (PR `products/v2-10-blocked-files`, base v2-9-attachments)

Gap: Gavin's CS3700 and HIST archive failed 72 of 152 saves with "blocked: the file host did not allow the browser to read this file", plus one 502. A folder download reads the file in the page, so a file host that redirects to a CDN without CORS headers (or refuses the unsigned request) throws a bare TypeError.
- New `src/files/transfer.ts`: each Canvas file is tried in order: direct read without credentials; the same URL with the Canvas session, only if the address is on the Canvas origin; then the browser's own downloader (`chrome.downloads`), which is not subject to CORS. 429/502/503/504 are retried up to 4 times with jittered backoff before moving to the next route.
- The method used (`fetch`, `fetch-session`, `downloads`) is recorded per file in the manifest. Nothing is skipped silently: a file no route can fetch fails with a message that starts "blocked:" or names the Canvas status, never the signed URL.
- Limit, stated plainly: the browser cannot write into a folder chosen with the folder picker. Files that needed the fallback land in `Downloads/Cornell/<course>/...` (same relative path), are counted in the result message, and are not re-checked against the chosen folder (the manifest says `downloads`). Move them over if you want them together.
- The nightly feed / ingest layout has no fallback on purpose: its files must land in the inbox, so a blocked file there still fails visibly.
- Cause is inferred from the error text and the earlier T-461 notes; it was not reproduced against Gavin's live account.
- Re-run for acceptance: reload the unpacked build, open the Files page, select CS3700 only, pick the same Cornell folder, run the archive again. Already-saved files are skipped; the 39 are expected to finish with 0 failed.

### T-522: review fixes on T-510 (Anvil T-511, two P2s)
- The downloader uses `conflictAction: "uniquify"`, never overwrites, and returns where the file really landed (`Cornell/<course>/x (1).pdf`).
- A file saved that way is recorded `method: "downloads"` with `savedTo` and reported as "saved to Downloads, not in the archive folder"; the next run does not re-download it (no "(1)" pile) but reports it as in Downloads, never as present in the folder. Files and Browse list these and Browse marks them "in Downloads, not the archive folder".
- `chrome.downloads.erase` removes the history record (which holds the signed address) on success and on failure; every error text is scrubbed of addresses and query strings. Regressions use a `verifier=SECRET` rejection.

## T-512: exam dates from syllabus files, one Ed notice (PR `products/v2-11-syllabus-exams`, base v2-10-blocked-files)

- `src/dates/syllabus-files.ts` + `syllabus-reader.ts`: once per sync, for each current-term course, the files its syllabus page links plus Files named "syllabus" are read (PDF text through `unpdf`, a worker-free build of pdf.js, bundled; plain text/HTML too), their exam/prelim/final dates go into `snapshot.exams` as unconfirmed "syllabus" tasks linked to the file. A file is read again only when its Canvas modified time changes (candidates cached in `chrome.storage.local`). A file that cannot be read (file host refuses a direct read, scanned PDF) adds nothing; nothing is invented, "Final exam: to be announced" stays dateless.
- `extract.ts` now joins a short exam label with a date on the next line (how PDF text lays out a schedule).
- Ed: a sign-in problem still stops at once with one notice; any other failure skips only that course and the sync shows a single "Ed Discussion data is missing for X, Y" notice instead of losing every course.
- Limit: bytes are read in the background worker, so a syllabus PDF behind a file host that refuses direct reads (the T-510 cases) is not parsed there; the manual per-course exam-dates field (T-519) covers those.
- Cost: pdf.js is inlined in `background.js` (1.66 MB, a service worker cannot lazy-load a chunk); unpacked build 2.1 MB.

## T-519: manual exam dates per course (PR `products/v2-12-manual-exams`, base v2-11-syllabus-exams)

Research T-513 found no source the extension may read for some exams: the registrar schedule is behind NetID, Piazza forbids scraping, CMSX has no API. So Settings has an "Exam dates" list per current-term course: date (YYYY-MM-DD), optional time (Eastern, 24 hour), label, several entries.
- Stored in `chrome.storage.local` (`settings.manual-exams.v1`); `src/dates/manual-exams.ts` validates (a date that does not exist is rejected, entries kept in date order, repeats ignored).
- Becomes exam tasks with source `manual`, badge "Entered by you", never unconfirmed. The background sync adds them to `snapshot.exams`; the Upcoming page also merges them live, so an edit shows at once.
- An entered exam wins over a parsed twin on the same day (priority above Canvas). Exported in due.json as `source: "manual"`.
- No new permissions, no network. Not done: importing from the registrar tab (a question for Gavin in the Monday brief).

## T-525: Gradescope handouts in the course browser, embedded Canvas images beside their pages (PR `products/v2-13-handouts-images`, base v2-12-manual-exams)

- Browser (#20): opening a class loads its Canvas tree first, then reads only the matching Gradescope class (name/code match, never a guess) and adds its handouts under a `Gradescope` folder. Same ticks, same download run, same manifest; a handout with a record at its path shows as saved and the run still asks the host before skipping it. A hang or failure never holds up the Canvas files.
- Images: an `<img>` whose address is relative or on the Canvas origin (`/courses/N/files/ID/preview`) is treated like a linked attachment: fetched by file id through the Canvas API, saved beside its page, the saved page's `src` pointed at it (original kept in `data-canvas-src`). Other hosts are ignored and never fetched; a file Canvas will not hand over is listed as skipped and the picture stays as it was. Applies to the archive, browser and nightly feed alike (shared plan).
- Not done (separate): the feed default; verifying the Gradescope markup against a live account.

## T-535: extension errors, popup anywhere, honest Done line (PR `products/v2-14-popup-errors`, base v2-13-handouts-images)

- **Errors reproduced, not guessed.** Loaded the built extension in Chromium (Playwright, fresh profile, consent seeded) and opened the service worker and every page. Signed out of Gradescope and Ed, every sync logged `console.warn` lines such as `refresh failed SessionExpiredError: You're not signed in to Canvas…` and `gradescope refresh failed GradescopeSessionExpiredError…` (7 times in one minute from the worker alone); chrome://extensions lists those. They describe a state the popup already reports. Now an expected signed-out service logs at `debug`; any other failure still warns. Same run after the fix: 0 warnings or errors on all seven pages. With a mocked signed-in Canvas there were none to begin with. Not verified: Gavin's own profile.
- **Popup opens anywhere.** The code never blocked it (the popup page loads on any tab); what was missing was a way to see where syncing starts. When the active tab is not Canvas, the popup shows "Open canvas.cornell.edu to sync" with an Open Canvas button; the rest works from the stored snapshot. No new permission: the Canvas host permission already lets the extension read a Canvas tab's address.
- **Done line.** "N new (31 attachments, 9 images, …), M unchanged skipped, K failed", from a `role` on each planned item (file, page, attachment, image, handout).
