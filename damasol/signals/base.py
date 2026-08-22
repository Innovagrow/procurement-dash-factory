# -*- coding: utf-8 -*-
"""
The contract every external signal implements.

A signal answers one question about a place: how touristic is it, how much is
the state spending there, is anything being announced about it. Each returns a
`SignalReading` carrying the raw number, a 0-100 intensity that is comparable
across signals, a confidence, and the provenance - so a score can always be
traced back to a dataset and a date rather than to a vibe.
"""
from __future__ import annotations

import dataclasses
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional


@dataclasses.dataclass
class SignalReading:
    signal: str
    area: str
    intensity: float          # 0-100, comparable across signals
    momentum: Optional[float] = None   # % change over the lookback window
    raw_value: Optional[float] = None
    confidence: float = 50.0  # 0-100
    source: str = ""
    as_of: str = ""
    evidence: List[str] = dataclasses.field(default_factory=list)
    notes: List[str] = dataclasses.field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        data = dataclasses.asdict(self)
        data["evidence"] = " | ".join(self.evidence)
        data["notes"] = " | ".join(self.notes)
        return data


class SignalProvider(ABC):
    """One external dataset, turned into a comparable per-area reading."""

    key: str = "abstract"
    name: str = ""
    source_url: str = ""
    licence: str = ""
    cadence: str = ""          # how often the upstream data actually changes

    def __init__(self, fetcher):
        self.fetcher = fetcher

    @abstractmethod
    def reading(self, lat: Optional[float], lng: Optional[float],
                area_name: str = "") -> Optional[SignalReading]:
        """Reading for the place at these coordinates, or None if unavailable."""

    def warm(self) -> None:
        """Pre-load whatever bulk data the provider needs. Optional."""
