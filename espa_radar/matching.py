"""Μηχανή αντιστοίχισης: πόσο ταιριάζει ένα πρόγραμμα με τα κριτήρια ενός προφίλ."""
from __future__ import annotations

from dataclasses import dataclass, field

from .config import settings
from .models import Profile, Program
from .taxonomy import STATUS_CLOSED, STATUS_UPCOMING
from .textutils import days_until, fmt_money, normalize

# Βάρη ανά διάσταση. Διαστάσεις που το προφίλ αφήνει κενές δεν μετράνε καθόλου
# (το σκορ επανακανονικοποιείται πάνω στις διαστάσεις που όντως ζητήθηκαν).
WEIGHTS: dict[str, float] = {
    "keywords": 28.0,
    "sectors": 24.0,
    "regions": 16.0,
    "beneficiaries": 14.0,
    "budget": 10.0,
    "subsidy_rate": 5.0,
    "aid_types": 3.0,
}

# Μπόνους πάνω στο τελικό σκορ (max +8) για προγράμματα που «τρέχουν τώρα».
FRESHNESS_BONUS = 5.0
URGENCY_BONUS = 3.0


@dataclass
class MatchResult:
    matched: bool
    score: float = 0.0
    reasons: list[str] = field(default_factory=list)
    breakdown: dict[str, float] = field(default_factory=dict)
    rejected_because: str | None = None


def _overlap(profile_values: list[str], program_values: list[str]) -> list[str]:
    wanted = {normalize(v) for v in profile_values if v}
    return [v for v in program_values if normalize(v) in wanted]


def _keyword_hits(keywords: list[str], haystack: str) -> list[str]:
    normalized = normalize(haystack)
    return [kw for kw in keywords if kw and normalize(kw) in normalized]


def _budget_score(profile: Profile, program: Program) -> tuple[float | None, str | None]:
    """Επικάλυψη του εύρους του προγράμματος με το εύρος που ζητά ο χρήστης."""
    if profile.budget_min is None and profile.budget_max is None:
        return None, None

    lo = program.budget_min if program.budget_min is not None else program.budget_max
    hi = program.budget_max if program.budget_max is not None else program.budget_min
    if lo is None or hi is None:
        # Άγνωστος προϋπολογισμός: ουδέτερο, χωρίς να τιμωρείται.
        return 0.5, "προϋπολογισμός προγράμματος άγνωστος"

    want_lo = profile.budget_min if profile.budget_min is not None else 0.0
    want_hi = profile.budget_max if profile.budget_max is not None else float("inf")

    if hi < want_lo or lo > want_hi:
        return 0.0, f"εκτός εύρους προϋπολογισμού ({fmt_money(lo)}–{fmt_money(hi)})"

    overlap_lo = max(lo, want_lo)
    overlap_hi = min(hi, want_hi if want_hi != float("inf") else hi)
    span = max(hi - lo, 1.0)
    ratio = max(0.0, (overlap_hi - overlap_lo)) / span if span else 1.0
    score = min(1.0, 0.6 + 0.4 * ratio)
    return score, f"προϋπολογισμός {fmt_money(lo)}–{fmt_money(hi)} εντός κριτηρίων"


def _criteria(profile: Profile, field: str) -> list[str]:
    """Λίστα κριτηρίων, ανθεκτικά σε None.

    Τα defaults των στηλών εφαρμόζονται μόνο κατά το INSERT, οπότε ένα προφίλ
    που δεν έχει ακόμη αποθηκευτεί έχει None αντί για κενή λίστα.
    """
    return list(getattr(profile, field, None) or [])


