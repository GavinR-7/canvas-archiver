"""Tests for the raw HTTP transport.

The interesting behaviour here is pagination, the read-only guarantee, and
response classification — Canvas's habit of signalling throttling with 403
rather than 429 makes the last of those genuinely easy to get wrong.

``httpx.MockTransport`` is used rather than a real server, so these run offline.
"""

from __future__ import annotations

import inspect

import httpx
import pytest

from canvas_archiver.auth import AuthMode, Credential, SessionExpiredError
from canvas_archiver.http_client import (
    AccessDeniedError,
    AuthenticationError,
    CanvasHTTP,
    CanvasHTTPError,
    CredentialScopeError,
    NotFoundError,
    ReadOnlyViolationError,
    parse_link_header,
    validate_credential_target,
)

BASE = "https://canvas.example.edu"


@pytest.fixture(autouse=True)
def no_real_sleeping(monkeypatch: pytest.MonkeyPatch) -> None:
    """Backoff delays are computed and then not actually waited out.

    The retry logic is still exercised in full; only the wall-clock cost is
    removed, which keeps the suite fast enough to run on every save.
    """
    monkeypatch.setattr("canvas_archiver.http_client.time.sleep", lambda _: None)


def _client(handler, *, mode: AuthMode = AuthMode.TOKEN, max_retries: int = 0) -> CanvasHTTP:
    """Build a CanvasHTTP whose transport is a mock."""
    credential = (
        Credential(mode=AuthMode.TOKEN, headers={"Authorization": "Bearer 1234~secret"})
        if mode is AuthMode.TOKEN
        else Credential(mode=AuthMode.SESSION, cookies={"canvas_session": "abc"})
    )
    client = CanvasHTTP(BASE, credential, max_retries=max_retries)
    client._client = httpx.Client(
        base_url=BASE,
        headers=dict(client._client.headers),
        cookies=credential.cookies or None,
        follow_redirects=False,
        transport=httpx.MockTransport(handler),
    )
    return client


# --- Link header parsing ---------------------------------------------------- #


def test_parse_link_header_extracts_every_rel() -> None:
    header = (
        '<https://x/api/v1/courses?page=1&per_page=100>; rel="current",'
        '<https://x/api/v1/courses?page=2&per_page=100>; rel="next",'
        '<https://x/api/v1/courses?page=1&per_page=100>; rel="first",'
        '<https://x/api/v1/courses?page=9&per_page=100>; rel="last"'
    )

    links = parse_link_header(header)

    assert links["next"] == "https://x/api/v1/courses?page=2&per_page=100"
    assert set(links) == {"current", "next", "first", "last"}


@pytest.mark.parametrize("header", [None, "", "garbage", "<no-rel-here>"])
def test_parse_link_header_survives_junk(header: str | None) -> None:
    assert parse_link_header(header) == {}


def test_parse_link_header_is_case_insensitive_on_rel() -> None:
    assert parse_link_header('<https://x/2>; rel="NEXT"') == {"next": "https://x/2"}


# --- read-only guarantee ---------------------------------------------------- #


def test_client_exposes_no_mutating_verbs() -> None:
    """The read-only promise should be visible in the public surface."""
    for verb in ("post", "put", "patch", "delete", "head", "options"):
        assert not hasattr(CanvasHTTP, verb), f"CanvasHTTP must not expose .{verb}()"


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE", "get"])
def test_non_get_methods_are_refused_even_internally(method: str) -> None:
    client = _client(lambda request: httpx.Response(200, json={}))

    with pytest.raises(ReadOnlyViolationError, match="read-only"):
        client._request(method, "/api/v1/courses", None)


def test_the_read_only_guard_is_not_an_assert() -> None:
    """`python -O` strips assert statements, which would delete the guarantee
    in exactly the build most likely to run unattended. So it must be a real
    raise, and its exception must not be AssertionError."""
    client = _client(lambda request: httpx.Response(200, json={}))

    with pytest.raises(ReadOnlyViolationError) as excinfo:
        client._request("POST", "/api/v1/courses", None)

    assert not isinstance(excinfo.value, AssertionError)

    source = inspect.getsource(CanvasHTTP._request)
    assert "raise ReadOnlyViolationError" in source
    assert "assert method" not in source


def test_read_only_violation_is_not_swallowed_as_an_api_error() -> None:
    """It is a bug in this codebase, not a condition Canvas produced, so it
    must not be caught by handlers that skip failed resources."""
    assert not issubclass(ReadOnlyViolationError, CanvasHTTPError)


def test_every_request_is_a_get() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.method)
        return httpx.Response(200, json=[{"id": 1}])

    client = _client(handler)
    list(client.paginate("/api/v1/courses"))

    assert seen == ["GET"]


# --- pagination ------------------------------------------------------------- #


