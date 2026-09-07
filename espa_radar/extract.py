"""Εξαγωγή δομημένων πεδίων από ελεύθερο ελληνικό κείμενο προσκλήσεων."""
from __future__ import annotations

import re
from datetime import datetime

from .textutils import (
    normalize,
    parse_amounts,
    parse_date,
    parse_percentages,
    strip_html,
    utcnow,
)


def _cues(*phrases: str) -> tuple[str, ...]:
    """Οι φράσεις-οδηγοί συγκρίνονται με κανονικοποιημένο κείμενο."""
    return tuple(normalize(p) for p in phrases)


_SENTENCE_SPLIT = re.compile(r"(?<=[.;:])\s+(?=[Α-ΩΆΈΉΊΌΎΏA-Z«\d])|[\n•·]+")


def _sentences(text: str) -> list[str]:
    """Χωρισμός σε προτάσεις χωρίς να σπάνε συντομογραφίες («εκατ.», «π.χ.»)."""
    return [s for s in _SENTENCE_SPLIT.split(text) if s and s.strip()]


# Φράσεις που προαναγγέλλουν καταληκτική ημερομηνία υποβολής.
_DEADLINE_CUES = _cues(
    "καταληκτική ημερομηνία",
    "λήξη υποβολής",
    "ημερομηνία λήξης",
    "προθεσμία υποβολής",
    "υποβολή αιτήσεων έως",
    "αιτήσεις έως",
    "έως και",
    "μέχρι και",
    "λήξη",
    "έως",
    "μέχρι",
    "deadline",
)

_START_CUES = _cues(
    "έναρξη υποβολής",
    "ημερομηνία έναρξης",
    "υποβολή αιτήσεων από",
    "ανοίγει",
    "από ",
    "έναρξη",
)

_PUBLISHED_CUES = _cues(
    "ημερομηνία δημοσίευσης",
    "δημοσιεύθηκε",
    "αναρτήθηκε",
    "δημοσίευση",
)

_DATE_TOKEN = re.compile(
    r"(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}"
    r"|\d{4}-\d{2}-\d{2}"
    r"|\d{1,2}\s+[α-ωΑ-Ωά-ώΆ-Ώa-zA-Z]{3,12}\s+\d{4})"
)


def _dates_with_context(text: str) -> list[tuple[str, str, int]]:
    """(ημερομηνία, κείμενο πριν, θέση) για κάθε ημερομηνία στο κείμενο."""
    plain = strip_html(text)
    out: list[tuple[str, str, int]] = []
    for match in _DATE_TOKEN.finditer(plain):
        start = max(0, match.start() - 90)
        out.append((match.group(1), normalize(plain[start : match.start()]), match.start()))
    return out


def _pick_by_cues(text: str | None, cues: tuple[str, ...]) -> datetime | None:
    if not text:
        return None
    candidates = _dates_with_context(text)
    if not candidates:
        return None
    for cue in cues:
        for raw, context, _ in candidates:
            if cue in context:
                parsed = parse_date(raw)
                if parsed:
                    return parsed
    return None


def extract_deadline(text: str | None) -> datetime | None:
    """Καταληκτική ημερομηνία. Προτιμά ρητές ενδείξεις· αλλιώς τη μελλοντική ημερομηνία."""
    if not text:
        return None

    found = _pick_by_cues(text, _DEADLINE_CUES)
    if found:
        return found

    # Fallback: η πιο κοντινή μελλοντική ημερομηνία μέσα σε λογικό ορίζοντα.
    today = utcnow()
    future: list[datetime] = []
    for raw, _, _ in _dates_with_context(text):
        parsed = parse_date(raw)
        if parsed and today <= parsed <= today.replace(year=today.year + 3):
            future.append(parsed)
    return min(future) if future else None


def extract_opens_at(text: str | None) -> datetime | None:
    return _pick_by_cues(text, _START_CUES)


