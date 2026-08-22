# -*- coding: utf-8 -*-
"""
Tourism demand per region, from Eurostat's nights-spent series.

Answers two different questions that are easy to conflate:

  intensity  how much tourism the region absorbs at all - decides whether
             short-stay letting is even a real option
  momentum   how fast that has changed over the window - the part that has
             not been priced into asking prices yet

Momentum is the interesting half. Everyone knows Santorini is touristic; far
fewer notice a secondary region compounding 9% a year.
"""
from __future__ import annotations

import json
import math
import statistics
import urllib.parse
from typing import Any, Dict, List, Optional

from ..http import FetchError
from .base import SignalProvider, SignalReading
from .regions import GREEK_REGIONS, region_for

EUROSTAT_BASE = (
    "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/tour_occ_nin2"
)

# 2020 and 2021 are not data about tourism, they are data about a border closure.
# Any growth rate anchored on them measures the reopening and nothing else - a
# naive CAGR from 2020 reports every Greek region growing ~40% a year, which
# would hand the model a signal that is pure artefact.
COVID_YEARS = frozenset({2020, 2021})


class TourismSignal(SignalProvider):
    key = "tourism"
    name = "Τουριστικές διανυκτερεύσεις ανά περιφέρεια"
    source_url = EUROSTAT_BASE
    licence = "Eurostat open data - ελεύθερη χρήση με αναφορά πηγής"
    cadence = "ετήσια, με καθυστέρηση ~6 μηνών"

    def __init__(self, fetcher, years: int = 6):
        super().__init__(fetcher)
        self.years = years
        self._series: Dict[str, Dict[int, float]] = {}
        self._intensity: Dict[str, float] = {}
        self._momentum: Dict[str, float] = {}
        self._momentum_window: Dict[str, tuple] = {}
        self._latest_year: Optional[int] = None

    # ------------------------------------------------------------- loading
    def warm(self, reference_year: int = 2025) -> None:
        if self._series:
            return
        # Reach back past the COVID gap so a clean pre-2020 anchor is available.
        years = [reference_year - offset for offset in range(self.years)]
        if 2019 not in years:
            years.append(2019)
        params = [("format", "JSON"), ("lang", "EN"), ("unit", "NR"),
                  ("nace_r2", "I551-I553"), ("c_resid", "TOTAL")]
        params += [("geo", code) for code in GREEK_REGIONS]
        params += [("time", str(year)) for year in years]
        url = EUROSTAT_BASE + "?" + urllib.parse.urlencode(params)

        try:
            payload = json.loads(self.fetcher.get(url))
        except (FetchError, ValueError) as exc:
            raise FetchError(f"tourism data unavailable: {exc}") from exc

        geo_index = payload["dimension"]["geo"]["category"]["index"]
        time_index = payload["dimension"]["time"]["category"]["index"]
        time_count = len(time_index)
        codes = {position: code for code, position in geo_index.items()}
        times = {position: int(year) for year, position in time_index.items()}

        for flat, value in payload["value"].items():
            flat = int(flat)
            code = codes.get(flat // time_count)
            year = times.get(flat % time_count)
            if code and year and value:
                self._series.setdefault(code, {})[year] = float(value)

        self._derive()

    def _derive(self) -> None:
        """Turn raw nights into a cross-region intensity rank and a growth rate."""
        latest_by_region: Dict[str, float] = {}
        for code, series in self._series.items():
            if not series:
                continue
            years = sorted(series)
            latest_by_region[code] = series[years[-1]]
            self._latest_year = max(self._latest_year or 0, years[-1])

            usable = [year for year in years if year not in COVID_YEARS]
            if len(usable) >= 2:
                first_year, last_year = usable[0], usable[-1]
                first, last = series[first_year], series[last_year]
                span = last_year - first_year
                if first > 0 and span > 0:
                    self._momentum[code] = round(((last / first) ** (1 / span) - 1) * 100, 2)
                    self._momentum_window[code] = (first_year, last_year)

        # Absolute nights span three orders of magnitude across Greek regions,
        # so rank on a log scale or Crete flattens everything else to zero.
        if latest_by_region:
            logs = {code: math.log10(max(1.0, value)) for code, value in latest_by_region.items()}
            low, high = min(logs.values()), max(logs.values())
            for code, value in logs.items():
                self._intensity[code] = (
                    round((value - low) / (high - low) * 100, 1) if high > low else 50.0
                )

    # ------------------------------------------------------------- reading
    def reading(self, lat, lng, area_name: str = "") -> Optional[SignalReading]:
        self.warm()
        region = region_for(lat, lng)
        if not region:
            return None
        code, name, _ = region
        if code not in self._intensity:
            return None

        series = self._series.get(code, {})
        years = sorted(series)
        momentum = self._momentum.get(code)
        window = self._momentum_window.get(code)
        evidence = [
            f"{year}: {series[year]:,.0f} διανυκτερεύσεις".replace(",", ".")
            for year in years[-3:]
        ]
        notes = []
        detail: Dict[str, Any] = {"latest_year": years[-1] if years else None,
                                  "nights_latest": series.get(years[-1]) if years else None}
        if momentum is not None and window:
            direction = "άνοδος" if momentum > 0 else "πτώση"
            notes.append(
                f"Μέση ετήσια {direction} {abs(momentum):.1f}% την περίοδο "
                f"{window[0]}–{window[1]}."
            )
        if 2019 in series and years and series[years[-1]]:
            versus_2019 = (series[years[-1]] / series[2019] - 1) * 100
            detail["versus_2019_pct"] = round(versus_2019, 1)
            detail["nights_2019"] = series[2019]
            notes.append(
                f"Έναντι 2019 (προ πανδημίας): {versus_2019:+.1f}% — "
                "δείχνει αν η περιοχή απλώς ανέκαμψε ή πράγματι μεγάλωσε."
            )
        notes.append("Τα έτη 2020–2021 εξαιρούνται από τον ρυθμό: μετρούν το κλείσιμο συνόρων.")
        notes.append(
            "Η ένταση είναι κατάταξη σε λογαριθμική κλίμακα μεταξύ των 13 περιφερειών, "
            "όχι απόλυτο μέγεθος."
        )

        return SignalReading(
            signal=self.key,
            area=name,
            intensity=self._intensity[code],
            momentum=momentum,
            raw_value=series.get(years[-1]) if years else None,
            confidence=78.0,
            source="Eurostat tour_occ_nin2",
            as_of=str(self._latest_year or ""),
            evidence=evidence,
            notes=notes,
            detail=detail,
        )

    def ranking(self) -> List[tuple]:
        """All regions, most touristic first - useful on its own."""
        self.warm()
        rows = [
            (GREEK_REGIONS[code][0], self._intensity[code], self._momentum.get(code))
            for code in self._intensity
        ]
        rows.sort(key=lambda row: row[1], reverse=True)
        return rows
