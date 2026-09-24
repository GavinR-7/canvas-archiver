"""``canvas-archive login`` — capture a Canvas session from a real browser.

Cornell gates personal access tokens behind an approval request, so the fallback
credential is the session a normal browser login produces. This module opens a
visible Chromium, gets out of the way while the user completes NetID and Duo
themselves, and then copies the resulting Canvas cookies into the credential
store.

Two things it deliberately does *not* do:

* **Touch credentials.** No field is filled, no keystroke is synthesised, and
  nothing on the identity provider's pages is read. The browser is handed over
  and watched only for the signal that a session now exists.
* **Guess when login finished.** Rather than matching on page titles or URLs —
  which break whenever the identity provider is restyled — it polls the Canvas
  API through the browser's own cookie jar. The login is complete exactly when
  ``/api/v1/users/self`` starts returning a user, which is the same condition
  the archiver itself needs.

The persistent profile means Duo's "remember this device" survives between
logins, so re-authenticating later is usually a click rather than a fresh push.
"""

from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path

from . import paths
from .auth import AuthError, save_cookies
from .log import get_logger

logger = get_logger("login")

#: How long to wait for the user to finish NetID + Duo before giving up.
DEFAULT_LOGIN_TIMEOUT = 300.0

#: Seconds between "are we signed in yet?" probes.
POLL_INTERVAL = 2.0

#: Chromium flags. The shared-memory one matters under WSL, where /dev/shm is
#: small enough by default that Chromium can crash on heavier pages.
_CHROMIUM_ARGS = ["--disable-dev-shm-usage"]

#: Playwright downloads a Chromium binary but not the system libraries it links
#: against, so a fresh Ubuntu can install the browser successfully and still
#: fail to start it. The dynamic linker's complaint is distinctive.
_MISSING_LIBRARY = re.compile(r"error while loading shared libraries: (\S+?):")


class LoginError(RuntimeError):
    """The login flow could not be completed."""


@dataclass(frozen=True)
class LoginResult:
    """Outcome of a successful login.

    Attributes:
        user_name: Display name of the account that signed in, so the user can
            confirm they landed in the right one.
        cookie_count: How many Canvas cookies were stored. Never the values.
        cookie_path: Where they were written.
    """

    user_name: str
    cookie_count: int
    cookie_path: Path


def _import_playwright():
    """Import Playwright, converting an absent install into a clear message."""
    try:
        from playwright.sync_api import sync_playwright  # noqa: PLC0415
    except ImportError as exc:
        raise LoginError(
            "Playwright is not installed. Run `uv sync` to install it."
        ) from exc
    return sync_playwright


def _diagnose_launch_failure(exc: Exception) -> str:
    """Turn a Chromium launch failure into a message with a fix in it.

    The three realistic causes look nothing alike to a user but all surface as
    one opaque Playwright exception, so they are separated here.
    """
    text = str(exc)

    missing = _MISSING_LIBRARY.search(text)
    if missing:
        return (
            f"Chromium is installed but cannot start: the system library "
            f"{missing.group(1)} is missing.\n\n"
            "Playwright downloads the browser but not the libraries it links "
            "against. Install them with:\n\n"
            "    sudo playwright install-deps chromium\n\n"
            "or, if that is unavailable, the two packages Ubuntu most often "
            "lacks:\n\n"
            "    sudo apt-get install -y libnss3 libnspr4\n"
        )

    if "executable doesn't exist" in text.lower() or "please run" in text.lower():
        return (
            f"Chromium is not installed: {exc}\n\n"
            "Install it with:\n\n"
            "    uv run playwright install chromium\n"
        )

    if not os.environ.get("DISPLAY") and not os.environ.get("WAYLAND_DISPLAY"):
        return (
            f"Could not start Chromium, and no display is set: {exc}\n\n"
            "`login` needs a visible browser window. Under WSL, check that "
            "WSLg is running:\n\n"
            "    echo $DISPLAY    # should print something like :0\n"
        )

    return (
        f"Could not start Chromium: {exc}\n\n"
        "If the browser is missing:      uv run playwright install chromium\n"
        "If system libraries are missing: sudo playwright install-deps chromium\n"
        "If there is no display, check that WSLg is running (echo $DISPLAY).\n"
    )


