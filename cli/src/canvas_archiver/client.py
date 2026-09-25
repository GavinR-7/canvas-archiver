"""Canvas API client: endpoint knowledge on top of the raw HTTP transport.

:mod:`canvas_archiver.http_client` knows how to make an authenticated,
paginated, rate-limit-aware GET. This module knows *which* GETs to make and how
to turn the JSON into dataclasses the rest of the package can rely on.

Canvas returns objects whose fields are conditionally present — a course outside
its availability window arrives with ``access_restricted_by_date`` and almost
nothing else — so conversion happens once, here, at the boundary.

REST endpoints used here
------------------------
* :meth:`CanvasClient.verify` -> ``GET /api/v1/users/self``
* :meth:`CanvasClient.iter_courses` -> ``GET /api/v1/courses`` with
  ``include[]=term``, ``include[]=teachers``, ``include[]=total_students`` and an
  ``enrollment_state`` filter, paginated via the ``Link`` header.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterator

from .auth import AuthMode, Credential, SessionExpiredError, build_credential
from .config import Config
from .http_client import (
    AccessDeniedError,
    AuthenticationError,
    CanvasHTTP,
    CanvasHTTPError,
    NotFoundError,
)
from .log import get_logger
from .terms import TermInfo, resolve_term

logger = get_logger("client")

#: Enrollment states requested for a normal run versus an ``--include-past`` run.
ACTIVE_STATES = ("active",)
PAST_STATES = ("active", "completed", "invited_or_pending")

# Re-exported so callers can catch client failures without importing the
# transport module directly.
CanvasClientError = CanvasHTTPError

__all__ = [
    "CanvasClient",
    "CanvasClientError",
    "CourseSummary",
    "AuthenticationError",
    "SessionExpiredError",
    "AccessDeniedError",
    "NotFoundError",
    "to_course_summary",
]


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
        raw: The decoded JSON object, for collectors that need more fields.
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


def _get(obj: Any, key: str, default: Any = None) -> Any:
    """Read *key* from a decoded JSON object, tolerating absence and null."""
    if not isinstance(obj, dict):
        return default
    value = obj.get(key, default)
    return default if value is None else value


def _extract_term(course: dict[str, Any]) -> TermInfo:
    """Resolve a course's term from the ``include[]=term`` payload."""
    term = _get(course, "term")
    if not isinstance(term, dict):
        return resolve_term(None, None, _get(course, "enrollment_term_id"))
    return resolve_term(
        _get(term, "name"), _get(term, "start_at"), _get(term, "id")
    )


def _extract_teachers(course: dict[str, Any]) -> tuple[str, ...]:
    """Pull instructor display names out of the ``include[]=teachers`` payload."""
    names: list[str] = []
    for teacher in _get(course, "teachers", []) or []:
        name = _get(teacher, "display_name") or _get(teacher, "name")
        if name:
            names.append(str(name))
    return tuple(names)


def _extract_enrollment_state(course: dict[str, Any]) -> str:
    """Return the enrollment state for *this* user on the course."""
    for enrollment in _get(course, "enrollments", []) or []:
        state = _get(enrollment, "enrollment_state")
        if state:
            return str(state)
    return "unknown"


def to_course_summary(course: dict[str, Any]) -> CourseSummary:
    """Convert a decoded Canvas course object into a :class:`CourseSummary`.

    Courses outside their availability window come back with
    ``access_restricted_by_date`` set and almost no other fields; those are
    flagged rather than dropped, so the CLI can show the user why a course is
    missing from the archive.
    """
    course_id = int(_get(course, "id", 0) or 0)
    restricted = bool(_get(course, "access_restricted_by_date", False))
    course_code = str(_get(course, "course_code", "") or "")
    name = str(_get(course, "name", "") or course_code or f"Course {course_id}")

    return CourseSummary(
        id=course_id,
        name=name,
        course_code=course_code,
        term=_extract_term(course),
        enrollment_state=_extract_enrollment_state(course),
        workflow_state=str(_get(course, "workflow_state", "unknown")),
        restricted=restricted,
        teachers=_extract_teachers(course),
        raw=course,
    )


class CanvasClient:
    """Authenticated, read-only handle on a Canvas instance."""

    def __init__(self, config: Config, credential: Credential | None = None) -> None:
        """Build the client.

        Args:
            config: Resolved runtime configuration.
            credential: Pre-built credential. When ``None``, one is assembled
                from ``config.auth_mode`` — which may raise
                :class:`SessionExpiredError` if no saved login exists.

        Raises:
            AuthError: Token mode with no token.
            SessionExpiredError: Session mode with no usable saved session.
        """
        self.config = config
        self.credential = credential or build_credential(
            config.auth_mode, token=config.token, api_url=config.api_url
        )
        self.http = CanvasHTTP(config.api_url, self.credential)

    @property
    def api_url(self) -> str:
        """The Canvas base URL this client talks to."""
        return self.config.api_url

    def close(self) -> None:
        """Release the underlying connection pool."""
        self.http.close()

    def __enter__(self) -> "CanvasClient":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def describe_auth(self) -> str:
        """A safe-to-print description of how this client is authenticating."""
        if self.credential.mode is AuthMode.TOKEN:
            return f"bearer token {self.config.redacted_token()}"
        return self.credential.describe()

    def verify(self) -> str:
        """Confirm the credential works and return the account's display name.

        Hits ``GET /api/v1/users/self``, the cheapest authenticated request
        Canvas offers and therefore the right smoke test.

        Raises:
            AuthenticationError: A bearer token was rejected.
            SessionExpiredError: A saved browser session was rejected.
            CanvasClientError: Any other API or transport failure.
        """
        user = self.http.get_json("/api/v1/users/self")
        return str(
            _get(user, "name")
            or _get(user, "short_name")
            or f"user {_get(user, 'id', '?')}"
        )

    def iter_courses(self, *, include_past: bool = False) -> Iterator[CourseSummary]:
        """Yield every course visible to the credential.

        Args:
            include_past: Also include concluded enrollments and pending
                invitations, not just active ones.

        Yields:
            :class:`CourseSummary` objects, including restricted ones so the
            caller can report them.
        """
        states = PAST_STATES if include_past else ACTIVE_STATES
        seen: set[int] = set()

        for state in states:
            try:
                courses = self.http.paginate(
                    "/api/v1/courses",
                    {
                        "enrollment_state": state,
                        "include[]": ["term", "teachers", "total_students"],
                    },
                )
                for course in courses:
                    course_id = int(_get(course, "id", 0) or 0)
                    if not course_id or course_id in seen:
                        continue
                    seen.add(course_id)
                    yield to_course_summary(course)
            except (AccessDeniedError, NotFoundError) as exc:
                # One enrollment state being unavailable must not kill the run.
                logger.warning("Skipping enrollment_state=%s: %s", state, exc)
                continue

    def list_courses(self, *, include_past: bool = False) -> list[CourseSummary]:
        """Eagerly collect :meth:`iter_courses` into a list."""
        return list(self.iter_courses(include_past=include_past))
