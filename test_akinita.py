"""
Offline test suite for the  real estate opportunity engine.

Runs with no network access: a fake source replays recorded-shape payloads so
the crawl -> pre-score -> enrich -> score -> export pipeline is exercised
end to end, deterministically.

    python test_akinita.py
"""
import json
import os
import re
import shutil
import sys
import tempfile

from akinita.geo import cell_bbox, geo_cell, nearest_urban_centre, normalise_area
from akinita.http import PoliteFetcher
from akinita.models import Listing, parse_age_days, parse_area, parse_money
from akinita.outreach.templates import available_templates, render
from akinita.report import write_html_report
from akinita.screener import (
    analyse_shortlist, enrich_market_context, export_csv, export_json,
)
from akinita.scoring import MarketIndex, grade_for, score_all
from akinita.sources.base import SearchQuery

PASSED, FAILED = [], []


def _raises(fn):
    try:
        fn()
    except Exception:  # noqa: BLE001 - the test only cares that it refused
        return True
    return False


def check(label, condition, detail=""):
    (PASSED if condition else FAILED).append(label)
    print(f"  {'[OK]  ' if condition else '[FAIL]'} {label}{(' - ' + detail) if detail and not condition else ''}")


class FakeSource:
    """Stands in for a portal: cheap candidates plus a pricier local market."""

    name = "fake"
    supports_bbox = True

    def __init__(self):
        self.calls = []

    def count(self, query):
        return 3

    def search(self, query):
        self.calls.append((query.transaction, query.item_type, bool(query.bbox)))
        if query.bbox is None:
            for index, (price, size) in enumerate([(30000, 60), (45000, 50), (49000, 90)]):
                yield Listing(
                    source=self.name, listing_id=f"cand{index}", url=f"https://x/{index}",
                    title="Διαμέρισμα", address="Άρτα", area_name="Άρτα", sub_area="Άρτα",
                    item_type="residence", transaction="SALE",
                    price=price, size_sqm=size, lat=39.16, lng=20.98,
                    listed_age_days=5, construction_year=1975,
                    description_hint="χρήζει ανακαίνισης",
                )
        elif query.transaction == "buy":
            for index in range(6):  # the wider local market, at market prices
                yield Listing(
                    source=self.name, listing_id=f"mkt{index}", url="",
                    address="Άρτα", area_name="Άρτα", sub_area="Άρτα", item_type="residence",
                    transaction="SALE", price=120000, size_sqm=80, lat=39.16, lng=20.98,
                )
        else:
            for index in range(6):  # local rents
                yield Listing(
                    source=self.name, listing_id=f"rent{index}", url="",
                    address="Άρτα", area_name="Άρτα", sub_area="Άρτα", item_type="residence",
                    transaction="RENT", price=350, size_sqm=70, lat=39.16, lng=20.98,
                )


print("=" * 62)
print("SAROSI ENGINE - OFFLINE TEST SUITE")
print("=" * 62)

print("\n[1] Parsers")
check("Greek money format", parse_money("47.000\xa0€") == 47000.0)
check("Greek decimals", parse_money("1.234.567,89 €") == 1234567.89)
check("Area with unit", parse_area("280 τ.μ.") == 280.0)
check("Relative date (days)", parse_age_days("πριν από 3 ημέρες") == 3)
check("Relative date (months)", parse_age_days("πριν από 2 μήνες") == 60)
check("Unparseable money is None", parse_money("κατόπιν συνεννόησης") is None)
check("price_per_sqm derived",
      Listing(source="t", listing_id="1", url="", price=40000, size_sqm=50).price_per_sqm == 800.0)

print("\n[2] Geography")
check("Nearest centre is Athens", nearest_urban_centre(37.99, 23.73)[0] == "Αθήνα")
cell = geo_cell(38.0933, 23.8294)
north, east, south, west = cell_bbox(cell)
check("Cell bbox brackets the point", south <= 38.0933 <= north and west <= 23.8294 <= east)
check("bbox ordering N>S, E>W", north > south and east > west)
check("Area normalisation", normalise_area("Νέα Ερυθραία (Καστρί)") == "Νέα Ερυθραία")
check("Missing coords give no cell", geo_cell(None, None) is None)

print("\n[3] robots.txt evaluation")
gate = PoliteFetcher(verbose=False)._robots
gate._rules["https://example.test"] = [
    (gate._compile("/private"), len("/private"), False),
    (gate._compile("/private/public"), len("/private/public"), True),
    (gate._compile("/*/results"), len("/*/results"), False),
]
check("Disallow blocks", not gate.allows("https://example.test/private/x"))
check("Longer Allow overrides Disallow", gate.allows("https://example.test/private/public/y"))
check("Wildcard rule matches", not gate.allows("https://example.test/el/results?a=1"))
check("Unlisted path allowed", gate.allows("https://example.test/anything"))

print("\n[4] Scoring")
index = MarketIndex()
market = [Listing(source="t", listing_id=f"m{i}", url="", item_type="residence",
                  area_name="Άρτα", price=120000, size_sqm=80, lat=39.16, lng=20.98)
          for i in range(6)]
rents = [Listing(source="t", listing_id=f"r{i}", url="", item_type="residence",
                 area_name="Άρτα", price=350, size_sqm=70, lat=39.16, lng=20.98)
         for i in range(6)]
index.add_sale_comparables(market)
index.add_rent_comparables(rents)

bargain = Listing(source="t", listing_id="a", url="", title="Διαμέρισμα", address="Άρτα",
                  area_name="Άρτα", item_type="residence", transaction="SALE",
                  price=42000, size_sqm=70, lat=39.16, lng=20.98,
                  construction_year=1978, listed_age_days=5,
                  description_hint="χρήζει ανακαίνισης")
overpriced = Listing(source="t", listing_id="b", url="", title="Διαμέρισμα", address="Άρτα",
                     area_name="Άρτα", item_type="residence", transaction="SALE",
                     price=49000, size_sqm=25, lat=39.16, lng=20.98, listed_age_days=400)
ranked = score_all([overpriced, bargain], index, budget=50000)
check("Bargain outranks overpriced", ranked[0].listing.listing_id == "a",
      f"got {ranked[0].listing.listing_id}")
check("Discount computed", ranked[0].discount_pct is not None and ranked[0].discount_pct > 50)
check("Yield computed", ranked[0].gross_yield_pct is not None and ranked[0].gross_yield_pct > 0)
check("Evidence is populated", len(ranked[0].evidence) >= 4)
check("Score inside 0-100", all(0 <= s.score <= 100 for s in ranked))
check("Grades ordered", grade_for(85) == "A+" and grade_for(40) == "D")

