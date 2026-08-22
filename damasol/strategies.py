# -*- coding: utf-8 -*-
"""
Exit strategy engine: for one property, what is the most profitable thing to do
with it - and is "most profitable" even the right answer once ease and capital
are on the table?

Each strategy is priced as its own small business case: what you must put in,
what comes back, when, how hard it is to run, and what can go wrong. They are
then ranked three ways at once, because a deal that returns 40% but needs
EUR 120.000 and a year of site visits is not obviously better than one that
returns 18% for EUR 50.000 and three phone calls.

    κέρδος    annualised return on the capital actually tied up
    ευκολία   how little of your attention it consumes
    κεφάλαιο  how little you need to start

Strategies that the property cannot support do not silently score zero - they
come back infeasible with the reason attached, which is usually the more useful
output.
"""
from __future__ import annotations

import dataclasses
from typing import Dict, List, Optional, Sequence

from .costs import DEFAULT_COSTS, CostModel
from .models import Listing
from .valuation import (
    CONDITION_MULTIPLIER,
    PropertyFacts,
    Valuation,
    value_after_works,
    value_at_horizon,
)

# Four families, so the shortlist can be read by what kind of business it is.
CATEGORY_RESALE = "Μεταπώληση"
CATEGORY_INCOME = "Εισόδημα"
CATEGORY_DEVELOP = "Ανάπτυξη"
CATEGORY_OPERATE = "Λειτουργία επιχείρησης"

DEFAULT_OBJECTIVE_WEIGHTS = {"profit": 0.45, "ease": 0.25, "capital": 0.30}


@dataclasses.dataclass
class MarketInputs:
    """Everything outside the property itself that the strategies need."""

    monthly_rent: Optional[float] = None       # long-let, from local comparables
    annual_drift_pct: float = 2.5              # expected regional price change
    liquidity_score: float = 60.0              # 0-100, from the screener
    tourism_intensity: float = 0.0             # 0-100, from the tourism signal
    student_demand: float = 0.0                # 0-100, proximity to universities
    commercial_demand: float = 0.0             # 0-100, local commercial rent depth
    buildable_sqm: Optional[float] = None      # for land
    build_cost_per_sqm: float = 1250.0


@dataclasses.dataclass
class StrategyOutcome:
    key: str
    name: str
    category: str
    feasible: bool
    capital_required: float = 0.0
    net_profit: float = 0.0
    roi_pct: float = 0.0
    annualised_roi_pct: float = 0.0
    months_to_exit: int = 0
    months_to_first_cash: int = 0
    ease: float = 50.0
    risk: float = 50.0
    blockers: List[str] = dataclasses.field(default_factory=list)
    assumptions: List[str] = dataclasses.field(default_factory=list)
    cashflow_note: str = ""
    score: float = 0.0

    def to_dict(self) -> Dict:
        data = dataclasses.asdict(self)
        data["blockers"] = " | ".join(self.blockers)
        data["assumptions"] = " | ".join(self.assumptions)
        return data


def _annualise(roi_pct: float, months: int) -> float:
    """Convert a total return over `months` into an annual equivalent."""
    if months <= 0:
        return 0.0
    years = months / 12.0
    growth = 1.0 + roi_pct / 100.0
    if growth <= 0:
        return -100.0
    return (growth ** (1.0 / years) - 1.0) * 100.0


def _acquisition_total(price: float, costs: CostModel) -> float:
    return price + sum(costs.acquisition_costs(price).values())


def _holding_total(value: float, size: float, months: int, costs: CostModel,
                   common_charges: bool = True) -> float:
    annual = sum(costs.annual_holding_costs(value, size, common_charges).values())
    return annual * months / 12.0


# --------------------------------------------------------------------- resale


