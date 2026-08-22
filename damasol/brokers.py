"""
Broker directory CLI.

    python -m damasol.brokers --categories "Μεσιτικό γραφείο" --with-contacts --limit 500

Builds the recipient list for the Damasol outreach campaign from xe.gr's public
professionals directory (`/property/pros`), which robots.txt permits - unlike
the results pages. The index gives name + profile URL for every professional;
`--with-contacts` then opens each profile for phone, e-mail and address.

That second step is one request per broker, so at the default 2s delay a full
sweep of ~5.000 profiles takes a few hours. Responses are cached, so the run is
resumable: re-running picks up where it left off at no network cost.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from typing import List, Optional, Sequence

from .http import PoliteFetcher
from .models import Broker
from .sources import REGISTRY


def _log(message: str) -> None:
    print(message, flush=True)


def export_brokers(brokers: Sequence[Broker], path: str) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    rows = [b.to_dict() for b in brokers]
    if not rows:
        return
    with open(path, "w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def deduplicate(brokers: Sequence[Broker]) -> List[Broker]:
    """Collapse profiles that share an e-mail or a phone number.

    Agencies routinely publish one profile per branch or per listing category;
    mailing all of them would land several copies in the same inbox.
    """
    seen_email: dict = {}
    seen_phone: dict = {}
    unique: List[Broker] = []
    for broker in brokers:
        email = (broker.email or "").strip().lower()
        phone = "".join(ch for ch in (broker.phone or "") if ch.isdigit())
        if email and email in seen_email:
            continue
        if phone and phone in seen_phone:
            continue
        if email:
            seen_email[email] = True
        if phone:
            seen_phone[phone] = True
        unique.append(broker)
    return unique


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="damasol.brokers",
        description="Κατάλογος μεσιτών/επαγγελματιών ακινήτων για την καμπάνια Damasol.",
    )
    parser.add_argument("--source", default="xe", choices=sorted(REGISTRY))
    parser.add_argument(
        "--categories",
        default="Μεσιτικό γραφείο",
        help="Κατηγορίες χωρισμένες με κόμμα, ή 'all' για όλες "
             "(Μεσιτικό γραφείο, Εταιρεία διαχείρισης ακινήτων, Κατασκευαστική εταιρεία).",
    )
    parser.add_argument("--with-contacts", action="store_true",
                        help="Άνοιγμα κάθε προφίλ για τηλέφωνο/email/διεύθυνση (αργό).")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--contactable-only", action="store_true",
                        help="Κράτα μόνο όσους έχουν email ή τηλέφωνο.")
    parser.add_argument("--no-dedupe", action="store_true")
    parser.add_argument("--out", default="out/brokers")
    parser.add_argument("--delay", type=float, default=2.0)
    parser.add_argument("--cache-hours", type=float, default=168.0)
    parser.add_argument("--ignore-robots", action="store_true")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)

    fetcher = PoliteFetcher(
        delay=args.delay,
        cache_ttl_hours=args.cache_hours,
        obey_robots=not args.ignore_robots,
    )
    source = REGISTRY[args.source](fetcher)

    _log("=" * 74)
    _log(f"DAMASOL LIMITED · Κατάλογος επαγγελματιών ακινήτων · πηγή: {source.name}")
    _log("=" * 74)

    _log("\n[1/3] Ανάγνωση δημόσιου καταλόγου")
    brokers = source.brokers()
    _log(f"  Βρέθηκαν {len(brokers)} προφίλ")

    wanted = [c.strip() for c in args.categories.split(",") if c.strip()]
    if wanted and wanted != ["all"]:
        brokers = [b for b in brokers if b.category in wanted]
        _log(f"  Μετά το φίλτρο κατηγοριών {wanted}: {len(brokers)}")

    if args.limit:
        brokers = brokers[: args.limit]
        _log(f"  Περιορισμός σε {len(brokers)}")

    if args.with_contacts:
        _log(f"\n[2/3] Άντληση στοιχείων επικοινωνίας ({len(brokers)} αιτήματα)")
        for position, broker in enumerate(brokers, 1):
            source.enrich_broker(broker)
            if position % 25 == 0 or position == len(brokers):
                have = sum(1 for b in brokers[:position] if b.is_contactable)
                _log(f"  {position}/{len(brokers)} · με στοιχεία επικοινωνίας: {have}")
    else:
        _log("\n[2/3] Στοιχεία επικοινωνίας παραλείφθηκαν (--with-contacts για άντληση)")

    if args.contactable_only:
        brokers = [b for b in brokers if b.is_contactable]
        _log(f"  Μόνο με στοιχεία επικοινωνίας: {len(brokers)}")
    if not args.no_dedupe:
        before = len(brokers)
        brokers = deduplicate(brokers)
        _log(f"  Αποδιπλασιασμός: {before} → {len(brokers)}")

    _log("\n[3/3] Εξαγωγή")
    export_brokers(brokers, args.out + ".csv")
    with open(args.out + ".json", "w", encoding="utf-8") as handle:
        json.dump([b.to_dict() for b in brokers], handle, ensure_ascii=False, indent=2)

    with_email = sum(1 for b in brokers if b.email)
    with_phone = sum(1 for b in brokers if b.phone)
    _log(f"  ✓ {args.out}.csv ({len(brokers)} εγγραφές)")
    _log(f"  ✓ {args.out}.json")
    _log(f"  Email: {with_email} · Τηλέφωνο: {with_phone}")
    _log(f"  Δίκτυο: {fetcher.stats}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
