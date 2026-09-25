"""Tests for the Canvas API client.

Two concerns: translating Canvas's conditionally-shaped JSON into dataclasses,
and asking for the right things on the right endpoints. The transport is mocked,
so these run offline.
"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from canvas_archiver.auth import AuthMode, Credential
from canvas_archiver.client import CanvasClient, to_course_summary
from canvas_archiver.config import Config


def _config(mode: AuthMode = AuthMode.TOKEN) -> Config:
    return Config(
        api_url="https://canvas.example.edu",
        archive_root=Path("/tmp/archive-under-test"),
        auth_mode=mode,
        _token="1234~secret",
    )


def _client(handler, mode: AuthMode = AuthMode.TOKEN) -> CanvasClient:
    credential = (
        Credential(mode=AuthMode.TOKEN, headers={"Authorization": "Bearer 1234~secret"})
        if mode is AuthMode.TOKEN
        else Credential(mode=AuthMode.SESSION, cookies={"canvas_session": "abc"})
    )
    client = CanvasClient(_config(mode), credential=credential)
    client.http._client = httpx.Client(
        base_url=client.api_url,
        cookies=credential.cookies or None,
        follow_redirects=False,
        transport=httpx.MockTransport(handler),
    )
    return client


# --- JSON -> dataclass ------------------------------------------------------ #


def test_reads_a_fully_populated_course() -> None:
    course = {
        "id": 12345,
        "name": "Embedded Systems",
        "course_code": "ECE 3140",
        "workflow_state": "available",
        "term": {"id": 9, "name": "Fall 2025", "start_at": "2025-08-25T04:00:00Z"},
        "teachers": [{"display_name": "Prof. Example"}],
        "enrollments": [{"enrollment_state": "active", "type": "student"}],
    }

    summary = to_course_summary(course)

    assert summary.id == 12345
    assert summary.course_code == "ECE 3140"
    assert summary.term.code == "FA25"
    assert summary.term.term_id == 9
    assert summary.enrollment_state == "active"
    assert summary.teachers == ("Prof. Example",)
    assert summary.restricted is False
    assert summary.label == "ECE 3140 - Embedded Systems"


def test_survives_a_bare_restricted_course() -> None:
    """Canvas omits almost everything for restricted courses; that must not crash."""
    summary = to_course_summary({"id": 999, "access_restricted_by_date": True})

    assert summary.id == 999
    assert summary.restricted is True
    assert summary.name == "Course 999"
    assert summary.term.code == "NOTERM"
    assert summary.teachers == ()
    assert summary.enrollment_state == "unknown"


def test_explicit_nulls_are_treated_as_absent() -> None:
    """Canvas sends `"name": null` rather than omitting the key. Same thing."""
    summary = to_course_summary(
        {"id": 7, "course_code": "ECE 2300", "name": None, "term": None, "teachers": None}
    )

    assert summary.name == "ECE 2300"
    assert summary.term.code == "NOTERM"
    assert summary.teachers == ()


def test_label_does_not_repeat_the_code_already_in_the_name() -> None:
    summary = to_course_summary(
        {"id": 7, "course_code": "ECE 2300", "name": "ECE 2300 Digital Logic"}
    )
    assert summary.label == "ECE 2300 Digital Logic"


# --- endpoints -------------------------------------------------------------- #


def test_verify_hits_users_self_and_returns_the_name() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        return httpx.Response(200, json={"id": 1, "name": "Gavin Reis"})

    assert _client(handler).verify() == "Gavin Reis"
    assert seen == ["/api/v1/users/self"]


def test_list_courses_requests_the_term_include() -> None:
    """Without include[]=term only an opaque id comes back, and the archive's
    directory names depend on the term name and start date."""
    captured: list[httpx.URL] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request.url)
        return httpx.Response(200, json=[])

    _client(handler).list_courses()

    includes = captured[0].params.get_list("include[]")
    assert "term" in includes
    assert "teachers" in includes
    assert captured[0].params["enrollment_state"] == "active"


def test_include_past_queries_three_states_and_deduplicates() -> None:
    states: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        state = request.url.params.get("enrollment_state", "")
        states.append(state)
        shared = {"id": 1, "name": "Shared", "course_code": "A 1"}
        if state == "active":
            return httpx.Response(200, json=[shared])
        return httpx.Response(200, json=[shared, {"id": 2, "name": "Old", "course_code": "B 2"}])

    courses = _client(handler).list_courses(include_past=True)

    assert states == ["active", "completed", "invited_or_pending"]
    assert [c.id for c in courses] == [1, 2]


def test_a_403_on_one_enrollment_state_does_not_kill_the_listing() -> None:
    """One broken state must never end the run."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.params.get("enrollment_state") == "completed":
            return httpx.Response(403, text="user not authorized")
        return httpx.Response(200, json=[{"id": 1, "name": "Fine", "course_code": "A 1"}])

    courses = _client(handler).list_courses(include_past=True)

    assert [c.id for c in courses] == [1]


def test_courses_are_collected_across_pages() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.params.get("page") != "2":
            return httpx.Response(
                200,
                json=[{"id": 1, "name": "One", "course_code": "A 1"}],
                headers={
                    "Link": '<https://canvas.example.edu/api/v1/courses?page=2>; rel="next"'
                },
            )
        return httpx.Response(200, json=[{"id": 2, "name": "Two", "course_code": "B 2"}])

    assert [c.id for c in _client(handler).list_courses()] == [1, 2]


# --- auth description ------------------------------------------------------- #


def test_describe_auth_redacts_the_token() -> None:
    client = _client(lambda r: httpx.Response(200, json={}), AuthMode.TOKEN)

    described = client.describe_auth()

    assert described == "bearer token 1234~...cret"
    assert "1234~secret" not in described


def test_describe_auth_never_mentions_cookie_values() -> None:
    client = _client(lambda r: httpx.Response(200, json={}), AuthMode.SESSION)

    assert client.describe_auth() == "browser session (1 cookies)"
