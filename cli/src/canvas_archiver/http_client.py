"""A small, read-only HTTP client for the Canvas REST API.

This replaces ``canvasapi``. The library was a good fit while bearer tokens were
the only credential, but it owns its own ``requests`` session and offers no seam
for injecting a browser cookie jar. Writing the transport directly costs about
two hundred lines and buys three things the archive needs anyway: pagination we
can see, rate-limit handling we control, and a hard guarantee that no request
leaves this process with a method other than ``GET``.

Named ``http_client`` rather than ``http`` so it cannot shadow the standard
library package.

Read-only by construction
-------------------------
:class:`CanvasHTTP` exposes no ``post``, ``put``, ``patch`` or ``delete``, and
the single private method every request funnels through asserts the method is
``GET``. There is no configuration flag that relaxes this. "This tool never
writes to Canvas" is therefore a property of the code rather than a promise in
the README.
"""

from __future__ import annotations

import random
import re
import time
from typing import Any, Iterator

import httpx

from .auth import AuthMode, Credential, SessionExpiredError
from .log import get_logger

logger = get_logger("http")

#: Canvas's maximum page size. The default is 10, so omitting this turns one
#: request into ten.
MAX_PER_PAGE = 100

#: Requests are abandoned after this many seconds without a response.
DEFAULT_TIMEOUT = 30.0

#: How many times a retryable failure is retried before giving up.
DEFAULT_MAX_RETRIES = 5

#: First backoff interval, in seconds. Doubles each attempt, with jitter.
BACKOFF_BASE = 1.0

#: Backoff never waits longer than this between attempts.
BACKOFF_CAP = 60.0

#: When ``X-Rate-Limit-Remaining`` drops below this, slow down before Canvas
#: forces the issue. Canvas starts each token's bucket at roughly 700.
RATE_LIMIT_FLOOR = 100.0

#: Pause applied when the remaining quota is under :data:`RATE_LIMIT_FLOOR`.
RATE_LIMIT_PAUSE = 2.0

#: Canvas signals throttling with 403 and this phrase, not with 429.
_RATE_LIMIT_BODY = re.compile(r"rate limit exceeded", re.IGNORECASE)

#: One entry of an RFC 5988 ``Link`` header: ``<url>; rel="next"``.
_LINK_ENTRY = re.compile(r'<(?P<url>[^>]*)>\s*;\s*rel="(?P<rel>[^"]*)"')

_RETRYABLE_STATUSES = frozenset({429, 500, 502, 503, 504, 507})


class CanvasHTTPError(RuntimeError):
    """A request failed in a way the caller cannot recover from."""


class AuthenticationError(CanvasHTTPError):
    """Canvas rejected the credential."""


class NotFoundError(CanvasHTTPError):
    """Canvas returned 404. Often benign — a course with a feature disabled."""


class AccessDeniedError(CanvasHTTPError):
    """Canvas returned 403 for reasons other than rate limiting.

    The common cause is an instructor disabling a course tab. Collectors catch
    this and move on; one locked feature must not end a run.
    """


def parse_link_header(value: str | None) -> dict[str, str]:
    """Parse an RFC 5988 ``Link`` header into ``{rel: url}``.

    Canvas paginates every list endpoint this way, advertising ``current``,
    ``next``, ``prev``, ``first`` and ``last``. ``next`` is absent on the final
    page, which is how iteration knows to stop.

        >>> parse_link_header('<https://x/api/v1/courses?page=2>; rel="next"')
        {'next': 'https://x/api/v1/courses?page=2'}
    """
    if not value:
        return {}
    return {
        match.group("rel").lower(): match.group("url")
        for match in _LINK_ENTRY.finditer(value)
    }


def _looks_like_a_login_page(response: httpx.Response) -> bool:
    """Whether Canvas answered an API call with an HTML sign-in page.

    An expired session does not always produce a clean 401. Canvas may redirect
    to the identity provider, or serve the login page with status 200, which
    would otherwise be parsed as a bafflingly-shaped API response.
    """
    location = response.headers.get("location", "")
    if response.is_redirect and ("/login" in location or "shibboleth" in location.lower()):
        return True

    content_type = response.headers.get("content-type", "")
    if response.status_code == 200 and "html" in content_type.lower():
        return True

    return False


