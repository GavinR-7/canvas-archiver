"""Canvas Archiver — a local, re-runnable archive of Canvas LMS course content.

The archive is structured so that a later retrieval-augmented tutor can ingest it
directly: every archived item is recorded in a versioned, per-course
``manifest.json`` alongside human-readable Markdown.

This package never writes to Canvas. It is read-only, forever.
"""

__version__ = "0.1.0"
