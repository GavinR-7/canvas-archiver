"""Two ways to authenticate to the same Canvas REST API.

Canvas accepts either credential on ``/api/v1``:

* **token** — ``Authorization: Bearer <token>``. A personal access token minted
  from Canvas's settings page. Scoped to the API, revocable on its own, and the
  documented way for a program to talk to Canvas.
* **session** — the ``Cookie`` header from a logged-in browser. This is what
  Canvas's *own* web front-end uses: the Canvas UI is a JavaScript application
  that calls the same ``/api/v1`` endpoints with the session cookie the login
  flow set.

Both are handed to :class:`~canvas_archiver.http_client.CanvasHTTP` as a
:class:`Credential`, which is the only thing the HTTP layer knows about auth.

A saved session cookie is the more dangerous of the two: it is unscoped — it is
your whole account, not a read-scoped key — and it cannot be revoked
individually. It is therefore written owner-only, kept out of the repo and the
archive, and never printed. See :mod:`canvas_archiver.paths`.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any

from . import paths
from .log import get_logger

logger = get_logger("auth")

#: Bumped if the on-disk cookie format changes incompatibly.
COOKIE_SCHEMA_VERSION = 1

#: Cookies Canvas uses to carry a session. Everything on the Canvas domain is
#: saved regardless; this list only drives the "did we actually capture a login?"
#: check, since a cookie jar with none of these in it is not a session.
SESSION_COOKIE_NAMES = frozenset(
    {"canvas_session", "_normandy_session", "_legacy_normandy_session"}
)


class AuthMode(str, Enum):
    """How to authenticate against Canvas."""

    SESSION = "session"
    TOKEN = "token"

    @classmethod
    def parse(cls, raw: str | None, default: "AuthMode" = None) -> "AuthMode":
        """Parse a mode name case-insensitively.

        Raises:
            AuthError: If *raw* is neither ``session`` nor ``token``.
        """
        if raw is None or not raw.strip():
            return default or cls.SESSION
        try:
            return cls(raw.strip().lower())
        except ValueError:
            valid = ", ".join(m.value for m in cls)
            raise AuthError(
                f"CANVAS_AUTH_MODE must be one of: {valid}. Got {raw!r}."
            ) from None


class AuthError(RuntimeError):
    """Authentication could not be set up. Fatal, but actionable."""


class SessionExpiredError(AuthError):
    """The saved browser session is no longer valid.

    Raised mid-run when Canvas stops accepting the cookie jar. The CLI turns
    this into a "run `canvas-archive login` again" message and stops cleanly
    rather than letting every subsequent request fail one at a time.
    """


@dataclass(frozen=True)
class Credential:
    """What the HTTP layer needs in order to authenticate a request.

    Exactly one of ``headers`` or ``cookies`` carries the secret, depending on
    :attr:`mode`. Both fields have ``repr=False``: a traceback that printed a
    ``Credential`` would otherwise leak the whole account.
    """

    mode: AuthMode
    headers: dict[str, str] = field(default_factory=dict, repr=False)
    cookies: dict[str, str] = field(default_factory=dict, repr=False)

    def describe(self) -> str:
        """A safe-to-print one-line description of this credential."""
        if self.mode is AuthMode.TOKEN:
            return "bearer token"
        return f"browser session ({len(self.cookies)} cookies)"

    def __str__(self) -> str:  # pragma: no cover - trivial
        return f"Credential({self.describe()})"


@dataclass(frozen=True)
class StoredCookies:
    """A cookie jar loaded from disk, with the metadata saved alongside it."""

    host: str
    saved_at: datetime | None
    cookies: dict[str, str] = field(default_factory=dict, repr=False)

    @property
    def age_days(self) -> float | None:
        """Days since these cookies were captured, or ``None`` if unknown."""
        if self.saved_at is None:
            return None
        return (datetime.now(timezone.utc) - self.saved_at).total_seconds() / 86400

    def looks_like_a_session(self) -> bool:
        """Whether the jar contains a cookie Canvas actually uses for sessions."""
        return any(name in SESSION_COOKIE_NAMES for name in self.cookies)


def _host_of(api_url: str) -> str:
    """Extract the bare hostname from a Canvas base URL."""
    from urllib.parse import urlparse

    return urlparse(api_url).hostname or api_url


def save_cookies(
    playwright_cookies: list[dict[str, Any]],
    api_url: str,
    path: Path | None = None,
) -> Path:
    """Write captured browser cookies to the credential store.

    Only cookies scoped to the Canvas host are kept — a browser profile picks up
    cookies for Duo, the identity provider and anything else visited during
    login, none of which this tool has any business storing.

    The file is created with owner-only permissions *before* the secret is
    written to it, so there is no window in which it exists world-readable.

    Args:
        playwright_cookies: The list returned by ``BrowserContext.cookies()``.
        api_url: The Canvas base URL, used to filter by host.
        path: Override the destination. Defaults to :func:`paths.cookie_file`.

    Returns:
        The path written.

    Raises:
        AuthError: If no Canvas session cookie was present.
    """
    destination = path or paths.cookie_file()
    host = _host_of(api_url)

    kept: dict[str, str] = {}
    for cookie in playwright_cookies:
        domain = str(cookie.get("domain", "")).lstrip(".")
        if domain and (domain == host or host.endswith(f".{domain}")):
            kept[str(cookie["name"])] = str(cookie["value"])

    if not kept:
        raise AuthError(
            f"No cookies were captured for {host}. "
            "The login did not complete, or it finished on a different host."
        )
    if not any(name in SESSION_COOKIE_NAMES for name in kept):
        raise AuthError(
            f"Captured {len(kept)} cookie(s) for {host}, but none of them is a "
            "Canvas session cookie. You may have stopped before the login "
            "finished — wait until your Canvas dashboard has loaded."
        )

    paths.ensure_private_dir(destination.parent)

    # Create the file empty and locked down, then write into it.
    destination.touch(mode=paths.SECRET_FILE_MODE, exist_ok=True)
    paths.harden_file(destination)
    payload = {
        "schema_version": COOKIE_SCHEMA_VERSION,
        "host": host,
        "saved_at": datetime.now(timezone.utc).isoformat(),
        "cookies": kept,
    }
    destination.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    paths.harden_file(destination)

    logger.debug("Saved %d cookie(s) for %s", len(kept), host)
    return destination


def load_cookies(path: Path | None = None) -> StoredCookies:
    """Read the saved cookie jar.

    Raises:
        SessionExpiredError: If the file is missing, unreadable, or malformed —
            all of which are resolved the same way, by logging in again.
    """
    source = path or paths.cookie_file()

    if not source.exists():
        raise SessionExpiredError(
            f"No saved Canvas session found at {source}.\n"
            "Run `canvas-archive login` to sign in with your NetID."
        )

    try:
        payload = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SessionExpiredError(
            f"The saved session at {source} could not be read ({exc}).\n"
            "Run `canvas-archive login` to sign in again."
        ) from exc

    version = payload.get("schema_version")
    if version != COOKIE_SCHEMA_VERSION:
        raise SessionExpiredError(
            f"The saved session at {source} uses format version {version!r}, "
            f"but this version expects {COOKIE_SCHEMA_VERSION}.\n"
            "Run `canvas-archive login` to sign in again."
        )

    cookies = payload.get("cookies") or {}
    if not isinstance(cookies, dict) or not cookies:
        raise SessionExpiredError(
            f"The saved session at {source} contains no cookies.\n"
            "Run `canvas-archive login` to sign in again."
        )

    saved_at: datetime | None = None
    raw_saved = payload.get("saved_at")
    if isinstance(raw_saved, str):
        try:
            saved_at = datetime.fromisoformat(raw_saved)
        except ValueError:
            saved_at = None

    return StoredCookies(
        host=str(payload.get("host", "")),
        saved_at=saved_at,
        cookies={str(k): str(v) for k, v in cookies.items()},
    )


def build_credential(
    mode: AuthMode,
    *,
    token: str = "",
    api_url: str = "",
    cookie_path: Path | None = None,
) -> Credential:
    """Assemble the credential for *mode*.

    Args:
        mode: Which authentication scheme to use.
        token: The bearer token. Required in token mode.
        api_url: The Canvas base URL, used to sanity-check the saved cookie host.
        cookie_path: Override the cookie file location.

    Raises:
        AuthError: In token mode with no token.
        SessionExpiredError: In session mode with no usable saved session.
    """
    if mode is AuthMode.TOKEN:
        if not token:
            raise AuthError(
                "CANVAS_AUTH_MODE=token, but CANVAS_API_TOKEN is not set.\n"
                "Either paste a token into .env, or switch to "
                "CANVAS_AUTH_MODE=session and run `canvas-archive login`."
            )
        return Credential(
            mode=mode, headers={"Authorization": f"Bearer {token}"}
        )

    stored = load_cookies(cookie_path)

    if api_url and stored.host and stored.host != _host_of(api_url):
        raise SessionExpiredError(
            f"The saved session is for {stored.host}, but CANVAS_API_URL points "
            f"at {_host_of(api_url)}.\n"
            "Run `canvas-archive login` to sign in to the right Canvas."
        )

    if not stored.looks_like_a_session():
        raise SessionExpiredError(
            "The saved session has no Canvas session cookie in it.\n"
            "Run `canvas-archive login` to sign in again."
        )

    return Credential(mode=mode, cookies=dict(stored.cookies))


def forget_session(path: Path | None = None) -> bool:
    """Delete the saved cookie jar. Returns whether a file was removed."""
    target = path or paths.cookie_file()
    try:
        target.unlink()
        return True
    except FileNotFoundError:
        return False
