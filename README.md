# canvas-archiver

A local, re-runnable archive of every Canvas course you're enrolled in — files,
modules, pages, assignments, announcements, discussions, syllabus, quiz
metadata and external links — laid out in a clean folder tree with
machine-readable metadata alongside it.

Built against the **official Canvas REST API** with a personal access token. No
browser automation, no scraping, and it **never writes anything to Canvas**.

The archive is designed as the ingestion layer for a future retrieval-augmented
course tutor, which is why the per-course `manifest.json` is versioned and
documented rather than incidental.

> **Status: Phase 1 of 5 (+ auth rework).** `login` and `list-courses` work.
> `sync` and `status` are scaffolded but not yet implemented. See
> [Build phases](#build-phases).

---

## Setup

Requires **Python 3.11+** and [uv](https://docs.astral.sh/uv/).

```bash
git clone <your-repo-url> canvas-archiver
cd canvas-archiver
uv sync --extra dev
```

### Choose how to authenticate

Canvas accepts two credentials on the same API. Pick whichever your institution
allows.

#### Option A — browser session (default)

For institutions that don't hand out API tokens. Cornell currently gates them
behind an approval request, which is why this is the default.

```bash
cp .env.example .env          # CANVAS_AUTH_MODE=session is already set
uv run canvas-archive login
```

A visible Chromium opens. Sign in with your NetID and Duo **yourself** — this
tool never sees, fills or stores your password. Once your dashboard loads, the
Canvas session cookies are saved to a private file and the browser closes.

The browser profile persists, so Duo's "remember this device" survives between
logins. When the session eventually expires, any command will stop cleanly and
tell you to run `login` again.

`canvas-archive logout` deletes the local copy. (It does not end the session on
Canvas's side — sign out in your browser for that.)

> **A note on what you're storing.** A session cookie is a *stronger* credential
> than an API token: it's your whole account rather than a scoped key, and it
> can't be revoked on its own. It is stored owner-only (`0600`) outside both the
> repo and the archive, pinned to one Canvas host, and never printed or logged.
> Prefer a token if you can get one. It's also worth a look at your
> institution's policy on automated access.

#### Option B — personal access token

1. Open your Canvas instance (e.g. `https://canvas.cornell.edu`).
2. Click your profile picture → **Account** → **Settings**.
3. Scroll to **Approved Integrations** → **+ New Access Token**.
4. Name it something like `canvas-archiver`. Leave the expiry blank, or set it
   to the end of the semester.
5. **Copy the token immediately — Canvas shows it exactly once.**

Then in `.env`, set `CANVAS_AUTH_MODE=token` and paste the token into
`CANVAS_API_TOKEN`. No `login` step is needed.

### Settings

| Variable                    | Default                      | Purpose                                                    |
| --------------------------- | ---------------------------- | ---------------------------------------------------------- |
| `CANVAS_API_URL`            | `https://canvas.cornell.edu` | Base URL of your Canvas instance.                          |
| `CANVAS_AUTH_MODE`          | `session`                    | `session` (browser login) or `token` (personal access token). |
| `CANVAS_API_TOKEN`          | —                            | Required only when `CANVAS_AUTH_MODE=token`.               |
| `ARCHIVE_ROOT`              | `~/canvas-archive`           | Where the archive is written. Outside the repo.            |
| `CANVAS_DOWNLOAD_WORKERS`   | `4`                          | Concurrent file downloads.                                 |
| `CANVAS_ARCHIVER_STATE_DIR` | `~/.local/share/canvas-archiver` | Where saved cookies and the browser profile live.      |

`.env` is git-ignored from the first commit. Neither credential is ever printed,
logged, or included in an error message — a token shows only as a fingerprint
like `1234~...aB9x`, and a session shows only as *"browser session (7 cookies)"*.

Three directories, deliberately kept apart: the **repo** (code), the **archive**
(`~/canvas-archive`, bulk course material you might back up or index), and the
**credential store** (`~/.local/share/canvas-archiver`). A password-equivalent
should not ride along with a backup.

### Linux system packages

`login` needs a real browser. Playwright downloads Chromium but not the system
libraries it links against:

```bash
uv run playwright install chromium
sudo playwright install-deps chromium
# or, the two packages Ubuntu most often lacks:
sudo apt-get install -y libnss3 libnspr4
```

Under WSL, `echo $DISPLAY` should print something like `:0` — that's WSLg
providing the window. If `login` can't start Chromium, it will tell you which of
these is the problem.

---

## Usage

```bash
# One-time, in session mode
uv run canvas-archive login

# Smoke test: do your credentials work?
uv run canvas-archive list-courses

# Include terms that have already ended
uv run canvas-archive list-courses --include-past

# Just one term
uv run canvas-archive list-courses --term FA25
```

Once installed into a venv on your `PATH`, drop the `uv run` prefix.

### Commands

| Command        | What it does                                                             |
| -------------- | ------------------------------------------------------------------------ |
| `login`        | Sign in via a browser and save the session. Session mode only.           |
| `logout`       | Delete the saved session from this machine.                              |
| `list-courses` | Table of every course you can see: id, code, name, term, state.          |
| `sync`         | Download new and changed content. *(Phase 2+)*                           |
| `status`       | Summarise the local archive offline. *(Phase 4)*                         |

`sync` flags (Phase 2+): `--term FA25`, `--course <id>` (repeatable),
`--include-past`, `--full`, `--dry-run`.

Every command takes `--verbose` for debug output and `--env-file` to point at a
`.env` somewhere other than the working directory. `--help` works everywhere.

Exit codes: `0` success, `1` not yet implemented, `2` configuration error,
`3` Canvas API error, `4` needs `login`.

---

## Folder layout

```
~/canvas-archive/
  archive.log
  archive_index.json
  FA25/
    ECE 3140 - Embedded Systems/
      README.md            ← auto-generated: instructor, item counts, last sync
      manifest.json
      _changelog.md
      _syllabus.md
      _modules.md
      _links.md
      _announcements/
      _assignments/
      _pages/
      _discussions/
      files/               ← mirrors Canvas's own folder structure
        lectures/
        problem-sets/
```

Term codes (`FA25`, `SP26`) are derived from Canvas term data. Canvas is
inconsistent about how it names terms — `"Fall 2025"`, `"2025FA"`, `"FA25"` and
the catch-all `"Default Term"` all show up — so every spelling is collapsed to
one code, falling back to the term's start date and finally to `NOTERM`.

Every path component is sanitized for the filesystem: illegal characters
stripped, trailing dots and spaces removed, a length cap enforced, and
collisions resolved by appending the Canvas ID.

---

## Manifest schema

*Implemented in Phase 4; specified now so the Phase 2–3 collectors capture the
right fields the first time.*

Each course gets a `manifest.json` with a `schema_version` and one entry per
archived item: `canvas_id`, `type`, `title`, `canvas_url`, `local_path`,
`content_type`, `size`, Canvas `updated_at`, `sha256`, and module context. A
top-level `archive_index.json` lists all courses, terms and last-sync times.

Assignments, quizzes and discussions additionally carry a **structured
`schedule` object** — `due_at`, `unlock_at`, `lock_at`, `points_possible`,
`submission_types`, and your own submission state (`workflow_state`,
`submitted_at`, `score`, `late`, `missing`, `excused`). These are real JSON
fields, not prose inside the Markdown, so a scheduler can read them directly.
Each course manifest also gets `calendar_events` and `planner_items` arrays.

All timestamps are stored exactly as Canvas returns them — ISO 8601, UTC — with
no local-time conversion, because the archive outlives any one machine's
timezone setting.

The full field-by-field schema is in
[ARCHITECTURE.md](ARCHITECTURE.md#manifest-schema).

---

## Development

```bash
uv run pytest            # run the tests
uv run pytest -v         # verbose
```

117 tests cover the pure logic — term parsing, `Link`-header parsing, filename
sanitization, path construction, manifest diffing, Markdown conversion edge
cases — plus the transport's response classification and the credential
guarantees (nothing leaks into a `repr`, a log line or an error message; the
cookie file is owner-only; non-Canvas cookies are never stored). The HTTP layer
is tested against `httpx.MockTransport`, so the whole suite runs offline in well
under a second.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module-by-module design, the
decisions behind it, and which Canvas REST endpoints each collector actually
hits.

---

## Build phases

| Phase | Scope                                                                        | Status |
| ----- | ---------------------------------------------------------------------------- | ------ |
| 1     | Scaffold, config/auth, `list-courses` end to end                             | ✅     |
| 1.5   | Session-cookie auth, `login`, own HTTP client, rate limiting                 | ✅     |
| 2     | Full file download for one course: folder mirroring, sanitization, fallbacks | ⬜     |
| 3     | Modules, pages, assignments, announcements, discussions, syllabus, links     | ⬜     |
| 4     | Manifest, incremental sync, `_changelog.md`, `status`                        | ⬜     |
| 5     | Robustness pass, tests, docs polish                                          | ⬜     |

---

## Out of scope for v1

Deliberately not built, and listed here as future ideas rather than omissions:

- **Downloading videos** from Panopto, Kaltura or YouTube. Module items that
  point at them are recorded in `_links.md` with their titles.
- **Any AI features** — summaries, search, Q&A. That's the next project, and it
  will consume this archive rather than reimplement it.
- **A GUI or web interface.** This is a CLI.
- **Writing anything to Canvas.** Read-only, forever. Not a v1 limitation — a
  permanent design decision.

---

## License

MIT
