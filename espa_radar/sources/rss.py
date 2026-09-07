"""Γενική πηγή RSS/Atom. Καλύπτει τα περισσότερα ελληνικά sites χρηματοδότησης."""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone

import feedparser

from ..textutils import parse_date, strip_html
from .base import RawProgram, Source, SourceError
from .http import get

logger = logging.getLogger(__name__)


# Χαρακτήρες που απαγορεύονται στο XML 1.0 αλλά εμφανίζονται σε feeds που
# παράγονται με string concatenation — αρκούν για να πέσει όλος ο parser.
_ILLEGAL_XML = re.compile(
    rb"[\x00-\x08\x0b\x0c\x0e-\x1f]"
)
_BARE_AMP = re.compile(rb"&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,7}|#[0-9]{1,7}|#x[0-9a-fA-F]{1,6});)")


def _parse_tolerantly(content: bytes):
    """Διαβάζει το feed· αν το XML είναι χαλασμένο, το καθαρίζει και ξαναδοκιμάζει.

    Πολλά ελληνικά δημόσια feeds έχουν ασυνόδευτα «&» ή χαρακτήρες ελέγχου,
    που κάνουν τον αυστηρό parser να επιστρέψει μηδέν εγγραφές. Το περιεχόμενο
    όμως είναι μια χαρά — απλώς θέλει καθάρισμα.
    """
    feed = feedparser.parse(content)
    if feed.entries:
        return feed

    cleaned = _ILLEGAL_XML.sub(b"", content)
    cleaned = _BARE_AMP.sub(b"&amp;", cleaned)
    repaired = feedparser.parse(cleaned)
    if repaired.entries:
        logger.info("Το feed χρειάστηκε καθάρισμα XML (%s εγγραφές)", len(repaired.entries))
        return repaired

    # Τελευταία λύση: ανεκτικός HTML parser που αγνοεί τη δομή.
    try:
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(cleaned, "html.parser")
        items = soup.find_all(["item", "entry"])
        if items:
            logger.info("Το feed διαβάστηκε με ανεκτικό parser (%s εγγραφές)", len(items))
            return _SoupFeed(items)
    except Exception as exc:  # noqa: BLE001
        logger.debug("Απέτυχε και ο ανεκτικός parser: %s", exc)

    return repaired


class _SoupEntry(dict):
    """Εγγραφή feed με το ίδιο dict-like API που περιμένει ο κώδικας."""

    def __init__(self, node):
        super().__init__()
        def text(*names):
            for name in names:
                found = node.find(name)
                if found is not None and found.get_text(strip=True):
                    return found.get_text(" ", strip=True)
            return None
        link = text("link", "guid", "id")
        if not link:
            anchor = node.find("link")
            link = anchor.get("href") if anchor is not None else None
        self.update({
            "title": text("title"),
            "link": link,
            "summary": text("description", "summary", "content"),
            "published": text("pubdate", "published", "updated", "date"),
            "id": text("guid", "id") or link,
            "content": [],
            "tags": [],
        })


class _SoupFeed:
    bozo = 1
    bozo_exception = "διαβάστηκε με ανεκτικό parser"

    def __init__(self, nodes):
        self.entries = [_SoupEntry(n) for n in nodes]


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

        feed = _parse_tolerantly(response.content)
        if not feed.entries:
            raise SourceError(
                f"[{self.source_id}] μη έγκυρο feed: {getattr(feed, 'bozo_exception', 'χωρίς εγγραφές')}"
            )

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