def strategy_flip_as_is(listing, facts, valuation, market, costs) -> StrategyOutcome:
    out = StrategyOutcome("FLIP_AS_IS", "Αγορά & άμεση μεταπώληση χωρίς έργα", CATEGORY_RESALE, True)
    price = listing.price or 0
    size = facts.size_sqm or 0
    months = 8 if market.liquidity_score >= 55 else 13

    capital = _acquisition_total(price, costs)
    sale = value_at_horizon(valuation.open_market, months, market.annual_drift_pct)
    holding = _holding_total(sale, size, months, costs)
    disposal = sum(costs.disposal_costs(sale, price).values())

    out.capital_required = round(capital, 0)
    out.net_profit = round(sale - capital - holding - disposal, 0)
    out.roi_pct = round(out.net_profit / capital * 100.0, 1) if capital else 0.0
    out.annualised_roi_pct = round(_annualise(out.roi_pct, months), 1)
    out.months_to_exit = months
    out.months_to_first_cash = months
    out.ease = 82.0
    out.risk = 48.0 if market.liquidity_score >= 55 else 66.0
    out.cashflow_note = "Καμία ταμειακή ροή μέχρι την πώληση."
    out.assumptions = [
        f"Πώληση σε {months} μήνες στην εκτιμώμενη αξία ανοιχτής αγοράς.",
        "Δεν γίνονται εργασίες — ο αγοραστής αναλαμβάνει την κατάσταση.",
    ]
    if valuation.open_market <= price * 1.05:
        out.feasible = False
        out.blockers.append(
            "Η εκτιμώμενη αξία δεν υπερβαίνει ουσιωδώς το τίμημα — δεν υπάρχει περιθώριο χωρίς έργα."
        )
    return out


def strategy_flip_renovated(listing, facts, valuation, market, costs) -> StrategyOutcome:
    out = StrategyOutcome("FLIP_RENOVATED", "Εργασίες & μεταπώληση", CATEGORY_RESALE, True)
    price = listing.price or 0
    size = facts.size_sqm or 0
    level = {"structural_needed": "structural", "needs_work": "full",
             "average": "cosmetic"}.get(facts.condition)
    if not level:
        out.feasible = False
        out.blockers.append("Ήδη ανακαινισμένο ή νεόδμητο — δεν υπάρχει περιθώριο αναβάθμισης.")
        return out

    def build(chosen):
        case = StrategyOutcome(key_name[0], key_name[1], CATEGORY_RESALE, True)
        works_months = {"cosmetic": 2, "full": 5, "structural": 9}[chosen]
        span = works_months + (7 if market.liquidity_score >= 55 else 11)
        works = costs.works_cost(size, chosen)
        capital = _acquisition_total(price, costs) + works

        resulting = _resulting_condition(facts.condition, chosen)
        after, ceiling_note = value_after_works(valuation, facts, resulting)
        sale = value_at_horizon(after, span, market.annual_drift_pct)
        holding = _holding_total(sale, size, span, costs)
        disposal = sum(costs.disposal_costs(sale, price).values())

        case.capital_required = round(capital, 0)
        case.net_profit = round(sale - capital - holding - disposal, 0)
        case.roi_pct = round(case.net_profit / capital * 100.0, 1) if capital else 0.0
        case.annualised_roi_pct = round(_annualise(case.roi_pct, span), 1)
        case.months_to_exit = span
        case.months_to_first_cash = span
        case.ease = {"cosmetic": 62.0, "full": 42.0, "structural": 24.0}[chosen]
        case.risk = {"cosmetic": 50.0, "full": 62.0, "structural": 78.0}[chosen]
        case.cashflow_note = f"Έξοδα {works_months} μήνες πριν από οποιοδήποτε έσοδο."
        case.assumptions = [
            f"Εργασίες «{chosen}»: {works:,.0f} € ({costs.works_contingency_pct:.0f}% απρόβλεπτα μέσα) "
            f"→ κατάσταση «{resulting}».",
            f"Χρόνος έργου {works_months} μήνες, μετά {span - works_months} μήνες για πώληση.",
            ceiling_note,
        ]
        return case

    key_name = ("FLIP_RENOVATED", "Εργασίες & μεταπώληση")
    candidates = ("cosmetic", "full") if level != "structural" else ("cosmetic", "full", "structural")
    return _best_works_level(build, candidates)


