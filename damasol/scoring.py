"""
Opportunity scoring.

A cheap listing is not the same thing as a good deal. This module turns raw
listings into a ranked shortlist by asking six questions and weighting the
answers:

  value_gap     Is it priced below what comparable stock in the same area asks?
  rental_yield  What gross yield would local rents produce against this price?
  liquidity     Is there a real market here, or is it a place nobody buys in?
  ticket_fit    Does the ticket leave room for costs and renovation?
  upside        Is there headroom to add value (condition, age, repositioning)?
  freshness     Are we early on it - or is it stale enough to negotiate hard?

Every component returns 0-100 and carries a Greek explanation, so the shortlist
can be defended line by line rather than taken on faith.
"""
from __future__ import annotations

import re
import statistics
from typing import Dict, Iterable, List, Optional, Sequence

from .geo import geo_cell, nearest_urban_centre
from .models import Listing, ScoredListing

DEFAULT_WEIGHTS: Dict[str, float] = {
    "value_gap": 0.35,
    "rental_yield": 0.25,
    "liquidity": 0.15,
    "ticket_fit": 0.10,
    "upside": 0.10,
    "freshness": 0.05,
}

COMPONENT_LABELS_EL = {
    "value_gap": "Τιμή έναντι αγοράς",
    "rental_yield": "Εκτιμώμενη απόδοση",
    "liquidity": "Ρευστότητα αγοράς",
    "ticket_fit": "Καταλληλότητα εισιτηρίου",
    "upside": "Περιθώριο υπεραξίας",
    "freshness": "Χρόνος στην αγορά",
}

# Condition keywords lifted from Greek listing copy.
_NEEDS_WORK = re.compile(
    r"χρήζει ανακαίν|για ανακαίν|ανακαινίσιμ|προς ανακαίν|παλαι[όάο]|"
    r"ημιτελ|διατηρητ|επισκευ|αποκατάστασ",
    re.I,
)
_ALREADY_DONE = re.compile(r"ανακαινισμ|νεόδμητ|νεοδμητ|υπό κατασκευ|καινούρι", re.I)
_INCOME_READY = re.compile(r"μισθωμ|επενδυτικ|απόδοσ|εισόδημ|airbnb|βραχυχρόν", re.I)
_TOURISM = re.compile(r"θέα|θάλασσ|παραλί|πρώτη σειρά|νησ", re.I)

MIN_SANE_PRICE = 5000.0