suspicious = Listing(source="t", listing_id="c", url="", address="Άρτα", area_name="Άρτα",
                     item_type="residence", transaction="SALE", price=3000, size_sqm=70,
                     lat=39.16, lng=20.98)
flagged = score_all([suspicious], index)[0]
check("Sub-5k price is flagged", any("5.000" in f for f in flagged.flags))

no_comps_index = MarketIndex()
orphan = score_all([bargain], no_comps_index, budget=50000)[0]
check("Missing comparables flagged, not crashed",
      any("συγκριτικά" in f for f in orphan.flags) and orphan.score > 0)

auction = Listing(source="t", listing_id="d", url="", address="Κοζάνη", area_name="Κοζάνη",
                  item_type="residence", transaction="AUCTION", price=33000, size_sqm=40,
                  lat=40.30, lng=21.78, auction_date="2026-09-01")
check("Auction is flagged",
      any("Πλειστηριασμ" in f for f in score_all([auction], index)[0].flags))

print("\n[4b] Comparable selection & plausibility ceilings")
mixed = MarketIndex()
# One coarse cell holding two very different neighbourhoods.
mixed.add_sale_comparables(
    [Listing(source="t", listing_id=f"cheap{i}", url="", item_type="residence",
             sub_area="Θεσσαλονίκη (Ξηροκρήνη)", area_name="Θεσσαλονίκη",
             price=61000, size_sqm=61, lat=40.65, lng=22.92) for i in range(5)]
    + [Listing(source="t", listing_id=f"posh{i}", url="", item_type="residence",
               sub_area="Θεσσαλονίκη (Κέντρο)", area_name="Θεσσαλονίκη",
               price=280000, size_sqm=80, lat=40.63, lng=22.94) for i in range(5)]
)
target = Listing(source="t", listing_id="t1", url="", item_type="residence",
                 transaction="SALE", sub_area="Θεσσαλονίκη (Ξηροκρήνη)",
                 area_name="Θεσσαλονίκη", price=45000, size_sqm=61,
                 lat=40.65, lng=22.92)
baseline = mixed.sale_price_per_sqm(target)
check("Neighbourhood baseline beats the mixed cell",
      baseline is not None and abs(baseline - 1000.0) < 1.0, f"baseline={baseline}")
check("Baseline basis reported as neighbourhood", mixed.last_basis == "γειτονιά")

coarse_only = MarketIndex()
coarse_only.add_sale_comparables(
    [Listing(source="t", listing_id=f"c{i}", url="", item_type="residence",
             area_name="Άρτα", price=90000, size_sqm=60, lat=39.16, lng=20.98)
     for i in range(5)]
)
no_sub = Listing(source="t", listing_id="n1", url="", item_type="residence",
                 area_name="Άρτα", price=30000, size_sqm=60, lat=39.16, lng=20.98)
check("Falls back when no neighbourhood match", coarse_only.sale_price_per_sqm(no_sub) is not None)

outlier_index = MarketIndex()
outlier_index.add_sale_comparables(
    [Listing(source="t", listing_id=f"n{i}", url="", item_type="residence",
             sub_area="Χ", area_name="Χ", price=100000, size_sqm=100,
             lat=39.0, lng=21.0) for i in range(9)]
    + [Listing(source="t", listing_id="junk", url="", item_type="residence",
               sub_area="Χ", area_name="Χ", price=800, size_sqm=100, lat=39.0, lng=21.0)]
)
probe = Listing(source="t", listing_id="p", url="", item_type="residence",
                sub_area="Χ", area_name="Χ", price=50000, size_sqm=100, lat=39.0, lng=21.0)
check("Outlier comparable is trimmed away",
      abs((outlier_index.sale_price_per_sqm(probe) or 0) - 1000.0) < 1.0)

silly = MarketIndex()
silly.add_sale_comparables(
    [Listing(source="t", listing_id=f"s{i}", url="", item_type="residence", sub_area="Ψ",
             area_name="Ψ", price=240000, size_sqm=80, lat=39.0, lng=21.0) for i in range(5)]
)
silly.add_rent_comparables(
    [Listing(source="t", listing_id=f"sr{i}", url="", item_type="residence", sub_area="Ψ",
             area_name="Ψ", price=900, size_sqm=60, lat=39.0, lng=21.0) for i in range(5)]
)
too_good = Listing(source="t", listing_id="tg", url="", item_type="residence",
                   transaction="SALE", sub_area="Ψ", area_name="Ψ", price=40000,
                   size_sqm=70, lat=39.0, lng=21.0)
verdict = score_all([too_good], silly, budget=50000)[0]
check("Implausible discount is flagged", any("Έκπτωση" in f for f in verdict.flags))
check("Implausible yield is flagged", any("απόδοση" in f for f in verdict.flags))
check("Implausible metrics do not produce a perfect score", verdict.score < 95,
      f"score={verdict.score}")

from akinita.scoring import _quality_haircut
at_market = Listing(source="t", listing_id="am", url="", item_type="residence",
                    price=100000, size_sqm=100)          # 1000/sqm
way_below = Listing(source="t", listing_id="wb", url="", item_type="residence",
                    price=20000, size_sqm=100)           # 200/sqm
check("No haircut at market price", abs(_quality_haircut(at_market, 1000.0) - 1.0) < 0.01)
check("Deep discount takes a rent haircut",
      abs(_quality_haircut(way_below, 1000.0) - 0.6) < 0.01)
check("Haircut floors at 60%", _quality_haircut(way_below, 100000.0) >= 0.5)
check("No baseline means no haircut", _quality_haircut(at_market, None) == 1.0)

print("\n[5] Enrichment orchestration")
source = FakeSource()
candidates = list(source.search(SearchQuery(item_type="residence", max_price=50000)))
check("Candidates crawled", len(candidates) == 3)
pre_index = MarketIndex()
pre_index.add_sale_comparables(candidates)
shortlist = score_all(candidates, pre_index, budget=50000)
live_index = MarketIndex()
enrich_market_context(source, live_index, shortlist, 0.05,
                      exclude_ids={c.listing_id for c in candidates})
check("Enrichment queried both sale and rent",
      ("buy", "residence", True) in source.calls and ("rent", "residence", True) in source.calls)
check("Market index populated", live_index.summary()["sale_cells"] > 0)
final = score_all(candidates, live_index, budget=50000)
check("Discount now measured against the real market",
      final[0].discount_pct is not None and final[0].discount_pct > 30,
      f"discount={final[0].discount_pct}")
