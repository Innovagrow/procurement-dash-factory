# -*- coding: utf-8 -*-
"""
Every way to make money from one property, priced and compared.

Rather than a hand-written list of strategies, plans are generated as a matrix:

    ΑΠΟΚΤΗΣΗ × ΜΕΤΑΣΧΗΜΑΤΙΣΜΟΣ × ΕΞΟΔΟΣ

    κτίσμα | οικόπεδο/αγροτεμάχιο | αντιπαροχή
      ×  τίποτα | ελαφριά | πλήρης | ριζική ανακαίνιση | ανέγερση
      ×  πώληση | μακροχρόνια | βραχυχρόνια | φοιτητική | επαγγελματική
         μίσθωση | λειτουργία επιχείρησης | διακράτηση

so "buy a plot, build, then let it commercially" and "buy, renovate, then sell"
are the same machinery rather than two special cases, and nothing is left out
because nobody thought to write a function for it. Combinations the property
cannot support come back infeasible with the reason attached.

Ranking is on return, not on how cheap the asking price looked. See
`indicators.py` for why - in short, an asking price is a seller's opinion, and a
plan whose whole return depends on one is marked uncertain rather than being
allowed to top the list.
"""
from __future__ import annotations

import dataclasses
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from .costs import DEFAULT_COSTS, CostModel
from .indicators import (
    DEFAULT_CAPITAL_CEILING,
    DEFAULT_INDICATOR_WEIGHTS,
    STRESS_RENT,
    STRESS_TERMINAL,
    Indicators,
    combine,
    score_capital,
    score_certainty,
    score_return,
    score_speed,
)
from .models import Listing
from .valuation import (
    CONDITION_MULTIPLIER,
    PropertyFacts,
    Valuation,
    value_after_works,
    value_at_horizon,
)

CATEGORY_RESALE = "Μεταπώληση"
CATEGORY_INCOME = "Εισόδημα"
CATEGORY_DEVELOP = "Ανάπτυξη"
CATEGORY_OPERATE = "Λειτουργία επιχείρησης"

# Typical floor-area ratio for a building plot inside a town plan. Used only
# when the real coefficient is unknown, and the plan is flagged and its
# certainty cut hard - an agricultural plot outside the plan may not be
# buildable at all, and no listing field tells us which we are looking at.
DEFAULT_FLOOR_AREA_RATIO = 0.40

# Same haircut valuation.py applies, so finished-space asking rates are
# comparable with the rest of the model.
ASKING_TO_TRANSACTION = 0.93

ACQUISITION_LABELS = {
    "building": "Αγορά κτίσματος",
    "land": "Αγορά γης",
    "antiparochi": "Αντιπαροχή",
}

TRANSFORM_LABELS = {
    "none": "χωρίς εργασίες",
    "cosmetic": "ελαφριά ανακαίνιση",
    "full": "πλήρης ανακαίνιση",
    "structural": "ριζική ανακατασκευή",
    "build": "ανέγερση",
}

TRANSFORM_MONTHS = {"none": 0, "cosmetic": 2, "full": 5, "structural": 9, "build": 20}
TRANSFORM_EASE = {"none": 0.0, "cosmetic": -14.0, "full": -30.0, "structural": -46.0,
                  "build": -58.0}
TRANSFORM_RISK = {"none": 0.0, "cosmetic": 8.0, "full": 20.0, "structural": 34.0,
                  "build": 42.0}

CONDITION_AFTER_WORKS = {"none": None, "cosmetic": "average", "full": "renovated",
                         "structural": "renovated", "build": "new_build"}

EXIT_LABELS = {
    "sell": "πώληση",
    "rent_long": "μακροχρόνια μίσθωση",
    "rent_short": "βραχυχρόνια μίσθωση",
    "rent_student": "φοιτητική μίσθωση",
    "rent_commercial": "επαγγελματική μίσθωση",
    "operate": "λειτουργία επιχείρησης",
    "hold": "διακράτηση",
}

EXIT_CATEGORY = {
    "sell": CATEGORY_RESALE, "rent_long": CATEGORY_INCOME, "rent_short": CATEGORY_INCOME,
    "rent_student": CATEGORY_INCOME, "rent_commercial": CATEGORY_INCOME,
    "operate": CATEGORY_OPERATE, "hold": CATEGORY_DEVELOP,
}