def extract_published(text: str | None) -> datetime | None:
    found = _pick_by_cues(text, _PUBLISHED_CUES)
    if found:
        return found
    if not text:
        return None
    today = utcnow()
    past: list[datetime] = []
    for raw, _, _ in _dates_with_context(text):
        parsed = parse_date(raw)
        if parsed and parsed <= today:
            past.append(parsed)
    return max(past) if past else None


# --- Προϋπολογισμός ----------------------------------------------------------

_TOTAL_CUES = _cues(
    "συνολικός προϋπολογισμός", "προϋπολογισμός της πρόσκλησης", "συνολική δημόσια δαπάνη",
    "δημόσια δαπάνη", "συνολικό ποσό", "προϋπολογισμός δράσης", "διαθέσιμος προϋπολογισμός",
)
_PER_PROJECT_CUES = _cues(
    "ανά επενδυτικό σχέδιο", "ανά αίτηση", "επιχορηγούμενος προϋπολογισμός",
    "επιλέξιμος προϋπολογισμός", "ύψος επένδυσης", "ανά δικαιούχο", "προϋπολογισμός επένδυσης",
)


def extract_budgets(text: str | None) -> tuple[float | None, float | None, float | None]:
    """(συνολικός προϋπολογισμός δράσης, ελάχιστο ανά έργο, μέγιστο ανά έργο)."""
    if not text:
        return None, None, None

    plain = strip_html(text)
    lowered = normalize(plain)

    total: float | None = None
    per_project: list[float] = []

    # Χωρίζουμε σε προτάσεις για να αποδώσουμε τα ποσά στο σωστό context.
    for sentence in _sentences(plain):
        amounts = [a for a in parse_amounts(sentence) if a >= 500]
        if not amounts:
            continue
        ctx = normalize(sentence)
        if any(cue in ctx for cue in _TOTAL_CUES):
            total = max(total or 0, max(amounts)) or None
        elif any(cue in ctx for cue in _PER_PROJECT_CUES):
            per_project.extend(amounts)

    all_amounts = [a for a in parse_amounts(plain) if a >= 500]
    if not per_project and all_amounts:
        # Χωρίς σαφές context: τα μικρά ποσά είναι συνήθως ανά έργο.
        per_project = [a for a in all_amounts if a < 5_000_000]
    if total is None and all_amounts:
        biggest = max(all_amounts)
        # Ένα πολύ μεγάλο ποσό δίπλα σε «προϋπολογισμ» είναι ο συνολικός.
        if biggest >= 1_000_000 and "προϋπολογισμ" in lowered:
            total = biggest

    budget_min = min(per_project) if per_project else None
    budget_max = max(per_project) if per_project else None
    if budget_min is not None and budget_max is not None and budget_min == budget_max:
        budget_min = None
    return total, budget_min, budget_max


# --- Ένταση ενίσχυσης --------------------------------------------------------

_RATE_CUES = _cues(
    "ένταση ενίσχυσης", "ποσοστό ενίσχυσης", "ποσοστό επιχορήγησης", "ποσοστό επιδότησης",
    "επιχορηγείται", "επιδότηση έως", "χρηματοδότηση έως", "καλύπτει",
)


def extract_subsidy_rate(text: str | None) -> float | None:
    """Ποσοστό επιδότησης — προτιμά ποσοστά δίπλα σε σχετικές φράσεις."""
    if not text:
        return None
    plain = strip_html(text)

    contextual: list[float] = []
    for sentence in _sentences(plain):
        ctx = normalize(sentence)
        if any(cue in ctx for cue in _RATE_CUES):
            contextual.extend(parse_percentages(sentence))
    if contextual:
        return max(contextual)

    # Χωρίς ρητό context, μόνο σε σύντομα κείμενα (τίτλος/περίληψη): σε μια
    # πλήρη σελίδα πρόσκλησης τα ποσοστά είναι συνήθως άσχετα (π.χ. ΦΠΑ,
    # ποσοστά συμμετοχής), οπότε θα δίναμε λάθος ένταση ενίσχυσης.
    if len(plain) > 1200:
        return None
    plausible = [p for p in parse_percentages(plain) if 10 <= p <= 100]
    return max(plausible) if plausible else None
