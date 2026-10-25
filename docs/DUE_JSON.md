# due.json: the deadline feed for HQ

Written by the Canvas Archiver extension to the GitHub repo the person chooses in Settings (default `GavinR-7/gavin-data`, path `due.json`). Opt-in; off by default, and it stays off until the GitHub token step is done (see `docs/SETUP.md`). The schedule is rebuilt about every 2 hours while Chrome is open (`chrome.alarms`), and a write only happens when the list of items changed, so it does not fill git history.

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

- Window: from 7 days ago (so overdue work can be flagged) to 60 days ahead. Sorted by `dueAt`.
- `done`: submitted, graded or excused. List as done, not as a deadline.
- `unconfirmed`: read out of prose (syllabus, Ed announcement), not a Canvas/Gradescope date. A plan should say "per the syllabus".
- `allDay` with no stated time means `dueAt` is 11:59 PM Eastern that day.
- `dueDay` is the Eastern calendar day, so a reader never converts UTC.
- Duplicates across sources are already merged (priority Canvas > Gradescope > Ed > syllabus).
- Contains no grades, scores, files or course content.

Token: fine-grained, one repository, Contents read and write. Stored in the extension's local storage only.