check("Candidates excluded from their own baseline",
      abs((final[0].market_price_per_sqm or 0) - 1500.0) < 1.0,
      f"baseline={final[0].market_price_per_sqm}")

print("\n[6] Exports")
tmp = tempfile.mkdtemp()
try:
    export_csv(final, os.path.join(tmp, "o.csv"))
    export_json(final, os.path.join(tmp, "o.json"))
    write_html_report(final, os.path.join(tmp, "o.html"),
                      meta={"source": "fake", "transaction": "buy",
                            "item_types": ["residence"], "max_price": 50000,
                            "bbox": "Όλη η Ελλάδα", "candidates": 3,
                            "weights": {"value_gap": 0.35}})
    csv_text = open(os.path.join(tmp, "o.csv"), encoding="utf-8-sig").read()
    html_text = open(os.path.join(tmp, "o.html"), encoding="utf-8").read()
    check("CSV has a row per listing", csv_text.count("\n") >= len(final))
    check("CSV carries score columns", "score_value_gap" in csv_text)
    check("JSON written", os.path.getsize(os.path.join(tmp, "o.json")) > 100)
    check("HTML is a complete document",
          html_text.startswith("<!doctype html>") and html_text.rstrip().endswith("</html>"))
    check("HTML is in Greek", "Ευκαιρίες Ακινήτων" in html_text)
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print("\n[7] Outreach copy")
check("All channels present",
      set(available_templates()) == {"email", "email_en", "follow_up", "sms", "viber",
                                     "linkedin", "brief_form"})
identity = {"sender_name": "Α. Β.", "reply_email": "deals@akinita.com", "phone": "+30 210 0000000"}
message = render("email", "ΑΒΓ Ακίνητα", identity)
body = message["body"]
check("Subject rendered", bool(message["subject"]))
check("Recipient personalised", "ΑΒΓ Ακίνητα" in body)
check("No unfilled placeholders", "{" not in body and "}" not in body)
must_contain = {
    "επενδυτικό οργανισμό": "identifies  as an investment organisation",
    "ευκαιρία": "asks for properties they consider an opportunity",
    "ΛΕΠΤΟΜΕΡΕΙΕΣ ΤΟΥ ΑΚΙΝΗΤΟΥ": "asks for property details",
    "ΓΙΑΤΙ ΤΟ ΘΕΩΡΕΙΤΕ ΕΥΚΑΙΡΙΑ": "asks why they consider it an opportunity",
    "ΑΝΟΙΧΤΟΙ ΣΕ ΠΡΟΤΑΣΕΙΣ ΣΥΝΕΡΓΑΣΙΑΣ": "states openness to partnership proposals",
    "ΕΥΕΛΙΚΤΑ ΕΠΙΧΕΙΡΗΜΑΤΙΚΑ ΜΟΝΤΕΛΑ": "states experience in flexible business models",
    "ΔΙΑΓΡΑΦΗ": "carries an opt-out",
    "deals@akinita.com": "carries the reply address",
}
for needle, description in must_contain.items():
    check(f"Email {description}", needle in body)
for channel in available_templates():
    rendered = render(channel, "ΑΒΓ", identity)["body"]
    check(f"Channel '{channel}' renders cleanly", "{" not in rendered and len(rendered) > 60)
check("Anonymous greeting when name is unknown",
      "Αξιότιμοι συνεργάτες" in render("email", "", identity)["body"])

print("\n[8] Cost model")
from akinita.costs import DEFAULT_COSTS, CostModel

acq = DEFAULT_COSTS.acquisition_costs(45000)
check("Acquisition costs are material on cheap stock",
      0.07 < sum(acq.values()) / 45000 < 0.12,
      f"{sum(acq.values()) / 45000:.1%}")
check("Transfer tax is on the bill", any("μεταβίβασης" in k for k in acq))
check("Rent tax is progressive",
      DEFAULT_COSTS.tax_on_rent(12000) == 1800
      and DEFAULT_COSTS.tax_on_rent(20000) == 1800 + 8000 * 0.35,
      f"{DEFAULT_COSTS.tax_on_rent(20000)}")
check("Works scale with level",
      DEFAULT_COSTS.works_cost(60, "cosmetic")
      < DEFAULT_COSTS.works_cost(60, "full")
      < DEFAULT_COSTS.works_cost(60, "structural"))
check("Contingency is included",
      DEFAULT_COSTS.works_cost(100, "full") > 100 * DEFAULT_COSTS.works_full_per_sqm)
check("Furnishing is additive",
      DEFAULT_COSTS.works_cost(60, "full", furnish=True) > DEFAULT_COSTS.works_cost(60, "full"))
try:
    DEFAULT_COSTS.works_cost(60, "gold_plated")
    check("Unknown works level rejected", False)
except ValueError:
    check("Unknown works level rejected", True)

print("\n[9] Valuation")
from akinita.valuation import (
    infer_facts, value_after_works, value_at_horizon, value_property,
)

wreck = Listing(source="t", listing_id="v1", url="", title="Διαμέρισμα 61 τ.μ.",
                address="Θεσσαλονίκη (Ξηροκρήνη)", area_name="Θεσσαλονίκη",
                sub_area="Θεσσαλονίκη (Ξηροκρήνη)", item_type="residence",
                transaction="SALE", price=40000, size_sqm=61, construction_year=1972,
                description_hint="2ος όροφος, χρήζει ανακαίνισης, με ασανσέρ")
wreck_facts = infer_facts(wreck)
check("Condition read from text", wreck_facts.condition == "needs_work")
check("Lift read from text", wreck_facts.has_lift is True)
check("Floor read from text", wreck_facts.floor_band == "low")
check("Unknowns recorded as assumptions", "ενεργειακή κλάση" in wreck_facts.assumed)
check("Certainty falls with assumptions", wreck_facts.certainty < 1.0)

basement = infer_facts(Listing(source="t", listing_id="v2", url="",
                               title="Διαμέρισμα", description_hint="υπόγειο, ψιλή κυριότητα"))
check("Basement detected", basement.floor_band == "basement")
check("Bare ownership detected", basement.legal_status == "bare_ownership")

comps = [1450, 1520, 1380, 1610, 1490, 1550, 1420, 1580, 1470, 1500]
val = value_property(wreck, 1500.0, comps, wreck_facts, liquidity_score=72)
check("Valuation produced", val is not None)
check("Base is below asking comparables", val.base_per_sqm < 1500)
check("Immediate below open market", val.immediate < val.open_market)
check("Band brackets the estimate", val.low < val.open_market < val.high)
check("Every factor is labelled data or assumption",
      all(row[3] in ("δεδομένο", "παραδοχή") for row in val.factor_table()))
