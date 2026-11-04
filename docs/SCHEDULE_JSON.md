# schedule.json

Written by the extension next to `due.json` (same repo, same folder, same token) whenever deadline sync is on and at least one class has been entered. Skipped when nothing changed.

```json
{
  "version": 1,
  "generatedAt": "2026-10-15T14:00:00.000Z",
  "timezone": "America/New_York",
  "classes": [
    { "id": "ece-3030-lecture-mon-wed-fri-1010", "course": "ECE 3030", "title": "Lecture (EM Fields & Waves)",
      "days": ["mon", "wed", "fri"], "start": "10:10", "end": "11:00", "location": "Hollister Hall B14" }
  ]
}
```

- `days`: `mon`..`sun`. `start`/`end`: 24-hour `HH:MM`, wall-clock in `timezone`.
- Weekly recurring meetings only. Holidays and exceptions are not modelled.
- Classes are never invented: they come from the table pasted into the Week schedule page (the `Course | Days | Time | Location` table in `knowledge/schedule.md` works as-is). Rows that cannot be read are reported and left out.
- Habits are not in this file; only classes. Deadlines stay in `due.json`.
- Order is stable and `generatedAt` is ignored when deciding whether to push, so an unchanged schedule makes no commit.
