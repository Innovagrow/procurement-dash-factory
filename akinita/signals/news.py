# -*- coding: utf-8 -*-
"""
Development news per area, from RSS.

This signal is different in kind from the other two. Tourism and public works
produce a dense number for every region; news produces a thin stream of named
events - a hotel sold, a marina tendered, a motorway extended. One snapshot of a
feed holds about thirty items, so a single run says almost nothing about any
given area.

It earns its place by accumulating. Every run appends to a local archive, so
after a few weeks of scheduled runs the archive - not the feed - is the signal.
Treat a fresh install as empty and let it fill.
"""
from __future__ import annotations

import html as html_module
import json
import math
import os
import re
from typing import Dict, Iterable, List, Optional, Tuple

from ..http import FetchError
from .base import SignalProvider, SignalReading
from .regions import GREEK_REGIONS, normalise_greek, region_for

# newmoney.gr disallows /feed/ in its robots.txt, so it is not shipped as a
# default. Add any feed you have the right to read via the `feeds` argument.
DEFAULT_FEEDS = (
    "https://www.naftemporiki.gr/feed/",
)

# Weighted by how directly the event moves nearby property values.
# A trailing "*" means "match this stem and whatever follows"; without it the
# term must match a whole word. That distinction is not cosmetic: "τραμ" as a
# substring matches "Τραμπ", and a tram line and a US president are not the
# same signal.
DEVELOPMENT_KEYWORDS: Dict[str, float] = {
    "μετρό": 3.0, "αεροδρόμι*": 3.0, "μαρίνα*": 2.5, "λιμάν*": 2.2,
    "αναπλάσ*": 2.4, "τραμ": 2.2,   # one stem only - two overlapping keys double-count
    "οδικός άξονας": 2.0, "αυτοκινητόδρομ*": 2.0,
    "επένδυσ*": 1.8, "ξενοδοχεί*": 1.8, "τουριστικ*": 1.5,
    "φοιτητικ*": 1.5, "πανεπιστήμι*": 1.5, "νοσοκομεί*": 1.4,
    "εμπορικό κέντρο": 1.8, "logistics": 1.6, "data center": 1.8,
    "ΕΣΠΑ": 1.4, "ταμείο ανάκαμψης": 1.6,
    "φωτοβολταϊκ*": 1.0, "αιολικ*": 0.8,
    "κτηματολόγι*": 0.8, "χρήσεις γης": 1.6, "πολεοδομικ*": 1.4,
    "golden visa": 1.6, "βραχυχρόνια μίσθωση": 1.4,
}

_ITEM_RE = re.compile(r"<item\b.*?</item>", re.S | re.I)
_TAG_RE = re.compile(r"<[^>]+>")


def _compile_keywords(keywords: Dict[str, float]):
    """Word-boundary patterns over accent-stripped text."""
    compiled = []
    for keyword, weight in keywords.items():
        stem = keyword.endswith("*")
        term = normalise_greek(keyword.rstrip("*"))
        pattern = r"(?<!\w)" + re.escape(term) + (r"\w*" if stem else r"(?!\w)")
        compiled.append((re.compile(pattern), keyword.rstrip("*"), weight))
    return compiled


_KEYWORD_PATTERNS = _compile_keywords(DEVELOPMENT_KEYWORDS)


def _field(block: str, tag: str) -> str:
    match = re.search(rf"<{tag}\b[^>]*>(.*?)</{tag}>", block, re.S | re.I)
    if not match:
        return ""
    text = match.group(1)
    text = re.sub(r"^\s*<!\[CDATA\[(.*?)\]\]>\s*$", r"\1", text, flags=re.S)
    return html_module.unescape(_TAG_RE.sub(" ", text)).strip()