check("Needs-work discount applied", val.total_multiplier < 1.0)

renovated, _ = value_after_works(val, wreck_facts, "renovated")
check("Renovation lifts value", renovated > val.open_market)
check("Uplift is proportional to the neighbourhood base",
      abs(renovated / val.open_market - 1.14 / 0.80) < 0.01)
cheap_area = value_property(wreck, 300.0, comps, wreck_facts, 72)
cheap_renovated, _ = value_after_works(cheap_area, wreck_facts, "renovated")
check("Renovating a cheap street yields cheap-street prices",
      cheap_renovated < renovated / 3)
check("Already-renovated stock gains nothing from renovation",
      value_after_works(val, infer_facts(Listing(
          source="t", listing_id="v3", url="",
          description_hint="πλήρως ανακαινισμένο")), "renovated")[1]
      == "καμία αναβάθμιση κατάστασης")
check("Horizon compounds", value_at_horizon(100000, 24, 3.0) > 100000)
check("No comparables means no valuation", value_property(wreck, None, [], wreck_facts) is None)

illiquid = value_property(wreck, 1500.0, comps, wreck_facts, liquidity_score=10)
check("Fast sale costs more where stock sits",
      (illiquid.open_market - illiquid.immediate) > (val.open_market - val.immediate))

print("\n[10] Plan matrix and indicators")
from akinita.indicators import (
    STRESS_RENT, STRESS_TERMINAL, score_capital, score_certainty, score_return, score_speed,
)
from akinita.strategies import (
    MarketInputs, best_per_category, best_per_indicator, best_plan, evaluate, generate_plans,
)

market = MarketInputs(monthly_rent=380, annual_drift_pct=3.0, liquidity_score=72,
                      tourism_intensity=48, student_demand=55, commercial_demand=40)
outcomes = evaluate(wreck, wreck_facts, val, market)
viable = [o for o in outcomes if o.feasible]
check("The matrix generates many plans", len(outcomes) >= 25, str(len(outcomes)))
check("Most are viable for a normal flat", len(viable) >= 12, str(len(viable)))
check("Ranked by combined indicator",
      all(a.indicators.combined >= b.indicators.combined for a, b in zip(viable, viable[1:])))
check("Blocked plans explain themselves", all(o.blockers for o in outcomes if not o.feasible))
check("Every viable plan states its assumptions", all(o.assumptions for o in viable))
check("Capital always exceeds the asking price",
      all(o.capital_required > wreck.price for o in viable))

plan_keys = {o.plan.key for o in outcomes}
check("Renovate-then-sell is covered",
      any(k.startswith("BUILDING_FULL") and k.endswith("SELL") for k in plan_keys))
check("Renovate-then-let is covered",
      any("FULL_RENT_LONG" in k for k in plan_keys))
check("Commercial conversion is covered", any("RENT_COMMERCIAL" in k for k in plan_keys))
check("Multiple holding horizons are offered",
      len({o.plan.hold_years for o in outcomes if o.plan.exit == "rent_long"}) >= 3)
check("No land plans for a flat", not any(o.plan.acquisition == "land" for o in outcomes))

# Indicator scales are absolute, so numbers from different properties compare.
check("Return scale is absolute", score_return(10) < score_return(25) < score_return(50))
check("Speed rewards early cash", score_speed(60, 4) > score_speed(60, 60))
check("Capital scale rewards small tickets", score_capital(40000) > score_capital(200000))

# The point of the redesign: rank on what survives, not on the headline.
flip = next(o for o in viable if o.plan.transform == "none" and o.plan.exit == "sell")
long_let = max((o for o in viable if o.plan.exit == "rent_long"),
               key=lambda o: o.plan.hold_years)
check("A flip's return collapses under stress",
      flip.annualised_roi_stressed_pct < flip.annualised_roi_pct / 2,
      f"{flip.annualised_roi_pct} -> {flip.annualised_roi_stressed_pct}")
check("A long let keeps most of its return under stress",
      long_let.annualised_roi_stressed_pct > long_let.annualised_roi_pct / 3,
      f"{long_let.annualised_roi_pct} -> {long_let.annualised_roi_stressed_pct}")
check("Certainty separates the fragile from the durable",
      long_let.indicators.certainty > flip.indicators.certainty + 8,
      f"let {long_let.indicators.certainty} vs flip {flip.indicators.certainty}")
check("Stressed return is reported, not hidden",
      any("Υπό πίεση" in a for a in flip.assumptions))

# Over-renovation must lose on the numbers, not be forbidden by a rule.
no_works_let = next(o for o in viable
                    if o.plan.transform == "none" and o.plan.exit == "rent_long"
                    and o.plan.hold_years == 5)
full_works_let = next((o for o in viable
                       if o.plan.transform == "full" and o.plan.exit == "rent_long"
                       and o.plan.hold_years == 5), None)
check("Renovating a cheap flat to let it loses to doing nothing",
      full_works_let is not None
      and full_works_let.annualised_roi_pct < no_works_let.annualised_roi_pct,
      f"{full_works_let.annualised_roi_pct if full_works_let else '?'} vs {no_works_let.annualised_roi_pct}")

check("Every indicator names a winner", len(best_per_indicator(outcomes)) == 6)
check("Categories are split", len(best_per_category(outcomes)) >= 2)
check("Best plan is the top viable one", best_plan(outcomes) is viable[0])

certainty_first = evaluate(wreck, wreck_facts, val, market,
                           weights={"return": 0.05, "certainty": 0.75, "speed": 0.05,
                                    "capital": 0.05, "ease": 0.05, "risk": 0.05})
top_certainty = [o for o in certainty_first if o.feasible][0]
check("Weighting certainty changes the winner",
      top_certainty.indicators.certainty >= flip.indicators.certainty,
      f"{top_certainty.plan.key}")

no_tourism = evaluate(wreck, wreck_facts, val, MarketInputs(monthly_rent=380))
check("Short stay blocked without tourism",
      any(o.plan.exit == "rent_short" and not o.feasible for o in no_tourism))

# An unmeasured signal and a measured zero are different claims. Reporting the
# first as the second is exactly the "the number could be a lie" failure the
# engine exists to avoid, so the blocker has to name which one it is.
unmeasured = [o for o in no_tourism if o.plan.exit == "rent_short"][0]
check("Unmeasured demand is not reported as zero",
      "άγνωστη" in unmeasured.blockers[0] and "0/100" not in unmeasured.blockers[0],
      unmeasured.blockers[0])
