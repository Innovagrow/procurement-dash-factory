"""
Opportunity screener CLI.

    python -m damasol.screener --max-price 50000 --item-types residence,prof,land

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

from .geo import GREECE_BBOX, cell_bbox, geo_cell
from .http import PoliteFetcher
from .models import Listing, ScoredListing
from .scoring import DEFAULT_WEIGHTS, MarketIndex, score_all
from .sources import REGISTRY, SearchQuery

DEFAULT_ITEM_TYPES = ("residence", "prof", "land")


def _log(message: str) -> None:
    print(message, flush=True)


# ------------------------------------------------------------------- crawl


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


def export_csv(scored: Sequence[ScoredListing], path: str) -> None:
    if not scored:
        return
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    rows = [s.to_dict() for s in scored]
    fieldnames = list(rows[0].keys())
    with open(path, "w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def export_json(scored: Sequence[ScoredListing], path: str) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    payload = [
        {
            **s.listing.to_dict(),
            "score": s.score,
            "grade": s.grade,
            "components": s.components,
            "evidence": s.evidence,
            "flags": s.flags,
            "market_price_per_sqm": s.market_price_per_sqm,
            "discount_pct": s.discount_pct,
            "est_monthly_rent": s.est_monthly_rent,
            "gross_yield_pct": s.gross_yield_pct,
        }
        for s in scored
    ]
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)


# --------------------------------------------------------------------- cli


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="damasol.screener",
        description="Εντοπισμός των καλύτερων επαγγελματικών ευκαιριών σε ακίνητα.",
    )
    parser.add_argument("--source", default="xe", choices=sorted(REGISTRY))
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
    parser.add_argument("--comp-pages", type=int, default=3,
                        help="Σελίδες συγκριτικών πωλήσεων ανά κελί")
    parser.add_argument("--rent-pages", type=int, default=2,
                        help="Σελίδες συγκριτικών ενοικίων ανά κελί")
    parser.add_argument("--probe", action="store_true", help="Έλεγχος πηγής χωρίς πλήρη σάρωση")
    parser.add_argument("--weights", default=None, help="JSON με βάρη, π.χ. '{\"rental_yield\":0.4}'")
    parser.add_argument(
        "--ignore-robots",
        action="store_true",
        help="Αγνόησε το robots.txt της πηγής. Ορισμένες πύλες (π.χ. xe.gr) απαγορεύουν "
             "ρητά τη σάρωση των σελίδων αποτελεσμάτων· η χρήση αυτής της επιλογής είναι "
             "δική σας εμπορική/νομική απόφαση και υπόκειται στους Όρους Χρήσης τους.",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
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
    source = REGISTRY[args.source](fetcher)
    item_types = [t.strip() for t in args.item_types.split(",") if t.strip()]

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
    _log(f"DAMASOL LIMITED · Σάρωση ευκαιριών · πηγή: {source.name}")
    _log(
        f"Φίλτρα: {args.transaction} · {', '.join(item_types)} · "
        f"έως {args.max_price:,.0f} € · {'όλη η Ελλάδα' if not bbox else 'bbox ' + args.bbox}"
    )
    _log("=" * 74)

    _log("\n[1/4] Συλλογή υποψηφίων")
    candidates = crawl_candidates(
        source, item_types, args.transaction, args.max_price,
        args.min_price, args.min_size, bbox, args.max_pages,
    )
    _log(f"  Σύνολο: {len(candidates)} αγγελίες")
    if not candidates:
        _log("Καμία αγγελία. Χαλαρώστε τα φίλτρα.")
        return 1

    _log("\n[2/4] Προκαταρκτική βαθμολόγηση (συγκριτικά εντός του δείγματος)")
    index = MarketIndex(cell_size=args.cell_size)
    index.add_sale_comparables(candidates)
    prescored = score_all(candidates, index, budget=args.max_price, weights=weights)
    shortlist = prescored[: args.enrich_top]
    _log(f"  Shortlist προς εμπλουτισμό: {len(shortlist)}")

    if not args.no_enrich:
        _log("\n[3/4] Εμπλουτισμός με πραγματικά συγκριτικά αγοράς & ενοικίων")
        enrich_index = MarketIndex(cell_size=args.cell_size)
        enrich_market_context(
            source, enrich_index, shortlist, args.cell_size,
            exclude_ids={c.listing_id for c in candidates},
            comp_pages=args.comp_pages,
            rent_pages=args.rent_pages,
        )
        _log(f"  Δείκτης αγοράς: {enrich_index.summary()}")
        index = enrich_index
        index.add_sale_comparables(
            [c for c in candidates if c.listing_id not in {s.listing.listing_id for s in shortlist}]
        )
    else:
        _log("\n[3/4] Εμπλουτισμός παραλείφθηκε (--no-enrich)")

    _log("\n[4/4] Τελική βαθμολόγηση & εξαγωγή")
    final = score_all([s.listing for s in shortlist], index, budget=args.max_price, weights=weights)
    final = final[: args.top]

    export_csv(final, args.out + ".csv")
    export_json(final, args.out + ".json")
    try:
        from .report import write_html_report

        write_html_report(
            final,
            args.out + ".html",
            meta={
                "source": source.name,
                "transaction": args.transaction,
                "item_types": item_types,
                "max_price": args.max_price,
                "bbox": args.bbox or "Όλη η Ελλάδα",
                "candidates": len(candidates),
                "weights": weights,
            },
        )
    except ImportError:
        pass

    _log(f"\n  ✓ {args.out}.csv")
    _log(f"  ✓ {args.out}.json")
    _log(f"  ✓ {args.out}.html")
    _log(f"  Δίκτυο: {fetcher.stats}")

    _log("\nΚΟΡΥΦΑΙΕΣ ΕΥΚΑΙΡΙΕΣ")
    _log("-" * 74)
    for position, scored in enumerate(final[:15], 1):
        listing = scored.listing
        price = f"{listing.price:,.0f}".replace(",", ".") if listing.price else "-"
        _log(
            f"{position:>3}. [{scored.grade:>2}] {scored.score:>5.1f}  "
            f"{price:>9} €  {(listing.address or '-')[:26]:<26} "
            f"{(listing.title or '')[:34]}"
        )
        if scored.discount_pct is not None:
            _log(f"       έκπτωση {scored.discount_pct:>5.1f}%  ·  απόδοση "
                 f"{scored.gross_yield_pct if scored.gross_yield_pct is not None else '—'}%")
        _log(f"       {listing.url}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
