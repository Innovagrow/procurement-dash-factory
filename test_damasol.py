"""
Offline test suite for the Damasol real estate opportunity engine.

Runs with no network access: a fake source replays recorded-shape payloads so
the crawl -> pre-score -> enrich -> score -> export pipeline is exercised
end to end, deterministically.

    python test_damasol.py
"""
import os
import shutil
import sys
import tempfile

from damasol.geo import cell_bbox, geo_cell, nearest_urban_centre, normalise_area
from damasol.http import PoliteFetcher
from damasol.models import Listing, parse_age_days, parse_area, parse_money
from damasol.outreach.templates import available_templates, render
from damasol.report import write_html_report
from damasol.screener import enrich_market_context, export_csv, export_json
from damasol.scoring import MarketIndex, grade_for, score_all
from damasol.sources.base import SearchQuery

PASSED, FAILED = [], []


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
print("DAMASOL ENGINE - OFFLINE TEST SUITE")
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

from damasol.scoring import _quality_haircut
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
identity = {"sender_name": "Α. Β.", "reply_email": "deals@damasol.com", "phone": "+30 210 0000000"}
message = render("email", "ΑΒΓ Ακίνητα", identity)
body = message["body"]
check("Subject rendered", bool(message["subject"]))
check("Recipient personalised", "ΑΒΓ Ακίνητα" in body)
check("No unfilled placeholders", "{" not in body and "}" not in body)
must_contain = {
    "επενδυτικό οργανισμό": "identifies Damasol as an investment organisation",
    "ευκαιρία": "asks for properties they consider an opportunity",
    "ΛΕΠΤΟΜΕΡΕΙΕΣ ΤΟΥ ΑΚΙΝΗΤΟΥ": "asks for property details",
    "ΓΙΑΤΙ ΤΟ ΘΕΩΡΕΙΤΕ ΕΥΚΑΙΡΙΑ": "asks why they consider it an opportunity",
    "ΑΝΟΙΧΤΟΙ ΣΕ ΠΡΟΤΑΣΕΙΣ ΣΥΝΕΡΓΑΣΙΑΣ": "states openness to partnership proposals",
    "ΕΥΕΛΙΚΤΑ ΕΠΙΧΕΙΡΗΜΑΤΙΚΑ ΜΟΝΤΕΛΑ": "states experience in flexible business models",
    "ΔΙΑΓΡΑΦΗ": "carries an opt-out",
    "deals@damasol.com": "carries the reply address",
}
for needle, description in must_contain.items():
    check(f"Email {description}", needle in body)
for channel in available_templates():
    rendered = render(channel, "ΑΒΓ", identity)["body"]
    check(f"Channel '{channel}' renders cleanly", "{" not in rendered and len(rendered) > 60)
check("Anonymous greeting when name is unknown",
      "Αξιότιμοι συνεργάτες" in render("email", "", identity)["body"])

print("\n" + "=" * 62)
print(f"PASSED {len(PASSED)}   FAILED {len(FAILED)}")
if FAILED:
    for name in FAILED:
        print("  FAILED:", name)
print("=" * 62)
sys.exit(1 if FAILED else 0)