def test_paginate_follows_the_next_link_to_the_end() -> None:
    pages = {
        "1": (
            [{"id": 1}, {"id": 2}],
            f'<{BASE}/api/v1/courses?page=2>; rel="next"',
        ),
        "2": ([{"id": 3}], f'<{BASE}/api/v1/courses?page=3>; rel="next"'),
        "3": ([{"id": 4}], None),  # no next -> stop
    }

    def handler(request: httpx.Request) -> httpx.Response:
        page = request.url.params.get("page", "1")
        body, link = pages[page]
        headers = {"Link": link} if link else {}
        return httpx.Response(200, json=body, headers=headers)

    client = _client(handler)

    assert [item["id"] for item in client.paginate("/api/v1/courses")] == [1, 2, 3, 4]


def test_paginate_requests_the_maximum_page_size() -> None:
    captured: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request.url.params.get("per_page"))
        return httpx.Response(200, json=[])

    client = _client(handler)
    list(client.paginate("/api/v1/courses"))

    assert captured == ["100"]


def test_paginate_does_not_resend_params_on_the_next_page() -> None:
    """Canvas embeds the query in the `next` URL; resending duplicates keys."""
    requests: list[httpx.URL] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request.url)
        if "page" not in request.url.params:
            return httpx.Response(
                200,
                json=[{"id": 1}],
                headers={"Link": f'<{BASE}/api/v1/courses?page=2&per_page=100>; rel="next"'},
            )
        return httpx.Response(200, json=[{"id": 2}])

    client = _client(handler)
    list(client.paginate("/api/v1/courses", {"enrollment_state": "active"}))

    assert requests[1].params.get_list("per_page") == ["100"]
    assert "enrollment_state" not in requests[1].params


def test_paginate_is_lazy() -> None:
    """Stopping early should stop the requests too."""
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            200,
            json=[{"id": calls}],
            headers={"Link": f'<{BASE}/api/v1/courses?page={calls + 1}>; rel="next"'},
        )

    client = _client(handler)
    first = next(iter(client.paginate("/api/v1/courses")))

    assert first == {"id": 1}
    assert calls == 1


def test_paginate_unwraps_endpoints_that_nest_their_list() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"items": [{"id": 1}, {"id": 2}]})

    client = _client(handler)

    assert [i["id"] for i in client.paginate("/api/v1/planner/items")] == [1, 2]


# --- response classification ------------------------------------------------ #


def test_403_with_rate_limit_body_is_retried_not_raised() -> None:
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(403, text="403 Forbidden (Rate Limit Exceeded)")
        return httpx.Response(200, json={"id": 1})

    client = _client(handler, max_retries=3)
    client._client = httpx.Client(
        base_url=BASE, follow_redirects=False, transport=httpx.MockTransport(handler)
    )

    assert client.get_json("/api/v1/users/self") == {"id": 1}
    assert attempts == 2


def test_403_without_rate_limit_body_is_an_access_error() -> None:
    client = _client(lambda r: httpx.Response(403, text="user not authorized"))

    with pytest.raises(AccessDeniedError):
        client.get_json("/api/v1/courses/1/files")


def test_404_is_its_own_error_type() -> None:
    client = _client(lambda r: httpx.Response(404, text="not found"))

    with pytest.raises(NotFoundError):
        client.get_json("/api/v1/courses/1/front_page")


def test_401_in_token_mode_is_an_authentication_error() -> None:
    client = _client(lambda r: httpx.Response(401, json={}), mode=AuthMode.TOKEN)

    with pytest.raises(AuthenticationError, match="rejected the access token"):
        client.get_json("/api/v1/users/self")


def test_401_in_session_mode_tells_you_to_log_in_again() -> None:
    client = _client(lambda r: httpx.Response(401, json={}), mode=AuthMode.SESSION)

    with pytest.raises(SessionExpiredError, match="canvas-archive login"):
        client.get_json("/api/v1/users/self")


def test_redirect_to_the_identity_provider_means_the_session_expired() -> None:
    """An expired Canvas session redirects to login rather than returning 401."""
    client = _client(
        lambda r: httpx.Response(302, headers={"Location": f"{BASE}/login/saml"}),
        mode=AuthMode.SESSION,
    )

    with pytest.raises(SessionExpiredError):
        client.get_json("/api/v1/users/self")


def test_html_login_page_with_status_200_is_caught_too() -> None:
    """Canvas sometimes serves the login page with a 200, which would otherwise
    be parsed as a bafflingly-shaped API response."""
    client = _client(
        lambda r: httpx.Response(
            200, text="<html><body>Sign in</body></html>",
            headers={"Content-Type": "text/html; charset=utf-8"},
        ),
        mode=AuthMode.SESSION,
    )

    with pytest.raises(SessionExpiredError):
        client.get_json("/api/v1/users/self")


def test_500_is_retried_then_given_up_on() -> None:
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(500, text="boom")

    client = _client(handler, max_retries=2)
    client._client = httpx.Client(
        base_url=BASE, follow_redirects=False, transport=httpx.MockTransport(handler)
    )

    with pytest.raises(CanvasHTTPError, match="500"):
        client.get_json("/api/v1/users/self")
    assert attempts == 3  # initial + 2 retries


