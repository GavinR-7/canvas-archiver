# canvas-archiver

Tools for getting your own Canvas LMS data out of Canvas and onto your own
machine. Local-first: nothing leaves your browser or your disk.

Two parts, in one repo:

| Directory | What it is | Status |
| --- | --- | --- |
| [`extension/`](extension/) | Chrome extension (MV3, TypeScript, React) — the product | In development |
| [`cli/`](cli/) | Python CLI — the reference implementation | **Frozen** |

---

## `extension/` — the product

A Chrome extension that reads your Canvas data using **the browser session you
already have**. No tokens, no passwords, no backend, no analytics. Everything
stays in extension storage on your machine.

Current milestone: a popup showing who you're signed in as and your active
courses, plus a full-page "Upcoming" view of everything due in the next 14 days
across all courses.

See [`extension/ARCHITECTURE.md`](extension/ARCHITECTURE.md) for the design, an
MV3 primer, and the Canvas API knowledge carried over from the CLI.

---

## `cli/` — the reference implementation, frozen

A Python CLI that archives Canvas course content to a local folder tree. It
reached Phase 1 (+ an auth rework) before the project pivoted to an extension:
`login`, `logout`, `list-courses` and `status` work; `sync` was never
implemented.

**It is not being developed further.** It stays in the repo because its 117
tests and its `ARCHITECTURE.md` encode a lot of hard-won Canvas behaviour — the
`Link`-header pagination rules, Canvas's habit of signalling throttling with
`403` rather than `429`, the `calendar_events` type split, user-scoped planner
items, and the structural read-only guarantee. The extension inherits all of
it.

```bash
cd cli
uv sync --extra dev
uv run pytest            # 117 tests
uv run canvas-archive --help
```

See [`cli/README.md`](cli/README.md) and
[`cli/ARCHITECTURE.md`](cli/ARCHITECTURE.md).

---

## Repo layout

```
canvas-archiver/
  extension/           the Chrome extension
    src/types/         Course and Task — the scheduler's contract
    spike/             throwaway MV3 extension answering the auth question
    ARCHITECTURE.md
  cli/                 frozen Python reference implementation
    src/canvas_archiver/
    tests/
    ARCHITECTURE.md
  dev/
    sync-to-windows.sh stage a build where Chrome-on-Windows can load it
```

---

## Out of scope

Deliberately not built, and listed here as future ideas rather than omissions:

- Scheduler logic, and the downloader
- AI features — that's the next project, and it will consume this data
- Accounts, a backend, telemetry of any kind
- Publishing to the Chrome Web Store
- Writing anything to Canvas. Read-only, forever — enforced structurally, not
  promised.

## License

MIT