EXIT_BASE_EASE = {
    "sell": 84.0, "rent_long": 74.0, "rent_short": 36.0, "rent_student": 56.0,
    "rent_commercial": 66.0, "operate": 22.0, "hold": 94.0,
}

EXIT_BASE_RISK = {
    "sell": 44.0, "rent_long": 30.0, "rent_short": 58.0, "rent_student": 42.0,
    "rent_commercial": 52.0, "operate": 70.0, "hold": 52.0,
}


@dataclasses.dataclass(frozen=True)
class Plan:
    acquisition: str
    transform: str
    exit: str
    hold_years: float = 0.0

    @property
    def key(self) -> str:
        suffix = f"_{self.hold_years:.0f}Y" if self.hold_years else ""
        return f"{self.acquisition.upper()}_{self.transform.upper()}_{self.exit.upper()}{suffix}"

    @property
    def name(self) -> str:
        parts = [ACQUISITION_LABELS[self.acquisition]]
        if self.transform != "none":
            parts.append(TRANSFORM_LABELS[self.transform])
        parts.append(EXIT_LABELS[self.exit])
        label = " → ".join(parts)
        if self.hold_years and self.exit != "hold":
            label += f" ({self.hold_years:.0f} έτη)"
        elif self.exit == "hold":
            label += f" {self.hold_years:.0f} ετών"
        return label

    @property
    def category(self) -> str:
        if self.transform == "build" or self.acquisition in ("land", "antiparochi"):
            return CATEGORY_DEVELOP if self.exit in ("sell", "hold") else EXIT_CATEGORY[self.exit]
        return EXIT_CATEGORY[self.exit]


@dataclasses.dataclass
class MarketInputs:
    """Everything outside the property itself that pricing a plan needs."""

    monthly_rent: Optional[float] = None       # long-let for average-condition stock
    annual_drift_pct: float = 2.5
    liquidity_score: float = 60.0
    tourism_intensity: float = 0.0
    student_demand: float = 0.0
    commercial_demand: float = 0.0
    buildable_sqm: Optional[float] = None
    floor_area_ratio: Optional[float] = None
    build_cost_per_sqm: float = 1250.0
    capital_ceiling: float = DEFAULT_CAPITAL_CEILING

    # Finished-space comparables. A plot and the building that could stand on
    # it trade in completely different markets: land at tens of euros per sqm,
    # finished flats at thousands. Pricing new construction off the land's own
    # EUR/sqm produced a 70% loss on every build plan until these were split
    # out, which is the kind of error that looks like a conclusion.
    built_price_per_sqm: Optional[float] = None    # sale EUR/sqm of finished space
    rent_per_sqm_month: Optional[float] = None     # rent EUR/sqm/month of finished space

    def derive_from(self, listing) -> "MarketInputs":
        """Fill finished-space rates from the listing itself where it is a building."""
        if listing.item_type != "land" and listing.size_sqm:
            if self.rent_per_sqm_month is None and self.monthly_rent:
                self.rent_per_sqm_month = self.monthly_rent / listing.size_sqm
        return self


