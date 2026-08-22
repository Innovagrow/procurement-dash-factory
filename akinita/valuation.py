# -*- coding: utf-8 -*-
"""
Resale valuation: what the property is worth now, and what it is worth later.

The method is the one appraisers actually use - comparison against local stock -
made explicit. Start from the neighbourhood's median EUR/sqm, then apply named
multiplicative adjustments for the things that make this unit differ from the
median unit. Nothing is hidden in a single fudge factor: every adjustment is
printed with its value, its reason, and whether it came from data or from an
assumption.

Three numbers come out:

  ανοιχτή αγορά   what it should fetch with a normal marketing period
  άμεση           what it fetches when you need out in weeks, not months
  σε ορίζοντα     what it should fetch in N months, optionally after works

The confidence band is not decoration. It widens with thin comparables, with
dispersed comparables, and with every factor that had to be guessed - so a
valuation built on three listings and six assumptions announces itself as such
instead of pretending to be a number.
"""
from __future__ import annotations

import dataclasses
import re
import statistics
from typing import Dict, List, Optional, Sequence, Tuple

from .models import Listing

# --------------------------------------------------------------- factor tables

CONDITION_MULTIPLIER = {
    "structural_needed": 0.68,   # ημιτελές, χρήζει ριζικής αποκατάστασης
    "needs_work": 0.80,          # χρήζει ανακαίνισης
    "average": 1.00,             # κατοικήσιμο, όχι ανακαινισμένο
    "renovated": 1.14,
    "new_build": 1.24,
}

# Floor matters differently with and without a lift; this is the with-lift case.
FLOOR_MULTIPLIER = {
    "basement": 0.72,
    "semi_basement": 0.80,
    "ground": 0.88,
    "mezzanine": 0.92,
    "low": 1.00,        # 1-3
    "mid": 1.03,        # 4-5
    "high": 1.06,       # 6+
    "top": 1.07,        # ρετιρέ
}

ENERGY_MULTIPLIER = {"A+": 1.06, "A": 1.05, "B": 1.03, "C": 1.00,
                     "D": 0.99, "E": 0.96, "F": 0.94, "G": 0.92}

LEGAL_MULTIPLIER = {
    "clean": 1.00,
    "pending_planning": 0.94,      # εκκρεμής τακτοποίηση αυθαιρέτου
    "encumbered": 0.90,            # βάρη προς εξάλειψη
    "bare_ownership": 0.62,        # ψιλή κυριότητα με επικαρπία εν ζωή
    "part_share": 0.55,            # ποσοστό εξ αδιαιρέτου
    "occupied": 0.82,              # κατεχόμενο, απαιτείται αποβολή
}

WORKS_FOR_CONDITION = {
    "structural_needed": "structural",
    "needs_work": "full",
    "average": "cosmetic",
    "renovated": "none",
    "new_build": "none",
}

# --------------------------------------------------------------- text inference

_PATTERNS: Dict[str, Sequence[Tuple[str, str]]] = {
    "condition": (
        ("structural_needed", r"ημιτελ|ριζικ[ήη] ανακαίν|αποκατάστασ|ετοιμόρροπ|κέλυφος"),
        ("needs_work", r"χρήζει ανακαίν|για ανακαίν|ανακαινίσιμ|προς ανακαίν|χρειάζεται ανακαίν"),
        ("new_build", r"νεόδμητ|νεοδμητ|υπό κατασκευ|καινούρι|υπό ανέγερσ"),
        ("renovated", r"ανακαινισμ|πλήρως ανακαιν"),
    ),
    "floor": (
        ("basement", r"υπόγει"),
        ("semi_basement", r"ημιυπόγει"),
        ("ground", r"ισόγει"),
        ("mezzanine", r"ημιώροφ|μεσοπάτωμ"),
        ("top", r"ρετιρέ|ρετιρε"),
    ),
    "legal": (
        ("part_share", r"ποσοστ[όο] εξ αδιαιρ|εξ αδιαιρέτου|ιδανικ[όο] μερίδιο"),
        ("bare_ownership", r"ψιλ[ήη] κυριότητ|επικαρπ"),
        ("occupied", r"κατεχόμεν|με ένοικο|μη ελεύθερ"),
        ("pending_planning", r"αυθαίρετ|τακτοποίησ|εκκρεμ[ήη] πολεοδομ"),
    ),
}

