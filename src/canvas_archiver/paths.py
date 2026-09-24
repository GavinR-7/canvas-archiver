"""Where canvas-archiver keeps state that is neither code nor archive.

Saved session cookies and the Playwright browser profile are credentials. They
belong in neither the repository (they would be one ``git add -A`` away from
being published) nor the archive root (which is bulk course material a user may
reasonably back up, copy to another machine, or hand to an indexing tool).

They therefore live under the XDG state directory, defaulting to
``~/.local/share/canvas-archiver``, with permissions that keep them readable
only by the owning user.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path

#: Directory mode: owner-only read/write/execute.
DIR_MODE = 0o700

#: File mode: owner-only read/write. Applied to anything credential-bearing.
SECRET_FILE_MODE = 0o600


def state_dir() -> Path:
    """Return the directory holding credentials and the browser profile.

    Honours ``CANVAS_ARCHIVER_STATE_DIR`` (used by tests), then
    ``XDG_DATA_HOME``, then falls back to ``~/.local/share``.
    """
    override = os.environ.get("CANVAS_ARCHIVER_STATE_DIR")
    if override:
        return Path(override).expanduser().resolve()

    xdg = os.environ.get("XDG_DATA_HOME")
    base = Path(xdg).expanduser() if xdg else Path.home() / ".local" / "share"
    return (base / "canvas-archiver").resolve()


def cookie_file() -> Path:
    """Path to the saved Canvas session cookies."""
    return state_dir() / "cookies.json"


def browser_profile_dir() -> Path:
    """Path to the persistent Chromium profile used by ``canvas-archive login``.

    A persistent profile means Duo's "remember this device" survives between
    logins, so re-authenticating is usually a click rather than a full push.
    """
    return state_dir() / "browser-profile"


def ensure_private_dir(path: Path) -> Path:
    """Create *path* if absent and force owner-only permissions on it."""
    path.mkdir(parents=True, exist_ok=True)
    try:
        path.chmod(DIR_MODE)
    except OSError:
        # Some filesystems (notably DrvFs under WSL) ignore chmod. Not fatal.
        pass
    return path


def harden_file(path: Path) -> None:
    """Force owner-only permissions on a credential file."""
    try:
        path.chmod(SECRET_FILE_MODE)
    except OSError:
        pass


def is_world_readable(path: Path) -> bool:
    """Return ``True`` if *path* is readable by group or other.

    Used to warn when a cookie file's permissions could not be tightened — on
    Windows-backed WSL paths, ``chmod`` silently does nothing.
    """
    try:
        mode = path.stat().st_mode
    except OSError:
        return False
    return bool(mode & (stat.S_IRGRP | stat.S_IROTH))