class NewsSignal(SignalProvider):
    key = "news"
    name = "Ειδήσεις ανάπτυξης ανά περιοχή"
    source_url = ", ".join(DEFAULT_FEEDS)
    licence = "Δημόσιες ροές RSS — έλεγχος όρων κάθε εκδότη πριν από αναδημοσίευση"
    cadence = "συνεχής· απαιτεί συσσώρευση για να γίνει χρήσιμο"

    def __init__(self, fetcher, feeds: Iterable[str] = DEFAULT_FEEDS,
                 archive_path: str = os.path.join(".cache", "akinita", "news_archive.jsonl"),
                 place_names: Optional[Iterable[str]] = None):
        super().__init__(fetcher)
        self.feeds = list(feeds)
        self.archive_path = archive_path
        self.place_names = list(place_names or [])
        self._items: List[dict] = []
        self._by_area: Dict[str, List[dict]] = {}
        self._intensity: Dict[str, float] = {}

    # ------------------------------------------------------------- ingestion
    def fetch_latest(self) -> int:
        """Pull every feed and append anything new to the archive."""
        seen = {item["link"] for item in self._load_archive() if item.get("link")}
        fresh: List[dict] = []

        for feed in self.feeds:
            try:
                body = self.fetcher.get(feed)
            except FetchError as exc:
                print(f"  ! παράλειψη ροής {feed}: {exc}")
                continue
            for block in _ITEM_RE.findall(body):
                link = _field(block, "link")
                if not link or link in seen:
                    continue
                seen.add(link)
                fresh.append({
                    "title": _field(block, "title"),
                    "summary": _field(block, "description")[:400],
                    "link": link,
                    "published": _field(block, "pubDate"),
                    "feed": feed,
                })

        if fresh:
            os.makedirs(os.path.dirname(self.archive_path) or ".", exist_ok=True)
            with open(self.archive_path, "a", encoding="utf-8") as handle:
                for item in fresh:
                    handle.write(json.dumps(item, ensure_ascii=False) + "\n")
        return len(fresh)

    def _load_archive(self) -> List[dict]:
        if not os.path.exists(self.archive_path):
            return []
        items = []
        with open(self.archive_path, encoding="utf-8") as handle:
            for line in handle:
                try:
                    items.append(json.loads(line))
                except ValueError:
                    continue
        return items

    # ------------------------------------------------------------- scoring
    @staticmethod
    def score_text(text: str) -> Tuple[float, List[str]]:
        """Development relevance of one headline, and which words earned it."""
        normalised = normalise_greek(text)
        weight, matched = 0.0, []
        for pattern, label, value in _KEYWORD_PATTERNS:
            if pattern.search(normalised):
                weight += value
                matched.append(label)
        return weight, matched

    def warm(self) -> None:
        if self._items:
            return
        self._items = self._load_archive()
        places = self.place_names or [name for name, _ in GREEK_REGIONS.values()]
        normalised = {normalise_greek(p): p for p in places if len(p) >= 4}

        for item in self._items:
            text = f"{item.get('title', '')} {item.get('summary', '')}"
            weight, matched = self.score_text(text)
            if weight <= 0:
                continue
            upper = normalise_greek(text)
            for key, place in normalised.items():
                if re.search(r"(?<!\w)" + re.escape(key) + r"\w{0,4}(?!\w)", upper):
                    entry = dict(item, weight=weight, keywords=matched)
                    self._by_area.setdefault(place, []).append(entry)

        if self._by_area:
            totals = {area: sum(i["weight"] for i in items)
                      for area, items in self._by_area.items()}
            logs = {area: math.log10(1 + value) for area, value in totals.items()}
            low, high = min(logs.values()), max(logs.values())
            for area, value in logs.items():
                self._intensity[area] = (
                    round((value - low) / (high - low) * 100, 1) if high > low else 50.0
                )

    # ------------------------------------------------------------- reading
    def reading(self, lat, lng, area_name: str = "") -> Optional[SignalReading]:
        self.warm()
        candidates = [area_name] if area_name else []
        region = region_for(lat, lng)
        if region:
            candidates.append(region[1])

        for candidate in candidates:
            items = self._by_area.get(candidate)
            if not items:
                continue
            items = sorted(items, key=lambda i: i["weight"], reverse=True)
            return SignalReading(
                signal=self.key,
                area=candidate,
                intensity=self._intensity.get(candidate, 0.0),
                raw_value=float(len(items)),
                # Deliberately low: an RSS archive is a sample of coverage, not
                # of reality, and coverage follows advertising, not development.
                confidence=34.0,
                source="RSS: " + ", ".join(self.feeds),
                as_of=f"αρχείο {len(self._items)} άρθρων",
                evidence=[f"{i['title'][:130]} [{', '.join(i['keywords'][:3])}]"
                          for i in items[:4]],
                notes=[
                    f"{len(items)} σχετικά άρθρα στο τοπικό αρχείο.",
                    "Το σήμα χτίζεται με τον χρόνο — τρέξτε το προγραμματισμένα.",
                    "Η κάλυψη των ΜΜΕ δεν είναι δείγμα της πραγματικότητας· χρησιμοποιήστε "
                    "το ως λίστα παρακολούθησης, όχι ως δείκτη.",
                ],
            )
        return None