_ENERGY_RE = re.compile(r"ενεργειακ[ήη][ςσ]?\s*(?:κλάση|κατηγορ[ίι]α)?\s*[:\-]?\s*(A\+|[A-G])", re.I)
_LIFT_RE = re.compile(r"ασανσέρ|ανελκυστήρ", re.I)
_NO_LIFT_RE = re.compile(r"χωρίς ασανσέρ|χωρίς ανελκυστήρ", re.I)
_FLOOR_NUM_RE = re.compile(r"(\d)ο[ςσ]?\s*όροφο|όροφο[ςσ]?\s*[:\-]?\s*(\d)", re.I)


@dataclasses.dataclass
class PropertyFacts:
    """What we believe about the unit, and how sure we are of each belief."""

    condition: str = "average"
    floor_band: str = "low"
    has_lift: Optional[bool] = None
    energy_class: Optional[str] = None
    legal_status: str = "clean"
    construction_year: Optional[int] = None
    size_sqm: Optional[float] = None
    assumed: List[str] = dataclasses.field(default_factory=list)

    @property
    def certainty(self) -> float:
        """1.0 when everything was read from the data, falling as we guess."""
        return max(0.35, 1.0 - 0.11 * len(self.assumed))


def infer_facts(listing: Listing) -> PropertyFacts:
    """Read what the advert actually says; record everything else as assumed."""
    text = " ".join([listing.title or "", listing.description_hint or "",
                     " ".join(listing.levels or [])])
    facts = PropertyFacts(size_sqm=listing.size_sqm,
                          construction_year=listing.construction_year)

    for field, patterns in _PATTERNS.items():
        for value, pattern in patterns:
            if re.search(pattern, text, re.I):
                setattr(facts, {"condition": "condition", "floor": "floor_band",
                                "legal": "legal_status"}[field], value)
                break
        else:
            facts.assumed.append({"condition": "κατάσταση", "floor": "όροφος",
                                  "legal": "νομική κατάσταση"}[field])

    if facts.floor_band == "low":
        match = _FLOOR_NUM_RE.search(text)
        if match:
            number = int(match.group(1) or match.group(2))
            facts.floor_band = "low" if number <= 3 else ("mid" if number <= 5 else "high")
            if "όροφος" in facts.assumed:
                facts.assumed.remove("όροφος")

    energy = _ENERGY_RE.search(text)
    if energy:
        facts.energy_class = energy.group(1).upper()
    else:
        facts.assumed.append("ενεργειακή κλάση")

    if _NO_LIFT_RE.search(text):
        facts.has_lift = False
    elif _LIFT_RE.search(text):
        facts.has_lift = True
    else:
        facts.assumed.append("ανελκυστήρας")

    if not facts.construction_year:
        facts.assumed.append("έτος κατασκευής")

    return facts


# ------------------------------------------------------------------ adjustments


def _age_multiplier(year: Optional[int], reference_year: int = 2026) -> Tuple[float, str]:
    if not year:
        return 1.0, "άγνωστη παλαιότητα — χωρίς προσαρμογή"
    age = reference_year - year
    if age < 0:
        return 1.10, "υπό κατασκευή"
    if year < 1940:
        # Pre-war stock is either a liability or a listed-building premium; the
        # spread is wide, so this stays deliberately neutral and gets flagged.
        return 0.97, f"προπολεμικό ({year}) — ακραία διασπορά αξιών"
    if age <= 5:
        return 1.12, f"σχεδόν νέο ({age} ετών)"
    if age <= 15:
        return 1.05, f"νεότερο ({age} ετών)"
    if age <= 30:
        return 1.00, f"τυπικής ηλικίας ({age} ετών)"
    if age <= 45:
        return 0.94, f"παλαιότερο ({age} ετών)"
    return 0.87, f"παλαιό ({age} ετών) — πιθανή ανάγκη υποδομών"


def _size_multiplier(size: Optional[float]) -> Tuple[float, str]:
    """Small units fetch more per sqm; very large ones fetch less and sell slower."""
    if not size:
        return 1.0, "άγνωστο εμβαδόν"
    if size < 30:
        return 1.12, f"πολύ μικρό ({size:.0f} τ.μ.) — υψηλό €/τ.μ., στενότερη αγορά"
    if size < 45:
        return 1.06, f"μικρό ({size:.0f} τ.μ.)"
    if size <= 110:
        return 1.00, f"τυπικό μέγεθος ({size:.0f} τ.μ.)"
    if size <= 160:
        return 0.95, f"μεγάλο ({size:.0f} τ.μ.) — μικρότερη δεξαμενή αγοραστών"
    return 0.89, f"πολύ μεγάλο ({size:.0f} τ.μ.) — περιορισμένη ζήτηση"