@dataclasses.dataclass
class StrategyOutcome:
    plan: Plan
    name: str
    category: str
    feasible: bool
    capital_required: float = 0.0
    net_profit: float = 0.0
    roi_pct: float = 0.0
    annualised_roi_pct: float = 0.0
    months_to_exit: int = 0
    months_to_first_cash: int = 0
    annual_net_income: float = 0.0
    terminal_value: float = 0.0
    net_profit_stressed: float = 0.0
    annualised_roi_stressed_pct: float = 0.0
    indicators: Indicators = dataclasses.field(default_factory=Indicators)
    blockers: List[str] = dataclasses.field(default_factory=list)
    assumptions: List[str] = dataclasses.field(default_factory=list)
    cashflow_note: str = ""

    # Kept so callers written against the old field names keep working.
    @property
    def key(self) -> str:
        return self.plan.key

    @property
    def score(self) -> float:
        return self.indicators.combined

    @property
    def ease(self) -> float:
        return self.indicators.ease

    def to_dict(self) -> Dict:
        data = {
            "plan": self.plan.key,
            "name": self.name,
            "category": self.category,
            "acquisition": self.plan.acquisition,
            "transform": self.plan.transform,
            "exit": self.plan.exit,
            "hold_years": self.plan.hold_years,
            "feasible": self.feasible,
            "capital_required": self.capital_required,
            "net_profit": self.net_profit,
            "roi_pct": self.roi_pct,
            "annualised_roi_pct": self.annualised_roi_pct,
            "annualised_roi_stressed_pct": self.annualised_roi_stressed_pct,
            "net_profit_stressed": self.net_profit_stressed,
            "months_to_exit": self.months_to_exit,
            "months_to_first_cash": self.months_to_first_cash,
            "annual_net_income": self.annual_net_income,
            "terminal_value": self.terminal_value,
            "blockers": " | ".join(self.blockers),
            "assumptions": " | ".join(self.assumptions),
        }
        data.update({f"ind_{k}": v for k, v in self.indicators.as_dict().items()})
        return data


# ----------------------------------------------------------------- helpers


def _annualise(roi_pct: float, months: int) -> float:
    if months <= 0:
        return 0.0
    growth = 1.0 + roi_pct / 100.0
    if growth <= 0:
        return -100.0
    return (growth ** (12.0 / months) - 1.0) * 100.0


def _acquisition_total(price: float, costs: CostModel) -> float:
    return price + sum(costs.acquisition_costs(price).values())


def _resulting_condition(current: str, transform: str) -> str:
    target = CONDITION_AFTER_WORKS[transform]
    if target is None:
        return current
    if CONDITION_MULTIPLIER[target] <= CONDITION_MULTIPLIER[current]:
        return current
    return target


def _rent_for_condition(base_rent: float, resulting: str) -> float:
    """Rent follows condition, but far less steeply than price does."""
    ratio = CONDITION_MULTIPLIER[resulting] / CONDITION_MULTIPLIER["average"]
    return base_rent * (1.0 + 0.6 * (ratio - 1.0))


def _buildable(listing: Listing, market: MarketInputs) -> Tuple[Optional[float], bool]:
    """Buildable area, and whether it had to be estimated."""
    if market.buildable_sqm:
        return market.buildable_sqm, False
    ratio = market.floor_area_ratio or DEFAULT_FLOOR_AREA_RATIO
    if listing.size_sqm:
        return listing.size_sqm * ratio, True
    return None, True


def _operating_concept(listing: Listing, facts: PropertyFacts, market: MarketInputs,
                       built: bool, built_area: float = 0.0
                       ) -> Optional[Tuple[str, float, float, float]]:
    """(concept, turnover multiple of residential rent, ease delta, risk delta)."""
    size = built_area if built else (facts.size_sqm or 0)
    effective_size = size
    if built and market.tourism_intensity >= 50:
        return ("τουριστικά καταλύματα", 3.2, 0.0, 8.0)
    if listing.item_type == "residence" and market.tourism_intensity >= 55 and effective_size >= 120:
        return ("μικρή ξενοδοχειακή μονάδα / ξενώνας", 3.4, -4.0, 10.0)
    if listing.item_type == "residence" and market.student_demand >= 45 and effective_size >= 110:
        return ("co-living ανά δωμάτιο", 2.1, 14.0, -12.0)
    if listing.item_type == "prof" and effective_size >= 150 and market.commercial_demand >= 45:
        return ("γραφεία / coworking", 2.0, 12.0, -8.0)
    if listing.item_type == "prof" and effective_size >= 80:
        return ("αποθηκευτικοί χώροι / self-storage", 2.3, 22.0, -16.0)
    if built and effective_size >= 200 and market.commercial_demand >= 40:
        return ("γραφεία / coworking σε νέα κατασκευή", 2.0, 12.0, -6.0)
    return None


# ------------------------------------------------------------ plan library


