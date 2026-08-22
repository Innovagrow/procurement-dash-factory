# -*- coding: utf-8 -*-
"""
Separate indicators, and one combined score built from them.

The engine used to rank on how far a listing sat below its neighbours' asking
prices. That was the wrong axis to hang a decision on: an asking price is a
seller's opinion, not a fact, and a "60% discount" is as likely to mean the
neighbours are dreaming as it is to mean anything. Rank on return instead, and
give the reliability of that return its own visible axis.

Six indicators, each 0-100, each computed on an ABSOLUTE scale so numbers from
different properties can be compared:

  απόδοση     annualised return on the capital actually tied up
  ταχύτητα    how soon the money comes back - both first cash and full exit
  κεφάλαιο    how little you need to start
  ευκολία     how little of your attention it consumes
  βεβαιότητα  how much of the return rests on measurement vs. on assumption
  ρίσκο       how badly it goes if the plan is wrong (inverted: high = safe)

They are reported separately AND combined. Nothing is hidden: a plan that scores
92 on return and 31 on certainty says exactly that, instead of averaging into a
comfortable 61 that means nothing.
"""
from __future__ import annotations

import dataclasses
from typing import Dict, Optional, Sequence, Tuple

# Ranking must be comparable across properties, so every indicator maps an
# absolute quantity onto 0-100 rather than ranking within one property's plans.
DEFAULT_CAPITAL_CEILING = 250_000.0

DEFAULT_INDICATOR_WEIGHTS: Dict[str, float] = {
    "return": 0.35,
    "certainty": 0.20,
    "speed": 0.15,
    "capital": 0.15,
    "ease": 0.10,
    "risk": 0.05,
}

# Two label sets. The long one is what a reader who has never seen this system
# should be able to understand without a glossary; the short one exists only
# because table columns have a width. Jargon like "certainty" or "ROI" was
# replaced with the plain question each number actually answers.
INDICATOR_LABELS_EL = {
    "return": "Πόσα βγάζεις τον χρόνο",
    "certainty": "Πόσο κέρδος μένει αν οι τιμές είναι φουσκωμένες",
    "speed": "Πόσο γρήγορα γυρίζουν τα λεφτά σου",
    "capital": "Πόσο λίγα λεφτά χρειάζεσαι για να ξεκινήσεις",
    "ease": "Πόσο λίγο θα σε απασχολεί",
    "risk": "Πόσο λίγα πράγματα μπορούν να πάνε στραβά",
}

INDICATOR_SHORT_EL = {
    "return": "Κέρδος",
    "certainty": "Αντοχή",
    "speed": "Ταχύτητα",
    "capital": "Λίγα λεφτά",
    "ease": "Λίγος κόπος",
    "risk": "Λίγο ρίσκο",
}

# The three numbers people ask about most, spelled out.
MEASURE_LABELS_EL = {
    "roi": "Απόδοση με τα νούμερα της αγγελίας",
    "roi_stressed": "Απόδοση αν οι τιμές αποδειχθούν φουσκωμένες",
    "certainty": "Πόσο κέρδος επιβιώνει στο κακό σενάριο",
}

# How much each input can be trusted. These are the heart of the certainty
# indicator, and the reason a rental plan outranks a flip at equal return.
#
# Asking sale prices sit near the bottom on purpose. They are unverified,
# frequently aspirational, and in a thin neighbourhood a handful of stale
# listings can invent a discount that does not exist. Asking RENTS are treated
# as far more reliable: the rental market clears monthly, so what is asked and
# what is achieved stay close.
INPUT_RELIABILITY: Dict[str, float] = {
    "purchase_price": 0.95,     # what you pay is a fact you control
    "acquisition_costs": 0.90,  # statutory rates and published scales
    "rent_level": 0.75,         # fast-clearing market, asking ≈ achieved
    "works_cost": 0.60,         # per-sqm averages; real quotes vary ±40%
    "build_cost": 0.55,
    "operating_model": 0.45,    # running a business on top of the asset
    "sale_comparables": 0.45,   # asking prices - the weakest link
    "short_stay": 0.40,         # nightly rate and occupancy both modelled
    "horizon_drift": 0.35,      # a guess about the future by construction
    "buildable_area": 0.30,     # unverified until the planning office says so
}


