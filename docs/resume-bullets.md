# Resume bullets: Canvas Archiver

Every number below was produced by the command beside it, run on
`87359c1` (head of `codex/canvas-v2-rc`, PR #27) on 2026-11-13. Re-run the
commands before you put a number on a resume; they will drift as the branch moves.

## The bullets

**Canvas Archiver | Chrome extension (TypeScript, React, WXT, Manifest V3)** | Cornell, 2026

- Built a local-first Chrome extension that works around Cornell Canvas's lack of
  student API tokens by reusing the signed-in browser session, with a read-only
  GET-only client and no backend, account or telemetry; shipped as 81 commits
  and 28 pull requests.
- Merged due dates from Canvas, Gradescope and Ed Discussion into one deduplicated
  list, and built an incremental course-file archiver (File System Access API,
  per-course manifests) that re-downloads only changed files; both fail per
  source so one outage never blanks the rest.
- Hardened the extension against credential leakage (exact-origin checks on
  server-supplied URLs, cookie-less-first file downloads, redirect-capped image fetches,
  no network from the popup off Canvas) and covered it with 494 automated tests
  across 38 files, plus type checking and a clean production build.

## Where each number comes from

| Number | Command (run from the repo root unless noted) | Result |
| --- | --- | --- |
| 81 commits | `git rev-list --count origin/codex/canvas-v2-rc` | 81 |
| 28 pull requests | `gh pr list --state all --limit 200 --json number \| python3 -c "import json,sys;print(len(json.load(sys.stdin)))"` | 28 (12 merged, 16 open) |
| 494 tests, 38 files | `cd extension && npm test` | `Test Files 38 passed (38)`, `Tests 494 passed (494)` |
| Type check | `cd extension && npm run compile` | exits 0, no output |
| Production build | `cd extension && npm run build` | built, `Σ Total size: 2.06 MB` |

Notes on honesty:

- The PR count includes 16 still-open PRs in the stacked series that PR #27
  combines. If you want only merged work, say "12 merged".
- The test count is the extension's Vitest suite. The frozen Python CLI has its
  own tests and is not counted.
- Commit count is the whole repo history including the CLI, not extension-only.
- Do not claim users, installs or accuracy. None exist yet, and the Gradescope,
  Ed and chat paths are not confirmed on a live account (see the README's
  Limits). Add a measured number (for example files archived, or the AI picker's
  hit rate on the 15-request test in `docs/V2_SPEC.md`) only after you run it.