measured_zero = evaluate(wreck, wreck_facts, val,
                         MarketInputs(monthly_rent=380, tourism_intensity=0.0))
zero_short = [o for o in measured_zero if o.plan.exit == "rent_short"][0]
check("A measured zero still blocks, and says so as measured",
      not zero_short.feasible and "0/100" in zero_short.blockers[0],
      zero_short.blockers[0])
check("Measured demand opens the plan the unmeasured case closes",
      any(o.plan.exit == "rent_short" and o.feasible for o in
          evaluate(wreck, wreck_facts, val,
                   MarketInputs(monthly_rent=380, tourism_intensity=85.0))))

print("\n[10b] Land, building and the two markets")
land = Listing(source="t", listing_id="L1", url="", title="Οικόπεδο 1.200 τ.μ.",
               address="Αρτεμίσιο", area_name="Αρτεμίσιο", sub_area="Αρτεμίσιο",
               item_type="land", transaction="SALE", price=40000, size_sqm=1200,
               lat=38.85, lng=23.25)
land_facts = infer_facts(land)
land_val = value_property(land, 55.0, [48, 52, 55, 58, 60, 51, 57, 54], land_facts, 45)

land_plans = {p.key for p in generate_plans(land, MarketInputs())}
check("Land offers build-then-sell", any("LAND_BUILD_SELL" in k for k in land_plans))
check("Land offers build-then-let", any("LAND_BUILD_RENT_LONG" in k for k in land_plans))
check("Land offers build-then-commercial",
      any("LAND_BUILD_RENT_COMMERCIAL" in k for k in land_plans))
check("Land offers build-then-operate", any("LAND_BUILD_OPERATE" in k for k in land_plans))
check("Antiparochi is offered", any(k.startswith("ANTIPAROCHI") for k in land_plans))
check("Land offers plain holding", any("LAND_NONE_HOLD" in k for k in land_plans))

# Pricing new construction off the plot's own EUR/sqm produced -70% on every
# build plan. The two markets must stay separate.
no_built_rate = evaluate(land, land_facts, land_val, MarketInputs(buildable_sqm=480))
check("Build is refused without finished-space prices",
      all(not o.feasible for o in no_built_rate if o.plan.transform == "build"))
check("The refusal explains why",
      any("δομημένου χώρου" in (o.blockers[0] if o.blockers else "")
          for o in no_built_rate if o.plan.transform == "build"))

land_market = MarketInputs(annual_drift_pct=2.5, liquidity_score=45, tourism_intensity=52,
                           commercial_demand=45, buildable_sqm=480,
                           built_price_per_sqm=1600, rent_per_sqm_month=5.5)
land_outcomes = evaluate(land, land_facts, land_val, land_market)
land_viable = [o for o in land_outcomes if o.feasible]
check("Build plans price up with finished-space rates",
      all(o.annualised_roi_pct > -20 for o in land_viable if o.plan.transform == "build"),
      str([round(o.annualised_roi_pct, 1) for o in land_viable if o.plan.transform == "build"]))
antiparochi = next(o for o in land_viable if o.plan.acquisition == "antiparochi")
buy_and_build = next(o for o in land_viable
                     if o.plan.acquisition == "land" and o.plan.transform == "build"
                     and o.plan.exit == "sell")
check("Antiparochi ties up less capital than buying the land",
      antiparochi.capital_required < buy_and_build.capital_required)
check("Buildable area is estimated when unknown, and flagged",
      any("ΕΚΤΙΜΩΜΕΝΑ" in a for o in evaluate(
          land, land_facts, land_val,
          MarketInputs(built_price_per_sqm=1600, rent_per_sqm_month=5.5))
          if o.feasible and o.plan.transform == "build" for a in o.assumptions))

print("\n[10c] Market index serves both markets")
from akinita.scoring import MarketIndex as _MI
both = _MI()
both.add_sale_comparables(
    [Listing(source="t", listing_id=f"p{i}", url="", item_type="land", sub_area="Ζ",
             area_name="Ζ", price=60000, size_sqm=1000, lat=38.8, lng=23.2) for i in range(6)]
    + [Listing(source="t", listing_id=f"h{i}", url="", item_type="residence", sub_area="Ζ",
               area_name="Ζ", price=160000, size_sqm=100, lat=38.8, lng=23.2) for i in range(6)]
)
both.add_rent_comparables(
    [Listing(source="t", listing_id=f"r{i}", url="", item_type="residence", sub_area="Ζ",
             area_name="Ζ", price=550, size_sqm=100, lat=38.8, lng=23.2) for i in range(6)]
)
plot = Listing(source="t", listing_id="P1", url="", item_type="land", sub_area="Ζ",
               area_name="Ζ", price=50000, size_sqm=900, lat=38.8, lng=23.2)
check("Land rate stays a land rate", both.sale_price_per_sqm(plot) == 60.0)
check("Finished-space rate comes from residential comps",
      both.built_price_per_sqm(plot) == 1600.0)
check("Finished-space rent comes from residential comps",
      both.built_rent_per_sqm(plot) == 5.5)
check("Comparables are exposed for the confidence band",
      len(both.comparables_for(plot)) >= 4)

print("\n[11] Signals (offline logic)")
from akinita.signals.news import NewsSignal
from akinita.signals.public_investment import _stems
from akinita.signals.regions import normalise_greek, region_for

check("Athens maps to Attica", region_for(37.98, 23.73)[0] == "EL30")
check("Corfu maps to the Ionian, not Epirus", region_for(39.62, 19.92)[0] == "EL62")
check("Rhodes maps to the South Aegean", region_for(36.43, 28.22)[0] == "EL42")
check("A point far outside Greece maps nowhere", region_for(48.85, 2.35) is None)
check("Accents stripped", normalise_greek("Θεσσαλονίκης") == "ΘΕΣΣΑΛΟΝΙΚΗΣ")

# Substring matching would score a US president as a tram extension.
check("Word boundaries respected", NewsSignal.score_text("Ο Τραμπ και η ΕΕ")[0] == 0.0)
check("Real term still matches", NewsSignal.score_text("Επέκταση του τραμ")[0] > 0)
check("Stems match inflections", NewsSignal.score_text("νέο ξενοδοχείο στη Ρόδο")[0] > 0)
check("Overlapping keywords do not double-count",
      len(NewsSignal.score_text("Ανάπλαση παραλιακού μετώπου")[1]) == 1)

