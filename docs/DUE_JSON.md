# due.json: the deadline feed for HQ

Written by the Canvas Archiver extension to the GitHub repo the person chooses in Settings (default `GavinR-7/gavin-data`, path `due.json`). Opt-in; off by default. The schedule is rebuilt about every 2 hours while Chrome is open (`chrome.alarms`), and a write only happens when the list of items changed, so it does not fill git history.

```json
{
  "version": 1,
  "generatedAt": "2026-10-15T14:00:00.000Z",
  "timezone": "America/New_York",
  "items": [
    {
      "id": "gradescope:5512",
      "source": "canvas | gradescope | ed | syllabus",
      "course": "CS 3700",
      "title": "Prelim 1",
      "kind": "assignment | quiz | discussion | exam",
      "dueAt": "2026-10-14T23:30:00Z",
      "dueDay": "2026-10-14",
      "allDay": false,
      "url": "https://…",
      "done": false,
      "unconfirmed": true
    }
  ]
}
```

- Window: from 7 days ago (so overdue work can be flagged) to 60 days ahead, inclusive at both ends. These are rolling 24-hour days measured from the refresh clock, including across DST. Canvas, Gradescope, syllabus and Ed reads use this same window; Upcoming separately displays only the next 14 days.
- Timestamps are exported as canonical UTC ISO strings with milliseconds. Sorted by `dueAt`, then `id`; equivalent offsets serialize identically.
- `done`: submitted, graded or excused. List as done, not as a deadline.
- `unconfirmed`: read out of prose (syllabus, Ed announcement), not a Canvas/Gradescope date. A plan should say "per the syllabus".
- `allDay` with no stated time means `dueAt` is 11:59 PM Eastern that day.
- `dueDay` is the Eastern calendar day, so a reader never converts UTC.
- Duplicates across sources are already merged (priority Canvas > Gradescope > Ed > syllabus).
- Contains no grades, scores, files or course content.
- A successful empty refresh writes `items: []`, clearing removed/out-of-window deadlines instead of leaving an old file forever. Every replacement (empty or nonempty) requires affirmative completeness from the current Canvas planner, Gradescope, syllabus and Ed reads. Null error flags and legacy caches without this evidence cannot authorize replacement.
- Planner 403/404 responses report incomplete reads and preserve cached Canvas deadlines. Per-course syllabus failures (including 403/404, restricted courses and missing response fields) report incomplete reads and retain that course's cached dates, while readable courses still refresh locally. Any failed or unverified source prevents the whole-list GitHub write and Settings reports the reason. This preserves remote-only deadlines too; copying only a nonempty partial cache could otherwise erase them.
- Ed requires recognized course and thread arrays with readable required rows; HTTP 200 error envelopes, missing collections and malformed relevant rows are incomplete, not empty. Gradescope requires a recognized course list and student assignment table; unknown layouts and unreadable rows/dates are incomplete. Explicit empty Ed arrays and empty Gradescope lists/tables remain valid. The permissive normalizers are not completeness evidence.
- Canvas collection responses must be arrays or recognized items-array envelopes, with recognizable course/planner rows; error envelopes are refused. Syllabus responses require the explicit syllabus field.
- Local healthy sources still refresh during an outage. GitHub replacement resumes after all required readers succeed. `generatedAt` is the export time, not a per-source freshness timestamp. Completeness evidence stays in the local snapshot; the public due.json version-1 shape is unchanged.
- Idempotence ignores `generatedAt`, but compares the version, timezone and normalized item list.

Token: fine-grained, one repository, Contents read and write. Stored in the extension's local storage only.

## Sync reliability

Alarm and manual runs share one in-flight refresh and upload in each worker
lifetime. Each GitHub request (including reading its response) has a 15-second
deadline and aborts on timeout; a stalled request cannot hold the next run
indefinitely. No token-bearing request follows a redirect. A stale SHA is
re-read and retried once; identical content after a competing write is skipped.
A malformed file response is refused without a write. Settings rejects empty
path segments and the reserved schedule.json name, so the two exports cannot
overwrite each other.

The deadline and class files are separate commits, not an atomic pair. If
due.json succeeds but schedule.json fails, Settings shows the run as failed and
says which file was not sent. The next run compares both files again. A worker
restart loses only the in-flight promise: remote content and SHAs determine
whether another write is necessary.
