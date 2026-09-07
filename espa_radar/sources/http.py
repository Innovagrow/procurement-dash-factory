"""Κοινός HTTP client: retries, backoff, ευγενικό rate limiting."""
from __future__ import annotations

import logging
import re
import threading
import time

import httpx

from ..config import settings

logger = logging.getLogger(__name__)

_last_request_at: dict[str, float] = {}
_lock = threading.Lock()

RETRYABLE_STATUS = {408, 425, 429, 500, 502, 503, 504}


def _throttle(host: str) -> None:
    """Τουλάχιστον `politeness_delay` δευτερόλεπτα μεταξύ αιτημάτων ανά host."""
    delay = settings.politeness_delay
    if delay <= 0:
        return
    with _lock:
        previous = _last_request_at.get(host, 0.0)
        wait = delay - (time.monotonic() - previous)
        if wait > 0:
            time.sleep(wait)
        _last_request_at[host] = time.monotonic()


def request(
    method: str,
    url: str,
    *,
    timeout: float | None = None,
    retries: int | None = None,
    **kwargs,
) -> httpx.Response:
    timeout = timeout or settings.http_timeout
    retries = settings.http_retries if retries is None else retries
    host = httpx.URL(url).host or url

    headers = {
        "User-Agent": settings.user_agent,
        "Accept-Language": "el-GR,el;q=0.9,en;q=0.6",
    }
    headers.update(kwargs.pop("headers", {}) or {})

    last_error: Exception | None = None
    for attempt in range(retries + 1):
        _throttle(host)
        try:
            with httpx.Client(timeout=timeout, follow_redirects=True) as client:
                response = client.request(method, url, headers=headers, **kwargs)
            if response.status_code in RETRYABLE_STATUS:
                raise httpx.HTTPStatusError(
                    f"HTTP {response.status_code}", request=response.request, response=response
                )
            response.raise_for_status()
            return response
        except Exception as exc:  # noqa: BLE001 - κάθε δικτυακό σφάλμα αξίζει retry
            last_error = exc
            if attempt >= retries:
                break
            backoff = min(2**attempt, 16)
            logger.warning("HTTP %s %s απέτυχε (%s) — retry σε %ss", method, url, exc, backoff)
            time.sleep(backoff)

    raise RuntimeError(f"Αποτυχία αιτήματος {method} {url}: {last_error}") from last_error


def get(url: str, **kwargs) -> httpx.Response:
    return request("GET", url, **kwargs)


# Παλιά ελληνικά κυβερνητικά sites σερβίρουν windows-1253 / ISO-8859-7, συχνά
# χωρίς σωστό charset στα headers. Αν τα διαβάσουμε ως UTF-8, παίρνουμε
# mojibake και όλη η εξαγωγή πεδίων καταρρέει σιωπηλά.
_META_CHARSET_RE = re.compile(rb"""charset=["']?\s*([\w\-]+)""", re.IGNORECASE)
_GREEK_FALLBACKS = ("utf-8", "windows-1253", "iso-8859-7", "cp1252")


def _decode(content: bytes, declared: str | None) -> str:
    """Αποκωδικοποίηση με σειρά: header → meta tag → ελληνικά fallbacks."""
    candidates: list[str] = []
    if declared and declared.lower() not in {"iso-8859-1", "ascii", "us-ascii"}:
        candidates.append(declared)

    match = _META_CHARSET_RE.search(content[:4096])
    if match:
        try:
            candidates.append(match.group(1).decode("ascii"))
        except UnicodeDecodeError:
            pass

    candidates.extend(_GREEK_FALLBACKS)

    seen: set[str] = set()
    for encoding in candidates:
        key = encoding.lower().strip()
        if key in seen:
            continue
        seen.add(key)
        try:
            return content.decode(key)
        except (UnicodeDecodeError, LookupError):
            continue

    return content.decode("utf-8", errors="replace")


def get_text(url: str, **kwargs) -> str:
    response = get(url, **kwargs)
    return _decode(response.content, response.charset_encoding)


def get_json(url: str, **kwargs) -> dict | list:
    return get(url, headers={"Accept": "application/json"}, **kwargs).json()