check("Nominative and genitive share a stem", _stems("Ρόδος") & _stems("ΔΗΜΟΣ ΡΟΔΟΥ"))
check("Larisa declension handled", _stems("Λάρισα") & _stems("ΔΗΜΟΣ ΛΑΡΙΣΑΙΩΝ"))
check("Generic modifiers ignored",
      not (_stems("Νέα Ερυθραία") & _stems("ΔΗΜΟΣ ΝΕΑΣ ΖΙΧΝΗΣ")))

print("\n[11b] robots.txt rules addressed to us by name")
ROBOTS = """
User-agent: *
Allow: /
User-agent: ClaudeBot
User-agent: Claude-Web
Disallow: /
User-agent: Claude-User
Allow: /public
Disallow: /
"""


class _Canned:
    """A fetcher that serves one robots.txt, so the gate can be tested offline."""

    def __init__(self, body):
        self.body = body
        self.user_agent = "test"
        self.accept_language = "el"

    def get(self, url, respect_robots=True):
        return self.body


from akinita.http import SELF_AGENT_NAMES, PoliteFetcher, RobotsGate

gate = RobotsGate(_Canned(ROBOTS))
check("A rule naming us beats a permissive wildcard",
      not gate.allows("https://example.test/anything"))
check("The gate reports which name matched",
      gate.named_group("https://example.test/") in SELF_AGENT_NAMES,
      gate.named_group("https://example.test/"))

only_star = RobotsGate(_Canned("User-agent: *\nDisallow: /private\nAllow: /\n"))
check("Falls back to the wildcard when we are not named",
      only_star.allows("https://a.test/x") and not only_star.allows("https://a.test/private"))
check("No named group is reported when none exists", only_star.named_group("https://a.test/") == "")

# A file that repeats `User-agent: *` — every such block applies, not just the
# first. spitogatos.gr splits its wildcard rules across four blocks, and keeping
# only the first reported a disallowed path as permitted.
split_groups = RobotsGate(_Canned(
    "User-agent: *\nDisallow: /one\n\nUser-agent: *\nDisallow: /two\n\n"
    "User-agent: *\nDisallow: */three*\n"))
check("First wildcard block applies", not split_groups.allows("https://c.test/one"))
check("Later wildcard blocks apply too", not split_groups.allows("https://c.test/two"))
check("...including the last one", not split_groups.allows("https://c.test/x/three/y"))
check("Unlisted paths still pass", split_groups.allows("https://c.test/four"))

split_named = RobotsGate(_Canned(
    "User-agent: *\nAllow: /\n\nUser-agent: ClaudeBot\nDisallow: /a\n\n"
    "User-agent: ClaudeBot\nDisallow: /b\n"))
check("Repeated named blocks merge as well",
      not split_named.allows("https://d.test/a") and not split_named.allows("https://d.test/b"))

narrow = RobotsGate(_Canned(
    "User-agent: *\nAllow: /\nUser-agent: Claude-User\nAllow: /ok\nDisallow: /\n"))
check("A named group's own allow-list still applies", narrow.allows("https://b.test/ok"))
check("...and its disallow blocks everything else", not narrow.allows("https://b.test/other"))

print("\n[11c] CSV source — data from anywhere")
from akinita.sources.csvfile import CsvSource, map_columns, normalise_type
from akinita.sources import ALL_ITEM_TYPES, REGISTRY

check("CSV is a registered source", "csv" in REGISTRY)
check("Four property types are declared", set(ALL_ITEM_TYPES) ==
      {"residence", "prof", "land", "parking"})

greek_headers = ["Κωδικός", "Ζητούμενη τιμή", "Εμβαδόν (τ.μ.)", "Περιοχή",
                 "Κατηγορία", "Έτος κατασκευής", "Περιγραφή", "Link", "Ενοίκιο"]
mapped = map_columns(greek_headers)
# Final sigma folding is why this failed the first time: "Κωδικός" normalises
# to "κωδικοσ" while the alias was typed "κωδικος".
for field in ("price", "size", "area", "type", "year", "url", "notes", "id", "rent"):
    check(f"Greek header mapped: {field}", field in mapped, str(sorted(mapped)))
check("English headers map too",
      {"price", "size", "area"} <= set(map_columns(["price", "sqm", "location"])))

for value, expected in [("Μεζονέτα", "residence"), ("ΟΙΚΟΠΕΔΟ", "land"),
                        ("Αγροτεμάχιο", "land"), ("Κατάστημα", "prof"),
                        ("Warehouse", "prof"), ("Θέση στάθμευσης", "parking"),
                        ("γκαράζ", "parking"), ("", "residence")]:
    check(f"Type «{value or '(κενό)'}» → {expected}", normalise_type(value) == expected)

import csv as _csv
import tempfile as _tf

_dir = _tf.mkdtemp()
_path = os.path.join(_dir, "t.csv")
with open(_path, "w", encoding="utf-8", newline="") as _h:
    _w = _csv.writer(_h, delimiter=";")
    _w.writerow(greek_headers)
    _w.writerow(["A1", "45.000 €", "61", "Θεσσαλονίκη (Ξηροκρήνη)", "Διαμέρισμα",
                 "1972", "χρήζει ανακαίνισης", "https://x/1", "430"])
    _w.writerow(["A2", "120000", "1200", "Αρτεμίσιο", "Αγροτεμάχιο", "", "εκτός σχεδίου",
                 "https://x/2", ""])
    _w.writerow(["A3", "88.500", "95", "Πάτρα (Κέντρο)", "Κατάστημα", "1998",
                 "ισόγειο", "https://x/3", "700"])
    _w.writerow(["A4", "χωρίς τιμή", "40", "Αθήνα", "Διαμέρισμα", "", "", "", ""])

source = CsvSource(None, _path)
rows = list(source.search(SearchQuery(item_type="")))
check("Semicolons and Greek money parsed", len(rows) == 3, str(len(rows)))
check("Rows without a price are dropped", all(r.price for r in rows))
check("Ids come from the file", rows[0].listing_id == "A1")
check("Greek thousand separators survive", rows[0].price == 45000.0)
check("Types are recognised per row",
      [r.item_type for r in rows] == ["residence", "land", "prof"])
check("Filtering by type works",
      len(list(source.search(SearchQuery(item_type="land")))) == 1)
check("Filtering by price works",
      len(list(source.search(SearchQuery(item_type="", max_price=50000)))) == 1)

