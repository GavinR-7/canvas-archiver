# hq-ingest

The nightly step that drains the extension's inbox into `knowledge/courses/<course>/`, following the "Ingest contract" in `knowledge/courses/README.md`. Plain Node, no dependencies, no AI.

```
node tools/hq-ingest/ingest.mjs [--inbox DIR] [--root DIR] [--dry-run]
```

Defaults: root `~/gavin-data/knowledge/courses`, inbox `<root>/_inbox`. Output is one line per course (`ece3030: 4 new, 1 changed, 0 failed`); exit code 1 if anything failed. Tests: `node --test tools/hq-ingest`.

## What it does

For each `_batches/*.json` (oldest first), for each listed file: check the SHA-256, then look up `source` in `<course>/ledger.json`.
- Not in the ledger → copy to `modules/<NN-slug>/`, `syllabus/` or `files/`, write `text/<path>.txt`, add an `index.md` block, add to the ledger.
- In the ledger with a different hash → keep the old file as `<name>.v<N>`, ingest the new one, mark the block `updated:`.
- Same hash → skip. Safe to run twice.

A batch is deleted only when every file in it landed; a failed file and its batch stay for the next night. Files in the inbox that no batch lists are reported and left alone. Unknown course folders (no `knowledge/courses/<course>/`) and any path with `..` are refused, never created. `course.json`'s `canvasId` is filled from the batch's `courses` map the first time.

## What it does not do (yet)

- **`covers:` lines.** New blocks get `covers: (pending)`. The Haiku pass that writes them is separate; it should pick up blocks with `(pending)`. Files it cannot extract get `(not extracted)` plus `needs-ocr` or `needs-review`.
- **Text extraction** covers HTML, Markdown, plain text, and PDF via `pdftotext` (poppler-utils; **not installed on this machine** at the time of writing, so PDFs are indexed `needs-review` until it is). Slides (`.pptx`) and video get `needs-review`.
- `index.md` `## Topics` block and the `manifest.json` entry for each course index are not touched.

## Install

Agents cannot edit `hq/tools/`; copy or symlink `ingest.mjs` there, then schedule it, e.g. a user cron line:

```
30 2 * * * node /home/gavin/gavin-data/hq/tools/ingest.mjs >> /home/gavin/gavin-data/hq/logs/ingest.log 2>&1
```

Run it after the extension's nightly feed (default 02:00 local, Chrome must be open).