def _floor_multiplier(facts: PropertyFacts) -> Tuple[float, str]:
    base = FLOOR_MULTIPLIER.get(facts.floor_band, 1.0)
    label = {"basement": "υπόγειο", "semi_basement": "ημιυπόγειο", "ground": "ισόγειο",
             "mezzanine": "ημιώροφος", "low": "1ος–3ος", "mid": "4ος–5ος",
             "high": "6ος+", "top": "ρετιρέ"}[facts.floor_band]
    if facts.has_lift is False and facts.floor_band in ("mid", "high", "top"):
        return base * 0.84, f"{label} χωρίς ανελκυστήρα — σοβαρή έκπτωση"
    return base, label


@dataclasses.dataclass
class Adjustment:
    name: str
    multiplier: float
    reason: str
    known: bool

    @property
    def effect_pct(self) -> float:
        return (self.multiplier - 1.0) * 100.0


@dataclasses.dataclass
class Valuation:
    base_per_sqm: float
    comparable_count: int
    comparable_spread: float
    adjustments: List[Adjustment]
    open_market: float
    immediate: float
    confidence_pct: float
    low: float
    high: float
    notes: List[str] = dataclasses.field(default_factory=list)

    @property
    def total_multiplier(self) -> float:
        product = 1.0
        for adjustment in self.adjustments:
            product *= adjustment.multiplier
        return product

    def factor_table(self) -> List[Tuple[str, str, str, str]]:
        """Rows of (factor, effect, reason, source) for display."""
        return [
            (a.name, f"{a.effect_pct:+.1f}%", a.reason,
             "δεδομένο" if a.known else "παραδοχή")
            for a in self.adjustments
        ]


