"""Tests for credential assembly and the on-disk cookie store.

The cookie file is a password-equivalent, so most of what matters here is
negative: what must *not* end up in it, and what must not leak out of it.
"""

from __future__ import annotations

import json
import stat
from pathlib import Path

import pytest

from canvas_archiver.auth import (
    COOKIE_SCHEMA_VERSION,
    AuthError,
    AuthMode,
    Credential,
    SessionExpiredError,
    build_credential,
    forget_browser_profile,
    forget_session,
    load_cookies,
    save_cookies,
)

API_URL = "https://canvas.cornell.edu"
TOKEN = "1234~abcdefghijklmnopqrstuvwxyz0123"


def _canvas_cookies() -> list[dict[str, object]]:
    return [
        {"name": "canvas_session", "value": "SESSION-SECRET", "domain": "canvas.cornell.edu"},
        {"name": "_csrf_token", "value": "csrf-value", "domain": ".canvas.cornell.edu"},
    ]


# --- mode parsing ----------------------------------------------------------- #


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("session", AuthMode.SESSION), ("token", AuthMode.TOKEN), ("TOKEN", AuthMode.TOKEN)],
)
def test_auth_mode_parses(raw: str, expected: AuthMode) -> None:
    assert AuthMode.parse(raw) is expected


def test_auth_mode_defaults_to_session() -> None:
    assert AuthMode.parse(None) is AuthMode.SESSION
    assert AuthMode.parse("  ") is AuthMode.SESSION


def test_auth_mode_rejects_anything_else() -> None:
    with pytest.raises(AuthError, match="session, token"):
        AuthMode.parse("basic")


# --- saving ----------------------------------------------------------------- #


def test_save_keeps_only_canvas_cookies(tmp_path: Path) -> None:
    """A browser profile picks up Duo and IdP cookies we have no business storing."""
    destination = tmp_path / "cookies.json"
    save_cookies(
        _canvas_cookies()
        + [
            {"name": "duo_session", "value": "NOPE", "domain": "api.duosecurity.com"},
            {"name": "shib", "value": "NOPE", "domain": "shibidp.cit.cornell.edu"},
            {"name": "ga", "value": "NOPE", "domain": ".google.com"},
        ],
        API_URL,
        destination,
    )

    stored = json.loads(destination.read_text())

    assert set(stored["cookies"]) == {"canvas_session", "_csrf_token"}
    assert "NOPE" not in destination.read_text()


def test_saved_file_is_owner_only(tmp_path: Path) -> None:
    destination = tmp_path / "cookies.json"
    save_cookies(_canvas_cookies(), API_URL, destination)

    mode = destination.stat().st_mode
    assert not mode & stat.S_IRGRP
    assert not mode & stat.S_IROTH


def test_save_records_host_and_schema_version(tmp_path: Path) -> None:
    destination = tmp_path / "cookies.json"
    save_cookies(_canvas_cookies(), API_URL, destination)

    stored = json.loads(destination.read_text())
    assert stored["host"] == "canvas.cornell.edu"
    assert stored["schema_version"] == COOKIE_SCHEMA_VERSION


def test_save_refuses_when_no_canvas_cookies_were_captured(tmp_path: Path) -> None:
    with pytest.raises(AuthError, match="No cookies were captured"):
        save_cookies(
            [{"name": "duo", "value": "x", "domain": "api.duosecurity.com"}],
            API_URL,
            tmp_path / "cookies.json",
        )


def test_save_refuses_a_jar_with_no_session_cookie(tmp_path: Path) -> None:
    """Cookies for the right host but no session means login never finished."""
    with pytest.raises(AuthError, match="none of them is a Canvas session cookie"):
        save_cookies(
            [{"name": "_csrf_token", "value": "x", "domain": "canvas.cornell.edu"}],
            API_URL,
            tmp_path / "cookies.json",
        )


# --- loading ---------------------------------------------------------------- #


def test_round_trip(tmp_path: Path) -> None:
    destination = tmp_path / "cookies.json"
    save_cookies(_canvas_cookies(), API_URL, destination)

    stored = load_cookies(destination)

    assert stored.host == "canvas.cornell.edu"
    assert stored.cookies["canvas_session"] == "SESSION-SECRET"
    assert stored.looks_like_a_session()
    assert stored.age_days is not None and stored.age_days < 1


@pytest.mark.parametrize(
    ("contents", "match"),
    [
        (None, "No saved Canvas session"),
        ("{ not json", "could not be read"),
        ('{"schema_version": 99, "cookies": {"a": "b"}}', "format version"),
        ('{"schema_version": 1, "cookies": {}}', "contains no cookies"),
    ],
)
def test_every_unusable_cookie_file_says_to_log_in_again(
    tmp_path: Path, contents: str | None, match: str
) -> None:
    """Missing, corrupt, outdated and empty all have the same remedy."""
    destination = tmp_path / "cookies.json"
    if contents is not None:
        destination.write_text(contents)

    with pytest.raises(SessionExpiredError, match=match) as excinfo:
        load_cookies(destination)

    assert "canvas-archive login" in str(excinfo.value)