def generate_plans(listing: Listing, market: MarketInputs) -> List[Plan]:
    """Every combination worth pricing for this kind of property."""
    plans: List[Plan] = []
    building_exits = ("sell", "rent_long", "rent_short", "rent_student",
                      "rent_commercial", "operate")

    if listing.item_type == "land":
        plans.append(Plan("land", "none", "sell"))
        for years in (3, 5, 10):
            plans.append(Plan("land", "none", "hold", years))
        for exit_kind in ("sell", "rent_long", "rent_short", "rent_commercial", "operate"):
            hold = 0.0 if exit_kind == "sell" else (7.0 if exit_kind in ("rent_commercial", "operate") else 5.0)
            plans.append(Plan("land", "build", exit_kind, hold))
        plans.append(Plan("antiparochi", "build", "sell"))
    else:
        for transform in ("none", "cosmetic", "full", "structural"):
            for exit_kind in building_exits:
                if exit_kind == "sell":
                    plans.append(Plan("building", transform, "sell"))
                elif exit_kind == "rent_long":
                    for years in (3, 5, 10):
                        plans.append(Plan("building", transform, "rent_long", years))
                else:
                    hold = 7.0 if exit_kind in ("rent_commercial", "operate") else 5.0
                    plans.append(Plan("building", transform, exit_kind, hold))
    return plans


# ------------------------------------------------------------ plan pricing