# --------------------------------------------------------------------- income


# Works take a unit to a condition; that condition sets both the rent it can
# ask and the price it can fetch.
CONDITION_AFTER_WORKS = {
    "none": None,            # unchanged
    "cosmetic": "average",
    "full": "renovated",
    "structural": "renovated",
}


def _resulting_condition(current: str, works_level: str) -> str:
    target = CONDITION_AFTER_WORKS[works_level]
    if target is None:
        return current
    if CONDITION_MULTIPLIER[target] <= CONDITION_MULTIPLIER[current]:
        return current
    return target


def _rent_for_condition(base_rent: float, current: str, resulting: str) -> float:
    """Rent follows condition, but far less steeply than price does.

    Buyers pay a large premium for a renovated flat; tenants pay a modest one.
    Damping the price multiplier by 0.6 keeps renovation from looking like a
    rent machine it is not.
    """
    ratio = CONDITION_MULTIPLIER[resulting] / CONDITION_MULTIPLIER[current]
    return base_rent * (1.0 + 0.6 * (ratio - 1.0))


def _best_works_level(build, candidates):
    """Try each works level and keep whichever actually returns the most.

    Without this the engine cheerfully spends EUR 49.000 renovating a EUR 40.000
    flat to let it for EUR 380 - which is the single most common way a spreadsheet
    talks someone into a bad deal.
    """
    best = None
    for level in candidates:
        outcome = build(level)
        if outcome.feasible and (best is None or outcome.annualised_roi_pct > best.annualised_roi_pct):
            best = outcome
    return best


def _rent_case(listing, facts, valuation, market, costs, *, key, name, monthly_rent,
               works_level, furnish, void_pct, mgmt_pct, ease, risk, hold_years,
               extra_assumptions) -> StrategyOutcome:
    """Shared engine for every let-it-out strategy.

    `monthly_rent` is the local rent for average-condition stock; it is
    re-based here onto whatever condition the works actually reach.
    """
    out = StrategyOutcome(key, name, CATEGORY_INCOME, True)
    price = listing.price or 0
    size = facts.size_sqm or 0
    months = int(hold_years * 12)

    resulting = _resulting_condition(facts.condition, works_level)
    monthly_rent = _rent_for_condition(monthly_rent, "average", resulting)

    works = costs.works_cost(size, works_level, furnish=furnish)
    capital = _acquisition_total(price, costs) + works

    gross_annual = monthly_rent * 12.0 * (1 - void_pct / 100.0)
    operating = gross_annual * mgmt_pct / 100.0
    holding_annual = sum(costs.annual_holding_costs(valuation.open_market, size).values())
    taxable = max(0.0, gross_annual - operating)
    tax = costs.tax_on_rent(taxable)
    net_annual = gross_annual - operating - holding_annual - tax

    after, _ = value_after_works(valuation, facts, resulting)
    terminal = value_at_horizon(after, months, market.annual_drift_pct)
    disposal = sum(costs.disposal_costs(terminal, price).values())

    out.capital_required = round(capital, 0)
    out.net_profit = round(net_annual * hold_years + terminal - disposal - capital, 0)
    out.roi_pct = round(out.net_profit / capital * 100.0, 1) if capital else 0.0
    out.annualised_roi_pct = round(_annualise(out.roi_pct, months), 1)
    out.months_to_exit = months
    out.months_to_first_cash = {"none": 2, "cosmetic": 4, "full": 7, "structural": 11}[works_level]
    out.ease = ease
    out.risk = risk
    out.cashflow_note = (
        f"Καθαρή ροή ~{net_annual / 12:,.0f} €/μήνα από τον {out.months_to_first_cash}ο μήνα "
        f"(απόδοση επί κεφαλαίου {net_annual / capital * 100:.1f}%/έτος)."
        if capital else ""
    )
    works_label = {"none": "χωρίς εργασίες", "cosmetic": "ελαφριά ανακαίνιση",
                   "full": "πλήρης ανακαίνιση", "structural": "ριζική ανακατασκευή"}[works_level]
    out.assumptions = [
        f"Εργασίες: {works_label} ({works:,.0f} €) → κατάσταση «{resulting}».",
        f"Μίσθωμα {monthly_rent:,.0f} €/μήνα, κενό {void_pct:.0f}%, διαχείριση {mgmt_pct:.0f}%.",
        f"Διακράτηση {hold_years:.0f} έτη και πώληση στο τέλος.",
        f"Φόρος εισοδήματος {tax:,.0f} €/έτος με την ισχύουσα κλίμακα.",
    ] + list(extra_assumptions)
    return out


