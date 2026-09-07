"""Γενική πηγή RSS/Atom. Καλύπτει τα περισσότερα ελληνικά sites χρηματοδότησης."""
from __future__ import annotations

import logging
from datetime import datetime, timezone

import feedparser

from ..textutils import parse_date, strip_html
from .base import RawProgram, Source, SourceError
from .http import get

logger = logging.getLogger(__name__)


def _entry_datetime(entry) -> datetime | None:
    for key in ("published_parsed", "updated_parsed"):
        parsed = entry.get(key)
        if parsed:
            try:
                return datetime(*parsed[:6], tzinfo=timezone.utc)
            except (TypeError, ValueError):
                continue
    for key in ("published", "updated", "date"):
        value = entry.get(key)
        if value:
            found = parse_date(value)
            if found:
                return found
    return None


class RssSource(Source):
    """options: url (υποχρεωτικό), limit, deadline_from_text."""

    def fetch(self) -> list[RawProgram]:
        url = self.options.get("url")
        if not url:
            raise SourceError(f"[{self.source_id}] λείπει το 'url'")

        # Κατεβάζουμε με τον κοινό client (retries + UA) και δίνουμε bytes στο feedparser.
        try:
            response = get(url)
        except Exception as exc:  # noqa: BLE001
            raise SourceError(f"[{self.source_id}] αποτυχία λήψης feed: {exc}") from exc

        feed = feedparser.parse(response.content)
        if feed.bozo and not feed.entries:
            raise SourceError(f"[{self.source_id}] μη έγκυρο feed: {feed.bozo_exception}")

        limit = int(self.options.get("limit", 100))
        results: list[RawProgram] = []

        for entry in feed.entries[:limit]:
            title = strip_html(entry.get("title"))
            link = entry.get("link") or entry.get("id")
            if not title or not link:
                continue

            summary = strip_html(entry.get("summary") or entry.get("description"))
            content = ""
            for block in entry.get("content", []) or []:
                content += " " + strip_html(block.get("value"))

            blob = f"{title} {summary} {content}"
            results.append(
                RawProgram(
                    source_id=self.source_id,
                    source_name=self.name,
                    external_id=entry.get("id") or link,
                    title=title,
                    url=link,
                    summary=summary or None,
                    body=content.strip() or None,
                    published_at=_entry_datetime(entry),
                    deadline=self._deadline(blob),
                    extra={"tags": [t.get("term") for t in entry.get("tags", []) or [] if t.get("term")]},
                )
            )

        logger.info("[%s] %s εγγραφές από RSS", self.source_id, len(results))
        return results

    def _deadline(self, blob: str) -> datetime | None:
        if not self.options.get("deadline_from_text", True):
            return None
        from ..extract import extract_deadline

        return extract_deadline(blob)
