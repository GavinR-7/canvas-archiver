"""Thin wrapper around :mod:`canvasapi`.

``canvasapi`` handles authentication (a ``Bearer`` header on every request) and
Link-header pagination, but it raises a family of exceptions and returns objects
whose attributes are conditionally present. This module is the single place
where that messiness is absorbed, so the rest of the package deals only with
plain dataclasses.

REST endpoints used here
------------------------
* :meth:`CanvasClient.verify` -> ``GET /api/v1/users/self`` — confirms the token
  is valid and tells us who it belongs to.
* :meth:`CanvasClient.list_courses` -> ``GET /api/v1/courses`` with
  ``include[]=term``, ``include[]=teachers``, ``include[]=total_students`` and an
  ``enrollment_state`` filter. Canvas paginates this endpoint via the ``Link``
  header; ``canvasapi``'s ``PaginatedList`` follows ``rel="next"`` transparently.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterator

from canvasapi import Canvas
from canvasapi.exceptions import (
    CanvasException,
    Forbidden,
    InvalidAccessToken,
    ResourceDoesNotExist,
    Unauthorized,
)

from .config import Config
from .log import get_logger
from .terms import TermInfo, resolve_term

logger = get_logger("client")

#: Enrollment states requested for a normal run versus an ``--include-past`` run.
ACTIVE_STATES = ("active",)
PAST_STATES = ("active", "completed", "invited_or_pending")


class CanvasClientError(RuntimeError):
    """A Canvas API failure that the CLI should report and exit on."""


class AuthenticationError(CanvasClientError):
    """The token is missing, expired, revoked, or for the wrong Canvas host."""


@dataclass(frozen=True)
class CourseSummary:
    """A Canvas course reduced to the fields the archiver needs.

    Attributes:
        id: Canvas course id.
        name: Full course name, e.g. ``"Embedded Systems"``. Falls back to the
            course code when Canvas withholds the name.
        course_code: Short code, e.g. ``"ECE 3140"``.
        term: Resolved enrollment term.
        enrollment_state: ``"active"``, ``"completed"``, ``"invited"``, etc.
        workflow_state: Canvas course state — ``"available"``, ``"unpublished"``,
            ``"completed"``.
        restricted: ``True`` when Canvas returned the course with
            ``access_restricted_by_date``, meaning content is not readable.
        teachers: Instructor display names, when Canvas includes them.
        raw: The underlying ``canvasapi`` object, for collectors that need more.
    """

    id: int
    name: str
    course_code: str
    term: TermInfo
    enrollment_state: str = "unknown"
    workflow_state: str = "unknown"
    restricted: bool = False
    teachers: tuple[str, ...] = ()
    raw: Any = field(default=None, repr=False, compare=False)

    @property
    def label(self) -> str:
        """Human-readable ``"ECE 3140 - Embedded Systems"`` style label."""
        if self.course_code and self.course_code not in self.name:
            return f"{self.course_code} - {self.name}"
        return self.name


def _attr(obj: Any, name: str, default: Any = None) -> Any:
    """``getattr`` that tolerates canvasapi objects with absent attributes."""
    value = getattr(obj, name, default)
    return default if value is None else value


def _extract_term(course: Any) -> TermInfo:
    """Resolve a course's term from the ``include[]=term`` payload."""
    term = _attr(course, "term", None)
    if term is None:
        return resolve_term(None, None, _attr(course, "enrollment_term_id", None))

    if isinstance(term, dict):
        name = term.get("name")
        start_at = term.get("start_at")
        term_id = term.get("id")
    else:
        name = _attr(term, "name", None)
        start_at = _attr(term, "start_at", None)
        term_id = _attr(term, "id", None)

    return resolve_term(name, start_at, term_id)


def _extract_teachers(course: Any) -> tuple[str, ...]:
    """Pull instructor display names out of the ``include[]=teachers`` payload."""
    teachers = _attr(course, "teachers", []) or []
    names: list[str] = []
    for teacher in teachers:
        if isinstance(teacher, dict):
            name = teacher.get("display_name") or teacher.get("name")
        else:
            name = _attr(teacher, "display_name", None) or _attr(teacher, "name", None)
        if name:
            names.append(str(name))
    return tuple(names)


