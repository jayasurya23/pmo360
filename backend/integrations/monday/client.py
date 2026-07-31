"""Thin GraphQL client for the monday.com API.

monday exposes a single POST endpoint that takes a GraphQL document. Two
behaviours make a naive ``requests.post`` unsafe here, and this module exists
to absorb both:

1. **HTTP 200 with errors.** monday returns 200 for GraphQL-level failures,
   putting the problem in an ``errors`` array. Anything that only checks
   ``raise_for_status()`` silently treats a failed query as an empty result —
   which, for a KPI dashboard, renders as "zero" rather than "broken".

2. **Complexity budgeting.** Rate limiting is a per-minute complexity budget,
   not a request count. Exceeding it returns ``COMPLEXITY_BUDGET_EXHAUSTED``
   with a reset hint; the fix is to wait it out, not to retry immediately.

The transport is injected so the parser and KPI layers can be exercised
against recorded fixtures with no network — see
``scripts/monday_selftest.py``.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Callable, Optional, Protocol

from config import monday_api_token, monday_config

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------- errors
class MondayError(RuntimeError):
    """Base class for every monday.com failure surfaced by this package."""


class MondayAuthError(MondayError):
    """Token missing, malformed, or lacking scope for the requested board."""


class MondayRateLimitError(MondayError):
    """Complexity budget exhausted or too many requests.

    ``retry_after_seconds`` carries monday's own reset hint when it gives one,
    so callers can surface a real wait time instead of guessing.
    """

    def __init__(self, message: str, retry_after_seconds: Optional[float] = None):
        super().__init__(message)
        self.retry_after_seconds = retry_after_seconds


class MondayQueryError(MondayError):
    """The GraphQL document was rejected — bad field, bad board id, etc."""


# ---------------------------------------------------------------- transport
class Transport(Protocol):
    """Minimal seam over HTTP so tests can supply canned responses."""

    def post(self, url: str, *, json: dict, headers: dict, timeout: float) -> "Response":
        ...


class Response(Protocol):
    status_code: int

    def json(self) -> Any: ...

    @property
    def headers(self) -> dict: ...


class RequestsTransport:
    """Default transport. ``requests`` is already a dependency (msal + Graph)."""

    def post(self, url: str, *, json: dict, headers: dict, timeout: float):
        import requests

        return requests.post(url, json=json, headers=headers, timeout=timeout)


# ---------------------------------------------------------------- client
# monday signals a spent complexity budget through these codes. They are
# retryable after a wait; everything else is a hard failure.
_RATE_LIMIT_CODES = {
    "COMPLEXITY_BUDGET_EXHAUSTED",
    "RATE_LIMIT_EXCEEDED",
    "DAILY_LIMIT_EXCEEDED",
}
_AUTH_CODES = {"UNAUTHENTICATED", "FORBIDDEN", "NOT_AUTHENTICATED"}


class MondayClient:
    """Executes GraphQL documents against monday.com.

    Construct via :func:`get_monday_client` so configuration stays in one
    place. Pass ``transport`` to test without network access.
    """

    def __init__(
        self,
        token: str,
        *,
        api_url: str,
        api_version: str,
        timeout_seconds: float = 30.0,
        max_retries: int = 3,
        transport: Optional[Transport] = None,
        sleep: Callable[[float], None] = time.sleep,
    ):
        if not token:
            raise MondayAuthError("monday.com API token is empty.")
        self._token = token
        self._api_url = api_url
        self._api_version = api_version
        self._timeout = timeout_seconds
        self._max_retries = max(0, max_retries)
        self._transport = transport or RequestsTransport()
        self._sleep = sleep

    # -- internals -------------------------------------------------------
    def _headers(self) -> dict:
        return {
            "Authorization": self._token,
            "API-Version": self._api_version,
            "Content-Type": "application/json",
        }

    @staticmethod
    def _classify(errors: list) -> MondayError:
        """Map a GraphQL ``errors`` array onto one of our exception types."""
        codes, messages = set(), []
        for err in errors:
            if not isinstance(err, dict):
                messages.append(str(err))
                continue
            messages.append(str(err.get("message", err)))
            ext = err.get("extensions") or {}
            code = ext.get("code") or err.get("error_code")
            if code:
                codes.add(str(code).upper())
            # Some responses put the HTTP-ish status only in extensions.
            if ext.get("status_code") in (401, 403):
                codes.add("FORBIDDEN")

        detail = "; ".join(messages) or "unknown monday.com error"
        if codes & _RATE_LIMIT_CODES:
            return MondayRateLimitError(detail)
        if codes & _AUTH_CODES:
            return MondayAuthError(detail)
        return MondayQueryError(detail)

    @staticmethod
    def _retry_after(headers: Any) -> Optional[float]:
        try:
            raw = (headers or {}).get("Retry-After")
        except AttributeError:
            return None
        if raw is None:
            return None
        try:
            return float(raw)
        except (TypeError, ValueError):
            return None

    # -- public ----------------------------------------------------------
    def execute(self, query: str, variables: Optional[dict] = None) -> dict:
        """Run a GraphQL document and return its ``data`` payload.

        Retries only what is genuinely transient: HTTP 429 and monday's
        complexity-budget errors. A malformed query fails on the first
        attempt — retrying it would just burn budget.
        """
        payload = {"query": query, "variables": variables or {}}
        attempt = 0

        while True:
            resp = self._transport.post(
                self._api_url,
                json=payload,
                headers=self._headers(),
                timeout=self._timeout,
            )

            status = getattr(resp, "status_code", 200)
            retry_after = self._retry_after(getattr(resp, "headers", None))

            if status in (401, 403):
                raise MondayAuthError(
                    f"monday.com rejected the API token (HTTP {status}). "
                    "Check MONDAY_API_TOKEN and that it can read the board."
                )

            if status == 429:
                err: MondayError = MondayRateLimitError(
                    "monday.com rate limit hit (HTTP 429).", retry_after
                )
            elif status >= 500:
                err = MondayError(f"monday.com server error (HTTP {status}).")
            else:
                try:
                    body = resp.json()
                except (ValueError, TypeError) as exc:
                    raise MondayError(
                        f"monday.com returned a non-JSON body (HTTP {status})."
                    ) from exc

                if not isinstance(body, dict):
                    raise MondayError("monday.com returned an unexpected payload shape.")

                # HTTP 200 with a populated `errors` array is the common
                # failure mode — treat it as an error, never as empty data.
                errors = body.get("errors") or body.get("error_message")
                if errors:
                    if isinstance(errors, str):
                        errors = [{"message": errors}]
                    err = self._classify(errors)
                    if not isinstance(err, MondayRateLimitError):
                        raise err
                    err.retry_after_seconds = err.retry_after_seconds or retry_after
                else:
                    data = body.get("data")
                    if data is None:
                        raise MondayError(
                            "monday.com response contained neither data nor errors."
                        )
                    return data

            # Only rate limits and 5xx reach here — both worth retrying.
            if attempt >= self._max_retries:
                raise err
            wait = (
                getattr(err, "retry_after_seconds", None)
                or retry_after
                # monday's complexity budget refills on a ~60s window, so back
                # off in real seconds rather than the usual sub-second ladder.
                or min(60.0, 2.0 ** attempt * 5.0)
            )
            logger.warning(
                "monday.com call failed (%s); retrying in %.1fs (attempt %d/%d)",
                err, wait, attempt + 1, self._max_retries,
            )
            self._sleep(wait)
            attempt += 1


def get_monday_client(transport: Optional[Transport] = None) -> MondayClient:
    """Build a client from environment config.

    Raises :class:`MondayAuthError` when no token is configured — callers that
    should degrade instead of failing must check ``config.monday_is_configured``
    first.
    """
    cfg = monday_config()
    try:
        token = monday_api_token()
    except RuntimeError as exc:
        raise MondayAuthError(str(exc)) from exc

    return MondayClient(
        token,
        api_url=cfg["api_url"],
        api_version=cfg["api_version"],
        timeout_seconds=cfg["timeout_seconds"],
        max_retries=cfg["max_retries"],
        transport=transport,
    )