def price_plan(plan: Plan, listing: Listing, facts: PropertyFacts,
               valuation: Valuation, market: MarketInputs,
               costs: CostModel) -> StrategyOutcome:
    """Price one plan end to end, or explain why it cannot run."""
    out = StrategyOutcome(plan=plan, name=plan.name, category=plan.category, feasible=True)
    price = listing.price or 0.0
    size = facts.size_sqm or 0.0
    assumptions: List[str] = []

    # ---------------------------------------------------------- feasibility
    if plan.transform in ("cosmetic", "full", "structural"):
        if _resulting_condition(facts.condition, plan.transform) == facts.condition:
            out.feasible = False
            out.blockers.append(
                f"Το ακίνητο είναι ήδη «{facts.condition}» — η {TRANSFORM_LABELS[plan.transform]} "
                "δεν αναβαθμίζει την κατάσταση."
            )
            return out

    buildable, buildable_estimated = (None, False)
    if plan.transform == "build":
        if not market.built_price_per_sqm:
            out.feasible = False
            out.blockers.append(
                "Λείπει η τιμή πώλησης δομημένου χώρου (€/τ.μ.) στην περιοχή. Η γη και "
                "το κτίσμα είναι δύο διαφορετικές αγορές — χωρίς αυτήν η ανέγερση δεν "
                "αποτιμάται. Δώστε --built-per-sqm."
            )
            return out
        if plan.exit.startswith("rent_") or plan.exit == "operate":
            if not market.rent_per_sqm_month:
                out.feasible = False
                out.blockers.append(
                    "Λείπει το μίσθωμα δομημένου χώρου (€/τ.μ./μήνα) στην περιοχή. "
                    "Δώστε --rent-per-sqm."
                )
                return out
        buildable, buildable_estimated = _buildable(listing, market)
        if not buildable:
            out.feasible = False
            out.blockers.append("Άγνωστη δομήσιμη επιφάνεια και άγνωστο εμβαδόν οικοπέδου.")
            return out
        if buildable_estimated:
            assumptions.append(
                f"Δομήσιμα {buildable:,.0f} τ.μ. ΕΚΤΙΜΩΜΕΝΑ με συντελεστή "
                f"{market.floor_area_ratio or DEFAULT_FLOOR_AREA_RATIO:.2f}. Αν πρόκειται για "
                "αγροτεμάχιο εκτός σχεδίου μπορεί να μην είναι δομήσιμο καθόλου — "
                "επιβεβαιώστε στην πολεοδομία πριν από οτιδήποτε."
            )

    needs_rent = plan.exit.startswith("rent_") or plan.exit == "operate"
    if needs_rent and plan.transform != "build" and not market.monthly_rent:
        out.feasible = False
        out.blockers.append("Δεν υπάρχουν συγκριτικά ενοικίων για την περιοχή.")
        return out

    if plan.exit == "rent_short" and market.tourism_intensity < 25:
        out.feasible = False
        out.blockers.append(
            f"Τουριστική ζήτηση {market.tourism_intensity:.0f}/100 — πολύ χαμηλή για "
            "βραχυχρόνια μίσθωση."
        )
        return out
    if plan.exit == "rent_student" and market.student_demand < 30:
        out.feasible = False
        out.blockers.append(
            f"Φοιτητική ζήτηση {market.student_demand:.0f}/100 — δεν υπάρχει κοντινό ίδρυμα."
        )
        return out
    if plan.exit == "rent_commercial":
        ground = facts.floor_band in ("ground", "semi_basement", "mezzanine")
        if not (listing.item_type == "prof" or ground or plan.transform == "build"):
            out.feasible = False
            out.blockers.append(
                "Δεν είναι ισόγειο, επαγγελματικός χώρος ή νέα κατασκευή — η αλλαγή "
                "χρήσης σπάνια εγκρίνεται."
            )
            return out
        if market.commercial_demand < 30:
            out.feasible = False
            out.blockers.append(
                f"Επαγγελματική ζήτηση {market.commercial_demand:.0f}/100 — υψηλός κίνδυνος κενού."
            )
            return out

    concept = None
    if plan.exit == "operate":
        preview_area, _ = _buildable(listing, market) if plan.transform == "build" else (0.0, False)
        concept = _operating_concept(listing, facts, market, plan.transform == "build",
                                     preview_area or 0.0)
        if not concept:
            out.feasible = False
            out.blockers.append(
                f"Δεν προκύπτει λειτουργικό μοντέλο (τύπος {listing.item_type}, "
                f"{size:.0f} τ.μ., τουρισμός {market.tourism_intensity:.0f}/100, "
                f"φοιτητές {market.student_demand:.0f}/100, επαγγελματική "
                f"{market.commercial_demand:.0f}/100)."
            )
            return out

    # -------------------------------------------------------------- capital
    if plan.acquisition == "antiparochi":
        acquisition_cost = 0.0   # the land is paid in units, not cash
        assumptions.append(
            "Η γη δεν αγοράζεται — αποπληρώνεται σε ποσοστό δομημένων τ.μ. "
            "Δεσμεύεται κεφάλαιο μόνο για την κατασκευή."
        )
    else:
        acquisition_cost = _acquisition_total(price, costs)

    developer_share = 0.55
    build_area = 0.0
    transform_cost = 0.0
    furnish = plan.exit in ("rent_short", "rent_student", "operate")

    if plan.transform == "build":
        build_area = (buildable or 0.0) * (developer_share if plan.acquisition == "antiparochi" else 1.0)
        transform_cost = build_area * market.build_cost_per_sqm * (
            1 + costs.works_contingency_pct / 100.0
        )
        if furnish:
            transform_cost += build_area * costs.furnishing_per_sqm
        assumptions.append(
            f"Κατασκευή {build_area:,.0f} τ.μ. × {market.build_cost_per_sqm:,.0f} €/τ.μ. "
            f"(+{costs.works_contingency_pct:.0f}% απρόβλεπτα)."
        )
        if plan.acquisition == "antiparochi":
            assumptions.append(
                f"Ποσοστό αντιπαροχής {developer_share:.0%} υπέρ του κατασκευαστή — διαπραγματεύσιμο."
            )
    elif plan.transform != "none":
        transform_cost = costs.works_cost(size, plan.transform, furnish=furnish)
        assumptions.append(
            f"Εργασίες: {TRANSFORM_LABELS[plan.transform]} — {transform_cost:,.0f} € "
            f"(περιλαμβάνονται {costs.works_contingency_pct:.0f}% απρόβλεπτα)."
        )
    elif furnish:
        transform_cost = size * costs.furnishing_per_sqm
        assumptions.append(f"Εξοπλισμός/επίπλωση {transform_cost:,.0f} €.")

    capital = acquisition_cost + transform_cost
    if capital <= 0:
        out.feasible = False
        out.blockers.append("Μηδενικό κεφάλαιο — λείπει τιμή ή κόστος.")
        return out

    # -------------------------------------------------------------- revenue
    resulting = ("new_build" if plan.transform == "build"
                 else _resulting_condition(facts.condition, plan.transform))
    effective_area = build_area if plan.transform == "build" else size

    if plan.transform == "build":
        # Finished space, priced off finished-space comparables - never off the
        # plot's own EUR/sqm.
        post_value = (
            market.built_price_per_sqm * ASKING_TO_TRANSACTION
            * build_area * CONDITION_MULTIPLIER["new_build"]
        )
    elif plan.transform == "none":
        post_value = valuation.open_market
    else:
        post_value, _ = value_after_works(valuation, facts, resulting)

    marketing_months = 7 if market.liquidity_score >= 55 else 11
    transform_months = TRANSFORM_MONTHS[plan.transform]

    income_kind = "rent_level"
    monthly_rent = 0.0
    void_pct, management_pct = 0.0, 0.0
    direct_costs_annual = 0.0

    if plan.exit in ("rent_long", "rent_student", "rent_commercial", "operate", "rent_short"):
        if plan.transform == "build":
            # A new building lets by its own floor area at finished-space rates.
            base_rent = (market.rent_per_sqm_month or 0.0) * build_area
        else:
            base_rent = _rent_for_condition(market.monthly_rent or 0.0, resulting)

        if plan.exit == "rent_long":
            monthly_rent, void_pct, management_pct = base_rent, 8.0, 4.0
        elif plan.exit == "rent_student":
            uplift = 1.10 + 0.20 * (market.student_demand / 100.0)
            monthly_rent, void_pct, management_pct = base_rent * uplift, 17.0, 8.0
            assumptions.append(f"Μίσθωμα +{(uplift - 1) * 100:.0f}% λόγω μίσθωσης ανά δωμάτιο.")
        elif plan.exit == "rent_commercial":
            uplift = 1.15 + 0.35 * (market.commercial_demand / 100.0)
            monthly_rent, void_pct, management_pct = base_rent * uplift, 18.0, 5.0
            assumptions.append(
                f"Επαγγελματικό μίσθωμα +{(uplift - 1) * 100:.0f}% έναντι κατοικίας. "
                "Απαιτείται έγκριση αλλαγής χρήσης και συμβατές χρήσεις γης."
            )
        elif plan.exit == "operate":
            name, multiple, ease_delta, risk_delta = concept
            monthly_rent, void_pct, management_pct = base_rent * multiple, 12.0, 38.0
            income_kind = "operating_model"
            out.name = f"{plan.name} — {name}"
            assumptions.append(
                f"Μοντέλο «{name}»: τζίρος ~{multiple:.1f}× το μίσθωμα κατοικίας, "
                "λειτουργικά 38% του τζίρου. Απαιτεί αδειοδότηση και ενεργή διοίκηση."
            )
        elif plan.exit == "rent_short":
            income_kind = "short_stay"
            intensity = market.tourism_intensity / 100.0
            adr_multiple = 2.4 + 2.9 * intensity
            occupancy = 0.32 + 0.36 * intensity
            nightly = (base_rent / 30.0) * adr_multiple
            nights = 365 * occupancy
            gross = nightly * nights
            stays = nights / max(1.0, costs.average_stay_nights)
            direct_costs_annual = (
                stays * costs.cleaning_per_stay_eur
                + nights * costs.short_stay_levy_per_night_eur
                + gross * costs.platform_fee_pct / 100.0
            )
            monthly_rent = (gross - direct_costs_annual) / 12.0
            void_pct, management_pct = 0.0, costs.management_fee_pct
            assumptions.append(
                f"{nightly:,.0f} €/βράδυ × {nights:.0f} βράδια ({occupancy * 100:.0f}% πληρότητα)· "
                f"καθαρισμοί, τέλος ανθεκτικότητας και προμήθεια πλατφόρμας αφαιρεμένα "
                f"({direct_costs_annual:,.0f} €/έτος)."
            )
            assumptions.append(
                "ΠΡΟΣΟΧΗ: απαιτείται ΑΜΑ και το σύστημα ΔΕΝ γνωρίζει τυχόν τοπικούς "
                "περιορισμούς ή απαγόρευση νέων βραχυχρόνιων μισθώσεων."
            )

    hold_months = int(plan.hold_years * 12)
    months = transform_months + (marketing_months if plan.exit in ("sell", "hold") else 0) + hold_months
    if plan.exit == "hold":
        months = hold_months
    months = max(1, months)

    gross_annual = monthly_rent * 12.0 * (1 - void_pct / 100.0)
    operating = gross_annual * management_pct / 100.0
    holding_annual = sum(
        costs.annual_holding_costs(max(post_value, 1.0), max(effective_area, 1.0),
                                   has_common_charges=listing.item_type != "land").values()
    )
    if listing.item_type == "land" and plan.transform == "none":
        holding_annual = (size or 0) * costs.enfia_per_sqm_eur * 0.25
    tax = costs.tax_on_rent(max(0.0, gross_annual - operating))
    annual_net = gross_annual - operating - holding_annual - tax

    income_years = plan.hold_years if plan.exit not in ("sell", "hold") else 0.0
    income_total = annual_net * income_years

    terminal = 0.0
    if plan.exit != "hold" or listing.item_type == "land":
        terminal = value_at_horizon(post_value, months, market.annual_drift_pct)
    disposal = sum(costs.disposal_costs(terminal, price).values()) if terminal else 0.0

    net_profit = income_total + terminal - disposal - capital
    roi = net_profit / capital * 100.0

    # Re-price the whole plan assuming the portal data flattered us: sale
    # comparables 20% optimistic, asking rents 15% optimistic. What survives is
    # the honest number, and the gap between the two IS the fragility.
    stressed_terminal = terminal * STRESS_TERMINAL
    stressed_disposal = (
        sum(costs.disposal_costs(stressed_terminal, price).values()) if stressed_terminal else 0.0
    )
    stressed_gross = gross_annual * STRESS_RENT
    stressed_annual_net = (
        stressed_gross
        - stressed_gross * management_pct / 100.0
        - holding_annual
        - costs.tax_on_rent(max(0.0, stressed_gross * (1 - management_pct / 100.0)))
    )
    stressed_profit = (
        stressed_annual_net * income_years + stressed_terminal - stressed_disposal - capital
    )
    roi_stressed = stressed_profit / capital * 100.0

    # ----------------------------------------------------------- indicators
    ease = max(0.0, min(100.0, EXIT_BASE_EASE[plan.exit] + TRANSFORM_EASE[plan.transform]
                        + (concept[2] if concept else 0.0)))
    risk_raw = max(0.0, min(100.0, EXIT_BASE_RISK[plan.exit] + TRANSFORM_RISK[plan.transform]
                            + (concept[3] if concept else 0.0)))
    if buildable_estimated:
        risk_raw = min(100.0, risk_raw + 18.0)

    months_to_first_cash = (transform_months + 2) if income_years else months
    annualised = _annualise(roi, months)
    annualised_stressed = _annualise(roi_stressed, months)

    inflow = max(1.0, income_total + max(0.0, terminal - disposal))
    certainty, breakdown = score_certainty(
        profit_base=net_profit,
        profit_stressed=stressed_profit,
        income_share=max(0.0, income_total) / inflow,
        valuation_confidence_pct=valuation.confidence_pct,
        income_kind=income_kind,
        uses_works=plan.transform in ("cosmetic", "full", "structural"),
        uses_build=plan.transform == "build",
        uses_buildable_estimate=buildable_estimated,
    )

    indicators = Indicators(
        ret=score_return(annualised, annualised_stressed),
        speed=score_speed(months, months_to_first_cash),
        capital=score_capital(capital, market.capital_ceiling),
        ease=ease,
        certainty=certainty,
        risk=100.0 - risk_raw,
        certainty_breakdown=breakdown,
    )

    out.capital_required = round(capital, 0)
    out.net_profit = round(net_profit, 0)
    out.roi_pct = round(roi, 1)
    out.annualised_roi_pct = round(annualised, 1)
    out.net_profit_stressed = round(stressed_profit, 0)
    out.annualised_roi_stressed_pct = round(annualised_stressed, 1)
    out.months_to_exit = months
    out.months_to_first_cash = months_to_first_cash
    out.annual_net_income = round(annual_net, 0)
    out.terminal_value = round(terminal, 0)
    out.indicators = indicators
    assumptions.insert(0, (
        f"Έξοδος σε {months} μήνες" +
        (f" (έργα {transform_months}, διάθεση {marketing_months})"
         if plan.exit in ("sell", "hold") and transform_months else "") +
        f", ετήσια μεταβολή τιμών {market.annual_drift_pct:+.1f}%."
    ))
    assumptions.append(
        f"Υπό πίεση (συγκριτικά −{(1 - STRESS_TERMINAL) * 100:.0f}%, ενοίκια "
        f"−{(1 - STRESS_RENT) * 100:.0f}%): κέρδος {stressed_profit:,.0f} €, "
        f"{annualised_stressed:.1f}%/έτος."
    )
    out.assumptions = assumptions
    out.cashflow_note = (
        f"Καθαρή ροή ~{annual_net / 12:,.0f} €/μήνα από τον {months_to_first_cash}ο μήνα."
        if income_years else "Καμία ταμειακή ροή μέχρι την έξοδο."
    )
    return out