def strategy_rent_long(listing, facts, valuation, market, costs) -> StrategyOutcome:
    if not market.monthly_rent:
        out = StrategyOutcome("RENT_LONG", "Μακροχρόνια μίσθωση", CATEGORY_INCOME, False)
        out.blockers.append("Δεν υπάρχουν συγκριτικά ενοικίων για την περιοχή.")
        return out
    def build(level):
        return _rent_case(
            listing, facts, valuation, market, costs,
            key="RENT_LONG", name="Μακροχρόνια μίσθωση",
            monthly_rent=market.monthly_rent, works_level=level, furnish=False,
            void_pct=8.0 if level != "none" else 13.0, mgmt_pct=4.0,
            ease=72.0 if level in ("none", "cosmetic") else 62.0,
            risk=38.0 if level in ("none", "cosmetic") else 50.0, hold_years=5,
            extra_assumptions=["Ένας μισθωτής, ελάχιστη λειτουργική εμπλοκή."],
        )

    return _best_works_level(build, ("none", "cosmetic", "full"))


def strategy_rent_short(listing, facts, valuation, market, costs) -> StrategyOutcome:
    out_key, out_name = "RENT_SHORT", "Βραχυχρόνια μίσθωση (τουριστική)"
    if not market.monthly_rent:
        out = StrategyOutcome(out_key, out_name, CATEGORY_INCOME, False)
        out.blockers.append("Δεν υπάρχουν συγκριτικά ενοικίων για την περιοχή.")
        return out
    if market.tourism_intensity < 25:
        out = StrategyOutcome(out_key, out_name, CATEGORY_INCOME, False)
        out.blockers.append(
            f"Τουριστική ζήτηση περιοχής {market.tourism_intensity:.0f}/100 — "
            "πολύ χαμηλή για να στηρίξει βραχυχρόνια μίσθωση."
        )
        return out

    # Nightly rate and occupancy both scale with how touristic the area is.
    intensity = market.tourism_intensity / 100.0
    adr_multiple = 2.4 + 2.9 * intensity
    occupancy = 0.32 + 0.36 * intensity
    nightly = (market.monthly_rent / 30.0) * adr_multiple
    nights = 365 * occupancy
    gross = nightly * nights
    stays = nights / max(1.0, costs.average_stay_nights)
    direct = (stays * costs.cleaning_per_stay_eur
              + nights * costs.short_stay_levy_per_night_eur
              + gross * costs.platform_fee_pct / 100.0)
    effective_monthly = (gross - direct) / 12.0

    def build(level):
        return _rent_case(
            listing, facts, valuation, market, costs,
            key=out_key, name=out_name,
            monthly_rent=effective_monthly, works_level=level, furnish=True,
            void_pct=0.0, mgmt_pct=costs.management_fee_pct, ease=34.0, risk=64.0, hold_years=5,
            extra_assumptions=[
                f"Τιμή {nightly:,.0f} €/βράδυ × {nights:.0f} βράδια ({occupancy * 100:.0f}% πληρότητα).",
                f"Καθαρισμοί, τέλος ανθεκτικότητας και προμήθεια πλατφόρμας ήδη αφαιρεμένα ({direct:,.0f} €/έτος).",
            "Απαιτείται ΑΜΑ στο Μητρώο Βραχυχρόνιας Μίσθωσης· ελέγξτε τυχόν τοπικούς περιορισμούς.",
            ],
        )

    outcome = _best_works_level(build, ("cosmetic", "full"))
    outcome.cashflow_note += " Έντονη εποχικότητα."
    return outcome


