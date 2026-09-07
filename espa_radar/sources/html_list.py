"""Γενική πηγή HTML: λίστα προσκλήσεων μέσω CSS selectors."""
from __future__ import annotations

import logging
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from ..textutils import strip_html
from .base import RawProgram, Source, SourceError
from .http import get_text

logger = logging.getLogger(__name__)


def _select_text(node, selector: str | None) -> str:
    if not selector:
        return ""
    found = node.select_one(selector)
    return strip_html(found.get_text(" ", strip=True)) if found else ""


class HtmlListSource(Source):
    """options:
    url            – σελίδα λίστας (υποχρεωτικό)
    item           – CSS selector για κάθε εγγραφή (υποχρεωτικό)
    title          – selector τίτλου μέσα στην εγγραφή
    link           – selector <a> (default: το πρώτο <a>)
    summary        – selector περίληψης
    meta           – selector με ημερομηνίες/κατάσταση
    pages          – λίστα επιπλέον URLs (pagination) ή πρότυπο με {page}
    page_range     – [από, έως] όταν χρησιμοποιείται πρότυπο
    detail_body    – selector για πλήρες κείμενο στη σελίδα λεπτομερειών
    max_details    – πόσες σελίδες λεπτομερειών να ανοίξει (default 0)
    """

    def fetch(self) -> list[RawProgram]:
        urls = self._urls()
        if not urls:
            raise SourceError(f"[{self.source_id}] λείπει το 'url'")

        item_selector = self.options.get("item")
        if not item_selector:
            raise SourceError(f"[{self.source_id}] λείπει το 'item' selector")

        results: list[RawProgram] = []
        seen: set[str] = set()

        for page_url in urls:
            try:
                html = get_text(page_url)
            except Exception as exc:  # noqa: BLE001
                logger.warning("[%s] αποτυχία σελίδας %s: %s", self.source_id, page_url, exc)
                continue

            soup = BeautifulSoup(html, "lxml")
            nodes = soup.select(item_selector)
            if not nodes:
                logger.warning("[%s] ο selector '%s' δεν βρήκε τίποτα στο %s",
                               self.source_id, item_selector, page_url)
                continue

            for node in nodes:
                program = self._parse_node(node, page_url)
                if program and program.url not in seen:
                    seen.add(program.url)
                    results.append(program)

        if not results:
            raise SourceError(f"[{self.source_id}] καμία εγγραφή — πιθανή αλλαγή στη δομή της σελίδας")

        self._enrich_details(results)
        logger.info("[%s] %s εγγραφές από HTML", self.source_id, len(results))
        return results

    # -- helpers -----------------------------------------------------------

    def _urls(self) -> list[str]:
        base = self.options.get("url")
        if not base:
            return []
        urls = [base]
        pages = self.options.get("pages")
        if isinstance(pages, list):
            urls.extend(pages)
        elif isinstance(pages, str) and "{page}" in pages:
            start, end = self.options.get("page_range", [2, 3])
            urls.extend(pages.format(page=p) for p in range(int(start), int(end) + 1))
        return urls

    def _parse_node(self, node, page_url: str) -> RawProgram | None:
        link_node = node.select_one(self.options["link"]) if self.options.get("link") else node.find("a")
        if link_node is None and node.name == "a":
            link_node = node
        href = link_node.get("href") if link_node is not None else None
        if not href:
            return None
        url = urljoin(page_url, href)

        title = _select_text(node, self.options.get("title"))
        if not title and link_node is not None:
            title = strip_html(link_node.get_text(" ", strip=True))
        if not title:
            return None

        summary = _select_text(node, self.options.get("summary"))
        meta = _select_text(node, self.options.get("meta"))
        blob = " ".join(filter(None, [title, summary, meta]))

        from ..extract import extract_deadline, extract_published

        return RawProgram(
            source_id=self.source_id,
            source_name=self.name,
            external_id=url,
            title=title,
            url=url,
            summary=summary or None,
            body=meta or None,
            published_at=extract_published(meta) or extract_published(summary),
            deadline=extract_deadline(blob),
            status_hint=meta or None,
        )

    def _enrich_details(self, programs: list[RawProgram]) -> None:
        """Ανοίγει σελίδες λεπτομερειών για πιο ακριβή εξαγωγή (προαιρετικό)."""
        selector = self.options.get("detail_body")
        max_details = int(self.options.get("max_details", 0))
        if not selector or max_details <= 0:
            return

        from ..extract import extract_deadline
        from .detail import fetch_detail_text

        for program in programs[:max_details]:
            text = fetch_detail_text(program.url, selector)
            if not text:
                continue
            program.body = text
            program.deadline = program.deadline or extract_deadline(text)