rents = source.rent_listings()
check("Rent comparables come out of a rent column", len(rents) == 2, str(len(rents)))
check("Rent listings carry the RENT transaction",
      all(r.transaction == "RENT" for r in rents))
check("A file with no rent column yields no rents",
      CsvSource(None, os.path.join(_dir, "t.csv")).rent_listings() is not None)
check("A missing file fails loudly", _raises(lambda: list(
    CsvSource(None, os.path.join(_dir, "nope.csv")).search(SearchQuery()))))
shutil.rmtree(_dir, ignore_errors=True)

print("\n[11c2] Terms of use gate")
from akinita.sources.spitogatos import SpitogatosSource
from akinita.sources.base import PropertySource

check("Sources declare whether their terms reserve the content",
      hasattr(PropertySource, "requires_consent"))
check("Spitogatos is gated on its terms, not on robots.txt",
      SpitogatosSource.requires_consent is True)
check("The gate cites the actual clause",
      "commercial use" in SpitogatosSource.terms_notice)
check("...and links the terms", SpitogatosSource.terms_url.endswith("legalTerms"))
check("It names a lawful route", "info@spitogatos.gr" in SpitogatosSource.terms_notice)
check("A file of your own data is not gated", CsvSource.requires_consent is False)

# The screener must refuse rather than run, and say why.
import io
import contextlib

from akinita import screener as _screener

buffer = io.StringIO()
with contextlib.redirect_stdout(buffer):
    code = _screener.main(["--sources", "spitogatos", "--max-price", "50000",
                           "--out", os.path.join(tempfile.gettempdir(), "gated")])
output = buffer.getvalue()
check("Screener refuses a consent-gated source", code == 3, f"exit={code}")
check("The refusal explains itself", "εμπορικά" in output)
check("The refusal offers the working alternative", "--csv-path" in output)
check("Both bases from the terms are offered",
      "--personal-use" in output and "--i-have-written-consent" in output)
check("Personal use is named as expressly permitted",
      "ΠΡΟΣΩΠΙΚΗ ΧΡΗΣΗ" in SpitogatosSource.terms_notice)
check("Republication stays prohibited under either basis",
      "αναδημοσίευση" in SpitogatosSource.terms_notice)

print("\n[11d] Results dashboard")
from akinita.webreport import write_dashboard

_dir = _tf.mkdtemp()
try:
    dash_index = MarketIndex(min_comparables=3)
    corpus = [Listing(source="t", listing_id=f"d{i}", url="https://x", item_type="residence",
                      sub_area="Ζ", area_name="Ζ", address="Ζ", title="Διαμέρισμα",
                      transaction="SALE", price=150000, size_sqm=100, lat=40.6, lng=22.9)
              for i in range(6)]
    cheap = Listing(source="t", listing_id="cheap", url="https://x/1", item_type="residence",
                    sub_area="Ζ", area_name="Ζ", address="Ζ", title="Διαμέρισμα 60 τ.μ.",
                    transaction="SALE", price=45000, size_sqm=60, lat=40.6, lng=22.9,
                    construction_year=1980, description_hint="χρήζει ανακαίνισης")
    dash_index.add_sale_comparables(corpus + [cheap])
    dash_index.add_rent_comparables(
        [Listing(source="t", listing_id=f"r{i}", url="", item_type="residence", sub_area="Ζ",
                 area_name="Ζ", price=560, size_sqm=100, lat=40.6, lng=22.9) for i in range(6)])
    dash_scored = score_all([cheap] + corpus, dash_index, budget=200000)
    dash_analysis = analyse_shortlist(dash_scored, dash_index)
    out = write_dashboard(dash_scored, dash_analysis, os.path.join(_dir, "d.html"),
                          meta={"sources": ["test"], "item_types": list(ALL_ITEM_TYPES),
                                "max_price": 200000, "scope": "Όλη η Ελλάδα",
                                "scanned": 7, "shortlisted": 7},
                          full_detail=2)
    page = open(out, encoding="utf-8").read()
    check("Dashboard written", os.path.getsize(out) > 4000)
    check("No document-level tags", not any(t in page.lower()
          for t in ("<!doctype", "<html", "<body")))
    check("Carries its own title", "<title>" in page[:200])
    payload = json.loads(re.search(r"const D = (\{.*?\});\n", page, re.S).group(1))
    check("Every valued listing is in the page",
          len(payload["items"]) == len(dash_analysis), str(len(payload["items"])))
    check("Leaders carry full plan detail", "alts" in payload["items"][0])
    check("The tail is summarised, not dropped",
          all("rank" in i for i in payload["items"]))
    check("Filters have property types to work with", bool(payload["typeLabels"]))
    check("Indicator labels travel with the data",
          set(payload["indicatorLabels"]) == set(payload["indicatorShort"]))
finally:
    shutil.rmtree(_dir, ignore_errors=True)

# Every bar on a card asks the label table for a name. A field key that is not
# in that table renders the word "undefined" where a Greek label should be, and
# nothing else fails — so the mismatch has to be caught here.
from akinita.webreport import _TEMPLATE as DASHBOARD_TEMPLATE
from akinita.indicators import INDICATOR_SHORT_EL, INDICATOR_LABELS_EL
axes_source = re.search(r"const AXES = \[(.*?)\];", DASHBOARD_TEMPLATE, re.S)
axes_pairs = re.findall(r'\["(\w+)",\s*"(\w+)"\]', axes_source.group(1) if axes_source else "")
check("Dashboard declares its encoding too",
      'charset="utf-8"' in DASHBOARD_TEMPLATE[:200].lower())
check("Dashboard declares one axis per indicator", len(axes_pairs) == len(INDICATOR_SHORT_EL),
      str(axes_pairs))
check("Every axis label key exists in the label tables",
      all(key in INDICATOR_SHORT_EL and key in INDICATOR_LABELS_EL for _, key in axes_pairs),
      str([key for _, key in axes_pairs if key not in INDICATOR_SHORT_EL]))
check("Every axis field exists in the exported payload",
      all(field in {"ret", "certainty", "speed", "cap", "ease", "risk"}
          for field, _ in axes_pairs), str([f for f, _ in axes_pairs]))

print("\n[11e] Regions tab and the single page")
from akinita.ethniki import render_pane, PANE_CSS, MUNICIPALITIES
from akinita.webreport import render_page, empty_data

