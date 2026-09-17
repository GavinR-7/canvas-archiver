# Canvas Archiver — Prompt for Claude Code

**How to use this file:**

1. **Get your Canvas API token (2 min, do this first):** go to `canvas.cornell.edu` → click your profile picture → **Account → Settings** → scroll to **Approved Integrations** → **+ New Access Token**. Give it a name like "canvas-archiver", leave expiry blank (or set end of semester), and **copy the token immediately — Canvas only shows it once.** Park it somewhere safe for now (you'll put it in a `.env`, never in chat and never in the repo).
2. In your WSL terminal: `mkdir ~/canvas-archiver && cd ~/canvas-archiver`, then launch Claude Code.
3. Paste everything **below the divider** as your first message.
4. First full sync of several courses can take a while. That's normal — the tool is designed so you can interrupt it and re-run safely.

---

## Context

You are building a complete, production-quality CLI tool for me. I'm an ECE student at Cornell; my school uses Canvas (`https://canvas.cornell.edu`). I want a local, perfectly organized archive of every course I'm enrolled in — every file, module, page, assignment, and announcement — that I can re-run any time to stay in sync.

This is not a throwaway script. It will later become the **ingestion layer for a RAG-based course tutor**, so clean folder structure and machine-readable metadata matter as much as the downloads themselves. It's also a personal archive of material I already have access to: it stays local, and the archive directory never goes in git.

My environment: WSL Ubuntu, Python managed with **uv**, Git for version control, will be pushed to GitHub. Build it as a real project: proper package structure, README, tests.

## Non-negotiable architecture decisions

1. **Official Canvas REST API with a personal access token.** No browser automation, no scraping, no ever touching my Cornell password. The token is read-only in practice — this tool never writes anything to Canvas.
2. Use the **`canvasapi`** Python library for API access (it handles auth and pagination). But as you build, briefly explain the actual REST endpoints it's wrapping in ARCHITECTURE.md — I want to understand what's happening under the hood, not just that it works.
3. Config via environment variables loaded from `.env` (python-dotenv): `CANVAS_API_URL` (default `https://canvas.cornell.edu`), `CANVAS_API_TOKEN`, `ARCHIVE_ROOT` (default `~/canvas-archive` — deliberately **outside** the repo). Ship a `.env.example`; add `.env` to `.gitignore` in the very first commit. Never print or log the token.
4. Stack: Python 3.11+, uv-managed. `typer` for the CLI, `rich` for progress bars and tables, `requests` or `httpx` for raw file downloads, `markdownify` (or `html2text`) for HTML→Markdown conversion, `pytest` for tests. **Ask me before adding any dependency beyond these.**

## What "everything" means — content to archive per course

Default scope: all courses with an active enrollment; provide flags to include past terms. For each course:

1. **Files** — every file, preserving Canvas's own folder hierarchy. Important: the Files tab is disabled for students in some courses, so implement layered fallbacks: (a) the Files API when available, (b) walking every module item of type `File`, (c) collecting file attachments embedded in pages, assignments, and announcements. De-duplicate by Canvas file ID.
2. **Modules** — the full module structure and ordering, saved as a human-readable `_modules.md` (with each item linked to its local file where one exists) and captured in the manifest.
3. **Pages** — every wiki page converted to Markdown, preserving links; download images/files embedded in page bodies.
4. **Assignments** — one Markdown file each: description, due date, points, submission types, and rubric if present; download attached files.
5. **Announcements** — Markdown, dated, sorted newest-first, in `_announcements/`.
6. **Discussions** — topic plus entries flattened to readable Markdown. Best-effort only; don't over-engineer threaded reply trees.
7. **Syllabus** — the syllabus body as `_syllabus.md` when present.
8. **Quizzes** — metadata only (title, due date, points, question count). Question content usually isn't accessible via the API; don't fight it.
9. **External links** — module items that are URLs or external tools go into `_links.md`. For embedded video platforms (Panopto, Kaltura, YouTube), capture the link and title; do **not** attempt video downloads in v1.

## Folder layout

```
~/canvas-archive/
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
      files/               ← mirrors Canvas's folder structure
        lectures/
        problem-sets/
```

Sanitize every name for the filesystem: strip illegal characters, trailing dots/spaces, enforce a length cap; resolve collisions by appending the Canvas ID. Derive short term names (FA25, SP26) from Canvas term data.

## The manifest — design this carefully

Per-course `manifest.json`: an entry for **every** archived item with `canvas_id`, `type`, `title`, `canvas_url`, `local_path`, `content_type`, `size`, Canvas `updated_at`, `sha256`, and module context (which module, position). Plus a top-level `archive_index.json` listing all courses, terms, and last-sync times.

This schema is the contract the future RAG tutor will ingest, so keep it stable, versioned (`schema_version` field), and documented in the README.

## Incremental sync — the tool must be re-runnable

- First run: full download. Every later run: only new or changed items, by comparing Canvas `updated_at` and size against the manifest, verifying with checksum when in doubt.
- `--full` forces a complete re-download. `--dry-run` prints exactly what would change without downloading anything.
- End every run with a rich summary table (new / updated / skipped / failed, per course) and append a dated "what's new since last sync" section to each course's `_changelog.md`.
- Safe to interrupt: download to a temp filename and rename on completion so a killed run never leaves corrupt or half-written files, and the next run picks up where it left off.

## Robustness requirements

- Handle pagination everywhere (canvasapi does this for you, but confirm for any raw HTTP calls).
- Respect rate limits: watch the `X-Rate-Limit-Remaining` header, exponential backoff on rate-limit 403s and 5xx errors.
- Modest, configurable download concurrency (ThreadPoolExecutor, default ~4 workers).
- Expect and gracefully skip: unpublished or restricted courses, locked files, 403s on disabled tabs. Log a warning and keep going — one broken course must never kill the whole run.
- Errors and skips go to both the console and a log file (`archive.log` inside the archive root).

## CLI

`canvas-archive` with subcommands:

- `sync` — the main event. Flags: `--term FA25`, `--course <id>`, `--include-past`, `--full`, `--dry-run`.
- `list-courses` — a table of every course visible to my token: id, code, name, term, state. (This is also our Phase 1 smoke test.)
- `status` — read the local archive and summarize contents and last-sync times without touching the network.

Good `--help` text on everything.

## Code quality bar

- Clean module layout — roughly: API client wrapper / content collectors (one per content type) / writers (markdown, files) / manifest / sync engine / CLI. Type hints throughout, docstrings on public functions.
- `pytest` tests for the pure logic: filename sanitization, path construction, manifest diffing, markdown conversion edge cases. Don't chase coverage on network code; a couple of mocked tests there is plenty.
- `README.md`: what it does, setup (uv, how to generate a Canvas token), usage examples, the folder layout, and the manifest schema.
- `ARCHITECTURE.md`: as you build, record every significant decision and a one-paragraph explanation of each module — including which Canvas REST endpoints each collector actually hits. I should be able to read this file and understand the entire system.
- Clean, conventional commits at the end of each phase.

## Build in phases — stop after each one

Work in phases. At the end of each phase: summarize what you built, why you built it that way, and what I should look at — then **wait for me** before continuing.

- **Phase 1:** project scaffold, config/auth loading, `list-courses` working end-to-end against my real account.
- **Phase 2:** complete file download for a single course — folder mirroring, sanitization, collision handling, the module-item and embedded-attachment fallbacks.
- **Phase 3:** all remaining content types (modules, pages, assignments, announcements, discussions, syllabus, links) plus the auto-generated per-course README.
- **Phase 4:** manifest, incremental sync, `_changelog.md`, `status` command.
- **Phase 5:** robustness pass (rate limiting, retries, interrupt-safety), tests, README and ARCHITECTURE polish.

Before starting Phase 1: restate your understanding of the project, flag anything you'd do differently, and ask me any questions you have.

## Explicitly out of scope for v1 (list these as future ideas in the README)

- Downloading videos from streaming platforms
- Any AI features (summaries, search, Q&A) — that's the next project, which will consume this archive
- A GUI or web interface
- Writing anything to Canvas — this tool is read-only, forever