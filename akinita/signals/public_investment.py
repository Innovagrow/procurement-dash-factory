# -*- coding: utf-8 -*-
"""
Public works intensity per municipality, from Diavgeia.

Every Greek public body must publish its decisions to Diavgeia before they take
effect. That makes it a near-complete, freely queryable record of what the state
is about to build - and public works land in property prices before they land in
listings.

The signal counts works-flavoured decisions per municipality over a window. It
measures *activity*, not euros: the search API does not expose amounts, and
inferring them from decision text would be guessing dressed as data.
"""
from __future__ import annotations

import json
import math
import re
import urllib.parse
from typing import Dict, List, Optional, Tuple

from ..http import FetchError
from .base import SignalProvider, SignalReading
from .regions import normalise_greek

SEARCH_URL = "https://diavgeia.gov.gr/opendata/search.json"
ORGANISATIONS_URL = "https://diavgeia.gov.gr/opendata/organizations.json"

# High-signal terms only: the API filters on one `subject` term per request, so
# each keyword costs requests. These are the words that mark capital works
# rather than routine municipal administration.
WORKS_KEYWORDS = (
    "ανάπλαση",
    "ασφαλτόστρωση",
    "πεζοδρόμηση",
    "αναβάθμιση",
    "κατασκευή έργου",
    "βιοκλιματική",
)

_GENITIVE_ENDINGS = ("ΑΙΩΝ", "ΕΩΝ", "ΟΥΣ", "ΕΙΣ", "ΩΝ", "ΗΣ", "ΑΣ", "ΟΥ", "ΟΣ",
                     "ΟΝ", "ΕΣ", "Α", "Ο", "Η", "Σ")

# Words that appear in dozens of Greek place names and identify none of them.
# Matching on these is how "Νέα Ερυθραία" ends up filed under "Νέα Ζίχνη".
_GENERIC_TOKENS = frozenset({
    "ΝΕΑ", "ΝΕΟ", "ΝΕΟΙ", "ΝΕΕΣ", "ΝΕΑΣ", "ΝΕΟΥ", "ΑΝΩ", "ΚΑΤΩ", "ΜΕΣΑ", "ΕΞΩ",
    "ΠΑΛΑΙΑ", "ΠΑΛΑΙΟ", "ΠΑΛΑΙΑΣ", "ΑΓΙΟΣ", "ΑΓΙΑ", "ΑΓΙΟΙ", "ΑΓΙΟΥ", "ΑΓΙΑΣ",
    "ΜΕΓΑΛΑ", "ΜΕΓΑΛΗ", "ΜΙΚΡΑ", "ΜΙΚΡΟ", "ΔΥΤΙΚΗΣ", "ΑΝΑΤΟΛΙΚΗΣ", "ΒΟΡΕΙΑΣ",
    "ΝΟΤΙΑΣ", "ΔΥΤΙΚΗ", "ΑΝΑΤΟΛΙΚΗ", "ΒΟΡΕΙΑ", "ΝΟΤΙΑ", "ΚΕΝΤΡΙΚΗΣ", "ΚΕΝΤΡΙΚΗ",
})


def _stems(name: str) -> set:
    """Every plausible stem of a Greek place name.

    Greek municipalities are published in the genitive ("ΔΗΜΟΣ ΡΟΔΟΥ") while
    listings use the nominative ("Ρόδος"), and the two share only a prefix.
    Stripping one ending is not enough - "ΡΟΔΟΣ" and "ΡΟΔΟΥ" both have to reduce
    to "ΡΟΔ" before they meet. Returning a set of candidates and intersecting
    them is more forgiving than trying to guess the single right stem.
    """
    text = normalise_greek(name).replace("ΔΗΜΟΣ ", "").strip()
    text = re.sub(r"\s*Ν\.\s*[\w]+$", "", text)         # drop "Ν. ΗΡΑΚΛΕΙΟΥ" suffixes

    tokens = [t for t in re.split(r"[\s\-]+", text) if len(t) >= 3]
    meaningful = [t for t in tokens if t not in _GENERIC_TOKENS] or tokens
    if not meaningful:
        return set()

    candidates = set()
    for token in meaningful:
        candidates.add(token)
        for ending in _GENITIVE_ENDINGS:
            # Short names like ΡΟΔΟΥ / ΒΟΛΟΥ need to reduce to a 3-letter
            # stem to meet their nominative; the ambiguity guard below is what
            # keeps that from producing false matches.
            if len(token) - len(ending) >= 3 and token.endswith(ending):
                candidates.add(token[: -len(ending)])
                break   # one ending only; stacking them destroys the stem
    return {c for c in candidates if len(c) >= 3}


def _stem(name: str) -> str:
    """Shortest stem for a name - the one most likely to match across cases."""
    candidates = _stems(name)
    return min(candidates, key=len) if candidates else ""