# --------------------------------------------------------------- evaluation


def evaluate(
    listing: Listing,
    facts: PropertyFacts,
    valuation: Valuation,
    market: MarketInputs,
    costs: Optional[CostModel] = None,
    weights: Optional[Dict[str, float]] = None,
    keep_infeasible: bool = True,
) -> List[StrategyOutcome]:
    """Price every plan in the matrix and rank the feasible ones."""
    costs = costs or DEFAULT_COSTS
    outcomes = [
        price_plan(plan, listing, facts, valuation, market, costs)
        for plan in generate_plans(listing, market)
    ]
    for outcome in outcomes:
        if outcome.feasible:
            outcome.indicators.combined = combine(outcome.indicators, weights)

    if not keep_infeasible:
        outcomes = [o for o in outcomes if o.feasible]
    outcomes.sort(key=lambda o: (o.feasible, o.indicators.combined), reverse=True)
    return outcomes


def best_plan(outcomes: Sequence[StrategyOutcome]) -> Optional[StrategyOutcome]:
    viable = [o for o in outcomes if o.feasible]
    return viable[0] if viable else None


def by_category(outcomes: Sequence[StrategyOutcome]) -> Dict[str, List[StrategyOutcome]]:
    grouped: Dict[str, List[StrategyOutcome]] = {}
    for outcome in outcomes:
        grouped.setdefault(outcome.category, []).append(outcome)
    for items in grouped.values():
        items.sort(key=lambda o: (o.feasible, o.indicators.combined), reverse=True)
    return grouped