def strategy_rent_student(listing, facts, valuation, market, costs) -> StrategyOutcome:
    key, name = "RENT_STUDENT", "Φοιτητική μίσθωση"
    if not market.monthly_rent:
        out = StrategyOutcome(key, name, CATEGORY_INCOME, False)
        out.blockers.append("Δεν υπάρχουν συγκριτικά ενοικίων για την περιοχή.")
        return out
    if market.student_demand < 30:
        out = StrategyOutcome(key, name, CATEGORY_INCOME, False)
        out.blockers.append(
            f"Φοιτητική ζήτηση {market.student_demand:.0f}/100 — δεν υπάρχει κοντινό ίδρυμα."
        )
        return out
    # Per-room letting beats whole-unit letting where the layout allows it.
    uplift = 1.10 + 0.20 * (market.student_demand / 100.0)

    def build(level):
        return _rent_case(
            listing, facts, valuation, market, costs,
            key=key, name=name, monthly_rent=market.monthly_rent * uplift,
            works_level=level, furnish=True, void_pct=17.0, mgmt_pct=8.0,
            ease=54.0, risk=48.0, hold_years=5,
            extra_assumptions=[
                f"Μίσθωμα +{(uplift - 1) * 100:.0f}% έναντι κοινής μίσθωσης λόγω μίσθωσης ανά δωμάτιο.",
                "Κενό δύο μηνών κάθε καλοκαίρι ήδη υπολογισμένο.",
            ],
        )

    return _best_works_level(build, ("cosmetic", "full"))


def strategy_commercial_convert(listing, facts, valuation, market, costs) -> StrategyOutcome:
    key, name = "COMMERCIAL_CONVERT", "Αλλαγή χρήσης σε επαγγελματικό"
    out = StrategyOutcome(key, name, CATEGORY_INCOME, False)
    if listing.item_type == "prof":
        pass
    elif facts.floor_band not in ("ground", "semi_basement", "mezzanine"):
        out.blockers.append("Δεν είναι ισόγειο ή ημιώροφος — η αλλαγή χρήσης σπάνια εγκρίνεται.")
        return out
    if market.commercial_demand < 30:
        out.blockers.append(
            f"Επαγγελματική ζήτηση {market.commercial_demand:.0f}/100 — υψηλός κίνδυνος κενού."
        )
        return out
    if not market.monthly_rent:
        out.blockers.append("Δεν υπάρχουν συγκριτικά ενοικίων για την περιοχή.")
        return out

    uplift = 1.15 + 0.35 * (market.commercial_demand / 100.0)
    outcome = _rent_case(
        listing, facts, valuation, market, costs,
        key=key, name=name, monthly_rent=market.monthly_rent * uplift,
        works_level="structural", furnish=False, void_pct=18.0, mgmt_pct=5.0,
        ease=38.0, risk=62.0, hold_years=7,
        extra_assumptions=[
            f"Επαγγελματικό μίσθωμα +{(uplift - 1) * 100:.0f}% έναντι κατοικίας.",
            "Απαιτείται έγκριση αλλαγής χρήσης και συμμόρφωση με χρήσεις γης — ελέγξτε πρώτα.",
            "Οι εμπορικές μισθώσεις είναι μακρύτερες αλλά τα κενά βαθύτερα.",
        ],
    )
    outcome.category = CATEGORY_INCOME
    return outcome


# ------------------------------------------------------------------ development