def evaluate(profile: Profile, program: Program) -> MatchResult:
    """Επιστρέφει σκορ 0–100 με αιτιολόγηση, ή απόρριψη με λόγο."""
    haystack = program.searchable

    # --- Σκληρά φίλτρα ---------------------------------------------------
    excluded = _keyword_hits(_criteria(profile, "exclude_keywords"), haystack)
    if excluded:
        return MatchResult(False, rejected_because=f"περιέχει αποκλεισμένους όρους: {', '.join(excluded)}")

    allowed_sources = _criteria(profile, "sources")
    if allowed_sources and program.source_id not in allowed_sources:
        return MatchResult(False, rejected_because=f"πηγή εκτός επιλογής ({program.source_id})")

    if program.status == STATUS_CLOSED:
        return MatchResult(False, rejected_because="η πρόσκληση έχει λήξει")

    # None (μη αποθηκευμένο προφίλ) σημαίνει το default του μοντέλου: True.
    include_upcoming = profile.include_upcoming is not False
    if program.status == STATUS_UPCOMING and not include_upcoming:
        return MatchResult(False, rejected_because="αναμενόμενη πρόσκληση (εξαιρείται)")

    remaining = days_until(program.deadline)
    if profile.min_days_left is not None and remaining is not None and remaining < profile.min_days_left:
        return MatchResult(
            False,
            rejected_because=f"απομένουν {remaining} ημέρες (ελάχιστο {profile.min_days_left})",
        )

    if (
        profile.min_subsidy_rate is not None
        and program.subsidy_rate is not None
        and program.subsidy_rate < profile.min_subsidy_rate
    ):
        return MatchResult(
            False,
            rejected_because=f"ένταση ενίσχυσης {program.subsidy_rate:.0f}% < {profile.min_subsidy_rate:.0f}%",
        )

    budget_score, budget_reason = _budget_score(profile, program)
    if budget_score == 0.0:
        return MatchResult(False, rejected_because=budget_reason or "εκτός εύρους προϋπολογισμού")

    # --- Βαθμολόγηση ------------------------------------------------------
    scores: dict[str, float] = {}
    reasons: list[str] = []

    keywords = _criteria(profile, "keywords")
    if keywords:
        hits = _keyword_hits(keywords, haystack)
        scores["keywords"] = min(1.0, len(hits) / max(1, min(len(keywords), 3)))
        if hits:
            reasons.append(f"λέξεις-κλειδιά: {', '.join(hits[:6])}")

    for dimension, program_values, label in (
        ("sectors", program.sectors, "κλάδοι"),
        ("regions", program.regions, "περιοχές"),
        ("beneficiaries", program.beneficiaries, "δικαιούχοι"),
        ("aid_types", program.aid_types, "είδος ενίσχυσης"),
    ):
        wanted = _criteria(profile, dimension)
        if not wanted:
            continue
        available = list(program_values or [])
        if dimension == "regions" and not available:
            # Καμία περιοχή στο κείμενο ⇒ συνήθως πανελλαδικό πρόγραμμα.
            scores[dimension] = 0.7
            reasons.append("πανελλαδικής εμβέλειας (δεν αναφέρονται περιοχές)")
            continue
        hits = _overlap(wanted, available)
        scores[dimension] = min(1.0, len(hits) / max(1, min(len(wanted), 2)))
        if hits:
            reasons.append(f"{label}: {', '.join(hits[:4])}")

    if budget_score is not None:
        scores["budget"] = budget_score
        if budget_reason:
            reasons.append(budget_reason)

    if profile.min_subsidy_rate is not None:
        if program.subsidy_rate is None:
            scores["subsidy_rate"] = 0.5
        else:
            headroom = program.subsidy_rate - profile.min_subsidy_rate
            scores["subsidy_rate"] = min(1.0, 0.6 + headroom / 100.0)
            reasons.append(f"ένταση ενίσχυσης {program.subsidy_rate:.0f}%")

    if not scores:
        # Προφίλ χωρίς κανένα κριτήριο: δέχεται τα πάντα με ουδέτερο σκορ.
        return MatchResult(
            True,
            score=50.0,
            reasons=["το προφίλ δεν ορίζει κριτήρια — εμφανίζονται όλα τα προγράμματα"],
            breakdown={},
        )

    total_weight = sum(WEIGHTS[k] for k in scores)
    weighted = sum(WEIGHTS[k] * v for k, v in scores.items())
    score = (weighted / total_weight) * 100.0 if total_weight else 0.0

    # Μπόνους επικαιρότητας.
    if program.published_at is not None:
        age_days = days_until(program.published_at)
        if age_days is not None and age_days >= -14:
            score += FRESHNESS_BONUS
            reasons.append("δημοσιεύθηκε πρόσφατα")
    if remaining is not None and 0 <= remaining <= 30:
        score += URGENCY_BONUS
        reasons.append(f"λήγει σε {remaining} ημέρες")

    score = round(min(100.0, score), 1)
    threshold = profile.min_score if profile.min_score is not None else settings.default_min_score

    breakdown = {k: round(WEIGHTS[k] * v, 2) for k, v in scores.items()}

    if score < threshold:
        return MatchResult(
            False,
            score=score,
            breakdown=breakdown,
            rejected_because=f"σκορ {score} < κατώφλι {threshold}",
        )

    return MatchResult(True, score=score, reasons=reasons, breakdown=breakdown)
