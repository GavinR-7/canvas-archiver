"""Mocked tests for the Canvas client wrapper.

Only the translation layer is tested here — turning whatever shape ``canvasapi``
hands back into a :class:`CourseSummary`. The network itself is not exercised;
that is what ``list-courses`` against a real account is for.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from canvasapi.exceptions import InvalidAccessToken

from canvas_archiver.client import (
    AuthenticationError,
    CanvasClient,
    to_course_summary,
)
from canvas_archiver.config import Config
from pathlib import Path


def _config() -> Config:
    return Config(
        api_url="https://canvas.example.edu",
        archive_root=Path("/tmp/archive-under-test"),
        _token="1234~secret",
    )


def test_to_course_summary_reads_a_fully_populated_course() -> None:
    course = SimpleNamespace(
        id=12345,
        name="Embedded Systems",
        course_code="ECE 3140",
        workflow_state="available",
        term={"id": 9, "name": "Fall 2025", "start_at": "2025-08-25T04:00:00Z"},
        teachers=[{"display_name": "Prof. Example"}],
        enrollments=[{"enrollment_state": "active", "type": "student"}],
    )

    summary = to_course_summary(course)

    assert summary.id == 12345
    assert summary.course_code == "ECE 3140"
    assert summary.term.code == "FA25"
    assert summary.term.term_id == 9
    assert summary.enrollment_state == "active"
    assert summary.teachers == ("Prof. Example",)
    assert summary.restricted is False
    assert summary.label == "ECE 3140 - Embedded Systems"


def test_to_course_summary_survives_a_bare_course() -> None:
    """Canvas omits almost everything for restricted courses; that must not crash."""
    course = SimpleNamespace(id=999, access_restricted_by_date=True)

    summary = to_course_summary(course)

    assert summary.id == 999
    assert summary.restricted is True
    assert summary.name == "Course 999"
    assert summary.term.code == "NOTERM"
    assert summary.teachers == ()
    assert summary.enrollment_state == "unknown"


def test_to_course_summary_falls_back_to_the_code_when_the_name_is_missing() -> None:
    course = SimpleNamespace(id=7, course_code="ECE 2300", name=None)
    assert to_course_summary(course).name == "ECE 2300"


def test_label_does_not_repeat_the_code_when_the_name_already_contains_it() -> None:
    course = SimpleNamespace(id=7, course_code="ECE 2300", name="ECE 2300 Digital Logic")
    assert to_course_summary(course).label == "ECE 2300 Digital Logic"


def test_term_accepts_an_object_as_well_as_a_dict() -> None:
    course = SimpleNamespace(
        id=1,
        name="X",
        course_code="X 100",
        term=SimpleNamespace(id=3, name="Spring 2026", start_at=None),
    )
    assert to_course_summary(course).term.code == "SP26"


def test_verify_translates_an_invalid_token_into_authentication_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = CanvasClient(_config())

    def boom() -> None:
        raise InvalidAccessToken(["Invalid access token."])

    monkeypatch.setattr(client._canvas, "get_current_user", boom)

    with pytest.raises(AuthenticationError, match="rejected the access token"):
        client.verify()


def test_verify_error_message_never_contains_the_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = CanvasClient(_config())

    def boom() -> None:
        raise InvalidAccessToken(["Invalid access token."])

    monkeypatch.setattr(client._canvas, "get_current_user", boom)

    with pytest.raises(AuthenticationError) as excinfo:
        client.verify()

    assert "1234~secret" not in str(excinfo.value)


def test_verify_returns_the_display_name(monkeypatch: pytest.MonkeyPatch) -> None:
    client = CanvasClient(_config())
    monkeypatch.setattr(
        client._canvas,
        "get_current_user",
        lambda: SimpleNamespace(id=1, name="Gavin Reis"),
    )

    assert client.verify() == "Gavin Reis"


def test_iter_courses_deduplicates_across_enrollment_states(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """--include-past queries several states; a course in two must appear once."""
    client = CanvasClient(_config())
    shared = SimpleNamespace(id=1, name="Shared", course_code="A 1", term=None)
    only_past = SimpleNamespace(id=2, name="Old", course_code="B 2", term=None)

    def fake_get_courses(**kwargs: object) -> list[SimpleNamespace]:
        if kwargs.get("enrollment_state") == "active":
            return [shared]
        return [shared, only_past]

    monkeypatch.setattr(client._canvas, "get_courses", fake_get_courses)

    ids = [c.id for c in client.iter_courses(include_past=True)]
    assert ids == [1, 2]