def _median(values: Sequence[float]) -> Optional[float]:
    """Median with the extremes trimmed once the sample is big enough.

    Listing feeds carry typos and part-share prices; a single 80 EUR/sqm entry
    would otherwise drag a neighbourhood baseline down far enough to invent a
    bargain that is not there.
    """
    clean = sorted(v for v in values if v and v > 0)
    if not clean:
        return None
    if len(clean) >= 8:
        cut = max(1, len(clean) // 10)
        clean = clean[cut:-cut] or clean
    return statistics.median(clean)


def _gr(value: float, decimals: int = 0) -> str:
    """Format a number the Greek way: 1.234.567,89"""
    formatted = f"{value:,.{decimals}f}"
    return formatted.replace(",", "\x00").replace(".", ",").replace("\x00", ".")


def _clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


def _interpolate(value: float, points: Sequence[tuple]) -> float:
    """Piecewise-linear map. `points` is ascending [(input, score), ...]."""
    if value <= points[0][0]:
        return points[0][1]
    if value >= points[-1][0]:
        return points[-1][1]
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        if x0 <= value <= x1:
            if x1 == x0:
                return y1
            return y0 + (y1 - y0) * (value - x0) / (x1 - x0)
    return points[-1][1]


class MarketIndex:
    """Median asking / rent levels per area, used as the comparison baseline.

    Two granularities are kept per item type: a ~5 km geo cell (preferred) and
    the area name (fallback for listings without coordinates).
    """

    def __init__(self, cell_size: float = 0.02, min_comparables: int = 4):
        self.cell_size = cell_size
        self.min_comparables = min_comparables
        self._sale_sub: Dict[tuple, List[float]] = {}
        self._sale_cell: Dict[tuple, List[float]] = {}
        self._sale_area: Dict[tuple, List[float]] = {}
        self._rent_sub: Dict[tuple, List[float]] = {}
        self._rent_cell: Dict[tuple, List[float]] = {}
        self._rent_area: Dict[tuple, List[float]] = {}
        self._cell_supply: Dict[tuple, int] = {}
        self.last_basis: str = ""

    # ------------------------------------------------------------- ingest
    def add_sale_comparables(self, listings: Iterable[Listing]) -> int:
        return self._add(
            listings, self._sale_sub, self._sale_cell, self._sale_area, count_supply=True
        )

    def add_rent_comparables(self, listings: Iterable[Listing]) -> int:
        return self._add(listings, self._rent_sub, self._rent_cell, self._rent_area)

    def _add(self, listings, sub_map, cell_map, area_map, count_supply: bool = False) -> int:
        added = 0
        for listing in listings:
            ppsm = listing.price_per_sqm
            if not ppsm or ppsm <= 0:
                continue
            if listing.sub_area:
                sub_map.setdefault((listing.item_type, listing.sub_area), []).append(ppsm)
            cell = geo_cell(listing.lat, listing.lng, self.cell_size)
            if cell:
                key = (listing.item_type, cell)
                cell_map.setdefault(key, []).append(ppsm)
                if count_supply:
                    self._cell_supply[key] = self._cell_supply.get(key, 0) + 1
            if listing.area_name:
                area_map.setdefault((listing.item_type, listing.area_name), []).append(ppsm)
            added += 1
        return added

    # ------------------------------------------------------------- lookup
    def _lookup(self, listing: Listing, sub_map, cell_map, area_map):
        """Most specific baseline first.

        A 5 km cell in central Thessaloniki spans neighbourhoods whose prices
        differ by a factor of three, so matching on the neighbourhood string the
        portal itself publishes beats matching on geography wherever it is
        available. Falls back to the cell, then the municipality.
        """
        if listing.sub_area:
            values = sub_map.get((listing.item_type, listing.sub_area), [])
            if len(values) >= self.min_comparables:
                return _median(values), "γειτονιά"
        cell = geo_cell(listing.lat, listing.lng, self.cell_size)
        if cell:
            values = cell_map.get((listing.item_type, cell), [])
            if len(values) >= self.min_comparables:
                return _median(values), "κελί ~2 χλμ"
        if listing.area_name:
            values = area_map.get((listing.item_type, listing.area_name), [])
            if len(values) >= self.min_comparables:
                return _median(values), "δήμος"
        return None, ""

    def sale_price_per_sqm(self, listing: Listing) -> Optional[float]:
        value, basis = self._lookup(listing, self._sale_sub, self._sale_cell, self._sale_area)
        self.last_basis = basis
        return value

    def rent_price_per_sqm(self, listing: Listing) -> Optional[float]:
        value, _ = self._lookup(listing, self._rent_sub, self._rent_cell, self._rent_area)
        return value

    def supply(self, listing: Listing) -> int:
        cell = geo_cell(listing.lat, listing.lng, self.cell_size)
        return self._cell_supply.get((listing.item_type, cell), 0) if cell else 0

    def summary(self) -> Dict[str, int]:
        return {
            "sale_neighbourhoods": len(self._sale_sub),
            "sale_cells": len(self._sale_cell),
            "sale_areas": len(self._sale_area),
            "rent_neighbourhoods": len(self._rent_sub),
            "rent_cells": len(self._rent_cell),
            "rent_areas": len(self._rent_area),
        }


# ------------------------------------------------------------------ scoring


# Above these levels the number is far more likely to be a comparables
# mismatch or a legal quirk (part share, bare ownership) than a real bargain,
# so the score plateaus and the listing is flagged for manual verification.
IMPLAUSIBLE_DISCOUNT_PCT = 55.0
IMPLAUSIBLE_YIELD_PCT = 14.0


def _score_value_gap(listing, market_ppsm, basis, evidence, flags):
    if not listing.price_per_sqm or not market_ppsm:
        evidence.append("Τιμή/τ.μ.: δεν βρέθηκαν επαρκή συγκριτικά στην περιοχή.")
        flags.append("Χωρίς συγκριτικά αγοράς")
        return 50.0, None

    discount = 1.0 - (listing.price_per_sqm / market_ppsm)
    pct = round(discount * 100, 1)
    scope = f" ({basis})" if basis else ""

    if pct >= 0:
        evidence.append(
            f"Ζητάει {_gr(listing.price_per_sqm)} €/τ.μ. έναντι διαμέσου "
            f"{_gr(market_ppsm)} €/τ.μ. στα συγκριτικά{scope} — έκπτωση {pct:.0f}%."
        )
    else:
        evidence.append(
            f"Ζητάει {_gr(listing.price_per_sqm)} €/τ.μ., δηλαδή {abs(pct):.0f}% "
            f"πάνω από τη διάμεσο των συγκριτικών{scope} ({_gr(market_ppsm)} €/τ.μ.)."
        )

    if pct > IMPLAUSIBLE_DISCOUNT_PCT:
        flags.append(
            f"Έκπτωση {pct:.0f}% — υπερβολικά μεγάλη για να ληφθεί τοις μετρητοίς. "
            "Είτε τα συγκριτικά δεν είναι πραγματικά όμοια, είτε υπάρχει νομικός "
            "λόγος (ποσοστό συνιδιοκτησίας, ψιλή κυριότητα, βάρη). Απαιτείται έλεγχος."
        )

    # The curve plateaus at the plausibility ceiling: a claimed 75% discount
    # earns no more credit than a verified 55% one.
    score = _interpolate(
        min(discount, IMPLAUSIBLE_DISCOUNT_PCT / 100.0),
        [(-0.30, 0), (-0.10, 25), (0.0, 40), (0.15, 62), (0.30, 82), (0.45, 95), (0.55, 100)],
    )
    return score, pct


def _quality_haircut(listing, market_ppsm) -> float:
    """How much of the neighbourhood's rent this property can realistically ask.

    A flat selling at a fifth of what its street sells for is cheap for reasons
    - condition, floor, layout, legal state - that hit the rent too. Assuming it
    achieves the local median rent is what manufactures 20% yields that do not
    exist. The haircut scales the rent estimate with the property's price
    position, floored at 60% so it never collapses to zero.
    """
    if not (market_ppsm and listing.price_per_sqm and market_ppsm > 0):
        return 1.0
    position = min(1.0, listing.price_per_sqm / market_ppsm)
    return 0.5 + 0.5 * position


def _score_rental_yield(listing, rent_ppsm, market_ppsm, evidence, flags):
    if not (rent_ppsm and listing.size_sqm and listing.price and listing.price > 0):
        evidence.append("Απόδοση: δεν υπολογίστηκε (λείπουν συγκριτικά ενοικίων ή εμβαδόν).")
        return 45.0, None, None

    haircut = _quality_haircut(listing, market_ppsm)
    rent_ppsm = rent_ppsm * haircut
    monthly_rent = rent_ppsm * listing.size_sqm
    gross_yield = (monthly_rent * 12.0) / listing.price * 100.0
    adjustment = (
        f", μειωμένο κατά {(1 - haircut) * 100:.0f}% επειδή το ακίνητο πωλείται "
        f"σημαντικά κάτω από τη γειτονιά του" if haircut < 0.97 else ""
    )
    evidence.append(
        f"Εκτιμώμενο ενοίκιο ~{_gr(monthly_rent)} €/μήνα βάσει "
        f"{rent_ppsm:.1f} €/τ.μ./μήνα στα συγκριτικά ενοικίων{adjustment} → μεικτή "
        f"απόδοση {gross_yield:.1f}% (προ εξόδων, φόρων και κενών περιόδων)."
    )
    if gross_yield > IMPLAUSIBLE_YIELD_PCT:
        flags.append(
            f"Θεωρητική απόδοση {gross_yield:.0f}% — πολύ πάνω από ό,τι αποδίδει "
            "ρεαλιστικά η ελληνική αγορά. Πιθανή αναντιστοιχία συγκριτικών ενοικίων· "
            "επαληθεύστε με πραγματικά μισθωτήρια της γειτονιάς."
        )
    # Same plateau logic as the discount: implausible yields stop earning credit.
    score = _interpolate(
        min(gross_yield, IMPLAUSIBLE_YIELD_PCT),
        [(0, 0), (3, 15), (5, 45), (7, 70), (9, 88), (11, 97), (14, 100)],
    )
    return score, round(monthly_rent, 0), round(gross_yield, 2)


def _score_liquidity(listing, index, evidence, flags):
    centre, distance_km, tier = nearest_urban_centre(listing.lat, listing.lng)
    if centre is None:
        flags.append("Χωρίς συντεταγμένες — αδύνατη αξιολόγηση θέσης")
        return 35.0

    base = {1: 88.0, 2: 74.0, 3: 60.0}.get(tier, 45.0)
    # Value decays with distance from the centre that anchors the market.
    decay = _interpolate(distance_km, [(0, 1.0), (15, 0.95), (40, 0.78), (80, 0.60), (150, 0.45)])
    supply = index.supply(listing)
    supply_bonus = _interpolate(supply, [(0, -8), (4, 0), (15, 6), (60, 10), (200, 4)])

    evidence.append(
        f"Πλησιέστερη αγορά: {centre} ({distance_km:.0f} χλμ) · "
        f"{supply} συγκρίσιμες αγγελίες στο κελί περιοχής."
    )
    if distance_km > 120:
        flags.append("Απομακρυσμένη αγορά — περιορισμένη ρευστότητα εξόδου")
    return _clamp(base * decay + supply_bonus)


def _score_ticket_fit(listing, budget, evidence, flags):
    if not listing.price:
        flags.append("Χωρίς τιμή")
        return 30.0
    if listing.price < MIN_SANE_PRICE:
        flags.append(
            "Τιμή κάτω των 5.000 € — συνήθως ποσοστό ιδιοκτησίας ή ψιλή κυριότητα, όχι πλήρες ακίνητο"
        )
    if not budget:
        return 60.0
    ratio = listing.price / budget
    # Sweet spot: 35%-85% of budget, leaving room for taxes, fees, renovation.
    score = _interpolate(ratio, [(0.0, 25), (0.10, 45), (0.35, 90), (0.70, 100), (0.85, 88), (1.0, 70)])
    evidence.append(
        f"Τίμημα {_gr(listing.price)} € = {ratio * 100:.0f}% του ορίου "
        f"{_gr(budget)} €, αφήνοντας περιθώριο για φόρο μεταβίβασης, έξοδα και ανακαίνιση."
    )
    return score


def _score_upside(listing, evidence, flags):
    text = " ".join([listing.title or "", listing.description_hint or ""])
    score = 50.0

    if _NEEDS_WORK.search(text):
        score += 25
        evidence.append("Η αγγελία υποδηλώνει ανάγκη ανακαίνισης — περιθώριο δημιουργίας υπεραξίας.")
    if _ALREADY_DONE.search(text):
        score -= 12
        evidence.append("Ανακαινισμένο/νεόδμητο — μικρότερο περιθώριο υπεραξίας, μικρότερο ρίσκο έργου.")
    if _INCOME_READY.search(text):
        score += 12
        evidence.append("Αναφορά σε μίσθωση/επενδυτική χρήση — δυνητικά άμεσο εισόδημα.")
    if _TOURISM.search(text):
        score += 8
        evidence.append("Χαρακτηριστικά τουριστικού ενδιαφέροντος (θέα/θάλασσα) — εναλλακτική βραχυχρόνιας μίσθωσης.")

    year = listing.construction_year
    if year:
        if year < 1960:
            score += 8
            flags.append("Κτίσμα προ 1960 — έλεγχος στατικής επάρκειας και αυθαιρεσιών")
        elif year < 1985:
            score += 10
        elif year >= 2010:
            score -= 5
        evidence.append(f"Έτος κατασκευής {year}.")

    if listing.item_type == "land":
        flags.append("Γη — έλεγχος αρτιότητας, οικοδομησιμότητας, όρων δόμησης και δασικών χαρτών")
        score += 5
    if listing.transaction == "AUCTION" or listing.auction_date:
        flags.append("Πλειστηριασμός — έλεγχος βαρών, κατοίκησης και διαδικασίας αποβολής")

    return _clamp(score)


def _score_freshness(listing, evidence, flags):
    days = listing.listed_age_days
    if days is None:
        return 50.0
    if days <= 14:
        evidence.append(f"Νέα αγγελία ({days} ημ.) — πλεονέκτημα πρώτης κίνησης.")
        return 100.0
    if days <= 90:
        evidence.append(f"Στην αγορά {days} ημέρες.")
        return 60.0
    # A listing nobody has taken in six months is negotiating leverage, not noise.
    evidence.append(
        f"Στην αγορά {days} ημέρες — ώριμη για διαπραγμάτευση, πιθανή πίεση πωλητή."
    )
    return 68.0 if days > 180 else 45.0


def grade_for(score: float) -> str:
    if score >= 80:
        return "A+"
    if score >= 72:
        return "A"
    if score >= 63:
        return "B"
    if score >= 54:
        return "C"
    return "D"


def score_listing(
    listing: Listing,
    index: MarketIndex,
    budget: Optional[float] = None,
    weights: Optional[Dict[str, float]] = None,
) -> ScoredListing:
    weights = weights or DEFAULT_WEIGHTS
    evidence: List[str] = []
    flags: List[str] = []

    market_ppsm = index.sale_price_per_sqm(listing)
    basis = index.last_basis
    rent_ppsm = index.rent_price_per_sqm(listing)

    value_gap, discount_pct = _score_value_gap(listing, market_ppsm, basis, evidence, flags)
    rental, monthly_rent, gross_yield = _score_rental_yield(
        listing, rent_ppsm, market_ppsm, evidence, flags
    )
    components = {
        "value_gap": round(value_gap, 1),
        "rental_yield": round(rental, 1),
        "liquidity": round(_score_liquidity(listing, index, evidence, flags), 1),
        "ticket_fit": round(_score_ticket_fit(listing, budget, evidence, flags), 1),
        "upside": round(_score_upside(listing, evidence, flags), 1),
        "freshness": round(_score_freshness(listing, evidence, flags), 1),
    }

    total = sum(components[key] * weights.get(key, 0.0) for key in components)

    if not listing.size_sqm:
        total -= 8
        flags.append("Άγνωστο εμβαδόν — αδύνατη σύγκριση €/τ.μ.")
    if listing.price and listing.price < MIN_SANE_PRICE:
        total -= 15
    if discount_pct is not None and discount_pct > IMPLAUSIBLE_DISCOUNT_PCT:
        # Unverifiable upside is not upside; hold it back until someone looks.
        total -= 6
    if gross_yield is not None and gross_yield > IMPLAUSIBLE_YIELD_PCT:
        total -= 6
    if listing.lat is None:
        total -= 5

    total = round(_clamp(total), 1)
    return ScoredListing(
        listing=listing,
        score=total,
        grade=grade_for(total),
        components=components,
        evidence=evidence,
        flags=flags,
        market_price_per_sqm=round(market_ppsm, 2) if market_ppsm else None,
        discount_pct=discount_pct,
        est_monthly_rent=monthly_rent,
        gross_yield_pct=gross_yield,
    )


def score_all(
    listings: Iterable[Listing],
    index: MarketIndex,
    budget: Optional[float] = None,
    weights: Optional[Dict[str, float]] = None,
) -> List[ScoredListing]:
    scored = [score_listing(l, index, budget, weights) for l in listings]
    scored.sort(key=lambda s: s.score, reverse=True)
    return scored