def test_the_token_never_appears_in_an_error_message() -> None:
    client = _client(lambda r: httpx.Response(401, json={}), mode=AuthMode.TOKEN)

    with pytest.raises(AuthenticationError) as excinfo:
        client.get_json("/api/v1/users/self")

    assert "1234~secret" not in str(excinfo.value)


# --- credentials only go to the configured Canvas --------------------------- #
#
# Canvas hands us URLs that we then follow: the `Link` header's `next` is an
# absolute URL chosen by the server. A compromised or misconfigured Canvas
# could point it anywhere, and the client would obligingly send the bearer
# token or session cookie along. These tests hold that door shut.


CANVAS = "https://canvas.cornell.edu"


@pytest.mark.parametrize(
    "url",
    [
        "https://canvas.cornell.edu/api/v1/users/self",
        "https://canvas.cornell.edu:443/api/v1/users/self",  # explicit default port
        "https://CANVAS.CORNELL.EDU/api/v1/users/self",  # DNS is case-insensitive
        "https://canvas.cornell.edu/api/v1/courses?page=2&per_page=100",
    ],
)
def test_validate_accepts_the_configured_host(url: str) -> None:
    assert validate_credential_target(url, CANVAS) == url


@pytest.mark.parametrize(
    ("url", "why"),
    [
        ("https://evil.example.com/api/v1/users/self", "a different host"),
        ("https://canvas.cornell.edu.evil.com/api/v1", "a suffix-matching host"),
        ("https://evil.canvas.cornell.edu/api/v1", "a subdomain"),
        ("https://canvas.cornell.edu:8443/api/v1", "a different port"),
        ("http://canvas.cornell.edu/api/v1", "plain HTTP"),
        ("file:///etc/passwd", "a non-HTTP scheme"),
        ("ftp://canvas.cornell.edu/x", "a non-HTTP scheme"),
        ("https:///api/v1/users/self", "no host at all"),
    ],
)
def test_validate_refuses_everything_else(url: str, why: str) -> None:
    with pytest.raises(CredentialScopeError):
        validate_credential_target(url, CANVAS)


def test_subdomains_are_rejected_because_cookies_would_reach_them() -> None:
    """A cookie scoped to .cornell.edu would be sent to any subdomain, so an
    attacker controlling one could collect it. Different origin, no exception."""
    with pytest.raises(CredentialScopeError, match="Refusing to send Canvas credentials"):
        validate_credential_target("https://evil.canvas.cornell.edu/api/v1", CANVAS)


def test_loopback_may_use_plain_http_so_tests_can_run_locally() -> None:
    for base in ("http://localhost:8080", "http://127.0.0.1:9000"):
        assert validate_credential_target(f"{base}/api/v1/users/self", base)


def test_loopback_exemption_does_not_leak_to_other_hosts() -> None:
    """The HTTP exemption is per-host, not a global 'allow http' switch."""
    with pytest.raises(CredentialScopeError, match="plain HTTP"):
        validate_credential_target("http://canvas.cornell.edu/api/v1", "http://localhost:8080")


def test_a_malformed_port_is_rejected_rather_than_ignored() -> None:
    with pytest.raises(CredentialScopeError, match="Malformed port"):
        validate_credential_target("https://canvas.cornell.edu:notaport/api", CANVAS)


def test_constructor_rejects_a_plain_http_canvas_url() -> None:
    """Caught at startup, not on the first request that leaks over it."""
    credential = Credential(mode=AuthMode.TOKEN, headers={"Authorization": "Bearer x"})

    with pytest.raises(CredentialScopeError, match="plain HTTP"):
        CanvasHTTP("http://canvas.cornell.edu", credential)


def test_an_absolute_off_host_url_is_refused_before_the_request_is_made() -> None:
    sent: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(200, json={})

    client = _client(handler)

    with pytest.raises(CredentialScopeError):
        client.get_json("https://evil.example.com/api/v1/users/self")

    # The decisive assertion: nothing left the process.
    assert sent == []


def test_a_pagination_link_pointing_off_host_stops_the_run() -> None:
    """The attack this guards against: Canvas controls the `next` URL."""
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        return httpx.Response(
            200,
            json=[{"id": 1}],
            headers={"Link": '<https://evil.example.com/steal?p=2>; rel="next"'},
        )

    client = _client(handler)

    with pytest.raises(CredentialScopeError, match="pagination link pointing off-host"):
        list(client.paginate("/api/v1/courses"))

    # The first page was fetched from Canvas; the second was never attempted.
    assert len(requested) == 1
    assert requested[0].startswith(BASE)


def test_a_same_host_pagination_link_is_still_followed() -> None:
    """The guard must not break ordinary pagination."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.params.get("page") != "2":
            return httpx.Response(
                200,
                json=[{"id": 1}],
                headers={"Link": f'<{BASE}/api/v1/courses?page=2>; rel="next"'},
            )
        return httpx.Response(200, json=[{"id": 2}])

    client = _client(handler)

    assert [item["id"] for item in client.paginate("/api/v1/courses")] == [1, 2]
