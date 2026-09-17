"""``canvas-archive`` command-line interface.

Three subcommands:

* ``list-courses`` — show every course the token can see. Network, read-only.
* ``sync``         — download course content into the archive. (Phase 2+.)
* ``status``       — summarise the local archive. Never touches the network.

Every command resolves configuration through
:func:`~canvas_archiver.config.load_config` and reports failures as a short
message plus a non-zero exit code, never a traceback.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Optional

import typer
from rich.table import Table

from . import __version__
from .client import CanvasClient, CanvasClientError
from .config import Config, ConfigError, load_config
from .log import console, get_logger, setup_logging
from .terms import sort_key as term_sort_key

app = typer.Typer(
    name="canvas-archive",
    help=(
        "Archive your Canvas courses to a local, re-runnable, machine-readable "
        "folder tree. Read-only: this tool never writes anything to Canvas."
    ),
    no_args_is_help=True,
    add_completion=False,
)

logger = get_logger("cli")

EXIT_CONFIG_ERROR = 2
EXIT_API_ERROR = 3


def _version_callback(value: bool) -> None:
    if value:
        console.print(f"canvas-archive {__version__}")
        raise typer.Exit()


@app.callback()
def main(
    _version: Annotated[
        bool,
        typer.Option(
            "--version",
            callback=_version_callback,
            is_eager=True,
            help="Show the version and exit.",
        ),
    ] = False,
) -> None:
    """Archive Canvas course content locally."""


def _load(
    *,
    require_token: bool,
    env_file: Path | None,
    verbose: bool,
    quiet: bool = False,
    create_archive_root: bool = False,
) -> Config:
    """Load config and configure logging, exiting cleanly on failure.

    Args:
        require_token: Whether a missing ``CANVAS_API_TOKEN`` is fatal.
        env_file: Explicit ``.env`` path, or ``None`` for auto-discovery.
        verbose: Enable DEBUG console output.
        quiet: Restrict console output to warnings and errors.
        create_archive_root: Create the archive root (and therefore its log
            file) if absent. Read-only commands leave this ``False`` so that
            merely listing courses never materialises an empty archive.
    """
    # Console-only first, so configuration errors are still reported nicely.
    setup_logging(None, verbose=verbose, quiet=quiet)
    try:
        config = load_config(env_file, require_token=require_token)
    except ConfigError as exc:
        console.print(f"[err]Configuration error:[/err] {exc}")
        raise typer.Exit(code=EXIT_CONFIG_ERROR)

    # Attach the file log now that we know where the archive lives — but only
    # if the archive root exists already, or this command may create it.
    if create_archive_root or config.archive_root.exists():
        setup_logging(
            config.log_path,
            verbose=verbose,
            quiet=quiet,
            create_parents=create_archive_root,
        )
    return config


# --------------------------------------------------------------------------- #
# list-courses
# --------------------------------------------------------------------------- #


@app.command("list-courses")
def list_courses(
    include_past: Annotated[
        bool,
        typer.Option(
            "--include-past",
            help="Also list concluded enrollments and pending invitations.",
        ),
    ] = False,
    term: Annotated[
        Optional[str],
        typer.Option("--term", help="Only show courses in this term, e.g. FA25."),
    ] = None,
    env_file: Annotated[
        Optional[Path],
        typer.Option("--env-file", help="Path to a .env file. Defaults to auto-discovery."),
    ] = None,
    verbose: Annotated[
        bool, typer.Option("--verbose", "-v", help="Show debug output.")
    ] = False,
) -> None:
    """List every course visible to your Canvas token.

    This is the smoke test for your setup: if this prints your courses, your
    token, Canvas URL and network path are all correct.
    """
    config = _load(require_token=True, env_file=env_file, verbose=verbose)
    client = CanvasClient(config)

    try:
        with console.status(f"Authenticating against {config.api_url}…"):
            who = client.verify()
        console.print(
            f"[ok]Authenticated[/ok] as [bold]{who}[/bold] "
            f"at {config.api_url} [hint](token {config.redacted_token()})[/hint]"
        )

        with console.status("Fetching courses…"):
            courses = client.list_courses(include_past=include_past)
    except CanvasClientError as exc:
        console.print(f"[err]{exc}[/err]")
        raise typer.Exit(code=EXIT_API_ERROR)

    wanted = term.strip().upper() if term else None
    if wanted:
        courses = [c for c in courses if c.term.code == wanted]

    if not courses:
        scope = f" in term {wanted}" if wanted else ""
        console.print(
            f"[warn]No courses found{scope}.[/warn] "
            "[hint]Try --include-past if the term has already ended.[/hint]"
        )
        return

    courses.sort(key=lambda c: (term_sort_key(c.term.code), c.course_code, c.name))

    table = Table(
        title=f"Canvas courses ({len(courses)})",
        header_style="bold",
        title_justify="left",
    )
    table.add_column("ID", justify="right", style="cyan", no_wrap=True)
    table.add_column("Code", style="bold")
    table.add_column("Name")
    table.add_column("Term", no_wrap=True)
    table.add_column("Enrollment", no_wrap=True)
    table.add_column("State", no_wrap=True)

    for course in courses:
        state = course.workflow_state
        if course.restricted:
            state = "restricted"
        table.add_row(
            str(course.id),
            course.course_code or "—",
            course.name,
            course.term.code,
            course.enrollment_state,
            state,
        )

    console.print(table)

    restricted = [c for c in courses if c.restricted]
    if restricted:
        console.print(
            f"[warn]{len(restricted)} course(s) are outside their availability window "
            "and cannot be archived.[/warn]"
        )
    console.print(f"[hint]Archive root: {config.archive_root}[/hint]")


# --------------------------------------------------------------------------- #
# sync (Phase 2+)
# --------------------------------------------------------------------------- #


@app.command()
def sync(
    term: Annotated[
        Optional[str], typer.Option("--term", help="Only sync this term, e.g. FA25.")
    ] = None,
    course: Annotated[
        Optional[list[int]],
        typer.Option("--course", help="Only sync these Canvas course IDs. Repeatable."),
    ] = None,
    include_past: Annotated[
        bool, typer.Option("--include-past", help="Include concluded enrollments.")
    ] = False,
    full: Annotated[
        bool, typer.Option("--full", help="Force a complete re-download, ignoring the manifest.")
    ] = False,
    dry_run: Annotated[
        bool, typer.Option("--dry-run", help="Report what would change; download nothing.")
    ] = False,
    env_file: Annotated[
        Optional[Path], typer.Option("--env-file", help="Path to a .env file.")
    ] = None,
    verbose: Annotated[bool, typer.Option("--verbose", "-v", help="Show debug output.")] = False,
) -> None:
    """Download new and changed course content into the local archive.

    Not yet implemented — arrives in Phase 2.
    """
    _load(
        require_token=True,
        env_file=env_file,
        verbose=verbose,
        create_archive_root=True,
    )
    console.print("[warn]`sync` is not implemented yet — it lands in Phase 2.[/warn]")
    console.print("[hint]Run `canvas-archive list-courses` to verify your setup.[/hint]")
    raise typer.Exit(code=1)


# --------------------------------------------------------------------------- #
# status (Phase 4)
# --------------------------------------------------------------------------- #


@app.command()
def status(
    env_file: Annotated[
        Optional[Path], typer.Option("--env-file", help="Path to a .env file.")
    ] = None,
    verbose: Annotated[bool, typer.Option("--verbose", "-v", help="Show debug output.")] = False,
) -> None:
    """Summarise the local archive without contacting Canvas.

    Not yet implemented — arrives in Phase 4.
    """
    config = _load(require_token=False, env_file=env_file, verbose=verbose)
    console.print(f"Archive root: [bold]{config.archive_root}[/bold]")

    index = config.archive_root / "archive_index.json"
    if not index.exists():
        console.print("[warn]Nothing synced yet[/warn] (no archive_index.json found).")
        console.print("[hint]Run `canvas-archive sync` to build the archive.[/hint]")
        return

    console.print("[warn]`status` reporting is not implemented yet — it lands in Phase 4.[/warn]")


if __name__ == "__main__":  # pragma: no cover
    app()
