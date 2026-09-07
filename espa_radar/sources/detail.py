"""Κοινή λήψη πλήρους κειμένου από σελίδα λεπτομερειών."""
from __future__ import annotations

import logging

from bs4 import BeautifulSoup

from ..textutils import strip_html
from .http import get_text

logger = logging.getLogger(__name__)

# Στοιχεία που δεν προσθέτουν πληροφορία και μπερδεύουν την εξαγωγή πεδίων.
_NOISE = "script, style, nav, header, footer, aside, .menu, .navigation, .cookie, .breadcrumb"

DEFAULT_SELECTORS = ("article", "main", ".entry-content", ".content", "#content", "body")


def fetch_detail_text(url: str, selector: str | None = None, max_chars: int = 20000) -> str | None:
    """Κατεβάζει τη σελίδα και επιστρέφει καθαρό κείμενο, ή None σε αποτυχία."""
    try:
        html = get_text(url)
    except Exception as exc:  # noqa: BLE001 - μια σελίδα που δεν ανοίγει δεν είναι σφάλμα πηγής
        logger.debug("Παράλειψη λεπτομερειών %s: %s", url, exc)
        return None

    soup = BeautifulSoup(html, "lxml")
    for node in soup.select(_NOISE):
        node.decompose()

    selectors = ([selector] if selector else []) + list(DEFAULT_SELECTORS)
    for candidate in selectors:
        node = soup.select_one(candidate)
        if node is None:
            continue
        text = strip_html(node.get_text(" ", strip=True))
        if len(text) >= 120:
            return text[:max_chars]
    return None
