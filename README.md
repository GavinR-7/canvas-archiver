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

> **Status: Phase 1 of 5.** `list-courses` works end to end. `sync` and
> `status` are scaffolded but not yet implemented. See
> [Build phases](#build-phases).

---

## Setup

Requires **Python 3.11+** and [uv](https://docs.astral.sh/uv/).

```bash
git clone <your-repo-url> canvas-archiver
cd canvas-archiver
uv sync --extra dev
```

### Get a Canvas access token

1. Open your Canvas instance (e.g. `https://canvas.cornell.edu`).
2. Click your profile picture → **Account** → **Settings**.
3. Scroll to **Approved Integrations** → **+ New Access Token**.
4. Name it something like `canvas-archiver`. Leave the expiry blank, or set it
   to the end of the semester.
5. **Copy the token immediately — Canvas shows it exactly once.**

### Configure

```bash
cp .env.example .env
```

Then edit `.env` and paste the token in:

| Variable                  | Default                      | Purpose                                              |
| ------------------------- | ---------------------------- | ---------------------------------------------------- |
| `CANVAS_API_URL`          | `https://canvas.cornell.edu` | Base URL of your Canvas instance.                    |
| `CANVAS_API_TOKEN`        | *(required)*                 | Your personal access token.                          |
| `ARCHIVE_ROOT`            | `~/canvas-archive`           | Where the archive is written. Outside the repo.       |
| `CANVAS_DOWNLOAD_WORKERS` | `4`                          | Concurrent file downloads.                           |

`.env` is git-ignored from the first commit. The token is never printed, never
logged, and never included in an error message — only a fingerprint like
`1234~...aB9x` is ever displayed, so you can tell two tokens apart without
either being recoverable from a log or a screenshot.

The archive directory lives **outside** the repo by design, and
`canvas-archive/` is git-ignored too in case you point `ARCHIVE_ROOT` inside it
anyway.

---

## Usage

```bash
# Smoke test: does your token work?
uv run canvas-archive list-courses

# Include terms that have already ended
uv run canvas-archive list-courses --include-past

# Just one term
uv run canvas-archive list-courses --term FA25
```

Once installed into a venv on your `PATH`, drop the `uv run` prefix.

### Commands

| Command                            | What it does                                                        |
| ---------------------------------- | ------------------------------------------------------------------- |
| `list-courses`                     | Table of every course your token can see: id, code, name, term, state. |
| `sync`                             | Download new and changed content. *(Phase 2+)*                      |
| `status`                           | Summarise the local archive offline. *(Phase 4)*                    |

`sync` flags (Phase 2+): `--term FA25`, `--course <id>` (repeatable),
`--include-past`, `--full`, `--dry-run`.

Every command takes `--verbose` for debug output and `--env-file` to point at a
`.env` somewhere other than the working directory. `--help` works everywhere.

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

*Written in Phase 4.* The contract: each course gets a `manifest.json` with a
`schema_version` and one entry per archived item, recording `canvas_id`, `type`,
`title`, `canvas_url`, `local_path`, `content_type`, `size`, Canvas
`updated_at`, `sha256`, and module context. A top-level `archive_index.json`
lists all courses, terms and last-sync times. This document will carry the full
field-by-field schema once it is implemented.

---

## Development

```bash
uv run pytest            # run the tests
uv run pytest -v         # verbose
```

Tests cover the pure logic — term parsing, filename sanitization, path
construction, manifest diffing, Markdown conversion edge cases — plus a handful
of mocked tests over the API translation layer. Network code is deliberately not
chased for coverage.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module-by-module design, the
decisions behind it, and which Canvas REST endpoints each collector actually
hits.

---

## Build phases

| Phase | Scope                                                                        | Status |
| ----- | ---------------------------------------------------------------------------- | ------ |
| 1     | Scaffold, config/auth, `list-courses` end to end                             | ✅     |
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