def strategy_land_hold(listing, facts, valuation, market, costs) -> StrategyOutcome:
    key, name = "LAND_HOLD", "Διακράτηση γης"
    out = StrategyOutcome(key, name, CATEGORY_DEVELOP, True)
    if listing.item_type != "land":
        out.feasible = False
        out.blockers.append("Δεν είναι γη ή οικόπεδο.")
        return out

    price = listing.price or 0
    size = facts.size_sqm or 0
    months = 60
    capital = _acquisition_total(price, costs)
    terminal = value_at_horizon(valuation.open_market, months, market.annual_drift_pct)
    holding = size * costs.enfia_per_sqm_eur * 0.25 * (months / 12.0)  # land ENFIA is far lower
    disposal = sum(costs.disposal_costs(terminal, price).values())

    out.capital_required = round(capital, 0)
    out.net_profit = round(terminal - capital - holding - disposal, 0)
    out.roi_pct = round(out.net_profit / capital * 100.0, 1) if capital else 0.0
    out.annualised_roi_pct = round(_annualise(out.roi_pct, months), 1)
    out.months_to_exit = months
    out.months_to_first_cash = months
    out.ease = 92.0
    out.risk = 55.0
    out.cashflow_note = "Καμία ροή· μόνο έξοδα κατοχή. Κερδίζει μόνο αν κινηθεί η αγορά."
    out.assumptions = [
        f"Διακράτηση 5 ετών με ετήσια μεταβολή {market.annual_drift_pct:.1f}%.",
        "Χωρίς εισόδημα — η απόδοση εξαρτάται αποκλειστικά από την ανατίμηση.",
        "Έλεγχος αρτιότητας, δασικού χάρτη και όρων δόμησης απαραίτητος πριν από κάθε δέσμευση.",
    ]
    return out


def strategy_land_develop(listing, facts, valuation, market, costs) -> StrategyOutcome:
    key, name = "LAND_DEVELOP", "Ανάπτυξη γης (ανέγερση)"
    out = StrategyOutcome(key, name, CATEGORY_DEVELOP, False)
    if listing.item_type != "land":
        out.blockers.append("Δεν είναι γη ή οικόπεδο.")
        return out
    if not market.buildable_sqm:
        out.blockers.append(
            "Άγνωστη δομήσιμη επιφάνεια — απαιτείται συντελεστής δόμησης από την πολεοδομία. "
            "Συμπληρώστε το `buildable_sqm` για να αποτιμηθεί."
        )
        return out

    price = listing.price or 0
    months = 30
    build = market.buildable_sqm * market.build_cost_per_sqm * 1.15
    capital = _acquisition_total(price, costs) + build
    # New build sells at the top condition multiplier on the local per-sqm base.
    revenue = valuation.base_per_sqm * market.buildable_sqm * CONDITION_MULTIPLIER["new_build"]
    revenue = value_at_horizon(revenue, months, market.annual_drift_pct)
    disposal = sum(costs.disposal_costs(revenue, price).values())

    out.feasible = True
    out.capital_required = round(capital, 0)
    out.net_profit = round(revenue - capital - disposal, 0)
    out.roi_pct = round(out.net_profit / capital * 100.0, 1) if capital else 0.0
    out.annualised_roi_pct = round(_annualise(out.roi_pct, months), 1)
    out.months_to_exit = months
    out.months_to_first_cash = months
    out.ease = 18.0
    out.risk = 82.0
    out.cashflow_note = "Βαρύ κεφάλαιο μπροστά, καμία ροή για δυόμισι χρόνια."
    out.assumptions = [
        f"Δόμηση {market.buildable_sqm:,.0f} τ.μ. × {market.build_cost_per_sqm:,.0f} €/τ.μ. (+15% απρόβλεπτα).",
        "Άδεια δόμησης, μελέτες και εργολάβος — χρόνος και ρίσκο εκτέλεσης.",
    ]
    return out


