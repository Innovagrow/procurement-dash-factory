"""
Opportunity screener CLI.

    python -m akinita.screener --max-price 50000 --item-types residence,prof,land

Pipeline
--------
1. CRAWL     every listing matching the hard filters (e.g. all of Greece, for
             sale, <= 50.000 EUR) across the requested property types.
2. PRE-SCORE using comparables drawn from the crawled corpus itself - cheap,
             no extra requests, good enough to rank.
3. ENRICH    the top N candidates only: for each ~5 km cell they sit in, pull
             the *unfiltered* local sale market and the local rental market.
             This is what turns "cheap" into "cheap relative to its own area,
             and yielding X%".
4. SCORE     again with the real baselines and export CSV / JSON / HTML.

Enrichment is the expensive step, which is why it runs on a shortlist rather
than the whole corpus. Everything is cached on disk, so a second run is free.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from typing import Dict, List, Optional, Sequence

from .console import ensure_utf8
from .costs import DEFAULT_COSTS
from .geo import GREECE_BBOX, cell_bbox, geo_cell
from .http import PoliteFetcher
from .indicators import DEFAULT_INDICATOR_WEIGHTS, INDICATOR_SHORT_EL
from .models import Listing, ScoredListing
from .scoring import DEFAULT_WEIGHTS, MarketIndex, score_all
from .sources import ALL_ITEM_TYPES, ITEM_TYPE_LABELS_EL, REGISTRY, SearchQuery
from .strategies import MarketInputs, best_plan, evaluate
from .valuation import infer_facts, value_property

DEFAULT_ITEM_TYPES = ("residence", "prof", "land")


def _log(message: str) -> None:
    print(message, flush=True)


# ------------------------------------------------------------------- crawl


def crawl_sources(
    sources: Sequence,
    item_types: Sequence[str],
    transaction: str,
    max_price: Optional[float],
    min_price: Optional[float],
    min_size: Optional[float],
    bbox,
    max_pages: Optional[int],
) -> List[Listing]:
    """Crawl every configured source and merge, keeping the cheapest duplicate.

    Sources disagree and overlap: the same flat can sit on two portals at two
    prices. Deduplicating on (area, size, rounded price) and keeping the lowest
    asking price means a listing never counts twice and we always evaluate the
    better of the two offers.
    """
    merged: Dict[tuple, Listing] = {}
    for source in sources:
        _log(f"\n  ── πηγή: {source.name}")
        try:
            found = crawl_candidates(source, item_types, transaction, max_price,
                                     min_price, min_size, bbox, max_pages)
        except Exception as exc:  # noqa: BLE001 - one dead source must not kill the run
            _log(f"    ! η πηγή {source.name} απέτυχε: {exc}")
            continue
        for listing in found:
            key = (
                listing.item_type,
                (listing.sub_area or listing.address or "").strip().lower(),
                round(listing.size_sqm or 0),
                round((listing.price or 0) / 500),
            )
            existing = merged.get(key)
            if existing is None or (listing.price or 0) < (existing.price or 0):
                merged[key] = listing
    return list(merged.values())


def crawl_candidates(
    source,
    item_types: Sequence[str],
    transaction: str,
    max_price: Optional[float],
    min_price: Optional[float],
    min_size: Optional[float],
    bbox,
    max_pages: Optional[int],
) -> List[Listing]:
    listings: List[Listing] = []
    for item_type in item_types:
        query = SearchQuery(
            transaction=transaction,
            item_type=item_type,
            max_price=max_price,
            min_price=min_price,
            min_size=min_size,
            bbox=bbox,
            max_pages=max_pages,
        )
        total = source.count(query)
        _log(f"  · {item_type:9s} {total:>6} αγγελίες στην αγορά για αυτά τα φίλτρα")
        collected = 0
        for listing in source.search(query):
            listings.append(listing)
            collected += 1
            if collected % 340 == 0:
                _log(f"      ... {collected} συλλέχθηκαν")
        _log(f"    ✓ {collected} συλλέχθηκαν")
    return listings


def enrich_market_context(
    source,
    index: MarketIndex,
    shortlist: Sequence[ScoredListing],
    cell_size: float,
    exclude_ids: set,
    comp_pages: int = 3,
    rent_pages: int = 2,
    rent_max_price: Optional[float] = 3000,
) -> None:
    """Pull real local baselines for the cells the shortlist sits in."""
    cells: Dict[tuple, None] = {}
    for scored in shortlist:
        cell = geo_cell(scored.listing.lat, scored.listing.lng, cell_size)
        if cell:
            cells[(scored.listing.item_type, cell)] = None

    _log(f"  · {len(cells)} μοναδικά κελιά περιοχής προς εμπλουτισμό")

    # A plot's own EUR/sqm says nothing about what a building on it would sell
    # or let for, so land cells need residential comparables as well as land ones.
    for item_type, cell in list(cells):
        if item_type == "land":
            cells.setdefault(("residence", cell), None)

    for position, (item_type, cell) in enumerate(cells, 1):
        bbox = cell_bbox(cell, cell_size)
        _log(f"    [{position}/{len(cells)}] {item_type} @ {cell}")

        sale_query = SearchQuery(
            transaction="buy",
            item_type=item_type,
            bbox=bbox,
            sorting="publication_date_desc",
            max_pages=comp_pages,
        )
        comparables = [
            listing
            for listing in source.search(sale_query)
            if listing.listing_id not in exclude_ids
        ]
        index.add_sale_comparables(comparables)

        rent_query = SearchQuery(
            transaction="rent",
            item_type=item_type,
            bbox=bbox,
            max_price=rent_max_price,
            sorting="publication_date_desc",
            max_pages=rent_pages,
        )
        index.add_rent_comparables(source.search(rent_query))


# ------------------------------------------------------------------ export


def analyse_shortlist(
    shortlist: Sequence[ScoredListing],
    index: MarketIndex,
    tourism_by_area: Optional[Dict[str, float]] = None,
    weights: Optional[Dict[str, float]] = None,
    capital_ceiling: float = 250_000.0,
) -> Dict[str, dict]:
    """Price every plan for every shortlisted listing and keep the best.

    This is the step that makes the final ranking a return ranking rather than a
    discount ranking: whatever the triage thought, a listing only rises here if
    some concrete plan actually pays.
    """
    tourism_by_area = tourism_by_area or {}
    results: Dict[str, dict] = {}

    for scored in shortlist:
        listing = scored.listing
        market_per_sqm = index.sale_price_per_sqm(listing)
        if not market_per_sqm or not listing.size_sqm:
            continue
        facts = infer_facts(listing)
        valuation = value_property(
            listing, market_per_sqm, index.comparables_for(listing),
            facts, scored.components.get("liquidity", 55.0),
        )
        if not valuation:
            continue

        rent_per_sqm = index.rent_price_per_sqm(listing)
        built_per_sqm = index.built_price_per_sqm(listing)
        built_rent_per_sqm = index.built_rent_per_sqm(listing)

        market = MarketInputs(
            monthly_rent=(rent_per_sqm * listing.size_sqm) if rent_per_sqm else None,
            liquidity_score=scored.components.get("liquidity", 55.0),
            tourism_intensity=tourism_by_area.get(listing.area_name),
            built_price_per_sqm=built_per_sqm,
            rent_per_sqm_month=built_rent_per_sqm,
            capital_ceiling=capital_ceiling,
        ).derive_from(listing)

        outcomes = evaluate(listing, facts, valuation, market, DEFAULT_COSTS, weights)
        winner = best_plan(outcomes)
        if not winner:
            continue
        results[listing.listing_id] = {
            "valuation": valuation,
            "best": winner,
            "outcomes": outcomes,
            "viable": sum(1 for o in outcomes if o.feasible),
        }
    return results


def _rows(scored: Sequence[ScoredListing], analysis: Optional[Dict[str, dict]]) -> List[dict]:
    rows = []
    for item in scored:
        row = item.to_dict()
        found = (analysis or {}).get(item.listing.listing_id)
        if found:
            best = found["best"]
            row.update({
                "best_plan": best.plan.key,
                "best_plan_name": best.name,
                "best_plan_category": best.category,
                "capital_required": best.capital_required,
                "net_profit": best.net_profit,
                "annualised_roi_pct": best.annualised_roi_pct,
                "annualised_roi_stressed_pct": best.annualised_roi_stressed_pct,
                "months_to_exit": best.months_to_exit,
                "viable_plans": found["viable"],
                "open_market_value": found["valuation"].open_market,
                "immediate_value": found["valuation"].immediate,
                "valuation_confidence_pct": found["valuation"].confidence_pct,
            })
            row.update({f"ind_{k}": v for k, v in best.indicators.as_dict().items()})
        rows.append(row)
    return rows


def export_csv(scored: Sequence[ScoredListing], path: str,
               analysis: Optional[Dict[str, dict]] = None) -> None:
    if not scored:
        return
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    rows = _rows(scored, analysis)
    fieldnames = sorted({key for row in rows for key in row})
    with open(path, "w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def export_json(scored: Sequence[ScoredListing], path: str,
                analysis: Optional[Dict[str, dict]] = None) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    payload = []
    for item in scored:
        row = {
            **item.listing.to_dict(),
            "triage_score": item.score,
            "triage_components": item.components,
            "evidence": item.evidence,
            "flags": item.flags,
            "market_price_per_sqm": item.market_price_per_sqm,
            "discount_pct": item.discount_pct,
            "est_monthly_rent": item.est_monthly_rent,
            "gross_yield_pct": item.gross_yield_pct,
        }
        found = (analysis or {}).get(item.listing.listing_id)
        if found:
            best = found["best"]
            row["valuation"] = {
                "open_market": found["valuation"].open_market,
                "immediate": found["valuation"].immediate,
                "low": found["valuation"].low,
                "high": found["valuation"].high,
                "confidence_pct": found["valuation"].confidence_pct,
                "factors": found["valuation"].factor_table(),
            }
            row["best_plan"] = best.to_dict()
            row["indicators"] = best.indicators.as_dict()
            row["plans"] = [o.to_dict() for o in found["outcomes"] if o.feasible][:12]
            row["blocked"] = [
                {"plan": o.name, "reason": o.blockers[0] if o.blockers else ""}
                for o in found["outcomes"] if not o.feasible
            ][:8]
        payload.append(row)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)


# --------------------------------------------------------------------- cli


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="akinita.screener",
        description="Εντοπισμός των καλύτερων επαγγελματικών ευκαιριών σε ακίνητα.",
    )
    parser.add_argument("--source", default="spitogatos", choices=sorted(REGISTRY),
                        help="Μία πηγή. Για περισσότερες μαζί, δείτε --sources.")
    parser.add_argument("--sources", default=None,
                        help="Πηγές χωρισμένες με κόμμα, π.χ. spitogatos,csv. "
                             "Τα αποτελέσματα συγχωνεύονται και αποδιπλασιάζονται.")
    parser.add_argument("--csv-path", default="", help="Αρχείο για την πηγή csv")
    parser.add_argument("--all-types", action="store_true",
                        help="Όλοι οι τύποι ακινήτων: " + ", ".join(ALL_ITEM_TYPES))
    parser.add_argument("--html-out", default=None,
                        help="Αρχείο HTML με ΟΛΑ τα αποτελέσματα (προεπιλογή: <out>.html)")
    parser.add_argument("--transaction", default="buy", choices=["buy", "auction", "rent"])
    parser.add_argument("--item-types", default=",".join(DEFAULT_ITEM_TYPES))
    parser.add_argument("--max-price", type=float, default=50000)
    parser.add_argument("--min-price", type=float, default=None)
    parser.add_argument("--min-size", type=float, default=None)
    parser.add_argument(
        "--bbox",
        default=None,
        help="Περιορισμός περιοχής ως N,E,S,W (π.χ. 38.2,24.1,37.8,23.4). Χωρίς αυτό: όλη η Ελλάδα.",
    )
    parser.add_argument("--max-pages", type=int, default=None, help="Όριο σελίδων ανά τύπο ακινήτου")
    parser.add_argument("--enrich-top", type=int, default=120)
    parser.add_argument("--no-enrich", action="store_true")
    parser.add_argument("--top", type=int, default=60, help="Πλήθος ακινήτων στην τελική αναφορά")
    parser.add_argument("--out", default="out/opportunities")
    parser.add_argument("--delay", type=float, default=2.0)
    parser.add_argument("--cache-hours", type=float, default=24.0)
    parser.add_argument("--cell-size", type=float, default=0.02,
                        help="Μέγεθος κελιού συγκριτικών σε μοίρες (0.02 ≈ 2,2 χλμ)")
    parser.add_argument("--min-comparables", type=int, default=0,
                        help="Ελάχιστα συγκρίσιμα ανά περιοχή (0 = αυτόματα)")
    parser.add_argument("--comp-pages", type=int, default=3,
                        help="Σελίδες συγκριτικών πωλήσεων ανά κελί")
    parser.add_argument("--rent-pages", type=int, default=2,
                        help="Σελίδες συγκριτικών ενοικίων ανά κελί")
    parser.add_argument("--probe", action="store_true", help="Έλεγχος πηγής χωρίς πλήρη σάρωση")
    parser.add_argument("--weights", default=None,
                        help="JSON με βάρη triage, π.χ. '{\"rental_yield\":0.4}'")
    parser.add_argument("--indicator-weights", default=None,
                        help="JSON με βάρη δεικτών κατάταξης, π.χ. '{\"certainty\":0.35}'")
    parser.add_argument("--show-browser", action="store_true",
                        help="Ανοίγει παράθυρο browser. Αν η πύλη ζητήσει "
                             "επαλήθευση, την περνάτε εσείς και η σάρωση συνεχίζει.")
    parser.add_argument("--save-html", default="",
                        help="Φάκελος όπου αποθηκεύονται οι σελίδες όπως ήρθαν, "
                             "για έλεγχο και προσαρμογή των εξαγωγέων.")
    parser.add_argument("--no-regions", action="store_true",
                        help="Χωρίς την καρτέλα «Πού να ψάξεις»")
    parser.add_argument("--note", default="",
                        help="Σημείωση που τυπώνεται στη σελίδα αποτελεσμάτων")
    parser.add_argument("--capital-ceiling", type=float, default=250000.0,
                        help="Κεφάλαιο που θεωρείται «πολύ» — βαθμονομεί τον δείκτη κεφαλαίου")
    parser.add_argument(
        "--personal-use",
        action="store_true",
        help="Δηλώνετε ότι η εκτέλεση γίνεται για προσωπική, μη εμπορική χρήση — "
             "που οι Όροι του Spitogatos επιτρέπουν ρητά.",
    )
    parser.add_argument(
        "--i-have-written-consent",
        action="store_true",
        help="Δηλώνετε ότι έχετε γραπτή άδεια του ιδιοκτήτη της πηγής για "
             "εμπορική χρήση των δεδομένων της.",
    )
    parser.add_argument(
        "--ignore-robots",
        action="store_true",
        help="Αγνόησε το robots.txt της πηγής. Ορισμένες πύλες (π.χ. xe.gr) απαγορεύουν "
             "ρητά τη σάρωση των σελίδων αποτελεσμάτων· η χρήση αυτής της επιλογής είναι "
             "δική σας εμπορική/νομική απόφαση και υπόκειται στους Όρους Χρήσης τους.",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    ensure_utf8()
    args = build_parser().parse_args(argv)

    bbox = None
    if args.bbox:
        parts = [float(v) for v in args.bbox.split(",")]
        if len(parts) != 4:
            _log("!! --bbox θέλει 4 τιμές: N,E,S,W")
            return 2
        bbox = tuple(parts)

    weights = dict(DEFAULT_WEIGHTS)
    if args.weights:
        weights.update(json.loads(args.weights))
        total = sum(weights.values())
        weights = {k: v / total for k, v in weights.items()}

    indicator_weights = dict(DEFAULT_INDICATOR_WEIGHTS)
    if args.indicator_weights:
        indicator_weights.update(json.loads(args.indicator_weights))

    fetcher = PoliteFetcher(
        delay=args.delay,
        cache_ttl_hours=args.cache_hours,
        obey_robots=not args.ignore_robots,
    )
    if args.ignore_robots:
        _log(
            "!! --ignore-robots: παρακάμπτεται το robots.txt. Βεβαιωθείτε ότι έχετε "
            "δικαίωμα πρόσβασης στα δεδομένα αυτής της πηγής."
        )

    names = [n.strip() for n in (args.sources or args.source).split(",") if n.strip()]
    sources = []
    for name in names:
        if name not in REGISTRY:
            _log(f"!! άγνωστη πηγή «{name}» — διαθέσιμες: {', '.join(sorted(REGISTRY))}")
            return 2
        sources.append(
            REGISTRY[name](fetcher, args.csv_path) if name == "csv"
            else REGISTRY[name](fetcher, headless=not args.show_browser,
                                save_html_dir=args.save_html)
            if name == "spitogatos"
            else REGISTRY[name](fetcher)
        )
    # The terms distinguish two bases, so the tool does too. Neither flag is a
    # permission this package grants - each records what the operator has
    # declared about their own use, which is the only thing that can settle it.
    declared_basis = ("γραπτή άδεια ιδιοκτήτη" if args.i_have_written_consent
                      else "προσωπική, μη εμπορική χρήση" if args.personal_use else "")
    gated = [s for s in sources if getattr(s, "requires_consent", False)]
    if gated and not declared_basis:
        for blocked_source in gated:
            _log("")
            _log("=" * 74)
            _log(f"  Η πηγή «{blocked_source.name}» δεν μπορεί να χρησιμοποιηθεί εμπορικά")
            _log("  χωρίς άδεια του ιδιοκτήτη της.")
            _log("=" * 74)
            _log(f"  {blocked_source.terms_notice}")
            if blocked_source.terms_url:
                _log(f"  Όροι: {blocked_source.terms_url}")
        _log("")
        _log("  Στο μεταξύ δουλεύει πλήρως η πηγή «csv» με δικά σας δεδομένα:")
        _log("    python -m akinita.screener --sources csv --csv-path akinita.csv --all-types")
        return 3

    if gated and declared_basis:
        _log(f"  Βάση χρήσης που δηλώθηκε: {declared_basis}.")
        if args.personal_use:
            _log("  Υπενθύμιση: οι Όροι απαγορεύουν την αναδημοσίευση και διανομή σε")
            _log("  κάθε περίπτωση — κρατήστε τα αποτελέσματα τοπικά.")

    source = sources[0]

    item_types = (list(ALL_ITEM_TYPES) if args.all_types
                  else [t.strip() for t in args.item_types.split(",") if t.strip()])

    if args.probe:
        query = SearchQuery(
            transaction=args.transaction,
            item_type=item_types[0],
            max_price=args.max_price,
            bbox=bbox,
        )
        if hasattr(source, "probe"):
            _log(json.dumps(source.probe(query), ensure_ascii=False, indent=2))
        else:
            _log(f"{source.name}: {source.count(query)} αποτελέσματα για {query.describe()}")
        return 0

    _log("=" * 74)
    # Branding the run as the company while a personal-use basis is declared
    # would put a contradiction in our own output.
    _log("Σάρωση ευκαιριών ακινήτων"
         if args.personal_use else "Σάρωση ευκαιριών ακινήτων")
    _log(f"Πηγές: {', '.join(s.name for s in sources)}")
    _log(f"Τύποι: {', '.join(ITEM_TYPE_LABELS_EL.get(t, t) for t in item_types)}")
    _log(
        f"Φίλτρα: {args.transaction} · έως {args.max_price:,.0f} € · "
        f"{'ΟΛΗ Η ΕΛΛΑΔΑ' if not bbox else 'bbox ' + args.bbox}"
    )
    _log("=" * 74)

    _log("\n[1/5] Συλλογή υποψηφίων")
    candidates = crawl_sources(
        sources, item_types, args.transaction, args.max_price,
        args.min_price, args.min_size, bbox, args.max_pages,
    )
    _log(f"  Σύνολο: {len(candidates)} αγγελίες")

    # Rent comparables come from whichever source can supply them: a portal
    # query, or a rent column in the file.
    rent_listings: List[Listing] = []
    for provider in sources:
        collector = getattr(provider, "rent_listings", None)
        if callable(collector):
            rent_listings.extend(collector())
    if rent_listings:
        _log(f"  Συγκριτικά ενοικίων από τις πηγές: {len(rent_listings)}")

    if not candidates:
        _log("Καμία αγγελία. Χαλαρώστε τα φίλτρα.")
        return 1

    _log("\n[2/5] Διαλογή — ποια αξίζουν πλήρη ανάλυση (ΟΧΙ ετυμηγορία)")

    # A national crawl can spare four comparables per neighbourhood; a
    # fifty-row spreadsheet cannot, and demanding them silently drops every
    # property type with only three examples - which reads as "found nothing"
    # rather than "your sample is small".
    min_comparables = args.min_comparables
    if not min_comparables:
        min_comparables = 4 if len(candidates) >= 200 else 2
        if len(candidates) < 200:
            _log(f"  Μικρό δείγμα ({len(candidates)}) — τα ελάχιστα συγκρίσιμα "
                 f"χαμηλώνουν σε {min_comparables}· η εμπιστοσύνη των εκτιμήσεων "
                 "πέφτει ανάλογα και φαίνεται στη σελίδα.")
    index = MarketIndex(cell_size=args.cell_size, min_comparables=min_comparables)
    index.add_sale_comparables(candidates)
    prescored = score_all(candidates, index, budget=args.max_price, weights=weights)
    shortlist = prescored[: args.enrich_top]
    _log(f"  Shortlist προς εμπλουτισμό: {len(shortlist)}")

    if not args.no_enrich:
        _log("\n[3/5] Εμπλουτισμός με πραγματικά συγκριτικά αγοράς & ενοικίων")
        enrich_index = MarketIndex(cell_size=args.cell_size,
                                   min_comparables=min_comparables)
        for enriching in sources:
            if not getattr(enriching, "supports_bbox", False):
                # A file-based source has no wider market to reach for: the file
                # IS the market. Excluding the candidates from their own
                # comparables would leave nothing at all, which is exactly what
                # happened before this check existed.
                _log(f"  · {enriching.name}: χωρίς γεωγραφική αναζήτηση — "
                     "τα ίδια τα δεδομένα χρησιμεύουν ως συγκριτικά")
                continue
            enrich_market_context(
                enriching, enrich_index, shortlist, args.cell_size,
                exclude_ids={c.listing_id for c in candidates},
                comp_pages=args.comp_pages,
                rent_pages=args.rent_pages,
            )
        # The corpus always underpins the index; enrichment adds the wider
        # market on top where a source can supply it.
        enrich_index.add_sale_comparables(candidates)
        enrich_index.add_rent_comparables(rent_listings)
        _log(f"  Δείκτης αγοράς: {enrich_index.summary()}")
        index = enrich_index
    else:
        _log("\n[3/5] Εμπλουτισμός παραλείφθηκε (--no-enrich)")
        index.add_rent_comparables(rent_listings)

    _log("\n[4/5] Αποτίμηση & τιμολόγηση κάθε πλάνου αξιοποίησης")
    rescored = score_all([s.listing for s in shortlist], index,
                         budget=args.max_price, weights=weights)
    analysis = analyse_shortlist(
        rescored, index, weights=indicator_weights, capital_ceiling=args.capital_ceiling,
    )
    _log(f"  {len(analysis)}/{len(rescored)} ακίνητα με τουλάχιστον ένα εφικτό πλάνο")

    _log("\n[5/5] Κατάταξη κατά απόδοση & εξαγωγή")
    ranked = [s for s in rescored if s.listing.listing_id in analysis]
    ranked.sort(
        key=lambda s: analysis[s.listing.listing_id]["best"].indicators.combined,
        reverse=True,
    )
    orphans = [s for s in rescored if s.listing.listing_id not in analysis]
    if orphans:
        _log(f"  ({len(orphans)} χωρίς επαρκή δεδομένα για αποτίμηση — εξαιρούνται)")
        _log("   Χρειάζονται τουλάχιστον 3 συγκρίσιμα ακίνητα ίδιου τύπου και ")
        _log("   γνωστό εμβαδόν. Αν το δείγμα σας είναι μικρό, προσθέστε κι άλλες ")
        _log("   γραμμές — ή στήλη «Ενοίκιο» για να αποτιμηθούν τα πλάνα μίσθωσης.")
    final = ranked[: args.top]

    export_csv(final, args.out + ".csv", analysis)
    export_json(final, args.out + ".json", analysis)
    from .webreport import write_dashboard

    dashboard_meta = {
        "sources": [s.name for s in sources],
        "transaction": args.transaction,
        "item_types": item_types,
        "max_price": args.max_price,
        "note": args.note,
        "scope": args.bbox or "Όλη η Ελλάδα",
        "scanned": len(candidates),
        "shortlisted": len(rescored),
        "valued": len(analysis),
        "basis": declared_basis,
        "indicator_weights": indicator_weights,
    }

    # Η καρτέλα «Πού να ψάξεις» έρχεται από ανοιχτά δεδομένα και δεν χρειάζεται
    # καμία αγγελία. Αν η ανάγνωσή τους αποτύχει, η σελίδα βγαίνει χωρίς αυτήν
    # αντί να μη βγει καθόλου.
    regions_html, regions_css = "", ""
    if not args.no_regions:
        try:
            from . import ethniki
            _log("\n  · Περιοχές: Eurostat και Διαύγεια …")
            regions_html = ethniki.render_pane(ethniki.collect(fetcher, verbose=False))
            regions_css = ethniki.PANE_CSS
        except Exception as exc:  # noqa: BLE001 - η σάρωση δεν χάνεται γι' αυτό
            _log(f"    · χωρίς την καρτέλα περιοχών: {exc}")

    # Τα δεδομένα της σελίδας χωριστά: αυτό το αρχείο ανεβαίνει στο droplet και
    # γίνεται εκεί η ίδια σελίδα, χωρίς να ξανατρέξει η σάρωση.
    from .webreport import build_data
    payload_path = args.out + "_analysis.json"
    with open(payload_path, "w", encoding="utf-8") as handle:
        json.dump(build_data(final, analysis, dashboard_meta), handle, ensure_ascii=False)

    html_path = args.html_out or (args.out + ".html")
    write_dashboard(
        final, analysis, html_path,
        regions_html=regions_html, regions_css=regions_css,
        meta=dashboard_meta,
    )

    _log(f"\n  ✓ {args.out}.csv")
    _log(f"  ✓ {args.out}.json")
    _log(f"  ✓ {html_path}")
    _log(f"  Δίκτυο: {fetcher.stats}")

    _log("\nΚΟΡΥΦΑΙΕΣ ΕΥΚΑΙΡΙΕΣ — κατάταξη κατά απόδοση, όχι κατά έκπτωση")
    _log("-" * 78)
    _log("Απόδοση ΑΓΓΕΛΙΑ = με τα νούμερα της αγγελίας · ΦΟΥΣΚΑ = αν οι τιμές "
         "είναι φουσκωμένες")
    _log(f"{'#':>3}  {'Τιμή':>9}  {'Περιοχή':<22} {'ΑΓΓΕΛΙΑ':>8} {'ΦΟΥΣΚΑ':>8} "
         f"{'Κέρδος':>6} {'Αντοχή':>6} {'Ταχύτ':>6} {'Λίγα€':>6} {'ΣΥΝΟΛΟ':>7}")
    _log("-" * 78)
    for position, scored in enumerate(final[:15], 1):
        listing = scored.listing
        best = analysis[listing.listing_id]["best"]
        ind = best.indicators
        price = f"{listing.price:,.0f}".replace(",", ".") if listing.price else "-"
        _log(
            f"{position:>3}. {price:>9} €  {(listing.sub_area or listing.address or '-')[:22]:<22} "
            f"{best.annualised_roi_pct:>7.1f}% {best.annualised_roi_stressed_pct:>7.1f}% "
            f"{ind.ret:>6.0f} {ind.certainty:>6.0f} {ind.speed:>6.0f} {ind.capital:>6.0f} "
            f"{ind.combined:>7.1f}"
        )
        _log(f"      → {best.name[:64]}")
        _log(f"        {listing.url}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
