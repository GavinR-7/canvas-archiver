"""Tests for term-code derivation.

Term codes become top-level directory names, so every Canvas spelling of the
same term must collapse to the same code.
"""

from __future__ import annotations

from datetime import datetime

import pytest

from canvas_archiver.terms import (
    UNKNOWN_TERM,
    resolve_term,
    sort_key,
    term_code_from_date,
    term_code_from_name,
)


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("Fall 2025", "FA25"),
        ("fall 2025", "FA25"),
        ("FALL 2025", "FA25"),
        ("Spring 2026", "SP26"),
        ("Summer 2025", "SU25"),
        ("Winter 2026", "WI26"),
        ("Autumn 2025", "FA25"),
        ("January 2026", "WI26"),
        # Year-first spellings.
        ("2025FA", "FA25"),
        ("2025 Fall", "FA25"),
        ("2026-SP", "SP26"),
        # Already-short spellings.
        ("FA25", "FA25"),
        ("SP-26", "SP26"),
        # Two-digit and apostrophe years.
        ("Fall '25", "FA25"),
        ("Fall 25", "FA25"),
        # Extra decoration around the term.
        ("2025 Fall Semester (Ithaca)", "FA25"),
    ],
)
def test_term_code_from_name_parses_known_spellings(name: str, expected: str) -> None:
    assert term_code_from_name(name) == expected


@pytest.mark.parametrize("name", [None, "", "   ", "Default Term", "Ongoing", "Sandbox"])
def test_term_code_from_name_returns_none_when_unparseable(name: str | None) -> None:
    assert term_code_from_name(name) is None


@pytest.mark.parametrize(
    ("start_at", "expected"),
    [
        ("2025-08-25T04:00:00Z", "FA25"),
        ("2026-01-05T04:00:00Z", "WI26"),
        ("2026-01-21T04:00:00Z", "WI26"),
        ("2026-02-02T04:00:00Z", "SP26"),
        ("2025-06-01T04:00:00Z", "SU25"),
        ("2025-12-01T00:00:00+00:00", "FA25"),
        (datetime(2025, 9, 1), "FA25"),
    ],
)
def test_term_code_from_date(start_at: str | datetime, expected: str) -> None:
    assert term_code_from_date(start_at) == expected


@pytest.mark.parametrize("start_at", [None, "", "not-a-date", "2025-13-45"])
def test_term_code_from_date_returns_none_when_unusable(start_at: str | None) -> None:
    assert term_code_from_date(start_at) is None


def test_resolve_term_prefers_the_name_over_the_date() -> None:
    # A term named "Fall 2025" that (oddly) starts in February is still FA25.
    info = resolve_term("Fall 2025", "2026-02-01T00:00:00Z", term_id=7)
    assert info.code == "FA25"
    assert info.name == "Fall 2025"
    assert info.term_id == 7


def test_resolve_term_falls_back_to_the_start_date() -> None:
    info = resolve_term("Default Term", "2026-01-21T04:00:00Z")
    assert info.code == "WI26"


def test_resolve_term_falls_back_to_unknown() -> None:
    info = resolve_term("Default Term", None, term_id=1)
    assert info.code == UNKNOWN_TERM
    assert info.name == "Default Term"


def test_sort_key_orders_terms_chronologically() -> None:
    codes = ["FA25", "SP26", "WI26", "SU25", UNKNOWN_TERM, "FA24"]
    assert sorted(codes, key=sort_key) == [
        "FA24",
        "SU25",
        "FA25",
        "WI26",
        "SP26",
        UNKNOWN_TERM,
    ]
