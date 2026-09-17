"""Tests for configuration loading and, above all, token redaction.

``load_config`` reads process environment variables, so every test here sets
them explicitly via monkeypatch and never relies on a real ``.env``.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from canvas_archiver.config import (
    DEFAULT_API_URL,
    DEFAULT_WORKERS,
    Config,
    ConfigError,
    load_config,
)

TOKEN = "1234~abcdefghijklmnopqrstuvwxyz0123"


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Remove every variable the loader reads, so tests start from nothing."""
    for key in (
        "CANVAS_API_URL",
        "CANVAS_API_TOKEN",
        "ARCHIVE_ROOT",
        "CANVAS_DOWNLOAD_WORKERS",
    ):
        monkeypatch.delenv(key, raising=False)


def _no_dotenv(monkeypatch: pytest.MonkeyPatch) -> None:
    """Point .env discovery at a file that does not exist."""
    monkeypatch.setattr("canvas_archiver.config.load_dotenv", lambda *a, **k: False)


def test_defaults_are_applied(monkeypatch: pytest.MonkeyPatch) -> None:
    _no_dotenv(monkeypatch)
    monkeypatch.setenv("CANVAS_API_TOKEN", TOKEN)

    config = load_config()

    assert config.api_url == DEFAULT_API_URL
    assert config.workers == DEFAULT_WORKERS
    assert config.archive_root == Path.home() / "canvas-archive"
    assert config.archive_root.is_absolute()


def test_missing_token_raises_with_actionable_message(monkeypatch: pytest.MonkeyPatch) -> None:
    _no_dotenv(monkeypatch)
    with pytest.raises(ConfigError, match="CANVAS_API_TOKEN is not set"):
        load_config()


def test_missing_token_tolerated_for_offline_commands(monkeypatch: pytest.MonkeyPatch) -> None:
    _no_dotenv(monkeypatch)
    config = load_config(require_token=False)
    assert config.token == ""
    assert config.redacted_token() == "<unset>"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("https://canvas.cornell.edu", "https://canvas.cornell.edu"),
        ("https://canvas.cornell.edu/", "https://canvas.cornell.edu"),
        ("https://canvas.cornell.edu///", "https://canvas.cornell.edu"),
        ("  https://canvas.cornell.edu  ", "https://canvas.cornell.edu"),
        # A bare hostname gets https:// rather than being rejected.
        ("canvas.cornell.edu", "https://canvas.cornell.edu"),
    ],
)
def test_api_url_is_normalised(
    monkeypatch: pytest.MonkeyPatch, raw: str, expected: str
) -> None:
    _no_dotenv(monkeypatch)
    monkeypatch.setenv("CANVAS_API_TOKEN", TOKEN)
    monkeypatch.setenv("CANVAS_API_URL", raw)

    assert load_config().api_url == expected


def test_archive_root_expands_tilde(monkeypatch: pytest.MonkeyPatch) -> None:
    _no_dotenv(monkeypatch)
    monkeypatch.setenv("CANVAS_API_TOKEN", TOKEN)
    monkeypatch.setenv("ARCHIVE_ROOT", "~/somewhere/else")

    assert load_config().archive_root == Path.home() / "somewhere" / "else"


@pytest.mark.parametrize("raw", ["0", "-1", "abc", "4.5"])
def test_invalid_worker_count_is_rejected(
    monkeypatch: pytest.MonkeyPatch, raw: str
) -> None:
    _no_dotenv(monkeypatch)
    monkeypatch.setenv("CANVAS_API_TOKEN", TOKEN)
    monkeypatch.setenv("CANVAS_DOWNLOAD_WORKERS", raw)

    with pytest.raises(ConfigError, match="CANVAS_DOWNLOAD_WORKERS"):
        load_config()


def test_log_path_lives_inside_the_archive_root(monkeypatch: pytest.MonkeyPatch) -> None:
    _no_dotenv(monkeypatch)
    monkeypatch.setenv("CANVAS_API_TOKEN", TOKEN)
    monkeypatch.setenv("ARCHIVE_ROOT", "/tmp/archive-under-test")

    assert load_config().log_path == Path("/tmp/archive-under-test/archive.log")


# --- Token leakage: the important part ------------------------------------- #


def test_redacted_token_hides_the_secret() -> None:
    config = Config(api_url=DEFAULT_API_URL, archive_root=Path("/tmp"), _token=TOKEN)
    redacted = config.redacted_token()

    assert redacted == "1234~...0123"
    assert "abcdefghijklmnopqrstuvwxyz" not in redacted


def test_redacted_token_handles_a_token_with_no_key_prefix() -> None:
    config = Config(api_url=DEFAULT_API_URL, archive_root=Path("/tmp"), _token="abcdwxyz")
    assert config.redacted_token() == "...wxyz"


def test_token_never_appears_in_repr_or_str() -> None:
    config = Config(api_url=DEFAULT_API_URL, archive_root=Path("/tmp"), _token=TOKEN)

    assert TOKEN not in repr(config)
    assert TOKEN not in str(config)
    assert "1234~...0123" in str(config)