def value_property(
    listing: Listing,
    neighbourhood_per_sqm: Optional[float],
    comparables: Optional[Sequence[float]] = None,
    facts: Optional[PropertyFacts] = None,
    liquidity_score: float = 60.0,
) -> Optional[Valuation]:
    """Open-market and immediate resale value, with every factor exposed.

    `neighbourhood_per_sqm` is the median asking EUR/sqm of comparable stock;
    `comparables` are the raw values behind it, used to size the confidence band.
    `liquidity_score` (0-100, from the screener) drives how deep the discount for
    a fast sale has to be.
    """
    if not (neighbourhood_per_sqm and listing.size_sqm):
        return None

    facts = facts or infer_facts(listing)
    comparables = list(comparables or [])
    notes: List[str] = []

    # Asking prices are not transaction prices. Greek residential asking prices
    # have historically cleared 5-10% below list; without transaction data this
    # haircut is the honest way to bridge the gap.
    asking_to_transaction = 0.93
    base_per_sqm = neighbourhood_per_sqm * asking_to_transaction
    notes.append(
        "Η βάση είναι ζητούμενες τιμές μειωμένες κατά 7% για να προσεγγίσει "
        "τιμές συναλλαγής. Αν έχετε πραγματικά συμβόλαια της περιοχής, "
        "αντικαταστήστε τη βάση με αυτά."
    )

    age_mult, age_reason = _age_multiplier(facts.construction_year)
    size_mult, size_reason = _size_multiplier(facts.size_sqm)
    floor_mult, floor_reason = _floor_multiplier(facts)

    adjustments = [
        Adjustment("Κατάσταση", CONDITION_MULTIPLIER.get(facts.condition, 1.0),
                   {"structural_needed": "ημιτελές / ριζική αποκατάσταση",
                    "needs_work": "χρήζει ανακαίνισης", "average": "κατοικήσιμο",
                    "renovated": "ανακαινισμένο", "new_build": "νεόδμητο"}[facts.condition],
                   "κατάσταση" not in facts.assumed),
        Adjustment("Όροφος", floor_mult, floor_reason, "όροφος" not in facts.assumed),
        Adjustment("Παλαιότητα", age_mult, age_reason, "έτος κατασκευής" not in facts.assumed),
        Adjustment("Μέγεθος", size_mult, size_reason, facts.size_sqm is not None),
        Adjustment("Ενεργειακή κλάση",
                   ENERGY_MULTIPLIER.get(facts.energy_class or "C", 1.0),
                   f"κλάση {facts.energy_class}" if facts.energy_class else "άγνωστη — ουδέτερη",
                   facts.energy_class is not None),
        Adjustment("Νομική κατάσταση", LEGAL_MULTIPLIER.get(facts.legal_status, 1.0),
                   {"clean": "καθαροί τίτλοι (παραδοχή έως τον έλεγχο)",
                    "pending_planning": "εκκρεμής τακτοποίηση",
                    "encumbered": "βάρη προς εξάλειψη",
                    "bare_ownership": "ψιλή κυριότητα",
                    "part_share": "ποσοστό εξ αδιαιρέτου",
                    "occupied": "κατεχόμενο"}[facts.legal_status],
                   "νομική κατάσταση" not in facts.assumed),
    ]

    multiplier = 1.0
    for adjustment in adjustments:
        multiplier *= adjustment.multiplier

    open_market = base_per_sqm * facts.size_sqm * multiplier

    # A fast sale costs more where stock sits longer.
    speed_discount = 0.99 - 0.16 * (1.0 - min(1.0, max(0.0, liquidity_score / 100.0)))
    immediate = open_market * speed_discount
    notes.append(
        f"Άμεση ρευστοποίηση: −{(1 - speed_discount) * 100:.0f}% έναντι ανοιχτής αγοράς, "
        f"με βάση ρευστότητα περιοχής {liquidity_score:.0f}/100."
    )

    # Confidence: thin or dispersed comparables and guessed factors all widen it.
    spread = 0.0
    if len(comparables) >= 4:
        median = statistics.median(comparables)
        if median:
            spread = statistics.pstdev(comparables) / median
    depth = min(1.0, len(comparables) / 12.0)
    confidence = 100.0 * facts.certainty * (0.45 + 0.55 * depth) * max(0.4, 1.0 - spread)
    confidence = round(max(15.0, min(92.0, confidence)), 1)
    band = (1.0 - confidence / 100.0) * 0.55

    if facts.assumed:
        notes.append("Παραδοχές που στενεύουν την ακρίβεια: " + ", ".join(facts.assumed) + ".")
    if len(comparables) < 6:
        notes.append(f"Μόνο {len(comparables)} συγκριτικά — η εκτίμηση είναι ενδεικτική.")

    return Valuation(
        base_per_sqm=round(base_per_sqm, 2),
        comparable_count=len(comparables),
        comparable_spread=round(spread, 3),
        adjustments=adjustments,
        open_market=round(open_market, 0),
        immediate=round(immediate, 0),
        confidence_pct=confidence,
        low=round(open_market * (1 - band), 0),
        high=round(open_market * (1 + band), 0),
        notes=notes,
    )


def value_after_works(
    valuation: Valuation,
    facts: PropertyFacts,
    target_condition: str = "renovated",
) -> Tuple[float, str]:
    """Open-market value once the unit is brought to `target_condition`.

    The uplift is proportional and anchored to the neighbourhood's own base, so
    it is inherently bounded by the street: renovating a unit in a EUR 900/sqm
    area yields a EUR 900/sqm area's renovated price, not an Athens one.

    An earlier version carried an extra absolute "street ceiling" on top of
    this. It was removed once a test showed it could never trigger with any
    sane condition table - the proportional uplift always landed below it. A
    safeguard that cannot fire is worse than none, because it reads like
    protection that is not there. The constraint that does bite lives in
    `strategies._best_works_level`, which refuses works that do not pay for
    themselves, and is covered by its own test.
    """
    current = CONDITION_MULTIPLIER.get(facts.condition, 1.0)
    target = CONDITION_MULTIPLIER.get(target_condition, 1.0)
    if target <= current:
        return valuation.open_market, "καμία αναβάθμιση κατάστασης"
    uplifted = valuation.open_market * (target / current)
    return round(uplifted, 0), f"αναβάθμιση σε «{target_condition}»"


def value_at_horizon(
    open_market_value: float,
    months: int,
    annual_drift_pct: float,
) -> float:
    """Project a value forward at a regional drift rate."""
    return round(open_market_value * (1 + annual_drift_pct / 100.0) ** (months / 12.0), 0)