class PublicInvestmentSignal(SignalProvider):
    key = "public_investment"
    name = "Ένταση δημόσιων έργων ανά δήμο"
    source_url = SEARCH_URL
    licence = "Διαύγεια - ανοικτά δεδομένα δημόσιου τομέα"
    cadence = "συνεχής· οι αποφάσεις αναρτώνται καθημερινά"

    def __init__(self, fetcher, months: int = 18, pages_per_keyword: int = 3,
                 page_size: int = 200):
        super().__init__(fetcher)
        self.months = months
        self.pages_per_keyword = pages_per_keyword
        self.page_size = page_size
        self._counts: Dict[str, int] = {}
        self._subjects: Dict[str, List[str]] = {}
        self._intensity: Dict[str, float] = {}
        self._stem_index: Dict[str, set] = {}
        self._total_decisions = 0

    # ------------------------------------------------------------- loading
    def _organisations(self) -> Dict[str, str]:
        payload = json.loads(self.fetcher.get(ORGANISATIONS_URL))
        lookup: Dict[str, str] = {}
        for org in payload.get("organizations", []):
            label = org.get("label") or ""
            for key in (org.get("uid"), org.get("vatNumber")):
                if key:
                    lookup[str(key)] = label
        return lookup

    def warm(self, from_date: str = "", to_date: str = "") -> None:
        if self._counts:
            return
        organisations = self._organisations()

        for keyword in WORKS_KEYWORDS:
            for page in range(self.pages_per_keyword):
                params = {"subject": keyword, "size": self.page_size, "from": page * self.page_size}
                if from_date:
                    params["from_issue_date"] = from_date
                if to_date:
                    params["to_issue_date"] = to_date
                try:
                    payload = json.loads(self.fetcher.get(SEARCH_URL + "?" + urllib.parse.urlencode(params)))
                except (FetchError, ValueError):
                    break

                decisions = payload.get("decisions") or []
                if not decisions:
                    break
                for decision in decisions:
                    label = organisations.get(str(decision.get("organizationId")))
                    if not label or not label.startswith("ΔΗΜΟΣ"):
                        continue
                    self._counts[label] = self._counts.get(label, 0) + 1
                    self._total_decisions += 1
                    subjects = self._subjects.setdefault(label, [])
                    if len(subjects) < 4:
                        subject = (decision.get("subject") or "").strip()
                        if subject:
                            subjects.append(subject[:140])

        self._derive()

    def _derive(self) -> None:
        if not self._counts:
            return
        logs = {label: math.log10(1 + count) for label, count in self._counts.items()}
        low, high = min(logs.values()), max(logs.values())
        for label, value in logs.items():
            self._intensity[label] = (
                round((value - low) / (high - low) * 100, 1) if high > low else 50.0
            )
            for stem in _stems(label):
                self._stem_index.setdefault(stem, set()).add(label)

    # ------------------------------------------------------------- reading
    def match_municipality(self, area_name: str) -> Optional[str]:
        self.warm()
        if not area_name:
            return None
        candidates = _stems(area_name)
        if not candidates:
            return None
        # Longest stem first, and never resolve one that points at more than one
        # municipality: 'ΗΡΑΚΛΕΙ' fits both Ηράκλειο and Ηράκλεια, and guessing
        # between them injects a confident wrong signal. No match beats that.
        for stem in sorted(candidates, key=len, reverse=True):
            labels = self._stem_index.get(stem)
            if labels and len(labels) == 1 and (len(stem) >= 4 or len(candidates) <= 3):
                return next(iter(labels))
        return None

    def reading(self, lat, lng, area_name: str = "") -> Optional[SignalReading]:
        self.warm()
        label = self.match_municipality(area_name)
        if not label:
            return None
        count = self._counts.get(label, 0)
        return SignalReading(
            signal=self.key,
            area=label,
            intensity=self._intensity.get(label, 0.0),
            raw_value=float(count),
            # Keyword sampling, not a census: a municipality can be busy in ways
            # these six words do not catch.
            confidence=52.0,
            source="Διαύγεια (diavgeia.gov.gr)",
            as_of=f"τελευταίοι {self.months} μήνες",
            evidence=self._subjects.get(label, []),
            notes=[
                f"{count} αποφάσεις έργων από {len(self._counts)} δήμους στο δείγμα "
                f"({self._total_decisions} συνολικά).",
                "Μετράει δραστηριότητα, όχι ποσά — το API αναζήτησης δεν εκθέτει προϋπολογισμούς.",
                "Δείγμα βάσει λέξεων-κλειδιών· απουσία σήματος δεν σημαίνει απουσία έργων.",
            ],
        )

    def ranking(self, top: int = 20) -> List[Tuple[str, int, float]]:
        self.warm()
        rows = [(label, count, self._intensity.get(label, 0.0))
                for label, count in self._counts.items()]
        rows.sort(key=lambda row: row[1], reverse=True)
        return rows[:top]