# --- credential assembly ---------------------------------------------------- #


def test_token_mode_builds_a_bearer_header() -> None:
    credential = build_credential(AuthMode.TOKEN, token=TOKEN)

    assert credential.headers["Authorization"] == f"Bearer {TOKEN}"
    assert credential.cookies == {}


def test_token_mode_without_a_token_explains_both_options() -> None:
    with pytest.raises(AuthError) as excinfo:
        build_credential(AuthMode.TOKEN, token="")

    message = str(excinfo.value)
    assert "CANVAS_API_TOKEN" in message
    assert "canvas-archive login" in message


def test_session_mode_builds_a_cookie_jar(tmp_path: Path) -> None:
    destination = tmp_path / "cookies.json"
    save_cookies(_canvas_cookies(), API_URL, destination)

    credential = build_credential(
        AuthMode.SESSION, api_url=API_URL, cookie_path=destination
    )

    assert credential.cookies["canvas_session"] == "SESSION-SECRET"
    assert credential.headers == {}


def test_session_for_a_different_canvas_host_is_rejected(tmp_path: Path) -> None:
    """Pointing CANVAS_API_URL elsewhere must not silently reuse the old session."""
    destination = tmp_path / "cookies.json"
    save_cookies(_canvas_cookies(), API_URL, destination)

    with pytest.raises(SessionExpiredError, match="saved session is for"):
        build_credential(
            AuthMode.SESSION,
            api_url="https://canvas.instructure.com",
            cookie_path=destination,
        )


# --- leakage ---------------------------------------------------------------- #


def test_credential_repr_hides_the_bearer_header() -> None:
    credential = build_credential(AuthMode.TOKEN, token=TOKEN)

    assert TOKEN not in repr(credential)
    assert TOKEN not in str(credential)
    assert credential.describe() == "bearer token"


def test_credential_repr_hides_cookie_values() -> None:
    credential = Credential(
        mode=AuthMode.SESSION, cookies={"canvas_session": "SESSION-SECRET"}
    )

    assert "SESSION-SECRET" not in repr(credential)
    assert "SESSION-SECRET" not in str(credential)
    assert credential.describe() == "browser session (1 cookies)"


# --- forgetting ------------------------------------------------------------- #


def test_forget_session_removes_the_file(tmp_path: Path) -> None:
    destination = tmp_path / "cookies.json"
    save_cookies(_canvas_cookies(), API_URL, destination)

    assert forget_session(destination) is True
    assert not destination.exists()
    assert forget_session(destination) is False


# --- purging the browser profile -------------------------------------------- #
#
# The profile is materially more sensitive than cookies.json: alongside a second
# copy of the Canvas session it holds the Shibboleth SSO session and Duo's
# device-trust token, which together mint a fresh Canvas session with no
# password and no MFA prompt. These tests cover the only thing that clears it.


def _fake_profile(root: Path) -> Path:
    """A directory shaped like the Chromium profile Playwright leaves behind."""
    profile = root / "browser-profile"
    (profile / "Default").mkdir(parents=True)
    (profile / "Default" / "Cookies").write_text("sqlite-ish")
    (profile / "Default" / "Login Data").write_text("sqlite-ish")
    (profile / "Default" / "Local Storage").mkdir()
    (profile / "Local State").write_text("{}")
    return profile


def test_forget_browser_profile_removes_the_whole_tree(tmp_path: Path) -> None:
    profile = _fake_profile(tmp_path)

    assert forget_browser_profile(profile) is True
    assert not profile.exists()


def test_forget_browser_profile_is_idempotent(tmp_path: Path) -> None:
    profile = _fake_profile(tmp_path)

    assert forget_browser_profile(profile) is True
    assert forget_browser_profile(profile) is False


def test_forget_browser_profile_reports_absence_rather_than_raising(tmp_path: Path) -> None:
    assert forget_browser_profile(tmp_path / "never-existed") is False


def test_forget_browser_profile_refuses_to_follow_a_symlink(tmp_path: Path) -> None:
    """rmtree through a symlink would delete somewhere unintended."""
    real = tmp_path / "somewhere-important"
    real.mkdir()
    (real / "keep-me").write_text("data")

    link = tmp_path / "browser-profile"
    link.symlink_to(real, target_is_directory=True)

    with pytest.raises(AuthError, match="symlink"):
        forget_browser_profile(link)

    assert (real / "keep-me").exists()


def test_forgetting_the_session_leaves_the_profile_alone(tmp_path: Path) -> None:
    """The default logout is deliberately narrow -- this documents that the
    profile survives it, which is exactly why --purge-profile exists."""
    cookies = tmp_path / "cookies.json"
    save_cookies(_canvas_cookies(), API_URL, cookies)
    profile = _fake_profile(tmp_path)

    forget_session(cookies)

    assert not cookies.exists()
    assert (profile / "Default" / "Cookies").exists()