def _retry_delay(attempt: int, response: httpx.Response | None) -> float:
    """Seconds to wait before retry number *attempt* (0-based).

    Honours ``Retry-After`` when Canvas sends one; otherwise exponential
    backoff with full jitter, which avoids a thundering herd when several
    download workers are throttled at the same moment.
    """
    if response is not None:
        retry_after = response.headers.get("retry-after")
        if retry_after:
            try:
                return min(float(retry_after), BACKOFF_CAP)
            except ValueError:
                pass

    window = min(BACKOFF_BASE * (2**attempt), BACKOFF_CAP)
    return random.uniform(window / 2, window)


class CanvasHTTP:
    """A read-only, authenticated, paginating HTTP client for one Canvas host."""

    def __init__(
        self,
        base_url: str,
        credential: Credential,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        user_agent: str = "canvas-archiver",
    ) -> None:
        """Build the client. No request is made here.

        Args:
            base_url: Canvas base URL, e.g. ``https://canvas.cornell.edu``.
            credential: Bearer header or browser cookie jar, from
                :func:`canvas_archiver.auth.build_credential`.
            timeout: Per-request timeout in seconds.
            max_retries: Retries for throttling and transient server errors.
            user_agent: Sent on every request. Being identifiable is the polite
                thing to do when running an automated client.
        """
        self.base_url = base_url.rstrip("/")
        self.credential = credential
        self.max_retries = max_retries

        headers = {
            "Accept": "application/json+canvas-string-ids, application/json",
            "User-Agent": user_agent,
            **credential.headers,
        }
        self._client = httpx.Client(
            base_url=self.base_url,
            headers=headers,
            cookies=credential.cookies or None,
            timeout=timeout,
            # Redirects are inspected rather than followed: a redirect to the
            # identity provider is how an expired session announces itself.
            follow_redirects=False,
        )

    # -- lifecycle ---------------------------------------------------------- #

    def close(self) -> None:
        """Release the underlying connection pool."""
        self._client.close()

    def __enter__(self) -> "CanvasHTTP":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    # -- the single request path -------------------------------------------- #

    def _request(self, method: str, url: str, params: dict[str, Any] | None) -> httpx.Response:
        """Issue one request, with retries. The only place a request is made.

        Raises:
            AssertionError: If *method* is not ``GET``. This is the read-only
                guarantee, and it is deliberately not catchable configuration.
        """
        assert method == "GET", (
            f"canvas-archiver is read-only; refusing to issue {method}. "
            "This is a bug, not a setting."
        )

        last_error: Exception | None = None

        for attempt in range(self.max_retries + 1):
            try:
                response = self._client.request(method, url, params=params)
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                last_error = exc
                if attempt == self.max_retries:
                    break
                delay = _retry_delay(attempt, None)
                logger.warning(
                    "Network error on %s (%s); retrying in %.1fs [%d/%d]",
                    url, exc.__class__.__name__, delay, attempt + 1, self.max_retries,
                )
                time.sleep(delay)
                continue

            if self._is_throttled(response):
                if attempt == self.max_retries:
                    raise CanvasHTTPError(
                        f"Canvas is still rate-limiting after {self.max_retries} "
                        f"retries. Try again later, or lower CANVAS_DOWNLOAD_WORKERS."
                    )
                delay = _retry_delay(attempt, response)
                logger.warning(
                    "Rate limited by Canvas; waiting %.1fs [%d/%d]",
                    delay, attempt + 1, self.max_retries,
                )
                time.sleep(delay)
                continue

            if response.status_code in _RETRYABLE_STATUSES:
                if attempt == self.max_retries:
                    raise CanvasHTTPError(
                        f"Canvas returned {response.status_code} for {url} after "
                        f"{self.max_retries} retries."
                    )
                delay = _retry_delay(attempt, response)
                logger.warning(
                    "Canvas returned %d for %s; retrying in %.1fs [%d/%d]",
                    response.status_code, url, delay, attempt + 1, self.max_retries,
                )
                time.sleep(delay)
                continue

            self._check_for_expired_session(response)
            self._raise_for_status(response, url)
            self._throttle_if_low(response)
            return response

        raise CanvasHTTPError(f"Could not reach {url}: {last_error}")

    def _is_throttled(self, response: httpx.Response) -> bool:
        """Whether this response means "slow down".

        Canvas is unusual here: instead of 429 it typically returns **403** with
        ``403 Forbidden (Rate Limit Exceeded)`` in the body. A 403 therefore has
        to be read before it can be classified, since the same status also means
        an ordinary permission denial.
        """
        if response.status_code == 429:
            return True
        if response.status_code != 403:
            return False
        try:
            return bool(_RATE_LIMIT_BODY.search(response.text))
        except Exception:  # pragma: no cover - body already consumed/undecodable
            return False

    def _throttle_if_low(self, response: httpx.Response) -> None:
        """Pause pre-emptively when Canvas says the quota is nearly spent.

        Canvas decrements ``X-Rate-Limit-Remaining`` by each request's cost and
        refills it over time. Backing off before it hits zero is cheaper than
        being throttled and retrying.
        """
        raw = response.headers.get("x-rate-limit-remaining")
        if not raw:
            return
        try:
            remaining = float(raw)
        except ValueError:
            return
        if remaining < RATE_LIMIT_FLOOR:
            logger.debug(
                "Rate limit quota low (%.0f remaining); pausing %.1fs",
                remaining, RATE_LIMIT_PAUSE,
            )
            time.sleep(RATE_LIMIT_PAUSE)

    def _check_for_expired_session(self, response: httpx.Response) -> None:
        """Turn "your login is stale" into a clean, actionable stop."""
        expired = response.status_code == 401 or _looks_like_a_login_page(response)
        if not expired:
            return

        if self.credential.mode is AuthMode.SESSION:
            raise SessionExpiredError(
                "Your saved Canvas session has expired or been invalidated.\n"
                "Run `canvas-archive login` to sign in again, then re-run this "
                "command — it will pick up where it left off."
            )
        raise AuthenticationError(
            f"Canvas rejected the access token for {self.base_url}. "
            "It may be expired or revoked. Generate a new one under "
            "Account → Settings → Approved Integrations."
        )

    def _raise_for_status(self, response: httpx.Response, url: str) -> None:
        """Map remaining non-2xx responses onto the local exception types."""
        if response.is_success:
            return
        if response.status_code == 403:
            raise AccessDeniedError(f"Access denied by Canvas for {url}.")
        if response.status_code == 404:
            raise NotFoundError(f"Not found: {url}")
        if response.is_redirect:
            raise CanvasHTTPError(
                f"Unexpected redirect from {url} to "
                f"{response.headers.get('location', '<no location>')}"
            )
        raise CanvasHTTPError(f"Canvas returned {response.status_code} for {url}.")

    # -- public surface: GET and paginated GET ------------------------------ #

    def get(self, path: str, params: dict[str, Any] | None = None) -> httpx.Response:
        """Issue a single GET. *path* may be relative to the base URL or absolute."""
        return self._request("GET", path, params)

    def get_json(self, path: str, params: dict[str, Any] | None = None) -> Any:
        """GET *path* and decode the JSON body."""
        response = self.get(path, params)
        try:
            return response.json()
        except ValueError as exc:
            raise CanvasHTTPError(f"Canvas returned non-JSON content for {path}.") from exc

    def paginate(
        self,
        path: str,
        params: dict[str, Any] | None = None,
        *,
        per_page: int = MAX_PER_PAGE,
    ) -> Iterator[Any]:
        """Yield every item across every page of a Canvas list endpoint.

        Follows ``rel="next"`` from the ``Link`` header until it is absent.
        Pages are fetched lazily, so a caller that stops early stops the
        requests too.

        Args:
            path: Relative or absolute URL of a list endpoint.
            params: Query parameters for the first request. Subsequent requests
                use the URL Canvas supplies, which already carries them.
            per_page: Page size. Defaults to Canvas's maximum.

        Yields:
            Decoded items, in the order Canvas returned them.
        """
        request_params = dict(params or {})
        request_params.setdefault("per_page", per_page)

        url: str | None = path
        page = 0

        while url:
            page += 1
            response = self.get(url, request_params)
            # Canvas embeds the parameters in the `next` URL; sending them again
            # alongside it would duplicate every key.
            request_params = None

            try:
                payload = response.json()
            except ValueError as exc:
                raise CanvasHTTPError(
                    f"Canvas returned non-JSON content for {url}."
                ) from exc

            if isinstance(payload, dict):
                # A few endpoints wrap their list, e.g. /api/v1/planner/items.
                for key in ("items", "results", "data"):
                    if isinstance(payload.get(key), list):
                        payload = payload[key]
                        break
                else:
                    payload = [payload]

            yield from payload

            links = parse_link_header(response.headers.get("link"))
            url = links.get("next")
            if url:
                logger.debug("Following pagination to page %d of %s", page + 1, path)
