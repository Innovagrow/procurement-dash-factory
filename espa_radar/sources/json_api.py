"""Γενική πηγή JSON API — για portals που εκθέτουν δομημένα δεδομένα."""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from ..textutils import parse_date, strip_html
from .base import RawProgram, Source, SourceError
from .http import get_json

logger = logging.getLogger(__name__)


def _dig(obj: Any, path: str | None) -> Any:
    """Διαδρομή τύπου 'data.items.0.title' μέσα σε dict/list."""
    if not path:
        return None
    current = obj
    for part in path.split("."):
        if current is None:
            return None
        if isinstance(current, list):
            try:
                current = current[int(part)]
            except (ValueError, IndexError):
                # Μη αριθμητικό βήμα πάνω σε λίστα: παίρνουμε το πρώτο στοιχείο.
                if current and isinstance(current[0], dict):
                    current = current[0].get(part)
                    continue
                return None
        elif isinstance(current, dict):
            current = current.get(part)
        else:
            return None
    return current


def _coerce_date(value: Any, date_format: str) -> datetime | None:
    """Δέχεται epoch ms/s, ISO string, ή λίστα από αυτά."""
    if value is None:
        return None
    if isinstance(value, list):
        value = value[0] if value else None
        if value is None:
            return None

    if date_format in {"epoch_ms", "epoch_s"} or isinstance(value, (int, float)):
        try:
            number = float(value)
        except (TypeError, ValueError):
            return None
        if date_format == "epoch_s" or (date_format == "auto" and number < 1e11):
            number *= 1000
        try:
            return datetime.fromtimestamp(number / 1000, tz=timezone.utc)
        except (ValueError, OSError, OverflowError):
            return None

    return parse_date(str(value))


def _flatten(item: dict, prefix: str = "") -> dict:
    """Επίπεδο dict για χρήση σε url_template (π.χ. {identifier})."""
    flat: dict[str, Any] = {}
    for key, value in item.items():
        name = f"{prefix}{key}"
        if isinstance(value, (str, int, float)):
            flat[name] = value
        elif isinstance(value, dict):
            flat.update(_flatten(value, f"{name}."))
    return flat


class JsonApiSource(Source):
    """options:
    url, params, items_path, limit, base_url
    fields: {title, url, summary, body, id, published, deadline}
    url_template: π.χ. "https://site/topic/{identifier}" (όταν δεν υπάρχει έτοιμο link)
    date_format: auto | epoch_ms | epoch_s
    sort_by: πεδίο ταξινόμησης (παίρνει τα νεότερα πρώτα)
    """

    def fetch(self) -> list[RawProgram]:
        url = self.options.get("url")
        if not url:
            raise SourceError(f"[{self.source_id}] λείπει το 'url'")

        try:
            payload = get_json(url, params=self.options.get("params") or None)
        except Exception as exc:  # noqa: BLE001
            raise SourceError(f"[{self.source_id}] αποτυχία JSON API: {exc}") from exc

        items_path = self.options.get("items_path")
        items = _dig(payload, items_path) if items_path else payload
        if isinstance(items, dict):
            items = items.get("items") or items.get("results") or items.get("data") or []
        if not isinstance(items, list):
            raise SourceError(f"[{self.source_id}] μη αναμενόμενη δομή απάντησης")

        fields = self.options.get("fields") or {}
        date_format = self.options.get("date_format", "auto")
        sort_by = self.options.get("sort_by")

        if sort_by:
            items = sorted(
                items,
                key=lambda item: _coerce_date(_dig(item, sort_by), date_format) or datetime.min.replace(tzinfo=timezone.utc),
                reverse=True,
            )

        base_url = self.options.get("base_url", "")
        url_template = self.options.get("url_template")
        results: list[RawProgram] = []

        from ..extract import extract_deadline

        for item in items[: int(self.options.get("limit", 100))]:
            if not isinstance(item, dict):
                continue

            title = strip_html(str(_dig(item, fields.get("title", "title")) or ""))
            if not title:
                continue

            link = _dig(item, fields.get("url", "url"))
            if not link and url_template:
                try:
                    link = url_template.format(**_flatten(item))
                except (KeyError, IndexError, ValueError):
                    link = None
            if not link:
                continue
            link = str(link)
            if base_url and not link.startswith("http"):
                link = base_url.rstrip("/") + "/" + link.lstrip("/")

            summary = strip_html(str(_dig(item, fields.get("summary", "summary")) or ""))
            body = strip_html(str(_dig(item, fields.get("body", "description")) or ""))
            blob = f"{title} {summary} {body}"

            deadline = _coerce_date(_dig(item, fields.get("deadline", "deadline")), date_format)

            results.append(
                RawProgram(
                    source_id=self.source_id,
                    source_name=self.name,
                    external_id=str(_dig(item, fields.get("id", "id")) or link),
                    title=title[:590],
                    url=link,
                    summary=summary or None,
                    body=body or None,
                    published_at=_coerce_date(
                        _dig(item, fields.get("published", "publishedAt")), date_format
                    ),
                    deadline=deadline or extract_deadline(blob),
                    status_hint=str(_dig(item, fields.get("status", "status")) or "") or None,
                )
            )

        self._enrich_details(results)
        logger.info("[%s] %s εγγραφές από JSON API", self.source_id, len(results))
        return results

    def _enrich_details(self, programs: list[RawProgram]) -> None:
        max_details = int(self.options.get("max_details", 0))
        if max_details <= 0:
            return

        from ..extract import extract_deadline
        from .detail import fetch_detail_text

        selector = self.options.get("detail_body")
        for program in programs[:max_details]:
            # Μόνο όταν το API δεν έδωσε ήδη αρκετό κείμενο.
            if program.body and len(program.body) > 400:
                continue
            text = fetch_detail_text(program.url, selector)
            if not text:
                continue
            program.body = text
            program.deadline = program.deadline or extract_deadline(text)