def _extract_enrollment_state(course: Any) -> str:
    """Return the enrollment state for *this* user on the course."""
    enrollments = _attr(course, "enrollments", []) or []
    for enrollment in enrollments:
        state = (
            enrollment.get("enrollment_state")
            if isinstance(enrollment, dict)
            else _attr(enrollment, "enrollment_state", None)
        )
        if state:
            return str(state)
    return "unknown"


def to_course_summary(course: Any) -> CourseSummary:
    """Convert a ``canvasapi`` course object into a :class:`CourseSummary`.

    Courses outside their availability window come back with
    ``access_restricted_by_date`` set and almost no other fields; those are
    flagged rather than dropped, so the CLI can show the user why a course is
    missing from the archive.
    """
    restricted = bool(_attr(course, "access_restricted_by_date", False))
    course_code = str(_attr(course, "course_code", "") or "")
    name = str(_attr(course, "name", "") or course_code or f"Course {course.id}")

    return CourseSummary(
        id=int(course.id),
        name=name,
        course_code=course_code,
        term=_extract_term(course),
        enrollment_state=_extract_enrollment_state(course),
        workflow_state=str(_attr(course, "workflow_state", "unknown")),
        restricted=restricted,
        teachers=_extract_teachers(course),
        raw=course,
    )


class CanvasClient:
    """Authenticated handle on a Canvas instance.

    The client is constructed from a :class:`~canvas_archiver.config.Config` and
    holds exactly one ``canvasapi.Canvas`` session for the life of a run.
    """

    def __init__(self, config: Config) -> None:
        """Build the underlying ``canvasapi`` session. No network call is made here."""
        self.config = config
        self._canvas = Canvas(config.api_url, config.token)

    @property
    def api_url(self) -> str:
        """The Canvas base URL this client talks to."""
        return self.config.api_url

    def verify(self) -> str:
        """Confirm the token works and return the account's display name.

        Hits ``GET /api/v1/users/self``, which is the cheapest authenticated
        request Canvas offers and therefore the right smoke test.

        Raises:
            AuthenticationError: The token was rejected.
            CanvasClientError: Any other API or transport failure.
        """
        try:
            user = self._canvas.get_current_user()
        except (InvalidAccessToken, Unauthorized) as exc:
            raise AuthenticationError(
                f"Canvas rejected the access token for {self.api_url}. "
                "It may be expired, revoked, or issued by a different Canvas host. "
                "Generate a new one under Account → Settings → Approved Integrations."
            ) from exc
        except CanvasException as exc:
            raise CanvasClientError(f"Canvas API error contacting {self.api_url}: {exc}") from exc
        except Exception as exc:  # network / DNS / TLS
            raise CanvasClientError(f"Could not reach {self.api_url}: {exc}") from exc

        return str(_attr(user, "name", None) or _attr(user, "short_name", None) or f"user {user.id}")

    def iter_courses(self, *, include_past: bool = False) -> Iterator[CourseSummary]:
        """Yield every course visible to the token, newest terms last.

        Args:
            include_past: Also include concluded enrollments and pending
                invitations, not just active ones.

        Yields:
            :class:`CourseSummary` objects, including restricted ones so the
            caller can report them.

        Raises:
            AuthenticationError: The token was rejected.
            CanvasClientError: Any other API or transport failure.
        """
        states = PAST_STATES if include_past else ACTIVE_STATES
        seen: set[int] = set()

        for state in states:
            try:
                courses = self._canvas.get_courses(
                    enrollment_state=state,
                    include=["term", "teachers", "total_students"],
                    per_page=100,
                )
                for course in courses:
                    course_id = int(getattr(course, "id", 0) or 0)
                    if not course_id or course_id in seen:
                        continue
                    seen.add(course_id)
                    yield to_course_summary(course)
            except (InvalidAccessToken, Unauthorized) as exc:
                raise AuthenticationError(
                    f"Canvas rejected the access token for {self.api_url}."
                ) from exc
            except (Forbidden, ResourceDoesNotExist) as exc:
                # One enrollment state being unavailable must not kill the run.
                logger.warning("Skipping enrollment_state=%s: %s", state, exc)
                continue
            except CanvasException as exc:
                raise CanvasClientError(f"Canvas API error listing courses: {exc}") from exc

    def list_courses(self, *, include_past: bool = False) -> list[CourseSummary]:
        """Eagerly collect :meth:`iter_courses` into a list."""
        return list(self.iter_courses(include_past=include_past))