def _interpolate(value: float, points: Sequence[Tuple[float, float]]) -> float:
    if value <= points[0][0]:
        return points[0][1]
    if value >= points[-1][0]:
        return points[-1][1]
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        if x0 <= value <= x1:
            return y0 if x1 == x0 else y0 + (y1 - y0) * (value - x0) / (x1 - x0)
    return points[-1][1]


def _clamp(value: float) -> float:
    return max(0.0, min(100.0, value))


@dataclasses.dataclass
class Indicators:
    """Six axes plus the combined score, all 0-100."""

    ret: float = 0.0
    speed: float = 0.0
    capital: float = 0.0
    ease: float = 0.0
    certainty: float = 0.0
    risk: float = 0.0
    combined: float = 0.0
    certainty_breakdown: Dict[str, float] = dataclasses.field(default_factory=dict)

    def as_dict(self) -> Dict[str, float]:
        return {
            "return": round(self.ret, 1),
            "speed": round(self.speed, 1),
            "capital": round(self.capital, 1),
            "ease": round(self.ease, 1),
            "certainty": round(self.certainty, 1),
            "risk": round(self.risk, 1),
            "combined": round(self.combined, 1),
        }


# How much of the headline return we are willing to bank on when the stressed
# case says something different. 0.65 on the stressed number means a plan is
# scored mostly on what survives a bad-data scenario, without discarding upside
# entirely.
STRESSED_WEIGHT = 0.65


def score_return(annualised_roi_pct: float,
                 annualised_roi_stressed_pct: Optional[float] = None) -> float:
    """Annualised return onto 0-100, absolute so properties compare.

    Anchored on what money costs and what alternatives pay: ~4% is a bond, 10%
    is a decent property deal, 25% is very good, past 45% you are either
    exceptional or wrong.

    When a stressed figure is supplied the score leans on it. Ranking on the
    headline alone would reproduce exactly the problem this redesign exists to
    fix: a return computed from asking-price comparables can be fiction, and
    sorting by fiction puts fiction on top. Both numbers are reported; only the
    conservative blend is ranked.
    """
    effective = annualised_roi_pct
    if annualised_roi_stressed_pct is not None:
        effective = (
            STRESSED_WEIGHT * annualised_roi_stressed_pct
            + (1 - STRESSED_WEIGHT) * annualised_roi_pct
        )
    return _clamp(_interpolate(
        effective,
        [(-20, 0), (0, 8), (4, 22), (8, 40), (12, 55), (18, 70), (25, 82), (40, 94), (60, 100)],
    ))


def score_speed(months_to_exit: int, months_to_first_cash: int) -> float:
    """How soon money returns. Weighted toward first cash, not just exit.

    A five-year hold that starts paying in month four is not slow money in the
    way a five-year hold with a single payout at the end is.
    """
    exit_speed = _interpolate(
        months_to_exit,
        [(3, 100), (8, 88), (12, 78), (24, 60), (36, 47), (60, 30), (96, 15), (144, 5)],
    )
    cash_speed = _interpolate(
        months_to_first_cash,
        [(0, 100), (3, 92), (6, 80), (12, 62), (24, 40), (36, 25), (60, 10)],
    )
    return _clamp(0.55 * exit_speed + 0.45 * cash_speed)


def score_capital(capital_required: float,
                  ceiling: float = DEFAULT_CAPITAL_CEILING) -> float:
    """Lower capital scores higher, on an absolute scale against a ceiling."""
    if capital_required <= 0:
        return 100.0
    return _clamp(_interpolate(
        capital_required / ceiling,
        [(0.0, 100), (0.1, 92), (0.2, 82), (0.35, 68), (0.5, 55), (0.75, 35), (1.0, 18), (1.6, 0)],
    ))