def strategy_antiparochi(listing, facts, valuation, market, costs) -> StrategyOutcome:
    key, name = "ANTIPAROCHI", "Αντιπαροχή (χωρίς αγορά γης)"
    out = StrategyOutcome(key, name, CATEGORY_DEVELOP, False)
    if listing.item_type != "land":
        out.blockers.append("Αφορά γη — δεν εφαρμόζεται σε κτίσμα.")
        return out
    if not market.buildable_sqm:
        out.blockers.append("Άγνωστη δομήσιμη επιφάνεια — συμπληρώστε το `buildable_sqm`.")
        return out

    months = 34
    developer_share = 0.55
    built = market.buildable_sqm * developer_share
    build = built * market.build_cost_per_sqm * 1.15
    capital = build  # the land is paid in units, not cash - that is the whole point
    revenue = value_at_horizon(
        valuation.base_per_sqm * built * CONDITION_MULTIPLIER["new_build"],
        months, market.annual_drift_pct,
    )
    disposal = sum(costs.disposal_costs(revenue).values())

    out.feasible = True
    out.capital_required = round(capital, 0)
    out.net_profit = round(revenue - capital - disposal, 0)
    out.roi_pct = round(out.net_profit / capital * 100.0, 1) if capital else 0.0
    out.annualised_roi_pct = round(_annualise(out.roi_pct, months), 1)
    out.months_to_exit = months
    out.months_to_first_cash = months
    out.ease = 22.0
    out.risk = 74.0
    out.cashflow_note = "Δεν δεσμεύεται κεφάλαιο για τη γη — μόνο για το κόστος κατασκευής."
    out.assumptions = [
        f"Ποσοστό αντιπαροχής {developer_share * 100:.0f}% υπέρ του κατασκευαστή — διαπραγματεύσιμο.",
        "Απαιτεί συμφωνία με τον ιδιοκτήτη· η γη δεν αγοράζεται.",
    ]
    return out


# ------------------------------------------------------------------- operating


def strategy_operate_business(listing, facts, valuation, market, costs) -> StrategyOutcome:
    key, name = "OPERATE_BUSINESS", "Λειτουργία επιχείρησης στο ακίνητο"
    out = StrategyOutcome(key, name, CATEGORY_OPERATE, False)
    size = facts.size_sqm or 0

    concept, multiple, ease, risk = None, 0.0, 0.0, 0.0
    if listing.item_type == "residence" and market.tourism_intensity >= 55 and size >= 120:
        concept, multiple, ease, risk = "μικρή ξενοδοχειακή μονάδα / ξενώνας", 3.4, 20.0, 78.0
    elif listing.item_type == "residence" and size >= 110 and market.student_demand >= 45:
        concept, multiple, ease, risk = "co-living ανά δωμάτιο", 2.1, 38.0, 58.0
    elif listing.item_type == "prof" and size >= 80:
        concept, multiple, ease, risk = "αποθηκευτικοί χώροι / self-storage", 2.3, 46.0, 52.0
    else:
        out.blockers.append(
            "Το ακίνητο δεν στηρίζει προφανές λειτουργικό μοντέλο "
            f"(τύπος {listing.item_type}, {size:.0f} τ.μ., τουρισμός "
            f"{market.tourism_intensity:.0f}/100, φοιτητές {market.student_demand:.0f}/100)."
        )
        return out
    if not market.monthly_rent:
        out.blockers.append("Δεν υπάρχουν συγκριτικά ενοικίων για να αποτιμηθεί ο τζίρος.")
        return out

    outcome = _rent_case(
        listing, facts, valuation, market, costs,
        key=key, name=f"{name}: {concept}", monthly_rent=market.monthly_rent * multiple,
        works_level="structural", furnish=True, void_pct=12.0, mgmt_pct=38.0,
        ease=ease, risk=risk, hold_years=7,
        extra_assumptions=[
            f"Μοντέλο: {concept} — τζίρος ~{multiple:.1f}× το μίσθωμα κατοικίας.",
            "Λειτουργικά έξοδα 38% του τζίρου (προσωπικό, ενέργεια, αναλώσιμα).",
            "Απαιτείται αδειοδότηση και ενεργή διοίκηση — δεν είναι παθητική επένδυση.",
        ],
    )
    outcome.category = CATEGORY_OPERATE
    return outcome


# ------------------------------------------------------------------- combined


