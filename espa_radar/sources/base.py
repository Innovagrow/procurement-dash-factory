"""Βασικοί τύποι για τις πηγές."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from ..textutils import normalize


class SourceError(RuntimeError):
    """Αποτυχία πηγής — δεν σταματά το υπόλοιπο scan."""


@dataclass
class RawProgram:
    """Ό,τι κατάφερε να διαβάσει μια πηγή, πριν τον εμπλουτισμό."""

    source_id: str
    source_name: str
    title: str
    url: str
    external_id: str | None = None
    summary: str | None = None
    body: str | None = None
    published_at: datetime | None = None
    deadline: datetime | None = None
    opens_at: datetime | None = None
    status_hint: str | None = None
    budget_total: float | None = None
    extra: dict = field(default_factory=dict)

    def text_blob(self) -> str:
        return " \n".join(filter(None, [self.title, self.summary, self.body, self.status_hint]))


class Source:
    """Βάση για κάθε συλλέκτη."""

    def __init__(self, source_id: str, name: str, enabled: bool = True, **options) -> None:
        self.source_id = source_id
        self.name = name
        self.enabled = enabled
        self.options = options

    def fetch(self) -> list[RawProgram]:  # pragma: no cover - override
        raise NotImplementedError

    def apply_filters(self, programs: list[RawProgram]) -> list[RawProgram]:
        """Φιλτράρει με βάση τα options must_match / must_not_match.

        Χρήσιμο σε πηγές γενικής αναζήτησης (π.χ. Διαύγεια), που επιστρέφουν
        και άσχετα έγγραφα όπως «απόφαση ανάληψης υποχρέωσης».
        """
        must = [normalize(v) for v in (self.options.get("must_match") or []) if v]
        must_not = [normalize(v) for v in (self.options.get("must_not_match") or []) if v]
        if not must and not must_not:
            return programs

        kept: list[RawProgram] = []
        for program in programs:
            haystack = normalize(program.text_blob())
            if must and not any(term in haystack for term in must):
                continue
            if must_not and any(term in haystack for term in must_not):
                continue
            kept.append(program)
        return kept

    def __repr__(self) -> str:
        return f"<{type(self).__name__} {self.source_id}>"