def _probe_for_session(context, api_url: str) -> str | None:
    """Return the signed-in user's name, or ``None`` if not signed in yet.

    Uses the browser context's own request API, so the probe carries exactly the
    cookies the browser currently holds — no copying, and no risk of testing a
    different jar than the one that will be saved.
    """
    try:
        response = context.request.get(
            f"{api_url}/api/v1/users/self",
            headers={"Accept": "application/json"},
            timeout=10_000,
        )
    except Exception:
        # Mid-navigation the context may refuse requests. Not an error; retry.
        return None

    if not response.ok:
        return None

    try:
        payload = json.loads(response.text())
    except (ValueError, Exception):
        return None

    if not isinstance(payload, dict) or "id" not in payload:
        return None

    return str(payload.get("name") or payload.get("short_name") or f"user {payload['id']}")


def run_login(
    api_url: str,
    *,
    timeout: float = DEFAULT_LOGIN_TIMEOUT,
    profile_dir: Path | None = None,
    cookie_path: Path | None = None,
    on_waiting=None,
) -> LoginResult:
    """Open a browser, wait for the user to sign in, and store the session.

    Args:
        api_url: Canvas base URL to sign in to.
        timeout: Seconds to wait for login before giving up.
        profile_dir: Persistent Chromium profile location. Defaults to
            :func:`paths.browser_profile_dir`.
        cookie_path: Where to write cookies. Defaults to
            :func:`paths.cookie_file`.
        on_waiting: Optional callback invoked once, just before waiting, so the
            CLI can print instructions at the right moment.

    Returns:
        A :class:`LoginResult` describing the captured session.

    Raises:
        LoginError: Browser could not start, the user closed it, or the timeout
            elapsed before a session appeared.
        AuthError: A session appeared but produced no storable Canvas cookie.
    """
    sync_playwright = _import_playwright()

    profile = paths.ensure_private_dir(profile_dir or paths.browser_profile_dir())
    base = api_url.rstrip("/")

    with sync_playwright() as playwright:
        try:
            context = playwright.chromium.launch_persistent_context(
                user_data_dir=str(profile),
                headless=False,
                args=_CHROMIUM_ARGS,
                viewport={"width": 1280, "height": 900},
            )
        except Exception as exc:
            raise LoginError(_diagnose_launch_failure(exc)) from exc

        try:
            page = context.pages[0] if context.pages else context.new_page()

            try:
                page.goto(f"{base}/login", wait_until="domcontentloaded", timeout=60_000)
            except Exception as exc:
                raise LoginError(f"Could not open {base}/login: {exc}") from exc

            if on_waiting is not None:
                on_waiting()

            deadline = time.monotonic() + timeout
            user_name: str | None = None

            while time.monotonic() < deadline:
                # A closed browser means the user gave up; say so rather than
                # spinning until the timeout.
                if not context.pages:
                    raise LoginError(
                        "The browser was closed before login completed. "
                        "Run `canvas-archive login` again."
                    )

                user_name = _probe_for_session(context, base)
                if user_name:
                    break

                time.sleep(POLL_INTERVAL)

            if not user_name:
                raise LoginError(
                    f"Timed out after {timeout:.0f}s waiting for sign-in.\n"
                    "Run `canvas-archive login` again, or raise the limit with "
                    "--timeout."
                )

            cookies = context.cookies()
            logger.debug("Browser holds %d cookie(s) across all domains", len(cookies))

            destination = save_cookies(cookies, base, cookie_path)
            stored = json.loads(destination.read_text(encoding="utf-8"))
            count = len(stored.get("cookies", {}))

            return LoginResult(
                user_name=user_name, cookie_count=count, cookie_path=destination
            )
        finally:
            try:
                context.close()
            except Exception:  # pragma: no cover - already gone
                pass


__all__ = ["run_login", "LoginResult", "LoginError", "AuthError", "DEFAULT_LOGIN_TIMEOUT"]