def strategy_renovate_rent_sell(listing, facts, valuation, market, costs) -> StrategyOutcome:
    """The combination most Greek small investors actually run."""
    key, name = "RENOVATE_RENT_SELL", "Συνδυαστικό: εργασίες → μίσθωση 3 έτη → πώληση"
    if not market.monthly_rent:
        out = StrategyOutcome(key, name, CATEGORY_RESALE, False)
        out.blockers.append("Δεν υπάρχουν συγκριτικά ενοικίων για την περιοχή.")
        return out
    def build(level):
        return _rent_case(
            listing, facts, valuation, market, costs,
            key=key, name=name, monthly_rent=market.monthly_rent,
            works_level=level, furnish=False, void_pct=8.0 if level != "none" else 13.0,
            mgmt_pct=4.0, ease=64.0, risk=42.0, hold_years=3,
            extra_assumptions=[
                "Το ενοίκιο καλύπτει την κατοχή όσο ωριμάζει η υπεραξία των εργασιών.",
                "Πώληση στο τέλος της τριετίας.",
            ],
        )

    outcome = _best_works_level(build, ("none", "cosmetic", "full"))
    outcome.category = CATEGORY_RESALE
    if outcome.assumptions and "χωρίς εργασίες" in outcome.assumptions[0]:
        outcome.name = "Συνδυαστικό: μίσθωση 3 έτη → πώληση (χωρίς έργα)"
    return outcome


ALL_STRATEGIES = (
    strategy_flip_as_is,
    strategy_flip_renovated,
    strategy_renovate_rent_sell,
    strategy_rent_long,
    strategy_rent_short,
    strategy_rent_student,
    strategy_commercial_convert,
    strategy_land_hold,
    strategy_land_develop,
    strategy_antiparochi,
    strategy_operate_business,
)


# --------------------------------------------------------------------- ranking


def _normalise(values: Sequence[float], invert: bool = False) -> List[float]:
    """Map a list onto 0-100. `invert` makes lower values score higher."""
    if not values:
        return []
    low, high = min(values), max(values)
    if high - low < 1e-9:
        return [50.0] * len(values)
    scaled = [(v - low) / (high - low) * 100.0 for v in values]
    return [100.0 - s for s in scaled] if invert else scaled


def evaluate(
    listing: Listing,
    facts: PropertyFacts,
    valuation: Valuation,
    market: MarketInputs,
    costs: Optional[CostModel] = None,
    weights: Optional[Dict[str, float]] = None,
) -> List[StrategyOutcome]:
    """Price every strategy and rank the feasible ones."""
    costs = costs or DEFAULT_COSTS
    weights = {**DEFAULT_OBJECTIVE_WEIGHTS, **(weights or {})}
    total_weight = sum(weights.values()) or 1.0
    weights = {k: v / total_weight for k, v in weights.items()}

    outcomes = [fn(listing, facts, valuation, market, costs) for fn in ALL_STRATEGIES]
    viable = [o for o in outcomes if o.feasible and o.capital_required > 0]

    if viable:
        profit = _normalise([o.annualised_roi_pct for o in viable])
        capital = _normalise([o.capital_required for o in viable], invert=True)
        for outcome, p, c in zip(viable, profit, capital):
            outcome.score = round(
                weights["profit"] * p + weights["ease"] * outcome.ease + weights["capital"] * c, 1
            )

    outcomes.sort(key=lambda o: (o.feasible, o.score), reverse=True)
    return outcomes


def by_category(outcomes: Sequence[StrategyOutcome]) -> Dict[str, List[StrategyOutcome]]:
    grouped: Dict[str, List[StrategyOutcome]] = {}
    for outcome in outcomes:
        grouped.setdefault(outcome.category, []).append(outcome)
    for items in grouped.values():
        items.sort(key=lambda o: (o.feasible, o.score), reverse=True)
    return grouped


def best_per_category(outcomes: Sequence[StrategyOutcome]) -> Dict[str, StrategyOutcome]:
    best: Dict[str, StrategyOutcome] = {}
    for category, items in by_category(outcomes).items():
        viable = [o for o in items if o.feasible]
        if viable:
            best[category] = viable[0]
    return best
