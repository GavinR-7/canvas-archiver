"""Logging setup: rich console output plus a persistent file log.

Every run writes to two places. The console gets human-facing progress via
:class:`rich.logging.RichHandler`; ``<archive_root>/archive.log`` gets a
timestamped, append-only record of the same events at DEBUG level, so a failure
noticed days later can still be diagnosed.

The module is named ``log`` rather than ``logging`` so it cannot be mistaken for
the standard library module it wraps.
"""

from __future__ import annotations

import logging
from pathlib import Path

from rich.console import Console
from rich.logging import RichHandler
from rich.theme import Theme

#: Shared console. Everything user-facing goes through this object so that
#: colours, width detection and redirection behave consistently.
console = Console(
    theme=Theme(
        {
            "ok": "bold green",
            "warn": "bold yellow",
            "err": "bold red",
            "hint": "dim",
        }
    )
)

LOGGER_NAME = "canvas_archiver"
_FILE_FORMAT = "%(asctime)s %(levelname)-8s %(name)s: %(message)s"


def get_logger(name: str | None = None) -> logging.Logger:
    """Return the package logger, or a named child of it."""
    base = logging.getLogger(LOGGER_NAME)
    return base.getChild(name) if name else base


def setup_logging(
    log_path: Path | None = None,
    *,
    verbose: bool = False,
    quiet: bool = False,
    create_parents: bool = False,
) -> logging.Logger:
    """Configure the package logger for a single CLI invocation.

    Safe to call more than once: existing handlers are removed first, so tests
    and repeated invocations do not accumulate duplicate output.

    Args:
        log_path: Destination for the file log. When ``None``, only console
            logging is configured — used by read-only commands that must not
            bring the archive root into existence as a side effect.
        verbose: Emit DEBUG-level records to the console.
        quiet: Restrict console output to warnings and errors. The file log is
            unaffected and always records DEBUG.
        create_parents: Create ``log_path``'s parent directory if it is absent.
            Only ``sync`` sets this, because only ``sync`` is entitled to create
            the archive root.

    Returns:
        The configured package logger.
    """
    logger = logging.getLogger(LOGGER_NAME)
    logger.setLevel(logging.DEBUG)
    logger.propagate = False
    for handler in list(logger.handlers):
        logger.removeHandler(handler)
        handler.close()

    if verbose:
        console_level = logging.DEBUG
    elif quiet:
        console_level = logging.WARNING
    else:
        console_level = logging.INFO

    rich_handler = RichHandler(
        console=console,
        show_time=False,
        show_path=verbose,
        rich_tracebacks=True,
        markup=False,
    )
    rich_handler.setLevel(console_level)
    logger.addHandler(rich_handler)

    if log_path is not None:
        try:
            if create_parents:
                log_path.parent.mkdir(parents=True, exist_ok=True)
            file_handler = logging.FileHandler(log_path, encoding="utf-8")
            file_handler.setLevel(logging.DEBUG)
            file_handler.setFormatter(logging.Formatter(_FILE_FORMAT))
            logger.addHandler(file_handler)
        except OSError as exc:
            # A missing file log must never stop an archive run.
            logger.warning("Could not open log file %s: %s", log_path, exc)

    return logger
