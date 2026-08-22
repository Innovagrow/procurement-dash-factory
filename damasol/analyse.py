# -*- coding: utf-8 -*-
"""
Single-property deep dive: valuation, signals, and what to do with it.

    # from a screener run
    python -m damasol.analyse --from-json out/eukairies.json --rank 1

    # or straight from numbers
    python -m damasol.analyse --price 40000 --size 61 --area "Θεσσαλονίκη (Ξηροκρήνη)" \
        --lat 40.65 --lng 22.92 --market-per-sqm 1500 --rent 380

Prints four things: what it is worth now and later and why, what the outside
world says about the area, what each exit strategy would return, and which one
wins once ease and capital are weighed alongside profit.
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Dict, List, Optional, Sequence

from .costs import DEFAULT_COSTS
from .http import PoliteFetcher
from .models import Listing
from .scoring import COMPONENT_LABELS_EL
from .strategies import (
    DEFAULT_OBJECTIVE_WEIGHTS,
    MarketInputs,
    best_per_category,
    evaluate,
)
from .valuation import infer_facts, value_after_works, value_at_horizon, value_property

RULE = "─" * 78


def _gr(value: Optional[float], decimals: int = 0) -> str:
    if value is None:
        return "—"
    text = f"{value:,.{decimals}f}"
    return text.replace(",", "\x00").replace(".", ",").replace("\x00", ".")


def _listing_from_json(path: str, rank: int) -> Listing:
    rows = json.load(open(path, encoding="utf-8"))
    if not 1 <= rank <= len(rows):
        raise SystemExit(f"Το --rank πρέπει να είναι 1..{len(rows)}")
    row = rows[rank - 1]
    return Listing(
        source=row.get("source", ""), listing_id=row.get("listing_id", ""),
        url=row.get("url", ""), title=row.get("title", ""),
        address=row.get("address", ""), area_name=row.get("area_name", ""),
        sub_area=row.get("sub_area", "") or row.get("address", ""),
        item_type=row.get("item_type", "residence"),
        transaction=row.get("transaction", "SALE"),
        price=row.get("price"), size_sqm=row.get("size_sqm"),
        construction_year=row.get("construction_year"),
        lat=row.get("lat"), lng=row.get("lng"),
        listed_age_days=row.get("listed_age_days"),
        description_hint=row.get("description_hint", ""),
    ), row


def gather_signals(fetcher, listing: Listing, use: Sequence[str]) -> Dict[str, object]:
    """Ask each enabled provider what it knows about this place."""
    from .signals import REGISTRY

    readings = {}
    for key in use:
        provider_class = REGISTRY.get(key)
        if not provider_class:
            continue
        try:
            provider = provider_class(fetcher)
            if key == "news":
                provider.place_names = [listing.area_name] if listing.area_name else []
                provider.fetch_latest()
            reading = provider.reading(listing.lat, listing.lng, listing.area_name)
            if reading:
                readings[key] = reading
        except Exception as exc:  # noqa: BLE001 - a dead signal must not kill the analysis
            print(f"  ! σήμα «{key}» μη διαθέσιμο: {exc}")
    return readings


def report(listing: Listing, market_per_sqm: float, comparables: Sequence[float],
           monthly_rent: Optional[float], readings: Dict, weights: Dict[str, float],
           liquidity: float, drift: float, student_demand: float,
           commercial_demand: float, buildable: Optional[float]) -> int:
    facts = infer_facts(listing)
    valuation = value_property(listing, market_per_sqm, comparables, facts, liquidity)
    if not valuation:
        print("Δεν υπάρχουν αρκετά στοιχεία για αποτίμηση (λείπει εμβαδόν ή συγκριτικά).")
        return 1

    print("\n" + "=" * 78)
    print(f"  {listing.title or 'Ακίνητο'} · {listing.sub_area or listing.address}")
    print(f"  Ζητούμενο {_gr(listing.price)} € · {_gr(listing.size_sqm)} τ.μ. · "
          f"{_gr(listing.price_per_sqm)} €/τ.μ.")
    if listing.url:
        print(f"  {listing.url}")
    print("=" * 78)

    # ---------------------------------------------------------- valuation
    print("\n1 · ΑΞΙΑ ΜΕΤΑΠΩΛΗΣΗΣ")
    print(RULE)
    print(f"  Βάση συγκριτικών : {_gr(valuation.base_per_sqm)} €/τ.μ. "
          f"({valuation.comparable_count} συγκριτικά, διασπορά {valuation.comparable_spread:.0%})")
    print(f"\n  {'Συντελεστής':<20} {'Επίδραση':>9}  {'Αιτιολογία':<38} Πηγή")
    print("  " + "─" * 74)
    for name, effect, reason, source in valuation.factor_table():
        print(f"  {name:<20} {effect:>9}  {reason[:38]:<38} {source}")
    print(f"  {'':<20} {'':<9}  {'':<38}")
    print(f"  Συνολικός πολλαπλασιαστής: ×{valuation.total_multiplier:.3f}")

    after, ceiling_note = value_after_works(valuation, facts, "renovated")
    print(f"\n  ➤ ΑΜΕΣΗ (ρευστοποίηση σε εβδομάδες)  : {_gr(valuation.immediate)} €")
    print(f"  ➤ ΑΝΟΙΧΤΗΣ ΑΓΟΡΑΣ (κανονική διάθεση) : {_gr(valuation.open_market)} €"
          f"   [{_gr(valuation.low)} – {_gr(valuation.high)}]")
    print(f"  ➤ ΜΕΤΑ ΑΠΟ ΠΛΗΡΗ ΑΝΑΚΑΙΝΙΣΗ         : {_gr(after)} €   ({ceiling_note})")
    for months in (12, 24, 36):
        print(f"  ➤ ΣΕ {months:>2} ΜΗΝΕΣ (drift {drift:+.1f}%/έτος)      : "
              f"{_gr(value_at_horizon(valuation.open_market, months, drift))} €")
    print(f"\n  Εμπιστοσύνη εκτίμησης: {valuation.confidence_pct:.0f}%")
    for note in valuation.notes:
        print(f"    · {note}")

    # ------------------------------------------------------------ signals
    print("\n2 · ΤΙ ΛΕΕΙ Ο ΕΞΩ ΚΟΣΜΟΣ ΓΙΑ ΤΗΝ ΠΕΡΙΟΧΗ")
    print(RULE)
    tourism = readings.get("tourism")
    if not readings:
        print("  Κανένα σήμα διαθέσιμο για αυτή την περιοχή.")
    for key, reading in readings.items():
        momentum = f" · ρυθμός {reading.momentum:+.1f}%/έτος" if reading.momentum is not None else ""
        print(f"\n  [{key}] {reading.area} — ένταση {reading.intensity:.0f}/100{momentum}"
              f"  (εμπιστοσύνη {reading.confidence:.0f}%, {reading.source})")
        for item in reading.evidence[:3]:
            print(f"      · {item[:96]}")
        for note in reading.notes[:2]:
            print(f"      ⚑ {note[:96]}")

    # --------------------------------------------------------- strategies
    market = MarketInputs(
        monthly_rent=monthly_rent, annual_drift_pct=drift, liquidity_score=liquidity,
        tourism_intensity=tourism.intensity if tourism else 0.0,
        student_demand=student_demand, commercial_demand=commercial_demand,
        buildable_sqm=buildable,
    )
    outcomes = evaluate(listing, facts, valuation, market, DEFAULT_COSTS, weights)
    viable = [o for o in outcomes if o.feasible]

    print("\n3 · ΤΡΟΠΟΙ ΑΞΙΟΠΟΙΗΣΗΣ")
    print(RULE)
    print(f"  Κριτήρια κατάταξης: κέρδος {weights['profit']:.0%} · "
          f"ευκολία {weights['ease']:.0%} · χαμηλό κεφάλαιο {weights['capital']:.0%}\n")
    print(f"  {'#':>2} {'Στρατηγική':<40} {'Κεφάλαιο':>10} {'Κέρδος':>10} "
          f"{'Ετ.ROI':>7} {'Μήν':>4} {'Ευκ':>4} {'Σκορ':>6}")
    print("  " + "─" * 74)
    for position, outcome in enumerate(viable, 1):
        print(f"  {position:>2} {outcome.name[:40]:<40} {_gr(outcome.capital_required):>10} "
              f"{_gr(outcome.net_profit):>10} {outcome.annualised_roi_pct:>6.1f}% "
              f"{outcome.months_to_exit:>4} {outcome.ease:>4.0f} {outcome.score:>6.1f}")

    blocked = [o for o in outcomes if not o.feasible]
    if blocked:
        print("\n  Μη εφικτές:")
        for outcome in blocked:
            reason = outcome.blockers[0] if outcome.blockers else ""
            print(f"    · {outcome.name[:34]:<34} → {reason[:60]}")

    print("\n4 · ΤΙ ΝΑ ΚΑΝΕΤΕ")
    print(RULE)
    if viable:
        winner = viable[0]
        print(f"  ΣΥΝΟΛΙΚΑ ΚΑΛΥΤΕΡΟ: {winner.name}")
        print(f"     Κεφάλαιο {_gr(winner.capital_required)} € → κέρδος "
              f"{_gr(winner.net_profit)} € σε {winner.months_to_exit} μήνες "
              f"({winner.annualised_roi_pct:.1f}%/έτος)")
        if winner.cashflow_note:
            print(f"     {winner.cashflow_note}")
        for assumption in winner.assumptions:
            print(f"     · {assumption}")

        print("\n  ΚΑΛΥΤΕΡΟ ΑΝΑ ΚΑΤΗΓΟΡΙΑ:")
        for category, outcome in best_per_category(outcomes).items():
            print(f"     {category:<24} {outcome.name[:38]:<38} "
                  f"{outcome.annualised_roi_pct:>5.1f}%/έτος, {_gr(outcome.capital_required)} €")

        cheapest = min(viable, key=lambda o: o.capital_required)
        easiest = max(viable, key=lambda o: o.ease)
        richest = max(viable, key=lambda o: o.annualised_roi_pct)
        print("\n  ΑΝ ΑΛΛΑΞΕΤΕ ΠΡΟΤΕΡΑΙΟΤΗΤΑ:")
        print(f"     Μόνο κέρδος          → {richest.name[:44]} ({richest.annualised_roi_pct:.1f}%/έτος)")
        print(f"     Μόνο ευκολία         → {easiest.name[:44]} (ευκολία {easiest.ease:.0f}/100)")
        print(f"     Μόνο λίγο κεφάλαιο   → {cheapest.name[:44]} ({_gr(cheapest.capital_required)} €)")
    else:
        print("  Καμία στρατηγική δεν βγαίνει με αυτά τα δεδομένα.")

    flags = sorted({flag for outcome in outcomes for flag in outcome.blockers})
    print("\n  ΠΡΙΝ ΑΠΟ ΚΑΘΕ ΔΕΣΜΕΥΣΗ: αυτοψία, έλεγχος τίτλων και βαρών, πολεοδομικός")
    print("  έλεγχος, τεχνική αξιολόγηση. Οι παραπάνω αριθμοί είναι μοντέλο, όχι εκτίμηση.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="damasol.analyse",
        description="Πλήρης ανάλυση ενός ακινήτου: αξία, σήματα, τρόποι αξιοποίησης.",
    )
    source = parser.add_argument_group("από πού διαβάζεται το ακίνητο")
    source.add_argument("--from-json", help="Αρχείο JSON από το damasol.screener")
    source.add_argument("--rank", type=int, default=1, help="Ποιο ακίνητο της λίστας (1 = κορυφή)")
    source.add_argument("--price", type=float)
    source.add_argument("--size", type=float)
    source.add_argument("--area", default="")
    source.add_argument("--lat", type=float)
    source.add_argument("--lng", type=float)
    source.add_argument("--year", type=int)
    source.add_argument("--description", default="", help="Κείμενο αγγελίας για εξαγωγή στοιχείων")
    source.add_argument("--item-type", default="residence",
                        choices=["residence", "prof", "land", "parking"])

    market = parser.add_argument_group("δεδομένα αγοράς")
    market.add_argument("--market-per-sqm", type=float,
                        help="Διάμεσος €/τ.μ. γειτονιάς· από το JSON αν παραλειφθεί")
    market.add_argument("--rent", type=float, help="Μηνιαίο μίσθωμα αναφοράς")
    market.add_argument("--drift", type=float, default=2.5, help="Ετήσια μεταβολή τιμών %%")
    market.add_argument("--liquidity", type=float, default=60.0)
    market.add_argument("--student-demand", type=float, default=0.0)
    market.add_argument("--commercial-demand", type=float, default=0.0)
    market.add_argument("--buildable", type=float, help="Δομήσιμα τ.μ. (για γη)")

    objectives = parser.add_argument_group("κριτήρια κατάταξης")
    objectives.add_argument("--w-profit", type=float, default=DEFAULT_OBJECTIVE_WEIGHTS["profit"])
    objectives.add_argument("--w-ease", type=float, default=DEFAULT_OBJECTIVE_WEIGHTS["ease"])
    objectives.add_argument("--w-capital", type=float, default=DEFAULT_OBJECTIVE_WEIGHTS["capital"])

    parser.add_argument("--signals", default="tourism",
                        help="Σήματα προς χρήση, χωρισμένα με κόμμα, ή 'none'")
    parser.add_argument("--delay", type=float, default=2.0)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)

    comparables: List[float] = []
    row: Dict = {}
    if args.from_json:
        listing, row = _listing_from_json(args.from_json, args.rank)
        market_per_sqm = args.market_per_sqm or row.get("market_price_per_sqm")
        monthly_rent = args.rent or row.get("est_monthly_rent")
    else:
        if not (args.price and args.size):
            raise SystemExit("Χρειάζονται --price και --size (ή --from-json)")
        listing = Listing(
            source="manual", listing_id="manual", url="",
            title=f"{args.item_type} {args.size:.0f} τ.μ.",
            address=args.area, area_name=args.area.split("(")[0].strip(),
            sub_area=args.area, item_type=args.item_type, transaction="SALE",
            price=args.price, size_sqm=args.size, construction_year=args.year,
            lat=args.lat, lng=args.lng, description_hint=args.description,
        )
        market_per_sqm = args.market_per_sqm
        monthly_rent = args.rent

    if not market_per_sqm:
        raise SystemExit(
            "Λείπει η διάμεσος €/τ.μ. της γειτονιάς. Δώστε --market-per-sqm ή "
            "τρέξτε πρώτα τον screener με εμπλουτισμό."
        )
    # Without the raw comparables the confidence band cannot narrow; synthesise a
    # thin stand-in so the report says "indicative" rather than overstating.
    comparables = comparables or [market_per_sqm] * 4

    weights = {"profit": args.w_profit, "ease": args.w_ease, "capital": args.w_capital}
    signal_keys = [] if args.signals == "none" else [
        s.strip() for s in args.signals.split(",") if s.strip()
    ]
    readings = {}
    if signal_keys:
        readings = gather_signals(PoliteFetcher(delay=args.delay, verbose=False),
                                  listing, signal_keys)

    return report(
        listing, market_per_sqm, comparables, monthly_rent, readings, weights,
        args.liquidity, args.drift, args.student_demand, args.commercial_demand,
        args.buildable,
    )


if __name__ == "__main__":
    sys.exit(main())
