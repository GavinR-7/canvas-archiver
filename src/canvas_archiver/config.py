"""Configuration loading.

All configuration arrives through environment variables, which are read from a
``.env`` file in the project root (or any parent directory) via python-dotenv.
Real environment variables always win over ``.env`` values, so CI or a one-off
``CANVAS_API_TOKEN=... canvas-archive sync`` behaves as expected.

The API token is deliberately never exposed by ``__repr__``, never logged, and
never included in error messages. :meth:`Config.redacted_token` exists purely so
the CLI can prove *which* token is loaded without revealing it.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

DEFAULT_API_URL = "https://canvas.cornell.edu"
DEFAULT_ARCHIVE_ROOT = "~/canvas-archive"
DEFAULT_WORKERS = 4

#: Name of the log file written inside the archive root.
LOG_FILENAME = "archive.log"


class ConfigError(RuntimeError):
    """Raised when required configuration is missing or malformed."""


@dataclass(frozen=True)
class Config:
    """Resolved runtime configuration.

    Attributes:
        api_url: Base URL of the Canvas instance, with no trailing slash.
        archive_root: Absolute path to the archive directory. Created on demand.
        workers: Number of concurrent download threads.
        _token: The Canvas personal access token. Private by convention; use
            :attr:`token` to read it and :meth:`redacted_token` to display it.
    """

    api_url: str
    archive_root: Path
    workers: int = DEFAULT_WORKERS
    _token: str = field(repr=False, default="")

    @property
    def token(self) -> str:
        """The raw Canvas access token. Never log or print this value."""
        return self._token

    @property
    def log_path(self) -> Path:
        """Absolute path to the archive-wide log file."""
        return self.archive_root / LOG_FILENAME

    def redacted_token(self) -> str:
        """Return a safe-to-display fingerprint of the token, e.g. ``1234~...aB9x``.

        Shows the Canvas key-id prefix (everything before ``~``, which is not
        secret) and the final four characters, so you can tell two tokens apart
        without either one being recoverable from logs or screenshots.
        """
        if not self._token:
            return "<unset>"
        prefix, _, rest = self._token.partition("~")
        tail = rest[-4:] if rest else prefix[-4:]
        head = f"{prefix}~" if rest else ""
        return f"{head}...{tail}"

    def __str__(self) -> str:  # pragma: no cover - trivial
        return (
            f"Config(api_url={self.api_url!r}, archive_root={str(self.archive_root)!r}, "
            f"workers={self.workers}, token={self.redacted_token()})"
        )


def _clean_url(raw: str) -> str:
    """Normalise a Canvas base URL: strip whitespace, trailing slashes, add scheme."""
    url = raw.strip().rstrip("/")
    if not url:
        raise ConfigError("CANVAS_API_URL is empty.")
    if not url.startswith(("http://", "https://")):
        url = f"https://{url}"
    return url


def _clean_workers(raw: str | None) -> int:
    """Parse the worker count, rejecting values that are not positive integers."""
    if raw is None or not raw.strip():
        return DEFAULT_WORKERS
    try:
        workers = int(raw)
    except ValueError as exc:
        raise ConfigError(
            f"CANVAS_DOWNLOAD_WORKERS must be an integer, got {raw!r}."
        ) from exc
    if workers < 1:
        raise ConfigError(f"CANVAS_DOWNLOAD_WORKERS must be >= 1, got {workers}.")
    return workers


def load_config(env_file: Path | None = None, *, require_token: bool = True) -> Config:
    """Load configuration from the environment and an optional ``.env`` file.

    Args:
        env_file: Explicit path to a ``.env`` file. When ``None``, python-dotenv
            searches upward from the current working directory.
        require_token: When ``False``, a missing token is tolerated and
            :attr:`Config.token` is empty. Used by offline commands such as
            ``status`` that never contact Canvas.

    Raises:
        ConfigError: If the token is required but absent, or if a value is
            malformed.
    """
    if env_file is not None:
        load_dotenv(dotenv_path=env_file, override=False)
    else:
        load_dotenv(override=False)

    token = os.environ.get("CANVAS_API_TOKEN", "").strip()
    if require_token and not token:
        raise ConfigError(
            "CANVAS_API_TOKEN is not set.\n"
            "Create a token at <your Canvas>/profile/settings → Approved Integrations\n"
            "→ + New Access Token, then copy .env.example to .env and paste it in."
        )

    api_url = _clean_url(os.environ.get("CANVAS_API_URL") or DEFAULT_API_URL)
    archive_root = (
        Path(os.environ.get("ARCHIVE_ROOT") or DEFAULT_ARCHIVE_ROOT)
        .expanduser()
        .resolve()
    )
    workers = _clean_workers(os.environ.get("CANVAS_DOWNLOAD_WORKERS"))

    return Config(
        api_url=api_url,
        archive_root=archive_root,
        workers=workers,
        _token=token,
    )
