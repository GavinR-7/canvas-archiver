"""``canvas-archive`` command-line interface.

Four subcommands:

* ``login``        — capture a Canvas session from a real browser. Network.
* ``list-courses`` — show every course the credential can see. Network, read-only.
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

from . import __version__, paths
from .auth import AuthError, AuthMode, SessionExpiredError, forget_session, load_cookies
from .client import CanvasClient, CanvasClientError
from .config import Config, ConfigError, load_config
from .log import console, get_logger, setup_logging
from .login import DEFAULT_LOGIN_TIMEOUT, LoginError, run_login
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

EXIT_NOT_IMPLEMENTED = 1
EXIT_CONFIG_ERROR = 2
EXIT_API_ERROR = 3
EXIT_NEEDS_LOGIN = 4


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
    require_auth: bool,
    env_file: Path | None,
    verbose: bool,
    quiet: bool = False,
    create_archive_root: bool = False,
) -> Config:
    """Load config and configure logging, exiting cleanly on failure.

    Args:
        require_auth: Whether missing credentials are fatal.
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
        config = load_config(env_file, require_auth=require_auth)
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


def _connect(config: Config) -> CanvasClient:
    """Build an authenticated client, turning auth failures into clean exits."""
    try:
        return CanvasClient(config)
    except SessionExpiredError as exc:
        console.print(f"[err]{exc}[/err]")
        raise typer.Exit(code=EXIT_NEEDS_LOGIN)
    except AuthError as exc:
        console.print(f"[err]{exc}[/err]")
        raise typer.Exit(code=EXIT_CONFIG_ERROR)


# --------------------------------------------------------------------------- #
# login
# --------------------------------------------------------------------------- #


@app.command()
def login(
    timeout: Annotated[
        float,
        typer.Option("--timeout", help="Seconds to wait for you to finish signing in."),
    ] = DEFAULT_LOGIN_TIMEOUT,
    env_file: Annotated[
        Optional[Path], typer.Option("--env-file", help="Path to a .env file.")
    ] = None,
    verbose: Annotated[bool, typer.Option("--verbose", "-v", help="Show debug output.")] = False,
) -> None:
    """Sign in to Canvas in a browser and save the session for later runs.

    Opens a visible Chromium. Complete NetID and Duo yourself — this tool never
    sees, fills or stores your password. Once your Canvas dashboard loads, the
    session cookies are written to a private file and the browser closes.

    Use this when your institution does not issue personal access tokens. If you
    do have a token, set CANVAS_AUTH_MODE=token instead and skip this entirely.
    """
    config = _load(require_auth=False, env_file=env_file, verbose=verbose)

    console.print(f"Opening a browser to [bold]{config.api_url}[/bold]…")

    def announce() -> None:
        console.print(
            "\n[bold]Sign in with your NetID and Duo in the browser window.[/bold]\n"
            "[hint]Your password is typed into Canvas's own login page — this "
            "tool never sees it.\n"
            f"Waiting up to {timeout:.0f}s. Close the window to cancel.[/hint]\n"
        )

    try:
        result = run_login(config.api_url, timeout=timeout, on_waiting=announce)
    except (LoginError, AuthError) as exc:
        console.print(f"[err]{exc}[/err]")
        raise typer.Exit(code=EXIT_API_ERROR)

    console.print(
        f"[ok]Signed in[/ok] as [bold]{result.user_name}[/bold] — "
        f"saved {result.cookie_count} session cookie(s)."
    )
    console.print(f"[hint]Stored at {result.cookie_path} (owner-only).[/hint]")

    if paths.is_world_readable(result.cookie_path):
        console.print(
            "[warn]Warning:[/warn] that file is readable by other users on this "
            "machine. chmod had no effect, which usually means it sits on a "
            "Windows-backed path. Consider moving it with "
            "CANVAS_ARCHIVER_STATE_DIR."
        )

    console.print("\n[hint]Next: canvas-archive list-courses[/hint]")


@app.command()
def logout(
    env_file: Annotated[
        Optional[Path], typer.Option("--env-file", help="Path to a .env file.")
    ] = None,
    verbose: Annotated[bool, typer.Option("--verbose", "-v", help="Show debug output.")] = False,
) -> None:
    """Delete the saved Canvas session from this machine.

    Removes the stored cookies. It does not end the session on Canvas's side —
    to do that, sign out from Canvas in your browser.
    """
    _load(require_auth=False, env_file=env_file, verbose=verbose)

    if forget_session():
        console.print("[ok]Saved session deleted.[/ok]")
        console.print(
            "[hint]This only removes the local copy. To invalidate the session "
            "itself, sign out of Canvas in your browser.[/hint]"
        )
    else:
        console.print("No saved session to delete.")


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
    """List every course visible to your Canvas credential.

    This is the smoke test for your setup: if this prints your courses, your
    credential, Canvas URL and network path are all correct.
    """
    config = _load(require_auth=True, env_file=env_file, verbose=verbose)
    client = _connect(config)

    try:
        with console.status(f"Authenticating against {config.api_url}…"):
            who = client.verify()
        console.print(
            f"[ok]Authenticated[/ok] as [bold]{who}[/bold] "
            f"at {config.api_url} [hint](via {client.describe_auth()})[/hint]"
        )

        with console.status("Fetching courses…"):
            courses = client.list_courses(include_past=include_past)
    except SessionExpiredError as exc:
        console.print(f"[err]{exc}[/err]")
        raise typer.Exit(code=EXIT_NEEDS_LOGIN)
    except CanvasClientError as exc:
        console.print(f"[err]{exc}[/err]")
        raise typer.Exit(code=EXIT_API_ERROR)
    finally:
        client.close()

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
        state = "restricted" if course.restricted else course.workflow_state
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
            f"[warn]{len(restricted)} course(s) are outside their availability "
            "window and cannot be archived.[/warn]"
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
        require_auth=True,
        env_file=env_file,
        verbose=verbose,
        create_archive_root=True,
    )
    console.print("[warn]`sync` is not implemented yet — it lands in Phase 2.[/warn]")
    console.print("[hint]Run `canvas-archive list-courses` to verify your setup.[/hint]")
    raise typer.Exit(code=EXIT_NOT_IMPLEMENTED)


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
    config = _load(require_auth=False, env_file=env_file, verbose=verbose)

    console.print(f"Archive root: [bold]{config.archive_root}[/bold]")
    console.print(f"Auth mode:    [bold]{config.auth_mode.value}[/bold]")

    if config.auth_mode is AuthMode.SESSION:
        try:
            stored = load_cookies()
        except SessionExpiredError:
            console.print("Session:      [warn]none saved[/warn] — run `canvas-archive login`")
        else:
            age = stored.age_days
            age_text = f", captured {age:.1f} days ago" if age is not None else ""
            console.print(f"Session:      saved for {stored.host}{age_text}")
    else:
        console.print(f"Token:        {config.redacted_token()}")

    index = config.archive_root / "archive_index.json"
    if not index.exists():
        console.print("\n[warn]Nothing synced yet[/warn] (no archive_index.json found).")
        console.print("[hint]Run `canvas-archive sync` to build the archive.[/hint]")
        return

    console.print("\n[warn]`status` reporting is not implemented yet — it lands in Phase 4.[/warn]")


if __name__ == "__main__":  # pragma: no cover
    app()