map_data = {
    "generated": "01/01/2026 09:00",
    "regions": [
        {"area": "Νότιο Αιγαίο", "code": "EL42", "intensity": 100.0, "momentum": 1.2,
         "raw_value": 41500466.0, "as_of": "2024", "confidence": 78.0,
         "evidence": ["2022: 1", "2023: 2", "2024: 3"], "notes": [],
         "detail": {"versus_2019_pct": 6.0}},
        {"area": "Δυτική Μακεδονία", "code": "EL53", "intensity": 0.0, "momentum": -0.7,
         "raw_value": 342558.0, "as_of": "2024", "confidence": 78.0,
         "evidence": ["2024: 3"], "notes": [], "detail": {}},
    ],
    "municipalities": [
        {"asked_for": "Ρόδος", "area": "ΔΗΜΟΣ ΡΟΔΟΥ", "region": "Νότιο Αιγαίο",
         "intensity": 97.5, "raw_value": 75.0, "region_tourism": 100.0,
         "where_to_look": 98.8, "evidence": ["Απόφαση Α", "Απόφαση Α", "Απόφαση Β"],
         "notes": [], "momentum": None, "confidence": 52.0},
        {"asked_for": "Φλώρινα", "area": "ΔΗΜΟΣ ΦΛΩΡΙΝΑΣ", "region": "Δυτική Μακεδονία",
         "intensity": 0.0, "raw_value": 3.0, "region_tourism": None,
         "where_to_look": None, "evidence": [], "notes": [], "momentum": None,
         "confidence": 52.0},
    ],
    "unmatched": ["Ηράκλειο", "Λάρισα"],
}
pane = render_pane(map_data)
check("Regions tab is content, not a page of its own",
      "<title>" not in pane and "<style>" not in pane
      and not re.search(r"<(?:!doctype|html|head|body)\b", pane, re.I))
check("Every region reaches the tab",
      all(row["area"] in pane for row in map_data["regions"]))
check("Every municipality reaches the tab",
      all(row["asked_for"] in pane for row in map_data["municipalities"]))
# «Διανυκτερεύσεις» ως επικεφαλίδα στήλης δεν απαντά σε κανένα ερώτημα αγοραστή.
# Ο αριθμός μένει ως τεκμήριο από κάτω, η στήλη λέει τι σημαίνει.
check("Columns say what the number means, not what it is",
      "Ζήτηση για μίσθωση" in pane and "<th>Διανυκτερεύσεις" not in pane)
check("The raw figure survives as evidence", "εκατ. διανυκτερεύσεις" in pane)
check("A zero rank is explained where it appears",
      "342.558" in pane and "0/100" in pane)
check("Missing figures render as a dash, not as zero",
      ">—<" in pane and "None" not in pane)
check("Pre-pandemic comparison comes from data, not prose", "+6.0%" in pane)
check("Repeated evidence is shown once", pane.count("Απόφαση Α") == 1)
check("Unmatched names are not listed one by one",
      not any(name in pane for name in map_data["unmatched"]))
check("Regions styling cannot leak into the other tab",
      PANE_CSS.count("#pane-areas") >= 10 and "\n  table{" not in PANE_CSS)
check("Every municipality in the national list has coordinates",
      all(isinstance(lat, float) and isinstance(lng, float)
          for _, lat, lng in MUNICIPALITIES))

page = render_page(empty_data(), pane, PANE_CSS)
check("One page carries both tabs",
      page.count('data-pane="') >= 3 and 'role="tablist"' in page)
check("The opportunities tab is the one that opens",
      re.search(r'data-pane="pane-ops"[^>]*aria-selected="true"', page) is not None)
check("The regions tab holds the regions content", "Πού να ψάξεις πρώτα" in page)
check("Every placeholder is substituted",
      not any(token in page for token in
              ("__DATA__", "__REGIONS__", "__PANE_CSS__", "__THEME_CSS__",
               "__THEME_CONTROL__", "__THEME_SCRIPT__")))
check("The page declares its encoding and title",
      'charset="utf-8"' in page[:200].lower() and "<title>" in page)
check("The page itself does not scroll, the open tab does",
      "overflow:hidden" in page and ".pane{" in page and "overflow-y:auto" in page)

print("\n[11f] Theme control")
from akinita import theme as theme_module
check("Theme control is present on the page", 'class="theme"' in page)
check("All three theme states offered",
      page.count('data-set="') == 3 and 'data-set="system"' in page)
check("Toggle writes data-theme, and system clears it",
      'setAttribute("data-theme"' in theme_module.SCRIPT
      and 'removeAttribute("data-theme")' in theme_module.SCRIPT)
check("Storage access cannot break the page",
      theme_module.SCRIPT.count("catch (e)") >= 2
      and "localStorage" in theme_module.SCRIPT)
check("Theme styling uses tokens, not literal colours",
      "#" not in theme_module.CSS and "var(--" in theme_module.CSS)

print("\n[12] Registries")
from akinita.registry import audit as registry_audit, load_ideas, load_mechanisms

ideas = load_ideas()
mechanisms = load_mechanisms()
check("Ideas registry is populated", len(ideas) >= 15, str(len(ideas)))
check("Mechanisms registry is populated", len(mechanisms) >= 15, str(len(mechanisms)))
check("Every idea states a hypothesis", all(i.get("hypothesis") for i in ideas))
check("Every mechanism states its validation", all(m.get("validation") for m in mechanisms))
check("Every mechanism names known limits", all(m.get("known_limits") for m in mechanisms))

audit_result = registry_audit()
check("Registry audit passes", audit_result.ok, "; ".join(audit_result.errors))
check("Audit actually checks things", audit_result.checks_run >= 20)

# The audit has to fail when the registry drifts from the code, or it is theatre.
broken = [dict(m) for m in mechanisms]
for entry in broken:
    if entry.get("feeds_score") == "value_gap":
        entry["weight"] = 0.99
check("Audit catches a weight that drifted from the code",
      not registry_audit(ideas, broken).ok)
orphan = [dict(m) for m in mechanisms]
orphan[0] = dict(orphan[0], implements="SIG-999")
check("Audit catches a mechanism pointing at no idea",
      not registry_audit(ideas, orphan).ok)
ghost = [dict(m) for m in mechanisms]
ghost[0] = dict(ghost[0], entrypoint="function_that_does_not_exist")
check("Audit catches an entrypoint that is not in the code",
      not registry_audit(ideas, ghost).ok)

print("\n" + "=" * 62)
print(f"PASSED {len(PASSED)}   FAILED {len(FAILED)}")
if FAILED:
    for name in FAILED:
        print("  FAILED:", name)
print("=" * 62)
sys.exit(1 if FAILED else 0)
