"""Derivation of short term codes (``FA25``, ``SP26``) from Canvas term data.

Canvas exposes an enrollment term per course, but institutions name those terms
inconsistently: Cornell alone produces values like ``"Fall 2025"``, ``"2025FA"``,
``"FA25"`` and the catch-all ``"Default Term"``. Since the term code becomes a
directory name at the top of the archive, it has to be short, stable and
collision-free across all of those spellings.

Resolution order:

1. Parse a season and year directly out of the term *name*.
2. Fall back to the term's ``start_at`` date, mapping month to season.
3. Fall back to :data:`UNKNOWN_TERM`.

This module is pure logic with no network or filesystem access, which makes it
straightforward to test.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime

#: Directory name used when a course's term cannot be identified at all.
UNKNOWN_TERM = "NOTERM"

#: Canonical two-letter season codes.
SEASONS: dict[str, str] = {
    "fall": "FA",
    "autumn": "FA",
    "fa": "FA",
    "spring": "SP",
    "sp": "SP",
    "summer": "SU",
    "su": "SU",
    "winter": "WI",
    "wi": "WI",
    "january": "WI",
    "jan": "WI",
}

#: Month number -> season code, used when only a start date is available.
#: Cornell's academic calendar: Jan is the winter session, Feb–May spring,
#: Jun–Jul summer, Aug–Dec fall.
_MONTH_TO_SEASON: dict[int, str] = {
    1: "WI",
    2: "SP",
    3: "SP",
    4: "SP",
    5: "SP",
    6: "SU",
    7: "SU",
    8: "FA",
    9: "FA",
    10: "FA",
    11: "FA",
    12: "FA",
}

_SEASON_ALTERNATION = "|".join(sorted(SEASONS, key=len, reverse=True))

# "Fall 2025", "Fall '25", "Fall 25", "FA25"
# No word boundary after the season group: "FA25" has none between "A" and "2",
# and the alternation is sorted longest-first so "fall" is tried before "fa".
_NAME_THEN_YEAR = re.compile(
    rf"\b({_SEASON_ALTERNATION})[\s\-_/]*'?(\d{{2,4}})\b",
    re.IGNORECASE,
)
# "2025FA", "2025 Fall", "25-SP"
_YEAR_THEN_NAME = re.compile(
    rf"\b(\d{{2,4}})[\s\-_/]*({_SEASON_ALTERNATION})\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class TermInfo:
    """A Canvas enrollment term reduced to what the archive needs.

    Attributes:
        code: Short directory-safe code, e.g. ``"FA25"`` or :data:`UNKNOWN_TERM`.
        name: The original Canvas term name, preserved for display and metadata.
        term_id: The Canvas enrollment term id, when known.
    """

    code: str
    name: str | None = None
    term_id: int | None = None


def _two_digit_year(raw: str) -> str:
    """Normalise a 2- or 4-digit year string to two digits (``"2025"`` -> ``"25"``)."""
    digits = raw.strip()
    return digits[-2:].zfill(2)


def term_code_from_name(name: str | None) -> str | None:
    """Extract a term code from a Canvas term name, or ``None`` if unparseable.

    Handles both orderings and a range of separators::

        "Fall 2025"  -> "FA25"
        "2025FA"     -> "FA25"
        "SP-26"      -> "SP26"
        "Default Term" -> None
    """
    if not name:
        return None

    match = _NAME_THEN_YEAR.search(name)
    if match:
        season, year = match.group(1), match.group(2)
        return f"{SEASONS[season.lower()]}{_two_digit_year(year)}"

    match = _YEAR_THEN_NAME.search(name)
    if match:
        year, season = match.group(1), match.group(2)
        return f"{SEASONS[season.lower()]}{_two_digit_year(year)}"

    return None


def term_code_from_date(when: datetime | date | str | None) -> str | None:
    """Derive a term code from a term start date, or ``None`` if unusable.

    Accepts the ISO-8601 strings Canvas returns (``"2025-08-25T04:00:00Z"``) as
    well as real ``datetime``/``date`` objects.
    """
    if when is None:
        return None

    if isinstance(when, str):
        text = when.strip()
        if not text:
            return None
        try:
            parsed: date = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        parsed = when

    season = _MONTH_TO_SEASON.get(parsed.month)
    if season is None:  # pragma: no cover - month is always 1..12
        return None
    return f"{season}{parsed.year % 100:02d}"


def resolve_term(
    name: str | None,
    start_at: datetime | date | str | None = None,
    term_id: int | None = None,
) -> TermInfo:
    """Resolve Canvas term data to a :class:`TermInfo` with a usable ``code``.

    Args:
        name: The Canvas term name, e.g. ``"Fall 2025"``.
        start_at: The term's start date, used only when the name is unparseable.
        term_id: The Canvas enrollment term id, carried through for metadata.

    Returns:
        A :class:`TermInfo` whose ``code`` is always a non-empty, directory-safe
        string — :data:`UNKNOWN_TERM` when nothing could be derived.
    """
    code = term_code_from_name(name) or term_code_from_date(start_at) or UNKNOWN_TERM
    return TermInfo(code=code, name=name, term_id=term_id)


def sort_key(code: str) -> tuple[int, int]:
    """Chronological sort key for term codes, oldest first.

    ``NOTERM`` sorts last. Within a year, seasons order winter → spring →
    summer → fall, matching how an academic year actually runs.
    """
    order = {"WI": 0, "SP": 1, "SU": 2, "FA": 3}
    match = re.fullmatch(r"([A-Z]{2})(\d{2})", code)
    if not match:
        return (9999, 9)
    season, year = match.group(1), int(match.group(2))
    return (year, order.get(season, 9))