def best_per_category(outcomes: Sequence[StrategyOutcome]) -> Dict[str, StrategyOutcome]:
    best: Dict[str, StrategyOutcome] = {}
    for category, items in by_category(outcomes).items():
        viable = [o for o in items if o.feasible]
        if viable:
            best[category] = viable[0]
    return best


def best_per_indicator(outcomes: Sequence[StrategyOutcome]) -> Dict[str, StrategyOutcome]:
    """Winner on each axis on its own - the answer to "separate indicators"."""
    viable = [o for o in outcomes if o.feasible]
    if not viable:
        return {}
    return {
        "return": max(viable, key=lambda o: o.indicators.ret),
        "certainty": max(viable, key=lambda o: o.indicators.certainty),
        "speed": max(viable, key=lambda o: o.indicators.speed),
        "capital": max(viable, key=lambda o: o.indicators.capital),
        "ease": max(viable, key=lambda o: o.indicators.ease),
        "risk": max(viable, key=lambda o: o.indicators.risk),
    }


def deduplicate(outcomes: Iterable[StrategyOutcome],
                keep: int = 3) -> List[StrategyOutcome]:
    """Keep the best few plans per (transform, exit) family, not all horizons."""
    seen: Dict[Tuple[str, str], int] = {}
    kept: List[StrategyOutcome] = []
    for outcome in outcomes:
        family = (outcome.plan.transform, outcome.plan.exit)
        if seen.get(family, 0) >= keep:
            continue
        seen[family] = seen.get(family, 0) + 1
        kept.append(outcome)
    return kept