# The downside case every plan is re-priced under. Both numbers say the same
# thing: assume the market data flattered us.
STRESS_TERMINAL = 0.80   # asking comparables were 20% optimistic
STRESS_RENT = 0.85       # asking rents were 15% optimistic


def score_certainty(
    profit_base: float,
    profit_stressed: float,
    income_share: float,
    valuation_confidence_pct: float,
    income_kind: str = "rent_level",
    uses_works: bool = False,
    uses_build: bool = False,
    uses_buildable_estimate: bool = False,
) -> Tuple[float, Dict[str, float]]:
    """How much of this return survives if the market data was flattering us.

    An earlier version measured what SHARE of gross inflow came from each
    source. That was the wrong question, and it showed: every plan scored
    within four points of every other, because for a cheap Greek flat even a
    ten-year rental hold is mostly a bet on the eventual sale.

    The question that discriminates is not where the money comes from but what
    happens to the PROFIT when the weakest input is wrong. Re-price the plan
    with comparables 20% lower and rents 15% lower, and see what is left. A flip
    whose entire margin is the comparables loses almost all of it. A rental hold
    keeps collecting rent and can simply wait. That difference is the whole
    point, and it is the answer to "the discount on the portal might be a lie":
    the plan that depends on the lie is marked fragile.
    """
    if profit_base > 0:
        resilience = max(0.0, min(1.0, profit_stressed / profit_base))
    else:
        resilience = 0.0

    # Even a fully exposed plan is not zero-knowledge; even a resilient one is
    # not certain. The floor and ceiling keep the axis honest at both ends.
    core = 0.30 + 0.70 * resilience

    income_reliability = INPUT_RELIABILITY.get(income_kind, 0.5)
    share = max(0.0, min(1.0, income_share))
    revenue_reliability = (
        share * income_reliability + (1 - share) * INPUT_RELIABILITY["sale_comparables"]
    )

    breakdown = {
        "ανθεκτικότητα κέρδους": round(resilience * 100, 1),
        "αξιοπιστία εσόδων": round(revenue_reliability * 100, 1),
    }

    base = core * (0.55 + 0.45 * revenue_reliability / 0.95)

    # Cost-side uncertainty erodes certainty even when revenue is solid.
    if uses_works:
        base *= 0.90 + 0.10 * INPUT_RELIABILITY["works_cost"]
        breakdown["κόστος έργων"] = round(INPUT_RELIABILITY["works_cost"] * 100, 1)
    if uses_build:
        base *= 0.82 + 0.18 * INPUT_RELIABILITY["build_cost"]
        breakdown["κόστος κατασκευής"] = round(INPUT_RELIABILITY["build_cost"] * 100, 1)
    if uses_buildable_estimate:
        base *= INPUT_RELIABILITY["buildable_area"] + 0.35
        breakdown["δομήσιμη επιφάνεια"] = round(INPUT_RELIABILITY["buildable_area"] * 100, 1)

    # And none of it can be more certain than the valuation underneath it.
    base *= 0.55 + 0.45 * (max(0.0, min(100.0, valuation_confidence_pct)) / 100.0)
    return _clamp(base * 100.0), breakdown


def combine(indicators: Indicators,
            weights: Optional[Dict[str, float]] = None) -> float:
    weights = {**DEFAULT_INDICATOR_WEIGHTS, **(weights or {})}
    total = sum(weights.values()) or 1.0
    weights = {key: value / total for key, value in weights.items()}
    return round(
        weights["return"] * indicators.ret
        + weights["certainty"] * indicators.certainty
        + weights["speed"] * indicators.speed
        + weights["capital"] * indicators.capital
        + weights["ease"] * indicators.ease
        + weights["risk"] * indicators.risk,
        1,
    )
