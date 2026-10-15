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

Built: opt-in nightly feed (Settings → inbox folder + switch; alarm opens `files.html?auto=feed`, which runs the ingest layout into the inbox and closes), course folders normalised to the contract name (`ECE 3030 FA26` → `ece3030`), and `tools/hq-ingest/`, the no-AI ingest script (tested). **Unverified:** Chrome accepting a `\\wsl.localhost` folder, folder permission surviving a browser restart, `pdftotext` not installed here, the whole chain on a real course.

## T-28 status (branch `products/v2-ai-pick`)

Built: "Get everything for…" on the Files page. `src/ai/pick.ts` is pure rules (exam named in folder/file, other-numbered exams excluded, "weeks 3-6", syllabus "Prelim 2 covers lectures 10-18"), each pick with its reason; `src/ai/model.ts` is the opt-in fallback with the user's own key (names only, reply cut to ids we sent). **Unverified:** a real request on a real account; syllabus phrasing varies, so coverage detection is best-effort; the model call has never been made (no key here).

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
